/** Protocol modes shared by the native packet parser and the browser preview. */
export type PacketMode = 'auto' | 'ethernet' | 'ipv4' | 'ipv6' | 'tcp' | 'udp' | 'raw';

export interface PacketLayer {
  id: string;
  name: string;
  offset: number;
  length: number;
  summary: string;
}

export interface PacketField {
  layer: string;
  name: string;
  offset: number;
  length: number;
  value: string;
  summary?: string;
}

export interface PacketWarning {
  code: string;
  message: string;
  offset: number;
}

export interface PacketAnalysis {
  mode: PacketMode;
  byteCount: number;
  bytes: number[];
  protocol: string;
  confidence: string | number;
  layers: PacketLayer[];
  fields: PacketField[];
  warnings: PacketWarning[];
}

export interface NormalizedHex {
  hex: string;
  bytes: number[];
  format: 'Wireshark 转储' | '连续 Hex' | '分隔 Hex';
}

const MAX_PACKET_BYTES = 65_536;

/**
 * Converts common packet-copy formats into one continuous hexadecimal string.
 * Wireshark offsets and printable ASCII columns are intentionally discarded.
 */
export function normalizeHexInput(input: string): NormalizedHex {
  const trimmed = input.trim();
  if (!trimmed) throw new Error('请先粘贴十六进制报文。');

  const lines = trimmed.split(/\r?\n/).filter((line) => line.trim());
  const firstLineTokens = (lines[0] ?? '').trim().split(/\s+/);
  const firstIsDump = /^(?:0x)?[0-9a-f]{4,8}$/i.test(firstLineTokens[0] ?? '')
    && firstLineTokens.slice(1, 5).length >= 3
    && firstLineTokens.slice(1, 5).every((token) => /^[0-9a-f]{2}$/i.test(token));
  let compact = '';
  let format: NormalizedHex['format'] = /[\s,:;_-]/.test(trimmed) ? '分隔 Hex' : '连续 Hex';

  if (firstIsDump) {
    format = 'Wireshark 转储';
    const pairs: string[] = [];
    for (const line of lines) {
      const match = line.match(/^\s*(?:0x)?[0-9a-f]{4,8}\s+(.*)$/i);
      if (!match) throw new Error('转储中存在没有偏移地址的行，请检查复制范围。');
      // Keep the byte and ASCII columns separate before tokenizing. A final
      // ASCII value such as "ab cd" otherwise looks exactly like two bytes.
      const columns = match[1].trim().split(/\t+|\s{2,}/);
      const firstColumnTokens = (columns[0] ?? '').trim().split(/\s+/).filter(Boolean);
      const secondColumnTokens = (columns[1] ?? '').trim().split(/\s+/).filter(Boolean);
      const groupedSecondColumn = firstColumnTokens.length === 8
        && /^(?:[0-9a-f]{2})(?:\s+[0-9a-f]{2}){0,7}$/i.test(columns[1] ?? '')
        && (columns.length >= 3 || secondColumnTokens.length === 8);
      const byteColumn = groupedSecondColumn ? `${columns[0]} ${columns[1]}` : columns[0];
      const tokens = (byteColumn ?? '').trim().split(/\s+/);
      let lineByteCount = 0;
      for (const token of tokens) {
        if (/^[0-9a-f]{2}$/i.test(token) && lineByteCount < 16) {
          pairs.push(token);
          lineByteCount += 1;
        } else if (/^[0-9a-f]{4,32}$/i.test(token) && token.length % 2 === 0 && lineByteCount === 0) {
          const grouped = token.match(/../g) ?? [];
          pairs.push(...grouped.slice(0, 16));
          lineByteCount += Math.min(grouped.length, 16);
        } else {
          break;
        }
      }
      if (!lineByteCount) throw new Error('转储行没有可识别的字节，请保留十六进制列。');
    }
    compact = pairs.join('');
  } else {
    compact = trimmed
      .replace(/\\x/gi, '')
      .replace(/0x/gi, '')
      .replace(/[\s,:;_-]/g, '');
    if (/[^0-9a-f]/i.test(compact)) {
      throw new Error('发现非 Hex 字符。支持空格、逗号、冒号、短横线、0xNN 和 \\xNN。');
    }
  }

  if (compact.length % 2 !== 0) throw new Error('Hex 字符数量必须为偶数，每两个字符表示 1 字节。');
  const bytes = (compact.match(/../g) ?? []).map((pair) => Number.parseInt(pair, 16));
  if (!bytes.length) throw new Error('没有读取到任何字节。');
  if (bytes.length > MAX_PACKET_BYTES) throw new Error(`单次最多分析 ${MAX_PACKET_BYTES} 字节。`);
  return { hex: compact.toLowerCase(), bytes, format };
}

