'use client'

import {
  useEffect,
  useMemo,
  useState,
  type CSSProperties,
  type FormEvent,
} from 'react'
import {
  inspectPacket,
  normalizePacketHex,
  type PacketField,
  type PacketInspection,
  type PacketMode,
} from '../../../lib/packetInspector'
import styles from './PacketInspector.module.scss'

type CustomFieldType = 'hex' | 'uint' | 'int' | 'ascii' | 'utf8'
type Endian = 'big' | 'little'

interface CustomField {
  id: string
  name: string
  offset: number
  length: number
  type: CustomFieldType
  endian: Endian
}

const CUSTOM_FIELDS_KEY = 'cloudyi.packet-inspector.custom-fields.v1'
const MAX_PACKET_BYTES = 64 * 1024
const MAX_RENDER_BYTES = 8 * 1024
const LAYER_COLORS = ['#15958f', '#497fc5', '#8d69c7', '#e78b55', '#d15b78', '#6f8d50']
const SAMPLE_DUMP = `0000  00 11 22 33 44 55 66 77 88 99 aa bb 08 00 45 00
0010  00 2c 1c 46 40 00 40 11 00 00 c0 a8 0b 66 c0 a8
0020  0b 9e 5f fc 5f f4 00 18 00 00 01 50 00 00 c0 a8
0030  0b 66 c0 a8 0b 9e 00 01 00 00`

const MODE_OPTIONS: Array<{ value: PacketMode; label: string; detail: string }> = [
  { value: 'auto', label: '自动判断', detail: '从完整帧或 IP 包起始识别' },
  { value: 'ethernet', label: 'Ethernet II', detail: '从以太网头开始' },
  { value: 'ipv4', label: 'IPv4', detail: '从 IPv4 头开始' },
  { value: 'ipv6', label: 'IPv6', detail: '从 IPv6 头开始' },
  { value: 'tcp', label: 'TCP', detail: '从 TCP 头开始' },
  { value: 'udp', label: 'UDP', detail: '从 UDP 头开始' },
  { value: 'raw', label: '原始载荷', detail: '不自动猜测' },
]

