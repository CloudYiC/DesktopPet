import { detectEdgeColor, replaceBackground } from './imageBackground';
import type { BackgroundOptions, RGB } from './imageBackground';

export interface BackgroundWorkerRequest {
  id: number;
  data: ArrayBuffer;
  width: number;
  height: number;
  options: BackgroundOptions;
}

export type BackgroundWorkerReply = {
  id: number;
  data: ArrayBuffer;
  replacedPixels: number;
  detectedColor: RGB | null;
} | { id: number; error: string };

// The application includes DOM libs, not webworker libs; keep the scope local.
interface BackgroundWorkerScope {
  onmessage: ((event: MessageEvent<BackgroundWorkerRequest>) => void) | null;
  postMessage(message: BackgroundWorkerReply, transfer?: Transferable[]): void;
}

const workerScope = self as unknown as BackgroundWorkerScope;
workerScope.onmessage = (event) => {
  const request = event.data;
  const id = request && Number.isSafeInteger(request.id) ? request.id : 0;
  try {
    if (!request || !Number.isSafeInteger(request.id) || !(request.data instanceof ArrayBuffer)) {
      throw new Error('图片换底任务格式无效。');
    }
    const input = new Uint8ClampedArray(request.data);
    const result = replaceBackground(input, request.width, request.height, request.options);
    const detectedColor = detectEdgeColor(input, request.width, request.height);
    // Detection is informational only; the supplied source colour is never overwritten.
    const buffer = result.data.buffer as ArrayBuffer;
    workerScope.postMessage({ id, data: buffer, replacedPixels: result.replacedPixels, detectedColor }, [buffer]);
  } catch (error) {
    workerScope.postMessage({ id, error: error instanceof Error ? error.message : '图片换底处理失败。' });
  }
};
