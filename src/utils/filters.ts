import { calculateStats } from './stretch';

// White point and conversions helper functions
function rgbToXyz(r: number, g: number, b: number) {
  // Linear RGB to XYZ (D65 illuminant)
  const x = r * 0.4124564 + g * 0.3575761 + b * 0.1804375;
  const y = r * 0.2126729 + g * 0.7151522 + b * 0.0721750;
  const z = r * 0.0193339 + g * 0.1191920 + b * 0.9503041;
  return { x, y, z };
}

function xyzToRgb(x: number, y: number, z: number) {
  const r = x * 3.2404542 + y * -1.5371385 + z * -0.4985314;
  const g = x * -0.9692660 + y * 1.8760108 + z * 0.0415560;
  const b = x * 0.0556434 + y * -0.2040259 + z * 1.0572252;
  return { r, g, b };
}

function xyzToLab(x: number, y: number, z: number) {
  const xn = 0.950489;
  const yn = 1.0;
  const zn = 1.088840;
  
  const fx = x / xn > 0.008856 ? Math.cbrt(x / xn) : (7.787 * (x / xn)) + 16 / 116;
  const fy = y / yn > 0.008856 ? Math.cbrt(y / yn) : (7.787 * (y / yn)) + 16 / 116;
  const fz = z / zn > 0.008856 ? Math.cbrt(z / zn) : (7.787 * (z / zn)) + 16 / 116;
  
  const l = (116 * fy) - 16;
  const a = 500 * (fx - fy);
  const b = 200 * (fy - fz);
  return { l, a, b };
}

function labToXyz(l: number, a: number, b: number) {
  const xn = 0.950489;
  const yn = 1.0;
  const zn = 1.088840;
  
  const fy = (l + 16) / 116;
  const fx = a / 500 + fy;
  const fz = fy - b / 200;
  
  const y = fy * fy * fy > 0.008856 ? fy * fy * fy : (fy - 16 / 116) / 7.787;
  const x = fx * fx * fx > 0.008856 ? fx * fx * fx : (fx - 16 / 116) / 7.787;
  const z = fz * fz * fz > 0.008856 ? fz * fz * fz : (fz - 16 / 116) / 7.787;
  
  return { x: x * xn, y: y * yn, z: z * zn };
}

/**
 * Subtractive Chrominance Noise Reduction (SCNR)
 * Replicates scnr.c in Siril. Removes green cast in color images.
 */
export function executeSCNR(
  width: number,
  height: number,
  data: Float32Array,
  type: number = 0, // 0: Average Neutral, 1: Maximum Neutral, 2: Maximum Neutral with amount, 3: Sum
  amount: number = 1.0,
  preserveLuminance: boolean = true
): { newData: Float32Array, logs: string[] } {
  const logs: string[] = [];
  logs.push(`Initializing SCNR (Subtractive Chrominance Noise Reduction)...`);
  
  const channels = data.length / (width * height);
  if (channels < 3) {
    logs.push(`Warning: SCNR requires a color (RGB) image. Grayscale FITS data detected.`);
    logs.push(`Skipping SCNR calculations (no chrominance noise to remove in monochrome).`);
    return { newData: new Float32Array(data), logs };
  }

  logs.push(`Processing color channels (Type: ${type}, Amount: ${amount}, Preserve Luminance: ${preserveLuminance})...`);
  const newData = new Float32Array(data.length);
  const planeSize = width * height;
  
  const rOffset = 0;
  const gOffset = planeSize;
  const bOffset = planeSize * 2;
  
  for (let i = 0; i < planeSize; i++) {
    let r = data[rOffset + i];
    let g = data[gOffset + i];
    let b = data[bOffset + i];
    
    let origL = 0;
    if (preserveLuminance) {
      const xyz = rgbToXyz(r, g, b);
      const lab = xyzToLab(xyz.x, xyz.y, xyz.z);
      origL = lab.l;
    }
    
    let m = 0;
    if (type === 0) {
      m = 0.5 * (r + b);
      g = Math.min(g, m);
    } else if (type === 1) {
      m = Math.max(r, b);
      g = Math.min(g, m);
    } else if (type === 2) {
      m = Math.max(r, b);
      g = (g * (1.0 - amount) * (1.0 - m)) + (m * g);
    } else if (type === 3) {
      m = Math.min(1.0, r + b);
      g = (g * (1.0 - amount) * (1.0 - m)) + (m * g);
    }
    
    if (preserveLuminance) {
      const xyz = rgbToXyz(r, g, b);
      const lab = xyzToLab(xyz.x, xyz.y, xyz.z);
      const restoredXyz = labToXyz(origL, lab.a, lab.b);
      const restoredRgb = xyzToRgb(restoredXyz.x, restoredXyz.y, restoredXyz.z);
      r = restoredRgb.r;
      g = restoredRgb.g;
      b = restoredRgb.b;
    }
    
    newData[rOffset + i] = Math.max(0, Math.min(1, r));
    newData[gOffset + i] = Math.max(0, Math.min(1, g));
    newData[bOffset + i] = Math.max(0, Math.min(1, b));
  }
  
  logs.push(`SCNR complete. Cleaned green noise.`);
  return { newData, logs };
}

/**
 * Hyperbolic Sine Transformation (Asinh Stretch)
 * Replicates asinh.c in Siril. Stretches pixels without bloating star cores.
 */
export function executeAsinhTransform(
  width: number,
  height: number,
  data: Float32Array,
  beta: number = 10.0,
  offset: number = 0.0,
  rgbSpace: boolean = true
): { newData: Float32Array, logs: string[] } {
  const logs: string[] = [];
  logs.push(`Initializing Asinh Transformation (stretch factor β = ${beta}, black point = ${offset})...`);
  
  const asinhBeta = Math.asinh(beta);
  if (Math.abs(asinhBeta) < 1e-10) {
    logs.push(`Error: Stretch factor β is too small. Aborting.`);
    return { newData: data, logs };
  }

  const channels = data.length / (width * height);
  const planeSize = width * height;
  const newData = new Float32Array(data.length);

  if (channels >= 3) {
    logs.push(`Applying color Asinh stretch...`);
    const rOffset = 0;
    const gOffset = planeSize;
    const bOffset = planeSize * 2;

    const factorRed = rgbSpace ? 0.2126 : 0.3333;
    const factorGreen = rgbSpace ? 0.7152 : 0.3333;
    const factorBlue = rgbSpace ? 0.0722 : 0.3333;

    for (let i = 0; i < planeSize; i++) {
      const r = data[rOffset + i];
      const g = data[gOffset + i];
      const b = data[bOffset + i];

      const x = factorRed * r + factorGreen * g + factorBlue * b;
      const k = (x === 0.0) ? 0.0 : Math.asinh(beta * x) / (x * asinhBeta);

      newData[rOffset + i] = Math.max(0, (r - offset) * k);
      newData[gOffset + i] = Math.max(0, (g - offset) * k);
      newData[bOffset + i] = Math.max(0, (b - offset) * k);
    }
  } else {
    logs.push(`Applying monochrome Asinh stretch...`);
    for (let i = 0; i < planeSize; i++) {
      const x = data[i];
      const k = (x === 0.0) ? 0.0 : Math.asinh(beta * x) / (x * asinhBeta);
      newData[i] = Math.max(0, (x - offset) * k);
    }
  }

  logs.push(`Asinh transformation complete.`);
  return { newData, logs };
}

/**
 * Canon Banding Noise Reduction
 * Replicates banding.c in Siril. Removes vertical or horizontal noise bands.
 */
export function executeBandingReduction(
  width: number,
  height: number,
  data: Float32Array,
  sigma: number = 3.0,
  amount: number = 0.9,
  protectHighlights: boolean = true,
  vertical: boolean = false
): { newData: Float32Array, logs: string[] } {
  const logs: string[] = [];
  logs.push(`Initializing Canon Banding Reduction (Amount: ${amount}, Protect: ${protectHighlights}, InvSigma: ${sigma}, Orientation: ${vertical ? 'Vertical' : 'Horizontal'})...`);

  const channels = data.length / (width * height);
  const planeSize = width * height;
  const newData = new Float32Array(data.length);
  
  const MAD_NORM = 1.4826;

  for (let c = 0; c < channels; c++) {
    const channelOffset = c * planeSize;
    
    // Calculate stats for this channel
    const chanData = data.subarray(channelOffset, channelOffset + planeSize);
    const stats = calculateStats(chanData);
    
    const background = stats.median;
    const globalsigma = stats.mad * MAD_NORM;
    const rejectThreshold = background + (1.0 / sigma) * globalsigma;

    logs.push(`[Channel ${c}] Background median: ${background.toFixed(4)}, Noise σ: ${globalsigma.toFixed(4)}`);

    const numLines = vertical ? width : height;
    const pixelsPerLine = vertical ? height : width;
    
    const lineCorrection = new Float32Array(numLines);
    let minimum = Infinity;

    for (let l = 0; l < numLines; l++) {
      // Gather line pixels
      const linePixels = new Float32Array(pixelsPerLine);
      for (let p = 0; p < pixelsPerLine; p++) {
        const idx = vertical 
          ? (p * width + l) // column l, row p
          : (l * width + p); // row l, column p
        linePixels[p] = chanData[idx];
      }

      let median = 0;
      if (protectHighlights) {
        linePixels.sort();
        let validCount = pixelsPerLine;
        for (let i = pixelsPerLine - 1; i >= 0; i--) {
          if (linePixels[i] < rejectThreshold) {
            break;
          }
          validCount--;
        }
        
        if (validCount > 0) {
          const mid = Math.floor(validCount / 2);
          median = validCount % 2 !== 0 ? linePixels[mid] : (linePixels[mid - 1] + linePixels[mid]) / 2;
        } else {
          median = background;
        }
      } else {
        linePixels.sort();
        const mid = Math.floor(pixelsPerLine / 2);
        median = pixelsPerLine % 2 !== 0 ? linePixels[mid] : (linePixels[mid - 1] + linePixels[mid]) / 2;
      }

      lineCorrection[l] = background - median;
      if (lineCorrection[l] < minimum) {
        minimum = lineCorrection[l];
      }
    }

    // Apply correction
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const pixelIdx = y * width + x;
        const lineIdx = vertical ? x : y;
        const correction = (lineCorrection[lineIdx] - minimum) * amount;
        newData[channelOffset + pixelIdx] = Math.max(0, chanData[pixelIdx] + correction);
      }
    }
  }

  logs.push(`Banding reduction complete.`);
  return { newData, logs };
}

/**
 * Rotational Gradient Filter
 * Replicates rgradient.c in Siril. Enhances radial structure details.
 */
