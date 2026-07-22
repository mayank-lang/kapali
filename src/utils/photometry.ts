import { calculateStats } from './stretch';

export interface StarProfile {
  x: number;
  y: number;
  flux: number;
  fwhm: number;
  eccentricity: number;
}

export interface ImageQualityMetrics {
  fwhm: number;
  eccentricity: number;
  starsDetected: number;
  snrWeight: number; // dimensionless relative quality score, not a measured SNR
}

/**
 * Native TypeScript implementation of Star Detection and PSF FWHM calculation,
 * inspired by Siril's star_finder.c
 */
export function calculateImageMetrics(width: number, height: number, data: Float32Array): ImageQualityMetrics {
  const stats = calculateStats(data);
  // Rejection threshold: Median + 5 * MAD
  const threshold = stats.median + 5 * stats.mad;
  
  const stars: StarProfile[] = [];
  const searchRadius = 4; // 9x9 box
  
  // To avoid detecting the same star multiple times, keep a boolean mask
  // In a real optimized system, we'd use a sparse mask, but here we can just skip pixels close to known stars
  
  // Step grid by 2 to speed up initial search
  for (let y = searchRadius; y < height - searchRadius; y += 2) {
    for (let x = searchRadius; x < width - searchRadius; x += 2) {
      const idx = y * width + x;
      const val = data[idx];
      
      if (val > threshold) {
        // Check if it's a local maximum in a 3x3 box
        let isMax = true;
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            if (dy === 0 && dx === 0) continue;
            if (data[(y + dy) * width + (x + dx)] > val) {
              isMax = false;
              break;
            }
          }
          if (!isMax) break;
        }
        
        if (isMax) {
          // It's a local peak. Calculate centroid and FWHM in a 9x9 box
          let sumFlux = 0;
          let sumWx = 0;
          let sumWy = 0;
          
          for (let dy = -searchRadius; dy <= searchRadius; dy++) {
            for (let dx = -searchRadius; dx <= searchRadius; dx++) {
              const py = y + dy;
              const px = x + dx;
              const pval = Math.max(0, data[py * width + px] - stats.median); // background subtracted
              
              sumFlux += pval;
              sumWx += px * pval;
              sumWy += py * pval;
            }
          }
          
          if (sumFlux > 0) {
            const centroidX = sumWx / sumFlux;
            const centroidY = sumWy / sumFlux;
            
            // Calculate variance (sigma^2)
            let varX = 0;
            let varY = 0;
            let varXY = 0;
            
            for (let dy = -searchRadius; dy <= searchRadius; dy++) {
              for (let dx = -searchRadius; dx <= searchRadius; dx++) {
                const py = y + dy;
                const px = x + dx;
                const pval = Math.max(0, data[py * width + px] - stats.median);
                
                const dxC = px - centroidX;
                const dyC = py - centroidY;
                
                varX += pval * dxC * dxC;
                varY += pval * dyC * dyC;
                varXY += pval * dxC * dyC;
              }
            }
            
            varX /= sumFlux;
            varY /= sumFlux;
            varXY /= sumFlux;
            
            // FWHM calculation (Gaussian approximation)
            // FWHM = 2.355 * sigma
            const sigmaSq = (varX + varY) / 2;
            const sigma = Math.sqrt(Math.max(0.1, sigmaSq));
            const fwhm = 2.355 * sigma;
            
            // Eccentricity calculation from covariance matrix eigenvalues
            // e = sqrt(1 - minor^2 / major^2)
            const diff = varX - varY;
            const det = Math.sqrt(diff * diff + 4 * varXY * varXY);
            const majorSq = (varX + varY + det) / 2;
            const minorSq = (varX + varY - det) / 2;
            
            let eccentricity = 0;
            if (majorSq > 0 && minorSq > 0) {
              eccentricity = Math.sqrt(1 - minorSq / majorSq);
            }
            
            // Reject unphysical stars (e.g. hot pixels or massive saturated blobs)
            if (fwhm > 1.0 && fwhm < 15.0 && eccentricity >= 0 && eccentricity <= 1) {
              stars.push({
                x: centroidX,
                y: centroidY,
                flux: sumFlux,
                fwhm,
                eccentricity
              });
            }
          }
        }
      }
    }
  }

  // Aggregate metrics
  if (stars.length === 0) {
    return { fwhm: 99.9, eccentricity: 1.0, starsDetected: 0, snrWeight: 0 };
  }

  // Sort by flux to use the top N stars for robust statistics
  stars.sort((a, b) => b.flux - a.flux);
  const robustStars = stars.slice(0, Math.min(stars.length, 100));

  const medianFwhm = robustStars.map(s => s.fwhm).sort((a,b)=>a-b)[Math.floor(robustStars.length/2)];
  const medianEcc = robustStars.map(s => s.eccentricity).sort((a,b)=>a-b)[Math.floor(robustStars.length/2)];
  
  // Relative quality heuristic: more detections, sharper stars, and rounder PSFs.
  const snrWeight = Math.min(100, Math.max(1, (stars.length * 10) / (medianFwhm * (1 + medianEcc))));

  return {
    fwhm: parseFloat(medianFwhm.toFixed(2)),
    eccentricity: parseFloat(medianEcc.toFixed(2)),
    starsDetected: stars.length,
    snrWeight: parseFloat(snrWeight.toFixed(1))
  };
}
