/** Parsing modes exposed by the packet inspector. */
export type PacketMode = 'auto' | 'ethernet' | 'ipv4' | 'ipv6' | 'tcp' | 'udp' | 'raw'

export type PacketConfidence = 'high' | 'medium' | 'low'

export interface PacketLayer {
  id: string
  name: string
  offset: number
  length: number
  summary: string
}

export interface PacketField {
  layer: string
  name: string
  offset: number
  length: number
  value: string
  summary: string
}

export interface PacketWarning {
  code: string
  message: string
  offset?: number
}

/** Shape intentionally mirrors the desktop native parser response. */
export interface PacketInspection {
  mode: PacketMode
  byteCount: number
  bytes: number[]
  protocol: string
  confidence: PacketConfidence
  layers: PacketLayer[]
  fields: PacketField[]
  warnings: PacketWarning[]
}

/**
 * Accepts continuous hex, separated bytes, \xNN literals, or Wireshark-style
 * lines beginning with offsets. ASCII columns in offset dumps are ignored.
 */
export function normalizePacketHex(input: string): number[] {
  const source = input.trim()
  if (!source) return []

  const lines = source.split(/\r?\n/)
  const looksLikeDump = lines.some((line) =>
    /^\s*(?:0x)?[0-9a-f]{4,8}(?::|\s{2,}|\t)/i.test(line),
  )

  if (looksLikeDump) {
    const bytes: number[] = []
    for (const originalLine of lines) {
      const offset = originalLine.match(/^\s*(?:0x)?[0-9a-f]{4,8}(?::|\s{2,}|\t)/i)
      if (!offset) continue
      const payload = originalLine.slice(offset[0].length)
      const byteColumn = isolateWiresharkByteColumn(payload)
      const tokens = byteColumn.match(/(?:^|\s)([0-9a-f]{2})(?=\s|$)/gi) ?? []
      // Wireshark's default byte pane emits 16 data bytes per offset row.
      // Limiting the row prevents ASCII text such as "de ad" from being
      // mistaken for extra bytes when it happens to look hexadecimal.
      for (const token of tokens.slice(0, 16)) {
        const value = token.trim()
        if (value) bytes.push(Number.parseInt(value, 16))
      }
    }
    if (bytes.length > 0) return bytes
    throw new Error('没有在转储行中找到十六进制字节。')
  }

  const normalized = source
    .replace(/\\x(?=[0-9a-f]{2})/gi, '')
    .replace(/0x(?=[0-9a-f]{2})/gi, '')
    .replace(/[\s,;:_|\-\[\](){}]/g, '')

  if (!normalized) return []
  if (/[^0-9a-f]/i.test(normalized)) {
    throw new Error('输入中包含非十六进制字符。可以粘贴 00 ff、00ff 或 Wireshark 转储。')
  }
  if (normalized.length % 2 !== 0) {
    throw new Error('十六进制数字数量必须是偶数，最后一个字节不完整。')
  }

  const bytes: number[] = []
  for (let index = 0; index < normalized.length; index += 2) {
    bytes.push(Number.parseInt(normalized.slice(index, index + 2), 16))
  }
  return bytes
}

/**
 * Separates Wireshark's byte column from its printable ASCII column. Some
 * themes add an extra space between the first and second group of eight
 * bytes, so choose the last separator whose prefix is still a valid byte
 * column instead of blindly splitting at the first double space.
 */
