import React, { useState, useEffect } from 'react';
import { Search, Save, AlertOctagon, Copy, GitCompare, Database } from 'lucide-react';
import '../App.css';
import { type SharedFile } from '../App';
import { type FitsHeaderCard, writeFits } from '../utils/parsers';


interface MetadataExplorerProps {
  activeFile: SharedFile | null;
  sharedFiles: SharedFile[];
  onSelectFile: (id: string) => void;
  onUpdateFits: (id: string, updatedFits: any) => void;
  onUpdateHeaders: (id: string, updatedHeaders: FitsHeaderCard[]) => void;
  addLog: (type: 'info' | 'success' | 'warning' | 'error', msg: string) => void;
  onAddFiles: (files: File[]) => void;
}

interface MetadataTemplate {
  name: string;
  cards: { key: string, value: string }[];
}

const MetadataExplorer: React.FC<MetadataExplorerProps> = ({
  activeFile, sharedFiles, onUpdateFits, onUpdateHeaders, addLog
}) => {
  const [searchQuery, setSearchQuery] = useState('');
  const [editedHeaders, setEditedHeaders] = useState<FitsHeaderCard[]>([]);
  const [validationErrors, setValidationErrors] = useState<string[]>([]);
  const [sidecarNotes, setSidecarNotes] = useState('');

  // Template System States
  const [templates, setTemplates] = useState<MetadataTemplate[]>([]);
  const [selectedTemplateName, setSelectedTemplateName] = useState('');
  const [newTemplateName, setNewTemplateName] = useState('');
  const [showTemplates, setShowTemplates] = useState(false);

  // Diff System States
  const [compareMode, setCompareMode] = useState(false);
  const [compareFileId, setCompareFileId] = useState<string>('');

  // Load saved templates from localStorage on mount
  useEffect(() => {
    try {
      const stored = localStorage.getItem('astroforge_metadata_templates');
      if (stored) {
        setTemplates(JSON.parse(stored));
      }
    } catch (e) {
      console.error(e);
    }
  }, []);

  // Sync state with active file
  useEffect(() => {
    if (activeFile) {
      setEditedHeaders([...activeFile.extractedHeaders]);
      setSidecarNotes('');
      if (activeFile.type === 'fits') {
        runFitsValidation(activeFile.extractedHeaders);
      } else {
        setValidationErrors(prev => prev.length > 0 ? [] : prev);
      }
    } else {
      setEditedHeaders(prev => prev.length > 0 ? [] : prev);
      setValidationErrors(prev => prev.length > 0 ? [] : prev);
    }
  }, [activeFile]);

  // Validation check for FITS files
  const runFitsValidation = (cards: FitsHeaderCard[]) => {
    const warnings: string[] = [];
    const keys = cards.map(c => c.key);
    const getVal = (key: string) => cards.find(c => c.key === key)?.value;

    if (!keys.includes('DATE-OBS')) warnings.push("Missing critical keyword: 'DATE-OBS' (Observation time).");
    if (!keys.includes('EXPTIME')) {
      warnings.push("Missing critical keyword: 'EXPTIME' (Exposure time).");
    } else {
      const expVal = parseFloat(getVal('EXPTIME') || '0');
      if (isNaN(expVal) || expVal <= 0) warnings.push(`Suspicious 'EXPTIME' value: ${getVal('EXPTIME')}s.`);
    }
    if (!keys.includes('IMAGETYP')) warnings.push("Missing keyword: 'IMAGETYP' (Frame type).");
    if (!keys.includes('FILTER')) warnings.push("Missing keyword: 'FILTER'.");

    const ccdTempStr = getVal('CCD-TEMP');
    if (ccdTempStr) {
      const temp = parseFloat(ccdTempStr);
      if (!isNaN(temp) && (temp > 80 || temp < -100)) warnings.push(`Impossible 'CCD-TEMP' value: ${temp}°C.`);
    }

    const hasWcs = keys.includes('CRVAL1') && keys.includes('CRVAL2') && keys.includes('CRPIX1') && keys.includes('CRPIX2');
    if (!hasWcs) warnings.push("Validation Warning: Missing WCS (World Coordinate System) mapping keywords.");

    setValidationErrors(warnings);
  };

  const handleHeaderValueChange = (index: number, newValue: string) => {
    const updated = [...editedHeaders];
    updated[index] = { ...updated[index], value: newValue };
    setEditedHeaders(updated);
    onUpdateHeaders(activeFile!.id, updated);
    if (activeFile?.type === 'fits') {
      runFitsValidation(updated);
    }
  };

  const handleHeaderCommentChange = (index: number, newComment: string) => {
    const updated = [...editedHeaders];
    updated[index] = { ...updated[index], comment: newComment };
    setEditedHeaders(updated);
    onUpdateHeaders(activeFile!.id, updated);
  };

  // ----------------- Template System Handlers -----------------
  const handleSaveTemplate = () => {
    if (!newTemplateName.trim()) {
      addLog('warning', 'Please enter a template name.');
      return;
    }
    if (editedHeaders.length === 0) return;

    // We only template non-file-specific metadata (e.g. not FILENAME, FILESIZE, SHA256, MODIFIED)
    const ignoreKeys = ['FILENAME', 'FILESIZE', 'FILEEXT', 'SHA256', 'MODIFIED'];
    const cardsToSave = editedHeaders
      .filter(h => !ignoreKeys.includes(h.key))
      .map(h => ({ key: h.key, value: h.value }));

    const newTemplate: MetadataTemplate = {
      name: newTemplateName,
      cards: cardsToSave
    };

    const updatedTemplates = [...templates.filter(t => t.name !== newTemplateName), newTemplate];
    setTemplates(updatedTemplates);
    localStorage.setItem('astroforge_metadata_templates', JSON.stringify(updatedTemplates));
    setNewTemplateName('');
    addLog('success', `Saved metadata template: "${newTemplate.name}"`);
  };

  const handleApplyTemplate = () => {
    const t = templates.find(temp => temp.name === selectedTemplateName);
    if (!t || !activeFile) return;

    const updated = editedHeaders.map(card => {
      const templateCard = t.cards.find(tc => tc.key === card.key);
      if (templateCard) {
        return { ...card, value: templateCard.value };
      }
      return card;
    });

    setEditedHeaders(updated);
    onUpdateHeaders(activeFile.id, updated);
    addLog('success', `Applied template "${t.name}" to ${activeFile.name}`);
  };

  // ----------------- Save and Export Handlers -----------------
  const handleSaveChanges = () => {
    if (!activeFile) return;

    const fileNameCard = editedHeaders.find(h => h.key === 'FILENAME');
    const targetFilename = fileNameCard?.value || activeFile.name;

    if (activeFile.type === 'fits' && activeFile.parsedFits) {
      try {
        addLog('info', 'Compiling and packing updated FITS block...');
        const fitsOnlyHeaders = editedHeaders.slice(5);
        const fitsBuffer = writeFits(activeFile.parsedFits, fitsOnlyHeaders);
        
        const updatedFits = {
          ...activeFile.parsedFits,
          headers: fitsOnlyHeaders,
          rawBuffer: fitsBuffer
        };
        onUpdateFits(activeFile.id, updatedFits);

        const blob = new Blob([fitsBuffer], { type: 'application/fits' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = targetFilename.endsWith('.fits') || targetFilename.endsWith('.fit') ? targetFilename : `${targetFilename}.fits`;
        a.click();
        URL.revokeObjectURL(url);

        addLog('success', `Exported FITS file successfully: ${a.download}`);
      } catch (err: any) {
        addLog('error', `Failed to export FITS headers: ${err.message}`);
      }
    } 
    else {
      try {
        addLog('info', 'Generating Sidecar Annotation file...');
        const metadataMap: Record<string, { value: string, comment: string }> = {};
        editedHeaders.forEach(h => {
          metadataMap[h.key] = { value: h.value, comment: h.comment };
        });

        const sidecarData = {
          file_metadata: metadataMap,
          annotations: sidecarNotes,
          exported_at: new Date().toISOString()
        };

        const jsonString = JSON.stringify(sidecarData, null, 2);
        const blob = new Blob([jsonString], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `${targetFilename}.astroforge.json`;
        a.click();
        URL.revokeObjectURL(url);

        addLog('success', `Sidecar Annotation saved: ${a.download}`);
      } catch (err: any) {
        addLog('error', `Failed to export sidecar annotation: ${err.message}`);
      }
    }
  };

  const filteredHeaders = editedHeaders.filter(
    h => h.key.toLowerCase().includes(searchQuery.toLowerCase()) || 
         h.value.toLowerCase().includes(searchQuery.toLowerCase()) ||
         h.comment.toLowerCase().includes(searchQuery.toLowerCase())
  );

  // ----------------- Metadata Diff Logic -----------------
  const compareFile = sharedFiles.find(f => f.id === compareFileId);
  const diffRows: { key: string, activeVal: string, compareVal: string, isDifferent: boolean }[] = [];

  if (compareMode && activeFile && compareFile) {
    // Generate comparison mapping
    const activeKeys = activeFile.extractedHeaders.map((h: any) => h.key);
    const compareKeys = compareFile.extractedHeaders.map((h: any) => h.key);
    const allKeys = Array.from(new Set([...activeKeys, ...compareKeys]));

    allKeys.forEach(k => {
      const activeCard = activeFile.extractedHeaders.find((h: any) => h.key === k);
      const compareCard = compareFile.extractedHeaders.find((h: any) => h.key === k);
      
      const activeVal = activeCard ? activeCard.value : '(Not Present)';
      const compareVal = compareCard ? compareCard.value : '(Not Present)';
      
      diffRows.push({
        key: k,
        activeVal,
        compareVal,
        isDifferent: activeVal !== compareVal
      });
    });
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', gap: '0.75rem', overflow: 'hidden' }}>
      
      {/* Top Header & Actions Row */}
      <div className="sidebar-module-header">
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <h2 className="sidebar-module-title">
            <Database size={16} color="var(--accent-purple)" />
            Metadata Explorer
            {activeFile && (
              <span style={{ fontSize: '0.7rem', color: 'var(--accent-blue)', backgroundColor: 'var(--bg-deep)', padding: '0.15rem 0.35rem', borderRadius: '4px', fontFamily: 'var(--font-mono)', textTransform: 'none' }}>
                {activeFile.name.split('.').pop()?.toUpperCase()}
              </span>
            )}
          </h2>
          {activeFile && (
            <button 
              disabled={!activeFile}
              onClick={handleSaveChanges}
              className="btn-primary"
            >
              <Save size={12} /> Save
            </button>
          )}
        </div>
        <p className="sidebar-module-desc">Inspect and edit FITS metadata cards and annotations.</p>

        {activeFile && (
          <div style={{ display: 'flex', gap: '0.4rem', marginTop: '0.5rem' }}>
            <button 
              onClick={() => { setCompareMode(!compareMode); setSearchQuery(''); }}
              className={compareMode ? "btn-primary" : "btn-secondary"}
              style={{ flex: 1 }}
            >
              <GitCompare size={12} /> {compareMode ? 'Exit Diff' : 'Compare Diff'}
            </button>
            
            <button 
              onClick={() => setShowTemplates(!showTemplates)}
              className={showTemplates ? "btn-primary" : "btn-secondary"}
              style={{ flex: 1 }}
            >
              <Copy size={12} /> Templates
            </button>
          </div>
        )}
      </div>

      {/* Templates Drawer */}
      {showTemplates && activeFile && (
        <div className="control-card">
          <div className="control-card-title">
            <Copy size={12} /> Metadata Templates
          </div>
          <div className="form-label">
            <span>Apply Template:</span>
            <div style={{ display: 'flex', gap: '0.3rem' }}>
              <select 
                value={selectedTemplateName} 
                onChange={e => setSelectedTemplateName(e.target.value)}
                className="input-select"
                style={{ padding: '0.25rem' }}
              >
                <option value="">Select template...</option>
                {templates.map(t => <option key={t.name} value={t.name}>{t.name}</option>)}
              </select>
              <button className="btn-primary" onClick={handleApplyTemplate} disabled={!selectedTemplateName} style={{ padding: '0.25rem 0.5rem' }}>Apply</button>
            </div>
          </div>
          <div className="form-label" style={{ borderTop: '1px dashed var(--border)', paddingTop: '0.4rem', marginTop: '0.2rem' }}>
            <span>Save current as template:</span>
            <div style={{ display: 'flex', gap: '0.3rem' }}>
              <input 
                type="text" 
                placeholder="Template name..." 
                value={newTemplateName}
                onChange={e => setNewTemplateName(e.target.value)}
                className="input-text"
                style={{ padding: '0.25rem' }}
              />
              <button className="btn-secondary" onClick={handleSaveTemplate} style={{ padding: '0.25rem 0.5rem' }}>Save</button>
            </div>
          </div>
        </div>
      )}

      {/* Compare Diff Drawer */}
      {compareMode && activeFile && (
        <div className="control-card">
          <div className="control-card-title">
            <GitCompare size={12} /> Compare Headers
          </div>
          <div className="form-label">
            <span>Compare with file:</span>
            <select 
              value={compareFileId} 
              onChange={e => setCompareFileId(e.target.value)}
              className="input-select"
              style={{ padding: '0.25rem' }}
            >
              <option value="">Choose file...</option>
              {sharedFiles.filter(f => f.id !== activeFile.id).map(f => <option key={f.id} value={f.id}>{f.name}</option>)}
            </select>
          </div>
        </div>
      )}

      {/* Main Metadata Listing Area (Scrollable) */}
      <div style={{ flex: 1, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
        
        {!activeFile ? (
          <div style={{ padding: '3rem 1rem', textAlign: 'center', color: 'var(--text-muted)', fontSize: '0.8rem' }}>
            No active file selected. Ingest or select a file in the workspace to view metadata.
          </div>
        ) : compareMode && compareFile ? (
          // 1. Compare Diff Cards Stack
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.4rem' }}>
            {diffRows.map((row) => (
              <div 
                key={row.key} 
                style={{ 
                  padding: '0.5rem', 
                  borderRadius: '6px',
                  backgroundColor: row.isDifferent ? 'rgba(239, 68, 68, 0.05)' : 'var(--bg-deep)',
                  border: `1px solid ${row.isDifferent ? 'rgba(239, 68, 68, 0.2)' : 'var(--border)'}`,
                  display: 'flex',
                  flexDirection: 'column',
                  gap: '0.25rem'
                }}
              >
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <span style={{ fontSize: '0.75rem', fontWeight: 700, fontFamily: 'var(--font-mono)', color: row.isDifferent ? 'var(--danger)' : 'var(--accent-purple)' }}>{row.key}</span>
                  {row.isDifferent && <span style={{ fontSize: '0.65rem', color: 'var(--danger)', fontWeight: 700, textTransform: 'uppercase' }}>Diff</span>}
                </div>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.4rem', fontSize: '0.7rem', borderTop: '1px dashed var(--border)', paddingTop: '0.25rem', marginTop: '0.15rem' }}>
                  <div style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    <span style={{ color: 'var(--text-muted)' }}>Active:</span> <span style={{ color: 'var(--text-main)', fontFamily: 'var(--font-mono)', fontWeight: 600 }}>{row.activeVal}</span>
                  </div>
                  <div style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    <span style={{ color: 'var(--text-muted)' }}>Compare:</span> <span style={{ color: 'var(--text-main)', fontFamily: 'var(--font-mono)', fontWeight: 600 }}>{row.compareVal}</span>
                  </div>
                </div>
              </div>
            ))}
          </div>
        ) : (
          // 2. Standard Metadata Form Stack
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
            
            {/* Inline Filter/Search Bar */}
            <div style={{ position: 'relative', flexShrink: 0, marginBottom: '0.25rem' }}>
              <Search size={12} color="var(--text-muted)" style={{ position: 'absolute', top: '50%', transform: 'translateY(-50%)', left: '0.4rem' }} />
              <input 
                type="text" 
                placeholder="Filter keywords..." 
                value={searchQuery}
                onChange={e => setSearchQuery(e.target.value)}
                className="input-text"
                style={{ paddingLeft: '1.6rem', paddingRight: '0.5rem', paddingTop: '0.3rem', paddingBottom: '0.3rem' }} 
              />
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.4rem' }}>
              {filteredHeaders.map((row) => {
                const originalIndex = editedHeaders.findIndex(h => h.key === row.key);
                const isSystemDescriptor = ['FILENAME', 'FILESIZE', 'FILEEXT', 'SHA256', 'MODIFIED'].includes(row.key);
                
                return (
                  <div 
                    key={row.key} 
                    style={{ 
                      padding: '0.5rem', 
                      backgroundColor: 'var(--bg-deep)', 
                      borderRadius: '6px', 
                      border: '1px solid var(--border)', 
                      display: 'flex', 
                      flexDirection: 'column', 
                      gap: '0.35rem' 
                    }}
                  >
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                      <span style={{ fontSize: '0.75rem', fontWeight: 700, fontFamily: 'var(--font-mono)', color: isSystemDescriptor ? 'var(--accent-blue)' : 'var(--accent-purple)' }}>{row.key}</span>
                      <input 
                        type="text" 
                        value={row.value} 
                        onChange={(e) => handleHeaderValueChange(originalIndex, e.target.value)}
                        className="input-text"
                        style={{ width: '60%', padding: '0.2rem 0.4rem', fontFamily: 'var(--font-mono)', fontSize: '0.75rem', textAlign: 'right' }} 
                      />
                    </div>
                    <input 
                      type="text" 
                      placeholder="Comment..." 
                      value={row.comment} 
                      onChange={(e) => handleHeaderCommentChange(originalIndex, e.target.value)}
                      style={{ width: '100%', backgroundColor: 'transparent', border: 'none', borderBottom: '1px dashed transparent', color: 'var(--text-muted)', fontSize: '0.65rem', padding: '0.1rem' }} 
                      onFocus={e => e.target.style.borderBottomColor = 'var(--border)'}
                      onBlur={e => e.target.style.borderBottomColor = 'transparent'}
                    />
                  </div>
                );
              })}
            </div>

            {/* Sidecar Annotation text area */}
            {activeFile.type !== 'fits' && (
              <div style={{ marginTop: '0.5rem', display: 'flex', flexDirection: 'column', gap: '0.3rem', borderTop: '1px dashed var(--border)', paddingTop: '0.6rem' }}>
                <span style={{ fontSize: '0.75rem', fontWeight: 600 }}>File Annotations & Notes</span>
                <textarea 
                  rows={2}
                  value={sidecarNotes}
                  onChange={(e) => setSidecarNotes(e.target.value)}
                  placeholder="Enter notes (included in sidecar JSON)..."
                  className="input-textarea"
                  style={{ fontSize: '0.75rem', resize: 'vertical' }}
                />
              </div>
            )}
          </div>
        )}
      </div>
      
      {/* Validation Warnings Banner for FITS */}
      {activeFile?.type === 'fits' && validationErrors.length > 0 && !compareMode && (
        <div style={{ backgroundColor: 'rgba(245, 158, 11, 0.05)', border: '1px solid var(--warning)', borderRadius: '6px', padding: '0.5rem', display: 'flex', flexDirection: 'column', gap: '0.25rem', flexShrink: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.3rem', fontWeight: 700, color: 'var(--warning)', fontSize: '0.75rem', textTransform: 'uppercase' }}>
            <AlertOctagon size={12} /> Validation Warnings ({validationErrors.length})
          </div>
          <ul style={{ paddingLeft: '1.1rem', fontSize: '0.65rem', color: 'var(--text-muted)', margin: 0, display: 'flex', flexDirection: 'column', gap: '0.15rem' }}>
            {validationErrors.map((err, i) => (
              <li key={i}>{err}</li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
};

export default MetadataExplorer;
