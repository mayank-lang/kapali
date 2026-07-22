import { calculateStats } from './stretch';

/**
 * Native TypeScript implementation of Dynamic Background Extraction (Linear Planar Fit),
 * inspired by Siril's background_extraction.c.
 * Supports both color (multi-channel) and monochrome images.
 */
export function executeDynamicBackgroundExtraction(
  width: number, 
  height: number, 
  data: Float32Array,
  tolerance: number = 1.5,
  gridSize: number = 10
): { newData: Float32Array, logs: string[] } {
  
  const logs: string[] = [];
  logs.push(`Initializing DBE (Degree 1 Polynomial Planar Fit)...`);
  
  const channels = data.length / (width * height);
  const planeSize = width * height;
  const newData = new Float32Array(data.length);
  
  // Grid parameters
  const stepX = Math.floor(width / gridSize);
  const stepY = Math.floor(height / gridSize);
  const boxSize = Math.floor(Math.min(stepX, stepY) / 4) || 4; // sample box size

  logs.push(`Generating ${gridSize}x${gridSize} sample grid (Box size: ${boxSize}px) for ${channels.toFixed(0)} channel(s)...`);

  for (let c = 0; c < channels; c++) {
    const offset = c * planeSize;
    const chanData = data.subarray(offset, offset + planeSize);
    
    // Stats for this channel
    const chanStats = calculateStats(chanData);
    const chanMedian = chanStats.median;
    const chanMad = chanStats.mad;
    
    const samples: { x: number, y: number, z: number }[] = [];

    for (let gy = 0; gy < gridSize; gy++) {
      for (let gx = 0; gx < gridSize; gx++) {
        const cx = Math.floor(gx * stepX + stepX / 2);
        const cy = Math.floor(gy * stepY + stepY / 2);
        
        // Calculate median of this box
        const boxVals: number[] = [];
        for (let dy = -boxSize; dy <= boxSize; dy++) {
          for (let dx = -boxSize; dx <= boxSize; dx++) {
            const py = cy + dy;
            const px = cx + dx;
            if (px >= 0 && px < width && py >= 0 && py < height) {
              boxVals.push(chanData[py * width + px]);
            }
          }
        }
        
        if (boxVals.length > 0) {
          boxVals.sort((a, b) => a - b);
          const boxMedian = boxVals[Math.floor(boxVals.length / 2)];
          
          // Rejection heuristic: If box median is too high, it's on a nebula or bright star
          if (Math.abs(boxMedian - chanMedian) < tolerance * chanMad * 10) {
            samples.push({ x: cx, y: cy, z: boxMedian });
          }
        }
      }
    }

    logs.push(`[Channel ${c}] Retained ${samples.length} valid background samples after outlier rejection.`);

    if (samples.length < 3) {
      logs.push(`[Channel ${c}] Warning: Not enough valid samples to fit a plane. Skipping subtraction.`);
      newData.set(chanData, offset);
      continue;
    }

    // Ordinary Least Squares (OLS) for z = ax + by + c
    // We solve (X^T X) * B = X^T Z
    let Sxx = 0, Syy = 0, Sxy = 0, Sxz = 0, Syz = 0, Sx = 0, Sy = 0, Sz = 0;
    const N = samples.length;

    for (const s of samples) {
      Sx += s.x;
      Sy += s.y;
      Sz += s.z;
      Sxx += s.x * s.x;
      Syy += s.y * s.y;
      Sxy += s.x * s.y;
      Sxz += s.x * s.z;
      Syz += s.y * s.z;
    }

    // 3x3 Matrix Inversion for (X^T X)
    const D = 
        Sxx * (Syy * N - Sy * Sy) 
      - Sxy * (Sxy * N - Sx * Sy) 
      + Sx * (Sxy * Sy - Syy * Sx);

    if (Math.abs(D) < 1e-10) {
      logs.push(`[Channel ${c}] Error: Singular matrix in sample distribution. Skipping.`);
      newData.set(chanData, offset);
      continue;
    }

    const a = (
        Sxz * (Syy * N - Sy * Sy)
      - Sxy * (Syz * N - Sz * Sy)
      + Sx * (Syz * Sy - Syy * Sz)
    ) / D;

    const b = (
        Sxx * (Syz * N - Sz * Sy)
      - Sxz * (Sxy * N - Sx * Sy)
      + Sx * (Sxy * Sz - Syz * Sx)
    ) / D;

    const c_coeff = (
        Sxx * (Syy * Sz - Sy * Syz)
      - Sxy * (Sxy * Sz - Sx * Syz)
      + Sxz * (Sxy * Sy - Syy * Sx)
    ) / D;

    logs.push(`[Channel ${c}] Calculated Model: z = (${a.toExponential(2)})x + (${b.toExponential(2)})y + ${c_coeff.toExponential(2)}`);

    // Subtract background
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const idx = y * width + x;
        const modelBg = a * x + b * y + c_coeff;
        // Subtract model but add back the channel median to maintain brightness baseline
        newData[offset + idx] = Math.max(0, chanData[idx] - modelBg + chanMedian);
      }
    }
  }

  logs.push(`Done. Gradient subtracted from all image channels in memory.`);
  return { newData, logs };
}

