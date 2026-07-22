/**
 * Signal-to-Noise Ratio (SNR) Calculator and Integration Time Estimator
 * Grounded in the CCD Equation and photon statistics (Poisson distribution).
 */

import { aperturePhotometry } from './spectralAnalysis';

export interface SNRMeasurement {
  signalRate: number;      // e-/s (if gain/exposure known) or ADU/s
  backgroundRate: number;  // e-/s/pixel or ADU/s/pixel
  measuredSNR: number;
  noiseBreakdown: {
    photonNoise: number;   // sqrt(signal_electrons)
    skyNoise: number;      // sqrt(background_electrons * npix)
    readNoise: number;     // readNoise_electrons * sqrt(npix)
    darkNoise: number;     // sqrt(darkCurrent * t * npix)
    totalNoise: number;
  };
  logs: string[];
}

export interface IntegrationEstimate {
  currentSNR: number;
  targetSNR: number;
  currentFrames: number;
  requiredFrames: number;
  additionalTimeHours: number;
  logs: string[];
}

/**
 * Measures the SNR of a target in an image based on the CCD equation.
 * Targets are defined by coordinate (cx, cy) and radius.
 */
export function measureSNR(
  data: Float32Array,
  width: number,
  height: number,
  targetX: number,
  targetY: number,
  apertureRadius: number,
  exposureSeconds: number,
  gain: number,          // e-/ADU
  readNoise: number,     // e-
  darkCurrent: number    // e-/pixel/s
): SNRMeasurement {
  const logs: string[] = [];
  logs.push(`Measuring target SNR using the CCD Equation...`);
  logs.push(`Target coordinates: (${targetX.toFixed(1)}, ${targetY.toFixed(1)}), Aperture radius: ${apertureRadius} px`);
  logs.push(`Parameters: Exp = ${exposureSeconds}s, Gain = ${gain.toFixed(2)} e-/ADU, ReadNoise = ${readNoise.toFixed(2)} e-, DarkCurrent = ${darkCurrent.toFixed(4)} e-/px/s`);

  // We use annulus inner = aperture * 1.5, outer = aperture * 2.5 for background subtraction
  const annulusInner = apertureRadius * 1.5;
  const annulusOuter = apertureRadius * 2.5;

  const phot = aperturePhotometry(data, width, height, targetX, targetY, apertureRadius, annulusInner, annulusOuter);
  
  // Calculate aperture area (number of pixels)
  const npix = phot.aperturePixelCount;
  const nBackground = phot.backgroundPixelCount;
  const skyEstimationFactor = 1 + npix / Math.max(1, nBackground);
  
  // Get signal and background in ADU
  // If color, average across R, G, B channels or use the first channel (green channel is usually best for SNR, but average is robust)
  let signalADU = 0;
  let backgroundADU = 0;
  
  if (phot.flux.length > 0) {
    signalADU = phot.flux.reduce((sum, v) => sum + v, 0) / phot.flux.length;
    backgroundADU = phot.background.reduce((sum, v) => sum + v, 0) / phot.background.length;
  }

  // Convert ADU to electrons
  const signalElectrons = signalADU * gain;
  const backgroundElectrons = backgroundADU * gain;

  logs.push(`Photometry results:`);
  logs.push(`- Net Signal: ${signalADU.toFixed(2)} ADU (${signalElectrons.toFixed(0)} e-)`);
  logs.push(`- Background: ${backgroundADU.toFixed(2)} ADU/px (${backgroundElectrons.toFixed(1)} e-/px)`);
  logs.push(`- Aperture Area: ${npix.toFixed(1)} pixels`);

  // Rates
  const t = Math.max(0.1, exposureSeconds);
  const signalRate = signalElectrons / t;
  const backgroundRate = backgroundElectrons / t;

  // Noise components in electrons:
  // 1. Photon Shot Noise = sqrt(Signal)
  const photonNoise = Math.sqrt(Math.max(0, signalElectrons));
  // 2. Sky Background Noise = sqrt(Background * Npix)
  const skyNoise = Math.sqrt(Math.max(0, backgroundElectrons * npix * skyEstimationFactor));
  // 3. Read Noise Contribution = ReadNoise * sqrt(Npix)
  const readNoiseContrib = readNoise * Math.sqrt(npix * skyEstimationFactor);
  // 4. Dark Current Noise = sqrt(DarkCurrent * t * Npix)
  const darkNoise = Math.sqrt(Math.max(0, darkCurrent * t * npix * skyEstimationFactor));

  // Total noise = sqrt(sum of squares)
  const totalNoise = Math.sqrt(
    photonNoise * photonNoise +
    skyNoise * skyNoise +
    readNoiseContrib * readNoiseContrib +
    darkNoise * darkNoise
  );

  const measuredSNR = totalNoise > 0 ? signalElectrons / totalNoise : 0;

  logs.push(`Noise breakdown (electrons):`);
  logs.push(`- Target Photon Noise: ${photonNoise.toFixed(2)} e-`);
  logs.push(`- Sky Background Noise: ${skyNoise.toFixed(2)} e-`);
  logs.push(`- Read Noise: ${readNoiseContrib.toFixed(2)} e-`);
  logs.push(`- Dark Current Noise: ${darkNoise.toFixed(2)} e-`);
  logs.push(`- Combined Total Noise: ${totalNoise.toFixed(2)} e-`);
  logs.push(`Derived Signal-to-Noise Ratio (SNR): ${measuredSNR.toFixed(2)}`);

  return {
    signalRate,
    backgroundRate,
    measuredSNR,
    noiseBreakdown: {
      photonNoise,
      skyNoise,
      readNoise: readNoiseContrib,
      darkNoise,
      totalNoise
    },
    logs
  };
}

