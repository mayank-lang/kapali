import React, { useState, useRef } from 'react';
import { Plus, Play, Save, Trash2 } from 'lucide-react';
import '../App.css';
import { type SharedFile } from '../App';
import { writeFits } from '../utils/parsers';
import { streamStackFits } from '../utils/stacking';
import { executeDynamicBackgroundExtraction, executeLinearMatch, executeColorCalibration } from '../utils/background';
import { executeSCNR, executeAsinhTransform, executeBandingReduction, executeRotationalGradient, executeWaveletTransform, executeColorSaturation, executeCosmeticCorrection, executeWaveletNoiseReduction, executeRichardsonLucyDeconvolution, executeHistogramTransformation, executeGeneralizedHyperbolicStretch, executeMaskedStretch, executeStarSeparation, executeStarReduction, executeCLAHE, executeMultiscaleWaveletContrast, executeFinalStarCorrection } from '../utils/filters';
import { calculateStats } from '../utils/stretch';


interface WorkflowBuilderProps {
  sharedFiles: SharedFile[];
  activeFile: SharedFile | null;
  onUpdateFits: (id: string, newData: Float32Array) => void;
  onSelectFile: (id: string) => void;
  onAddFiles: (files: File[]) => Promise<void>;
  addLog: (type: 'info' | 'success' | 'warning' | 'error', msg: string) => void;
}

interface WorkflowStep {
  id: string;
  op: 'stack' | 'dbe' | 'scnr' | 'asinh' | 'banding' | 'rgradient' | 'wavelets' | 'lmatch' | 'saturation' | 'cosmetic' | 'colorcalib' | 'noise' | 'deconv' | 'ht' | 'ghs' | 'maskedstretch' | 'starnet' | 'starreduce' | 'clahe' | 'waveletcontrast' | 'starcorrect' | 'script';
  name: string;
  params: any;
}