/**
 * Linear Match (LMATCH) algorithm.
 * Computes y = ax + b where y is reference image and x is target image,
 * matching target channel to reference channel statistics.
 */
export function executeLinearMatch(
  _targetWidth: number,
  _targetHeight: number,
  targetData: Float32Array,
  refData: Float32Array,
  lowLimit: number = 0.0,
  highLimit: number = 1.0
): { newData: Float32Array, logs: string[] } {
  const logs: string[] = [];
  logs.push(`Initializing Linear Match (LMATCH) between target and reference...`);
  
  if (targetData.length !== refData.length) {
    logs.push(`Error: Reference and Target must be the same size.`);
    return { newData: targetData, logs };
  }

  // We want to fit y = ax + b, where:
  // y = reference pixel
  // x = target pixel
  let n = 0;
  let sumX = 0, sumY = 0;
  let sumXX = 0, sumXY = 0;

  for (let i = 0; i < targetData.length; i++) {
    const x = targetData[i];
    const y = refData[i];
    
    // Ignore pixels outside [lowLimit, highLimit]
    if (x >= lowLimit && x <= highLimit && y >= lowLimit && y <= highLimit) {
      n++;
      sumX += x;
      sumY += y;
      sumXX += x * x;
      sumXY += x * y;
    }
  }

  if (n < 10) {
    logs.push(`Error: Too few valid pixels (${n}) to perform Linear Match. Aborting.`);
    return { newData: targetData, logs };
  }

  const meanX = sumX / n;
  const meanY = sumY / n;
  const varX = (sumXX / n) - (meanX * meanX);
  const covXY = (sumXY / n) - (meanX * meanY);

  if (Math.abs(varX) < 1e-10) {
    logs.push(`Error: Variance is zero. Target is a flat image. Aborting.`);
    return { newData: targetData, logs };
  }

  const scale = covXY / varX;
  const offset = meanY - scale * meanX;

  logs.push(`Calculated linear matching coefficients (using ${n} pixels):`);
  logs.push(`> Scale factor (a): ${scale.toFixed(4)}`);
  logs.push(`> Offset (b): ${offset.toExponential(3)} ADU`);
  logs.push(`Applying transformation: Target' = ${scale.toFixed(4)} * Target + ${offset.toExponential(3)}`);

  const newData = new Float32Array(targetData.length);
  for (let i = 0; i < targetData.length; i++) {
    newData[i] = Math.max(0, targetData[i] * scale + offset);
  }

  logs.push(`Done. Linear match complete.`);
  return { newData, logs };
}

/**
 * Photometric/Manual Color Calibration algorithm.
 * Sets background neutralization offsets and scaling coefficients for white balance.
 */
