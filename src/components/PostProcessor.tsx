import React, { useState, useEffect, useCallback, useRef } from 'react';
import { Layers, Wand2, Sparkles, Droplets, RotateCcw, CircleDashed, Ratio, Compass, Eye, Palette } from 'lucide-react';
import { type SharedFile } from '../App';
import { executeDynamicBackgroundExtraction, executeLinearMatch, executeColorCalibration } from '../utils/background';
import { executeSCNR, executeAsinhTransform, executeBandingReduction, executeRotationalGradient, executeWaveletTransform, executeColorSaturation, executeCosmeticCorrection, executeWaveletNoiseReduction, executeRichardsonLucyDeconvolution, executeHistogramTransformation, executeGeneralizedHyperbolicStretch, executeMaskedStretch, executeStarSeparation, executeStarReduction, executeCLAHE, executeMultiscaleWaveletContrast, executeFinalStarCorrection, combineFitsChannels } from '../utils/filters';

// Operations fast enough for live preview (<100ms on typical images)
const LIVE_PREVIEW_OPS = new Set(['HT', 'GHS', 'Asinh', 'MaskedStretch', 'SCNR', 'Saturation']);

interface PostProcessorProps {
  activeFile: SharedFile | null;
  sharedFiles: SharedFile[];
  onUpdateFits: (id: string, newData: Float32Array) => void;
  onLivePreview?: (fileId: string, data: Float32Array | null) => void;
  onAddFiles?: (files: File[]) => void;
  addLog: (type: 'info' | 'success' | 'warning' | 'error', msg: string) => void;
}

interface ProcessHistory {
  id: string;
  name: string;
  params: string;
  icon: React.ReactNode;
}