/** Validates and normalizes JSON produced by the native C/C++11 bridge. */
export function parseNativeAnalysis(
  output: string,
  fallbackBytes: number[],
  requestedMode: PacketMode,
): PacketAnalysis {
  const candidate = JSON.parse(output) as Partial<PacketAnalysis>;
  if (!candidate || !Array.isArray(candidate.layers) || !Array.isArray(candidate.fields)) {
    throw new Error('本地解析器返回了无法识别的数据。');
  }
  const bytes = Array.isArray(candidate.bytes)
    ? candidate.bytes.filter((value) => Number.isInteger(value) && value >= 0 && value <= 255)
    : fallbackBytes;
  const byteCount = Number.isInteger(candidate.byteCount) ? Number(candidate.byteCount) : bytes.length;
  const bounded = (value: unknown) => Number.isInteger(value) && Number(value) >= 0 ? Number(value) : 0;
  return {
    mode: isPacketMode(candidate.mode) ? candidate.mode : requestedMode,
    byteCount,
    bytes: bytes.length ? bytes : fallbackBytes,
    protocol: typeof candidate.protocol === 'string' && candidate.protocol ? candidate.protocol : '未识别载荷',
    confidence: typeof candidate.confidence === 'string' || typeof candidate.confidence === 'number'
      ? candidate.confidence
      : 'low',
    layers: candidate.layers.map((layer, index) => ({
      id: typeof layer?.id === 'string' && layer.id ? layer.id : `layer-${index}`,
      name: localizeLayerName(
        typeof layer?.id === 'string' ? layer.id : '',
        typeof layer?.name === 'string' ? layer.name : `第 ${index + 1} 层`,
      ),
      offset: bounded(layer?.offset),
      length: bounded(layer?.length),
      summary: localizeLayerSummary(
        typeof layer?.id === 'string' ? layer.id : '',
        typeof layer?.summary === 'string' ? layer.summary : '',
      ),
    })),
    fields: candidate.fields.map((field) => ({
      layer: typeof field?.layer === 'string' ? field.layer : 'raw',
      name: typeof field?.name === 'string' ? field.name : '字段',
      offset: bounded(field?.offset),
      length: bounded(field?.length),
      value: localizeFieldValue(typeof field?.value === 'string' ? field.value : ''),
      summary: localizeFieldSummary(
        typeof field?.name === 'string' ? field.name : '',
        typeof field?.summary === 'string' ? field.summary : '',
      ),
    })),
    warnings: Array.isArray(candidate.warnings) ? candidate.warnings.map((warning) => ({
      code: typeof warning?.code === 'string' ? warning.code : 'warning',
      message: localizeWarning(
        typeof warning?.code === 'string' ? warning.code : '',
        typeof warning?.message === 'string' ? warning.message : '报文存在需要确认的内容。',
      ),
      offset: bounded(warning?.offset),
    })) : [],
  };
}

function isPacketMode(value: unknown): value is PacketMode {
  return ['auto', 'ethernet', 'ipv4', 'ipv6', 'tcp', 'udp', 'raw'].includes(String(value));
}

function localizeLayerName(id: string, fallback: string) {
  const labels: Record<string, string> = {
    ethernet: 'Ethernet II',
    vlan: '802.1Q VLAN',
    arp: 'ARP 地址解析',
    ipv4: 'IPv4',
    ipv6: 'IPv6',
    tcp: 'TCP',
    udp: 'UDP',
    icmp: 'ICMP',
    icmpv6: 'ICMPv6',
    payload: '未解释载荷',
    trailing: '尾随字节',
    raw: '原始字节',
  };
  return labels[id] ?? fallback;
}

