/** Range checks happen before the native bridge, without rounding user input. */
export function boundedInteger(input: string, minimum: number, maximum: number, label: string): number {
  if (!/^-?\d+$/.test(input.trim())) throw new Error(`${label}必须是完整的十进制整数。`);
  const value = Number(input.trim());
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${label}需要在 ${minimum} 到 ${maximum} 之间。`);
  }
  return value;
}

/** Matches the existing C timestamp core's supported years, 0000 through 9999. */
export function timestampMilliseconds(input: string, unit: string): number {
  if (unit !== 'seconds' && unit !== 'milliseconds') throw new Error('请选择秒或毫秒。');
  if (!/^-?\d+$/.test(input.trim())) throw new Error('时间戳必须是完整的十进制整数。');
  const raw = Number(input.trim());
  const value = unit === 'seconds' ? raw * 1000 : raw;
  if (!Number.isSafeInteger(raw) || !Number.isSafeInteger(value)
      || value < -62167219200000 || value > 253402300799999) {
    throw new Error('时间戳超出支持范围：UTC 年份须为 0000–9999。');
  }
  return value;
}

/** Keep subsecond precision exact, including -1 ms and dates far from the epoch. */
export function unixSecondsText(milliseconds: number): string {
  const absolute = Math.abs(milliseconds);
  const seconds = Math.floor(absolute / 1000);
  const remainder = absolute % 1000;
  const fraction = remainder ? `.${String(remainder).padStart(3, '0').replace(/0+$/, '')}` : '';
  return `${milliseconds < 0 ? '-' : ''}${seconds}${fraction}`;
}

/** A numeric offset is included so daylight-saving and named-zone differences are visible. */
export function localDateText(milliseconds: number): string {
  const date = new Date(milliseconds);
  const pad = (value: number, length = 2) => String(value).padStart(length, '0');
  const offsetMinutes = -date.getTimezoneOffset();
  const offset = `${offsetMinutes >= 0 ? '+' : '-'}${pad(Math.floor(Math.abs(offsetMinutes) / 60))}:${pad(Math.abs(offsetMinutes) % 60)}`;
  return `${pad(date.getFullYear(), 4)}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${pad(date.getMilliseconds(), 3)} UTC${offset}`;
}
