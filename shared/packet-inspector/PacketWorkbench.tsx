'use client';

import { useEffect, useId, useMemo, useRef, useState, type CSSProperties, type FormEvent } from 'react';
import { inspectPacket, normalizeHexInput, type PacketAnalysis, type PacketMode, type PacketField } from './packetParser';
import {
  CUSTOM_FIELDS_KEY, MODE_OPTIONS, ROW_HEIGHT, UDP_SAMPLE, fieldLabel, fieldValue, hexBytes, hexOffset,
  initialSelection, integerValue, isPayload, layerAt, layerLabel, layerTone, parseOffset, rangeInPacket,
  rangeText, readCustomFields, type ByteRange, type CustomField, type CustomFieldType,
} from './workbenchModel';
import styles from './PacketWorkbench.module.scss';
import { ToolWorkspaceHeader } from '../tool-workspace/ToolWorkspaceHeader';

export interface PacketWorkbenchProps {
  title?: string;
  onBack?: () => void;
  backHref?: string;
  /** Only an adapter supplies a host implementation; the view has no native imports. */
  analyze?: (hex: string, bytes: number[], mode: PacketMode) => Promise<PacketAnalysis>;
}

const EMPTY_ANALYSIS: PacketAnalysis = {
  mode: 'raw', byteCount: 0, bytes: [], protocol: '', confidence: 'low', layers: [], fields: [], warnings: [],
};
const SAMPLE_INPUT = hexBytes(normalizeHexInput(UDP_SAMPLE).bytes);

