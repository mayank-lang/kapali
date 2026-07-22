import React, { useState } from 'react';
import { Terminal, Play, RotateCcw, HelpCircle } from 'lucide-react';
import '../App.css';
import { type SharedFile } from '../App';
import { 
  executeSCNR, 
  executeAsinhTransform, 
  executeBandingReduction, 
  executeRotationalGradient, 
  executeWaveletTransform, 
  executeColorSaturation, 
  executeCosmeticCorrection,
  executeWaveletNoiseReduction,
  executeRichardsonLucyDeconvolution,
  executeHistogramTransformation,
  executeGeneralizedHyperbolicStretch,
  executeMaskedStretch,
  executeStarSeparation,
  executeStarReduction,
  executeCLAHE,
  executeMultiscaleWaveletContrast,
  executeFinalStarCorrection
} from '../utils/filters';
import { 
  executeDynamicBackgroundExtraction, 
  executeLinearMatch,
  executeColorCalibration
} from '../utils/background';
import { calculateStats } from '../utils/stretch';

interface ScriptConsoleProps {
  activeFile: SharedFile | null;
  sharedFiles: SharedFile[];
  onUpdateFits: (id: string, updatedFits: any) => void;
  addLog: (type: 'info' | 'success' | 'warning' | 'error', msg: string) => void;
}

const PRESETS = [
  {
    name: 'Brightness Booster (Pixel Loop)',
    code: `// Loop through every pixel and multiply brightness by 1.5
for (let i = 0; i < floatData.length; i++) {
  floatData[i] = Math.min(1.0, floatData[i] * 1.5);
}
return floatData;`
  },
  {
    name: 'Logarithmic Stretch (Manual)',
    code: `// Custom logarithmic stretch: log1p(x * 100) / log1p(100)
for (let i = 0; i < floatData.length; i++) {
  floatData[i] = Math.log1p(floatData[i] * 100) / Math.log1p(100);
}
return floatData;`
  },
  {
    name: 'SCNR Green Removal + Asinh Stretch',
    code: `// 1. Remove green chrominance noise (SCNR average)
const scnr = helpers.scnr(width, height, floatData, 0, 1.0, true);

// 2. Apply Hyperbolic Sine (Asinh) stretch with beta = 15
const stretch = helpers.asinh(width, height, scnr.newData, 15.0, 0.0, true);

return stretch.newData;`
  },
  {
    name: 'Advanced Nebula Enhancer (CLAHE + Contrast + Star Reduction)',
    code: `// 1. Enhance local contrast with CLAHE
const clahe = helpers.clahe(width, height, floatData, 3.0, 8);

// 2. Amplify wavelet detail scale contrast (B3-Spline)
const biases = [1.25, 1.15, 1.0, 1.0, 1.0];
const contrast = helpers.multiscaleWaveletContrast(width, height, clahe.newData, 2, 0.8, 1.0, biases);

// 3. Shrink star profiles slightly for nebular focus
const reduced = helpers.starReduction(width, height, contrast.newData, 0.4, 3.0, 2, 2, 'scaling');

return reduced.newData;`
  },
  {
    name: 'Wavelet Sharpening (High Frequencies)',
    code: `// Apply 5-layer B-spline wavelet, boosting layer 1 and 2 details
// Coefficients array corresponds to layers 1 to 5.
const coefs = [2.5, 1.8, 1.0, 1.0, 1.0];
const wavelet = helpers.wavelet(width, height, floatData, 5, 2, coefs);

return wavelet.newData;`
  },
  {
    name: 'Invert Color Channels',
    code: `// Invert every pixel channel (1.0 - value)
const inverted = new Float32Array(floatData.length);
for (let i = 0; i < floatData.length; i++) {
  inverted[i] = 1.0 - floatData[i];
}
return inverted;`
  }
];