export function executeColorCalibration(
  width: number,
  height: number,
  data: Float32Array,
  autoBg: boolean = true,
  bgRed: number = 0.0,
  bgGreen: number = 0.0,
  bgBlue: number = 0.0,
  autoWhite: boolean = true,
  whiteRed: number = 1.0,
  whiteGreen: number = 1.0,
  whiteBlue: number = 1.0
): { newData: Float32Array, logs: string[] } {
  const logs: string[] = [];
  logs.push(`Initializing Color Calibration module...`);
  
  const planeSize = width * height;
  const channels = data.length / planeSize;
  const newData = new Float32Array(data.length);
  
  if (channels < 3) {
    logs.push(`Warning: Image has only ${channels} channel(s). Color calibration requires 3 channels (RGB). Copying original data.`);
    newData.set(data);
    return { newData, logs };
  }
  
  const rData = data.subarray(0, planeSize);
  const gData = data.subarray(planeSize, 2 * planeSize);
  const bData = data.subarray(2 * planeSize, 3 * planeSize);
  
  // 1. Calculate Background Offsets
  let rBg = bgRed;
  let gBg = bgGreen;
  let bBg = bgBlue;
  
  if (autoBg) {
    logs.push(`Calculating background medians for neutralization...`);
    
    const getMedian = (arr: Float32Array): number => {
      const sampleCount = Math.min(50000, arr.length);
      const sample = new Float32Array(sampleCount);
      const stride = Math.max(1, Math.floor(arr.length / sampleCount));
      let count = 0;
      for (let i = 0; i < sampleCount; i++) {
        const val = arr[i * stride];
        if (!isNaN(val) && isFinite(val)) {
          sample[count++] = val;
        }
      }
      const sorted = sample.subarray(0, count);
      sorted.sort();
      if (count === 0) return 0.0;
      return sorted[Math.floor(count / 2)];
    };
    
    rBg = getMedian(rData);
    gBg = getMedian(gData);
    bBg = getMedian(bData);
    
    logs.push(`> Detected Background Medians - R: ${rBg.toFixed(4)}, G: ${gBg.toFixed(4)}, B: ${bBg.toFixed(4)}`);
  } else {
    logs.push(`> Using Manual Background Offsets - R: ${rBg.toFixed(4)}, G: ${gBg.toFixed(4)}, B: ${bBg.toFixed(4)}`);
  }
  
  // Subtract background offsets (neutralize)
  const neutralizedR = new Float32Array(planeSize);
  const neutralizedG = new Float32Array(planeSize);
  const neutralizedB = new Float32Array(planeSize);
  
  const targetBg = (rBg + gBg + bBg) / 3.0;
  for (let i = 0; i < planeSize; i++) {
    neutralizedR[i] = Math.max(0, rData[i] - rBg + targetBg);
    neutralizedG[i] = Math.max(0, gData[i] - gBg + targetBg);
    neutralizedB[i] = Math.max(0, bData[i] - bBg + targetBg);
  }
  logs.push(`> Neutralized background channels to target baseline: ${targetBg.toFixed(4)} ADU.`);
  
  // 2. White Balance Scaling
  let kr = whiteRed;
  let kg = whiteGreen;
  let kb = whiteBlue;
  
  if (autoWhite) {
    logs.push(`Calculating white balance ratios (using star/brightness centroids)...`);
    
    const getBrightReference = (arr: Float32Array): number => {
      const sampleCount = Math.min(20000, arr.length);
      const sample = new Float32Array(sampleCount);
      const stride = Math.max(1, Math.floor(arr.length / sampleCount));
      let count = 0;
      for (let i = 0; i < sampleCount; i++) {
        const val = arr[i * stride];
        if (!isNaN(val) && isFinite(val)) {
          sample[count++] = val;
        }
      }
      const sorted = sample.subarray(0, count);
      sorted.sort();
      
      const start = Math.floor(count * 0.90);
      const end = Math.floor(count * 0.99);
      let sum = 0;
      let pCount = 0;
      for (let j = start; j < end; j++) {
        sum += sorted[j];
        pCount++;
      }
      return pCount > 0 ? (sum / pCount) : 1.0;
    };
    
    const rBright = getBrightReference(neutralizedR);
    const gBright = getBrightReference(neutralizedG);
    const bBright = getBrightReference(neutralizedB);
    
    const avgBright = (rBright + gBright + bBright) / 3.0;
    
    kr = avgBright / Math.max(1e-6, rBright);
    kg = avgBright / Math.max(1e-6, gBright);
    kb = avgBright / Math.max(1e-6, bBright);
    
    // Normalize coefficients so green is 1.0
    const normFactor = kg;
    kr = kr / normFactor;
    kg = 1.0;
    kb = kb / normFactor;
    
    logs.push(`> Auto White Balance Coefficients - R: ${kr.toFixed(4)}, G: ${kg.toFixed(4)}, B: ${kb.toFixed(4)}`);
  } else {
    logs.push(`> Using Manual White Balance Scaling - R: ${kr.toFixed(4)}, G: ${kg.toFixed(4)}, B: ${kb.toFixed(4)}`);
  }
  
  // Apply White Balance scaling
  const outR = newData.subarray(0, planeSize);
  const outG = newData.subarray(planeSize, 2 * planeSize);
  const outB = newData.subarray(2 * planeSize, 3 * planeSize);
  
  for (let i = 0; i < planeSize; i++) {
    outR[i] = Math.max(0, neutralizedR[i] * kr);
    outG[i] = Math.max(0, neutralizedG[i] * kg);
    outB[i] = Math.max(0, neutralizedB[i] * kb);
  }
  
  logs.push(`Done. Color calibration completed successfully.`);
  return { newData, logs };
}

