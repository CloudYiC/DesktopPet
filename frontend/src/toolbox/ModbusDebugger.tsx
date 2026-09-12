import { useCallback, useEffect, useRef, useState } from 'react';
import { isNativeHost } from '../bridge/hostBridge';
import { isModbusWrite, modbusCall, modbusFunctions, modbusProtocolAddress, modbusQuantityLimit, modbusReference,
  type ModbusConnection, type ModbusLog, type ModbusPoll, type ModbusRequest, type ModbusResult, type ModbusSnapshot } from '../bridge/modbusBridge';
import { ToolWorkspaceHeader } from '../../../shared/tool-workspace/ToolWorkspaceHeader';
import type { ToolDefinition } from './catalog';
import styles from './ModbusDebugger.module.scss';

const initial: ModbusSnapshot = { state: 'stopped', transport: 'tcp', pending: false, error: '', result: null };
const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);
const time = (value: number) => new Date(value).toLocaleTimeString('zh-CN', { hour12: false }) + '.' + String(value % 1000).padStart(3, '0');
const hex = (value: number) => '0x' + value.toString(16).toUpperCase().padStart(4, '0');
interface WriteConfirmation extends ModbusRequest { endpoint: string; unitId: number; transport: 'tcp' | 'rtu' }

/** Device requests stay single-flight. Polling never repeats writes, and a write
 * confirmation captures an immutable complete request rather than live inputs. */
