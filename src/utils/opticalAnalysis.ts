/**
 * Optical Aberration Field Analyzer
 * Grounded in optical physics and second-moment PSF analysis.
 */

import { calculateStats } from './stretch';

export interface PSFEllipse {
  gridX: number;        // Grid cell column index
  gridY: number;        // Grid cell row index
  centerX: number;      // Star centroid X in image coordinates
  centerY: number;      // Star centroid Y in image coordinates
  fwhmX: number;        // FWHM along major axis (pixels)
  fwhmY: number;        // FWHM along minor axis (pixels)
  angle: number;        // Orientation angle (radians, -pi/2 to pi/2)
  eccentricity: number; // 0 = perfect circle, 1 = fully elongated
  flux: number;         // Total flux of the star
  nStars: number;       // Number of stars used for this cell's average
}

export interface AberrationDiagnosis {
  coma: { severity: number; direction: number }; // 0-1 severity, direction in radians
  astigmatism: { severity: number };
  fieldCurvature: { severity: number };
  tilt: { severity: number; direction: number };
  overallScore: number; // 0 = perfect, 1 = severely aberrated
  summary: string;
}

export interface FieldPSFResult {
  grid: PSFEllipse[];
  gridCols: number;
  gridRows: number;
  diagnosis: AberrationDiagnosis;
  logs: string[];
}

/**
 * Detects stars and fits 2D Gaussian models across an NxN grid to analyze PSF.
 */