const ScriptConsole: React.FC<ScriptConsoleProps> = ({
  activeFile,
  sharedFiles,
  onUpdateFits,
  addLog
}) => {
  const [scriptCode, setScriptCode] = useState(PRESETS[0].code);
  const [selectedPresetIndex, setSelectedPresetIndex] = useState(0);
  const [showHelp, setShowHelp] = useState(true);

  const handleSelectPreset = (index: number) => {
    setSelectedPresetIndex(index);
    setScriptCode(PRESETS[index].code);
  };

  const handleRunScript = () => {
    if (!activeFile) {
      addLog('warning', 'Please load or select a file to execute script on.');
      return;
    }

    if (!activeFile.parsedFits) {
      addLog('warning', 'Active file must be a FITS or parsed image structure.');
      return;
    }

    addLog('info', `Executing custom script on ${activeFile.name}...`);
    
    try {
      const floatDataCopy = new Float32Array(activeFile.parsedFits.floatData);
      const { width, height } = activeFile.parsedFits;
      const channels = floatDataCopy.length / (width * height);

      // Sandbox function execution
      const sandboxFunc = new Function(
        'floatData',
        'width',
        'height',
        'channels',
        'helpers',
        'sharedFiles',
        scriptCode
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
        if (result.length !== floatDataCopy.length) {
          throw new Error(`Returned Float32Array size mismatch. Expected ${floatDataCopy.length} elements, got ${result.length}.`);
        }
        onUpdateFits(activeFile.id, result);
        addLog('success', 'Custom script completed and output array updated.');
      } else {
        throw new Error('Script must return a modified Float32Array (e.g., return floatData;).');
      }
    } catch (err: any) {
      addLog('error', `Script Execution Failed: ${err.message}`);
      console.error(err);
    }
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem', height: '100%', overflow: 'hidden' }}>
      
      {/* Module Header */}
      <div className="sidebar-module-header">
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <h2 className="sidebar-module-title">
            <Terminal size={16} color="var(--accent-purple)" />
            Custom Scripting
          </h2>
          <button 
            onClick={() => setShowHelp(!showHelp)}
            className="btn-secondary"
            style={{ padding: '0.35rem 0.65rem' }}
          >
            <HelpCircle size={12} /> {showHelp ? 'Hide API' : 'Show API'}
          </button>
        </div>
        <p className="sidebar-module-desc">Write and execute custom Javascript equations and mathematical processing loops on the pixel matrix.</p>
      </div>

      {showHelp && (
        <div style={{ backgroundColor: 'var(--bg-panel-light)', border: '1px solid var(--border)', borderRadius: '6px', padding: '0.6rem', fontSize: '0.72rem', lineHeight: '1.4', overflowY: 'auto', maxHeight: '180px', flexShrink: 0 }}>
          <div style={{ fontWeight: 700, color: 'var(--accent-blue)', marginBottom: '0.2rem' }}>Exposed API Variables:</div>
          <ul style={{ paddingLeft: '1.1rem', marginBottom: '0.4rem', display: 'flex', flexDirection: 'column', gap: '2px', color: 'var(--text-muted)' }}>
            <li><code>floatData</code>: Float32Array containing pixel data (read/write).</li>
            <li><code>width</code> / <code>height</code>: Dimensions of active frame.</li>
            <li><code>channels</code>: 1 for grayscale, 3 for RGB planar.</li>
            <li><code>helpers</code>: Object exposing the Siril algorithms.</li>
            <li><code>sharedFiles</code>: Workspace files array.</li>
          </ul>
          <div style={{ fontWeight: 700, color: 'var(--success)', marginBottom: '0.2rem' }}>Helper Functions Available:</div>
          <div style={{ fontFamily: 'var(--font-mono)', fontSize: '0.65rem', maxHeight: '100px', overflowY: 'auto', padding: '0.25rem', backgroundColor: '#07090e', borderRadius: '4px', border: '1px solid var(--border)' }}>
            <div>helpers.scnr(w, h, data, type[0-3], amt, preserveLuminance)</div>
            <div>helpers.asinh(w, h, data, beta, offset, rgbSpace)</div>
            <div>helpers.banding(w, h, data, sigma, amt, protect, vertical)</div>
            <div>helpers.rotationalGradient(w, h, data, xc, yc, dR, da)</div>
            <div>helpers.wavelet(w, h, data, layers, transformType[1-5], coefficients[])</div>
            <div>helpers.colorSaturation(w, h, data, amt, hueType[0-6], bgFactor)</div>
            <div>helpers.cosmeticCorrection(w, h, data, sigHot, sigCold, cfa)</div>
            <div>helpers.dbe(w, h, data, tolerance, gridSize)</div>
            <div>helpers.linearMatch(w, h, targetData, refData, lowLimit, highLimit)</div>
            <div>helpers.colorCalibration(w, h, data, autoBg, bgR, bgG, bgB, autoWhite, whiteR, whiteG, whiteB)</div>
            <div>helpers.waveletNoiseReduction(w, h, data, layers, transformType[1-5], thresholds[], amt)</div>
            <div>helpers.richardsonLucyDeconvolution(w, h, data, iterations, psfSize, psfSigma, deringingAmt, deringingThreshold)</div>
            <div>helpers.histogramTransformation(w, h, data, shadows, highlights, midtones)</div>
            <div>helpers.generalizedHyperbolicStretch(w, h, data, symmetryPoint, stretchFactor)</div>
            <div>helpers.maskedStretch(w, h, data, targetMedian, iterations)</div>
            <div>helpers.starSeparation(w, h, data, threshold, expansion, feather, iterations, outputType["starless"|"stars"])</div>
            <div>helpers.starReduction(w, h, data, amt, threshold, expansion, feather, method["scaling"|"morphological"])</div>
            <div>helpers.clahe(w, h, data, clipLimit, gridSize)</div>
            <div>helpers.multiscaleWaveletContrast(w, h, data, transformType[1-5], amt, threshold, biases[])</div>
            <div>helpers.finalStarCorrection(w, h, data, threshold, expansion, feather, restoreColors, repairRinging)</div>
            <div>helpers.calculateStats(data)</div>
          </div>
        </div>
      )}

      <div className="control-card" style={{ flexShrink: 0 }}>
        <label className="form-label">
          <span>Load Preset Script Template:</span>
          <select 
            value={selectedPresetIndex}
            onChange={(e) => handleSelectPreset(parseInt(e.target.value))}
            className="input-select"
          >
            {PRESETS.map((p, i) => (
              <option key={i} value={i}>{p.name}</option>
            ))}
          </select>
        </label>
      </div>

      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: '0.35rem', minHeight: '180px' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <span style={{ fontSize: '0.7rem', color: 'var(--text-muted)', textTransform: 'uppercase', fontWeight: 700 }}>Write Script (sandbox.js)</span>
        </div>
        <textarea
          value={scriptCode}
          onChange={(e) => setScriptCode(e.target.value)}
          className="input-textarea"
          style={{
            flex: 1,
            color: '#A7F3D0',
            resize: 'none',
            fontSize: '0.75rem'
          }}
        />
      </div>

      <div style={{ display: 'flex', gap: '0.5rem', flexShrink: 0 }}>
        <button 
          onClick={handleRunScript}
          disabled={!activeFile}
          className="btn-primary"
          style={{ flex: 1, padding: '0.55rem' }}
        >
          <Play size={14} /> Execute Custom Script
        </button>
        <button 
          onClick={() => setScriptCode(PRESETS[selectedPresetIndex].code)}
          className="btn-secondary"
          style={{ padding: '0.55rem 0.8rem' }}
          title="Reset code to preset template"
        >
          <RotateCcw size={14} />
        </button>
      </div>
    </div>
  );
};

export default ScriptConsole;