/**
 * Projects the required integration time/frames to reach a target SNR
 * based on current SNR and frame counts.
 */
export function estimateIntegrationTime(
  currentSNR: number,
  currentFrames: number,
  exposureSeconds: number,
  targetSNR: number
): IntegrationEstimate {
  const logs: string[] = [];
  logs.push(`Calculating integration time projections...`);
  logs.push(`Current: SNR = ${currentSNR.toFixed(2)}, Frames = ${currentFrames}, Single Exp = ${exposureSeconds}s`);
  logs.push(`Target: SNR = ${targetSNR.toFixed(2)}`);

  if (currentSNR <= 0) {
    logs.push("Warning: Current SNR is zero or negative. Cannot project integration time.");
    return {
      currentSNR,
      targetSNR,
      currentFrames,
      requiredFrames: currentFrames,
      additionalTimeHours: 0,
      logs
    };
  }

  // SNR scales with the square root of integration time (number of frames N) for background-limited exposures:
  // SNR_target / SNR_current = sqrt(N_target / N_current)
  // N_target = N_current * (SNR_target / SNR_current)^2
  const ratio = targetSNR / currentSNR;
  const requiredFrames = Math.max(currentFrames, Math.ceil(currentFrames * ratio * ratio));
  const additionalFrames = Math.max(0, requiredFrames - currentFrames);
  const additionalTimeSeconds = additionalFrames * exposureSeconds;
  const additionalTimeHours = additionalTimeSeconds / 3600;

  logs.push(`Projections:`);
  logs.push(`- Required total frames: ${requiredFrames} (Ratio: ${ratio.toFixed(2)}x)`);
  logs.push(`- Additional frames needed: ${additionalFrames}`);
  logs.push(`- Additional integration time: ${additionalTimeHours.toFixed(3)} hours (${(additionalTimeSeconds / 60).toFixed(1)} minutes)`);

  return {
    currentSNR,
    targetSNR,
    currentFrames,
    requiredFrames,
    additionalTimeHours,
    logs
  };
}