export function PacketInspector() {
  const [source, setSource] = useState(SAMPLE_DUMP)
  const [mode, setMode] = useState<PacketMode>('auto')
  const [selectedKey, setSelectedKey] = useState('field:0')
  const [customFields, setCustomFields] = useState<CustomField[]>([])
  const [draftName, setDraftName] = useState('消息类型')
  const [draftOffset, setDraftOffset] = useState('42')
  const [draftLength, setDraftLength] = useState('1')
  const [draftType, setDraftType] = useState<CustomFieldType>('uint')
  const [draftEndian, setDraftEndian] = useState<Endian>('big')
  const [customError, setCustomError] = useState<string | null>(null)

  useEffect(() => {
    try {
      const saved = localStorage.getItem(CUSTOM_FIELDS_KEY)
      if (!saved) return
      const value: unknown = JSON.parse(saved)
      if (Array.isArray(value)) {
        setCustomFields(value.filter(isCustomField))
      }
    } catch {
      // A damaged local preference must not prevent the analyzer from opening.
    }
  }, [])

  const parseState = useMemo(() => {
    try {
      const bytes = normalizePacketHex(source)
      if (bytes.length > MAX_PACKET_BYTES) {
        throw new Error(`当前输入 ${bytes.length} 字节，超过单次分析上限 ${MAX_PACKET_BYTES} 字节。`)
      }
      return { result: inspectPacket(bytes, mode), error: null }
    } catch (error) {
      return {
        result: inspectPacket([], mode),
        error: error instanceof Error ? error.message : '报文格式不正确。',
      }
    }
  }, [mode, source])

  const result = parseState.result
  const validCustomFields = customFields.filter((field) =>
    isCustomFieldUsable(field, result.byteCount),
  )
  const selectedRange = selectedRangeFor(selectedKey, result, validCustomFields)
  const headerBytes = result.layers
    .filter((layer) => layer.id !== 'payload' && layer.id !== 'trailing')
    .reduce((total, layer) => total + layer.length, 0)
  const payloadBytes = result.layers
    .filter((layer) => layer.id === 'payload')
    .reduce((total, layer) => total + layer.length, 0)

  function storeCustomFields(next: CustomField[]) {
    setCustomFields(next)
    try {
      localStorage.setItem(CUSTOM_FIELDS_KEY, JSON.stringify(next))
    } catch {
      setCustomError('当前浏览器禁止本地存储：字段已在本次页面生效，但关闭后不会保留。')
    }
  }

  function addCustomField(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const offset = Number.parseInt(draftOffset, 10)
    const length = Number.parseInt(draftLength, 10)
    if (!draftName.trim()) {
      setCustomError('请填写字段名称。')
      return
    }
    if (!Number.isInteger(offset) || !Number.isInteger(length) || offset < 0 || length < 1) {
      setCustomError('Offset 必须是非负整数，长度至少为 1。')
      return
    }
    if (offset + length > result.byteCount) {
      setCustomError(`字段结束于 ${offset + length}，但当前报文只有 ${result.byteCount} 字节。`)
      return
    }
    if ((draftType === 'uint' || draftType === 'int') && length > 8) {
      setCustomError('整数字段最长为 8 字节；更长内容请选择 Hex、ASCII 或 UTF-8。')
      return
    }
    const next: CustomField = {
      id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
      name: draftName.trim(),
      offset,
      length,
      type: draftType,
      endian: draftEndian,
    }
    storeCustomFields([...customFields, next])
    setSelectedKey(`custom:${next.id}`)
    setDraftOffset(String(offset + length))
    setCustomError(null)
  }

  return (
    <div className={styles.inspector}>
      <section className={styles.intro}>
        <div>
          <span className={styles.eyebrow}>PACKET MAP</span>
          <h2>从“一大串 Hex”看到每个字节的位置。</h2>
          <p>
            标准协议只在结构足够可靠时识别；自定义载荷保留为“未知”，由你定义字段。
          </p>
        </div>
        <span className={styles.localBadge}>● 仅在浏览器本地处理</span>
      </section>

      <section className={styles.inputPanel}>
        <div className={styles.panelHead}>
          <div>
            <span>INPUT</span>
            <h3>原始报文</h3>
          </div>
          <div className={styles.inputActions}>
            <button type="button" onClick={() => setSource(SAMPLE_DUMP)}>
              载入 UDP 示例
            </button>
            <button type="button" onClick={() => setSource('')}>
              清空
            </button>
          </div>
        </div>
        <div className={styles.inputGrid}>
          <label className={styles.sourceField}>
            <span>Hex / Wireshark hexdump</span>
            <textarea
              value={source}
              onChange={(event) => setSource(event.target.value)}
              spellCheck={false}
              placeholder="00 11 22 33 ... 或直接粘贴带 offset 的 Wireshark 转储"
            />
          </label>
          <label className={styles.modeField}>
            <span>起始协议</span>
            <select value={mode} onChange={(event) => setMode(event.target.value as PacketMode)}>
              {MODE_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
            <small>{MODE_OPTIONS.find((option) => option.value === mode)?.detail}</small>
          </label>
        </div>
        {parseState.error && <div className={styles.errorBanner}>{parseState.error}</div>}
      </section>

      <section className={styles.stats} aria-label="报文摘要">
        <Stat label="总长度" value={`${result.byteCount}`} unit="bytes" />
        <Stat label="已解析头部" value={`${headerBytes}`} unit="bytes" />
        <Stat label="未知载荷" value={`${payloadBytes}`} unit="bytes" />
        <Stat
          label="识别结果"
          value={result.protocol}
          unit={confidenceLabel(result.confidence)}
          compact
        />
      </section>

      {result.warnings.length > 0 && (
        <section className={styles.warningPanel} aria-label="解析提示">
          <strong>解析提示</strong>
          <div>
            {result.warnings.map((warning, index) => (
              <p key={`${warning.code}-${warning.offset ?? 'none'}-${index}`}>
                <span>{warning.offset === undefined ? '!' : `@${formatOffset(warning.offset)}`}</span>
                {warning.message}
              </p>
            ))}
          </div>
        </section>
      )}

      <div className={styles.analysisGrid}>
        <section className={styles.structurePanel}>
          <div className={styles.panelHead}>
            <div>
              <span>LAYERS &amp; FIELDS</span>
              <h3>协议结构</h3>
            </div>
            <small>点击字段可在右侧高亮</small>
          </div>
          {result.layers.length === 0 ? (
            <div className={styles.empty}>粘贴报文后，这里会显示协议层与字段。</div>
          ) : (
            <div className={styles.layerList}>
              {result.layers.map((layer, layerIndex) => {
                const fields = result.fields
                  .map((field, index) => ({ field, index }))
                  .filter((entry) => entry.field.layer === layer.id)
                return (
                  <article key={`${layer.id}-${layer.offset}`} className={styles.layerCard}>
                    <header>
                      <i style={{ background: LAYER_COLORS[layerIndex % LAYER_COLORS.length] }} />
                      <div>
                        <strong>{layer.name}</strong>
                        <small>{layer.summary}</small>
                      </div>
                      <code>
                        {formatOffset(layer.offset)} · {layer.length} B
                      </code>
                    </header>
                    {fields.length > 0 && (
                      <div className={styles.fieldList}>
                        {fields.map(({ field, index }) => (
                          <button
                            type="button"
                            key={`${field.layer}-${field.name}-${field.offset}`}
                            className={selectedKey === `field:${index}` ? styles.fieldActive : ''}
                            onClick={() => setSelectedKey(`field:${index}`)}
                          >
                            <span>
                              <strong>{field.name}</strong>
                              <small>{field.summary}</small>
                            </span>
                            <span>
                              <em>{field.value}</em>
                              <code>
                                +{field.offset} / {field.length} B
                              </code>
                            </span>
                          </button>
                        ))}
                      </div>
                    )}
                  </article>
                )
              })}
            </div>
          )}

          {validCustomFields.length > 0 && (
            <article className={`${styles.layerCard} ${styles.customLayer}`}>
              <header>
                <i style={{ background: '#e35e8d' }} />
                <div>
                  <strong>自定义协议模板</strong>
                  <small>你标记的业务字段，仅保存在本机</small>
                </div>
                <code>{validCustomFields.length} fields</code>
              </header>
              <div className={styles.fieldList}>
                {validCustomFields.map((field) => (
                  <button
                    type="button"
                    key={field.id}
                    className={selectedKey === `custom:${field.id}` ? styles.fieldActive : ''}
                    onClick={() => setSelectedKey(`custom:${field.id}`)}
                  >
                    <span>
                      <strong>{field.name}</strong>
                      <small>
                        {customTypeLabel(field.type)} ·{' '}
                        {isIntegerType(field.type)
                          ? field.endian === 'big'
                            ? '大端'
                            : '小端'
                          : '原始字节顺序'}
                      </small>
                    </span>
                    <span>
                      <em>{formatCustomValue(field, result.bytes)}</em>
                      <code>
                        +{field.offset} / {field.length} B
                      </code>
                    </span>
                  </button>
                ))}
              </div>
            </article>
          )}
        </section>

        <section className={styles.bytesPanel}>
          <div className={styles.panelHead}>
            <div>
              <span>BYTE MAP</span>
              <h3>字节视图</h3>
            </div>
            <small>16 bytes / row</small>
          </div>
          <div className={styles.hexHeader} aria-hidden="true">
            <span>OFFSET</span>
            <span>{Array.from({ length: 16 }, (_, index) => index.toString(16).toUpperCase()).join('  ')}</span>
            <span>ASCII</span>
          </div>
          {result.byteCount > MAX_RENDER_BYTES && (
            <div className={styles.renderLimit}>
              报文共 {result.byteCount} 字节。为保持页面流畅，字节图仅显示前 {MAX_RENDER_BYTES}{' '}
              字节，长度统计与头部解析仍基于完整输入。
            </div>
          )}
          <div className={styles.byteRows}>
            {chunkBytes(result.bytes.slice(0, MAX_RENDER_BYTES), 16).map((row, rowIndex) => {
              const rowOffset = rowIndex * 16
              return (
                <div className={styles.byteRow} key={rowOffset}>
                  <code className={styles.rowOffset}>{formatOffset(rowOffset)}</code>
                  <div className={styles.byteCells}>
                    {Array.from({ length: 16 }, (_, column) => {
                      const byteOffset = rowOffset + column
                      const value = row[column]
                      if (value === undefined) return <span key={column} className={styles.byteBlank} />
                      const layerIndex = findLayerIndex(result, byteOffset)
                      const selected =
                        selectedRange !== null &&
                        byteOffset >= selectedRange.offset &&
                        byteOffset < selectedRange.offset + selectedRange.length
                      const byteStyle = {
                        '--byte-color':
                          layerIndex >= 0 ? LAYER_COLORS[layerIndex % LAYER_COLORS.length] : '#8da09a',
                      } as CSSProperties
                      return (
                        <button
                          type="button"
                          key={column}
                          className={`${styles.byteCell} ${selected ? styles.byteSelected : ''}`}
                          style={byteStyle}
                          title={`Offset ${byteOffset} (0x${formatOffset(byteOffset)}) = 0x${hexByte(value)}`}
                          onClick={() => {
                            setDraftOffset(String(byteOffset))
                            setDraftLength('1')
                          }}
                        >
                          {hexByte(value)}
                        </button>
                      )
                    })}
                  </div>
                  <code className={styles.ascii}>{row.map(asciiChar).join('')}</code>
                </div>
              )
            })}
            {result.byteCount === 0 && <div className={styles.empty}>暂无字节。</div>}
          </div>
          <div className={styles.legend}>
            {result.layers.map((layer, index) => (
              <span key={`${layer.id}-${layer.offset}`}>
                <i style={{ background: LAYER_COLORS[index % LAYER_COLORS.length] }} />
                {layer.name}
              </span>
            ))}
            <span className={styles.selectedLegend}>
              <i />当前字段
            </span>
          </div>
        </section>
      </div>

      <section className={styles.customPanel}>
        <div className={styles.panelHead}>
          <div>
            <span>CUSTOM PROTOCOL</span>
            <h3>定义你自己的字段</h3>
          </div>
          <small>不写死某一种私有协议，模板保存到 localStorage</small>
        </div>
        <form className={styles.customForm} onSubmit={addCustomField}>
          <label>
            <span>字段名称</span>
            <input value={draftName} onChange={(event) => setDraftName(event.target.value)} />
          </label>
          <label>
            <span>Offset（十进制）</span>
            <input
              type="number"
              min="0"
              value={draftOffset}
              onChange={(event) => setDraftOffset(event.target.value)}
            />
          </label>
          <label>
            <span>长度（字节）</span>
            <input
              type="number"
              min="1"
              value={draftLength}
              onChange={(event) => setDraftLength(event.target.value)}
            />
          </label>
          <label>
            <span>类型</span>
            <select value={draftType} onChange={(event) => setDraftType(event.target.value as CustomFieldType)}>
              <option value="hex">Hex</option>
              <option value="uint">无符号整数</option>
              <option value="int">有符号整数</option>
              <option value="ascii">ASCII</option>
              <option value="utf8">UTF-8</option>
            </select>
          </label>
          <label>
            <span>字节序（仅整数）</span>
            <select value={draftEndian} onChange={(event) => setDraftEndian(event.target.value as Endian)}>
              <option value="big">大端 Big-endian</option>
              <option value="little">小端 Little-endian</option>
            </select>
          </label>
          <button type="submit" className={styles.addButton}>
            + 添加字段
          </button>
        </form>
        {customError && <div className={styles.errorBanner}>{customError}</div>}
        <div className={styles.savedFields}>
          {customFields.map((field) => {
            const valid = isCustomFieldUsable(field, result.byteCount)
            return (
              <div key={field.id} className={!valid ? styles.savedInvalid : ''}>
                <span>
                  <strong>{field.name}</strong>
                  <small>
                    [{field.offset}..{field.offset + field.length - 1}] · {customTypeLabel(field.type)} ·{' '}
                    {valid ? formatCustomValue(field, result.bytes) : '当前报文越界'}
                  </small>
                </span>
                <button
                  type="button"
                  onClick={() => storeCustomFields(customFields.filter((item) => item.id !== field.id))}
                >
                  删除
                </button>
              </div>
            )
          })}
          {customFields.length === 0 && (
            <p className={styles.templateHint}>
              例如：你知道 UDP 载荷第 1 字节是“消息类型”，就填 Offset 42、长度 1。
            </p>
          )}
        </div>
      </section>
    </div>
  )
}

function Stat({
  label,
  value,
  unit,
  compact = false,
}: {
  label: string
  value: string
  unit: string
  compact?: boolean
}) {
  return (
    <article className={`${styles.stat} ${compact ? styles.statCompact : ''}`}>
      <span>{label}</span>
      <strong>{value}</strong>
      <small>{unit}</small>
    </article>
  )
}

function isCustomField(value: unknown): value is CustomField {
  if (!value || typeof value !== 'object') return false
  const field = value as Partial<CustomField>
  return (
    typeof field.id === 'string' &&
    typeof field.name === 'string' &&
    Number.isInteger(field.offset) &&
    Number.isInteger(field.length) &&
    ['hex', 'uint', 'int', 'ascii', 'utf8'].includes(field.type ?? '') &&
    (field.endian === 'big' || field.endian === 'little')
  )
}

function selectedRangeFor(
  key: string,
  result: PacketInspection,
  customFields: CustomField[],
): { offset: number; length: number } | null {
  if (key.startsWith('field:')) {
    const field = result.fields[Number.parseInt(key.slice(6), 10)]
    return field ? { offset: field.offset, length: field.length } : null
  }
  if (key.startsWith('custom:')) {
    const field = customFields.find((item) => item.id === key.slice(7))
    return field ? { offset: field.offset, length: field.length } : null
  }
  return null
}

function findLayerIndex(result: PacketInspection, offset: number): number {
  return result.layers.findIndex(
    (layer) => offset >= layer.offset && offset < layer.offset + layer.length,
  )
}

function chunkBytes(bytes: number[], size: number): number[][] {
  const rows: number[][] = []
  for (let offset = 0; offset < bytes.length; offset += size) rows.push(bytes.slice(offset, offset + size))
  return rows
}

function formatCustomValue(field: CustomField, bytes: number[]): string {
  const source = bytes.slice(field.offset, field.offset + field.length)
  if (field.type === 'hex') return source.map(hexByte).join(' ')
  if (field.type === 'ascii') return source.map(asciiChar).join('')
  if (field.type === 'utf8') {
    try {
      return new TextDecoder('utf-8', { fatal: true }).decode(Uint8Array.from(source))
    } catch {
      return '无效 UTF-8'
    }
  }
  const ordered = field.endian === 'little' ? [...source].reverse() : source
  if (ordered.length > 8) return '整数字段最多 8 字节'
  let value = ordered.reduce((total, byte) => (total << 8n) | BigInt(byte), 0n)
  if (field.type === 'int' && ordered.length > 0 && (ordered[0] & 0x80) !== 0) {
    value -= 1n << BigInt(ordered.length * 8)
  }
  return value.toString(10)
}

function isIntegerType(type: CustomFieldType): boolean {
  return type === 'uint' || type === 'int'
}

function isCustomFieldUsable(field: CustomField, byteCount: number): boolean {
  const integerTooWide = (field.type === 'uint' || field.type === 'int') && field.length > 8
  return field.offset >= 0 && field.length > 0 && field.offset + field.length <= byteCount && !integerTooWide
}

function confidenceLabel(confidence: PacketInspection['confidence']): string {
  if (confidence === 'high') return '高可信'
  if (confidence === 'medium') return '手动起始 / 中等可信'
  return '未知 / 低可信'
}

function customTypeLabel(type: CustomFieldType): string {
  const labels: Record<CustomFieldType, string> = {
    hex: 'Hex',
    uint: '无符号整数',
    int: '有符号整数',
    ascii: 'ASCII',
    utf8: 'UTF-8',
  }
  return labels[type]
}

function formatOffset(offset: number): string {
  return offset.toString(16).padStart(4, '0').toUpperCase()
}

function hexByte(value: number): string {
  return value.toString(16).padStart(2, '0').toUpperCase()
}

function asciiChar(value: number): string {
  return value >= 32 && value <= 126 ? String.fromCharCode(value) : '·'
}