export function executeRotationalGradient(
  width: number,
  height: number,
  data: Float32Array,
  xc: number,
  yc: number,
  dR: number = 2,
  da: number = 1.0
): { newData: Float32Array, logs: string[] } {
  const logs: string[] = [];
  logs.push(`Initializing Rotational Gradient Filter (Center: [${xc.toFixed(1)}, ${yc.toFixed(1)}], dR: ${dR}px, dA: ${da}°)...`);

  const channels = data.length / (width * height);
  const planeSize = width * height;
  const newData = new Float32Array(data.length);
  
  const dAlpha = (Math.PI / 180.0) * da;
  const w = width - 1;
  const h = height - 1;

  const clampCoord = (val: number, max: number): number => {
    let v = val;
    if (v < 0) {
      v = Math.abs(v);
    } else if (v > max) {
      v = 2 * max - v;
    }
    return Math.max(0, Math.min(max, Math.floor(v)));
  };

  const getPixelVal = (chanData: Float32Array, px: number, py: number): number => {
    const cx = clampCoord(px, w);
    const cy = clampCoord(py, h);
    return chanData[cy * width + cx];
  };

  for (let c = 0; c < channels; c++) {
    const offset = c * planeSize;
    const chanData = data.subarray(offset, offset + planeSize);

    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const dx = x - xc;
        const dy = y - yc;
        const r = Math.sqrt(dx * dx + dy * dy);
        const theta = Math.atan2(dy, dx);

        // Positive differential
        const rPos = r - dR;
        const thetaPos = theta + dAlpha;
        const xPos = xc + rPos * Math.cos(thetaPos);
        const yPos = yc + rPos * Math.sin(thetaPos);
        const valPos = getPixelVal(chanData, xPos, yPos);

        // Negative differential
        const rNeg = r + dR;
        const thetaNeg = theta - dAlpha;
        const xNeg = xc + rNeg * Math.cos(thetaNeg);
        const yNeg = yc + rNeg * Math.sin(thetaNeg);
        const valNeg = getPixelVal(chanData, xNeg, yNeg);

        const val = chanData[y * width + x];
        const newVal = 2.0 * val - valPos - valNeg;
        
        newData[offset + y * width + x] = Math.max(0, Math.min(1, newVal));
      }
    }
  }

  logs.push(`Rotational Gradient applied successfully.`);
  return { newData, logs };
}

// Wavelet à trous smoothing helpers
function pave2dLinearSmooth(src: Float32Array, dest: Float32Array, width: number, height: number, step: number) {
  const testInd = (ind: number, max: number): number => {
    if (ind < 0) return 0;
    if (ind >= max) return max - 1;
    return ind;
  };

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const y1 = testInd(y - step, height);
      const x1 = testInd(x - step, width);
      const y2 = testInd(y + step, height);
      const x2 = testInd(x + step, width);

      dest[y * width + x] = 
        0.0625 * (
          src[y1 * width + x1] +
          src[y1 * width + x2] +
          src[y2 * width + x1] +
          src[y2 * width + x2]
        ) +
        0.125 * (
          src[y1 * width + x] +
          src[y * width + x1] +
          src[y * width + x2] +
          src[y2 * width + x]
        ) +
        0.25 * src[y * width + x];
    }
  }
}

function pave2dBsplineSmooth(src: Float32Array, dest: Float32Array, width: number, height: number, step: number) {
  const testInd = (ind: number, max: number): number => {
    if (ind < 0) return 0;
    if (ind >= max) return max - 1;
    return ind;
  };

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const y1 = testInd(y - step, height);
      const x1 = testInd(x - step, width);
      const y2 = testInd(y + step, height);
      const x2 = testInd(x + step, width);
      
      const y3 = testInd(y - 2 * step, height);
      const x3 = testInd(x - 2 * step, width);
      const y4 = testInd(y + 2 * step, height);
      const x4 = testInd(x + 2 * step, width);

      dest[y * width + x] = 
        0.00390625 * (
          src[y3 * width + x3] +
          src[y3 * width + x4] +
          src[y4 * width + x3] +
          src[y4 * width + x4]
        ) +
        0.015625 * (
          src[y4 * width + x2] +
          src[y3 * width + x2] +
          src[y4 * width + x1] +
          src[y3 * width + x1] +
          src[y2 * width + x3] +
          src[y2 * width + x4] +
          src[y1 * width + x3] +
          src[y1 * width + x4]
        ) +
        0.0234375 * (
          src[y3 * width + x] +
          src[y4 * width + x] +
          src[y * width + x3] +
          src[y * width + x4]
        ) +
        0.0625 * (
          src[y2 * width + x2] +
          src[y2 * width + x1] +
          src[y1 * width + x2] +
          src[y1 * width + x1]
        ) +
        0.09375 * (
          src[y2 * width + x] +
          src[y1 * width + x] +
          src[y * width + x2] +
          src[y * width + x1]
        ) +
        0.140625 * src[y * width + x];
    }
  }
}

function pave2dGaussianSmooth(src: Float32Array, dest: Float32Array, width: number, height: number, step: number) {
  const testInd = (ind: number, max: number): number => {
    if (ind < 0) return 0;
    if (ind >= max) return max - 1;
    return ind;
  };

  const weights = [0.0545, 0.2442, 0.4026, 0.2442, 0.0545];
  const coordsX = new Int32Array(5);
  const coordsY = new Int32Array(5);

  for (let y = 0; y < height; y++) {
    coordsY[0] = testInd(y - 2 * step, height);
    coordsY[1] = testInd(y - step, height);
    coordsY[2] = y;
    coordsY[3] = testInd(y + step, height);
    coordsY[4] = testInd(y + 2 * step, height);

    for (let x = 0; x < width; x++) {
      coordsX[0] = testInd(x - 2 * step, width);
      coordsX[1] = testInd(x - step, width);
      coordsX[2] = x;
      coordsX[3] = testInd(x + step, width);
      coordsX[4] = testInd(x + 2 * step, width);

      let sum = 0;
      for (let dy = 0; dy < 5; dy++) {
        const wy = weights[dy];
        const rowOffset = coordsY[dy] * width;
        for (let dx = 0; dx < 5; dx++) {
          const wx = weights[dx];
          sum += src[rowOffset + coordsX[dx]] * wy * wx;
        }
      }
      dest[y * width + x] = sum;
    }
  }
}

function pave2dBoxSmooth(src: Float32Array, dest: Float32Array, width: number, height: number, step: number) {
  const testInd = (ind: number, max: number): number => {
    if (ind < 0) return 0;
    if (ind >= max) return max - 1;
    return ind;
  };

  const w = 1.0 / 9.0;
  const coordsX = new Int32Array(3);
  const coordsY = new Int32Array(3);

  for (let y = 0; y < height; y++) {
    coordsY[0] = testInd(y - step, height);
    coordsY[1] = y;
    coordsY[2] = testInd(y + step, height);

    for (let x = 0; x < width; x++) {
      coordsX[0] = testInd(x - step, width);
      coordsX[1] = x;
      coordsX[2] = testInd(x + step, width);

      let sum = 0;
      for (let dy = 0; dy < 3; dy++) {
        const rowOffset = coordsY[dy] * width;
        for (let dx = 0; dx < 3; dx++) {
          sum += src[rowOffset + coordsX[dx]];
        }
      }
      dest[y * width + x] = sum * w;
    }
  }
}

function pave2dCubic7Smooth(src: Float32Array, dest: Float32Array, width: number, height: number, step: number) {
  const testInd = (ind: number, max: number): number => {
    if (ind < 0) return 0;
    if (ind >= max) return max - 1;
    return ind;
  };

  const weights = [0.015625, 0.09375, 0.234375, 0.3125, 0.234375, 0.09375, 0.015625];
  const coordsX = new Int32Array(7);
  const coordsY = new Int32Array(7);

  for (let y = 0; y < height; y++) {
    coordsY[0] = testInd(y - 3 * step, height);
    coordsY[1] = testInd(y - 2 * step, height);
    coordsY[2] = testInd(y - step, height);
    coordsY[3] = y;
    coordsY[4] = testInd(y + step, height);
    coordsY[5] = testInd(y + 2 * step, height);
    coordsY[6] = testInd(y + 3 * step, height);

    for (let x = 0; x < width; x++) {
      coordsX[0] = testInd(x - 3 * step, width);
      coordsX[1] = testInd(x - 2 * step, width);
      coordsX[2] = testInd(x - step, width);
      coordsX[3] = x;
      coordsX[4] = testInd(x + step, width);
      coordsX[5] = testInd(x + 2 * step, width);
      coordsX[6] = testInd(x + 3 * step, width);

      let sum = 0;
      for (let dy = 0; dy < 7; dy++) {
        const wy = weights[dy];
        const rowOffset = coordsY[dy] * width;
        for (let dx = 0; dx < 7; dx++) {
          const wx = weights[dx];
          sum += src[rowOffset + coordsX[dx]] * wy * wx;
        }
      }
      dest[y * width + x] = sum;
    }
  }
}

function pave2dSmooth(
  src: Float32Array,
  dest: Float32Array,
  width: number,
  height: number,
  step: number,
  typeTransform: number
) {
  switch (typeTransform) {
    case 1:
      pave2dLinearSmooth(src, dest, width, height, step);
      break;
    case 2:
      pave2dBsplineSmooth(src, dest, width, height, step);
      break;
    case 3:
      pave2dGaussianSmooth(src, dest, width, height, step);
      break;
    case 4:
      pave2dBoxSmooth(src, dest, width, height, step);
      break;
    case 5:
      pave2dCubic7Smooth(src, dest, width, height, step);
      break;
    default:
      pave2dBsplineSmooth(src, dest, width, height, step);
  }
}

/**
 * Wavelet à trous Decomposition & Reconstruction Filter
 * Ported from wavelets.c and pave.c in Siril.
 * Decomposes an image into multi-scale frequency bands, applies coefficients to scale layers, and reconstructs the output.
 */
export function executeWaveletTransform(
  width: number,
  height: number,
  data: Float32Array,
  nbrPlan: number = 5,
  typeTransform: number = 2, // 1: Linear, 2: Bspline
  coefficients: number[] = [1, 1, 1, 1, 1]
): { newData: Float32Array, logs: string[] } {
  const logs: string[] = [];
  const getKernelName = (type: number): string => {
    switch (type) {
      case 1: return 'Linear';
      case 2: return 'B3-Spline';
      case 3: return 'Gaussian (5x5)';
      case 4: return 'Box/Haar (3x3)';
      case 5: return 'Cubic Spline (7x7)';
      default: return 'B3-Spline';
    }
  };
  logs.push(`Initializing Wavelet à trous decomposition (Scale layers: ${nbrPlan}, Kernel: ${getKernelName(typeTransform)})...`);

  const channels = data.length / (width * height);
  const planeSize = width * height;
  const newData = new Float32Array(data.length);

  for (let c = 0; c < channels; c++) {
    const offset = c * planeSize;
    const chanData = data.subarray(offset, offset + planeSize);

    // 1. Allocate Pave (Decomposed planes)
    const pave = new Float32Array(planeSize * nbrPlan);
    
    // Copy input into active smoothing buffer
    let smooth = new Float32Array(chanData);

    logs.push(`[Channel ${c}] Computing forward à trous wavelet decomposition...`);

    for (let plan = 0; plan < nbrPlan - 1; plan++) {
      const planOffset = plan * planeSize;
      
      // Copy current scale to pave plan
      pave.set(smooth, planOffset);

      // Smooth it
      const nextSmooth = new Float32Array(planeSize);
      const step = Math.pow(2, plan);
      
      pave2dSmooth(smooth, nextSmooth, width, height, step, typeTransform);

      // Compute detail: Detail = smooth - nextSmooth
      const planView = pave.subarray(planOffset, planOffset + planeSize);
      for (let i = 0; i < planeSize; i++) {
        planView[i] -= nextSmooth[i];
      }

      // Proceed with next scale
      smooth = nextSmooth;
    }

    // Last plan is the lowest resolution residue
    pave.set(smooth, (nbrPlan - 1) * planeSize);

    // 2. Reconstruction (Sharpening / Filtering)
    logs.push(`[Channel ${c}] Reconstructing image from wavelet layers with coefficients: ${coefficients.slice(0, nbrPlan).map(v => v.toFixed(2)).join(', ')}...`);

    const reconstructed = new Float32Array(planeSize);
    for (let plan = 0; plan < nbrPlan; plan++) {
      const planOffset = plan * planeSize;
      const planView = pave.subarray(planOffset, planOffset + planeSize);
      const coeff = coefficients[plan] !== undefined ? coefficients[plan] : 1.0;

      for (let i = 0; i < planeSize; i++) {
        // Last plane is the residue, typically we keep it at coeff 1.0 to preserve base brightness
        const scaleCoeff = (plan === nbrPlan - 1) ? 1.0 : coeff;
        reconstructed[i] += planView[i] * scaleCoeff;
      }
    }

    // Write back to channel output
    for (let i = 0; i < planeSize; i++) {
      newData[offset + i] = Math.max(0, Math.min(1, reconstructed[i]));
    }
  }

  logs.push(`Wavelet processing complete.`);
  return { newData, logs };
}

