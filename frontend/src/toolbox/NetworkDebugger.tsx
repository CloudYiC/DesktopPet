import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type UIEvent,
} from 'react';
import {
  requestNetworkPoll,
  requestNetworkSend,
  requestNetworkStart,
  requestNetworkStop,
} from '../bridge/hostBridge';
import type {
  NetworkDebugEvent,
  NetworkMode,
  NetworkSessionSnapshot,
  NetworkStartOptions,
} from '../types';
import type { ToolDefinition } from './catalog';
import { normalizeHexInput } from './packetParser';
import styles from './NetworkDebugger.module.scss';

interface NetworkDebuggerProps {
  tool: ToolDefinition;
  onBack(): void;
}

type DataMode = 'text' | 'hex';
type LineEnding = 'none' | 'lf' | 'crlf';

const MAX_LOG_EVENTS = 5_000;
const MAX_LOG_CHARACTERS = 4 * 1_024 * 1_024;
const MAX_SEND_BYTES = 65_536;
const MAX_UDP_SEND_BYTES = 65_507;
const MIN_AUTO_SEND_INTERVAL = 50;

const MODE_OPTIONS: Array<{
  id: NetworkMode;
  label: string;
  description: string;
}> = [
  { id: 'tcp-client', label: 'TCP 客户端', description: '连接远端 TCP 服务并双向收发数据。' },
  { id: 'tcp-server', label: 'TCP 服务端', description: '监听本地端口并管理多个客户端。' },
  { id: 'udp', label: 'UDP', description: '绑定本地端口并向指定目标发送数据报。' },
];

