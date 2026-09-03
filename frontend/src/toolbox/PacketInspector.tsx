import { useEffect, useMemo, useState, type CSSProperties } from 'react';
import { executeTool, isNativeHost } from '../bridge/hostBridge';
import type { ToolDefinition } from './catalog';
import {
  inspectPacket,
  normalizeHexInput,
  parseNativeAnalysis,
  type PacketAnalysis,
  type PacketField,
  type PacketMode,
} from './packetParser';
import styles from './PacketInspector.module.scss';

interface PacketInspectorProps {
  tool: ToolDefinition;
  onBack(): void;
}

type CustomFieldType = 'hex' | 'uint' | 'string';
type CustomFieldEndian = 'big' | 'little';

interface CustomField {
  id: string;
  name: string;
  offset: number;
  length: number;
  type: CustomFieldType;
  endian: CustomFieldEndian;
}

const CUSTOM_FIELDS_KEY = 'cloudyi.packet-inspector.custom-fields.v1';
const MAX_RENDERED_BYTES = 8192;
const LAYER_COLORS = ['#dff2ee', '#ffe5d7', '#e8e2fb', '#fff0c9', '#dceeff', '#f5deea', '#e9eee4'];

const UDP_SAMPLE = `0000  00 11 22 33 44 55 66 77 88 99 aa bb 08 00 45 00  .."3DUfw......E.
0010  00 34 12 34 40 00 40 11 00 00 c0 a8 0b 66 c0 a8  .4.4@.@......f..
0020  0b 9e 60 00 60 00 00 20 00 00 01 80 00 10 c0 a8  ..a.. ..........
0030  0b 66 c0 a8 0b 9e 5d c2 01 3c 26 d8 9d f4 00 00  .f....]..<&.....
0040  00 01                                            ..`;

const MODE_OPTIONS: Array<{ value: PacketMode; label: string; hint: string }> = [
  { value: 'auto', label: '自动识别', hint: '根据明确的版本号和 EtherType 识别，不凭端口猜业务协议。' },
  { value: 'ethernet', label: '从 Ethernet II 开始', hint: '输入应从 14 字节以太网首部开始。' },
  { value: 'ipv4', label: '从 IPv4 开始', hint: '适合只复制了 IP 层及其载荷的内容。' },
  { value: 'ipv6', label: '从 IPv6 开始', hint: '适合只复制了 IPv6 层及其载荷的内容。' },
  { value: 'tcp', label: '从 TCP 开始', hint: '需要你确认第 0 字节确实是 TCP 首部。' },
  { value: 'udp', label: '从 UDP 开始', hint: '需要你确认第 0 字节确实是 UDP 首部。' },
  { value: 'raw', label: '仅查看原始字节', hint: '只做偏移、字节数和 ASCII 对照，不解释协议。' },
];

