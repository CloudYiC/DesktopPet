import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { requestNetworkInterfaces, requestNetworkPoll, requestNetworkSend, requestNetworkStart, requestNetworkStop } from '../bridge/hostBridge';
import type { NetworkDebugEvent, NetworkInterface, NetworkSessionSnapshot, NetworkStartOptions, NetworkMode } from '../types';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { PacketTemplateDialog } from './PacketTemplateDialog';
import { ToolWorkspaceHeader } from '../../../shared/tool-workspace/ToolWorkspaceHeader';
import type { ToolDefinition } from './catalog';
import { createDefaultPacketDraft, validatePacketDraft, encodePacketPayload, convertPacketPayloadMode, isMulticastHost, encodeNetworkPayload, packetNetworkMode,
  parsePacketLibrary, serializePacketLibrary, mergePacketLibraries, PACKET_LIBRARY_STORAGE_KEY, MAX_PACKET_LIBRARY_BYTES,
  type PacketSenderDraft, type PacketLibrary, type SavedPacket } from './packetSenderModel';
import styles from './NetworkDebugger.module.scss';

const native = Boolean(window.chrome?.webview);
const errorText = (error: unknown) => error instanceof Error ? error.message : '操作失败，请重试。';
const pause = (ms: number) => new Promise<void>((resolve) => window.setTimeout(resolve, ms));
const ready = (snapshot: NetworkSessionSnapshot | null) => snapshot?.state === 'connected' || snapshot?.state === 'ready' || snapshot?.state === 'listening';
const localOnly = (address: string) => /^127\./.test(address) || address === 'localhost';
type LogEvent = NetworkDebugEvent & { uiId: number };
class DisconnectedPeerError extends Error {}
type NetworkAction = 'connect' | 'join' | 'send';
type NetworkReview = { packet: PacketSenderDraft; count: number | null; action: NetworkAction; changedBinding: boolean; options: NetworkStartOptions; peerIds: string[] };
const defaultDraft = (): PacketSenderDraft => ({ ...createDefaultPacketDraft(), protocol: 'tcp', networkMode: 'tcp-client' });
const modeName = (mode: NetworkMode) => mode === 'tcp-server' ? 'TCP 服务端' : mode === 'tcp-client' ? 'TCP 客户端' : 'UDP';
function initialLibrary() {
  try { const raw = localStorage.getItem(PACKET_LIBRARY_STORAGE_KEY); return { library: raw ? parsePacketLibrary(raw) : { schemaVersion: 1 as const, packets: [] }, error: '' }; }
  catch (error) { return { library: { schemaVersion: 1 as const, packets: [] }, error: `报文模板读取失败，原数据未覆盖：${errorText(error)}` }; }
}
function download(name: string, content: string) {
  const url = URL.createObjectURL(new Blob([content], { type: 'application/json;charset=utf-8' }));
  const link = document.createElement('a'); link.href = url; link.download = name; link.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function trimEvents(items: LogEvent[]) {
  let used = 0, start = items.length;
  while (start > 0 && items.length - start < 5000) {
    const event = items[start - 1]; const length = (event.dataHex?.length ?? 0) + (event.message?.length ?? 0) + (event.peerLabel?.length ?? 0) + 100;
    if (used + length > 4 * 1024 * 1024) break;
    used += length; start -= 1;
  }
  return items.slice(start);
}
function logPayload(event: NetworkDebugEvent, mode: 'text' | 'hex' | 'escaped') {
  if (!event.dataHex) return event.message ?? '';
  try { const encoded = encodePacketPayload({ protocol: 'tcp', dataMode: 'hex', payload: event.dataHex }); return mode === 'text' ? new TextDecoder().decode(encoded.bytes).replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '·') : mode === 'hex' ? encoded.hex.match(/../g)?.join(' ').toUpperCase() : encoded.escaped; }
  catch { return event.dataHex; }
}


