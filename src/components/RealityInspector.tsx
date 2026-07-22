import React, { useState } from 'react';
import { Eye, Search, Compass, RefreshCw, AlertTriangle, Play, Pause, Zap } from 'lucide-react';
import { type SharedFile } from '../App';

interface RealityInspectorProps {
  activeFile: SharedFile | null;
  addLog: (type: 'info' | 'success' | 'warning' | 'error', msg: string) => void;

  // Sync state props with parent
  compareMode: 'none' | 'blink' | 'swipe' | 'difference' | 'dss';
  onCompareModeChange: (mode: 'none' | 'blink' | 'swipe' | 'difference' | 'dss') => void;
  blinkRate: number;
  onBlinkRateChange: (rate: number) => void;
  swipePos: number;
  onSwipePosChange: (pos: number) => void;
  diffBoost: number;
  onDiffBoostChange: (boost: number) => void;
  diffMode: 'added' | 'removed' | 'absolute';
  onDiffModeChange: (mode: 'added' | 'removed' | 'absolute') => void;
  profileMode: boolean;
  onProfileModeChange: (enabled: boolean) => void;

  originalProfile: number[];
  processedProfile: number[];
  
  dssImageUrl: string | null;
  onDssUrlChange: (url: string | null) => void;
}

export const RealityInspector: React.FC<RealityInspectorProps> = ({
  activeFile,
  addLog,
  compareMode,
  onCompareModeChange,
  blinkRate,
  onBlinkRateChange,
  swipePos,
  onSwipePosChange,
  diffBoost,
  onDiffBoostChange,
  diffMode,
  onDiffModeChange,
  profileMode,
  onProfileModeChange,
  originalProfile,
  processedProfile,
  dssImageUrl,
  onDssUrlChange
}) => {
  const [targetQuery, setTargetQuery] = useState('');
  const [isLoadingDSS, setIsLoadingDSS] = useState(false);
  const [dssError, setDssError] = useState<string | null>(null);

  const fetchDSSReference = async () => {
    if (!targetQuery.trim()) return;
    setIsLoadingDSS(true);
    setDssError(null);
    try {
      addLog('info', `Resolving coordinates for target object: ${targetQuery}...`);
      const sesameUrl = `https://cdsweb.u-strasbg.fr/cgi-bin/nph-sesame/-A?${encodeURIComponent(targetQuery.trim())}`;
      const res = await fetch(sesameUrl);
      const text = await res.text();
      
      const match = text.match(/%J\s+([\d\.\-]+)\s+([\d\.\-]+)/);
      if (!match) {
        throw new Error(`Could not resolve coordinates for "${targetQuery}" on CDS Simbad/NED.`);
      }
      
      const ra = parseFloat(match[1]);
      const dec = parseFloat(match[2]);
      addLog('success', `Resolved coordinates for ${targetQuery}: RA=${ra.toFixed(4)}°, DEC=${dec.toFixed(4)}°`);
      
      // Construct DSS image url (field of view is 0.5 degrees, tan projection, size 512x512)
      const dssUrl = `https://alasky.cds.unistra.fr/hips-image-services/hips2fits?hips=CDS%2FP%2FDSS2%2Fcolor&width=512&height=512&fov=0.5&projection=TAN&coordsys=icrs&ra=${ra}&dec=${dec}`;
      
      onDssUrlChange(dssUrl);
    } catch (e: any) {
      addLog('error', `DSS fetch error: ${e.message || e}`);
      setDssError(e.message || String(e));
      onDssUrlChange(null);
    } finally {
      setIsLoadingDSS(false);
    }
  };

  const renderProfilePlot = () => {
    if (!originalProfile.length || !processedProfile.length) {
      return (
        <div style={{ padding: '1.5rem', textAlign: 'center', backgroundColor: '#07090e', border: '1px solid var(--border)', borderRadius: '6px', color: 'var(--text-muted)', fontSize: '0.75rem' }}>
          No profile line drawn. Click & drag on the viewport canvas to inspect a cross-section.
        </div>
      );
    }

    const width = 360;
    const height = 130;
    const padding = 10;
    const chartW = width - padding * 2;
    const chartH = height - padding * 2;

    // Find min and max values to dynamically scale Y-axis
    let minVal = Infinity;
    let maxVal = -Infinity;
    for (let i = 0; i < originalProfile.length; i++) {
      const v = originalProfile[i];
      if (v < minVal) minVal = v;
      if (v > maxVal) maxVal = v;
    }
    for (let i = 0; i < processedProfile.length; i++) {
      const v = processedProfile[i];
      if (v < minVal) minVal = v;
      if (v > maxVal) maxVal = v;
    }

    const range = maxVal - minVal;
    const minBound = range === 0 ? minVal - 0.5 : minVal - range * 0.05;
    const maxBound = range === 0 ? maxVal + 0.5 : maxVal + range * 0.05;
    const divisorY = maxBound - minBound || 1;

    const scaleY = (val: number) => {
      const pct = (val - minBound) / divisorY;
      const clamped = Math.max(0.0, Math.min(1.0, pct));
      return padding + chartH * (1.0 - clamped);
    };

    const getSvgPath = (samples: number[]) => {
      if (!samples.length) return '';
      const divisor = Math.max(1, samples.length - 1);
      const points = samples.map((val, idx) => {
        const x = padding + (idx / divisor) * chartW;
        const y = scaleY(val);
        return `${x.toFixed(1)},${y.toFixed(1)}`;
      });
      return `M ${points.join(' L ')}`;
    };

    const oPath = getSvgPath(originalProfile);
    const pPath = getSvgPath(processedProfile);

    return (
      <div style={{ backgroundColor: '#07090e', border: '1px solid var(--border)', borderRadius: '6px', padding: '0.5rem', display: 'flex', flexDirection: 'column', gap: '0.4rem' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.65rem', color: 'var(--text-muted)', fontWeight: 600 }}>
          <span style={{ color: '#38bdf8' }}>● Original Stack</span>
          <span style={{ color: '#f472b6' }}>● Processed (Current)</span>
        </div>
        <svg width="100%" height={height} viewBox={`0 0 ${width} ${height}`} style={{ overflow: 'visible' }}>
          {/* Grid lines */}
          <line x1={padding} y1={padding} x2={padding + chartW} y2={padding} stroke="rgba(255,255,255,0.05)" />
          <line x1={padding} y1={padding + chartH / 2} x2={padding + chartW} y2={padding + chartH / 2} stroke="rgba(255,255,255,0.05)" />
          <line x1={padding} y1={padding + chartH} x2={padding + chartW} y2={padding + chartH} stroke="rgba(255,255,255,0.1)" />

          {/* Paths */}
          {oPath && <path d={oPath} fill="none" stroke="#38bdf8" strokeWidth="1.5" opacity="0.8" />}
          {pPath && <path d={pPath} fill="none" stroke="#f472b6" strokeWidth="2" />}
        </svg>
        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.6rem', color: 'var(--text-muted)' }}>
          <span>Start Point</span>
          <span>Index (0 to {originalProfile.length - 1})</span>
          <span>End Point</span>
        </div>
      </div>
    );
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', gap: '0.75rem', overflowY: 'auto' }}>
      
      {/* Module Header */}
      <div className="sidebar-module-header">
        <h2 className="sidebar-module-title">
          <Eye size={16} color="var(--accent-purple)" />
          Reality Inspector
        </h2>
        <p className="sidebar-module-desc">
          Compare original and processed images, analyze cross-section profiles, or fetch DSS sky catalog references.
        </p>
      </div>

      {/* Target Active File Banner */}
      <div className="control-card">
        <div style={{ fontSize: '0.7rem', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', marginBottom: '0.15rem' }}>Inspecting File</div>
        <div style={{ fontSize: '0.8rem', fontWeight: 600, color: 'var(--accent-blue)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
          {activeFile ? activeFile.name : '-- No File Selected --'}
        </div>
      </div>

      {/* SECTION 1: COMPARE MODE SELECTOR */}
      <div className="control-card">
        <div className="control-card-title">
          <Eye size={12} /> Image Comparer (A/B)
        </div>
        
        <div className="form-label">
          <span>Comparison Mode:</span>
          <select 
            value={compareMode} 
            onChange={e => onCompareModeChange(e.target.value as any)}
            className="input-select"
          >
            <option value="none">Disabled (Show Processed)</option>
            <option value="blink">Blink (Alternating Processed vs Stack)</option>
            <option value="swipe">Split Screen (Interactive Wipe)</option>
            <option value="difference">Difference Map (Residual Inspection)</option>
            <option value="dss">DSS Sky Survey (Alternating Reference)</option>
          </select>
        </div>

        {/* Blink Mode parameters */}
        {compareMode === 'blink' && (
          <div className="form-label" style={{ marginTop: '0.2rem' }}>
            <div className="form-label-row">
              <span>Blink Speed:</span>
              <span>{blinkRate}ms</span>
            </div>
            <input 
              type="range" 
              min={100} 
              max={2000} 
              step={50} 
              value={blinkRate} 
              onChange={e => onBlinkRateChange(parseInt(e.target.value))}
              className="input-range"
            />
          </div>
        )}

        {/* Swipe Mode parameters */}
        {compareMode === 'swipe' && (
          <div className="form-label" style={{ marginTop: '0.2rem' }}>
            <div className="form-label-row">
              <span>Swipe Split Position:</span>
              <span>{swipePos}%</span>
            </div>
            <input 
              type="range" 
              min={0} 
              max={100} 
              value={swipePos} 
              onChange={e => onSwipePosChange(parseInt(e.target.value))}
              className="input-range"
            />
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.65rem', color: 'var(--text-muted)' }}>
              <span>Left: Stacked</span>
              <span>Right: Processed</span>
            </div>
          </div>
        )}

        {/* Difference Map Mode parameters */}
        {compareMode === 'difference' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem', marginTop: '0.2rem' }}>
            <div className="form-label">
              <span>Difference Formula:</span>
              <select
                value={diffMode}
                onChange={e => onDiffModeChange(e.target.value as any)}
                className="input-select"
              >
                <option value="absolute">Absolute Difference |P - O|</option>
                <option value="added">Added Details P - O (Sharpening / Casts)</option>
                <option value="removed">Removed Details O - P (Noise / Stars)</option>
              </select>
            </div>
            <div className="form-label">
              <div className="form-label-row">
                <span>Amplify Residuals (Boost):</span>
                <span>{diffBoost}x</span>
              </div>
              <input 
                type="range" 
                min={1} 
                max={50} 
                value={diffBoost} 
                onChange={e => onDiffBoostChange(parseInt(e.target.value))}
                className="input-range"
              />
            </div>
          </div>
        )}
      </div>

      {/* SECTION 2: 1D PIXEL LINE PROFILE */}
      <div className="control-card">
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <div className="control-card-title" style={{ borderBottom: 'none', marginBottom: 0, paddingBottom: 0 }}>
            <Zap size={12} /> Line Profile Analyzer
          </div>
          <label className="input-checkbox-container">
            <input 
              type="checkbox" 
              checked={profileMode} 
              onChange={e => onProfileModeChange(e.target.checked)}
            />
            <span style={{ fontWeight: 600, color: profileMode ? 'var(--accent-blue)' : 'white' }}>Activate</span>
          </label>
        </div>

        {profileMode && renderProfilePlot()}
      </div>

      {/* SECTION 3: ONLINE DSS SKY SURVEY REFERENCE */}
      <div className="control-card">
        <div className="control-card-title">
          <Compass size={12} /> DSS Reference Catalog
        </div>

        <div style={{ display: 'flex', gap: '0.4rem', alignItems: 'center' }}>
          <div style={{ position: 'relative', flex: 1 }}>
            <input 
              type="text" 
              placeholder="e.g. M31, Orion, Ring Nebula..."
              value={targetQuery}
              onChange={e => setTargetQuery(e.target.value)}
              className="input-text"
              style={{ paddingLeft: '1.6rem' }}
              onKeyDown={e => { if (e.key === 'Enter') fetchDSSReference(); }}
            />
            <Search size={12} style={{ position: 'absolute', left: '0.5rem', top: '50%', transform: 'translateY(-50%)', color: 'var(--text-muted)' }} />
          </div>
          
          <button
            onClick={fetchDSSReference}
            disabled={isLoadingDSS || !targetQuery.trim()}
            className="btn-primary"
            style={{ padding: '0.45rem 0.75rem', flexShrink: 0 }}
          >
            {isLoadingDSS ? <RefreshCw size={12} className="spin" /> : 'Fetch'}
          </button>
        </div>

        {dssError && (
          <div style={{ color: 'var(--danger)', fontSize: '0.7rem', display: 'flex', alignItems: 'center', gap: '0.2rem', backgroundColor: 'rgba(239, 68, 68, 0.05)', padding: '0.4rem', borderRadius: '4px' }}>
            <AlertTriangle size={12} /> {dssError}
          </div>
        )}

        {dssImageUrl && (
          <div style={{ marginTop: '0.3rem', display: 'flex', flexDirection: 'column', gap: '0.4rem' }}>
            <div style={{ position: 'relative', width: '100%', paddingBottom: '100%', backgroundColor: '#000', border: '1px solid var(--border)', borderRadius: '6px', overflow: 'hidden' }}>
              <img 
                src={dssImageUrl} 
                alt="DSS Sky survey target" 
                style={{ position: 'absolute', left: 0, top: 0, width: '100%', height: '100%', objectFit: 'cover' }} 
                onError={() => {
                  setDssError('Failed to load DSS reference image.');
                  onDssUrlChange(null);
                }}
              />
            </div>
            <div style={{ fontSize: '0.65rem', color: 'var(--text-muted)', textAlign: 'center' }}>
              Fetched 0.5° patch from Digitized Sky Survey (DSS2)
            </div>
            
            <button
              onClick={() => onCompareModeChange(compareMode === 'dss' ? 'none' : 'dss')}
              className="btn-secondary"
              style={{ width: '100%' }}
            >
              {compareMode === 'dss' ? <Pause size={12} /> : <Play size={12} />}
              {compareMode === 'dss' ? 'Stop Viewport Blink' : 'Blink in Main Viewport'}
            </button>
          </div>
        )}
      </div>

    </div>
  );
};
