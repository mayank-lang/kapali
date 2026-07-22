/**
 * Photon Transfer Curve (PTC) Analyzer
 * Grounded in CCD/CMOS sensor characterization physics.
 * Var(Signal) = Mean(Signal) / Gain + (ReadNoise)^2
 */

export interface PTCDataPoint {
  meanSignal: number;    // Mean ADU of the flat pair
  variance: number;      // Variance between the two flats
  exposureTime: number;  // If available
}

export interface PTCResult {
  dataPoints: PTCDataPoint[];
  gain: number;           // e-/ADU (slope of linear region)
  readNoise: number;      // e- (sqrt of y-intercept)
  fullWellCapacity: number; // e- (where curve rolls over)
  linearityRange: [number, number]; // ADU range of linear region
  logs: string[];
}

export function computePTC(
  flatPairs: { a: Float32Array; b: Float32Array }[],
  _width: number,
  _height: number,
  exposureTimes?: number[]
): PTCResult {
  const logs: string[] = [];
  logs.push(`Starting Photon Transfer Curve (PTC) sensor analysis...`);
  logs.push(`Received ${flatPairs.length} flat-field pairs for processing.`);

  if (flatPairs.length < 2) {
    logs.push("Error: At least 2 flat-field pairs are required to fit a PTC curve.");
    return {
      dataPoints: [],
      gain: 1.0,
      readNoise: 0.0,
      fullWellCapacity: 0.0,
      linearityRange: [0, 0],
      logs
    };
  }

  const dataPoints: PTCDataPoint[] = [];

  for (let idx = 0; idx < flatPairs.length; idx++) {
    const { a, b } = flatPairs[idx];
    const expTime = exposureTimes && exposureTimes[idx] !== undefined ? exposureTimes[idx] : idx + 1;

    if (a.length !== b.length || a.length === 0) {
      logs.push(`Warning: Flat pair at index ${idx} has mismatched or empty arrays. Skipping.`);
      continue;
    }

    // Determine saturation threshold dynamically from sample
    let maxVal = 0;
    const initialSampleSize = Math.min(10000, a.length);
    for (let j = 0; j < initialSampleSize; j++) {
      if (a[j] > maxVal) maxVal = a[j];
    }
    const saturationThreshold = maxVal > 1.1 ? 62000 : 0.95;

    // Subsample up to 50,000 pixels for speed and memory efficiency
    const sampleLimit = 50000;
    const step = Math.max(1, Math.floor(a.length / sampleLimit));
    
    let sumMean = 0;
    let sumDiff = 0;
    let validPixels = 0;

    // First pass: compute mean of means, and mean of differences
    for (let j = 0; j < a.length; j += step) {
      const valA = a[j];
      const valB = b[j];
      
      if (isNaN(valA) || isNaN(valB) || !isFinite(valA) || !isFinite(valB)) continue;
      if (valA >= saturationThreshold || valB >= saturationThreshold) continue;

      sumMean += (valA + valB) / 2;
      sumDiff += (valA - valB);
      validPixels++;
    }

    if (validPixels < 100) {
      logs.push(`Warning: Pair ${idx} has too many saturated or invalid pixels (${validPixels} valid). Skipping.`);
      continue;
    }

    const meanSignal = sumMean / validPixels;
    const meanDiff = sumDiff / validPixels;

    // Second pass: compute variance of differences
    let sumSquaredDiff = 0;
    for (let j = 0; j < a.length; j += step) {
      const valA = a[j];
      const valB = b[j];
      if (isNaN(valA) || isNaN(valB) || !isFinite(valA) || !isFinite(valB)) continue;
      if (valA >= saturationThreshold || valB >= saturationThreshold) continue;

      const diff = valA - valB;
      sumSquaredDiff += (diff - meanDiff) * (diff - meanDiff);
    }

    // Var(A - B) = Var(A) + Var(B) = 2 * Var(Noise)
    // Thus Var(Noise) = Var(A - B) / 2
    const variance = (sumSquaredDiff / (validPixels - 1)) / 2;

    dataPoints.push({
      meanSignal,
      variance,
      exposureTime: expTime
    });

    logs.push(`Pair ${idx} (Exp: ${expTime}s): Mean Signal = ${meanSignal.toFixed(2)}, Variance = ${variance.toFixed(4)} (pixels sampled: ${validPixels})`);
  }

  // Sort by mean signal
  dataPoints.sort((p1, p2) => p1.meanSignal - p2.meanSignal);

  if (dataPoints.length < 2) {
    logs.push("Error: Fewer than two usable flat pairs remain after validation.");
    return {
      dataPoints,
      gain: 0,
      readNoise: 0,
      fullWellCapacity: 0,
      linearityRange: [0, 0],
      logs
    };
  }

  // Identify linear (photon-noise-dominated) region
  // Find point of maximum variance (onset of saturation/rollover)
  let maxVarIdx = 0;
  let maxVar = -1;
  for (let i = 0; i < dataPoints.length; i++) {
    if (dataPoints[i].variance > maxVar) {
      maxVar = dataPoints[i].variance;
      maxVarIdx = i;
    }
  }

  const rolloverPoint = dataPoints[maxVarIdx];
  logs.push(`Detected saturation/rollover onset at Mean Signal = ${rolloverPoint.meanSignal.toFixed(2)} ADU`);

  // Linear region is typically between 5% and 80% of the rollover signal
  const linearMin = rolloverPoint.meanSignal * 0.05;
  const linearMax = rolloverPoint.meanSignal * 0.80;

  const linearPoints = dataPoints.filter(
    p => p.meanSignal >= linearMin && p.meanSignal <= linearMax
  );

  logs.push(`Linear region candidate range: [${linearMin.toFixed(1)}, ${linearMax.toFixed(1)}] ADU. Points in range: ${linearPoints.length}`);

  let gain = 1.0;
  let readNoise = 0.0;
  let slope = 0.0;
  let intercept = 0.0;

  const pointsToFit = linearPoints.length >= 2 ? linearPoints : dataPoints.slice(0, Math.max(2, maxVarIdx));

  if (pointsToFit.length >= 2) {
    // Linear regression on Y = Variance, X = MeanSignal
    let sumX = 0, sumY = 0, sumXY = 0, sumXX = 0;
    const n = pointsToFit.length;
    for (const p of pointsToFit) {
      sumX += p.meanSignal;
      sumY += p.variance;
      sumXY += p.meanSignal * p.variance;
      sumXX += p.meanSignal * p.meanSignal;
    }

    const denom = n * sumXX - sumX * sumX;
    if (Math.abs(denom) > 1e-9) {
      slope = (n * sumXY - sumX * sumY) / denom;
      intercept = (sumY - slope * sumX) / n;
    } else {
      logs.push("Warning: Linear regression denominator near zero. Using defaults.");
    }
  }

  if (slope > 0) {
    // Var = Mean / Gain + ReadNoise^2 / Gain^2 in ADU^2
    // If Var(ADU) = Mean(ADU)/Gain, then Slope = 1 / Gain.
    gain = 1.0 / slope;
    // Intercept = ReadNoise^2 / Gain^2 (in ADU^2)
    // ReadNoise = sqrt(Intercept) * Gain (in electrons)
    const interceptClamped = Math.max(0, intercept);
    readNoise = Math.sqrt(interceptClamped) * gain;
    logs.push(`Fitted Slope = ${slope.toFixed(6)}, Intercept = ${intercept.toFixed(6)}`);
  } else {
    logs.push("Warning: Non-positive slope obtained from linear fit. Falling back to simple estimation.");
    // Fallback: estimate from the lowest signal point
    const firstPoint = dataPoints[0];
    if (firstPoint && firstPoint.meanSignal > 0) {
      gain = firstPoint.meanSignal / Math.max(1e-5, firstPoint.variance);
    }
  }

  const fullWellCapacity = rolloverPoint.meanSignal * gain;
  const linearityRange: [number, number] = [
    pointsToFit[0]?.meanSignal || 0,
    pointsToFit[pointsToFit.length - 1]?.meanSignal || rolloverPoint.meanSignal
  ];

  logs.push(`Analysis complete:`);
  logs.push(`- Measured Gain: ${gain.toFixed(4)} e-/ADU`);
  logs.push(`- Intercept-derived Read Noise: ${readNoise.toFixed(2)} e- (requires bias-subtracted flats)`);
  logs.push(`- Estimated Saturation Capacity: ${fullWellCapacity.toFixed(0)} e- (${rolloverPoint.meanSignal.toFixed(0)} ADU)`);
  logs.push(`- Linearity Range: ${linearityRange[0].toFixed(0)} to ${linearityRange[1].toFixed(0)} ADU`);

  return {
    dataPoints,
    gain,
    readNoise,
    fullWellCapacity,
    linearityRange,
    logs
  };
}
