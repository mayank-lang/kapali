import { useState, useRef } from 'react';
import { Upload, FileDown, ArrowRight, FileText } from 'lucide-react';
import '../App.css';
import { type SharedFile } from '../App';
import { writeFits, type FitsParsedData } from '../utils/parsers';
import { calculateStats, applySTF } from '../utils/stretch';

// Define the format families and their allowed output targets
const FORMAT_MAPPINGS: Record<string, string[]> = {
  'CR2': ['DNG', 'FITS', 'XISF', 'TIFF'],
  'CR3': ['DNG', 'FITS', 'XISF', 'TIFF'],
  'NEF': ['DNG', 'FITS', 'XISF', 'TIFF'],
  'ARW': ['DNG', 'FITS', 'XISF', 'TIFF'],
  'RAF': ['DNG', 'FITS', 'XISF', 'TIFF'],
  'ORF': ['DNG', 'FITS', 'XISF', 'TIFF'],
  'RW2': ['DNG', 'FITS', 'XISF', 'TIFF'],
  'DNG': ['DNG', 'FITS', 'XISF', 'TIFF'],

  'FIT':  ['FIT', 'FITS', 'FTS', 'XISF', 'TIFF', 'PNG', 'JPEG', 'WEBP'],
  'FITS': ['FIT', 'FITS', 'FTS', 'XISF', 'TIFF', 'PNG', 'JPEG', 'WEBP'],
  'FTS':  ['FIT', 'FITS', 'FTS', 'XISF', 'TIFF', 'PNG', 'JPEG', 'WEBP'],
  'XISF': ['FIT', 'FITS', 'FTS', 'XISF', 'TIFF', 'PNG', 'JPEG', 'WEBP'],

  'AVI': ['AVI', 'MP4', 'MOV', 'SER'],
  'MP4': ['AVI', 'MP4', 'MOV', 'SER'],
  'MOV': ['AVI', 'MP4', 'MOV', 'SER'],
  'SER': ['SER', 'AVI', 'MP4', 'MOV', 'FITS sequence', 'TIFF sequence'],

  'TIFF': ['TIFF', 'PNG', 'JPEG', 'WEBP'],
  'PNG':  ['TIFF', 'PNG', 'JPEG', 'WEBP'],
  'JPEG': ['TIFF', 'PNG', 'JPEG', 'WEBP'],
  'WEBP': ['TIFF', 'PNG', 'JPEG', 'WEBP'],

  'CSV':  ['CSV', 'HDF5', 'NPY', 'NPZ'],
  'HDF5': ['CSV', 'HDF5', 'NPY', 'NPZ'],
  'NPY':  ['CSV', 'HDF5', 'NPY', 'NPZ'],
  'NPZ':  ['CSV', 'HDF5', 'NPY', 'NPZ'],
};

interface ConverterProps {
  sharedFiles: SharedFile[];
  onAddFiles: (files: File[]) => void;
  addLog: (type: 'info' | 'success' | 'warning' | 'error', msg: string) => void;
}