/** One selection model drives protocol navigation, bytes and both field tabs. */
export function PacketWorkbench({ title = '十六进制报文分析器', onBack, backHref, analyze }: PacketWorkbenchProps) {
  const initial = useMemo(() => inspectPacket(normalizeHexInput(UDP_SAMPLE).bytes, 'auto'), []);
  const first = useMemo(() => initialSelection(initial), [initial]);
  const [input, setInput] = useState(SAMPLE_INPUT);
  const [mode, setMode] = useState<PacketMode>('auto');
  const [analysis, setAnalysis] = useState(initial);
  const [analyzedInput, setAnalyzedInput] = useState(SAMPLE_INPUT);
  const [analyzedMode, setAnalyzedMode] = useState<PacketMode>('auto');
  const [collapsed, setCollapsed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [range, setRange] = useState<ByteRange>(first.range);
  const [selectedKey, setSelectedKey] = useState(first.key);
  const [activeLayer, setActiveLayer] = useState(first.layer);
  const [tab, setTab] = useState<'standard' | 'custom'>('standard');
  const [offsetInput, setOffsetInput] = useState(hexOffset(first.range.offset));
  const [locateError, setLocateError] = useState('');
  const [columnChoice, setColumnChoice] = useState<'auto' | '8' | '16' | '32'>('auto');
  const [byteViewportWidth, setByteViewportWidth] = useState(0);
  const autoColumns = byteViewportWidth >= 612 ? 16 : 8;
  const columns = columnChoice === 'auto' ? autoColumns : Number(columnChoice);
  const [viewport, setViewport] = useState({ top: 0, height: 256 });
  const [customFields, setCustomFields] = useState<CustomField[]>([]);
  const [editorOpen, setEditorOpen] = useState(false);
  const [editorRevision, setEditorRevision] = useState(0);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draftName, setDraftName] = useState('');
  const [draftOffset, setDraftOffset] = useState('34');
  const [draftLength, setDraftLength] = useState('2');
  const [draftType, setDraftType] = useState<CustomFieldType>('uint');
  const [draftEndian, setDraftEndian] = useState<'big' | 'little'>('big');
  const [customError, setCustomError] = useState('');
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const nameRef = useRef<HTMLInputElement>(null);
  const scrollerRef = useRef<HTMLDivElement>(null);
  const fieldScrollerRef = useRef<HTMLDivElement>(null);
  const editorRef = useRef<HTMLFormElement>(null);
  const selectionAnchor = useRef(first.range.offset);
  const generation = useRef(0);
  const selectionRevision = useRef(0);
  const previousByteLayout = useRef<{ columns: number; width: number; height: number } | null>(null);
  const ids = useId();
  const dirty = input !== analyzedInput || mode !== analyzedMode;

  const inputStatus = useMemo(() => {
    if (!input.trim()) return { normalized: null, error: '' };
    try { return { normalized: normalizeHexInput(input), error: '' }; }
    catch (e) { return { normalized: null, error: e instanceof Error ? e.message : '报文格式不正确。' }; }
  }, [input]);

  useEffect(() => {
    try { setCustomFields(readCustomFields(window.localStorage.getItem(CUSTOM_FIELDS_KEY))); }
    catch { /* Storage restrictions must not prevent inspecting a packet. */ }
    return () => { generation.current += 1; };
  }, []);

  useEffect(() => {
    const element = scrollerRef.current;
    if (!element) return;
    const observer = new ResizeObserver(() => {
      setViewport({ top: element.scrollTop, height: element.clientHeight });
      setByteViewportWidth(element.clientWidth);
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    // Initial automatic sizing should show the packet from offset 0000. Later
    // layout changes keep the selection visible without moving an already
    // visible range unnecessarily. User scrolling alone must not trigger this.
    const element = scrollerRef.current;
    const previous = previousByteLayout.current;
    previousByteLayout.current = { columns, width: byteViewportWidth, height: viewport.height };
    if (!element || !previous || previous.width === 0
      || (previous.columns === columns && previous.width === byteViewportWidth && previous.height === viewport.height)) return;
    const top = Math.floor(range.offset / columns) * ROW_HEIGHT;
    if (top < element.scrollTop || top + ROW_HEIGHT * 2 > element.scrollTop + element.clientHeight) {
      element.scrollTop = Math.max(0, top - ROW_HEIGHT);
    }
    setViewport({ top: element.scrollTop, height: element.clientHeight });
  }, [columns, byteViewportWidth, viewport.height]);

  useEffect(() => {
    if (editorOpen) {
      fieldScrollerRef.current?.scrollTo({ top: 0 });
      // Opening an editor below the fold must reveal it in the outer dashboard,
      // including when a second range is defined while the editor is already open.
      editorRef.current?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
      nameRef.current?.focus({ preventScroll: true });
    }
  }, [editorOpen, editorRevision]);

  const scrollToByte = (offset: number, force = false) => {
    const element = scrollerRef.current;
    if (!element) return;
    const top = Math.floor(offset / columns) * ROW_HEIGHT;
    if (force || top < element.scrollTop || top + ROW_HEIGHT * 2 > element.scrollTop + element.clientHeight) {
      element.scrollTop = Math.max(0, top - ROW_HEIGHT);
      setViewport({ top: element.scrollTop, height: element.clientHeight });
    }
  };

  const selectRange = (next: ByteRange, key: string, owner?: string, scroll = true, anchor = true) => {
    if (!rangeInPacket(next, analysis.bytes.length)) return;
    selectionRevision.current += 1;
    setRange(next);
    setSelectedKey(key);
    setOffsetInput(hexOffset(next.offset));
    setLocateError('');
    if (anchor) selectionAnchor.current = next.offset;
    const layer = owner ?? layerAt(analysis, next)?.id;
    if (layer) setActiveLayer(layer);
    if (scroll) scrollToByte(next.offset);
  };

  const resetSelection = (result: PacketAnalysis) => {
    const next = initialSelection(result);
    setRange(next.range);
    setSelectedKey(next.key);
    setActiveLayer(next.layer);
    selectionAnchor.current = next.range.offset;
    setOffsetInput(result.bytes.length ? hexOffset(next.range.offset) : '');
    setLocateError('');
    setEditorOpen(false);
    scrollerRef.current?.scrollTo({ top: 0 });
    setViewport((current) => ({ ...current, top: 0 }));
  };

  useEffect(() => {
    if (!analyze) return;
    const request = ++generation.current;
    const selectionAtStart = selectionRevision.current;
    const normalized = normalizeHexInput(UDP_SAMPLE);
    // The initial example uses the same host parser as subsequent analyses.
    // A late response must never replace a user's edited source or selection.
    let active = true;
    void analyze(normalized.hex, normalized.bytes, 'auto').then((result) => {
      if (!active || request !== generation.current || selectionAtStart !== selectionRevision.current) return;
      setAnalysis(result);
      resetSelection(result);
    }).catch(() => { /* The synchronously rendered fallback remains usable. */ });
    return () => { active = false; };
  }, [analyze]);

  const changeInput = (value: string) => {
    // Discard a pending native response when its source has already changed.
    generation.current += 1;
    setBusy(false);
    setInput(value);
    setError('');
    setMessage('');
  };

  const runAnalysis = async () => {
    if (busy) return;
    const request = ++generation.current;
    const source = input;
    const requestedMode = mode;
    let normalized;
    try { normalized = normalizeHexInput(source); }
    catch (e) { setError(e instanceof Error ? e.message : '请检查报文。'); setCollapsed(false); return; }
    setBusy(true);
    setError('');
    setMessage('');
    let result = inspectPacket(normalized.bytes, requestedMode);
    try {
      if (analyze) result = await analyze(normalized.hex, normalized.bytes, requestedMode);
    } catch {
      if (request === generation.current) setMessage('解析暂不可用，已显示备用解析结果。');
    }
    if (request !== generation.current) return;
    setAnalysis(result);
    setAnalyzedInput(source);
    setAnalyzedMode(requestedMode);
    resetSelection(result);
    setBusy(false);
  };

  const clearInput = () => {
    changeInput('');
    setAnalyzedInput('');
    setAnalyzedMode(mode);
    setAnalysis(EMPTY_ANALYSIS);
    resetSelection(EMPTY_ANALYSIS);
    setCollapsed(false);
    inputRef.current?.focus({ preventScroll: true });
  };

  const pasteInput = async () => {
    setCollapsed(false);
    try { changeInput(await navigator.clipboard.readText()); }
    catch {
      setMessage('无法直接读取剪贴板，请在报文输入框按 Ctrl+V 粘贴。');
      inputRef.current?.focus({ preventScroll: true });
    }
  };

  const copySelection = async () => {
    if (!rangeInPacket(range, analysis.bytes.length)) return;
    try {
      await navigator.clipboard.writeText(hexBytes(analysis.bytes.slice(range.offset, range.offset + range.length)));
      setMessage(`已复制 ${range.length} 字节。`);
    } catch { setMessage('复制失败，请允许剪贴板访问后重试。'); }
  };

  const selectByte = (index: number, extend: boolean) => {
    const start = extend ? Math.min(selectionAnchor.current, index) : index;
    const length = extend ? Math.abs(index - selectionAnchor.current) + 1 : 1;
    selectRange({ offset: start, length }, 'bytes', undefined, false, !extend);
  };

  const locate = () => {
    try {
      const offset = parseOffset(offsetInput, analysis.bytes.length);
      selectRange({ offset, length: 1 }, 'bytes');
      scrollToByte(offset, true);
    } catch (e) { setLocateError(e instanceof Error ? e.message : '偏移无效。'); }
  };

  const openEditor = (target: ByteRange = range, existing?: CustomField) => {
    if (!existing && !rangeInPacket(target, analysis.bytes.length)) return;
    setDraftName(existing?.name ?? '');
    setDraftOffset(String(target.offset));
    setDraftLength(String(target.length));
    setDraftType(existing?.type ?? (target.length <= 8 ? 'uint' : 'hex'));
    setDraftEndian(existing?.endian ?? 'big');
    setEditingId(existing?.id ?? null);
    setCustomError('');
    setTab('custom');
    setEditorOpen(true);
    setEditorRevision((revision) => revision + 1);
    fieldScrollerRef.current?.scrollTo({ top: 0 });
  };

  const persistFields = (next: CustomField[]) => {
    setCustomFields(next);
    try { window.localStorage.setItem(CUSTOM_FIELDS_KEY, JSON.stringify(next)); return true; }
    catch { setMessage('字段已在本次会话生效；当前环境禁止保存到本机。'); return false; }
  };

  const saveField = (event: FormEvent) => {
    event.preventDefault();
    const target = { offset: Number(draftOffset), length: Number(draftLength) };
    if (!draftName.trim()) { setCustomError('请填写字段名称。'); return; }
    if (!/^\d+$/.test(draftOffset) || !/^\d+$/.test(draftLength) || !rangeInPacket(target, analysis.bytes.length)) {
      setCustomError(`偏移从报文起点计算，长度至少为 1，结束位置不能超过 ${analysis.bytes.length} 字节。`); return;
    }
    if (['uint', 'int'].includes(draftType) && target.length > 8) {
      setCustomError('整数最多支持 8 字节；更长范围请选择 Hex 或文本。'); return;
    }
    const field: CustomField = { ...target, id: editingId ?? `field-${Date.now()}-${Math.random().toString(16).slice(2)}`,
      name: draftName.trim(), type: draftType, endian: draftEndian };
    const next = editingId ? customFields.map((item) => item.id === editingId ? field : item) : [...customFields, field];
    if (persistFields(next)) setMessage(`“${field.name}”已保存到本机。`);
    setEditorOpen(false);
    setCustomError('');
    selectRange(field, `custom:${field.id}`);
  };

  const validRange = rangeInPacket(range, analysis.bytes.length);
  const selectedBytes = validRange ? analysis.bytes.slice(range.offset, range.offset + range.length) : [];
  const selectedCustom = selectedKey.startsWith('custom:') ? customFields.find((field) => selectedKey === `custom:${field.id}`) : undefined;
  const selectedField = analysis.fields.find((field, index) => selectedKey === `field:${index}`)
    ?? (selectedKey === 'bytes' ? analysis.fields.find((field) => range.offset >= field.offset && range.offset + range.length <= field.offset + field.length) : undefined);
  const currentLayer = analysis.layers.find((layer) => layer.id === activeLayer);
  const currentFields = analysis.fields.map((field, index) => ({ field, key: `field:${index}` }))
    .filter(({ field }) => field.layer === activeLayer);
  const unknownLayers = analysis.layers.filter(isPayload);
  const payloadBytes = unknownLayers.reduce((count, layer) => count + layer.length, 0);
  const headerBytes = analysis.layers.filter((layer) => !isPayload(layer)).reduce((count, layer) => count + layer.length, 0);
  const warnings = analysis.warnings.filter((warning) => !['unknown-payload', 'raw-data'].includes(warning.code));
  const selectedDescription = selectedCustom ? `自定义 · ${selectedCustom.name}` : selectedField
    ? `${analysis.layers.find((layer) => layer.id === selectedField.layer)?.name ?? selectedField.layer} · ${fieldLabel(selectedField)}`
    : validRange ? (layerAt(analysis, range) ? layerLabel(layerAt(analysis, range)!) : '跨层选区') : '尚未选择';
  const rows = Math.ceil(analysis.bytes.length / columns);
  // Render only rows near the viewport, including offsets beyond the former 8 KiB cap.
  const startRow = Math.max(0, Math.floor((viewport.top - ROW_HEIGHT) / ROW_HEIGHT) - 5);
  const endRow = Math.min(rows, startRow + Math.ceil(viewport.height / ROW_HEIGHT) + 12);
  const rowIndexes = Array.from({ length: Math.max(0, endRow - startRow) }, (_, index) => startRow + index);
  const colorForByte = (index: number) => {
    const layer = layerAt(analysis, { offset: index, length: 1 });
    return layer ? layerTone(layer).background : '#F1F2F1';
  };
  const selectField = (field: PacketField, key: string) => selectRange(field, key, field.layer);
  const customPreviews = useMemo(() => new Map(customFields.map((field) => {
    // A field can span the whole packet. Limit table previews without changing
    // its true byte range, and do not decode it again on every scroll event.
    const preview = rangeInPacket(field, analysis.bytes.length) && field.length > 96
      ? `${fieldValue({ ...field, length: 96 }, analysis.bytes)} …` : fieldValue(field, analysis.bytes);
    return [field.id, preview];
  })), [customFields, analysis.bytes]);

  return (
    <section className={styles.workspace} data-input-collapsed={collapsed} aria-label={title}
      onKeyDown={(event) => {
        if ((event.ctrlKey || event.metaKey) && event.key === 'Enter' && !(tab === 'custom' && editorOpen)) { event.preventDefault(); void runAnalysis(); }
      }}>
      <ToolWorkspaceHeader title={title} onBack={onBack} backHref={backHref} />

      <section className={styles.inputCard} aria-label="报文输入">
        <header className={styles.inputHeading}>
          <h3>报文输入</h3>
          <div className={styles.inputActions}>
            <button type="button" onClick={() => void pasteInput()}>粘贴</button>
            <button type="button" onClick={() => { changeInput(SAMPLE_INPUT); setMode('auto'); setCollapsed(false); if (inputRef.current) inputRef.current.scrollTop = 0; }}>载入示例</button>
            <button type="button" onClick={clearInput}>清空</button>
            <button type="button" aria-expanded={!collapsed} aria-controls={`${ids}-input`} onClick={() => setCollapsed(!collapsed)}>{collapsed ? '展开 ⌄' : '收起 ⌃'}</button>
          </div>
        </header>
        <div id={`${ids}-input`} className={styles.inputBody} hidden={collapsed}>
          <textarea ref={inputRef} aria-label="十六进制报文" spellCheck={false} value={input} rows={3}
            placeholder="粘贴 Hex 字节或 Wireshark 转储…" onChange={(event) => changeInput(event.target.value)} />
        </div>
        <div className={styles.analysisControls}>
          <label>解析起点<select aria-label="解析起点" value={mode} title={MODE_OPTIONS.find((item) => item.value === mode)?.hint}
            onChange={(event) => { generation.current += 1; setBusy(false); setMode(event.target.value as PacketMode); setError(''); }}>
            {MODE_OPTIONS.map((item) => <option value={item.value} key={item.value}>{item.label}</option>)}
          </select></label>
          <div className={styles.inputFacts}><span>{inputStatus.normalized?.format ?? 'Hex / Wireshark 转储'}</span><strong>{inputStatus.normalized?.bytes.length ?? 0} 字节</strong></div>
          {dirty && <span className={styles.pendingBadge}>待重新分析</span>}
          <button className={styles.primaryButton} type="button" disabled={busy || !inputStatus.normalized} onClick={() => void runAnalysis()}>{busy ? '分析中…' : '分析报文'}<kbd>Ctrl Enter</kbd></button>
        </div>
        {(error || inputStatus.error) && <p className={styles.inputError} role="alert">{error || inputStatus.error}</p>}
        {message && <p className={styles.actionMessage} role="status">{message}</p>}
      </section>

      <div className={styles.protocolSummary}>
        <nav className={styles.protocolPath} aria-label="识别路径">
          {analysis.layers.length ? analysis.layers.map((layer, index) => <span key={`${layer.id}-${index}`}>
            {index > 0 && <i aria-hidden="true">→</i>}<button type="button" onClick={() => { selectRange(layer, `layer:${index}`, layer.id); setTab('standard'); }}>{layerLabel(layer)}</button>
          </span>) : <span>粘贴报文后开始分析</span>}
        </nav>
        {!!analysis.bytes.length && <span className={styles.summaryFacts}>首部 {headerBytes} B · 载荷 {payloadBytes} B{dirty ? ' · 当前显示上次结果' : ''}</span>}
      </div>

      <div className={styles.inspectorGrid} data-testid="packet-inspector-grid">
        <aside className={styles.layerPanel} data-testid="packet-layer-panel">
          <div className={styles.layerTreeArea}>
            <h3>协议分层</h3>
            <div className={styles.layerTree}>
              {analysis.layers.map((layer, index) => <div key={`${layer.id}-${index}`} className={styles.layerNode}
                data-testid={isPayload(layer) ? 'payload-layer-node' : undefined} data-layer-id={layer.id} data-layer-offset={layer.offset}
                style={{ '--layer-color': layerTone(layer).background, '--layer-accent': layerTone(layer).accent } as CSSProperties}>
                <button type="button" className={styles.layerButton} aria-pressed={layer.id === activeLayer}
                  onClick={() => { selectRange(layer, `layer:${index}`, layer.id); setTab('standard'); }}>
                  <i /><span><strong>{layerLabel(layer)}</strong><small>{rangeText(layer)}</small></span>
                </button>
                {isPayload(layer) && <button type="button" className={styles.definePayload}
                  aria-label={`定义载荷字段：${rangeText(layer)}`} onClick={() => {
                    selectRange(layer, 'bytes', layer.id); openEditor(layer);
                  }}>定义载荷字段 <span aria-hidden="true">→</span></button>}
              </div>)}
            </div>
            {!analysis.layers.length && <p className={styles.emptyState}>暂无协议层</p>}
            {!!warnings.length && <details className={styles.warningList}><summary>{warnings.length} 条解析提示</summary>
              {warnings.map((warning, index) => <p key={index}>{warning.message}<small>{hexOffset(warning.offset)}</small></p>)}
            </details>}
          </div>
          <section className={styles.selectionDetails} aria-label="当前选区">
            <h3 title="检查当前选中的原始字节范围；协议解析后的字段值请查看标准字段">当前选区</h3><span className={styles.selectionTag}>{selectedDescription}</span>
            <code className={styles.selectedHex} title={hexBytes(selectedBytes.slice(0, 64))}>{hexBytes(selectedBytes.slice(0, 24)) || '—'}{selectedBytes.length > 24 ? ' …' : ''}</code>
            <dl>
              <div><dt title="所有偏移从输入报文的第 0 字节开始">起始偏移</dt><dd>{validRange ? `${hexOffset(range.offset)} / ${range.offset}` : '—'}</dd></div>
              <div><dt>长度</dt><dd>{validRange ? range.length : 0} 字节</dd></div>
              <div><dt title="按选中的完整原始字节解释；协议位字段值请查看标准字段">大端整数</dt><dd>{integerValue(selectedBytes, 'big')}</dd></div>
              <div><dt title="按选中的完整原始字节解释；协议位字段值请查看标准字段">小端整数</dt><dd>{integerValue(selectedBytes, 'little')}</dd></div>
            </dl>
            {selectedBytes.length > 8 && <small>整数解释支持 1–8 字节</small>}
            <div className={styles.selectionActions}>
              <button type="button" disabled={!validRange} aria-label="复制选中字节" title="复制选中字节" onClick={() => void copySelection()}>复制字节</button>
              <button type="button" disabled={!validRange} aria-label="将选区定义为字段" title="将选区定义为字段" className={styles.outlineButton} onClick={() => openEditor()}>定义为字段</button>
            </div>
          </section>
          {unknownLayers.length > 0 && <p className={styles.unknownNote}>ⓘ 未知载荷需按协议文档定义</p>}
        </aside>

        <div className={styles.resultPanels} data-testid="packet-result-panels">
          <section className={styles.bytePanel} data-testid="packet-byte-panel">
            <header className={styles.byteToolbar}>
              <h3 title="按偏移检查 Hex 与 ASCII 原文，单击或 Shift 连选字节，与协议层和字段联动">字节视图</h3>
              <div className={styles.byteTools}>
                <label>定位偏移<input aria-label="定位偏移" value={offsetInput} placeholder="0x0022" title="输入偏移后按 Enter 定位；十六进制请加 0x"
                  onChange={(event) => { setOffsetInput(event.target.value); setLocateError(''); }} onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); locate(); } }} />
                  <button type="button" aria-label="跳转到偏移" title="跳转到偏移" onClick={locate}>↵</button></label>
                <select aria-label="每行字节数" value={columnChoice} onChange={(event) => setColumnChoice(event.target.value as typeof columnChoice)}>
                  <option value="auto">自动（{autoColumns} 字节）</option><option value="8">8 字节 / 行</option><option value="16">16 字节 / 行</option><option value="32">32 字节 / 行</option>
                </select>
              </div>
              <div className={styles.legend}>{analysis.layers.map((layer, index) => <span key={`${layer.id}-${index}`}><i style={{ background: layerTone(layer).accent }} />{isPayload(layer) ? '载荷' : layer.name.replace(' II', '')}</span>)}</div>
              {locateError && <p className={styles.inputError} role="alert">{locateError}</p>}
            </header>
            <div ref={scrollerRef} className={styles.hexScroller} role="region" aria-label="报文字节视图" tabIndex={0}
              style={{ '--byte-columns': columns } as CSSProperties}
              onScroll={(event) => setViewport({ top: event.currentTarget.scrollTop, height: event.currentTarget.clientHeight })}>
              <div className={styles.hexHeader}><b>偏移</b>{Array.from({ length: columns }, (_, i) => <i key={i}>{i.toString(16).toUpperCase().padStart(2, '0')}</i>)}<b>ASCII</b></div>
              <div className={styles.hexRows} style={{ height: rows * ROW_HEIGHT }}>
                {rowIndexes.map((row) => {
                  const offset = row * columns;
                  return <div key={row} className={styles.hexRow} style={{ top: row * ROW_HEIGHT }}>
                    <b>{offset.toString(16).toUpperCase().padStart(4, '0')}</b>
                    {Array.from({ length: columns }, (_, column) => {
                      const index = offset + column;
                      const byte = analysis.bytes[index];
                      if (byte === undefined) return <i key={column} />;
                      const selected = index >= range.offset && index < range.offset + range.length;
                      return <button key={column} type="button" data-byte-index={index} aria-pressed={selected}
                        aria-label={`${hexOffset(index)}: ${byte.toString(16).toUpperCase().padStart(2, '0')}`}
                        tabIndex={index === range.offset ? 0 : -1} className={selected ? styles.selectedByte : undefined}
                        data-range-start={selected && index === range.offset} data-range-end={selected && index === range.offset + range.length - 1}
                        style={{ '--byte-color': colorForByte(index) } as CSSProperties} onClick={(event) => selectByte(index, event.shiftKey)}
                        onKeyDown={(event) => {
                          const delta: Record<string, number> = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -columns, ArrowDown: columns };
                          if (!(event.key in delta)) return;
                          event.preventDefault(); const next = Math.max(0, Math.min(analysis.bytes.length - 1, index + delta[event.key]));
                          selectByte(next, event.shiftKey); scrollToByte(next);
                          requestAnimationFrame(() => scrollerRef.current?.querySelector<HTMLButtonElement>(`[data-byte-index="${next}"]`)?.focus({ preventScroll: true }));
                        }}>{byte.toString(16).toUpperCase().padStart(2, '0')}</button>;
                    })}
                    <code className={styles.ascii}>{analysis.bytes.slice(offset, offset + columns).map((byte, column) => {
                      const index = offset + column; const selected = index >= range.offset && index < range.offset + range.length;
                      return <span key={column} data-selected={selected} style={{ background: colorForByte(index) }}>{byte >= 32 && byte <= 126 ? String.fromCharCode(byte) : '·'}</span>;
                    })}</code>
                  </div>;
                })}
              </div>
              {!rows && <p className={styles.emptyState}>分析报文后，在这里查看字节和 ASCII 对照。</p>}
            </div>
            <footer className={styles.byteFooter}><span>{validRange ? `已选 ${rangeText(range).replace(' B', ' 字节')}` : '尚未选择字节'}</span><span>单击选择 · Shift 连选</span></footer>
          </section>

          <section className={styles.fieldPanel} data-testid="packet-field-panel">
            <header className={styles.fieldToolbar}>
              <div className={styles.fieldTabs} role="tablist" aria-label="字段类型">
                <button type="button" id={`${ids}-standard-tab`} role="tab" title="查看当前协议层已解析的字段及含义，例如 IP 地址、端口、版本和长度；点击可定位原始字节" aria-selected={tab === 'standard'} aria-controls={`${ids}-fields`} onClick={() => setTab('standard')}>标准字段</button>
                <button type="button" id={`${ids}-custom-tab`} role="tab" aria-selected={tab === 'custom'} aria-controls={`${ids}-fields`} onClick={() => setTab('custom')}>自定义字段{customFields.length ? ` (${customFields.length})` : ''}</button>
              </div>
              {tab === 'standard' ? <label className={styles.layerFilter}>当前层：<select aria-label="当前协议层" value={activeLayer} disabled={!analysis.layers.length} onChange={(event) => {
                const layer = analysis.layers.find((item) => item.id === event.target.value); if (layer) selectRange(layer, `layer:${analysis.layers.indexOf(layer)}`, layer.id);
              }}>{!analysis.layers.length && <option value="">无</option>}{analysis.layers.map((layer, index) => <option key={index} value={layer.id}>{layerLabel(layer)}</option>)}</select></label>
                : <button type="button" className={styles.outlineButton} disabled={!validRange} onClick={() => openEditor()}>＋ 新增字段</button>}
            </header>
            <div ref={fieldScrollerRef} className={styles.fieldScroller} id={`${ids}-fields`} role="tabpanel" aria-labelledby={`${ids}-${tab}-tab`}>
              {tab === 'standard' ? currentFields.length ? <table className={styles.fieldTable}>
                <thead><tr><th>字段</th><th>偏移</th><th>长度</th><th>值</th></tr></thead>
                <tbody>{currentFields.map(({ field, key }) => <tr key={key} className={selectedField === field ? styles.selectedField : undefined} onClick={() => selectField(field, key)}>
                  <td><button type="button" title={field.summary} onClick={(event) => { event.stopPropagation(); selectField(field, key); }}>{fieldLabel(field)}</button></td>
                  <td><code>{hexOffset(field.offset)}</code></td><td>{field.length} B</td><td title={field.value}>{field.value}</td>
                </tr>)}</tbody>
              </table> : <p className={styles.emptyState}>当前没有标准字段。可在字节视图选择范围并定义字段。</p>
                : <>
                  {editorOpen && <form ref={editorRef} className={styles.customEditor} onSubmit={saveField}>
                    <header><strong>{editingId ? '编辑字段' : '定义选区字段'}</strong><button type="button" onClick={() => setEditorOpen(false)}>取消</button></header>
                    <div className={styles.customForm}>
                      <label>字段名称<input ref={nameRef} aria-label="字段名称" value={draftName} maxLength={80} placeholder="例如：消息类型" onChange={(e) => setDraftName(e.target.value)} /></label>
                      <label>起始偏移（十进制）<input aria-label="字段起始偏移" inputMode="numeric" value={draftOffset} onChange={(e) => setDraftOffset(e.target.value)} /></label>
                      <label>长度（字节）<input aria-label="字段长度" inputMode="numeric" value={draftLength} onChange={(e) => setDraftLength(e.target.value)} /></label>
                      <label>解释方式<select aria-label="字段解释方式" value={draftType} onChange={(e) => setDraftType(e.target.value as CustomFieldType)}>
                        <option value="hex">Hex</option><option value="uint">无符号整数</option><option value="int">有符号整数</option><option value="ascii">ASCII</option><option value="utf8">UTF-8 / 文本</option>{draftType === 'string' && <option value="string">UTF-8 / 文本</option>}
                      </select></label>
                      <label>字节序<select aria-label="字段字节序" disabled={!['uint', 'int'].includes(draftType)} value={draftEndian} onChange={(e) => setDraftEndian(e.target.value as 'big' | 'little')}><option value="big">大端（网络序）</option><option value="little">小端</option></select></label>
                    </div>
                    {customError && <p role="alert" className={styles.inputError}>{customError}</p>}
                    <div className={styles.customActions}><small>偏移从报文第 0 字节开始计算</small><button type="submit" className={styles.primaryButton}>保存字段</button></div>
                  </form>}
                  {customFields.length > 0 ? <table className={`${styles.fieldTable} ${styles.customTable}`}>
                    <thead><tr><th>字段</th><th>偏移 / 长度</th><th>值</th><th>操作</th></tr></thead>
                    <tbody>{customFields.map((field) => {
                      const valid = rangeInPacket(field, analysis.bytes.length);
                      return <tr key={field.id} className={!valid ? styles.invalidField : selectedKey === `custom:${field.id}` ? styles.selectedField : undefined}>
                        <td><button type="button" disabled={!valid} onClick={() => selectRange(field, `custom:${field.id}`)}>{field.name}</button><small>{field.type.toUpperCase()}{['int', 'uint'].includes(field.type) ? ` · ${field.endian === 'big' ? '大端' : '小端'}` : ''}</small></td>
                        <td><code>{hexOffset(field.offset)} / {field.length} B</code></td><td>{customPreviews.get(field.id)}</td>
                        <td><button type="button" onClick={() => { selectRange(field, `custom:${field.id}`); openEditor(field, field); }}>编辑</button><button type="button" className={styles.deleteField} aria-label={`删除字段 ${field.name}`} onClick={() => {
                          persistFields(customFields.filter((item) => item.id !== field.id));
                          if (selectedKey === `custom:${field.id}`) setSelectedKey('bytes');
                          if (editingId === field.id) setEditorOpen(false);
                        }}>删除</button></td>
                      </tr>;
                    })}</tbody>
                  </table> : !editorOpen && <div className={styles.emptyState}>在字节视图中选中范围，然后点击“将选区定义为字段”。<br />已保存字段会保留在本机，可用于后续报文。</div>}
                </>}
            </div>
            <footer className={styles.fieldFootnote}>{tab === 'custom' ? `${customFields.length} 个本机字段 · 字段含义以你的协议文档为准` : currentLayer
              ? `${layerLabel(currentLayer)}${isPayload(currentLayer) ? '' : ' 首部'} ${currentLayer.length} 字节${currentLayer.id === 'udp' ? `，载荷 ${payloadBytes} 字节` : ''}` : '选择协议层查看字段'}</footer>
          </section>
        </div>
      </div>
    </section>
  );
}
