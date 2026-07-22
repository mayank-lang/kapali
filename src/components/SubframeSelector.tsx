import React, { useEffect } from 'react';
import { Target, SlidersHorizontal, Save } from 'lucide-react';
import { type SharedFile } from '../App';
import { calculateImageMetrics } from '../utils/photometry';

export interface FrameStats {
  id: number;
  name: string;
  fwhm: number;         // pixels (lower is better; no plate scale is assumed)
  eccentricity: number; // 0.2 to 0.9 (lower is better)
  snrWeight: number;    // 10 to 100 (higher is better)
  rejected: boolean;
}

interface SubframeSelectorProps {
  sharedFiles: SharedFile[];
  addLog: (type: 'info' | 'success' | 'warning' | 'error', msg: string) => void;
  frames: FrameStats[];
  setFrames: React.Dispatch<React.SetStateAction<FrameStats[]>>;
  activeMetric: 'fwhm' | 'eccentricity' | 'snrWeight';
  setActiveMetric: (m: 'fwhm' | 'eccentricity' | 'snrWeight') => void;
  thresholds: { fwhm: number; eccentricity: number; snrWeight: number };
  setThresholds: React.Dispatch<React.SetStateAction<{ fwhm: number; eccentricity: number; snrWeight: number }>>;
}