function localizeLayerSummary(id: string, fallback: string) {
  const byId: Record<string, string> = {
    ethernet: '以太网帧首部',
    vlan: 'VLAN 标签',
    arp: '地址解析消息',
    ipv4: 'IPv4 固定首部与选项',
    ipv6: 'IPv6 固定首部',
    tcp: 'TCP 首部',
    udp: 'UDP 首部',
    icmp: '控制消息首部',
    icmpv6: '控制消息首部',
    trailing: '协议声明范围之外的字节',
    raw: '未指定协议起点',
  };
  if (id === 'payload') {
    const payloads: Record<string, string> = {
      'TCP application data': 'TCP 应用载荷',
      'UDP application data': 'UDP 应用载荷',
      'Transport payload is not decoded': '未解码的传输层载荷',
      'Ethernet payload is not decoded': '未解码的以太网载荷',
      'IPv6 extension header and payload': 'IPv6 扩展首部与载荷',
      'Fragment payload': 'IP 分片载荷',
    };
    return payloads[fallback] ?? '未解释的原始载荷';
  }
  return byId[id] ?? fallback;
}

function localizeFieldSummary(name: string, fallback: string) {
  const labels: Record<string, string> = {
    data: '原始字节数据',
    source: '源地址',
    destination: '目标地址',
    sourcePort: '源端口',
    destinationPort: '目标端口',
    sequenceNumber: 'TCP 序列号',
    acknowledgmentNumber: 'TCP 确认号',
    headerLength: '首部占用的字节数',
    flags: '协议控制标志位',
    window: '接收窗口',
    checksum: '校验和（当前不验证）',
    urgentPointer: '紧急指针',
    options: '原始选项字节',
    length: '首部与载荷总长度',
    type: '控制消息类型',
    code: '控制消息代码',
    version: '版本号高四位',
    dscpEcn: 'DSCP 与 ECN 位',
    totalLength: 'IP 首部与载荷总长度',
    identification: '分片标识',
    fragment: '分片标志与偏移',
    ttl: '生存时间',
    protocol: '封装的上层协议号',
    headerChecksum: 'IPv4 首部校验和（当前不验证）',
    trafficClassAndFlowLabel: '流量类别与流标签',
    payloadLength: 'IPv6 固定首部之后的字节数',
    nextHeader: 'IPv6 下一个首部编号',
    hopLimit: 'IPv6 跳数限制',
    hardwareType: '链路层地址类型',
    protocolType: '网络协议 EtherType',
    hardwareAddressLength: '硬件地址长度',
    protocolAddressLength: '协议地址长度',
    operation: 'ARP 请求或应答操作',
    senderHardwareAddress: '发送方硬件地址',
    senderProtocolAddress: '发送方协议地址',
    targetHardwareAddress: '目标硬件地址',
    targetProtocolAddress: '目标协议地址',
    etherType: '封装协议 EtherType',
    tagControl: '优先级、丢弃资格与 VLAN ID',
  };
  return labels[name] ?? fallback;
}

function localizeFieldValue(value: string) {
  return value
    .replace(/\bbytes?\b/gi, '字节')
    .replace(/trafficClass=/g, '流量类别=')
    .replace(/flowLabel=/g, '流标签=')
    .replace(/flags=/g, '标志=')
    .replace(/offsetBytes=/g, '偏移字节=')
    .replace(/offset=/g, '偏移=')
    .replace(/priority=/g, '优先级=')
    .replace(/vlanId=/g, 'VLAN ID=');
}

