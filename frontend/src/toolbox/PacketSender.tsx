import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { requestNetworkPoll, requestNetworkSend, requestNetworkStart, requestNetworkStop } from '../bridge/hostBridge';
import type { NetworkDebugEvent, NetworkSessionSnapshot, NetworkStartOptions } from '../types';
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
  const [allowLan, setAllowLan] = useState(false);
  const [advanced, setAdvanced] = useState(false);
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
  const log = useRef<HTMLDivElement>(null), importInput = useRef<HTMLInputElement>(null), payloadFile = useRef<HTMLInputElement>(null);
  const preview = useMemo(() => { try { return { value: encodePacketPayload(draft), error: '' }; } catch (e) { return { value: null, error: errorText(e) }; } }, [draft]);
  const filtered = library.packets.filter((packet) => `${packet.name} ${packet.host} ${packet.port}`.toLowerCase().includes(search.toLowerCase()));
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

  const send = async (count: number) => {
    if (locked.current || !native) return;
    let packet: PacketSenderDraft;
    try { packet = validatePacketDraft({ ...draft, repeatCount: count }); }
    catch (e) { setError(errorText(e)); return; }
    if (packet.protocol === 'tcp' && isMulticastHost(packet.host)) { setError('组播目标请使用 UDP 协议，TCP 不支持组播。'); return; }
    if (!localOnly(packet.localAddress) && !allowLan) { setAdvanced(true); setError('使用非回环本地地址前，请确认允许局域网收发。'); return; }
    if (isMulticastHost(packet.host) && localOnly(packet.localAddress)) { setAdvanced(true); setError('组播目标需要选择自动网卡或填写本机网卡 IPv4，并确认允许局域网收发。'); return; }
    const bytes = encodePacketPayload(packet);
    if (!bytes.byteCount) { setError('请先填写至少 1 字节的发送内容。'); return; }
    const options: NetworkStartOptions = { mode: packet.protocol === 'tcp' ? 'tcp-client' : 'udp', localHost: packet.localAddress,
      localPort: packet.localPort, remoteHost: packet.host, remotePort: packet.port, allowLan };
    const key = JSON.stringify(options), token = ++generation.current;
    locked.current = true; setBusy(true); setError(''); setNotice(''); setProgress(`准备发送 0 / ${count}`);
    try {
      if (!ownsSession.current || activeKey.current !== key || !ready(latest.current)) {
        await requestNetworkStop(); if (!current(token)) return;
        ownsSession.current = true; activeKey.current = key;
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
      if (current(token)) setNotice('发送完成，连接保留以接收响应；可继续发送或断开。');
    } catch (e) {
      if (current(token)) {
        setError(errorText(e)); setProgress('发送已停止'); ownsSession.current = false; activeKey.current = '';
        try { const next = await requestNetworkStop(); if (current(token)) updateSnapshot(next); } catch { /* Preserve original failure. */ }
      }
    } finally { if (current(token)) { locked.current = false; setBusy(false); } }
  };
  const stop = async () => {
    if (stopping.current) return;
    stopping.current = true;
    const token = ++generation.current; locked.current = true; setBusy(true); ownsSession.current = false; activeKey.current = '';
    try { const next = await requestNetworkStop(); if (current(token)) { updateSnapshot(next); setProgress('已停止'); setNotice('连接已关闭，后续重复发送已取消。'); } }
    catch (e) { if (current(token)) setError(errorText(e)); }
    finally { stopping.current = false; if (current(token)) { locked.current = false; setBusy(false); } }
  };
  const edit = <K extends keyof PacketSenderDraft>(key: K, value: PacketSenderDraft[K]) => {
    if (locked.current) return;
    editRevision.current += 1;
    setDraft((old) => ({ ...old, [key]: value })); setError(''); setProgress('');
    if (key === 'localAddress') setAllowLan(false);
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
    setDraft(validatePacketDraft(editable)); setSelectedId(id); setAllowLan(false); setError(''); setNotice('报文已载入，点击发送才会访问目标。');
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
        <section className={styles.card}>
          <header><h3>报文编辑</h3><button disabled={busy} onClick={() => { editRevision.current += 1; setDraft(createDefaultPacketDraft()); setSelectedId(''); setAllowLan(false); setError(''); setNotice('新建草稿，未发送。'); }}>新建</button><button disabled={busy} onClick={save}>{selectedId ? '更新报文' : '保存报文'}</button></header>
          <label>报文名称<input aria-label="报文名称" maxLength={80} value={draft.name} disabled={busy} onChange={(e) => edit('name', e.target.value)} /></label>
          <div className={styles.targetRow}><label>目标地址<input aria-label="目标地址" value={draft.host} disabled={busy} maxLength={253} onChange={(e) => edit('host', e.target.value)} /></label><label>端口<input aria-label="目标端口" type="number" min={1} max={65535} value={draft.port} disabled={busy} onChange={(e) => edit('port', Number(e.target.value))} /></label></div>
          <div className={styles.protocolRow}><div className={styles.tabs} aria-label="发送协议">{(['udp', 'tcp'] as const).map((protocol) => <button key={protocol} aria-pressed={draft.protocol === protocol} disabled={busy} onClick={() => edit('protocol', protocol)}>{protocol.toUpperCase()}</button>)}</div><button aria-expanded={advanced} onClick={() => setAdvanced(!advanced)}>本地绑定 {advanced ? '⌃' : '⌄'}</button></div>
          {isMulticastHost(draft.host) && <p className={styles.warning}>UDP 组播使用系统默认路由；不指定组播接口或加入接收组。</p>}
          {advanced && <div className={styles.binding}><div className={styles.targetRow}><label>本地 IPv4<input aria-label="本地 IPv4" value={draft.localAddress} disabled={busy} onChange={(e) => edit('localAddress', e.target.value)} list="packet-local-addresses" /><datalist id="packet-local-addresses"><option value="127.0.0.1">仅本机</option><option value="0.0.0.0">自动网卡 / 所有本地地址</option></datalist></label><label>本地端口<input aria-label="发包本地端口" type="number" min={0} max={65535} value={draft.localPort} disabled={busy} onChange={(e) => edit('localPort', Number(e.target.value))} /></label></div><small>端口 0 由系统分配；向局域网发包请选择自动网卡或本机网卡地址。</small></div>}
          {!localOnly(draft.localAddress) && <label className={styles.consent}><input type="checkbox" checked={allowLan} disabled={busy} onChange={(e) => setAllowLan(e.target.checked)} />允许此本地地址收发局域网数据</label>}
        </section>
        <section className={`${styles.card} ${styles.payloadCard}`}>
          <header><h3>发送内容</h3><button disabled={busy} onClick={() => payloadFile.current?.click()}>载入文件</button></header>
          <div className={styles.payloadToolbar}><div className={styles.tabs}>{([['text', '文本'], ['hex', 'HEX'], ['escaped', '转义字节']] as const).map(([mode, label]) => <button key={mode} aria-pressed={draft.dataMode === mode} disabled={busy} onClick={() => changeMode(mode)}>{label}</button>)}</div><span data-testid="packet-byte-count">{preview.value?.byteCount ?? 0} 字节</span></div>
          <textarea aria-label="报文内容" spellCheck={false} value={draft.payload} disabled={busy} onChange={(e) => edit('payload', e.target.value)} onKeyDown={(e) => { if ((e.ctrlKey || e.metaKey) && e.key === 'Enter' && !e.repeat) { e.preventDefault(); void send(1); } }} />
          {draft.dataMode === 'escaped' && <small>转义字节：\00、\FF、\r、\n、\t、\\；普通文字按 UTF-8 编码。</small>}
          {preview.error && <p className={styles.warning}>{preview.error}</p>}
          <div className={styles.sendOptions}><label>间隔（毫秒）<input aria-label="重发间隔" type="number" min={100} max={86400000} value={draft.intervalMs} disabled={busy} onChange={(e) => edit('intervalMs', Number(e.target.value))} /></label><label>发送次数<input aria-label="重发次数" type="number" min={1} max={1000} value={draft.repeatCount} disabled={busy} onChange={(e) => edit('repeatCount', Number(e.target.value))} /></label></div>
          <div className={styles.sendActions}><button className={styles.primary} disabled={!native || busy || !preview.value?.byteCount} onClick={() => void send(1)}>发送一次</button><button disabled={!native || busy || !preview.value?.byteCount} onClick={() => void send(draft.repeatCount)}>重复发送</button><button className={styles.stop} disabled={!native || stopping.current || (!busy && !ownsSession.current)} onClick={() => void stop()}>停止 / 断开</button></div>
          {!native && <small>发送与接收需要 Windows 客户端；浏览器仅供编辑预览。</small>}
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
          <div className={styles.log} role="log" aria-label="发包收发记录" ref={log}>{events.length ? events.map((event) => <div key={event.uiId} className={styles.logRow} data-kind={event.kind}><div><time>{new Date(event.timestamp).toLocaleTimeString('zh-CN', { hour12: false })}</time><b>{event.kind === 'sent' ? 'TX →' : event.kind === 'received' ? 'RX ←' : event.kind === 'error' ? '错误' : '状态'}</b><span>{event.peerLabel} {event.byteLength > 0 ? `${event.byteLength} B` : ''}</span></div><pre>{logPayload(event, logMode)}</pre></div>) : <div className={styles.logEmpty}>发送报文后，在这里同时查看收发字节与状态。</div>}</div>
          <footer><span>{events.length} 条记录 · 最多保留 1000 条 / 2 MiB</span><span>{busy ? progress : 'TCP 接收按数据块显示，不保证应用报文边界'}</span></footer>
        </section>
      </div>
    </div>
    <input ref={importInput} type="file" accept=".json,application/json" hidden onChange={(e) => { const file = e.target.files?.[0]; e.target.value = ''; void importLibrary(file); }} />
    <input ref={payloadFile} type="file" hidden onChange={(e) => { const file = e.target.files?.[0]; e.target.value = ''; void loadFile(file); }} />
    <ConfirmDialog open={!!deleteTarget} title="删除保存的报文？" confirmLabel="删除报文" onCancel={() => setDeleteTarget(null)} onConfirm={() => { if (!deleteTarget) return; try { persist({ schemaVersion: 1, packets: library.packets.filter((packet) => packet.id !== deleteTarget.id) }); if (selectedId === deleteTarget.id) setSelectedId(''); setDeleteTarget(null); setNotice('已删除保存条目，编辑区内容保留。'); } catch (e) { setError(errorText(e)); setDeleteTarget(null); } }}><p>删除“{deleteTarget?.name}”的本机保存条目。当前编辑内容不会被清空。</p></ConfirmDialog>
  </section>;
}
