import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { ToolWorkspaceHeader } from '../../../shared/tool-workspace/ToolWorkspaceHeader';
import {
  isNativeHost,
  requestMqttPoll,
  requestMqttPublish,
  requestMqttStart,
  requestMqttStop,
  requestMqttSubscribe,
  requestMqttUnsubscribe,
  type MqttEvent,
  type MqttPayloadMode,
  type MqttQos,
  type MqttSessionSnapshot,
  type MqttStartOptions,
} from '../bridge/mqttBridge';
import type { ToolDefinition } from './catalog';
import styles from './MqttDebugger.module.scss';

const MAX_EVENTS = 2_000;
const MAX_EVENT_CHARACTERS = 4 * 1_024 * 1_024;
const MAX_PAYLOAD_BYTES = 256 * 1_024;
const initialOptions: MqttStartOptions = {
  host: '127.0.0.1', port: 1883, clientId: `cloudyi-${Math.random().toString(16).slice(2, 10)}`,
  username: '', password: '', keepAlive: 60, cleanSession: true, tls: false,
};

const stateText: Record<string, string> = {
  stopped: '未连接', connecting: '连接中…', connected: '已连接', stopping: '断开中…', error: '连接错误',
};
const errorText = (reason: unknown) => reason instanceof Error ? reason.message : '操作失败，请重试。';
const timeText = (value: number) => `${new Date(value).toLocaleTimeString('zh-CN', { hour12: false })}.${String(value % 1000).padStart(3, '0')}`;
const spacedHex = (hex: string) => hex.match(/../g)?.join(' ').toUpperCase() ?? '';

function textFromHex(hex: string) {
  const bytes = Uint8Array.from(hex.match(/../g) ?? [], (value) => Number.parseInt(value, 16));
  return new TextDecoder('utf-8', { fatal: false }).decode(bytes);
}

function encodePayload(value: string, mode: MqttPayloadMode) {
  if (mode === 'text') {
    const bytes = new TextEncoder().encode(value);
    if (bytes.length > MAX_PAYLOAD_BYTES) throw new Error('发布载荷不能超过 256 KiB。');
    return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
  }
  const compact = value.replace(/[\s,:_-]+/g, '');
  if (compact && (!/^[\da-f]+$/i.test(compact) || compact.length % 2 !== 0)) {
    throw new Error('HEX 必须由完整的两位字节组成。');
  }
  if (compact.length / 2 > MAX_PAYLOAD_BYTES) throw new Error('发布载荷不能超过 256 KiB。');
  return compact.toLowerCase();
}

function validTopicName(topic: string) {
  return !!topic && !topic.includes('+') && !topic.includes('#') && new TextEncoder().encode(topic).length <= 65_535;
}

function validTopicFilter(filter: string) {
  if (!filter || new TextEncoder().encode(filter).length > 65_535) return false;
  return filter.split('/').every((level, index, levels) => {
    if (level === '#') return index === levels.length - 1;
    if (level === '+') return true;
    return !level.includes('#') && !level.includes('+');
  });
}

function trimEvents(events: MqttEvent[]) {
  let characters = 0;
  let begin = events.length;
  while (begin > 0 && events.length - begin < MAX_EVENTS) {
    const event = events[begin - 1];
    const size = (event.payloadHex?.length ?? 0) + (event.topic?.length ?? 0) + (event.message?.length ?? 0);
    if (characters + size > MAX_EVENT_CHARACTERS) break;
    characters += size;
    begin -= 1;
  }
  return events.slice(begin);
}