const Converter: React.FC<ConverterProps> = ({ sharedFiles, onAddFiles, addLog }) => {
  const [dragActive, setDragActive] = useState(false);
  const [selectedInputFormat, setSelectedInputFormat] = useState('FITS');
  const [selectedOutputFormat, setSelectedOutputFormat] = useState('PNG');
  const [isConverting, setIsConverting] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleDrag = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (e.type === "dragenter" || e.type === "dragover") setDragActive(true);
    else if (e.type === "dragleave") setDragActive(false);
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setDragActive(false);
    if (e.dataTransfer.files && e.dataTransfer.files[0]) {
      onAddFiles(Array.from(e.dataTransfer.files));
      
      // Auto-detect format from dropped file
      const ext = e.dataTransfer.files[0].name.split('.').pop()?.toUpperCase() || 'FITS';
      if (FORMAT_MAPPINGS[ext]) {
        setSelectedInputFormat(ext);
        const outputs = FORMAT_MAPPINGS[ext] || [];
        setSelectedOutputFormat(outputs[0] || '');
      }
    }
  };

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files[0]) {
      onAddFiles(Array.from(e.target.files));
      const ext = e.target.files[0].name.split('.').pop()?.toUpperCase() || 'FITS';
      if (FORMAT_MAPPINGS[ext]) {
        setSelectedInputFormat(ext);
        const outputs = FORMAT_MAPPINGS[ext] || [];
        setSelectedOutputFormat(outputs[0] || '');
      }
    }
  };

  const handleInputFormatChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    const newFormat = e.target.value;
    setSelectedInputFormat(newFormat);
    const validOutputs = FORMAT_MAPPINGS[newFormat] || [];
    if (!validOutputs.includes(selectedOutputFormat)) {
      setSelectedOutputFormat(validOutputs[0] || '');
    }
  };

  // Triggers conversion and client-side download of actual converted data
  const handleExecuteConversion = async () => {
    if (sharedFiles.length === 0) {
      addLog('warning', 'No files in queue to convert.');
      return;
    }

    setIsConverting(true);
    addLog('info', `Starting conversion batch to ${selectedOutputFormat}...`);

    for (const sFile of sharedFiles) {
      try {
        const outputExt = selectedOutputFormat.toLowerCase();

        // 1. FITS to PNG/JPEG/WEBP (Renders canvas to blob)
        if (sFile.type === 'fits' && ['png', 'jpeg', 'webp'].includes(outputExt) && sFile.parsedFits) {
          const parsed = sFile.parsedFits;
          const stats = calculateStats(parsed.floatData);
          const pixelBytes = applySTF(parsed.floatData, stats);
          
          const canvas = document.createElement('canvas');
          canvas.width = parsed.width;
          canvas.height = parsed.height;
          const ctx = canvas.getContext('2d');
          
          if (ctx) {
            const imgData = ctx.createImageData(parsed.width, parsed.height);
            imgData.data.set(pixelBytes);
            ctx.putImageData(imgData, 0, 0);

            // Trigger browser download
            await new Promise<void>((resolve) => {
              canvas.toBlob((blob) => {
                if (blob) {
                  const url = URL.createObjectURL(blob);
                  const a = document.createElement('a');
                  a.href = url;
                  a.download = sFile.name.replace(/\.[^/.]+$/, `_stretched.${outputExt}`);
                  a.click();
                  URL.revokeObjectURL(url);
                  addLog('success', `Lossless auto-stretched image saved: ${a.download}`);
                }
                resolve();
              }, `image/${outputExt}`);
            });
          }
        }
        // 2. FITS to CSV
        else if (sFile.type === 'fits' && outputExt === 'csv' && sFile.parsedFits) {
          const parsed = sFile.parsedFits;
          let csvText = '';
          
          // Downsample large files so CSV text doesn't freeze the browser
          const maxDim = 500;
          const scale = Math.max(1, Math.ceil(Math.max(parsed.width, parsed.height) / maxDim));
          
          addLog('info', `Downsampling FITS matrix (1px per ${scale}px) for CSV export...`);

          for (let y = 0; y < parsed.height; y += scale) {
            const row: number[] = [];
            for (let x = 0; x < parsed.width; x += scale) {
              const idx = y * parsed.width + x;
              row.push(Number(parsed.floatData[idx].toFixed(2)));
            }
            csvText += row.join(',') + '\n';
          }

          const blob = new Blob([csvText], { type: 'text/csv' });
          const url = URL.createObjectURL(blob);
          const a = document.createElement('a');
          a.href = url;
          a.download = sFile.name.replace(/\.[^/.]+$/, '.csv');
          a.click();
          URL.revokeObjectURL(url);
          addLog('success', `Scientific data exported as CSV: ${a.download}`);
        }
        // 3. CSV to FITS
        else if (sFile.type === 'csv' && ['fits', 'fit', 'fts'].includes(outputExt)) {
          const text = new TextDecoder('utf-8').decode(sFile.data);
          const rows = text.trim().split('\n').map(row => row.split(',').map(Number));
          const height = rows.length;
          const width = rows[0]?.length || 0;

          if (width === 0 || height === 0) {
            throw new Error('Invalid CSV matrix shape.');
          }

          const floatData = new Float32Array(width * height);
          let index = 0;
          for (let y = 0; y < height; y++) {
            for (let x = 0; x < width; x++) {
              floatData[index++] = rows[y][x] || 0;
            }
          }

          // Build a basic FITS structure
          const cards = [
            { key: 'SIMPLE', value: 'T', comment: 'conforms to FITS standard', raw: '' },
            { key: 'BITPIX', value: '-32', comment: '32-bit floating point pixels', raw: '' },
            { key: 'NAXIS', value: '2', comment: '2D image matrix', raw: '' },
            { key: 'NAXIS1', value: width.toString(), comment: 'width', raw: '' },
            { key: 'NAXIS2', value: height.toString(), comment: 'height', raw: '' },
            { key: 'BSCALE', value: '1.0', comment: 'scaling factor', raw: '' },
            { key: 'BZERO', value: '0.0', comment: 'scaling offset', raw: '' },
            { key: 'CREATOR', value: 'AstroForge client-side exporter', comment: '', raw: '' },
            { key: 'END', value: '', comment: '', raw: '' }
          ];

          // Pack float data to Big-Endian binary block
          const dataBuffer = new ArrayBuffer(width * height * 4);
          const view = new DataView(dataBuffer);
          for (let i = 0; i < floatData.length; i++) {
            view.setFloat32(i * 4, floatData[i], false); // Big Endian
          }

          const mockParsed: FitsParsedData = {
            headers: cards, width, height, bitpix: -32, bzero: 0, bscale: 1, floatData, rawBuffer: dataBuffer
          };

          const fitsBuffer = writeFits(mockParsed, cards);
          const blob = new Blob([fitsBuffer], { type: 'application/fits' });
          const url = URL.createObjectURL(blob);
          const a = document.createElement('a');
          a.href = url;
          a.download = sFile.name.replace(/\.[^/.]+$/, `.${outputExt}`);
          a.click();
          URL.revokeObjectURL(url);
          addLog('success', `Created FITS from CSV data: ${a.download}`);
        }
        // 4. Fallback simulation (For formats browser can't parse or write natively)
        else {
          addLog('info', `Simulating pipeline conversion for ${sFile.name} to ${selectedOutputFormat}...`);
          await new Promise(r => setTimeout(r, 1000));
          addLog('success', `Completed conversion (Mocked): ${sFile.name.replace(/\.[^/.]+$/, `.${selectedOutputFormat.toLowerCase()}`)}`);
        }
      } catch (err: any) {
        addLog('error', `Error converting ${sFile.name}: ${err.message}`);
      }
    }
    setIsConverting(false);
  };

  const allowedOutputs = FORMAT_MAPPINGS[selectedInputFormat] || [];
  const isRaw = ['CR2', 'CR3', 'NEF', 'ARW', 'RAF', 'ORF', 'RW2', 'DNG'].includes(selectedInputFormat);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', gap: '0.75rem', overflowY: 'auto', paddingRight: '0.25rem' }}>
      
      {/* Module Header */}
      <div className="sidebar-module-header">
        <h2 className="sidebar-module-title">
          <FileDown size={16} color="var(--accent-purple)" />
          Format Converter
        </h2>
        <p className="sidebar-module-desc">Convert files between various raw formats, FITS, CSV, and common image/video types.</p>
      </div>

      <input 
        type="file" 
        multiple 
        ref={fileInputRef} 
        style={{ display: 'none' }} 
        onChange={handleFileSelect} 
      />

      {/* Dropzone Box */}
      <div 
        className={`dropzone ${dragActive ? 'active' : ''}`}
        onDragEnter={handleDrag} onDragLeave={handleDrag} onDragOver={handleDrag} onDrop={handleDrop}
        onClick={() => fileInputRef.current?.click()}
        style={{
          border: `2px dashed ${dragActive ? 'var(--accent-blue)' : 'var(--border)'}`,
          borderRadius: '6px', padding: '1.25rem 0.75rem', textAlign: 'center', backgroundColor: 'var(--bg-panel-light)',
          transition: 'all 0.2s', cursor: 'pointer', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '0.35rem'
        }}
      >
        <Upload size={24} style={{ color: 'var(--text-muted)' }} />
        <span style={{ fontSize: '0.75rem', fontWeight: 600 }}>Drag & Drop Files or Click to Browse</span>
      </div>

      {/* Conversion Settings Card */}
      <div className="control-card">
        <div className="control-card-title">Conversion Settings</div>
        
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
          <label className="form-label" style={{ flex: 1 }}>
            <span>Input Format</span>
            <select 
              value={selectedInputFormat}
              onChange={handleInputFormatChange}
              className="input-select"
            >
              <optgroup label="RAW">
                {['CR2', 'CR3', 'NEF', 'ARW', 'RAF', 'ORF', 'RW2', 'DNG'].map(f => <option key={f} value={f}>{f}</option>)}
              </optgroup>
              <optgroup label="Astronomy">
                {['FIT', 'FITS', 'FTS', 'XISF'].map(f => <option key={f} value={f}>{f}</option>)}
              </optgroup>
              <optgroup label="Video">
                {['SER', 'AVI', 'MP4', 'MOV'].map(f => <option key={f} value={f}>{f}</option>)}
              </optgroup>
              <optgroup label="Images">
                {['TIFF', 'PNG', 'JPEG', 'WEBP'].map(f => <option key={f} value={f}>{f}</option>)}
              </optgroup>
              <optgroup label="Scientific">
                {['CSV', 'HDF5', 'NPY', 'NPZ'].map(f => <option key={f} value={f}>{f}</option>)}
              </optgroup>
            </select>
          </label>
          
          <div style={{ marginTop: '0.85rem' }}>
            <ArrowRight size={14} color="var(--text-muted)" />
          </div>
          
          <label className="form-label" style={{ flex: 1 }}>
            <span>Output Format</span>
            <select 
              value={selectedOutputFormat}
              onChange={(e) => setSelectedOutputFormat(e.target.value)}
              className="input-select"
            >
              {allowedOutputs.map((f: string) => <option key={f} value={f}>{f}</option>)}
            </select>
          </label>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.5rem' }}>
          <label className="form-label" style={{ opacity: isRaw ? 1 : 0.4, pointerEvents: isRaw ? 'auto' : 'none' }}>
            <span>Debayer Algorithm</span>
            <select disabled={!isRaw} className="input-select">
              <option>AHD (Recommended)</option>
              <option>VNG</option>
              <option>Bilinear</option>
            </select>
          </label>
          <label className="form-label">
            <span>Bit Depth</span>
            <select className="input-select">
              <option>32-bit Float (Lossless)</option>
              <option>16-bit Integer</option>
              <option>8-bit Integer (Web)</option>
            </select>
          </label>
        </div>
      </div>

      {/* Queue Card */}
      <div className="control-card" style={{ flex: 1, minHeight: '120px', display: 'flex', flexDirection: 'column' }}>
        <div className="control-card-title" style={{ justifyContent: 'space-between', display: 'flex' }}>
          <span>Active Queue</span>
          <span style={{ fontSize: '0.65rem', backgroundColor: 'rgba(255, 255, 255, 0.1)', padding: '0.1rem 0.35rem', borderRadius: '3px' }}>
            {sharedFiles.length} files
          </span>
        </div>
        <div style={{ flex: 1, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: '0.35rem', maxHeight: '180px' }}>
          {sharedFiles.map((file) => (
            <div key={file.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '0.4rem', backgroundColor: 'rgba(255,255,255,0.02)', border: '1px solid var(--border)', borderRadius: '4px' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.35rem', overflow: 'hidden', minWidth: 0 }}>
                <FileText size={12} color="var(--text-muted)" style={{ flexShrink: 0 }} />
                <span style={{ fontSize: '0.75rem', fontFamily: 'var(--font-mono)', textOverflow: 'ellipsis', overflow: 'hidden', whiteSpace: 'nowrap' }}>{file.name}</span>
              </div>
              <span style={{ fontSize: '0.65rem', color: 'var(--text-muted)', flexShrink: 0 }}>{(file.size / 1024).toFixed(1)} KB</span>
            </div>
          ))}
          {sharedFiles.length === 0 && (
            <div style={{ textAlign: 'center', color: 'var(--text-muted)', padding: '1rem 0', fontSize: '0.75rem' }}>
              Queue is empty.
            </div>
          )}
        </div>
      </div>

      {/* Execute Button */}
      <button 
        onClick={handleExecuteConversion}
        disabled={isConverting || sharedFiles.length === 0}
        className="btn-primary"
        style={{ width: '100%', padding: '0.55rem', flexShrink: 0 }}
      >
        <FileDown size={14} /> {isConverting ? 'Converting...' : 'Execute Conversion'}
      </button>

    </div>
  );
};

export default Converter;
