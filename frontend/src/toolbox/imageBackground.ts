/** Local, edge-connected colour keying. This is not semantic/person segmentation. */
export type RGB = { r: number; g: number; b: number };

export interface BackgroundOptions {
  mode: 'keep' | 'fill' | 'replace';
  sourceColor: RGB;
  targetColor: RGB | null;
  /** RGB Euclidean distance at which background removal is still complete. */
  tolerance: number;
  /** Additional distance over which removal smoothly falls to zero. */
  feather: number;
}

const MAX_DIMENSION = 4096;
const MAX_EDGE_SAMPLES = 1024;

function validateImage(data: Uint8ClampedArray, width: number, height: number): number {
  if (!Number.isInteger(width) || !Number.isInteger(height)
      || width < 1 || height < 1 || width > MAX_DIMENSION || height > MAX_DIMENSION) {
    throw new Error('图片宽高须为 1 至 4096 的整数。');
  }
  const pixels = width * height;
  if (!(data instanceof Uint8ClampedArray) || data.length !== pixels * 4) {
    throw new Error('图片像素数据长度与宽高不一致。');
  }
  return pixels;
}

function validColor(color: RGB | null): color is RGB {
  return color !== null && typeof color === 'object'
    && [color.r, color.g, color.b].every((value) => Number.isFinite(value) && value >= 0 && value <= 255);
}

function validateOptions(options: BackgroundOptions): void {
  if (!options || !['keep', 'fill', 'replace'].includes(options.mode)
      || !validColor(options.sourceColor)
      || (options.targetColor !== null && !validColor(options.targetColor))
      || !Number.isFinite(options.tolerance) || options.tolerance < 0 || options.tolerance > 150
      || !Number.isFinite(options.feather) || options.feather < 0 || options.feather > 60) {
    throw new Error('换底参数无效：容差范围为 0–150，边缘柔化范围为 0–60。');
  }
}

/** Estimate the dominant visible perimeter colour with a bounded, alpha-weighted sample. */
export function detectEdgeColor(data: Uint8ClampedArray, width: number, height: number): RGB | null {
  validateImage(data, width, height);
  const perimeter = width === 1 ? height : height === 1 ? width : 2 * width + 2 * height - 4;
  const sampleCount = Math.min(perimeter, MAX_EDGE_SAMPLES);
  const bins = new Float64Array(512);
  const samples: number[] = [];

  for (let sample = 0; sample < sampleCount; sample += 1) {
    let edge = Math.floor(sample * perimeter / sampleCount);
    let pixel: number;
    if (width === 1) pixel = edge;
    else if (height === 1) pixel = edge;
    else if (edge < width) pixel = edge;
    else if ((edge -= width) < height - 1) pixel = (edge + 1) * width + width - 1;
    else if ((edge -= height - 1) < width - 1) pixel = (height - 1) * width + width - 2 - edge;
    else {
      edge -= width - 1;
      pixel = (height - 2 - edge) * width;
    }
    const offset = pixel * 4;
    const alpha = data[offset + 3];
    if (alpha === 0) continue;
    const bin = (data[offset] >> 5) * 64 + (data[offset + 1] >> 5) * 8 + (data[offset + 2] >> 5);
    bins[bin] += alpha;
    samples.push(offset);
  }
  if (samples.length === 0) return null;

  let winner = 0;
  for (let bin = 1; bin < bins.length; bin += 1) {
    if (bins[bin] > bins[winner]) winner = bin;
  }
  // Average the winning cluster first, then include nearby samples on quantisation boundaries.
  let red = 0;
  let green = 0;
  let blue = 0;
  let weight = 0;
  for (const offset of samples) {
    const bin = (data[offset] >> 5) * 64 + (data[offset + 1] >> 5) * 8 + (data[offset + 2] >> 5);
    if (bin !== winner) continue;
    const alpha = data[offset + 3];
    red += data[offset] * alpha;
    green += data[offset + 1] * alpha;
    blue += data[offset + 2] * alpha;
    weight += alpha;
  }
  const center = { r: red / weight, g: green / weight, b: blue / weight };
  red = 0;
  green = 0;
  blue = 0;
  weight = 0;
  for (const offset of samples) {
    const dr = data[offset] - center.r;
    const dg = data[offset + 1] - center.g;
    const db = data[offset + 2] - center.b;
    if (dr * dr + dg * dg + db * db > 32 * 32) continue;
    const alpha = data[offset + 3];
    red += data[offset] * alpha;
    green += data[offset + 1] * alpha;
    blue += data[offset + 2] * alpha;
    weight += alpha;
  }
  return { r: Math.round(red / weight), g: Math.round(green / weight), b: Math.round(blue / weight) };
}

