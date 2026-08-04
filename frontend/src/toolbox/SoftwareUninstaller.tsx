import { useEffect, useMemo, useState } from 'react';
import {
  requestInstalledSoftware,
  requestSoftwareCleanup,
  requestSoftwareResidualScan,
  requestSoftwareUninstall,
} from '../bridge/hostBridge';
import type {
  InstalledSoftware,
  SoftwareCleanupPlan,
  SoftwareResidual,
} from '../types';
import type { ToolDefinition } from './catalog';
import styles from './SoftwareUninstaller.module.scss';

interface SoftwareUninstallerProps {
  tool: ToolDefinition;
  onBack(): void;
}

/** Guarded Windows software inventory, uninstaller launcher and residue review. */
export function SoftwareUninstaller({ tool, onBack }: SoftwareUninstallerProps) {
  const [entries, setEntries] = useState<InstalledSoftware[]>([]);
  const [selectedId, setSelectedId] = useState('');
  const [query, setQuery] = useState('');
  const [plan, setPlan] = useState<SoftwareCleanupPlan | null>(null);
  const [selectedPaths, setSelectedPaths] = useState<Set<string>>(new Set());
  const [typedName, setTypedName] = useState('');
  const [busy, setBusy] = useState<'list' | 'scan' | 'uninstall' | 'cleanup' | ''>('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  const selected = entries.find((entry) => entry.id === selectedId) ?? null;
  const visibleEntries = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase('zh-CN');
    return entries.filter((entry) => !normalized ||
      `${entry.displayName} ${entry.publisher} ${entry.displayVersion}`
        .toLocaleLowerCase('zh-CN')
        .includes(normalized));
  }, [entries, query]);

  const loadEntries = async () => {
    setBusy('list');
    setError('');
    try {
      const next = await requestInstalledSoftware();
      setEntries(next);
      setSelectedId((current) => next.some((entry) => entry.id === current)
        ? current
        : (next[0]?.id ?? ''));
    } catch (loadError) {
      setError(messageFrom(loadError, '无法读取已安装软件。'));
    } finally {
      setBusy('');
    }
  };

  useEffect(() => { void loadEntries(); }, []);

  const chooseSoftware = (entry: InstalledSoftware) => {
    setSelectedId(entry.id);
    setPlan(null);
    setSelectedPaths(new Set());
    setTypedName('');
    setError('');
    setNotice('');
  };

  const scanResiduals = async () => {
    if (!selected) return;
    setBusy('scan');
    setError('');
    setNotice('');
    try {
      const next = await requestSoftwareResidualScan(selected);
      setPlan(next);
      setSelectedPaths(new Set(next.residuals
        .filter((residual) => residual.defaultSelected)
        .map((residual) => residual.path)));
      setTypedName('');
      setNotice(next.residuals.length
        ? `找到 ${next.residuals.length} 个关联位置，请逐项检查。`
        : '通用扫描没有找到证据充分的关联位置；不会根据模糊名称扩大搜索范围。');
    } catch (scanError) {
      setError(messageFrom(scanError, '关联残留扫描失败。'));
    } finally {
      setBusy('');
    }
  };

  const launchUninstaller = async () => {
    if (!selected || selected.noRemove) return;
    const confirmed = window.confirm(
      `将启动“${selected.displayName}”在 Windows 中注册的卸载程序。\n\n` +
      '小助手不会静默卸载，也不会自动点击卸载程序中的确认按钮。是否继续？',
    );
    if (!confirmed) return;
    setBusy('uninstall');
    setError('');
    try {
      if (!plan || plan.softwareId !== selected.id) {
        const next = await requestSoftwareResidualScan(selected);
        setPlan(next);
        setSelectedPaths(new Set(next.residuals
          .filter((residual) => residual.defaultSelected)
          .map((residual) => residual.path)));
        setTypedName('');
      }
      const result = await requestSoftwareUninstall(selected);
      setNotice(`${result.message} 已在启动前保存关联位置，卸载完成后可继续审核清理。`);
    } catch (uninstallError) {
      setError(messageFrom(uninstallError, '无法启动注册卸载程序。'));
    } finally {
      setBusy('');
    }
  };

  const cleanupResiduals = async () => {
    if (!plan || typedName !== plan.displayName || selectedPaths.size === 0) return;
    const personalCount = plan.residuals.filter((residual) =>
      residual.personalData && selectedPaths.has(residual.path)).length;
    const confirmed = window.confirm(
      `准备把 ${selectedPaths.size} 个“${plan.displayName}”关联位置移入回收站。` +
      (personalCount ? `\n\n其中 ${personalCount} 项包含插件、设置或其他个人数据。` : '') +
      '\n\n路径已由原生扫描锁定，是否执行？',
    );
    if (!confirmed) return;
    setBusy('cleanup');
    setError('');
    try {
      const result = await requestSoftwareCleanup(
        plan,
        [...selectedPaths],
        typedName,
      );
      setNotice(result.message);
      if (result.failedPaths.length) {
        setSelectedPaths(new Set(result.failedPaths));
        setTypedName('');
      } else {
        setPlan(null);
        setSelectedPaths(new Set());
        setTypedName('');
        await loadEntries();
      }
    } catch (cleanupError) {
      setError(messageFrom(cleanupError, '残留清理未完成。'));
    } finally {
      setBusy('');
    }
  };

  const togglePath = (path: string) => {
    setSelectedPaths((current) => {
      const next = new Set(current);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  };

  return (
    <section className={styles.workspace}>
      <header className={styles.heading}>
        <button type="button" onClick={onBack}>← 返回工具列表</button>
        <div>
          <i>{tool.glyph}</i>
          <span><small>WINDOWS NATIVE · REVIEW REQUIRED</small><strong>{tool.name}</strong><em>{tool.description}</em></span>
        </div>
      </header>

      <div className={styles.safetyBar}>
        <span><strong>两阶段保护</strong>先启动软件自己的卸载程序，再按需清理已审核残留。</span>
        <span><strong>不是 rm -rf</strong>拒绝系统根目录和任意路径，清理内容进入回收站。</span>
        <button type="button" disabled={Boolean(busy)} onClick={() => void loadEntries()}>
          {busy === 'list' ? '读取中…' : '刷新软件列表'}
        </button>
      </div>

      {error && <p className={styles.error}>{error}</p>}
      {notice && <p className={styles.notice}>{notice}</p>}

      <div className={styles.contentGrid}>
        <aside className={styles.inventory}>
          <header>
            <div><span>INSTALLED</span><strong>{entries.length} 个已注册软件</strong></div>
            <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索名称、厂商或版本…" />
          </header>
          <div className={styles.softwareList}>
            {visibleEntries.map((entry) => (
              <button
                key={entry.id}
                type="button"
                className={entry.id === selectedId ? styles.activeSoftware : undefined}
                onClick={() => chooseSoftware(entry)}
              >
                <i>{entry.displayName.slice(0, 1).toLocaleUpperCase('zh-CN')}</i>
                <span>
                  <strong>{entry.displayName}</strong>
                  <small>{joinPresent(entry.publisher, entry.displayVersion) || '未提供厂商与版本'}</small>
                </span>
                <em>{entry.currentUser ? '当前用户' : '所有用户'}</em>
              </button>
            ))}
            {!visibleEntries.length && <p>没有匹配的软件。</p>}
          </div>
        </aside>

        <main className={styles.detail}>
          {!selected && <div className={styles.empty}>请选择一个软件查看卸载与残留信息。</div>}
          {selected && (
            <>
              <section className={styles.softwareSummary}>
                <div>
                  <span>SELECTED APPLICATION</span>
                  <h3>{selected.displayName}</h3>
                  <p>{joinPresent(selected.publisher, selected.displayVersion) || 'Windows 注册信息不完整'}</p>
                </div>
                <div className={styles.summaryActions}>
                  <button type="button" disabled={Boolean(busy)} onClick={() => void scanResiduals()}>
                    {busy === 'scan' ? '扫描中…' : '先扫描关联位置'}
                  </button>
                  <button type="button" disabled={Boolean(busy) || selected.noRemove} onClick={() => void launchUninstaller()}>
                    {busy === 'uninstall' ? '准备并启动中…' : '启动标准卸载'}
                  </button>
                </div>
              </section>

              <dl className={styles.metadata}>
                <div><dt>安装范围</dt><dd>{selected.currentUser ? '仅当前用户' : '所有用户 / 可能需管理员权限'}</dd></div>
                <div><dt>注册大小</dt><dd>{selected.estimatedSizeBytes ? formatBytes(selected.estimatedSizeBytes) : '未提供'}</dd></div>
                <div><dt>安装位置</dt><dd title={selected.installLocation}>{selected.installLocation || '未能从注册信息推断'}</dd></div>
                <div><dt>卸载方式</dt><dd>{selected.windowsInstaller ? 'Windows Installer (MSI)' : '软件自带卸载程序'}</dd></div>
                <div className={styles.metadataWide}>
                  <dt>注册表来源</dt>
                  <dd title={selected.registryPath}>{selected.registryPath || '未报告'}</dd>
                </div>
                <div className={styles.metadataWide}>
                  <dt>位置来源</dt>
                  <dd>{selected.installLocationInferred
                    ? '注册项未填写 InstallLocation，已从 DisplayIcon 或 UninstallString 中存在的程序文件推断。'
                    : 'Windows 卸载注册项直接提供。'}</dd>
                </div>
              </dl>

              <section className={styles.residualSection}>
                <header>
                  <div><span>RESIDUAL REVIEW</span><h3>关联文件与个人数据</h3></div>
                  {plan && <small>{selectedPaths.size} / {plan.residuals.length} 项已选择</small>}
                </header>
                {!plan && (
                  <div className={styles.scanEmpty}>
                    <strong>尚未扫描</strong>
                    <p>扫描会组合卸载注册项、有效 EXE、版本信息、发布者、受限数据目录和开始菜单名称；不使用针对某个软件的硬编码目录。</p>
                  </div>
                )}
                {plan && !plan.residuals.length && (
                  <div className={styles.scanEmpty}><strong>没有已知残留</strong><p>标准卸载完成后可刷新列表再次确认。</p></div>
                )}
                {plan && plan.residuals.length > 0 && (
                  <>
                    <div className={styles.residualList}>
                      {plan.residuals.map((residual) => (
                        <ResidualRow
                          key={residual.path}
                          residual={residual}
                          checked={selectedPaths.has(residual.path)}
                          onToggle={() => togglePath(residual.path)}
                        />
                      ))}
                    </div>
                    <div className={styles.cleanupConfirm}>
                      <label>
                        <span>输入完整软件名称以确认彻底清理</span>
                        <input
                          value={typedName}
                          onChange={(event) => setTypedName(event.target.value)}
                          placeholder={plan.displayName}
                          autoComplete="off"
                        />
                      </label>
                      <button
                        type="button"
                        disabled={Boolean(busy) || typedName !== plan.displayName || selectedPaths.size === 0}
                        onClick={() => void cleanupResiduals()}
                      >
                        {busy === 'cleanup' ? '正在移入回收站…' : '清理所选残留'}
                      </button>
                    </div>
                  </>
                )}
              </section>
            </>
          )}
        </main>
      </div>
    </section>
  );
}

function ResidualRow({ residual, checked, onToggle }: {
  residual: SoftwareResidual;
  checked: boolean;
  onToggle(): void;
}) {
  return (
    <label className={residual.personalData ? styles.personalResidual : undefined}>
      <input type="checkbox" checked={checked} onChange={onToggle} />
      <i>{kindGlyph(residual.kind)}</i>
      <span>
        <strong>{residual.label}</strong>
        <code title={residual.path}>{residual.path}</code>
        <p>{residual.evidence}</p>
      </span>
      <em>
        {residual.personalData && <b>个人数据</b>}
        <b className={residual.confidence === 'high' ? styles.highConfidence : styles.mediumConfidence}>
          {residual.confidence === 'high' ? '高可信' : '中可信'}
        </b>
        <small>{residual.sizeTruncated ? '至少 ' : ''}{formatBytes(residual.sizeBytes)} · {residual.itemCount} 项</small>
      </em>
    </label>
  );
}

function kindGlyph(kind: SoftwareResidual['kind']) {
  if (kind === 'personal') return '♥';
  if (kind === 'cache') return '◇';
  if (kind === 'shortcut') return '↗';
  return '▣';
}

function formatBytes(bytes: number) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  return `${(bytes / 1024 ** index).toFixed(index > 1 ? 1 : 0)} ${units[index]}`;
}

function joinPresent(...values: string[]) {
  return values.filter(Boolean).join(' · ');
}

function messageFrom(error: unknown, fallback: string) {
  return error instanceof Error ? error.message : fallback;
}
