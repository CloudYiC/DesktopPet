import { isNativeHost, requestNativePayload } from './hostBridge';

export interface SerialOptions {
  port: string; baud: number; dataBits: number; parity: number; stopBits: number; flowControl: number; dtr: boolean; rts: boolean;
}
export interface SerialPort { port: string; label: string; }
export interface SerialSnapshot {
  state: 'stopped' | 'opening' | 'open' | 'stopping' | 'error';
  port: string; baud: number; dataBits: number; parity: number; stopBits: number; flowControl: number;
  rxBytes: number; txBytes: number; lastError: string;
}
export interface SerialEvent { id: number; kind: 'rx' | 'tx' | 'status' | 'error'; timestamp: number; dataHex: string; byteLength: number; message: string; }
export interface SerialPoll { snapshot: SerialSnapshot; events: SerialEvent[]; }

/** Never report a simulated open/send success in a normal browser. */
function request<T>(action: string, payload: Record<string, unknown> = {}) {
  if (!isNativeHost) return Promise.reject<T>(new Error('串口需要 Windows 桌面客户端；浏览器无法打开本机 COM 端口。'));
  return requestNativePayload<T>(`serial.${action}`, payload, 12000);
}
export const enumerateSerial = () => request<{ ports: SerialPort[] }>('enumerate');
export const startSerial = (options: SerialOptions) => request<{ snapshot: SerialSnapshot }>('start', { ...options });
export const stopSerial = () => request<{ snapshot: SerialSnapshot }>('stop');
export const sendSerial = (dataHex: string) => request<{ snapshot: SerialSnapshot }>('send', { dataHex });
export const pollSerial = () => request<SerialPoll>('poll');

/** Hex is byte-oriented. Text uses UTF-8 and an explicitly selected line ending. */
export function serialPayload(input: string, mode: 'text' | 'hex', ending: 'none' | 'cr' | 'lf' | 'crlf') {
  let bytes: Uint8Array;
  if (mode === 'hex') {
    const compact = input.replace(/\s/g, '');
    if (!/^(?:[a-fA-F0-9]{2})+$/.test(compact)) throw new Error('Hex 须由完整的两位字节组成，可用空格或换行分隔。');
    if (compact.length > 131072) throw new Error('单次发送不能超过 65536 字节。');
    bytes = Uint8Array.from(compact.match(/../g) ?? [], (value) => parseInt(value, 16));
  } else {
    bytes = new TextEncoder().encode(input + (ending === 'cr' ? '\r' : ending === 'lf' ? '\n' : ending === 'crlf' ? '\r\n' : ''));
  }
  if (!bytes.length) throw new Error('请输入要发送的数据。');
  if (bytes.length > 65536) throw new Error('单次发送不能超过 65536 字节。');
  return { count: bytes.length, hex: Array.from(bytes, (value) => value.toString(16).padStart(2, '0')).join('') };
}