/**
 * Color Saturation Enhancement
 * Replicates saturation.c in Siril. Enhances or reduces color saturation in specific hue ranges.
 */
export function executeColorSaturation(
  width: number,
  height: number,
  data: Float32Array,
  amount: number = 0.5, // satu_amount: e.g. 0.5 is +50% saturation
  hueType: number = 6, // 0-5 for specific bands, 6 for global
  backgroundFactor: number = 0.0
): { newData: Float32Array; logs: string[] } {
  const logs: string[] = [];
  logs.push(`Initializing Color Saturation Enhancement (Amount: ${(amount * 100).toFixed(0)}%, Hue Band: ${hueType}, Background Factor: ${backgroundFactor})...`);

  const channels = data.length / (width * height);
  if (channels < 3) {
    logs.push(`Warning: Color Saturation requires a color (RGB) image. Grayscale FITS data detected.`);
    logs.push(`Skipping saturation changes.`);
    return { newData: new Float32Array(data), logs };
  }

  const planeSize = width * height;
  const newData = new Float32Array(data.length);
  const rOffset = 0;
  const gOffset = planeSize;
  const bOffset = planeSize * 2;

  // 1. Determine Hue limits in [0, 6] range
  let hMin = 0.0;
  let hMax = 6.0;
  switch (hueType) {
    case 0: // Pink-Red to Red-Orange
      hMin = 346.0 / 60.0;
      hMax = 20.0 / 60.0;
      break;
    case 1: // Orange-Brown to Yellow
      hMin = 21.0 / 60.0;
      hMax = 60.0 / 60.0;
      break;
    case 2: // Yellow-Green to Green-Cyan
      hMin = 61.0 / 60.0;
      hMax = 200.0 / 60.0;
      break;
    case 3: // Cyan
      hMin = 170.0 / 60.0;
      hMax = 200.0 / 60.0;
      break;
    case 4: // Cyan-Blue to Blue-Magenta
      hMin = 201.0 / 60.0;
      hMax = 280.0 / 60.0;
      break;
    case 5: // Magenta to Pink
      hMin = 281.0 / 60.0;
      hMax = 345.0 / 60.0;
      break;
    default:
    case 6: // Global
      hMin = 0.0;
      hMax = 6.0;
  }

  // 2. Compute background threshold if backgroundFactor > 0
  let bgThreshold = 0.0;
  if (backgroundFactor > 0.0) {
    // Compute median of Green channel
    const gData = data.subarray(gOffset, gOffset + planeSize);
    const stats = calculateStats(gData);
    bgThreshold = (stats.median + stats.mad * 1.4826) * backgroundFactor;
    logs.push(`Background threshold calculated: ${bgThreshold.toFixed(4)}`);
  }

  const sMult = 1.0 + amount;
  const isRedCase = hMin > hMax;

  logs.push(`Applying pixel-by-pixel Saturation scale...`);

  // HSL helper routines
  const rgbToHslSat = (r: number, g: number, b: number, low: number) => {
    const v = Math.max(r, Math.max(g, b));
    const m = Math.min(r, Math.min(g, b));
    if (m + v < low * 2) {
      return { h: 0, s: 0, l: 0 };
    }
    const l = (m + v) / 2;
    let h = 0;
    let s = 0;
    const vm = v - m;
    if (vm > 0) {
      s = vm / (l <= 0.5 ? v + m : 2 - v - m);
      if (r === v) {
        const g2 = (v - g) / vm;
        const b2 = (v - b) / vm;
        h = g === m ? 5 + b2 : 1 - g2;
      } else if (g === v) {
        const r2 = (v - r) / vm;
        const b2 = (v - b) / vm;
        h = b === m ? 1 + r2 : 3 - b2;
      } else {
        const r2 = (v - r) / vm;
        const g2 = (v - g) / vm;
        h = r === m ? 3 + g2 : 5 - r2;
      }
    }
    return { h, s, l };
  };

  const hslToRgbSat = (h: number, s: number, l: number) => {
    const hNorm = h >= 6.0 ? h - 6.0 : h;
    const v = l <= 0.5 ? l * (1.0 + s) : l + s - l * s;
    if (v <= 0.0) {
      return { r: 0, g: 0, b: 0 };
    }
    const m = l * 2.0 - v;
    const sv = (v - m) / v;
    const sextant = Math.floor(hNorm);
    const fract = hNorm - sextant;
    const vsf = v * sv * fract;
    const mid1 = m + vsf;
    const mid2 = v - vsf;
    let r = 0, g = 0, b = 0;
    switch (sextant) {
      case 0: r = v; g = mid1; b = m; break;
      case 1: r = mid2; g = v; b = m; break;
      case 2: r = m; g = v; b = mid1; break;
      case 3: r = m; g = mid2; b = v; break;
      case 4: r = mid1; g = m; b = v; break;
      case 5: r = v; g = m; b = mid2; break;
    }
    return { r, g, b };
  };

  for (let i = 0; i < planeSize; i++) {
    let r = data[rOffset + i];
    let g = data[gOffset + i];
    let b = data[bOffset + i];

    const hsl = rgbToHslSat(r, g, b, bgThreshold);
    if (hsl.l > bgThreshold) {
      let match = false;
      if (isRedCase) {
        if (hsl.h >= hMin || hsl.h <= hMax) {
          match = true;
        }
      } else {
        if (hsl.h >= hMin && hsl.h <= hMax) {
          match = true;
        }
      }

      if (match) {
        hsl.s *= sMult;
        if (hsl.s > 1.0) hsl.s = 1.0;
        if (hsl.s < 0.0) hsl.s = 0.0;
      }

      const rgb = hslToRgbSat(hsl.h, hsl.s, hsl.l);
      r = rgb.r;
      g = rgb.g;
      b = rgb.b;
    }

    newData[rOffset + i] = Math.max(0, Math.min(1, r));
    newData[gOffset + i] = Math.max(0, Math.min(1, g));
    newData[bOffset + i] = Math.max(0, Math.min(1, b));
  }

  logs.push(`Saturation enhancement complete.`);
  return { newData, logs };
}

/**
 * Cosmetic Correction (Hot and Cold Pixel Removal)
 * Ported from cosmetic_correction.c in Siril.
 * Detects outlier pixels using sigma thresholds and replaces them with local median/average.
 */
export function executeCosmeticCorrection(
  width: number,
  height: number,
  data: Float32Array,
  sigmaHot: number = 3.0, // Threshold for hot pixels (-1 to disable)
  sigmaCold: number = 3.0, // Threshold for cold pixels (-1 to disable)
  isCfa: boolean = false // CFA Bayer matrix flag (skips adjacent pixels in 2x2 grid if true)
): { newData: Float32Array; logs: string[] } {
  const logs: string[] = [];
  logs.push(`Initializing Cosmetic Correction (Hot Sigma: ${sigmaHot}, Cold Sigma: ${sigmaCold}, CFA: ${isCfa})...`);

  const channels = data.length / (width * height);
  const planeSize = width * height;
  const newData = new Float32Array(data); // copy original data

  const getMedian5x5 = (buf: Float32Array, channelOffset: number, xx: number, yy: number, step: number): number => {
    const radius = 2 * step;
    const values: number[] = [];
    for (let y = yy - radius; y <= yy + radius; y += step) {
      if (y >= 0 && y < height) {
        for (let x = xx - radius; x <= xx + radius; x += step) {
          if (x >= 0 && x < width) {
            if (x !== xx || y !== yy) {
              values.push(buf[channelOffset + y * width + x]);
            }
          }
        }
      }
    }
    values.sort((a, b) => a - b);
    const len = values.length;
    if (len === 0) return buf[channelOffset + yy * width + xx];
    const mid = Math.floor(len / 2);
    return len % 2 !== 0 ? values[mid] : (values[mid - 1] + values[mid]) / 2;
  };

  const getAverage3x3 = (buf: Float32Array, channelOffset: number, xx: number, yy: number, step: number): number => {
    let sum = 0;
    let count = 0;
    for (let y = yy - step; y <= yy + step; y += step) {
      if (y >= 0 && y < height) {
        for (let x = xx - step; x <= xx + step; x += step) {
          if (x >= 0 && x < width) {
            if (x !== xx || y !== yy) {
              sum += buf[channelOffset + y * width + x];
              count++;
            }
          }
        }
      }
    }
    return count > 0 ? sum / count : buf[channelOffset + yy * width + xx];
  };

  const step = isCfa ? 2 : 1;

  for (let c = 0; c < channels; c++) {
    const channelOffset = c * planeSize;
    const chanData = data.subarray(channelOffset, channelOffset + planeSize);
    
    // Calculate global stats for this channel
    const stats = calculateStats(chanData);
    const median = stats.median;
    const sigma = stats.mad * 1.4826; // robust std dev estimation

    const thresCold = sigmaCold > 0 ? Math.max(0, median - sigmaCold * sigma) : -1.0;
    const thresHot = sigmaHot > 0 ? median + sigmaHot * sigma : 2.0; // above max possible 1.0

    logs.push(`[Channel ${c}] Median: ${median.toFixed(4)}, Noise σ: ${sigma.toFixed(4)}`);
    if (sigmaCold > 0) logs.push(`[Channel ${c}] Cold Threshold: < ${thresCold.toFixed(4)}`);
    if (sigmaHot > 0) logs.push(`[Channel ${c}] Hot Threshold: > ${thresHot.toFixed(4)}`);

    let hotCount = 0;
    let coldCount = 0;

    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const idx = y * width + x;
        const val = chanData[idx];

        if (sigmaCold > 0 && val <= thresCold) {
          // Cold pixel: replace with 5x5 median
          newData[channelOffset + idx] = getMedian5x5(data, channelOffset, x, y, step);
          coldCount++;
        } else if (sigmaHot > 0 && val >= thresHot) {
          // Hot pixel: replace with 3x3 average
          newData[channelOffset + idx] = getAverage3x3(data, channelOffset, x, y, step);
          hotCount++;
        }
      }
    }

    logs.push(`[Channel ${c}] Corrected ${hotCount} Hot pixels and ${coldCount} Cold pixels.`);
  }

  logs.push(`Cosmetic Correction complete.`);
  return { newData, logs };
}