function isolateWiresharkByteColumn(payload: string): string {
  const tabIndex = payload.indexOf('\t')
  if (tabIndex >= 0) return payload.slice(0, tabIndex)

  let boundary = -1
  let boundaryWidth = 0
  for (const match of payload.matchAll(/\s{2,}/g)) {
    const index = match.index ?? -1
    if (index < 0) continue
    const prefix = payload.slice(0, index).trim()
    const tokens = prefix ? prefix.split(/\s+/) : []
    if (tokens.length > 0 && tokens.length <= 16 && tokens.every((token) => /^[0-9a-f]{2}$/i.test(token))) {
      boundary = index
      boundaryWidth = match[0].length
    }
  }
  if (boundary < 0) return payload

  // A two-space separator after exactly eight bytes is commonly only the
  // visual gap between Wireshark's two byte groups. Preserve the second group
  // when the rest of the line contains nothing except up to eight more bytes.
  const prefixTokens = payload.slice(0, boundary).trim().split(/\s+/)
  const suffix = payload.slice(boundary + boundaryWidth).trim()
  const suffixTokens = suffix ? suffix.split(/\s+/) : []
  const isEightByteGroupGap =
    boundaryWidth === 2 &&
    prefixTokens.length === 8 &&
    suffixTokens.length > 0 &&
    suffixTokens.length <= 8 &&
    suffixTokens.every((token) => /^[0-9a-f]{2}$/i.test(token))
  return isEightByteGroupGap ? payload : payload.slice(0, boundary)
}

export function inspectPacket(bytes: number[], requestedMode: PacketMode): PacketInspection {
  const result: PacketInspection = {
    mode: requestedMode,
    byteCount: bytes.length,
    bytes: [...bytes],
    protocol: '原始字节',
    confidence: 'low',
    layers: [],
    fields: [],
    warnings: [],
  }

  if (bytes.length === 0) return result

  const mode = requestedMode === 'auto' ? detectMode(bytes) : requestedMode
  if (requestedMode === 'auto' && mode === 'raw') {
    result.warnings.push({
      code: 'unknown-start',
      message:
        '无法可靠判断起始协议。这可能是中间载荷或自定义协议，请手动选择起始层或定义字段。',
      offset: 0,
    })
  }

  switch (mode) {
    case 'ethernet':
      parseEthernet(result, 0, bytes.length)
      break
    case 'ipv4':
      parseIpv4(result, 0, bytes.length)
      break
    case 'ipv6':
      parseIpv6(result, 0, bytes.length)
      break
    case 'tcp':
      parseTcp(result, 0, bytes.length)
      break
    case 'udp':
      parseUdp(result, 0, bytes.length)
      break
    default:
      addPayload(result, 0, bytes.length, '原始 / 未知数据')
      break
  }

  result.protocol = result.layers
    .filter((layer) => layer.id !== 'payload' && layer.id !== 'trailing')
    .map((layer) => layer.name)
    .join(' / ')
  if (!result.protocol) result.protocol = '原始字节'
  result.confidence = determineConfidence(result, requestedMode)
  return result
}

function detectMode(bytes: number[]): PacketMode {
  if (bytes.length >= 14) {
    let etherType = readU16(bytes, 12)
    let payloadOffset = 14
    if ((etherType === 0x8100 || etherType === 0x88a8) && bytes.length >= 18) {
      etherType = readU16(bytes, 16)
      payloadOffset = 18
    }
    if (
      (etherType === 0x0800 && isPlausibleIpv4(bytes, payloadOffset, bytes.length)) ||
      (etherType === 0x86dd && isPlausibleIpv6(bytes, payloadOffset, bytes.length)) ||
      (etherType === 0x0806 && isPlausibleArp(bytes, payloadOffset, bytes.length))
    ) {
      return 'ethernet'
    }
  }
  if (isPlausibleIpv4(bytes, 0, bytes.length)) return 'ipv4'
  if (isPlausibleIpv6(bytes, 0, bytes.length)) return 'ipv6'
  return 'raw'
}

function isPlausibleIpv4(bytes: number[], offset: number, end: number): boolean {
  if (offset < 0 || offset + 20 > end || bytes[offset] >>> 4 !== 4) return false
  const headerLength = (bytes[offset] & 0x0f) * 4
  const totalLength = readU16(bytes, offset + 2)
  return (
    headerLength >= 20 &&
    offset + headerLength <= end &&
    totalLength >= headerLength &&
    offset + totalLength <= end
  )
}