/** MQTT 3.1.1 desktop client. Network and TLS work stays in the native worker. */
export function MqttDebugger({ tool, onBack }: { tool: ToolDefinition; onBack(): void }) {
  const [options, setOptions] = useState(initialOptions);
  const [snapshot, setSnapshot] = useState<MqttSessionSnapshot | null>(null);
  const [advanced, setAdvanced] = useState(false);
  const [subscriptionsExpanded, setSubscriptionsExpanded] = useState(false);
  const [events, setEvents] = useState<MqttEvent[]>([]);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [filter, setFilter] = useState('');
  const [subscriptionTopic, setSubscriptionTopic] = useState('devices/+/state');
  const [subscriptionQos, setSubscriptionQos] = useState<MqttQos>(0);
  const [publishTopic, setPublishTopic] = useState('devices/demo/set');
  const [publishQos, setPublishQos] = useState<MqttQos>(0);
  const [retain, setRetain] = useState(false);
  const [payloadMode, setPayloadMode] = useState<MqttPayloadMode>('text');
  const [payload, setPayload] = useState('{"enabled":true}');
  const [contentMode, setContentMode] = useState<MqttPayloadMode>('text');
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState(isNativeHost ? '' : 'MQTT 连接仅在 Windows 桌面客户端可用；浏览器不会模拟连接。');
  const mounted = useRef(true);
  const commandPending = useRef(false);
  const activeRef = useRef(false);

  const state = snapshot?.state ?? 'stopped';
  const active = state === 'connecting' || state === 'connected' || state === 'stopping';
  const connected = state === 'connected';
  const connectionLocked = active || busy;
  activeRef.current = active;

  const encoded = useMemo(() => {
    try { const hex = encodePayload(payload, payloadMode); return { hex, bytes: hex.length / 2, error: '' }; }
    catch (reason) { return { hex: '', bytes: 0, error: errorText(reason) }; }
  }, [payload, payloadMode]);

  const visibleMessages = useMemo(() => {
    const needle = filter.trim().toLocaleLowerCase();
    return events.filter((event) => event.kind === 'message' || event.kind === 'published')
      .filter((event) => !needle || event.topic?.toLocaleLowerCase().includes(needle));
  }, [events, filter]);
  const selected = events.find((event) => event.id === selectedId)
    ?? visibleMessages[visibleMessages.length - 1]
    ?? null;

  const applyPoll = useCallback((next: { snapshot: MqttSessionSnapshot; events: MqttEvent[] }) => {
    if (!mounted.current) return;
    setSnapshot(next.snapshot);
    if (next.snapshot.lastError) setFeedback(next.snapshot.lastError);
    if (next.events.length) {
      setEvents((current) => trimEvents([...current, ...next.events]));
      const lastMessage = [...next.events].reverse().find((event) => event.kind === 'message' || event.kind === 'published');
      if (lastMessage) setSelectedId((current) => current ?? lastMessage.id);
    }
  }, []);

  useEffect(() => {
    mounted.current = true;
    let disposed = false;
    let timer = 0;
    const poll = async () => {
      if (disposed || !isNativeHost) return;
      try { applyPoll(await requestMqttPoll()); }
      catch (reason) { if (!disposed) setFeedback(errorText(reason)); }
      if (!disposed) timer = window.setTimeout(poll, activeRef.current ? 200 : 800);
    };
    void poll();
    return () => {
      disposed = true;
      mounted.current = false;
      window.clearTimeout(timer);
      if (isNativeHost && activeRef.current) void requestMqttStop().catch(() => undefined);
    };
  }, [applyPoll]);

  const run = async (operation: () => Promise<MqttSessionSnapshot>, success = '') => {
    if (commandPending.current) return;
    commandPending.current = true;
    setBusy(true);
    setFeedback('');
    try {
      const next = await operation();
      if (mounted.current) { setSnapshot(next); if (success) setFeedback(success); }
    } catch (reason) { if (mounted.current) setFeedback(errorText(reason)); }
    finally { commandPending.current = false; if (mounted.current) setBusy(false); }
  };

  const toggleConnection = () => {
    if (!isNativeHost || commandPending.current) return;
    if (active) { void run(requestMqttStop, '已请求断开 MQTT 会话。'); return; }
    const host = options.host.trim();
    const clientId = options.clientId.trim();
    if (!host || host.length > 253) { setFeedback('请填写有效的 Broker 地址。'); return; }
    if (!Number.isInteger(options.port) || options.port < 1 || options.port > 65_535) { setFeedback('端口必须是 1–65535 的整数。'); return; }
    if (!clientId || new TextEncoder().encode(clientId).length > 128) { setFeedback('客户端 ID 不能为空且不能超过 128 字节。'); return; }
    if (!Number.isInteger(options.keepAlive) || options.keepAlive < 5 || options.keepAlive > 3600) { setFeedback('Keep Alive 必须是 5–3600 秒。'); return; }
    const requestOptions = { ...options, host, clientId, cleanSession: true };
    setOptions((current) => ({ ...current, password: '' }));
    setEvents([]); setSelectedId(null);
    void run(() => requestMqttStart(requestOptions), '已提交连接请求，正在等待 Broker 响应。');
  };

  const subscribe = () => {
    if (!isNativeHost || !connected || commandPending.current) return;
    const topic = subscriptionTopic.trim();
    if (!validTopicFilter(topic)) { setFeedback('订阅主题过滤器不正确；+ 必须独占一层，# 只能位于末尾。'); return; }
    void run(() => requestMqttSubscribe(topic, subscriptionQos), `已提交订阅：${topic}`);
  };
  const unsubscribe = (topic: string) => void run(() => requestMqttUnsubscribe(topic), `已提交取消订阅：${topic}`);

  const publish = () => {
    if (!isNativeHost || !connected || commandPending.current) return;
    const topic = publishTopic.trim();
    if (!validTopicName(topic)) { setFeedback('发布主题不能为空，也不能包含 + 或 # 通配符。'); return; }
    if (encoded.error) { setFeedback(encoded.error); return; }
    void run(() => requestMqttPublish(topic, encoded.hex, publishQos, retain), `已提交发布：${topic}`);
  };

  const updateOption = <K extends keyof MqttStartOptions>(key: K, value: MqttStartOptions[K]) => {
    setOptions((current) => ({ ...current, [key]: value }));
    setFeedback('');
  };
  const handlePublishKey = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if ((event.ctrlKey || event.metaKey) && event.key === 'Enter' && !event.repeat) { event.preventDefault(); publish(); }
  };

  return <section className={styles.workspace} data-testid="mqtt-workspace">
    <ToolWorkspaceHeader title={tool.name} onBack={onBack} />

    <section className={styles.connection} aria-label="MQTT 连接参数">
      <div className={styles.connectionFields}>
        <label className={styles.host}>Broker 地址<input aria-label="MQTT Broker 地址" value={options.host} disabled={connectionLocked} spellCheck={false} onChange={(event) => updateOption('host', event.target.value)} /></label>
        <label className={styles.port}>端口<input aria-label="MQTT Broker 端口" type="number" min="1" max="65535" value={options.port} disabled={connectionLocked} onChange={(event) => updateOption('port', Number(event.target.value))} /></label>
        <label>协议<select aria-label="MQTT 协议版本" disabled><option>MQTT 3.1.1</option></select></label>
        <label className={styles.clientId}>客户端 ID<input aria-label="MQTT 客户端 ID" value={options.clientId} disabled={connectionLocked} spellCheck={false} onChange={(event) => updateOption('clientId', event.target.value)} /></label>
        <button type="button" className={active ? styles.stop : styles.primary} disabled={!isNativeHost || busy || state === 'stopping'} onClick={toggleConnection}>{busy ? '处理中…' : active ? '断开连接' : '连接 Broker'}</button>
      </div>
      <div className={styles.connectionFooter}>
        <strong className={connected ? styles.connected : undefined}>● {stateText[state] ?? state}{snapshot?.sessionPresent ? ' · 已恢复会话' : ''}</strong>
        <span>{snapshot ? `接收 ${snapshot.rxMessages} 条 / ${snapshot.rxBytes} B　发送 ${snapshot.txMessages} 条 / ${snapshot.txBytes} B` : '系统证书校验 · 密码不会保存'}</span>
        <button type="button" aria-expanded={advanced} onClick={() => setAdvanced((value) => !value)}>认证、TLS 与会话 {advanced ? '⌃' : '⌄'}</button>
      </div>
      {advanced && <div className={styles.advanced}>
        <label>用户名<input autoComplete="username" value={options.username} disabled={connectionLocked} onChange={(event) => updateOption('username', event.target.value)} /></label>
        <label>密码<input type="password" autoComplete="new-password" value={options.password} disabled={connectionLocked} onChange={(event) => updateOption('password', event.target.value)} /></label>
        <label>Keep Alive（秒）<input type="number" min="5" max="3600" value={options.keepAlive} disabled={connectionLocked} onChange={(event) => updateOption('keepAlive', Number(event.target.value))} /></label>
        <span className={styles.sessionMode}>新会话</span>
        <label className={styles.check}><input type="checkbox" checked={options.tls} disabled={connectionLocked} onChange={(event) => { updateOption('tls', event.target.checked); if (event.target.checked && options.port === 1883) updateOption('port', 8883); }} />TLS（Windows 系统证书）</label>
        <small>TLS 会校验证书链和 Broker 主机名，不能跳过验证；认证密码只保留到本次连接请求。</small>
      </div>}
    </section>

    <section className={styles.middle}>
      <aside className={`${styles.subscriptions} ${subscriptionsExpanded ? styles.subscriptionsExpanded : ''}`} aria-label="MQTT 订阅">
        <header><h3>主题订阅</h3><span>{snapshot?.subscriptions.length ?? 0}</span><button className={styles.subscriptionToggle} type="button" aria-expanded={subscriptionsExpanded} aria-controls="mqtt-subscription-settings" onClick={() => setSubscriptionsExpanded((value) => !value)}>{subscriptionsExpanded ? '收起订阅' : '展开订阅'}</button></header>
        <div className={styles.subscriptionSettings} id="mqtt-subscription-settings">
        <label>主题过滤器<input aria-label="MQTT 订阅主题" value={subscriptionTopic} spellCheck={false} onChange={(event) => setSubscriptionTopic(event.target.value)} /></label>
        <div className={styles.subscribeActions}><label>QoS<select aria-label="订阅 QoS" value={subscriptionQos} onChange={(event) => setSubscriptionQos(Number(event.target.value) as MqttQos)}><option value="0">0</option><option value="1">1</option><option value="2">2</option></select></label><button className={styles.primary} disabled={!connected || busy} onClick={subscribe}>订阅</button></div>
        <div className={styles.subscriptionList}>{snapshot?.subscriptions.length ? snapshot.subscriptions.map((entry) => <div key={entry.topic}><span title={entry.topic}>{entry.topic}</span><small>QoS {entry.qos}</small><button aria-label={`取消订阅 ${entry.topic}`} disabled={!connected || busy} onClick={() => unsubscribe(entry.topic)}>×</button></div>) : <p>连接 Broker 后添加主题；支持 <code>+</code> 与 <code>#</code> 通配符。</p>}</div>
        </div>
      </aside>

      <section className={styles.messages} aria-label="MQTT 消息">
        <header><h3>消息记录</h3><input aria-label="筛选 MQTT 主题" placeholder="筛选主题…" value={filter} onChange={(event) => setFilter(event.target.value)} /><button disabled={!events.length} onClick={() => { setEvents([]); setSelectedId(null); }}>清空</button></header>
        <div className={styles.messageBody}>
          <div className={styles.messageTable}>
            <div className={styles.tableHead} aria-hidden="true"><span>时间</span><span>方向</span><span>主题</span><span>QoS</span><span>保留</span></div>
            <div className={styles.messageList} role="listbox" aria-label="MQTT 消息列表">{visibleMessages.length ? visibleMessages.map((event) => <button type="button" role="option" aria-selected={selected?.id === event.id} key={event.id} onClick={() => setSelectedId(event.id)}><time>{timeText(event.timestamp)}</time><b className={event.kind === 'message' ? styles.rx : styles.tx}>{event.kind === 'message' ? 'RX' : 'TX'}</b><span title={event.topic}>{event.topic}</span><small>{event.qos ?? 0}</small><small>{event.retain ? '是' : '否'}</small></button>) : <p>{isNativeHost ? '订阅后收到的消息会显示在这里。' : '浏览器预览不建立 MQTT 连接。'}</p>}</div>
          </div>
          <div className={styles.content}>
            <header><div><strong title={selected?.topic}>{selected?.topic ?? '消息内容'}</strong><span>{selected ? `${selected.byteLength ?? 0} 字节` : '尚未选择消息'}</span></div><div className={styles.segmented}><button aria-pressed={contentMode === 'text'} onClick={() => setContentMode('text')}>文本</button><button aria-pressed={contentMode === 'hex'} onClick={() => setContentMode('hex')}>HEX</button><button disabled={!selected} onClick={() => selected && void navigator.clipboard.writeText(contentMode === 'hex' ? spacedHex(selected.payloadHex ?? '') : textFromHex(selected.payloadHex ?? '')).catch(() => setFeedback('复制失败，请检查剪贴板权限。'))}>复制</button></div></header>
            <pre aria-label="消息内容">{selected ? selected.payloadHex ? contentMode === 'hex' ? spacedHex(selected.payloadHex) : textFromHex(selected.payloadHex) : '空载荷（0 字节）' : '选择上方消息后查看完整载荷。'}</pre>
          </div>
        </div>
      </section>
    </section>

    <section className={styles.publish} aria-label="MQTT 发布">
      <header><h3>发布消息</h3><span className={encoded.error ? styles.invalid : undefined}>{encoded.error || `${encoded.bytes} 字节`}</span></header>
      <div className={styles.publishControls}><label>发布主题<input aria-label="MQTT 发布主题" value={publishTopic} spellCheck={false} onChange={(event) => setPublishTopic(event.target.value)} /></label><label>QoS<select aria-label="发布 QoS" value={publishQos} onChange={(event) => setPublishQos(Number(event.target.value) as MqttQos)}><option value="0">0</option><option value="1">1</option><option value="2">2</option></select></label><label className={styles.check}><input type="checkbox" checked={retain} onChange={(event) => setRetain(event.target.checked)} />Retain</label></div>
      <div className={styles.publishBody}><div className={styles.publishEditor}><div className={styles.segmented}><button aria-pressed={payloadMode === 'text'} onClick={() => setPayloadMode('text')}>文本</button><button aria-pressed={payloadMode === 'hex'} onClick={() => setPayloadMode('hex')}>HEX</button></div><textarea aria-label="MQTT 发布内容" value={payload} spellCheck={false} onChange={(event) => setPayload(event.target.value)} onKeyDown={handlePublishKey} /></div><button className={styles.primary} disabled={!connected || busy || !!encoded.error} onClick={publish}>发布 <kbd>Ctrl Enter</kbd></button></div>
      {feedback && <p role={snapshot?.lastError || encoded.error ? 'alert' : 'status'} className={snapshot?.lastError || encoded.error ? styles.error : styles.notice}>{feedback}</p>}
    </section>
  </section>;
}
