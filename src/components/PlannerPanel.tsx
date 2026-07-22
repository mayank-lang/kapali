import React, { useState, useMemo, useCallback } from 'react';
import { MapPin, Search, Clock, Telescope, RefreshCw } from 'lucide-react';

// ─── Astronomical Math ────────────────────────────────────────────────────────

function toJD(y: number, mo: number, d: number, h: number): number {
  if (mo <= 2) { y--; mo += 12; }
  const A = Math.floor(y / 100);
  const B = 2 - A + Math.floor(A / 4);
  return Math.floor(365.25 * (y + 4716)) + Math.floor(30.6001 * (mo + 1)) + d + h / 24.0 + B - 1524.5;
}

function gmst(jd: number): number {
  const T = (jd - 2451545.0) / 36525.0;
  const θ = 280.46061837 + 360.98564736629 * (jd - 2451545.0)
             + 0.000387933 * T * T - (T * T * T) / 38710000;
  return ((θ % 360) + 360) % 360;
}

function lst(jd: number, lon: number): number {
  return ((gmst(jd) + lon) % 360 + 360) % 360;
}

function altAtHourAngle(haDeg: number, decDeg: number, latDeg: number): number {
  const ha  = haDeg  * Math.PI / 180;
  const dec = decDeg * Math.PI / 180;
  const lat = latDeg * Math.PI / 180;
  const sinAlt = Math.sin(dec) * Math.sin(lat) + Math.cos(dec) * Math.cos(lat) * Math.cos(ha);
  return Math.asin(Math.max(-1, Math.min(1, sinAlt))) * 180 / Math.PI;
}

function targetAlt(raDeg: number, decDeg: number, latDeg: number, jd: number, lonDeg: number): number {
  const L = lst(jd, lonDeg);
  const ha = ((L - raDeg) % 360 + 360) % 360;
  return altAtHourAngle(ha, decDeg, latDeg);
}

/** Moon position (accuracy ≈1°, good for planning) */
function moonEquatorial(jd: number): { ra: number; dec: number } {
  const d = jd - 2451545.0;
  const L = ((218.316 + 13.176396 * d) % 360 + 360) % 360;
  const M = ((134.963 + 13.064993 * d) % 360 + 360) % 360;
  const F = ((93.272  + 13.229350 * d) % 360 + 360) % 360;

  const lam = (L + 6.289 * Math.sin(M * Math.PI / 180)) * Math.PI / 180;
  const bet = (5.128 * Math.sin(F * Math.PI / 180)) * Math.PI / 180;
  const eps = (23.4393 - 0.0000004 * d) * Math.PI / 180;

  const ra  = Math.atan2(Math.sin(lam) * Math.cos(eps) - Math.tan(bet) * Math.sin(eps), Math.cos(lam)) * 180 / Math.PI;
  const dec = Math.asin(Math.sin(bet) * Math.cos(eps) + Math.cos(bet) * Math.sin(eps) * Math.sin(lam)) * 180 / Math.PI;
  return { ra: (ra + 360) % 360, dec };
}

/** Moon phase 0=new … 0.5=full */
function moonPhase(jd: number): number {
  const k = (jd - 2451550.1) / 29.53058853;
  return ((k % 1) + 1) % 1;
}

/** Angular separation in degrees */
function angularSep(ra1: number, dec1: number, ra2: number, dec2: number): number {
  const r1 = ra1 * Math.PI / 180, d1 = dec1 * Math.PI / 180;
  const r2 = ra2 * Math.PI / 180, d2 = dec2 * Math.PI / 180;
  const cos = Math.sin(d1) * Math.sin(d2) + Math.cos(d1) * Math.cos(d2) * Math.cos(r1 - r2);
  return Math.acos(Math.max(-1, Math.min(1, cos))) * 180 / Math.PI;
}