function isPlausibleIpv6(bytes: number[], offset: number, end: number): boolean {
  if (offset < 0 || offset + 40 > end || bytes[offset] >>> 4 !== 6) return false
  return offset + 40 + readU16(bytes, offset + 4) <= end
}

function isPlausibleArp(bytes: number[], offset: number, end: number): boolean {
  if (offset < 0 || offset + 8 > end) return false
  const hardwareLength = bytes[offset + 4]
  const protocolLength = bytes[offset + 5]
  const operation = readU16(bytes, offset + 6)
  const totalLength = 8 + 2 * (hardwareLength + protocolLength)
  return (
    readU16(bytes, offset) === 1 &&
    readU16(bytes, offset + 2) === 0x0800 &&
    hardwareLength === 6 &&
    protocolLength === 4 &&
    (operation === 1 || operation === 2) &&
    offset + totalLength <= end
  )
}

function parseEthernet(result: PacketInspection, offset: number, end: number) {
  if (!requireBytes(result, offset, 14, end, 'ethernet-short', 'Ethernet II 头部至少需要 14 字节。')) {
    addPayload(result, offset, Math.max(0, end - offset), '不完整 Ethernet 数据')
    return
  }

  const etherType = readU16(result.bytes, offset + 12)
  addLayer(result, 'ethernet', 'Ethernet II', offset, 14, `EtherType ${hexWord(etherType, 4)}`)
  addField(result, 'ethernet', '目标 MAC', offset, 6, formatMac(result.bytes, offset), '二层目标地址')
  addField(result, 'ethernet', '源 MAC', offset + 6, 6, formatMac(result.bytes, offset + 6), '二层源地址')
  addField(
    result,
    'ethernet',
    'EtherType',
    offset + 12,
    2,
    `${hexWord(etherType, 4)} (${etherTypeName(etherType)})`,
    '指示上层协议',
  )

  let nextOffset = offset + 14
  let nextType = etherType
  if ((etherType === 0x8100 || etherType === 0x88a8) && nextOffset + 4 <= end) {
    const tci = readU16(result.bytes, nextOffset)
    nextType = readU16(result.bytes, nextOffset + 2)
    addLayer(result, 'vlan', '802.1Q VLAN', nextOffset, 4, `VLAN ID ${tci & 0x0fff}`)
    addField(result, 'vlan', 'TCI', nextOffset, 2, hexWord(tci, 4), `PCP ${tci >>> 13}，VLAN ID ${tci & 0x0fff}`)
    addField(result, 'vlan', '内层 EtherType', nextOffset + 2, 2, hexWord(nextType, 4), etherTypeName(nextType))
    nextOffset += 4
  }

  if (nextType === 0x0800) parseIpv4(result, nextOffset, end)
  else if (nextType === 0x86dd) parseIpv6(result, nextOffset, end)
  else if (nextType === 0x0806) parseArp(result, nextOffset, end)
  else {
    result.warnings.push({
      code: 'unsupported-ethertype',
      message: `尚未解析 EtherType ${hexWord(nextType, 4)}，余下内容保留为未知载荷。`,
      offset: nextOffset,
    })
    addPayload(result, nextOffset, end - nextOffset, '未知二层载荷')
  }
}