function localizeWarning(code: string, fallback: string) {
  const messages: Record<string, string> = {
    'unknown-transport': 'IP 上层协议暂未支持，后续载荷保持原始字节。',
    'truncated-tcp': 'TCP 首部不足 20 字节，报文可能已被截断。',
    'invalid-tcp-header': 'TCP Data Offset 小于最小首部长度。',
    'truncated-tcp-options': 'TCP 首部或选项超出当前可用字节。',
    'truncated-udp': 'UDP 首部不足 8 字节，报文可能已被截断。',
    'invalid-udp-length': 'UDP 声明长度小于其 8 字节首部。',
    'truncated-udp-payload': 'UDP 声明长度超过当前可用字节。',
    'udp-trailing-bytes': 'UDP 声明范围之后仍存在尾随字节。',
    'truncated-icmp': 'ICMP 首部不足 4 字节，报文可能已被截断。',
    'truncated-ipv4': 'IPv4 首部不足 20 字节，报文可能已被截断。',
    'invalid-ipv4-version': '版本号高四位不是 4；请确认解析起点。',
    'invalid-ipv4-header': 'IPv4 IHL 小于最小首部长度。',
    'truncated-ipv4-options': 'IPv4 首部或选项超出当前可用字节。',
    'invalid-ipv4-length': 'IPv4 总长度小于其首部长度。',
    'truncated-ipv4-payload': 'IPv4 声明长度超过当前可用字节。',
    'ipv4-trailing-bytes': 'IPv4 声明范围之后仍存在尾随字节。',
    'ipv4-fragment': '这是 IPv4 非首分片，无法可靠定位传输层首部。',
    'truncated-ipv6': 'IPv6 固定首部不足 40 字节。',
    'invalid-ipv6-version': '版本号高四位不是 6；请确认解析起点。',
    'truncated-ipv6-payload': 'IPv6 载荷长度超过当前可用字节。',
    'ipv6-trailing-bytes': 'IPv6 声明范围之后仍存在尾随字节。',
    'ipv6-extension-header': '检测到 IPv6 扩展首部，当前保留为原始载荷。',
    'truncated-arp': 'ARP 固定首部不足 8 字节。',
    'invalid-arp-length': 'ARP 地址长度计算溢出。',
    'truncated-arp-addresses': 'ARP 地址字段超出当前可用字节。',
    'truncated-ethernet': 'Ethernet II 首部不足 14 字节。',
    'truncated-vlan': '802.1Q VLAN 标签不足 4 字节。',
    'unknown-ethertype': '该 EtherType 暂未支持，后续载荷保持原始字节。',
    'empty-input': '没有收到可分析的报文字节。',
    'unknown-protocol': '没有可靠的协议特征；请手动指定解析起点。',
  };
  return messages[code] ?? fallback;
}

