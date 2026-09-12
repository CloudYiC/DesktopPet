import { useEffect, useMemo, useRef, useState } from 'react';
import {
  requestInstalledSoftware,
  requestSoftwareCleanup,
  requestSoftwareResidualScan,
  requestSoftwareResidualRefresh,
  requestSoftwareUninstall,
  requestSoftwareReveal,
  requestSoftwareScanCancel,
} from '../bridge/hostBridge';
import type { InstalledSoftware, SoftwareCleanupPlan, SoftwareResidual } from '../types';
import type { ToolDefinition } from './catalog';
import { ToolWorkspaceHeader } from '../../../shared/tool-workspace/ToolWorkspaceHeader';
import { ConfirmDialog } from '../components/ConfirmDialog';
import styles from './SoftwareUninstaller.module.scss';

type Category = 'all' | 'shortcut' | 'program' | 'personal';
type Busy = 'list' | 'scan' | 'cancel' | 'uninstall' | 'cleanup' | 'reveal' | '';
const PAGE_SIZE = 5;
const categories: { value: Category; label: string }[] = [
  { value: 'all', label: '全部' }, { value: 'shortcut', label: '快捷方式' },
  { value: 'program', label: '程序文件' }, { value: 'personal', label: '个人数据' },
];

/** Exact native scan plans remain the only authority for revealing or recycling paths. */
export function SoftwareUninstaller({ tool, onBack }: { tool: ToolDefinition; onBack(): void }) {
  const [entries, setEntries] = useState<InstalledSoftware[]>([]);
  const [selectedId, setSelectedId] = useState('');
  const [query, setQuery] = useState('');
  const [plan, setPlan] = useState<SoftwareCleanupPlan | null>(null);
  const [launchedSoftware, setLaunchedSoftware] = useState<InstalledSoftware | null>(null);
  const [selectedPaths, setSelectedPaths] = useState<Set<string>>(new Set());
  const [focusedPath, setFocusedPath] = useState('');
  const [tab, setTab] = useState<'related' | 'info'>('related');
  const [category, setCategory] = useState<Category>('all');
  const [page, setPage] = useState(0);
  const [typedName, setTypedName] = useState('');
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [uninstallConfirmOpen, setUninstallConfirmOpen] = useState(false);
  const [busy, setBusy] = useState<Busy>('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const lifecycle = useRef(0);
  const pending = useRef<{ generation: number; action: Busy } | null>(null);

  const selected = entries.find((entry) => entry.id === selectedId) ?? (launchedSoftware?.id === selectedId ? launchedSoftware : null);
  const visibleEntries = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase('zh-CN');
    const inventory = launchedSoftware && !entries.some((entry) => entry.id === launchedSoftware.id) ? [launchedSoftware, ...entries] : entries;
    return inventory.filter((entry) => !needle ||
      [entry.displayName, entry.publisher, entry.displayVersion].join(' ').toLocaleLowerCase('zh-CN').includes(needle));
  }, [entries, query, launchedSoftware]);
  const residuals = plan?.residuals ?? [];
  const filtered = residuals.filter((residual) => category === 'all' || categoryOf(residual) === category);
  const pages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const currentPage = Math.min(page, pages - 1);
  const pageRows = filtered.slice(currentPage * PAGE_SIZE, (currentPage + 1) * PAGE_SIZE);
  const focused = residuals.find((residual) => residual.path === focusedPath) ?? pageRows[0] ?? null;
  const checked = residuals.filter((residual) => selectedPaths.has(residual.path));
  const selectedBytes = checked.reduce((sum, item) => sum + item.sizeBytes, 0);
  const sizeIncomplete = checked.some((item) => item.sizeTruncated);
  const personalCount = checked.filter((item) => item.personalData).length;
  const allPageChecked = !!pageRows.length && pageRows.every((item) => selectedPaths.has(item.path));
  const somePageChecked = pageRows.some((item) => selectedPaths.has(item.path));
  const scanStatus = busy === 'scan' ? '扫描中…' : !plan ? '尚未扫描' : plan.scanTruncated ? '扫描受限' : launchedSoftware ? '卸载程序已启动' : '扫描完成';

  const begin = (action: Busy) => {
    const generation = lifecycle.current;
    if (pending.current?.generation === generation) return null;
    pending.current = { generation, action };
    setBusy(action); setError(''); setNotice('');
    return generation;
  };
  const finish = (generation: number) => {
    if (pending.current?.generation === generation) pending.current = null;
    if (lifecycle.current === generation) setBusy('');
  };
  const resetPlan = () => {
    setPlan(null); setSelectedPaths(new Set()); setFocusedPath(''); setTypedName('');
    setCategory('all'); setPage(0); setConfirmOpen(false); setUninstallConfirmOpen(false);
    setLaunchedSoftware(null);
  };
  const acceptPlan = (next: SoftwareCleanupPlan) => {
    setPlan(next);
    setSelectedPaths(new Set(next.residuals.filter((item) => item.defaultSelected).map((item) => item.path)));
    setFocusedPath(next.residuals[0]?.path ?? '');
    setTypedName(''); setCategory('all'); setPage(0); setTab('related');
  };

  const loadEntries = async () => {
    const generation = begin('list');
    if (generation === null) return;
    try {
      const next = await requestInstalledSoftware();
      if (lifecycle.current !== generation) return;
      setEntries(next);
      if (!plan || !launchedSoftware || plan.softwareId !== launchedSoftware.id) {
        setSelectedId((current) => next.some((entry) => entry.id === current) ? current : (next[0]?.id ?? ''));
        resetPlan();
      }
    } catch (reason) { if (lifecycle.current === generation) setError(messageFrom(reason, '无法读取已安装软件。')); }
    finally { finish(generation); }
  };
  useEffect(() => {
    lifecycle.current += 1;
    void loadEntries();
    return () => {
      lifecycle.current += 1;
      if (pending.current?.action === 'scan' || pending.current?.action === 'uninstall') {
        void requestSoftwareScanCancel().catch(() => undefined);
      }
    };
  }, []);

  const cancelScan = async () => {
    if (pending.current?.action !== 'scan') return;
    // Invalidate the old request before asking native code to cancel its current scan.
    lifecycle.current += 1;
    const generation = begin('cancel');
    if (generation === null) return;
    try { await requestSoftwareScanCancel(); }
    catch (reason) { if (lifecycle.current === generation) setError(messageFrom(reason, '未能取消扫描。')); }
    finally { finish(generation); }
  };
  const chooseSoftware = (entry: InstalledSoftware) => {
    if ((busy && busy !== 'scan') || selectedId === entry.id) return;
    if (busy === 'scan') void cancelScan();
    setSelectedId(entry.id); resetPlan(); setTab('related'); setError(''); setNotice('');
  };
  const scanResiduals = async () => {
    if (!selected) return;
    const generation = begin('scan');
    if (generation === null) return;
    try {
      const next = launchedSoftware && plan ? await requestSoftwareResidualRefresh(plan) : await requestSoftwareResidualScan(selected);
      if (lifecycle.current === generation) acceptPlan(next);
    } catch (reason) { if (lifecycle.current === generation) setError(messageFrom(reason, '关联项目扫描失败。')); }
    finally { finish(generation); }
  };
  const launchUninstaller = async () => {
    if (!selected || selected.noRemove || busy || !uninstallConfirmOpen) return;
    const generation = begin('uninstall');
    if (generation === null) return;
    try {
      if (!plan || plan.softwareId !== selected.id) {
        const next = await requestSoftwareResidualScan(selected);
        if (lifecycle.current !== generation) return;
        acceptPlan(next);
      }
      const result = await requestSoftwareUninstall(selected);
      if (lifecycle.current === generation) {
        if (result.succeeded) { setUninstallConfirmOpen(false); setLaunchedSoftware(selected); setNotice('卸载程序已启动；完成其中的操作后，可复查残留。'); }
        else setError(result.message || '卸载程序未成功启动。');
      }
    } catch (reason) { if (lifecycle.current === generation) setError(messageFrom(reason, '无法启动注册卸载程序。')); }
    finally { finish(generation); }
  };
  const cleanupResiduals = async () => {
    if (!plan || !selected || plan.softwareId !== selected.id || typedName !== plan.displayName || !checked.length || !confirmOpen) return;
    const generation = begin('cleanup');
    if (generation === null) return;
    try {
      // Capture the reviewed allowlist; never derive cleanup paths from UI text or the link target.
      const result = await requestSoftwareCleanup(plan, checked.map((item) => item.path), typedName);
      if (lifecycle.current !== generation) return;
      setTypedName('');
      if (result.failedPaths.length || !result.succeeded) {
        const removed = new Set(result.removedPaths);
        setPlan({ ...plan, residuals: plan.residuals.filter((item) => !removed.has(item.path)) });
        setSelectedPaths(new Set(result.failedPaths.filter((path) => plan.residuals.some((item) => item.path === path))));
        setError(result.message || '部分项目未能移入回收站，请重新审核。');
        setConfirmOpen(false);
      } else {
        // Keep unselected candidates after uninstall: the registration may be
        // gone, so discarding this native plan would make them unreachable.
        const removed = new Set(result.removedPaths);
        const remaining = plan.residuals.filter((item) => !removed.has(item.path));
        setPlan({ ...plan, residuals: remaining });
        setSelectedPaths(new Set()); setFocusedPath(remaining[0]?.path ?? '');
        setConfirmOpen(false); setPage(0);
        setNotice(result.message || '所选项目已移入回收站。');
      }
    } catch (reason) { if (lifecycle.current === generation) setError(messageFrom(reason, '关联项目清理未完成。')); }
    finally { finish(generation); }
  };
  const revealFocused = async () => {
    if (!plan || !focused) return;
    const generation = begin('reveal');
    if (generation === null) return;
    try { await requestSoftwareReveal(plan.token, focused.path); }
    catch (reason) { if (lifecycle.current === generation) setError(messageFrom(reason, '无法打开文件位置。')); }
    finally { finish(generation); }
  };
  const copyPath = async () => {
    if (!focused) return;
    const generation = lifecycle.current;
    try {
      await navigator.clipboard.writeText(focused.path);
      if (lifecycle.current === generation) setNotice('路径已复制。');
    } catch { if (lifecycle.current === generation) setError('复制失败，请检查剪贴板权限。'); }
  };
  const togglePath = (path: string) => {
    if (busy) return;
    setSelectedPaths((current) => {
      const next = new Set(current);
      if (next.has(path)) next.delete(path); else next.add(path);
      return next;
    });
  };
  const changeCategory = (value: Category) => {
    setCategory(value); setPage(0);
    setFocusedPath(residuals.find((item) => value === 'all' || categoryOf(item) === value)?.path ?? '');
  };
  const changePage = (value: number) => {
    setPage(value); setFocusedPath(filtered[value * PAGE_SIZE]?.path ?? '');
  };

  return <section className={styles.workspace} data-testid="software-uninstaller-workspace">
    <div className={styles.topbar}><ToolWorkspaceHeader title={tool.name} onBack={onBack} /><button type="button" disabled={!!busy} onClick={() => void loadEntries()} aria-label="刷新软件列表">↻ {busy === 'list' ? '读取中…' : '刷新列表'}</button></div>
    {(error || notice) && !confirmOpen && !uninstallConfirmOpen && <p className={error ? styles.error : styles.notice} role={error ? 'alert' : 'status'}>{error || notice}<button type="button" aria-label="关闭提示" onClick={() => { setError(''); setNotice(''); }}>×</button></p>}
    <div className={styles.contentGrid}>
      <aside className={styles.inventory} aria-label="已安装软件">
        <header><div><h3>已安装软件</h3><span>{entries.length}</span></div><input aria-label="搜索已安装软件" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索软件、厂商…" /></header>
        <div className={styles.softwareList} role="listbox" aria-label="软件列表">
          {visibleEntries.map((entry) => <button key={entry.id} type="button" role="option" aria-selected={entry.id === selectedId} disabled={!!busy && busy !== 'scan'} onClick={() => chooseSoftware(entry)}><i aria-hidden="true">{initial(entry.displayName)}</i><span><strong title={entry.displayName}>{entry.displayName}</strong><small title={entry.publisher}>{entry.publisher || '未提供厂商'}</small></span></button>)}
          {!visibleEntries.length && <p>{busy === 'list' ? '正在读取软件…' : '没有匹配的软件。'}</p>}
        </div>
      </aside>
      <section className={styles.detail} aria-label="软件详情">
        {!selected && <div className={styles.empty}>请选择软件。</div>}
        {selected && <>
          <div className={styles.softwareSummary}><i aria-hidden="true">{initial(selected.displayName)}</i><div><h3 title={selected.displayName}>{selected.displayName}</h3><p title={joinPresent(selected.publisher, selected.displayVersion)}>{joinPresent(selected.publisher, selected.currentUser ? '当前用户' : '所有用户')}</p></div><div className={styles.summaryActions}><button type="button" disabled={!!busy && busy !== 'scan'} onClick={() => void (busy === 'scan' ? cancelScan() : scanResiduals())}>{busy === 'scan' ? '取消扫描' : launchedSoftware && plan ? '复查残留' : plan ? '重新扫描' : '扫描关联项目'}</button><button className={styles.danger} type="button" disabled={!!busy || selected.noRemove} title={selected.noRemove ? '该注册项禁止卸载' : undefined} onClick={() => { setError(''); setUninstallConfirmOpen(true); }}>{busy === 'uninstall' ? '准备中…' : '卸载软件'}</button></div></div>
          <div className={styles.installPath}><span>安装位置</span><code title={selected.installLocation}>{selected.installLocation || '注册信息未提供'}</code><button type="button" onClick={() => setTab('info')}>查看详情 ›</button></div>
          <div className={styles.tabs} role="tablist" aria-label="软件详情分类"><button id="software-related-tab" type="button" role="tab" aria-selected={tab === 'related'} aria-controls="software-related-panel" tabIndex={tab === 'related' ? 0 : -1} onClick={() => setTab('related')} onKeyDown={(event) => { if (event.key === 'ArrowRight') { setTab('info'); document.getElementById('software-info-tab')?.focus(); } }}>关联项目 {plan ? residuals.length : ''}</button><button id="software-info-tab" type="button" role="tab" aria-selected={tab === 'info'} aria-controls="software-info-panel" tabIndex={tab === 'info' ? 0 : -1} onClick={() => setTab('info')} onKeyDown={(event) => { if (event.key === 'ArrowLeft') { setTab('related'); document.getElementById('software-related-tab')?.focus(); } }}>软件信息</button><span role="status" title={plan?.scanWarnings?.join('\n')}>{scanStatus}</span></div>
          {tab === 'info' ? <section className={styles.infoPanel} id="software-info-panel" role="tabpanel" aria-labelledby="software-info-tab"><dl className={styles.metadata}>
            <div><dt>软件名称</dt><dd>{selected.displayName}</dd></div><div><dt>版本</dt><dd>{selected.displayVersion || '未提供'}</dd></div>
            <div><dt>发布者</dt><dd>{selected.publisher || '未提供'}</dd></div><div><dt>注册大小</dt><dd>{selected.estimatedSizeBytes ? formatBytes(selected.estimatedSizeBytes) : '未提供'}</dd></div>
            <div><dt>安装范围</dt><dd>{selected.currentUser ? '仅当前用户' : '所有用户，可能需管理员权限'}</dd></div><div><dt>卸载方式</dt><dd>{selected.windowsInstaller ? 'Windows Installer (MSI)' : '软件自带卸载程序'}</dd></div>
            <div className={styles.metadataWide}><dt>安装位置</dt><dd>{selected.installLocation || '未提供'}</dd></div>
            <div className={styles.metadataWide}><dt>位置来源</dt><dd>{selected.installLocationInferred ? '根据注册的程序或卸载命令推断' : 'Windows 卸载注册项'}</dd></div>
            <div className={styles.metadataWide}><dt>注册表来源</dt><dd>{selected.registryPath || '未提供'}</dd></div>
            {plan?.scanWarnings?.length ? <div className={styles.metadataWide}><dt>扫描提醒</dt><dd>{plan.scanWarnings.map((warning, index) => <p key={index}>{warning}</p>)}</dd></div> : null}
          </dl></section> : <section className={styles.relatedPanel} id="software-related-panel" role="tabpanel" aria-labelledby="software-related-tab">
            <div className={styles.filters} aria-label="关联项目筛选">{categories.map((item) => <button key={item.value} type="button" aria-pressed={category === item.value} onClick={() => changeCategory(item.value)}>{item.label} <span>{residuals.filter((residual) => item.value === 'all' || categoryOf(residual) === item.value).length}</span></button>)}</div>
            <div className={styles.residualTable} role="table" aria-label="关联项目">
              <div className={styles.tableHeader} role="row"><span role="columnheader"><input type="checkbox" aria-label="选择本页关联项目" disabled={!!busy || !pageRows.length} checked={allPageChecked} ref={(input) => { if (input) input.indeterminate = somePageChecked && !allPageChecked; }} onChange={() => setSelectedPaths((current) => { const next = new Set(current); for (const item of pageRows) { if (allPageChecked) next.delete(item.path); else next.add(item.path); } return next; })} /></span><span role="columnheader">项目 / 位置</span><span role="columnheader">关联依据</span><span role="columnheader">大小</span></div>
              {pageRows.map((residual) => <div key={residual.path} className={focused?.path === residual.path ? styles.focusedRow : styles.residualRow} role="row" data-category={categoryOf(residual)} data-selected={selectedPaths.has(residual.path) || undefined} onClick={() => setFocusedPath(residual.path)}>
                <span role="cell"><input type="checkbox" aria-label={`选择 ${residual.path}`} disabled={!!busy} checked={selectedPaths.has(residual.path)} onChange={() => togglePath(residual.path)} /></span>
                <span role="cell"><button type="button" className={styles.rowDetails} aria-label={`查看 ${residual.path}`} aria-pressed={focused?.path === residual.path} onClick={() => setFocusedPath(residual.path)}><ResidualIcon category={categoryOf(residual)} /><span><strong>{basename(residual.path) || residual.label}</strong><small title={residual.path}>{parentPath(residual.path)}</small></span></button></span>
                <span role="cell"><span className={styles.evidenceBadge} data-category={categoryOf(residual)} title={`${residual.evidence} · ${residual.confidence === 'high' ? '高可信' : '需复核'}`}>{evidenceLabel(residual)}</span></span>
                <span role="cell" className={styles.sizeCell}>{residual.sizeTruncated ? '≥ ' : ''}{formatBytes(residual.sizeBytes)}</span>
              </div>)}
              {!pageRows.length && <div className={styles.scanEmpty}>{!plan ? <><strong>{busy === 'scan' ? '正在扫描关联项目…' : '尚未扫描关联项目'}</strong><button type="button" disabled={!!busy} onClick={() => void scanResiduals()}>扫描关联项目</button></> : <strong>{residuals.length ? '该分类没有关联项目' : '未找到可确认的关联项目'}</strong>}</div>}
            </div>
            <div className={styles.pagination}><span>共 {filtered.length} 项</span><span>每页 5 项</span><button type="button" aria-label="上一页关联项目" disabled={currentPage === 0} onClick={() => changePage(currentPage - 1)}>‹</button><span aria-live="polite">{currentPage + 1} / {pages}</span><button type="button" aria-label="下一页关联项目" disabled={currentPage + 1 >= pages} onClick={() => changePage(currentPage + 1)}>›</button></div>
            <section className={styles.pathDetail} aria-label="关联项目详情"><header><h4>{focused ? focused.kind === 'shortcut' ? '快捷方式详情' : '关联项目详情' : '项目详情'}</h4><span>{focused ? focused.confidence === 'high' ? '高可信' : '需要复核' : ''}</span><div><button type="button" disabled={!focused} onClick={() => void copyPath()}>复制路径</button><button type="button" disabled={!focused || !!busy || !plan} onClick={() => void revealFocused()}>打开位置</button></div></header><dl><dt>位置</dt><dd title={focused?.path}>{focused?.path || '选择上方项目查看完整位置'}</dd>{focused?.kind === 'shortcut' ? <><dt>目标</dt><dd title={focused.targetPath}>{focused.targetPath || '未提供可确认的目标'}</dd></> : <><dt>依据</dt><dd title={focused?.evidence}>{focused?.evidence || '—'}</dd></>}</dl></section>
          </section>}
          <footer className={styles.cleanupBar}><span>已选 <strong>{checked.length}</strong> 项 · {sizeIncomplete ? '至少 ' : ''}{formatBytes(selectedBytes)}</span><button type="button" disabled={!checked.length || !!busy} onClick={() => setSelectedPaths(new Set())}>取消选择</button><button type="button" className={styles.danger} disabled={!plan || !checked.length || !!busy} onClick={() => { setTypedName(''); setError(''); setConfirmOpen(true); }}>清理所选…</button></footer>
        </>}
      </section>
    </div>
    <ConfirmDialog open={uninstallConfirmOpen} title="确认卸载软件" confirmLabel="启动卸载" busy={busy === 'uninstall'} error={error} tone="danger" onCancel={() => { if (busy !== 'uninstall') { setUninstallConfirmOpen(false); setError(''); } }} onConfirm={() => void launchUninstaller()}>
      <div className={styles.uninstallIdentity}><i aria-hidden="true">{initial(selected?.displayName || '')}</i><div><strong>{selected?.displayName}</strong><span>{selected?.publisher || '未提供厂商'}{selected?.displayVersion ? ` · ${selected.displayVersion}` : ''}</span></div></div>
      <p>将打开软件自带的卸载程序，由你在其中确认卸载。完成后可返回这里复查并清理残留项目。</p>
    </ConfirmDialog>
    <ConfirmDialog open={confirmOpen} title="确认清理关联项目" confirmLabel="确认移入回收站" busy={busy === 'cleanup'} confirmDisabled={!!busy || !plan || typedName !== plan.displayName || !checked.length} error={error} size="wide" onCancel={() => { if (busy !== 'cleanup') setConfirmOpen(false); }} onConfirm={() => void cleanupResiduals()}>
      <p>将把“<strong>{plan?.displayName}</strong>”的 {checked.length} 个已审核位置移入回收站。请先完成软件卸载；仍注册的软件不会被清理。</p>
      {personalCount > 0 && <p className={styles.personalWarning}>其中 {personalCount} 项包含个人数据，可能包括设置、缓存或插件。请确认这些内容不再需要。</p>}
      <ul className={styles.confirmPaths}>{checked.map((item) => <li key={item.path}>{item.path}{item.personalData && <b>个人数据</b>}</li>)}</ul>
      <label>输入完整软件名称以确认<input aria-label="确认清理的软件名称" value={typedName} disabled={busy === 'cleanup'} onChange={(event) => setTypedName(event.target.value)} placeholder={plan?.displayName} autoComplete="off" spellCheck={false} /></label>
    </ConfirmDialog>
  </section>;
}

