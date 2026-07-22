import { useState, useCallback, useEffect, useMemo, useRef } from 'react';
import { createPortal } from 'react-dom';
import { FolderOpen, Database, ListOrdered, Target, Wand2, Workflow, Save, FileDown, ExternalLink, Terminal, Eye, ChevronUp, ChevronDown, Atom, X, Telescope } from 'lucide-react';
import './styles/global.css';
import Layout from './components/Layout';
import logoImg from './assets/unnamed.png';

import AstroPreviewer from './components/AstroPreviewer';
import MetadataExplorer from './components/MetadataExplorer';
import BatchManager from './components/BatchManager';
import WorkflowBuilder from './components/WorkflowBuilder';
import SubframeSelector, { type FrameStats } from './components/SubframeSelector';
import PostProcessor from './components/PostProcessor';
import Converter from './components/Converter';
import ScriptConsole from './components/ScriptConsole';
import { RealityInspector } from './components/RealityInspector';
import { PhysicsLab } from './components/PhysicsLab';
import { PlannerPanel } from './components/PlannerPanel';
import { ErrorBoundary } from './components/ErrorBoundary';

import UTIF from 'utif';
import { parseFits, type FitsParsedData, parseSer, type SerParsedData, parseExif, type FitsHeaderCard, parsePng, writeFits } from './utils/parsers';

export interface SharedFile {
  id: string;
  name: string;
  size: number;
  type: string;
  data: ArrayBuffer;
  fileObject: File;
  parsedFits?: FitsParsedData | null;
  parsedSer?: SerParsedData | null;
  extractedHeaders: FitsHeaderCard[];
  originalFloatData?: Float32Array;
}

interface LogEntry {
  id: number;
  time: string;
  type: 'info' | 'error' | 'success' | 'warning';
  msg: string;
}

// Extract standard image pixels as color planar Float32Array
const loadImagePixels = (file: File): Promise<{ width: number, height: number, floatData: Float32Array }> => {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.src = URL.createObjectURL(file);
    img.onload = () => {
      URL.revokeObjectURL(img.src);
      const canvas = document.createElement('canvas');
      canvas.width = img.width;
      canvas.height = img.height;
      const ctx = canvas.getContext('2d');
      if (!ctx) {
        reject(new Error('Failed to get 2D canvas context'));
        return;
      }
      ctx.drawImage(img, 0, 0);
      const imgData = ctx.getImageData(0, 0, img.width, img.height);
      const len = img.width * img.height;
      const floatData = new Float32Array(len * 3);
      
      // Convert interleaved RGBA to planar RGB Float32Array [0.0, 1.0]
      for (let i = 0; i < len; i++) {
        const idx = i * 4;
        floatData[i] = imgData.data[idx] / 255.0;            // R channel plane
        floatData[len + i] = imgData.data[idx + 1] / 255.0;    // G channel plane
        floatData[len * 2 + i] = imgData.data[idx + 2] / 255.0;// B channel plane
      }
      resolve({ width: img.width, height: img.height, floatData });
    };
    img.onerror = () => {
      URL.revokeObjectURL(img.src);
      reject(new Error('Failed to load image file'));
    };
  });
};

// Extract TIFF pixels using UTIF library
const loadTiffPixels = (buffer: ArrayBuffer): { width: number, height: number, floatData: Float32Array } => {
  const ifds = UTIF.decode(buffer);
  if (!ifds || ifds.length === 0) {
    throw new Error('No image directory found in TIFF.');
  }
  UTIF.decodeImage(buffer, ifds[0]);
  const rgba = UTIF.toRGBA8(ifds[0]); // Uint8Array [width * height * 4]
  const width = ifds[0].width;
  const height = ifds[0].height;

  const len = width * height;
  const floatData = new Float32Array(len * 3);
  for (let i = 0; i < len; i++) {
    const idx = i * 4;
    floatData[i] = rgba[idx] / 255.0;            // R channel plane
    floatData[len + i] = rgba[idx + 1] / 255.0;    // G channel plane
    floatData[len * 2 + i] = rgba[idx + 2] / 255.0;// B channel plane
  }
  return { width, height, floatData };
};