export function analyzeFieldPSF(
  data: Float32Array,
  width: number,
  height: number,
  gridSize: number // e.g., 5 for a 5x5 grid
): FieldPSFResult {
  const logs: string[] = [];
  logs.push(`Starting Field-wide PSF and Aberration analysis (Grid: ${gridSize}x${gridSize})...`);

  // Use only first channel plane (Luminance or Red) for star analysis
  const pixelCount = width * height;
  const chanData = data.subarray(0, pixelCount);

  // 1. Calculate stats of first channel to determine detection threshold
  const stats = calculateStats(chanData);
  const threshold = stats.median + 5.0 * stats.mad;
  logs.push(`Image stats: Median = ${stats.median.toFixed(5)}, MAD = ${stats.mad.toFixed(5)}`);
  logs.push(`Star detection threshold (median + 5*MAD) = ${threshold.toFixed(5)}`);

  // 2. Divide the image into grid cells
  const gridCols = gridSize;
  const gridRows = gridSize;
  const cellW = width / gridCols;
  const cellH = height / gridRows;

  const gridResults: PSFEllipse[] = [];

  // Loop over each grid cell
  for (let gy = 0; gy < gridRows; gy++) {
    for (let gx = 0; gx < gridCols; gx++) {
      const cellMinX = Math.floor(gx * cellW);
      const cellMaxX = Math.min(width - 1, Math.floor((gx + 1) * cellW));
      const cellMinY = Math.floor(gy * cellH);
      const cellMaxY = Math.min(height - 1, Math.floor((gy + 1) * cellH));

      // Local star detection in this cell
      const starsInCell: { x: number; y: number; val: number }[] = [];

      // Find local maxima in cell
      for (let y = cellMinY + 5; y < cellMaxY - 5; y += 2) {
        for (let x = cellMinX + 5; x < cellMaxX - 5; x += 2) {
          const idx = y * width + x;
          const val = chanData[idx];

          if (val > threshold && val < stats.max * 0.98) { // avoid saturated stars
            // Verify if local maximum in a 5x5 window
            let isMax = true;
            for (let wy = -2; wy <= 2; wy++) {
              for (let wx = -2; wx <= 2; wx++) {
                if (chanData[(y + wy) * width + (x + wx)] > val) {
                  isMax = false;
                  break;
                }
              }
              if (!isMax) break;
            }

            if (isMax) {
              starsInCell.push({ x, y, val });
            }
          }
        }
      }

      // Sort stars in cell by brightness, take top 5
      starsInCell.sort((a, b) => b.val - a.val);
      const targetStars = starsInCell.slice(0, 5);

      const cellPSFs: {
        centerX: number;
        centerY: number;
        fwhmX: number;
        fwhmY: number;
        angle: number;
        eccentricity: number;
        flux: number;
      }[] = [];

      // For each star, fit a 2D Gaussian using second moments in a 15x15 window
      const winSize = 7; // half-width
      for (const star of targetStars) {
        let sumI = 0;
        let sumX = 0;
        let sumY = 0;

        // Bounding box for local fitting window
        const wMinX = Math.max(0, star.x - winSize);
        const wMaxX = Math.min(width - 1, star.x + winSize);
        const wMinY = Math.max(0, star.y - winSize);
        const wMaxY = Math.min(height - 1, star.y + winSize);

        // First pass: compute centroid
        // Subtract local background (we use local minimum in window as proxy)
        let minLocalVal = star.val;
        for (let wy = wMinY; wy <= wMaxY; wy++) {
          for (let wx = wMinX; wx <= wMaxX; wx++) {
            const v = chanData[wy * width + wx];
            if (v < minLocalVal) minLocalVal = v;
          }
        }

        for (let wy = wMinY; wy <= wMaxY; wy++) {
          for (let wx = wMinX; wx <= wMaxX; wx++) {
            const val = Math.max(0, chanData[wy * width + wx] - minLocalVal);
            sumI += val;
            sumX += val * wx;
            sumY += val * wy;
          }
        }

        if (sumI <= 0) continue;

        const xc = sumX / sumI;
        const yc = sumY / sumI;

        // Second pass: compute central moments
        let muXX = 0;
        let muYY = 0;
        let muXY = 0;

        for (let wy = wMinY; wy <= wMaxY; wy++) {
          const dy = wy - yc;
          for (let wx = wMinX; wx <= wMaxX; wx++) {
            const dx = wx - xc;
            const val = Math.max(0, chanData[wy * width + wx] - minLocalVal);
            muXX += val * dx * dx;
            muYY += val * dy * dy;
            muXY += val * dx * dy;
          }
        }

        muXX /= sumI;
        muYY /= sumI;
        muXY /= sumI;

        // Eigenvalues of covariance matrix
        // C = [ muXX, muXY ]
        //     [ muXY, muYY ]
        const trace = muXX + muYY;
        const det = muXX * muYY - muXY * muXY;
        const term = Math.sqrt(Math.max(0, (trace * trace) / 4.0 - det));
        
        const lambda1 = trace / 2.0 + term; // Eigenvalue 1 (major)
        const lambda2 = Math.max(0, trace / 2.0 - term); // Eigenvalue 2 (minor)

        if (lambda1 <= 0.05) continue; // too small, likely noise

        const sigmaX = Math.sqrt(lambda1);
        const sigmaY = Math.sqrt(lambda2);

        // FWHM = 2.355 * sigma
        const fwhmX = 2.355 * sigmaX;
        const fwhmY = 2.355 * sigmaY;

        // Orientation angle theta = 0.5 * atan2(2 * muXY, muXX - muYY)
        const angle = 0.5 * Math.atan2(2 * muXY, muXX - muYY);

        // Eccentricity e = sqrt(1 - lambda2 / lambda1)
        const eccentricity = Math.sqrt(Math.max(0, 1.0 - lambda2 / lambda1));

        cellPSFs.push({
          centerX: xc,
          centerY: yc,
          fwhmX,
          fwhmY,
          angle,
          eccentricity,
          flux: sumI
        });
      }

      if (cellPSFs.length > 0) {
        // Average PSF parameters for the cell using median
        const getMedianOfProp = (arr: any[], prop: string): number => {
          const sorted = arr.map(x => x[prop]).sort((a, b) => a - b);
          const mid = Math.floor(sorted.length / 2);
          return sorted.length % 2 !== 0 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
        };

        const avgX = cellMinX + cellW / 2;
        const avgY = cellMinY + cellH / 2;
        
        gridResults.push({
          gridX: gx,
          gridY: gy,
          centerX: avgX,
          centerY: avgY,
          fwhmX: getMedianOfProp(cellPSFs, 'fwhmX'),
          fwhmY: getMedianOfProp(cellPSFs, 'fwhmY'),
          angle: getMedianOfProp(cellPSFs, 'angle'),
          eccentricity: getMedianOfProp(cellPSFs, 'eccentricity'),
          flux: getMedianOfProp(cellPSFs, 'flux'),
          nStars: cellPSFs.length
        });
      } else {
        // Empty cell fallback - placeholder with 0 stars
        gridResults.push({
          gridX: gx,
          gridY: gy,
          centerX: cellMinX + cellW / 2,
          centerY: cellMinY + cellH / 2,
          fwhmX: 0,
          fwhmY: 0,
          angle: 0,
          eccentricity: 0,
          flux: 0,
          nStars: 0
        });
      }
    }
  }

  // 3. Diagnose Aberrations
  const diagnosis = diagnoseAberrations(gridResults, width, height);

  logs.push(`Aberration Field diagnosis complete.`);
  logs.push(`- Coma Severity: ${(diagnosis.coma.severity * 100).toFixed(1)}%`);
  logs.push(`- Astigmatism Severity: ${(diagnosis.astigmatism.severity * 100).toFixed(1)}%`);
  logs.push(`- Field Curvature Severity: ${(diagnosis.fieldCurvature.severity * 100).toFixed(1)}%`);
  logs.push(`- Tilt Severity: ${(diagnosis.tilt.severity * 100).toFixed(1)}%`);
  logs.push(`Overall Optical Quality Score: ${((1 - diagnosis.overallScore) * 100).toFixed(1)}/100`);

  return {
    grid: gridResults,
    gridCols,
    gridRows,
    diagnosis,
    logs
  };
}

