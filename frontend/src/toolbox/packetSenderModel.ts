/** Pure packet authoring/library model. It deliberately performs no I/O or sends. */
export type PacketProtocol = 'udp' | 'tcp';
export type PacketDataMode = 'text' | 'hex' | 'escaped';
export type PacketNetworkMode = 'tcp-client' | 'tcp-server' | 'udp';
export type PacketLineEnding = 'none' | 'lf' | 'crlf';

export interface PacketSenderDraft {
  name: string;
  protocol: PacketProtocol;
  /** Optional in schema-1 libraries written before the unified network workspace. */
  networkMode?: PacketNetworkMode;
  lineEnding?: PacketLineEnding;
  host: string;
  port: number;
  localAddress: string;
  localPort: number;
  dataMode: PacketDataMode;
  payload: string;
  intervalMs: number;
  repeatCount: number;
  multicastTtl: number;
}

export interface EncodedPacketPayload {
  bytes: Uint8Array;
  /** Compact lowercase byte pairs, ready for the existing native bridge. */
  hex: string;
  escaped: string;
  byteCount: number;
  /** null means the bytes are not valid UTF-8; never a replacement-character preview. */
  text: string | null;
}

export interface SavedPacket extends PacketSenderDraft {
  id: string;
  updatedAt: string;
}

export interface PacketLibrary {
  schemaVersion: 1;
  packets: SavedPacket[];
}

export const PACKET_LIBRARY_STORAGE_KEY = 'cloudyi.packet-sender.library.v1';
export const MAX_SAVED_PACKETS = 100;
export const MAX_PACKET_LIBRARY_BYTES = 1024 * 1024;
export const MAX_UDP_PACKET_BYTES = 65507;
export const MAX_TCP_PACKET_BYTES = 65536;

const DRAFT_KEYS = ['name', 'protocol', 'host', 'port', 'localAddress', 'localPort', 'dataMode', 'payload', 'intervalMs', 'repeatCount'];
const OPTIONAL_DRAFT_KEYS = ['multicastTtl', 'networkMode', 'lineEnding'];
const encoder = new TextEncoder();

export function createDefaultPacketDraft(): PacketSenderDraft {
  return {
    name: '', protocol: 'udp', networkMode: 'udp', lineEnding: 'none', host: '127.0.0.1', port: 9000,
    localAddress: '0.0.0.0', localPort: 0,
    dataMode: 'text', payload: '你好，云依助手', intervalMs: 1000, repeatCount: 1, multicastTtl: 1,
  };
}

/** Infer old schema-1 modes without changing endpoints, bytes or stored library data. */
export function packetNetworkMode(draft: Pick<PacketSenderDraft, 'protocol' | 'networkMode'>): PacketNetworkMode {
  if (draft.protocol !== 'udp' && draft.protocol !== 'tcp') throw new Error('仅支持 UDP 和 TCP。');
  const mode = draft.networkMode === undefined ? (draft.protocol === 'udp' ? 'udp' : 'tcp-client') : draft.networkMode;
  if (mode !== 'udp' && mode !== 'tcp-client' && mode !== 'tcp-server') throw new Error('网络模式必须是 TCP 客户端、TCP 服务端或 UDP。');
  if ((mode === 'udp') !== (draft.protocol === 'udp')) throw new Error('网络模式与报文协议不一致。');
  return mode;
}