function parseIpv4(result: PacketInspection, offset: number, end: number) {
  if (!requireBytes(result, offset, 20, end, 'ipv4-short', 'IPv4 头部至少需要 20 字节。')) {
    addPayload(result, offset, Math.max(0, end - offset), '不完整 IPv4 数据')
    return
  }
  const version = result.bytes[offset] >>> 4
  const ihl = (result.bytes[offset] & 0x0f) * 4
  if (version !== 4 || ihl < 20 || offset + ihl > end) {
    result.warnings.push({ code: 'invalid-ipv4', message: 'IPv4 版本或头部长度无效。', offset })
    addPayload(result, offset, end - offset, '无效 IPv4 数据')
    return
  }

  const totalLength = readU16(result.bytes, offset + 2)
  const protocol = result.bytes[offset + 9]
  const declaredEnd = totalLength >= ihl ? offset + totalLength : end
  const packetEnd = Math.min(end, declaredEnd)
  const flagsAndFragment = readU16(result.bytes, offset + 6)
  const fragmentOffset = flagsAndFragment & 0x1fff
  addLayer(
    result,
    'ipv4',
    'IPv4',
    offset,
    ihl,
    `${formatIpv4(result.bytes, offset + 12)} → ${formatIpv4(result.bytes, offset + 16)}`,
  )
  addField(result, 'ipv4', '版本 / IHL', offset, 1, `${version} / ${ihl} 字节`, 'IPv4 版本与头部长度')
  addField(result, 'ipv4', 'DSCP / ECN', offset + 1, 1, hexByte(result.bytes[offset + 1]), '服务质量与拥塞通知')
  addField(result, 'ipv4', '总长度', offset + 2, 2, `${totalLength} 字节`, '包含 IPv4 头部和载荷')
  addField(result, 'ipv4', '标识', offset + 4, 2, hexWord(readU16(result.bytes, offset + 4), 4), '用于分片重组')
  addField(
    result,
    'ipv4',
    '标志 / 分片偏移',
    offset + 6,
    2,
    `${hexWord(flagsAndFragment, 4)} / ${fragmentOffset * 8} 字节`,
    flagsAndFragment & 0x4000 ? 'DF（不允许分片）' : '允许分片',
  )
  addField(result, 'ipv4', 'TTL', offset + 8, 1, String(result.bytes[offset + 8]), '生存时间')
  addField(result, 'ipv4', '上层协议', offset + 9, 1, `${protocol} (${ipProtocolName(protocol)})`, '指示 IP 载荷协议')
  addField(result, 'ipv4', '头部校验和', offset + 10, 2, hexWord(readU16(result.bytes, offset + 10), 4), '未在浏览器中重算')
  addField(result, 'ipv4', '源 IP', offset + 12, 4, formatIpv4(result.bytes, offset + 12), '网络层源地址')
  addField(result, 'ipv4', '目标 IP', offset + 16, 4, formatIpv4(result.bytes, offset + 16), '网络层目标地址')
  if (ihl > 20) addField(result, 'ipv4', 'Options', offset + 20, ihl - 20, `${ihl - 20} 字节`, 'IPv4 可选字段')

  if (totalLength < ihl) {
    result.warnings.push({
      code: 'invalid-ipv4-total-length',
      message: `IPv4 总长度 ${totalLength} 小于头部长度 ${ihl}，已停止解析传输层。`,
      offset: offset + 2,
    })
    addPayload(result, offset + ihl, Math.max(0, end - (offset + ihl)), '无效 IPv4 后续数据')
    return
  }

  if (declaredEnd > end) {
    result.warnings.push({
      code: 'ipv4-truncated',
      message: `IPv4 声明 ${totalLength} 字节，但当前只有 ${end - offset} 字节。`,
      offset: offset + 2,
    })
  } else if (declaredEnd < end) {
    result.warnings.push({
      code: 'ipv4-trailing',
      message: `IPv4 包之后还有 ${end - declaredEnd} 个尾随字节，可能是 Ethernet 填充。`,
      offset: declaredEnd,
    })
  }

  const nextOffset = offset + ihl
  if (fragmentOffset !== 0) {
    result.warnings.push({ code: 'ipv4-fragment', message: '这是非首分片，不尝试解析传输层头部。', offset: offset + 6 })
    addPayload(result, nextOffset, packetEnd - nextOffset, 'IPv4 分片载荷')
  } else if (protocol === 6) parseTcp(result, nextOffset, packetEnd)
  else if (protocol === 17) parseUdp(result, nextOffset, packetEnd)
  else if (protocol === 1) parseIcmp(result, nextOffset, packetEnd, false)
  else {
    result.warnings.push({ code: 'unknown-ip-protocol', message: `尚未解析 IP 协议号 ${protocol}。`, offset: offset + 9 })
    addPayload(result, nextOffset, packetEnd - nextOffset, `${ipProtocolName(protocol)} 载荷`)
  }
  if (declaredEnd < end) addTrailing(result, declaredEnd, end - declaredEnd)
}