/**
 * Heuristic diagnostics based on spatial pattern of PSF ellipses.
 */
function diagnoseAberrations(
  grid: PSFEllipse[],
  width: number,
  height: number
): AberrationDiagnosis {
  const centerImageX = width / 2;
  const centerImageY = height / 2;
  const maxRadius = Math.sqrt(centerImageX * centerImageX + centerImageY * centerImageY);

  // Filter grid cells that actually have stars
  const validCells = grid.filter(cell => cell.nStars > 0 && cell.fwhmX > 0);

  if (validCells.length < 5) {
    return {
      coma: { severity: 0, direction: 0 },
      astigmatism: { severity: 0 },
      fieldCurvature: { severity: 0 },
      tilt: { severity: 0, direction: 0 },
      overallScore: 0,
      summary: "Insufficient stars detected across field of view to perform aberration analysis."
    };
  }

  // --- 1. Field Curvature ---
  // Definition: FWHM increases quadratically/radially from center
  // Compute correlation between average FWHM and distance from optical center
  let sumR = 0, sumF = 0, sumRF = 0, sumRR = 0, sumFF = 0;
  const n = validCells.length;

  for (const cell of validCells) {
    const dx = cell.centerX - centerImageX;
    const dy = cell.centerY - centerImageY;
    const r = Math.sqrt(dx * dx + dy * dy);
    const avgFWHM = (cell.fwhmX + cell.fwhmY) / 2;

    sumR += r;
    sumF += avgFWHM;
    sumRF += r * avgFWHM;
    sumRR += r * r;
    sumFF += avgFWHM * avgFWHM;
  }

  const denom = Math.sqrt((n * sumRR - sumR * sumR) * (n * sumFF - sumF * sumF));
  let fcCorrelation = 0;
  if (denom > 0) {
    fcCorrelation = (n * sumRF - sumR * sumF) / denom;
  }

  // Field curvature is high if FWHM is strongly positively correlated with distance from center
  const fcSeverity = Math.max(0, Math.min(1.0, fcCorrelation));

  // --- 2. Coma ---
  // Definition: Elongation oriented radially, increasing with distance from center
  let comaIntensitySum = 0;
  let comaCount = 0;
  let netComaX = 0;
  let netComaY = 0;

  for (const cell of validCells) {
    const dx = cell.centerX - centerImageX;
    const dy = cell.centerY - centerImageY;
    const r = Math.sqrt(dx * dx + dy * dy);
    if (r < 50) continue; // skip central region where radial angle is poorly defined

    const radialAngle = Math.atan2(dy, dx);
    // PSF angle is in range [-pi/2, pi/2]
    // Map radial angle to [-pi/2, pi/2]
    let normalRadialAngle = radialAngle;
    while (normalRadialAngle > Math.PI / 2) normalRadialAngle -= Math.PI;
    while (normalRadialAngle < -Math.PI / 2) normalRadialAngle += Math.PI;

    // Alignment: cos(2 * (angle - normalRadialAngle))
    // 1 if parallel, -1 if perpendicular
    const alignment = Math.cos(2.0 * (cell.angle - normalRadialAngle));
    
    // Coma grows with distance, weighted by eccentricity
    const weight = (r / maxRadius) * cell.eccentricity;
    comaIntensitySum += alignment * weight;
    comaCount++;

    // Net orientation direction
    if (alignment > 0) {
      netComaX += cell.eccentricity * Math.cos(cell.angle);
      netComaY += cell.eccentricity * Math.sin(cell.angle);
    }
  }

  const comaSeverity = comaCount > 0 ? Math.max(0, Math.min(1.0, comaIntensitySum / comaCount)) : 0;
  const comaDirection = Math.atan2(netComaY, netComaX);

  // --- 3. Astigmatism ---
  // Definition: Elongation direction rotates tangentially/symmetrically with field angle
  // (perpendicular to coma pattern)
  let astigIntensitySum = 0;
  let astigCount = 0;

  for (const cell of validCells) {
    const dx = cell.centerX - centerImageX;
    const dy = cell.centerY - centerImageY;
    const r = Math.sqrt(dx * dx + dy * dy);
    if (r < 50) continue;

    const radialAngle = Math.atan2(dy, dx);
    const tangentialAngle = radialAngle + Math.PI / 2; // perpendicular
    let normalTangentialAngle = tangentialAngle;
    while (normalTangentialAngle > Math.PI / 2) normalTangentialAngle -= Math.PI;
    while (normalTangentialAngle < -Math.PI / 2) normalTangentialAngle += Math.PI;

    const alignment = Math.cos(2.0 * (cell.angle - normalTangentialAngle));
    const weight = (r / maxRadius) * cell.eccentricity;
    astigIntensitySum += alignment * weight;
    astigCount++;
  }

  const astigSeverity = astigCount > 0 ? Math.max(0, Math.min(1.0, astigIntensitySum / astigCount)) : 0;

  // --- 4. Sensor Tilt ---
  // Definition: FWHM gradient is linear across field (planar tilt)
  // Fit a plane: FWHM = A * X + B * Y + C
  let tiltSeverity = 0;
  let tiltDirection = 0;

  // Linear regression to fit a plane: Z = A*X + B*Y + C
  // Z = FWHM, X = centerX, Y = centerY
  let sX = 0, sY = 0, sZ = 0;
  let sXX = 0, sYY = 0, sXY = 0, sXZ = 0, sYZ = 0;

  for (const cell of validCells) {
    const x = cell.centerX;
    const y = cell.centerY;
    const z = (cell.fwhmX + cell.fwhmY) / 2;

    sX += x; sY += y; sZ += z;
    sXX += x * x; sYY += y * y; sXY += x * y;
    sXZ += x * z; sYZ += y * z;
  }

  // Linear equation system matrix (3x3):
  // [ sXX  sXY  sX ] [ A ]   [ sXZ ]
  // [ sXY  sYY  sY ] [ B ] = [ sYZ ]
  // [ sX   sY   n  ] [ C ]   [ sZ  ]
  const det3 =
    sXX * (sYY * n - sY * sY) -
    sXY * (sXY * n - sY * sX) +
    sX * (sXY * sY - sYY * sX);

  if (Math.abs(det3) > 1e-3) {
    const detA =
      sXZ * (sYY * n - sY * sY) -
      sXY * (sYZ * n - sY * sZ) +
      sX * (sYZ * sY - sYY * sZ);
    const detB =
      sXX * (sYZ * n - sY * sZ) -
      sXZ * (sXY * n - sY * sX) +
      sX * (sXY * sZ - sYZ * sX);

    const A = detA / det3; // X gradient
    const B = detB / det3; // Y gradient

    // Magnitude of gradient is proportional to tilt severity
    const gradMagnitude = Math.sqrt(A * A + B * B);
    
    // Normalize tilt severity relative to average FWHM
    const avgFWHM = sZ / n;
    tiltSeverity = Math.min(1.0, (gradMagnitude * Math.max(width, height)) / (2.0 * avgFWHM));
    tiltDirection = Math.atan2(B, A);
  }

  // --- Summary ---
  const overallScore = Math.max(
    0.1, // baseline
    (fcSeverity * 0.3 + comaSeverity * 0.3 + astigSeverity * 0.2 + tiltSeverity * 0.2)
  );

  let summary = "Stars appear sharp and symmetric across the field of view.";
  const issues: string[] = [];

  if (fcSeverity > 0.4) issues.push("Field Curvature (stars swell at edges)");
  if (comaSeverity > 0.4) issues.push("Coma (radial star elongation)");
  if (astigSeverity > 0.4) issues.push("Astigmatism (tangential/elliptical distortion)");
  if (tiltSeverity > 0.3) issues.push("Sensor Tilt (uneven focal plane, one side softer)");

  if (issues.length > 0) {
    summary = `Detected optical anomalies: ${issues.join(', ')}.`;
  }

  return {
    coma: { severity: comaSeverity, direction: comaDirection },
    astigmatism: { severity: astigSeverity },
    fieldCurvature: { severity: fcSeverity },
    tilt: { severity: tiltSeverity, direction: tiltDirection },
    overallScore,
    summary
  };
}
