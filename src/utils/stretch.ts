// Fast median approximation or exact median for small samples
export function getMedian(arr: Float32Array): number {
  // Filter out NaN and Infinite values before sorting
  const valid = arr.filter(x => !isNaN(x) && isFinite(x));
  if (valid.length === 0) return 0;
  
  const sorted = valid.sort();
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 !== 0 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

// Get statistics of the pixel data
export interface DataStats {
  min: number;
  max: number;
  mean: number;
  median: number;
  mad: number;
}

export function calculateStats(data: Float32Array): DataStats {
  let min = Infinity;
  let max = -Infinity;
  let sum = 0;
  let validCount = 0;
  const len = data.length;

  // Take a step-based sample to make stats calculation extremely fast on large files
  const sampleSize = Math.min(10000, len);
  const sampleArr = new Float32Array(sampleSize);
  let sampleCount = 0;
  const sampleStep = Math.max(1, Math.floor(len / 10000));

  for (let i = 0; i < len; i++) {
    const val = data[i];
    if (isNaN(val) || !isFinite(val)) continue;
    
    if (val < min) min = val;
    if (val > max) max = val;
    sum += val;
    validCount++;

    if (i % sampleStep === 0 && sampleCount < sampleSize) {
      sampleArr[sampleCount++] = val;
    }
  }

  // Handle completely invalid or empty buffers gracefully
  if (validCount === 0 || min === Infinity || max === -Infinity) {
    return { min: 0, max: 1, mean: 0.5, median: 0.5, mad: 0.1 };
  }

  const mean = sum / validCount;
  
  // Calculate median from sampled array for performance
  const samples = sampleArr.subarray(0, sampleCount);
  samples.sort();

  let median = 0.5;
  if (samples.length > 0) {
    const mid = Math.floor(samples.length / 2);
    median = samples.length % 2 !== 0 ? samples[mid] : (samples[mid - 1] + samples[mid]) / 2;
  }

  // Calculate MAD (Median Absolute Deviation)
  const absDevs = new Float32Array(samples.length);
  for (let i = 0; i < samples.length; i++) {
    absDevs[i] = Math.abs(samples[i] - median);
  }
  absDevs.sort();

  let mad = 1e-5;
  if (absDevs.length > 0) {
    const mid = Math.floor(absDevs.length / 2);
    mad = absDevs.length % 2 !== 0 ? absDevs[mid] : (absDevs[mid - 1] + absDevs[mid]) / 2;
    if (mad === 0) mad = 1e-5; // avoid zero dev
  }

  return { min, max, mean, median, mad };
}

// Midtones Transfer Function (STF)
// Maps inputs x (0 to 1) using midtone parameter m (0 to 1)
export function mtf(x: number, m: number): number {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  if (m === 0.5) return x;
  return ((m - 1) * x) / ((2 * m - 1) * x - m);
}

// Apply auto-stretch (PixInsight STF style) to an array of pixels
// Returns a Uint8Array (0-255) for canvas presentation
export function applySTF(data: Float32Array, stats: DataStats, targetBackground = 0.125): Uint8ClampedArray {
  const len = data.length;
  const out = new Uint8ClampedArray(len * 4); // RGBA format for canvas

  const minVal = stats.min;
  const maxVal = stats.max;
  const range = maxVal - minVal || 1;

  // Background clipping (shadows limit)
  // Typically median - 2.8 * MAD (clipped to minVal/maxVal range)
  const clipShadow = Math.max(minVal, stats.median - 2.8 * stats.mad);
  const normalizedClipShadow = (clipShadow - minVal) / range;

  // Target midtone parameter m
  // We want the median value (after shadow clipping) to map to targetBackground
  const normalizedMedian = (stats.median - minVal) / range;
  const shiftedMedian = normalizedMedian - normalizedClipShadow;
  
  let m = 0.5;
  if (shiftedMedian > 0 && shiftedMedian < 1) {
    // Solve MTF equation for m: targetBackground = mtf(shiftedMedian, m)
    m = (shiftedMedian * (targetBackground - 1)) / (shiftedMedian * (2 * targetBackground - 1) - targetBackground);
  }
  
  // Guard midtone limits
  m = Math.min(0.999, Math.max(0.001, m));

  for (let i = 0; i < len; i++) {
    const val = data[i];
    
    // Handle NaN values by mapping them to 0 (black background)
    if (isNaN(val) || !isFinite(val)) {
      const idx = i * 4;
      out[idx] = 0;
      out[idx + 1] = 0;
      out[idx + 2] = 0;
      out[idx + 3] = 255;
      continue;
    }

    // Normalize pixel relative to shadow clip
    let norm = (val - clipShadow) / (maxVal - clipShadow || 1);
    norm = Math.min(1, Math.max(0, norm));

    // Apply Midtones Transfer Function stretch
    const stretched = mtf(norm, m);
    const pixelVal = Math.round(stretched * 255);

    const idx = i * 4;
    out[idx] = pixelVal;     // R
    out[idx + 1] = pixelVal; // G
    out[idx + 2] = pixelVal; // B
    out[idx + 3] = 255;      // A
  }

  return out;
}

// Apply Arcsinh Stretch
export function applyArcsinh(data: Float32Array, stats: DataStats, stretchFactor = 30): Uint8ClampedArray {
  const len = data.length;
  const out = new Uint8ClampedArray(len * 4);
  const minVal = stats.min;
  const range = stats.max - minVal || 1;

  // Arcsinh formula: arcsinh(val * factor) / arcsinh(factor)
  const arcsinhDenominator = Math.asinh(stretchFactor);

  for (let i = 0; i < len; i++) {
    const val = data[i];
    
    // Handle NaN values by mapping them to 0 (black background)
    if (isNaN(val) || !isFinite(val)) {
      const idx = i * 4;
      out[idx] = 0;
      out[idx + 1] = 0;
      out[idx + 2] = 0;
      out[idx + 3] = 255;
      continue;
    }

    // Linear normalization first (0 to 1)
    let norm = (val - minVal) / range;
    norm = Math.min(1, Math.max(0, norm));

    const stretched = Math.asinh(norm * stretchFactor) / arcsinhDenominator;
    const pixelVal = Math.round(stretched * 255);

    const idx = i * 4;
    out[idx] = pixelVal;
    out[idx + 1] = pixelVal;
    out[idx + 2] = pixelVal;
    out[idx + 3] = 255;
  }

  return out;
}

// Apply linear normalization (standard stretch)
export function applyLinear(data: Float32Array, stats: DataStats): Uint8ClampedArray {
  const len = data.length;
  const out = new Uint8ClampedArray(len * 4);
  const minVal = stats.min;
  const range = stats.max - minVal || 1;

  for (let i = 0; i < len; i++) {
    const val = data[i];
    
    // Handle NaN values by mapping them to 0 (black background)
    if (isNaN(val) || !isFinite(val)) {
      const idx = i * 4;
      out[idx] = 0;
      out[idx + 1] = 0;
      out[idx + 2] = 0;
      out[idx + 3] = 255;
      continue;
    }

    let norm = (val - minVal) / range;
    norm = Math.min(1, Math.max(0, norm));
    const pixelVal = Math.round(norm * 255);

    const idx = i * 4;
    out[idx] = pixelVal;
    out[idx + 1] = pixelVal;
    out[idx + 2] = pixelVal;
    out[idx + 3] = 255;
  }

  return out;
}
