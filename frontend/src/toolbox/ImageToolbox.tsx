import { useEffect, useRef, useState, type ChangeEvent, type DragEvent } from 'react';
import { requestImageSave } from '../bridge/hostBridge';
import type { ImageExportFormat } from '../types';
import type { ToolDefinition } from './catalog';
import styles from './ImageToolbox.module.scss';

interface ImageToolboxProps {
  tool: ToolDefinition;
  onBack(): void;
}

interface SourceImage {
  fileName: string;
  baseName: string;
  sizeBytes: number;
  mimeType: string;
  width: number;
  height: number;
  objectUrl: string;
}

function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 ** 2).toFixed(2)} MB`;
}

function loadImage(url: string) {
  return new Promise<HTMLImageElement>((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error('无法解析这张图片。'));
    image.src = url;
  });
}

function fitWithinMaximum(width: number, height: number) {
  const scale = Math.min(1, 4096 / width, 4096 / height);
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

function roundedSquare(context: CanvasRenderingContext2D, inset: number, radius: number) {
  const size = 256 - inset * 2;
  const right = inset + size;
  const bottom = inset + size;
  context.beginPath();
  context.moveTo(inset + radius, inset);
  context.arcTo(right, inset, right, bottom, radius);
  context.arcTo(right, bottom, inset, bottom, radius);
  context.arcTo(inset, bottom, inset, inset, radius);
  context.arcTo(inset, inset, right, inset, radius);
  context.closePath();
}

function renderOutput(
  image: HTMLImageElement,
  width: number,
  height: number,
  rotation: number,
  flipHorizontal: boolean,
  flipVertical: boolean,
  format: ImageExportFormat,
  quality: number,
) {
  const swapped = rotation === 90 || rotation === 270;
  const canvas = document.createElement('canvas');
  canvas.width = swapped ? height : width;
  canvas.height = swapped ? width : height;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('当前环境无法创建图片画布。');
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = 'high';
  if (format === 'jpeg') {
    context.fillStyle = '#fffaf3';
    context.fillRect(0, 0, canvas.width, canvas.height);
  }
  context.translate(canvas.width / 2, canvas.height / 2);
  context.rotate(rotation * Math.PI / 180);
  context.scale(flipHorizontal ? -1 : 1, flipVertical ? -1 : 1);
  context.drawImage(image, -width / 2, -height / 2, width, height);

  let outputCanvas = canvas;
  if (format === 'ico') {
    outputCanvas = document.createElement('canvas');
    outputCanvas.width = 256;
    outputCanvas.height = 256;
    const iconContext = outputCanvas.getContext('2d');
    if (!iconContext) throw new Error('当前环境无法创建图标画布。');
    roundedSquare(iconContext, 2, 54);
    iconContext.fillStyle = '#168b85';
    iconContext.fill();
    roundedSquare(iconContext, 13, 45);
    iconContext.fillStyle = '#fff7eb';
    iconContext.fill();
    const scale = Math.min(208 / canvas.width, 208 / canvas.height);
    const targetWidth = canvas.width * scale;
    const targetHeight = canvas.height * scale;
    iconContext.drawImage(
      canvas,
      (256 - targetWidth) / 2,
      (256 - targetHeight) / 2,
      targetWidth,
      targetHeight,
    );
  }

  const mimeType = format === 'ico' ? 'image/png' : `image/${format}`;
  const dataUrl = outputCanvas.toDataURL(mimeType, quality / 100);
  if (!dataUrl.startsWith(`data:${mimeType};base64,`)) {
    throw new Error(`当前 WebView2 无法编码 ${format.toUpperCase()}。`);
  }
  return {
    dataUrl,
    width: outputCanvas.width,
    height: outputCanvas.height,
    sizeBytes: Math.floor(dataUrl.slice(dataUrl.indexOf(',') + 1).length * 0.75),
  };
}

/** Local image converter: browser codecs render; native C/C++11 saves safely. */
export function ImageToolbox({ tool, onBack }: ImageToolboxProps) {
  const fileInput = useRef<HTMLInputElement>(null);
  const imageElement = useRef<HTMLImageElement | null>(null);
  const [source, setSource] = useState<SourceImage | null>(null);
  const [width, setWidth] = useState(0);
  const [height, setHeight] = useState(0);
  const [keepAspect, setKeepAspect] = useState(true);
  const [rotation, setRotation] = useState(0);
  const [flipHorizontal, setFlipHorizontal] = useState(false);
  const [flipVertical, setFlipVertical] = useState(false);
  const [format, setFormat] = useState<ImageExportFormat>('png');
  const [quality, setQuality] = useState(88);
  const [output, setOutput] = useState<ReturnType<typeof renderOutput> | null>(null);
  const [busy, setBusy] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');

  useEffect(() => () => {
    if (source) URL.revokeObjectURL(source.objectUrl);
  }, [source]);

  useEffect(() => {
    if (!source || !imageElement.current || width < 1 || height < 1) {
      setOutput(null);
      return;
    }
    const timer = window.setTimeout(() => {
      try {
        setOutput(renderOutput(
          imageElement.current!, width, height, rotation,
          flipHorizontal, flipVertical, format, quality,
        ));
        setError('');
      } catch (renderError) {
        setOutput(null);
        setError(renderError instanceof Error ? renderError.message : '图片转换失败。');
      }
    }, 90);
    return () => window.clearTimeout(timer);
  }, [flipHorizontal, flipVertical, format, height, quality, rotation, source, width]);

  const selectFile = async (file: File | undefined) => {
    if (!file) return;
    setMessage('');
    setError('');
    if (!file.type.startsWith('image/')) {
      setError('请选择 PNG、JPEG、WebP、BMP 或 GIF 图片。');
      return;
    }
    if (file.size > 20 * 1024 * 1024) {
      setError('单张原图不能超过 20 MB。');
      return;
    }
    const objectUrl = URL.createObjectURL(file);
    try {
      const image = await loadImage(objectUrl);
      if (image.naturalWidth * image.naturalHeight > 60_000_000) {
        throw new Error('图片像素超过 6000 万，请先缩小后再处理。');
      }
      if (source) URL.revokeObjectURL(source.objectUrl);
      imageElement.current = image;
      const baseName = file.name.replace(/\.[^.]+$/, '') || 'converted-image';
      setSource({
        fileName: file.name,
        baseName,
        sizeBytes: file.size,
        mimeType: file.type || 'image/unknown',
        width: image.naturalWidth,
        height: image.naturalHeight,
        objectUrl,
      });
      const initialSize = fitWithinMaximum(image.naturalWidth, image.naturalHeight);
      setWidth(initialSize.width);
      setHeight(initialSize.height);
      setRotation(0);
      setFlipHorizontal(false);
      setFlipVertical(false);
      setMessage('图片已载入，所有处理都在本机完成。');
    } catch (loadError) {
      URL.revokeObjectURL(objectUrl);
      setError(loadError instanceof Error ? loadError.message : '图片读取失败。');
    }
  };

  const updateWidth = (value: number) => {
    let nextWidth = Math.max(1, Math.min(4096, Math.round(value || 1)));
    if (keepAspect && source) {
      let nextHeight = Math.max(1, Math.round(nextWidth * source.height / source.width));
      if (nextHeight > 4096) {
        nextHeight = 4096;
        nextWidth = Math.max(1, Math.round(nextHeight * source.width / source.height));
      }
      setHeight(nextHeight);
    }
    setWidth(nextWidth);
  };

  const updateHeight = (value: number) => {
    let nextHeight = Math.max(1, Math.min(4096, Math.round(value || 1)));
    if (keepAspect && source) {
      let nextWidth = Math.max(1, Math.round(nextHeight * source.width / source.height));
      if (nextWidth > 4096) {
        nextWidth = 4096;
        nextHeight = Math.max(1, Math.round(nextWidth * source.height / source.width));
      }
      setWidth(nextWidth);
    }
    setHeight(nextHeight);
  };

  const save = async () => {
    if (!source || !output) return;
    setBusy(true);
    setError('');
    setMessage('');
    try {
      const result = await requestImageSave(output.dataUrl, format, `${source.baseName}-converted`);
      if (!result.cancelled) {
        setMessage(`已保存：${result.path} · ${formatBytes(result.sizeBytes)}`);
      }
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : '图片保存失败。');
    } finally {
      setBusy(false);
    }
  };

  const reset = () => {
    if (!source) return;
    const initialSize = fitWithinMaximum(source.width, source.height);
    setWidth(initialSize.width);
    setHeight(initialSize.height);
    setRotation(0);
    setFlipHorizontal(false);
    setFlipVertical(false);
    setQuality(88);
  };

  return (
    <section className={styles.imageToolbox}>
      <header className={styles.workspaceHeader}>
        <button type="button" onClick={onBack}>← 返回工具列表</button>
        <div><i>{tool.glyph}</i><span><small>LOCAL CANVAS · NATIVE SAVE</small><strong>{tool.name}</strong><em>{tool.description}</em></span></div>
      </header>

      {!source ? (
        <div
          className={`${styles.dropZone} ${dragging ? styles.dropActive : ''}`}
          onDragEnter={(event) => { event.preventDefault(); setDragging(true); }}
          onDragOver={(event) => event.preventDefault()}
          onDragLeave={() => setDragging(false)}
          onDrop={(event: DragEvent) => {
            event.preventDefault();
            setDragging(false);
            void selectFile(event.dataTransfer.files[0]);
          }}
        >
          <i>IMG</i><span>IMAGE WORKSPACE</span>
          <h2>把图片放进来，在本机完成转换。</h2>
          <p>支持 PNG、JPEG、WebP、BMP 和 GIF 输入，原图不会被覆盖。</p>
          <button type="button" onClick={() => fileInput.current?.click()}>选择图片</button>
          <input ref={fileInput} hidden type="file" accept="image/png,image/jpeg,image/webp,image/bmp,image/gif" onChange={(event: ChangeEvent<HTMLInputElement>) => { void selectFile(event.target.files?.[0]); event.target.value = ''; }} />
        </div>
      ) : (
        <>
          <div className={styles.sourceBar}>
            <div><i>IMG</i><span><strong>{source.fileName}</strong><small>{source.width} × {source.height} · {formatBytes(source.sizeBytes)} · {source.mimeType}</small></span></div>
            <button type="button" onClick={() => fileInput.current?.click()}>更换图片</button>
            <input ref={fileInput} hidden type="file" accept="image/png,image/jpeg,image/webp,image/bmp,image/gif" onChange={(event) => { void selectFile(event.target.files?.[0]); event.target.value = ''; }} />
          </div>

          <div className={styles.editorGrid}>
            <aside className={styles.controls}>
              <section><span>OUTPUT FORMAT</span><h3>输出格式</h3><div className={styles.formatGrid}>{(['png', 'jpeg', 'webp', 'ico'] as ImageExportFormat[]).map((item) => <button key={item} type="button" className={format === item ? styles.selected : undefined} onClick={() => setFormat(item)}>{item === 'jpeg' ? 'JPG' : item.toUpperCase()}</button>)}</div>{format === 'ico' && <small>ICO 固定生成 256 × 256 图标。</small>}</section>
              <section><span>RESIZE</span><h3>尺寸</h3><div className={styles.sizeInputs}><label>宽度<input type="number" min="1" max="4096" value={width} disabled={format === 'ico'} onChange={(event) => updateWidth(Number(event.target.value))} /></label><button type="button" className={keepAspect ? styles.locked : undefined} onClick={() => setKeepAspect((value) => !value)} title="保持比例">{keepAspect ? '🔗' : '—'}</button><label>高度<input type="number" min="1" max="4096" value={height} disabled={format === 'ico'} onChange={(event) => updateHeight(Number(event.target.value))} /></label></div></section>
              <section><span>TRANSFORM</span><h3>方向与翻转</h3><div className={styles.rotationGrid}>{[0, 90, 180, 270].map((angle) => <button key={angle} type="button" className={rotation === angle ? styles.selected : undefined} onClick={() => setRotation(angle)}>{angle}°</button>)}</div><div className={styles.flipGrid}><button type="button" className={flipHorizontal ? styles.selected : undefined} onClick={() => setFlipHorizontal((value) => !value)}>↔ 水平</button><button type="button" className={flipVertical ? styles.selected : undefined} onClick={() => setFlipVertical((value) => !value)}>↕ 垂直</button></div></section>
              {(format === 'jpeg' || format === 'webp') && <section><span>QUALITY</span><h3>压缩质量 <em>{quality}%</em></h3><input className={styles.qualityRange} type="range" min="20" max="100" value={quality} onChange={(event) => setQuality(Number(event.target.value))} /></section>}
              <button type="button" className={styles.resetButton} onClick={reset}>恢复原始设置</button>
            </aside>

            <main className={styles.previewPane}>
              <div className={styles.previewHeading}><div><span>LIVE PREVIEW</span><h2>转换预览</h2></div>{output && <p>{output.width} × {output.height} · 约 {formatBytes(output.sizeBytes)}</p>}</div>
              <div className={styles.previews}><figure><div><img src={source.objectUrl} alt="原图预览" /></div><figcaption>原图</figcaption></figure><figure><div>{output ? <img src={output.dataUrl} alt="转换结果预览" /> : <span>正在生成…</span>}</div><figcaption>{format.toUpperCase()} 输出</figcaption></figure></div>
              {error && <p className={styles.error}>{error}</p>}
              {message && <p className={styles.message}>{message}</p>}
              <div className={styles.saveBar}><span>原图始终保留；保存时可选择新的位置和文件名。</span><button type="button" disabled={!output || busy} onClick={() => void save()}>{busy ? '正在保存…' : '转换并保存'}</button></div>
            </main>
          </div>
        </>
      )}
      {!source && error && <p className={styles.error}>{error}</p>}
    </section>
  );
}
