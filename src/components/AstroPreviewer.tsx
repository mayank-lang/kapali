import React, { useState, useEffect, useRef } from 'react';
import { ZoomIn, ZoomOut, Maximize, MousePointer2, FileText, Upload, Target, AlertCircle, CheckCircle, ExternalLink, FolderOpen } from 'lucide-react';
import '../App.css';
import { type SharedFile } from '../App';
import { calculateStats, applySTF, applyArcsinh, applyLinear } from '../utils/stretch';
import { extractSerFrame, type FitsParsedData, writeFits } from '../utils/parsers';
import { type FrameStats } from './SubframeSelector';

interface AstroPreviewerProps {
  activeFile: SharedFile | null;
  sharedFiles: SharedFile[];
  onSelectFile: (id: string) => void;
  onAddFiles: (files: File[]) => void;
  addLog: (type: 'info' | 'success' | 'warning' | 'error', msg: string) => void;
  activeTab?: string;
  subframeFrames?: FrameStats[];
  subframeMetric?: 'fwhm' | 'eccentricity' | 'snrWeight';
  subframeThresholds?: { fwhm: number; eccentricity: number; snrWeight: number };
  isPoppedOut?: boolean;
  onPopOut?: () => void;

  // Reality Inspector Props
  compareMode?: 'none' | 'blink' | 'swipe' | 'difference' | 'dss';
  blinkRate?: number;
  swipePos?: number;
  diffBoost?: number;
  diffMode?: 'added' | 'removed' | 'absolute';
  profileMode?: boolean;
  onProfileDataChange?: (originalSamples: number[], processedSamples: number[]) => void;
  dssImageUrl?: string | null;
  onUpdateFits?: (id: string, updatedFits: any) => void;
  livePreviewData?: { fileId: string; data: Float32Array } | null;
}

function isTextFile(name: string, buffer: ArrayBuffer): boolean {
  const ext = name.split('.').pop()?.toLowerCase() || '';
  if (['csv', 'txt', 'log', 'json', 'xml', 'ini', 'md', 'html', 'css', 'js', 'ts'].includes(ext)) {
    return true;
  }
  const view = new Uint8Array(buffer, 0, Math.min(buffer.byteLength, 100));
  for (let i = 0; i < view.length; i++) {
    const char = view[i];
    if (char < 9 || (char > 13 && char < 32 && char !== 27)) {
      return false;
    }
  }
  return true;
}

function renderHexDump(buffer: ArrayBuffer): string {
  const view = new DataView(buffer);
  const len = Math.min(buffer.byteLength, 2048);
  let hexString = '';
  
  for (let i = 0; i < len; i += 16) {
    const offset = i.toString(16).padStart(8, '0');
    let hexParts = '';
    let asciiParts = '';
    
    for (let j = 0; j < 16; j++) {
      if (i + j < len) {
        const val = view.getUint8(i + j);
        hexParts += val.toString(16).padStart(2, '0') + ' ';
        asciiParts += (val >= 32 && val <= 126) ? String.fromCharCode(val) : '.';
      } else {
        hexParts += '   ';
      }
    }
    hexString += `${offset}:  ${hexParts.slice(0, 24)} ${hexParts.slice(24).padEnd(24, ' ')} |${asciiParts.padEnd(16, ' ')}|\n`;
  }
  
  if (buffer.byteLength > len) {
    hexString += `\n... [Capped preview at 2KB, total file size: ${buffer.byteLength} bytes]`;
  }
  return hexString;
}

// ImageJ Helper Functions: LUT color-mapping, ROI calculations, and cropping
const mapLut = (val: number, type: 'grayscale' | 'fire' | 'ice' | 'rainbow' | 'green'): [number, number, number] => {
  const t = val / 255.0;
  if (type === 'grayscale') {
    return [val, val, val];
  } else if (type === 'fire') {
    let r = 0, g = 0, b = 0;
    if (t < 0.33) {
      r = (t / 0.33) * 255;
    } else if (t < 0.66) {
      r = 255;
      g = ((t - 0.33) / 0.33) * 255;
    } else {
      r = 255;
      g = 255;
      b = ((t - 0.66) / 0.34) * 255;
    }
    return [Math.round(r), Math.round(g), Math.round(b)];
  } else if (type === 'ice') {
    let r = 0, g = 0, b = 0;
    if (t < 0.33) {
      b = (t / 0.33) * 255;
    } else if (t < 0.66) {
      g = ((t - 0.33) / 0.33) * 255;
      b = 255;
    } else {
      r = ((t - 0.66) / 0.34) * 255;
      g = 255;
      b = 255;
    }
    return [Math.round(r), Math.round(g), Math.round(b)];
  } else if (type === 'rainbow') {
    const h = (1.0 - t) * 240;
    const s = 1.0;
    const l = t * 0.5 + 0.1;
    const c = (1 - Math.abs(2 * l - 1)) * s;
    const x = c * (1 - Math.abs((h / 60) % 2 - 1));
    const m = l - c / 2;
    let r = 0, g = 0, b = 0;
    if (h >= 0 && h < 60) { r = c; g = x; }
    else if (h >= 60 && h < 120) { r = x; g = c; }
    else if (h >= 120 && h < 180) { g = c; b = x; }
    else if (h >= 180 && h < 240) { g = x; b = c; }
    return [
      Math.round((r + m) * 255),
      Math.round((g + m) * 255),
      Math.round((b + m) * 255)
    ];
  } else if (type === 'green') {
    return [0, val, 0];
  }
  return [val, val, val];
};

const calculateRoiStats = (
  floatData: Float32Array,
  width: number,
  height: number,
  channels: number,
  box: { x1: number, y1: number, x2: number, y2: number }
) => {
  const rx = Math.min(box.x1, box.x2);
  const ry = Math.min(box.y1, box.y2);
  const rw = Math.abs(box.x2 - box.x1) + 1;
  const rh = Math.abs(box.y2 - box.y1) + 1;

  let min = Infinity;
  let max = -Infinity;
  let sum = 0;
  let count = 0;
  const planeSize = width * height;

  for (let c = 0; c < channels; c++) {
    const channelOffset = c * planeSize;
    for (let y = ry; y < ry + rh; y++) {
      if (y < 0 || y >= height) continue;
      const rowStart = y * width + channelOffset;
      for (let x = rx; x < rx + rw; x++) {
        if (x < 0 || x >= width) continue;
        const val = floatData[rowStart + x];
        if (isNaN(val) || !isFinite(val)) continue;
        if (val < min) min = val;
        if (val > max) max = val;
        sum += val;
        count++;
      }
    }
  }

  if (count === 0) return null;
  const mean = sum / count;
  let varianceSum = 0;

  for (let c = 0; c < channels; c++) {
    const channelOffset = c * planeSize;
    for (let y = ry; y < ry + rh; y++) {
      if (y < 0 || y >= height) continue;
      const rowStart = y * width + channelOffset;
      for (let x = rx; x < rx + rw; x++) {
        if (x < 0 || x >= width) continue;
        const val = floatData[rowStart + x];
        if (isNaN(val) || !isFinite(val)) continue;
        varianceSum += (val - mean) ** 2;
      }
    }
  }

  const stdDev = Math.sqrt(varianceSum / count);
  return { min, max, mean, stdDev };
};

const calculateRoiStatsPixels = (
  data: Uint8ClampedArray,
  width: number,
  height: number,
  box: { x1: number, y1: number, x2: number, y2: number }
) => {
  const rx = Math.min(box.x1, box.x2);
  const ry = Math.min(box.y1, box.y2);
  const rw = Math.abs(box.x2 - box.x1) + 1;
  const rh = Math.abs(box.y2 - box.y1) + 1;

  let min = Infinity;
  let max = -Infinity;
  let sum = 0;
  let count = 0;

  for (let y = ry; y < ry + rh; y++) {
    if (y < 0 || y >= height) continue;
    const rowStart = y * width;
    for (let x = rx; x < rx + rw; x++) {
      if (x < 0 || x >= width) continue;
      const idx = (rowStart + x) * 4;
      const val = 0.299 * data[idx] + 0.587 * data[idx + 1] + 0.114 * data[idx + 2];
      if (val < min) min = val;
      if (val > max) max = val;
      sum += val;
      count++;
    }
  }

  if (count === 0) return null;
  const mean = sum / count;
  let varianceSum = 0;

  for (let y = ry; y < ry + rh; y++) {
    if (y < 0 || y >= height) continue;
    const rowStart = y * width;
    for (let x = rx; x < rx + rw; x++) {
      if (x < 0 || x >= width) continue;
      const idx = (rowStart + x) * 4;
      const val = 0.299 * data[idx] + 0.587 * data[idx + 1] + 0.114 * data[idx + 2];
      varianceSum += (val - mean) ** 2;
    }
  }

  const stdDev = Math.sqrt(varianceSum / count);
  return { 
    min: min / 255.0, 
    max: max / 255.0, 
    mean: mean / 255.0, 
    stdDev: stdDev / 255.0 
  };
};

const cropImage = (
  floatData: Float32Array, 
  width: number, 
  height: number, 
  channels: number, 
  roi: { x1: number, y1: number, x2: number, y2: number }
): { floatData: Float32Array, width: number, height: number } => {
  const rx = Math.min(roi.x1, roi.x2);
  const ry = Math.min(roi.y1, roi.y2);
  const rw = Math.abs(roi.x2 - roi.x1) + 1;
  const rh = Math.abs(roi.y2 - roi.y1) + 1;

  const newFloatData = new Float32Array(rw * rh * channels);
  const oldPlaneSize = width * height;
  const newPlaneSize = rw * rh;

  for (let c = 0; c < channels; c++) {
    const oldOffset = c * oldPlaneSize;
    const newOffset = c * newPlaneSize;

    for (let y = 0; y < rh; y++) {
      const oldRowStart = (ry + y) * width + rx + oldOffset;
      const newRowStart = y * rw + newOffset;
      for (let x = 0; x < rw; x++) {
        newFloatData[newRowStart + x] = floatData[oldRowStart + x];
      }
    }
  }
  return { floatData: newFloatData, width: rw, height: rh };
};