const SubframeSelector: React.FC<SubframeSelectorProps> = ({ 
  sharedFiles, addLog, frames, setFrames, activeMetric, setActiveMetric, thresholds, setThresholds 
}) => {

  // Generate real stats on mount if frames list is empty
  useEffect(() => {
    if (sharedFiles.length === 0 || frames.length > 0) return;
    
    addLog('info', 'Executing Siril-inspired Star Detection and PSF calculation on workspace files...');
    
    setTimeout(() => {
      const realFrames: FrameStats[] = [];
      let idCounter = 1;
      
      for (const file of sharedFiles) {
        if (file.parsedFits && file.parsedFits.floatData) {
          const metrics = calculateImageMetrics(
            file.parsedFits.width, 
            file.parsedFits.height, 
            file.parsedFits.floatData
          );
          
          realFrames.push({
            id: idCounter++,
            name: file.name,
            fwhm: metrics.fwhm,
            eccentricity: metrics.eccentricity,
            snrWeight: metrics.snrWeight,
            rejected: false
          });
        }
      }
      
      if (realFrames.length > 0) {
        setFrames(realFrames);
        addLog('success', `Subframe metrics computed successfully for ${realFrames.length} frames.`);
      } else {
        addLog('warning', 'No valid FITS arrays loaded. Please open FITS files to calculate metrics.');
      }
    }, 100);
  }, [sharedFiles, addLog, frames.length, setFrames]);

  // Evaluate frames based on current thresholds
  const evaluatedFrames = React.useMemo(() => {
    return frames.map(f => {
      let isRejected = false;
      if (f.fwhm > thresholds.fwhm) isRejected = true;
      if (f.eccentricity > thresholds.eccentricity) isRejected = true;
      if (f.snrWeight < thresholds.snrWeight) isRejected = true;
      return { ...f, rejected: isRejected };
    });
  }, [frames, thresholds]);

  const approvedCount = evaluatedFrames.filter(f => !f.rejected).length;
  const rejectedCount = evaluatedFrames.filter(f => f.rejected).length;

  const handleThresholdChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setThresholds(prev => ({
      ...prev,
      [activeMetric]: parseFloat(e.target.value)
    }));
  };

  const getScale = () => {
    let min = 0;
    let max = 100;
    if (activeMetric === 'fwhm') { min = 1.0; max = 7.0; }
    if (activeMetric === 'eccentricity') { min = 0.0; max = 1.0; }
    if (activeMetric === 'snrWeight') { min = 0; max = 100; }
    return { min, max };
  };

  const { min: yMin, max: yMax } = getScale();

  const metricLabels = {
    fwhm: { label: 'FWHM (px)', desc: 'Median fitted star width. Lower is sharper.', invert: false, step: 0.1 },
    eccentricity: { label: 'Eccentricity', desc: 'Measures star trailing. Lower is rounder.', invert: false, step: 0.05 },
    snrWeight: { label: 'Quality Weight', desc: 'Relative ranking from stars, width, and shape.', invert: true, step: 1 }
  };

  const currentSettings = metricLabels[activeMetric];

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem', height: '100%', overflowY: 'auto' }}>
      
      {/* Module Header */}
      <div className="sidebar-module-header">
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <h2 className="sidebar-module-title">
            <Target size={16} color="var(--accent-purple)" />
            Subframe Selector
          </h2>
          <button 
            onClick={() => addLog('success', `Saved ${approvedCount} approved frames to integration queue. Discarded ${rejectedCount} outliers.`)}
            disabled={frames.length === 0}
            className="btn-primary"
            style={{ padding: '0.25rem 0.5rem' }}
          >
            <Save size={12} /> Approve Queue
          </button>
        </div>
        <p className="sidebar-module-desc">Rank subframes by pixel FWHM, eccentricity, and a relative quality weight.</p>
      </div>

      {frames.length === 0 ? (
        <div style={{ padding: '2rem 1rem', textAlign: 'center', color: 'var(--text-muted)', fontSize: '0.8rem', border: '1px dashed var(--border)', borderRadius: '6px' }}>
          Please ingest FITS files to calculate PSF metrics.
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.6rem' }}>
          
          {/* Metric Selector Card */}
          <div className="control-card">
            <div className="control-card-title">
              <SlidersHorizontal size={12} /> Metric Filters
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.4rem' }}>
              {(['fwhm', 'eccentricity', 'snrWeight'] as const).map(metric => (
                <button
                  key={metric}
                  onClick={() => setActiveMetric(metric)}
                  className={activeMetric === metric ? "btn-primary" : "btn-secondary"}
                  style={{
                    justifyContent: 'flex-start',
                    textAlign: 'left',
                    padding: '0.4rem 0.6rem',
                    width: '100%',
                    display: 'flex',
                    flexDirection: 'column',
                    alignItems: 'flex-start',
                    gap: '0.1rem',
                    height: 'auto'
                  }}
                >
                  <span style={{ fontWeight: 700, fontSize: '0.75rem', color: activeMetric === metric ? 'white' : 'var(--text-main)' }}>
                    {metricLabels[metric].label}
                  </span>
                  <span style={{ fontSize: '0.65rem', color: activeMetric === metric ? 'rgba(255,255,255,0.7)' : 'var(--text-muted)' }}>
                    {metricLabels[metric].desc}
                  </span>
                </button>
              ))}
            </div>
          </div>

          {/* Range Slider Card */}
          <div className="control-card">
            <div className="control-card-title">
              Filter Threshold
            </div>
            <div className="form-label-row">
              <span>{currentSettings.invert ? 'Minimum' : 'Maximum'} Allowed:</span>
              <span>{thresholds[activeMetric]}</span>
            </div>
            <input 
              type="range" 
              min={yMin} 
              max={yMax} 
              step={currentSettings.step}
              value={thresholds[activeMetric]}
              onChange={handleThresholdChange}
              className="input-range"
            />
            <div style={{ fontSize: '0.68rem', color: 'var(--text-muted)', fontStyle: 'italic', marginTop: '0.15rem' }}>
              {currentSettings.invert 
                ? `Frames below ${thresholds[activeMetric]} will be discarded.` 
                : `Frames above ${thresholds[activeMetric]} will be discarded.`}
            </div>
          </div>

          {/* Selection Summary Card */}
          <div className="control-card">
            <div className="control-card-title">
              Selection Summary
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.4rem' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', backgroundColor: 'rgba(16, 185, 129, 0.04)', padding: '0.4rem 0.6rem', borderRadius: '4px', border: '1px solid rgba(16, 185, 129, 0.15)', fontSize: '0.75rem' }}>
                <span style={{ color: 'var(--success)', fontWeight: 600 }}>Approved frames</span>
                <span style={{ fontWeight: 700, color: 'var(--success)', fontFamily: 'var(--font-mono)' }}>{approvedCount}</span>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', backgroundColor: 'rgba(239, 68, 68, 0.04)', padding: '0.4rem 0.6rem', borderRadius: '4px', border: '1px solid rgba(239, 68, 68, 0.15)', fontSize: '0.75rem' }}>
                <span style={{ color: 'var(--danger)', fontWeight: 600 }}>Rejected frames</span>
                <span style={{ fontWeight: 700, color: 'var(--danger)', fontFamily: 'var(--font-mono)' }}>{rejectedCount}</span>
              </div>
            </div>
          </div>

        </div>
      )}
    </div>
  );

};

export default SubframeSelector;
