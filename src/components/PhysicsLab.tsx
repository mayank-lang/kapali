import { useState, useEffect, useMemo, useRef } from 'react';
import { Atom, Compass, Sun, Wind, Zap, BarChart2, Eye, RefreshCw, Play, Sliders, Grid, AlertTriangle } from 'lucide-react';
import { type SharedFile } from '../App';
import { computePTC, type PTCResult } from '../utils/photonTransfer';
import { analyzeFieldPSF, type FieldPSFResult } from '../utils/opticalAnalysis';
import { aperturePhotometry, fitBlackbody, type SEDResult } from '../utils/spectralAnalysis';
import { computeAirmass, computeExtinction, correctExtinction, parseObservationMetadata } from '../utils/atmosphericPhysics';
import { measureSNR, estimateIntegrationTime, type SNRMeasurement, type IntegrationEstimate } from '../utils/snrCalculator';
import { computeFFT2D, type FourierResult } from '../utils/fourierAnalysis';
import { modelVignetting, correctVignetting, type VignettingModel } from '../utils/background';

interface PhysicsLabProps {
  activeFile: SharedFile | null;
  sharedFiles: SharedFile[];
  onUpdateFits: (fileId: string, newData: Float32Array) => void;
  addLog: (type: 'info' | 'error' | 'success' | 'warning', msg: string) => void;
}

type PhysicsToolId = 'ptc' | 'aberration' | 'sed' | 'extinction' | 'snr' | 'fourier' | 'vignetting';