function parseIpv6(result: PacketInspection, offset: number, end: number) {
  if (!requireBytes(result, offset, 40, end, 'ipv6-short', 'IPv6 固定头部需要 40 字节。')) {
    addPayload(result, offset, Math.max(0, end - offset), '不完整 IPv6 数据')
    return
  }
  const version = result.bytes[offset] >>> 4
  if (version !== 6) {
    result.warnings.push({ code: 'invalid-ipv6', message: '首字节不是 IPv6 版本号。', offset })
  }
  const payloadLength = readU16(result.bytes, offset + 4)
  const nextHeader = result.bytes[offset + 6]
  const declaredEnd = offset + 40 + payloadLength
  const packetEnd = Math.min(end, declaredEnd)
  const trafficClass = ((result.bytes[offset] & 0x0f) << 4) | (result.bytes[offset + 1] >>> 4)
  const flowLabel = ((result.bytes[offset + 1] & 0x0f) << 16) | readU16(result.bytes, offset + 2)
  addLayer(
    result,
    'ipv6',
    'IPv6',
    offset,
    40,
    `${formatIpv6(result.bytes, offset + 8)} → ${formatIpv6(result.bytes, offset + 24)}`,
  )
  addField(result, 'ipv6', '版本 / 流量类', offset, 2, `${version} / ${trafficClass}`, 'IPv6 版本与 Traffic Class')
  addField(result, 'ipv6', '流标签', offset + 1, 3, hexWord(flowLabel, 5), '20 位 Flow Label')
  addField(result, 'ipv6', '载荷长度', offset + 4, 2, `${payloadLength} 字节`, '不包含 40 字节固定头')
  addField(result, 'ipv6', '下一头部', offset + 6, 1, `${nextHeader} (${ipProtocolName(nextHeader)})`, '传输层或扩展头')
  addField(result, 'ipv6', '跳数限制', offset + 7, 1, String(result.bytes[offset + 7]), 'Hop Limit')
  addField(result, 'ipv6', '源 IPv6', offset + 8, 16, formatIpv6(result.bytes, offset + 8), '网络层源地址')
  addField(result, 'ipv6', '目标 IPv6', offset + 24, 16, formatIpv6(result.bytes, offset + 24), '网络层目标地址')
  if (declaredEnd > end) {
    result.warnings.push({ code: 'ipv6-truncated', message: `IPv6 声明的载荷比当前数据多 ${declaredEnd - end} 字节。`, offset: offset + 4 })
  }
  const nextOffset = offset + 40
  if ([0, 43, 44, 50, 51, 60].includes(nextHeader)) {
    result.warnings.push({
      code: 'ipv6-extension',
      message: `检测到 IPv6 扩展头 ${nextHeader}，当前版本不继续猜测后续偏移。`,
      offset: nextOffset,
    })
    addPayload(result, nextOffset, packetEnd - nextOffset, 'IPv6 扩展头与载荷')
  } else if (nextHeader === 6) parseTcp(result, nextOffset, packetEnd)
  else if (nextHeader === 17) parseUdp(result, nextOffset, packetEnd)
  else if (nextHeader === 58) parseIcmp(result, nextOffset, packetEnd, true)
  else addPayload(result, nextOffset, packetEnd - nextOffset, `${ipProtocolName(nextHeader)} 载荷`)
  if (declaredEnd < end) addTrailing(result, declaredEnd, end - declaredEnd)
}

