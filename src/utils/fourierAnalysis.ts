/**
 * Fourier Power Spectrum Analyzer (2D FFT)
 * Grounded in digital signal processing (DSP) and Cooley-Tukey radix-2 FFT.
 * Reveals periodic tracking errors, banding, and sensor interference patterns.
 */

export interface FourierResult {
  powerSpectrum: Float32Array;  // Log-scaled power, dimensions: paddedWidth x paddedHeight
  paddedWidth: number;
  paddedHeight: number;
  radialProfile: { frequency: number; power: number }[]; // cycles/pixel, 1D radial average
  peakFrequencies: { fx: number; fy: number; power: number; periodPx: number }[]; // Top N peaks
  logs: string[];
}

/**
 * Returns the next power of 2.
 */
function nextPowerOf2(n: number): number {
  let count = 1;
  while (count < n) count *= 2;
  return count;
}

/**
 * Iterative 1D FFT (Cooley-Tukey)
 * Operates in-place on interleaved real/imaginary array.
 */
function fft1D(real: Float32Array, imag: Float32Array, n: number) {
  // Bit-reversal permutation
  let j = 0;
  for (let i = 0; i < n; i++) {
    if (i < j) {
      const tempReal = real[i];
      real[i] = real[j];
      real[j] = tempReal;

      const tempImag = imag[i];
      imag[i] = imag[j];
      imag[j] = tempImag;
    }
    let m = n >> 1;
    while (m >= 1 && j >= m) {
      j -= m;
      m >>= 1;
    }
    j += m;
  }

  // Pre-computed twiddle factors can be done, but standard Math.cos/sin in outer loop is fast enough for steps.
  // We can compute them per step for speed.
  for (let len = 2; len <= n; len <<= 1) {
    const angle = (-2.0 * Math.PI) / len;
    const wlenReal = Math.cos(angle);
    const wlenImag = Math.sin(angle);
    
    const halfLen = len >> 1;
    for (let i = 0; i < n; i += len) {
      let wReal = 1.0;
      let wImag = 0.0;
      for (let k = 0; k < halfLen; k++) {
        const uIdx = i + k;
        const vIdx = i + k + halfLen;

        const vReal = real[vIdx] * wReal - imag[vIdx] * wImag;
        const vImag = real[vIdx] * wImag + imag[vIdx] * wReal;

        real[vIdx] = real[uIdx] - vReal;
        imag[vIdx] = imag[uIdx] - vImag;
        real[uIdx] += vReal;
        imag[uIdx] += vImag;

        // Update twiddle factor
        const nextWReal = wReal * wlenReal - wImag * wlenImag;
        wImag = wReal * wlenImag + wImag * wlenReal;
        wReal = nextWReal;
      }
    }
  }
}

/**
 * Computes 2D FFT and power spectrum of a monochrome image.
 * To keep UI responsive, we crop/analyze the center 512x512 region if the image is larger.
 */