/** Desktop-only TCP/UDP workbench backed by the native WinSock service. */
export function NetworkDebugger({ tool, onBack }: NetworkDebuggerProps) {
  const [mode, setMode] = useState<NetworkMode>('tcp-client');
  const [localHost, setLocalHost] = useState('');
  const [localPort, setLocalPort] = useState('0');
  const [remoteHost, setRemoteHost] = useState('127.0.0.1');
  const [remotePort, setRemotePort] = useState('9000');
  const [snapshot, setSnapshot] = useState<NetworkSessionSnapshot | null>(null);
  const [events, setEvents] = useState<NetworkDebugEvent[]>([]);
  const [receiveMode, setReceiveMode] = useState<DataMode>('text');
  const [sendMode, setSendMode] = useState<DataMode>('text');
  const [lineEnding, setLineEnding] = useState<LineEnding>('none');
  const [draft, setDraft] = useState('你好，云依助手');
  const [targetPeerId, setTargetPeerId] = useState('all');
  const [showTimestamps, setShowTimestamps] = useState(true);
  const [autoScroll, setAutoScroll] = useState(true);
  const [autoSend, setAutoSend] = useState(false);
  const [autoSendInterval, setAutoSendInterval] = useState('1000');
  const [allowLan, setAllowLan] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('所有连接和数据都只在当前电脑中处理。');
  const [hasUnseenData, setHasUnseenData] = useState(false);
  const logRef = useRef<HTMLDivElement>(null);
  const followTailRef = useRef(true);
  const sendInFlightRef = useRef(false);
  const mountedRef = useRef(true);

  const sessionState = snapshot?.state ?? 'idle';
  const active = !['idle', 'stopped', 'error'].includes(sessionState);
  const readyToSend = sessionState === 'connected'
    || sessionState === 'listening'
    || sessionState === 'ready';
  const selectedMode = MODE_OPTIONS.find((item) => item.id === mode) ?? MODE_OPTIONS[0];
  const peers = snapshot?.peers ?? [];
  const hasSendTarget = mode !== 'tcp-server' || peers.length > 0;
  const requiresLanConfirmation = localHost === '0.0.0.0';

  const sendPreview = useMemo(() => {
    try {
      const bytes = encodePayload(
        draft,
        sendMode,
        lineEnding,
        mode === 'udp' ? MAX_UDP_SEND_BYTES : MAX_SEND_BYTES,
      );
      return { bytes, error: '' };
    } catch (payloadError) {
      return {
        bytes: [] as number[],
        error: payloadError instanceof Error ? payloadError.message : '发送内容不正确。',
      };
    }
  }, [draft, lineEnding, mode, sendMode]);

  const appendEvents = useCallback((incoming: NetworkDebugEvent[]) => {
    if (!incoming.length) return;
    setEvents((current) => trimLogEvents([...current, ...incoming]));
    if (!autoScroll || !followTailRef.current) setHasUnseenData(true);
  }, [autoScroll]);

  const poll = useCallback(async () => {
    try {
      const result = await requestNetworkPoll();
      if (!mountedRef.current) return;
      setSnapshot(result.snapshot);
      appendEvents(result.events);
      if (result.snapshot.lastError) setError(result.snapshot.lastError);
    } catch (pollError) {
      if (!mountedRef.current) return;
      setError(pollError instanceof Error ? pollError.message : '读取网络会话状态失败。');
    }
  }, [appendEvents]);

  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  useEffect(() => {
    let disposed = false;
    let timer = 0;
    const run = async () => {
      if (disposed) return;
      await poll();
      if (!disposed) timer = window.setTimeout(run, active ? 250 : 900);
    };
    void run();
    return () => {
      disposed = true;
      window.clearTimeout(timer);
    };
  }, [active, poll]);

  useLayoutEffect(() => {
    const log = logRef.current;
    if (!log || !autoScroll || !followTailRef.current) return;
    log.scrollTop = log.scrollHeight;
    setHasUnseenData(false);
  }, [autoScroll, events, receiveMode, showTimestamps]);

  useEffect(() => {
    if (mode === 'tcp-server') {
      setLocalHost((value) => value || '127.0.0.1');
      setLocalPort((value) => value === '0' ? '9000' : value);
      return;
    }
    if (mode === 'tcp-client') {
      setLocalHost((value) => value === '127.0.0.1' ? '' : value);
      setLocalPort('0');
    }
    if (mode === 'udp') {
      setLocalHost((value) => value || '127.0.0.1');
      setLocalPort((value) => value === '0' ? '9001' : value);
    }
  }, [mode]);

  useEffect(() => {
    if (targetPeerId !== 'all' && !peers.some((peer) => peer.id === targetPeerId)) {
      setTargetPeerId('all');
    }
  }, [peers, targetPeerId]);

  useEffect(() => {
    if (!readyToSend) setAutoSend(false);
  }, [readyToSend]);

  useEffect(() => () => {
    // A debugging socket must never keep listening after its workspace closes.
    void requestNetworkStop().catch(() => undefined);
  }, []);

  const startSession = async () => {
    const options = validateStartOptions(mode, localHost, localPort, remoteHost, remotePort, allowLan);
    if (typeof options === 'string') {
      setError(options);
      return;
    }
    setBusy(true);
    setError('');
    setNotice(mode === 'tcp-client' ? '正在连接远端服务…' : mode === 'tcp-server' ? '正在启动监听…' : '正在绑定 UDP 端口…');
    try {
      const next = await requestNetworkStart(options);
      if (!mountedRef.current) return;
      setSnapshot(next);
      setNotice(startedNotice(mode, next));
    } catch (startError) {
      if (!mountedRef.current) return;
      setError(startError instanceof Error ? startError.message : '网络会话启动失败。');
      setNotice('请检查地址、端口和本机防火墙设置。');
    } finally {
      if (mountedRef.current) setBusy(false);
    }
  };

  const stopSession = async () => {
    setBusy(true);
    setError('');
    setAutoSend(false);
    try {
      const next = await requestNetworkStop();
      if (!mountedRef.current) return;
      setSnapshot(next);
      setNotice('网络会话已经停止，本地端口已释放。');
    } catch (stopError) {
      if (!mountedRef.current) return;
      setError(stopError instanceof Error ? stopError.message : '网络会话停止失败。');
    } finally {
      if (mountedRef.current) setBusy(false);
    }
  };

  const sendNow = useCallback(async (fromTimer = false) => {
    if (sendInFlightRef.current) return;
    let bytes: number[];
    try {
      bytes = encodePayload(
        draft,
        sendMode,
        lineEnding,
        mode === 'udp' ? MAX_UDP_SEND_BYTES : MAX_SEND_BYTES,
      );
    } catch (payloadError) {
      setError(payloadError instanceof Error ? payloadError.message : '发送内容不正确。');
      if (fromTimer) setAutoSend(false);
      return;
    }
    if (!readyToSend) {
      setError('请先建立连接、启动监听或绑定 UDP 端口。');
      if (fromTimer) setAutoSend(false);
      return;
    }
    if (mode === 'tcp-server' && targetPeerId === 'all' && !peers.length) {
      setError('当前没有已连接的 TCP 客户端。');
      if (fromTimer) setAutoSend(false);
      return;
    }
    sendInFlightRef.current = true;
    setError('');
    try {
      const next = await requestNetworkSend(
        bytesToHex(bytes),
        mode === 'tcp-server' && targetPeerId !== 'all' ? targetPeerId : undefined,
      );
      if (!mountedRef.current) return;
      setSnapshot(next);
    } catch (sendError) {
      if (!mountedRef.current) return;
      setError(sendError instanceof Error ? sendError.message : '数据发送失败。');
      if (fromTimer) setAutoSend(false);
    } finally {
      sendInFlightRef.current = false;
    }
  }, [draft, lineEnding, mode, peers.length, readyToSend, sendMode, targetPeerId]);

  useEffect(() => {
    if (!autoSend) return undefined;
    const interval = Number(autoSendInterval);
    if (!Number.isInteger(interval) || interval < MIN_AUTO_SEND_INTERVAL) {
      setError(`自动发送间隔不能小于 ${MIN_AUTO_SEND_INTERVAL} 毫秒。`);
      setAutoSend(false);
      return undefined;
    }
    const timer = window.setInterval(() => void sendNow(true), interval);
    return () => window.clearInterval(timer);
  }, [autoSend, autoSendInterval, sendNow]);

  const changeMode = (nextMode: NetworkMode) => {
    if (active || busy) return;
    setMode(nextMode);
    setSnapshot(null);
    setAllowLan(false);
    setError('');
    setNotice(MODE_OPTIONS.find((item) => item.id === nextMode)?.description ?? '');
  };

  const copyLog = async () => {
    const text = events.map((event) => formatLogLine(event, receiveMode, showTimestamps)).join('\n');
    if (!text) {
      setNotice('当前还没有可以复制的收发记录。');
      return;
    }
    try {
      await navigator.clipboard.writeText(text);
      setNotice(`已复制 ${events.length} 条收发记录。`);
    } catch {
      setError('无法访问剪贴板，请检查系统权限。');
    }
  };

  const clearLog = () => {
    setEvents([]);
    setHasUnseenData(false);
    followTailRef.current = true;
    setNotice('显示记录已清空；当前网络会话仍然保持。');
  };

  const scrollToLatest = () => {
    const log = logRef.current;
    if (log) log.scrollTop = log.scrollHeight;
    followTailRef.current = true;
    setHasUnseenData(false);
  };

  const handleLogScroll = (event: UIEvent<HTMLDivElement>) => {
    const element = event.currentTarget;
    followTailRef.current = element.scrollHeight - element.scrollTop - element.clientHeight < 36;
    if (followTailRef.current) setHasUnseenData(false);
  };

  const handleSendKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
      event.preventDefault();
      void sendNow();
    }
  };

  return (
    <section className={styles.workspace}>
      <header className={styles.workspaceHeader}>
        <button type="button" onClick={onBack}>← 返回工具列表</button>
        <div className={styles.workspaceTitle}>
          <i>{tool.glyph}</i>
          <div>
            <span>WINDOWS NATIVE · LOCAL SOCKET</span>
            <h2>{tool.name}</h2>
            <p>{tool.description}</p>
          </div>
        </div>
      </header>

      <div className={styles.modeBar}>
        <div className={styles.modeTabs} role="tablist" aria-label="网络模式">
          {MODE_OPTIONS.map((option) => (
            <button
              key={option.id}
              type="button"
              role="tab"
              aria-selected={mode === option.id}
              className={mode === option.id ? styles.activeMode : undefined}
              disabled={active || busy}
              onClick={() => changeMode(option.id)}
            >
              {option.label}
            </button>
          ))}
        </div>
        <SessionStatus snapshot={snapshot} fallbackMode={mode} />
      </div>

      <div className={styles.debuggerLayout}>
        <aside className={styles.connectionPanel}>
          <div className={styles.panelHeading}>
            <div><span>CONNECTION</span><h3>连接设置</h3></div>
            <small>{selectedMode.description}</small>
          </div>

          <div className={styles.formGrid}>
            <label className={styles.addressField}>
              <span>本地地址</span>
              <select
                value={localHost}
                disabled={active || busy}
                onChange={(event) => {
                  setLocalHost(event.target.value);
                  setAllowLan(false);
                }}
              >
                {mode === 'tcp-client' && <option value="">自动选择出站网卡</option>}
                <option value="127.0.0.1">127.0.0.1 · 仅本机</option>
                <option value="0.0.0.0">0.0.0.0 · 全部网卡</option>
              </select>
            </label>
            <label className={styles.portField}>
              <span>本地端口</span>
              <input
                value={localPort}
                disabled={active || busy}
                inputMode="numeric"
                placeholder={mode === 'tcp-client' ? '0 · 自动' : '9000'}
                onChange={(event) => setLocalPort(event.target.value)}
              />
            </label>

            {mode !== 'tcp-server' && (
              <>
                <label className={styles.addressField}>
                  <span>远端主机</span>
                  <input
                    value={remoteHost}
                    disabled={active || busy}
                    spellCheck={false}
                    placeholder="127.0.0.1 或主机名"
                    onChange={(event) => setRemoteHost(event.target.value)}
                  />
                </label>
                <label className={styles.portField}>
                  <span>远端端口</span>
                  <input
                    value={remotePort}
                    disabled={active || busy}
                    inputMode="numeric"
                    placeholder="9000"
                    onChange={(event) => setRemotePort(event.target.value)}
                  />
                </label>
              </>
            )}
          </div>

          {requiresLanConfirmation && !active && (
            <label className={styles.exposureNotice}>
              <input type="checkbox" checked={allowLan} onChange={(event) => setAllowLan(event.target.checked)} />
              <span>
                <strong>{mode === 'tcp-client' ? '允许外部网络连接' : '允许局域网访问'}</strong>
                {mode === 'tcp-client'
                  ? '系统将自动选择出站网卡，用于连接本机以外的远端地址。'
                  : '将对所有本机网卡开放，请确认防火墙与局域网环境可信。'}
              </span>
            </label>
          )}

          <button
            type="button"
            className={active ? styles.stopButton : styles.startButton}
            disabled={busy || (requiresLanConfirmation && !allowLan)}
            onClick={() => void (active ? stopSession() : startSession())}
          >
            {busy ? '处理中…' : sessionAction(mode, active)}
          </button>

          {mode === 'tcp-server' && (
            <section className={styles.peerPanel} aria-label="TCP 客户端列表">
              <div><strong>已连接客户端</strong><span>{peers.length}</span></div>
              {peers.length ? (
                <div className={styles.peerList}>
                  {peers.map((peer) => (
                    <button
                      key={peer.id}
                      type="button"
                      className={targetPeerId === peer.id ? styles.selectedPeer : undefined}
                      onClick={() => setTargetPeerId(peer.id)}
                    >
                      <span>{peer.address}:{peer.port}</span><small>{peer.id}</small>
                    </button>
                  ))}
                </div>
              ) : <p>监听后，新的 TCP 客户端会显示在这里。</p>}
            </section>
          )}
        </aside>

        <main className={styles.dataWorkspace}>
          <section className={styles.receivePanel}>
            <header className={styles.receiveToolbar}>
              <div><span>RECEIVE LOG</span><h3>收发记录</h3></div>
              <div className={styles.toolbarActions}>
                <div className={styles.smallTabs} aria-label="数据显示方式">
                  <button type="button" className={receiveMode === 'text' ? styles.activeSmallTab : undefined} onClick={() => setReceiveMode('text')}>文本</button>
                  <button type="button" className={receiveMode === 'hex' ? styles.activeSmallTab : undefined} onClick={() => setReceiveMode('hex')}>HEX</button>
                </div>
                <label className={styles.checkControl}><input type="checkbox" checked={showTimestamps} onChange={(event) => setShowTimestamps(event.target.checked)} /><span>时间</span></label>
                <label className={styles.checkControl}>
                  <input
                    type="checkbox"
                    checked={autoScroll}
                    onChange={(event) => {
                      const enabled = event.target.checked;
                      setAutoScroll(enabled);
                      if (enabled) followTailRef.current = true;
                    }}
                  />
                  <span>自动滚动</span>
                </label>
                <button type="button" className={styles.textButton} onClick={() => void copyLog()}>复制</button>
                <button type="button" className={styles.textButton} onClick={clearLog}>清空</button>
              </div>
            </header>

            <div ref={logRef} className={styles.logConsole} role="log" aria-label="网络收发记录" onScroll={handleLogScroll}>
              {!events.length && (
                <div className={styles.emptyLog}>
                  <strong>等待网络数据</strong>
                  <span>建立连接后，收到和发出的字节都会按顺序显示在这里。</span>
                </div>
              )}
              {events.map((event, index) => (
                <LogEntry
                  key={`${event.id}-${index}`}
                  event={event}
                  mode={receiveMode}
                  showTimestamp={showTimestamps}
                />
              ))}
            </div>
            {hasUnseenData && <button type="button" className={styles.newDataButton} onClick={scrollToLatest}>有新数据 · 查看最新</button>}
          </section>

          <section className={styles.sendPanel}>
            <header>
              <div><span>SEND DATA</span><h3>发送数据</h3></div>
              <div className={styles.sendHeaderMeta}>
                <div className={styles.smallTabs} aria-label="发送数据方式">
                  <button type="button" className={sendMode === 'text' ? styles.activeSmallTab : undefined} onClick={() => setSendMode('text')}>文本</button>
                  <button type="button" className={sendMode === 'hex' ? styles.activeSmallTab : undefined} onClick={() => setSendMode('hex')}>HEX</button>
                </div>
                <strong className={sendPreview.error ? styles.invalidSize : undefined}>
                  {sendPreview.error || `${sendPreview.bytes.length} 字节`}
                </strong>
              </div>
            </header>
            <textarea
              value={draft}
              spellCheck={false}
              placeholder={sendMode === 'hex' ? '例如：48 65 6c 6c 6f' : '输入要发送的 UTF-8 文本'}
              aria-label="发送内容"
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={handleSendKeyDown}
            />
            <div className={styles.sendControls}>
              <label>
                <span>行尾</span>
                <select value={lineEnding} onChange={(event) => setLineEnding(event.target.value as LineEnding)}>
                  <option value="none">不追加</option><option value="lf">LF</option><option value="crlf">CRLF</option>
                </select>
              </label>
              {mode === 'tcp-server' && (
                <label>
                  <span>发送目标</span>
                  <select value={targetPeerId} onChange={(event) => setTargetPeerId(event.target.value)}>
                    <option value="all">全部客户端</option>
                    {peers.map((peer) => <option key={peer.id} value={peer.id}>{peer.address}:{peer.port}</option>)}
                  </select>
                </label>
              )}
              <label className={styles.autoSendControl}>
                <span>循环发送</span>
                <div>
                  <input type="checkbox" checked={autoSend} disabled={!readyToSend || !hasSendTarget || Boolean(sendPreview.error)} onChange={(event) => setAutoSend(event.target.checked)} />
                  <input value={autoSendInterval} disabled={!autoSend} inputMode="numeric" aria-label="循环发送间隔毫秒" onChange={(event) => setAutoSendInterval(event.target.value)} />
                  <small>ms</small>
                </div>
              </label>
              <button
                type="button"
                className={styles.sendButton}
                disabled={!readyToSend || !hasSendTarget || Boolean(sendPreview.error) || sendInFlightRef.current}
                onClick={() => void sendNow()}
              >
                发送 <kbd>Ctrl Enter</kbd>
              </button>
            </div>
          </section>
        </main>
      </div>

      {(notice || error) && (
        <div className={`${styles.feedbackBar} ${error ? styles.errorFeedback : ''}`} role={error ? 'alert' : 'status'}>
          <span>{error ? '!' : 'i'}</span><p>{error || notice}</p>
        </div>
      )}
    </section>
  );
}

