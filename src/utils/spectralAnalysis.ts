/**
 * Spectral Energy Distribution (SED) and Aperture Photometry Utility
 * Grounded in astronomical photometry and Planckian blackbody radiation physics.
 */

export interface PhotometryResult {
  flux: number[];         // Per-channel flux (background subtracted)
  background: number[];   // Per-channel background level per pixel
  snr: number;            // Combined Signal-to-Noise Ratio
  aperturePx: number;     // Aperture radius used
  aperturePixelCount: number;
  backgroundPixelCount: number;
}

export interface SEDResult {
  temperature: number;     // Kelvin
  spectralClass: string;   // O, B, A, F, G, K, M
  colorIndexBV: number;    // B-V color index
  chiSquared: number;      // Goodness of fit
  modelCurve: { wavelength_nm: number; relativeFlux: number }[];
  logs: string[];
}

/**
 * Performs aperture photometry on circular aperture with background subtraction from a concentric annulus.
 * Supports monochrome (1 channel) and color (3 channels, R-G-B order).
 */
export function aperturePhotometry(
  data: Float32Array,
  width: number,
  height: number,
  cx: number,
  cy: number,
  apertureRadius: number,
  annulusInner: number,
  annulusOuter: number
): PhotometryResult {
  const pixelCount = width * height;
  const channels = Math.floor(data.length / pixelCount) || 1;

  const flux: number[] = new Array(channels).fill(0);
  const background: number[] = new Array(channels).fill(0);
  
  // Pre-calculate bounding box for optimization
  const minX = Math.max(0, Math.floor(cx - annulusOuter));
  const maxX = Math.min(width - 1, Math.ceil(cx + annulusOuter));
  const minY = Math.max(0, Math.floor(cy - annulusOuter));
  const maxY = Math.min(height - 1, Math.ceil(cy + annulusOuter));

  const rAp2 = apertureRadius * apertureRadius;
  const rIn2 = annulusInner * annulusInner;
  const rOut2 = annulusOuter * annulusOuter;

  for (let c = 0; c < channels; c++) {
    const channelOffset = c * pixelCount;
    
    let apSum = 0;
    let apCount = 0;
    
    // Annulus pixels for background estimation
    const bgValues: number[] = [];

    for (let y = minY; y <= maxY; y++) {
      const dy = y - cy;
      const dy2 = dy * dy;
      const rowOffset = channelOffset + y * width;

      for (let x = minX; x <= maxX; x++) {
        const dx = x - cx;
        const d2 = dx * dx + dy2;

        if (d2 <= rAp2) {
          apSum += data[rowOffset + x];
          apCount++;
        } else if (d2 >= rIn2 && d2 <= rOut2) {
          bgValues.push(data[rowOffset + x]);
        }
      }
    }

    // Estimate background per pixel using median for robustness
    let bgLevel = 0;
    if (bgValues.length > 0) {
      bgValues.sort((a, b) => a - b);
      const mid = Math.floor(bgValues.length / 2);
      bgLevel = bgValues.length % 2 !== 0 ? bgValues[mid] : (bgValues[mid - 1] + bgValues[mid]) / 2;
    }

    // Subtract background from aperture sum
    const netFlux = apSum - (apCount * bgLevel);
    
    flux[c] = Math.max(0, netFlux);
    background[c] = bgLevel;
  }

  // Calculate combined SNR using CCD equation approximation (neglecting dark/read noise if unknown)
  // SNR = Signal / sqrt(Signal + N_pix * Background)
  let totalSignal = 0;
  let totalNoiseVar = 0;
  let apPixelsCount = 0;
  let bgPixelsCount = 0;

  // Geometry is identical for every channel, so count it once from the first pass.
  for (let y = minY; y <= maxY; y++) {
    const dy = y - cy;
    for (let x = minX; x <= maxX; x++) {
      const dx = x - cx;
      const d2 = dx * dx + dy * dy;
      if (d2 <= rAp2) apPixelsCount++;
      else if (d2 >= rIn2 && d2 <= rOut2) bgPixelsCount++;
    }
  }

  for (let c = 0; c < channels; c++) {
    const sig = flux[c];
    const bg = background[c];
    totalSignal += sig;
    // Include uncertainty from estimating the sky level in a finite annulus.
    const skyFactor = 1 + apPixelsCount / Math.max(1, bgPixelsCount);
    totalNoiseVar += Math.max(0, sig) + (apPixelsCount * Math.max(1e-6, bg) * skyFactor);
  }

  const snr = totalNoiseVar > 0 ? totalSignal / Math.sqrt(totalNoiseVar) : 0;

  return {
    flux,
    background,
    snr,
    aperturePx: apertureRadius,
    aperturePixelCount: apPixelsCount,
    backgroundPixelCount: bgPixelsCount
  };
}

