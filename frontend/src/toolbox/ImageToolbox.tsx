import { useEffect, useRef, useState, type DragEvent, type MouseEvent } from 'react';
import { requestImageSave } from '../bridge/hostBridge';
import type { ImageExportFormat } from '../types';
import type { ToolDefinition } from './catalog';
import { ToolWorkspaceHeader } from '../../../shared/tool-workspace/ToolWorkspaceHeader';
import type { BackgroundOptions } from './imageBackground';
import { encodeOutput, estimateBackground, makeCanvas, toHex, toRgb } from './imageRendering';
import styles from './ImageToolbox.module.scss';

interface SourceImage {
  fileName: string; baseName: string; sizeBytes: number;
  width: number; height: number; objectUrl: string;
}
interface RenderedImage { dataUrl: string; width: number; height: number; sizeBytes: number; key: string; replacedPixels: number }
const COLORS = [{ label: '白色', value: '#ffffff' }, { label: '蓝色', value: '#438edb' }, { label: '红色', value: '#d84645' }, { label: '透明', value: 'transparent' }];
const formatBytes = (bytes: number) => bytes < 1024 ? `${bytes} B` : bytes < 1024 ** 2 ? `${(bytes / 1024).toFixed(1)} KB` : `${(bytes / 1024 ** 2).toFixed(2)} MB`;
function loadImage(url: string) {
  return new Promise<HTMLImageElement>((resolve, reject) => {
    const image = new Image(); image.onload = () => resolve(image);
    image.onerror = () => reject(new Error('无法解析这张图片。')); image.src = url;
  });
}
function fitWithinMaximum(width: number, height: number) {
  const scale = Math.min(1, 4096 / width, 4096 / height);
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

/** Local image processing; native C/C++11 retains the save/overwrite boundary. */
export function ImageToolbox({ tool, onBack }: { tool: ToolDefinition; onBack(): void }) {
  const fileInput = useRef<HTMLInputElement>(null);
  const imageElement = useRef<HTMLImageElement | null>(null);
  const loadSequence = useRef(0);
  const [source, setSource] = useState<SourceImage | null>(null);
  const [width, setWidth] = useState(0); const [height, setHeight] = useState(0);
  const [keepAspect, setKeepAspect] = useState(true); const [rotation, setRotation] = useState(0);
  const [flipHorizontal, setFlipHorizontal] = useState(false); const [flipVertical, setFlipVertical] = useState(false);
  const [format, setFormat] = useState<ImageExportFormat>('png'); const [quality, setQuality] = useState(88);
  const [mode, setMode] = useState<BackgroundOptions['mode']>('keep');
  const [sourceColor, setSourceColor] = useState('#438edb'); const [targetColor, setTargetColor] = useState('#ffffff');
  const [tolerance, setTolerance] = useState(40); const [feather, setFeather] = useState(12);
  const [picking, setPicking] = useState(false); const [compareView, setCompareView] = useState(true);
  const [output, setOutput] = useState<RenderedImage | null>(null);
  const [busy, setBusy] = useState(false); const [loading, setLoading] = useState(false); const [dragging, setDragging] = useState(false);
  const [message, setMessage] = useState(''); const [error, setError] = useState(''); const [renderError, setRenderError] = useState('');
  // Saving requires the exact current settings snapshot, not a stale debounced preview.
  const renderKey = JSON.stringify([source?.objectUrl, width, height, rotation, flipHorizontal, flipVertical, format, quality, mode, sourceColor, targetColor, tolerance, feather]);
  const currentOutput = output?.key === renderKey ? output : null;

  useEffect(() => () => { loadSequence.current += 1; }, []);
  useEffect(() => () => { if (source) URL.revokeObjectURL(source.objectUrl); }, [source]);
  useEffect(() => {
    if (!source || !imageElement.current || width < 1 || height < 1) return;
    let cancelled = false; let worker: Worker | undefined;
    setRenderError(''); setMessage('');
    const timer = window.setTimeout(() => {
      try {
        const { canvas, context } = makeCanvas(width, height);
        context.drawImage(imageElement.current!, 0, 0, width, height);
        const finish = (replacedPixels: number) => {
          if (cancelled) return;
          try { setOutput({ ...encodeOutput(canvas, rotation, flipHorizontal, flipVertical, format, quality), key: renderKey, replacedPixels }); }
          catch (reason) { setRenderError(reason instanceof Error ? reason.message : '图片转换失败。'); }
          worker?.terminate();
        };
        if (mode === 'keep') { finish(0); return; }
        // Scanning runs off-thread. Cancelling edits terminates stale workers;
        // transferred buffers avoid unnecessary copies of full-sized pixels.
        worker = new Worker(new URL('./imageBackground.worker.ts', import.meta.url), { type: 'module' });
        worker.onmessage = (event: MessageEvent<{ id: number; data?: ArrayBuffer; replacedPixels?: number; error?: string }>) => {
          if (cancelled) return;
          if (event.data.error || !event.data.data) { setRenderError(event.data.error || '背景处理失败。'); worker?.terminate(); return; }
          try { context.putImageData(new ImageData(new Uint8ClampedArray(event.data.data), width, height), 0, 0); finish(event.data.replacedPixels ?? 0); }
          catch (reason) { setRenderError(reason instanceof Error ? reason.message : '背景处理失败。'); worker?.terminate(); }
        };
        worker.onerror = (event) => { event.preventDefault(); if (!cancelled) setRenderError('背景处理未完成，请减小图片尺寸后重试。'); worker?.terminate(); };
        const pixels = context.getImageData(0, 0, width, height);
        const options: BackgroundOptions = { mode, sourceColor: toRgb(sourceColor), targetColor: targetColor === 'transparent' ? null : toRgb(targetColor), tolerance, feather };
        worker.postMessage({ id: 1, data: pixels.data.buffer, width, height, options }, [pixels.data.buffer]);
      } catch (reason) { if (!cancelled) setRenderError(reason instanceof Error ? reason.message : '图片处理失败。'); worker?.terminate(); }
    }, 140);
    return () => { cancelled = true; window.clearTimeout(timer); worker?.terminate(); };
  }, [renderKey, source, width, height, rotation, flipHorizontal, flipVertical, format, quality, mode, sourceColor, targetColor, tolerance, feather]);

  async function selectFile(file: File | undefined) {
    if (!file) return;
    const sequence = ++loadSequence.current;
    setLoading(false); setMessage(''); setError(''); setPicking(false);
    if (!file.type.startsWith('image/')) { setError('请选择 PNG、JPEG、WebP、BMP 或 GIF 图片。'); return; }
    if (file.size > 20 * 1024 * 1024) { setError('单张原图不能超过 20 MB。'); return; }
    const objectUrl = URL.createObjectURL(file); setLoading(true);
    try {
      const image = await loadImage(objectUrl);
      if (sequence !== loadSequence.current) { URL.revokeObjectURL(objectUrl); return; }
      if (image.naturalWidth * image.naturalHeight > 60_000_000) throw new Error('图片像素超过 6000 万，请先缩小后再处理。');
      const estimated = estimateBackground(image); imageElement.current = image;
      setSource({ fileName: file.name, baseName: file.name.replace(/\.[^.]+$/, '') || 'converted-image', sizeBytes: file.size, width: image.naturalWidth, height: image.naturalHeight, objectUrl });
      const size = fitWithinMaximum(image.naturalWidth, image.naturalHeight);
      setWidth(size.width); setHeight(size.height); setKeepAspect(true); setRotation(0); setFlipHorizontal(false); setFlipVertical(false);
      setMode('keep'); setSourceColor(estimated ? toHex(estimated) : '#438edb'); setTargetColor('#ffffff'); setTolerance(40); setFeather(12); setOutput(null);
    } catch (reason) { URL.revokeObjectURL(objectUrl); if (sequence === loadSequence.current) setError(reason instanceof Error ? reason.message : '图片读取失败。'); }
    finally { if (sequence === loadSequence.current) setLoading(false); }
  }
  function updateSize(value: number, dimension: 'width' | 'height') {
    let next = Math.max(1, Math.min(4096, Math.round(value || 1)));
    if (keepAspect && source) {
      const ratio = dimension === 'width' ? source.height / source.width : source.width / source.height;
      const other = Math.max(1, Math.min(4096, Math.round(next * ratio)));
      if (next * ratio > 4096) next = Math.max(1, Math.round(other / ratio));
      if (dimension === 'width') setHeight(other); else setWidth(other);
    }
    if (dimension === 'width') setWidth(next); else setHeight(next);
  }
  function toggleAspect() {
    if (!keepAspect && source) { const size = fitWithinMaximum(width, Math.max(1, Math.round(width * source.height / source.width))); setWidth(size.width); setHeight(size.height); }
    setKeepAspect(!keepAspect);
  }
  function reset() {
    if (!source) return;
    const size = fitWithinMaximum(source.width, source.height);
    setWidth(size.width); setHeight(size.height); setKeepAspect(true); setRotation(0); setFlipHorizontal(false); setFlipVertical(false);
    setQuality(88); setMode('keep'); setTargetColor('#ffffff'); setTolerance(40); setFeather(12); setPicking(false); setError(''); setMessage('');
  }
  function autoPick() {
    if (!imageElement.current) return;
    const color = estimateBackground(imageElement.current);
    if (color) { setSourceColor(toHex(color)); setMessage('已根据图片边缘估计背景色，请检查预览。'); }
    else setMessage('图片边缘为透明区域，可使用“填充透明区域”。');
  }
  function pickColor(event: MouseEvent<HTMLImageElement>) {
    if (!picking || !imageElement.current) return;
    const image = imageElement.current; const rect = event.currentTarget.getBoundingClientRect();
    const scale = Math.min(rect.width / image.naturalWidth, rect.height / image.naturalHeight);
    const x = (event.clientX - rect.left - (rect.width - image.naturalWidth * scale) / 2) / scale;
    const y = (event.clientY - rect.top - (rect.height - image.naturalHeight * scale) / 2) / scale;
    if (x < 0 || y < 0 || x >= image.naturalWidth || y >= image.naturalHeight) return;
    const { context } = makeCanvas(1, 1);
    context.drawImage(image, Math.floor(x), Math.floor(y), 1, 1, 0, 0, 1, 1);
    const pixel = context.getImageData(0, 0, 1, 1).data;
    if (pixel[3] < 16) { setMessage('此处是透明像素，请选取有底色的位置。'); return; }
    setSourceColor(toHex({ r: pixel[0], g: pixel[1], b: pixel[2] })); setPicking(false);
  }
  async function save() {
    if (!source || !currentOutput || loading || busy) return;
    setBusy(true); setError(''); setMessage('');
    try { const result = await requestImageSave(currentOutput.dataUrl, format, `${source.baseName}-converted`); if (!result.cancelled) setMessage(`已保存：${result.path} · ${formatBytes(result.sizeBytes)}`); }
    catch (reason) { setError(reason instanceof Error ? reason.message : '图片保存失败。'); } finally { setBusy(false); }
  }

  return <section className={`${styles.imageToolbox} ${source ? styles.loaded : ''}`}>
    <ToolWorkspaceHeader title={tool.name} onBack={onBack} />
    <input ref={fileInput} hidden type="file" accept="image/png,image/jpeg,image/webp,image/bmp,image/gif" onChange={(event) => { void selectFile(event.target.files?.[0]); event.target.value = ''; }} />
    {!source ? <div className={`${styles.dropZone} ${dragging ? styles.dropActive : ''}`}
      onDragEnter={(event) => { event.preventDefault(); setDragging(true); }} onDragOver={(event) => event.preventDefault()} onDragLeave={() => setDragging(false)}
      onDrop={(event: DragEvent) => { event.preventDefault(); setDragging(false); void selectFile(event.dataTransfer.files[0]); }}>
      <i>IMG</i><h2>选择一张图片</h2><p>本地缩放、纯色换底与格式转换，原图不会被覆盖。</p>
      <button type="button" disabled={loading} onClick={() => fileInput.current?.click()}>{loading ? '正在载入…' : '选择图片'}</button><small>PNG / JPG / WebP / BMP / GIF · 最大 20 MB</small>
      {error && <p role="alert" className={styles.error}>{error}</p>}
    </div> : <>
      <div className={styles.sourceBar}><div><i>IMG</i><span><strong title={source.fileName}>{source.fileName}</strong><small>{source.width} × {source.height} px · {formatBytes(source.sizeBytes)}</small></span></div><button type="button" disabled={busy} onClick={() => fileInput.current?.click()}>{loading ? '正在载入…' : '更换图片'}</button></div>
      <div className={styles.editorGrid}>
        <aside className={styles.controls} aria-label="图片设置" data-testid="image-controls"><fieldset disabled={busy || loading}>
          <section><h3>输出格式</h3><div className={styles.formatGrid}>{(['png', 'jpeg', 'webp', 'ico'] as ImageExportFormat[]).map((item) => <button key={item} type="button" aria-pressed={format === item} className={format === item ? styles.selected : ''} onClick={() => setFormat(item)}>{item === 'jpeg' ? 'JPG' : item.toUpperCase()}</button>)}</div>{format === 'ico' && <small>ICO 为 256 × 256，保留现有圆角图标底板。</small>}</section>
          <section><h3>背景换色</h3>
            <label className={styles.modeLabel}>背景处理<select value={mode} onChange={(event) => { setMode(event.target.value as BackgroundOptions['mode']); setPicking(false); }}><option value="keep">保留原背景</option><option value="replace">替换纯色背景</option><option value="fill">填充透明区域</option></select></label>
            {mode !== 'keep' && <><span className={styles.controlLabel}>目标背景</span><div className={styles.colorPresets}>{COLORS.map((color) => <button key={color.value} type="button" aria-pressed={targetColor === color.value} className={targetColor === color.value ? styles.selected : ''} onClick={() => setTargetColor(color.value)}><i style={{ background: color.value === 'transparent' ? undefined : color.value }} className={color.value === 'transparent' ? styles.checker : ''} />{color.label}</button>)}</div><label className={styles.colorInput}>自定义颜色<input type="color" aria-label="自定义背景色" value={targetColor === 'transparent' ? '#ffffff' : targetColor} onChange={(event) => setTargetColor(event.target.value)} /><code>{targetColor === 'transparent' ? '透明' : targetColor.toUpperCase()}</code></label></>}
            {mode === 'replace' && <>
              <label className={styles.colorInput}>原背景色<input type="color" aria-label="原背景色" value={sourceColor} onChange={(event) => setSourceColor(event.target.value)} /><code>{sourceColor.toUpperCase()}</code></label>
              <div className={styles.pickActions}><button type="button" aria-pressed={picking} onClick={() => { setPicking(!picking); setCompareView(true); }}>从原图取色</button><button type="button" onClick={autoPick}>自动取色</button></div>
              <label className={styles.rangeLabel}><span>颜色容差 <output>{tolerance}</output></span><input aria-label="颜色容差" type="range" min="0" max="150" value={tolerance} onChange={(event) => setTolerance(Number(event.target.value))} /></label>
              <label className={styles.rangeLabel}><span>边缘柔化 <output>{feather}</output></span><input aria-label="边缘柔化" type="range" min="0" max="60" value={feather} onChange={(event) => setFeather(Number(event.target.value))} /></label>
              <small>仅处理与边缘相连的近似纯色。衣服与底色相近时请减小容差；复杂背景、发丝边缘仍需检查。</small>
            </>}
            {mode === 'fill' && <small>只填充已有透明区域，不会去除照片中已有的底色。</small>}
            {format === 'jpeg' && <small>JPG 不支持透明，剩余透明区域会合成到白色背景。</small>}
          </section>
          <section><h3>像素尺寸</h3><div className={styles.sizeInputs}><label>宽度<input type="number" min="1" max="4096" value={width} disabled={format === 'ico'} onChange={(event) => updateSize(Number(event.target.value), 'width')} /></label><button type="button" aria-label="保持比例" aria-pressed={keepAspect} className={keepAspect ? styles.locked : ''} onClick={toggleAspect} title="保持比例">{keepAspect ? '🔗' : '—'}</button><label>高度<input type="number" min="1" max="4096" value={height} disabled={format === 'ico'} onChange={(event) => updateSize(Number(event.target.value), 'height')} /></label></div>
            <small>{keepAspect ? '等比缩放，不裁剪。' : '比例已解锁，宽高独立调整可能使图像变形。'} 一寸／二寸还需匹配证件照比例与打印分辨率，此处不提供裁剪或 DPI 设置。</small>
          </section>
          <section><h3>方向与翻转</h3><div className={styles.rotationGrid}>{[0, 90, 180, 270].map((angle) => <button key={angle} type="button" aria-pressed={rotation === angle} className={rotation === angle ? styles.selected : ''} onClick={() => setRotation(angle)}>{angle}°</button>)}</div><div className={styles.flipGrid}><button type="button" aria-pressed={flipHorizontal} className={flipHorizontal ? styles.selected : ''} onClick={() => setFlipHorizontal(!flipHorizontal)}>↔ 水平</button><button type="button" aria-pressed={flipVertical} className={flipVertical ? styles.selected : ''} onClick={() => setFlipVertical(!flipVertical)}>↕ 垂直</button></div></section>
          {(format === 'jpeg' || format === 'webp') && <section><h3>压缩质量 <em>{quality}%</em></h3><input aria-label="压缩质量" className={styles.qualityRange} type="range" min="20" max="100" value={quality} onChange={(event) => setQuality(Number(event.target.value))} /></section>}
          <button type="button" className={styles.resetButton} onClick={reset}>恢复原始设置</button>
        </fieldset></aside>
        <section className={styles.previewPane} aria-label="图片预览" data-testid="image-preview">
          <div className={styles.previewHeading}><h2>转换预览</h2><div><button type="button" aria-pressed={compareView} onClick={() => setCompareView(true)}>并排对照</button><button type="button" aria-pressed={!compareView} onClick={() => { setCompareView(false); setPicking(false); }}>只看结果</button></div></div>
          <p className={styles.outputMeta}>{currentOutput ? `${currentOutput.width} × ${currentOutput.height} px · ${format === 'jpeg' ? 'JPG' : format.toUpperCase()} · 约 ${formatBytes(currentOutput.sizeBytes)}` : renderError ? '预览生成失败' : '正在生成预览…'}</p>
          <div className={`${styles.previews} ${compareView ? '' : styles.resultOnly}`}>
            {compareView && <figure><div className={`${styles.imageStage} ${picking ? styles.picking : ''}`}><img src={source.objectUrl} alt="原图预览" draggable={false} onClick={pickColor} /></div><figcaption>原图 <small>始终保留</small></figcaption></figure>}
            <figure><div className={styles.imageStage}>{currentOutput ? <img src={currentOutput.dataUrl} alt="转换结果预览" /> : <span>{renderError ? '请调整设置后重试' : '正在生成…'}</span>}</div><figcaption>处理结果 <small>{mode === 'replace' ? '纯色换底' : mode === 'fill' ? '透明区填色' : '保留背景'}</small></figcaption></figure>
          </div>
          <div className={styles.statusArea} aria-live="polite">
            {picking && <p className={styles.message}>请点击左侧原图中的背景位置取色。</p>}
            {(error || renderError) && <p role="alert" className={styles.error}>{error || renderError}</p>}
            {message && <p className={styles.message}>{message}</p>}
            {mode === 'replace' && currentOutput?.replacedPixels === 0 && <p className={styles.message}>未找到与边缘相连的匹配底色，请重新取色或调整容差。</p>}
          </div>
          <div className={styles.saveBar}><span>本机处理 · 原图不覆盖<br />保存前请检查人物和发丝边缘。</span><button type="button" disabled={!currentOutput || busy || loading} onClick={() => void save()}>{busy ? '正在保存…' : '转换并保存'}</button></div>
        </section>
      </div>
    </>}
  </section>;
}
