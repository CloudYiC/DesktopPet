import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { ToolWorkspaceHeader } from '../../../shared/tool-workspace/ToolWorkspaceHeader';
import { ActionToast, useActionToast } from '../../../shared/tool-workspace/ActionToast';
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
const MAX_MESSAGE_STORAGE = 4 * 1_024 * 1_024;
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
type FeedbackScope = 'connection' | 'subscription' | 'publish';

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


interface MessageEntry extends MqttEvent {
  text: string;
  searchText: string;
  preview: string;
  clock: string;
  storageBytes: number;
}

function prepareMessage(event: MqttEvent): MessageEntry {
  const text = textFromHex(event.payloadHex ?? '');
  const searchText = `${event.topic ?? ''}\n${text}`.toLocaleLowerCase();
  const preview = text.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '·').replace(/\s+/g, ' ').slice(0, 220);
  const clock = timeText(event.timestamp);
  // Include cached decoded/search strings in the budget, not just the wire payload.
  const storageBytes = 2 * ((event.payloadHex?.length ?? 0) + (event.topic?.length ?? 0)
    + text.length + searchText.length + preview.length + clock.length) + 160;
  return { ...event, text, searchText, preview, clock, storageBytes };
}

function trimMessages(entries: MessageEntry[]) {
  let bytes = 0;
  let begin = entries.length;
  while (begin > 0 && entries.length - begin < MAX_EVENTS) {
    const size = entries[begin - 1].storageBytes;
    if (bytes + size > MAX_MESSAGE_STORAGE) break;
    bytes += size;
    begin -= 1;
  }
  return entries.slice(begin);
}

const MessageRow = memo(function MessageRow({ entry, selected, onSelect }: {
  entry: MessageEntry; selected: boolean; onSelect(id: number): void;
}) {
  const received = entry.kind === 'message';
  return <button type="button" role="option" aria-selected={selected} data-message-id={entry.id}
    id={`mqtt-message-${entry.id}`} tabIndex={selected ? 0 : -1}
    className={styles.messageRow} onClick={() => onSelect(entry.id)}>
    <span className={styles.messageTop}>
      <b className={received ? styles.rx : styles.tx}>{received ? 'RX 接收' : 'TX 发布'}</b>
      <strong title={entry.topic}>{entry.topic}</strong><time>{entry.clock}</time>
    </span>
    <span className={styles.messageBottom}>
      <time className={styles.compactTime}>{entry.clock}</time>
      <span className={styles.preview} title={entry.preview}>{entry.preview || (entry.payloadHex ? '不可见字符 · 查看 HEX 字节' : '空载荷（0 字节）')}</span>
      <small>QoS {entry.qos ?? 0}</small>{entry.retain && <small className={styles.retainBadge}>Retain</small>}
      <small>{entry.byteLength ?? (entry.payloadHex?.length ?? 0) / 2} B</small>
    </span>
  </button>;
});