/**
 * Planck blackbody function B_λ(T) = (2 * h * c^2) / (λ^5 * (exp(h * c / (λ * k * T)) - 1))
 * Wavelength λ in meters, Temperature T in Kelvin.
 * Returns relative intensity (ignoring absolute scale factor).
 */
function planckIntensity(wavelength_m: number, T: number): number {
  const h = 6.62607015e-34; // Planck constant (J s)
  const c = 299792458;      // Speed of light (m/s)
  const k = 1.380649e-23;   // Boltzmann constant (J/K)

  const c1 = 2 * h * c * c;
  const c2 = (h * c) / k;

  const exponent = c2 / (wavelength_m * T);
  
  // Guard against exponential overflow/underflow
  if (exponent > 700) return 0;
  if (exponent < 1e-6) return 0;

  return c1 / (Math.pow(wavelength_m, 5) * (Math.exp(exponent) - 1));
}

// Silicon sensors count photons. For relative narrow-band samples, photon rate
// is proportional to B_lambda divided by photon energy, i.e. B_lambda * lambda.
function planckPhotonIntensity(wavelength_m: number, T: number): number {
  return planckIntensity(wavelength_m, T) * wavelength_m;
}

/**
 * Fits a Planck blackbody spectral energy distribution (SED) to observed filter fluxes.
 * Uses grid search + golden section refinement to find temperature T that minimizes chi-squared.
 */
