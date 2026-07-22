/**
 * Atmospheric Physics and Extinction Correction Utility
 * Grounded in atmospheric optics, Rayleigh scattering, and Pickering airmass formulas.
 */

export interface ExtinctionResult {
  airmass: number;
  extinctionCoeffs: { r: number; g: number; b: number };   // mag per airmass
  correctionFactors: { r: number; g: number; b: number };  // multiplicative scale factor
  logs: string[];
}

export interface ObservationMetadata {
  ra?: number;
  dec?: number;
  dateObs?: string;
  airmass?: number;
  altitude?: number;
  latitude?: number;
  longitude?: number;
  siteElevation?: number;
}

/**
 * Computes airmass using the Pickering (2002) formula.
 * Altitude in degrees.
 */
export function computeAirmass(altitudeDeg: number): number {
  // Clamp altitude to a safe range (0.1 to 90 degrees) to prevent division by zero or negative values
  const alt = Math.max(0.1, Math.min(90.0, altitudeDeg));
  // Pickering (2002) formula
  const X = 1.0 / Math.sin((alt + 244.0 / (165.0 + 47.0 * Math.pow(alt, 1.1))) * Math.PI / 180.0);
  return X;
}

/**
 * Parses astronomical observation metadata from FITS headers.
 */
export function parseObservationMetadata(headers: { key: string; value: string }[]): ObservationMetadata {
  const meta: ObservationMetadata = {};

  const findHeader = (keys: string[]): string | undefined => {
    const card = headers.find(h => keys.includes(h.key.trim().toUpperCase()));
    return card ? card.value.replace(/['"]+/g, '').trim() : undefined;
  };

  const raStr = findHeader(['RA', 'OBJCTRA']);
  if (raStr) {
    // Parse HH:MM:SS or degrees
    if (raStr.includes(':')) {
      const parts = raStr.split(':').map(Number);
      if (parts.length >= 3 && parts.every(p => !isNaN(p))) {
        meta.ra = (parts[0] + parts[1] / 60 + parts[2] / 3600) * 15; // hours to degrees
      }
    } else {
      const val = parseFloat(raStr);
      if (!isNaN(val)) meta.ra = val;
    }
  }

  const decStr = findHeader(['DEC', 'OBJCTDEC']);
  if (decStr) {
    // Parse DD:MM:SS or degrees
    if (decStr.includes(':')) {
      const parts = decStr.split(':').map(Number);
      if (parts.length >= 3 && parts.every(p => !isNaN(p))) {
        const sign = parts[0] < 0 || decStr.startsWith('-') ? -1 : 1;
        meta.dec = parts[0] + sign * (parts[1] / 60 + parts[2] / 3600);
      }
    } else {
      const val = parseFloat(decStr);
      if (!isNaN(val)) meta.dec = val;
    }
  }

  meta.dateObs = findHeader(['DATE-OBS', 'DATE']);
  
  const airmassStr = findHeader(['AIRMASS', 'AMASS']);
  if (airmassStr && !isNaN(parseFloat(airmassStr))) {
    meta.airmass = parseFloat(airmassStr);
  }

  const altStr = findHeader(['ALTITUDE', 'ALT', 'CENTALT']);
  if (altStr && !isNaN(parseFloat(altStr))) {
    meta.altitude = parseFloat(altStr);
  }

  const latStr = findHeader(['SITELAT', 'LATITUDE', 'LAT']);
  if (latStr && !isNaN(parseFloat(latStr))) {
    meta.latitude = parseFloat(latStr);
  }

  const lonStr = findHeader(['SITELONG', 'LONGITUD', 'LONG', 'LON']);
  if (lonStr && !isNaN(parseFloat(lonStr))) {
    meta.longitude = parseFloat(lonStr);
  }

  const elevStr = findHeader(['SITEALT', 'ELEVATION', 'HEIGHT', 'ALT-OBS']);
  if (elevStr && !isNaN(parseFloat(elevStr))) {
    meta.siteElevation = parseFloat(elevStr);
  }

  return meta;
}

/**
 * Computes atmospheric extinction coefficients and multiplicative correction factors
 * based on Rayleigh scattering and site elevation.
 * Standard bands: R (620nm), G (530nm), B (450nm)
 */
export function computeExtinction(
  airmass: number,
  siteElevationM: number
): ExtinctionResult {
  const logs: string[] = [];
  logs.push(`Calculating atmospheric extinction...`);
  logs.push(`Airmass: ${airmass.toFixed(3)}`);
  logs.push(`Site Elevation: ${siteElevationM.toFixed(1)} m`);

  // Rayleigh scattering coefficient at sea level for reference wavelength 550nm
  const k0 = 0.1451; // mag per airmass
  const lambda0 = 550.0; // nm

  // Wavelengths of standard RGB channels in nm
  const lambdaR = 620.0;
  const lambdaG = 530.0;
  const lambdaB = 450.0;

  // Elevation scaling factor: scale height of Rayleigh atmosphere is ~8500 meters
  const elevationScale = Math.exp(-siteElevationM / 8500.0);

  // k(lambda) = k0 * (lambda0 / lambda)^4 * exp(-H / H_scale)
  const kR = k0 * Math.pow(lambda0 / lambdaR, 4) * elevationScale;
  const kG = k0 * Math.pow(lambda0 / lambdaG, 4) * elevationScale;
  const kB = k0 * Math.pow(lambda0 / lambdaB, 4) * elevationScale;

  logs.push(`Derived Extinction Coefficients (mag/airmass):`);
  logs.push(`- Red (620nm): ${kR.toFixed(4)}`);
  logs.push(`- Green (530nm): ${kG.toFixed(4)}`);
  logs.push(`- Blue (450nm): ${kB.toFixed(4)}`);

  // Multiplicative correction factors to restore unextinguished flux
  // Correction = 10^(0.4 * k * X)
  const factorR = Math.pow(10.0, 0.4 * kR * airmass);
  const factorG = Math.pow(10.0, 0.4 * kG * airmass);
  const factorB = Math.pow(10.0, 0.4 * kB * airmass);

  logs.push(`Multiplicative Correction Factors:`);
  logs.push(`- Red: ${factorR.toFixed(4)} (+${((factorR - 1) * 100).toFixed(1)}%)`);
  logs.push(`- Green: ${factorG.toFixed(4)} (+${((factorG - 1) * 100).toFixed(1)}%)`);
  logs.push(`- Blue: ${factorB.toFixed(4)} (+${((factorB - 1) * 100).toFixed(1)}%)`);

  return {
    airmass,
    extinctionCoeffs: { r: kR, g: kG, b: kB },
    correctionFactors: { r: factorR, g: factorG, b: factorB },
    logs
  };
}

/**
 * Applies extinction correction factors to image pixels.
 * Supports monochrome (applied green/average factor) and planar RGB.
 */
export function correctExtinction(
  data: Float32Array,
  width: number,
  height: number,
  correctionFactors: { r: number; g: number; b: number }
): Float32Array {
  const pixelCount = width * height;
  const channels = Math.floor(data.length / pixelCount) || 1;
  const result = new Float32Array(data.length);

  if (channels >= 3) {
    const rOffset = 0;
    const gOffset = pixelCount;
    const bOffset = pixelCount * 2;

    // Apply channel-specific corrections
    for (let i = 0; i < pixelCount; i++) {
      result[rOffset + i] = data[rOffset + i] * correctionFactors.r;
      result[gOffset + i] = data[gOffset + i] * correctionFactors.g;
      result[bOffset + i] = data[bOffset + i] * correctionFactors.b;
    }
    
    // Copy remaining channels if any (e.g. Alpha or narrowband)
    if (data.length > pixelCount * 3) {
      result.set(data.subarray(pixelCount * 3), pixelCount * 3);
    }
  } else {
    // Monochrome data - use green channel correction as proxy for visible spectrum
    const factor = correctionFactors.g;
    for (let i = 0; i < data.length; i++) {
      result[i] = data[i] * factor;
    }
  }

  return result;
}