export function ModbusDebugger({ tool, onBack }: { tool: ToolDefinition; onBack(): void }) {
  const [connection, setConnection] = useState<ModbusConnection>({ transport: 'tcp', host: '127.0.0.1', port: 502, serialPort: 'COM1', baudRate: 9600, dataBits: 8, parity: 'even', stopBits: 1, unitId: 1, timeoutMs: 1000, retries: 0 });
  const [snapshot, setSnapshot] = useState(initial), [result, setResult] = useState<ModbusResult | null>(null);
  const [logs, setLogs] = useState<ModbusLog[]>([]), [ports, setPorts] = useState<string[]>([]);
  const [code, setCode] = useState(3), [address, setAddress] = useState('0'), [quantity, setQuantity] = useState('8');
  const [referenceMode, setReferenceMode] = useState(false), [writeValues, setWriteValues] = useState('0');
  const [allowWrite, setAllowWrite] = useState(false), [auto, setAuto] = useState(false), [interval, setIntervalMs] = useState('1000');
  const [signed, setSigned] = useState(false), [busy, setBusy] = useState(false), [feedback, setFeedback] = useState('');
  const [confirmation, setConfirmation] = useState<WriteConfirmation | null>(null);
  const modal = useRef<HTMLElement>(null), confirmationTrigger = useRef<HTMLElement | null>(null);
  const alive = useRef(true), commandBusy = useRef(false), revision = useRef(0), lastResult = useRef(0), logRegion = useRef<HTMLDivElement>(null);
  const connected = snapshot.state === 'connected', locked = busy || snapshot.pending || auto || Boolean(confirmation);
  const connectionLocked = !['stopped', 'error'].includes(snapshot.state) || busy;
  const write = isModbusWrite(code);
  const apply = useCallback((response: ModbusPoll) => {
    setSnapshot(response.snapshot);
    if (response.snapshot.result && response.snapshot.result.id !== lastResult.current) { lastResult.current = response.snapshot.result.id; setResult(response.snapshot.result); }
    if (response.logs?.length) setLogs((previous) => [...previous, ...response.logs!].slice(-256));
    if (response.snapshot.error) { setAuto(false); setFeedback(''); }
  }, []);
  useEffect(() => {
    alive.current = true;
    if (!isNativeHost) return () => { alive.current = false; };
    let cancelled = false, timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      const current = revision.current;
      if (!commandBusy.current) try {
        const response = await modbusCall<ModbusPoll>('poll');
        if (!cancelled && current === revision.current) apply(response);
      } catch (error) { if (!cancelled) { setFeedback(errorText(error)); setAuto(false); } }
      if (!cancelled) timer = setTimeout(poll, 150);
    };
    void poll();
    return () => { cancelled = true; alive.current = false; ++revision.current; clearTimeout(timer); void modbusCall('stop').catch(() => {}); };
  }, [apply]);
  useEffect(() => { if (logRegion.current) logRegion.current.scrollTop = logRegion.current.scrollHeight; }, [logs]);
  useEffect(() => {
    if (confirmation) modal.current?.querySelector<HTMLButtonElement>('button')?.focus();
    else if (confirmationTrigger.current) { confirmationTrigger.current.focus(); confirmationTrigger.current = null; }
  }, [confirmation]);
  const runCommand = useCallback(async (action: string, payload: object = {}) => {
    if (commandBusy.current) return;
    commandBusy.current = true; setBusy(true); setFeedback(''); const current = ++revision.current;
    try { const response = await modbusCall<ModbusPoll>(action, payload); if (alive.current && current === revision.current) apply(response); }
    catch (error) { if (alive.current && current === revision.current) { setFeedback(errorText(error)); setAuto(false); } }
    finally { commandBusy.current = false; if (alive.current) setBusy(false); }
  }, [apply]);
  const readRequest = (): ModbusRequest => {
    const offset = referenceMode ? modbusProtocolAddress(code, address) : Number(address);
    const count = Number(quantity);
    if (!address.trim() || !Number.isInteger(offset) || offset < 0 || offset > 65535) throw new Error('协议地址必须是 0–65535 的整数。');
    if (!quantity.trim() || !Number.isInteger(count) || count < 1 || count > modbusQuantityLimit(code) || offset + count > 65536) throw new Error(`数量需为 1–${modbusQuantityLimit(code)}，且地址范围不得超过 65535。`);
    const request: ModbusRequest = { functionCode: code, address: offset, quantity: count };
    if (write) {
      const tokens = writeValues.trim().split(/[\s,，;；]+/).filter(Boolean);
      const values = tokens.map((token) => /^(?:\d+|0x[\da-f]+)$/i.test(token) ? Number(token) : NaN);
      if (values.length !== count || values.some((value) => !Number.isInteger(value) || value < 0 || value > ([5, 15].includes(code) ? 1 : 65535)))
        throw new Error(`请填写恰好 ${count} 个${[5, 15].includes(code) ? '0 或 1' : '0–65535 整数（支持 0x Hex）'}，用空格或逗号分隔。`);
      request.values = values;
    }
    return request;
  };
  const execute = () => {
    if (!connected || commandBusy.current || snapshot.pending) return;
    try {
      const request = readRequest();
      if (write) { if (!allowWrite) throw new Error('请先开启“允许写入”，每次写入仍需确认。'); setAuto(false); confirmationTrigger.current = document.activeElement as HTMLElement; setConfirmation({ ...request, endpoint: snapshot.endpoint || '', unitId: snapshot.unitId ?? connection.unitId, transport: connection.transport }); }
      else { setResult(null); void runCommand('request', request); }
    } catch (error) { setAuto(false); setFeedback(errorText(error)); }
  };
  const executeRef = useRef(execute); executeRef.current = execute;
  useEffect(() => {
    if (!auto || !connected || busy || snapshot.pending || write) return;
    const delay = Number(interval);
    if (!Number.isInteger(delay) || delay < 100 || delay > 60000) { setAuto(false); setFeedback('轮询间隔必须为 100–60000 毫秒。'); return; }
    const timer = setTimeout(() => executeRef.current(), delay); return () => clearTimeout(timer);
  }, [auto, connected, busy, snapshot.pending, snapshot.result?.id, interval, write]);
  const edit = () => { setResult(null); setFeedback(''); };
  const copy = async (text: string) => { try { await navigator.clipboard.writeText(text); if (alive.current) setFeedback('已复制。'); } catch { if (alive.current) setFeedback('复制失败，请检查剪贴板权限。'); } };
  let reference = '—'; try {
    const offset = referenceMode ? modbusProtocolAddress(code, address) : Number(address), count = Number(quantity);
    if (address.trim() && Number.isInteger(offset) && offset >= 0 && offset <= 65535 && Number.isInteger(count) && count > 0 && offset + count <= 65536)
      reference = `${modbusReference(code, offset)}–${modbusReference(code, offset + count - 1)}`;
  } catch { /* Invalid fields are reported on execution. */ }
  const refreshPorts = async () => { try { const response = await modbusCall<{ ports: string[] }>('ports'); if (alive.current) { setPorts(response.ports); if (!response.ports.length) setFeedback('未检测到串口，可手动填写 COM 名称。'); } } catch (error) { if (alive.current) setFeedback(errorText(error)); } };
  return <section className={styles.workspace} data-testid="modbus-workspace">
    <ToolWorkspaceHeader title={tool.name} onBack={onBack} />
    <section className={styles.connection} aria-label="Modbus 连接参数">
      <header><div className={styles.tabs} role="tablist" aria-label="Modbus 传输方式">{(['rtu', 'tcp'] as const).map((transport) => <button key={transport} role="tab" aria-selected={connection.transport === transport} disabled={connectionLocked} onClick={() => { setConnection({ ...connection, transport }); edit(); }}>Modbus {transport.toUpperCase()}</button>)}</div>
        <span className={connected ? styles.connected : styles.state}>{({ stopped: '未连接', connecting: '连接中…', connected: '已连接', stopping: '断开中…', error: '连接错误' })[snapshot.state]}</span>
        <details className={styles.advanced}><summary>超时与重试</summary><div><label>超时（ms）<input aria-label="请求超时毫秒" type="number" min="100" max="10000" value={connection.timeoutMs} disabled={connectionLocked} onChange={(e) => setConnection({ ...connection, timeoutMs: Number(e.target.value) })} /></label><label>读取重试<select aria-label="读取重试次数" value={connection.retries} disabled={connectionLocked} onChange={(e) => setConnection({ ...connection, retries: Number(e.target.value) })}>{[0, 1, 2].map((n) => <option key={n} value={n}>{n} 次</option>)}</select></label><small>写入不会自动重试。</small></div></details></header>
      <div className={`${styles.connectionFields} ${connection.transport === 'rtu' ? styles.rtuFields : ''}`}>
        {connection.transport === 'tcp' ? <><label>主机地址<input aria-label="Modbus 主机地址" value={connection.host} disabled={connectionLocked} onChange={(e) => setConnection({ ...connection, host: e.target.value })} placeholder="IPv4 / IPv6 地址" /></label><label>端口<input aria-label="Modbus TCP 端口" type="number" min="1" max="65535" value={connection.port} disabled={connectionLocked} onChange={(e) => setConnection({ ...connection, port: Number(e.target.value) })} /></label></> : <><label>串口<div className={styles.portPicker}><input aria-label="Modbus 串口" list="modbus-ports" value={connection.serialPort} disabled={connectionLocked} onChange={(e) => setConnection({ ...connection, serialPort: e.target.value.toUpperCase() })} /><datalist id="modbus-ports">{ports.map((port) => <option key={port} value={port} />)}</datalist><button aria-label="刷新 Modbus 串口" disabled={connectionLocked || !isNativeHost} onClick={() => void refreshPorts()}>↻</button></div></label><label>波特率<select aria-label="Modbus 波特率" value={connection.baudRate} disabled={connectionLocked} onChange={(e) => setConnection({ ...connection, baudRate: Number(e.target.value) })}>{[1200, 2400, 4800, 9600, 19200, 38400, 57600, 115200, 230400].map((n) => <option key={n}>{n}</option>)}</select></label><label>校验 / 数据位<select aria-label="Modbus 校验位" value={connection.parity} disabled={connectionLocked} onChange={(e) => setConnection({ ...connection, parity: e.target.value as ModbusConnection['parity'] })}><option value="even">Even / 8</option><option value="odd">Odd / 8</option><option value="none">None / 8</option></select></label><label>停止位<select aria-label="Modbus 停止位" value={connection.stopBits} disabled={connectionLocked} onChange={(e) => setConnection({ ...connection, stopBits: Number(e.target.value) as 1 | 2 })}><option value="1">1</option><option value="2">2</option></select></label></>}
        <label>设备 ID<input aria-label="Modbus 设备 ID" type="number" min="1" max="247" value={connection.unitId} disabled={connectionLocked} onChange={(e) => setConnection({ ...connection, unitId: Number(e.target.value) })} /></label>
        <button className={styles.primary} disabled={busy || snapshot.state === 'stopping' || !isNativeHost} onClick={() => { setAuto(false); setConfirmation(null); setAllowWrite(false); setResult(null); void runCommand(connectionLocked ? 'stop' : 'start', connectionLocked ? {} : connection); }}>{connectionLocked ? '断开连接' : '连接设备'}</button>
      </div>
    </section>
    <section className={styles.requestPanel} aria-label="Modbus 请求参数"><div className={styles.requestFields}>
      <label>功能码<select aria-label="Modbus 功能码" value={code} disabled={locked} onChange={(e) => { const next = Number(e.target.value); setCode(next); setQuantity([5, 6].includes(next) ? '1' : '8'); if (referenceMode) setAddress(modbusReference(next, 0)); setAllowWrite(false); edit(); }}>{modbusFunctions.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
      <label>{referenceMode ? '参考编号' : '协议地址（0 起始）'}<input aria-label="Modbus 起始地址" value={address} disabled={locked} onChange={(e) => { setAddress(e.target.value); edit(); }} /></label>
      <label>数量<input aria-label="Modbus 数量" type="number" value={quantity} min="1" max={modbusQuantityLimit(code)} disabled={locked || [5, 6].includes(code)} onChange={(e) => { setQuantity(e.target.value); edit(); }} /></label>
      <label className={styles.poll}><span><input type="checkbox" aria-label="轮询读取" checked={auto} disabled={!connected || write || busy} onChange={(e) => setAuto(e.target.checked)} />轮询</span><input aria-label="轮询间隔毫秒" type="number" value={interval} min="100" max="60000" disabled={auto} onChange={(e) => setIntervalMs(e.target.value)} /><span>ms</span></label>
      <button className={styles.primary} disabled={!connected || busy || snapshot.pending || auto || (write && !allowWrite)} onClick={execute}>{snapshot.pending ? '等待响应…' : write ? '写入…' : '读取'}</button>
    </div><div className={styles.requestFooter}><span>参考编号 {reference}</span><label><input type="checkbox" checked={referenceMode} disabled={locked} onChange={(e) => { try { const value = referenceMode ? modbusProtocolAddress(code, address) : Number(address); if (e.target.checked && (value < 0 || value > 9998)) throw new Error('五位参考编号仅表示前 9999 个地址；较大地址请使用协议地址。'); setAddress(e.target.checked ? modbusReference(code, value) : String(value)); setReferenceMode(e.target.checked); edit(); } catch (error) { setFeedback(errorText(error)); } }} />按五位参考编号输入</label><label className={styles.allow}><input type="checkbox" aria-label="允许 Modbus 写入" checked={allowWrite} disabled={locked} onChange={(e) => setAllowWrite(e.target.checked)} />允许写入</label></div>
      {write && <label className={styles.writeValues}>写入值（空格或逗号分隔；线圈 0 / 1，寄存器 0–65535）<textarea aria-label="Modbus 写入值" value={writeValues} disabled={locked} onChange={(e) => { setWriteValues(e.target.value); edit(); }} /></label>}
    </section>
    <section className={styles.dataPanel}><header><h3>{result && [1, 2, 5, 15].includes(result.functionCode) ? '线圈 / 离散量数据' : '寄存器数据'}</h3><span>{result ? `${result.values.length} 项` : '尚无数据'}</span><select aria-label="寄存器数据显示" value={signed ? 'signed' : 'unsigned'} onChange={(e) => setSigned(e.target.value === 'signed')}><option value="unsigned">无符号 16 位</option><option value="signed">有符号 16 位</option></select><button disabled={!result} onClick={() => result && void copy(['协议地址\t参考编号\tHEX\t十进制', ...result.values.map((v, i) => `${result.address + i}\t${modbusReference(result.functionCode, result.address + i)}\t${hex(v)}\t${signed && v >= 32768 ? v - 65536 : v}`)].join('\n'))}>复制结果</button></header>
      <div className={styles.tableScroll} data-testid="modbus-data"><table><thead><tr><th>协议地址</th><th>参考编号</th><th>HEX</th><th>十进制</th><th>更新时间</th></tr></thead><tbody>{result?.values.map((value, index) => <tr key={index}><td>{result.address + index}</td><td>{modbusReference(result.functionCode, result.address + index)}</td><td><code>{hex(value)}</code></td><td>{signed && value >= 32768 ? value - 65536 : value}</td><td>{time(result.timestamp)}</td></tr>)}</tbody></table>{!result && <p className={styles.empty}>{!isNativeHost ? '设备通信仅限 Windows 客户端；浏览器不会模拟成功结果。' : snapshot.pending ? '等待设备响应…' : '连接设备后读取数据；协议地址从 0 开始。'}</p>}</div>
      <footer role={snapshot.error ? 'alert' : 'status'}>{snapshot.error || feedback || (result ? `${result.written ? '设备已确认写入' : '读取成功'} · ${result.elapsedMs} ms` : '01 / 02 / 03 / 04 读取 · 05 / 06 / 15 / 16 写入')}</footer>
    </section>
    <section className={styles.logPanel}><header><h3>原始报文</h3><button disabled={!logs.length} onClick={() => void copy(logs.map((line) => `${time(line.timestamp)} ${line.direction} ${line.hex} ${line.message}`).join('\n'))}>复制</button><button disabled={!logs.length} onClick={() => setLogs([])}>清空</button></header><div className={styles.log} role="log" aria-label="Modbus 原始报文" ref={logRegion}>{logs.length ? logs.map((line) => <div key={line.id}><b className={line.direction === 'TX' ? styles.tx : styles.rx}>{line.direction}</b><time>{time(line.timestamp)}</time><code>{line.hex || line.message}</code>{line.hex && line.message && <small>{line.message}</small>}</div>) : <p>连接后的收发字节显示在这里。</p>}</div></section>
    {confirmation && <div className={styles.modalBackdrop}><section ref={modal} role="dialog" aria-modal="true" aria-labelledby="modbus-write-title" className={styles.modal} onKeyDown={(e) => {
      if (e.key === 'Escape') { e.preventDefault(); setConfirmation(null); }
      if (e.key === 'Tab') {
        const controls = Array.from(e.currentTarget.querySelectorAll<HTMLButtonElement>('button:not(:disabled)'));
        const first = controls[0], last = controls[controls.length - 1];
        if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last?.focus(); }
        else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first?.focus(); }
      }
    }}><h3 id="modbus-write-title">确认写入设备？</h3><p>写入会修改实际设备。请核对目标、功能、地址和全部值；写入超时后不会自动重试。</p><dl><dt>目标</dt><dd>Modbus {confirmation.transport.toUpperCase()} · {confirmation.endpoint} · ID {confirmation.unitId}</dd><dt>功能</dt><dd>{modbusFunctions.find(([value]) => value === confirmation.functionCode)?.[1]}</dd><dt>协议地址 / 数量</dt><dd>{confirmation.address} / {confirmation.quantity}</dd><dt>全部写入值</dt><dd className={styles.confirmValues}>{confirmation.values?.join(', ')}</dd></dl><div><button onClick={() => setConfirmation(null)}>取消</button><button className={styles.danger} disabled={busy || !connected || !allowWrite} onClick={() => {
      const request: ModbusRequest = { functionCode: confirmation.functionCode, address: confirmation.address, quantity: confirmation.quantity, values: confirmation.values, confirmed: true };
      setConfirmation(null); setResult(null); void runCommand('request', request);
    }}>确认写入</button></div></section></div>}
  </section>;
}