const cropImagePixels = (
  data: Uint8ClampedArray,
  width: number,
  roi: { x1: number, y1: number, x2: number, y2: number }
): { data: Uint8ClampedArray, width: number, height: number } => {
  const rx = Math.min(roi.x1, roi.x2);
  const ry = Math.min(roi.y1, roi.y2);
  const rw = Math.abs(roi.x2 - roi.x1) + 1;
  const rh = Math.abs(roi.y2 - roi.y1) + 1;

  const newPixels = new Uint8ClampedArray(rw * rh * 4);
  for (let y = 0; y < rh; y++) {
    for (let x = 0; x < rw; x++) {
      const oldIdx = ((ry + y) * width + (rx + x)) * 4;
      const newIdx = (y * rw + x) * 4;
      newPixels[newIdx] = data[oldIdx];
      newPixels[newIdx + 1] = data[oldIdx + 1];
      newPixels[newIdx + 2] = data[oldIdx + 2];
      newPixels[newIdx + 3] = data[oldIdx + 3];
    }
  }
  return { data: newPixels, width: rw, height: rh };
};

const AstroPreviewer: React.FC<AstroPreviewerProps> = ({
  activeFile, sharedFiles, onSelectFile, onAddFiles, addLog,
  activeTab = 'metadata', subframeFrames = [], subframeMetric = 'fwhm', subframeThresholds = { fwhm: 4.5, eccentricity: 0.65, snrWeight: 40 },
  isPoppedOut = false, onPopOut,
  compareMode = 'none', blinkRate = 500, swipePos = 50, diffBoost = 5, diffMode = 'absolute', profileMode = false, onProfileDataChange, dssImageUrl = null,
  onUpdateFits, livePreviewData = null
}) => {
  const [stretch, setStretch] = useState<'STF' | 'Arcsinh' | 'Linear'>('STF');
  const [channel, setChannel] = useState<'RGB' | 'R' | 'G' | 'B' | 'L'>('RGB');
  
  const [hoverCoords, setHoverCoords] = useState<{ 
    x: number; 
    y: number; 
    val: number | null; 
    rVal?: number; 
    gVal?: number; 
    bVal?: number; 
  }>({ x: 0, y: 0, val: null });
  const [serFrameIndex, setSerFrameIndex] = useState(0);
  
  // Dynamic Zoom scale states: supports 'fit' mode or absolute percentages (e.g. 100, 150)
  const [zoom, setZoom] = useState<number | 'fit'>('fit');

  // Buffer state to store raw pixels of standard JPEGs/PNGs for dynamic channel splitting
  const [imagePixels, setImagePixels] = useState<{ width: number, height: number, data: Uint8ClampedArray } | null>(null);

  const [showOriginal, setShowOriginal] = useState(false);
  const [showFilesList, setShowFilesList] = useState(false);
  const [dssImage, setDssImage] = useState<HTMLImageElement | null>(null);
  const [localProfileLine, setLocalProfileLine] = useState<{ x1: number, y1: number, x2: number, y2: number } | null>(null);
  const [isDrawingProfile, setIsDrawingProfile] = useState(false);

  // ImageJ state hooks
  const [lutMode, setLutMode] = useState<'grayscale' | 'fire' | 'ice' | 'rainbow' | 'green'>('grayscale');
  const [thresholdActive, setThresholdActive] = useState(false);
  const [thresholdMin, setThresholdMin] = useState(128);
  const [thresholdMax, setThresholdMax] = useState(255);
  const [roiMode, setRoiMode] = useState(false);
  const [roi, setRoi] = useState<{ x1: number, y1: number, x2: number, y2: number } | null>(null);
  const [isDrawingRoi, setIsDrawingRoi] = useState(false);
  const [roiStats, setRoiStats] = useState<{ min: number, max: number, mean: number, stdDev: number } | null>(null);

  const handleCropRoi = () => {
    if (!activeFile || !roi) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const width = canvas.width;
    const height = canvas.height;
    
    const rw = Math.abs(roi.x2 - roi.x1) + 1;
    const rh = Math.abs(roi.y2 - roi.y1) + 1;

    if (rw < 2 || rh < 2) {
      addLog('warning', 'Crop area is too small. Select a larger region.');
      return;
    }

    addLog('info', `Cropping image to ROI: ${rw}x${rh} pixels...`);

    if ((activeFile.type === 'fits' || activeFile.type === 'image') && activeFile.parsedFits) {
      const floatData = activeFile.parsedFits.floatData;
      const channels = floatData.length / (width * height);
      const cropped = cropImage(floatData, width, height, channels, roi);
      
      const newParsedFits: FitsParsedData = {
        ...activeFile.parsedFits,
        width: cropped.width,
        height: cropped.height,
        floatData: cropped.floatData,
        headers: activeFile.parsedFits.headers.map(c => {
          if (c.key === 'NAXIS1') return { ...c, value: cropped.width.toString(), raw: `NAXIS1  = ${cropped.width.toString().padEnd(20, ' ')}` };
          if (c.key === 'NAXIS2') return { ...c, value: cropped.height.toString(), raw: `NAXIS2  = ${cropped.height.toString().padEnd(20, ' ')}` };
          return c;
        }),
        rawBuffer: new ArrayBuffer(0)
      };
      
      const newBuffer = writeFits(newParsedFits, newParsedFits.headers);
      newParsedFits.rawBuffer = newBuffer;

      if (onUpdateFits) {
        onUpdateFits(activeFile.id, newParsedFits);
        addLog('success', `Cropped FITS file to ${cropped.width}x${cropped.height}`);
      }
    } else if (activeFile.type === 'image' && imagePixels) {
      const cropped = cropImagePixels(imagePixels.data, width, roi);
      setImagePixels({
        width: cropped.width,
        height: cropped.height,
        data: cropped.data
      });
      addLog('success', `Cropped sRGB image buffer to ${cropped.width}x${cropped.height}`);
    }
    
    setRoi(null);
    setRoiStats(null);
  };

  const [showHistogram, setShowHistogram] = useState(false);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const histCanvasRef = useRef<HTMLCanvasElement>(null);

  const videoUrl = React.useMemo(() => {
    if (activeFile?.type === 'video' && activeFile.fileObject) {
      return URL.createObjectURL(activeFile.fileObject);
    }
    return null;
  }, [activeFile?.id, activeFile?.type]);

  useEffect(() => {
    return () => {
      if (videoUrl) {
        URL.revokeObjectURL(videoUrl);
      }
    };
  }, [videoUrl]);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Blink timer effect
  useEffect(() => {
    if (compareMode !== 'blink' && compareMode !== 'dss') {
      setShowOriginal(false);
      return;
    }
    const interval = setInterval(() => {
      setShowOriginal(prev => !prev);
    }, blinkRate);
    return () => clearInterval(interval);
  }, [compareMode, blinkRate]);

  // Load DSS Image element when URL changes
  useEffect(() => {
    if (!dssImageUrl) {
      setDssImage(null);
      return;
    }
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.src = dssImageUrl;
    img.onload = () => {
      setDssImage(img);
      addLog('success', 'DSS reference image loaded successfully.');
    };
    img.onerror = () => {
      console.error('Failed to load DSS image from url:', dssImageUrl);
      setDssImage(null);
    };
  }, [dssImageUrl, addLog]);

  // Reset local profile line if profileMode is disabled
  useEffect(() => {
    if (!profileMode) {
      setLocalProfileLine(null);
    }
  }, [profileMode]);

  // Histogram drawing effect
  useEffect(() => {
    const hCanvas = histCanvasRef.current;
    if (!hCanvas) return;
    const ctx = hCanvas.getContext('2d');
    if (!ctx) return;

    const W = hCanvas.width;
    const H = hCanvas.height;
    const BINS = W;

    ctx.clearRect(0, 0, W, H);
    if (!showHistogram) return;

    // Determine source data
    let floatData: Float32Array | null = null;
    let imgW = 0, imgH = 0;

    const isLive = livePreviewData?.fileId === activeFile?.id && livePreviewData?.data != null;
    if (isLive) {
      floatData = livePreviewData!.data;
      imgW = activeFile?.parsedFits?.width ?? 0;
      imgH = activeFile?.parsedFits?.height ?? 0;
    } else if ((activeFile?.type === 'fits' || activeFile?.type === 'image') && activeFile.parsedFits) {
      floatData = activeFile.parsedFits.floatData;
      imgW = activeFile.parsedFits.width;
      imgH = activeFile.parsedFits.height;
    }

    ctx.fillStyle = 'rgba(5, 7, 10, 0.88)';
    ctx.fillRect(0, 0, W, H);

    if (!floatData || imgW === 0 || imgH === 0) {
      ctx.strokeStyle = 'rgba(255,255,255,0.08)';
      ctx.strokeRect(0, 0, W, H);
      return;
    }

    const len = imgW * imgH;
    const channels = floatData.length / len;
    const step = Math.max(1, Math.floor(len / 30000));

    const drawCurve = (hist: Float32Array, maxV: number, color: string, fill: boolean) => {
      ctx.beginPath();
      for (let b = 0; b < BINS; b++) {
        const x = b;
        const y = H - 2 - (hist[b] / maxV) * (H - 4);
        if (b === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      }
      if (fill) {
        ctx.lineTo(W, H); ctx.lineTo(0, H); ctx.closePath();
        ctx.fillStyle = color.replace('0.85', '0.12');
        ctx.fill();
      }
      ctx.strokeStyle = color;
      ctx.lineWidth = 1;
      ctx.stroke();
    };

    if (channels >= 3) {
      const hR = new Float32Array(BINS); const hG = new Float32Array(BINS); const hB = new Float32Array(BINS);
      for (let i = 0; i < len; i += step) {
        const r = floatData[i], g = floatData[len + i], b = floatData[len * 2 + i];
        if (r >= 0 && r <= 1) hR[Math.min(BINS - 1, Math.floor(r * BINS))]++;
        if (g >= 0 && g <= 1) hG[Math.min(BINS - 1, Math.floor(g * BINS))]++;
        if (b >= 0 && b <= 1) hB[Math.min(BINS - 1, Math.floor(b * BINS))]++;
      }
      let mv = 1;
      for (let b = 0; b < BINS; b++) mv = Math.max(mv, hR[b], hG[b], hB[b]);
      drawCurve(hR, mv, 'rgba(239,80,80,0.85)', true);
      drawCurve(hG, mv, 'rgba(80,200,80,0.85)', true);
      drawCurve(hB, mv, 'rgba(80,130,239,0.85)', true);
    } else {
      const hMono = new Float32Array(BINS);
      for (let i = 0; i < len; i += step) {
        const v = floatData[i];
        if (v >= 0 && v <= 1) hMono[Math.min(BINS - 1, Math.floor(v * BINS))]++;
      }
      let mv = 1;
      for (let b = 0; b < BINS; b++) mv = Math.max(mv, hMono[b]);
      drawCurve(hMono, mv, 'rgba(200,220,240,0.9)', true);
    }

    ctx.strokeStyle = 'rgba(255,255,255,0.1)';
    ctx.lineWidth = 1;
    ctx.strokeRect(0, 0, W, H);
  }, [showHistogram, activeFile, livePreviewData, stretch, channel]);

  const sampleProfileLine = (
    x1: number, y1: number, x2: number, y2: number,
    floatData: Float32Array, width: number, height: number
  ): number[] => {
    const samples: number[] = [];
    const dx = x2 - x1;
    const dy = y2 - y1;
    const steps = Math.max(Math.abs(dx), Math.abs(dy));
    
    if (steps === 0) {
      const idx = y1 * width + x1;
      const channels = floatData.length / (width * height);
      if (channels >= 3) {
        samples.push(0.299 * floatData[idx] + 0.587 * floatData[width * height + idx] + 0.114 * floatData[width * height * 2 + idx]);
      } else {
        samples.push(floatData[idx]);
      }
      return samples;
    }
    
    const xStep = dx / steps;
    const yStep = dy / steps;
    const planeSize = width * height;
    const channels = floatData.length / planeSize;

    for (let i = 0; i <= steps; i++) {
      const px = Math.round(x1 + xStep * i);
      const py = Math.round(y1 + yStep * i);
      if (px >= 0 && px < width && py >= 0 && py < height) {
        const idx = py * width + px;
        if (channels >= 3) {
          const r = floatData[idx];
          const g = floatData[planeSize + idx];
          const b = floatData[planeSize * 2 + idx];
          samples.push(0.299 * r + 0.587 * g + 0.114 * b);
        } else {
          samples.push(floatData[idx]);
        }
      }
    }
    return samples;
  };

  // Reset states on active file change
  useEffect(() => {
    setZoom(prev => prev === 'fit' ? prev : 'fit');
    setChannel(prev => prev === 'RGB' ? prev : 'RGB');
    setImagePixels(prev => prev === null ? prev : null);
    setSerFrameIndex(prev => prev === 0 ? prev : 0);

    const ext = activeFile?.name.split('.').pop()?.toLowerCase() || '';
    const isNativeImage = ['jpg', 'jpeg', 'png', 'webp', 'gif', 'bmp', 'svg'].includes(ext);
    if (activeFile && activeFile.type === 'image' && isNativeImage) {
      const img = new Image();
      const objectUrl = URL.createObjectURL(activeFile.fileObject);
      img.src = objectUrl;
      img.onload = () => {
        URL.revokeObjectURL(objectUrl);
        const tempCanvas = document.createElement('canvas');
        tempCanvas.width = img.width;
        tempCanvas.height = img.height;
        const tempCtx = tempCanvas.getContext('2d');
        if (tempCtx) {
          tempCtx.drawImage(img, 0, 0);
          const imgData = tempCtx.getImageData(0, 0, img.width, img.height);
          setImagePixels({
            width: img.width,
            height: img.height,
            data: imgData.data
          });
          addLog('info', `Loaded sRGB image buffers for ${activeFile.name}`);
        }
      };
      img.onerror = () => {
        URL.revokeObjectURL(objectUrl);
      };
    }
  }, [activeFile, addLog]);

  // Main rendering loop
  useEffect(() => {
    if (!activeFile) return;

    const canvas = canvasRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    let width = 0;
    let height = 0;
    let pixelBytes: Uint8ClampedArray | null = null;

    if ((activeFile.type === 'fits' || activeFile.type === 'image') && activeFile.parsedFits) {
      width = activeFile.parsedFits.width;
      height = activeFile.parsedFits.height;
      const isLivePreview = livePreviewData?.fileId === activeFile.id && livePreviewData.data != null;
      const floatData = isLivePreview ? livePreviewData!.data : activeFile.parsedFits.floatData;
      
      const channels = floatData.length / (width * height);
      if (channels === 3) {
        const len = width * height;
        pixelBytes = new Uint8ClampedArray(len * 4);
        
        const rData = floatData.subarray(0, len);
        const gData = floatData.subarray(len, len * 2);
        const bData = floatData.subarray(len * 2, len * 3);
        
        const rStats = calculateStats(rData);
        const gStats = calculateStats(gData);
        const bStats = calculateStats(bData);
        
        let rStretched: Uint8ClampedArray;
        let gStretched: Uint8ClampedArray;
        let bStretched: Uint8ClampedArray;
        
        if (stretch === 'STF') {
          rStretched = applySTF(rData, rStats);
          gStretched = applySTF(gData, gStats);
          bStretched = applySTF(bData, bStats);
        } else if (stretch === 'Arcsinh') {
          rStretched = applyArcsinh(rData, rStats);
          gStretched = applyArcsinh(gData, gStats);
          bStretched = applyArcsinh(bData, bStats);
        } else {
          rStretched = applyLinear(rData, rStats);
          gStretched = applyLinear(gData, gStats);
          bStretched = applyLinear(bData, bStats);
        }
        
        for (let i = 0; i < len; i++) {
          const idx = i * 4;
          pixelBytes[idx] = rStretched[idx];         // R
          pixelBytes[idx + 1] = gStretched[idx + 1]; // G
          pixelBytes[idx + 2] = bStretched[idx + 2]; // B
          pixelBytes[idx + 3] = 255;                 // A
        }
      } else {
        const monoData = floatData.subarray(0, width * height);
        const stats = calculateStats(monoData);
        if (stretch === 'STF') {
          pixelBytes = applySTF(monoData, stats);
        } else if (stretch === 'Arcsinh') {
          pixelBytes = applyArcsinh(monoData, stats);
        } else {
          pixelBytes = applyLinear(monoData, stats);
        }
      }
    } 
    else if (activeFile.type === 'ser' && activeFile.parsedSer) {
      width = activeFile.parsedSer.width;
      height = activeFile.parsedSer.height;
      const floatData = extractSerFrame(activeFile.parsedSer, serFrameIndex);
      
      const channels = floatData.length / (width * height);
      if (channels === 3) {
        const len = width * height;
        pixelBytes = new Uint8ClampedArray(len * 4);
        
        const rData = floatData.subarray(0, len);
        const gData = floatData.subarray(len, len * 2);
        const bData = floatData.subarray(len * 2, len * 3);
        
        const rStats = calculateStats(rData);
        const gStats = calculateStats(gData);
        const bStats = calculateStats(bData);
        
        let rStretched: Uint8ClampedArray;
        let gStretched: Uint8ClampedArray;
        let bStretched: Uint8ClampedArray;
        
        if (stretch === 'STF') {
          rStretched = applySTF(rData, rStats);
          gStretched = applySTF(gData, gStats);
          bStretched = applySTF(bData, bStats);
        } else if (stretch === 'Arcsinh') {
          rStretched = applyArcsinh(rData, rStats);
          gStretched = applyArcsinh(gData, gStats);
          bStretched = applyArcsinh(bData, bStats);
        } else {
          rStretched = applyLinear(rData, rStats);
          gStretched = applyLinear(gData, gStats);
          bStretched = applyLinear(bData, bStats);
        }
        
        for (let i = 0; i < len; i++) {
          const idx = i * 4;
          pixelBytes[idx] = rStretched[idx];         // R
          pixelBytes[idx + 1] = gStretched[idx + 1]; // G
          pixelBytes[idx + 2] = bStretched[idx + 2]; // B
          pixelBytes[idx + 3] = 255;                 // A
        }
      } else {
        const monoData = floatData.subarray(0, width * height);
        const stats = calculateStats(monoData);
        if (stretch === 'STF') {
          pixelBytes = applySTF(monoData, stats);
        } else if (stretch === 'Arcsinh') {
          pixelBytes = applyArcsinh(monoData, stats);
        } else {
          pixelBytes = applyLinear(monoData, stats);
        }
      }
    } 
    else if (activeFile.type === 'image' && imagePixels) {
      width = imagePixels.width;
      height = imagePixels.height;
      
      const rawData = imagePixels.data;
      const len = width * height;
      pixelBytes = new Uint8ClampedArray(len * 4);
      
      if (stretch === 'Linear') {
        pixelBytes.set(rawData);
      } else {
        const rData = new Float32Array(len);
        const gData = new Float32Array(len);
        const bData = new Float32Array(len);
        
        for (let i = 0; i < len; i++) {
          const idx = i * 4;
          rData[i] = rawData[idx] / 255.0;
          gData[i] = rawData[idx + 1] / 255.0;
          bData[i] = rawData[idx + 2] / 255.0;
        }
        
        const rStats = calculateStats(rData);
        const gStats = calculateStats(gData);
        const bStats = calculateStats(bData);
        
        let rStretched: Uint8ClampedArray;
        let gStretched: Uint8ClampedArray;
        let bStretched: Uint8ClampedArray;
        
        if (stretch === 'STF') {
          rStretched = applySTF(rData, rStats);
          gStretched = applySTF(gData, gStats);
          bStretched = applySTF(bData, bStats);
        } else {
          rStretched = applyArcsinh(rData, rStats);
          gStretched = applyArcsinh(gData, gStats);
          bStretched = applyArcsinh(bData, bStats);
        }
        
        for (let i = 0; i < len; i++) {
          const idx = i * 4;
          pixelBytes[idx] = rStretched[idx];         // R
          pixelBytes[idx + 1] = gStretched[idx + 1]; // G
          pixelBytes[idx + 2] = bStretched[idx + 2]; // B
          pixelBytes[idx + 3] = rawData[idx + 3];   // A
        }
      }
    }

    if (!pixelBytes || width === 0 || height === 0) return;

    // A. Compute original pixel bytes if comparison is needed
    let originalPixelBytes: Uint8ClampedArray | null = null;
    if (compareMode !== 'none' && activeFile.originalFloatData) {
      const oData = activeFile.originalFloatData;
      const len = width * height;
      const channels = oData.length / len;

      if (channels === 3) {
        originalPixelBytes = new Uint8ClampedArray(len * 4);
        const rData = oData.subarray(0, len);
        const gData = oData.subarray(len, len * 2);
        const bData = oData.subarray(len * 2, len * 3);

        const rStats = calculateStats(rData);
        const gStats = calculateStats(gData);
        const bStats = calculateStats(bData);

        let rStretched: Uint8ClampedArray;
        let gStretched: Uint8ClampedArray;
        let bStretched: Uint8ClampedArray;

        if (stretch === 'STF') {
          rStretched = applySTF(rData, rStats);
          gStretched = applySTF(gData, gStats);
          bStretched = applySTF(bData, bStats);
        } else if (stretch === 'Arcsinh') {
          rStretched = applyArcsinh(rData, rStats);
          gStretched = applyArcsinh(gData, gStats);
          bStretched = applyArcsinh(bData, bStats);
        } else {
          rStretched = applyLinear(rData, rStats);
          gStretched = applyLinear(gData, gStats);
          bStretched = applyLinear(bData, bStats);
        }

        for (let i = 0; i < len; i++) {
          const idx = i * 4;
          originalPixelBytes[idx] = rStretched[idx];
          originalPixelBytes[idx + 1] = gStretched[idx + 1];
          originalPixelBytes[idx + 2] = bStretched[idx + 2];
          originalPixelBytes[idx + 3] = 255;
        }
      } else {
        const monoData = oData.subarray(0, width * height);
        const stats = calculateStats(monoData);
        if (stretch === 'STF') {
          originalPixelBytes = applySTF(monoData, stats);
        } else if (stretch === 'Arcsinh') {
          originalPixelBytes = applyArcsinh(monoData, stats);
        } else {
          originalPixelBytes = applyLinear(monoData, stats);
        }
      }
    }

    canvas.width = width;
    canvas.height = height;

    if (channel !== 'RGB') {
      for (let i = 0; i < width * height; i++) {
        const idx = i * 4;
        let cVal = pixelBytes[idx];
        if (channel === 'G') {
          cVal = pixelBytes[idx + 1];
        } else if (channel === 'B') {
          cVal = pixelBytes[idx + 2];
        } else if (channel === 'L') {
          cVal = Math.round(0.299 * pixelBytes[idx] + 0.587 * pixelBytes[idx + 1] + 0.114 * pixelBytes[idx + 2]);
        }
        
        pixelBytes[idx] = cVal;
        pixelBytes[idx + 1] = cVal;
        pixelBytes[idx + 2] = cVal;
      }

      if (originalPixelBytes) {
        for (let i = 0; i < width * height; i++) {
          const idx = i * 4;
          let cVal = originalPixelBytes[idx];
          if (channel === 'G') {
            cVal = originalPixelBytes[idx + 1];
          } else if (channel === 'B') {
            cVal = originalPixelBytes[idx + 2];
          } else if (channel === 'L') {
            cVal = Math.round(0.299 * originalPixelBytes[idx] + 0.587 * originalPixelBytes[idx + 1] + 0.114 * originalPixelBytes[idx + 2]);
          }
          
          originalPixelBytes[idx] = cVal;
          originalPixelBytes[idx + 1] = cVal;
          originalPixelBytes[idx + 2] = cVal;
        }
      }
    }

    // B. Apply compare modes to pixelBytes
    if (compareMode === 'blink' && showOriginal && originalPixelBytes) {
      const copyBytes = new Uint8ClampedArray(pixelBytes.length);
      copyBytes.set(originalPixelBytes);
      pixelBytes = copyBytes;
    } 
    else if (compareMode === 'swipe' && originalPixelBytes) {
      const len = width * height;
      const blendedBytes = new Uint8ClampedArray(len * 4);
      const splitX = Math.floor(width * (swipePos / 100));

      for (let y = 0; y < height; y++) {
        const rowOffset = y * width;
        for (let x = 0; x < width; x++) {
          const idx = (rowOffset + x) * 4;
          if (x === splitX) {
            blendedBytes[idx] = 0;
            blendedBytes[idx + 1] = 230;
            blendedBytes[idx + 2] = 255;
            blendedBytes[idx + 3] = 255;
          } else if (x < splitX) {
            blendedBytes[idx] = originalPixelBytes[idx];
            blendedBytes[idx + 1] = originalPixelBytes[idx + 1];
            blendedBytes[idx + 2] = originalPixelBytes[idx + 2];
            blendedBytes[idx + 3] = originalPixelBytes[idx + 3];
          } else {
            blendedBytes[idx] = pixelBytes[idx];
            blendedBytes[idx + 1] = pixelBytes[idx + 1];
            blendedBytes[idx + 2] = pixelBytes[idx + 2];
            blendedBytes[idx + 3] = pixelBytes[idx + 3];
          }
        }
      }
      pixelBytes = blendedBytes;
    }
    else if (compareMode === 'difference' && originalPixelBytes) {
      const len = width * height;
      const diffBytes = new Uint8ClampedArray(len * 4);

      for (let i = 0; i < len; i++) {
        const idx = i * 4;
        for (let c = 0; c < 3; c++) {
          const pVal = pixelBytes[idx + c];
          const oVal = originalPixelBytes[idx + c];
          let diff = 0;
          
          if (diffMode === 'absolute') {
            diff = Math.abs(pVal - oVal);
          } else if (diffMode === 'added') {
            diff = Math.max(0, pVal - oVal);
          } else if (diffMode === 'removed') {
            diff = Math.max(0, oVal - pVal);
          }
          
          diffBytes[idx + c] = Math.min(255, Math.max(0, diff * diffBoost));
        }
        diffBytes[idx + 3] = 255;
      }
      pixelBytes = diffBytes;
    }

    // E. Apply LUT and Thresholding to pixelBytes
    if (lutMode !== 'grayscale' || thresholdActive) {
      for (let i = 0; i < width * height; i++) {
        const idx = i * 4;
        const r = pixelBytes[idx];
        const g = pixelBytes[idx + 1];
        const b = pixelBytes[idx + 2];
        const intensity = Math.round(0.299 * r + 0.587 * g + 0.114 * b);
        
        if (thresholdActive && intensity >= thresholdMin && intensity <= thresholdMax) {
          pixelBytes[idx] = 255;
          pixelBytes[idx + 1] = 0;
          pixelBytes[idx + 2] = 0;
        } else if (lutMode !== 'grayscale') {
          const [lr, lg, lb] = mapLut(intensity, lutMode);
          pixelBytes[idx] = lr;
          pixelBytes[idx + 1] = lg;
          pixelBytes[idx + 2] = lb;
        }
      }
    }

    const imgData = ctx.createImageData(width, height);
    imgData.data.set(pixelBytes);
    ctx.putImageData(imgData, 0, 0);

    // C. Draw DSS Overlay if active
    if (compareMode === 'dss' && showOriginal && dssImage) {
      ctx.drawImage(dssImage, 0, 0, width, height);
    }

    // D. Draw profile line overlay
    if (profileMode && localProfileLine) {
      ctx.strokeStyle = '#38bdf8';
      ctx.lineWidth = Math.max(1, Math.round(width / 300));
      ctx.setLineDash([4, 4]);
      ctx.beginPath();
      ctx.moveTo(localProfileLine.x1, localProfileLine.y1);
      ctx.lineTo(localProfileLine.x2, localProfileLine.y2);
      ctx.stroke();
      ctx.setLineDash([]);

      ctx.fillStyle = '#f472b6';
      ctx.beginPath();
      ctx.arc(localProfileLine.x1, localProfileLine.y1, Math.max(3, Math.round(width / 150)), 0, Math.PI * 2);
      ctx.arc(localProfileLine.x2, localProfileLine.y2, Math.max(3, Math.round(width / 150)), 0, Math.PI * 2);
      ctx.fill();
    }

    // F. Draw ROI bounding box overlay
    if (roiMode && roi) {
      ctx.strokeStyle = '#a855f7'; // purple
      ctx.lineWidth = Math.max(1.5, Math.round(width / 300));
      const rx = Math.min(roi.x1, roi.x2);
      const ry = Math.min(roi.y1, roi.y2);
      const rw = Math.abs(roi.x2 - roi.x1);
      const rh = Math.abs(roi.y2 - roi.y1);
      ctx.strokeRect(rx, ry, rw, rh);
      
      ctx.fillStyle = '#c084fc';
      const cornerSize = Math.max(4, Math.round(width / 150));
      ctx.fillRect(rx - cornerSize / 2, ry - cornerSize / 2, cornerSize, cornerSize);
      ctx.fillRect(rx + rw - cornerSize / 2, ry - cornerSize / 2, cornerSize, cornerSize);
      ctx.fillRect(rx - cornerSize / 2, ry + rh - cornerSize / 2, cornerSize, cornerSize);
      ctx.fillRect(rx + rw - cornerSize / 2, ry + rh - cornerSize / 2, cornerSize, cornerSize);
    }

  }, [activeFile, stretch, channel, serFrameIndex, imagePixels, compareMode, blinkRate, swipePos, diffBoost, diffMode, dssImageUrl, showOriginal, dssImage, localProfileLine, profileMode, lutMode, thresholdActive, thresholdMin, thresholdMax, roiMode, roi, livePreviewData]);

  const handleMouseDown = (e: React.MouseEvent<HTMLCanvasElement>) => {
    if (!activeFile) return;
    const canvas = canvasRef.current;
    if (!canvas) return;

    const rect = canvas.getBoundingClientRect();
    const scaleX = canvas.width / rect.width;
    const scaleY = canvas.height / rect.height;

    const x = Math.floor((e.clientX - rect.left) * scaleX);
    const y = Math.floor((e.clientY - rect.top) * scaleY);

    if (x >= 0 && x < canvas.width && y >= 0 && y < canvas.height) {
      if (profileMode) {
        setLocalProfileLine({ x1: x, y1: y, x2: x, y2: y });
        setIsDrawingProfile(true);
      } else if (roiMode) {
        setRoi({ x1: x, y1: y, x2: x, y2: y });
        setIsDrawingRoi(true);
        setRoiStats(null);
      }
    }
  };

  const handleMouseMoveCanvas = (e: React.MouseEvent<HTMLCanvasElement>) => {
    handleMouseMove(e);

    if (profileMode && isDrawingProfile && localProfileLine && activeFile) {
      const canvas = canvasRef.current;
      if (!canvas) return;

      const rect = canvas.getBoundingClientRect();
      const scaleX = canvas.width / rect.width;
      const scaleY = canvas.height / rect.height;

      const x = Math.floor((e.clientX - rect.left) * scaleX);
      const y = Math.floor((e.clientY - rect.top) * scaleY);

      const nx = Math.max(0, Math.min(canvas.width - 1, x));
      const ny = Math.max(0, Math.min(canvas.height - 1, y));

      setLocalProfileLine(prev => prev ? { ...prev, x2: nx, y2: ny } : null);
    } else if (roiMode && isDrawingRoi && roi && activeFile) {
      const canvas = canvasRef.current;
      if (!canvas) return;

      const rect = canvas.getBoundingClientRect();
      const scaleX = canvas.width / rect.width;
      const scaleY = canvas.height / rect.height;

      const x = Math.floor((e.clientX - rect.left) * scaleX);
      const y = Math.floor((e.clientY - rect.top) * scaleY);

      const nx = Math.max(0, Math.min(canvas.width - 1, x));
      const ny = Math.max(0, Math.min(canvas.height - 1, y));

      setRoi(prev => prev ? { ...prev, x2: nx, y2: ny } : null);
      
      const width = canvas.width;
      const height = canvas.height;
      const tempRoi = { x1: roi.x1, y1: roi.y1, x2: nx, y2: ny };
      
      if ((activeFile.type === 'fits' || activeFile.type === 'image') && activeFile.parsedFits) {
        const floatData = activeFile.parsedFits.floatData;
        const channels = floatData.length / (width * height);
        const stats = calculateRoiStats(floatData, width, height, channels, tempRoi);
        setRoiStats(stats);
      } else if (activeFile.type === 'image' && imagePixels) {
        const stats = calculateRoiStatsPixels(imagePixels.data, width, height, tempRoi);
        setRoiStats(stats);
      }
    }
  };

  const handleMouseUp = () => {
    if (activeFile && profileMode && isDrawingProfile && localProfileLine) {
      setIsDrawingProfile(false);
      
      const width = activeFile.parsedFits?.width || activeFile.parsedSer?.width || imagePixels?.width || 0;
      const height = activeFile.parsedFits?.height || activeFile.parsedSer?.height || imagePixels?.height || 0;
      
      if (width > 0 && height > 0) {
        const processedData = activeFile.parsedFits?.floatData;
        const originalData = activeFile.originalFloatData;
        
        if (processedData && originalData) {
          const processedSamples = sampleProfileLine(
            localProfileLine.x1, localProfileLine.y1, localProfileLine.x2, localProfileLine.y2,
            processedData, width, height
          );
          const originalSamples = sampleProfileLine(
            localProfileLine.x1, localProfileLine.y1, localProfileLine.x2, localProfileLine.y2,
            originalData, width, height
          );
          
          if (onProfileDataChange) {
            onProfileDataChange(originalSamples, processedSamples);
          }
        }
      }
    } else if (activeFile && roiMode && isDrawingRoi && roi) {
      setIsDrawingRoi(false);
      const canvas = canvasRef.current;
      if (!canvas) return;
      const width = canvas.width;
      const height = canvas.height;
      
      if (width > 0 && height > 0) {
        if ((activeFile.type === 'fits' || activeFile.type === 'image') && activeFile.parsedFits) {
          const floatData = activeFile.parsedFits.floatData;
          const channels = floatData.length / (width * height);
          const stats = calculateRoiStats(floatData, width, height, channels, roi);
          setRoiStats(stats);
        } else if (activeFile.type === 'image' && imagePixels) {
          const stats = calculateRoiStatsPixels(imagePixels.data, width, height, roi);
          setRoiStats(stats);
        }
      }
    }
  };

  const handleMouseMove = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    if (!canvas || !activeFile) return;

    const rect = canvas.getBoundingClientRect();
    const scaleX = canvas.width / rect.width;
    const scaleY = canvas.height / rect.height;

    const x = Math.floor((e.clientX - rect.left) * scaleX);
    const y = Math.floor((e.clientY - rect.top) * scaleY);

    if (x >= 0 && x < canvas.width && y >= 0 && y < canvas.height) {
      let val: number | null = null;
      let rVal: number | undefined;
      let gVal: number | undefined;
      let bVal: number | undefined;

      if ((activeFile.type === 'fits' || activeFile.type === 'image') && activeFile.parsedFits) {
        const floatData = activeFile.parsedFits.floatData;
        const len = canvas.width * canvas.height;
        const channels = floatData.length / len;
        if (channels === 3) {
          rVal = floatData[y * canvas.width + x];
          gVal = floatData[len + y * canvas.width + x];
          bVal = floatData[len * 2 + y * canvas.width + x];
          val = 0.299 * rVal + 0.587 * gVal + 0.114 * bVal;
        } else {
          val = floatData[y * canvas.width + x];
        }
      } else if (activeFile.type === 'ser' && activeFile.parsedSer) {
        const frameData = extractSerFrame(activeFile.parsedSer, serFrameIndex);
        val = frameData[y * canvas.width + x];
      } else if (activeFile.type === 'image' && imagePixels) {
        const idx = (y * canvas.width + x) * 4;
        rVal = imagePixels.data[idx] / 255.0;
        gVal = imagePixels.data[idx + 1] / 255.0;
        bVal = imagePixels.data[idx + 2] / 255.0;
        val = 0.299 * rVal + 0.587 * gVal + 0.114 * bVal;
      }
      setHoverCoords({ x, y, val, rVal, gVal, bVal });
    }
  };

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    if (e.dataTransfer.files && e.dataTransfer.files[0]) {
      onAddFiles(Array.from(e.dataTransfer.files));
    }
  };

  // Zoom Handler functions
  const handleZoomIn = () => {
    setZoom(prev => {
      if (prev === 'fit') return 120;
      return Math.min(800, prev + 20);
    });
  };

  const handleZoomOut = () => {
    setZoom(prev => {
      if (prev === 'fit') return 80;
      return Math.max(10, prev - 20);
    });
  };

  const isSupportedGraphic = activeFile && (activeFile.type === 'fits' || activeFile.type === 'ser' || activeFile.type === 'image');

  const getRawDimensions = () => {
    if (activeFile) {
      if (activeFile.type === 'fits' && activeFile.parsedFits) {
        return { width: activeFile.parsedFits.width, height: activeFile.parsedFits.height };
      }
      if (activeFile.type === 'ser' && activeFile.parsedSer) {
        return { width: activeFile.parsedSer.width, height: activeFile.parsedSer.height };
      }
      if (activeFile.type === 'image' && imagePixels) {
        return { width: imagePixels.width, height: imagePixels.height };
      }
    }
    return null;
  };

  const dims = getRawDimensions();
  const containerStyle: React.CSSProperties = {
    flex: 1, 
    backgroundColor: '#05070a', 
    borderRadius: '8px', 
    border: '1px solid var(--border)', 
    overflow: zoom === 'fit' ? 'hidden' : 'auto', 
    position: 'relative',
    display: 'flex',
    padding: zoom === 'fit' ? '0' : '2rem'
  };

  const graphicStyle: React.CSSProperties = zoom === 'fit' ? {
    maxWidth: '100%',
    maxHeight: '100%',
    width: 'auto',
    height: 'auto',
    objectFit: 'contain',
    boxShadow: '0 0 20px rgba(0,0,0,0.8)',
    flexShrink: 0,
    margin: 'auto'
  } : {
    width: dims ? `${(dims.width * zoom) / 100}px` : `${zoom}%`,
    height: dims ? `${(dims.height * zoom) / 100}px` : 'auto',
    maxWidth: 'none',
    maxHeight: 'none',
    boxShadow: '0 0 20px rgba(0,0,0,0.8)',
    flexShrink: 0,
    margin: 'auto',
    transition: 'width 0.1s ease, height 0.1s ease'
  };

  if (activeTab === 'subframes') {
    const frames = subframeFrames;
    const metric = subframeMetric;
    const thresholds = subframeThresholds;

    const evaluatedFrames = frames.map(f => {
      let isRejected = false;
      if (f.fwhm > thresholds.fwhm) isRejected = true;
      if (f.eccentricity > thresholds.eccentricity) isRejected = true;
      if (f.snrWeight < thresholds.snrWeight) isRejected = true;
      return { ...f, rejected: isRejected };
    });

    const chartWidth = 900;
    const chartHeight = 250;
    const padding = { top: 20, right: 20, bottom: 40, left: 50 };
    const innerWidth = chartWidth - padding.left - padding.right;
    const innerHeight = chartHeight - padding.top - padding.bottom;

    const getScale = () => {
      let min = 0;
      let max = 100;
      if (metric === 'fwhm') { min = 1.0; max = 7.0; }
      if (metric === 'eccentricity') { min = 0.0; max = 1.0; }
      if (metric === 'snrWeight') { min = 0; max = 100; }
      return { min, max };
    };

    const { min: yMin, max: yMax } = getScale();
    const getX = (index: number) => padding.left + (index / Math.max(1, evaluatedFrames.length - 1)) * innerWidth;
    const getY = (value: number) => {
      const clamped = Math.max(yMin, Math.min(yMax, value));
      const ratio = (clamped - yMin) / (yMax - yMin);
      return padding.top + innerHeight - (ratio * innerHeight);
    };

    const thresholdY = getY(thresholds[metric]);
    const metricLabels = {
      fwhm: { label: 'FWHM (arcsec)' },
      eccentricity: { label: 'Eccentricity' },
      snrWeight: { label: 'SNR Weight' }
    };

    return (
      <div style={{ display: 'flex', flexDirection: 'column', height: '100%', gap: '1rem', overflowY: 'auto' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <h2 style={{ fontSize: '1.25rem', fontWeight: 600, display: 'flex', alignItems: 'center', gap: '0.5rem', margin: 0 }}>
            <Target size={20} color="var(--accent-blue)" />
            Subframe Selector Distribution Plot
          </h2>
          <span style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>Analyzing {evaluatedFrames.length} frames</span>
        </div>

        {evaluatedFrames.length === 0 ? (
          <div style={{ flex: 1, display: 'flex', justifyContent: 'center', alignItems: 'center', border: '1.5px dashed var(--border)', borderRadius: '8px', color: 'var(--text-muted)', padding: '2rem' }}>
            No FITS subframes analyzed yet. Please calculate metrics via the sidebar controls.
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem', flex: 1 }}>
            
            {/* Chart Card */}
            <div style={{ backgroundColor: 'var(--bg-panel)', borderRadius: '8px', border: '1px solid var(--border)', padding: '1rem' }}>
              <div style={{ width: '100%', overflowX: 'auto', backgroundColor: '#07090e', borderRadius: '6px', padding: '0.5rem' }}>
                <svg width="100%" height={chartHeight} viewBox={`0 0 ${chartWidth} ${chartHeight}`} preserveAspectRatio="xMidYMid meet" style={{ display: 'block', margin: 'auto' }}>
                  {/* Axes */}
                  <line x1={padding.left} y1={padding.top} x2={padding.left} y2={chartHeight - padding.bottom} stroke="var(--border)" strokeWidth="2" />
                  <line x1={padding.left} y1={chartHeight - padding.bottom} x2={chartWidth - padding.right} y2={chartHeight - padding.bottom} stroke="var(--border)" strokeWidth="2" />
                  
                  {/* Y-Axis Labels */}
                  <text x={padding.left - 10} y={padding.top + 5} fill="var(--text-muted)" fontSize="11" textAnchor="end">{yMax}</text>
                  <text x={padding.left - 10} y={chartHeight - padding.bottom + 5} fill="var(--text-muted)" fontSize="11" textAnchor="end">{yMin}</text>
                  <text x={padding.left - 10} y={padding.top + innerHeight/2 + 5} fill="var(--text-muted)" fontSize="11" textAnchor="end">{((yMax+yMin)/2).toFixed(1)}</text>
                  
                  {/* Threshold Line */}
                  <line 
                    x1={padding.left} 
                    y1={thresholdY} 
                    x2={chartWidth - padding.right} 
                    y2={thresholdY} 
                    stroke="var(--danger)" 
                    strokeWidth="1.5" 
                    strokeDasharray="4 4" 
                  />
                  
                  {/* Data Points */}
                  {evaluatedFrames.map((frame, i) => {
                    const cx = getX(i);
                    const cy = getY(frame[metric]);
                    let isPointRejected = frame.rejected;

                    return (
                      <g key={frame.id}>
                        {i > 0 && (
                          <line 
                            x1={getX(i-1)} y1={getY(evaluatedFrames[i-1][metric])} 
                            x2={cx} y2={cy} 
                            stroke={isPointRejected ? "rgba(239, 68, 68, 0.4)" : "rgba(56, 189, 248, 0.5)"} 
                            strokeWidth="1.5"
                          />
                        )}
                        <circle 
                          cx={cx} 
                          cy={cy} 
                          r="4.5" 
                          fill={isPointRejected ? "var(--danger)" : "var(--accent-blue)"} 
                          style={{ cursor: 'pointer' }}
                          onClick={() => {
                            const matched = sharedFiles.find(sf => sf.name === frame.name);
                            if (matched) {
                              onSelectFile(matched.id);
                              addLog('info', `Selected frame for inspection: ${frame.name}`);
                            }
                          }}
                        >
                          <title>{`${frame.name}\n${metricLabels[metric].label}: ${frame[metric].toFixed(3)}\nStatus: ${isPointRejected ? 'Rejected' : 'Approved'}`}</title>
                        </circle>
                      </g>
                    );
                  })}
                </svg>
              </div>
              <div style={{ display: 'flex', justifyContent: 'center', marginTop: '0.4rem', fontSize: '0.7rem', color: 'var(--text-muted)', fontStyle: 'italic' }}>
                Frame Index (Capture Sequence)
              </div>
            </div>

            {/* Table Card */}
            <div style={{ backgroundColor: 'var(--bg-panel)', borderRadius: '8px', border: '1px solid var(--border)', display: 'flex', flexDirection: 'column', overflow: 'hidden', flex: 1 }}>
              <div style={{ padding: '0.5rem 1rem', borderBottom: '1px solid var(--border)', backgroundColor: 'var(--bg-deep)', fontSize: '0.75rem', fontWeight: 700, textTransform: 'uppercase', color: 'var(--text-muted)' }}>
                Frame Metrics Log Table
              </div>
              <div style={{ overflowY: 'auto', maxHeight: '250px' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.8rem', textAlign: 'left' }}>
                  <thead style={{ position: 'sticky', top: 0, backgroundColor: 'var(--bg-panel)', zIndex: 1 }}>
                    <tr style={{ color: 'var(--text-muted)', borderBottom: '1px solid var(--border)' }}>
                      <th style={{ padding: '0.5rem 0.75rem' }}>ID</th>
                      <th style={{ padding: '0.5rem 0.75rem' }}>Filename</th>
                      <th style={{ padding: '0.5rem 0.75rem' }}>FWHM (arcsec)</th>
                      <th style={{ padding: '0.5rem 0.75rem' }}>Eccentricity</th>
                      <th style={{ padding: '0.5rem 0.75rem' }}>SNR Weight</th>
                      <th style={{ padding: '0.5rem 0.75rem' }}>Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {evaluatedFrames.map(f => (
                      <tr 
                        key={f.id} 
                        onClick={() => {
                          const matched = sharedFiles.find(sf => sf.name === f.name);
                          if (matched) {
                            onSelectFile(matched.id);
                            addLog('info', `Selected frame for inspection: ${f.name}`);
                          }
                        }}
                        style={{ 
                          borderBottom: '1px solid var(--border)', 
                          backgroundColor: f.rejected ? 'rgba(239,68,68,0.02)' : 'transparent',
                          cursor: 'pointer' 
                        }}
                        title="Click to inspect this frame"
                      >
                        <td style={{ padding: '0.5rem 0.75rem', fontFamily: 'var(--font-mono)' }}>{f.id}</td>
                        <td style={{ padding: '0.5rem 0.75rem', fontFamily: 'var(--font-mono)', fontWeight: 600 }}>{f.name}</td>
                        <td style={{ padding: '0.5rem 0.75rem', fontFamily: 'var(--font-mono)', color: f.fwhm > thresholds.fwhm ? 'var(--danger)' : 'var(--success)' }}>{f.fwhm.toFixed(3)}</td>
                        <td style={{ padding: '0.5rem 0.75rem', fontFamily: 'var(--font-mono)', color: f.eccentricity > thresholds.eccentricity ? 'var(--danger)' : 'var(--success)' }}>{f.eccentricity.toFixed(3)}</td>
                        <td style={{ padding: '0.5rem 0.75rem', fontFamily: 'var(--font-mono)', color: f.snrWeight < thresholds.snrWeight ? 'var(--danger)' : 'var(--success)' }}>{f.snrWeight.toFixed(2)}</td>
                        <td style={{ padding: '0.5rem 0.75rem' }}>
                          {f.rejected ? (
                            <span style={{ display: 'inline-flex', alignItems: 'center', gap: '0.2rem', color: 'var(--danger)', fontSize: '0.7rem', fontWeight: 700, padding: '0.1rem 0.3rem', backgroundColor: 'rgba(239, 68, 68, 0.08)', borderRadius: '4px' }}>
                              <AlertCircle size={10} /> Rejected
                            </span>
                          ) : (
                            <span style={{ display: 'inline-flex', alignItems: 'center', gap: '0.2rem', color: 'var(--success)', fontSize: '0.7rem', fontWeight: 700, padding: '0.1rem 0.3rem', backgroundColor: 'rgba(16, 185, 129, 0.08)', borderRadius: '4px' }}>
                              <CheckCircle size={10} /> Approved
                            </span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        )}
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', gap: '0.75rem' }} onDragOver={handleDragOver} onDrop={handleDrop}>
      <div style={{ display: 'flex', flex: 1, gap: '0.75rem', overflow: 'hidden', minHeight: 0 }}>
        {/* Workspace Files List */}
        {showFilesList && (
          <div style={{ width: '220px', backgroundColor: 'var(--bg-panel)', borderRadius: '8px', border: '1px solid var(--border)', display: 'flex', flexDirection: 'column', flexShrink: 0 }}>
            <div style={{ padding: '0.5rem 0.75rem', borderBottom: '1px solid var(--border)', fontSize: '0.8rem', fontWeight: 600, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <span>Workspace Files</span>
              <button onClick={() => setShowFilesList(false)} style={{ background: 'transparent', border: 'none', color: 'var(--text-muted)', cursor: 'pointer', fontSize: '0.8rem' }}>✕</button>
            </div>
            <div style={{ overflowY: 'auto', flex: 1, padding: '0.35rem' }}>
              {sharedFiles.map(file => (
                <div 
                  key={file.id} 
                  onClick={() => onSelectFile(file.id)}
                  style={{ 
                    display: 'flex', alignItems: 'center', gap: '0.4rem', padding: '0.5rem 0.6rem', 
                    borderRadius: '4px', cursor: 'pointer', marginBottom: '0.2rem',
                    backgroundColor: activeFile?.id === file.id ? 'var(--bg-panel-light)' : 'transparent',
                    borderLeft: activeFile?.id === file.id ? '3px solid var(--accent-blue)' : '3px solid transparent'
                  }}
                >
                  <FileText size={14} color="var(--text-muted)" style={{ flexShrink: 0 }} />
                  <span style={{ fontSize: '0.75rem', fontFamily: 'var(--font-mono)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{file.name}</span>
                </div>
              ))}
              {sharedFiles.length === 0 && (
                <div 
                  onClick={() => fileInputRef.current?.click()}
                  style={{ textAlign: 'center', color: 'var(--text-muted)', marginTop: '2rem', fontSize: '0.75rem', cursor: 'pointer' }}
                >
                  Click to select files
                </div>
              )}
            </div>
          </div>
        )}

        <div style={{ display: 'flex', flexDirection: 'column', flex: 1, minWidth: 0, borderRadius: '8px', border: '1px solid var(--border)', overflow: 'hidden', backgroundColor: '#05070a', position: 'relative' }}>
          
          {/* ImageJ Interactive Tools Toolbar */}
          {isSupportedGraphic && (
            <div style={{ 
              height: '38px', 
              backgroundColor: 'var(--bg-deep)', 
              borderBottom: '1px solid var(--border)', 
              display: 'flex', 
              alignItems: 'center', 
              padding: '0 0.75rem', 
              fontSize: '0.72rem', 
              justifyContent: 'space-between',
              gap: '1rem',
              zIndex: 10,
              flexShrink: 0
            }}>
              {/* Left: LUT Mode, Threshold controls */}
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
                <span style={{ fontWeight: 700, color: 'var(--accent-purple)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>ImageJ Tools:</span>

                {/* LUT selector */}
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.3rem' }}>
                  <span style={{ color: 'var(--text-muted)' }}>LUT:</span>
                  <select
                    value={lutMode}
                    onChange={(e) => setLutMode(e.target.value as any)}
                    className="input-select"
                    style={{ padding: '0.15rem 0.4rem', fontSize: '0.7rem', width: '90px', backgroundColor: 'var(--bg-panel-light)' }}
                  >
                    <option value="grayscale">Grayscale</option>
                    <option value="fire">Fire</option>
                    <option value="ice">Ice</option>
                    <option value="rainbow">Rainbow</option>
                    <option value="green">Green (Night)</option>
                  </select>
                </div>

                <div style={{ width: '1px', height: '14px', backgroundColor: 'var(--border)' }}></div>

                {/* Thresholding */}
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
                  <label className="input-checkbox-container" style={{ gap: '0.25rem' }}>
                    <input 
                      type="checkbox" 
                      checked={thresholdActive} 
                      onChange={(e) => setThresholdActive(e.target.checked)} 
                    />
                    <span style={{ fontWeight: 600, color: thresholdActive ? 'var(--accent-blue)' : 'var(--text-muted)' }}>Threshold</span>
                  </label>

                  {thresholdActive && (
                    <div style={{ display: 'flex', alignItems: 'center', gap: '0.3rem', marginLeft: '0.2rem' }}>
                      <span style={{ color: 'var(--text-muted)', fontFamily: 'var(--font-mono)' }}>Min:</span>
                      <input 
                        type="range" 
                        min={0} 
                        max={255} 
                        value={thresholdMin} 
                        onChange={(e) => setThresholdMin(parseInt(e.target.value))} 
                        style={{ width: '60px', cursor: 'pointer' }}
                      />
                      <span style={{ color: 'var(--accent-blue)', fontFamily: 'var(--font-mono)', minWidth: '22px' }}>{thresholdMin}</span>
                      
                      <span style={{ color: 'var(--text-muted)', fontFamily: 'var(--font-mono)' }}>Max:</span>
                      <input 
                        type="range" 
                        min={0} 
                        max={255} 
                        value={thresholdMax} 
                        onChange={(e) => setThresholdMax(parseInt(e.target.value))} 
                        style={{ width: '60px', cursor: 'pointer' }}
                      />
                      <span style={{ color: 'var(--accent-blue)', fontFamily: 'var(--font-mono)', minWidth: '22px' }}>{thresholdMax}</span>
                    </div>
                  )}
                </div>
              </div>

              {/* Right: ROI crop controls */}
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
                <label className="input-checkbox-container" style={{ gap: '0.25rem' }}>
                  <input 
                    type="checkbox" 
                    checked={roiMode} 
                    onChange={(e) => {
                      setRoiMode(e.target.checked);
                      if (!e.target.checked) {
                        setRoi(null);
                        setRoiStats(null);
                      }
                    }} 
                  />
                  <span style={{ fontWeight: 600, color: roiMode ? 'var(--accent-blue)' : 'var(--text-muted)' }}>ROI Crop Mode</span>
                </label>

                {roiMode && roi && (
                  <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                    <div style={{ display: 'flex', gap: '0.4rem', color: 'var(--text-muted)', fontSize: '0.7rem', backgroundColor: 'var(--bg-panel-light)', padding: '0.15rem 0.4rem', borderRadius: '4px', border: '1px solid var(--border)' }}>
                      <span>Size: <strong style={{ color: 'var(--accent-blue)' }}>{Math.abs(roi.x2 - roi.x1) + 1}x{Math.abs(roi.y2 - roi.y1) + 1}</strong></span>
                      {roiStats && (
                        <>
                          <span>| Mean: <strong style={{ color: 'var(--success)' }}>{roiStats.mean.toFixed(3)}</strong></span>
                          <span>| Std: <strong style={{ color: 'var(--accent-purple)' }}>{roiStats.stdDev.toFixed(3)}</strong></span>
                        </>
                      )}
                    </div>
                    <button
                      onClick={handleCropRoi}
                      className="btn-primary"
                      style={{ padding: '0.15rem 0.5rem', fontSize: '0.7rem', border: 'none', borderRadius: '4px' }}
                    >
                      Crop Image
                    </button>
                  </div>
                )}
              </div>
            </div>
          )}

          {/* Canvas Area */}
          <div ref={containerRef} style={{ ...containerStyle, border: 'none', borderRadius: 0 }}>
            {activeFile ? (
              isSupportedGraphic ? (
                <canvas 
                  ref={canvasRef} 
                  onMouseDown={handleMouseDown}
                  onMouseMove={handleMouseMoveCanvas}
                  onMouseUp={handleMouseUp}
                  onMouseLeave={handleMouseUp}
                  style={{ 
                    ...graphicStyle,
                    cursor: (profileMode || roiMode) ? 'crosshair' : 'default'
                  }} 
                />
              ) : activeFile.type === 'video' ? (
                <video 
                  src={videoUrl || ''}
                  controls
                  autoPlay
                  loop
                  style={{ 
                    ...graphicStyle,
                    objectFit: 'contain'
                  }}
                />
              ) : isTextFile(activeFile.name, activeFile.data) ? (
                <pre style={{ width: '100%', height: '100%', overflow: 'auto', padding: '1.5rem', fontFamily: 'var(--font-mono)', fontSize: '0.85rem', color: 'var(--text-main)', textAlign: 'left', margin: 0 }}>
                  {new TextDecoder('utf-8').decode(new Uint8Array(activeFile.data, 0, Math.min(activeFile.data.byteLength, 10000)))}
                  {activeFile.data.byteLength > 10000 && "\n... [Preview truncated to 10KB]"}
                </pre>
              ) : (
                <pre style={{ width: '100%', height: '100%', overflow: 'auto', padding: '1.5rem', fontFamily: 'var(--font-mono)', fontSize: '0.85rem', color: 'var(--text-muted)', textAlign: 'left', margin: 0, lineHeight: '1.3' }}>
                  {renderHexDump(activeFile.data)}
                </pre>
              )
            ) : (
              <div 
                onClick={() => fileInputRef.current?.click()}
                style={{ display: 'flex', flexDirection: 'column', justifyContent: 'center', alignItems: 'center', width: '100%', height: '100%', color: 'var(--text-muted)', margin: 'auto', cursor: 'pointer' }}
              >
                <Upload size={32} style={{ marginBottom: '0.5rem' }} />
                <h3>Drag & Drop Files Here or Click to Select</h3>
              </div>
            )}

            {/* Histogram overlay */}
            {showHistogram && isSupportedGraphic && (
              <div style={{ position: 'absolute', bottom: '0.6rem', left: '0.6rem', zIndex: 6, borderRadius: '4px', overflow: 'hidden', boxShadow: '0 2px 12px rgba(0,0,0,0.7)' }}>
                <canvas ref={histCanvasRef} width={220} height={80} style={{ display: 'block' }} />
              </div>
            )}
            {/* invisible canvas kept in DOM so ref is always valid */}
            {!showHistogram && <canvas ref={histCanvasRef} width={220} height={80} style={{ display: 'none' }} />}

            {/* SER playback slider */}
            {activeFile?.type === 'ser' && activeFile.parsedSer && (
              <div style={{ position: 'absolute', bottom: '4rem', left: '50%', transform: 'translateX(-50%)', backgroundColor: 'rgba(21, 24, 33, 0.9)', padding: '0.5rem 1rem', borderRadius: '8px', border: '1px solid var(--border)', display: 'flex', alignItems: 'center', gap: '1rem', width: '80%', zIndex: 5 }}>
                <span style={{ fontSize: '0.8rem', whiteSpace: 'nowrap' }}>Frame: {serFrameIndex + 1} / {activeFile.parsedSer.frameCount}</span>
                <input 
                  type="range" 
                  min={0} 
                  max={activeFile.parsedSer.frameCount - 1} 
                  value={serFrameIndex} 
                  onChange={(e) => setSerFrameIndex(parseInt(e.target.value))} 
                  style={{ flex: 1, cursor: 'pointer' }}
                />
              </div>
            )}
          </div>

          {/* Bottom Siril-style control strip */}
          <div style={{ 
            height: '38px', 
            backgroundColor: 'var(--bg-panel)', 
            borderTop: '1px solid var(--border)', 
            display: 'flex', 
            alignItems: 'center', 
            justifyContent: 'space-between', 
            padding: '0 0.75rem', 
            flexShrink: 0,
            fontSize: '0.75rem',
            userSelect: 'none',
            gap: '1rem',
            zIndex: 10
          }}>
            {/* Left side: Files Toggle, Active File name, Zoom Info */}
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', minWidth: 0 }}>
              <button 
                onClick={() => setShowFilesList(prev => !prev)}
                style={{
                  display: 'flex', alignItems: 'center', gap: '0.3rem', padding: '0.25rem 0.5rem',
                  backgroundColor: showFilesList ? 'rgba(6, 182, 212, 0.12)' : 'var(--bg-panel-light)',
                  border: '1px solid var(--border)', color: showFilesList ? 'var(--accent-blue)' : 'var(--text-main)',
                  borderRadius: '4px', cursor: 'pointer', fontSize: '0.75rem', fontWeight: 600, flexShrink: 0
                }}
                title="Toggle Workspace Files List"
              >
                <FolderOpen size={12} />
                <span>Files</span>
              </button>

              <div style={{ width: '1px', height: '16px', backgroundColor: 'var(--border)', flexShrink: 0 }}></div>

              {activeFile && (
                <span style={{
                  color: 'var(--text-main)',
                  fontFamily: 'var(--font-mono)',
                  fontWeight: 600,
                  fontSize: '0.75rem',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap'
                }} title={activeFile.name}>
                  {activeFile.name} <span style={{ color: 'var(--accent-blue)', fontWeight: 500 }}>({zoom === 'fit' ? 'Fit' : `${zoom}%`})</span>
                </span>
              )}
              {livePreviewData?.fileId === activeFile?.id && (
                <span style={{
                  fontSize: '0.62rem', fontWeight: 700, letterSpacing: '0.07em',
                  color: '#f59e0b', backgroundColor: 'rgba(245, 158, 11, 0.12)',
                  border: '1px solid rgba(245, 158, 11, 0.35)',
                  borderRadius: '3px', padding: '0.1rem 0.35rem', flexShrink: 0
                }}>PREVIEW</span>
              )}
            </div>

            {/* Middle side: Stretching, Channels, Zoom buttons */}
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', flexShrink: 0 }}>
              {isSupportedGraphic && (
                <div style={{ display: 'flex', gap: '0.2rem', backgroundColor: 'var(--bg-deep)', padding: '0.15rem', borderRadius: '4px', border: '1px solid var(--border)' }}>
                  {(['STF', 'Arcsinh', 'Linear'] as const).map(s => (
                    <button 
                      key={s}
                      onClick={() => setStretch(s)}
                      style={{ 
                        padding: '0.2rem 0.5rem', 
                        backgroundColor: stretch === s ? 'var(--accent-blue)' : 'transparent',
                        color: stretch === s ? 'white' : 'var(--text-muted)',
                        border: 'none', borderRadius: '3px', cursor: 'pointer', fontSize: '0.7rem', fontWeight: 600
                      }}
                    >
                      {s}
                    </button>
                  ))}
                </div>
              )}

              {isSupportedGraphic && (
                <div style={{ display: 'flex', gap: '0.2rem', backgroundColor: 'var(--bg-deep)', padding: '0.15rem', borderRadius: '4px', border: '1px solid var(--border)' }}>
                  {(['RGB', 'R', 'G', 'B', 'L'] as const).map(c => (
                    <button 
                      key={c}
                      onClick={() => setChannel(c)}
                      style={{ 
                        padding: '0.2rem 0.4rem', 
                        backgroundColor: channel === c ? 'var(--bg-panel-light)' : 'transparent',
                        color: channel === c ? 'white' : 'var(--text-muted)',
                        border: channel === c ? '1px solid var(--border)' : '1px solid transparent',
                        borderRadius: '3px', cursor: 'pointer', fontSize: '0.7rem', fontWeight: 700
                      }}
                    >
                      {c}
                    </button>
                  ))}
                </div>
              )}

              <div style={{ width: '1px', height: '16px', backgroundColor: 'var(--border)' }}></div>

              <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
                <button onClick={() => setZoom(100)} style={{ background: 'none', border: 'none', color: zoom === 100 ? 'var(--accent-blue)' : 'var(--text-muted)', cursor: 'pointer', display: 'flex', alignItems: 'center' }} title="Zoom 1:1"><MousePointer2 size={13} /></button>
                <button onClick={handleZoomIn} style={{ background: 'none', border: 'none', color: 'var(--text-muted)', cursor: 'pointer', display: 'flex', alignItems: 'center' }} title="Zoom In"><ZoomIn size={13} /></button>
                <button onClick={handleZoomOut} style={{ background: 'none', border: 'none', color: 'var(--text-muted)', cursor: 'pointer', display: 'flex', alignItems: 'center' }} title="Zoom Out"><ZoomOut size={13} /></button>
                <button onClick={() => setZoom('fit')} style={{ background: 'none', border: 'none', color: zoom === 'fit' ? 'var(--accent-purple)' : 'var(--text-muted)', cursor: 'pointer', display: 'flex', alignItems: 'center' }} title="Zoom Fit"><Maximize size={13} /></button>
              </div>

              {isSupportedGraphic && (
                <>
                  <div style={{ width: '1px', height: '16px', backgroundColor: 'var(--border)' }}></div>
                  <button
                    onClick={() => setShowHistogram(p => !p)}
                    title="Toggle Histogram"
                    style={{
                      background: 'none', border: 'none', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '0.25rem',
                      color: showHistogram ? 'var(--accent-blue)' : 'var(--text-muted)', fontSize: '0.7rem', fontWeight: 600
                    }}
                  >
                    <svg width="14" height="10" viewBox="0 0 14 10" fill="currentColor">
                      <rect x="0" y="6" width="2" height="4" opacity="0.7"/>
                      <rect x="3" y="3" width="2" height="7" opacity="0.7"/>
                      <rect x="6" y="1" width="2" height="9" opacity="0.7"/>
                      <rect x="9" y="4" width="2" height="6" opacity="0.7"/>
                      <rect x="12" y="7" width="2" height="3" opacity="0.7"/>
                    </svg>
                    Hist
                  </button>
                </>
              )}
            </div>

            {/* Right side: coordinates and ADU info */}
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.6rem', fontFamily: 'var(--font-mono)', fontSize: '0.75rem', color: 'var(--text-muted)', flexShrink: 0 }}>
              {activeFile && hoverCoords.val !== null && isSupportedGraphic ? (
                <>
                  <span>X: <span style={{ color: 'var(--accent-blue)' }}>{hoverCoords.x}</span> Y: <span style={{ color: 'var(--accent-blue)' }}>{hoverCoords.y}</span></span>
                  <span style={{ color: 'var(--border)' }}>|</span>
                  {hoverCoords.rVal !== undefined ? (
                    <span>RGB: (<span style={{ color: 'hsl(0, 85%, 65%)' }}>{hoverCoords.rVal.toFixed(3)}</span>, <span style={{ color: 'hsl(120, 80%, 65%)' }}>{hoverCoords.gVal?.toFixed(3)}</span>, <span style={{ color: 'hsl(220, 85%, 65%)' }}>{hoverCoords.bVal?.toFixed(3)}</span>) | L: <span style={{ color: 'var(--success)' }}>{hoverCoords.val.toFixed(3)}</span></span>
                  ) : (
                    <span>Value: <span style={{ color: 'var(--success)' }}>{hoverCoords.val.toFixed(4)}</span></span>
                  )}
                </>
              ) : (
                <span>X: -- Y: -- | Value: --</span>
              )}
              
              {onPopOut && (
                <>
                  <span style={{ color: 'var(--border)' }}>|</span>
                  <button 
                    onClick={onPopOut}
                    style={{
                      background: 'none', border: 'none', color: 'var(--text-main)', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '0.2rem', fontSize: '0.75rem'
                    }}
                    title={isPoppedOut ? "Dock Previewer back to main window" : "Pop out Previewer to a separate window"}
                  >
                    <ExternalLink size={12} color="var(--accent-blue)" />
                    <span>{isPoppedOut ? "Dock" : "Pop"}</span>
                  </button>
                </>
              )}
            </div>
          </div>
        </div>
      </div>
      <input 
        type="file" 
        ref={fileInputRef} 
        multiple 
        style={{ display: 'none' }} 
        onChange={(e) => {
          if (e.target.files && e.target.files.length > 0) {
            onAddFiles(Array.from(e.target.files));
          }
        }} 
      />
    </div>
  );
};

export default AstroPreviewer;