export function fitBlackbody(
  fluxes: { wavelength_nm: number; flux: number }[]
): SEDResult {
  const logs: string[] = [];
  logs.push(`Starting Planck Blackbody SED fitting...`);
  
  if (fluxes.length < 2) {
    logs.push("Warning: SED fitting requires at least 2 flux bands. Fitting with default 5778K.");
    return {
      temperature: 5778,
      spectralClass: 'G',
      colorIndexBV: 0.52,
      chiSquared: 0,
      modelCurve: [],
      logs
    };
  }

  logs.push(`Observed Fluxes: ` + fluxes.map(f => `${f.wavelength_nm}nm = ${f.flux.toFixed(4)}`).join(', '));

  // Objective function: compute chi-squared between observed fluxes and planck model at temp T
  // Since fluxes are relative, we first scale the Planck model to match the average flux.
  const computeChiSquared = (T: number): { chi2: number, scale: number } => {
    const models = fluxes.map(f => {
      const wavelength_m = f.wavelength_nm * 1e-9;
      return planckPhotonIntensity(wavelength_m, T);
    });

    let weightedObsModel = 0;
    let weightedModelSquared = 0;
    for (let i = 0; i < fluxes.length; i++) {
      const error = Math.max(1e-5, Math.abs(fluxes[i].flux) * 0.1);
      const weight = 1 / (error * error);
      weightedObsModel += weight * fluxes[i].flux * models[i];
      weightedModelSquared += weight * models[i] * models[i];
    }

    if (weightedModelSquared === 0) return { chi2: Infinity, scale: 0 };
    const scale = weightedObsModel / weightedModelSquared;

    let chi2 = 0;
    for (let i = 0; i < fluxes.length; i++) {
      const modelFlux = models[i] * scale;
      const obsFlux = fluxes[i].flux;
      const diff = obsFlux - modelFlux;
      // We assume simple unit variance or proportional error (10% flux error)
      const error = Math.max(1e-5, obsFlux * 0.1);
      chi2 += (diff * diff) / (error * error);
    }

    return { chi2, scale };
  };

  // 1. Grid search from 1500K to 40000K in steps of 100K
  let bestT = 5778;
  let minChi2 = Infinity;

  for (let T = 1500; T <= 40000; T += 100) {
    const { chi2 } = computeChiSquared(T);
    if (chi2 < minChi2) {
      minChi2 = chi2;
      bestT = T;
    }
  }

  // 2. Refine using golden section search around bestT
  const ax = Math.max(1000, bestT - 200);
  const cx = Math.min(50000, bestT + 200);
  const bx = bestT;

  const R = 0.61803399; // golden ratio conjugate
  const C = 1.0 - R;

  let x0 = ax;
  let x3 = cx;
  let x1, x2;
  
  if (Math.abs(cx - bx) > Math.abs(bx - ax)) {
    x1 = bx;
    x2 = bx + C * (cx - bx);
  } else {
    x2 = bx;
    x1 = bx - C * (bx - ax);
  }

  let f1 = computeChiSquared(x1).chi2;
  let f2 = computeChiSquared(x2).chi2;

  // Run 15 iterations of golden section search
  for (let iter = 0; iter < 15; iter++) {
    if (f1 < f2) {
      x3 = x2;
      x2 = x1;
      f2 = f1;
      x1 = x0 + C * (x2 - x0);
      f1 = computeChiSquared(x1).chi2;
    } else {
      x0 = x1;
      x1 = x2;
      f1 = f2;
      x2 = x3 - C * (x3 - x1);
      f2 = computeChiSquared(x2).chi2;
    }
  }

  const finalT = f1 < f2 ? x1 : x2;
  const finalChi2 = Math.min(f1, f2);
  const finalScale = computeChiSquared(finalT).scale;
  const rawCurve = Array.from({ length: 41 }, (_, i) => {
    const wavelength_nm = 350 + i * 10;
    return {
      wavelength_nm,
      relativeFlux: planckPhotonIntensity(wavelength_nm * 1e-9, finalT) * finalScale
    };
  });
  const curveMax = Math.max(...rawCurve.map(p => p.relativeFlux), 1e-30);
  const modelCurve = rawCurve.map(p => ({ ...p, relativeFlux: p.relativeFlux / curveMax }));

  logs.push(`Fitted Temperature: ${Math.round(finalT)} K (Chi2 = ${finalChi2.toFixed(4)})`);

  // Map to spectral class based on temperature
  // O: >30,000K
  // B: 10,000K – 30,000K
  // A: 7,500K – 10,000K
  // F: 6,000K – 7,500K
  // G: 5,200K – 6,000K
  // K: 3,700K – 5,200K
  // M: <3,700K
  let spectralClass: string;
  if (finalT >= 30000) spectralClass = 'O';
  else if (finalT >= 10000) spectralClass = 'B';
  else if (finalT >= 7500) spectralClass = 'A';
  else if (finalT >= 6000) spectralClass = 'F';
  else if (finalT >= 5200) spectralClass = 'G';
  else if (finalT >= 3700) spectralClass = 'K';
  else spectralClass = 'M';

  // Numerically invert Ballesteros' color-temperature relation. This is still
  // only a color estimate: RGB camera channels are not calibrated B and V bands.
  const temperatureFromBV = (bv: number) =>
    4600 * (1 / (0.92 * bv + 1.7) + 1 / (0.92 * bv + 0.62));
  let lo = -0.4;
  let hi = 2.0;
  for (let i = 0; i < 40; i++) {
    const mid = (lo + hi) / 2;
    if (temperatureFromBV(mid) > finalT) lo = mid;
    else hi = mid;
  }
  const colorIndexBV = (lo + hi) / 2;

  logs.push(`Spectral Class Estimate: ${spectralClass}`);
  logs.push(`Color Index (B-V) Estimate: ${colorIndexBV.toFixed(3)}`);

  return {
    temperature: Math.round(finalT),
    spectralClass,
    colorIndexBV,
    chiSquared: finalChi2,
    modelCurve,
    logs
  };
}
