import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { requestNetworkInterfaces, requestNetworkPoll, requestNetworkSend, requestNetworkStart, requestNetworkStop } from '../bridge/hostBridge';
import type { NetworkDebugEvent, NetworkInterface, NetworkSessionSnapshot, NetworkStartOptions } from '../types';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { ToolWorkspaceHeader } from '../../../shared/tool-workspace/ToolWorkspaceHeader';
import type { ToolDefinition } from './catalog';
import { createDefaultPacketDraft, validatePacketDraft, encodePacketPayload, convertPacketPayloadMode, isMulticastHost,
  parsePacketLibrary, serializePacketLibrary, mergePacketLibraries, PACKET_LIBRARY_STORAGE_KEY, MAX_PACKET_LIBRARY_BYTES,
  type PacketSenderDraft, type PacketLibrary, type SavedPacket } from './packetSenderModel';
import styles from './PacketSender.module.scss';

const native = Boolean(window.chrome?.webview);
const errorText = (error: unknown) => error instanceof Error ? error.message : '操作失败，请重试。';
const pause = (ms: number) => new Promise<void>((resolve) => window.setTimeout(resolve, ms));
const ready = (snapshot: NetworkSessionSnapshot | null) => snapshot?.state === 'connected' || snapshot?.state === 'ready';
const localOnly = (address: string) => /^127\./.test(address) || address === 'localhost';
type LogEvent = NetworkDebugEvent & { uiId: number };
type NetworkReview = { packet: PacketSenderDraft; count: number; join: boolean; changedBinding: boolean; options: NetworkStartOptions };
function initialLibrary() {
  try { const raw = localStorage.getItem(PACKET_LIBRARY_STORAGE_KEY); return { library: raw ? parsePacketLibrary(raw) : { schemaVersion: 1 as const, packets: [] }, error: '' }; }
  catch (error) { return { library: { schemaVersion: 1 as const, packets: [] }, error: `报文库读取失败，原数据未覆盖：${errorText(error)}` }; }
}
function download(name: string, content: string) {
  const url = URL.createObjectURL(new Blob([content], { type: 'application/json;charset=utf-8' }));
  const link = document.createElement('a'); link.href = url; link.download = name; link.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function trimEvents(items: LogEvent[]) {
  let used = 0, start = items.length;
  while (start > 0 && items.length - start < 1000) {
    const event = items[start - 1]; const length = (event.dataHex?.length ?? 0) + (event.message?.length ?? 0) + (event.peerLabel?.length ?? 0) + 100;
    if (used + length > 2 * 1024 * 1024) break;
    used += length; start -= 1;
  }
  return items.slice(start);
}
function logPayload(event: NetworkDebugEvent, mode: 'hex' | 'escaped') {
  if (!event.dataHex) return event.message ?? '';
  try { const encoded = encodePacketPayload({ protocol: 'tcp', dataMode: 'hex', payload: event.dataHex }); return mode === 'hex' ? encoded.hex.match(/../g)?.join(' ').toUpperCase() : encoded.escaped; }
  catch { return event.dataHex; }
}

/** Packet templates plus bounded sends; shares the existing desktop Winsock owner. */
export function PacketSender({ tool, onBack }: { tool: ToolDefinition; onBack(): void }) {
  const [initial] = useState(initialLibrary);
  const [library, setLibrary] = useState<PacketLibrary>(initial.library);
  const [draft, setDraft] = useState<PacketSenderDraft>(createDefaultPacketDraft);
  const [selectedId, setSelectedId] = useState('');
  const [search, setSearch] = useState('');
  const [adapters, setAdapters] = useState<NetworkInterface[]>([]);
  const [adaptersLoading, setAdaptersLoading] = useState(false);
  const [review, setReview] = useState<NetworkReview | null>(null);
  const [busy, setBusy] = useState(false);
  const [snapshot, setSnapshot] = useState<NetworkSessionSnapshot | null>(null);
  const [events, setEvents] = useState<LogEvent[]>([]);
  const [logMode, setLogMode] = useState<'hex' | 'escaped'>('hex');
  const [follow, setFollow] = useState(true);
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
  const log = useRef<HTMLDivElement>(null), importInput = useRef<HTMLInputElement>(null), payloadFile = useRef<HTMLInputElement>(null);
  const preview = useMemo(() => { try { return { value: encodePacketPayload(draft), error: '' }; } catch (e) { return { value: null, error: errorText(e) }; } }, [draft]);
  const filtered = library.packets.filter((packet) => `${packet.name} ${packet.host} ${packet.port}`.toLowerCase().includes(search.toLowerCase()));
  const multicast = draft.protocol === 'udp' && isMulticastHost(draft.host);
  const adapterName = (address: string) => address === '0.0.0.0' ? '自动选择网卡' : localOnly(address) ? '仅本机回环' : adapters.find((item) => item.address === address)?.name || '指定网卡';
  const current = (token: number) => alive.current && token === generation.current;
  const updateSnapshot = (next: NetworkSessionSnapshot) => { latest.current = next; setSnapshot(next); };
  const poll = async (token: number) => {
    const result = await requestNetworkPoll();
    if (!current(token)) return null;
    updateSnapshot(result.snapshot);
    if (result.events.length) {
      const incoming = result.events.map((event) => ({ ...event, uiId: ++eventSequence.current }));
      setEvents((old) => trimEvents([...old, ...incoming]));
    }
    return result.snapshot;
  };
  useEffect(() => {
    alive.current = true;
    let disposed = false, timer = 0;
    const tick = async () => {
      if (disposed) return;
      const token = generation.current;
      if (ownsSession.current && !locked.current) {
        try { const next = await poll(token); if (next?.lastError) setError(next.lastError); }
        catch (e) { if (current(token)) setError(errorText(e)); }
      }
      if (!disposed) timer = window.setTimeout(tick, 250);
    };
    void tick();
    return () => { disposed = true; alive.current = false; generation.current += 1; window.clearTimeout(timer); ownsSession.current = false; void requestNetworkStop().catch(() => undefined); };
  }, []);
  useLayoutEffect(() => { if (follow && log.current) log.current.scrollTop = log.current.scrollHeight; }, [events, logMode, follow]);
  const refreshAdapters = async () => {
    const request = ++adapterRequest.current; setAdaptersLoading(true);
    try { const items = await requestNetworkInterfaces(); if (alive.current && request === adapterRequest.current) setAdapters(items); }
    catch (e) { if (alive.current && request === adapterRequest.current) setError(`无法读取网卡：${errorText(e)} 可重试或选择自动网卡。`); }
    finally { if (alive.current && request === adapterRequest.current) setAdaptersLoading(false); }
  };
  useEffect(() => { void refreshAdapters(); }, []);

  const optionsFor = (packet: PacketSenderDraft, join: boolean): NetworkStartOptions => {
    const group = packet.protocol === 'udp' && isMulticastHost(packet.host);
    const options: NetworkStartOptions = { mode: packet.protocol === 'tcp' ? 'tcp-client' : 'udp',
      localHost: group ? '0.0.0.0' : packet.localAddress, localPort: packet.localPort,
      remoteHost: packet.host, remotePort: packet.port, allowLan: group || !localOnly(packet.localAddress),
      multicastInterface: group ? packet.localAddress : '', multicastTtl: group ? packet.multicastTtl : 1,
      multicastGroup: join ? packet.host : '' };
    const previous = sessionOptions.current;
    const sameEndpoint = group && previous && ownsSession.current && ready(latest.current) &&
        previous.remoteHost === options.remoteHost && previous.remotePort === options.remotePort &&
        sessionRequestedPort.current === packet.localPort && previous.multicastInterface === options.multicastInterface &&
        previous.multicastTtl === options.multicastTtl;
    // Joining recreates the UDP socket: keep its already allocated source port,
    // then retain that exact port for later sends while the draft still says 0.
    if (sameEndpoint) options.localPort = previous.localPort || (join ? latest.current!.localPort : 0);
    // Sending through an already joined socket must not silently discard membership.
    if (!join && sameEndpoint && latest.current?.multicastJoined) options.multicastGroup = packet.host;
    return options;
  };

  const send = (count: number, join = false) => {
    if (locked.current || !native) return;
    let packet: PacketSenderDraft;
    try { packet = validatePacketDraft({ ...draft, repeatCount: count || draft.repeatCount }); }
    catch (e) { setError(errorText(e)); return; }
    if (packet.protocol === 'tcp' && isMulticastHost(packet.host)) { setError('组播目标请使用 UDP 协议，TCP 不支持组播。'); return; }
    if (join && !isMulticastHost(packet.host)) { setError('请填写有效的 IPv4 组播目标地址。'); return; }
    if (!join && !encodePacketPayload(packet).byteCount) { setError('请先填写至少 1 字节的发送内容。'); return; }
    const changedBinding = isMulticastHost(packet.host) && localOnly(packet.localAddress);
    // Offer a reviewed migration for legacy loopback drafts, never silently change a route.
    if (changedBinding) packet = { ...packet, localAddress: '0.0.0.0' };
    if (packet.localAddress !== '0.0.0.0' && !localOnly(packet.localAddress) && !adapters.some((item) => item.address === packet.localAddress)) {
      setError('保存的网卡当前不可用，请刷新并重新选择发送网卡。'); return;
    }
    const options = optionsFor(packet, join);
    if (options.allowLan && (!ownsSession.current || !ready(latest.current) || approvedKey.current !== JSON.stringify(options) || changedBinding || join)) {
      const pending = { packet, count, join, changedBinding, options }; reviewRef.current = pending; setReview(pending); return;
    }
    void execute(packet, count, join, options);
  };
  const execute = async (packet: PacketSenderDraft, count: number, join: boolean, options: NetworkStartOptions) => {
    if (locked.current || !alive.current) return;
    const bytes = encodePacketPayload(packet);
    const key = JSON.stringify(options), token = ++generation.current;
    locked.current = true; setBusy(true); setError(''); setNotice(''); setProgress(join ? '正在加入组播…' : `准备发送 0 / ${count}`);
    try {
      if (!ownsSession.current || activeKey.current !== key || !ready(latest.current)) {
        await requestNetworkStop(); if (!current(token)) return;
        ownsSession.current = true; activeKey.current = key; sessionOptions.current = options; sessionRequestedPort.current = packet.localPort;
        const next = await requestNetworkStart(options); if (!current(token)) return;
        updateSnapshot(next);
      }
      const deadline = Date.now() + 20000;
      while (current(token) && !ready(latest.current)) {
        const next = await poll(token); if (!current(token)) return;
        if (next?.state === 'error' || next?.state === 'stopped') throw new Error(next.lastError || '连接未建立。');
        if (Date.now() > deadline) throw new Error('等待连接超时。');
        if (!ready(next)) await pause(100);
      }
      if (!current(token)) return;
      if (join) {
        if (!latest.current?.multicastJoined) throw new Error('未确认加入组播组，请检查网卡与本地监听端口。');
        setNotice(`已加入 ${packet.host}，监听本地端口 ${latest.current.localPort}；未发送数据。`);
        return;
      }
      for (let index = 0; index < count && current(token); index += 1) {
        const before = latest.current?.txPackets ?? 0;
        const next = await requestNetworkSend(bytes.hex); if (!current(token)) return;
        updateSnapshot(next);
        const sendDeadline = Date.now() + 20000;
        // Enqueue acceptance is not successful transmission. Wait for native TX.
        while (current(token) && (latest.current?.txPackets ?? 0) <= before) {
          const state = await poll(token); if (!current(token)) return;
          if (!ready(state)) throw new Error(state?.lastError || '连接已关闭，后续发送已停止。');
          if (Date.now() > sendDeadline) throw new Error('等待发送完成超时，已停止后续发送。');
          if ((latest.current?.txPackets ?? 0) <= before) await pause(50);
        }
        if (!current(token)) return;
        setProgress(`已发送 ${index + 1} / ${count}`);
        if (index + 1 < count) {
          const nextAt = Date.now() + packet.intervalMs;
          while (current(token) && Date.now() < nextAt) {
            await pause(Math.min(100, nextAt - Date.now())); if (!current(token)) return;
            const state = await poll(token); if (!current(token)) return;
            if (!ready(state)) throw new Error(state?.lastError || '连接已关闭，后续发送已停止。');
          }
        }
      }
      if (current(token)) setNotice(`本机已发送 ${count} 次，共 ${count * bytes.byteCount} B → ${packet.host}:${packet.port}。TX 不代表对方已收到；等待 RX 响应。`);
    } catch (e) {
      if (current(token)) {
        setError(errorText(e)); setProgress('操作已停止'); ownsSession.current = false; activeKey.current = ''; approvedKey.current = ''; sessionOptions.current = null;
        try { const next = await requestNetworkStop(); if (current(token)) updateSnapshot(next); } catch { /* Preserve original failure. */ }
      }
    } finally { if (current(token)) { locked.current = false; setBusy(false); } }
  };
  const stop = async () => {
    if (stopping.current) return;
    stopping.current = true;
    const token = ++generation.current; locked.current = true; setBusy(true); ownsSession.current = false; activeKey.current = ''; approvedKey.current = ''; sessionOptions.current = null;
    try { const next = await requestNetworkStop(); if (current(token)) { updateSnapshot(next); setProgress('已停止'); setNotice('已断开并退出组播，后续重复发送已取消。'); } }
    catch (e) { if (current(token)) setError(errorText(e)); }
    finally { stopping.current = false; if (current(token)) { locked.current = false; setBusy(false); } }
  };
  const edit = <K extends keyof PacketSenderDraft>(key: K, value: PacketSenderDraft[K]) => {
    if (locked.current) return;
    editRevision.current += 1;
    setDraft((old) => ({ ...old, [key]: value })); setError(''); setProgress('');
  };
  const changeMode = (mode: PacketSenderDraft['dataMode']) => {
    if (locked.current) return;
    try { const payload = convertPacketPayloadMode(draft, mode); editRevision.current += 1; setDraft({ ...draft, dataMode: mode, payload }); setError(''); }
    catch (e) { setError(`${errorText(e)} 原内容已保留。`); }
  };
  const persist = (next: PacketLibrary) => {
    if (initial.error) throw new Error('报文库读取失败，禁止覆盖原数据。请先导出原始备份。');
    const json = serializePacketLibrary(next); localStorage.setItem(PACKET_LIBRARY_STORAGE_KEY, json); libraryRef.current = next; setLibrary(next);
  };
  const save = () => {
    try {
      const packet = validatePacketDraft(draft);
      if (!packet.name.trim()) throw new Error('保存前请填写报文名称。');
      const item: SavedPacket = { ...packet, id: selectedId || crypto.randomUUID(), updatedAt: new Date().toISOString() };
      persist({ schemaVersion: 1, packets: selectedId ? library.packets.map((old) => old.id === selectedId ? item : old) : [...library.packets, item] });
      setSelectedId(item.id); setNotice('报文已保存到本机；保存和载入都不会自动发送。'); setError('');
    } catch (e) { setError(errorText(e)); }
  };
  const load = (packet: SavedPacket) => {
    if (locked.current) return;
    const { id, updatedAt: _updatedAt, ...editable } = packet;
    editRevision.current += 1;
    setDraft(validatePacketDraft(editable)); setSelectedId(id); approvedKey.current = ''; setError(''); setNotice('报文已载入，点击发送才会访问目标。');
  };
  const importLibrary = async (file?: File) => {
    if (!file || locked.current) return;
    try { if (file.size > MAX_PACKET_LIBRARY_BYTES) throw new Error('报文库文件不能超过 1 MiB。'); const incoming = parsePacketLibrary(await file.text()); if (!alive.current || locked.current) return; persist(mergePacketLibraries(libraryRef.current, incoming)); setNotice(`已导入 ${incoming.packets.length} 条报文，未执行发送。`); setError(''); }
    catch (e) { if (alive.current) setError(errorText(e)); }
  };
  const loadFile = async (file?: File) => {
    if (!file || locked.current) return;
    const revision = ++editRevision.current;
    try { if (file.size > (draft.protocol === 'udp' ? 65507 : 65536)) throw new Error('文件超过单次报文容量。'); const bytes = new Uint8Array(await file.arrayBuffer()); if (!alive.current || locked.current || revision !== editRevision.current) return; setDraft((old) => ({ ...old, dataMode: 'hex', payload: Array.from(bytes, (v) => v.toString(16).padStart(2, '0')).join(' ') })); setNotice(`已载入 ${file.size} 字节，未发送。`); setError(''); }
    catch (e) { if (alive.current) setError(errorText(e)); }
  };
  const exportLibrary = () => { try { download('cloudyi-packets.json', initial.error ? localStorage.getItem(PACKET_LIBRARY_STORAGE_KEY) ?? '' : serializePacketLibrary(library)); } catch (e) { setError(errorText(e)); } };
  const copyLogs = async () => { try { await navigator.clipboard.writeText(events.map((event) => `${new Date(event.timestamp).toISOString()} ${event.kind} ${event.peerLabel ?? ''} ${event.byteLength} B ${logPayload(event, logMode)}`).join('\n')); setNotice('已复制收发记录。'); } catch (e) { setError(errorText(e)); } };

  return <section className={styles.workspace} data-testid="packet-sender-workspace">
    <ToolWorkspaceHeader title={tool.name} onBack={onBack} />
    {(error || notice) && <p className={error ? styles.error : styles.notice} role={error ? 'alert' : 'status'}>{error || notice}</p>}
    <div className={styles.workbench}>
      <div className={styles.editor} data-testid="packet-sender-editor">
        <div className={styles.editScroll}>
        <section className={styles.card}>
          <header><h3>报文编辑</h3><button disabled={busy} onClick={() => { editRevision.current += 1; setDraft(createDefaultPacketDraft()); setSelectedId(''); approvedKey.current = ''; setError(''); setNotice('新建草稿，未发送。'); }}>新建</button><button disabled={busy} onClick={save}>{selectedId ? '更新报文' : '保存报文'}</button></header>
          <label>报文名称<input aria-label="报文名称" maxLength={80} value={draft.name} disabled={busy} onChange={(e) => edit('name', e.target.value)} /></label>
          <div className={styles.targetRow}><label>目标地址<input aria-label="目标地址" value={draft.host} disabled={busy} maxLength={253} onChange={(e) => edit('host', e.target.value)} /></label><label>端口<input aria-label="目标端口" type="number" min={1} max={65535} value={draft.port} disabled={busy} onChange={(e) => edit('port', Number(e.target.value))} /></label></div>
          <div className={styles.protocolRow}><div className={styles.tabs} aria-label="发送协议">{(['udp', 'tcp'] as const).map((protocol) => <button key={protocol} aria-pressed={draft.protocol === protocol} disabled={busy} onClick={() => edit('protocol', protocol)}>{protocol.toUpperCase()}</button>)}</div><span className={styles.transportBadge}>{multicast ? 'IPv4 组播' : 'IPv4 单播'}</span></div>
          <div className={styles.interfaceRow}><label>发送网卡<select aria-label="发送网卡" disabled={busy} value={draft.localAddress} onChange={(e) => edit('localAddress', e.target.value)}><option value="0.0.0.0">自动选择网卡（系统路由）</option><option value="127.0.0.1">仅本机（127.0.0.1）</option>{adapters.filter((item) => !item.loopback).map((item) => <option value={item.address} key={`${item.index}-${item.address}`}>{item.name}（{item.address}）</option>)}{!['0.0.0.0', '127.0.0.1'].includes(draft.localAddress) && !adapters.some((item) => item.address === draft.localAddress) && <option value={draft.localAddress}>网卡不可用（{draft.localAddress}）</option>}</select></label><button disabled={busy || adaptersLoading} onClick={() => void refreshAdapters()}>{adaptersLoading ? '读取中…' : '刷新网卡'}</button></div>
          <div className={styles.localRow}><label>本地端口（0 自动）<input aria-label="发包本地端口" type="number" min={0} max={65535} value={draft.localPort} disabled={busy} onChange={(e) => edit('localPort', Number(e.target.value))} /></label>{multicast && <><button disabled={busy} onClick={() => edit('localPort', draft.port)}>同目标端口</button><label>组播 TTL<input aria-label="组播 TTL" type="number" min={0} max={255} value={draft.multicastTtl} disabled={busy} onChange={(e) => edit('multicastTtl', Number(e.target.value))} /></label></>}</div>
          {multicast && <div className={styles.multicastControls}><div><button disabled={!native || busy} onClick={() => send(0, true)}>加入组播</button><button disabled={!snapshot?.multicastJoined || busy} onClick={() => void stop()}>退出组播</button></div><small>发送不必加组；接收组播需加组并监听设备使用的端口。</small></div>}
        </section>
        <section className={`${styles.card} ${styles.payloadCard}`}>
          <header><h3>发送内容</h3><button disabled={busy} onClick={() => payloadFile.current?.click()}>载入文件</button></header>
          <div className={styles.payloadToolbar}><div className={styles.tabs}>{([['text', '文本'], ['hex', 'HEX'], ['escaped', '转义字节']] as const).map(([mode, label]) => <button key={mode} aria-pressed={draft.dataMode === mode} disabled={busy} onClick={() => changeMode(mode)}>{label}</button>)}</div><span data-testid="packet-byte-count">{preview.value?.byteCount ?? 0} 字节</span></div>
          <textarea aria-label="报文内容" spellCheck={false} value={draft.payload} disabled={busy} onChange={(e) => edit('payload', e.target.value)} onKeyDown={(e) => { if ((e.ctrlKey || e.metaKey) && e.key === 'Enter' && !e.repeat) { e.preventDefault(); void send(1); } }} />
          {draft.dataMode === 'escaped' && <small>转义字节：\00、\FF、\r、\n、\t、\\；普通文字按 UTF-8 编码。</small>}
          {preview.error && <p className={styles.warning}>{preview.error}</p>}
          {!native && <small>发送与接收需要 Windows 客户端；浏览器仅供编辑预览。</small>}
        </section>
        </div>
        <section className={`${styles.card} ${styles.sendDock}`}>
          <div className={styles.sendOptions}><label>间隔（毫秒）<input aria-label="重发间隔" type="number" min={100} max={86400000} value={draft.intervalMs} disabled={busy} onChange={(e) => edit('intervalMs', Number(e.target.value))} /></label><label>发送次数<input aria-label="重发次数" type="number" min={1} max={1000} value={draft.repeatCount} disabled={busy} onChange={(e) => edit('repeatCount', Number(e.target.value))} /></label></div>
          <div className={styles.sendActions}><button className={styles.primary} disabled={!native || busy || !preview.value?.byteCount} onClick={() => send(1)}>发送一次</button><button disabled={!native || busy || !preview.value?.byteCount} onClick={() => send(draft.repeatCount)}>重复发送</button><button className={styles.stop} disabled={!native || stopping.current || (!busy && !ownsSession.current)} onClick={() => void stop()}>停止 / 断开</button></div>
        </section>
      </div>
      <div className={styles.right} data-testid="packet-sender-results">
        <section className={`${styles.card} ${styles.library}`}>
          <header><h3>已保存报文 <span>{library.packets.length}</span></h3><button disabled={busy} onClick={() => importInput.current?.click()}>导入</button><button onClick={exportLibrary}>导出</button></header>
          <input aria-label="搜索报文" placeholder="搜索名称、地址或端口…" value={search} onChange={(e) => setSearch(e.target.value)} />
          <div className={styles.packetList} data-testid="packet-library">{filtered.length ? filtered.map((packet) => <article key={packet.id} data-selected={packet.id === selectedId}><button className={styles.packetName} disabled={busy} onClick={() => load(packet)} title="载入编辑，不会自动发送"><strong>{packet.name}</strong><small>{packet.protocol.toUpperCase()} · {packet.host}:{packet.port}</small></button><button disabled={busy} onClick={() => load(packet)}>载入</button><button className={styles.delete} disabled={busy} aria-label={`删除报文 ${packet.name}`} onClick={() => setDeleteTarget(packet)}>删除</button></article>) : <p className={styles.empty}>{library.packets.length ? '没有匹配的报文。' : '保存常用报文后，可在这里再次载入。'}</p>}</div>
        </section>
        <section className={`${styles.card} ${styles.logPanel}`}>
          <header><h3>收发记录</h3><div className={styles.tabs}><button aria-pressed={logMode === 'hex'} onClick={() => setLogMode('hex')}>HEX</button><button aria-pressed={logMode === 'escaped'} onClick={() => setLogMode('escaped')}>转义</button></div><label className={styles.follow}><input type="checkbox" checked={follow} onChange={(e) => setFollow(e.target.checked)} />自动滚动</label><button disabled={!events.length} onClick={() => void copyLogs()}>复制</button><button onClick={() => setEvents([])}>清空</button></header>
          <div className={styles.session}><span title={ready(snapshot) ? `${snapshot?.remoteHost}:${snapshot?.remotePort}` : undefined}>{busy ? progress : ready(snapshot) ? `${snapshot?.mode === 'udp' ? 'UDP' : 'TCP'} 连接保留中` : '未连接'}</span><span>TX {snapshot?.txPackets ?? 0} 次 · {snapshot?.txBytes ?? 0} B</span><span>RX {snapshot?.rxPackets ?? 0} 次 · {snapshot?.rxBytes ?? 0} B</span></div>
          {snapshot && ready(snapshot) && <div className={styles.endpoints}><span>监听 {snapshot.localHost}:{snapshot.localPort}</span><span>目标 {snapshot.remoteHost}:{snapshot.remotePort}</span><span data-testid="packet-multicast-state">{snapshot.multicastJoined ? `已加入 ${snapshot.multicastGroup}` : '未加入组播'}{snapshot.multicastInterface ? ` · ${snapshot.multicastInterface === '0.0.0.0' ? '系统网卡' : snapshot.multicastInterface} · TTL ${snapshot.multicastTtl}` : ''}</span></div>}
          <div className={styles.log} role="log" aria-label="发包收发记录" ref={log}>{events.length ? events.map((event) => <div key={event.uiId} className={styles.logRow} data-kind={event.kind}><div><time>{new Date(event.timestamp).toLocaleTimeString('zh-CN', { hour12: false })}</time><b>{event.kind === 'sent' ? 'TX →' : event.kind === 'received' ? 'RX ←' : event.kind === 'error' ? '错误' : '状态'}</b><span>{event.peerLabel} {event.byteLength > 0 ? `${event.byteLength} B` : ''}</span></div><pre>{logPayload(event, logMode)}</pre></div>) : <div className={styles.logEmpty}>发送报文后，在这里同时查看收发字节与状态。</div>}</div>
          <footer><span>{events.length} 条记录 · 最多保留 1000 条 / 2 MiB</span><span>{busy ? progress : 'TCP 接收按数据块显示，不保证应用报文边界'}</span></footer>
        </section>
      </div>
    </div>
    <input ref={importInput} type="file" accept=".json,application/json" hidden onChange={(e) => { const file = e.target.files?.[0]; e.target.value = ''; void importLibrary(file); }} />
    <input ref={payloadFile} type="file" hidden onChange={(e) => { const file = e.target.files?.[0]; e.target.value = ''; void loadFile(file); }} />
    <ConfirmDialog open={!!review} title="确认网络操作" confirmLabel={review?.join ? '确认并加入' : '确认并发送'} tone="primary" onCancel={() => { reviewRef.current = null; setReview(null); }} onConfirm={() => {
      const pending = reviewRef.current; if (!pending) return;
      reviewRef.current = null; setReview(null); approvedKey.current = JSON.stringify(pending.options);
      if (pending.changedBinding) { setDraft(pending.packet); editRevision.current += 1; }
      void execute(pending.packet, pending.count, pending.join, pending.options);
    }}>
      {review && <div className={styles.reviewContent}>
        <p>{review.join ? '加入组播并开始监听，不发送编辑区数据。' : '仅向以下目标发送。加入组播并不是发送的必要步骤。'}</p>
        <dl><dt>目标</dt><dd>{review.packet.protocol.toUpperCase()} · {review.packet.host}:{review.packet.port}</dd><dt>发送网卡</dt><dd>{adapterName(review.packet.localAddress)} · {review.packet.localAddress}</dd><dt>本地监听端口</dt><dd>{review.options.localPort || '系统分配（0）'}</dd>{isMulticastHost(review.packet.host) && <><dt>组播 TTL</dt><dd>{review.packet.multicastTtl}</dd></>}{!review.join && <><dt>发送内容</dt><dd>{encodePacketPayload(review.packet).byteCount} 字节 × {review.count} 次</dd></>}</dl>
        {review.changedBinding && <p>旧草稿绑定了 127.0.0.1，仅限本机。确认后将改为自动网卡，不会修改目标地址、端口或报文。</p>}
        {review.join && <p>只有发往本地监听端口的组播才会被接收；端口 0 不会自动监听目标端口 {review.packet.port}。可取消后点击“同目标端口”。</p>}
        {review.join && ready(snapshot) && <p>加入将重建当前 UDP 会话；配置未变时保留已分配的本地端口，切换期间可能错过入站数据。</p>}
        <p>确认即允许本次配置使用所选网卡收发；停止或变更配置后需重新确认。不会修改防火墙。</p>
      </div>}
    </ConfirmDialog>
    <ConfirmDialog open={!!deleteTarget} title="删除保存的报文？" confirmLabel="删除报文" onCancel={() => setDeleteTarget(null)} onConfirm={() => { if (!deleteTarget) return; try { persist({ schemaVersion: 1, packets: library.packets.filter((packet) => packet.id !== deleteTarget.id) }); if (selectedId === deleteTarget.id) setSelectedId(''); setDeleteTarget(null); setNotice('已删除保存条目，编辑区内容保留。'); } catch (e) { setError(errorText(e)); setDeleteTarget(null); } }}><p>删除“{deleteTarget?.name}”的本机保存条目。当前编辑内容不会被清空。</p></ConfirmDialog>
  </section>;
}