// Search file buffer for embedded JPEG SOI (0xFF 0xD8 0xFF) and EOI (0xFF 0xD9) markers
const extractEmbeddedJpeg = (buffer: ArrayBuffer): Uint8Array | null => {
  const bytes = new Uint8Array(buffer);
  let startIdx = -1;
  for (let i = 0; i < bytes.length - 2; i++) {
    if (bytes[i] === 0xFF && bytes[i + 1] === 0xD8 && bytes[i + 2] === 0xFF) {
      startIdx = i;
      break;
    }
  }
  if (startIdx === -1) return null;

  let endIdx = -1;
  for (let i = bytes.length - 2; i > startIdx; i--) {
    if (bytes[i] === 0xFF && bytes[i + 1] === 0xD9) {
      endIdx = i + 2;
      break;
    }
  }
  if (endIdx === -1) return null;

  return bytes.subarray(startIdx, endIdx);
};

type TabId = 'metadata' | 'batch' | 'subframes' | 'postprocess' | 'workflow' | 'converter' | 'script' | 'inspector' | 'physics' | 'planner';

function App() {
  const [sharedFiles, setSharedFiles] = useState<SharedFile[]>([]);
  const [logs, setLogs] = useState<LogEntry[]>([{
    id: 1,
    time: new Date().toLocaleTimeString(),
    type: 'info',
    msg: 'Kapali initialized. Ready.'
  }]);
  
  const [activeFileId, setActiveFileId] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<TabId>('subframes');
  const externalWindowRef = useRef<Window | null>(null);

  // Reality Inspector States
  const [compareMode, setCompareMode] = useState<'none' | 'blink' | 'swipe' | 'difference' | 'dss'>('none');
  const [blinkRate, setBlinkRate] = useState(500);
  const [swipePos, setSwipePos] = useState(50);
  const [diffBoost, setDiffBoost] = useState(5);
  const [diffMode, setDiffMode] = useState<'added' | 'removed' | 'absolute'>('absolute');
  const [profileMode, setProfileMode] = useState(false);
  const [originalProfile, setOriginalProfile] = useState<number[]>([]);
  const [processedProfile, setProcessedProfile] = useState<number[]>([]);
  const [dssImageUrl, setDssImageUrl] = useState<string | null>(null);

  const [frames, setFrames] = useState<FrameStats[]>([]);
  const [activeMetric, setActiveMetric] = useState<'fwhm' | 'eccentricity' | 'snrWeight'>('fwhm');
  const [thresholds, setThresholds] = useState<{ fwhm: number; eccentricity: number; snrWeight: number }>({
    fwhm: 4.5,
    eccentricity: 0.65,
    snrWeight: 40
  });

  const [externalWindow, setExternalWindow] = useState<Window | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState<boolean>(true);
  const [consoleCollapsed, setConsoleCollapsed] = useState<boolean>(true);
  const [openMenu, setOpenMenu] = useState<string | null>(null);
  const menuBarRef = useRef<HTMLDivElement>(null);
  const [livePreviewData, setLivePreviewData] = useState<{ fileId: string; data: Float32Array } | null>(null);

  const handleLivePreview = useCallback((fileId: string, data: Float32Array | null) => {
    setLivePreviewData(data ? { fileId, data } : null);
  }, []);

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (menuBarRef.current && !menuBarRef.current.contains(e.target as Node)) {
        setOpenMenu(null);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  const PANEL_LABELS: Record<TabId, string> = {
    subframes:   'Subframe Selector',
    batch:       'Calibration & Stack',
    postprocess: 'Post-Processing',
    inspector:   'Inspect & Compare',
    converter:   'Export / Convert',
    metadata:    'FITS Metadata',
    physics:     'Physics Lab',
    workflow:    'Workflow Builder',
    script:      'Script Console',
    planner:     'Session Planner',
  };

  // The core, sequential imaging workflow. Rendered as an always-visible stepper
  // so the app reads as one continuous pipeline instead of a flat set of panels.
  const PIPELINE_STAGES: { id: TabId; shortLabel: string; icon: typeof Target }[] = [
    { id: 'subframes',   shortLabel: 'Frames',  icon: Target },
    { id: 'batch',       shortLabel: 'Stack',   icon: ListOrdered },
    { id: 'postprocess', shortLabel: 'Process', icon: Wand2 },
    { id: 'inspector',   shortLabel: 'Inspect', icon: Eye },
    { id: 'converter',   shortLabel: 'Export',  icon: FileDown },
  ];

  // Supplementary tools. Not every target needs all of these (a quick planetary
  // stack may never touch Physics Lab or Session Planner), so they're kept
  // visually separate from the mandatory pipeline stages rather than numbered
  // alongside them.
  const TOOL_TABS: { id: TabId; label: string; icon: typeof Database }[] = [
    { id: 'metadata', label: 'FITS Metadata',    icon: Database },
    { id: 'physics',  label: 'Physics Lab',      icon: Atom },
    { id: 'workflow', label: 'Workflow Builder', icon: Workflow },
    { id: 'script',   label: 'Script Console',   icon: Terminal },
    { id: 'planner',  label: 'Session Planner',  icon: Telescope },
  ];

  const saveMasterFile = () => {
    if (!activeFile) return;
    const blob = new Blob([activeFile.data], { type: 'application/octet-stream' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = activeFile.name;
    a.click();
    URL.revokeObjectURL(url);
    addLog('success', `Saved master file: ${activeFile.name}`);
  };

  const openTool = (tab: TabId) => {
    setActiveTab(tab);
    setSidebarOpen(true);
    setOpenMenu(null);
  };

  const popOutPreviewer = () => {
    if (externalWindow) {
      externalWindow.focus();
      return;
    }
    
    const win = window.open('', 'KapaliPreview', 'width=900,height=700,menubar=no,status=no,toolbar=no');
    if (!win) {
      addLog('error', 'Popup blocker prevented opening the previewer window.');
      return;
    }

    win.document.title = 'Kapali Viewport';
    
    const copyStyles = () => {
      win.document.head.innerHTML = '';
      Array.from(document.querySelectorAll('link[rel="stylesheet"], style')).forEach(el => {
        const clone = el.cloneNode(true);
        win.document.head.appendChild(clone);
      });
      
      const styleEl = win.document.createElement('style');
      styleEl.textContent = `
        body {
          margin: 0;
          padding: 1.5rem;
          background: #080b11;
          background-image: 
            radial-gradient(circle at 15% 20%, rgba(139, 92, 246, 0.16) 0%, transparent 45%),
            radial-gradient(circle at 85% 75%, rgba(6, 182, 212, 0.14) 0%, transparent 50%),
            url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='400' height='400' viewBox='0 0 400 400'%3E%3Cpath d='M10 10h1v1h-1zM70 120h1v1h-1zM150 40h1v1h-1zM280 90h1v1h-1zM310 210h1v1h-1zM20 310h1v1h-1zM90 380h1v1h-1zM190 280h1v1h-1zM340 330h1v1h-1zM380 50h1v1h-1z' fill='%23ffffff' fill-opacity='0.25'/%3E%3Cpath d='M30 80h2v2h-2zM120 180h2v2h-2zM220 120h2v2h-2zM330 40h2v2h-2zM260 300h2v2h-2zM80 290h2v2h-2zM180 350h2v2h-2zM360 250h2v2h-2z' fill='%23ffffff' fill-opacity='0.4'/%3E%3Cpath d='M140 250h3v3h-3zM300 150h3v3h-3zM50 350h3v3h-3z' fill='%23ffffff' fill-opacity='0.55'/%3E%3C/svg%3E");
          background-attachment: fixed;
          font-family: 'Nunito', system-ui, sans-serif;
          color: #E2E8F0;
          height: 100vh;
          width: 100vw;
          box-sizing: border-box;
          overflow: hidden;
          background-image: none;
        }
        #preview-portal-root {
          height: 100%;
          width: 100%;
          display: flex;
          flex-direction: column;
        }
      `;
      win.document.head.appendChild(styleEl);
      
      const rootDiv = win.document.createElement('div');
      rootDiv.id = 'preview-portal-root';
      win.document.body.appendChild(rootDiv);
    };
    
    copyStyles();
    
    win.addEventListener('beforeunload', () => {
      setExternalWindow(null);
      externalWindowRef.current = null;
    });
    
    externalWindowRef.current = win;
    setExternalWindow(win);
    addLog('info', 'Popped out viewport to a separate window.');
  };

  useEffect(() => {
    return () => {
      if (externalWindowRef.current) {
        externalWindowRef.current.close();
      }
    };
  }, []);

  const addLog = useCallback((type: 'info' | 'error' | 'success' | 'warning', msg: string) => {
    setLogs(prev => {
      const next = [...prev, {
        id: Math.floor(Math.random() * 1e9), // use numeric id since log.id is typed as number
        time: new Date().toLocaleTimeString(),
        type,
        msg
      }];
      if (next.length > 500) {
        return next.slice(next.length - 500);
      }
      return next;
    });
  }, []);

  const handleAddFiles = useCallback(async (files: File[]) => {
    const newSharedFiles: SharedFile[] = [];
    addLog('info', `Ingesting ${files.length} files...`);

    const allowedExtensions = ['fit', 'fits', 'fts', 'ser', 'jpg', 'jpeg', 'png', 'webp', 'gif', 'bmp', 'svg', 'tiff', 'tif', 'cr2', 'cr3', 'nef', 'arw', 'raf', 'dng', 'csv'];

    for (const file of files) {
      const ext = file.name.split('.').pop()?.toLowerCase() || '';

      if (!allowedExtensions.includes(ext)) {
        addLog('warning', `Skipped ${file.name}: Unsupported file format (.${ext}).`);
        continue;
      }

      if (file.size > 500 * 1024 * 1024) {
        addLog('warning', `Skipped ${file.name}: File size (${(file.size / (1024 * 1024)).toFixed(1)} MB) exceeds 500 MB limit.`);
        continue;
      }

      try {
        const buffer = await file.arrayBuffer();
        let parsedFits = null;
        let parsedSer = null;
        let extractedHeaders: FitsHeaderCard[] = [];
        let mappedType = ext;

        if (ext === 'fit' || ext === 'fits') {
          const parsed = parseFits(buffer);
          parsedFits = parsed;
          extractedHeaders = parsed.headers;
          mappedType = 'fits';
        } else if (ext === 'ser') {
          parsedSer = parseSer(buffer);
          mappedType = 'ser';
        } else if (['jpg', 'jpeg', 'png', 'webp', 'gif', 'bmp', 'svg'].includes(ext)) {
          let tempHeaders: FitsHeaderCard[] = [];
          if (ext === 'png') {
            tempHeaders = parsePng(buffer);
          } else {
            tempHeaders = parseExif(buffer);
          }
          
          try {
            const imgResult = await loadImagePixels(file);
            parsedFits = {
              headers: tempHeaders,
              width: imgResult.width,
              height: imgResult.height,
              bitpix: 8,
              bzero: 0,
              bscale: 1,
              floatData: imgResult.floatData,
              rawBuffer: buffer
            };
            extractedHeaders = tempHeaders;
            mappedType = 'image';
          } catch (e) {
            addLog('error', `Failed to load image pixels for ${file.name}: ${e}`);
            continue;
          }
        } else if (ext === 'tiff' || ext === 'tif') {
          try {
            const tiffResult = loadTiffPixels(buffer);
            parsedFits = {
              headers: [
                { key: 'SIMPLE', value: 'T', comment: 'TIFF imported file', raw: '' },
                { key: 'BITPIX', value: '8', comment: '', raw: '' },
                { key: 'NAXIS', value: '2', comment: '', raw: '' },
                { key: 'NAXIS1', value: tiffResult.width.toString(), comment: '', raw: '' },
                { key: 'NAXIS2', value: tiffResult.height.toString(), comment: '', raw: '' }
              ],
              width: tiffResult.width,
              height: tiffResult.height,
              bitpix: 8,
              bzero: 0,
              bscale: 1,
              floatData: tiffResult.floatData,
              rawBuffer: buffer
            };
            extractedHeaders = parsedFits.headers;
            mappedType = 'image';
          } catch (e) {
            addLog('error', `Failed to parse TIFF ${file.name}: ${e}`);
            continue;
          }
        } else {
          // RAW Camera files fallback
          try {
            const tempHeaders = [
              { key: 'SIMPLE', value: 'T', comment: 'RAW Camera file imported', raw: '' },
              { key: 'BITPIX', value: '8', comment: '', raw: '' },
              { key: 'NAXIS', value: '2', comment: '', raw: '' }
            ];
            
            // Try UTIF first if we can decode embedded JPEG
            const jpegBytes = extractEmbeddedJpeg(buffer);
            if (jpegBytes) {
              const jpegBuffer = new Uint8Array(jpegBytes).buffer as ArrayBuffer;
              const imgResult = await loadImagePixels(new File([jpegBuffer], file.name, { type: 'image/jpeg' }));
              parsedFits = {
                headers: tempHeaders,
                width: imgResult.width,
                height: imgResult.height,
                bitpix: 8,
                bzero: 0,
                bscale: 1,
                floatData: imgResult.floatData,
                rawBuffer: buffer
              };
              extractedHeaders = tempHeaders;
              mappedType = 'image';
            } else {
              // Fallback to UTIF
              const tiffResult = loadTiffPixels(buffer);
              parsedFits = {
                headers: [
                  { key: 'SIMPLE', value: 'T', comment: 'RAW TIFF imported file', raw: '' },
                  { key: 'BITPIX', value: '8', comment: '', raw: '' },
                  { key: 'NAXIS', value: '2', comment: '', raw: '' },
                  { key: 'NAXIS1', value: tiffResult.width.toString(), comment: '', raw: '' },
                  { key: 'NAXIS2', value: tiffResult.height.toString(), comment: '', raw: '' }
                ],
                width: tiffResult.width,
                height: tiffResult.height,
                bitpix: 8,
                bzero: 0,
                bscale: 1,
                floatData: tiffResult.floatData,
                rawBuffer: buffer
              };
              extractedHeaders = parsedFits.headers;
              mappedType = 'image';
            }
          } catch (e) {
            addLog('error', `Failed to parse RAW camera file: ${e}`);
            continue;
          }
        }

        newSharedFiles.push({
          id: crypto.randomUUID(),
          name: file.name,
          size: file.size,
          type: mappedType,
          data: buffer,
          fileObject: file,
          parsedFits,
          parsedSer,
          extractedHeaders
        });
      } catch (err) {
        addLog('error', `Failed to parse ${file.name}: ${err}`);
      }
    }

    setSharedFiles(prev => [...prev, ...newSharedFiles]);
    if (newSharedFiles.length > 0) {
      addLog('success', `Added ${newSharedFiles.length} files to workspace.`);
    }
  }, [addLog]);

  const handleUpdateFits = useCallback((fileId: string, newData: ArrayBuffer | Float32Array | FitsParsedData | any) => {
    let success = false;
    setSharedFiles(prev => prev.map(f => {
      if (f.id === fileId) {
        if (newData instanceof ArrayBuffer) {
          success = true;
          let parsedData = f.parsedFits;
          try {
            parsedData = parseFits(newData);
          } catch (e) {
            console.error(e);
          }
          return {
            ...f,
            data: newData,
            parsedFits: parsedData,
            extractedHeaders: parsedData ? parsedData.headers : f.extractedHeaders
          };
        } else if (newData instanceof Float32Array) {
          if (f.parsedFits) {
            success = true;
            const originalFloatData = f.originalFloatData || new Float32Array(f.parsedFits.floatData);
            const updatedParsedFits = {
              ...f.parsedFits,
              floatData: newData
            };
            const updatedBuffer = writeFits(updatedParsedFits, f.parsedFits.headers);
            return {
              ...f,
              data: updatedBuffer,
              parsedFits: updatedParsedFits,
              originalFloatData
            };
          } else {
            console.warn(`handleUpdateFits: parsedFits is null for file ${fileId}, Float32Array update dropped.`);
          }
        } else if (newData && typeof newData === 'object' && 'rawBuffer' in newData) {
          success = true;
          const parsed = newData as FitsParsedData;
          const originalFloatData = f.originalFloatData || (parsed.floatData ? new Float32Array(parsed.floatData) : undefined);
          return {
            ...f,
            data: parsed.rawBuffer,
            parsedFits: parsed,
            extractedHeaders: parsed.headers,
            originalFloatData
          };
        }
      }
      return f;
    }));

    if (success) {
      addLog('success', `Updated file data in memory.`);
    }
  }, [addLog]);

  const handleUpdateHeaders = useCallback((fileId: string, newHeaders: FitsHeaderCard[]) => {
    setSharedFiles(prev => prev.map(f => {
      if (f.id === fileId) {
        if (f.parsedFits) {
          const updatedParsedFits = {
            ...f.parsedFits,
            headers: newHeaders
          };
          return {
            ...f,
            parsedFits: updatedParsedFits,
            extractedHeaders: newHeaders
          };
        }
        return {
          ...f,
          extractedHeaders: newHeaders
        };
      }
      return f;
    }));
    addLog('success', `Updated file metadata in memory.`);
  }, [addLog]);

  const activeFile = useMemo(() => {
    return sharedFiles.find(f => f.id === activeFileId) || null;
  }, [sharedFiles, activeFileId]);

  useEffect(() => {
    if (sharedFiles.length > 0) {
      if (!activeFileId || !sharedFiles.some(f => f.id === activeFileId)) {
        setActiveFileId(sharedFiles[0].id);
      }
    } else {
      setActiveFileId(null);
    }
  }, [sharedFiles, activeFileId]);

  // Clear live preview when the active file switches
  useEffect(() => {
    setLivePreviewData(null);
  }, [activeFileId]);

  return (
    <Layout>
      {/* Top Toolbar */}
      <header className="top-toolbar">
        <div className="toolbar-left">
          <img src={logoImg} alt="Kapali Logo" style={{ height: '22px', marginRight: '0.5rem', borderRadius: '4px' }} />
          <span className="app-title">Kapali</span>

          <div className="toolbar-separator" />

          <input
            type="file"
            id="global-file-input"
            multiple
            style={{ display: 'none' }}
            onChange={(e) => {
              if (e.target.files && e.target.files.length > 0) {
                handleAddFiles(Array.from(e.target.files));
                e.target.value = '';
              }
            }}
          />
          <button className="toolbar-btn" onClick={() => document.getElementById('global-file-input')?.click()}>
            <FolderOpen size={14} /> Open Files
          </button>

          {/* Menu Bar */}
          <nav className="menu-bar" ref={menuBarRef}>

            {/* File menu */}
            <div
              className={`menu-item ${openMenu === 'file' ? 'open' : ''}`}
              onMouseDown={() => setOpenMenu(openMenu === 'file' ? null : 'file')}
            >
              <span>File</span>
              <ChevronDown size={11} />
              {openMenu === 'file' && (
                <div className="menu-dropdown">
                  <button className="menu-dropdown-item" onClick={() => { document.getElementById('global-file-input')?.click(); setOpenMenu(null); }}>
                    <FolderOpen size={14} />
                    <span>Open Files…</span>
                  </button>
                  <div className="menu-divider" />
                  <button className="menu-dropdown-item" disabled={!activeFile} onClick={() => { saveMasterFile(); setOpenMenu(null); }}>
                    <Save size={14} />
                    <span>Save Master</span>
                  </button>
                  <div className="menu-divider" />
                  {externalWindow ? (
                    <button className="menu-dropdown-item" onClick={() => { externalWindow.close(); setExternalWindow(null); setOpenMenu(null); }}>
                      <ExternalLink size={14} />
                      <span>Dock Viewport</span>
                    </button>
                  ) : (
                    <button className="menu-dropdown-item" onClick={() => { popOutPreviewer(); setOpenMenu(null); }}>
                      <ExternalLink size={14} />
                      <span>Pop Out Viewport</span>
                    </button>
                  )}
                </div>
              )}
            </div>

            {/* View menu */}
            <div
              className={`menu-item ${openMenu === 'view' ? 'open' : ''}`}
              onMouseDown={() => setOpenMenu(openMenu === 'view' ? null : 'view')}
            >
              <span>View</span>
              <ChevronDown size={11} />
              {openMenu === 'view' && (
                <div className="menu-dropdown">
                  <button className="menu-dropdown-item" onClick={() => { setSidebarOpen(prev => !prev); setOpenMenu(null); }}>
                    <span>{sidebarOpen ? 'Hide Panel' : 'Show Panel'}</span>
                  </button>
                  <button className="menu-dropdown-item" onClick={() => { setConsoleCollapsed(prev => !prev); setOpenMenu(null); }}>
                    <span>{consoleCollapsed ? 'Show Log Console' : 'Hide Log Console'}</span>
                  </button>
                </div>
              )}
            </div>

          </nav>
        </div>

        <div className="toolbar-right">
          {sharedFiles.length > 0 && (
            <select
              value={activeFileId || ''}
              onChange={e => setActiveFileId(e.target.value)}
              className="toolbar-file-select"
              title="Active file"
            >
              {sharedFiles.map(f => (
                <option key={f.id} value={f.id}>{f.name}</option>
              ))}
            </select>
          )}
          <span className="toolbar-workspace-info">{sharedFiles.length} file{sharedFiles.length !== 1 ? 's' : ''} loaded</span>
        </div>
      </header>

      {/* Main Split Layout */}
      <div className="main-paned">

        {/* Left Control Sidebar */}
        <div className={`pane-control-sidebar ${externalWindow ? 'expanded' : ''} ${sidebarOpen ? '' : 'collapsed'}`}>

          {/* Pipeline Stepper: always-visible core workflow, Frames -> Stack -> Process -> Inspect -> Export */}
          <div className="pipeline-stepper">
            {PIPELINE_STAGES.map((stage, idx) => {
              const Icon = stage.icon;
              return (
                <button
                  key={stage.id}
                  className={`stepper-step ${activeTab === stage.id ? 'active' : ''}`}
                  onClick={() => openTool(stage.id)}
                  title={PANEL_LABELS[stage.id]}
                >
                  <span className="stepper-step-num">{idx + 1}</span>
                  <Icon size={13} />
                  <span className="stepper-step-label">{stage.shortLabel}</span>
                </button>
              );
            })}
          </div>

          {/* Optional tools: supplementary utilities, not every session needs all of them */}
          <div className="tools-strip">
            <span className="tools-strip-label">Tools</span>
            <div className="tools-strip-chips">
              {TOOL_TABS.map(tool => {
                const Icon = tool.icon;
                return (
                  <button
                    key={tool.id}
                    className={`tool-chip ${activeTab === tool.id ? 'active' : ''}`}
                    onClick={() => openTool(tool.id)}
                    title={tool.label}
                  >
                    <Icon size={12} />
                  </button>
                );
              })}
            </div>
          </div>

          {/* Panel header */}
          <div className="panel-header">
            <span className="panel-title">{PANEL_LABELS[activeTab]}</span>
            <button className="panel-close-btn" onClick={() => setSidebarOpen(false)} title="Close panel">
              <X size={13} />
            </button>
          </div>

          <div className="pane-notebook">
            <div className="notebook-content">
              <ErrorBoundary>
                {activeTab === 'metadata' && (
                  <MetadataExplorer 
                    activeFile={activeFile} 
                    sharedFiles={sharedFiles}
                    onSelectFile={setActiveFileId}
                    onUpdateFits={handleUpdateFits}
                    onUpdateHeaders={handleUpdateHeaders}
                    addLog={addLog}
                    onAddFiles={handleAddFiles}
                  />
                )}
                {activeTab === 'batch' && (
                  <BatchManager onAddFiles={handleAddFiles} addLog={addLog} />
                )}
                {activeTab === 'subframes' && (
                  <SubframeSelector 
                    sharedFiles={sharedFiles} 
                    addLog={addLog}
                    frames={frames}
                    setFrames={setFrames}
                    activeMetric={activeMetric}
                    setActiveMetric={setActiveMetric}
                    thresholds={thresholds}
                    setThresholds={setThresholds}
                  />
                )}
                {activeTab === 'postprocess' && (
                  <PostProcessor
                    activeFile={activeFile}
                    sharedFiles={sharedFiles}
                    onUpdateFits={handleUpdateFits}
                    onLivePreview={handleLivePreview}
                    onAddFiles={handleAddFiles}
                    addLog={addLog}
                  />
                )}
                {activeTab === 'physics' && (
                  <PhysicsLab
                    activeFile={activeFile}
                    sharedFiles={sharedFiles}
                    onUpdateFits={handleUpdateFits}
                    addLog={addLog}
                  />
                )}
                {activeTab === 'workflow' && (
                  <WorkflowBuilder 
                    sharedFiles={sharedFiles} 
                    activeFile={activeFile}
                    onUpdateFits={handleUpdateFits}
                    onSelectFile={setActiveFileId}
                    onAddFiles={handleAddFiles}
                    addLog={addLog} 
                  />
                )}
                {activeTab === 'converter' && (
                  <Converter 
                    sharedFiles={sharedFiles} 
                    onAddFiles={handleAddFiles} 
                    addLog={addLog} 
                  />
                )}
                {activeTab === 'script' && (
                  <ScriptConsole
                    activeFile={activeFile}
                    sharedFiles={sharedFiles}
                    onUpdateFits={handleUpdateFits}
                    addLog={addLog}
                  />
                )}
                {activeTab === 'planner' && (
                  <PlannerPanel addLog={addLog} />
                )}
                {activeTab === 'inspector' && (
                  <RealityInspector
                    activeFile={activeFile}
                    addLog={addLog}
                    compareMode={compareMode}
                    onCompareModeChange={setCompareMode}
                    blinkRate={blinkRate}
                    onBlinkRateChange={setBlinkRate}
                    swipePos={swipePos}
                    onSwipePosChange={setSwipePos}
                    diffBoost={diffBoost}
                    onDiffBoostChange={setDiffBoost}
                    diffMode={diffMode}
                    onDiffModeChange={setDiffMode}
                    profileMode={profileMode}
                    onProfileModeChange={setProfileMode}
                    originalProfile={originalProfile}
                    processedProfile={processedProfile}
                    dssImageUrl={dssImageUrl}
                    onDssUrlChange={setDssImageUrl}
                  />
                )}
              </ErrorBoundary>
            </div>
          </div>

          <div className={`pane-console ${consoleCollapsed ? 'collapsed' : ''}`}>
            <div 
              className="console-header" 
              style={{ cursor: 'pointer', userSelect: 'none' }} 
              onClick={() => setConsoleCollapsed(prev => !prev)}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
                <span>System Log Console</span>
                {consoleCollapsed ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
              </div>
            </div>
            {!consoleCollapsed && (
              <div className="console-content">
                {logs.map((log) => (
                  <div key={log.id} className="log-entry">
                    <span className="log-time">[{log.time}]</span>
                    <span className={`log-msg ${log.type}`}>{log.msg}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>

        {/* Right Viewport */}
        {!externalWindow && (
          <div className="pane-viewport">
            <AstroPreviewer
              activeFile={activeFile}
              sharedFiles={sharedFiles}
              onSelectFile={setActiveFileId}
              onAddFiles={handleAddFiles}
              addLog={addLog}
              activeTab={activeTab}
              subframeFrames={frames}
              subframeMetric={activeMetric}
              subframeThresholds={thresholds}
              onPopOut={popOutPreviewer}
              compareMode={compareMode}
              blinkRate={blinkRate}
              swipePos={swipePos}
              diffBoost={diffBoost}
              diffMode={diffMode}
              profileMode={profileMode}
              onProfileDataChange={(orig, proc) => {
                setOriginalProfile(orig);
                setProcessedProfile(proc);
              }}
              dssImageUrl={dssImageUrl}
              onUpdateFits={handleUpdateFits}
              livePreviewData={livePreviewData}
            />
          </div>
        )}

        {externalWindow && (() => {
          const portalRoot = externalWindow.document.getElementById('preview-portal-root');
          return portalRoot ? createPortal(
            <AstroPreviewer 
              activeFile={activeFile} 
              sharedFiles={sharedFiles}
              onSelectFile={setActiveFileId}
              onAddFiles={handleAddFiles}
              addLog={addLog}
              activeTab={activeTab}
              subframeFrames={frames}
              subframeMetric={activeMetric}
              subframeThresholds={thresholds}
              isPoppedOut={true}
              onPopOut={() => { externalWindow.close(); setExternalWindow(null); }}
              compareMode={compareMode}
              blinkRate={blinkRate}
              swipePos={swipePos}
              diffBoost={diffBoost}
              diffMode={diffMode}
              profileMode={profileMode}
              onProfileDataChange={(orig, proc) => {
                setOriginalProfile(orig);
                setProcessedProfile(proc);
              }}
              dssImageUrl={dssImageUrl}
              onUpdateFits={handleUpdateFits}
            />,
            portalRoot
          ) : null;
        })()}

      </div>
    </Layout>
  );
}

export default App;
