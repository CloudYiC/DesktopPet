import type { PacketAnalysis, PacketField, PacketLayer, PacketMode } from './packetParser';

export type CustomFieldType = 'hex' | 'uint' | 'int' | 'string' | 'ascii' | 'utf8';
export interface ByteRange { offset: number; length: number }
export interface CustomField extends ByteRange {
  id: string;
  name: string;
  type: CustomFieldType;
  endian: 'big' | 'little';
}

export const CUSTOM_FIELDS_KEY = 'cloudyi.packet-inspector.custom-fields.v1';
export const ROW_HEIGHT = 32;
export const UDP_SAMPLE = `0000  00 11 22 33 44 55 66 77 88 99 aa bb 08 00 45 00
0010  00 34 12 34 40 00 40 11 00 00 c0 a8 0b 66 c0 a8
0020  0b 9e 60 00 60 00 00 20 00 00 01 80 00 10 c0 a8
0030  0b 66 c0 a8 0b 9e 5d c2 01 3c 26 d8 9d f4 00 00
0040  00 01`;

export const MODE_OPTIONS: Array<{ value: PacketMode; label: string; hint: string }> = [
  { value: 'auto', label: '自动识别', hint: '从完整以太网帧或 IP 包起点识别。' },
  { value: 'ethernet', label: 'Ethernet II', hint: '第 0 字节是以太网首部。' },
  { value: 'ipv4', label: 'IPv4', hint: '第 0 字节是 IPv4 首部。' },
  { value: 'ipv6', label: 'IPv6', hint: '第 0 字节是 IPv6 首部。' },
  { value: 'tcp', label: 'TCP', hint: '仅在第 0 字节是 TCP 首部时选择。' },
  { value: 'udp', label: 'UDP', hint: '仅在第 0 字节是 UDP 首部时选择。' },
  { value: 'raw', label: '原始字节 / 自定义协议', hint: '保留原始字节，按协议文档自行定义字段。' },
];

export function hexOffset(offset: number) { return `0x${offset.toString(16).toUpperCase().padStart(4, '0')}`; }
export function hexBytes(bytes: number[]) { return bytes.map((byte) => byte.toString(16).toUpperCase().padStart(2, '0')).join(' '); }
export function rangeText(range: ByteRange) {
  return range.length ? `${hexOffset(range.offset)}–${hexOffset(range.offset + range.length - 1)} · ${range.length} B` : '未选择字节';
}
export function rangeInPacket(range: ByteRange, length: number) {
  return Number.isSafeInteger(range.offset) && Number.isSafeInteger(range.length)
    && range.offset >= 0 && range.length > 0 && range.offset + range.length <= length;
}

/** Use BigInt so eight-byte integers do not lose precision above 2^53. */
export function integerValue(bytes: number[], endian: 'big' | 'little', signed = false) {
  if (!bytes.length || bytes.length > 8) return '—';
  const ordered = endian === 'little' ? [...bytes].reverse() : bytes;
  let value = ordered.reduce((total, byte) => (total << 8n) | BigInt(byte), 0n);
  if (signed && (ordered[0] & 0x80)) value -= 1n << BigInt(ordered.length * 8);
  return value.toString();
}

export function fieldValue(field: CustomField, bytes: number[]) {
  if (!rangeInPacket(field, bytes.length)) return '超出当前报文';
  const slice = bytes.slice(field.offset, field.offset + field.length);
  if (field.type === 'uint' || field.type === 'int') return integerValue(slice, field.endian, field.type === 'int');
  if (field.type === 'hex') return hexBytes(slice);
  if (field.type === 'ascii') return slice.map((b) => b >= 32 && b <= 126 ? String.fromCharCode(b) : '·').join('');
  return new TextDecoder('utf-8').decode(Uint8Array.from(slice)).replace(/[\u0000-\u001f\u007f]/g, '·');
}