function SessionStatus({ snapshot, fallbackMode }: {
  snapshot: NetworkSessionSnapshot | null;
  fallbackMode: NetworkMode;
}) {
  const state = snapshot?.state ?? 'idle';
  const mode = snapshot && snapshot.state !== 'stopped' ? snapshot.mode : fallbackMode;
  const stateLabel = sessionStateLabel(state);
  const localEndpoint = snapshot && snapshot.state !== 'stopped'
    ? `${snapshot.localHost || '0.0.0.0'}:${snapshot.localPort || 0}`
    : '尚未启动';
  return (
    <div className={styles.sessionStatus}>
      <span className={`${styles.stateDot} ${styles[`state_${state}`] ?? ''}`} aria-hidden="true" />
      <div><small>{modeLabel(mode)}</small><strong>{stateLabel}</strong></div>
      <div className={styles.endpoint}><small>本地端点</small><strong>{localEndpoint}</strong></div>
      <div><small>接收</small><strong>{snapshot?.rxPackets ?? 0} 次 · {formatBytes(snapshot?.rxBytes ?? 0)}</strong></div>
      <div><small>发送</small><strong>{snapshot?.txPackets ?? 0} 次 · {formatBytes(snapshot?.txBytes ?? 0)}</strong></div>
    </div>
  );
}

