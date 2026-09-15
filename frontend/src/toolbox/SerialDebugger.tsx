import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { ToolWorkspaceHeader } from '../../../shared/tool-workspace/ToolWorkspaceHeader';
import { ActionToast, useActionToast } from '../../../shared/tool-workspace/ActionToast';
import type { ToolDefinition } from './catalog';
import { isNativeHost } from '../bridge/hostBridge';
import { enumerateSerial, pollSerial, sendSerial, serialPayload, startSerial, stopSerial, type SerialEvent, type SerialOptions, type SerialPort, type SerialSnapshot } from '../bridge/serialBridge';
import styles from './SerialDebugger.module.scss';

type DisplayEvent = SerialEvent & { text: string };
const defaults: SerialOptions = { port: '', baud: 115200, dataBits: 8, parity: 0, stopBits: 0, flowControl: 0, dtr: true, rts: true };
const stateLabels = { stopped: '未打开', opening: '打开中', open: '已打开', stopping: '关闭中', error: '连接错误' };
const decodeHex = (hex: string) => Uint8Array.from(hex.match(/../g) ?? [], (value) => parseInt(value, 16));
const timeText = (time: number) => `${new Date(time).toLocaleTimeString('zh-CN', { hour12: false })}.${String(time % 1000).padStart(3, '0')}`;
const errorText = (error: unknown) => error instanceof Error ? error.message : '操作失败，请重试。';