const WorkflowBuilder: React.FC<WorkflowBuilderProps> = ({ 
  sharedFiles, activeFile, onUpdateFits, onSelectFile, onAddFiles, addLog 
}) => {
  const [isRunning, setIsRunning] = useState(false);
  const [activeStepId, setActiveStepId] = useState<string | null>(null);
  const [terminalLog, setTerminalLog] = useState<string>('Workflow engine idle. Ingest FITS files and build a sequence.');
  
  const filesRef = useRef(sharedFiles);
  filesRef.current = sharedFiles;

  // Custom workflow steps sequence
  const [sequence, setSequence] = useState<WorkflowStep[]>([
    { id: '1', op: 'dbe', name: 'Planar Background Neutralization (DBE)', params: { tolerance: 1.5, smoothing: 0.5 } },
    { id: '2', op: 'asinh', name: 'Asinh Hyperbolic Sine Stretch', params: { beta: 20.0, offset: 0.005, rgbSpace: true } }
  ]);

  // Operations palette
  const operations = [
    { op: 'stack', name: 'Stack Images (Sigma Clipping)', desc: 'Run stream-stack on all FITS files.' },
    { op: 'dbe', name: 'Apply DBE', desc: 'Neutralize planar light pollution gradient.' },
    { op: 'lmatch', name: 'Apply Linear Match (LMATCH)', desc: 'Match intensity stats to a reference image.' },
    { op: 'scnr', name: 'Apply SCNR (Green noise reduction)', desc: 'Remove chrominance noise cast.' },
    { op: 'asinh', name: 'Apply Asinh Stretch', desc: 'Hyperbolic sine stretch for star protection.' },
    { op: 'banding', name: 'Apply Banding Reduction', desc: 'Clean horizontal/vertical noise lines.' },
    { op: 'rgradient', name: 'Apply Rotational Gradient', desc: 'Enhance concentric shells or comets.' },
    { op: 'wavelets', name: 'Apply Wavelet Sharpen (à trous)', desc: 'Multi-scale frequency detail filter.' },
    { op: 'saturation', name: 'Apply Saturation', desc: 'Enhance or reduce color saturation by range.' },
    { op: 'cosmetic', name: 'Apply Cosmetic Correction', desc: 'Remove deviant hot and cold pixels.' },
    { op: 'colorcalib', name: 'Apply Color Calibration', desc: 'Perform manual/auto background neutralization and white balance.' },
    { op: 'noise', name: 'Apply Wavelet Noise Reduction', desc: 'Filter high-frequency noise using multiscale wavelet thresholds.' },
    { op: 'deconv', name: 'Apply Richardson-Lucy Deconvolution', desc: 'Sharpen stars and details with local deringing.' },
    { op: 'ht', name: 'Apply Histogram Transformation', desc: 'Stretch image using shadows, highlights, and midtones.' },
    { op: 'ghs', name: 'Apply Generalized Hyperbolic Stretch', desc: 'Stretch image around a Symmetry Point.' },
    { op: 'maskedstretch', name: 'Apply Masked Stretch', desc: 'Progressive star-protected stretch.' },
    { op: 'starnet', name: 'Apply Star Separation', desc: 'Separate stars and nebula into separate layers.' },
    { op: 'starreduce', name: 'Apply Star Reduction', desc: 'Shrink or scale down star profiles.' },
    { op: 'clahe', name: 'Apply CLAHE Local Contrast', desc: 'Local adaptive contrast enhancement on luminance.' },
    { op: 'waveletcontrast', name: 'Apply Wavelet Contrast', desc: 'Multiscale contrast enhancement with noise gating.' },
    { op: 'starcorrect', name: 'Apply Final Star Correction', desc: 'Recover star core colors and suppress dark halos.' },
    { op: 'script', name: 'Apply Custom Script', desc: 'Execute a custom JavaScript processing routine.' }
  ] as const;

  const addStep = (op: typeof operations[number]['op'], name: string) => {
    let params: any = {};
    if (op === 'stack') params = { sigma: 3.0, iterations: 2, register: true, method: 'sigma' };
    else if (op === 'dbe') params = { tolerance: 1.5, smoothing: 0.5 };
    else if (op === 'scnr') params = { type: 0, amount: 1.0, preserveLuminance: true };
    else if (op === 'asinh') params = { beta: 10.0, offset: 0.0, rgbSpace: true };
    else if (op === 'banding') params = { sigma: 3.0, amount: 0.9, protectHighlights: true, vertical: false };
    else if (op === 'rgradient') params = { dR: 2, da: 1.0 };
    else if (op === 'wavelets') params = { plans: 5, type: 2, coefficients: [1.0, 1.0, 1.0, 1.0, 1.0] };
    else if (op === 'lmatch') params = { refFileId: '' };
    else if (op === 'saturation') params = { amount: 0.5, hueType: 6, backgroundFactor: 0.0 };
    else if (op === 'cosmetic') params = { sigmaHot: 3.0, sigmaCold: 3.0, enableHot: true, enableCold: true, isCfa: false };
    else if (op === 'colorcalib') params = { autoBg: true, bgRed: 0.0, bgGreen: 0.0, bgBlue: 0.0, autoWhite: true, whiteRed: 1.0, whiteGreen: 1.0, whiteBlue: 1.0 };
    else if (op === 'noise') params = { plans: 4, amount: 0.5, type: 2, thresholds: [3.0, 2.0, 1.0, 0.5] };
    else if (op === 'deconv') params = { iterations: 10, psfSize: 5, psfSigma: 1.5, deringing: 0.5, deringingThreshold: 0.02 };
    else if (op === 'ht') params = { shadows: 0.0, highlights: 1.0, midtones: 0.5 };
    else if (op === 'ghs') params = { sp: 0.01, d: 10.0 };
    else if (op === 'maskedstretch') params = { targetMedian: 0.125, iterations: 6 };
    else if (op === 'starnet') params = { threshold: 3.0, expansion: 3, feather: 2, iterations: 30, outputType: 'starless' };
    else if (op === 'starreduce') params = { threshold: 3.0, expansion: 3, feather: 2, amount: 0.5, method: 'scaling' };
    else if (op === 'clahe') params = { clipLimit: 2.5, gridSize: 8 };
    else if (op === 'waveletcontrast') params = { biases: [1.2, 1.15, 1.1, 1.05, 1.0], noiseThreshold: 2.0, amount: 1.0, type: 2 };
    else if (op === 'starcorrect') params = { threshold: 3.0, expansion: 3, feather: 2, restoreColor: true, repairRinging: true };
    else if (op === 'script') params = { code: `// Custom pixel multiplication script\nfor (let i = 0; i < floatData.length; i++) {\n  floatData[i] = Math.min(1.0, floatData[i] * 1.2);\n}\nreturn floatData;` };


    const newStep: WorkflowStep = {
      id: `${op}-${Date.now()}-${Math.random()}`,
      op,
      name,
      params
    };
    setSequence(prev => [...prev, newStep]);
  };

  const removeStep = (id: string) => {
    setSequence(prev => prev.filter(s => s.id !== id));
  };

  const updateParam = (stepId: string, paramKey: string, val: any) => {
    setSequence(prev => prev.map(s => {
      if (s.id === stepId) {
        return {
          ...s,
          params: {
            ...s.params,
            [paramKey]: val
          }
        };
      }
      return s;
    }));
  };

  const updateWaveletCoeff = (stepId: string, index: number, val: number) => {
    setSequence(prev => prev.map(s => {
      if (s.id === stepId && s.op === 'wavelets') {
        const copy = [...s.params.coefficients];
        copy[index] = val;
        return {
          ...s,
          params: {
            ...s.params,
            coefficients: copy
          }
        };
      }
      return s;
    }));
  };

  const updateNoiseThreshold = (stepId: string, index: number, val: number) => {
    setSequence(prev => prev.map(s => {
      if (s.id === stepId && s.op === 'noise') {
        const copy = [...s.params.thresholds];
        copy[index] = val;
        return {
          ...s,
          params: {
            ...s.params,
            thresholds: copy
          }
        };
      }
      return s;
    }));
  };

  const runWorkflow = async () => {
    if (sequence.length === 0) {
      addLog('warning', 'Workflow aborted: Sequence is empty.');
      return;
    }

    setIsRunning(true);
    setTerminalLog('Initializing workflow engine automator...\n');
    addLog('info', 'Executing workflow automator sequence...');

    let currentFile = activeFile;
 
    for (let i = 0; i < sequence.length; i++) {
      currentFile = (currentFile ? filesRef.current.find(f => f.id === currentFile!.id) : null)
        || filesRef.current[filesRef.current.length - 1]
        || null;
      const step = sequence[i];
      setActiveStepId(step.id);
      setTerminalLog(prev => prev + `\n--- [Step ${i + 1}/${sequence.length}] Executing: ${step.name} ---\n`);

      try {
        if (step.op === 'stack') {
          // Stacking operates on all loaded FITS files
          setTerminalLog(prev => prev + `Scanning workspace for FITS frames to stack...\n`);
          const fitsFiles = sharedFiles.filter(f => f.type === 'fits');
          if (fitsFiles.length === 0) {
            throw new Error('No FITS files loaded in the workspace for stacking.');
          }

          setTerminalLog(prev => prev + `Found ${fitsFiles.length} files. Initiating streaming stack...\n`);
          
          const stackResult = streamStackFits(
            fitsFiles, 
            step.params.sigma, 
            step.params.sigma,
            step.params.register !== false,
            step.params.method || 'sigma'
          );

          // Append stacking logs to our console
          setTerminalLog(prev => prev + stackResult.logs.join('\n') + '\n');

          // Build a new FITS file buffer in memory
          setTerminalLog(prev => prev + `Reconstructing FITS header matrix...\n`);
          const firstFits = fitsFiles.find(f => f.parsedFits);
          if (!firstFits || !firstFits.parsedFits) {
            throw new Error('No valid parsed FITS metadata found.');
          }
          const headers = firstFits.parsedFits.headers;

          const newParsedFits = {
            width: stackResult.width,
            height: stackResult.height,
            bitpix: -32,
            bzero: 0,
            bscale: 1,
            floatData: stackResult.masterData,
            headers: headers,
            rawBuffer: new ArrayBuffer(0)
          };
          const buffer = writeFits(newParsedFits, headers);
          const stackedFile = new File([buffer], "master_light_stacked.fits", { type: "image/fits" });

          // Ingest file and set it as active
          setTerminalLog(prev => prev + `Importing stacked master light to active workspace...\n`);
          await onAddFiles([stackedFile]);
          
          // Wait a brief moment for ingestion state to settle, then select it
          await new Promise(r => setTimeout(r, 600));
          const newlyAdded = filesRef.current.find(f => f.name === "master_light_stacked.fits");
          if (newlyAdded) {
            onSelectFile(newlyAdded.id);
            currentFile = newlyAdded;
            setTerminalLog(prev => prev + `Selected stacked master light: ${newlyAdded.name}\n`);
          }
          setTerminalLog(prev => prev + `Stacking step complete. Output: master_light_stacked.fits\n`);
        } 
        else {
          // Post-processing operations run on the active file
          // If a stack operation ran, the new file is ingested, but we need to fetch the latest activeFile
          let targetFile = currentFile;
          if (!targetFile && filesRef.current.length > 0) {
            targetFile = filesRef.current[filesRef.current.length - 1]; // fallback to last ingested
          }

          if (!targetFile || !targetFile.parsedFits) {
            throw new Error(`Active FITS file not found for processing step: ${step.name}`);
          }

          const floatData = targetFile.parsedFits.floatData;
          const width = targetFile.parsedFits.width;
          const height = targetFile.parsedFits.height;

          let processResult: { newData: Float32Array, logs: string[] };

          if (step.op === 'dbe') {
            processResult = executeDynamicBackgroundExtraction(
              width, height, floatData, step.params.tolerance, Math.floor(step.params.smoothing * 20) || 10
            );
          } 
          else if (step.op === 'lmatch') {
            const refFile = sharedFiles.find(f => f.id === step.params.refFileId) || sharedFiles.find(f => f.id !== targetFile?.id);
            if (!refFile || !refFile.parsedFits) {
              throw new Error('LMATCH requires a valid reference image in the workspace.');
            }
            processResult = executeLinearMatch(width, height, floatData, refFile.parsedFits.floatData);
          }
          else if (step.op === 'scnr') {
            processResult = executeSCNR(width, height, floatData, step.params.type, step.params.amount, step.params.preserveLuminance);
          }
          else if (step.op === 'asinh') {
            processResult = executeAsinhTransform(width, height, floatData, step.params.beta, step.params.offset, step.params.rgbSpace);
          }
          else if (step.op === 'banding') {
            processResult = executeBandingReduction(
              width, height, floatData, step.params.sigma, step.params.amount, step.params.protectHighlights, step.params.vertical
            );
          }
          else if (step.op === 'rgradient') {
            const xc = Math.floor(width / 2);
            const yc = Math.floor(height / 2);
            processResult = executeRotationalGradient(width, height, floatData, xc, yc, step.params.dR, step.params.da);
          }
          else if (step.op === 'wavelets') {
            processResult = executeWaveletTransform(width, height, floatData, step.params.plans, step.params.type, step.params.coefficients);
          }
          else if (step.op === 'saturation') {
            processResult = executeColorSaturation(width, height, floatData, step.params.amount, step.params.hueType, step.params.backgroundFactor);
          }
          else if (step.op === 'cosmetic') {
            const sh = step.params.enableHot ? step.params.sigmaHot : -1.0;
            const sc = step.params.enableCold ? step.params.sigmaCold : -1.0;
            processResult = executeCosmeticCorrection(width, height, floatData, sh, sc, step.params.isCfa);
          }
          else if (step.op === 'colorcalib') {
            processResult = executeColorCalibration(
              width, height, floatData,
              step.params.autoBg, step.params.bgRed, step.params.bgGreen, step.params.bgBlue,
              step.params.autoWhite, step.params.whiteRed, step.params.whiteGreen, step.params.whiteBlue
            );
          }
          else if (step.op === 'noise') {
            processResult = executeWaveletNoiseReduction(
              width, height, floatData, step.params.plans, step.params.thresholds, step.params.amount, step.params.type
            );
          }
          else if (step.op === 'deconv') {
            processResult = executeRichardsonLucyDeconvolution(
              width, height, floatData, step.params.iterations, step.params.psfSize, step.params.psfSigma, step.params.deringing, step.params.deringingThreshold
            );
          }
          else if (step.op === 'ht') {
            processResult = executeHistogramTransformation(
              width, height, floatData, step.params.shadows, step.params.highlights, step.params.midtones
            );
          }
          else if (step.op === 'ghs') {
            processResult = executeGeneralizedHyperbolicStretch(
              width, height, floatData, step.params.sp, step.params.d
            );
          }
          else if (step.op === 'maskedstretch') {
            processResult = executeMaskedStretch(
              width, height, floatData, step.params.targetMedian, step.params.iterations
            );
          }
          else if (step.op === 'starnet') {
            processResult = executeStarSeparation(
              width, height, floatData,
              step.params.threshold, step.params.expansion, step.params.feather, step.params.iterations,
              step.params.outputType
            );
          }
          else if (step.op === 'starreduce') {
            processResult = executeStarReduction(
              width, height, floatData,
              step.params.threshold, step.params.expansion, step.params.feather,
              step.params.amount, step.params.method
            );
          }
          else if (step.op === 'clahe') {
            processResult = executeCLAHE(
              width, height, floatData, step.params.clipLimit, step.params.gridSize
            );
          }
          else if (step.op === 'waveletcontrast') {
            processResult = executeMultiscaleWaveletContrast(
              width, height, floatData, step.params.biases, step.params.noiseThreshold, step.params.amount, step.params.type !== undefined ? step.params.type : 2
            );
          }
          else if (step.op === 'starcorrect') {
            processResult = executeFinalStarCorrection(
              width, height, floatData,
              step.params.threshold, step.params.expansion, step.params.feather,
              step.params.restoreColor, step.params.repairRinging
            );
          }
          else if (step.op === 'script') {
            setTerminalLog(prev => prev + `Running custom script sandbox execution...\n`);
            const floatDataCopy = new Float32Array(floatData);
            const channels = floatDataCopy.length / (width * height);
            
            const sandboxFunc = new Function(
              'floatData',
              'width',
              'height',
              'channels',
              'helpers',
              'sharedFiles',
              step.params.code || ''
            );

            const helpers = {
              scnr: executeSCNR,
              asinh: executeAsinhTransform,
              banding: executeBandingReduction,
              rotationalGradient: executeRotationalGradient,
              wavelet: executeWaveletTransform,
              colorSaturation: executeColorSaturation,
              cosmeticCorrection: executeCosmeticCorrection,
              dbe: executeDynamicBackgroundExtraction,
              linearMatch: executeLinearMatch,
              colorCalibration: executeColorCalibration,
              waveletNoiseReduction: executeWaveletNoiseReduction,
              richardsonLucyDeconvolution: executeRichardsonLucyDeconvolution,
              histogramTransformation: executeHistogramTransformation,
              generalizedHyperbolicStretch: executeGeneralizedHyperbolicStretch,
              maskedStretch: executeMaskedStretch,
              starSeparation: executeStarSeparation,
              starReduction: executeStarReduction,
              clahe: executeCLAHE,
              multiscaleWaveletContrast: executeMultiscaleWaveletContrast,
              finalStarCorrection: executeFinalStarCorrection,
              calculateStats: calculateStats
            };

            const result = sandboxFunc(floatDataCopy, width, height, channels, helpers, sharedFiles);

            if (result instanceof Float32Array) {
              if (result.length !== floatData.length) {
                throw new Error(`Returned Float32Array size mismatch. Expected ${floatData.length} elements, got ${result.length}.`);
              }
              processResult = {
                newData: result,
                logs: ['Custom script executed successfully.', `Output array size: ${result.length} elements.`]
              };
            } else {
              throw new Error('Script must return a modified Float32Array (e.g., return floatData;).');
            }
          }

          else {
            throw new Error(`Unsupported operation: ${step.op}`);
          }

          // Output algorithm logs
          setTerminalLog(prev => prev + processResult.logs.join('\n') + '\n');
          
          // Write FITS update in-memory
          onUpdateFits(targetFile.id, processResult.newData);
          setTerminalLog(prev => prev + `Applied changes to active file: ${targetFile?.name || ''}\n`);
        }
      } catch (err: any) {
        setTerminalLog(prev => prev + `Error: ${err.message || err}\nAborting sequence.\n`);
        addLog('error', `Workflow step failed: ${err.message || err}`);
        setActiveStepId(null);
        setIsRunning(false);
        return;
      }

      // Procedural pause
      await new Promise(r => setTimeout(r, 600));
    }

    setTerminalLog(prev => prev + '\n--- Workflow Execution Completed Successfully ---');
    addLog('success', 'Workflow sequence executed successfully.');
    setActiveStepId(null);
    setIsRunning(false);
  };

  const otherFiles = sharedFiles.filter(f => f.id !== activeFile?.id);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', gap: '0.75rem', overflow: 'hidden' }}>
      
      {/* Module Header */}
      <div className="sidebar-module-header">
        <h2 className="sidebar-module-title">
          <Plus size={16} color="var(--accent-purple)" />
          Workflow Automator
        </h2>
        <p className="sidebar-module-desc">Chain multiple background calibration, stretch, and filtering steps into a single macro pipeline.</p>
      </div>

      {/* Top Add Step Select & Execution Control Buttons */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem', flexShrink: 0 }}>
        <div className="control-card">
          <div className="control-card-title">Add Step to Sequence</div>
          <div style={{ display: 'flex', gap: '0.4rem' }}>
            <select 
              id="workflow-step-select" 
              className="input-select"
              defaultValue=""
            >
              <option value="" disabled>-- Select Step to Add --</option>
              {operations.map((op, idx) => (
                <option key={idx} value={op.op}>{op.name}</option>
              ))}
            </select>
            <button 
              onClick={() => {
                const selectEl = document.getElementById('workflow-step-select') as HTMLSelectElement;
                const val = selectEl?.value;
                if (val) {
                  const op = operations.find(o => o.op === val);
                  if (op) addStep(op.op, op.name);
                }
              }}
              className="btn-primary"
              style={{ padding: '0.45rem' }}
              title="Add step to pipeline"
            >
              <Plus size={16} />
            </button>
          </div>
        </div>

        <div style={{ display: 'flex', gap: '0.5rem' }}>
          <button 
            onClick={runWorkflow}
            disabled={isRunning || sequence.length === 0}
            className="btn-primary"
            style={{ flex: 2, padding: '0.55rem' }}
          >
            <Play size={12} />
            {isRunning ? 'Running...' : 'Run Sequence'}
          </button>
          
          <button 
            className="btn-secondary"
            style={{ flex: 1, padding: '0.55rem' }}
          >
            <Save size={12} /> Save Script
          </button>
        </div>
      </div>

      {/* Middle Active Sequence Pipeline */}
      <div style={{ flex: 1, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: '0.75rem', paddingRight: '0.25rem' }}>
        <div style={{ fontSize: '0.75rem', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <span>Active Pipeline Sequence</span>
          <span style={{ color: 'var(--accent-blue)', fontWeight: 600 }}>{sequence.length} steps</span>
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
          {sequence.map((step, index) => {
            const isActive = activeStepId === step.id;
            
            return (
              <div 
                key={step.id} 
                className="control-card"
                style={{ 
                  borderColor: isActive ? 'var(--accent-blue)' : 'var(--border)', 
                  backgroundColor: isActive ? 'rgba(59, 130, 246, 0.08)' : 'var(--bg-panel-light)',
                  margin: 0
                }}
              >
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
                    <span style={{ fontSize: '0.7rem', backgroundColor: 'var(--bg-panel-light)', padding: '0.1rem 0.3rem', borderRadius: '3px', fontWeight: 700 }}>
                      #{index + 1}
                    </span>
                    <span style={{ fontSize: '0.8rem', fontWeight: 600, color: isActive ? 'var(--accent-blue)' : 'var(--text-main)' }}>{step.name}</span>
                  </div>
                  <button 
                    onClick={() => removeStep(step.id)}
                    style={{ background: 'none', border: 'none', color: 'var(--danger)', cursor: 'pointer', opacity: 0.7 }}
                    title="Remove step"
                  >
                    <Trash2 size={12} />
                  </button>
                </div>

                {/* Inline step parameters based on type */}
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.5rem', padding: '0.25rem', borderTop: '1px dashed var(--border)', fontSize: '0.75rem', color: 'var(--text-muted)' }}>
                  
                  {step.op === 'stack' && (
                    <>
                      <label style={{ display: 'flex', alignItems: 'center', gap: '0.2rem' }}>
                        <span>Sigma:</span>
                        <input type="number" step="0.1" className="input-number" style={{ width: '45px', padding: '0.25rem' }} value={step.params.sigma} onChange={e => updateParam(step.id, 'sigma', parseFloat(e.target.value) || 0)} />
                      </label>
                      <label style={{ display: 'flex', alignItems: 'center', gap: '0.2rem' }}>
                        <span>Iter:</span>
                        <input type="number" className="input-number" style={{ width: '35px', padding: '0.25rem' }} value={step.params.iterations} onChange={e => updateParam(step.id, 'iterations', parseInt(e.target.value) || 0)} />
                      </label>
                      <label style={{ display: 'flex', alignItems: 'center', gap: '0.2rem' }}>
                        <span>Method:</span>
                        <select className="input-select" style={{ padding: '0.25rem' }} value={step.params.method || 'sigma'} onChange={e => updateParam(step.id, 'method', e.target.value)}>
                          <option value="sigma">Sigma Clipping</option>
                          <option value="winsorized">Winsorized Sigma</option>
                          <option value="linearfit">Linear Fit</option>
                        </select>
                      </label>
                      <label className="input-checkbox-container">
                        <input type="checkbox" checked={step.params.register !== false} onChange={e => updateParam(step.id, 'register', e.target.checked)} />
                        <span>Register</span>
                      </label>
                    </>
                  )}

                  {step.op === 'dbe' && (
                    <>
                      <label style={{ display: 'flex', alignItems: 'center', gap: '0.2rem' }}>
                        <span>Tol:</span>
                        <input type="number" step="0.1" className="input-number" style={{ width: '45px', padding: '0.25rem' }} value={step.params.tolerance} onChange={e => updateParam(step.id, 'tolerance', parseFloat(e.target.value) || 0)} />
                      </label>
                      <label style={{ display: 'flex', alignItems: 'center', gap: '0.2rem' }}>
                        <span>Smoothing:</span>
                        <input type="number" step="0.1" className="input-number" style={{ width: '45px', padding: '0.25rem' }} value={step.params.smoothing} onChange={e => updateParam(step.id, 'smoothing', parseFloat(e.target.value) || 0)} />
                      </label>
                    </>
                  )}

                  {step.op === 'scnr' && (
                    <>
                      <label style={{ display: 'flex', alignItems: 'center', gap: '0.2rem' }}>
                        <span>Type:</span>
                        <select className="input-select" style={{ padding: '0.25rem' }} value={step.params.type} onChange={e => updateParam(step.id, 'type', parseInt(e.target.value))}>
                          <option value="0">Average Neutral</option>
                          <option value="1">Max Neutral</option>
                          <option value="2">Max w/ Amount</option>
                        </select>
                      </label>
                      <label style={{ display: 'flex', alignItems: 'center', gap: '0.2rem' }}>
                        <span>Amount:</span>
                        <input type="number" step="0.1" className="input-number" style={{ width: '45px', padding: '0.25rem' }} value={step.params.amount} onChange={e => updateParam(step.id, 'amount', parseFloat(e.target.value) || 0)} />
                      </label>
                    </>
                  )}

                  {step.op === 'asinh' && (
                    <>
                      <label style={{ display: 'flex', alignItems: 'center', gap: '0.2rem' }}>
                        <span>β:</span>
                        <input type="number" className="input-number" style={{ width: '55px', padding: '0.25rem' }} value={step.params.beta} onChange={e => updateParam(step.id, 'beta', parseFloat(e.target.value) || 0)} />
                      </label>
                      <label style={{ display: 'flex', alignItems: 'center', gap: '0.2rem' }}>
                        <span>Black offset:</span>
                        <input type="number" step="0.001" className="input-number" style={{ width: '60px', padding: '0.25rem' }} value={step.params.offset} onChange={e => updateParam(step.id, 'offset', parseFloat(e.target.value) || 0)} />
                      </label>
                    </>
                  )}

                  {step.op === 'banding' && (
                    <>
                      <label style={{ display: 'flex', alignItems: 'center', gap: '0.2rem' }}>
                        <span>σ:</span>
                        <input type="number" step="0.5" className="input-number" style={{ width: '45px', padding: '0.25rem' }} value={step.params.sigma} onChange={e => updateParam(step.id, 'sigma', parseFloat(e.target.value) || 0)} />
                      </label>
                      <label style={{ display: 'flex', alignItems: 'center', gap: '0.2rem' }}>
                        <span>Amt:</span>
                        <input type="number" step="0.05" className="input-number" style={{ width: '45px', padding: '0.25rem' }} value={step.params.amount} onChange={e => updateParam(step.id, 'amount', parseFloat(e.target.value) || 0)} />
                      </label>
                      <label className="input-checkbox-container">
                        <input type="checkbox" checked={step.params.vertical} onChange={e => updateParam(step.id, 'vertical', e.target.checked)} />
                        <span>Vert</span>
                      </label>
                    </>
                  )}

                  {step.op === 'rgradient' && (
                    <>
                      <label style={{ display: 'flex', alignItems: 'center', gap: '0.2rem' }}>
                        <span>dR (px):</span>
                        <input type="number" className="input-number" style={{ width: '40px', padding: '0.25rem' }} value={step.params.dR} onChange={e => updateParam(step.id, 'dR', parseInt(e.target.value) || 0)} />
                      </label>
                      <label style={{ display: 'flex', alignItems: 'center', gap: '0.2rem' }}>
                        <span>dA (°):</span>
                        <input type="number" step="0.5" className="input-number" style={{ width: '45px', padding: '0.25rem' }} value={step.params.da} onChange={e => updateParam(step.id, 'da', parseFloat(e.target.value) || 0)} />
                      </label>
                    </>
                  )}

                  {step.op === 'lmatch' && (
                    <>
                      <label style={{ display: 'flex', alignItems: 'center', gap: '0.2rem' }}>
                        <span>Ref File:</span>
                        <select className="input-select" style={{ padding: '0.25rem', maxWidth: '120px' }} value={step.params.refFileId} onChange={e => updateParam(step.id, 'refFileId', e.target.value)}>
                          <option value="">(Auto select other)</option>
                          {otherFiles.map(f => (
                            <option key={f.id} value={f.id}>{f.name}</option>
                          ))}
                        </select>
                      </label>
                    </>
                  )}

                  {step.op === 'wavelets' && (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.25rem', width: '100%' }}>
                      <div style={{ display: 'flex', gap: '0.5rem' }}>
                        <label style={{ display: 'flex', alignItems: 'center', gap: '0.2rem' }}>
                          <span>Plans:</span>
                          <select className="input-select" style={{ padding: '0.25rem' }} value={step.params.plans} onChange={e => updateParam(step.id, 'plans', parseInt(e.target.value))}>
                            <option value="3">3</option>
                            <option value="4">4</option>
                            <option value="5">5</option>
                          </select>
                        </label>
                        <label style={{ display: 'flex', alignItems: 'center', gap: '0.2rem' }}>
                          <span>Kernel:</span>
                          <select className="input-select" style={{ padding: '0.25rem' }} value={step.params.type} onChange={e => updateParam(step.id, 'type', parseInt(e.target.value))}>
                            <option value="1">Linear</option>
                            <option value="2">B3-Spline</option>
                            <option value="3">Gaussian (5x5)</option>
                            <option value="4">Box/Haar (3x3)</option>
                            <option value="5">Cubic Spline (7x7)</option>
                          </select>
                        </label>
                      </div>
                      <div style={{ display: 'flex', gap: '0.4rem', flexWrap: 'wrap' }}>
                        {Array.from({ length: step.params.plans - 1 }).map((_, idx) => (
                          <label key={idx} style={{ display: 'flex', alignItems: 'center', gap: '0.15rem' }}>
                            <span>w{idx}:</span>
                            <input 
                              type="number" 
                              step="0.1" 
                              className="input-number"
                              style={{ width: '40px', padding: '0.25rem' }} 
                              value={step.params.coefficients[idx] || 1.0} 
                              onChange={e => updateWaveletCoeff(step.id, idx, parseFloat(e.target.value) || 0)} 
                            />
                          </label>
                        ))}
                      </div>
                    </div>
                  )}

                  {step.op === 'saturation' && (
                    <>
                      <label style={{ display: 'flex', alignItems: 'center', gap: '0.2rem' }}>
                        <span>Amount:</span>
                        <input type="number" step="0.1" className="input-number" style={{ width: '45px', padding: '0.25rem' }} value={step.params.amount} onChange={e => updateParam(step.id, 'amount', parseFloat(e.target.value) || 0)} />
                      </label>
                      <label style={{ display: 'flex', alignItems: 'center', gap: '0.2rem' }}>
                        <span>Band:</span>
                        <select className="input-select" style={{ padding: '0.25rem' }} value={step.params.hueType} onChange={e => updateParam(step.id, 'hueType', parseInt(e.target.value))}>
                          <option value="6">Global</option>
                          <option value="0">Pink-Red</option>
                          <option value="1">Orange-Brown</option>
                          <option value="2">Yellow-Green</option>
                          <option value="3">Cyan</option>
                          <option value="4">Cyan-Blue</option>
                          <option value="5">Magenta</option>
                        </select>
                      </label>
                      <label style={{ display: 'flex', alignItems: 'center', gap: '0.2rem' }}>
                        <span>BG Cut:</span>
                        <input type="number" step="0.5" className="input-number" style={{ width: '45px', padding: '0.25rem' }} value={step.params.backgroundFactor} onChange={e => updateParam(step.id, 'backgroundFactor', parseFloat(e.target.value) || 0)} />
                      </label>
                    </>
                  )}

                  {step.op === 'cosmetic' && (
                    <>
                      <label className="input-checkbox-container" style={{ display: 'inline-flex', alignItems: 'center', gap: '0.2rem' }}>
                        <input type="checkbox" checked={step.params.enableHot} onChange={e => updateParam(step.id, 'enableHot', e.target.checked)} />
                        <span>Hot σ:</span>
                      </label>
                      {step.params.enableHot && (
                        <input type="number" step="0.5" className="input-number" style={{ width: '40px', padding: '0.25rem' }} value={step.params.sigmaHot} onChange={e => updateParam(step.id, 'sigmaHot', parseFloat(e.target.value) || 0)} />
                      )}
                      <label className="input-checkbox-container" style={{ display: 'inline-flex', alignItems: 'center', gap: '0.2rem' }}>
                        <input type="checkbox" checked={step.params.enableCold} onChange={e => updateParam(step.id, 'enableCold', e.target.checked)} />
                        <span>Cold σ:</span>
                      </label>
                      {step.params.enableCold && (
                        <input type="number" step="0.5" className="input-number" style={{ width: '40px', padding: '0.25rem' }} value={step.params.sigmaCold} onChange={e => updateParam(step.id, 'sigmaCold', parseFloat(e.target.value) || 0)} />
                      )}
                      <label className="input-checkbox-container">
                        <input type="checkbox" checked={step.params.isCfa} onChange={e => updateParam(step.id, 'isCfa', e.target.checked)} />
                        <span>CFA</span>
                      </label>
                    </>
                  )}

                  {step.op === 'colorcalib' && (
                    <>
                      <label className="input-checkbox-container">
                        <input type="checkbox" checked={step.params.autoBg} onChange={e => updateParam(step.id, 'autoBg', e.target.checked)} />
                        <span>Auto Bg</span>
                      </label>
                      {!step.params.autoBg && (
                        <div style={{ display: 'flex', gap: '0.2rem' }}>
                          <input type="number" step="0.001" className="input-number" style={{ width: '40px', padding: '0.25rem' }} value={step.params.bgRed} onChange={e => updateParam(step.id, 'bgRed', parseFloat(e.target.value) || 0)} title="Red Offset" />
                          <input type="number" step="0.001" className="input-number" style={{ width: '40px', padding: '0.25rem' }} value={step.params.bgGreen} onChange={e => updateParam(step.id, 'bgGreen', parseFloat(e.target.value) || 0)} title="Green Offset" />
                          <input type="number" step="0.001" className="input-number" style={{ width: '40px', padding: '0.25rem' }} value={step.params.bgBlue} onChange={e => updateParam(step.id, 'bgBlue', parseFloat(e.target.value) || 0)} title="Blue Offset" />
                        </div>
                      )}
                      <label className="input-checkbox-container">
                        <input type="checkbox" checked={step.params.autoWhite} onChange={e => updateParam(step.id, 'autoWhite', e.target.checked)} />
                        <span>Auto White</span>
                      </label>
                      {!step.params.autoWhite && (
                        <div style={{ display: 'flex', gap: '0.2rem' }}>
                          <input type="number" step="0.05" className="input-number" style={{ width: '35px', padding: '0.25rem' }} value={step.params.whiteRed} onChange={e => { const val = parseFloat(e.target.value); updateParam(step.id, 'whiteRed', isNaN(val) ? 1.0 : val); }} title="Red Scale" />
                          <input type="number" step="0.05" className="input-number" style={{ width: '35px', padding: '0.25rem' }} value={step.params.whiteGreen} onChange={e => { const val = parseFloat(e.target.value); updateParam(step.id, 'whiteGreen', isNaN(val) ? 1.0 : val); }} title="Green Scale" />
                          <input type="number" step="0.05" className="input-number" style={{ width: '35px', padding: '0.25rem' }} value={step.params.whiteBlue} onChange={e => { const val = parseFloat(e.target.value); updateParam(step.id, 'whiteBlue', isNaN(val) ? 1.0 : val); }} title="Blue Scale" />
                        </div>
                      )}
                    </>
                  )}

                  {step.op === 'noise' && (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.25rem', width: '100%' }}>
                      <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
                        <label style={{ display: 'flex', alignItems: 'center', gap: '0.2rem' }}>
                          <span>Plans:</span>
                          <select className="input-select" style={{ padding: '0.25rem' }} value={step.params.plans} onChange={e => {
                            const plansVal = parseInt(e.target.value);
                            updateParam(step.id, 'plans', plansVal);
                            const newThres = [...step.params.thresholds];
                            if (newThres.length < plansVal) {
                              newThres.push(...Array(plansVal - newThres.length).fill(1.0));
                            } else {
                              newThres.splice(plansVal);
                            }
                            updateParam(step.id, 'thresholds', newThres);
                          }}>
                            <option value="2">2</option>
                            <option value="3">3</option>
                            <option value="4">4</option>
                            <option value="5">5</option>
                          </select>
                        </label>
                        <label style={{ display: 'flex', alignItems: 'center', gap: '0.2rem' }}>
                          <span>Kernel:</span>
                          <select className="input-select" style={{ padding: '0.25rem' }} value={step.params.type} onChange={e => updateParam(step.id, 'type', parseInt(e.target.value))}>
                            <option value="1">Linear</option>
                            <option value="2">B3-Spline</option>
                            <option value="3">Gaussian (5x5)</option>
                            <option value="4">Box/Haar (3x3)</option>
                            <option value="5">Cubic Spline (7x7)</option>
                          </select>
                        </label>
                        <label style={{ display: 'flex', alignItems: 'center', gap: '0.2rem' }}>
                          <span>Amt:</span>
                          <input type="number" step="0.1" className="input-number" style={{ width: '45px', padding: '0.25rem' }} value={step.params.amount} onChange={e => updateParam(step.id, 'amount', parseFloat(e.target.value) || 0)} />
                        </label>
                      </div>
                      <div style={{ display: 'flex', gap: '0.4rem', flexWrap: 'wrap', marginTop: '0.15rem' }}>
                        {Array.from({ length: step.params.plans - 1 }).map((_, idx) => (
                          <label key={idx} style={{ display: 'flex', alignItems: 'center', gap: '0.15rem' }}>
                            <span>L{idx + 1}(σ):</span>
                            <input 
                              type="number" 
                              step="0.1" 
                              className="input-number"
                              style={{ width: '40px', padding: '0.25rem' }} 
                              value={step.params.thresholds[idx] !== undefined ? step.params.thresholds[idx] : 1.0} 
                              onChange={e => updateNoiseThreshold(step.id, idx, parseFloat(e.target.value) || 0)} 
                            />
                          </label>
                        ))}
                      </div>
                    </div>
                  )}

                  {step.op === 'deconv' && (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.25rem', width: '100%' }}>
                      <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
                        <label style={{ display: 'flex', alignItems: 'center', gap: '0.2rem' }}>
                          <span>Iter:</span>
                          <input type="number" className="input-number" style={{ width: '35px', padding: '0.25rem' }} value={step.params.iterations} onChange={e => updateParam(step.id, 'iterations', parseInt(e.target.value) || 0)} />
                        </label>
                        <label style={{ display: 'flex', alignItems: 'center', gap: '0.2rem' }}>
                           <span>PSF Size:</span>
                           <select className="input-select" style={{ padding: '0.25rem' }} value={step.params.psfSize} onChange={e => updateParam(step.id, 'psfSize', parseInt(e.target.value))}>
                             <option value="3">3</option>
                             <option value="5">5</option>
                             <option value="7">7</option>
                             <option value="9">9</option>
                           </select>
                        </label>
                        <label style={{ display: 'flex', alignItems: 'center', gap: '0.2rem' }}>
                          <span>PSF σ:</span>
                          <input type="number" step="0.1" className="input-number" style={{ width: '45px', padding: '0.25rem' }} value={step.params.psfSigma} onChange={e => updateParam(step.id, 'psfSigma', parseFloat(e.target.value) || 0)} />
                        </label>
                        <label style={{ display: 'flex', alignItems: 'center', gap: '0.2rem' }}>
                          <span>Dering:</span>
                          <input type="number" step="0.1" className="input-number" style={{ width: '45px', padding: '0.25rem' }} value={step.params.deringing} onChange={e => updateParam(step.id, 'deringing', parseFloat(e.target.value) || 0)} />
                        </label>
                      </div>
                    </div>
                  )}

                  {step.op === 'ht' && (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.25rem', width: '100%' }}>
                      <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
                        <label style={{ display: 'flex', alignItems: 'center', gap: '0.2rem' }}>
                          <span>Shadows:</span>
                          <input type="number" step="0.001" className="input-number" style={{ width: '55px', padding: '0.25rem' }} value={step.params.shadows} onChange={e => updateParam(step.id, 'shadows', parseFloat(e.target.value) || 0)} />
                        </label>
                        <label style={{ display: 'flex', alignItems: 'center', gap: '0.2rem' }}>
                          <span>Highlights:</span>
                          <input type="number" step="0.001" className="input-number" style={{ width: '55px', padding: '0.25rem' }} value={step.params.highlights} onChange={e => updateParam(step.id, 'highlights', parseFloat(e.target.value) || 0)} />
                        </label>
                        <label style={{ display: 'flex', alignItems: 'center', gap: '0.2rem' }}>
                          <span>Midtones:</span>
                          <input type="number" step="0.005" className="input-number" style={{ width: '55px', padding: '0.25rem' }} value={step.params.midtones} onChange={e => updateParam(step.id, 'midtones', parseFloat(e.target.value) || 0.5)} />
                        </label>
                      </div>
                    </div>
                  )}

                  {step.op === 'ghs' && (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.25rem', width: '100%' }}>
                      <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
                        <label style={{ display: 'flex', alignItems: 'center', gap: '0.2rem' }}>
                          <span>SP:</span>
                          <input type="number" step="0.001" className="input-number" style={{ width: '55px', padding: '0.25rem' }} value={step.params.sp} onChange={e => updateParam(step.id, 'sp', parseFloat(e.target.value) || 0)} />
                        </label>
                        <label style={{ display: 'flex', alignItems: 'center', gap: '0.2rem' }}>
                          <span>Strength (D):</span>
                          <input type="number" step="0.5" className="input-number" style={{ width: '50px', padding: '0.25rem' }} value={step.params.d} onChange={e => updateParam(step.id, 'd', parseFloat(e.target.value) || 0)} />
                        </label>
                      </div>
                    </div>
                  )}

                  {step.op === 'maskedstretch' && (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.25rem', width: '100%' }}>
                      <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
                        <label style={{ display: 'flex', alignItems: 'center', gap: '0.2rem' }}>
                          <span>Target:</span>
                          <input type="number" step="0.005" className="input-number" style={{ width: '55px', padding: '0.25rem' }} value={step.params.targetMedian} onChange={e => updateParam(step.id, 'targetMedian', parseFloat(e.target.value) || 0)} />
                        </label>
                        <label style={{ display: 'flex', alignItems: 'center', gap: '0.2rem' }}>
                          <span>Iter:</span>
                          <input type="number" className="input-number" style={{ width: '40px', padding: '0.25rem' }} value={step.params.iterations} onChange={e => updateParam(step.id, 'iterations', parseInt(e.target.value) || 0)} />
                        </label>
                      </div>
                    </div>
                  )}

                  {step.op === 'starnet' && (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.25rem', width: '100%' }}>
                      <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap', alignItems: 'center' }}>
                        <label style={{ display: 'flex', alignItems: 'center', gap: '0.2rem' }}>
                          <span>Threshold:</span>
                          <input type="number" step="0.5" className="input-number" style={{ width: '45px', padding: '0.25rem' }} value={step.params.threshold} onChange={e => updateParam(step.id, 'threshold', parseFloat(e.target.value) || 0)} />
                        </label>
                        <label style={{ display: 'flex', alignItems: 'center', gap: '0.2rem' }}>
                          <span>Expand:</span>
                          <input type="number" className="input-number" style={{ width: '40px', padding: '0.25rem' }} value={step.params.expansion} onChange={e => updateParam(step.id, 'expansion', parseInt(e.target.value) || 0)} />
                        </label>
                        <label style={{ display: 'flex', alignItems: 'center', gap: '0.2rem' }}>
                          <span>Feather:</span>
                          <input type="number" className="input-number" style={{ width: '40px', padding: '0.25rem' }} value={step.params.feather} onChange={e => updateParam(step.id, 'feather', parseInt(e.target.value) || 0)} />
                        </label>
                        <label style={{ display: 'flex', alignItems: 'center', gap: '0.2rem' }}>
                          <span>Iter:</span>
                          <input type="number" className="input-number" style={{ width: '40px', padding: '0.25rem' }} value={step.params.iterations} onChange={e => updateParam(step.id, 'iterations', parseInt(e.target.value) || 0)} />
                        </label>
                        <label style={{ display: 'flex', alignItems: 'center', gap: '0.2rem' }}>
                          <span>Output:</span>
                          <select className="input-select" style={{ padding: '0.25rem' }} value={step.params.outputType} onChange={e => updateParam(step.id, 'outputType', e.target.value)}>
                            <option value="starless">Starless</option>
                            <option value="stars">Stars</option>
                          </select>
                        </label>
                      </div>
                    </div>
                  )}

                  {step.op === 'starreduce' && (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.25rem', width: '100%' }}>
                      <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap', alignItems: 'center' }}>
                        <label style={{ display: 'flex', alignItems: 'center', gap: '0.2rem' }}>
                          <span>Amount:</span>
                          <input type="number" step="0.05" className="input-number" style={{ width: '50px', padding: '0.25rem' }} value={step.params.amount} onChange={e => updateParam(step.id, 'amount', parseFloat(e.target.value) || 0)} />
                        </label>
                        <label style={{ display: 'flex', alignItems: 'center', gap: '0.2rem' }}>
                          <span>Threshold:</span>
                          <input type="number" step="0.5" className="input-number" style={{ width: '45px', padding: '0.25rem' }} value={step.params.threshold} onChange={e => updateParam(step.id, 'threshold', parseFloat(e.target.value) || 0)} />
                        </label>
                        <label style={{ display: 'flex', alignItems: 'center', gap: '0.2rem' }}>
                          <span>Expand:</span>
                          <input type="number" className="input-number" style={{ width: '40px', padding: '0.25rem' }} value={step.params.expansion} onChange={e => updateParam(step.id, 'expansion', parseInt(e.target.value) || 0)} />
                        </label>
                        <label style={{ display: 'flex', alignItems: 'center', gap: '0.2rem' }}>
                          <span>Feather:</span>
                          <input type="number" className="input-number" style={{ width: '40px', padding: '0.25rem' }} value={step.params.feather} onChange={e => updateParam(step.id, 'feather', parseInt(e.target.value) || 0)} />
                        </label>
                        <label style={{ display: 'flex', alignItems: 'center', gap: '0.2rem' }}>
                          <span>Method:</span>
                          <select className="input-select" style={{ padding: '0.25rem' }} value={step.params.method} onChange={e => updateParam(step.id, 'method', e.target.value)}>
                            <option value="scaling">Scaling</option>
                            <option value="morphological">Morphological</option>
                          </select>
                        </label>
                      </div>
                    </div>
                  )}

                  {step.op === 'clahe' && (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.25rem', width: '100%' }}>
                      <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap', alignItems: 'center' }}>
                        <label style={{ display: 'flex', alignItems: 'center', gap: '0.2rem' }}>
                          <span>Clip Limit:</span>
                          <input type="number" step="0.2" className="input-number" style={{ width: '45px', padding: '0.25rem' }} value={step.params.clipLimit} onChange={e => updateParam(step.id, 'clipLimit', parseFloat(e.target.value) || 0)} />
                        </label>
                        <label style={{ display: 'flex', alignItems: 'center', gap: '0.2rem' }}>
                          <span>Grid Tiles:</span>
                          <input type="number" step="2" className="input-number" style={{ width: '45px', padding: '0.25rem' }} value={step.params.gridSize} onChange={e => updateParam(step.id, 'gridSize', parseInt(e.target.value) || 0)} />
                        </label>
                      </div>
                    </div>
                  )}

                  {step.op === 'waveletcontrast' && (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.25rem', width: '100%' }}>
                      <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap', alignItems: 'center' }}>
                        <label style={{ display: 'flex', alignItems: 'center', gap: '0.2rem' }}>
                          <span>Amount:</span>
                          <input type="number" step="0.05" className="input-number" style={{ width: '45px', padding: '0.25rem' }} value={step.params.amount} onChange={e => updateParam(step.id, 'amount', parseFloat(e.target.value) || 0)} />
                        </label>
                        <label style={{ display: 'flex', alignItems: 'center', gap: '0.2rem' }}>
                          <span>Threshold:</span>
                          <input type="number" step="0.5" className="input-number" style={{ width: '45px', padding: '0.25rem' }} value={step.params.noiseThreshold} onChange={e => updateParam(step.id, 'noiseThreshold', parseFloat(e.target.value) || 0)} />
                        </label>
                        <label style={{ display: 'flex', alignItems: 'center', gap: '0.2rem' }}>
                          <span>Kernel:</span>
                          <select className="input-select" style={{ padding: '0.25rem' }} value={step.params.type !== undefined ? step.params.type : 2} onChange={e => updateParam(step.id, 'type', parseInt(e.target.value))}>
                            <option value="1">Linear</option>
                            <option value="2">B3-Spline</option>
                            <option value="3">Gaussian (5x5)</option>
                            <option value="4">Box/Haar (3x3)</option>
                            <option value="5">Cubic Spline (7x7)</option>
                          </select>
                        </label>
                      </div>
                      <div style={{ display: 'flex', gap: '0.35rem', flexWrap: 'wrap', fontSize: '0.65rem', color: 'var(--text-muted)', marginTop: '0.2rem' }}>
                        <span>Biases:</span>
                        {step.params.biases && step.params.biases.map((b: number, idx: number) => (
                          <label key={idx} style={{ display: 'flex', alignItems: 'center', gap: '0.1rem' }}>
                            <span>S{idx+1}:</span>
                            <input type="number" step="0.05" className="input-number" style={{ width: '45px', padding: '0.05rem', fontSize: '0.65rem' }} value={b} onChange={e => {
                              const newVal = parseFloat(e.target.value) || 1.0;
                              const updatedBiases = [...step.params.biases];
                              updatedBiases[idx] = newVal;
                              updateParam(step.id, 'biases', updatedBiases);
                            }} />
                          </label>
                        ))}
                      </div>
                    </div>
                  )}

                  {step.op === 'starcorrect' && (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.25rem', width: '100%' }}>
                      <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap', alignItems: 'center' }}>
                        <label style={{ display: 'flex', alignItems: 'center', gap: '0.2rem' }}>
                          <span>Threshold:</span>
                          <input type="number" step="0.5" className="input-number" style={{ width: '45px', padding: '0.25rem' }} value={step.params.threshold} onChange={e => updateParam(step.id, 'threshold', parseFloat(e.target.value) || 0)} />
                        </label>
                        <label style={{ display: 'flex', alignItems: 'center', gap: '0.2rem' }}>
                          <span>Expand:</span>
                          <input type="number" className="input-number" style={{ width: '40px', padding: '0.25rem' }} value={step.params.expansion} onChange={e => updateParam(step.id, 'expansion', parseInt(e.target.value) || 0)} />
                        </label>
                        <label style={{ display: 'flex', alignItems: 'center', gap: '0.2rem' }}>
                          <span>Feather:</span>
                          <input type="number" className="input-number" style={{ width: '40px', padding: '0.25rem' }} value={step.params.feather} onChange={e => updateParam(step.id, 'feather', parseInt(e.target.value) || 0)} />
                        </label>
                        <label className="input-checkbox-container">
                          <input type="checkbox" checked={step.params.restoreColor} onChange={e => updateParam(step.id, 'restoreColor', e.target.checked)} />
                          <span>Recover Color</span>
                        </label>
                        <label className="input-checkbox-container">
                          <input type="checkbox" checked={step.params.repairRinging} onChange={e => updateParam(step.id, 'repairRinging', e.target.checked)} />
                          <span>Repair Ringing</span>
                        </label>
                      </div>
                    </div>
                  )}

                  {step.op === 'script' && (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.4rem', width: '100%' }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                        <span style={{ fontWeight: 600, fontSize: '0.75rem' }}>Custom JS Script Code:</span>
                        <span style={{ fontSize: '0.65rem', color: 'var(--text-muted)' }}>Must return a Float32Array</span>
                      </div>
                      <textarea
                        value={step.params.code || ''}
                        onChange={e => updateParam(step.id, 'code', e.target.value)}
                        className="input-textarea"
                        style={{
                          width: '100%',
                          height: '120px',
                          color: 'var(--success)',
                          fontSize: '0.75rem'
                        }}
                        placeholder={`// Write your custom script here\nfor (let i = 0; i < floatData.length; i++) {\n  floatData[i] = Math.min(1.0, floatData[i] * 1.0);\n}\nreturn floatData;`}
                      />
                    </div>
                  )}


                </div>
              </div>
            );
          })}
          
          {sequence.length === 0 && (
            <div style={{ padding: '2rem 1rem', textAlign: 'center', border: '1.5px dashed var(--border)', borderRadius: '8px', color: 'var(--text-muted)', fontSize: '0.8rem' }}>
              Your pipeline is empty. Select a step from the dropdown to start.
            </div>
          )}
        </div>
      </div>

      {/* Bottom Run Logs console */}
      <div style={{ borderTop: '1px solid var(--border)', paddingTop: '0.75rem', display: 'flex', flexDirection: 'column', gap: '0.4rem', flexShrink: 0 }}>
        <div style={{ fontSize: '0.75rem', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <span>Run Logs</span>
          {isRunning && <span style={{ color: 'var(--accent-blue)', animation: 'pulse 1s infinite', fontSize: '0.65rem' }}>RUNNING</span>}
        </div>
        <div style={{ height: '95px', backgroundColor: '#07090e', border: '1px solid var(--border)', borderRadius: '4px', padding: '0.5rem', fontFamily: 'var(--font-mono)', fontSize: '0.7rem', color: 'var(--success)', overflowY: 'auto', textAlign: 'left' }}>
          <pre style={{ margin: 0, whiteSpace: 'pre-wrap', fontFamily: 'inherit' }}>{terminalLog}</pre>
        </div>
      </div>

    </div>
  );
};

export default WorkflowBuilder;