function trimLogEvents(allEvents: NetworkDebugEvent[]) {
  const retained: NetworkDebugEvent[] = [];
  let characters = 0;
  for (let index = allEvents.length - 1; index >= 0; index -= 1) {
    const event = allEvents[index];
    const eventCharacters = (event.dataHex?.length ?? 0)
      + (event.message?.length ?? 0)
      + (event.peerLabel?.length ?? 0);
    if (retained.length >= MAX_LOG_EVENTS
        || (retained.length > 0 && characters + eventCharacters > MAX_LOG_CHARACTERS)) {
      break;
    }
    retained.push(event);
    characters += eventCharacters;
  }
  return retained.reverse();
}

function LogEntry({ event, mode, showTimestamp }: {
  event: NetworkDebugEvent;
  mode: DataMode;
  showTimestamp: boolean;
}) {
  const direction = event.kind === 'received' ? '收' : event.kind === 'sent' ? '发' : '状态';
  const content = event.message || payloadText(event.dataHex ?? '', mode);
  return (
    <div className={`${styles.logEntry} ${styles[`log_${event.kind}`] ?? ''}`}>
      <div className={styles.logMeta}>
        {showTimestamp && <time>{formatTime(event.timestamp)}</time>}
        <b>{direction}</b>
        {event.peerLabel && <span>{event.peerLabel}</span>}
        {event.byteLength > 0 && <em>{event.byteLength} B</em>}
      </div>
      <pre>{content || '（空数据）'}</pre>
    </div>
  );
}