export interface VignettingModel {
  opticalCenterX: number;
  opticalCenterY: number;
  effectiveFocalPx: number;  // Effective focal length in pixels
  amplitude: number;         // Scale factor
  radialProfile: { radius: number; measured: number; modeled: number }[];
  logs: string[];
}

export function modelVignetting(
  data: Float32Array,
  width: number,
  height: number
): VignettingModel {
  const logs: string[] = [];
  logs.push(`Starting Vignetting Profile modeling (cos⁴ Law)...`);

  const centerX = width / 2;
  const centerY = height / 2;
  const maxRadius = Math.sqrt(centerX * centerX + centerY * centerY);
  const numBins = 100;
  const binSize = maxRadius / numBins;

  const planeSize = width * height;
  const channels = Math.floor(data.length / planeSize) || 1;

  logs.push(`Image dimensions: ${width}x${height}, Center: (${centerX}, ${centerY}), Channels: ${channels}`);

  // 1. Group pixels into radial bins
  const bins: number[][] = Array.from({ length: numBins }, () => []);
  const step = Math.max(1, Math.floor(planeSize / 100000)); // Sample up to 100,000 pixels

  for (let i = 0; i < planeSize; i += step) {
    const x = i % width;
    const y = Math.floor(i / width);
    const dx = x - centerX;
    const dy = y - centerY;
    const r = Math.sqrt(dx * dx + dy * dy);
    
    const binIdx = Math.floor(r / binSize);
    if (binIdx >= 0 && binIdx < numBins) {
      let val = 0;
      for (let c = 0; c < channels; c++) {
        val += data[c * planeSize + i];
      }
      bins[binIdx].push(val / channels);
    }
  }

  // 2. Compute median for each bin to ignore stars
  const measuredProfile: { radius: number; intensity: number }[] = [];
  for (let b = 0; b < numBins; b++) {
    const vals = bins[b];
    if (vals.length > 5) {
      vals.sort((x, y) => x - y);
      const medianVal = vals[Math.floor(vals.length / 2)];
      measuredProfile.push({
        radius: (b + 0.5) * binSize,
        intensity: medianVal
      });
    }
  }

  logs.push(`Extracted radial profile with ${measuredProfile.length} valid bins.`);

  if (measuredProfile.length < 5) {
    logs.push("Warning: Insufficient radial profile data. Returning default model.");
    return {
      opticalCenterX: centerX,
      opticalCenterY: centerY,
      effectiveFocalPx: width,
      amplitude: 1.0,
      radialProfile: [],
      logs
    };
  }

  // 3. Amplitude estimate (intensity at center)
  // Take average of the first 3 bins
  let sumCenter = 0;
  let countCenter = 0;
  for (let i = 0; i < Math.min(3, measuredProfile.length); i++) {
    sumCenter += measuredProfile[i].intensity;
    countCenter++;
  }
  const amplitude = countCenter > 0 ? sumCenter / countCenter : 1.0;
  logs.push(`Estimated center intensity amplitude (A): ${amplitude.toFixed(4)}`);

  // 4. Golden Section Search to find best effective focal length in pixels (f)
  // Model: I(r) = A / (1 + (r/f)^2)^2
  const computeLoss = (f: number): number => {
    let loss = 0;
    for (const pt of measuredProfile) {
      const r_f = pt.radius / f;
      const modelVal = amplitude / Math.pow(1.0 + r_f * r_f, 2);
      const diff = pt.intensity - modelVal;
      loss += diff * diff;
    }
    return loss;
  };

  const ax = 0.1 * maxRadius;
  const cx = 10.0 * maxRadius;
  
  const R = 0.61803399;
  const C = 1.0 - R;

  let x0 = ax;
  let x3 = cx;
  let x1 = x0 + C * (x3 - x0);
  let x2 = x0 + R * (x3 - x0);

  let f1 = computeLoss(x1);
  let f2 = computeLoss(x2);

  for (let iter = 0; iter < 20; iter++) {
    if (f1 < f2) {
      x3 = x2;
      x2 = x1;
      f2 = f1;
      x1 = x0 + C * (x2 - x0);
      f1 = computeLoss(x1);
    } else {
      x0 = x1;
      x1 = x2;
      f1 = f2;
      x2 = x0 + R * (x3 - x0);
      f2 = computeLoss(x2);
    }
  }

  const bestF = f1 < f2 ? x1 : x2;
  logs.push(`Fitted Effective Focal Length: ${bestF.toFixed(1)} pixels`);

  // 5. Generate radialProfile comparison points
  const finalProfile = measuredProfile.map(pt => {
    const r_f = pt.radius / bestF;
    const modeled = amplitude / Math.pow(1.0 + r_f * r_f, 2);
    return {
      radius: pt.radius,
      measured: pt.intensity,
      modeled
    };
  });

  return {
    opticalCenterX: centerX,
    opticalCenterY: centerY,
    effectiveFocalPx: bestF,
    amplitude,
    radialProfile: finalProfile,
    logs
  };
}