/** Browser-preview implementation mirroring the bounded native parser. */
export function inspectPacket(bytes: number[], requestedMode: PacketMode): PacketAnalysis {
  const layers: PacketLayer[] = [];
  const fields: PacketField[] = [];
  const warnings: PacketWarning[] = [];
  const path: string[] = [];
  let payloadOffset = 0;

  const warning = (code: string, message: string, offset = 0) => warnings.push({ code, message, offset });
  const layer = (id: string, name: string, offset: number, length: number, summary: string) => {
    layers.push({ id, name, offset, length: Math.max(0, Math.min(length, bytes.length - offset)), summary });
    path.push(name);
  };
  const field = (owner: string, name: string, offset: number, length: number, value: string, summary = '') => {
    if (offset >= 0 && length > 0 && offset + length <= bytes.length) {
      fields.push({ layer: owner, name, offset, length, value, summary });
    }
  };

  const read16 = (offset: number) => ((bytes[offset] ?? 0) << 8) | (bytes[offset + 1] ?? 0);
  const read32 = (offset: number) => (
    (((bytes[offset] ?? 0) * 0x1000000)
      + ((bytes[offset + 1] ?? 0) << 16)
      + ((bytes[offset + 2] ?? 0) << 8)
      + (bytes[offset + 3] ?? 0)) >>> 0
  );
  const hex = (offset: number, length: number, separator = ' ') => bytes
    .slice(offset, offset + length)
    .map((value) => value.toString(16).padStart(2, '0'))
    .join(separator);
  const mac = (offset: number) => hex(offset, 6, ':');
  const ipv4 = (offset: number) => bytes.slice(offset, offset + 4).join('.');
  const ipv6 = (offset: number) => Array.from({ length: 8 }, (_, index) => read16(offset + index * 2).toString(16)).join(':');

  const parseTcp = (offset: number, availableLength: number) => {
    if (availableLength < 20 || offset + 20 > bytes.length) {
      warning('truncated-tcp', 'TCP 首部不足 20 字节，无法继续解释。', offset);
      return offset;
    }
    const headerLength = ((bytes[offset + 12] >> 4) & 0x0f) * 4;
    if (headerLength < 20 || headerLength > availableLength || offset + headerLength > bytes.length) {
      warning('invalid-tcp-length', 'TCP Data Offset 与可用字节不一致。', offset + 12);
      return offset;
    }
    const flags = bytes[offset + 13];
    const flagNames = [
      [0x20, 'URG'], [0x10, 'ACK'], [0x08, 'PSH'], [0x04, 'RST'], [0x02, 'SYN'], [0x01, 'FIN'],
    ].filter(([mask]) => (flags & Number(mask)) !== 0).map(([, name]) => name).join(', ') || '无';
    layer('tcp', 'TCP', offset, headerLength, `${read16(offset)} → ${read16(offset + 2)} · ${flagNames}`);
    field('tcp', '源端口', offset, 2, String(read16(offset)));
    field('tcp', '目标端口', offset + 2, 2, String(read16(offset + 2)));
    field('tcp', '序列号', offset + 4, 4, String(read32(offset + 4)), `0x${hex(offset + 4, 4, '')}`);
    field('tcp', '确认号', offset + 8, 4, String(read32(offset + 8)), `0x${hex(offset + 8, 4, '')}`);
    field('tcp', '首部长度', offset + 12, 1, `${headerLength} 字节`);
    field('tcp', '标志', offset + 13, 1, flagNames, `0x${hex(offset + 13, 1, '')}`);
    field('tcp', '窗口', offset + 14, 2, String(read16(offset + 14)));
    field('tcp', '校验和', offset + 16, 2, `0x${hex(offset + 16, 2, '')}`);
    return offset + headerLength;
  };

  const parseUdp = (offset: number, availableLength: number) => {
    if (availableLength < 8 || offset + 8 > bytes.length) {
      warning('truncated-udp', 'UDP 首部不足 8 字节，无法继续解释。', offset);
      return offset;
    }
    const declaredLength = read16(offset + 4);
    layer('udp', 'UDP', offset, 8, `${read16(offset)} → ${read16(offset + 2)} · ${declaredLength} 字节`);
    field('udp', '源端口', offset, 2, String(read16(offset)));
    field('udp', '目标端口', offset + 2, 2, String(read16(offset + 2)));
    field('udp', '长度', offset + 4, 2, `${declaredLength} 字节`);
    field('udp', '校验和', offset + 6, 2, `0x${hex(offset + 6, 2, '')}`);
    if (declaredLength < 8 || declaredLength > availableLength) {
      warning('udp-length-mismatch', `UDP 声明长度 ${declaredLength} 与可用长度 ${availableLength} 不一致。`, offset + 4);
    }
    return offset + 8;
  };

  const parseIpv4 = (offset: number, availableLength: number) => {
    if (availableLength < 20 || offset + 20 > bytes.length) {
      warning('truncated-ipv4', 'IPv4 首部不足 20 字节。', offset);
      return offset;
    }
    const version = bytes[offset] >> 4;
    const headerLength = (bytes[offset] & 0x0f) * 4;
    if (version !== 4) warning('version-mismatch', `首部版本为 ${version}，不是 IPv4。`, offset);
    if (headerLength < 20 || headerLength > availableLength || offset + headerLength > bytes.length) {
      warning('invalid-ipv4-header', `IPv4 IHL=${headerLength} 字节，无效或报文被截断。`, offset);
      return offset;
    }
    const totalLength = read16(offset + 2);
    const packetLength = totalLength >= headerLength ? Math.min(totalLength, availableLength) : availableLength;
    const protocol = bytes[offset + 9];
    const fragmentOffset = read16(offset + 6) & 0x1fff;
    const protocolName = protocol === 6 ? 'TCP' : protocol === 17 ? 'UDP' : protocol === 1 ? 'ICMP' : `协议 ${protocol}`;
    layer('ipv4', 'IPv4', offset, headerLength, `${ipv4(offset + 12)} → ${ipv4(offset + 16)} · ${protocolName}`);
    field('ipv4', '版本 / IHL', offset, 1, `${version === 4 ? 'IPv4' : `版本 ${version}`} / ${headerLength} 字节`, `0x${hex(offset, 1, '')}`);
    field('ipv4', 'DSCP / ECN', offset + 1, 1, `0x${hex(offset + 1, 1, '')}`);
    field('ipv4', '总长度', offset + 2, 2, `${totalLength} 字节`);
    field('ipv4', '标识', offset + 4, 2, `0x${hex(offset + 4, 2, '')}`);
    field('ipv4', '标志 / 分片偏移', offset + 6, 2, `0x${hex(offset + 6, 2, '')}`);
    field('ipv4', 'TTL', offset + 8, 1, String(bytes[offset + 8]));
    field('ipv4', '上层协议', offset + 9, 1, protocolName, String(protocol));
    field('ipv4', '首部校验和', offset + 10, 2, `0x${hex(offset + 10, 2, '')}`);
    field('ipv4', '源地址', offset + 12, 4, ipv4(offset + 12));
    field('ipv4', '目标地址', offset + 16, 4, ipv4(offset + 16));
    if (totalLength < headerLength || totalLength > availableLength) {
      warning('ipv4-length-mismatch', `IPv4 声明长度 ${totalLength} 与可用长度 ${availableLength} 不一致。`, offset + 2);
    }
    const transportOffset = offset + headerLength;
    const transportLength = Math.max(0, packetLength - headerLength);
    if (totalLength < headerLength) {
      // The declared packet ends inside its own header. Do not reinterpret
      // following bytes as a transport header even when Protocol says TCP/UDP.
      return transportOffset;
    }
    if (fragmentOffset !== 0) {
      warning('ipv4-fragment', '这是 IPv4 非首分片，无法可靠定位 TCP/UDP 首部。', offset + 6);
      return transportOffset;
    }
    if (protocol === 6) return parseTcp(transportOffset, transportLength);
    if (protocol === 17) return parseUdp(transportOffset, transportLength);
    if (protocol === 1 && transportLength >= 4) {
      layer('icmp', 'ICMP', transportOffset, 4, `类型 ${bytes[transportOffset]} · 代码 ${bytes[transportOffset + 1]}`);
      field('icmp', '类型', transportOffset, 1, String(bytes[transportOffset]));
      field('icmp', '代码', transportOffset + 1, 1, String(bytes[transportOffset + 1]));
      field('icmp', '校验和', transportOffset + 2, 2, `0x${hex(transportOffset + 2, 2, '')}`);
      return transportOffset + 4;
    }
    return transportOffset;
  };

  const parseIpv6 = (offset: number, availableLength: number) => {
    if (availableLength < 40 || offset + 40 > bytes.length) {
      warning('truncated-ipv6', 'IPv6 固定首部不足 40 字节。', offset);
      return offset;
    }
    const version = bytes[offset] >> 4;
    if (version !== 6) warning('version-mismatch', `首部版本为 ${version}，不是 IPv6。`, offset);
    const payloadLength = read16(offset + 4);
    const nextHeader = bytes[offset + 6];
    const packetLength = Math.min(40 + payloadLength, availableLength);
    const protocolName = nextHeader === 6 ? 'TCP' : nextHeader === 17 ? 'UDP' : `Next Header ${nextHeader}`;
    layer('ipv6', 'IPv6', offset, 40, `${ipv6(offset + 8)} → ${ipv6(offset + 24)} · ${protocolName}`);
    field('ipv6', '版本 / 流量类别', offset, 2, `${version === 6 ? 'IPv6' : `版本 ${version}`} / 0x${hex(offset, 2, '')}`);
    field('ipv6', '流标签', offset + 1, 3, `0x${hex(offset + 1, 3, '')}`);
    field('ipv6', '载荷长度', offset + 4, 2, `${payloadLength} 字节`);
    field('ipv6', '下一个首部', offset + 6, 1, protocolName, String(nextHeader));
    field('ipv6', '跳数限制', offset + 7, 1, String(bytes[offset + 7]));
    field('ipv6', '源地址', offset + 8, 16, ipv6(offset + 8));
    field('ipv6', '目标地址', offset + 24, 16, ipv6(offset + 24));
    if (40 + payloadLength > availableLength) {
      warning('ipv6-length-mismatch', `IPv6 需要 ${40 + payloadLength} 字节，当前只有 ${availableLength} 字节。`, offset + 4);
    }
    const transportOffset = offset + 40;
    const transportLength = Math.max(0, packetLength - 40);
    if (nextHeader === 6) return parseTcp(transportOffset, transportLength);
    if (nextHeader === 17) return parseUdp(transportOffset, transportLength);
    if ([0, 43, 44, 50, 51, 60].includes(nextHeader)) {
      warning('ipv6-extension', '检测到 IPv6 扩展首部，第一版不会越过它猜测传输层。', offset + 6);
    }
    return transportOffset;
  };

  const parseArp = (offset: number, availableLength: number) => {
    if (availableLength < 8 || offset + 8 > bytes.length) {
      warning('truncated-arp', 'ARP 固定首部不足 8 字节。', offset);
      return offset;
    }
    const hardwareType = read16(offset);
    const protocolType = read16(offset + 2);
    const hardwareLength = bytes[offset + 4];
    const protocolLength = bytes[offset + 5];
    const operation = read16(offset + 6);
    const expectedLength = 8 + hardwareLength * 2 + protocolLength * 2;
    const operationName = operation === 1 ? '请求' : operation === 2 ? '应答' : `操作 ${operation}`;
    layer('arp', 'ARP', offset, Math.min(expectedLength, availableLength), `${operationName} · 地址长度 ${hardwareLength}/${protocolLength}`);
    field('arp', '硬件类型', offset, 2, hardwareType === 1 ? 'Ethernet (1)' : String(hardwareType));
    field('arp', '协议类型', offset + 2, 2, `0x${protocolType.toString(16).padStart(4, '0')}`);
    field('arp', '地址长度', offset + 4, 2, `${hardwareLength} / ${protocolLength}`);
    field('arp', '操作码', offset + 6, 2, operationName);
    if (expectedLength > availableLength || offset + expectedLength > bytes.length) {
      warning('truncated-arp', `ARP 地址字段需要 ${expectedLength} 字节，当前只有 ${availableLength} 字节。`, offset + 4);
      return offset + 8;
    }
    let cursor = offset + 8;
    const formatHardware = (position: number) => hardwareLength === 6 ? mac(position) : hex(position, hardwareLength);
    const formatProtocol = (position: number) => protocolType === 0x0800 && protocolLength === 4
      ? ipv4(position)
      : hex(position, protocolLength);
    field('arp', '发送方硬件地址', cursor, hardwareLength, formatHardware(cursor));
    cursor += hardwareLength;
    field('arp', '发送方协议地址', cursor, protocolLength, formatProtocol(cursor));
    cursor += protocolLength;
    field('arp', '目标硬件地址', cursor, hardwareLength, formatHardware(cursor));
    cursor += hardwareLength;
    field('arp', '目标协议地址', cursor, protocolLength, formatProtocol(cursor));
    return offset + expectedLength;
  };

  const parseEthernet = () => {
    if (bytes.length < 14) {
      warning('truncated-ethernet', 'Ethernet II 首部不足 14 字节。');
      return 0;
    }
    let etherType = read16(12);
    let networkOffset = 14;
    layer('ethernet', 'Ethernet II', 0, 14, `${mac(6)} → ${mac(0)} · 0x${etherType.toString(16).padStart(4, '0')}`);
    field('ethernet', '目标 MAC', 0, 6, mac(0));
    field('ethernet', '源 MAC', 6, 6, mac(6));
    field('ethernet', 'EtherType', 12, 2, `0x${etherType.toString(16).padStart(4, '0')}`);
    if ((etherType === 0x8100 || etherType === 0x88a8) && bytes.length >= 18) {
      const vlan = read16(14);
      etherType = read16(16);
      layer('vlan', '802.1Q VLAN', 14, 4, `VLAN ${vlan & 0x0fff} · 0x${etherType.toString(16).padStart(4, '0')}`);
      field('vlan', '标签控制信息', 14, 2, `VLAN ${vlan & 0x0fff}`);
      field('vlan', '封装协议', 16, 2, `0x${etherType.toString(16).padStart(4, '0')}`);
      networkOffset = 18;
    }
    if (etherType === 0x0800) return parseIpv4(networkOffset, bytes.length - networkOffset);
    if (etherType === 0x86dd) return parseIpv6(networkOffset, bytes.length - networkOffset);
    if (etherType === 0x0806) return parseArp(networkOffset, bytes.length - networkOffset);
    warning('unknown-ethertype', `EtherType 0x${etherType.toString(16).padStart(4, '0')} 暂未解释。`, networkOffset - 2);
    return networkOffset;
  };

  let mode = requestedMode;
  if (mode === 'auto') {
    const looksLikeIpv4 = (offset: number) => {
      if (offset < 0 || bytes.length - offset < 20 || (bytes[offset] >> 4) !== 4) return false;
      const headerLength = (bytes[offset] & 0x0f) * 4;
      const totalLength = read16(offset + 2);
      return headerLength >= 20 && headerLength <= bytes.length - offset
        && totalLength >= headerLength && totalLength <= bytes.length - offset;
    };
    const looksLikeIpv6 = (offset: number) => bytes.length - offset >= 40
      && (bytes[offset] >> 4) === 6
      && 40 + read16(offset + 4) <= bytes.length - offset;
    const looksLikeArp = (offset: number) => {
      if (bytes.length - offset < 8) return false;
      const expected = 8 + bytes[offset + 4] * 2 + bytes[offset + 5] * 2;
      return bytes[offset + 4] > 0 && bytes[offset + 5] > 0 && expected <= bytes.length - offset;
    };
    const etherType = bytes.length >= 14 ? read16(12) : -1;
    const vlan = etherType === 0x8100 || etherType === 0x88a8;
    const innerType = vlan && bytes.length >= 18 ? read16(16) : etherType;
    const networkOffset = vlan ? 18 : 14;
    const looksLikeEthernet = bytes.length >= networkOffset && (
      (innerType === 0x0800 && looksLikeIpv4(networkOffset))
      || (innerType === 0x86dd && looksLikeIpv6(networkOffset))
      || (innerType === 0x0806 && looksLikeArp(networkOffset))
    );
    if (looksLikeEthernet) mode = 'ethernet';
    else if (looksLikeIpv4(0)) mode = 'ipv4';
    else if (looksLikeIpv6(0)) mode = 'ipv6';
    else mode = 'raw';
  }

  if (mode === 'ethernet') payloadOffset = parseEthernet();
  else if (mode === 'ipv4') payloadOffset = parseIpv4(0, bytes.length);
  else if (mode === 'ipv6') payloadOffset = parseIpv6(0, bytes.length);
  else if (mode === 'tcp') payloadOffset = parseTcp(0, bytes.length);
  else if (mode === 'udp') payloadOffset = parseUdp(0, bytes.length);
  else payloadOffset = 0;

  if (mode === 'raw') {
    layer('raw', '原始字节', 0, bytes.length, `${bytes.length} 字节 · 未指定协议起点`);
    field('raw', '数据', 0, bytes.length, hex(0, Math.min(bytes.length, 48)), bytes.length > 48 ? '仅预览前 48 字节' : '');
    warning('raw-data', '没有可靠的协议特征；数据保持原样，不猜测字段含义。');
  } else if (payloadOffset < bytes.length) {
    layer('payload', '未解释载荷', payloadOffset, bytes.length - payloadOffset, `${bytes.length - payloadOffset} 字节`);
    field('payload', '载荷', payloadOffset, bytes.length - payloadOffset, hex(payloadOffset, Math.min(bytes.length - payloadOffset, 48)), bytes.length - payloadOffset > 48 ? '仅预览前 48 字节' : '');
    warning('unknown-payload', '剩余载荷没有可靠定义；请用自定义字段标注，不会根据内容臆测。', payloadOffset);
  }

  const requestedWasAuto = requestedMode === 'auto';
  const hasStructuralWarning = warnings.some((item) => item.code.includes('truncated')
    || item.code.includes('mismatch')
    || item.code.includes('invalid'));
  const confidence = mode === 'raw'
    ? 'low'
    : requestedMode !== 'auto'
      ? (hasStructuralWarning ? 'low' : 'medium')
      : (hasStructuralWarning ? 'medium' : 'high');
  return {
    mode: requestedWasAuto ? 'auto' : requestedMode,
    byteCount: bytes.length,
    bytes,
    protocol: path.filter((name) => name !== '未解释载荷').join(' / ') || '未识别载荷',
    confidence,
    layers,
    fields,
    warnings,
  };
}