export function PhysicsLab({ activeFile, sharedFiles, onUpdateFits, addLog }: PhysicsLabProps) {
  const [activeTool, setActiveTool] = useState<PhysicsToolId>('ptc');

  // --- 1. PTC State ---
  const [ptcFlatPairs, setPtcFlatPairs] = useState<{ idA: string; idB: string }[]>([
    { idA: '', idB: '' },
    { idA: '', idB: '' },
    { idA: '', idB: '' }
  ]);
  const [ptcResult, setPtcResult] = useState<PTCResult | null>(null);
  const [showAllPtcFiles, setShowAllPtcFiles] = useState(false);

  const flatCandidates = useMemo(() => {
    return sharedFiles.filter(f => {
      const name = f.name.toLowerCase();
      if (name.includes('flat')) return true;
      if (name.includes('master_flat')) return true;
      const imagetyp = f.extractedHeaders?.find(
        h => h.key.trim().toUpperCase() === 'IMAGETYP'
      );
      if (imagetyp && imagetyp.value.replace(/["']/g, '').toLowerCase().includes('flat')) return true;
      return false;
    });
  }, [sharedFiles]);

  const ptcFileList = showAllPtcFiles ? sharedFiles : flatCandidates;

  // --- 2. Aberration State ---
  const [aberrationResult, setAberrationResult] = useState<FieldPSFResult | null>(null);
  const [isAnalyzingPSF, setIsAnalyzingPSF] = useState(false);

  // --- 3. SED State ---
  const [starX, setStarX] = useState<number>(256);
  const [starY, setStarY] = useState<number>(256);
  const [apRadius, setApRadius] = useState<number>(8);
  const [sedResult, setSedResult] = useState<SEDResult | null>(null);
  const [sedApertureResult, setSedApertureResult] = useState<ReturnType<typeof aperturePhotometry> | null>(null);

  // --- 4. Extinction State ---
  const [siteAltitude, setSiteAltitude] = useState<number>(1000); // meters
  const [obsAltitude, setObsAltitude] = useState<number>(45);     // degrees
  const airmass = useMemo(() => computeAirmass(obsAltitude), [obsAltitude]);
  const [extinctionCorrectionFactors, setExtinctionCorrectionFactors] = useState<{ r: number; g: number; b: number } | null>(null);

  // Read altitude and site elevation from FITS header when activeFile changes
  useEffect(() => {
    if (activeFile?.extractedHeaders) {
      const meta = parseObservationMetadata(activeFile.extractedHeaders);
      // A file change is an intentional reset point; later edits remain user-controlled.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      if (meta.altitude && meta.altitude > 0) setObsAltitude(meta.altitude);
      if (meta.siteElevation && meta.siteElevation > 0) setSiteAltitude(meta.siteElevation);
    }
  }, [activeFile?.extractedHeaders]);

  // Center target coordinates automatically when a new file is selected
  useEffect(() => {
    if (activeFile?.parsedFits) {
      const w = activeFile.parsedFits.width;
      const h = activeFile.parsedFits.height;
      if (w > 0 && h > 0) {
        const cx = Math.floor(w / 2);
        const cy = Math.floor(h / 2);
        setStarX(cx);
        setStarY(cy);
        setSnrTargetX(cx);
        setSnrTargetY(cy);
      }
    }
  }, [activeFile?.id]);

  // --- 5. SNR State ---
  const [snrTargetX, setSnrTargetX] = useState<number>(256);
  const [snrTargetY, setSnrTargetY] = useState<number>(256);
  const [snrAperture, setSnrAperture] = useState<number>(8);
  const [cameraGain, setCameraGain] = useState<number>(1.0);       // e-/ADU
  const [cameraReadNoise, setCameraReadNoise] = useState<number>(5.0); // e-
  const [cameraDarkCurrent, setCameraDarkCurrent] = useState<number>(0.05); // e-/px/s
  const [snrMeasurement, setSnrMeasurement] = useState<SNRMeasurement | null>(null);
  const [targetSNR, setTargetSNR] = useState<number>(50);
  const [currentFramesCount, setCurrentFramesCount] = useState<number>(10);
  const [exposureTimeSec, setExposureTimeSec] = useState<number>(300);
  const integrationEstimate: IntegrationEstimate | null = useMemo(() => {
    if (!snrMeasurement) return null;
    return estimateIntegrationTime(
      snrMeasurement.measuredSNR,
      currentFramesCount,
      exposureTimeSec,
      targetSNR
    );
  }, [snrMeasurement, currentFramesCount, exposureTimeSec, targetSNR]);

  // --- 6. Fourier State ---
  const [fourierResult, setFourierResult] = useState<FourierResult | null>(null);
  const [isAnalyzingFourier, setIsAnalyzingFourier] = useState(false);
  const fourierCanvasRef = useRef<HTMLCanvasElement | null>(null);

  // --- 7. Vignetting State ---
  const [vignettingModel, setVignettingModel] = useState<VignettingModel | null>(null);
  const [isModelingVignetting, setIsModelingVignetting] = useState(false);

  // --- 1. PTC Handler ---
  const handleRunPTC = () => {
    const pairsToCompute: { a: Float32Array; b: Float32Array }[] = [];
    const expTimes: number[] = [];
    
    for (let i = 0; i < ptcFlatPairs.length; i++) {
      const pair = ptcFlatPairs[i];
      const fileA = sharedFiles.find(f => f.id === pair.idA);
      const fileB = sharedFiles.find(f => f.id === pair.idB);
      
      if (fileA?.parsedFits?.floatData && fileB?.parsedFits?.floatData &&
          fileA.parsedFits.width === fileB.parsedFits.width &&
          fileA.parsedFits.height === fileB.parsedFits.height &&
          fileA.parsedFits.floatData.length === fileB.parsedFits.floatData.length) {
        pairsToCompute.push({
          a: fileA.parsedFits.floatData,
          b: fileB.parsedFits.floatData
        });
        const exposureCard = fileA.extractedHeaders.find(h => ['EXPTIME', 'EXPOSURE'].includes(h.key.trim().toUpperCase()));
        const exposure = exposureCard ? Number(exposureCard.value.replace(/["']/g, '')) : NaN;
        expTimes.push(Number.isFinite(exposure) && exposure > 0 ? exposure : i + 1);
      } else if (pair.idA && pair.idB) {
        addLog('warning', `Skipped flat pair ${i + 1}: images must have matching dimensions and channels.`);
      }
    }

    if (pairsToCompute.length < 2) {
      addLog('error', "PTC requires at least 2 complete flat pairs containing FITS floatData.");
      return;
    }

    addLog('info', `Running PTC analyzer on ${pairsToCompute.length} flat-field pairs...`);
    const firstSelected = sharedFiles.find(f => f.id === ptcFlatPairs.find(p => p.idA)?.idA);
    const width = firstSelected?.parsedFits?.width || 0;
    const height = firstSelected?.parsedFits?.height || 0;
    const res = computePTC(pairsToCompute, width, height, expTimes);
    setPtcResult(res);
    addLog('success', `PTC analysis complete: Gain = ${res.gain.toFixed(3)} e-/ADU, Read Noise = ${res.readNoise.toFixed(2)} e-`);
  };

  // --- 2. Aberration Handler ---
  const handleRunAberration = () => {
    if (!activeFile?.parsedFits?.floatData) {
      addLog('error', "No active FITS image file loaded for aberration analysis.");
      return;
    }

    setIsAnalyzingPSF(true);
    setTimeout(() => {
      try {
        const fits = activeFile.parsedFits!;
        const res = analyzeFieldPSF(fits.floatData, fits.width, fits.height, 5);
        setAberrationResult(res);
        addLog('success', "Optical aberration analysis completed.");
      } catch (err) {
        addLog('error', `Aberration analysis failed: ${err}`);
      } finally {
        setIsAnalyzingPSF(false);
      }
    }, 100);
  };

  // --- 3. SED Handler ---
  const handleRunSED = () => {
    if (!activeFile?.parsedFits?.floatData) {
      addLog('error', "No active FITS image loaded for spectral photometry.");
      return;
    }

    const fits = activeFile.parsedFits!;
    const channelCount = Math.floor(fits.floatData.length / (fits.width * fits.height));
    if (channelCount < 3) {
      setSedResult(null);
      setSedApertureResult(null);
      addLog('error', 'RGB color-temperature estimation requires three measured channels; monochrome data cannot supply a color slope.');
      return;
    }
    const annulusInner = apRadius * 1.5;
    const annulusOuter = apRadius * 2.5;

    const phot = aperturePhotometry(fits.floatData, fits.width, fits.height, starX, starY, apRadius, annulusInner, annulusOuter);
    setSedApertureResult(phot);

    const filterFluxes: { wavelength_nm: number; flux: number }[] = [];
    if (phot.flux.length >= 3) {
      filterFluxes.push({ wavelength_nm: 620, flux: phot.flux[0] }); // Red
      filterFluxes.push({ wavelength_nm: 530, flux: phot.flux[1] }); // Green (V proxy)
      filterFluxes.push({ wavelength_nm: 450, flux: phot.flux[2] }); // Blue
    }

    const sed = fitBlackbody(filterFluxes);
    setSedResult(sed);
    addLog('success', `Approximate RGB color temperature fitted: ${sed.temperature} K (${sed.spectralClass}-like).`);
  };

  // --- 4. Extinction Handler ---
  const handleComputeExtinction = () => {
    const res = computeExtinction(airmass, siteAltitude);
    setExtinctionCorrectionFactors(res.correctionFactors);
  };

  const handleApplyExtinctionCorrection = () => {
    if (!activeFile?.parsedFits?.floatData) {
      addLog('error', "No active FITS file loaded for extinction correction.");
      return;
    }
    if (!extinctionCorrectionFactors) {
      addLog('error', "Please calculate the extinction correction factors first.");
      return;
    }

    const fits = activeFile.parsedFits!;
    addLog('info', "Applying differential atmospheric extinction correction to pixel data...");
    const currentFactors = computeExtinction(airmass, siteAltitude).correctionFactors;
    const correctedData = correctExtinction(fits.floatData, fits.width, fits.height, currentFactors);
    onUpdateFits(activeFile.id, correctedData);
    addLog('success', "Atmospheric extinction correction applied to master buffer.");
  };

  // --- 5. SNR Handler ---
  const handleRunSNR = () => {
    if (!activeFile?.parsedFits?.floatData) {
      addLog('error', "No active FITS image loaded for SNR measurement.");
      return;
    }

    const fits = activeFile.parsedFits!;
    const measurement = measureSNR(
      fits.floatData, fits.width, fits.height,
      snrTargetX, snrTargetY, snrAperture,
      exposureTimeSec, cameraGain, cameraReadNoise, cameraDarkCurrent
    );
    setSnrMeasurement(measurement);

    addLog('success', `SNR measured at ${measurement.measuredSNR.toFixed(2)}. Projections calculated.`);
  };

  // --- 6. Fourier Handler ---
  const handleRunFourier = () => {
    if (!activeFile?.parsedFits?.floatData) {
      addLog('error', "No active FITS image loaded for Fourier power spectrum analysis.");
      return;
    }

    setIsAnalyzingFourier(true);
    setTimeout(() => {
      try {
        const fits = activeFile.parsedFits!;
        const res = computeFFT2D(fits.floatData, fits.width, fits.height);
        setFourierResult(res);
        addLog('success', "2D Fourier Power Spectrum computed successfully.");
      } catch (err) {
        addLog('error', `FFT computation failed: ${err}`);
      } finally {
        setIsAnalyzingFourier(false);
      }
    }, 100);
  };

  // Draw Fourier spectrum on canvas
  useEffect(() => {
    if (fourierResult && fourierCanvasRef.current) {
      const canvas = fourierCanvasRef.current;
      const ctx = canvas.getContext('2d');
      if (ctx) {
        const w = fourierResult.paddedWidth;
        const h = fourierResult.paddedHeight;
        canvas.width = w;
        canvas.height = h;

        const imgData = ctx.createImageData(w, h);
        const spectrum = fourierResult.powerSpectrum;
        for (let i = 0; i < w * h; i++) {
          const val = Math.floor(spectrum[i] * 255);
          const idx = i * 4;
          // Apply a cool plasma or cyan monochromatic color scheme
          imgData.data[idx] = Math.max(0, Math.min(255, val * 0.3));     // R
          imgData.data[idx + 1] = Math.max(0, Math.min(255, val * 0.85)); // G
          imgData.data[idx + 2] = Math.max(0, Math.min(255, val));       // B
          imgData.data[idx + 3] = 255;                                  // A
        }
        ctx.putImageData(imgData, 0, 0);
      }
    }
  }, [fourierResult]);

  // --- 7. Vignetting Handler ---
  const handleRunVignettingModel = () => {
    if (!activeFile?.parsedFits?.floatData) {
      addLog('error', "No active FITS image loaded for vignetting modeling.");
      return;
    }

    setIsModelingVignetting(true);
    setTimeout(() => {
      try {
        const fits = activeFile.parsedFits!;
        const res = modelVignetting(fits.floatData, fits.width, fits.height);
        setVignettingModel(res);
        addLog('success', `Vignetting modeled successfully. Effective focal px: ${res.effectiveFocalPx.toFixed(1)}`);
      } catch (err) {
        addLog('error', `Vignetting modeling failed: ${err}`);
      } finally {
        setIsModelingVignetting(false);
      }
    }, 100);
  };

  const handleApplyVignettingCorrection = () => {
    if (!activeFile?.parsedFits?.floatData) {
      addLog('error', "No active FITS image loaded for vignetting correction.");
      return;
    }
    if (!vignettingModel) {
      addLog('error', "Please model the vignetting profile first.");
      return;
    }

    const fits = activeFile.parsedFits!;
    addLog('info', "Applying physical cos⁴ law vignetting correction...");
    const res = correctVignetting(fits.floatData, fits.width, fits.height, vignettingModel);
    onUpdateFits(activeFile.id, res.newData);
    addLog('success', "Vignetting correction applied in-place.");
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', gap: '0.75rem', overflow: 'hidden' }}>
      
      {/* Header */}
      <div className="sidebar-module-header">
        <h2 className="sidebar-module-title">
          <Atom size={16} color="var(--accent-blue)" />
          Physics Lab
        </h2>
        <p className="sidebar-module-desc">Interact with optical physics, sensor characterization, and radiative science tools.</p>
      </div>

      {/* Main Body */}
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: '0.75rem', overflow: 'hidden' }}>
        
        {/* Tool Select list */}
        <div style={{ display: 'flex', gap: '0.25rem', overflowX: 'auto', flexShrink: 0, paddingBottom: '0.25rem' }}>
          {[
            { id: 'ptc', label: 'PTC Sensor', icon: <Zap size={12} />, badge: flatCandidates.length > 0 ? flatCandidates.length : undefined },
            { id: 'aberration', label: 'Aberration', icon: <Compass size={12} /> },
            { id: 'sed', label: 'Color temp', icon: <Sun size={12} /> },
            { id: 'extinction', label: 'Airmass & Ext', icon: <Wind size={12} /> },
            { id: 'snr', label: 'SNR Estimator', icon: <BarChart2 size={12} /> },
            { id: 'fourier', label: 'Fourier FFT', icon: <Grid size={12} /> },
            { id: 'vignetting', label: 'Vignetting', icon: <Eye size={12} /> },
          ].map(t => (
            <button
              key={t.id}
              onClick={() => setActiveTool(t.id as PhysicsToolId)}
              className={activeTool === t.id ? 'btn-secondary active' : 'btn-secondary'}
              style={{
                display: 'flex', alignItems: 'center', gap: '0.35rem',
                fontSize: '0.7rem', padding: '0.35rem 0.5rem', whiteSpace: 'nowrap',
                backgroundColor: activeTool === t.id ? 'rgba(56, 189, 248, 0.15)' : 'transparent',
                borderColor: activeTool === t.id ? 'var(--accent-blue)' : 'var(--border)',
                color: 'var(--text-main)'
              }}
            >
              {t.icon}
              {t.label}
              {t.badge !== undefined && (
                <span style={{
                  marginLeft: '0.25rem',
                  padding: '0.05rem 0.3rem',
                  fontSize: '0.6rem',
                  fontWeight: 700,
                  borderRadius: '10px',
                  backgroundColor: 'var(--accent-purple)',
                  color: 'white'
                }}>
                  {t.badge}
                </span>
              )}
            </button>
          ))}
        </div>

        {/* Dynamic Tool Content */}
        <div className="control-card" style={{ flex: 1, overflowY: 'auto', padding: '0.75rem', display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
          
          {/* ================= 1. PTC ANALYZER ================= */}
          {activeTool === 'ptc' && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
              <h3 style={{ fontSize: '0.85rem', fontWeight: 600, color: 'var(--text-main)', margin: 0 }}>Photon Transfer Curve (PTC) Analyzer</h3>
              <p style={{ fontSize: '0.75rem', color: 'var(--text-muted)', margin: 0 }}>
                Estimate conversion gain and saturation from matched flat pairs at several levels. Read-noise accuracy requires bias-subtracted data.
              </p>

              {/* Pair selection inputs */}
              <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <div style={{ fontSize: '0.7rem', fontWeight: 600, color: 'var(--text-muted)' }}>
                    Select Flat Pairs {flatCandidates.length > 0 && <span style={{ color: 'var(--accent-blue)', fontWeight: 400 }}>({flatCandidates.length} flat{flatCandidates.length !== 1 ? 's' : ''} detected)</span>}:
                  </div>
                  <label style={{ display: 'flex', alignItems: 'center', gap: '0.3rem', fontSize: '0.65rem', color: 'var(--text-muted)', cursor: 'pointer' }}>
                    <input
                      type="checkbox"
                      checked={showAllPtcFiles}
                      onChange={(e) => setShowAllPtcFiles(e.target.checked)}
                      style={{ width: '12px', height: '12px' }}
                    />
                    All files
                  </label>
                </div>
                {ptcFileList.length === 0 ? (
                  <div style={{
                    display: 'flex', alignItems: 'center', gap: '0.5rem',
                    padding: '0.6rem', borderRadius: '4px',
                    backgroundColor: 'rgba(255, 170, 0, 0.08)',
                    border: '1px solid rgba(255, 170, 0, 0.2)',
                    fontSize: '0.7rem', color: 'var(--text-muted)'
                  }}>
                    <AlertTriangle size={14} style={{ color: 'hsl(40, 100%, 50%)', flexShrink: 0 }} />
                    <span>No flat-field frames detected in workspace. Load flat frames (files with "flat" in the name or IMAGETYP=Flat header) to use the PTC analyzer, or check "All files" above.</span>
                  </div>
                ) : (
                  ptcFlatPairs.map((pair, idx) => (
                    <div key={idx} style={{ display: 'flex', gap: '0.35rem', alignItems: 'center' }}>
                      <span style={{ fontSize: '0.7rem', color: 'var(--text-muted)', minWidth: '45px' }}>Pair {idx + 1}:</span>
                      <select
                        value={pair.idA}
                        onChange={(e) => {
                          const next = [...ptcFlatPairs];
                          next[idx].idA = e.target.value;
                          setPtcFlatPairs(next);
                        }}
                        className="input-select"
                        style={{ flex: 1, fontSize: '0.7rem', padding: '0.25rem' }}
                      >
                        <option value="">-- Flat A --</option>
                        {ptcFileList.map(f => <option key={f.id} value={f.id}>{f.name}</option>)}
                      </select>
                      <select
                        value={pair.idB}
                        onChange={(e) => {
                          const next = [...ptcFlatPairs];
                          next[idx].idB = e.target.value;
                          setPtcFlatPairs(next);
                        }}
                        className="input-select"
                        style={{ flex: 1, fontSize: '0.7rem', padding: '0.25rem' }}
                      >
                        <option value="">-- Flat B --</option>
                        {ptcFileList.map(f => <option key={f.id} value={f.id}>{f.name}</option>)}
                      </select>
                    </div>
                  ))
                )}
              </div>

              <button className="btn-primary" onClick={handleRunPTC} style={{ alignSelf: 'flex-start', marginTop: '0.25rem' }}>
                <Play size={12} /> Compute Sensor PTC
              </button>

              {ptcResult && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem', borderTop: '1px solid var(--border)', paddingTop: '0.5rem' }}>
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.5rem' }}>
                    <div style={{ padding: '0.5rem', backgroundColor: 'rgba(255,255,255,0.03)', borderRadius: '4px', border: '1px solid var(--border)' }}>
                      <div style={{ fontSize: '0.65rem', color: 'var(--text-muted)' }}>System Gain</div>
                      <div style={{ fontSize: '0.95rem', fontWeight: 700, color: 'var(--accent-blue)' }}>{ptcResult.gain.toFixed(3)} <span style={{ fontSize: '0.65rem', fontWeight: 500 }}>e-/ADU</span></div>
                    </div>
                    <div style={{ padding: '0.5rem', backgroundColor: 'rgba(255,255,255,0.03)', borderRadius: '4px', border: '1px solid var(--border)' }}>
                      <div style={{ fontSize: '0.65rem', color: 'var(--text-muted)' }}>Intercept Noise*</div>
                      <div style={{ fontSize: '0.95rem', fontWeight: 700, color: 'var(--accent-blue)' }}>{ptcResult.readNoise.toFixed(2)} <span style={{ fontSize: '0.65rem', fontWeight: 500 }}>e-</span></div>
                    </div>
                    <div style={{ padding: '0.5rem', backgroundColor: 'rgba(255,255,255,0.03)', borderRadius: '4px', border: '1px solid var(--border)' }}>
                      <div style={{ fontSize: '0.65rem', color: 'var(--text-muted)' }}>Est. Saturation Capacity</div>
                      <div style={{ fontSize: '0.95rem', fontWeight: 700, color: 'var(--text-main)' }}>{ptcResult.fullWellCapacity.toFixed(0)} <span style={{ fontSize: '0.65rem', fontWeight: 500 }}>e-</span></div>
                    </div>
                    <div style={{ padding: '0.5rem', backgroundColor: 'rgba(255,255,255,0.03)', borderRadius: '4px', border: '1px solid var(--border)' }}>
                      <div style={{ fontSize: '0.65rem', color: 'var(--text-muted)' }}>Linearity Limit</div>
                      <div style={{ fontSize: '0.95rem', fontWeight: 700, color: 'var(--text-main)' }}>{ptcResult.linearityRange[1].toFixed(0)} <span style={{ fontSize: '0.65rem', fontWeight: 500 }}>ADU</span></div>
                    </div>
                  </div>

                  {/* SVG Scatter Plot */}
                  <div style={{ marginTop: '0.25rem' }}>
                    <div style={{ fontSize: '0.65rem', fontWeight: 600, color: 'var(--text-muted)', marginBottom: '0.25rem' }}>PTC Plot (Variance vs Mean Signal):</div>
                    <svg viewBox="0 0 240 120" style={{ width: '100%', height: '110px', backgroundColor: 'rgba(0,0,0,0.2)', borderRadius: '4px', border: '1px solid var(--border)' }}>
                      {/* Grid lines */}
                      <line x1="30" y1="10" x2="30" y2="100" stroke="rgba(255,255,255,0.05)" />
                      <line x1="220" y1="10" x2="220" y2="100" stroke="rgba(255,255,255,0.05)" />
                      <line x1="30" y1="100" x2="220" y2="100" stroke="rgba(255,255,255,0.1)" />
                      
                      {/* Scatter points */}
                      {ptcResult.dataPoints.map((p, i) => {
                        const maxMean = Math.max(...ptcResult.dataPoints.map(point => point.meanSignal), 1);
                        const maxVariance = Math.max(...ptcResult.dataPoints.map(point => point.variance), 1e-12);
                        const xVal = 30 + (p.meanSignal / maxMean) * 180;
                        const yVal = 100 - (p.variance / maxVariance) * 80;
                        return (
                          <circle key={i} cx={xVal} cy={yVal} r="3" fill="var(--accent-blue)" />
                        );
                      })}
                      {/* Fitted line indicator */}
                      <line x1="30" y1="95" x2="180" y2="25" stroke="rgba(56,189,248,0.5)" strokeDasharray="3,3" />
                      <text x="35" y="112" fill="var(--text-muted)" fontSize="6">0 ADU</text>
                      <text x="195" y="112" fill="var(--text-muted)" fontSize="6">65K ADU</text>
                      <text x="5" y="55" fill="var(--text-muted)" fontSize="6" transform="rotate(-90 5 55)">Variance</text>
                    </svg>
                  </div>
                </div>
              )}
            </div>
          )}

          {/* ================= 2. OPTICAL ABERRATION ================= */}
          {activeTool === 'aberration' && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
              <h3 style={{ fontSize: '0.85rem', fontWeight: 600, color: 'var(--text-main)', margin: 0 }}>Optical Aberration Field Analyzer</h3>
              <p style={{ fontSize: '0.75rem', color: 'var(--text-muted)', margin: 0 }}>
                Compare PSF width and orientation across a 5x5 grid to score patterns consistent with coma, astigmatism, field curvature, and sensor tilt.
              </p>

              <button className="btn-primary" onClick={handleRunAberration} disabled={isAnalyzingPSF || !activeFile} style={{ alignSelf: 'flex-start' }}>
                <Play size={12} /> {isAnalyzingPSF ? 'Fitting PSFs...' : 'Run Aberration Audit'}
              </button>

              {aberrationResult && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem', borderTop: '1px solid var(--border)', paddingTop: '0.5rem' }}>
                  <div style={{ fontSize: '0.7rem', fontWeight: 600, color: 'var(--text-muted)' }}>Aberration Breakdown:</div>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '0.35rem' }}>
                    {[
                      { name: 'Field Curvature', val: aberrationResult.diagnosis.fieldCurvature.severity, desc: 'Swelling of stars away from center' },
                      { name: 'Coma', val: aberrationResult.diagnosis.coma.severity, desc: 'Radial flaring oriented from center' },
                      { name: 'Astigmatism', val: aberrationResult.diagnosis.astigmatism.severity, desc: 'Crossed elliptical distortion pattern' },
                      { name: 'Sensor Tilt', val: aberrationResult.diagnosis.tilt.severity, desc: 'Linear defocus gradient across frame' },
                    ].map(ab => {
                      const pct = Math.round(ab.val * 100);
                      let color = 'hsl(140, 80%, 45%)';
                      if (pct > 60) color = 'hsl(0, 80%, 55%)';
                      else if (pct > 30) color = 'hsl(40, 80%, 50%)';
                      
                      return (
                        <div key={ab.name} style={{ display: 'flex', flexDirection: 'column', padding: '0.35rem', backgroundColor: 'rgba(255,255,255,0.02)', border: '1px solid var(--border)', borderRadius: '4px' }}>
                          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.7rem', fontWeight: 600 }}>
                            <span>{ab.name}</span>
                            <span style={{ color }}>{pct}% pattern score</span>
                          </div>
                          <div style={{ width: '100%', height: '4px', backgroundColor: 'rgba(255,255,255,0.05)', borderRadius: '2px', marginTop: '0.2rem', overflow: 'hidden' }}>
                            <div style={{ width: `${pct}%`, height: '100%', backgroundColor: color }} />
                          </div>
                        </div>
                      );
                    })}
                  </div>

                  {/* SVG 5x5 PSF Grid Map */}
                  <div style={{ marginTop: '0.25rem' }}>
                    <div style={{ fontSize: '0.65rem', fontWeight: 600, color: 'var(--text-muted)', marginBottom: '0.25rem' }}>PSF Aberration Field Map (5x5):</div>
                    <div style={{
                      display: 'grid',
                      gridTemplateColumns: 'repeat(5, 1fr)',
                      gap: '2px',
                      backgroundColor: 'rgba(0,0,0,0.2)',
                      padding: '4px',
                      borderRadius: '4px',
                      border: '1px solid var(--border)',
                      aspectRatio: '1 / 1',
                      width: '100%',
                      maxWidth: '180px',
                      margin: '0.25rem auto'
                    }}>
                      {Array.from({ length: 25 }).map((_, idx) => {
                        const gx = idx % 5;
                        const gy = Math.floor(idx / 5);
                        const cell = aberrationResult.grid.find(c => c.gridX === gx && c.gridY === gy);
                        
                        if (!cell || cell.nStars === 0) {
                          return (
                            <div key={idx} style={{
                              backgroundColor: 'rgba(255,255,255,0.02)',
                              border: '1px solid rgba(255,255,255,0.03)',
                              display: 'flex',
                              alignItems: 'center',
                              justifyContent: 'center',
                              fontSize: '0.55rem',
                              color: 'var(--text-muted)'
                            }}>
                              —
                            </div>
                          );
                        }

                        const maxFwhm = Math.max(cell.fwhmX, cell.fwhmY);
                        let cellBg = 'rgba(16, 185, 129, 0.1)'; 
                        let cellBorder = 'rgba(16, 185, 129, 0.3)';
                        if (maxFwhm > 5) {
                          cellBg = 'rgba(239, 68, 68, 0.15)'; 
                          cellBorder = 'rgba(239, 68, 68, 0.4)';
                        } else if (maxFwhm > 3) {
                          cellBg = 'rgba(245, 158, 11, 0.12)'; 
                          cellBorder = 'rgba(245, 158, 11, 0.35)';
                        }

                        const rotDeg = (cell.angle * 180) / Math.PI;
                        const majScale = 12;
                        const minScale = 12 * (1.0 - cell.eccentricity);

                        return (
                          <div key={idx} title={`Cell (${gx},${gy}): ${cell.nStars} stars\nFWHM: ${maxFwhm.toFixed(2)}px\nEccentricity: ${cell.eccentricity.toFixed(2)}`} style={{
                            backgroundColor: cellBg,
                            border: `1px solid ${cellBorder}`,
                            display: 'flex',
                            flexDirection: 'column',
                            alignItems: 'center',
                            justifyContent: 'center',
                            position: 'relative',
                            aspectRatio: '1 / 1'
                          }}>
                            <svg viewBox="0 0 30 30" style={{ width: '80%', height: '80%' }}>
                              <ellipse
                                cx="15"
                                cy="15"
                                rx={majScale / 2}
                                ry={minScale / 2}
                                transform={`rotate(${rotDeg} 15 15)`}
                                fill="none"
                                stroke="var(--accent-blue)"
                                strokeWidth="1.5"
                              />
                            </svg>
                            <span style={{ fontSize: '0.45rem', color: 'var(--text-muted)', position: 'absolute', bottom: '1px', right: '1px', transform: 'scale(0.85)' }}>
                              {maxFwhm.toFixed(1)}
                            </span>
                          </div>
                        );
                      })}
                    </div>
                  </div>

                  <div style={{ fontSize: '0.7rem', color: 'var(--text-main)', fontStyle: 'italic', marginTop: '0.2rem', padding: '0.4rem', borderLeft: '3px solid var(--accent-blue)', backgroundColor: 'rgba(56,189,248,0.03)' }}>
                    {aberrationResult.diagnosis.summary}
                  </div>
                </div>
              )}
            </div>
          )}

          {/* ================= 3. SED PLANCK ESTIMATOR ================= */}
          {activeTool === 'sed' && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
              <h3 style={{ fontSize: '0.85rem', fontWeight: 600, color: 'var(--text-main)', margin: 0 }}>RGB Color-Temperature Estimate</h3>
              <p style={{ fontSize: '0.75rem', color: 'var(--text-muted)', margin: 0 }}>
                Measure background-subtracted RGB fluxes and fit a blackbody color temperature. Results are approximate unless channels are photometrically calibrated.
              </p>

              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.5rem' }}>
                <div>
                  <label style={{ fontSize: '0.65rem', color: 'var(--text-muted)' }}>Star Center X (px)</label>
                  <input type="number" value={starX} onChange={e => setStarX(Number(e.target.value))} className="input-text" style={{ width: '100%', fontSize: '0.7rem', padding: '0.25rem' }} />
                </div>
                <div>
                  <label style={{ fontSize: '0.65rem', color: 'var(--text-muted)' }}>Star Center Y (px)</label>
                  <input type="number" value={starY} onChange={e => setStarY(Number(e.target.value))} className="input-text" style={{ width: '100%', fontSize: '0.7rem', padding: '0.25rem' }} />
                </div>
                <div style={{ gridColumn: 'span 2' }}>
                  <label style={{ fontSize: '0.65rem', color: 'var(--text-muted)' }}>Aperture Radius (px): {apRadius}px</label>
                  <input type="range" min="3" max="25" value={apRadius} onChange={e => setApRadius(Number(e.target.value))} style={{ width: '100%' }} />
                </div>
              </div>

              <button className="btn-primary" onClick={handleRunSED} style={{ alignSelf: 'flex-start' }}>
                <Play size={12} /> Fit Star Blackbody
              </button>

              {sedResult && sedApertureResult && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem', borderTop: '1px solid var(--border)', paddingTop: '0.5rem' }}>
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.5rem' }}>
                    <div style={{ padding: '0.5rem', backgroundColor: 'rgba(255,255,255,0.03)', borderRadius: '4px', border: '1px solid var(--border)' }}>
                      <div style={{ fontSize: '0.65rem', color: 'var(--text-muted)' }}>Color Temperature</div>
                      <div style={{ fontSize: '0.95rem', fontWeight: 700, color: 'var(--accent-blue)' }}>{sedResult.temperature} K</div>
                    </div>
                    <div style={{ padding: '0.5rem', backgroundColor: 'rgba(255,255,255,0.03)', borderRadius: '4px', border: '1px solid var(--border)' }}>
                      <div style={{ fontSize: '0.65rem', color: 'var(--text-muted)' }}>Class-like Color</div>
                      <div style={{ fontSize: '0.95rem', fontWeight: 700, color: 'var(--accent-blue)' }}>{sedResult.spectralClass}-Type</div>
                    </div>
                    <div style={{ padding: '0.5rem', backgroundColor: 'rgba(255,255,255,0.03)', borderRadius: '4px', border: '1px solid var(--border)' }}>
                      <div style={{ fontSize: '0.65rem', color: 'var(--text-muted)' }}>Inferred B-V</div>
                      <div style={{ fontSize: '0.95rem', fontWeight: 700, color: 'var(--text-main)' }}>{sedResult.colorIndexBV.toFixed(2)}</div>
                    </div>
                    <div style={{ padding: '0.5rem', backgroundColor: 'rgba(255,255,255,0.03)', borderRadius: '4px', border: '1px solid var(--border)' }}>
                      <div style={{ fontSize: '0.65rem', color: 'var(--text-muted)' }}>Aperture SNR</div>
                      <div style={{ fontSize: '0.95rem', fontWeight: 700, color: 'var(--text-main)' }}>{sedApertureResult.snr.toFixed(1)}</div>
                    </div>
                  </div>

                  {/* SVG Blackbody Fitting Curve */}
                  <div style={{ marginTop: '0.25rem' }}>
                    <div style={{ fontSize: '0.65rem', fontWeight: 600, color: 'var(--text-muted)', marginBottom: '0.25rem' }}>Normalized blackbody fit:</div>
                    <svg viewBox="0 0 240 100" style={{ width: '100%', height: '90px', backgroundColor: 'rgba(0,0,0,0.2)', borderRadius: '4px', border: '1px solid var(--border)' }}>
                      <polyline
                        points={sedResult.modelCurve.map(p => `${30 + ((p.wavelength_nm - 350) / 400) * 180},${85 - p.relativeFlux * 60}`).join(' ')}
                        fill="none"
                        stroke="rgba(239, 68, 68, 0.75)"
                        strokeWidth="1.5"
                      />
                      
                      {/* Filter photometry points */}
                      {sedApertureResult.flux.slice(0, 3).map((f: number, i: number) => {
                        // R (620nm), G (530nm), B (450nm)
                        const wls = [620, 530, 450];
                        const colors = ['#EF4444', '#10B981', '#3B82F6'];
                        const xVal = 30 + ((wls[i] - 350) / 400) * 180;
                        const yVal = 85 - (f / (Math.max(...sedApertureResult.flux) || 1)) * 60;
                        return (
                          <circle key={i} cx={xVal} cy={yVal} r="4" fill={colors[i]} stroke="white" strokeWidth="0.5" />
                        );
                      })}
                      <text x="35" y="95" fill="var(--text-muted)" fontSize="6">350nm</text>
                      <text x="195" y="95" fill="var(--text-muted)" fontSize="6">750nm</text>
                    </svg>
                  </div>
                </div>
              )}
            </div>
          )}

          {/* ================= 4. ATMOSPHERIC EXTINCTION ================= */}
          {activeTool === 'extinction' && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
              <h3 style={{ fontSize: '0.85rem', fontWeight: 600, color: 'var(--text-main)', margin: 0 }}>Atmospheric Extinction & Airmass</h3>
              <p style={{ fontSize: '0.75rem', color: 'var(--text-muted)', margin: 0 }}>
                Estimate the Rayleigh-only atmospheric term from target altitude and site elevation. Aerosols, ozone, humidity, and filter response are not modeled.
              </p>

              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.5rem' }}>
                <div>
                  <label style={{ fontSize: '0.65rem', color: 'var(--text-muted)' }}>Target Altitude (deg)</label>
                  <input
                    type="number"
                    min="1"
                    max="90"
                    value={obsAltitude}
                    onChange={e => {
                      setObsAltitude(Number(e.target.value));
                      setExtinctionCorrectionFactors(null);
                    }}
                    className="input-text"
                    style={{ width: '100%', fontSize: '0.7rem', padding: '0.25rem' }}
                  />
                </div>
                <div>
                  <label style={{ fontSize: '0.65rem', color: 'var(--text-muted)' }}>Site Elevation (m)</label>
                  <input
                    type="number"
                    min="0"
                    max="8000"
                    value={siteAltitude}
                    onChange={e => setSiteAltitude(Number(e.target.value))}
                    className="input-text"
                    style={{ width: '100%', fontSize: '0.7rem', padding: '0.25rem' }}
                  />
                </div>
              </div>

              <div style={{ display: 'flex', gap: '0.5rem' }}>
                <button className="btn-secondary" onClick={handleComputeExtinction} style={{ flex: 1 }}>
                  <RefreshCw size={12} /> Compute Coefficients
                </button>
                <button
                  className="btn-primary"
                  onClick={handleApplyExtinctionCorrection}
                  disabled={!extinctionCorrectionFactors || !activeFile}
                  style={{ flex: 1 }}
                >
                  <Sliders size={12} /> Apply Extinction Correction
                </button>
              </div>

              {extinctionCorrectionFactors && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '0.4rem', borderTop: '1px solid var(--border)', paddingTop: '0.5rem' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.75rem', borderBottom: '1px solid rgba(255,255,255,0.05)', paddingBottom: '0.2rem' }}>
                    <span>Calculated Airmass (X)</span>
                    <span style={{ fontWeight: 700, color: 'var(--accent-blue)' }}>{airmass.toFixed(3)}</span>
                  </div>
                  <div style={{ fontSize: '0.7rem', fontWeight: 600, color: 'var(--text-muted)', marginTop: '0.25rem' }}>Top-of-atmosphere scale factors:</div>
                  <div style={{ display: 'flex', justifyContent: 'space-around', padding: '0.25rem 0' }}>
                    <div style={{ textAlign: 'center' }}>
                      <div style={{ fontSize: '0.65rem', color: 'var(--text-muted)' }}>Red (620nm)</div>
                      <div style={{ fontSize: '0.85rem', fontWeight: 700, color: '#EF4444' }}>{extinctionCorrectionFactors.r.toFixed(4)}x</div>
                    </div>
                    <div style={{ textAlign: 'center' }}>
                      <div style={{ fontSize: '0.65rem', color: 'var(--text-muted)' }}>Green (530nm)</div>
                      <div style={{ fontSize: '0.85rem', fontWeight: 700, color: '#10B981' }}>{extinctionCorrectionFactors.g.toFixed(4)}x</div>
                    </div>
                    <div style={{ textAlign: 'center' }}>
                      <div style={{ fontSize: '0.65rem', color: 'var(--text-muted)' }}>Blue (450nm)</div>
                      <div style={{ fontSize: '0.85rem', fontWeight: 700, color: '#3B82F6' }}>{extinctionCorrectionFactors.b.toFixed(4)}x</div>
                    </div>
                  </div>
                </div>
              )}
            </div>
          )}

          {/* ================= 5. SNR CALCULATOR ================= */}
          {activeTool === 'snr' && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
              <h3 style={{ fontSize: '0.85rem', fontWeight: 600, color: 'var(--text-main)', margin: 0 }}>SNR & Integration Time Estimator</h3>
              <p style={{ fontSize: '0.75rem', color: 'var(--text-muted)', margin: 0 }}>
                Estimate aperture SNR with source, sky, read, dark, and sky-estimation noise, then project integration under square-root stacking.
              </p>

              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.5rem' }}>
                <div>
                  <label style={{ fontSize: '0.65rem', color: 'var(--text-muted)' }}>Target X (px)</label>
                  <input type="number" value={snrTargetX} onChange={e => setSnrTargetX(Number(e.target.value))} className="input-text" style={{ width: '100%', fontSize: '0.7rem', padding: '0.25rem' }} />
                </div>
                <div>
                  <label style={{ fontSize: '0.65rem', color: 'var(--text-muted)' }}>Target Y (px)</label>
                  <input type="number" value={snrTargetY} onChange={e => setSnrTargetY(Number(e.target.value))} className="input-text" style={{ width: '100%', fontSize: '0.7rem', padding: '0.25rem' }} />
                </div>
                <div>
                  <label style={{ fontSize: '0.65rem', color: 'var(--text-muted)' }}>Camera Gain (e-/ADU)</label>
                  <input type="number" step="0.1" value={cameraGain} onChange={e => setCameraGain(Number(e.target.value))} className="input-text" style={{ width: '100%', fontSize: '0.7rem', padding: '0.25rem' }} />
                </div>
                <div>
                  <label style={{ fontSize: '0.65rem', color: 'var(--text-muted)' }}>Read Noise (e-)</label>
                  <input type="number" value={cameraReadNoise} onChange={e => setCameraReadNoise(Number(e.target.value))} className="input-text" style={{ width: '100%', fontSize: '0.7rem', padding: '0.25rem' }} />
                </div>
                <div>
                  <label style={{ fontSize: '0.65rem', color: 'var(--text-muted)' }}>Aperture Radius (px)</label>
                  <input type="number" value={snrAperture} onChange={e => setSnrAperture(Number(e.target.value))} className="input-text" style={{ width: '100%', fontSize: '0.7rem', padding: '0.25rem' }} />
                </div>
                <div>
                  <label style={{ fontSize: '0.65rem', color: 'var(--text-muted)' }}>Dark Current (e-/px/s)</label>
                  <input type="number" step="0.01" value={cameraDarkCurrent} onChange={e => setCameraDarkCurrent(Number(e.target.value))} className="input-text" style={{ width: '100%', fontSize: '0.7rem', padding: '0.25rem' }} />
                </div>
                <div>
                  <label style={{ fontSize: '0.65rem', color: 'var(--text-muted)' }}>Current Frames</label>
                  <input type="number" value={currentFramesCount} onChange={e => setCurrentFramesCount(Number(e.target.value))} className="input-text" style={{ width: '100%', fontSize: '0.7rem', padding: '0.25rem' }} />
                </div>
                <div>
                  <label style={{ fontSize: '0.65rem', color: 'var(--text-muted)' }}>Exposure Time (s)</label>
                  <input type="number" value={exposureTimeSec} onChange={e => setExposureTimeSec(Number(e.target.value))} className="input-text" style={{ width: '100%', fontSize: '0.7rem', padding: '0.25rem' }} />
                </div>
                <div style={{ gridColumn: 'span 2' }}>
                  <label style={{ fontSize: '0.65rem', color: 'var(--text-muted)' }}>Target Desired SNR: {targetSNR}</label>
                  <input type="range" min="10" max="250" value={targetSNR} onChange={e => setTargetSNR(Number(e.target.value))} style={{ width: '100%' }} />
                </div>
              </div>

              <button className="btn-primary" onClick={handleRunSNR} style={{ alignSelf: 'flex-start' }}>
                <Play size={12} /> Analyze target SNR
              </button>

              {snrMeasurement && integrationEstimate && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem', borderTop: '1px solid var(--border)', paddingTop: '0.5rem' }}>
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.4rem' }}>
                    <div style={{ padding: '0.4rem', backgroundColor: 'rgba(255,255,255,0.03)', borderRadius: '4px', border: '1px solid var(--border)' }}>
                      <div style={{ fontSize: '0.65rem', color: 'var(--text-muted)' }}>Measured SNR</div>
                      <div style={{ fontSize: '0.9rem', fontWeight: 700, color: 'var(--accent-blue)' }}>{snrMeasurement.measuredSNR.toFixed(2)}</div>
                    </div>
                    <div style={{ padding: '0.4rem', backgroundColor: 'rgba(255,255,255,0.03)', borderRadius: '4px', border: '1px solid var(--border)' }}>
                      <div style={{ fontSize: '0.65rem', color: 'var(--text-muted)' }}>Required Frames</div>
                      <div style={{ fontSize: '0.9rem', fontWeight: 700, color: 'var(--accent-blue)' }}>{integrationEstimate.requiredFrames} <span style={{ fontSize: '0.65rem', fontWeight: 500 }}>frames</span></div>
                    </div>
                  </div>

                  <div style={{ fontSize: '0.65rem', fontWeight: 600, color: 'var(--text-muted)', marginTop: '0.2rem' }}>Noise Budget Breakdown (Electrons):</div>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '0.2rem' }}>
                    {[
                      { name: 'Star Photon Noise', val: snrMeasurement.noiseBreakdown.photonNoise, color: '#3B82F6' },
                      { name: 'Sky Background Noise', val: snrMeasurement.noiseBreakdown.skyNoise, color: '#10B981' },
                      { name: 'Read Noise Floor', val: snrMeasurement.noiseBreakdown.readNoise, color: '#8B5CF6' },
                      { name: 'Sensor Dark Noise', val: snrMeasurement.noiseBreakdown.darkNoise, color: '#F59E0B' },
                    ].map(n => {
                      const total = snrMeasurement.noiseBreakdown.totalNoise || 1;
                      const pct = Math.round(((n.val * n.val) / (total * total)) * 100);
                      return (
                        <div key={n.name} style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', fontSize: '0.65rem' }}>
                          <span style={{ display: 'inline-block', width: '8px', height: '8px', backgroundColor: n.color, borderRadius: '2px' }} />
                          <span style={{ flex: 1, color: 'var(--text-muted)' }}>{n.name} ({n.val.toFixed(1)} e-)</span>
                          <span style={{ fontWeight: 600 }}>{pct}%</span>
                        </div>
                      );
                    })}
                  </div>

                  <div style={{ fontSize: '0.7rem', color: 'var(--text-main)', fontStyle: 'italic', marginTop: '0.2rem', padding: '0.4rem', borderLeft: '3px solid var(--accent-blue)', backgroundColor: 'rgba(56,189,248,0.03)' }}>
                    To reach target SNR = {targetSNR}, you need {integrationEstimate.requiredFrames} frames ({((integrationEstimate.requiredFrames * exposureTimeSec) / 3600).toFixed(1)} hrs total integration).
                  </div>
                </div>
              )}
            </div>
          )}

          {/* ================= 6. FOURIER FFT ANALYZER ================= */}
          {activeTool === 'fourier' && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
              <h3 style={{ fontSize: '0.85rem', fontWeight: 600, color: 'var(--text-main)', margin: 0 }}>2D Fourier Power Spectrum Analyzer</h3>
              <p style={{ fontSize: '0.75rem', color: 'var(--text-muted)', margin: 0 }}>
                Compute the 2D Fast Fourier Transform (FFT) of the image to analyze periodic tracking errors, sensor banding harmonics, and grid diffraction lines in frequency space.
              </p>

              <button className="btn-primary" onClick={handleRunFourier} disabled={isAnalyzingFourier || !activeFile} style={{ alignSelf: 'flex-start' }}>
                <Play size={12} /> {isAnalyzingFourier ? 'Running FFT...' : 'Compute 2D FFT'}
              </button>

              <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem', alignItems: 'center', marginTop: '0.25rem' }}>
                <canvas
                  ref={fourierCanvasRef}
                  style={{
                    width: '100%',
                    height: '180px',
                    backgroundColor: 'rgba(0,0,0,0.3)',
                    border: '1px solid var(--border)',
                    borderRadius: '4px',
                    display: fourierResult ? 'block' : 'none'
                  }}
                />
                {!fourierResult && (
                  <div style={{ width: '100%', height: '180px', backgroundColor: 'rgba(0,0,0,0.1)', border: '1px dashed var(--border)', borderRadius: '4px', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--text-muted)', fontSize: '0.75rem' }}>
                    FFT power spectrum will display here
                  </div>
                )}
              </div>

              {fourierResult && fourierResult.peakFrequencies.length > 0 && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '0.4rem', borderTop: '1px solid var(--border)', paddingTop: '0.5rem' }}>
                  <div style={{ fontSize: '0.7rem', fontWeight: 600, color: 'var(--text-muted)' }}>Detected Banding Harmonics:</div>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '0.25rem' }}>
                    {fourierResult.peakFrequencies.slice(0, 3).map((p, idx) => (
                      <div key={idx} style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.65rem', padding: '0.2rem', backgroundColor: 'rgba(255,255,255,0.02)', border: '1px solid var(--border)', borderRadius: '2px' }}>
                        <span>Banding Spike {idx + 1} (fx={p.fx}, fy={p.fy})</span>
                        <span style={{ fontWeight: 600, color: 'var(--accent-blue)' }}>Period = {p.periodPx.toFixed(1)} px</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}

          {/* ================= 7. VIGNETTING MODELER ================= */}
          {activeTool === 'vignetting' && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
              <h3 style={{ fontSize: '0.85rem', fontWeight: 600, color: 'var(--text-main)', margin: 0 }}>Radial Vignetting Model</h3>
              <p style={{ fontSize: '0.75rem', color: 'var(--text-muted)', margin: 0 }}>
                Fit a centered cos⁴ radial falloff to the image background and correct the active master. Gradients or extended nebulosity can bias this fit.
              </p>

              <div style={{ display: 'flex', gap: '0.5rem' }}>
                <button className="btn-secondary" onClick={handleRunVignettingModel} disabled={isModelingVignetting || !activeFile} style={{ flex: 1 }}>
                  <RefreshCw size={12} /> {isModelingVignetting ? 'Fitting Model...' : 'Fit cos⁴ Model'}
                </button>
                <button className="btn-primary" onClick={handleApplyVignettingCorrection} disabled={!vignettingModel || !activeFile} style={{ flex: 1 }}>
                  <Sliders size={12} /> Apply Correction
                </button>
              </div>

              {vignettingModel && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem', borderTop: '1px solid var(--border)', paddingTop: '0.5rem' }}>
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.5rem' }}>
                    <div style={{ padding: '0.4rem', backgroundColor: 'rgba(255,255,255,0.03)', borderRadius: '4px', border: '1px solid var(--border)' }}>
                      <div style={{ fontSize: '0.65rem', color: 'var(--text-muted)' }}>Fitted Radial Scale</div>
                      <div style={{ fontSize: '0.9rem', fontWeight: 700, color: 'var(--accent-blue)' }}>{vignettingModel.effectiveFocalPx.toFixed(0)} <span style={{ fontSize: '0.65rem', fontWeight: 500 }}>px</span></div>
                    </div>
                    <div style={{ padding: '0.4rem', backgroundColor: 'rgba(255,255,255,0.03)', borderRadius: '4px', border: '1px solid var(--border)' }}>
                      <div style={{ fontSize: '0.65rem', color: 'var(--text-muted)' }}>Assumed Image Center</div>
                      <div style={{ fontSize: '0.9rem', fontWeight: 700, color: 'var(--text-main)' }}>({vignettingModel.opticalCenterX.toFixed(0)}, {vignettingModel.opticalCenterY.toFixed(0)})</div>
                    </div>
                  </div>

                  {/* SVG radial profile plot */}
                  <div>
                    <div style={{ fontSize: '0.65rem', fontWeight: 600, color: 'var(--text-muted)', marginBottom: '0.25rem' }}>Radial Intensity Profile (Measured vs cos⁴ Model):</div>
                    <svg viewBox="0 0 240 100" style={{ width: '100%', height: '90px', backgroundColor: 'rgba(0,0,0,0.2)', borderRadius: '4px', border: '1px solid var(--border)' }}>
                      {/* Model line */}
                      <path
                        d={"M 30 " + (85 - (vignettingModel.radialProfile[0]?.modeled / vignettingModel.amplitude || 1) * 60) + " " +
                          vignettingModel.radialProfile.map((pt, idx) => {
                            const x = 30 + (idx / vignettingModel.radialProfile.length) * 180;
                            const y = 85 - (pt.modeled / vignettingModel.amplitude) * 60;
                            return `L ${x} ${y}`;
                          }).join(' ')
                        }
                        fill="none"
                        stroke="rgba(56, 189, 248, 0.7)"
                        strokeWidth="1.5"
                      />
                      {/* Measured points */}
                      {vignettingModel.radialProfile.filter((_, i) => i % 4 === 0).map((pt, i) => {
                        const xVal = 30 + (i * 4 / vignettingModel.radialProfile.length) * 180;
                        const yVal = 85 - (pt.measured / vignettingModel.amplitude) * 60;
                        return (
                          <circle key={i} cx={xVal} cy={yVal} r="2" fill="var(--text-muted)" />
                        );
                      })}
                      <text x="35" y="95" fill="var(--text-muted)" fontSize="6">Center</text>
                      <text x="195" y="95" fill="var(--text-muted)" fontSize="6">Edge</text>
                    </svg>
                  </div>
                </div>
              )}
            </div>
          )}

        </div>
      </div>
    </div>
  );
}