/**
 * Wavelet-based Multiscale Noise Reduction
 * Decomposes image using à trous algorithm, filters high frequency detail layers using MAD sigma thresholds, and reconstructs.
 */
export function executeWaveletNoiseReduction(
  width: number,
  height: number,
  data: Float32Array,
  nbrPlan: number = 4,
  thresholds: number[] = [3.0, 2.0, 1.0, 0.5],
  amount: number = 0.5,
  typeTransform: number = 2 // 1: Linear, 2: Bspline
): { newData: Float32Array; logs: string[] } {
  const logs: string[] = [];
  const getKernelName = (type: number): string => {
    switch (type) {
      case 1: return 'Linear';
      case 2: return 'B3-Spline';
      case 3: return 'Gaussian (5x5)';
      case 4: return 'Box/Haar (3x3)';
      case 5: return 'Cubic Spline (7x7)';
      default: return 'B3-Spline';
    }
  };
  logs.push(`Initializing Multiscale Wavelet Noise Reduction (Layers: ${nbrPlan}, Amount: ${(amount * 100).toFixed(0)}%, Kernel: ${getKernelName(typeTransform)})...`);

  const channels = data.length / (width * height);
  const planeSize = width * height;
  const newData = new Float32Array(data.length);

  for (let c = 0; c < channels; c++) {
    const offset = c * planeSize;
    const chanData = data.subarray(offset, offset + planeSize);

    // 1. Allocate Pave (Decomposed planes)
    const pave = new Float32Array(planeSize * nbrPlan);
    
    // Copy input into active smoothing buffer
    let smooth = new Float32Array(chanData);

    logs.push(`[Channel ${c}] Decomposing scales...`);

    for (let plan = 0; plan < nbrPlan - 1; plan++) {
      const planOffset = plan * planeSize;
      
      // Copy current scale to pave plan
      pave.set(smooth, planOffset);

      // Smooth it
      const nextSmooth = new Float32Array(planeSize);
      const step = Math.pow(2, plan);
      
      pave2dSmooth(smooth, nextSmooth, width, height, step, typeTransform);

      // Compute detail: Detail = smooth - nextSmooth
      const planView = pave.subarray(planOffset, planOffset + planeSize);
      for (let i = 0; i < planeSize; i++) {
        planView[i] -= nextSmooth[i];
      }

      // Proceed with next scale
      smooth = nextSmooth;
    }

    // Last plan is the residue
    pave.set(smooth, (nbrPlan - 1) * planeSize);

    // 2. Apply noise thresholding to detail layers
    for (let plan = 0; plan < nbrPlan - 1; plan++) {
      const planOffset = plan * planeSize;
      const planView = pave.subarray(planOffset, planOffset + planeSize);
      
      // Estimate noise scale sigma via MAD
      const stats = calculateStats(planView);
      const sigma = stats.mad * 1.4826;
      const multiplier = thresholds[plan] !== undefined ? thresholds[plan] : 1.0;
      const T = multiplier * sigma;

      logs.push(`> Scale ${plan + 1} (${Math.pow(2, plan)}px) - estimated noise σ: ${sigma.toFixed(5)}, threshold: ${T.toFixed(5)}`);

      if (T > 0 && amount > 0) {
        for (let i = 0; i < planeSize; i++) {
          const val = planView[i];
          const absVal = Math.abs(val);
          if (absVal < T) {
            const y = absVal / T;
            // Attenuate coefficients smaller than the threshold smoothly
            planView[i] = val * (1.0 - amount * (1.0 - y));
          }
        }
      }
    }

    // 3. Reconstruction
    logs.push(`[Channel ${c}] Reconstructing denoised plane...`);
    const reconstructed = new Float32Array(planeSize);
    for (let plan = 0; plan < nbrPlan; plan++) {
      const planOffset = plan * planeSize;
      const planView = pave.subarray(planOffset, planOffset + planeSize);

      for (let i = 0; i < planeSize; i++) {
        reconstructed[i] += planView[i];
      }
    }

    // Write back and clamp
    for (let i = 0; i < planeSize; i++) {
      newData[offset + i] = Math.max(0, Math.min(1, reconstructed[i]));
    }
  }

  logs.push(`Wavelet Noise Reduction complete.`);
  return { newData, logs };
}

/**
 * Richardson-Lucy Deconvolution
 * Performs iterative restoration using a Gaussian PSF model.
 * Includes local deringing star mask protection.
 */
export function executeRichardsonLucyDeconvolution(
  width: number,
  height: number,
  data: Float32Array,
  iterations: number = 10,
  psfSize: number = 5,
  psfSigma: number = 1.5,
  deringing: number = 0.5, // Deringing amount (0 = none, 1 = maximum star mask protection)
  deringingThreshold: number = 0.02 // Threshold above which pixels are considered stars
): { newData: Float32Array; logs: string[] } {
  const logs: string[] = [];
  logs.push(`Initializing Richardson-Lucy Deconvolution (${iterations} iterations, PSF size: ${psfSize}px, PSF σ: ${psfSigma.toFixed(2)})...`);

  const channels = data.length / (width * height);
  const planeSize = width * height;
  const newData = new Float32Array(data.length);

  // 1. Construct Gaussian PSF Kernel
  const kernel = new Float32Array(psfSize * psfSize);
  const half = Math.floor(psfSize / 2);
  let kernelSum = 0;
  for (let y = 0; y < psfSize; y++) {
    const dy = y - half;
    for (let x = 0; x < psfSize; x++) {
      const dx = x - half;
      const distSq = dx * dx + dy * dy;
      const val = Math.exp(-distSq / (2 * psfSigma * psfSigma));
      kernel[y * psfSize + x] = val;
      kernelSum += val;
    }
  }
  // Normalize PSF
  for (let i = 0; i < kernel.length; i++) {
    kernel[i] /= kernelSum;
  }

  // 2. Convolution helper
  const convolve = (src: Float32Array, dest: Float32Array) => {
    const kHalf = Math.floor(psfSize / 2);
    for (let c = 0; c < channels; c++) {
      const offset = c * planeSize;
      for (let y = 0; y < height; y++) {
        const rowOffset = offset + y * width;
        for (let x = 0; x < width; x++) {
          let sum = 0;
          for (let ky = 0; ky < psfSize; ky++) {
            const py = y + ky - kHalf;
            const clampY = py < 0 ? 0 : (py >= height ? height - 1 : py);
            const kernelRowOffset = offset + clampY * width;
            const kernelRowIndex = ky * psfSize;
            for (let kx = 0; kx < psfSize; kx++) {
              const px = x + kx - kHalf;
              const clampX = px < 0 ? 0 : (px >= width ? width - 1 : px);
              sum += src[kernelRowOffset + clampX] * kernel[kernelRowIndex + kx];
            }
          }
          dest[rowOffset + x] = sum;
        }
      }
    }
  };

  // 3. Deringing Star Mask
  const deringingMask = new Float32Array(planeSize);
  if (deringing > 0) {
    logs.push(`Generating local deringing mask (Threshold: ${deringingThreshold}, Strength: ${deringing})...`);
    
    // Find stars based on max value in any channel
    const rawMask = new Float32Array(planeSize);
    for (let i = 0; i < planeSize; i++) {
      let maxVal = 0;
      for (let c = 0; c < channels; c++) {
        const val = data[c * planeSize + i];
        if (val > maxVal && !isNaN(val) && isFinite(val)) {
          maxVal = val;
        }
      }
      if (maxVal > deringingThreshold) {
        rawMask[i] = 1.0;
      }
    }
    
    // Smooth the raw mask using a 5x5 box blur to cover surrounding halos
    const blurRadius = 2;
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        let maskSum = 0;
        let count = 0;
        for (let dy = -blurRadius; dy <= blurRadius; dy++) {
          const py = y + dy;
          if (py >= 0 && py < height) {
            const rowOffset = py * width;
            for (let dx = -blurRadius; dx <= blurRadius; dx++) {
              const px = x + dx;
              if (px >= 0 && px < width) {
                maskSum += rawMask[rowOffset + px];
                count++;
              }
            }
          }
        }
        deringingMask[y * width + x] = (maskSum / count) * deringing;
      }
    }
    logs.push(`> Deringing mask computed.`);
  }

  // 4. Richardson-Lucy Iterations
  let u = new Float32Array(data); // active estimate
  const nextU = new Float32Array(data.length);
  const cData = new Float32Array(data.length);
  const rData = new Float32Array(data.length);
  const gData = new Float32Array(data.length);

  logs.push(`Running ${iterations} deconvolution iterations...`);

  for (let t = 0; t < iterations; t++) {
    // c = u^t * P
    convolve(u, cData);

    // r = d / c
    for (let i = 0; i < data.length; i++) {
      rData[i] = data[i] / Math.max(1e-6, cData[i]);
    }

    // g = r * P (adjoint of Gaussian is Gaussian)
    convolve(rData, gData);

    // u^{t+1} = u^t * g (apply deringing mask)
    for (let c = 0; c < channels; c++) {
      const offset = c * planeSize;
      for (let i = 0; i < planeSize; i++) {
        const idx = offset + i;
        const dMaskVal = deringingMask[i];
        const correction = gData[idx] * (1.0 - dMaskVal) + 1.0 * dMaskVal;
        nextU[idx] = Math.max(0, Math.min(1, u[idx] * correction));
      }
    }

    u.set(nextU);
  }

  newData.set(u);
  logs.push(`Deconvolution complete.`);
  return { newData, logs };
}

/**
 * Histogram Transformation (HT / Permanent MTF Stretch)
 * Applies clipping limits and the Midtones Transfer Function (MTF) to FITS float data.
 */
export function executeHistogramTransformation(
  width: number,
  height: number,
  data: Float32Array,
  shadows: number = 0.0,
  highlights: number = 1.0,
  midtones: number = 0.5
): { newData: Float32Array; logs: string[] } {
  const logs: string[] = [];
  void width;
  void height;
  logs.push(`Initializing Histogram Transformation (Shadows: ${shadows.toFixed(4)}, Highlights: ${highlights.toFixed(4)}, Midtones: ${midtones.toFixed(4)})...`);

  const newData = new Float32Array(data.length);
  const mtfVal = (x: number, m: number): number => {
    if (x <= 0) return 0;
    if (x >= 1) return 1;
    m = Math.max(0.001, Math.min(0.999, m));
    if (m === 0.5) return x;
    return ((m - 1) * x) / ((2 * m - 1) * x - m);
  };

  const range = highlights - shadows || 1e-6;

  for (let i = 0; i < data.length; i++) {
    const val = data[i];
    if (isNaN(val) || !isFinite(val)) {
      newData[i] = 0.0;
      continue;
    }

    let norm = (val - shadows) / range;
    norm = Math.max(0.0, Math.min(1.0, norm));
    newData[i] = mtfVal(norm, midtones);
  }

  logs.push(`Histogram stretch applied successfully.`);
  return { newData, logs };
}

