import type { ImageExportFormat } from '../types';
import { detectEdgeColor, type RGB } from './imageBackground';

export const toRgb = (hex: string): RGB => ({ r: parseInt(hex.slice(1, 3), 16), g: parseInt(hex.slice(3, 5), 16), b: parseInt(hex.slice(5, 7), 16) });
export const toHex = (color: RGB) => `#${[color.r, color.g, color.b].map((value) => value.toString(16).padStart(2, '0')).join('')}`;
export function makeCanvas(width: number, height: number) {
  const canvas = document.createElement('canvas');
  canvas.width = width; canvas.height = height;
  const context = canvas.getContext('2d', { willReadFrequently: true });
  if (!context) throw new Error('当前环境无法创建图片画布。');
  context.imageSmoothingEnabled = true; context.imageSmoothingQuality = 'high';
  return { canvas, context };
}
export function estimateBackground(image: HTMLImageElement) {
  const scale = Math.min(1, 128 / Math.max(image.naturalWidth, image.naturalHeight));
  const { canvas, context } = makeCanvas(Math.max(1, Math.round(image.naturalWidth * scale)), Math.max(1, Math.round(image.naturalHeight * scale)));
  context.drawImage(image, 0, 0, canvas.width, canvas.height);
  return detectEdgeColor(context.getImageData(0, 0, canvas.width, canvas.height).data, canvas.width, canvas.height);
}
function roundedSquare(context: CanvasRenderingContext2D, inset: number, radius: number) {
  const edge = 256 - inset;
  context.beginPath(); context.moveTo(inset + radius, inset);
  context.arcTo(edge, inset, edge, edge, radius); context.arcTo(edge, edge, inset, edge, radius);
  context.arcTo(inset, edge, inset, inset, radius); context.arcTo(inset, inset, edge, inset, radius); context.closePath();
}
/** Background processing precedes the existing rotate/flip/encode pipeline. */
export function encodeOutput(input: HTMLCanvasElement, rotation: number, flipHorizontal: boolean, flipVertical: boolean, format: ImageExportFormat, quality: number) {
  const swapped = rotation === 90 || rotation === 270;
  const { canvas, context } = makeCanvas(swapped ? input.height : input.width, swapped ? input.width : input.height);
  // JPEG has no alpha channel; remaining transparency is flattened to white.
  if (format === 'jpeg') { context.fillStyle = '#ffffff'; context.fillRect(0, 0, canvas.width, canvas.height); }
  context.translate(canvas.width / 2, canvas.height / 2); context.rotate(rotation * Math.PI / 180);
  context.scale(flipHorizontal ? -1 : 1, flipVertical ? -1 : 1);
  context.drawImage(input, -input.width / 2, -input.height / 2);
  let outputCanvas = canvas;
  if (format === 'ico') {
    const icon = makeCanvas(256, 256);
    roundedSquare(icon.context, 2, 54); icon.context.fillStyle = '#168b85'; icon.context.fill();
    roundedSquare(icon.context, 13, 45); icon.context.fillStyle = '#fff7eb'; icon.context.fill();
    const scale = Math.min(208 / canvas.width, 208 / canvas.height);
    icon.context.drawImage(canvas, (256 - canvas.width * scale) / 2, (256 - canvas.height * scale) / 2, canvas.width * scale, canvas.height * scale);
    outputCanvas = icon.canvas;
  }
  const mimeType = format === 'ico' ? 'image/png' : `image/${format}`;
  const dataUrl = outputCanvas.toDataURL(mimeType, quality / 100);
  if (!dataUrl.startsWith(`data:${mimeType};base64,`)) throw new Error(`当前 WebView2 无法编码 ${format.toUpperCase()}。`);
  const encoded = dataUrl.slice(dataUrl.indexOf(',') + 1);
  return { dataUrl, width: outputCanvas.width, height: outputCanvas.height, sizeBytes: encoded.length * 3 / 4 - (encoded.endsWith('==') ? 2 : encoded.endsWith('=') ? 1 : 0) };
}