/** One native session for connection debugging and saved-packet workflows. */
export function NetworkDebugger({ tool, onBack }: { tool: ToolDefinition; onBack(): void }) {
  const [initial] = useState(initialLibrary);
  const [library, setLibrary] = useState<PacketLibrary>(initial.library);
  const [draft, setDraft] = useState<PacketSenderDraft>(defaultDraft);
  const [selectedId, setSelectedId] = useState('');
  const [search, setSearch] = useState('');
  const [templatesOpen, setTemplatesOpen] = useState(false);
  const [templateFeedback, setTemplateFeedback] = useState<{ text: string; error: boolean } | null>(null);
  const [adapters, setAdapters] = useState<NetworkInterface[]>([]);
  const [adaptersLoading, setAdaptersLoading] = useState(false);
  const [review, setReview] = useState<NetworkReview | null>(null);
  const [busy, setBusy] = useState(false);
  const [sending, setSending] = useState(false);
  const [snapshot, setSnapshot] = useState<NetworkSessionSnapshot | null>(null);
  const [events, setEvents] = useState<LogEvent[]>([]);
  const [logMode, setLogMode] = useState<'text' | 'hex' | 'escaped'>('text');
  const [showTime, setShowTime] = useState(true);
  const [follow, setFollow] = useState(true);
  const [unseen, setUnseen] = useState(false);
  const [peerTarget, setPeerTarget] = useState('all');
  const [error, setError] = useState(initial.error);
  const [notice, setNotice] = useState('');
  const [progress, setProgress] = useState('');
  const [deleteTarget, setDeleteTarget] = useState<SavedPacket | null>(null);
  const alive = useRef(true), generation = useRef(0), locked = useRef(false), ownsSession = useRef(false);
  const stopping = useRef(false), eventSequence = useRef(0), editRevision = useRef(0);
  const libraryRef = useRef(library);
  const activeKey = useRef(''), latest = useRef<NetworkSessionSnapshot | null>(null);
  const sessionOptions = useRef<NetworkStartOptions | null>(null), approvedKey = useRef('');
  const sessionRequestedPort = useRef<number | null>(null);
  const reviewRef = useRef<NetworkReview | null>(null), adapterRequest = useRef(0);
  const runControl = useRef<{ cancelled: boolean } | null>(null), lastTrafficError = useRef('');
  const followTail = useRef(true), followEnabled = useRef(true);
  const log = useRef<HTMLDivElement>(null), importInput = useRef<HTMLInputElement>(null), payloadFile = useRef<HTMLInputElement>(null);
  const payloadInput = useRef<HTMLTextAreaElement>(null), templateSearch = useRef<HTMLInputElement>(null);
  const templateReturnFocus = useRef<HTMLElement | null>(null);
  const mode = packetNetworkMode(draft);
  const preview = useMemo(() => { try { return { value: encodeNetworkPayload(draft), error: '' }; } catch (e) { return { value: null, error: errorText(e) }; } }, [draft]);
  const filtered = library.packets.filter((packet) => (packet.name + ' ' + packet.host + ' ' + packet.port).toLowerCase().includes(search.toLowerCase()));
  const multicast = mode === 'udp' && isMulticastHost(draft.host);
  const peers = snapshot?.mode === 'tcp-server' ? snapshot.peers : [];
  const adapterName = (address: string) => address === '0.0.0.0' ? '自动选择网卡' : localOnly(address) ? '仅本机回环' : adapters.find((item) => item.address === address)?.name || '指定网卡';
  const current = (token: number) => alive.current && token === generation.current;
  const updateSnapshot = (next: NetworkSessionSnapshot) => { latest.current = next; setSnapshot(next); };
  const poll = async (token: number) => {
    const result = await requestNetworkPoll();
    if (!alive.current) return null;
    const belongsToRun = current(token);
    if (belongsToRun) updateSnapshot(result.snapshot);
    if (result.events.length) {
      const incoming = result.events.map((event) => ({ ...event, uiId: ++eventSequence.current }));
      const failure = incoming.find((event) => event.kind === 'error');
      if (failure && belongsToRun) lastTrafficError.current = failure.message || '网络发送出现错误。';
      // Poll drains the native event queue. A new send invalidates the snapshot,
      // not the traffic already read from the same session's history.
      setEvents((old) => trimEvents([...old, ...incoming]));
      if (!followEnabled.current || !followTail.current) setUnseen(true);
    }
    return belongsToRun ? result.snapshot : null;
  };
  useEffect(() => {
    alive.current = true;
    let disposed = false, timer = 0;
    const tick = async () => {
      if (disposed) return;
      const token = generation.current;
      if (ownsSession.current && !locked.current) {
        try { const next = await poll(token); if (next?.lastError && current(token)) setError(next.lastError); }
        catch (e) { if (current(token)) setError(errorText(e)); }
      }
      if (!disposed) timer = window.setTimeout(tick, 250);
    };
    void tick();
    return () => {
      disposed = true; alive.current = false; generation.current += 1;
      if (runControl.current) runControl.current.cancelled = true;
      window.clearTimeout(timer); ownsSession.current = false;
      void requestNetworkStop().catch(() => undefined);
    };
  }, []);
  useLayoutEffect(() => {
    if (follow && followTail.current && log.current) { log.current.scrollTop = log.current.scrollHeight; setUnseen(false); }
  }, [events, logMode, showTime, follow]);
  const refreshAdapters = async () => {
    const request = ++adapterRequest.current; setAdaptersLoading(true);
    try { const items = await requestNetworkInterfaces(); if (alive.current && request === adapterRequest.current) setAdapters(items); }
    catch (e) { if (alive.current && request === adapterRequest.current) setError('无法读取网卡：' + errorText(e) + ' 可重试或选择自动网卡。'); }
    finally { if (alive.current && request === adapterRequest.current) setAdaptersLoading(false); }
  };
  useEffect(() => { void refreshAdapters(); }, []);

  const optionsFor = (packet: PacketSenderDraft, join: boolean): NetworkStartOptions => {
    const nextMode = packetNetworkMode(packet), group = nextMode === 'udp' && isMulticastHost(packet.host);
    const options: NetworkStartOptions = {
      mode: nextMode, localHost: group ? '0.0.0.0' : packet.localAddress, localPort: packet.localPort,
      remoteHost: nextMode === 'tcp-server' ? '' : packet.host, remotePort: nextMode === 'tcp-server' ? 0 : packet.port,
      allowLan: group || !localOnly(packet.localAddress),
      multicastInterface: group ? packet.localAddress : '', multicastTtl: group ? packet.multicastTtl : 1,
      multicastGroup: join ? packet.host : ''
    };
    const previous = sessionOptions.current;
    const sameEndpoint = group && previous && ownsSession.current && ready(latest.current) &&
      previous.remoteHost === options.remoteHost && previous.remotePort === options.remotePort &&
      sessionRequestedPort.current === packet.localPort && previous.multicastInterface === options.multicastInterface &&
      previous.multicastTtl === options.multicastTtl;
    if (sameEndpoint) options.localPort = previous.localPort || (join ? latest.current!.localPort : 0);
    if (!join && sameEndpoint && latest.current?.multicastJoined) options.multicastGroup = packet.host;
    return options;
  };

  const submit = (action: NetworkAction, count: number | null = 0) => {
    if (locked.current || !native) return;
    let packet: PacketSenderDraft;
    try {
      packet = validatePacketDraft({ ...draft, payload: action === 'send' ? draft.payload : '',
        repeatCount: count || draft.repeatCount });
      if (action !== 'send') packet.payload = draft.payload;
    } catch (e) { setError(errorText(e)); return; }
    const nextMode = packetNetworkMode(packet);
    if (nextMode === 'tcp-client' && isMulticastHost(packet.host)) { setError('组播目标请使用 UDP 协议，TCP 不支持组播。'); return; }
    if (action === 'join' && (nextMode !== 'udp' || !isMulticastHost(packet.host))) { setError('请填写有效的 IPv4 组播目标地址。'); return; }
    if (action === 'send' && !encodeNetworkPayload(packet).byteCount) { setError('请先填写至少 1 字节的发送内容。'); return; }
    const changedBinding = nextMode === 'udp' && isMulticastHost(packet.host) && localOnly(packet.localAddress);
    if (changedBinding) packet = { ...packet, localAddress: '0.0.0.0' };
    if (packet.localAddress !== '0.0.0.0' && !localOnly(packet.localAddress) && !adapters.some((item) => item.address === packet.localAddress)) {
      setError('保存的网卡当前不可用，请刷新并重新选择发送网卡。'); return;
    }
    const options = optionsFor(packet, action === 'join');
    let peerIds: string[] = [];
    if (action === 'send' && nextMode === 'tcp-server') {
      if (!ownsSession.current || !ready(latest.current) || latest.current?.mode !== 'tcp-server' || activeKey.current !== JSON.stringify(options)) {
        setError('请先按当前配置开始 TCP 监听，再等待客户端连接。'); return;
      }
      peerIds = peerTarget === 'all' ? latest.current.peers.map((peer) => peer.id) : [peerTarget];
      if (!peerIds.length || peerIds.some((id) => !latest.current!.peers.some((peer) => peer.id === id))) {
        setError('当前没有可用的目标客户端，请重新选择。'); return;
      }
    }
    const pending: NetworkReview = { packet, count, action, changedBinding, options, peerIds };
    if (options.allowLan && (!ownsSession.current || !ready(latest.current) || approvedKey.current !== JSON.stringify(options) || changedBinding || action === 'join')) {
      reviewRef.current = pending; setReview(pending); return;
    }
    void execute(pending);
  };
  const execute = async ({ packet, count, action, options, peerIds }: NetworkReview) => {
    if (locked.current || !alive.current) return;
    const bytes = action === 'send' ? encodeNetworkPayload(packet) : null;
    const key = JSON.stringify(options), token = ++generation.current;
    const control = { cancelled: false }; runControl.current = control; lastTrafficError.current = '';
    locked.current = true; setBusy(true); setSending(action === 'send'); setError(''); setNotice('');
    setProgress(action === 'join' ? '正在加入组播…' : action === 'connect' ? '正在建立会话…' : '准备发送');
    try {
      if (!ownsSession.current || activeKey.current !== key || !ready(latest.current)) {
        await requestNetworkStop(); if (!current(token)) return;
        ownsSession.current = true; activeKey.current = key; sessionOptions.current = options; sessionRequestedPort.current = packet.localPort;
        const next = await requestNetworkStart(options); if (!current(token)) return; updateSnapshot(next);
      }
      const deadline = Date.now() + 20000;
      while (current(token) && !ready(latest.current)) {
        const next = await poll(token); if (!current(token)) return;
        if (next?.state === 'error' || next?.state === 'stopped') throw new Error(next.lastError || '连接未建立。');
        if (Date.now() > deadline) throw new Error('等待连接超时。');
        if (!ready(next)) await pause(100);
      }
      if (!current(token)) return;
      // A confirmed request may reuse the same actual port after the user
      // changes an ephemeral-port draft to that explicit port.
      sessionRequestedPort.current = packet.localPort;
      if (action !== 'send') {
        if (action === 'join' && !latest.current?.multicastJoined) throw new Error('未确认加入组播组，请检查网卡与本地监听端口。');
        setNotice((action === 'join' ? '已加入 ' + packet.host : modeName(options.mode) + ' 已就绪') +
          '，本地 ' + latest.current!.localHost + ':' + latest.current!.localPort + '；未发送数据。');
        return;
      }
      const recipients: (string | undefined)[] = options.mode === 'tcp-server' ? peerIds : [undefined];
      let completed = 0;
      for (let index = 0; (count === null || index < count) && current(token) && !control.cancelled; index += 1) {
        for (const recipient of recipients) {
          if (!current(token) || control.cancelled) break;
          if (recipient && !latest.current?.peers.some((peer) => peer.id === recipient)) throw new DisconnectedPeerError('目标客户端已断开，后续发送已停止。');
          const before = latest.current?.txPackets ?? 0;
          const next = await requestNetworkSend(bytes!.hex, recipient); if (!current(token)) return; updateSnapshot(next);
          const sendDeadline = Date.now() + 20000;
          // Wait for the already-submitted TX even after Stop Sending. This avoids
          // attributing its late acknowledgment to a new run. Disconnect cancels now.
          while (current(token) && (latest.current?.txPackets ?? 0) <= before) {
            const state = await poll(token); if (!current(token)) return;
            if (!ready(state)) throw new Error(state?.lastError || '连接已关闭，后续发送已停止。');
            if (recipient && !state?.peers.some((peer) => peer.id === recipient)) throw new DisconnectedPeerError('目标客户端已断开，后续发送已停止。');
            if (lastTrafficError.current) throw new Error(lastTrafficError.current);
            if (Date.now() > sendDeadline) throw new Error('等待发送完成超时，已停止后续发送。');
            if ((latest.current?.txPackets ?? 0) <= before) await pause(50);
          }
        }
        if (!current(token)) return;
        if (control.cancelled) break;
        completed += 1;
        setProgress('已发送 ' + completed + (count === null ? ' 次 · 持续发送中' : ' / ' + count));
        if (count === null || index + 1 < count) {
          const nextAt = Date.now() + packet.intervalMs;
          while (current(token) && !control.cancelled && Date.now() < nextAt) {
            await pause(Math.min(100, nextAt - Date.now())); if (!current(token)) return;
            const state = await poll(token); if (!current(token)) return;
            if (lastTrafficError.current) throw new Error(lastTrafficError.current);
            if (!ready(state)) throw new Error(state?.lastError || '连接已关闭，后续发送已停止。');
          }
        }
      }
      if (current(token)) setNotice(control.cancelled ? '后续发送已停止，连接保留，可继续接收回包。' :
        '本机已完成 ' + completed + ' 次发送' + (options.mode === 'tcp-server' ? '（每次向 ' + peerIds.length + ' 个选定客户端发送）' : '') +
        '。TX 不代表对方已收到；等待 RX 响应。');
    } catch (e) {
      if (current(token)) {
        setError(errorText(e)); setProgress('操作已停止');
        if (e instanceof DisconnectedPeerError && options.mode === 'tcp-server' && latest.current?.state === 'listening') {
          setNotice('本批次已停止，TCP 监听及其他客户端保持连接。');
        } else {
          ownsSession.current = false; activeKey.current = ''; approvedKey.current = ''; sessionOptions.current = null;
          try { const next = await requestNetworkStop(); if (current(token)) updateSnapshot(next); } catch { /* Keep original error. */ }
        }
      }
    } finally {
      if (current(token)) { locked.current = false; setBusy(false); setSending(false); runControl.current = null; }
    }
  };
  const stopSending = () => {
    if (runControl.current) { runControl.current.cancelled = true; setProgress('后续发送已取消，等待已提交数据完成…'); }
  };
  const stop = async () => {
    if (stopping.current) return;
    stopping.current = true;
    if (runControl.current) runControl.current.cancelled = true;
    const token = ++generation.current; locked.current = true; setBusy(true); ownsSession.current = false;
    activeKey.current = ''; approvedKey.current = ''; sessionOptions.current = null; sessionRequestedPort.current = null;
    try { const next = await requestNetworkStop(); if (current(token)) { updateSnapshot(next); setProgress('已停止'); setNotice('已断开会话、释放端口并退出组播。'); } }
    catch (e) { if (current(token)) setError(errorText(e)); }
    finally { stopping.current = false; if (current(token)) { locked.current = false; setBusy(false); setSending(false); runControl.current = null; } }
  };
  const edit = <K extends keyof PacketSenderDraft>(key: K, value: PacketSenderDraft[K]) => {
    if (locked.current) return;
    editRevision.current += 1;
    setDraft((old) => ({ ...old, [key]: value })); setError(''); setProgress('');
  };
  const changeMode = (dataMode: PacketSenderDraft['dataMode']) => {
    if (locked.current) return;
    try { const payload = convertPacketPayloadMode(draft, dataMode); editRevision.current += 1; setDraft({ ...draft, dataMode, payload }); setError(''); }
    catch (e) { setError(errorText(e) + ' 原内容已保留。'); }
  };
  const changeNetworkMode = (networkMode: NetworkMode) => {
    if (locked.current) return;
    editRevision.current += 1; setPeerTarget('all'); setError('');
    setDraft((old) => ({ ...old, networkMode, protocol: networkMode === 'udp' ? 'udp' : 'tcp',
      localPort: networkMode === 'tcp-server' && old.localPort === 0 ? 9000 : old.localPort }));
  };
  const networkModes: NetworkMode[] = ['tcp-client', 'tcp-server', 'udp'];
  const showLatest = () => {
    followTail.current = true; followEnabled.current = true; setFollow(true); setUnseen(false);
    if (log.current) log.current.scrollTop = log.current.scrollHeight;
  };
  const persist = (next: PacketLibrary) => {
    if (initial.error) throw new Error('报文模板读取失败，禁止覆盖原数据。请先导出原始备份。');
    const json = serializePacketLibrary(next); localStorage.setItem(PACKET_LIBRARY_STORAGE_KEY, json); libraryRef.current = next; setLibrary(next);
  };
  const save = () => {
    try {
      const packet = validatePacketDraft(draft);
      if (!packet.name.trim()) throw new Error('保存前请填写模板名称。');
      const item: SavedPacket = { ...packet, id: selectedId || crypto.randomUUID(), updatedAt: new Date().toISOString() };
      persist({ schemaVersion: 1, packets: selectedId ? library.packets.map((old) => old.id === selectedId ? item : old) : [...library.packets, item] });
      setSelectedId(item.id); setNotice('报文模板已保存到本机；保存和载入都不会自动发送。'); setError('');
    } catch (e) { setError(errorText(e)); }
  };
  const load = (packet: SavedPacket) => {
    if (locked.current) return;
    const { id, updatedAt: _updatedAt, ...editable } = packet;
    editRevision.current += 1;
    setDraft(validatePacketDraft(editable)); setSelectedId(id); setPeerTarget('all'); approvedKey.current = ''; setError(''); setNotice('模板已载入，点击发送才会访问目标。');
    templateReturnFocus.current = payloadInput.current; setTemplatesOpen(false);
  };
  const importLibrary = async (file?: File) => {
    if (!file || locked.current) return;
    try { if (file.size > MAX_PACKET_LIBRARY_BYTES) throw new Error('模板文件不能超过 1 MiB。'); const incoming = parsePacketLibrary(await file.text()); if (!alive.current || locked.current) return; persist(mergePacketLibraries(libraryRef.current, incoming)); const text = `已导入 ${incoming.packets.length} 条模板，未执行发送。`; setNotice(text); setTemplateFeedback({ text, error: false }); setError(''); }
    catch (e) { if (alive.current) { setError(errorText(e)); setTemplateFeedback({ text: errorText(e), error: true }); } }
  };
  const loadFile = async (file?: File) => {
    if (!file || locked.current) return;
    const revision = ++editRevision.current;
    try { if (file.size > (draft.protocol === 'udp' ? 65507 : 65536)) throw new Error('文件超过单次报文容量。'); const bytes = new Uint8Array(await file.arrayBuffer()); if (!alive.current || locked.current || revision !== editRevision.current) return; setDraft((old) => ({ ...old, dataMode: 'hex', payload: Array.from(bytes, (v) => v.toString(16).padStart(2, '0')).join(' ') })); setNotice(`已载入 ${file.size} 字节，未发送。`); setError(''); }
    catch (e) { if (alive.current) setError(errorText(e)); }
  };
  const exportLibrary = () => { try { download('cloudyi-packets.json', initial.error ? localStorage.getItem(PACKET_LIBRARY_STORAGE_KEY) ?? '' : serializePacketLibrary(library)); } catch (e) { setError(errorText(e)); setTemplateFeedback({ text: errorText(e), error: true }); } };
  const copyLogs = async () => { try { await navigator.clipboard.writeText(events.map((event) => `${showTime ? new Date(event.timestamp).toISOString() + ' ' : ''}${event.kind} ${event.peerLabel ?? ''} ${event.byteLength} B ${logPayload(event, logMode)}`).join('\n')); setNotice('已复制收发记录。'); } catch (e) { setError(errorText(e)); } };


  const matchingSession = ownsSession.current && ready(snapshot) && activeKey.current === JSON.stringify(optionsFor(draft, false));
  const connectLabel = mode === 'tcp-server' ? '开始监听' : mode === 'udp' ? '绑定端口' : '连接服务';
  const disconnectLabel = mode === 'tcp-server' ? '停止监听' : mode === 'udp' ? '解除绑定' : '断开连接';
  return <section className={styles.workspace} data-testid="network-workspace">
    <ToolWorkspaceHeader title={tool.name} onBack={onBack} />
    {(error || notice) && <p className={error ? styles.error : styles.notice} role={error ? 'alert' : 'status'}>{error || notice}</p>}
    <div className={styles.modeBar}>
      <div className={styles.modeTabs} role="tablist" aria-label="网络模式">{networkModes.map((value, index) => <button key={value} role="tab" aria-selected={mode === value} aria-pressed={mode === value} tabIndex={mode === value ? 0 : -1} disabled={busy} onClick={() => changeNetworkMode(value)} onKeyDown={(event) => {
        const next = event.key === 'ArrowRight' ? (index + 1) % networkModes.length : event.key === 'ArrowLeft' ? (index + networkModes.length - 1) % networkModes.length : event.key === 'Home' ? 0 : event.key === 'End' ? networkModes.length - 1 : -1;
        if (next < 0 || busy) return;
        event.preventDefault(); changeNetworkMode(networkModes[next]);
        event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>('[role=tab]')[next]?.focus();
      }}>{modeName(value)}</button>)}</div>
      <span>{ready(snapshot) ? modeName(snapshot!.mode) + ' · 会话就绪' : '尚未连接'}</span>
    </div>
    <div className={styles.workbench}>
      <div className={styles.editor} data-testid="packet-sender-editor">
        <div className={styles.editScroll} data-testid="network-operations">
          <section className={styles.card} aria-label="连接参数">
            <div className={styles.interfaceRow}><label>本地地址 / 发送网卡<select aria-label="发送网卡" disabled={busy} value={draft.localAddress} onChange={(e) => edit('localAddress', e.target.value)}>
              <option value="0.0.0.0">{mode === 'tcp-server' ? '全部网卡（0.0.0.0）' : '自动选择网卡（系统路由）'}</option><option value="127.0.0.1">仅本机（127.0.0.1）</option>
              {adapters.filter((item) => !item.loopback).map((item) => <option value={item.address} key={item.index + '-' + item.address}>{item.name}（{item.address}）</option>)}
              {!['0.0.0.0', '127.0.0.1'].includes(draft.localAddress) && !adapters.some((item) => item.address === draft.localAddress) && <option value={draft.localAddress}>网卡不可用（{draft.localAddress}）</option>}
            </select></label><button disabled={busy || adaptersLoading} onClick={() => void refreshAdapters()}>{adaptersLoading ? '读取中…' : '刷新网卡'}</button></div>
            {mode !== 'tcp-server' && <div className={styles.targetRow}><label>远端主机<input aria-label="目标地址" value={draft.host} disabled={busy} maxLength={253} onChange={(e) => edit('host', e.target.value)} /></label><label>远端端口<input aria-label="目标端口" type="number" min={1} max={65535} value={draft.port} disabled={busy} onChange={(e) => edit('port', Number(e.target.value))} /></label></div>}
            <div className={styles.connectionRow}><label>本地端口（0 自动）<input aria-label="发包本地端口" type="number" min={0} max={65535} value={draft.localPort} disabled={busy} onChange={(e) => edit('localPort', Number(e.target.value))} /></label><button className={matchingSession ? styles.stop : styles.primary} disabled={!native || busy} onClick={() => matchingSession ? void stop() : submit('connect')}>{matchingSession ? disconnectLabel : connectLabel}</button></div>
            {multicast && <><div className={styles.multicastRow}><label>组播 TTL<input aria-label="组播 TTL" type="number" min={0} max={255} value={draft.multicastTtl} disabled={busy} onChange={(e) => edit('multicastTtl', Number(e.target.value))} /></label><button disabled={busy} onClick={() => edit('localPort', draft.port)}>同目标端口</button></div><div className={styles.connectionActions}><button disabled={!native || busy} onClick={() => submit('join')}>加入组播</button><button disabled={!snapshot?.multicastJoined || busy} onClick={() => void stop()}>退出组播</button></div></>}
            {multicast && <small className={styles.multicastHint}>发送不必加组；接收组播需加组并监听设备使用的端口。</small>}
            {mode === 'tcp-server' && <div className={styles.peerPanel} aria-label="TCP 客户端列表"><strong>已连接客户端 {peers.length}</strong><div>{peers.length ? peers.map((peer) => <button key={peer.id} disabled={busy} aria-pressed={peerTarget === peer.id} onClick={() => setPeerTarget(peer.id)}>{peer.address}:{peer.port}</button>) : <small>等待客户端连接</small>}</div></div>}
          </section>
          <section className={styles.card}>
            <header><h3>发送数据</h3><button className={styles.templateButton} aria-label="报文模板" aria-haspopup="dialog" onClick={() => { templateReturnFocus.current = null; setTemplateFeedback(initial.error ? { text: initial.error, error: true } : null); setTemplatesOpen(true); }}>报文模板 <span>{library.packets.length}</span></button></header>

            <div className={styles.payloadToolbar}><div className={styles.tabs} aria-label="发送数据方式">{([['text', '文本'], ['hex', 'HEX'], ['escaped', '转义字节']] as const).map(([value, label]) => <button key={value} aria-pressed={draft.dataMode === value} disabled={busy} onClick={() => changeMode(value)}>{label}</button>)}</div><span data-testid="packet-byte-count">{preview.value?.byteCount ?? 0} 字节</span><button disabled={busy} onClick={() => payloadFile.current?.click()}>载入文件</button></div>
            <textarea ref={payloadInput} className={styles.payloadInput} aria-label="报文内容" spellCheck={false} value={draft.payload} disabled={busy} onChange={(e) => edit('payload', e.target.value)} onKeyDown={(e) => { if ((e.ctrlKey || e.metaKey) && e.key === 'Enter' && !e.repeat) { e.preventDefault(); submit('send', 1); } }} />
            <label className={styles.packetTitle}>模板名称<input aria-label="模板名称" maxLength={80} value={draft.name} disabled={busy} onChange={(e) => edit('name', e.target.value)} /></label>
            <div className={styles.templateActions}><button disabled={busy} onClick={() => { editRevision.current += 1; setDraft(defaultDraft()); setSelectedId(''); setPeerTarget('all'); approvedKey.current = ''; setError(''); setNotice('新建草稿，未发送。'); }}>新建</button><button disabled={busy} onClick={save}>{selectedId ? '更新模板' : '保存模板'}</button></div>
            {draft.dataMode === 'escaped' && <small>转义字节：\00、\FF、\r、\n、\t、\\；普通文字按 UTF-8 编码。</small>}{preview.error && <p className={styles.warning}>{preview.error}</p>}{!native && <small>网络连接需要 Windows 客户端。</small>}
          </section>
        <section className={styles.sendDock + ' ' + styles.card} data-testid="network-send-actions">
          {mode === 'tcp-server' && <label className={styles.peerTarget}>发送目标<select aria-label="发送目标" disabled={busy} value={peerTarget} onChange={(e) => setPeerTarget(e.target.value)}><option value="all">全部已连接客户端（{peers.length}）</option>{peerTarget !== 'all' && !peers.some((peer) => peer.id === peerTarget) && <option value={peerTarget}>原目标已断开，请重新选择</option>}{peers.map((peer) => <option key={peer.id} value={peer.id}>{peer.address}:{peer.port}</option>)}</select></label>}
          <div className={styles.sendOptions}><label>行尾<select aria-label="行尾" value={draft.lineEnding ?? 'none'} disabled={busy} onChange={(e) => edit('lineEnding', e.target.value as PacketSenderDraft['lineEnding'])}><option value="none">不添加</option><option value="lf">LF（\n）</option><option value="crlf">CRLF（\r\n）</option></select></label><label>间隔（毫秒）<input aria-label="重发间隔" type="number" min={50} max={86400000} value={draft.intervalMs} disabled={busy} onChange={(e) => edit('intervalMs', Number(e.target.value))} /></label><label>发送次数<input aria-label="重发次数" type="number" min={1} max={1000} value={draft.repeatCount} disabled={busy} onChange={(e) => edit('repeatCount', Number(e.target.value))} /></label></div>
          <div className={styles.sendActions}><button className={styles.primary} disabled={!native || busy || !preview.value?.byteCount} onClick={() => submit('send', 1)}>发送一次</button><button disabled={!native || busy || !preview.value?.byteCount} onClick={() => submit('send', draft.repeatCount)}>重复发送</button><button disabled={!native || busy || !preview.value?.byteCount} onClick={() => submit('send', null)}>持续发送</button></div>
          <div className={styles.stopActions}><button disabled={!sending || stopping.current} onClick={stopSending}>停止发送</button><button className={styles.stop} disabled={!native || stopping.current || (!busy && !ownsSession.current)} onClick={() => void stop()}>停止 / 断开</button></div>
          {busy && <small className={styles.runProgress}>{progress}</small>}
        </section>
        </div>
      </div>
      <div className={styles.right} data-testid="packet-sender-results">
        <section className={styles.card + ' ' + styles.logPanel} data-testid="network-receive">
          <header><h3>收发记录</h3><div className={styles.tabs} aria-label="日志显示格式">{([['text', '文本'], ['hex', 'HEX'], ['escaped', '转义']] as const).map(([value, label]) => <button key={value} aria-pressed={logMode === value} onClick={() => setLogMode(value)}>{label}</button>)}</div><label className={styles.follow}><input aria-label="显示时间" type="checkbox" checked={showTime} onChange={(e) => setShowTime(e.target.checked)} />时间</label><label className={styles.follow}><input type="checkbox" checked={follow} onChange={(e) => { followEnabled.current = e.target.checked; setFollow(e.target.checked); if (e.target.checked) showLatest(); }} />自动滚动</label><button disabled={!events.length} onClick={() => void copyLogs()}>复制</button><button onClick={() => { setEvents([]); setUnseen(false); followTail.current = true; }}>清空</button></header>
          <div className={styles.session}><span>{busy ? progress : ready(snapshot) ? modeName(snapshot!.mode) + ' 会话保留中' : '未连接'}</span><span>TX {snapshot?.txPackets ?? 0} 次 · {snapshot?.txBytes ?? 0} B</span><span>RX {snapshot?.rxPackets ?? 0} 次 · {snapshot?.rxBytes ?? 0} B</span></div>
          {snapshot && ready(snapshot) && <div className={styles.endpoints}><span>监听 {snapshot.localHost}:{snapshot.localPort}</span>{snapshot.mode !== 'tcp-server' && <span>目标 {snapshot.remoteHost}:{snapshot.remotePort}</span>}{snapshot.mode === 'udp' && <span data-testid="packet-multicast-state">{snapshot.multicastJoined ? '已加入 ' + snapshot.multicastGroup : '未加入组播'}{snapshot.multicastInterface ? ' · ' + (snapshot.multicastInterface === '0.0.0.0' ? '系统网卡' : snapshot.multicastInterface) + ' · TTL ' + snapshot.multicastTtl : ''}</span>}{snapshot.mode === 'tcp-server' && <span>{peers.length} 个客户端</span>}</div>}
          <div className={styles.log} role="log" aria-label="网络收发记录" ref={log} onScroll={(e) => { const node = e.currentTarget; followTail.current = node.scrollHeight - node.scrollTop - node.clientHeight < 36; if (followTail.current) setUnseen(false); }}>
            {events.length ? events.map((event) => <div key={event.uiId} className={styles.logRow} data-kind={event.kind}><div>{showTime && <time>{new Date(event.timestamp).toLocaleTimeString('zh-CN', { hour12: false })}</time>}<b>{event.kind === 'sent' ? 'TX →' : event.kind === 'received' ? 'RX ←' : event.kind === 'error' ? '错误' : '状态'}</b><span>{event.peerLabel} {event.byteLength > 0 ? event.byteLength + ' B' : ''}</span></div><pre>{logPayload(event, logMode)}</pre></div>) : <div className={styles.logEmpty}>等待网络数据</div>}
          </div>
          {unseen && <button className={styles.newData} onClick={showLatest}>查看最新数据</button>}
          <footer><span>{events.length} 条记录 · 最多保留 5000 条 / 4 MiB</span>{snapshot?.mode !== 'udp' && <span>TCP 接收按数据块显示，不保证应用报文边界</span>}</footer>
        </section>
      </div>
    </div>
    <PacketTemplateDialog open={templatesOpen} count={library.packets.length} search={search} busy={busy} feedback={templateFeedback} returnFocus={templateReturnFocus} searchRef={templateSearch} onSearch={setSearch} onImport={() => importInput.current?.click()} onExport={exportLibrary} onClose={() => setTemplatesOpen(false)}>
      {filtered.length ? filtered.map((packet) => <article key={packet.id} data-selected={packet.id === selectedId}><button disabled={busy} onClick={() => load(packet)} title="载入编辑，不会自动发送"><strong>{packet.name}</strong><small>{modeName(packetNetworkMode(packet))} · {packetNetworkMode(packet) === 'tcp-server' ? packet.localAddress + ':' + packet.localPort : packet.host + ':' + packet.port}</small></button><button disabled={busy} onClick={() => load(packet)}>载入</button><button disabled={busy} aria-label={'删除模板 ' + packet.name} onClick={() => setDeleteTarget(packet)}>删除</button></article>) : <p>{library.packets.length ? '没有匹配的模板。' : '还没有报文模板。填写发送内容和模板名称，点击“保存模板”即可添加。'}</p>}
      <input ref={importInput} type="file" aria-label="模板导入文件" accept=".json,application/json" hidden onChange={(e) => { const file = e.target.files?.[0]; e.target.value = ''; void importLibrary(file); }} />
    </PacketTemplateDialog>
    <input ref={payloadFile} type="file" aria-label="发送内容文件" hidden onChange={(e) => { const file = e.target.files?.[0]; e.target.value = ''; void loadFile(file); }} />
    <ConfirmDialog open={!!review} title="确认网络操作" confirmLabel={review?.action === 'join' ? '确认并加入' : review?.action === 'connect' ? '确认并连接' : '确认并发送'} tone="primary" onCancel={() => { reviewRef.current = null; setReview(null); }} onConfirm={() => {
      const pending = reviewRef.current; if (!pending) return; reviewRef.current = null; setReview(null); approvedKey.current = JSON.stringify(pending.options);
      if (pending.changedBinding) { setDraft(pending.packet); editRevision.current += 1; } void execute(pending);
    }}>
      {review && <div className={styles.reviewContent}>
        <p>{review.action === 'join' ? '加入组播并开始监听，不发送编辑区数据。' : review.action === 'connect' ? '建立连接或开始监听，不发送编辑区数据。' : '按以下配置发送；加入组播不是发送的必要步骤。'}</p>
        <dl><dt>模式 / 目标</dt><dd>{modeName(review.options.mode)}{review.options.mode !== 'tcp-server' && ' · ' + review.packet.host + ':' + review.packet.port}</dd><dt>本地网卡</dt><dd>{adapterName(review.packet.localAddress)} · {review.packet.localAddress}</dd><dt>本地监听端口</dt><dd>{review.options.localPort || '系统分配（0）'}</dd>{review.options.mode === 'udp' && isMulticastHost(review.packet.host) && <><dt>组播 TTL</dt><dd>{review.packet.multicastTtl}</dd></>}{review.action === 'send' && <>{review.options.mode === 'tcp-server' && <><dt>目标客户端</dt><dd>{review.peerIds.map((id) => { const peer = peers.find((item) => item.id === id); return peer ? peer.address + ':' + peer.port : id + '（已断开）'; }).join('、')}</dd></>}<dt>发送内容</dt><dd>{encodeNetworkPayload(review.packet).byteCount} 字节 × {review.count === null ? '持续发送（直到停止）' : review.count + ' 次'}</dd><dt>发送间隔</dt><dd>{review.packet.intervalMs} 毫秒</dd></>}</dl>
        {review.changedBinding && <p>旧草稿绑定了 127.0.0.1，仅限本机。确认后将改为自动网卡，不会修改目标地址、端口或报文。</p>}
        {review.action === 'join' && <p>只有发往本地监听端口的组播才会被接收；端口 0 不会自动监听目标端口 {review.packet.port}。可取消后点击“同目标端口”。</p>}
        {review.action === 'join' && ready(snapshot) && <p>加入将重建当前 UDP 会话；配置未变时保留已分配的本地端口，切换期间可能错过入站数据。</p>}
        <p>确认即允许本次配置使用所选网卡收发；停止或变更配置后需重新确认。不会修改防火墙。</p>
      </div>}
    </ConfirmDialog>
    <ConfirmDialog open={!!deleteTarget} title="删除报文模板？" confirmLabel="删除模板" onCancel={() => setDeleteTarget(null)} onConfirm={() => {
      if (!deleteTarget || locked.current) return;
      try {
        persist({ schemaVersion: 1, packets: library.packets.filter((packet) => packet.id !== deleteTarget.id) });
        if (selectedId === deleteTarget.id) setSelectedId('');
        setDeleteTarget(null); setNotice('已删除模板，编辑区内容保留。'); setTemplateFeedback({ text: '已删除模板，编辑区内容保留。', error: false }); setError('');
        window.requestAnimationFrame(() => { if (alive.current) templateSearch.current?.focus({ preventScroll: true }); });
      } catch (e) { setError(errorText(e)); setTemplateFeedback({ text: errorText(e), error: true }); setDeleteTarget(null); }
    }}><p>删除“{deleteTarget?.name}”的本机模板。当前编辑内容不会被清空。</p></ConfirmDialog>
  </section>;
}