// ─── FOV presets ─────────────────────────────────────────────────────────────
const SENSOR_PRESETS: { name: string; w: number; h: number }[] = [
  { name: 'Custom',                w: 0,     h: 0     },
  { name: 'ASI2600MM (6248×4176)', w: 28.3,  h: 18.9  },
  { name: 'ASI1600MM (4656×3520)', w: 17.7,  h: 13.4  },
  { name: 'IMX294 (4144×2822)',    w: 19.1,  h: 13.0  },
  { name: 'IMX571 (6244×4168)',    w: 23.5,  h: 15.7  },
  { name: 'Full Frame 24MP',       w: 35.9,  h: 24.0  },
  { name: 'APS-C (Canon)',         w: 22.3,  h: 14.9  },
  { name: 'APS-C (Nikon/Sony)',    w: 23.5,  h: 15.6  },
];

// ─── Component ───────────────────────────────────────────────────────────────

interface PlannerPanelProps {
  addLog: (type: 'info' | 'success' | 'warning' | 'error', msg: string) => void;
}

export const PlannerPanel: React.FC<PlannerPanelProps> = ({ addLog }) => {
  // Observer
  const [lat, setLat]   = useState(48.85);
  const [lon, setLon]   = useState(2.35);
  const [locName, setLocName] = useState('Paris, France');

  // Date/time
  const today = new Date();
  const [dateStr, setDateStr] = useState(
    `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`
  );

  // Target
  const [targetName, setTargetName] = useState('');
  const [ra, setRa]   = useState(83.82);  // Orion Nebula default
  const [dec, setDec] = useState(-5.39);
  const [isResolving, setIsResolving] = useState(false);

  // Planner settings
  const [minAlt, setMinAlt] = useState(25);

  // FOV Calculator
  const [focalLen, setFocalLen] = useState(700);
  const [sensorPreset, setSensorPreset] = useState(0);
  const [sensorW, setSensorW] = useState(23.5);
  const [sensorH, setSensorH] = useState(15.6);
  const [pixelSizeMu, setPixelSizeMu] = useState(3.76);

  const handleSensorPreset = (idx: number) => {
    setSensorPreset(idx);
    const p = SENSOR_PRESETS[idx];
    if (p.w > 0) { setSensorW(p.w); setSensorH(p.h); }
  };

  const fovW  = focalLen > 0 ? (sensorW / focalLen) * (180 / Math.PI) : 0;
  const fovH  = focalLen > 0 ? (sensorH / focalLen) * (180 / Math.PI) : 0;
  const platescale = focalLen > 0 ? (pixelSizeMu / focalLen) * 206.265 : 0;

  // Resolve target name via CDS Sesame
  const resolveTarget = useCallback(async () => {
    if (!targetName.trim()) return;
    setIsResolving(true);
    try {
      const url = `https://cdsweb.u-strasbg.fr/cgi-bin/nph-sesame/-A?${encodeURIComponent(targetName.trim())}`;
      const res = await fetch(url);
      const text = await res.text();
      const match = text.match(/%J\s+([\d.\-]+)\s+([\d.\-]+)/);
      if (!match) throw new Error(`Could not resolve "${targetName}"`);
      setRa(parseFloat(match[1]));
      setDec(parseFloat(match[2]));
      addLog('success', `Resolved ${targetName}: RA=${parseFloat(match[1]).toFixed(4)}° Dec=${parseFloat(match[2]).toFixed(4)}°`);
    } catch (e: any) {
      addLog('error', e.message);
    } finally {
      setIsResolving(false);
    }
  }, [targetName, addLog]);

  // Use browser geolocation
  const geolocate = () => {
    if (!navigator.geolocation) { addLog('warning', 'Geolocation not available in this browser.'); return; }
    navigator.geolocation.getCurrentPosition(
      pos => { setLat(pos.coords.latitude); setLon(pos.coords.longitude); setLocName('Current location'); addLog('success', `Location set: ${pos.coords.latitude.toFixed(4)}°, ${pos.coords.longitude.toFixed(4)}°`); },
      () => addLog('error', 'Could not obtain GPS location.')
    );
  };

  // Compute altitude curve  (UTC midnight of selected date, then 24h)
  const curve = useMemo(() => {
    const [y, mo, d] = dateStr.split('-').map(Number);
    if (!y || !mo || !d) return { alts: [] as number[], moonAlts: [] as number[], moonPos: { ra: 0, dec: 0 }, phase: 0, sep: 0, jdMidnight: 0 };

    const jdMidnight = toJD(y, mo, d, 12); // local "noon" as anchor; we'll shift to evening
    const hours: number[] = [];
    for (let i = 0; i <= 24; i++) hours.push(i);

    // Build altitude curve starting from 12:00 UT (good enough for visual planning)
    const alts = hours.map(h => {
      const jd = toJD(y, mo, d, h);
      return targetAlt(ra, dec, lat, jd, lon);
    });

    const moonPos = moonEquatorial(jdMidnight);
    const moonAlts = hours.map(h => {
      const jd = toJD(y, mo, d, h);
      return targetAlt(moonPos.ra, moonPos.dec, lat, jd, lon);
    });

    const phase = moonPhase(jdMidnight);
    const sep   = angularSep(ra, dec, moonPos.ra, moonPos.dec);

    return { alts, moonAlts, moonPos, phase, sep, jdMidnight };
  }, [dateStr, ra, dec, lat, lon]);

  // Best imaging window above minAlt
  const imagingHours = useMemo(() => {
    return curve.alts.filter(a => a >= minAlt).length;
  }, [curve.alts, minAlt]);

  const maxAlt = useMemo(() => Math.max(...curve.alts, 0), [curve.alts]);

  // SVG altitude chart
  const chartW = 340, chartH = 120;
  const padL = 36, padB = 24, padT = 8, padR = 8;
  const iW = chartW - padL - padR;
  const iH = chartH - padT - padB;

  const toX = (i: number) => padL + (i / 24) * iW;
  const toY = (alt: number) => padT + iH - ((alt + 10) / 100) * iH;

  const curvePath = (alts: number[]) =>
    alts.map((a, i) => `${i === 0 ? 'M' : 'L'}${toX(i).toFixed(1)},${toY(a).toFixed(1)}`).join(' ');

  const phaseLabel = curve.phase < 0.1 || curve.phase > 0.9 ? 'New' :
    curve.phase < 0.25 ? 'Crescent' : curve.phase < 0.4 ? 'Quarter' :
    curve.phase < 0.6 ? 'Full' : curve.phase < 0.75 ? 'Gibbous' : 'Quarter';

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem', height: '100%', overflowY: 'auto' }}>

      {/* Header */}
      <div className="sidebar-module-header">
        <h2 className="sidebar-module-title">
          <Telescope size={16} color="var(--accent-purple)" />
          Session Planner
        </h2>
        <p className="sidebar-module-desc">Plan your imaging session: target visibility, moon phase, and optimal window.</p>
      </div>

      {/* Observer */}
      <div className="control-card">
        <div className="control-card-title"><MapPin size={12} /> Observer Location</div>
        <div style={{ display: 'flex', gap: '0.4rem' }}>
          <label className="form-label" style={{ flex: 1 }}>
            <span>Latitude (°N)</span>
            <input className="input-number" type="number" step="0.01" value={lat} onChange={e => setLat(parseFloat(e.target.value) || 0)} />
          </label>
          <label className="form-label" style={{ flex: 1 }}>
            <span>Longitude (°E)</span>
            <input className="input-number" type="number" step="0.01" value={lon} onChange={e => setLon(parseFloat(e.target.value) || 0)} />
          </label>
        </div>
        <div style={{ display: 'flex', gap: '0.4rem', alignItems: 'center' }}>
          <input className="input-text" style={{ flex: 1 }} placeholder="Location label" value={locName} onChange={e => setLocName(e.target.value)} />
          <button className="btn-secondary" style={{ padding: '0.35rem 0.5rem', flexShrink: 0 }} onClick={geolocate} title="Use GPS">
            <MapPin size={12} />
          </button>
        </div>
      </div>

      {/* Target & Date */}
      <div className="control-card">
        <div className="control-card-title"><Search size={12} /> Target</div>
        <div style={{ display: 'flex', gap: '0.4rem' }}>
          <input className="input-text" style={{ flex: 1 }} placeholder="Object name (e.g. M42, NGC 7293)" value={targetName} onChange={e => setTargetName(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && resolveTarget()} />
          <button className="btn-primary" style={{ padding: '0.35rem 0.5rem', flexShrink: 0 }} onClick={resolveTarget} disabled={isResolving} title="Resolve">
            {isResolving ? <RefreshCw size={12} style={{ animation: 'spin 1s linear infinite' }} /> : <Search size={12} />}
          </button>
        </div>
        <div style={{ display: 'flex', gap: '0.4rem' }}>
          <label className="form-label" style={{ flex: 1 }}>
            <span>RA (°)</span>
            <input className="input-number" type="number" step="0.001" value={ra.toFixed(4)} onChange={e => setRa(parseFloat(e.target.value) || 0)} />
          </label>
          <label className="form-label" style={{ flex: 1 }}>
            <span>Dec (°)</span>
            <input className="input-number" type="number" step="0.001" value={dec.toFixed(4)} onChange={e => setDec(parseFloat(e.target.value) || 0)} />
          </label>
        </div>
        <label className="form-label">
          <span>Observation Date</span>
          <input className="input-text" type="date" value={dateStr} onChange={e => setDateStr(e.target.value)} />
        </label>
      </div>

      {/* Altitude curve */}
      <div className="control-card">
        <div className="control-card-title"><Clock size={12} /> 24-Hour Altitude Curve</div>

        <svg width="100%" viewBox={`0 0 ${chartW} ${chartH}`} style={{ display: 'block', overflow: 'visible' }}>
          {/* Background */}
          <rect x={padL} y={padT} width={iW} height={iH} fill="#070a0f" rx="2" />

          {/* Night shading (rough: 20:00–04:00 UT) */}
          {[20, 21, 22, 23, 0, 1, 2, 3].map(h => {
            const x0 = toX(h);
            return <rect key={h} x={x0} y={padT} width={iW / 24} height={iH} fill="rgba(30,40,80,0.35)" />;
          })}

          {/* Horizon */}
          <line x1={padL} y1={toY(0)} x2={chartW - padR} y2={toY(0)} stroke="rgba(239,68,68,0.5)" strokeWidth="1" strokeDasharray="3,3" />

          {/* Minimum altitude guide */}
          <line x1={padL} y1={toY(minAlt)} x2={chartW - padR} y2={toY(minAlt)} stroke="rgba(245,158,11,0.45)" strokeWidth="1" strokeDasharray="3,3" />
          <text x={padL + 2} y={toY(minAlt) - 3} fontSize="8" fill="rgba(245,158,11,0.7)">{minAlt}°</text>

          {/* Moon curve */}
          {curve.moonAlts.length > 0 && (
            <path d={curvePath(curve.moonAlts)} fill="none" stroke="rgba(200,190,120,0.35)" strokeWidth="1.5" strokeDasharray="4,3" />
          )}

          {/* Target curve */}
          {curve.alts.length > 0 && (
            <path d={curvePath(curve.alts)} fill="none" stroke="var(--accent-blue)" strokeWidth="2" strokeLinecap="round" />
          )}

          {/* X axis labels (every 6h) */}
          {[0, 6, 12, 18, 24].map(h => (
            <g key={h}>
              <line x1={toX(h)} y1={padT + iH} x2={toX(h)} y2={padT + iH + 4} stroke="rgba(255,255,255,0.2)" strokeWidth="1" />
              <text x={toX(h)} y={chartH - 4} fontSize="8" fill="rgba(255,255,255,0.4)" textAnchor="middle">{h === 24 ? '0h' : `${h}h`}</text>
            </g>
          ))}

          {/* Y axis labels */}
          {[0, 30, 60, 90].map(alt => (
            <g key={alt}>
              <text x={padL - 3} y={toY(alt) + 3} fontSize="8" fill="rgba(255,255,255,0.4)" textAnchor="end">{alt}°</text>
            </g>
          ))}

          {/* Legend */}
          <line x1={chartW - 90} y1={padT + 8} x2={chartW - 75} y2={padT + 8} stroke="var(--accent-blue)" strokeWidth="2" />
          <text x={chartW - 72} y={padT + 11} fontSize="8" fill="rgba(255,255,255,0.6)">Target</text>
          <line x1={chartW - 90} y1={padT + 19} x2={chartW - 75} y2={padT + 19} stroke="rgba(200,190,120,0.5)" strokeWidth="1.5" strokeDasharray="4,3" />
          <text x={chartW - 72} y={padT + 22} fontSize="8" fill="rgba(255,255,255,0.4)">Moon</text>
        </svg>

        {/* Min alt slider */}
        <div>
          <div className="form-label-row"><span>Minimum imaging altitude:</span><span>{minAlt}°</span></div>
          <input type="range" min="5" max="60" step="5" value={minAlt} onChange={e => setMinAlt(parseInt(e.target.value))} className="input-range" />
        </div>
      </div>

      {/* Session Summary */}
      <div className="control-card">
        <div className="control-card-title">Session Summary</div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.4rem', fontSize: '0.75rem' }}>
          <div style={{ padding: '0.4rem', backgroundColor: 'var(--bg-deep)', borderRadius: '4px', border: '1px solid var(--border)' }}>
            <div style={{ color: 'var(--text-muted)', fontSize: '0.65rem', marginBottom: '0.15rem' }}>ABOVE {minAlt}°</div>
            <div style={{ color: imagingHours >= 4 ? 'var(--success)' : imagingHours >= 2 ? 'var(--warning)' : 'var(--danger)', fontWeight: 700, fontFamily: 'var(--font-mono)' }}>
              ~{imagingHours}h
            </div>
          </div>
          <div style={{ padding: '0.4rem', backgroundColor: 'var(--bg-deep)', borderRadius: '4px', border: '1px solid var(--border)' }}>
            <div style={{ color: 'var(--text-muted)', fontSize: '0.65rem', marginBottom: '0.15rem' }}>MAX ALTITUDE</div>
            <div style={{ color: 'var(--accent-blue)', fontWeight: 700, fontFamily: 'var(--font-mono)' }}>
              {maxAlt.toFixed(1)}°
            </div>
          </div>
          <div style={{ padding: '0.4rem', backgroundColor: 'var(--bg-deep)', borderRadius: '4px', border: '1px solid var(--border)' }}>
            <div style={{ color: 'var(--text-muted)', fontSize: '0.65rem', marginBottom: '0.15rem' }}>MOON PHASE</div>
            <div style={{ fontWeight: 700, fontFamily: 'var(--font-mono)' }}>
              {phaseLabel} {(curve.phase * 100).toFixed(0)}%
            </div>
          </div>
          <div style={{ padding: '0.4rem', backgroundColor: 'var(--bg-deep)', borderRadius: '4px', border: '1px solid var(--border)' }}>
            <div style={{ color: 'var(--text-muted)', fontSize: '0.65rem', marginBottom: '0.15rem' }}>MOON SEPARATION</div>
            <div style={{ color: curve.sep < 30 ? 'var(--danger)' : curve.sep < 60 ? 'var(--warning)' : 'var(--success)', fontWeight: 700, fontFamily: 'var(--font-mono)' }}>
              {curve.sep.toFixed(1)}°
            </div>
          </div>
        </div>
        <div style={{ marginTop: '0.3rem', padding: '0.4rem', backgroundColor: 'var(--bg-deep)', borderRadius: '4px', border: '1px solid var(--border)', fontSize: '0.7rem', color: 'var(--text-muted)', lineHeight: 1.4 }}>
          {imagingHours < 2
            ? 'Target barely visible this night — consider a different date or target.'
            : curve.sep < 30
            ? 'Moon is close to target — expect light pollution in broadband; consider waiting for new moon.'
            : curve.phase > 0.7
            ? 'Bright moon tonight — narrowband filters will help considerably.'
            : imagingHours >= 6
            ? 'Excellent session window. Target is well-placed above the horizon.'
            : 'Decent window. Aim for the peak altitude window for the best results.'}
        </div>
      </div>

      {/* FOV Calculator */}
      <div className="control-card">
        <div className="control-card-title"><Telescope size={12} /> FOV / Plate Scale Calculator</div>
        <label className="form-label">
          <span>Telescope Focal Length (mm)</span>
          <input className="input-number" type="number" step="1" min="1" value={focalLen} onChange={e => setFocalLen(parseFloat(e.target.value) || 700)} />
        </label>
        <label className="form-label">
          <span>Sensor Preset</span>
          <select className="input-select" value={sensorPreset} onChange={e => handleSensorPreset(parseInt(e.target.value))}>
            {SENSOR_PRESETS.map((s, i) => <option key={i} value={i}>{s.name}</option>)}
          </select>
        </label>
        <div style={{ display: 'flex', gap: '0.4rem' }}>
          <label className="form-label" style={{ flex: 1 }}>
            <span>Sensor Width (mm)</span>
            <input className="input-number" type="number" step="0.1" value={sensorW} onChange={e => { setSensorW(parseFloat(e.target.value) || 0); setSensorPreset(0); }} />
          </label>
          <label className="form-label" style={{ flex: 1 }}>
            <span>Sensor Height (mm)</span>
            <input className="input-number" type="number" step="0.1" value={sensorH} onChange={e => { setSensorH(parseFloat(e.target.value) || 0); setSensorPreset(0); }} />
          </label>
        </div>
        <label className="form-label">
          <span>Pixel Size (μm)</span>
          <input className="input-number" type="number" step="0.01" value={pixelSizeMu} onChange={e => setPixelSizeMu(parseFloat(e.target.value) || 3.76)} />
        </label>

        {/* Results */}
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '0.35rem', marginTop: '0.25rem' }}>
          {[
            { label: 'FOV Width',    val: fovW  > 0 ? `${(fovW * 60).toFixed(1)}'` : '—' },
            { label: 'FOV Height',   val: fovH  > 0 ? `${(fovH * 60).toFixed(1)}'` : '—' },
            { label: 'Plate Scale',  val: platescale > 0 ? `${platescale.toFixed(2)}"/px` : '—' },
          ].map(({ label, val }) => (
            <div key={label} style={{ padding: '0.35rem', backgroundColor: 'var(--bg-deep)', borderRadius: '4px', border: '1px solid var(--border)', textAlign: 'center' }}>
              <div style={{ fontSize: '0.62rem', color: 'var(--text-muted)' }}>{label}</div>
              <div style={{ fontSize: '0.8rem', fontWeight: 700, color: 'var(--accent-blue)', fontFamily: 'var(--font-mono)' }}>{val}</div>
            </div>
          ))}
        </div>
        <div style={{ fontSize: '0.65rem', color: 'var(--text-muted)', fontStyle: 'italic', marginTop: '0.15rem', lineHeight: 1.3 }}>
          Ideal plate scale for a typical seeing of 2–3": 0.8–2.0"/px with a monochrome sensor.
        </div>
      </div>

      <style>{`@keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }`}</style>
    </div>
  );
};

export default PlannerPanel;