/** Keep both desktop and web v1 templates, including the older string alias. */
export function readCustomFields(raw: string | null): CustomField[] {
  if (!raw) return [];
  try {
    const value: unknown = JSON.parse(raw);
    if (!Array.isArray(value)) return [];
    return value.filter((item): item is CustomField => {
      if (!item || typeof item !== 'object') return false;
      return typeof item.id === 'string' && typeof item.name === 'string'
        && rangeInPacket(item, 65536)
        && ['hex', 'uint', 'int', 'string', 'ascii', 'utf8'].includes(item.type)
        && ['big', 'little'].includes(item.endian)
        && (!['uint', 'int'].includes(item.type) || item.length <= 8);
    });
  } catch { return []; }
}

/** Bare offsets are decimal; a 0x prefix explicitly selects hexadecimal. */
export function parseOffset(value: string, byteCount: number) {
  const input = value.trim();
  if (!/^(?:0x[0-9a-f]+|\d+)$/i.test(input)) throw new Error('请输入十进制偏移，或带 0x 前缀的十六进制偏移。');
  const offset = Number(input);
  if (!Number.isSafeInteger(offset) || offset < 0 || offset >= byteCount) {
    throw new Error(byteCount ? `偏移范围为 0–${byteCount - 1}（${hexOffset(byteCount - 1)}）。` : '请先分析报文。');
  }
  return offset;
}

export function isPayload(layer: PacketLayer) { return ['payload', 'raw', 'trailing'].includes(layer.id); }
export function layerLabel(layer: PacketLayer) { return layer.id === 'payload' ? '未解析载荷' : layer.name; }
export function layerAt(analysis: PacketAnalysis, range: ByteRange) {
  return [...analysis.layers].reverse().find((layer) => range.offset >= layer.offset
    && range.offset + range.length <= layer.offset + layer.length);
}
export function layerTone(layer: PacketLayer) {
  if (isPayload(layer)) return { background: '#FFF0D8', accent: '#EEAA39' };
  if (['ipv4', 'ipv6'].includes(layer.id)) return { background: '#E5F0FD', accent: '#72ADEB' };
  if (['udp', 'tcp'].includes(layer.id)) return { background: '#DDF3F2', accent: '#169D98' };
  return { background: '#E2F3EB', accent: '#79CFA6' };
}

export function fieldLabel(field: PacketField) {
  const labels: Record<string, string> = {
    data: '数据', source: '源地址', destination: '目标地址', sourcePort: '源端口', destinationPort: '目标端口',
    sequenceNumber: '序列号', acknowledgmentNumber: '确认号', headerLength: '首部长度', flags: '标志', window: '窗口',
    checksum: '校验和', urgentPointer: '紧急指针', options: '选项', length: '长度', type: '类型', code: '代码',
    version: '版本', dscpEcn: 'DSCP / ECN', totalLength: '总长度', identification: '标识', fragment: '标志 / 分片偏移',
    ttl: 'TTL', protocol: '上层协议', headerChecksum: '首部校验和', trafficClassAndFlowLabel: '流量类别 / 流标签',
    payloadLength: '载荷长度', nextHeader: '下一个首部', hopLimit: '跳数限制', hardwareType: '硬件类型',
    protocolType: '协议类型', hardwareAddressLength: '硬件地址长度', protocolAddressLength: '协议地址长度', operation: '操作码',
    senderHardwareAddress: '发送方硬件地址', senderProtocolAddress: '发送方协议地址', targetHardwareAddress: '目标硬件地址',
    targetProtocolAddress: '目标协议地址', etherType: 'EtherType', tagControl: '标签控制信息',
  };
  const name = labels[field.name] ?? field.name;
  return field.layer === 'udp' && name === '长度' ? 'UDP 长度' : name;
}

export function initialSelection(analysis: PacketAnalysis) {
  let index = analysis.fields.findIndex((field) => field.layer === 'udp' && fieldLabel(field) === '源端口');
  if (index < 0) index = analysis.fields.findIndex((field) => rangeInPacket(field, analysis.bytes.length));
  const field = analysis.fields[index];
  return {
    key: field ? `field:${index}` : '',
    layer: field?.layer ?? analysis.layers[0]?.id ?? '',
    range: field ? { offset: field.offset, length: field.length } : { offset: 0, length: Math.min(1, analysis.bytes.length) },
  };
}