function validateStartOptions(
  mode: NetworkMode,
  localHost: string,
  localPortText: string,
  remoteHost: string,
  remotePortText: string,
  allowLan: boolean,
): NetworkStartOptions | string {
  const localPort = parsePort(localPortText, mode === 'tcp-client');
  if (localPort === null) return mode === 'tcp-client' ? '本地端口应为 0–65535。' : '本地端口应为 1–65535。';
  const normalizedLocalHost = localHost.trim();
  if (!normalizedLocalHost && mode !== 'tcp-client') return '请选择本地监听地址。';
  if (mode === 'tcp-server') {
    return {
      mode,
      localHost: normalizedLocalHost,
      localPort,
      remoteHost: '',
      remotePort: 0,
      allowLan,
    };
  }
  const normalizedRemoteHost = remoteHost.trim();
  if (!normalizedRemoteHost) return '请填写远端主机地址。';
  const remotePort = parsePort(remotePortText, false);
  if (remotePort === null) return '远端端口应为 1–65535。';
  return {
    mode,
    localHost: normalizedLocalHost,
    localPort,
    remoteHost: normalizedRemoteHost,
    remotePort,
    allowLan,
  };
}

function parsePort(value: string, allowZero: boolean) {
  if (!/^\d+$/.test(value.trim())) return null;
  const port = Number(value);
  const minimum = allowZero ? 0 : 1;
  return Number.isInteger(port) && port >= minimum && port <= 65_535 ? port : null;
}