/** Exclusive desktop COM workbench. React only prepares bytes; Win32 owns IO off-thread. */
export function SerialDebugger({ tool, onBack }: { tool: ToolDefinition; onBack(): void }) {
  const [options, setOptions] = useState<SerialOptions>(defaults);
  const [ports, setPorts] = useState<SerialPort[]>([]);
  const [snapshot, setSnapshot] = useState<SerialSnapshot | null>(null);
  const [events, setEvents] = useState<DisplayEvent[]>([]);
  const [connectionError, setConnectionError] = useState('');
  const [connectionNotice, setConnectionNotice] = useState(isNativeHost ? '' : '串口功能仅在 Windows 桌面客户端可用。');
  const [sendError, setSendError] = useState('');
  const [recordError, setRecordError] = useState('');
  const { toast, notify, dismiss } = useActionToast();
  const lastNativeError = useRef('');
  const [busy, setBusy] = useState(false);
  const [enumerating, setEnumerating] = useState(false);
  const [sending, setSending] = useState(false);
  const [advanced, setAdvanced] = useState(false);
  const [receiveMode, setReceiveMode] = useState<'text' | 'hex'>('text');
  const [sendMode, setSendMode] = useState<'text' | 'hex'>('text');
  const [draft, setDraft] = useState('HELLO');
  const [ending, setEnding] = useState<'none' | 'cr' | 'lf' | 'crlf'>('none');
  const [showTime, setShowTime] = useState(true);
  const [follow, setFollow] = useState(true);
  const [repeat, setRepeat] = useState(false);
  const [interval, setIntervalValue] = useState('1000');
  const alive = useRef(0);
  const command = useRef(false);
  const txPending = useRef(false);
  const enumeratePending = useRef<number | null>(null);
  const sessionRevision = useRef(0);
  const log = useRef<HTMLDivElement>(null);
  const tail = useRef(true);
  const lastEvent = useRef(0);
  const decoders = useRef({ rx: new TextDecoder('utf-8'), tx: new TextDecoder('utf-8') });
  const state = snapshot?.state ?? 'stopped';
  const active = ['opening', 'open', 'stopping'].includes(state);
  const locked = busy || active;
  const ready = state === 'open';
  const encoded = useMemo(() => {
    try { return { ...serialPayload(draft, sendMode, ending), error: '' }; }
    catch (reason) { return { hex: '', count: 0, error: errorText(reason) }; }
  }, [draft, sendMode, ending]);
  const intervalValid = /^\d+$/.test(interval) && Number(interval) >= 50 && Number(interval) <= 3600000;

  const refresh = async () => {
    const generation = alive.current;
    if (!isNativeHost || enumeratePending.current === generation) return;
    enumeratePending.current = generation; setEnumerating(true);
    try {
      const result = await enumerateSerial();
      if (generation !== alive.current) return;
      const sorted = result.ports.sort((a, b) => Number(a.port.slice(3)) - Number(b.port.slice(3)));
      setPorts(sorted);
      setOptions((current) => ({ ...current, port: current.port && sorted.some((entry) => entry.port === current.port) ? current.port : sorted[0]?.port ?? '' }));
      setConnectionNotice(sorted.length ? '' : '未找到串口，请连接设备后刷新。');
    } catch (reason) { if (generation === alive.current) setConnectionError(errorText(reason)); }
    finally { if (enumeratePending.current === generation) enumeratePending.current = null; if (generation === alive.current) setEnumerating(false); }
  };

  useEffect(() => {
    const generation = ++alive.current;
    let disposed = false;
    let timer = 0;
    void refresh();
    const poll = async () => {
      if (disposed || !isNativeHost) return;
      const revision = sessionRevision.current;
      try {
        const result = await pollSerial();
        if (disposed || generation !== alive.current) return;
        if (revision !== sessionRevision.current) { timer = window.setTimeout(poll, 50); return; }
        setSnapshot(result.snapshot);
        const nativeError = result.snapshot.state === 'error' ? result.snapshot.lastError || '串口已断开。' : '';
        if (nativeError && nativeError !== lastNativeError.current) setConnectionError(nativeError);
        lastNativeError.current = nativeError;
        const incoming: DisplayEvent[] = [];
        for (const event of result.events) {
          if (event.id <= lastEvent.current) continue;
          lastEvent.current = event.id;
          const text = event.kind === 'rx' || event.kind === 'tx'
            ? decoders.current[event.kind].decode(decodeHex(event.dataHex), { stream: true }) : event.message;
          incoming.push({ ...event, text });
        }
        if (incoming.length) setEvents((old) => {
          const all = [...old, ...incoming];
          let size = 0, begin = all.length;
          while (begin > 0 && all.length - begin < 1500 && size + all[begin - 1].dataHex.length + all[begin - 1].text.length <= 2097152) {
            begin -= 1; size += all[begin].dataHex.length + all[begin].text.length;
          }
          return all.slice(begin);
        });
      } catch (reason) { if (!disposed) { setConnectionError(errorText(reason)); setRepeat(false); } }
      if (!disposed) timer = window.setTimeout(poll, 150);
    };
    void poll();
    return () => {
      disposed = true; alive.current += 1; window.clearTimeout(timer);
      if (isNativeHost) void stopSerial().catch(() => undefined);
    };
  }, []);

  useLayoutEffect(() => { if (follow && tail.current && log.current) log.current.scrollTop = log.current.scrollHeight; }, [events, follow, receiveMode, showTime]);
  useEffect(() => { if (!ready || encoded.error || !intervalValid) setRepeat(false); }, [ready, encoded.error, intervalValid]);

  const send = async () => {
    if (!ready || txPending.current || encoded.error) return;
    txPending.current = true; setSending(true);
    const generation = alive.current;
    try { await sendSerial(encoded.hex); if (generation === alive.current) setSendError(''); }
    catch (reason) { if (generation === alive.current) { setSendError(errorText(reason)); setRepeat(false); } }
    finally { txPending.current = false; if (generation === alive.current) setSending(false); }
  };
  useEffect(() => {
    if (!repeat || !ready || !intervalValid || encoded.error) return;
    const timer = window.setInterval(() => void send(), Number(interval));
    return () => window.clearInterval(timer);
  }, [repeat, ready, interval, encoded.hex]);

  const toggle = async () => {
    if (command.current || !isNativeHost) return;
    command.current = true; setBusy(true); setConnectionError(''); setConnectionNotice(''); setRepeat(false);
    sessionRevision.current += 1;
    const generation = alive.current;
    try {
      if (active) { const result = await stopSerial(); if (generation === alive.current) setSnapshot(result.snapshot); }
      else {
        if (!options.port) throw new Error('请选择可用串口。');
        decoders.current = { rx: new TextDecoder('utf-8'), tx: new TextDecoder('utf-8') };
        const result = await startSerial(options);
        if (generation === alive.current) { setEvents([]); setSnapshot(result.snapshot); }
      }
    } catch (reason) { if (generation === alive.current) setConnectionError(errorText(reason)); }
    finally { command.current = false; if (generation === alive.current) setBusy(false); }
  };
  const update = (key: keyof SerialOptions, value: string | number | boolean) => { setOptions((old) => ({ ...old, [key]: value })); };
  const copy = async () => {
    const generation = alive.current;
    try {
      await navigator.clipboard.writeText(events.map((event) => `${showTime ? timeText(event.timestamp) + ' ' : ''}${event.kind.toUpperCase()} ${receiveMode === 'hex' && event.dataHex ? event.dataHex.match(/../g)?.join(' ').toUpperCase() : event.text}`).join('\n'));
      if (generation === alive.current) { setRecordError(''); notify('收发记录已复制。'); }
    } catch { if (generation === alive.current) setRecordError('复制失败，请检查剪贴板权限。'); }
  };

  return <section className={styles.workspace} data-testid="serial-workspace" onKeyDown={(event) => {
    if ((event.ctrlKey || event.metaKey) && event.key === 'Enter' && !event.repeat) { event.preventDefault(); void send(); }
  }}>
    <ToolWorkspaceHeader title={tool.name} onBack={onBack} />
    <div className={styles.split}>
    <div className={styles.controls} data-testid="serial-controls">
    <section className={styles.connection} aria-label="串口连接参数">
      <div className={styles.fields}>
        <label className={styles.port}><span>串口</span><div><select aria-label="串口" value={options.port} disabled={locked || !isNativeHost} onChange={(event) => update('port', event.target.value)}><option value="">{ports.length ? '请选择' : '无可用串口'}</option>{ports.map((port) => <option key={port.port} value={port.port}>{port.port}</option>)}</select><button type="button" aria-label="刷新串口" title="刷新串口" disabled={locked || enumerating || !isNativeHost} onClick={() => void refresh()}>↻</button></div></label>
        <label><span>波特率</span><select aria-label="波特率" disabled={locked} value={options.baud} onChange={(event) => update('baud', Number(event.target.value))}>{[300,600,1200,2400,4800,9600,14400,19200,38400,57600,115200,230400,460800,921600,1000000,2000000].map((rate) => <option key={rate}>{rate}</option>)}</select></label>
        <label><span>数据位</span><select aria-label="数据位" disabled={locked} value={options.dataBits} onChange={(event) => update('dataBits', Number(event.target.value))}>{[5,6,7,8].map((bits) => <option key={bits}>{bits}</option>)}</select></label>
        <label><span>校验位</span><select aria-label="校验位" disabled={locked} value={options.parity} onChange={(event) => update('parity', Number(event.target.value))}>{['无','奇校验','偶校验','标记','空格'].map((label, value) => <option key={label} value={value}>{label}</option>)}</select></label>
        <label><span>停止位</span><select aria-label="停止位" disabled={locked} value={options.stopBits} onChange={(event) => update('stopBits', Number(event.target.value))}><option value={0}>1</option><option value={1}>1.5</option><option value={2}>2</option></select></label>
        <label><span>流控</span><select aria-label="流控" disabled={locked} value={options.flowControl} onChange={(event) => update('flowControl', Number(event.target.value))}><option value={0}>无</option><option value={1}>RTS/CTS</option><option value={2}>XON/XOFF</option></select></label>
        <button className={styles.connect} type="button" disabled={busy || state === 'stopping' || (!active && (!options.port || !isNativeHost))} onClick={() => void toggle()}>{busy ? '处理中…' : active ? '关闭串口' : '打开串口'}</button>
      </div>
      <div className={styles.connectionStatus}><strong className={ready ? styles.connected : ''}>● {stateLabels[state]}{snapshot?.port ? ` · ${snapshot.port}` : ''}</strong><span>{options.baud} · {options.dataBits}{['N','O','E','M','S'][options.parity]}{['1','1.5','2'][options.stopBits]}</span><span className={styles.counters}>接收 {snapshot?.rxBytes ?? 0} B　发送 {snapshot?.txBytes ?? 0} B</span><button type="button" aria-expanded={advanced} onClick={() => setAdvanced(!advanced)}>高级设置 {advanced ? '⌃' : '⌄'}</button></div>
      {advanced && <div className={styles.advanced}><label><input type="checkbox" checked={options.dtr} disabled={locked} onChange={(event) => update('dtr', event.target.checked)} />DTR</label><label><input type="checkbox" checked={options.rts} disabled={locked || options.flowControl === 1} onChange={(event) => update('rts', event.target.checked)} />RTS</label><span>{options.flowControl === 1 ? 'RTS 由硬件流控管理' : 'DTR/RTS 电平在打开时应用'}</span></div>}
      {(connectionError || connectionNotice) && <p className={connectionError ? styles.error : styles.notice} role={connectionError ? 'alert' : 'status'} data-testid="serial-connection-feedback">{connectionError || connectionNotice}</p>}
    </section>
    <section className={styles.sendPanel} aria-label="串口发送数据">
      <header><h3>发送数据</h3><div className={styles.sendMode}><div className={styles.segmented}><button type="button" aria-pressed={sendMode === 'text'} onClick={() => { setSendMode('text'); setRepeat(false); }}>文本</button><button type="button" aria-pressed={sendMode === 'hex'} onClick={() => { setSendMode('hex'); setRepeat(false); }}>HEX</button></div><span>{encoded.count} 字节</span></div></header>
      <textarea aria-label="串口发送内容" value={draft} spellCheck={false} onChange={(event) => { setDraft(event.target.value); setRepeat(false); }} />
      <div className={styles.sendActions}>
        <label className={styles.ending}>行尾<select aria-label="串口行尾" value={ending} disabled={sendMode === 'hex'} onChange={(event) => { setEnding(event.target.value as typeof ending); setRepeat(false); }}><option value="none">不添加</option><option value="cr">CR</option><option value="lf">LF</option><option value="crlf">CRLF</option></select></label>
        <div className={styles.repeatControl}><label><input type="checkbox" checked={repeat} disabled={!ready || !!encoded.error || !intervalValid} onChange={(event) => setRepeat(event.target.checked)} />循环发送</label><label className={styles.interval}><input type="number" aria-label="串口循环间隔" min="50" max="3600000" value={interval} onChange={(event) => { setIntervalValue(event.target.value); setRepeat(false); }} />ms</label></div>
        <button className={styles.sendButton} type="button" disabled={!ready || !!encoded.error || sending} onClick={() => void send()}>{sending ? '发送中…' : '发送'}<kbd>Ctrl Enter</kbd></button>
      </div>
      {(sendError || encoded.error || !intervalValid) && <p className={styles.error} role="alert" data-testid="serial-send-feedback">{encoded.error || (!intervalValid ? '循环间隔须为 50–3600000 毫秒。' : '') || sendError}</p>}
    </section>
    </div>
    <section className={styles.logPanel} data-testid="serial-log-panel">
      <header><h3>收发记录</h3><div className={styles.logTools}><div className={styles.segmented}><button type="button" aria-pressed={receiveMode === 'text'} onClick={() => setReceiveMode('text')}>文本</button><button type="button" aria-pressed={receiveMode === 'hex'} onClick={() => setReceiveMode('hex')}>HEX</button></div><span className={styles.encoding}>UTF-8</span><label><input type="checkbox" checked={showTime} onChange={(event) => setShowTime(event.target.checked)} />时间</label><label><input type="checkbox" checked={follow} onChange={(event) => { setFollow(event.target.checked); tail.current = event.target.checked; }} />自动滚动</label><button type="button" disabled={!events.length} onClick={() => void copy()}>复制</button><button type="button" onClick={() => { setEvents([]); setRecordError(''); notify('界面记录已清空，字节统计继续累计。'); }}>清空</button></div></header>
      {recordError && <p className={styles.error} role="alert" data-testid="serial-record-feedback">{recordError}</p>}
      <div ref={log} role="log" aria-label="串口收发记录" aria-live="off" className={styles.log} onScroll={() => { if (log.current) tail.current = log.current.scrollHeight - log.current.scrollTop - log.current.clientHeight < 24; }}>
        {!events.length && <div className={styles.empty}>{ready ? '等待串口数据' : '打开串口后查看收发记录'}</div>}
        {events.map((event) => <div className={styles.logRow} key={event.id}>{showTime && <time>{timeText(event.timestamp)}</time>}<b className={styles[event.kind]}>{event.kind === 'tx' ? 'TX →' : event.kind === 'rx' ? 'RX ←' : event.kind === 'error' ? '错误' : '状态'}</b><code>{receiveMode === 'hex' && event.dataHex ? event.dataHex.match(/../g)?.join(' ').toUpperCase() : event.text || (event.byteLength ? `〈${event.byteLength} B，等待 UTF-8 后续字节〉` : '')}</code></div>)}
      </div>
    </section>
    </div>
    <ActionToast toast={toast} onDismiss={dismiss} />
  </section>;
}