function parseTcp(result: PacketInspection, offset: number, end: number) {
  if (!requireBytes(result, offset, 20, end, 'tcp-short', 'TCP 头部至少需要 20 字节。')) {
    addPayload(result, offset, Math.max(0, end - offset), '不完整 TCP 数据')
    return
  }
  const headerLength = (result.bytes[offset + 12] >>> 4) * 4
  if (headerLength < 20 || offset + headerLength > end) {
    result.warnings.push({ code: 'invalid-tcp-length', message: 'TCP Data Offset 不合理，不继续猜测载荷起点。', offset: offset + 12 })
    addPayload(result, offset, end - offset, '无效 TCP 数据')
    return
  }
  const sourcePort = readU16(result.bytes, offset)
  const destinationPort = readU16(result.bytes, offset + 2)
  const flags = result.bytes[offset + 13]
  addLayer(result, 'tcp', 'TCP', offset, headerLength, `${sourcePort} → ${destinationPort}  ${tcpFlags(flags)}`)
  addField(result, 'tcp', '源端口', offset, 2, String(sourcePort), portHint(sourcePort))
  addField(result, 'tcp', '目标端口', offset + 2, 2, String(destinationPort), portHint(destinationPort))
  addField(result, 'tcp', '序列号', offset + 4, 4, String(readU32(result.bytes, offset + 4)), 'Sequence number')
  addField(result, 'tcp', '确认号', offset + 8, 4, String(readU32(result.bytes, offset + 8)), 'Acknowledgment number')
  addField(result, 'tcp', '头部长度 / 标志', offset + 12, 2, `${headerLength} 字节 / ${tcpFlags(flags)}`, hexWord(readU16(result.bytes, offset + 12), 4))
  addField(result, 'tcp', '窗口', offset + 14, 2, String(readU16(result.bytes, offset + 14)), '接收窗口')
  addField(result, 'tcp', '校验和', offset + 16, 2, hexWord(readU16(result.bytes, offset + 16), 4), '未重算伪头校验和')
  addField(result, 'tcp', '紧急指针', offset + 18, 2, String(readU16(result.bytes, offset + 18)), 'Urgent pointer')
  if (headerLength > 20) addField(result, 'tcp', 'Options', offset + 20, headerLength - 20, `${headerLength - 20} 字节`, 'TCP 选项')
  addPayload(result, offset + headerLength, end - (offset + headerLength), '应用载荷（未识别）')
}

function parseUdp(result: PacketInspection, offset: number, end: number) {
  if (!requireBytes(result, offset, 8, end, 'udp-short', 'UDP 头部需要 8 字节。')) {
    addPayload(result, offset, Math.max(0, end - offset), '不完整 UDP 数据')
    return
  }
  const sourcePort = readU16(result.bytes, offset)
  const destinationPort = readU16(result.bytes, offset + 2)
  const declaredLength = readU16(result.bytes, offset + 4)
  const udpEnd = declaredLength >= 8 ? Math.min(end, offset + declaredLength) : end
  addLayer(result, 'udp', 'UDP', offset, 8, `${sourcePort} → ${destinationPort}`)
  addField(result, 'udp', '源端口', offset, 2, String(sourcePort), portHint(sourcePort))
  addField(result, 'udp', '目标端口', offset + 2, 2, String(destinationPort), portHint(destinationPort))
  addField(result, 'udp', '长度', offset + 4, 2, `${declaredLength} 字节`, '包含 8 字节 UDP 头')
  addField(result, 'udp', '校验和', offset + 6, 2, hexWord(readU16(result.bytes, offset + 6), 4), '未重算伪头校验和')
  if (declaredLength < 8) {
    result.warnings.push({ code: 'udp-invalid-length', message: `UDP 长度 ${declaredLength} 小于头部长度 8。`, offset: offset + 4 })
  } else if (offset + declaredLength > end) {
    result.warnings.push({ code: 'udp-truncated', message: `UDP 声明 ${declaredLength} 字节，但当前只剩 ${end - offset} 字节。`, offset: offset + 4 })
  }
  addPayload(result, offset + 8, Math.max(0, udpEnd - (offset + 8)), '应用载荷（未识别）')
}