function encodePayload(
  input: string,
  mode: DataMode,
  lineEnding: LineEnding,
  maximumBytes: number,
) {
  const suffix = lineEnding === 'crlf' ? '\r\n' : lineEnding === 'lf' ? '\n' : '';
  let bytes: number[];
  if (mode === 'hex') {
    const normalized = normalizeHexInput(input);
    bytes = normalized.bytes;
    if (suffix) bytes = [...bytes, ...new TextEncoder().encode(suffix)];
  } else {
    if (!input && !suffix) throw new Error('请输入要发送的内容。');
    bytes = Array.from(new TextEncoder().encode(`${input}${suffix}`));
  }
  if (!bytes.length) throw new Error('发送内容不能为空。');
  if (bytes.length > maximumBytes) throw new Error(`单次最多发送 ${maximumBytes} 字节。`);
  return bytes;
}

function payloadText(hex: string, mode: DataMode) {
  if (!hex) return '';
  const compact = hex.replace(/[^0-9a-f]/gi, '');
  const pairs = compact.match(/../g) ?? [];
  if (mode === 'hex') return pairs.join(' ').toUpperCase();
  const bytes = Uint8Array.from(pairs.map((pair) => Number.parseInt(pair, 16)));
  return new TextDecoder('utf-8', { fatal: false }).decode(bytes)
    .replace(/[^\t\r\n\x20-\x7e\u0080-\uffff]/g, '·');
}