export function correctVignetting(
  data: Float32Array,
  width: number,
  height: number,
  model: VignettingModel
): { newData: Float32Array; logs: string[] } {
  const logs: string[] = [];
  logs.push(`Applying Vignetting Correction (cos⁴ Law)...`);
  
  const planeSize = width * height;
  const channels = Math.floor(data.length / planeSize) || 1;
  const newData = new Float32Array(data.length);

  const cx = model.opticalCenterX;
  const cy = model.opticalCenterY;
  const f = model.effectiveFocalPx;

  logs.push(`Correction parameters - Center: (${cx}, ${cy}), FocalPx: ${f.toFixed(1)}`);

  // Pre-calculate correction factor per pixel to optimize
  const correctionLUT = new Float32Array(planeSize);
  for (let y = 0; y < height; y++) {
    const dy = y - cy;
    const dy2 = dy * dy;
    const rowOffset = y * width;
    for (let x = 0; x < width; x++) {
      const dx = x - cx;
      const r2 = dx * dx + dy2;
      
      // Model: flat = 1 / (1 + (r/f)^2)^2
      // Correction = 1 / flat = (1 + r^2/f^2)^2
      const r2_f2 = r2 / (f * f);
      correctionLUT[rowOffset + x] = Math.pow(1.0 + r2_f2, 2);
    }
  }

  // Apply correction. A cap avoids turning a poor fit into unbounded edge noise.
  const maxCorrection = 4;
  for (let c = 0; c < channels; c++) {
    const offset = c * planeSize;
    for (let i = 0; i < planeSize; i++) {
      // Divide by normalized model (meaning correction LUT is applied, clamped to max allowed value)
      const val = data[offset + i] * Math.min(maxCorrection, correctionLUT[i]);
      newData[offset + i] = Math.max(0, val);
    }
  }

  logs.push(`Vignetting correction complete (maximum correction ${maxCorrection.toFixed(1)}x).`);
  return { newData, logs };
}