/**
 * Return a new RGBA array without changing the input. Background eligibility uses
 * four-neighbour connectivity from every image edge; enclosed same-colour areas
 * are retained. Fully transparent pixels can connect the exterior flood, but
 * their hidden RGB values never classify a visible pixel as background.
 *
 * A colour target is an opaque backing layer beneath the remaining foreground.
 * With a transparent target, original alpha is multiplied by the retained mask.
 * replacedPixels counts keyed visible pixels and pixels filled beneath existing
 * transparency (not merely byte differences, so replacing blue with blue counts).
 */
export function replaceBackground(
  data: Uint8ClampedArray,
  width: number,
  height: number,
  options: BackgroundOptions,
): { data: Uint8ClampedArray; replacedPixels: number } {
  const pixelCount = validateImage(data, width, height);
  validateOptions(options);
  const output = new Uint8ClampedArray(data);
  if (options.mode === 'keep' || (options.mode === 'fill' && options.targetColor === null)) {
    return { data: output, replacedPixels: 0 };
  }

  const source = options.sourceColor;
  const target = options.targetColor;
  const innerSquared = options.tolerance * options.tolerance;
  const outer = options.tolerance + options.feather;
  const outerSquared = outer * outer;
  let connected: Uint8Array | null = null;

  if (options.mode === 'replace') {
    // One byte of state and one bounded queue slot per pixel: O(width * height).
    // 0 = unseen, 1 = rejected, 2 = queued/connected. No recursion or JS object queue.
    const state = new Uint8Array(pixelCount);
    const queue = new Uint32Array(pixelCount);
    let head = 0;
    let tail = 0;
    const offer = (pixel: number) => {
      if (state[pixel] !== 0) return;
      state[pixel] = 1;
      const offset = pixel * 4;
      if (data[offset + 3] !== 0) {
        const dr = data[offset] - source.r;
        const dg = data[offset + 1] - source.g;
        const db = data[offset + 2] - source.b;
        const distance = dr * dr + dg * dg + db * db;
        // At zero feather the tolerance is inclusive; otherwise the outer edge
        // has zero removal and must not bridge two disconnected matching areas.
        if (distance > innerSquared && (options.feather === 0 || distance >= outerSquared)) return;
      }
      state[pixel] = 2;
      queue[tail] = pixel;
      tail += 1;
    };

    for (let x = 0; x < width; x += 1) {
      offer(x);
      if (height > 1) offer((height - 1) * width + x);
    }
    for (let y = 1; y < height - 1; y += 1) {
      offer(y * width);
      if (width > 1) offer(y * width + width - 1);
    }
    while (head < tail) {
      const pixel = queue[head];
      head += 1;
      const x = pixel % width;
      if (x > 0) offer(pixel - 1);
      if (x + 1 < width) offer(pixel + 1);
      if (pixel >= width) offer(pixel - width);
      if (pixel + width < pixelCount) offer(pixel + width);
    }
    connected = state;
  }

  let replacedPixels = 0;
  for (let pixel = 0; pixel < pixelCount; pixel += 1) {
    const offset = pixel * 4;
    const originalAlpha = data[offset + 3];
    let retained = 1;
    if (connected?.[pixel] === 2 && originalAlpha > 0) {
      const dr = data[offset] - source.r;
      const dg = data[offset + 1] - source.g;
      const db = data[offset + 2] - source.b;
      const distance = dr * dr + dg * dg + db * db;
      if (distance <= innerSquared) retained = 0;
      else {
        const transition = Math.max(0, Math.min(1, (Math.sqrt(distance) - options.tolerance) / options.feather));
        retained = transition * transition * (3 - 2 * transition);
      }
    }
    const alpha = originalAlpha / 255 * retained;
    if (retained < 1 || (target !== null && originalAlpha < 255)) replacedPixels += 1;
    if (target !== null) {
      output[offset] = Math.round(data[offset] * alpha + target.r * (1 - alpha));
      output[offset + 1] = Math.round(data[offset + 1] * alpha + target.g * (1 - alpha));
      output[offset + 2] = Math.round(data[offset + 2] * alpha + target.b * (1 - alpha));
      output[offset + 3] = 255;
    } else {
      output[offset + 3] = Math.round(alpha * 255);
    }
  }
  return { data: output, replacedPixels };
}