/** MQTT 3.1.1 desktop client. Network and TLS work stays in the native worker. */
export function MqttDebugger({ tool, onBack }: { tool: ToolDefinition; onBack(): void }) {
  const [options, setOptions] = useState(initialOptions);
  const [snapshot, setSnapshot] = useState<MqttSessionSnapshot | null>(null);
  const [advanced, setAdvanced] = useState(false);
  const [events, setEvents] = useState<MessageEntry[]>([]);
  const eventsRef = useRef<MessageEntry[]>([]);
  const [direction, setDirection] = useState<'all' | 'rx' | 'tx'>('all');
  const [detailOpen, setDetailOpen] = useState(false);
  const [following, setFollowing] = useState(true);
  const followingRef = useRef(true);
  const [newMessages, setNewMessages] = useState(0);
  const [discarded, setDiscarded] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);
  const readingAnchor = useRef<{ id: string; top: number } | null>(null);
  const generation = useRef(0);
  const commandRevision = useRef(0);
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
  const [errors, setErrors] = useState<Record<FeedbackScope, string>>({ connection: '', subscription: '', publish: '' });
  const [copyError, setCopyError] = useState('');
  const { toast, notify, dismiss } = useActionToast();
  const lastNativeError = useRef('');
  const mounted = useRef(true);
  const commandPending = useRef(false);
  const activeRef = useRef(false);
  const sessionRequestedRef = useRef(false);
  const setFeedback = useCallback((scope: FeedbackScope, message: string) => {
    setErrors((current) => current[scope] === message ? current : { ...current, [scope]: message });
  }, []);
  const applyNativeError = useCallback((message: string) => {
    // Polling a persistent native error must not reannounce it or replace a newer
    // validation message. Unrelated actions never clear another card's error.
    if (message && message !== lastNativeError.current) {
      setFeedback(/订阅|SUBACK|UNSUBACK/i.test(message) ? 'subscription' : 'connection', message);
    }
    lastNativeError.current = message;
  }, [setFeedback]);

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
    return events.filter((event) => (direction === 'all' || event.kind === (direction === 'rx' ? 'message' : 'published'))
      && (!needle || event.searchText.includes(needle)));
  }, [events, filter, direction]);
  // Selection is explicit. Filtering/retention never substitutes another message.
  const selected = detailOpen ? visibleMessages.find((event) => event.id === selectedId) ?? null : null;
  const selectedContent = useMemo(() => !selected ? '' : contentMode === 'hex'
    ? spacedHex(selected.payloadHex ?? '') : selected.text, [selected, contentMode]);

  const captureReadingAnchor = useCallback(() => {
    if (followingRef.current || !listRef.current) return;
    const list = listRef.current;
    const anchor = Array.from(list.querySelectorAll<HTMLButtonElement>('[data-message-id]'))
      .find((node) => node.offsetTop + node.offsetHeight > list.scrollTop);
    readingAnchor.current = anchor ? { id: anchor.dataset.messageId!, top: anchor.offsetTop - list.scrollTop } : null;
  }, []);

  const followLatest = useCallback((enabled: boolean) => {
    followingRef.current = enabled;
    setFollowing(enabled);
    readingAnchor.current = null;
    if (enabled) {
      setNewMessages(0);
      if (listRef.current) listRef.current.scrollTop = listRef.current.scrollHeight;
    }
  }, []);

  const selectMessage = useCallback((id: number) => {
    followLatest(false);
    setSelectedId(id);
    setDetailOpen(true);
    setCopyError('');
  }, [followLatest]);

  const clearMessages = useCallback(() => {
    eventsRef.current = [];
    setEvents([]);
    setSelectedId(null);
    setDetailOpen(false);
    setCopyError('');
    setNewMessages(0);
    setDiscarded(0);
    readingAnchor.current = null;
  }, []);

  const applyPoll = useCallback((next: { snapshot: MqttSessionSnapshot; events: MqttEvent[] }, acceptSnapshot: boolean) => {
    if (!mounted.current) return;
    // An older in-flight poll must not roll back a command's current snapshot.
    if (acceptSnapshot) {
      setSnapshot(next.snapshot);
      applyNativeError(next.snapshot.lastError);
    }
    const incoming = next.events.filter((event) => event.kind === 'message' || event.kind === 'published').map(prepareMessage);
    if (!incoming.length) return;
    captureReadingAnchor();
    const combined = [...eventsRef.current, ...incoming];
    const retained = trimMessages(combined);
    eventsRef.current = retained;
    setEvents(retained);
    setDiscarded((current) => current + combined.length - retained.length);
    if (!followingRef.current) setNewMessages((current) => current + incoming.length);
  }, [captureReadingAnchor, applyNativeError]);

  useEffect(() => {
    if (selectedId !== null && !visibleMessages.some((event) => event.id === selectedId)) {
      setSelectedId(null);
      setDetailOpen(false);
    }
  }, [selectedId, visibleMessages]);

  useLayoutEffect(() => {
    const list = listRef.current;
    if (!list) return;
    if (followingRef.current) list.scrollTop = list.scrollHeight;
    else if (readingAnchor.current) {
      const anchor = list.querySelector<HTMLButtonElement>(`[data-message-id="${readingAnchor.current.id}"]`);
      if (anchor) list.scrollTop = anchor.offsetTop - readingAnchor.current.top;
    }
    readingAnchor.current = null;
  }, [visibleMessages]);


  useEffect(() => {
    mounted.current = true;
    let disposed = false;
    let timer = 0;
    const poll = async () => {
      if (disposed || !isNativeHost) return;
      if (!commandPending.current) {
        const token = generation.current;
        const revision = commandRevision.current;
        try {
          const result = await requestMqttPoll();
          if (!disposed && token === generation.current) applyPoll(result, revision === commandRevision.current && !commandPending.current);
        } catch (reason) { if (!disposed && token === generation.current && revision === commandRevision.current) setFeedback('connection', errorText(reason)); }
      }
      if (!disposed) timer = window.setTimeout(poll, activeRef.current ? 200 : 800);
    };
    void poll();
    return () => {
      disposed = true;
      mounted.current = false;
      window.clearTimeout(timer);
      if (isNativeHost && (activeRef.current || sessionRequestedRef.current)) void requestMqttStop().catch(() => undefined);
    };
  }, [applyPoll, setFeedback]);

  const run = async (scope: FeedbackScope, operation: () => Promise<MqttSessionSnapshot>, success = '') => {
    if (commandPending.current) return;
    commandPending.current = true;
    commandRevision.current += 1;
    const token = generation.current;
    setBusy(true);
    setFeedback(scope, '');
    try {
      const next = await operation();
      if (operation === requestMqttStop) sessionRequestedRef.current = false;
      if (mounted.current && token === generation.current) {
        setSnapshot(next);
        applyNativeError(next.lastError);
        if (success && !next.lastError) notify(success);
      }
    } catch (reason) { if (mounted.current) setFeedback(scope, errorText(reason)); }
    finally { commandPending.current = false; if (mounted.current) setBusy(false); }
  };

  const toggleConnection = () => {
    if (!isNativeHost || commandPending.current) return;
    if (active) { void run('connection', requestMqttStop); return; }
    const host = options.host.trim();
    const clientId = options.clientId.trim();
    if (!host || host.length > 253) { setFeedback('connection', '请填写有效的 Broker 地址。'); return; }
    if (!Number.isInteger(options.port) || options.port < 1 || options.port > 65_535) { setFeedback('connection', '端口必须是 1–65535 的整数。'); return; }
    if (!clientId || new TextEncoder().encode(clientId).length > 128) { setFeedback('connection', '客户端 ID 不能为空且不能超过 128 字节。'); return; }
    if (!Number.isInteger(options.keepAlive) || options.keepAlive < 5 || options.keepAlive > 3600) { setFeedback('connection', 'Keep Alive 必须是 5–3600 秒。'); return; }
    const requestOptions = { ...options, host, clientId, cleanSession: true };
    setOptions((current) => ({ ...current, password: '' }));
    generation.current += 1;
    sessionRequestedRef.current = true;
    clearMessages();
    void run('connection', () => requestMqttStart(requestOptions));
  };

  const subscribe = () => {
    if (!isNativeHost || !connected || commandPending.current) return;
    const topic = subscriptionTopic.trim();
    if (!validTopicFilter(topic)) { setFeedback('subscription', '订阅主题过滤器不正确；+ 必须独占一层，# 只能位于末尾。'); return; }
    void run('subscription', () => requestMqttSubscribe(topic, subscriptionQos), `已提交订阅：${topic}`);
  };
  const unsubscribe = (topic: string) => void run('subscription', () => requestMqttUnsubscribe(topic), `已提交取消订阅：${topic}`);

  const publish = () => {
    if (!isNativeHost || !connected || commandPending.current) return;
    const topic = publishTopic.trim();
    if (!validTopicName(topic)) { setFeedback('publish', '发布主题不能为空，也不能包含 + 或 # 通配符。'); return; }
    if (encoded.error) { setFeedback('publish', encoded.error); return; }
    void run('publish', () => requestMqttPublish(topic, encoded.hex, publishQos, retain), `已提交发布：${topic}`);
  };

  const updateOption = <K extends keyof MqttStartOptions>(key: K, value: MqttStartOptions[K]) => {
    setOptions((current) => ({ ...current, [key]: value }));
  };
  const handlePublishKey = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if ((event.ctrlKey || event.metaKey) && event.key === 'Enter' && !event.repeat) { event.preventDefault(); publish(); }
  };

  const showMessage = (index: number) => {
    const entry = visibleMessages[index];
    if (!entry) return;
    selectMessage(entry.id);
    const list = listRef.current;
    const row = list?.querySelector<HTMLButtonElement>(`[data-message-id="${entry.id}"]`);
    if (!list || !row) return;
    if (row.offsetTop < list.scrollTop) list.scrollTop = row.offsetTop;
    else if (row.offsetTop + row.offsetHeight > list.scrollTop + list.clientHeight) list.scrollTop = row.offsetTop + row.offsetHeight - list.clientHeight;
  };
  const selectedIndex = selected ? visibleMessages.findIndex((entry) => entry.id === selected.id) : -1;
  const copyMessage = async () => {
    try {
      await navigator.clipboard.writeText(selectedContent);
      if (mounted.current) { setCopyError(''); notify('消息内容已复制。'); }
    } catch { if (mounted.current) setCopyError('复制失败，请检查剪贴板权限。'); }
  };


  return <section className={styles.workspace} data-testid="mqtt-workspace">
    <ToolWorkspaceHeader title={tool.name} onBack={onBack} />
    <div className={styles.workbench}>
      <aside className={styles.controls} data-testid="mqtt-controls" aria-label="MQTT 操作面板">
        <section className={styles.connection} aria-label="MQTT 连接参数">
          <header><h3>Broker 连接</h3><span className={styles.protocol}>MQTT 3.1.1</span></header>
          <div className={styles.connectionFields}>
            <label className={styles.host}>Broker 地址<input aria-label="MQTT Broker 地址" value={options.host} disabled={connectionLocked} spellCheck={false} onChange={(event) => updateOption('host', event.target.value)} /></label>
            <label>端口<input aria-label="MQTT Broker 端口" type="number" min="1" max="65535" value={options.port} disabled={connectionLocked} onChange={(event) => updateOption('port', Number(event.target.value))} /></label>
            <label className={styles.clientId}>客户端 ID<input aria-label="MQTT 客户端 ID" value={options.clientId} disabled={connectionLocked} spellCheck={false} onChange={(event) => updateOption('clientId', event.target.value)} /></label>
          </div>
          <button type="button" className={active ? styles.stop : styles.primary} disabled={!isNativeHost || busy || state === 'stopping'} onClick={toggleConnection}>{busy ? '处理中…' : active ? '断开连接' : '连接 Broker'}</button>
          <div className={styles.connectionFooter}>
            <strong className={connected ? styles.connected : undefined}>● {stateText[state] ?? state}</strong>
            <button type="button" aria-expanded={advanced} aria-controls="mqtt-advanced-options" onClick={() => setAdvanced((value) => !value)}>认证与 TLS {advanced ? '⌃' : '⌄'}</button>
          </div>
          {advanced && <div className={styles.advanced} id="mqtt-advanced-options">
            <label>用户名<input autoComplete="username" value={options.username} disabled={connectionLocked} onChange={(event) => updateOption('username', event.target.value)} /></label>
            <label>密码<input type="password" autoComplete="new-password" value={options.password} disabled={connectionLocked} onChange={(event) => updateOption('password', event.target.value)} /></label>
            <label>Keep Alive（秒）<input type="number" min="5" max="3600" value={options.keepAlive} disabled={connectionLocked} onChange={(event) => updateOption('keepAlive', Number(event.target.value))} /></label>
            <span className={styles.sessionMode}>新会话 · 不保存密码</span>
            <label className={styles.check}><input type="checkbox" checked={options.tls} disabled={connectionLocked} onChange={(event) => { updateOption('tls', event.target.checked); if (event.target.checked && options.port === 1883) updateOption('port', 8883); }} />TLS（系统证书校验）</label>
            <small>TLS 校验证书链与主机名，不跳过验证。</small>
          </div>}
          {errors.connection && <p role="alert" className={styles.error} data-testid="mqtt-connection-feedback">{errors.connection}</p>}
          {!isNativeHost && <p role="status" className={styles.notice}>MQTT 连接仅在 Windows 桌面客户端可用；浏览器不会模拟连接。</p>}
        </section>

        <section className={styles.subscriptions} aria-label="MQTT 订阅">
          <header><h3>主题订阅</h3><span>{snapshot?.subscriptions.length ?? 0}</span></header>
          <label>主题过滤器<input aria-label="MQTT 订阅主题" value={subscriptionTopic} spellCheck={false} onChange={(event) => setSubscriptionTopic(event.target.value)} /></label>
          <div className={styles.subscribeActions}><label>QoS<select aria-label="订阅 QoS" value={subscriptionQos} onChange={(event) => setSubscriptionQos(Number(event.target.value) as MqttQos)}><option value="0">0</option><option value="1">1</option><option value="2">2</option></select></label><button className={styles.primary} disabled={!connected || busy} onClick={subscribe}>订阅</button></div>
          <div className={styles.subscriptionList}>{snapshot?.subscriptions.length ? snapshot.subscriptions.map((entry) => <div key={entry.topic}><span title={entry.topic}>{entry.topic}</span><small>QoS {entry.qos}</small><button aria-label={`取消订阅 ${entry.topic}`} disabled={!connected || busy} onClick={() => unsubscribe(entry.topic)}>×</button></div>) : <p>支持 <code>+</code> 单层 / <code>#</code> 多层通配符</p>}</div>
          {errors.subscription && <p role="alert" className={styles.error} data-testid="mqtt-subscription-feedback">{errors.subscription}</p>}
        </section>

        <section className={styles.publish} aria-label="MQTT 发布">
          <header><h3>发布消息</h3><span className={encoded.error ? styles.invalid : undefined}>{encoded.error ? 'HEX 无效' : `${encoded.bytes} 字节`}</span></header>
          <label>发布主题<input aria-label="MQTT 发布主题" value={publishTopic} spellCheck={false} onChange={(event) => setPublishTopic(event.target.value)} /></label>
          <div className={styles.publishControls}><label>QoS<select aria-label="发布 QoS" value={publishQos} onChange={(event) => setPublishQos(Number(event.target.value) as MqttQos)}><option value="0">0</option><option value="1">1</option><option value="2">2</option></select></label><label className={styles.check}><input type="checkbox" checked={retain} onChange={(event) => setRetain(event.target.checked)} />Retain</label></div>
          <div className={styles.publishEditor}>
            <div className={styles.segmented}><button aria-pressed={payloadMode === 'text'} onClick={() => setPayloadMode('text')}>文本</button><button aria-pressed={payloadMode === 'hex'} onClick={() => setPayloadMode('hex')}>HEX</button></div>
            <textarea aria-label="MQTT 发布内容" value={payload} spellCheck={false} onChange={(event) => setPayload(event.target.value)} onKeyDown={handlePublishKey} />
          </div>
          {(encoded.error || errors.publish) && <p role="alert" className={styles.error} data-testid="mqtt-publish-feedback">{encoded.error || errors.publish}</p>}
          <button className={styles.primary} disabled={!connected || busy || !!encoded.error} onClick={publish}>发布 <kbd>Ctrl Enter</kbd></button>
        </section>
      </aside>

      <section className={styles.messages} aria-label="MQTT 消息" data-testid="mqtt-messages">
        <header className={styles.messageHeader}><h3>消息记录 <span>{visibleMessages.length}{visibleMessages.length !== events.length ? ` / ${events.length}` : ''}</span></h3><div className={styles.counters}><span className={styles.rx}>RX {snapshot?.rxMessages ?? 0}<small>{snapshot?.rxBytes ?? 0} B</small></span><span className={styles.tx}>TX {snapshot?.txMessages ?? 0}<small>{snapshot?.txBytes ?? 0} B</small></span></div><button disabled={!events.length} onClick={() => { clearMessages(); notify('消息记录已清空，收发统计继续累计。'); }}>清空</button></header>
        <div className={styles.filters}>
          <input aria-label="筛选 MQTT 消息" placeholder="搜索主题或消息内容…" value={filter} onChange={(event) => { readingAnchor.current = null; setFilter(event.target.value); }} />
          <select aria-label="MQTT 消息方向" value={direction} onChange={(event) => { readingAnchor.current = null; setDirection(event.target.value as typeof direction); }}><option value="all">全部消息</option><option value="rx">RX 接收</option><option value="tx">TX 发布</option></select>
          <label className={styles.check}><input aria-label="跟随最新消息" type="checkbox" checked={following} onChange={(event) => followLatest(event.target.checked)} />跟随最新</label>
        </div>
        <div className={`${styles.messageBody} ${selected ? styles.hasDetail : ''}`}>
          <div className={styles.listPanel}>
            <div className={styles.listCaption}><span>方向 / 主题 / 内容摘要</span><span>时间 · QoS · 字节</span></div>
            <div className={styles.messageList} ref={listRef} role="listbox" aria-label="MQTT 消息列表" tabIndex={0} aria-activedescendant={selected ? `mqtt-message-${selected.id}` : undefined}
              onScroll={(event) => { const list = event.currentTarget; if (followingRef.current && list.scrollHeight - list.clientHeight - list.scrollTop > 36) followLatest(false); }}
              onKeyDown={(event) => {
                if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key) || !visibleMessages.length) return;
                event.preventDefault();
                const index = visibleMessages.findIndex((entry) => entry.id === selectedId);
                const next = event.key === 'Home' ? 0 : event.key === 'End' ? visibleMessages.length - 1
                  : Math.max(0, Math.min(visibleMessages.length - 1, index + (event.key === 'ArrowDown' ? 1 : -1)));
                showMessage(next);
              }}>
              {visibleMessages.length ? visibleMessages.map((entry) => <MessageRow key={entry.id} entry={entry} selected={selected?.id === entry.id} onSelect={selectMessage} />) : <div className={styles.empty}>
                <strong>{events.length ? '没有匹配的消息' : '等待 MQTT 消息'}</strong>
                <p>{events.length ? '试试其他关键词或收发方向。' : '接收与发布的消息都会显示主题和内容摘要。'}</p>
              </div>}
            </div>
          </div>
          {selected && <aside className={styles.content} data-testid="mqtt-detail" aria-label="MQTT 消息详情">
            <header><h3>消息详情</h3><button aria-label="收起消息详情" onClick={() => { setDetailOpen(false); setSelectedId(null); }}>收起 ×</button></header>
            <nav className={styles.detailNavigation} aria-label="浏览 MQTT 消息"><button aria-label="上一条 MQTT 消息" disabled={selectedIndex <= 0} onClick={() => showMessage(selectedIndex - 1)}>← 上一条</button><span>{selectedIndex + 1} / {visibleMessages.length}</span><button aria-label="下一条 MQTT 消息" disabled={selectedIndex >= visibleMessages.length - 1} onClick={() => showMessage(selectedIndex + 1)}>下一条 →</button></nav>
            <div className={styles.detailMeta}><span className={selected.kind === 'message' ? styles.rx : styles.tx}>{selected.kind === 'message' ? 'RX 接收' : 'TX 发布'}</span><time>{selected.clock}</time><span>QoS {selected.qos ?? 0}</span>{selected.retain && <span className={styles.retainBadge}>Retain</span>}<span>{selected.byteLength ?? (selected.payloadHex?.length ?? 0) / 2} B</span></div>
            <strong className={styles.detailTopic}>{selected.topic}</strong>
            <div className={styles.contentToolbar}><div className={styles.segmented}><button aria-pressed={contentMode === 'text'} onClick={() => setContentMode('text')}>文本</button><button aria-pressed={contentMode === 'hex'} onClick={() => setContentMode('hex')}>HEX</button></div><button onClick={() => void copyMessage()}>复制</button></div>
            {copyError && <p role="alert" className={`${styles.error} ${styles.copyError}`} data-testid="mqtt-copy-feedback">{copyError}</p>}
            <pre aria-label="消息内容">{selected.payloadHex ? selectedContent || '不可见字符，请切换 HEX 查看字节。' : '空载荷（0 字节）'}</pre>
          </aside>}
        </div>
        <footer className={styles.messageFooter}>{!following && newMessages > 0 && <button type="button" className={styles.newMessages} onClick={() => followLatest(true)}>查看新消息（{newMessages}） ↓</button>}<span>{following ? '跟随最新消息' : '正在查看历史 · 接收继续'}{discarded > 0 ? ` · 已淘汰 ${discarded} 条旧消息` : ''}</span><span>最多 2,000 条 / 4 MiB 缓存</span></footer>
      </section>
    </div>
    <ActionToast toast={toast} onDismiss={dismiss} />
  </section>;
}