/**
 * Generalized Hyperbolic Stretch (GHS)
 * Stretches pixels around a customized symmetry point (SP) where stretch rate is maximized, protecting stars from blooming.
 */
export function executeGeneralizedHyperbolicStretch(
  width: number,
  height: number,
  data: Float32Array,
  sp: number = 0.01,
  d: number = 10.0
): { newData: Float32Array; logs: string[] } {
  const logs: string[] = [];
  void width;
  void height;
  logs.push(`Initializing Generalized Hyperbolic Stretch (SP: ${sp.toFixed(4)}, Strength D: ${d.toFixed(1)})...`);

  const newData = new Float32Array(data.length);
  const f0 = Math.asinh(-d * sp);
  const f1 = Math.asinh(d * (1.0 - sp)) - f0;

  if (Math.abs(f1) < 1e-10) {
    logs.push(`Error: Invalid GHS parameters (Symmetry Point or Strength values). Skipping.`);
    newData.set(data);
    return { newData, logs };
  }

  for (let i = 0; i < data.length; i++) {
    const val = data[i];
    if (isNaN(val) || !isFinite(val)) {
      newData[i] = 0.0;
      continue;
    }

    const clampVal = Math.max(0.0, Math.min(1.0, val));
    const fx = Math.asinh(d * (clampVal - sp)) - f0;
    const valOut = fx / f1;
    newData[i] = Math.max(0.0, Math.min(1.0, valOut));
  }

  logs.push(`GHS applied successfully.`);
  return { newData, logs };
}

/**
 * Masked Stretch (MSTRETCH)
 * Iteratively applies mild MTF stretches blended with an inverted luminance mask to protect stars and bright zones.
 */
export function executeMaskedStretch(
  width: number,
  height: number,
  data: Float32Array,
  targetMedian: number = 0.125,
  iterations: number = 6
): { newData: Float32Array; logs: string[] } {
  const logs: string[] = [];
  logs.push(`Initializing Masked Stretch (Target Median: ${targetMedian.toFixed(3)}, Iterations: ${iterations})...`);

  const planeSize = width * height;
  const channels = data.length / planeSize;
  const current = new Float32Array(data);
  const next = new Float32Array(data.length);

  const mtfVal = (x: number, m: number): number => {
    if (x <= 0) return 0;
    if (x >= 1) return 1;
    if (m === 0.5) return x;
    return ((m - 1) * x) / ((2 * m - 1) * x - m);
  };

  const getApproxMedian = (arr: Float32Array): number => {
    const sampleSize = Math.min(10000, arr.length);
    const stride = Math.max(1, Math.floor(arr.length / sampleSize));
    const sample = [];
    for (let i = 0; i < sampleSize; i++) {
      const v = arr[i * stride];
      if (!isNaN(v) && isFinite(v)) {
        sample.push(v);
      }
    }
    sample.sort((a, b) => a - b);
    return sample.length > 0 ? sample[Math.floor(sample.length / 2)] : 0.0;
  };

  for (let iter = 0; iter < iterations; iter++) {
    const currentMedian = getApproxMedian(current);
    logs.push(`> Iteration ${iter + 1}: current median: ${currentMedian.toFixed(4)}`);

    if (currentMedian >= targetMedian) {
      logs.push(`Target median reached early at iteration ${iter + 1}.`);
      break;
    }

    // A. Generate inverted luminance mask
    const mask = new Float32Array(planeSize);
    for (let i = 0; i < planeSize; i++) {
      let sum = 0;
      for (let c = 0; c < channels; c++) {
        sum += current[c * planeSize + i];
      }
      const val = sum / channels;
      mask[i] = Math.max(0.0, Math.min(1.0, 1.0 - val));
    }

    // B. Smooth mask with a 5x5 box blur
    const blurredMask = new Float32Array(planeSize);
    const r = 2;
    for (let y = 0; y < height; y++) {
      const rowOffset = y * width;
      for (let x = 0; x < width; x++) {
        let mSum = 0;
        let count = 0;
        for (let dy = -r; dy <= r; dy++) {
          const py = y + dy;
          if (py >= 0 && py < height) {
            const pRowOffset = py * width;
            for (let dx = -r; dx <= r; dx++) {
              const px = x + dx;
              if (px >= 0 && px < width) {
                mSum += mask[pRowOffset + px];
                count++;
              }
            }
          }
        }
        blurredMask[rowOffset + x] = mSum / count;
      }
    }

    // C. Apply MTF stretch blended with mask
    const m = 0.35;
    for (let c = 0; c < channels; c++) {
      const offset = c * planeSize;
      for (let i = 0; i < planeSize; i++) {
        const idx = offset + i;
        const val = current[idx];
        const mVal = blurredMask[i];
        const stretched = mtfVal(val, m);
        next[idx] = val * (1.0 - mVal) + stretched * mVal;
      }
    }

    current.set(next);
  }

  logs.push(`Masked Stretch completed successfully.`);
  return { newData: current, logs };
}

/**
 * Star Separation (Starless / Star Layer Decomposer)
 * Detects stars, creates a feathered star mask, and performs Laplace inpainting to separate stars from nebulosity.
 */
export function executeStarSeparation(
  width: number,
  height: number,
  data: Float32Array,
  detectThreshold: number = 3.0,
  maskExpansion: number = 3,
  featherSize: number = 2,
  inpaintIterations: number = 30,
  outputType: 'starless' | 'stars' = 'starless'
): { newData: Float32Array; logs: string[] } {
  const logs: string[] = [];
  logs.push(`Initializing Star Separation (Threshold: ${detectThreshold}σ, Expansion: ${maskExpansion}px, Feather: ${featherSize}px, Inpaint Iterations: ${inpaintIterations}, Output: ${outputType})...`);

  const planeSize = width * height;
  const channels = data.length / planeSize;

  // 1. Calculate basic statistics on average luminance to find stars
  const avgIntensity = new Float32Array(planeSize);
  for (let i = 0; i < planeSize; i++) {
    let sum = 0;
    for (let c = 0; c < channels; c++) {
      sum += data[c * planeSize + i];
    }
    avgIntensity[i] = sum / channels;
  }

  // Calculate robust stats of avgIntensity (using median and MAD)
  const validIntensity = avgIntensity.filter(val => !isNaN(val) && isFinite(val));
  const sorted = new Float32Array(validIntensity).sort();
  const medianVal = sorted[Math.floor(sorted.length / 2)] || 0.0;
  
  // Calculate MAD
  const absDev = new Float32Array(validIntensity.length);
  for (let i = 0; i < validIntensity.length; i++) {
    absDev[i] = Math.abs(validIntensity[i] - medianVal);
  }
  absDev.sort();
  const mad = absDev[Math.floor(absDev.length / 2)] || 1e-5;
  const sigma = mad * 1.4826;

  const starThreshold = medianVal + detectThreshold * sigma;
  logs.push(`> Sky median: ${medianVal.toFixed(5)}, Noise σ: ${sigma.toFixed(5)}, Star detection threshold: ${starThreshold.toFixed(5)}`);

  // 2. Local Maxima Detection in 5x5 window
  const mask = new Float32Array(planeSize);
  let starCount = 0;

  // Track star centers and radii
  interface DetectedStar {
    cx: number;
    cy: number;
    r: number;
  }
  const detectedStars: DetectedStar[] = [];

  const border = 5;
  for (let y = border; y < height - border; y++) {
    const rowOffset = y * width;
    for (let x = border; x < width - border; x++) {
      const idx = rowOffset + x;
      const val = avgIntensity[idx];
      if (val < starThreshold) continue;

      // Check if it is a local maximum in a 5x5 window
      let isMax = true;
      for (let dy = -2; dy <= 2; dy++) {
        const ny = y + dy;
        const nRowOffset = ny * width;
        for (let dx = -2; dx <= 2; dx++) {
          if (avgIntensity[nRowOffset + (x + dx)] > val) {
            isMax = false;
            break;
          }
        }
        if (!isMax) break;
      }

      if (isMax) {
        // Compute sub-pixel centroid in 5x5 window
        let sumIntensity = 0;
        let sumX = 0;
        let sumY = 0;
        let sumSqDist = 0;

        for (let dy = -2; dy <= 2; dy++) {
          const ny = y + dy;
          const nRowOffset = ny * width;
          for (let dx = -2; dx <= 2; dx++) {
            const nVal = avgIntensity[nRowOffset + (x + dx)];
            sumIntensity += nVal;
            sumX += (x + dx) * nVal;
            sumY += ny * nVal;
          }
        }

        if (sumIntensity > 0) {
          const cx = sumX / sumIntensity;
          const cy = sumY / sumIntensity;

          // Estimate FWHM radius
          for (let dy = -2; dy <= 2; dy++) {
            const ny = y + dy;
            const nRowOffset = ny * width;
            for (let dx = -2; dx <= 2; dx++) {
              const nVal = avgIntensity[nRowOffset + (x + dx)];
              const distSq = (x + dx - cx) * (x + dx - cx) + (ny - cy) * (ny - cy);
              sumSqDist += distSq * nVal;
            }
          }
          const stdDev = Math.sqrt(sumSqDist / sumIntensity);
          const fwhmRadius = stdDev * 2.355 / 2.0;

          // Keep radius reasonable
          const starRadius = Math.max(1.5, Math.min(12.0, fwhmRadius));
          detectedStars.push({ cx, cy, r: starRadius });
          starCount++;
        }
      }
    }
  }

  logs.push(`> Detected ${starCount} stars. Constructing star protection mask...`);

  // 3. Build feathered Star Mask
  for (const star of detectedStars) {
    const rx = Math.ceil(star.r * maskExpansion + featherSize);
    const minX = Math.max(0, Math.floor(star.cx - rx));
    const maxX = Math.min(width - 1, Math.ceil(star.cx + rx));
    const minY = Math.max(0, Math.floor(star.cy - rx));
    const maxY = Math.min(height - 1, Math.ceil(star.cy + rx));

    const coreRad = star.r * maskExpansion;
    const outerRad = coreRad + featherSize;

    for (let my = minY; my <= maxY; my++) {
      const rowOffset = my * width;
      const dy = my - star.cy;
      for (let mx = minX; mx <= maxX; mx++) {
        const dx = mx - star.cx;
        const dist = Math.sqrt(dx * dx + dy * dy);
        
        let maskValue = 0;
        if (dist <= coreRad) {
          maskValue = 1.0;
        } else if (dist < outerRad) {
          // Feather transition from 1.0 to 0.0
          maskValue = 1.0 - (dist - coreRad) / (outerRad - coreRad);
        }

        const idx = rowOffset + mx;
        if (maskValue > mask[idx]) {
          mask[idx] = maskValue;
        }
      }
    }
  }

  // 4. Laplace Inpainting for Starless Layer
  // S initialized as copy of original data
  const S = new Float32Array(data);
  const SNext = new Float32Array(data);

  logs.push(`> Performing Laplace inpainting (${inpaintIterations} iterations)...`);

  for (let iter = 0; iter < inpaintIterations; iter++) {
    for (let c = 0; c < channels; c++) {
      const cOffset = c * planeSize;
      
      for (let y = 1; y < height - 1; y++) {
        const rowOffset = y * width;
        for (let x = 1; x < width - 1; x++) {
          const idx = rowOffset + x;
          const maskVal = mask[idx];

          if (maskVal > 0.05) {
            // Harmonic average of 4 cardinal neighbors
            const avg = (
              S[cOffset + idx - 1] + 
              S[cOffset + idx + 1] + 
              S[cOffset + idx - width] + 
              S[cOffset + idx + width]
            ) * 0.25;

            // Blend based on mask value
            SNext[cOffset + idx] = S[cOffset + idx] * (1.0 - maskVal) + avg * maskVal;
          }
        }
      }
    }
    S.set(SNext);
  }

  // 5. Output Construction
  const newData = new Float32Array(data.length);
  if (outputType === 'starless') {
    newData.set(S);
    logs.push(`Star Separation complete. Retained Starless Layer.`);
  } else {
    // Star layer: Original - Starless (clamped to >= 0)
    for (let i = 0; i < data.length; i++) {
      newData[i] = Math.max(0.0, data[i] - S[i]);
    }
    logs.push(`Star Separation complete. Extracted Star Layer.`);
  }

  return { newData, logs };
}