function ResidualIcon({ category }: { category: Exclude<Category, 'all'> }) {
  return category === 'shortcut'
    ? <svg aria-hidden="true" viewBox="0 0 24 24" fill="#e8f1ff" stroke="#477fbe" strokeWidth="1.5"><rect x="4" y="3" width="16" height="18" rx="3" /><path d="M8 15 16 7m-7 0h7v7" fill="none" /></svg>
    : <svg aria-hidden="true" viewBox="0 0 24 24" fill={category === 'program' ? '#eee9ff' : '#fff0cd'} stroke={category === 'program' ? '#8363ba' : '#b88026'} strokeWidth="1.4"><path d="M2.5 7V5.5A1.5 1.5 0 0 1 4 4h5l2 2h9a1.5 1.5 0 0 1 1.5 1.5v11A1.5 1.5 0 0 1 20 20H4a1.5 1.5 0 0 1-1.5-1.5Z" /><path d="M2.5 8h19" /></svg>;
}
function categoryOf(item: SoftwareResidual): Exclude<Category, 'all'> {
  if (item.kind === 'shortcut') return 'shortcut';
  return item.personalData || item.kind === 'personal' || item.kind === 'cache' ? 'personal' : 'program';
}
function evidenceLabel(item: SoftwareResidual) {
  if (item.personalData) return '个人数据';
  if (item.confidence !== 'high') return '需要复核';
  if (/目标|指向/.test(item.evidence)) return '目标程序匹配';
  if (/InstallLocation|安装目录|安装位置/.test(item.evidence)) return '安装位置匹配';
  if (/注册/.test(item.evidence)) return '注册信息匹配';
  return '关联信息匹配';
}
function basename(path: string) { return path.replace(/[\\/]+$/, '').split(/[\\/]/).pop() ?? path; }
function parentPath(path: string) { const clean = path.replace(/[\\/]+$/, ''); return clean.slice(0, Math.max(clean.lastIndexOf('\\'), clean.lastIndexOf('/'))) || clean; }
function initial(name: string) { return Array.from(name)[0]?.toLocaleUpperCase('zh-CN') || '软'; }
function formatBytes(bytes: number) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  return `${(bytes / 1024 ** index).toFixed(index > 1 ? 1 : 0)} ${units[index]}`;
}
function joinPresent(...values: string[]) { return values.filter(Boolean).join(' · '); }
function messageFrom(error: unknown, fallback: string) { return error instanceof Error ? error.message : fallback; }