function packetLineEnding(value: unknown): PacketLineEnding {
  if (value === undefined) return 'none';
  if (value !== 'none' && value !== 'lf' && value !== 'crlf') throw new Error('行尾必须是不添加、LF 或 CRLF。');
  return value;
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label}必须是对象。`);
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) throw new Error(`${label}必须是纯数据对象。`);
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, keys: string[], label: string): void {
  if (Object.keys(value).some((key) => !keys.includes(key)) || keys.some((key) => !Object.prototype.hasOwnProperty.call(value, key))) {
    throw new Error(`${label}字段不完整或包含不支持的字段。`);
  }
}

function stringValue(value: unknown, label: string, maxLength: number): string {
  if (typeof value !== 'string' || value.length > maxLength) throw new Error(`${label}必须是长度不超过 ${maxLength} 的文本。`);
  return value;
}

function integer(value: unknown, label: string, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) {
    throw new Error(`${label}必须是 ${min}～${max} 之间的整数。`);
  }
  return value;
}

function validIPv4(value: string): boolean {
  const parts = value.split('.');
  return parts.length === 4 && parts.every((part) => /^(0|[1-9]\d{0,2})$/.test(part) && Number(part) <= 255);
}

function hostValue(value: unknown): string {
  const host = stringValue(value, '目标地址', 253).trim();
  if (validIPv4(host)) return host;
  // No URL, path, shell syntax, IPv6, port suffix or ambiguous shortened numeric IPv4.
  if (!host || /^[\d.]+$/.test(host) || !/^[a-zA-Z0-9.-]+$/.test(host)) {
    throw new Error('目标地址需填写 IPv4 或域名，不含协议、端口或路径；暂不支持 IPv6。');
  }
  const labels = host.replace(/\.$/, '').split('.');
  if (labels.some((label) => !/^[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?$/.test(label))) {
    throw new Error('目标域名格式不正确。');
  }
  return host;
}

/** The native backend is IPv4-only. This identifies multicast, not delivery success. */
export function isMulticastHost(host: string): boolean {
  if (!validIPv4(host)) return false;
  const first = Number(host.split('.')[0]);
  return first >= 224 && first <= 239;
}

function assertUnicode(text: string): void {
  // TextEncoder replaces unpaired UTF-16 surrogates; reject instead of silently changing data.
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = text.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) throw new Error('文本包含不完整的 Unicode 字符，无法无损编码。');
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      throw new Error('文本包含不完整的 Unicode 字符，无法无损编码。');
    }
  }
}

function escapedBytes(payload: string): Uint8Array {
  assertUnicode(payload);
  const bytes: number[] = [];
  let start = 0;
  let index = 0;
  while (index < payload.length) {
    if (payload[index] !== '\\') { index += 1; continue; }
    for (const byte of encoder.encode(payload.slice(start, index))) bytes.push(byte);
    const token = payload[index + 1];
    if (token === '\\' || token === 'r' || token === 'n' || token === 't') {
      bytes.push(token === '\\' ? 92 : token === 'r' ? 13 : token === 'n' ? 10 : 9);
      index += 2;
    } else {
      const hex = payload.slice(index + 1, index + 3);
      if (!/^[\da-fA-F]{2}$/.test(hex)) throw new Error(`第 ${index + 1} 个字符处转义不完整或不支持，请使用 \\00、\\ff、\\r、\\n、\\t 或 \\\\。`);
      bytes.push(Number.parseInt(hex, 16));
      index += 3;
    }
    start = index;
  }
  for (const byte of encoder.encode(payload.slice(start))) bytes.push(byte);
  return Uint8Array.from(bytes);
}

function asEscaped(bytes: Uint8Array): string {
  const parts: string[] = [];
  for (const byte of bytes) {
    if (byte === 92) parts.push('\\\\');
    else if (byte === 13) parts.push('\\r');
    else if (byte === 10) parts.push('\\n');
    else if (byte === 9) parts.push('\\t');
    else if (byte >= 32 && byte <= 126) parts.push(String.fromCharCode(byte));
    else parts.push(`\\${byte.toString(16).padStart(2, '0')}`);
  }
  return parts.join('');
}

function encodedBytes(bytes: Uint8Array, protocol: PacketProtocol): EncodedPacketPayload {
  const limit = protocol === 'udp' ? MAX_UDP_PACKET_BYTES : MAX_TCP_PACKET_BYTES;
  if (bytes.length > limit) throw new Error(`${protocol.toUpperCase()} 单次报文不能超过 ${limit} 字节。`);
  let text: string | null;
  try {
    // ignoreBOM=true preserves the initial UTF-8 BOM as a character, keeping mode switches lossless.
    text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    text = null;
  }
  return { bytes, hex: Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join(''), escaped: asEscaped(bytes), byteCount: bytes.length, text };
}

export function encodePacketPayload(draft: Pick<PacketSenderDraft, 'protocol' | 'dataMode' | 'payload'>): EncodedPacketPayload {
  if (draft.protocol !== 'udp' && draft.protocol !== 'tcp') throw new Error('仅支持 UDP 和 TCP。');
  const payload = stringValue(draft.payload, '报文内容', MAX_PACKET_LIBRARY_BYTES);
  let bytes: Uint8Array;
  if (draft.dataMode === 'text') {
    assertUnicode(payload);
    bytes = encoder.encode(payload);
  } else if (draft.dataMode === 'hex') {
    const compact = payload.replace(/\s/g, '');
    if (!/^[\da-fA-F]*$/.test(compact)) throw new Error('HEX 只能包含十六进制字节和空白，不支持 0x 前缀或标点。');
    if (compact.length % 2 !== 0) throw new Error('HEX 每个字节必须有两位，当前内容有未配对的半字节。');
    bytes = new Uint8Array(compact.length / 2);
    for (let index = 0; index < bytes.length; index += 1) bytes[index] = Number.parseInt(compact.slice(index * 2, index * 2 + 2), 16);
  } else if (draft.dataMode === 'escaped') {
    bytes = escapedBytes(payload);
  } else {
    throw new Error('报文格式必须是文本、HEX 或转义字节。');
  }
  return encodedBytes(bytes, draft.protocol);
}

/** Encode exactly the authored body, then append the selected line ending once per send. */
export function encodeNetworkPayload(draft: Pick<PacketSenderDraft, 'protocol' | 'dataMode' | 'payload' | 'lineEnding'>): EncodedPacketPayload {
  const ending = packetLineEnding(draft.lineEnding);
  const body = encodePacketPayload(draft);
  if (ending === 'none') return body;
  const suffix = ending === 'lf' ? [10] : [13, 10];
  const bytes = new Uint8Array(body.byteCount + suffix.length);
  bytes.set(body.bytes);
  bytes.set(suffix, body.byteCount);
  // The native limit applies to transmitted bytes, including the selected terminator.
  return encodedBytes(bytes, draft.protocol);
}

export function convertPacketPayloadMode(draft: Pick<PacketSenderDraft, 'protocol' | 'dataMode' | 'payload'>, targetMode: PacketDataMode): string {
  const result = encodePacketPayload(draft);
  if (targetMode === 'hex') return result.hex.match(/.{2}/g)?.join(' ') ?? '';
  if (targetMode === 'escaped') return result.escaped;
  if (targetMode !== 'text') throw new Error('不支持的报文格式。');
  if (result.text === null) throw new Error('这些字节不是有效的 UTF-8 文本，请使用 HEX 或转义字节以保留原始数据。');
  return result.text;
}

function normalizedDraft(value: Record<string, unknown>): PacketSenderDraft {
  const name = stringValue(value.name, '报文名称', 80).trim();
  if (/[\u0000-\u001f\u007f]/.test(name)) throw new Error('报文名称不能包含控制字符。');
  assertUnicode(name);
  if (value.protocol !== 'udp' && value.protocol !== 'tcp') throw new Error('仅支持 UDP 和 TCP。');
  const networkMode = packetNetworkMode({ protocol: value.protocol, networkMode: value.networkMode as PacketNetworkMode | undefined });
  const lineEnding = packetLineEnding(value.lineEnding);
  if (value.dataMode !== 'text' && value.dataMode !== 'hex' && value.dataMode !== 'escaped') throw new Error('报文格式无效。');
  const localAddress = stringValue(value.localAddress, '本地地址', 15).trim();
  if (!validIPv4(localAddress)) throw new Error('本地地址必须是 IPv4 地址；自动选择使用 0.0.0.0。');
  // Server mode does not use a remote endpoint. Keep its inactive editor values,
  // including an empty address/port, without blocking listening or rewriting them.
  // Switching back to a client/UDP template applies the usual endpoint validation.
  const host = networkMode === 'tcp-server' ? stringValue(value.host, '目标地址', 253) : hostValue(value.host);
  const port = integer(value.port, '目标端口', networkMode === 'tcp-server' ? 0 : 1, 65535);
  const draft: PacketSenderDraft = {
    name, protocol: value.protocol, networkMode, lineEnding, host, port,
    localAddress, localPort: integer(value.localPort, '本地端口', 0, 65535), dataMode: value.dataMode,
    payload: stringValue(value.payload, '报文内容', MAX_PACKET_LIBRARY_BYTES),
    intervalMs: integer(value.intervalMs, '发送间隔（毫秒）', 50, 86400000),
    repeatCount: integer(value.repeatCount, '发送次数', 1, 1000),
    multicastTtl: value.multicastTtl === undefined ? 1 : integer(value.multicastTtl, '组播 TTL', 0, 255),
  };
  encodeNetworkPayload(draft);
  return draft;
}

export function validatePacketDraft(value: unknown): PacketSenderDraft {
  const draft = record(value, '报文');
  exactKeys(draft, [...DRAFT_KEYS, ...OPTIONAL_DRAFT_KEYS.filter((key) => Object.prototype.hasOwnProperty.call(draft, key))], '报文');
  return normalizedDraft(draft);
}

function normalizedLibrary(value: unknown): PacketLibrary {
  const library = record(value, '报文库');
  exactKeys(library, ['schemaVersion', 'packets'], '报文库');
  if (library.schemaVersion !== 1 || !Array.isArray(library.packets)) throw new Error('不支持此报文库格式，需要 schemaVersion: 1。');
  if (library.packets.length > MAX_SAVED_PACKETS) throw new Error(`报文库最多保存 ${MAX_SAVED_PACKETS} 条报文。`);
  const ids = new Set<string>();
  const packets = library.packets.map((item) => {
    const saved = record(item, '保存的报文');
    exactKeys(saved, [...DRAFT_KEYS, 'id', 'updatedAt', ...OPTIONAL_DRAFT_KEYS.filter((key) => Object.prototype.hasOwnProperty.call(saved, key))], '保存的报文');
    const id = stringValue(saved.id, '报文 ID', 80);
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/.test(id)) throw new Error('报文 ID 格式无效。');
    if (ids.has(id)) throw new Error('报文库包含重复 ID，已取消导入，不会覆盖已有报文。');
    ids.add(id);
    const updatedAt = stringValue(saved.updatedAt, '保存时间', 24);
    const timestamp = Date.parse(updatedAt);
    if (!Number.isFinite(timestamp) || new Date(timestamp).toISOString() !== updatedAt) throw new Error('保存时间必须是有效的 UTC ISO 时间。');
    return { ...normalizedDraft(saved), id, updatedAt };
  });
  const result: PacketLibrary = { schemaVersion: 1, packets };
  if (encoder.encode(JSON.stringify(result)).length > MAX_PACKET_LIBRARY_BYTES) throw new Error('报文库总大小不能超过 1 MiB。');
  return result;
}

/** Strict import also serves as localStorage validation. No unknown fields or executable state. */
export function parsePacketLibrary(json: string): PacketLibrary {
  if (typeof json !== 'string' || json.length > MAX_PACKET_LIBRARY_BYTES || encoder.encode(json).length > MAX_PACKET_LIBRARY_BYTES) {
    throw new Error('报文库文件不能超过 1 MiB。');
  }
  let value: unknown;
  try { value = JSON.parse(json); }
  catch { throw new Error('报文库不是有效的 JSON 文件。'); }
  return normalizedLibrary(value);
}

export function serializePacketLibrary(library: PacketLibrary): string {
  const json = JSON.stringify(normalizedLibrary(library));
  if (encoder.encode(json).length > MAX_PACKET_LIBRARY_BYTES) throw new Error('报文库总大小不能超过 1 MiB。');
  return json;
}

/** Atomic merge: colliding IDs reject the whole import; current data is never mutated. */
export function mergePacketLibraries(current: PacketLibrary, incoming: PacketLibrary): PacketLibrary {
  const existing = normalizedLibrary(current);
  const imported = normalizedLibrary(incoming);
  return normalizedLibrary({ schemaVersion: 1, packets: [...existing.packets, ...imported.packets] });
}