/**
 * Star Reduction (Selective Shrinking)
 * Shrinks stars either by scaling down the isolated star layer or applying local morphological filters.
 */
export function executeStarReduction(
  width: number,
  height: number,
  data: Float32Array,
  detectThreshold: number = 3.0,
  maskExpansion: number = 3,
  featherSize: number = 2,
  amount: number = 0.5,
  method: 'scaling' | 'morphological' = 'scaling'
): { newData: Float32Array; logs: string[] } {
  const logs: string[] = [];
  logs.push(`Initializing Star Reduction (Method: ${method}, Amount: ${(amount * 100).toFixed(0)}%, Threshold: ${detectThreshold}σ, Expansion: ${maskExpansion}px)...`);

  const planeSize = width * height;
  const channels = data.length / planeSize;

  if (method === 'scaling') {
    // 1. Separate stars into Starless (S) and Star Layer (Original - S)
    // We run 30 iterations of Laplace inpainting
    logs.push(`Running Star Separation under the hood for scaling reduction...`);
    const sep = executeStarSeparation(
      width, height, data, detectThreshold, maskExpansion, featherSize, 30, 'starless'
    );
    
    const starless = sep.newData;
    const newData = new Float32Array(data.length);
    
    // 2. Recombine: Starless + (1.0 - amount) * Stars
    for (let i = 0; i < data.length; i++) {
      const orig = data[i];
      const sl = starless[i];
      const starVal = Math.max(0.0, orig - sl);
      newData[i] = Math.max(0.0, Math.min(1.0, sl + starVal * (1.0 - amount)));
    }
    
    logs.push(`Star Reduction via scaling complete.`);
    return { newData, logs };
  } else {
    // Morphological reduction
    // 1. We must construct the star mask first (similar to separation)
    const avgIntensity = new Float32Array(planeSize);
    for (let i = 0; i < planeSize; i++) {
      let sum = 0;
      for (let c = 0; c < channels; c++) {
        sum += data[c * planeSize + i];
      }
      avgIntensity[i] = sum / channels;
    }

    const validIntensity = avgIntensity.filter(val => !isNaN(val) && isFinite(val));
    const sorted = new Float32Array(validIntensity).sort();
    const medianVal = sorted[Math.floor(sorted.length / 2)] || 0.0;
    
    const absDev = new Float32Array(validIntensity.length);
    for (let i = 0; i < validIntensity.length; i++) {
      absDev[i] = Math.abs(validIntensity[i] - medianVal);
    }
    absDev.sort();
    const mad = absDev[Math.floor(absDev.length / 2)] || 1e-5;
    const sigma = mad * 1.4826;
    const starThreshold = medianVal + detectThreshold * sigma;

    interface DetectedStar {
      cx: number;
      cy: number;
      r: number;
    }
    const detectedStars: DetectedStar[] = [];
    const border = 5;
    for (let y = border; y < height - border; y++) {
      const rowOffset = y * width;
      for (let x = border; x < width - border; x++) {
        const idx = rowOffset + x;
        if (avgIntensity[idx] < starThreshold) continue;

        let isMax = true;
        for (let dy = -2; dy <= 2; dy++) {
          const ny = y + dy;
          const nRowOffset = ny * width;
          for (let dx = -2; dx <= 2; dx++) {
            if (avgIntensity[nRowOffset + (x + dx)] > avgIntensity[idx]) {
              isMax = false;
              break;
            }
          }
          if (!isMax) break;
        }

        if (isMax) {
          let sumIntensity = 0;
          let sumX = 0;
          let sumY = 0;
          let sumSqDist = 0;
          for (let dy = -2; dy <= 2; dy++) {
            const ny = y + dy;
            const nRowOffset = ny * width;
            for (let dx = -2; dx <= 2; dx++) {
              const nVal = avgIntensity[nRowOffset + (x + dx)];
              sumIntensity += nVal;
              sumX += (x + dx) * nVal;
              sumY += ny * nVal;
            }
          }
          if (sumIntensity > 0) {
            const cx = sumX / sumIntensity;
            const cy = sumY / sumIntensity;
            for (let dy = -2; dy <= 2; dy++) {
              const ny = y + dy;
              const nRowOffset = ny * width;
              for (let dx = -2; dx <= 2; dx++) {
                const nVal = avgIntensity[nRowOffset + (x + dx)];
                sumSqDist += ((x + dx - cx) * (x + dx - cx) + (ny - cy) * (ny - cy)) * nVal;
              }
            }
            const stdDev = Math.sqrt(sumSqDist / sumIntensity);
            detectedStars.push({ cx, cy, r: Math.max(1.5, Math.min(12.0, stdDev * 2.355 / 2.0)) });
          }
        }
      }
    }

    const mask = new Float32Array(planeSize);
    for (const star of detectedStars) {
      const rx = Math.ceil(star.r * maskExpansion + featherSize);
      const minX = Math.max(0, Math.floor(star.cx - rx));
      const maxX = Math.min(width - 1, Math.ceil(star.cx + rx));
      const minY = Math.max(0, Math.floor(star.cy - rx));
      const maxY = Math.min(height - 1, Math.ceil(star.cy + rx));
      const coreRad = star.r * maskExpansion;
      const outerRad = coreRad + featherSize;

      for (let my = minY; my <= maxY; my++) {
        const rowOffset = my * width;
        const dy = my - star.cy;
        for (let mx = minX; mx <= maxX; mx++) {
          const dx = mx - star.cx;
          const dist = Math.sqrt(dx * dx + dy * dy);
          let val = 0;
          if (dist <= coreRad) val = 1.0;
          else if (dist < outerRad) val = 1.0 - (dist - coreRad) / (outerRad - coreRad);
          const idx = rowOffset + mx;
          if (val > mask[idx]) mask[idx] = val;
        }
      }
    }

    // 2. Perform Morphological Min/Median Erosion
    const newData = new Float32Array(data.length);
    newData.set(data);

    for (let c = 0; c < channels; c++) {
      const cOffset = c * planeSize;
      
      for (let y = 1; y < height - 1; y++) {
        const rowOffset = y * width;
        for (let x = 1; x < width - 1; x++) {
          const idx = rowOffset + x;
          const maskVal = mask[idx];
          if (maskVal > 0.05) {
            // Find local minimum and median in 3x3 window
            const neighbors: number[] = [];
            let minVal = Infinity;
            for (let dy = -1; dy <= 1; dy++) {
              const ny = y + dy;
              const nRowOffset = ny * width;
              for (let dx = -1; dx <= 1; dx++) {
                const val = data[cOffset + nRowOffset + (x + dx)];
                neighbors.push(val);
                if (val < minVal) minVal = val;
              }
            }
            neighbors.sort((a, b) => a - b);
            const medianVal = neighbors[4]; // center element of 9 sorted items

            // Morph target is 50% min, 50% median
            const morphTarget = 0.5 * minVal + 0.5 * medianVal;
            
            // Blend
            newData[cOffset + idx] = data[cOffset + idx] * (1.0 - amount * maskVal) + morphTarget * (amount * maskVal);
          }
        }
      }
    }

    logs.push(`Star Reduction via morphological erosion complete.`);
    return { newData, logs };
  }
}

/**
 * Contrast Limited Adaptive Histogram Equalization (CLAHE)
 * Divides the image into a grid of tiles, clips local histograms to limit contrast,
 * and interpolates bilinearly on the luminance channel.
 */