function parseIcmp(result: PacketInspection, offset: number, end: number, ipv6: boolean) {
  const name = ipv6 ? 'ICMPv6' : 'ICMP'
  const id = ipv6 ? 'icmpv6' : 'icmp'
  if (!requireBytes(result, offset, 4, end, 'icmp-short', `${name} 头部至少需要 4 字节。`)) {
    addPayload(result, offset, Math.max(0, end - offset), `不完整 ${name} 数据`)
    return
  }
  addLayer(result, id, name, offset, 4, `Type ${result.bytes[offset]}, Code ${result.bytes[offset + 1]}`)
  addField(result, id, '类型', offset, 1, String(result.bytes[offset]), `${name} Type`)
  addField(result, id, '代码', offset + 1, 1, String(result.bytes[offset + 1]), `${name} Code`)
  addField(result, id, '校验和', offset + 2, 2, hexWord(readU16(result.bytes, offset + 2), 4), '未重算')
  addPayload(result, offset + 4, end - (offset + 4), `${name} 消息体`)
}

function parseArp(result: PacketInspection, offset: number, end: number) {
  if (!requireBytes(result, offset, 28, end, 'arp-short', '常见 Ethernet/IPv4 ARP 数据需要 28 字节。')) {
    addPayload(result, offset, Math.max(0, end - offset), '不完整 ARP 数据')
    return
  }
  const operation = readU16(result.bytes, offset + 6)
  addLayer(result, 'arp', 'ARP', offset, 28, operation === 1 ? 'Request' : operation === 2 ? 'Reply' : `Operation ${operation}`)
  addField(result, 'arp', '硬件类型', offset, 2, hexWord(readU16(result.bytes, offset), 4), '1 表示 Ethernet')
  addField(result, 'arp', '协议类型', offset + 2, 2, hexWord(readU16(result.bytes, offset + 2), 4), etherTypeName(readU16(result.bytes, offset + 2)))
  addField(result, 'arp', '操作', offset + 6, 2, String(operation), operation === 1 ? '请求' : operation === 2 ? '应答' : '其他')
  addField(result, 'arp', '发送方 MAC', offset + 8, 6, formatMac(result.bytes, offset + 8), '')
  addField(result, 'arp', '发送方 IP', offset + 14, 4, formatIpv4(result.bytes, offset + 14), '')
  addField(result, 'arp', '目标 MAC', offset + 18, 6, formatMac(result.bytes, offset + 18), '')
  addField(result, 'arp', '目标 IP', offset + 24, 4, formatIpv4(result.bytes, offset + 24), '')
  addPayload(result, offset + 28, end - (offset + 28), 'ARP 尾随字节')
}

function addLayer(result: PacketInspection, id: string, name: string, offset: number, length: number, summary: string) {
  result.layers.push({ id, name, offset, length, summary })
}

function addField(
  result: PacketInspection,
  layer: string,
  name: string,
  offset: number,
  length: number,
  value: string,
  summary: string,
) {
  result.fields.push({ layer, name, offset, length, value, summary })
}

function addPayload(result: PacketInspection, offset: number, length: number, summary: string) {
  if (length <= 0) return
  addLayer(result, 'payload', '载荷 / 未知数据', offset, length, summary)
  addField(result, 'payload', '原始载荷', offset, length, `${length} 字节`, '仅标记范围，不猜测自定义语义')
  result.warnings.push({
    code: 'unknown-payload',
    message: '载荷的业务语义未知。可以在下方添加自定义字段，不会自动冒充识别结果。',
    offset,
  })
}

function addTrailing(result: PacketInspection, offset: number, length: number) {
  if (length <= 0) return
  addLayer(result, 'trailing', '尾随字节', offset, length, '不属于协议声明长度')
}

