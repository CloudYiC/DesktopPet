import { isNativeHost, requestNativePayload } from './hostBridge';

export interface ModbusConnection {
  transport: 'tcp' | 'rtu'; host: string; port: number; serialPort: string;
  baudRate: number; dataBits: 8; parity: 'none' | 'even' | 'odd'; stopBits: 1 | 2;
  unitId: number; timeoutMs: number; retries: number;
}
export interface ModbusRequest { functionCode: number; address: number; quantity: number; values?: number[]; confirmed?: boolean }
export interface ModbusResult { id: number; functionCode: number; address: number; quantity: number; values: number[]; timestamp: number; elapsedMs: number; written: boolean }
export interface ModbusSnapshot { state: 'stopped' | 'connecting' | 'connected' | 'stopping' | 'error'; transport: 'tcp' | 'rtu'; endpoint?: string; unitId?: number; pending: boolean; error: string; result: ModbusResult | null }
export interface ModbusLog { id: number; timestamp: number; direction: 'TX' | 'RX' | 'INFO'; hex: string; message: string }
export interface ModbusPoll { snapshot: ModbusSnapshot; logs?: ModbusLog[] }

/** No browser simulation: device access only happens through the native worker. */
export function modbusCall<T>(action: string, payload: object = {}): Promise<T> {
  if (!isNativeHost) return Promise.reject(new Error('Modbus 设备通信仅在 Windows 客户端提供；网页不会模拟连接成功。'));
  return requestNativePayload<T>(`modbus.${action}`, { ...payload }, 5000);
}
export const modbusFunctions = [
  [1, '01 · 读取线圈'], [2, '02 · 读取离散输入'], [3, '03 · 读取保持寄存器'], [4, '04 · 读取输入寄存器'],
  [5, '05 · 写单线圈'], [6, '06 · 写单寄存器'], [15, '15 · 写多个线圈'], [16, '16 · 写多个寄存器'],
] as const;
export const isModbusWrite = (code: number) => [5, 6, 15, 16].includes(code);
export const modbusQuantityLimit = (code: number) => code <= 2 ? 2000 : code <= 4 ? 125 : [5, 6].includes(code) ? 1 : code === 15 ? 1968 : 123;

/** Traditional five-digit references are a display convention, not PDU bytes.
 * Addresses beyond its 9999-item range remain unambiguous zero-based addresses. */
export function modbusReference(code: number, address: number): string {
  if (!Number.isInteger(address) || address < 0 || address > 9998) return '—（超出五位参考编号）';
  const prefix = [1, 5, 15].includes(code) ? '0' : code === 2 ? '1' : code === 4 ? '3' : '4';
  return prefix + String(address + 1).padStart(4, '0');
}
export function modbusProtocolAddress(code: number, reference: string): number {
  const prefix = [1, 5, 15].includes(code) ? '0' : code === 2 ? '1' : code === 4 ? '3' : '4';
  if (!new RegExp(`^${prefix}\\d{4}$`).test(reference) || Number(reference.slice(1)) < 1)
    throw new Error(`该功能的五位参考编号必须为 ${prefix}0001–${prefix}9999。`);
  return Number(reference.slice(1)) - 1;
}