export function computeFFT2D(
  data: Float32Array,
  width: number,
  height: number
): FourierResult {
  const logs: string[] = [];
  logs.push(`Starting 2D Fast Fourier Transform (FFT) analysis...`);

  // 1. Determine analysis dimensions. Limit to 512x512 for interactive speed
  const maxAnalysisDim = 512;
  let analysisWidth = width;
  let analysisHeight = height;
  let cropActive = false;

  if (width > maxAnalysisDim || height > maxAnalysisDim) {
    analysisWidth = Math.min(width, maxAnalysisDim);
    analysisHeight = Math.min(height, maxAnalysisDim);
    cropActive = true;
    logs.push(`Image size (${width}x${height}) exceeds threshold. Cropping center ${analysisWidth}x${analysisHeight} region to maintain responsiveness.`);
  }

  const paddedWidth = nextPowerOf2(analysisWidth);
  const paddedHeight = nextPowerOf2(analysisHeight);
  logs.push(`Fourier space dimensions padded to next power of 2: ${paddedWidth}x${paddedHeight}`);

  // 2. Extract first channel (luminance) and apply Hann window
  const real = new Float32Array(paddedWidth * paddedHeight);
  const imag = new Float32Array(paddedWidth * paddedHeight);

  // Compute starting indices for center crop
  const startX = cropActive ? Math.floor((width - analysisWidth) / 2) : 0;
  const startY = cropActive ? Math.floor((height - analysisHeight) / 2) : 0;

  logs.push(`Applying 2D Hann window to minimize edge discontinuity leakage...`);
  for (let y = 0; y < analysisHeight; y++) {
    const srcRow = (startY + y) * width;
    const destRow = y * paddedWidth;
    // 1D Hann window factor for Y
    const wy = 0.5 * (1.0 - Math.cos((2.0 * Math.PI * y) / (analysisHeight - 1 || 1)));

    for (let x = 0; x < analysisWidth; x++) {
      const wx = 0.5 * (1.0 - Math.cos((2.0 * Math.PI * x) / (analysisWidth - 1 || 1)));
      const pixelVal = data[srcRow + (startX + x)];
      
      if (!isNaN(pixelVal) && isFinite(pixelVal)) {
        real[destRow + x] = pixelVal * wx * wy;
      }
    }
  }

  // 3. Perform 2D FFT
  // A: Apply 1D FFT on all rows
  logs.push(`Processing row-wise 1D FFTs...`);
  const rowReal = new Float32Array(paddedWidth);
  const rowImag = new Float32Array(paddedWidth);

  for (let y = 0; y < paddedHeight; y++) {
    const rowOffset = y * paddedWidth;
    
    // Copy row to temp buffer
    for (let x = 0; x < paddedWidth; x++) {
      rowReal[x] = real[rowOffset + x];
      rowImag[x] = imag[rowOffset + x];
    }

    fft1D(rowReal, rowImag, paddedWidth);

    // Copy back
    for (let x = 0; x < paddedWidth; x++) {
      real[rowOffset + x] = rowReal[x];
      imag[rowOffset + x] = rowImag[x];
    }
  }

  // B: Apply 1D FFT on all columns
  logs.push(`Processing column-wise 1D FFTs...`);
  const colReal = new Float32Array(paddedHeight);
  const colImag = new Float32Array(paddedHeight);

  for (let x = 0; x < paddedWidth; x++) {
    // Copy column to temp buffer
    for (let y = 0; y < paddedHeight; y++) {
      const idx = y * paddedWidth + x;
      colReal[y] = real[idx];
      colImag[y] = imag[idx];
    }

    fft1D(colReal, colImag, paddedHeight);

    // Copy back
    for (let y = 0; y < paddedHeight; y++) {
      const idx = y * paddedWidth + x;
      real[idx] = colReal[y];
      imag[idx] = colImag[y];
    }
  }

  // 4. Compute Power Spectrum: log10(1 + |F(u,v)|^2)
  // Shift DC component to the center of the spectrum (swap quadrants)
  logs.push(`Re-centering DC (zero frequency) component and scaling power spectrum...`);
  const powerSpectrum = new Float32Array(paddedWidth * paddedHeight);
  const halfW = paddedWidth / 2;
  const halfH = paddedHeight / 2;
  
  let maxPower = -Infinity;
  let minPower = Infinity;

  // Calculate raw power values
  for (let y = 0; y < paddedHeight; y++) {
    // Shift row index: (y + halfH) % paddedHeight
    const targetY = (y + halfH) % paddedHeight;
    const targetRowOffset = targetY * paddedWidth;
    const srcRowOffset = y * paddedWidth;

    for (let x = 0; x < paddedWidth; x++) {
      // Shift col index: (x + halfW) % paddedWidth
      const targetX = (x + halfW) % paddedWidth;

      const r = real[srcRowOffset + x];
      const im = imag[srcRowOffset + x];
      const magnitude2 = r * r + im * im;
      
      // Log scaling
      const power = Math.log10(1.0 + magnitude2);
      powerSpectrum[targetRowOffset + targetX] = power;

      if (power > maxPower) maxPower = power;
      if (power < minPower) minPower = power;
    }
  }

  // Normalize power spectrum to [0, 1] range
  const powerRange = maxPower - minPower || 1.0;
  for (let i = 0; i < powerSpectrum.length; i++) {
    powerSpectrum[i] = (powerSpectrum[i] - minPower) / powerRange;
  }

  // 5. Compute 1D Radial Profile
  logs.push(`Extracting radial frequency profile...`);
  const maxR = Math.floor(Math.sqrt(halfW * halfW + halfH * halfH));
  const radialSum = new Float32Array(maxR);
  const radialCount = new Int32Array(maxR);

  for (let y = 0; y < paddedHeight; y++) {
    const dy = y - halfH;
    const dy2 = dy * dy;
    const rowOffset = y * paddedWidth;

    for (let x = 0; x < paddedWidth; x++) {
      const dx = x - halfW;
      const r = Math.floor(Math.sqrt(dx * dx + dy2));
      
      if (r < maxR) {
        radialSum[r] += powerSpectrum[rowOffset + x];
        radialCount[r]++;
      }
    }
  }

  const radialProfile: { frequency: number; power: number }[] = [];
  for (let r = 0; r < maxR; r++) {
    if (radialCount[r] > 0) {
      radialProfile.push({
        frequency: r / Math.max(paddedWidth, paddedHeight),
        power: radialSum[r] / radialCount[r]
      });
    }
  }

  // 6. Peak Frequency Detection (Excluding DC region)
  logs.push(`Searching for significant periodic frequency spikes...`);
  const peakFrequencies: { fx: number; fy: number; power: number; periodPx: number }[] = [];
  const dcRadius = 12; // exclude low frequency center circle

  // Find local peaks in power spectrum
  for (let y = 2; y < paddedHeight - 2; y++) {
    const dy = y - halfH;
    const dy2 = dy * dy;
    const rowOffset = y * paddedWidth;

    for (let x = 2; x < paddedWidth - 2; x++) {
      const dx = x - halfW;
      const dist2 = dx * dx + dy2;

      // Exclude low-frequency DC peak area
      if (dist2 < dcRadius * dcRadius) continue;

      const power = powerSpectrum[rowOffset + x];

      // Local maximum check in a 5x5 window
      let isPeak = true;
      for (let wy = -2; wy <= 2; wy++) {
        const checkRowOffset = (y + wy) * paddedWidth;
        for (let wx = -2; wx <= 2; wx++) {
          if (powerSpectrum[checkRowOffset + (x + wx)] > power) {
            isPeak = false;
            break;
          }
        }
        if (!isPeak) break;
      }

      if (isPeak) {
        // Frequency components must be normalized by their own dimensions.
        // This remains correct for rectangular transforms.
        const cyclesPerPixel = Math.hypot(dx / paddedWidth, dy / paddedHeight);
        const periodPx = cyclesPerPixel > 0 ? 1 / cyclesPerPixel : 0;
        
        peakFrequencies.push({
          fx: dx,
          fy: dy,
          power,
          periodPx
        });
      }
    }
  }

  // Sort peaks, then collapse conjugate pairs: (+f) and (-f) encode the same
  // real-image periodicity and should not be reported as separate artifacts.
  peakFrequencies.sort((a, b) => b.power - a.power);
  const seenConjugates = new Set<string>();
  const topPeaks = peakFrequencies.filter(p => {
    const flip = p.fx < 0 || (p.fx === 0 && p.fy < 0);
    const canonicalX = flip ? -p.fx : p.fx;
    const canonicalY = flip ? -p.fy : p.fy;
    const key = `${canonicalX},${canonicalY}`;
    if (seenConjugates.has(key)) return false;
    seenConjugates.add(key);
    return true;
  }).slice(0, 10);

  logs.push(`Detected top periodic periods (in pixels): ` + topPeaks.map(p => p.periodPx.toFixed(1) + 'px').join(', '));

  return {
    powerSpectrum,
    paddedWidth,
    paddedHeight,
    radialProfile,
    peakFrequencies: topPeaks,
    logs
  };
}