/** Interactive packet workbench backed by the native C parser when available. */
export function PacketInspector({ tool, onBack }: PacketInspectorProps) {
  const [input, setInput] = useState(UDP_SAMPLE);
  const [mode, setMode] = useState<PacketMode>('auto');
  const initial = useMemo(() => normalizeHexInput(UDP_SAMPLE), []);
  const [analysis, setAnalysis] = useState<PacketAnalysis>(() => inspectPacket(initial.bytes, 'auto'));
  const [sourceFormat, setSourceFormat] = useState(initial.format);
  const [parserSource, setParserSource] = useState(isNativeHost ? '示例预览 · 点击启用 C 核心' : '浏览器等价预览');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('示例中的 UDP 载荷保持“未知”，可在下方按协议文档建立字段。');
  const [selectedRange, setSelectedRange] = useState({ offset: 0, length: 14 });
  const [selectionAnchor, setSelectionAnchor] = useState(0);
  const [selectedKey, setSelectedKey] = useState('layer:ethernet');
  const [customFields, setCustomFields] = useState<CustomField[]>(loadCustomFields);
  const [draftName, setDraftName] = useState('消息类型');
  const [draftOffset, setDraftOffset] = useState(42);
  const [draftLength, setDraftLength] = useState(1);
  const [draftType, setDraftType] = useState<CustomFieldType>('uint');
  const [draftEndian, setDraftEndian] = useState<CustomFieldEndian>('big');

  const inputStatus = useMemo(() => {
    try {
      const normalized = normalizeHexInput(input);
      return { normalized, error: '' };
    } catch (parseError) {
      return { normalized: null, error: parseError instanceof Error ? parseError.message : 'Hex 格式不正确。' };
    }
  }, [input]);

  useEffect(() => {
    try {
      window.localStorage.setItem(CUSTOM_FIELDS_KEY, JSON.stringify(customFields));
    } catch {
      // Local storage can be unavailable in hardened WebView profiles; fields
      // still remain usable for the current session.
    }
  }, [customFields]);

  const runAnalysis = async () => {
    setError('');
    let normalized;
    try {
      normalized = normalizeHexInput(input);
    } catch (parseError) {
      setError(parseError instanceof Error ? parseError.message : 'Hex 格式不正确。');
      return;
    }

    const preview = inspectPacket(normalized.bytes, mode);
    setAnalysis(preview);
    setSourceFormat(normalized.format);
    setBusy(true);
    try {
      if (!isNativeHost) {
        setParserSource('浏览器等价预览');
        setNotice('当前是浏览器预览；安装版会调用同一界面下的本地 C 解析核心。');
        return;
      }
      const output = await executeTool({
        toolId: 'packet-inspector',
        operation: mode,
        input: normalized.hex,
      });
      setAnalysis(parseNativeAnalysis(output, normalized.bytes, mode));
      setParserSource('本地 C 核心');
      setNotice('协议层来自本地 C 核心；没有定义的业务载荷仍会保持未知。');
    } catch (nativeError) {
      setParserSource('React 安全回退');
      setNotice('本地解析暂不可用，已用等价预览继续显示；不会因此猜测未知字段。');
      setError(nativeError instanceof Error ? `本地解析器：${nativeError.message}` : '本地解析器暂不可用。');
    } finally {
      setBusy(false);
    }
  };

  const selectLayer = (id: string, offset: number, length: number) => {
    setSelectedKey(`layer:${id}`);
    setSelectedRange({ offset, length });
    setSelectionAnchor(offset);
    setDraftOffset(offset);
    setDraftLength(Math.max(1, length));
  };

  const selectField = (key: string, field: Pick<PacketField, 'offset' | 'length'>) => {
    setSelectedKey(key);
    setSelectedRange({ offset: field.offset, length: field.length });
    setSelectionAnchor(field.offset);
    setDraftOffset(field.offset);
    setDraftLength(Math.max(1, field.length));
  };

  const selectByte = (index: number, extend: boolean) => {
    const start = extend ? Math.min(selectionAnchor, index) : index;
    const length = extend ? Math.abs(index - selectionAnchor) + 1 : 1;
    if (!extend) setSelectionAnchor(index);
    setSelectedKey('bytes');
    setSelectedRange({ offset: start, length });
    setDraftOffset(start);
    setDraftLength(length);
  };

  const addCustomField = () => {
    const name = draftName.trim();
    if (!name) {
      setError('请为自定义字段填写名称。');
      return;
    }
    if (!Number.isInteger(draftOffset) || !Number.isInteger(draftLength) || draftOffset < 0 || draftLength < 1) {
      setError('字段偏移需为非负整数，长度至少为 1 字节。');
      return;
    }
    if (draftOffset + draftLength > analysis.byteCount) {
      setError(`字段范围超出当前 ${analysis.byteCount} 字节报文。`);
      return;
    }
    if (draftType === 'uint' && draftLength > 8) {
      setError('无符号整数最多读取 8 字节；更长内容请选择 Hex。');
      return;
    }
    const field: CustomField = {
      id: `field-${Date.now()}-${Math.random().toString(16).slice(2)}`,
      name,
      offset: draftOffset,
      length: draftLength,
      type: draftType,
      endian: draftEndian,
    };
    setCustomFields((current) => [...current, field]);
    setSelectedKey(`custom:${field.id}`);
    setSelectedRange({ offset: field.offset, length: field.length });
    setError('');
    setNotice(`“${field.name}”已保存到本机字段模板。`);
  };

  const deleteCustomField = (id: string) => {
    setCustomFields((current) => current.filter((field) => field.id !== id));
    if (selectedKey === `custom:${id}`) setSelectedKey('');
  };

  const visibleByteCount = Math.min(analysis.bytes.length, MAX_RENDERED_BYTES);
  const rows = Math.ceil(visibleByteCount / 16);
  const selectedEnd = selectedRange.offset + selectedRange.length;
  const confidence = confidenceLabel(analysis.confidence);
  const currentMode = MODE_OPTIONS.find((option) => option.value === mode) ?? MODE_OPTIONS[0];

  return (
    <section className={styles.workspace}>
      <header className={styles.workspaceHeader}>
        <button type="button" onClick={onBack}>← 返回工具列表</button>
        <div className={styles.workspaceTitle}>
          <i>{tool.glyph}</i>
          <div>
            <span>C CORE · C++11 BRIDGE</span>
            <h2>{tool.name}</h2>
            <p>把偏移、协议层、字段值与原始字节放在同一张工作台中。</p>
          </div>
        </div>
      </header>

      <div className={styles.inputCard}>
        <div className={styles.inputHeading}>
          <div>
            <span>PACKET SOURCE</span>
            <h3>粘贴报文字节</h3>
            <p>支持连续 Hex、空格分隔、0xNN、\\xNN，以及带偏移和 ASCII 列的 Wireshark 转储。</p>
          </div>
          <button type="button" onClick={() => { setInput(UDP_SAMPLE); setMode('auto'); }}>载入 UDP 示例</button>
        </div>
        <textarea
          value={input}
          onChange={(event) => setInput(event.target.value)}
          spellCheck={false}
          aria-label="十六进制报文"
        />
        <div className={styles.analysisControls}>
          <label>
            <span>解析起点</span>
            <select value={mode} onChange={(event) => setMode(event.target.value as PacketMode)}>
              {MODE_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
            </select>
          </label>
          <p>{inputStatus.error || currentMode.hint}</p>
          <div className={styles.inputFacts}>
            <span>{inputStatus.normalized?.format ?? '等待有效输入'}</span>
            <strong>{inputStatus.normalized ? `${inputStatus.normalized.bytes.length} B` : '—'}</strong>
          </div>
          <button type="button" disabled={busy || !inputStatus.normalized} onClick={() => void runAnalysis()}>
            {busy ? '解析中…' : '分析报文'}
          </button>
        </div>
      </div>

      {error && <p className={styles.errorBanner}>{error}</p>}

      <div className={styles.summaryGrid}>
        <SummaryCard label="报文长度" value={`${analysis.byteCount} 字节`} detail={`${analysis.byteCount * 8} bit`} />
        <SummaryCard label="识别路径" value={analysis.protocol} detail={`${analysis.layers.length} 个层级`} />
        <SummaryCard label="识别可信度" value={confidence.label} detail={confidence.detail} tone={confidence.tone} />
        <SummaryCard label="解析来源" value={parserSource} detail={`${sourceFormat} · 本地处理`} />
      </div>

      <p className={styles.truthNotice}><b>不瞎猜原则</b><span>{notice}</span></p>

      <div className={styles.inspectorGrid}>
        <aside className={styles.layerPanel}>
          <header><span>PROTOCOL TREE</span><h3>协议分层</h3></header>
          <div className={styles.layerTree}>
            {analysis.layers.map((item, index) => (
              <button
                key={`${item.id}-${index}`}
                type="button"
                className={selectedKey === `layer:${item.id}` ? styles.selectedLayer : undefined}
                onClick={() => selectLayer(item.id, item.offset, item.length)}
                style={{ '--layer-color': LAYER_COLORS[index % LAYER_COLORS.length] } as CSSProperties}
              >
                <i>{index + 1}</i>
                <span><strong>{item.name}</strong><small>{item.summary || '无摘要'}</small></span>
                <em>{formatRange(item.offset, item.length, analysis.byteCount)}</em>
              </button>
            ))}
          </div>
          {analysis.warnings.length > 0 && (
            <div className={styles.warningList}>
              <strong>需要确认</strong>
              {analysis.warnings.map((warning, index) => (
                <p key={`${warning.code}-${index}`}><i>!</i><span>{warning.message}<small>@ 0x{toOffset(warning.offset, analysis.byteCount)}</small></span></p>
              ))}
            </div>
          )}
        </aside>

        <div className={styles.bytePanel}>
          <header>
            <div><span>BYTE MAP</span><h3>字节地图</h3></div>
            <p>单击选 1 字节，Shift + 单击扩展范围</p>
          </header>
          <div className={styles.hexScroller}>
            <div className={styles.hexTable}>
              <div className={styles.hexHeader}><b>OFFSET</b>{Array.from({ length: 16 }, (_, index) => <i key={index}>{index.toString(16).toUpperCase().padStart(2, '0')}</i>)}<b>ASCII</b></div>
              {Array.from({ length: rows }, (_, rowIndex) => {
                const offset = rowIndex * 16;
                const rowBytes = analysis.bytes.slice(offset, Math.min(offset + 16, visibleByteCount));
                return (
                  <div className={styles.hexRow} key={offset}>
                    <b>0x{toOffset(offset, analysis.byteCount)}</b>
                    {Array.from({ length: 16 }, (_, column) => {
                      const index = offset + column;
                      const value = analysis.bytes[index];
                      if (value === undefined || index >= visibleByteCount) return <i className={styles.emptyByte} key={column}>--</i>;
                      const layerIndex = layerIndexAt(analysis, index);
                      const selected = index >= selectedRange.offset && index < selectedEnd;
                      return (
                        <button
                          type="button"
                          key={column}
                          className={selected ? styles.selectedByte : undefined}
                          style={{
                            '--byte-color': layerIndex >= 0
                              ? LAYER_COLORS[layerIndex % LAYER_COLORS.length]
                              : '#e9eee4',
                          } as CSSProperties}
                          title={`偏移 0x${toOffset(index, analysis.byteCount)} · ${value}`}
                          onClick={(event) => selectByte(index, event.shiftKey)}
                        >
                          {value.toString(16).toUpperCase().padStart(2, '0')}
                        </button>
                      );
                    })}
                    <code>{asciiText(rowBytes)}</code>
                  </div>
                );
              })}
            </div>
          </div>
          {analysis.bytes.length > visibleByteCount && (
            <p className={styles.renderLimit}>为保持界面流畅，仅显示前 {visibleByteCount} 字节；统计与本地解析仍包含完整报文。</p>
          )}
          <div className={styles.selectionSummary}>
            <span>当前选择</span>
            <strong>{formatRange(selectedRange.offset, selectedRange.length, analysis.byteCount)}</strong>
            <code>{hexSlice(analysis.bytes, selectedRange.offset, selectedRange.length, 48)}</code>
          </div>
        </div>
      </div>

      <section className={styles.fieldCard}>
        <header><div><span>FIELD DETAILS</span><h3>标准字段</h3></div><p>点击一行，字节地图会同步高亮。</p></header>
        <div className={styles.fieldTable}>
          <div className={styles.fieldTableHead}><span>层</span><span>字段</span><span>范围</span><span>值</span></div>
          {analysis.fields.map((field, index) => {
            const key = `field:${index}`;
            return (
              <button key={key} type="button" className={selectedKey === key ? styles.selectedField : undefined} onClick={() => selectField(key, field)}>
                <span>{layerName(analysis, field.layer)}</span>
                <strong>{displayFieldName(field.name)}<small>{field.summary}</small></strong>
                <code>{formatRange(field.offset, field.length, analysis.byteCount)}</code>
                <em>{field.value}</em>
              </button>
            );
          })}
        </div>
      </section>

      <section className={styles.customCard}>
        <header>
          <div><span>CUSTOM SCHEMA · LOCAL</span><h3>自定义协议字段</h3><p>依据你自己的协议文档标注未知载荷；字段模板只保存在本机。</p></div>
          <strong>{customFields.length} 个已保存字段</strong>
        </header>
        <div className={styles.customForm}>
          <label><span>字段名称</span><input value={draftName} onChange={(event) => setDraftName(event.target.value)} placeholder="例如：消息类型" /></label>
          <label><span>起始偏移（十进制）</span><input type="number" min={0} value={draftOffset} onChange={(event) => setDraftOffset(Number(event.target.value))} /></label>
          <label><span>长度（字节）</span><input type="number" min={1} value={draftLength} onChange={(event) => setDraftLength(Number(event.target.value))} /></label>
          <label><span>解释方式</span><select value={draftType} onChange={(event) => setDraftType(event.target.value as CustomFieldType)}><option value="hex">Hex</option><option value="uint">无符号整数</option><option value="string">UTF-8 / 文本</option></select></label>
          <label><span>字节序</span><select value={draftEndian} disabled={draftType !== 'uint'} onChange={(event) => setDraftEndian(event.target.value as CustomFieldEndian)}><option value="big">大端（网络序）</option><option value="little">小端</option></select></label>
          <button type="button" onClick={addCustomField}>保存字段</button>
        </div>
        <p className={styles.selectionTip}>可以先在字节地图单击起点，再按住 Shift 点击终点，偏移和长度会自动填入。</p>
        {customFields.length ? (
          <div className={styles.customFieldGrid}>
            {customFields.map((field) => {
              const inRange = field.offset + field.length <= analysis.bytes.length;
              const key = `custom:${field.id}`;
              return (
                <article key={field.id} className={selectedKey === key ? styles.selectedCustom : undefined}>
                  <button type="button" onClick={() => selectField(key, field)}>
                    <span>{field.type === 'uint' ? (field.endian === 'big' ? 'UINT · BE' : 'UINT · LE') : field.type.toUpperCase()}</span>
                    <strong>{field.name}</strong>
                    <small>{formatRange(field.offset, field.length, analysis.byteCount)}</small>
                    <code>{inRange ? customFieldValue(field, analysis.bytes) : '超出当前报文'}</code>
                  </button>
                  <button type="button" aria-label={`删除 ${field.name}`} onClick={() => deleteCustomField(field.id)}>删除</button>
                </article>
              );
            })}
          </div>
        ) : (
          <div className={styles.emptyCustom}><i>＋</i><span>还没有自定义字段。未知载荷不会被自动命名，等你按协议文档来定义。</span></div>
        )}
      </section>
    </section>
  );
}

function SummaryCard({ label, value, detail, tone = 'teal' }: { label: string; value: string; detail: string; tone?: string }) {
  return <article className={styles.summaryCard} data-tone={tone}><span>{label}</span><strong>{value}</strong><small>{detail}</small></article>;
}

function confidenceLabel(value: PacketAnalysis['confidence']) {
  if (typeof value === 'number') {
    const percent = value <= 1 ? Math.round(value * 100) : Math.round(value);
    if (percent >= 80) return { label: `高 · ${percent}%`, detail: '结构特征明确', tone: 'teal' };
    if (percent >= 50) return { label: `中 · ${percent}%`, detail: '手动指定起点或存在结构提示', tone: 'gold' };
    return { label: `低 · ${percent}%`, detail: '需要手动指定起点', tone: 'rose' };
  }
  const normalized = value.toLocaleLowerCase('en-US');
  if (normalized === 'high') return { label: '高', detail: '结构特征明确', tone: 'teal' };
  if (normalized === 'medium') return { label: '中', detail: '存在长度或截断提示', tone: 'gold' };
  return { label: '低', detail: '未对未知内容作猜测', tone: 'rose' };
}

function toOffset(value: number, byteCount: number) {
  const width = Math.max(4, Math.ceil(Math.log2(Math.max(1, byteCount)) / 4));
  return Math.max(0, value).toString(16).toUpperCase().padStart(width, '0');
}

function formatRange(offset: number, length: number, byteCount: number) {
  if (length <= 0) return `0x${toOffset(offset, byteCount)}`;
  const end = offset + length - 1;
  return `0x${toOffset(offset, byteCount)}–0x${toOffset(end, byteCount)} · ${length} B`;
}

function layerIndexAt(analysis: PacketAnalysis, offset: number) {
  let match = -1;
  analysis.layers.forEach((layer, index) => {
    if (offset >= layer.offset && offset < layer.offset + layer.length) match = index;
  });
  return match;
}

function asciiText(bytes: number[]) {
  return bytes.map((value) => (value >= 32 && value <= 126 ? String.fromCharCode(value) : '·')).join('').padEnd(16, ' ');
}

function hexSlice(bytes: number[], offset: number, length: number, max: number) {
  const safeOffset = Math.max(0, Math.min(offset, bytes.length));
  const safeLength = Math.max(0, Math.min(length, bytes.length - safeOffset));
  const shown = bytes.slice(safeOffset, safeOffset + Math.min(safeLength, max));
  const value = shown.map((byte) => byte.toString(16).toUpperCase().padStart(2, '0')).join(' ');
  return safeLength > max ? `${value} …` : value || '—';
}

function layerName(analysis: PacketAnalysis, id: string) {
  return analysis.layers.find((layer) => layer.id === id || layer.name === id)?.name ?? id;
}

/** Native identifiers remain stable while the workbench presents Chinese labels. */
function displayFieldName(name: string) {
  const labels: Record<string, string> = {
    data: '数据',
    source: '源地址',
    destination: '目标地址',
    sourcePort: '源端口',
    destinationPort: '目标端口',
    sequenceNumber: '序列号',
    acknowledgmentNumber: '确认号',
    headerLength: '首部长度',
    flags: '标志',
    window: '窗口',
    checksum: '校验和',
    urgentPointer: '紧急指针',
    options: '选项',
    length: '长度',
    type: '类型',
    code: '代码',
    version: '版本',
    dscpEcn: 'DSCP / ECN',
    totalLength: '总长度',
    identification: '标识',
    fragment: '标志 / 分片偏移',
    ttl: 'TTL',
    protocol: '上层协议',
    headerChecksum: '首部校验和',
    trafficClassAndFlowLabel: '流量类别 / 流标签',
    payloadLength: '载荷长度',
    nextHeader: '下一个首部',
    hopLimit: '跳数限制',
    hardwareType: '硬件类型',
    protocolType: '协议类型',
    hardwareAddressLength: '硬件地址长度',
    protocolAddressLength: '协议地址长度',
    operation: '操作码',
    senderHardwareAddress: '发送方硬件地址',
    senderProtocolAddress: '发送方协议地址',
    targetHardwareAddress: '目标硬件地址',
    targetProtocolAddress: '目标协议地址',
    etherType: 'EtherType',
    tagControl: '标签控制信息',
  };
  return labels[name] ?? name;
}

function customFieldValue(field: CustomField, bytes: number[]) {
  const selected = bytes.slice(field.offset, field.offset + field.length);
  if (field.type === 'hex') return selected.map((byte) => byte.toString(16).toUpperCase().padStart(2, '0')).join(' ');
  if (field.type === 'string') {
    const decoded = new TextDecoder('utf-8').decode(Uint8Array.from(selected));
    return decoded.replace(/[\u0000-\u001f\u007f]/g, '·') || '空文本';
  }
  const ordered = field.endian === 'little' ? [...selected].reverse() : selected;
  const value = ordered.reduce((current, byte) => (current << 8n) | BigInt(byte), 0n);
  return `${value.toString()} · 0x${value.toString(16).toUpperCase()}`;
}

function loadCustomFields(): CustomField[] {
  try {
    const raw = window.localStorage.getItem(CUSTOM_FIELDS_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((field): field is CustomField => Boolean(
      field && typeof field === 'object'
      && typeof (field as CustomField).id === 'string'
      && typeof (field as CustomField).name === 'string'
      && Number.isInteger((field as CustomField).offset)
      && Number.isInteger((field as CustomField).length)
      && ['hex', 'uint', 'string'].includes((field as CustomField).type)
      && ['big', 'little'].includes((field as CustomField).endian),
    ));
  } catch {
    return [];
  }
}