function requireBytes(
  result: PacketInspection,
  offset: number,
  length: number,
  end: number,
  code: string,
  message: string,
): boolean {
  if (offset >= 0 && length >= 0 && offset + length <= end && offset + length <= result.bytes.length) {
    return true
  }
  result.warnings.push({ code, message, offset })
  return false
}

function determineConfidence(result: PacketInspection, requestedMode: PacketMode): PacketConfidence {
  if (requestedMode === 'raw' || result.layers.every((layer) => layer.id === 'payload')) return 'low'
  if (requestedMode !== 'auto') return result.warnings.some((item) => item.code.includes('invalid')) ? 'low' : 'medium'
  if (result.warnings.some((item) => item.code.includes('invalid') || item.code.includes('short'))) return 'low'
  return result.layers.some((layer) => layer.id === 'ethernet' || layer.id === 'ipv4' || layer.id === 'ipv6')
    ? 'high'
    : 'medium'
}

function readU16(bytes: number[], offset: number): number {
  return ((bytes[offset] ?? 0) << 8) | (bytes[offset + 1] ?? 0)
}

function readU32(bytes: number[], offset: number): number {
  return (
    ((bytes[offset] ?? 0) * 0x1000000 +
      (bytes[offset + 1] ?? 0) * 0x10000 +
      (bytes[offset + 2] ?? 0) * 0x100 +
      (bytes[offset + 3] ?? 0)) >>>
    0
  )
}

function hexByte(value: number): string {
  return value.toString(16).padStart(2, '0').toUpperCase()
}

function hexWord(value: number, width: number): string {
  return `0x${value.toString(16).padStart(width, '0').toUpperCase()}`
}

function formatMac(bytes: number[], offset: number): string {
  return bytes.slice(offset, offset + 6).map(hexByte).join(':')
}

function formatIpv4(bytes: number[], offset: number): string {
  return bytes.slice(offset, offset + 4).join('.')
}

function formatIpv6(bytes: number[], offset: number): string {
  const groups: string[] = []
  for (let index = 0; index < 16; index += 2) {
    groups.push(readU16(bytes, offset + index).toString(16))
  }
  return groups.join(':')
}

function etherTypeName(value: number): string {
  const names: Record<number, string> = {
    0x0800: 'IPv4',
    0x0806: 'ARP',
    0x8100: '802.1Q VLAN',
    0x86dd: 'IPv6',
    0x88a8: '802.1ad VLAN',
  }
  return names[value] ?? '未知'
}

function ipProtocolName(value: number): string {
  const names: Record<number, string> = {
    1: 'ICMP',
    2: 'IGMP',
    6: 'TCP',
    17: 'UDP',
    41: 'IPv6',
    47: 'GRE',
    50: 'ESP',
    51: 'AH',
    58: 'ICMPv6',
  }
  return names[value] ?? `协议 ${value}`
}

function portHint(port: number): string {
  const names: Record<number, string> = {
    20: 'FTP data',
    21: 'FTP',
    22: 'SSH',
    25: 'SMTP',
    53: 'DNS',
    67: 'DHCP server',
    68: 'DHCP client',
    80: 'HTTP',
    123: 'NTP',
    443: 'HTTPS',
    3306: 'MySQL',
    5432: 'PostgreSQL',
    6379: 'Redis',
  }
  return names[port] ?? '未知 / 动态端口'
}

function tcpFlags(flags: number): string {
  const names = [
    [0x80, 'CWR'],
    [0x40, 'ECE'],
    [0x20, 'URG'],
    [0x10, 'ACK'],
    [0x08, 'PSH'],
    [0x04, 'RST'],
    [0x02, 'SYN'],
    [0x01, 'FIN'],
  ] as const
  const selected = names.filter(([mask]) => (flags & mask) !== 0).map(([, name]) => name)
  return selected.length > 0 ? selected.join(', ') : '无标志'
}