function bytesToHex(bytes: number[]) {
  return bytes.map((value) => value.toString(16).padStart(2, '0')).join('');
}

function formatLogLine(event: NetworkDebugEvent, mode: DataMode, showTimestamp: boolean) {
  const pieces = [];
  if (showTimestamp) pieces.push(`[${formatTime(event.timestamp)}]`);
  pieces.push(event.kind === 'received' ? '[收]' : event.kind === 'sent' ? '[发]' : '[状态]');
  if (event.peerLabel) pieces.push(`[${event.peerLabel}]`);
  if (event.byteLength > 0) pieces.push(`[${event.byteLength} B]`);
  pieces.push(event.message || payloadText(event.dataHex ?? '', mode));
  return pieces.join(' ');
}

function formatTime(timestamp: number) {
  const date = new Date(timestamp);
  const clock = date.toLocaleTimeString('zh-CN', {
    hour12: false,
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
  return `${clock}.${date.getMilliseconds().toString().padStart(3, '0')}`;
}

function formatBytes(bytes: number) {
  if (bytes < 1_024) return `${bytes} B`;
  if (bytes < 1_048_576) return `${(bytes / 1_024).toFixed(1)} KB`;
  return `${(bytes / 1_048_576).toFixed(1)} MB`;
}

function modeLabel(mode: NetworkMode) {
  if (mode === 'tcp-server') return 'TCP SERVER';
  if (mode === 'udp') return 'UDP';
  return 'TCP CLIENT';
}

function sessionStateLabel(state: string) {
  if (state === 'connecting' || state === 'starting') return '正在启动';
  if (state === 'connected') return '已连接';
  if (state === 'listening') return '监听中';
  if (state === 'ready') return '已绑定';
  if (state === 'stopping') return '正在停止';
  if (state === 'error') return '出现错误';
  return '未启动';
}

function sessionAction(mode: NetworkMode, active: boolean) {
  if (active) {
    if (mode === 'tcp-server') return '停止监听';
    if (mode === 'udp') return '解除绑定';
    return '断开连接';
  }
  if (mode === 'tcp-server') return '开始监听';
  if (mode === 'udp') return '绑定端口';
  return '连接服务';
}

function startedNotice(mode: NetworkMode, snapshot: NetworkSessionSnapshot) {
  const endpoint = `${snapshot.localHost || '0.0.0.0'}:${snapshot.localPort || 0}`;
  if (mode === 'tcp-server') {
    return snapshot.state === 'listening'
      ? `正在 ${endpoint} 监听 TCP 客户端。`
      : '正在启动 TCP 监听…';
  }
  if (mode === 'udp') {
    return snapshot.state === 'ready'
      ? `UDP 已绑定到 ${endpoint}。`
      : '正在绑定 UDP 端口…';
  }
  return snapshot.state === 'connected'
    ? `已通过 ${endpoint} 建立 TCP 连接。`
    : '正在连接远端 TCP 服务…';
}
