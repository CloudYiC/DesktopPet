import { useEffect, useMemo, useRef, useState } from 'react';
import { requestPortEntries, terminatePortProcess } from '../bridge/hostBridge';
import { ConfirmDialog } from '../components/ConfirmDialog';
import type { PortEntry } from '../types';
import type { ToolDefinition } from './catalog';
import { ToolWorkspaceHeader } from '../../../shared/tool-workspace/ToolWorkspaceHeader';
import styles from './PortManagerWorkspace.module.scss';

export function PortManagerWorkspace({ tool, onBack }: { tool: ToolDefinition; onBack(): void }) {
  const [entries, setEntries] = useState<PortEntry[]>([]);
  const [query, setQuery] = useState('');
  const [protocol, setProtocol] = useState<'all' | 'TCP' | 'UDP'>('all');
  const [busy, setBusy] = useState(false);
  const [terminating, setTerminating] = useState(false);
  const [confirmation, setConfirmation] = useState<PortEntry | null>(null);
  const [modalError, setModalError] = useState('');
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  const [updatedAt, setUpdatedAt] = useState('');
  const alive = useRef(true);
  const refreshGeneration = useRef(0);
  const operationPending = useRef(false);
  const table = useRef<HTMLDivElement>(null);
  const refresh = async () => {
    const generation = ++refreshGeneration.current;
    setBusy(true); setError('');
    try {
      const result = await requestPortEntries();
      if (alive.current && generation === refreshGeneration.current) {
        setEntries(result); setUpdatedAt(new Date().toLocaleTimeString('zh-CN', { hour12: false }));
      }
    } catch (reason) {
      if (alive.current && generation === refreshGeneration.current) setError(reason instanceof Error ? reason.message : '端口读取失败。');
    } finally { if (alive.current && generation === refreshGeneration.current) setBusy(false); }
  };
  useEffect(() => { alive.current = true; void refresh(); return () => { alive.current = false; refreshGeneration.current += 1; }; }, []);
  useEffect(() => { if (table.current) table.current.scrollTop = 0; }, [query, protocol]);
  const filtered = useMemo(() => {
    const search = query.trim().toLocaleLowerCase('zh-CN');
    return entries.filter((entry) => (protocol === 'all' || entry.protocol === protocol) && (!search ||
      `${endpoint(entry.localAddress, entry.localPort)} ${endpoint(entry.remoteAddress, entry.remotePort)} ${entry.processName} ${entry.processId} ${entry.state}`.toLocaleLowerCase('zh-CN').includes(search)));
  }, [entries, query, protocol]);
  const tcpCount = entries.filter((entry) => entry.protocol === 'TCP').length;
  const processCount = new Set(entries.filter((entry) => entry.processId > 0).map((entry) => entry.processId)).size;
  const requestTermination = (entry: PortEntry) => {
    if (busy || operationPending.current || isProtected(entry)) return;
    // Freeze the reviewed row. A refresh must never change the confirmation target.
    setConfirmation({ ...entry }); setModalError('');
  };
  const terminate = async () => {
    if (!confirmation || operationPending.current || isProtected(confirmation)) return;
    const target = confirmation;
    operationPending.current = true; setTerminating(true); setModalError(''); setNotice('');
    try {
      const result = await terminatePortProcess(target);
      if (!alive.current) return;
      setConfirmation(null); setNotice(result); await refresh();
    } catch (reason) {
      if (alive.current) setModalError(reason instanceof Error ? reason.message : '结束进程失败。');
    } finally { operationPending.current = false; if (alive.current) setTerminating(false); }
  };
  return <section className={styles.workspace} data-testid="port-manager-workspace">
    <ToolWorkspaceHeader title={tool.name} onBack={onBack} />
    <div className={styles.overview} aria-label="端口统计">
      <article data-tone="slate"><span>全部端口</span><strong>{entries.length}</strong></article>
      <article data-tone="teal"><span>TCP</span><strong>{tcpCount}</strong></article>
      <article data-tone="violet"><span>UDP</span><strong>{entries.length - tcpCount}</strong></article>
      <article data-tone="blue"><span>关联进程</span><strong>{processCount}</strong></article>
    </div>
    <div className={styles.controls}>
      <label className={styles.search}><svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><circle cx="10" cy="10" r="6"/><path d="m15 15 6 6"/></svg><input aria-label="搜索端口、进程或 PID" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索端口、进程或 PID…" /></label>
      <select aria-label="协议筛选" value={protocol} disabled={terminating} onChange={(event) => setProtocol(event.target.value as 'all' | 'TCP' | 'UDP')}><option value="all">全部协议</option><option value="TCP">TCP</option><option value="UDP">UDP</option></select>
      <button type="button" className={styles.refresh} disabled={busy || terminating} onClick={() => void refresh()}>{busy ? '刷新中…' : '刷新'}</button>
    </div>
    {error && <p className={styles.error} role="alert">{error}</p>}
    <section className={styles.tablePanel} aria-label="端口列表">
      <header><h3>端口与进程</h3><span>{updatedAt ? `${updatedAt} 更新` : '正在读取…'}</span></header>
      <div ref={table} className={styles.tableScroll} data-testid="port-table-scroll" tabIndex={0} aria-label="可滚动端口列表">
        <table className={styles.table}>
          <colgroup><col className={styles.protocolColumn}/><col/><col/><col className={styles.stateColumn}/><col/><col className={styles.actionColumn}/></colgroup>
          <thead><tr><th>协议</th><th>本地端口</th><th>远端</th><th>状态</th><th>进程</th><th>操作</th></tr></thead>
          <tbody>{filtered.map((entry, index) => <tr key={`${entry.protocol}-${entry.localAddress}-${entry.localPort}-${entry.processId}-${index}`}>
            <td data-label="协议"><span className={styles.protocol} data-protocol={entry.protocol}>{entry.protocol}</span></td>
            <td data-label="本地端口"><strong className={styles.endpoint}>{endpoint(entry.localAddress, entry.localPort)}</strong></td>
            <td data-label="远端"><span className={styles.endpoint}>{endpoint(entry.remoteAddress, entry.remotePort)}</span></td>
            <td data-label="状态"><span className={styles.state} data-state={stateTone(entry.state)}>{entry.state}</span></td>
            <td data-label="进程"><strong className={styles.processName} title={entry.processName}>{entry.processName}</strong><small>PID {entry.processId}</small></td>
            <td data-label="操作"><button type="button" className={styles.terminate} disabled={isProtected(entry) || busy || terminating} onClick={() => requestTermination(entry)}>{isProtected(entry) ? '系统保护' : '结束进程'}</button></td>
          </tr>)}{!filtered.length && <tr><td colSpan={6} className={styles.empty}>{busy ? '正在读取端口…' : error ? '读取失败，请点击刷新重试。' : '没有符合条件的端口。'}</td></tr>}</tbody>
        </table>
      </div>
      <footer><span>显示 {filtered.length} / {entries.length} 条</span>{notice && <span role="status" className={styles.notice}>{notice}</span>}</footer>
    </section>
    <ConfirmDialog open={!!confirmation} title="结束进程？" confirmLabel="确认结束" busy={terminating} error={modalError} onCancel={() => { if (!operationPending.current) { setConfirmation(null); setModalError(''); } }} onConfirm={() => void terminate()}>
      {confirmation && <><dl><dt>进程</dt><dd>{confirmation.processName}</dd><dt>PID</dt><dd>{confirmation.processId}</dd><dt>端口</dt><dd>{confirmation.protocol} · {endpoint(confirmation.localAddress, confirmation.localPort)}</dd></dl><p>这会关闭该进程的全部窗口、任务和网络连接，未保存的内容可能丢失。</p></>}
    </ConfirmDialog>
  </section>;
}
function endpoint(address: string, port: number) { return port ? `${address}:${port}` : address || '—'; }
function stateTone(state: string) { return state.includes('监听') ? 'listening' : state.includes('已连接') ? 'connected' : /等待|关闭|释放/.test(state) ? 'waiting' : 'neutral'; }
function isProtected(entry: PortEntry) { return entry.processId <= 4 || ['system', 'registry', 'smss.exe', 'csrss.exe', 'wininit.exe', 'services.exe', 'lsass.exe', 'winlogon.exe', 'svchost.exe', 'fontdrvhost.exe', 'dwm.exe'].includes(entry.processName.toLocaleLowerCase('en-US')); }