export function executeCLAHE(
  width: number,
  height: number,
  data: Float32Array,
  clipLimit: number = 2.5,
  gridSize: number = 8
): { newData: Float32Array; logs: string[] } {
  const logs: string[] = [];
  logs.push(`Initializing CLAHE (Clip Limit: ${clipLimit.toFixed(1)}, Grid Size: ${gridSize}x${gridSize})...`);

  const planeSize = width * height;
  const channels = data.length / planeSize;
  const newData = new Float32Array(data.length);

  // 1. Calculate luminance channel
  const luminance = new Float32Array(planeSize);
  if (channels >= 3) {
    for (let i = 0; i < planeSize; i++) {
      const r = data[i];
      const g = data[planeSize + i];
      const b = data[planeSize * 2 + i];
      luminance[i] = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    }
  } else {
    luminance.set(data.subarray(0, planeSize));
  }

  // 2. Divide into grid tiles
  gridSize = Math.min(gridSize, width, height);
  if (gridSize < 1) gridSize = 1;
  const tileSizeX = Math.floor(width / gridSize);
  const tileSizeY = Math.floor(height / gridSize);

  // Pre-calculate tile boundaries
  const tileWidths = new Int32Array(gridSize);
  const tileHeights = new Int32Array(gridSize);
  const tileStartX = new Int32Array(gridSize);
  const tileStartY = new Int32Array(gridSize);

  for (let i = 0; i < gridSize; i++) {
    tileStartX[i] = i * tileSizeX;
    tileWidths[i] = (i === gridSize - 1) ? (width - tileStartX[i]) : tileSizeX;
    tileStartY[i] = i * tileSizeY;
    tileHeights[i] = (i === gridSize - 1) ? (height - tileStartY[i]) : tileSizeY;
  }

  // 3. Compute CDFs for all tiles
  const tileCDFs: Float32Array[] = [];
  for (let ty = 0; ty < gridSize; ty++) {
    const sY = tileStartY[ty];
    const tH = tileHeights[ty];

    for (let tx = 0; tx < gridSize; tx++) {
      const sX = tileStartX[tx];
      const tW = tileWidths[tx];

      // Compute local histogram (256 bins)
      const hist = new Int32Array(256);
      for (let y = 0; y < tH; y++) {
        const rowOffset = (sY + y) * width;
        for (let x = 0; x < tW; x++) {
          const val = luminance[rowOffset + (sX + x)];
          const bin = Math.max(0, Math.min(255, Math.floor(val * 255)));
          hist[bin]++;
        }
      }

      // Clip local histogram
      const totalPixels = tW * tH;
      const limit = Math.max(1, Math.floor((clipLimit * totalPixels) / 256));
      
      let excess = 0;
      for (let i = 0; i < 256; i++) {
        if (hist[i] > limit) {
          excess += hist[i] - limit;
          hist[i] = limit;
        }
      }

      // Redistribute excess count uniformly
      const add = Math.floor(excess / 256);
      const rem = excess % 256;
      for (let i = 0; i < 256; i++) {
        hist[i] += add;
      }
      for (let i = 0; i < rem; i++) {
        hist[i]++;
      }

      // Compute local CDF
      const cdf = new Float32Array(256);
      let cumulativeSum = 0;
      for (let i = 0; i < 256; i++) {
        cumulativeSum += hist[i];
        cdf[i] = cumulativeSum / totalPixels;
      }

      tileCDFs.push(cdf);
    }
  }

  logs.push(`> Computed local histograms and CDF distributions for ${gridSize * gridSize} tiles.`);

  // 4. Bilinear Interpolation for each pixel
  const newLuminance = new Float32Array(planeSize);
  for (let y = 0; y < height; y++) {
    const rowOffset = y * width;
    
    // Find the surrounding tile rows in Y
    const tyFloat = (y - tileSizeY / 2) / tileSizeY;
    const ty1 = Math.floor(tyFloat);
    const ty2 = ty1 + 1;

    const yFraction = tyFloat - ty1;

    const cty1 = Math.max(0, Math.min(gridSize - 1, ty1));
    const cty2 = Math.max(0, Math.min(gridSize - 1, ty2));

    for (let x = 0; x < width; x++) {
      const idx = rowOffset + x;
      const val = luminance[idx];
      const bin = Math.max(0, Math.min(255, Math.floor(val * 255)));

      // Find surrounding tile columns in X
      const txFloat = (x - tileSizeX / 2) / tileSizeX;
      const tx1 = Math.floor(txFloat);
      const tx2 = tx1 + 1;

      const xFraction = txFloat - tx1;

      const ctx1 = Math.max(0, Math.min(gridSize - 1, tx1));
      const ctx2 = Math.max(0, Math.min(gridSize - 1, tx2));

      // Retrieve values from the 4 surrounding tile CDFs
      const valTL = tileCDFs[cty1 * gridSize + ctx1][bin];
      const valTR = tileCDFs[cty1 * gridSize + ctx2][bin];
      const valBL = tileCDFs[cty2 * gridSize + ctx1][bin];
      const valBR = tileCDFs[cty2 * gridSize + ctx2][bin];

      // Bilinear interpolation
      const valTop = valTL * (1.0 - xFraction) + valTR * xFraction;
      const valBottom = valBL * (1.0 - xFraction) + valBR * xFraction;
      const finalVal = valTop * (1.0 - yFraction) + valBottom * yFraction;

      newLuminance[idx] = finalVal;
    }
  }

  // 5. Restore color channels using the new luminance
  if (channels >= 3) {
    const redOffset = 0;
    const greenOffset = planeSize;
    const blueOffset = planeSize * 2;

    for (let i = 0; i < planeSize; i++) {
      const oldL = luminance[i];
      const newL = newLuminance[i];
      const ratio = oldL > 1e-6 ? (newL / oldL) : 0;

      newData[redOffset + i] = Math.max(0.0, Math.min(1.0, data[redOffset + i] * ratio));
      newData[greenOffset + i] = Math.max(0.0, Math.min(1.0, data[greenOffset + i] * ratio));
      newData[blueOffset + i] = Math.max(0.0, Math.min(1.0, data[blueOffset + i] * ratio));
    }
  } else {
    newData.set(newLuminance);
  }

  logs.push(`CLAHE execution complete.`);
  return { newData, logs };
}

/**
 * Multiscale Detail Enhancement (Wavelet Contrast)
 * Decomposes luminance, multiplies detail layer coefficients by scale biases,
 * gates noise using MAD thresholds, and reconstructs.
 */
export function executeMultiscaleWaveletContrast(
  width: number,
  height: number,
  data: Float32Array,
  biases: number[] = [1.2, 1.15, 1.1, 1.0, 1.0],
  noiseThreshold: number = 2.0,
  amount: number = 1.0,
  typeTransform: number = 2
): { newData: Float32Array; logs: string[] } {
  const logs: string[] = [];
  const getKernelName = (type: number): string => {
    switch (type) {
      case 1: return 'Linear';
      case 2: return 'B3-Spline';
      case 3: return 'Gaussian (5x5)';
      case 4: return 'Box/Haar (3x3)';
      case 5: return 'Cubic Spline (7x7)';
      default: return 'B3-Spline';
    }
  };
  logs.push(`Initializing Multiscale Wavelet Contrast (Biases: ${biases.join(', ')}, Noise Threshold: ${noiseThreshold}σ, Amount: ${(amount * 100).toFixed(0)}%, Kernel: ${getKernelName(typeTransform)})...`);

  const planeSize = width * height;
  const channels = data.length / planeSize;
  const newData = new Float32Array(data.length);

  // 1. Extract luminance channel
  const luminance = new Float32Array(planeSize);
  if (channels >= 3) {
    for (let i = 0; i < planeSize; i++) {
      luminance[i] = 0.2126 * data[i] + 0.7152 * data[planeSize + i] + 0.0722 * data[planeSize * 2 + i];
    }
  } else {
    luminance.set(data.subarray(0, planeSize));
  }

  // 2. Perform Wavelet à trous decomposition (using Bspline by default)
  const nbrPlan = biases.length + 1; // last plan is residue
  const pave = new Float32Array(planeSize * nbrPlan);
  let smooth = new Float32Array(luminance);

  for (let plan = 0; plan < nbrPlan - 1; plan++) {
    const planOffset = plan * planeSize;
    pave.set(smooth, planOffset);

    const nextSmooth = new Float32Array(planeSize);
    const step = Math.pow(2, plan);
    pave2dSmooth(smooth, nextSmooth, width, height, step, typeTransform);

    // Compute detail: Detail = smooth - nextSmooth
    const planView = pave.subarray(planOffset, planOffset + planeSize);
    for (let i = 0; i < planeSize; i++) {
      planView[i] -= nextSmooth[i];
    }
    smooth = nextSmooth;
  }
  
  // Set residue as the last layer
  pave.set(smooth, (nbrPlan - 1) * planeSize);

  // 3. Apply scale bias and noise-threshold gating
  for (let plan = 0; plan < nbrPlan - 1; plan++) {
    const planOffset = plan * planeSize;
    const planView = pave.subarray(planOffset, planOffset + planeSize);
    
    // Estimate noise scale sigma via MAD
    const stats = calculateStats(planView);
    const sigma = stats.mad * 1.4826;
    const T = noiseThreshold * sigma;

    const bias = biases[plan] !== undefined ? biases[plan] : 1.0;

    logs.push(`> Scale ${plan + 1} (${Math.pow(2, plan)}px) - estimated noise σ: ${sigma.toFixed(5)}, threshold: ${T.toFixed(5)}, bias: ${bias.toFixed(3)}`);

    if (bias !== 1.0) {
      for (let i = 0; i < planeSize; i++) {
        const val = planView[i];
        const absVal = Math.abs(val);

        // Gate: only enhance if coefficient is above noise threshold
        if (absVal > T) {
          // Boost coefficient by bias, scaled by total amount
          const scale = 1.0 + (bias - 1.0) * amount;
          planView[i] = val * scale;
        }
      }
    }
  }

  // 4. Reconstruction
  const newLuminance = new Float32Array(planeSize);
  for (let plan = 0; plan < nbrPlan; plan++) {
    const planOffset = plan * planeSize;
    const planView = pave.subarray(planOffset, planOffset + planeSize);
    for (let i = 0; i < planeSize; i++) {
      newLuminance[i] += planView[i];
    }
  }

  // 5. Restore color channels
  if (channels >= 3) {
    const redOffset = 0;
    const greenOffset = planeSize;
    const blueOffset = planeSize * 2;

    for (let i = 0; i < planeSize; i++) {
      const oldL = luminance[i];
      const newL = newLuminance[i];
      const ratio = oldL > 1e-6 ? (newL / oldL) : 0;

      newData[redOffset + i] = Math.max(0.0, Math.min(1.0, data[redOffset + i] * ratio));
      newData[greenOffset + i] = Math.max(0.0, Math.min(1.0, data[greenOffset + i] * ratio));
      newData[blueOffset + i] = Math.max(0.0, Math.min(1.0, data[blueOffset + i] * ratio));
    }
  } else {
    for (let i = 0; i < planeSize; i++) {
      newData[i] = Math.max(0.0, Math.min(1.0, newLuminance[i]));
    }
  }

  logs.push(`Wavelet Local Contrast enhancement complete.`);
  return { newData, logs };
}

/**
 * Final Star Correction (Saturation recovery and Ringing repair)
 * Restores star color to saturated white cores and suppresses dark halos.
 */