const PostProcessor: React.FC<PostProcessorProps> = ({ activeFile, sharedFiles, onUpdateFits: onUpdateFitsProp, onLivePreview, onAddFiles, addLog }) => {
  type ActiveTool = 'DBE' | 'LMATCH' | 'SCNR' | 'Asinh' | 'Banding' | 'RGradient' | 'Wavelets' | 'StarNet' | 'StarReduce' | 'Noise' | 'Saturation' | 'Cosmetic' | 'ColorCalib' | 'Deconv' | 'HT' | 'GHS' | 'MaskedStretch' | 'CLAHE' | 'WaveletContrast' | 'StarCorrect' | 'CombineRGB' | 'CombineHOO' | 'CombineSHO' | 'CombineLRGB';
  const [activeTool, setActiveTool] = useState<ActiveTool | null>(null);
  const [history, setHistory] = useState<ProcessHistory[]>([
    { id: 'init', name: 'Initial Integration Load', params: 'Linear 32-bit Float', icon: <Layers size={14} /> }
  ]);
  const [pixelHistory, setPixelHistory] = useState<Float32Array[]>([]);
  const [isProcessing, setIsProcessing] = useState(false);

  const [expandedCategories, setExpandedCategories] = useState<Record<string, boolean>>({
    'Background & Calibration': true,
    'Color & Noise': false,
    'Non-Linear Stretching': false,
    'Contrast & Details': false,
    'Stellar Management': false
  });

  const toggleCategory = (catName: string) => {
    setExpandedCategories(prev => ({
      ...prev,
      [catName]: !prev[catName]
    }));
  };

  useEffect(() => {
    if (activeFile && activeFile.parsedFits) {
      setPixelHistory([new Float32Array(activeFile.parsedFits.floatData)]);
      setHistory([
        { id: 'init', name: 'Initial Integration Load', params: 'Linear 32-bit Float', icon: <Layers size={14} /> }
      ]);
    } else {
      setPixelHistory([]);
    }
  }, [activeFile?.id, activeFile?.parsedFits?.floatData]);


  // DBE Params
  const [dbeTolerance, setDbeTolerance] = useState(1.5);
  const [dbeSmoothing, setDbeSmoothing] = useState(0.5);

  // LMATCH Params
  const [refFileId, setRefFileId] = useState<string>('');

  // SCNR Params
  const [scnrType, setScnrType] = useState<number>(0); // 0: Avg, 1: Max, 2: Max w/ amount, 3: Sum
  const [scnrAmount, setScnrAmount] = useState<number>(1.0);
  const [scnrPreserveLuminance, setScnrPreserveLuminance] = useState<boolean>(true);

  // Asinh Params
  const [asinhStretch, setAsinhStretch] = useState<number>(10.0);
  const [asinhOffset, setAsinhOffset] = useState<number>(0.0);
  const [asinhRgb, setAsinhRgb] = useState<boolean>(true);

  // Banding Params
  const [bandingSigma, setBandingSigma] = useState<number>(3.0);
  const [bandingAmount, setBandingAmount] = useState<number>(0.9);
  const [bandingProtect, setBandingProtect] = useState<boolean>(true);
  const [bandingVertical, setBandingVertical] = useState<boolean>(false);

  // RGradient Params
  const [rgXc, setRgXc] = useState<number>(0);
  const [rgYc, setRgYc] = useState<number>(0);
  const [rgDr, setRgDr] = useState<number>(2);
  const [rgDa, setRgDa] = useState<number>(1.0);

  // Wavelets Params
  const [waveletPlans, setWaveletPlans] = useState<number>(5);
  const [waveletType, setWaveletType] = useState<number>(2); // 1: Linear, 2: Bspline
  const [waveletCoeffs, setWaveletCoeffs] = useState<number[]>([1.0, 1.0, 1.0, 1.0, 1.0]);

  useEffect(() => {
    setWaveletCoeffs(prev => {
      if (prev.length === waveletPlans) return prev;
      const next = new Array(waveletPlans).fill(1.0);
      for (let i = 0; i < Math.min(prev.length, waveletPlans); i++) {
        next[i] = prev[i];
      }
      return next;
    });
  }, [waveletPlans]);

  // Saturation Params
  const [satuAmount, setSatuAmount] = useState<number>(0.5);
  const [satuHueType, setSatuHueType] = useState<number>(6); // 6: Global
  const [satuBgFactor, setSatuBgFactor] = useState<number>(0.0);

  // Cosmetic Params
  const [cosmeSigmaHot, setCosmeSigmaHot] = useState<number>(3.0);
  const [cosmeSigmaCold, setCosmeSigmaCold] = useState<number>(3.0);
  const [cosmeEnableHot, setCosmeEnableHot] = useState<boolean>(true);
  const [cosmeEnableCold, setCosmeEnableCold] = useState<boolean>(true);
  const [cosmeIsCfa, setCosmeIsCfa] = useState<boolean>(false);

  // Color Calibration Params
  const [ccAutoBg, setCcAutoBg] = useState<boolean>(true);
  const [ccBgRed, setCcBgRed] = useState<number>(0.0);
  const [ccBgGreen, setCcBgGreen] = useState<number>(0.0);
  const [ccBgBlue, setCcBgBlue] = useState<number>(0.0);
  const [ccAutoWhite, setCcAutoWhite] = useState<boolean>(true);
  const [ccWhiteRed, setCcWhiteRed] = useState<number>(1.0);
  const [ccWhiteGreen, setCcWhiteGreen] = useState<number>(1.0);
  const [ccWhiteBlue, setCcWhiteBlue] = useState<number>(1.0);

  // Wavelet Noise Params
  const [noisePlans, setNoisePlans] = useState<number>(4);
  const [noiseAmount, setNoiseAmount] = useState<number>(0.5);
  const [noiseType, setNoiseType] = useState<number>(2); // 2: Bspline
  const [noiseThresholds, setNoiseThresholds] = useState<number[]>([3.0, 2.0, 1.0, 0.5]);

  // Deconv Params
  const [deconvIter, setDeconvIter] = useState<number>(10);
  const [deconvPsfSize, setDeconvPsfSize] = useState<number>(5);
  const [deconvPsfSigma, setDeconvPsfSigma] = useState<number>(1.5);
  const [deconvDeringing, setDeconvDeringing] = useState<number>(0.5);
  const [deconvDeringingThreshold, setDeconvDeringingThreshold] = useState<number>(0.02);

  const handleNoiseThresholdChange = (index: number, val: number) => {
    setNoiseThresholds(prev => {
      const copy = [...prev];
      copy[index] = val;
      return copy;
    });
  };

  // HT Params
  const [htShadows, setHtShadows] = useState<number>(0.0);
  const [htHighlights, setHtHighlights] = useState<number>(1.0);
  const [htMidtones, setHtMidtones] = useState<number>(0.5);

  // GHS Params
  const [ghsSP, setGhsSP] = useState<number>(0.01);
  const [ghsD, setGhsD] = useState<number>(10.0);

  // MaskedStretch Params
  const [msTargetMedian, setMsTargetMedian] = useState<number>(0.125);
  const [msIter, setMsIter] = useState<number>(6);

  // Star Separation (StarNet) Params
  const [starnetThreshold, setStarnetThreshold] = useState<number>(3.0);
  const [starnetExpansion, setStarnetExpansion] = useState<number>(3);
  const [starnetFeather, setStarnetFeather] = useState<number>(2);
  const [starnetIterations, setStarnetIterations] = useState<number>(30);
  const [starnetOutput, setStarnetOutput] = useState<string>('starless');

  // Star Reduction Params
  const [reduceThreshold, setReduceThreshold] = useState<number>(3.0);
  const [reduceExpansion, setReduceExpansion] = useState<number>(3);
  const [reduceFeather, setReduceFeather] = useState<number>(2);
  const [reduceAmount, setReduceAmount] = useState<number>(0.5);
  const [reduceMethod, setReduceMethod] = useState<string>('scaling');

  // CLAHE Params
  const [claheClipLimit, setClaheClipLimit] = useState<number>(2.5);
  const [claheGridSize, setClaheGridSize] = useState<number>(8);

  // Wavelet Contrast Params
  const [wcBiases, setWcBiases] = useState<number[]>([1.2, 1.15, 1.1, 1.05, 1.0]);
  const [wcNoiseThreshold, setWcNoiseThreshold] = useState<number>(2.0);
  const [wcAmount, setWcAmount] = useState<number>(1.0);
  const [wcType, setWcType] = useState<number>(2); // 2: Bspline

  const handleWcBiasChange = (idx: number, val: number) => {
    setWcBiases(prev => {
      const copy = [...prev];
      copy[idx] = val;
      return copy;
    });
  };

  // Star Correction Params
  const [scThreshold, setScThreshold] = useState<number>(3.0);
  const [scExpansion, setScExpansion] = useState<number>(3);
  const [scFeather, setScFeather] = useState<number>(2);
  const [scRestoreColor, setScRestoreColor] = useState<boolean>(true);
  const [scRepairRinging, setScRepairRinging] = useState<boolean>(true);

  // Channel Combine Params
  const [combineRFile, setCombineRFile] = useState('');
  const [combineGFile, setCombineGFile] = useState('');
  const [combineBFile, setCombineBFile] = useState('');
  const [combineLFile, setCombineLFile] = useState('');
  const [combineLumWeight, setCombineLumWeight] = useState(0.5);
  const [combineHaFile, setCombineHaFile] = useState('');
  const [combineOiiiFile, setCombineOiiiFile] = useState('');
  const [combineSiiFile, setCombineSiiFile] = useState('');

  // Reset center coords when activeFile changes
  useEffect(() => {
    if (activeFile && activeFile.parsedFits) {
      setRgXc(Math.floor(activeFile.parsedFits.width / 2));
      setRgYc(Math.floor(activeFile.parsedFits.height / 2));
    }
  }, [activeFile?.id]);

  // Clear live preview when active file or tool changes
  useEffect(() => {
    onLivePreview?.(activeFile?.id ?? '', null);
  }, [activeFile?.id, activeTool]); // eslint-disable-line react-hooks/exhaustive-deps

  // Debounced live preview for fast operations
  const previewTimerRef = useRef<number | null>(null);

  const scheduleLivePreview = useCallback(() => {
    if (!activeTool || !activeFile?.parsedFits || !onLivePreview) return;
    if (!LIVE_PREVIEW_OPS.has(activeTool)) return;

    if (previewTimerRef.current !== null) clearTimeout(previewTimerRef.current);

    previewTimerRef.current = window.setTimeout(() => {
      if (!activeFile?.parsedFits) return;
      const { floatData, width, height } = activeFile.parsedFits;
      try {
        let result: { newData: Float32Array } | null = null;
        if (activeTool === 'HT') {
          result = executeHistogramTransformation(width, height, floatData, htShadows, htHighlights, htMidtones);
        } else if (activeTool === 'GHS') {
          result = executeGeneralizedHyperbolicStretch(width, height, floatData, ghsSP, ghsD);
        } else if (activeTool === 'Asinh') {
          result = executeAsinhTransform(width, height, floatData, asinhStretch, asinhOffset, asinhRgb);
        } else if (activeTool === 'MaskedStretch') {
          result = executeMaskedStretch(width, height, floatData, msTargetMedian, msIter);
        } else if (activeTool === 'SCNR') {
          result = executeSCNR(width, height, floatData, scnrType, scnrAmount, scnrPreserveLuminance);
        } else if (activeTool === 'Saturation') {
          result = executeColorSaturation(width, height, floatData, satuAmount, satuHueType, satuBgFactor);
        }
        if (result) onLivePreview(activeFile.id, result.newData);
      } catch (_) { /* silent */ }
    }, 160);
  }, [
    activeTool, activeFile,
    htShadows, htHighlights, htMidtones,
    ghsSP, ghsD,
    asinhStretch, asinhOffset, asinhRgb,
    msTargetMedian, msIter,
    scnrType, scnrAmount, scnrPreserveLuminance,
    satuAmount, satuHueType, satuBgFactor,
    onLivePreview,
  ]);

  useEffect(() => {
    scheduleLivePreview();
    return () => { if (previewTimerRef.current !== null) clearTimeout(previewTimerRef.current); };
  }, [scheduleLivePreview]);

  // Set default reference file if empty
  useEffect(() => {
    if (activeFile && sharedFiles.length > 1) {
      const other = sharedFiles.find(f => f.id !== activeFile.id);
      if (other && !refFileId) {
        setRefFileId(other.id);
      }
    }
  }, [activeFile, sharedFiles, refFileId]);

  const handleWaveletCoeffChange = (index: number, val: number) => {
    setWaveletCoeffs(prev => {
      const copy = [...prev];
      copy[index] = val;
      return copy;
    });
  };

  const executeProcess = async () => {
    if (!activeTool || !activeFile) {
      addLog('error', 'Please select a file and a tool to execute.');
      return;
    }

    if (!activeFile.parsedFits && activeFile.type !== 'image') {
      addLog('error', 'Selected file does not contain valid pixel buffers.');
      return;
    }

    // Clear live preview before committing the real result
    onLivePreview?.(activeFile.id, null);
    setIsProcessing(true);
    try {
      const getKernelName = (type: number): string => {
        switch (type) {
          case 1: return 'Linear';
          case 2: return 'B3-Spline';
          case 3: return 'Gaussian';
          case 4: return 'Box/Haar';
          case 5: return 'Cubic Spline';
          default: return 'B3-Spline';
        }
      };
      let logMsg = '';
      let stepName = '';
      let stepParams = '';
      let icon = <Wand2 size={14} />;
      
      // Extract pixel buffer
      const floatData = activeFile.parsedFits?.floatData;
      const width = activeFile.parsedFits?.width || 0;
      const height = activeFile.parsedFits?.height || 0;

      if (!floatData || width === 0 || height === 0) {
        addLog('error', 'Selected file does not contain valid pixel data for processing.');
        return;
      }

    if (activeTool === 'DBE' && floatData) {
      stepName = 'Dynamic Background Extraction';
      stepParams = `Tol: ${dbeTolerance}, Grid: ${Math.floor(dbeSmoothing * 20)}`;
      addLog('info', 'Executing DBE Planar Fit...');
      
      const result = executeDynamicBackgroundExtraction(
        width, height, floatData, dbeTolerance, Math.floor(dbeSmoothing * 20) || 10
      );
      
      logMsg = result.logs.join('\n');
      onUpdateFits(activeFile.id, result.newData);
      icon = <CircleDashed size={14} />;
    } 
    else if (activeTool === 'LMATCH' && floatData) {
      stepName = 'Linear Match (LMATCH)';
      stepParams = `Ref: ${sharedFiles.find(f => f.id === refFileId)?.name || 'Unknown'}`;
      addLog('info', 'Executing Linear Regression Match...');
      
      const refFile = sharedFiles.find(f => f.id === refFileId);
      const refData = refFile?.parsedFits?.floatData;

      if (!refData) {
        logMsg = 'Error: Selected reference file does not contain float pixel data.';
      } else {
        const result = executeLinearMatch(width, height, floatData, refData);
        logMsg = result.logs.join('\n');
        onUpdateFits(activeFile.id, result.newData);
      }
      icon = <Ratio size={14} />;
    }
    else if (activeTool === 'SCNR' && floatData) {
      stepName = 'Subtractive Chrominance Noise Reduction';
      stepParams = `Type: ${scnrType}, Amt: ${scnrAmount}`;
      addLog('info', 'Executing SCNR Chrominance filter...');
      
      const result = executeSCNR(width, height, floatData, scnrType, scnrAmount, scnrPreserveLuminance);
      logMsg = result.logs.join('\n');
      onUpdateFits(activeFile.id, result.newData);
      icon = <Droplets size={14} />;
    }
    else if (activeTool === 'Asinh' && floatData) {
      stepName = 'Asinh Transformation';
      stepParams = `β: ${asinhStretch}, Offset: ${asinhOffset}`;
      addLog('info', 'Executing Hyperbolic Sine Stretch...');
      
      const result = executeAsinhTransform(width, height, floatData, asinhStretch, asinhOffset, asinhRgb);
      logMsg = result.logs.join('\n');
      onUpdateFits(activeFile.id, result.newData);
      icon = <Compass size={14} />;
    }
    else if (activeTool === 'Banding' && floatData) {
      stepName = 'Banding Noise Reduction';
      stepParams = `Amt: ${bandingAmount}, InvSigma: ${bandingSigma}, Vert: ${bandingVertical}`;
      addLog('info', 'Executing Banding Reduction...');
      
      const result = executeBandingReduction(width, height, floatData, bandingSigma, bandingAmount, bandingProtect, bandingVertical);
      logMsg = result.logs.join('\n');
      onUpdateFits(activeFile.id, result.newData);
      icon = <Layers size={14} />;
    }
    else if (activeTool === 'RGradient' && floatData) {
      stepName = 'Rotational Gradient Filter';
      stepParams = `Center: [${rgXc}, ${rgYc}], dR: ${rgDr}, dA: ${rgDa}`;
      addLog('info', 'Executing Radial Differential Gradient...');
      
      const result = executeRotationalGradient(width, height, floatData, rgXc, rgYc, rgDr, rgDa);
      logMsg = result.logs.join('\n');
      onUpdateFits(activeFile.id, result.newData);
      icon = <Compass size={14} />;
    }
    else if (activeTool === 'Wavelets' && floatData) {
      stepName = 'à trous Wavelet Processing';
      stepParams = `Plans: ${waveletPlans}, Kernel: ${getKernelName(waveletType)}`;
      addLog('info', 'Executing Multi-Scale Wavelet decomposition/reconstruction...');

      const result = executeWaveletTransform(width, height, floatData, waveletPlans, waveletType, waveletCoeffs);
      logMsg = result.logs.join('\n');
      onUpdateFits(activeFile.id, result.newData);
      icon = <Layers size={14} />;
    }
    else if (activeTool === 'Saturation' && floatData) {
      stepName = 'Color Saturation';
      stepParams = `Amt: ${satuAmount}, Band: ${satuHueType}, BG: ${satuBgFactor}`;
      addLog('info', 'Executing Saturation adjustment...');

      const result = executeColorSaturation(width, height, floatData, satuAmount, satuHueType, satuBgFactor);
      logMsg = result.logs.join('\n');
      onUpdateFits(activeFile.id, result.newData);
      icon = <Sparkles size={14} />;
    }
    else if (activeTool === 'Cosmetic' && floatData) {
      stepName = 'Cosmetic Correction';
      const sh = cosmeEnableHot ? cosmeSigmaHot : -1.0;
      const sc = cosmeEnableCold ? cosmeSigmaCold : -1.0;
      stepParams = `Hot: ${sh >= 0 ? sh : 'Off'}, Cold: ${sc >= 0 ? sc : 'Off'}, CFA: ${cosmeIsCfa}`;
      addLog('info', 'Executing Cosmetic correction...');

      const result = executeCosmeticCorrection(width, height, floatData, sh, sc, cosmeIsCfa);
      logMsg = result.logs.join('\n');
      onUpdateFits(activeFile.id, result.newData);
      icon = <Wand2 size={14} />;
    }
    else if (activeTool === 'ColorCalib' && floatData) {
      stepName = 'Color Calibration';
      stepParams = `AutoBg: ${ccAutoBg}, AutoWhite: ${ccAutoWhite}`;
      addLog('info', 'Executing Color Calibration (Background & White Balance)...');

      const result = executeColorCalibration(
        width, height, floatData,
        ccAutoBg, ccBgRed, ccBgGreen, ccBgBlue,
        ccAutoWhite, ccWhiteRed, ccWhiteGreen, ccWhiteBlue
      );
      logMsg = result.logs.join('\n');
      onUpdateFits(activeFile.id, result.newData);
      icon = <Palette size={14} />;
    }
    else if (activeTool === 'StarNet' && floatData) {
      stepName = 'StarNet Star Separation';
      stepParams = `Threshold: ${starnetThreshold}σ, Expansion: ${starnetExpansion}px, Out: ${starnetOutput}`;
      addLog('info', `Executing Star Separation (${starnetOutput})...`);

      const result = executeStarSeparation(
        width, height, floatData,
        starnetThreshold, starnetExpansion, starnetFeather, starnetIterations,
        starnetOutput as 'starless' | 'stars'
      );
      logMsg = result.logs.join('\n');
      onUpdateFits(activeFile.id, result.newData);
      icon = <Sparkles size={14} />;
    }
    else if (activeTool === 'StarReduce' && floatData) {
      stepName = 'Selective Star Reduction';
      stepParams = `Method: ${reduceMethod}, Amt: ${(reduceAmount * 100).toFixed(0)}%`;
      addLog('info', `Executing Selective Star Reduction (Method: ${reduceMethod})...`);

      const result = executeStarReduction(
        width, height, floatData,
        reduceThreshold, reduceExpansion, reduceFeather,
        reduceAmount, reduceMethod as 'scaling' | 'morphological'
      );
      logMsg = result.logs.join('\n');
      onUpdateFits(activeFile.id, result.newData);
      icon = <Sparkles size={14} />;
    } 
    else if (activeTool === 'CLAHE' && floatData) {
      stepName = 'CLAHE Local Contrast';
      stepParams = `Limit: ${claheClipLimit.toFixed(1)}, Grid: ${claheGridSize}x${claheGridSize}`;
      addLog('info', 'Executing CLAHE Local Contrast Enhancement...');

      const result = executeCLAHE(
        width, height, floatData, claheClipLimit, claheGridSize
      );
      logMsg = result.logs.join('\n');
      onUpdateFits(activeFile.id, result.newData);
      icon = <Compass size={14} />;
    }
    else if (activeTool === 'WaveletContrast' && floatData) {
      stepName = 'Wavelet Contrast';
      stepParams = `Biases: [${wcBiases.map(b => b.toFixed(2)).join(', ')}], Threshold: ${wcNoiseThreshold}σ, Kernel: ${getKernelName(wcType)}`;
      addLog('info', 'Executing Multiscale Wavelet Contrast Enhancement...');

      const result = executeMultiscaleWaveletContrast(
        width, height, floatData, wcBiases, wcNoiseThreshold, wcAmount, wcType
      );
      logMsg = result.logs.join('\n');
      onUpdateFits(activeFile.id, result.newData);
      icon = <Compass size={14} />;
    }
    else if (activeTool === 'StarCorrect' && floatData) {
      stepName = 'Final Star Correction';
      stepParams = `Restore: ${scRestoreColor}, Repair: ${scRepairRinging}`;
      addLog('info', 'Executing Final Star Correction...');

      const result = executeFinalStarCorrection(
        width, height, floatData,
        scThreshold, scExpansion, scFeather,
        scRestoreColor, scRepairRinging
      );
      logMsg = result.logs.join('\n');
      onUpdateFits(activeFile.id, result.newData);
      icon = <Sparkles size={14} />;
    } 
    else if (activeTool === 'Noise' && floatData) {
      stepName = 'Multi-Scale Wavelet Noise Reduction';
      stepParams = `Plans: ${noisePlans}, Amt: ${(noiseAmount * 100).toFixed(0)}%, Kernel: ${getKernelName(noiseType)}`;
      addLog('info', 'Executing Wavelet Noise Reduction...');

      const result = executeWaveletNoiseReduction(
        width, height, floatData, noisePlans, noiseThresholds, noiseAmount, noiseType
      );
      logMsg = result.logs.join('\n');
      onUpdateFits(activeFile.id, result.newData);
      icon = <Droplets size={14} />;
    }
    else if (activeTool === 'Deconv' && floatData) {
      stepName = 'Richardson-Lucy Deconvolution';
      stepParams = `Iter: ${deconvIter}, PSF: ${deconvPsfSize}px/σ=${deconvPsfSigma}, Dering: ${deconvDeringing}`;
      addLog('info', 'Executing Richardson-Lucy Deconvolution...');

      const result = executeRichardsonLucyDeconvolution(
        width, height, floatData, deconvIter, deconvPsfSize, deconvPsfSigma, deconvDeringing, deconvDeringingThreshold
      );
      logMsg = result.logs.join('\n');
      onUpdateFits(activeFile.id, result.newData);
      icon = <Sparkles size={14} />;
    }
    else if (activeTool === 'HT' && floatData) {
      stepName = 'Histogram Transformation (HT)';
      stepParams = `Shadows: ${htShadows.toFixed(4)}, Highlights: ${htHighlights.toFixed(4)}, Midtones: ${htMidtones.toFixed(4)}`;
      addLog('info', 'Applying Histogram Transformation stretch...');

      const result = executeHistogramTransformation(
        width, height, floatData, htShadows, htHighlights, htMidtones
      );
      logMsg = result.logs.join('\n');
      onUpdateFits(activeFile.id, result.newData);
      icon = <Layers size={14} />;
    }
    else if (activeTool === 'GHS' && floatData) {
      stepName = 'Generalized Hyperbolic Stretch (GHS)';
      stepParams = `SP: ${ghsSP.toFixed(4)}, D: ${ghsD.toFixed(1)}`;
      addLog('info', 'Applying Generalized Hyperbolic Stretch...');

      const result = executeGeneralizedHyperbolicStretch(
        width, height, floatData, ghsSP, ghsD
      );
      logMsg = result.logs.join('\n');
      onUpdateFits(activeFile.id, result.newData);
      icon = <Sparkles size={14} />;
    }
    else if (activeTool === 'MaskedStretch' && floatData) {
      stepName = 'Masked Stretch';
      stepParams = `Target: ${msTargetMedian.toFixed(3)}, Iter: ${msIter}`;
      addLog('info', 'Applying Masked Stretch...');

      const result = executeMaskedStretch(
        width, height, floatData, msTargetMedian, msIter
      );
      logMsg = result.logs.join('\n');
      onUpdateFits(activeFile.id, result.newData);
      icon = <Wand2 size={14} />;
    }
    // ── Channel Combine ops ───────────────────────────────────────────────
    else if ((activeTool === 'CombineRGB' || activeTool === 'CombineHOO' || activeTool === 'CombineSHO' || activeTool === 'CombineLRGB')) {
      const getPlane = (fileId: string): Float32Array | null => {
        const f = sharedFiles.find(sf => sf.id === fileId);
        if (!f?.parsedFits) return null;
        const { floatData: fd, width: fw, height: fh } = f.parsedFits;
        // Support both mono and color source — extract plane 0 for mono, luma for color
        const planeLen = fw * fh;
        if (fd.length === planeLen) return fd.subarray(0, planeLen);
        if (fd.length >= planeLen * 3) {
          // Derive luma from RGB
          const mono = new Float32Array(planeLen);
          for (let i = 0; i < planeLen; i++) {
            mono[i] = 0.2126 * fd[i] + 0.7152 * fd[planeLen + i] + 0.0722 * fd[planeLen * 2 + i];
          }
          return mono;
        }
        return null;
      };

      // All combine ops need a consistent width/height — use first valid source file
      const srcIds = activeTool === 'CombineRGB'
        ? [combineRFile, combineGFile, combineBFile]
        : activeTool === 'CombineHOO'
        ? [combineHaFile, combineOiiiFile]
        : activeTool === 'CombineSHO'
        ? [combineSiiFile, combineHaFile, combineOiiiFile]
        : [combineLFile, combineRFile, combineGFile, combineBFile];

      const firstSrc = srcIds.map(id => sharedFiles.find(f => f.id === id)).find(f => f?.parsedFits);
      if (!firstSrc?.parsedFits) {
        addLog('error', 'No valid source files selected for channel combination.');
        setIsProcessing(false);
        return;
      }
      const { width: cW, height: cH } = firstSrc.parsedFits;

      let combineResult: { newData: Float32Array } | null = null;
      if (activeTool === 'CombineRGB') {
        stepName = 'RGB Channel Combine';
        addLog('info', `Combining R/G/B planes to ${cW}x${cH} color FITS...`);
        combineResult = combineFitsChannels(cW, cH, {
          mode: 'RGB', rOrHa: getPlane(combineRFile), gOrOiii: getPlane(combineGFile), bOrSii: getPlane(combineBFile)
        });
      } else if (activeTool === 'CombineHOO') {
        stepName = 'HOO Narrowband Combine';
        addLog('info', 'Combining Ha → R, OIII → G+B (HOO palette)...');
        combineResult = combineFitsChannels(cW, cH, {
          mode: 'HOO', rOrHa: getPlane(combineHaFile), gOrOiii: getPlane(combineOiiiFile)
        });
      } else if (activeTool === 'CombineSHO') {
        stepName = 'SHO Hubble Palette Combine';
        addLog('info', 'Combining SII → R, Ha → G, OIII → B (Hubble palette)...');
        combineResult = combineFitsChannels(cW, cH, {
          mode: 'SHO', rOrHa: getPlane(combineHaFile), bOrSii: getPlane(combineSiiFile), oiii: getPlane(combineOiiiFile)
        });
      } else if (activeTool === 'CombineLRGB') {
        stepName = 'LRGB Luminance Blend';
        addLog('info', `Blending L with RGB (luminance weight: ${(combineLumWeight * 100).toFixed(0)}%)...`);
        combineResult = combineFitsChannels(cW, cH, {
          mode: 'LRGB',
          lum: getPlane(combineLFile),
          rOrHa: getPlane(combineRFile), gOrOiii: getPlane(combineGFile), bOrSii: getPlane(combineBFile),
          lumWeight: combineLumWeight
        });
      }

      if (combineResult) {
        // Combine produces a new image — create it as a new workspace file so the
        // mono source planes (R/G/B, Ha/OIII/SII, L) are left untouched.
        const { writeFits } = await import('../utils/parsers');
        const headers = [
          { key: 'SIMPLE', value: 'T', comment: '', raw: '' },
          { key: 'BITPIX', value: '-32', comment: '', raw: '' },
          { key: 'NAXIS', value: '3', comment: '', raw: '' },
          { key: 'NAXIS1', value: cW.toString(), comment: '', raw: '' },
          { key: 'NAXIS2', value: cH.toString(), comment: '', raw: '' },
          { key: 'NAXIS3', value: '3', comment: '', raw: '' },
          { key: 'IMAGETYP', value: stepName, comment: '', raw: '' },
          { key: 'END', value: '', comment: '', raw: '' },
        ];
        const buf = writeFits({ headers, width: cW, height: cH, bitpix: -32, bzero: 0, bscale: 1, floatData: combineResult.newData, rawBuffer: new ArrayBuffer(0) }, headers);
        const outFile = new File([buf], `${stepName.replace(/\s+/g, '_')}.fits`, { type: 'application/fits' });

        if (onAddFiles) {
          onAddFiles([outFile]);
          addLog('success', `${stepName} complete → ${outFile.name} (${cW}x${cH}) added to workspace.`);
        } else {
          // Fallback for hosts that don't wire up onAddFiles: at least don't lose the result.
          onUpdateFits(activeFile.id, combineResult.newData);
          addLog('warning', `${stepName} complete, but no workspace-add handler was provided — result written to the active file instead of a new one.`);
        }
        icon = <Palette size={14} />;
        stepParams = `${cW}x${cH}`;
        // This produced a distinct new file rather than editing activeFile in place,
        // so it deliberately skips the per-file history/undo stack pushed below.
        return;
      }
    }

      if (logMsg) {
        logMsg.split('\n').forEach(line => {
          if (line.trim()) {
            addLog('info', line);
          }
        });
      }

      // Short processing delay for UI responsiveness
      await new Promise(r => setTimeout(r, 600));

      setHistory(prev => [
        ...prev, 
        { id: `${activeTool}-${Date.now()}`, name: stepName, params: stepParams, icon }
      ]);
      
      addLog('success', `Executed ${stepName}`);
    } catch (err) {
      addLog('error', `Processing failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setIsProcessing(false);
    }
  };

  const onUpdateFits = (id: string, newData: Float32Array) => {
    onUpdateFitsProp(id, newData);
    setPixelHistory(prev => {
      const updated = [...prev, new Float32Array(newData)];
      if (updated.length > 20) {
        updated.splice(0, updated.length - 20);
      }
      return updated;
    });
  };

  const undoLast = () => {
    if (history.length <= 1 || pixelHistory.length <= 1) return;
    const previousPixels = pixelHistory[pixelHistory.length - 2];
    const poppedName = history[history.length - 1]?.name || 'Unknown';
    setPixelHistory(prev => prev.slice(0, -1));
    setHistory(prev => prev.slice(0, -1));
    if (activeFile && previousPixels) {
      onUpdateFitsProp(activeFile.id, new Float32Array(previousPixels));
      addLog('info', `Reverted last operation: ${poppedName}`);
    }
  };

  const toolCategories = [
    {
      name: 'Background & Calibration',
      tools: [
        { id: 'DBE',        name: 'Dynamic Background Extraction' },
        { id: 'LMATCH',     name: 'Channel Match (LMATCH)' },
        { id: 'Banding',    name: 'Banding Reduction' },
        { id: 'ColorCalib', name: 'Color Calibration' },
        { id: 'Cosmetic',   name: 'Hot / Cold Pixel Fix' },
      ]
    },
    {
      name: 'Stretch',
      tools: [
        { id: 'HT',            name: 'Histogram Stretch (HT)' },
        { id: 'Asinh',         name: 'Arcsinh Stretch' },
        { id: 'GHS',           name: 'Hyperbolic Stretch (GHS)' },
        { id: 'MaskedStretch', name: 'Background-Protected Stretch' },
      ]
    },
    {
      name: 'Noise & Sharpening',
      tools: [
        { id: 'Noise',          name: 'Multi-Scale Noise Reduction' },
        { id: 'Deconv',         name: 'Deconvolution (Sharpening)' },
        { id: 'Wavelets',       name: 'Wavelet Sharpening' },
        { id: 'CLAHE',          name: 'Adaptive Local Contrast' },
        { id: 'WaveletContrast',name: 'Large-Scale Contrast Boost' },
      ]
    },
    {
      name: 'Color',
      tools: [
        { id: 'SCNR',      name: 'Remove Green Cast (SCNR)' },
        { id: 'Saturation',name: 'Selective Saturation' },
      ]
    },
    {
      name: 'Stars',
      tools: [
        { id: 'StarNet',    name: 'Star Separation (StarNet)' },
        { id: 'StarReduce', name: 'Star Size Reduction' },
        { id: 'StarCorrect',name: 'Star Color Correction' },
      ]
    },
    {
      name: 'Analysis',
      tools: [
        { id: 'RGradient', name: 'Rotational Gradient' },
      ]
    },
    {
      name: 'Combine Channels',
      tools: [
        { id: 'CombineRGB',  name: 'RGB Combine' },
        { id: 'CombineHOO', name: 'HOO Narrowband (Ha/OIII)' },
        { id: 'CombineSHO', name: 'SHO Hubble Palette' },
        { id: 'CombineLRGB',name: 'LRGB Luminance Blend' },
      ]
    },
  ];

  const otherFiles = sharedFiles.filter(f => f.id !== activeFile?.id);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', gap: '0.75rem', overflow: 'hidden' }}>
      
      {/* Module Header */}
      <div className="sidebar-module-header">
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <h2 className="sidebar-module-title">
            <Wand2 size={16} color="var(--accent-purple)" />
            Post-Processing Suite
          </h2>
          <button 
            onClick={undoLast}
            disabled={history.length <= 1 || isProcessing}
            className="btn-secondary"
            style={{ padding: '0.35rem 0.65rem' }}
          >
            <RotateCcw size={12} /> Undo
          </button>
        </div>
        <p className="sidebar-module-desc">Apply professional-grade astronomical image processing algorithms to FITS/SER data.</p>
      </div>

      {/* Main Content Area */}
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: '0.75rem', overflow: 'hidden' }}>
        {/* Tool Selector Section */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem', flexShrink: 0, maxHeight: '40%', overflowY: 'auto', borderBottom: activeTool ? '1px solid var(--border)' : 'none', paddingBottom: activeTool ? '0.5rem' : 0 }}>
          <div style={{ fontSize: '0.7rem', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Modules List</div>
          
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.35rem' }}>
            {toolCategories.map(cat => {
              const isExpanded = expandedCategories[cat.name];
              return (
                <div key={cat.name} style={{ display: 'flex', flexDirection: 'column', border: '1px solid var(--border)', borderRadius: '6px', overflow: 'hidden', backgroundColor: 'rgba(10, 15, 30, 0.4)' }}>
                  <button
                    onClick={() => toggleCategory(cat.name)}
                    style={{
                      display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                      width: '100%', padding: '0.4rem 0.6rem', backgroundColor: 'rgba(20, 30, 55, 0.5)',
                      color: 'var(--text-main)', border: 'none', borderBottom: isExpanded ? '1px solid var(--border)' : 'none',
                      cursor: 'pointer', fontSize: '0.7rem', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.05em'
                    }}
                  >
                    <span>{cat.name}</span>
                    <span style={{ fontSize: '0.65rem', color: 'var(--text-muted)' }}>{isExpanded ? '▼' : '▶'}</span>
                  </button>
                  {isExpanded && (
                    <div style={{ display: 'flex', flexDirection: 'column', padding: '0.2rem', gap: '0.15rem' }}>
                      {cat.tools.map(tool => {
                        const isActive = activeTool === tool.id;
                        return (
                          <button
                            key={tool.id}
                            onClick={() => setActiveTool(tool.id as ActiveTool)}
                            style={{
                              textAlign: 'left', padding: '0.35rem 0.5rem',
                              backgroundColor: isActive ? 'rgba(56, 189, 248, 0.12)' : 'transparent',
                              color: isActive ? 'var(--accent-blue)' : 'var(--text-muted)',
                              border: 'none',
                              borderRadius: '4px', cursor: 'pointer', fontSize: '0.75rem', fontWeight: isActive ? 700 : 500,
                              display: 'flex', alignItems: 'center', gap: '0.4rem', transition: 'all 0.15s ease'
                            }}
                          >
                            <span style={{
                              width: '5px', height: '5px', borderRadius: '50%',
                              backgroundColor: isActive ? 'var(--accent-blue)' : 'rgba(255, 255, 255, 0.1)',
                              boxShadow: isActive ? '0 0 5px var(--accent-blue)' : 'none'
                            }} />
                            {tool.name}
                          </button>
                        );
                      })}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>

        {/* Selected Tool Parameters Section */}
        <div style={{ flex: 1, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: '0.75rem', paddingRight: '0.25rem' }}>
          {activeTool && (
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexShrink: 0 }}>
              <span style={{ fontSize: '0.75rem', fontWeight: 700, color: 'var(--accent-blue)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                Parameters & Controls
              </span>
              
              <div style={{ display: 'flex', gap: '0.4rem', alignItems: 'center' }}>
                <button
                  onClick={() => setActiveTool(null)}
                  className="btn-secondary"
                  style={{ padding: '0.35rem 0.65rem' }}
                  title="Deselect Tool"
                >
                  Clear
                </button>
                <button 
                  onClick={executeProcess}
                  disabled={isProcessing || !activeFile}
                  className="btn-primary"
                  style={{ padding: '0.35rem 0.65rem' }}
                >
                  <Eye size={12} />
                  {isProcessing ? 'Executing...' : 'Apply'}
                </button>
              </div>
            </div>
          )}

          {!activeFile && (
            <div style={{ padding: '2rem 1rem', textAlign: 'center', color: 'var(--text-muted)', fontSize: '0.8rem' }}>
              No active FITS file selected. Please load a file.
            </div>
          )}

          {activeFile && !activeTool && (
            <div style={{ padding: '2rem 1rem', textAlign: 'center', color: 'var(--text-muted)', fontSize: '0.8rem' }}>
              Select a processing module from the list above.
            </div>
          )}

        {activeFile && activeTool === 'DBE' && (
          <div className="control-card">
            <div className="control-card-title">Background Extraction (DBE)</div>
            <div>
              <div className="form-label-row"><span>Tolerance:</span> <span>{dbeTolerance}</span></div>
              <input type="range" min="0.1" max="5.0" step="0.1" value={dbeTolerance} onChange={e => setDbeTolerance(parseFloat(e.target.value))} className="input-range" />
            </div>
            <div>
              <div className="form-label-row"><span>Smoothing / Grid size:</span> <span>{Math.floor(dbeSmoothing * 20)}</span></div>
              <input type="range" min="0.1" max="1.0" step="0.1" value={dbeSmoothing} onChange={e => setDbeSmoothing(parseFloat(e.target.value))} className="input-range" />
            </div>
          </div>
        )}

        {activeFile && activeTool === 'LMATCH' && (
          <div className="control-card">
            <div className="control-card-title">Linear Match (LMATCH)</div>
            <label className="form-label">
              <span>Reference Image:</span>
              <select 
                value={refFileId} 
                onChange={e => setRefFileId(e.target.value)} 
                className="input-select"
              >
                {otherFiles.map(f => (
                  <option key={f.id} value={f.id}>{f.name}</option>
                ))}
                {otherFiles.length === 0 && <option value="">No other files in workspace</option>}
              </select>
            </label>
            <p style={{ fontSize: '0.7rem', color: 'var(--text-muted)', margin: 0, lineHeight: 1.4 }}>
              Linear Regression Matching matches the target channels to the reference channel statistics.
            </p>
          </div>
        )}

        {activeFile && activeTool === 'SCNR' && (
          <div className="control-card">
            <div className="control-card-title">Green Noise (SCNR)</div>
            <label className="form-label">
              <span>Protection Method:</span>
              <select 
                value={scnrType} 
                onChange={e => setScnrType(parseInt(e.target.value))} 
                className="input-select"
              >
                <option value="0">Average Neutral protection</option>
                <option value="1">Maximum Neutral protection</option>
                <option value="2">Maximum Neutral with amount</option>
                <option value="3">Sum protection</option>
              </select>
            </label>
            {scnrType >= 2 && (
              <div>
                <div className="form-label-row"><span>Amount:</span> <span>{scnrAmount}</span></div>
                <input type="range" min="0.0" max="1.0" step="0.05" value={scnrAmount} onChange={e => setScnrAmount(parseFloat(e.target.value))} className="input-range" />
              </div>
            )}
            <label className="input-checkbox-container">
              <input type="checkbox" checked={scnrPreserveLuminance} onChange={e => setScnrPreserveLuminance(e.target.checked)} />
              <span>Preserve Luminance (CIELAB L*)</span>
            </label>
          </div>
        )}

        {activeFile && activeTool === 'Asinh' && (
          <div className="control-card">
            <div className="control-card-title">Asinh Transformation</div>
            <div>
              <div className="form-label-row"><span>Stretch Factor (β):</span> <span>{asinhStretch}</span></div>
              <input type="range" min="1" max="500" step="5" value={asinhStretch} onChange={e => setAsinhStretch(parseFloat(e.target.value))} className="input-range" />
            </div>
            <div>
              <div className="form-label-row"><span>Black Point (offset):</span> <span>{asinhOffset.toFixed(4)}</span></div>
              <input type="range" min="0" max="0.1" step="0.001" value={asinhOffset} onChange={e => setAsinhOffset(parseFloat(e.target.value))} className="input-range" />
            </div>
            <label className="input-checkbox-container">
              <input type="checkbox" checked={asinhRgb} onChange={e => setAsinhRgb(e.target.checked)} />
              <span>Use RGB Weighted Luminance</span>
            </label>
          </div>
        )}

        {activeFile && activeTool === 'Banding' && (
          <div className="control-card">
            <div className="control-card-title">Banding Reduction</div>
            <div>
              <div className="form-label-row"><span>Sigma (invsigma):</span> <span>{bandingSigma}</span></div>
              <input type="range" min="1.0" max="10.0" step="0.5" value={bandingSigma} onChange={e => setBandingSigma(parseFloat(e.target.value))} className="input-range" />
            </div>
            <div>
              <div className="form-label-row"><span>Amount:</span> <span>{bandingAmount}</span></div>
              <input type="range" min="0.1" max="1.0" step="0.05" value={bandingAmount} onChange={e => setBandingAmount(parseFloat(e.target.value))} className="input-range" />
            </div>
            <label className="input-checkbox-container">
              <input type="checkbox" checked={bandingProtect} onChange={e => setBandingProtect(e.target.checked)} />
              <span>Protect Highlights</span>
            </label>
            <label className="input-checkbox-container">
              <input type="checkbox" checked={bandingVertical} onChange={e => setBandingVertical(e.target.checked)} />
              <span>Vertical banding reduction</span>
            </label>
          </div>
        )}

        {activeFile && activeTool === 'RGradient' && (
          <div className="control-card">
            <div className="control-card-title">Rotational Gradient</div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.4rem' }}>
              <label className="form-label">
                <span>Center X:</span>
                <input type="number" value={rgXc} onChange={e => setRgXc(parseInt(e.target.value) || 0)} className="input-number" />
              </label>
              <label className="form-label">
                <span>Center Y:</span>
                <input type="number" value={rgYc} onChange={e => setRgYc(parseInt(e.target.value) || 0)} className="input-number" />
              </label>
            </div>
            <div>
              <div className="form-label-row"><span>Radial step (dR):</span> <span>{rgDr}px</span></div>
              <input type="range" min="1" max="20" step="1" value={rgDr} onChange={e => setRgDr(parseInt(e.target.value))} className="input-range" />
            </div>
            <div>
              <div className="form-label-row"><span>Angular step (dA):</span> <span>{rgDa}°</span></div>
              <input type="range" min="0.1" max="10.0" step="0.1" value={rgDa} onChange={e => setRgDa(parseFloat(e.target.value))} className="input-range" />
            </div>
          </div>
        )}

        {activeFile && activeTool === 'Wavelets' && (
          <div className="control-card">
            <div className="control-card-title">Wavelet Sharpening</div>
            <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
              <label className="form-label" style={{ flex: 1 }}>
                <span>Kernel:</span>
                <select 
                  value={waveletType} 
                  onChange={e => setWaveletType(parseInt(e.target.value))}
                  className="input-select"
                >
                  <option value="1">Linear</option>
                  <option value="2">B3-Spline</option>
                  <option value="3">Gaussian (5x5)</option>
                  <option value="4">Box/Haar (3x3)</option>
                  <option value="5">Cubic Spline (7x7)</option>
                </select>
              </label>
              <label className="form-label">
                <span>Layers (plans):</span>
                <select 
                  value={waveletPlans} 
                  onChange={e => setWaveletPlans(parseInt(e.target.value))}
                  className="input-select"
                >
                  <option value="2">2</option>
                  <option value="3">3</option>
                  <option value="4">4</option>
                  <option value="5">5</option>
                </select>
              </label>
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.4rem', borderTop: '1px dashed var(--border)', paddingTop: '0.5rem' }}>
              <span style={{ fontSize: '0.7rem', fontWeight: 700 }}>Layer Scale Coefficients</span>
              {Array.from({ length: waveletPlans - 1 }).map((_, index) => (
                <div key={index} style={{ marginBottom: '0.2rem' }}>
                  <div className="form-label-row">
                    <span>Scale {index + 1} ({Math.pow(2, index)}px):</span>
                    <span style={{ color: waveletCoeffs[index] > 1.0 ? 'var(--success)' : waveletCoeffs[index] < 1.0 ? 'var(--accent-blue)' : 'var(--text-main)' }}>
                      {waveletCoeffs[index].toFixed(2)}x
                    </span>
                  </div>
                  <input 
                    type="range" 
                    min="0.0" 
                    max="4.0" 
                    step="0.1" 
                    value={waveletCoeffs[index] || 1.0} 
                    onChange={e => handleWaveletCoeffChange(index, parseFloat(e.target.value))} 
                    className="input-range" 
                  />
                </div>
              ))}
              <div style={{ fontSize: '0.65rem', color: 'var(--text-muted)', fontStyle: 'italic', lineHeight: 1.3 }}>
                Boost (&gt;1.0) to sharpen details. Reduce (&lt;1.0) to suppress noise. Residual base layer kept at 1.0.
              </div>
            </div>
          </div>
        )}

        {activeFile && activeTool === 'Saturation' && (
          <div className="control-card">
            <div className="control-card-title">Color Saturation</div>
            <label className="form-label">
              <span>Color Band:</span>
              <select 
                value={satuHueType} 
                onChange={e => setSatuHueType(parseInt(e.target.value))}
                className="input-select"
              >
                <option value="6">Global Saturation</option>
                <option value="0">Pink-Red to Red-Orange</option>
                <option value="1">Orange-Brown to Yellow</option>
                <option value="2">Yellow-Green to Green-Cyan</option>
                <option value="3">Cyan</option>
                <option value="4">Cyan-Blue to Blue-Magenta</option>
                <option value="5">Magenta to Pink</option>
              </select>
            </label>

            <div>
              <div className="form-label-row"><span>Saturation Factor:</span> <span>{(satuAmount * 100).toFixed(0)}%</span></div>
              <input type="range" min="-1.0" max="3.0" step="0.1" value={satuAmount} onChange={e => setSatuAmount(parseFloat(e.target.value))} className="input-range" />
            </div>

            <div>
              <div className="form-label-row"><span>Background Cutoff:</span> <span>{satuBgFactor.toFixed(1)}x</span></div>
              <input type="range" min="0.0" max="5.0" step="0.5" value={satuBgFactor} onChange={e => setSatuBgFactor(parseFloat(e.target.value))} className="input-range" />
              <div style={{ fontSize: '0.65rem', color: 'var(--text-muted)', marginTop: '0.15rem' }}>
                If &gt;0, prevents noise amplification in dark background.
              </div>
            </div>
          </div>
        )}

        {activeFile && activeTool === 'Cosmetic' && (
          <div className="control-card">
            <div className="control-card-title">Cosmetic Correction</div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.4rem', borderBottom: '1px solid var(--border)', paddingBottom: '0.5rem' }}>
              <label className="input-checkbox-container">
                <input type="checkbox" checked={cosmeEnableHot} onChange={e => setCosmeEnableHot(e.target.checked)} />
                <span style={{ fontWeight: 600 }}>Hot Pixel Correction</span>
              </label>
              {cosmeEnableHot && (
                <div>
                  <div className="form-label-row"><span>Hot Sigma Threshold:</span> <span>{cosmeSigmaHot.toFixed(1)}</span></div>
                  <input type="range" min="1.0" max="10.0" step="0.5" value={cosmeSigmaHot} onChange={e => setCosmeSigmaHot(parseFloat(e.target.value))} className="input-range" />
                </div>
              )}
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.4rem', borderBottom: '1px solid var(--border)', paddingBottom: '0.5rem' }}>
              <label className="input-checkbox-container">
                <input type="checkbox" checked={cosmeEnableCold} onChange={e => setCosmeEnableCold(e.target.checked)} />
                <span style={{ fontWeight: 600 }}>Cold Pixel Correction</span>
              </label>
              {cosmeEnableCold && (
                <div>
                  <div className="form-label-row"><span>Cold Sigma Threshold:</span> <span>{cosmeSigmaCold.toFixed(1)}</span></div>
                  <input type="range" min="1.0" max="10.0" step="0.5" value={cosmeSigmaCold} onChange={e => setCosmeSigmaCold(parseFloat(e.target.value))} className="input-range" />
                </div>
              )}
            </div>

            <label className="input-checkbox-container">
              <input type="checkbox" checked={cosmeIsCfa} onChange={e => setCosmeIsCfa(e.target.checked)} />
              <span>Is CFA / Bayer pattern</span>
            </label>
          </div>
        )}

        {activeFile && activeTool === 'ColorCalib' && (
          <div className="control-card">
            <div className="control-card-title">Color Calibration</div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.4rem', borderBottom: '1px solid var(--border)', paddingBottom: '0.5rem' }}>
              <label className="input-checkbox-container">
                <input type="checkbox" checked={ccAutoBg} onChange={e => setCcAutoBg(e.target.checked)} />
                <span style={{ fontWeight: 600 }}>Auto Background Neutralization</span>
              </label>
              {!ccAutoBg && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '0.4rem' }}>
                  <div style={{ fontSize: '0.7rem', color: 'var(--text-muted)' }}>Manual Offset ADU:</div>
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '0.25rem' }}>
                    <label className="form-label">
                      <span style={{ color: 'var(--danger)' }}>Red:</span>
                      <input type="number" step="0.001" className="input-number" style={{ padding: '0.2rem' }} value={ccBgRed} onChange={e => setCcBgRed(parseFloat(e.target.value) || 0)} />
                    </label>
                    <label className="form-label">
                      <span style={{ color: 'var(--success)' }}>Green:</span>
                      <input type="number" step="0.001" className="input-number" style={{ padding: '0.2rem' }} value={ccBgGreen} onChange={e => setCcBgGreen(parseFloat(e.target.value) || 0)} />
                    </label>
                    <label className="form-label">
                      <span style={{ color: 'var(--accent-blue)' }}>Blue:</span>
                      <input type="number" step="0.001" className="input-number" style={{ padding: '0.2rem' }} value={ccBgBlue} onChange={e => setCcBgBlue(parseFloat(e.target.value) || 0)} />
                    </label>
                  </div>
                </div>
              )}
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.4rem' }}>
              <label className="input-checkbox-container">
                <input type="checkbox" checked={ccAutoWhite} onChange={e => setCcAutoWhite(e.target.checked)} />
                <span style={{ fontWeight: 600 }}>Auto White Balance</span>
              </label>
              {!ccAutoWhite && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '0.4rem' }}>
                  <div style={{ fontSize: '0.7rem', color: 'var(--text-muted)' }}>Manual Multipliers:</div>
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '0.25rem' }}>
                    <label className="form-label">
                      <span style={{ color: 'var(--danger)' }}>Red:</span>
                      <input type="number" step="0.01" className="input-number" style={{ padding: '0.2rem' }} value={ccWhiteRed} onChange={e => setCcWhiteRed(parseFloat(e.target.value) || 1)} />
                    </label>
                    <label className="form-label">
                      <span style={{ color: 'var(--success)' }}>Green:</span>
                      <input type="number" step="0.01" className="input-number" style={{ padding: '0.2rem' }} value={ccWhiteGreen} onChange={e => setCcWhiteGreen(parseFloat(e.target.value) || 1)} />
                    </label>
                    <label className="form-label">
                      <span style={{ color: 'var(--accent-blue)' }}>Blue:</span>
                      <input type="number" step="0.01" className="input-number" style={{ padding: '0.2rem' }} value={ccWhiteBlue} onChange={e => setCcWhiteBlue(parseFloat(e.target.value) || 1)} />
                    </label>
                  </div>
                </div>
              )}
            </div>
          </div>
        )}

        {activeFile && activeTool === 'Noise' && (
          <div className="control-card">
            <div className="control-card-title">Wavelet Noise Reduction</div>
            <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
              <label className="form-label" style={{ flex: 1 }}>
                <span>Kernel:</span>
                <select 
                  value={noiseType} 
                  onChange={e => setNoiseType(parseInt(e.target.value))}
                  className="input-select"
                >
                  <option value="1">Linear</option>
                  <option value="2">B3-Spline</option>
                  <option value="3">Gaussian (5x5)</option>
                  <option value="4">Box/Haar (3x3)</option>
                  <option value="5">Cubic Spline (7x7)</option>
                </select>
              </label>
              <label className="form-label">
                <span>Layers (plans):</span>
                <select 
                  value={noisePlans} 
                  onChange={e => {
                    const val = parseInt(e.target.value);
                    setNoisePlans(val);
                    setNoiseThresholds(prev => {
                      if (prev.length < val) {
                        return [...prev, ...Array(val - prev.length).fill(1.0)];
                      }
                      return prev.slice(0, val);
                    });
                  }}
                  className="input-select"
                >
                  <option value="2">2</option>
                  <option value="3">3</option>
                  <option value="4">4</option>
                  <option value="5">5</option>
                </select>
              </label>
            </div>

            <div>
              <div className="form-label-row"><span>Reduction Amount:</span> <span>{(noiseAmount * 100).toFixed(0)}%</span></div>
              <input type="range" min="0.0" max="1.0" step="0.05" value={noiseAmount} onChange={e => setNoiseAmount(parseFloat(e.target.value))} className="input-range" />
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.4rem', borderTop: '1px dashed var(--border)', paddingTop: '0.5rem' }}>
              <span style={{ fontSize: '0.7rem', fontWeight: 700 }}>Sigma Thresholds per Layer</span>
              {Array.from({ length: noisePlans - 1 }).map((_, index) => (
                <div key={index} style={{ marginBottom: '0.2rem' }}>
                  <div className="form-label-row">
                    <span>Layer {index + 1} ({Math.pow(2, index)}px):</span>
                    <span>
                      {(noiseThresholds[index] !== undefined ? noiseThresholds[index] : 1.0).toFixed(1)}σ
                    </span>
                  </div>
                  <input 
                    type="range" 
                    min="0.1" 
                    max="10.0" 
                    step="0.1" 
                    value={noiseThresholds[index] !== undefined ? noiseThresholds[index] : 1.0} 
                    onChange={e => handleNoiseThresholdChange(index, parseFloat(e.target.value))} 
                    className="input-range" 
                  />
                </div>
              ))}
              <div style={{ fontSize: '0.65rem', color: 'var(--text-muted)', fontStyle: 'italic', lineHeight: 1.3 }}>
                Higher thresholds filter more noise but may smooth details. Lower layers represent smaller structures.
              </div>
            </div>
          </div>
        )}

        {activeFile && activeTool === 'Deconv' && (
          <div className="control-card">
            <div className="control-card-title">Richardson-Lucy Deconvolution</div>
            <div>
              <div className="form-label-row"><span>Iterations:</span> <span>{deconvIter}</span></div>
              <input type="range" min="1" max="40" step="1" value={deconvIter} onChange={e => setDeconvIter(parseInt(e.target.value))} className="input-range" />
            </div>

            <div style={{ display: 'flex', gap: '0.5rem' }}>
              <label className="form-label" style={{ flex: 1 }}>
                <span>PSF Kernel Size:</span>
                <select 
                  value={deconvPsfSize} 
                  onChange={e => setDeconvPsfSize(parseInt(e.target.value))}
                  className="input-select"
                >
                  <option value="3">3x3</option>
                  <option value="5">5x5</option>
                  <option value="7">7x7</option>
                  <option value="9">9x9</option>
                </select>
              </label>
              <label className="form-label" style={{ flex: 1 }}>
                <span>PSF Sigma (px):</span>
                <input 
                  type="number" 
                  step="0.1" 
                  min="0.5" 
                  max="5.0"
                  value={deconvPsfSigma} 
                  onChange={e => setDeconvPsfSigma(parseFloat(e.target.value) || 1.0)} 
                  className="input-number" 
                />
              </label>
            </div>

            <div style={{ borderTop: '1px dashed var(--border)', paddingTop: '0.5rem', display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
              <span style={{ fontSize: '0.7rem', fontWeight: 700 }}>Halos & Deringing Protection</span>
              
              <div>
                <div className="form-label-row"><span>Deringing Amount:</span> <span>{(deconvDeringing * 100).toFixed(0)}%</span></div>
                <input type="range" min="0.0" max="1.0" step="0.05" value={deconvDeringing} onChange={e => setDeconvDeringing(parseFloat(e.target.value))} className="input-range" />
              </div>

              <div>
                <div className="form-label-row"><span>Star Threshold:</span> <span>{deconvDeringingThreshold.toFixed(3)}</span></div>
                <input type="range" min="0.001" max="0.2" step="0.002" value={deconvDeringingThreshold} onChange={e => setDeconvDeringingThreshold(parseFloat(e.target.value))} className="input-range" />
              </div>
            </div>
          </div>
        )}

        {activeFile && activeTool === 'HT' && (
          <div className="control-card">
            <div className="control-card-title">Histogram Transformation</div>
            <div>
              <div className="form-label-row"><span>Shadows Clip:</span> <span>{htShadows.toFixed(4)}</span></div>
              <input type="range" min="0.0" max="0.1" step="0.0005" value={htShadows} onChange={e => setHtShadows(parseFloat(e.target.value))} className="input-range" />
            </div>

            <div>
              <div className="form-label-row"><span>Highlights Clip:</span> <span>{htHighlights.toFixed(4)}</span></div>
              <input type="range" min="0.9" max="1.0" step="0.0005" value={htHighlights} onChange={e => setHtHighlights(parseFloat(e.target.value))} className="input-range" />
            </div>

            <div>
              <div className="form-label-row"><span>Midtones Balance:</span> <span>{htMidtones.toFixed(4)}</span></div>
              <input type="range" min="0.005" max="0.995" step="0.005" value={htMidtones} onChange={e => setHtMidtones(parseFloat(e.target.value))} className="input-range" />
            </div>
            <div style={{ fontSize: '0.65rem', color: 'var(--text-muted)', fontStyle: 'italic', lineHeight: 1.3 }}>
              Shadows clips dark levels to black. Midtones stretches the midtone region.
            </div>
          </div>
        )}

        {activeFile && activeTool === 'GHS' && (
          <div className="control-card">
            <div className="control-card-title">Generalized Hyperbolic Stretch</div>
            <div>
              <div className="form-label-row"><span>Symmetry Point (SP):</span> <span>{ghsSP.toFixed(4)}</span></div>
              <input type="range" min="0.0" max="0.1" step="0.001" value={ghsSP} onChange={e => setGhsSP(parseFloat(e.target.value))} className="input-range" />
            </div>

            <div>
              <div className="form-label-row"><span>Stretch Factor (D):</span> <span>{ghsD.toFixed(1)}</span></div>
              <input type="range" min="1.0" max="30.0" step="0.5" value={ghsD} onChange={e => setGhsD(parseFloat(e.target.value))} className="input-range" />
            </div>
            <div style={{ fontSize: '0.65rem', color: 'var(--text-muted)', fontStyle: 'italic', lineHeight: 1.3 }}>
              Concentrates the stretch rate at the Symmetry Point to protect star colors and highlight nebulosity.
            </div>
          </div>
        )}

        {activeFile && activeTool === 'MaskedStretch' && (
          <div className="control-card">
            <div className="control-card-title">Masked Stretch</div>
            <div>
              <div className="form-label-row"><span>Target Median:</span> <span>{msTargetMedian.toFixed(3)}</span></div>
              <input type="range" min="0.05" max="0.25" step="0.005" value={msTargetMedian} onChange={e => setMsTargetMedian(parseFloat(e.target.value))} className="input-range" />
            </div>

            <div>
              <div className="form-label-row"><span>Max Iterations:</span> <span>{msIter}</span></div>
              <input type="range" min="1" max="15" step="1" value={msIter} onChange={e => setMsIter(parseInt(e.target.value))} className="input-range" />
            </div>
            <div style={{ fontSize: '0.65rem', color: 'var(--text-muted)', fontStyle: 'italic', lineHeight: 1.3 }}>
              Progressively stretches details using a luminance star-protecting mask to prevent cores and halos from saturating.
            </div>
          </div>
        )}

        {activeFile && activeTool === 'StarNet' && (
          <div className="control-card">
            <div className="control-card-title">Star Separation (StarNet)</div>
            <div>
              <div className="form-label-row"><span>Star Threshold (σ):</span> <span>{starnetThreshold.toFixed(1)}</span></div>
              <input type="range" min="1.0" max="8.0" step="0.2" value={starnetThreshold} onChange={e => setStarnetThreshold(parseFloat(e.target.value))} className="input-range" />
            </div>
            <div>
              <div className="form-label-row"><span>Mask Expansion (px):</span> <span>{starnetExpansion}px</span></div>
              <input type="range" min="0" max="10" step="1" value={starnetExpansion} onChange={e => setStarnetExpansion(parseInt(e.target.value))} className="input-range" />
            </div>
            <div>
              <div className="form-label-row"><span>Mask Feather (px):</span> <span>{starnetFeather}px</span></div>
              <input type="range" min="0" max="10" step="1" value={starnetFeather} onChange={e => setStarnetFeather(parseInt(e.target.value))} className="input-range" />
            </div>
            <div>
              <div className="form-label-row"><span>Inpaint Iterations:</span> <span>{starnetIterations}</span></div>
              <input type="range" min="5" max="80" step="5" value={starnetIterations} onChange={e => setStarnetIterations(parseInt(e.target.value))} className="input-range" />
            </div>
            <label className="form-label">
              <span>Output Layer:</span>
              <select value={starnetOutput} onChange={e => setStarnetOutput(e.target.value)} className="input-select">
                <option value="starless">Starless (Nebula Layer)</option>
                <option value="stars">Stars (Isolated Star Layer)</option>
              </select>
            </label>
            <div style={{ fontSize: '0.65rem', color: 'var(--text-muted)', fontStyle: 'italic', lineHeight: 1.3 }}>
              Separates star profiles from background nebulae using a local maxima star detector and Laplace harmonic inpainting.
            </div>
          </div>
        )}

        {activeFile && activeTool === 'StarReduce' && (
          <div className="control-card">
            <div className="control-card-title">Star Reduction</div>
            <div>
              <div className="form-label-row"><span>Reduction Amount:</span> <span>{(reduceAmount * 100).toFixed(0)}%</span></div>
              <input type="range" min="0.05" max="1.0" step="0.05" value={reduceAmount} onChange={e => setReduceAmount(parseFloat(e.target.value))} className="input-range" />
            </div>
            <div>
              <div className="form-label-row"><span>Star Threshold (σ):</span> <span>{reduceThreshold.toFixed(1)}</span></div>
              <input type="range" min="1.0" max="8.0" step="0.2" value={reduceThreshold} onChange={e => setReduceThreshold(parseFloat(e.target.value))} className="input-range" />
            </div>
            <div>
              <div className="form-label-row"><span>Mask Expansion (px):</span> <span>{reduceExpansion}px</span></div>
              <input type="range" min="0" max="10" step="1" value={reduceExpansion} onChange={e => setReduceExpansion(parseInt(e.target.value))} className="input-range" />
            </div>
            <div>
              <div className="form-label-row"><span>Mask Feather (px):</span> <span>{reduceFeather}px</span></div>
              <input type="range" min="0" max="10" step="1" value={reduceFeather} onChange={e => setReduceFeather(parseInt(e.target.value))} className="input-range" />
            </div>
            <label className="form-label">
              <span>Reduction Method:</span>
              <select value={reduceMethod} onChange={e => setReduceMethod(e.target.value)} className="input-select">
                <option value="scaling">Layer Scaling (Precise & Smooth)</option>
                <option value="morphological">Morphological (Min/Median Erosion)</option>
              </select>
            </label>
            <div style={{ fontSize: '0.65rem', color: 'var(--text-muted)', fontStyle: 'italic', lineHeight: 1.3 }}>
              Selective star profile shrinking. Scaling uses subtraction and dimming. Morphological uses local minimum/median erosion.
            </div>
          </div>
        )}

        {activeFile && activeTool === 'CLAHE' && (
          <div className="control-card">
            <div className="control-card-title">CLAHE Local Contrast</div>
            <div>
              <div className="form-label-row"><span>Contrast Clip Limit:</span> <span>{claheClipLimit.toFixed(1)}</span></div>
              <input type="range" min="1.0" max="10.0" step="0.2" value={claheClipLimit} onChange={e => setClaheClipLimit(parseFloat(e.target.value))} className="input-range" />
            </div>
            <div>
              <div className="form-label-row"><span>Grid Tiles:</span> <span>{claheGridSize} x {claheGridSize}</span></div>
              <input type="range" min="2" max="24" step="2" value={claheGridSize} onChange={e => setClaheGridSize(parseInt(e.target.value))} className="input-range" />
            </div>
            <div style={{ fontSize: '0.65rem', color: 'var(--text-muted)', fontStyle: 'italic', lineHeight: 1.3 }}>
              Enhances regional details using adaptive histogram equalization. Clipping the local histograms prevents background noise from bloating. Runs on luminance to preserve original colors.
            </div>
          </div>
        )}

        {activeFile && activeTool === 'WaveletContrast' && (
          <div className="control-card">
            <div className="control-card-title">Wavelet Contrast</div>
            <label className="form-label">
              <span>Kernel:</span>
              <select 
                value={wcType} 
                onChange={e => setWcType(parseInt(e.target.value))}
                className="input-select"
              >
                <option value="1">Linear</option>
                <option value="2">B3-Spline</option>
                <option value="3">Gaussian (5x5)</option>
                <option value="4">Box/Haar (3x3)</option>
                <option value="5">Cubic Spline (7x7)</option>
              </select>
            </label>
            <div>
              <div className="form-label-row"><span>Total Enhancement Amount:</span> <span>{(wcAmount * 100).toFixed(0)}%</span></div>
              <input type="range" min="0.0" max="2.0" step="0.05" value={wcAmount} onChange={e => setWcAmount(parseFloat(e.target.value))} className="input-range" />
            </div>
            <div>
              <div className="form-label-row"><span>Noise Threshold (σ):</span> <span>{wcNoiseThreshold.toFixed(1)}σ</span></div>
              <input type="range" min="0.0" max="6.0" step="0.2" value={wcNoiseThreshold} onChange={e => setWcNoiseThreshold(parseFloat(e.target.value))} className="input-range" />
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.35rem' }}>
              <span style={{ fontSize: '0.7rem', fontWeight: 700 }}>Wavelet Scale Contrast Bias</span>
              {wcBiases.map((bias, i) => (
                <div key={i} style={{ display: 'flex', flexDirection: 'column', gap: '0.1rem' }}>
                  <div className="form-label-row">
                    <span>Scale {i + 1} ({Math.pow(2, i)}px detail):</span>
                    <span>{bias.toFixed(2)}x</span>
                  </div>
                  <input type="range" min="0.5" max="2.0" step="0.05" value={bias} onChange={e => handleWcBiasChange(i, parseFloat(e.target.value))} className="input-range" />
                </div>
              ))}
            </div>

            <div style={{ fontSize: '0.65rem', color: 'var(--text-muted)', fontStyle: 'italic', lineHeight: 1.3 }}>
              Enhances detail scales independently. Biases larger than 1.0 enhance contrast. A noise threshold prevents background noise amplification.
            </div>
          </div>
        )}

        {activeFile && activeTool === 'StarCorrect' && (
          <div className="control-card">
            <div className="control-card-title">Final Star Correction</div>
            <div>
              <div className="form-label-row"><span>Star Threshold (σ):</span> <span>{scThreshold.toFixed(1)}σ</span></div>
              <input type="range" min="1.0" max="8.0" step="0.2" value={scThreshold} onChange={e => setScThreshold(parseFloat(e.target.value))} className="input-range" />
            </div>
            <div>
              <div className="form-label-row"><span>Mask Expansion (px):</span> <span>{scExpansion}px</span></div>
              <input type="range" min="0" max="10" step="1" value={scExpansion} onChange={e => setScExpansion(parseInt(e.target.value))} className="input-range" />
            </div>
            <div>
              <div className="form-label-row"><span>Mask Feather (px):</span> <span>{scFeather}px</span></div>
              <input type="range" min="0" max="10" step="1" value={scFeather} onChange={e => setScFeather(parseInt(e.target.value))} className="input-range" />
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.4rem', borderTop: '1px solid var(--border)', paddingTop: '0.5rem' }}>
              <label className="input-checkbox-container">
                <input type="checkbox" checked={scRestoreColor} onChange={e => setScRestoreColor(e.target.checked)} />
                <span style={{ fontWeight: 600 }}>Recover Saturated Star Colors</span>
              </label>
              <div style={{ fontSize: '0.65rem', color: 'var(--text-muted)', fontStyle: 'italic', lineHeight: 1.2 }}>
                Restores original RGB chromatic ratios inside white saturated star cores by interpolating from the unsaturated outer halo.
              </div>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.4rem', borderTop: '1px solid var(--border)', paddingTop: '0.5rem' }}>
              <label className="input-checkbox-container">
                <input type="checkbox" checked={scRepairRinging} onChange={e => setScRepairRinging(e.target.checked)} />
                <span style={{ fontWeight: 600 }}>Repair Dark Ringing Halos</span>
              </label>
              <div style={{ fontSize: '0.65rem', color: 'var(--text-muted)', fontStyle: 'italic', lineHeight: 1.2 }}>
                Suppresses dark under-shoots and black rings around stars by comparing and clamping halo pixel values to the local background sky level.
              </div>
            </div>
          </div>
        )}

        {/* ── Channel Combine Control Cards ─────────────────────────────── */}
        {(() => {
          const fileOpts = sharedFiles.filter(f => f.parsedFits);
          const fileSelect = (label: string, val: string, set: (v: string) => void) => (
            <label className="form-label" style={{ marginBottom: '0.25rem' }}>
              <span style={{ color: 'var(--text-main)' }}>{label}</span>
              <select className="input-select" value={val} onChange={e => set(e.target.value)}>
                <option value="">— select file —</option>
                {fileOpts.map(f => <option key={f.id} value={f.id}>{f.name}</option>)}
              </select>
            </label>
          );
          return (
            <>
              {activeTool === 'CombineRGB' && (
                <div className="control-card">
                  <div className="control-card-title"><Palette size={12} /> RGB Channel Combine</div>
                  <p style={{ fontSize: '0.68rem', color: 'var(--text-muted)', marginBottom: '0.4rem' }}>
                    Combine three separate monochrome FITS files into one color image.
                  </p>
                  {fileSelect('Red channel file:', combineRFile, setCombineRFile)}
                  {fileSelect('Green channel file:', combineGFile, setCombineGFile)}
                  {fileSelect('Blue channel file:', combineBFile, setCombineBFile)}
                </div>
              )}
              {activeTool === 'CombineHOO' && (
                <div className="control-card">
                  <div className="control-card-title"><Palette size={12} /> HOO Narrowband</div>
                  <p style={{ fontSize: '0.68rem', color: 'var(--text-muted)', marginBottom: '0.4rem' }}>
                    Ha → Red · OIII → Green + Blue. Classic two-filter narrowband palette.
                  </p>
                  {fileSelect('Hα (Hydrogen-alpha) file:', combineHaFile, setCombineHaFile)}
                  {fileSelect('OIII file:', combineOiiiFile, setCombineOiiiFile)}
                </div>
              )}
              {activeTool === 'CombineSHO' && (
                <div className="control-card">
                  <div className="control-card-title"><Palette size={12} /> SHO Hubble Palette</div>
                  <p style={{ fontSize: '0.68rem', color: 'var(--text-muted)', marginBottom: '0.4rem' }}>
                    SII → Red · Hα → Green · OIII → Blue. Three-filter narrowband "Hubble palette."
                  </p>
                  {fileSelect('SII (Sulphur-II) file:', combineSiiFile, setCombineSiiFile)}
                  {fileSelect('Hα (Hydrogen-alpha) file:', combineHaFile, setCombineHaFile)}
                  {fileSelect('OIII file:', combineOiiiFile, setCombineOiiiFile)}
                </div>
              )}
              {activeTool === 'CombineLRGB' && (
                <div className="control-card">
                  <div className="control-card-title"><Palette size={12} /> LRGB Luminance Blend</div>
                  <p style={{ fontSize: '0.68rem', color: 'var(--text-muted)', marginBottom: '0.4rem' }}>
                    Blend a luminance frame into an existing color image to add detail depth.
                  </p>
                  {fileSelect('Luminance (L) file:', combineLFile, setCombineLFile)}
                  {fileSelect('Red channel file:', combineRFile, setCombineRFile)}
                  {fileSelect('Green channel file:', combineGFile, setCombineGFile)}
                  {fileSelect('Blue channel file:', combineBFile, setCombineBFile)}
                  <div>
                    <div className="form-label-row"><span>Luminance Weight:</span><span>{(combineLumWeight * 100).toFixed(0)}%</span></div>
                    <input type="range" min="0" max="1" step="0.05" value={combineLumWeight} onChange={e => setCombineLumWeight(parseFloat(e.target.value))} className="input-range" />
                  </div>
                </div>
              )}
            </>
          );
        })()}
      </div>
    </div>

      {/* Bottom Collapsible History */}
      <div style={{ borderTop: '1px solid var(--border)', paddingTop: '0.75rem', display: 'flex', flexDirection: 'column', gap: '0.4rem', flexShrink: 0 }}>
        <div style={{ fontSize: '0.75rem', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', display: 'flex', justifyContent: 'space-between' }}>
          <span>Applied History</span>
          <span>{history.length} steps</span>
        </div>
        <div style={{ maxHeight: '110px', overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: '0.25rem', paddingRight: '0.25rem' }}>
          {history.map((step, i) => (
            <div key={step.id} style={{ display: 'flex', gap: '0.4rem', padding: '0.35rem 0.5rem', backgroundColor: i === history.length - 1 ? 'rgba(59, 130, 246, 0.08)' : 'var(--bg-deep)', border: i === history.length - 1 ? '1px solid var(--accent-blue)' : '1px solid var(--border)', borderRadius: '4px', alignItems: 'center' }}>
              <div style={{ color: i === history.length - 1 ? 'var(--accent-blue)' : 'var(--text-muted)' }}>
                {step.icon}
              </div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: '0.75rem', fontWeight: 600, color: i === history.length - 1 ? 'var(--text-main)' : 'var(--text-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{step.name}</div>
                <div style={{ fontSize: '0.65rem', color: 'var(--text-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{step.params}</div>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
};

export default PostProcessor;
