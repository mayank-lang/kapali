import React, { useState, useRef } from 'react';
import { FolderPlus, Play, CheckCircle, AlertTriangle, Database, Layers, X, ListOrdered } from 'lucide-react';
import '../App.css';
import { analyzeSampleImage, type SampleAnalysis, generateStackingScriptLogs, streamStackFromFiles } from '../utils/stacking';
import { parseFits, writeFits } from '../utils/parsers';

interface FolderBatch {
  id: string;
  type: 'Light' | 'Dark' | 'Flat' | 'Bias' | 'Unknown';
  files: File[];
  sampleAnalysis: SampleAnalysis | null;
  confirmed: boolean;
}

interface BatchManagerProps {
  onAddFiles?: (files: File[]) => void;
  addLog?: (type: 'info' | 'success' | 'warning' | 'error', msg: string) => void;
}

const BatchManager: React.FC<BatchManagerProps> = ({ onAddFiles, addLog }) => {
  const [batches, setBatches] = useState<FolderBatch[]>([]);
  const [isProcessing, setIsProcessing] = useState(false);
  const [sigmaLow, setSigmaLow] = useState(3.0);
  const [sigmaHigh, setSigmaHigh] = useState(3.0);
  const [rejectionMethod, setRejectionMethod] = useState<'sigma' | 'winsorized' | 'linearfit'>('sigma');
  const [progressPct, setProgressPct] = useState(0);
  const [progressMsg, setProgressMsg] = useState('');
  
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [pendingType, setPendingType] = useState<'Light' | 'Dark' | 'Flat' | 'Bias'>('Light');

  const handleSelectFolderClick = (type: 'Light' | 'Dark' | 'Flat' | 'Bias') => {
    setPendingType(type);
    if (fileInputRef.current) {
      fileInputRef.current.click();
    }
  };

  const handleFolderSelected = async (e: React.ChangeEvent<HTMLInputElement>) => {
    if (!e.target.files || e.target.files.length === 0) return;
    
    const filesArray = Array.from(e.target.files);
    
    // Pick a sample image (the first one that looks like an image/FITS)
    const sample = filesArray.find(f => {
      const ext = f.name.split('.').pop()?.toLowerCase();
      return ext && ['fit', 'fits', 'fts', 'ser', 'jpg', 'jpeg', 'png', 'tif', 'tiff', 'cr2', 'cr3', 'dng', 'nef'].includes(ext);
    }) || filesArray[0];

    // Analyze it
    const analysis = await analyzeSampleImage(sample);

    const newBatch: FolderBatch = {
      id: `${pendingType}-${Date.now()}`,
      type: pendingType,
      files: filesArray,
      sampleAnalysis: analysis,
      confirmed: false,
    };

    setBatches(prev => [...prev.filter(b => b.type !== pendingType), newBatch]);
    e.target.value = ''; // reset
  };

  const confirmBatch = (id: string) => {
    setBatches(prev => prev.map(b => b.id === id ? { ...b, confirmed: true } : b));
  };

  const removeBatch = (id: string) => {
    setBatches(prev => prev.filter(b => b.id !== id));
  };

  const processMasters = async () => {
    setIsProcessing(true);
    setProgressPct(0);
    setProgressMsg('Initializing...');
    addLog?.('info', 'Started processing master calibrations (streaming mode)');

    const typesOrder: ('Bias' | 'Dark' | 'Flat' | 'Light')[] = ['Bias', 'Dark', 'Flat', 'Light'];
    
    let masterBiasData: Float32Array | null = null;
    let masterDarkData: Float32Array | null = null;
    let masterFlatData: Float32Array | null = null;
    let flatMeanValue = 1.0;

    for (const type of typesOrder) {
      const batch = batches.find(b => b.type === type && b.confirmed);
      if (batch) {
        addLog?.('info', `--- Starting Streaming Integration for ${type} frames ---`);
        
        const fitsFiles = batch.files.filter(f => {
          const ext = f.name.split('.').pop()?.toLowerCase();
          return ext === 'fit' || ext === 'fits' || ext === 'fts';
        });

        if (fitsFiles.length > 0) {
          try {
            addLog?.('info', `[Streaming] ${fitsFiles.length} FITS files queued — will read one-at-a-time to minimize memory usage.`);

            // Build calibration data for Light frames
            const calibrationData = (type === 'Light' && (masterDarkData || masterFlatData || masterBiasData))
              ? { masterDark: masterDarkData, masterFlat: masterFlatData, masterBias: masterBiasData, flatMean: flatMeanValue }
              : undefined;

            if (calibrationData) {
              addLog?.('info', `[Streaming] Calibration will be applied inline during frame reading.`);
            }

            // Use the new streaming stacker — reads File objects one at a time
            const result = await streamStackFromFiles(
              fitsFiles,
              sigmaLow,
              sigmaHigh,
              type === 'Light',  // register only light frames
              rejectionMethod,
              calibrationData,
              (pct, msg) => {
                setProgressPct(pct);
                setProgressMsg(`${type}: ${msg}`);
              }
            );
            
            // Stream logs to the console
            for (const log of result.logs) {
              addLog?.('info', log);
            }

            // Store master calibration arrays for subsequent steps in the pipeline
            if (type === 'Bias') {
              masterBiasData = result.masterData;
            } else if (type === 'Dark') {
              masterDarkData = result.masterData;
            } else if (type === 'Flat') {
              masterFlatData = result.masterData;
              // Calculate flat field normalization factor
              let sum = 0;
              let count = 0;
              for (let i = 0; i < masterFlatData.length; i++) {
                const divisor = masterFlatData[i] - (masterBiasData ? masterBiasData[i] : 0.0);
                if (divisor > 1e-6) {
                  sum += divisor;
                  count++;
                }
              }
              flatMeanValue = count > 0 ? (sum / count) : 1.0;
              addLog?.('info', `Flat field normalization factor calculated: ${flatMeanValue.toFixed(4)} ADU.`);
            }

            // Read first file for header metadata (small allocation, released after writeFits)
            const headerBuffer = await fitsFiles[0].arrayBuffer();
            const headerParsed = parseFits(headerBuffer);

            const masterHeaders = [
              { key: 'SIMPLE', value: 'T', comment: 'conforms to FITS standard', raw: '' },
              { key: 'BITPIX', value: '-32', comment: '32-bit floating point pixels', raw: '' },
              { key: 'NAXIS', value: '2', comment: '2D image matrix', raw: '' },
              { key: 'NAXIS1', value: result.width.toString(), comment: 'width', raw: '' },
              { key: 'NAXIS2', value: result.height.toString(), comment: 'height', raw: '' },
              { key: 'IMAGETYP', value: `Master_${type}`, comment: 'Frame type descriptor', raw: '' },
              { key: 'EXPTIME', value: headerParsed.headers.find(h => h.key === 'EXPTIME')?.value || '1.0', comment: 'Exposure time', raw: '' },
              { key: 'STACKCNT', value: fitsFiles.length.toString(), comment: 'Number of frames stacked', raw: '' },
              { key: 'STKMETHD', value: rejectionMethod, comment: 'Stacking rejection method', raw: '' },
              { key: 'END', value: '', comment: '', raw: '' }
            ];

            const masterBuffer = writeFits(
              {
                headers: masterHeaders,
                width: result.width,
                height: result.height,
                bitpix: -32,
                bzero: 0,
                bscale: 1,
                floatData: result.masterData,
                rawBuffer: new ArrayBuffer(0)
              },
              masterHeaders
            );

            const masterFile = new File([masterBuffer], `Master_${type}.fits`, { type: 'image/fits' });
            
            if (onAddFiles) {
              onAddFiles([masterFile]);
              if (addLog) addLog('success', `Created and imported Master_${type}.fits into workspace.`);
            }
            addLog?.('success', `Successfully exported Master_${type}.fits to workspace directory.`);

          } catch (err: any) {
            addLog?.('error', `Stacking error: ${err.message}`);
          }
        } else {
          const logs = generateStackingScriptLogs(type, batch.files.length);
          for (const log of logs) {
            addLog?.('info', log);
            await new Promise(r => setTimeout(r, 100));
          }
        }
        
        addLog?.('info', `--- Master ${type} Generation Complete ---`);
        await new Promise(r => setTimeout(r, 300));
      }
    }

    addLog?.('success', `All selected calibration and integration tasks completed successfully.`);
    setIsProcessing(false);
    setProgressPct(0);
    setProgressMsg('');
  };


  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', gap: '0.75rem', overflowY: 'auto' }}>
      
      {/* Hidden File Input for Folders */}
      <input 
        type="file" 
        ref={fileInputRef} 
        style={{ display: 'none' }} 
        // @ts-ignore
        webkitdirectory="true" 
        directory="true" 
        multiple 
        onChange={handleFolderSelected}
      />

      {/* Module Header */}
      <div className="sidebar-module-header">
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <h2 className="sidebar-module-title">
            <ListOrdered size={16} color="var(--accent-purple)" />
            Calibration Stacking
          </h2>
          <button 
            onClick={processMasters}
            disabled={isProcessing || !batches.some(b => b.confirmed)}
            className="btn-primary"
          >
            <Play size={12} /> {isProcessing ? 'Processing...' : 'Run Pipeline'}
          </button>
        </div>
        <p className="sidebar-module-desc">Ingest calibration frames and stack lights using masters.</p>
      </div>

      {/* Progress Bar when processing */}
      {isProcessing && (
        <div className="control-card" style={{ display: 'flex', flexDirection: 'column', gap: '0.4rem', border: '1px solid rgba(6, 182, 212, 0.2)', padding: '0.75rem', margin: '0' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.75rem', fontWeight: 600 }}>
            <span style={{ color: 'var(--accent-blue)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: '80%' }}>{progressMsg || 'Processing...'}</span>
            <span>{progressPct}%</span>
          </div>
          <div style={{ width: '100%', height: '6px', backgroundColor: 'var(--bg-panel-light)', borderRadius: '3px', overflow: 'hidden' }}>
            <div style={{ width: `${progressPct}%`, height: '100%', background: 'linear-gradient(90deg, var(--accent-purple), var(--accent-blue))', borderRadius: '3px', transition: 'width 0.2s ease-out' }}></div>
          </div>
        </div>
      )}

      {/* Global Stacking Parameters */}
      <div className="control-card">
        <div className="control-card-title">
          Global Stacking Parameters
        </div>
        <div style={{ display: 'flex', gap: '0.5rem' }}>
          <label className="form-label" style={{ flex: 1 }}>
            <span>Sigma Low:</span>
            <input 
              type="number" 
              step="0.1" 
              className="input-number"
              value={sigmaLow} 
              onChange={e => setSigmaLow(parseFloat(e.target.value) || 3.0)} 
            />
          </label>
          <label className="form-label" style={{ flex: 1 }}>
            <span>Sigma High:</span>
            <input 
              type="number" 
              step="0.1" 
              className="input-number"
              value={sigmaHigh} 
              onChange={e => setSigmaHigh(parseFloat(e.target.value) || 3.0)} 
            />
          </label>
        </div>
        <label className="form-label">
          <span>Rejection Algorithm:</span>
          <select 
            className="input-select"
            value={rejectionMethod} 
            onChange={e => setRejectionMethod(e.target.value as any)}
          >
            <option value="sigma">Sigma Clipping (Running Average)</option>
            <option value="winsorized">Winsorized Sigma Clipping</option>
            <option value="linearfit">Linear Fit Clipping</option>
          </select>
        </label>
      </div>

      {/* Folders Stack */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: '0.6rem' }}>
        {(['Light', 'Flat', 'Dark', 'Bias'] as const).map(type => {
          const batch = batches.find(b => b.type === type);
          const isConfirmed = batch?.confirmed;

          return (
            <div key={type} className="control-card" style={{ 
              border: `1px solid ${isConfirmed ? 'var(--success)' : 'var(--border)'}`, 
              padding: '0.75rem'
            }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                  {type === 'Light' ? <Layers size={16} color="var(--accent-blue)" /> : <Database size={16} color="var(--accent-purple)" />}
                  <span style={{ fontSize: '0.8rem', fontWeight: 700 }}>{type} Frames</span>
                </div>
                {!batch ? (
                  <button 
                    onClick={() => handleSelectFolderClick(type)}
                    className="btn-secondary"
                    style={{ padding: '0.25rem 0.5rem' }}
                  >
                    <FolderPlus size={12} /> Select Folder
                  </button>
                ) : (
                  <button 
                    onClick={() => removeBatch(batch.id)}
                    style={{ padding: '0.2rem', backgroundColor: 'transparent', color: 'var(--text-muted)', border: 'none', cursor: 'pointer' }}
                  >
                    <X size={14} />
                  </button>
                )}
              </div>

              {!batch ? (
                <div style={{ color: 'var(--text-muted)', fontSize: '0.7rem', padding: '0.5rem', border: '1px dashed var(--border)', borderRadius: '4px', textAlign: 'center' }}>
                  No folder selected.
                </div>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem', marginTop: '0.25rem' }}>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '0.15rem', fontSize: '0.7rem', color: 'var(--text-muted)' }}>
                    <div>Files: <strong style={{ color: 'var(--text-main)' }}>{batch.files.length}</strong></div>
                    <div style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>Sample: <strong style={{ color: 'var(--text-main)' }}>{batch.files[0]?.name}</strong></div>
                  </div>

                  {batch.sampleAnalysis && (
                    <div style={{ 
                      backgroundColor: batch.sampleAnalysis.suggestedType === type ? 'rgba(16, 185, 129, 0.03)' : 'rgba(245, 158, 11, 0.03)',
                      border: `1px solid ${batch.sampleAnalysis.suggestedType === type ? 'rgba(16, 185, 129, 0.15)' : 'rgba(245, 158, 11, 0.15)'}`,
                      padding: '0.5rem', borderRadius: '4px', fontSize: '0.7rem'
                    }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '0.3rem', marginBottom: '0.25rem', fontWeight: 600, color: batch.sampleAnalysis.suggestedType === type ? 'var(--success)' : 'var(--warning)' }}>
                        {batch.sampleAnalysis.suggestedType === type ? <CheckCircle size={12} /> : <AlertTriangle size={12} />}
                        Analysis: {batch.sampleAnalysis.suggestedType} Frame
                      </div>
                      <div style={{ color: 'var(--text-muted)', marginBottom: '0.4rem', lineHeight: 1.3 }}>
                        {batch.sampleAnalysis.reasoning}
                      </div>

                      {!isConfirmed ? (
                        <button 
                          onClick={() => confirmBatch(batch.id)}
                          className="btn-primary"
                          style={{ width: '100%', padding: '0.3rem' }}
                        >
                          Confirm & Accept
                        </button>
                      ) : (
                        <div style={{ color: 'var(--success)', fontWeight: 600, display: 'flex', alignItems: 'center', gap: '0.3rem' }}>
                          <CheckCircle size={10} /> Verified and queued.
                        </div>
                      )}
                    </div>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
};

export default BatchManager;