export function executeFinalStarCorrection(
  width: number,
  height: number,
  data: Float32Array,
  detectThreshold: number = 3.0,
  maskExpansion: number = 3,
  featherSize: number = 2,
  restoreColor: boolean = true,
  repairRinging: boolean = true
): { newData: Float32Array; logs: string[] } {
  const logs: string[] = [];
  logs.push(`Initializing Final Star Correction (Restore Color: ${restoreColor}, Repair Ringing: ${repairRinging}, Threshold: ${detectThreshold}σ, Expansion: ${maskExpansion}px)...`);

  const planeSize = width * height;
  const channels = data.length / planeSize;
  const newData = new Float32Array(data);

  // 1. Compute stats on luminance to build the star mask
  const avgIntensity = new Float32Array(planeSize);
  for (let i = 0; i < planeSize; i++) {
    let sum = 0;
    for (let c = 0; c < channels; c++) {
      sum += data[c * planeSize + i];
    }
    avgIntensity[i] = sum / channels;
  }

  const validIntensity = avgIntensity.filter(val => !isNaN(val) && isFinite(val));
  const sorted = new Float32Array(validIntensity).sort();
  const medianVal = sorted[Math.floor(sorted.length / 2)] || 0.0;
  
  const absDev = new Float32Array(validIntensity.length);
  for (let i = 0; i < validIntensity.length; i++) {
    absDev[i] = Math.abs(validIntensity[i] - medianVal);
  }
  absDev.sort();
  const mad = absDev[Math.floor(absDev.length / 2)] || 1e-5;
  const sigma = mad * 1.4826;

  const starThreshold = medianVal + detectThreshold * sigma;
  logs.push(`> Sky background median: ${medianVal.toFixed(5)}, Noise σ: ${sigma.toFixed(5)}`);

  // 2. Star Detection in 5x5 window
  interface DetectedStar {
    cx: number;
    cy: number;
    r: number;
  }
  const detectedStars: DetectedStar[] = [];
  const border = 5;

  for (let y = border; y < height - border; y++) {
    const rowOffset = y * width;
    for (let x = border; x < width - border; x++) {
      const idx = rowOffset + x;
      if (avgIntensity[idx] < starThreshold) continue;

      let isMax = true;
      for (let dy = -2; dy <= 2; dy++) {
        const ny = y + dy;
        const nRowOffset = ny * width;
        for (let dx = -2; dx <= 2; dx++) {
          if (avgIntensity[nRowOffset + (x + dx)] > avgIntensity[idx]) {
            isMax = false;
            break;
          }
        }
        if (!isMax) break;
      }

      if (isMax) {
        let sumIntensity = 0;
        let sumX = 0;
        let sumY = 0;
        let sumSqDist = 0;

        for (let dy = -2; dy <= 2; dy++) {
          const ny = y + dy;
          const nRowOffset = ny * width;
          for (let dx = -2; dx <= 2; dx++) {
            const nVal = avgIntensity[nRowOffset + (x + dx)];
            sumIntensity += nVal;
            sumX += (x + dx) * nVal;
            sumY += ny * nVal;
          }
        }

        if (sumIntensity > 0) {
          const cx = sumX / sumIntensity;
          const cy = sumY / sumIntensity;

          for (let dy = -2; dy <= 2; dy++) {
            const ny = y + dy;
            const nRowOffset = ny * width;
            for (let dx = -2; dx <= 2; dx++) {
              const nVal = avgIntensity[nRowOffset + (x + dx)];
              sumSqDist += ((x + dx - cx) * (x + dx - cx) + (ny - cy) * (ny - cy)) * nVal;
            }
          }

          const stdDev = Math.sqrt(sumSqDist / sumIntensity);
          detectedStars.push({ cx, cy, r: Math.max(1.5, Math.min(12.0, stdDev * 2.355 / 2.0)) });
        }
      }
    }
  }

  // 3. Create Star Mask
  const mask = new Float32Array(planeSize);
  for (const star of detectedStars) {
    const rx = Math.ceil(star.r * maskExpansion + featherSize);
    const minX = Math.max(0, Math.floor(star.cx - rx));
    const maxX = Math.min(width - 1, Math.ceil(star.cx + rx));
    const minY = Math.max(0, Math.floor(star.cy - rx));
    const maxY = Math.min(height - 1, Math.ceil(star.cy + rx));

    const coreRad = star.r * maskExpansion;
    const outerRad = coreRad + featherSize;

    for (let my = minY; my <= maxY; my++) {
      const rowOffset = my * width;
      const dy = my - star.cy;
      for (let mx = minX; mx <= maxX; mx++) {
        const dx = mx - star.cx;
        const dist = Math.sqrt(dx * dx + dy * dy);

        let val = 0;
        if (dist <= coreRad) val = 1.0;
        else if (dist < outerRad) val = 1.0 - (dist - coreRad) / (outerRad - coreRad);

        const idx = rowOffset + mx;
        if (val > mask[idx]) mask[idx] = val;
      }
    }
  }

  logs.push(`> Built star mask for ${detectedStars.length} stars.`);

  // 4. Color Recovery in Saturated Star Cores
  if (restoreColor && channels >= 3) {
    let recoveredCount = 0;
    const rOffset = 0;
    const gOffset = planeSize;
    const bOffset = planeSize * 2;

    for (let y = 0; y < height; y++) {
      const rowOffset = y * width;
      for (let x = 0; x < width; x++) {
        const idx = rowOffset + x;
        
        // Skip pixels outside the star mask
        if (mask[idx] <= 0.05) continue;

        // Check for saturation
        const rVal = data[rOffset + idx];
        const gVal = data[gOffset + idx];
        const bVal = data[bOffset + idx];

        if (rVal >= 0.95 || gVal >= 0.95 || bVal >= 0.95) {
          // Saturated core pixel! Search radially for nearest unsaturated pixel inside star boundary
          let found = false;
          let bestR = 1.0, bestG = 1.0, bestB = 1.0;

          // Search radial circles
          for (let r = 1; r <= 6; r++) {
            for (let dy = -r; dy <= r; dy++) {
              const ny = y + dy;
              if (ny < 0 || ny >= height) continue;
              const nRowOffset = ny * width;

              const dxLimit = Math.round(Math.sqrt(r * r - dy * dy));
              for (let dx = -dxLimit; dx <= dxLimit; dx++) {
                const nx = x + dx;
                if (nx < 0 || nx >= width) continue;

                const nIdx = nRowOffset + nx;
                
                // Must be inside star boundary, but not saturated
                if (mask[nIdx] > 0.05) {
                  const nr = data[rOffset + nIdx];
                  const ng = data[gOffset + nIdx];
                  const nb = data[bOffset + nIdx];

                  if (nr < 0.95 && ng < 0.95 && nb < 0.95 && (nr > 0.05 || ng > 0.05 || nb > 0.05)) {
                    bestR = nr;
                    bestG = ng;
                    bestB = nb;
                    found = true;
                    break;
                  }
                }
              }
              if (found) break;
            }
            if (found) break;
          }

          if (found) {
            const sumQ = bestR + bestG + bestB;
            const sumP = rVal + gVal + bVal;

            if (sumQ > 0.01) {
              const cr = bestR / sumQ;
              const cg = bestG / sumQ;
              const cb = bestB / sumQ;

              // Restore ratio keeping the total brightness
              newData[rOffset + idx] = Math.max(0.0, Math.min(1.0, sumP * cr));
              newData[gOffset + idx] = Math.max(0.0, Math.min(1.0, sumP * cg));
              newData[bOffset + idx] = Math.max(0.0, Math.min(1.0, sumP * cb));
              recoveredCount++;
            }
          }
        }
      }
    }
    logs.push(`> Restored colors in ${recoveredCount} saturated star core pixels.`);
  }

  // 5. Suppress Dark Ringing Artifacts (Undershoots)
  if (repairRinging) {
    let repairedCount = 0;

    for (let c = 0; c < channels; c++) {
      const cOffset = c * planeSize;

      for (let y = 3; y < height - 3; y++) {
        const rowOffset = y * width;
        for (let x = 3; x < width - 3; x++) {
          const idx = rowOffset + x;
          const maskVal = mask[idx];

          if (maskVal <= 0.05) continue;

          // Saturated pixels shouldn't have ringing, only the halo region does
          const pixelVal = newData[cOffset + idx];

          // Compute local background median in 7x7 neighborhood, excluding star pixels (mask > 0.05)
          const bgSamples: number[] = [];
          for (let dy = -3; dy <= 3; dy++) {
            const ny = y + dy;
            const nRowOffset = ny * width;
            for (let dx = -3; dx <= 3; dx++) {
              const nIdx = nRowOffset + (x + dx);
              if (mask[nIdx] < 0.05) {
                bgSamples.push(data[cOffset + nIdx]);
              }
            }
          }

          let localBg = medianVal;
          if (bgSamples.length > 0) {
            bgSamples.sort((a, b) => a - b);
            localBg = bgSamples[Math.floor(bgSamples.length / 2)];
          }

          // If pixel value is below local background, it is a ringing artifact (undershoot)
          if (pixelVal < localBg) {
            const diff = localBg - pixelVal;
            // Smoothly lift the pixel value to background level using mask weight
            newData[cOffset + idx] = pixelVal + diff * maskVal;
            repairedCount++;
          }
        }
      }
    }
    logs.push(`> Repaired ringing/undershoots in ${repairedCount} pixels.`);
  }

  logs.push(`Final Star Correction complete.`);
  return { newData, logs };
}

// ─── Channel Combination ──────────────────────────────────────────────────────

/**
 * Combine separate mono Float32 planes into a 3-channel color FITS.
 *
 * mode:
 *  'RGB'  – straight R/G/B assignment (also used for L = copy to all channels)
 *  'HOO'  – Hubble-like: Ha → R, OIII → G+B
 *  'SHO'  – Hubble Palette: SII → R, Ha → G, OIII → B
 *  'LRGB' – Luminance + RGB: mix L into RGB via luminance weight
 *
 * Each source Float32Array should be mono (len = width * height).
 * Missing channels are zero-filled.
 */
export function combineFitsChannels(
  width: number,
  height: number,
  opts: {
    mode: 'RGB' | 'HOO' | 'SHO' | 'LRGB';
    rOrHa?: Float32Array | null;   // R (RGB/LRGB) or Ha (HOO/SHO)
    gOrOiii?: Float32Array | null; // G (RGB/LRGB) or OIII (HOO)
    bOrSii?: Float32Array | null;  // B (RGB/LRGB) or SII (SHO)
    lum?: Float32Array | null;     // L channel (LRGB only)
    oiii?: Float32Array | null;    // OIII for SHO
    lumWeight?: number;            // 0-1, how much luminance dominates (LRGB)
  }
): { newData: Float32Array } {
  const len = width * height;
  const newData = new Float32Array(len * 3);

  const zero = new Float32Array(len); // reusable zero plane

  const { mode, rOrHa, gOrOiii, bOrSii, lum, oiii, lumWeight = 0.5 } = opts;
  const src1 = (rOrHa && rOrHa.length >= len) ? rOrHa : zero;
  const src2 = (gOrOiii && gOrOiii.length >= len) ? gOrOiii : zero;
  const src3 = (bOrSii && bOrSii.length >= len) ? bOrSii : zero;
  const srcL = (lum && lum.length >= len) ? lum : zero;
  const srcO = (oiii && oiii.length >= len) ? oiii : zero;

  if (mode === 'HOO') {
    // Ha → R, OIII → G, OIII → B
    for (let i = 0; i < len; i++) {
      newData[i]           = Math.max(0, Math.min(1, src1[i]));  // R = Ha
      newData[len + i]     = Math.max(0, Math.min(1, src2[i]));  // G = OIII
      newData[len * 2 + i] = Math.max(0, Math.min(1, src2[i]));  // B = OIII
    }
  } else if (mode === 'SHO') {
    // SII → R, Ha → G, OIII → B
    for (let i = 0; i < len; i++) {
      newData[i]           = Math.max(0, Math.min(1, src3[i]));  // R = SII
      newData[len + i]     = Math.max(0, Math.min(1, src1[i]));  // G = Ha
      newData[len * 2 + i] = Math.max(0, Math.min(1, srcO[i]));  // B = OIII
    }
  } else if (mode === 'LRGB') {
    // Apply luminance via CIE Lab-style: replace Luma while preserving chroma
    const lw = Math.max(0, Math.min(1, lumWeight));
    for (let i = 0; i < len; i++) {
      const r = src1[i], g = src2[i], b = src3[i];
      const l = srcL[i];
      // Luma of color image
      const yRGB = 0.2126 * r + 0.7152 * g + 0.0722 * b;
      // Scale chroma to match new luminance
      const scale = yRGB > 1e-6 ? l / yRGB : 1.0;
      const blendedScale = 1.0 + (scale - 1.0) * lw;
      newData[i]           = Math.max(0, Math.min(1, r * blendedScale));
      newData[len + i]     = Math.max(0, Math.min(1, g * blendedScale));
      newData[len * 2 + i] = Math.max(0, Math.min(1, b * blendedScale));
    }
  } else {
    // RGB – straight assignment
    for (let i = 0; i < len; i++) {
      newData[i]           = Math.max(0, Math.min(1, src1[i]));
      newData[len + i]     = Math.max(0, Math.min(1, src2[i]));
      newData[len * 2 + i] = Math.max(0, Math.min(1, src3[i]));
    }
  }

  return { newData };
}


