import { useEffect, useMemo, useRef, useState } from 'react';
import {
  executeTool,
  requestPortEntries,
  requestSystemSnapshot,
  terminatePortProcess,
} from '../bridge/hostBridge';
import { setPluginEnabled, usePluginRegistry } from '../plugins/pluginRegistry';
import type { PortEntry, SystemSnapshot, ToolExecuteRequest } from '../types';
import {
  categoryById,
  READY_TOOL_COUNT,
  TOOL_CATEGORIES,
  TOOL_DEFINITIONS,
  type ToolCategoryId,
  type ToolDefinition,
  toolsForCategory,
} from './catalog';
import styles from './Toolbox.module.scss';
import { DatabaseStudio } from './DatabaseStudio';
import { ImageToolbox } from './ImageToolbox';
import { SoftwareUninstaller } from './SoftwareUninstaller';
import { PacketInspector } from './PacketInspector';

interface ToolboxProps {
  category: ToolCategoryId | null;
  onOpenCategory(category: ToolCategoryId): void;
  onWorkspaceChange(): void;
}

/** CloudYi tool catalog and workbench embedded in the pet dashboard. */
export function Toolbox({ category, onOpenCategory, onWorkspaceChange }: ToolboxProps) {
  const [activeToolId, setActiveToolId] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState<'default' | 'local' | 'available'>('default');
  const searchInput = useRef<HTMLInputElement>(null);
  const activeTool = TOOL_DEFINITIONS.find((tool) => tool.id === activeToolId) ?? null;
  const pluginState = usePluginRegistry();
  const selectedCategory = categoryById(category);
  const visibleTools = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase('zh-CN');
    return toolsForCategory(category).filter((tool) => {
      const local = pluginState[tool.id] !== false;
      const available = !local;
      if (statusFilter === 'local' && !local) return false;
      if (statusFilter === 'available' && !available) return false;
      return !normalized || `${tool.name} ${tool.shortName} ${tool.description}`
        .toLocaleLowerCase('zh-CN')
        .includes(normalized);
    });
  }, [category, pluginState, query, statusFilter]);

  useEffect(() => {
    if (activeTool && category && activeTool.category !== category) {
      setActiveToolId(null);
    }
  }, [activeTool, category]);

  useEffect(() => {
    if (activeTool && pluginState[activeTool.id] === false) setActiveToolId(null);
  }, [activeTool, pluginState]);

  useEffect(() => {
    onWorkspaceChange();
  }, [activeToolId, onWorkspaceChange]);

  useEffect(() => {
    const focusSearch = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLocaleLowerCase() === 'k') {
        event.preventDefault();
        searchInput.current?.focus();
      }
    };
    window.addEventListener('keydown', focusSearch);
    return () => window.removeEventListener('keydown', focusSearch);
  }, []);

  if (activeTool) {
    if (activeTool.id === 'system-inspector') {
      return <SystemCenterWorkspace tool={activeTool} onBack={() => setActiveToolId(null)} />;
    }
    if (activeTool.id === 'port-manager') {
      return <PortManagerWorkspace tool={activeTool} onBack={() => setActiveToolId(null)} />;
    }
    if (activeTool.id === 'database-studio') {
      return <DatabaseStudio tool={activeTool} onBack={() => setActiveToolId(null)} />;
    }
    if (activeTool.id === 'image-toolbox') {
      return <ImageToolbox tool={activeTool} onBack={() => setActiveToolId(null)} />;
    }
    if (activeTool.id === 'software-uninstaller') {
      return <SoftwareUninstaller tool={activeTool} onBack={() => setActiveToolId(null)} />;
    }
    if (activeTool.id === 'packet-inspector') {
      return <PacketInspector tool={activeTool} onBack={() => setActiveToolId(null)} />;
    }
    return <ToolWorkspace tool={activeTool} onBack={() => setActiveToolId(null)} />;
  }

  return (
    <section className={styles.toolbox}>
      {!selectedCategory && (
        <div className={styles.toolboxHero}>
          <div>
            <span>CLOUDYI TOOLBOX · LOCAL FIRST</span>
            <h2>常用开发工具，现在和可爱依依住在一起。</h2>
            <p>首批工具已经通过 C++11 桥接原有 C 核心；高权限功能会在确认前保持关闭。</p>
          </div>
          <div className={styles.heroStats}>
            <strong>{READY_TOOL_COUNT}</strong>
            <span>个工具可直接使用</span>
          </div>
        </div>
      )}

      {!selectedCategory && (
        <div className={styles.categoryStrip}>
          {TOOL_CATEGORIES.map((item) => (
            <button key={item.id} type="button" onClick={() => onOpenCategory(item.id)}>
              <i>{item.glyph}</i>
              <span><strong>{item.label}</strong><small>{toolsForCategory(item.id).length} 个工具</small></span>
              <em>›</em>
            </button>
          ))}
        </div>
      )}

      <div className={styles.catalogToolbar}>
        <label>
          <span>⌕</span>
          <input ref={searchInput} value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索工具…" />
          <kbd>Ctrl K</kbd>
        </label>
        <select value={statusFilter} onChange={(event) => setStatusFilter(event.target.value as typeof statusFilter)}>
          <option value="default">Default</option>
          <option value="local">Local</option>
          <option value="available">Available</option>
        </select>
      </div>

      {!selectedCategory && (
        <div className={styles.catalogHeading}>
          <div><span>TOOL CATALOG</span><h2>全部工具</h2><p>这里只展示已经可以实际使用的本地工具与模块。</p></div>
        </div>
      )}

      <div className={styles.toolGrid}>
        {visibleTools.map((tool) => {
          const local = pluginState[tool.id] !== false;
          const available = !local;
          const popular = ['timestamp', 'system-inspector', 'port-manager', 'software-uninstaller'].includes(tool.id);
          return (
            <article key={tool.id} className={available ? styles.availableTool : undefined}>
              <div className={styles.toolGlyph}>{tool.glyph}</div>
              <div className={styles.toolCopy}>
                <span>{runtimeLabel(tool)}</span>
                <h3>{tool.name}</h3>
                <p>{tool.description}</p>
              </div>
              <footer className={styles.toolActions}>
                <div>
                  {popular && <span className={styles.popularBadge}>Popular</span>}
                  <span className={local ? styles.localBadge : styles.availableBadge}>
                    {local ? 'Local' : 'Available'}
                  </span>
                </div>
                <button
                  type="button"
                  onClick={() => {
                    if (available) setPluginEnabled(tool.id, true);
                    else setActiveToolId(tool.id);
                  }}
                >
                  {local ? 'Open' : 'Enable'}
                </button>
              </footer>
            </article>
          );
        })}
        {!visibleTools.length && <p className={styles.emptyCatalog}>没有符合当前搜索和状态筛选的工具。</p>}
      </div>
    </section>
  );
}

function runtimeLabel(tool: ToolDefinition) {
  if (tool.runtime === 'c-core') return 'C CORE';
  if (tool.runtime === 'react') return 'REACT LOCAL';
  return 'WINDOWS NATIVE';
}

function WorkspaceHeading({ tool, onBack }: ToolWorkspaceProps) {
  return (
    <header className={styles.workspaceHeader}>
      <button type="button" onClick={onBack}>← 返回工具列表</button>
      <div className={styles.workspaceTitle}>
        <i>{tool.glyph}</i>
        <div><span>{runtimeLabel(tool)} · PERMISSION GATED</span><h2>{tool.name}</h2><p>{tool.description}</p></div>
      </div>
    </header>
  );
}

function SystemCenterWorkspace({ tool, onBack }: ToolWorkspaceProps) {
  const [snapshot, setSnapshot] = useState<SystemSnapshot | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const refresh = async () => {
    setBusy(true);
    setError('');
    try {
      setSnapshot(await requestSystemSnapshot());
    } catch (refreshError) {
      setError(refreshError instanceof Error ? refreshError.message : '系统信息读取失败。');
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => { void refresh(); }, []);

  return (
    <section className={styles.workspace}>
      <WorkspaceHeading tool={tool} onBack={onBack} />
      <div className={styles.nativeToolbar}>
        <span>只读取当前设备信息，不会上传或修改系统设置。</span>
        <button type="button" disabled={busy} onClick={() => void refresh()}>{busy ? '读取中…' : '刷新信息'}</button>
      </div>
      {error && <p className={styles.toolError}>{error}</p>}
      {snapshot && <SystemSnapshotView snapshot={snapshot} />}
    </section>
  );
}

function SystemSnapshotView({ snapshot }: { snapshot: SystemSnapshot }) {
  const memoryUsed = Math.max(0, snapshot.totalMemoryBytes - snapshot.availableMemoryBytes);
  const diskUsed = Math.max(0, snapshot.systemDiskTotalBytes - snapshot.systemDiskFreeBytes);
  const pageFileUsed = Math.max(0, snapshot.totalPageFileBytes - snapshot.availablePageFileBytes);
  const memoryPercent = snapshot.memoryLoadPercent || percentage(memoryUsed, snapshot.totalMemoryBytes);
  const diskPercent = percentage(diskUsed, snapshot.systemDiskTotalBytes);
  const osDetail = [
    snapshot.osEdition,
    snapshot.osDisplayVersion,
    snapshot.osBuild ? `Build ${snapshot.osBuild}` : '',
    snapshot.architecture,
  ].filter(Boolean).join(' · ');
  const processorSummary = snapshot.physicalCores
    ? `${snapshot.physicalCores} 核 / ${snapshot.logicalProcessors} 线程`
    : `${snapshot.logicalProcessors} 个逻辑处理器`;

  return (
    <>
      <div className={styles.metricGrid}>
        <MetricCard label="操作系统" value={snapshot.operatingSystem} detail={osDetail || snapshot.architecture} />
        <MetricCard label="处理器" value={processorSummary} detail={snapshot.processorName || 'Windows 处理器信息'} />
        <MetricCard
          label="物理内存"
          value={`${formatBytes(memoryUsed)} 已用`}
          detail={`${memoryPercent}% · 总计 ${formatBytes(snapshot.totalMemoryBytes)}`}
          progress={memoryPercent}
        />
        <MetricCard
          label={`${snapshot.systemDrive || '系统盘'} 存储`}
          value={`${formatBytes(snapshot.systemDiskFreeBytes)} 可用`}
          detail={`${diskPercent}% 已用 · 总计 ${formatBytes(snapshot.systemDiskTotalBytes)}`}
          progress={diskPercent}
        />
      </div>

      <div className={styles.systemPanelGrid}>
        <SystemInfoPanel
          eyebrow="DEVICE & WINDOWS"
          title="设备与系统"
          rows={[
            { label: '计算机名称', value: snapshot.computerName },
            { label: '当前用户', value: snapshot.userName },
            { label: '设备厂商', value: snapshot.manufacturer },
            { label: '设备型号', value: snapshot.model },
            { label: 'Windows 版本', value: osDetail, wide: true },
            { label: 'BIOS', value: joinPresent(snapshot.biosVersion, snapshot.biosDate), wide: true },
            { label: '系统安装日期', value: formatUnixDate(snapshot.installUnixSeconds) },
            { label: '本次启动时间', value: formatDateTime(Date.now() - snapshot.uptimeMilliseconds) },
            { label: '持续运行', value: formatUptime(snapshot.uptimeMilliseconds) },
            { label: '数据权限', value: '本机只读' },
          ]}
        />

        <SystemInfoPanel
          eyebrow="PROCESSOR & DISPLAY"
          title="处理器与显示"
          rows={[
            { label: '处理器型号', value: snapshot.processorName, wide: true },
            { label: '物理核心', value: snapshot.physicalCores ? `${snapshot.physicalCores} 核` : '' },
            { label: '逻辑处理器', value: `${snapshot.logicalProcessors} 线程` },
            { label: '处理器插槽', value: snapshot.processorPackages ? `${snapshot.processorPackages} 个` : '' },
            { label: '标称频率', value: formatFrequency(snapshot.processorMaxMegahertz) },
            { label: '固件虚拟化', value: snapshot.virtualizationEnabled ? '已启用' : '未启用或不可用' },
            { label: '主显示适配器', value: snapshot.primaryGraphics, wide: true },
            {
              label: '主屏幕',
              value: snapshot.primaryDisplayWidth && snapshot.primaryDisplayHeight
                ? `${snapshot.primaryDisplayWidth} × ${snapshot.primaryDisplayHeight} · ${snapshot.primaryDisplayDpi || 96} DPI`
                : '',
              wide: true,
            },
          ]}
        />

        <SystemInfoPanel
          eyebrow="MEMORY & STORAGE"
          title="内存与存储"
          rows={[
            { label: '物理内存总量', value: formatBytes(snapshot.totalMemoryBytes) },
            { label: '物理内存可用', value: formatBytes(snapshot.availableMemoryBytes) },
            { label: '物理内存已用', value: formatBytes(memoryUsed) },
            { label: '内存负载', value: `${memoryPercent}%` },
            { label: '提交总限制', value: formatBytes(snapshot.totalPageFileBytes) },
            { label: '提交可用', value: formatBytes(snapshot.availablePageFileBytes) },
            { label: '提交已用', value: formatBytes(pageFileUsed) },
            { label: '系统盘', value: snapshot.systemDrive },
            { label: '系统盘总量', value: formatBytes(snapshot.systemDiskTotalBytes) },
            { label: '系统盘可用', value: formatBytes(snapshot.systemDiskFreeBytes) },
          ]}
        />

        <SystemInfoPanel
          eyebrow="NETWORK & ENVIRONMENT"
          title="网络与环境"
          rows={[
            { label: '主要网络适配器', value: snapshot.primaryNetworkAdapter, wide: true },
            { label: '主要 IPv4', value: snapshot.primaryIpv4 },
            { label: '活动适配器', value: `${snapshot.activeNetworkAdapters} 个` },
            { label: '时区', value: snapshot.timeZone, wide: true },
            { label: '系统区域', value: snapshot.localeName },
            { label: '供电状态', value: formatPower(snapshot) },
          ]}
        />
      </div>
    </>
  );
}

function MetricCard({ label, value, detail, progress }: {
  label: string;
  value: string;
  detail: string;
  progress?: number;
}) {
  const normalizedProgress = progress === undefined ? undefined : Math.max(0, Math.min(100, progress));
  return (
    <article className={styles.metricCard}>
      <span>{label}</span>
      <strong title={value}>{value}</strong>
      {normalizedProgress !== undefined && (
        <div
          className={styles.metricProgress}
          role="progressbar"
          aria-label={`${label}使用率`}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={normalizedProgress}
        >
          <i style={{ width: `${normalizedProgress}%` }} />
        </div>
      )}
      <small title={detail}>{detail}</small>
    </article>
  );
}

interface SystemInfoRow {
  label: string;
  value: string;
  wide?: boolean;
}

function SystemInfoPanel({ eyebrow, title, rows }: {
  eyebrow: string;
  title: string;
  rows: SystemInfoRow[];
}) {
  return (
    <article className={styles.systemPanel}>
      <header>
        <span>{eyebrow}</span>
        <h3>{title}</h3>
      </header>
      <div className={styles.systemInfoList}>
        {rows.map((row) => (
          <div key={`${row.label}-${row.value}`} className={row.wide ? styles.systemInfoWide : undefined}>
            <span>{row.label}</span>
            <strong title={row.value || '未报告'}>{row.value || '未报告'}</strong>
          </div>
        ))}
      </div>
    </article>
  );
}

function PortManagerWorkspace({ tool, onBack }: ToolWorkspaceProps) {
  const [entries, setEntries] = useState<PortEntry[]>([]);
  const [query, setQuery] = useState('');
  const [protocol, setProtocol] = useState<'all' | 'TCP' | 'UDP'>('all');
  const [busy, setBusy] = useState(false);
  const [terminatingPid, setTerminatingPid] = useState<number | null>(null);
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');

  const refresh = async () => {
    setBusy(true);
    setError('');
    try {
      setEntries(await requestPortEntries());
    } catch (refreshError) {
      setError(refreshError instanceof Error ? refreshError.message : '端口读取失败。');
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => { void refresh(); }, []);

  const filteredEntries = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase('zh-CN');
    return entries.filter((entry) => {
      if (protocol !== 'all' && entry.protocol !== protocol) return false;
      if (!normalized) return true;
      return `${entry.localAddress}:${entry.localPort} ${entry.remoteAddress}:${entry.remotePort} ${entry.processName} ${entry.processId} ${entry.state}`
        .toLocaleLowerCase('zh-CN')
        .includes(normalized);
    });
  }, [entries, protocol, query]);

  const terminate = async (entry: PortEntry) => {
    const confirmed = window.confirm(
      `确定结束 ${entry.processName}（PID ${entry.processId}）吗？\n这会关闭该进程拥有的全部窗口、任务和网络连接。`,
    );
    if (!confirmed) return;
    setTerminatingPid(entry.processId);
    setError('');
    setNotice('');
    try {
      setNotice(await terminatePortProcess(entry));
      await refresh();
    } catch (terminateError) {
      setError(terminateError instanceof Error ? terminateError.message : '结束进程失败。');
    } finally {
      setTerminatingPid(null);
    }
  };

  return (
    <section className={styles.workspace}>
      <WorkspaceHeading tool={tool} onBack={onBack} />
      <div className={styles.portControls}>
        <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索端口、进程或 PID…" />
        <select value={protocol} onChange={(event) => setProtocol(event.target.value as 'all' | 'TCP' | 'UDP')}>
          <option value="all">全部协议</option><option value="TCP">TCP</option><option value="UDP">UDP</option>
        </select>
        <button type="button" disabled={busy} onClick={() => void refresh()}>{busy ? '刷新中…' : '刷新'}</button>
      </div>
      {notice && <p className={styles.nativeNotice}>{notice}</p>}
      {error && <p className={styles.toolError}>{error}</p>}
      <div className={styles.portTableWrap}>
        <table className={styles.portTable}>
          <thead><tr><th>协议</th><th>本地端口</th><th>远端</th><th>状态</th><th>进程</th><th>操作</th></tr></thead>
          <tbody>
            {filteredEntries.map((entry, index) => {
              const protectedProcess = isProtectedPortProcess(entry);
              return (
                <tr key={`${entry.protocol}-${entry.localAddress}-${entry.localPort}-${entry.processId}-${index}`}>
                  <td><span className={entry.protocol === 'TCP' ? styles.tcpBadge : styles.udpBadge}>{entry.protocol}</span></td>
                  <td><strong>{entry.localAddress}:{entry.localPort}</strong></td>
                  <td>{entry.remotePort ? `${entry.remoteAddress}:${entry.remotePort}` : entry.remoteAddress}</td>
                  <td>{entry.state}</td>
                  <td><strong>{entry.processName}</strong><small>PID {entry.processId}</small></td>
                  <td><button type="button" disabled={protectedProcess || terminatingPid === entry.processId} onClick={() => void terminate(entry)}>{protectedProcess ? '系统保护' : terminatingPid === entry.processId ? '处理中…' : '结束进程'}</button></td>
                </tr>
              );
            })}
            {!filteredEntries.length && <tr><td colSpan={6} className={styles.emptyPorts}>没有符合条件的端口。</td></tr>}
          </tbody>
        </table>
      </div>
      <p className={styles.permissionFootnote}>结束进程需要二次确认；原生层会重新核对端口归属，并拒绝关键 Windows 进程。</p>
    </section>
  );
}

function formatBytes(bytes: number) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '—';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit += 1; }
  return `${value >= 100 ? value.toFixed(0) : value.toFixed(1)} ${units[unit]}`;
}

function formatUptime(milliseconds: number) {
  const totalHours = Math.floor(milliseconds / 3_600_000);
  const days = Math.floor(totalHours / 24);
  const hours = totalHours % 24;
  return days ? `${days} 天 ${hours} 小时` : `${hours} 小时`;
}

/** Returns a clamped whole-number percentage without exposing NaN to the UI. */
function percentage(used: number, total: number) {
  if (!Number.isFinite(used) || !Number.isFinite(total) || total <= 0) return 0;
  return Math.round(Math.max(0, Math.min(1, used / total)) * 100);
}

/** Joins optional pieces of native system metadata into one readable value. */
function joinPresent(...values: string[]) {
  return values.map((value) => value.trim()).filter(Boolean).join(' · ');
}

function formatDateTime(timestampMilliseconds: number) {
  if (!Number.isFinite(timestampMilliseconds) || timestampMilliseconds <= 0) return '未报告';
  return new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(new Date(timestampMilliseconds));
}

function formatUnixDate(timestampSeconds: number) {
  if (!Number.isFinite(timestampSeconds) || timestampSeconds <= 0) return '未报告';
  return new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(timestampSeconds * 1000));
}

function formatFrequency(megahertz: number) {
  if (!Number.isFinite(megahertz) || megahertz <= 0) return '未报告';
  return megahertz >= 1000 ? `${(megahertz / 1000).toFixed(2)} GHz` : `${Math.round(megahertz)} MHz`;
}

function formatPower(snapshot: SystemSnapshot) {
  const powerSource = snapshot.acLineStatus === 1
    ? '外接电源'
    : snapshot.acLineStatus === 0
      ? '电池供电'
      : '电源状态未知';
  const hasBatteryReading = snapshot.batteryPercent >= 0 && snapshot.batteryPercent <= 100;
  return hasBatteryReading ? `${powerSource} · ${snapshot.batteryPercent}%` : `${powerSource} · 未报告电池`;
}

function isProtectedPortProcess(entry: PortEntry) {
  const name = entry.processName.toLocaleLowerCase('en-US');
  return entry.processId <= 4 || [
    'system', 'registry', 'smss.exe', 'csrss.exe', 'wininit.exe',
    'services.exe', 'lsass.exe', 'winlogon.exe', 'svchost.exe',
    'fontdrvhost.exe', 'dwm.exe',
  ].includes(name);
}

interface ToolWorkspaceProps {
  tool: ToolDefinition;
  onBack(): void;
}

function ToolWorkspace({ tool, onBack }: ToolWorkspaceProps) {
  const [input, setInput] = useState(sampleInput(tool.id));
  const [secondaryInput, setSecondaryInput] = useState(sampleSecondaryInput(tool.id));
  const [operation, setOperation] = useState(defaultOperation(tool.id));
  const [pattern, setPattern] = useState('\\b\\w{4,}\\b');
  const [flags, setFlags] = useState('gi');
  const [output, setOutput] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    setInput(sampleInput(tool.id));
    setSecondaryInput(sampleSecondaryInput(tool.id));
    setOperation(defaultOperation(tool.id));
    setOutput('');
    setError('');
  }, [tool.id]);

  const run = async () => {
    setBusy(true);
    setError('');
    try {
      if (tool.id === 'json-format') {
        const parsed = JSON.parse(input) as unknown;
        setOutput(JSON.stringify(parsed, null, operation === 'minify' ? 0 : 2));
      } else if (tool.id === 'regex') {
        const expression = new RegExp(pattern, flags);
        const matches = Array.from(input.matchAll(expression));
        setOutput(matches.length
          ? matches.map((match, index) => `${index + 1}. ${match[0]}  [位置 ${match.index ?? 0}]`).join('\n')
          : '没有找到匹配内容。');
      } else if (tool.id === 'diff') {
        setOutput(createLineDiff(input, secondaryInput));
      } else {
        setOutput(await executeTool(toNativeRequest(tool.id, operation, input)));
      }
    } catch (runError) {
      setOutput('');
      setError(runError instanceof Error ? runError.message : '工具执行失败。');
    } finally {
      setBusy(false);
    }
  };

  const copyOutput = async () => {
    if (!output) return;
    await navigator.clipboard.writeText(output);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1400);
  };

  return (
    <section className={styles.workspace}>
      <header className={styles.workspaceHeader}>
        <button type="button" onClick={onBack}>← 返回工具列表</button>
        <div className={styles.workspaceTitle}>
          <i>{tool.glyph}</i>
          <div><span>{tool.runtime === 'c-core' ? 'C CORE · C++11 BRIDGE' : 'LOCAL REACT TOOL'}</span><h2>{tool.name}</h2><p>{tool.description}</p></div>
        </div>
      </header>

      <div className={styles.operationBar}>
        <OperationControls
          toolId={tool.id}
          operation={operation}
          onOperationChange={setOperation}
          pattern={pattern}
          flags={flags}
          onPatternChange={setPattern}
          onFlagsChange={setFlags}
        />
        <button className={styles.runButton} type="button" disabled={busy} onClick={run}>
          {busy ? '正在处理…' : '运行'}
        </button>
      </div>

      <div className={styles.editorGrid}>
        <label className={styles.editorPanel}>
          <span>{workspaceInputLabel(tool.id)}</span>
          <textarea value={input} onChange={(event) => setInput(event.target.value)} spellCheck={false} />
        </label>
        {tool.id === 'diff' ? (
          <label className={styles.editorPanel}>
            <span>修改后文本</span>
            <textarea value={secondaryInput} onChange={(event) => setSecondaryInput(event.target.value)} spellCheck={false} />
          </label>
        ) : (
          <div className={`${styles.editorPanel} ${styles.outputPanel}`}>
            <div><span>输出</span><button type="button" disabled={!output} onClick={copyOutput}>{copied ? '已复制' : '复制'}</button></div>
            {error ? <p className={styles.toolError}>{error}</p> : <pre>{output || '运行后结果会显示在这里。'}</pre>}
          </div>
        )}
      </div>

      {tool.id === 'diff' && (
        <div className={`${styles.editorPanel} ${styles.diffOutput}`}>
          <div><span>比较结果</span><button type="button" disabled={!output} onClick={copyOutput}>{copied ? '已复制' : '复制'}</button></div>
          {error ? <p className={styles.toolError}>{error}</p> : <pre>{output || '运行后会按行标出新增、删除和未变化内容。'}</pre>}
        </div>
      )}
    </section>
  );
}

interface OperationControlsProps {
  toolId: string;
  operation: string;
  onOperationChange(value: string): void;
  pattern: string;
  flags: string;
  onPatternChange(value: string): void;
  onFlagsChange(value: string): void;
}

function OperationControls(props: OperationControlsProps) {
  if (props.toolId === 'regex') {
    return (
      <div className={styles.regexControls}>
        <label><span>表达式</span><input value={props.pattern} onChange={(event) => props.onPatternChange(event.target.value)} /></label>
        <label><span>标志</span><input value={props.flags} maxLength={6} onChange={(event) => props.onFlagsChange(event.target.value)} /></label>
      </div>
    );
  }
  if (props.toolId === 'diff') return <span className={styles.operationHint}>按行比较两侧文本</span>;
  const options = operationOptions(props.toolId);
  return (
    <label className={styles.operationSelect}>
      <span>操作</span>
      <select value={props.operation} onChange={(event) => props.onOperationChange(event.target.value)}>
        {options.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
      </select>
    </label>
  );
}

function operationOptions(toolId: string) {
  if (toolId === 'hash') return [{ value: 'sha256', label: 'SHA-256' }, { value: 'md5', label: 'MD5（兼容用途）' }];
  if (toolId === 'url-encode') return [
    { value: 'encode-component', label: '编码 URL 组件' },
    { value: 'encode-url', label: '编码完整 URL' },
    { value: 'decode', label: '解码' },
  ];
  if (toolId === 'json-format') return [{ value: 'format', label: '格式化' }, { value: 'minify', label: '压缩' }];
  if (toolId === 'numfmt') return [{ value: 'group', label: '添加千位分组符' }];
  if (toolId === 'timestamp') return [
    { value: 'seconds', label: 'Unix 秒 → UTC' },
    { value: 'milliseconds', label: 'Unix 毫秒 → UTC' },
  ];
  if (toolId === 'uuid') return [
    { value: 'v4', label: 'UUID v4（随机）' },
    { value: 'v7', label: 'UUID v7（时间有序）' },
  ];
  if (toolId === 'password') return [
    { value: 'strong', label: '强密码（含符号）' },
    { value: 'letters-digits', label: '字母与数字' },
    { value: 'pin', label: '纯数字 PIN' },
  ];
  return [{ value: 'encode', label: '编码' }, { value: 'decode', label: '解码' }];
}

function defaultOperation(toolId: string) {
  if (toolId === 'hash') return 'sha256';
  if (toolId === 'url-encode') return 'encode-component';
  if (toolId === 'json-format') return 'format';
  if (toolId === 'numfmt') return 'group';
  if (toolId === 'timestamp') return 'milliseconds';
  if (toolId === 'uuid') return 'v4';
  if (toolId === 'password') return 'strong';
  return 'encode';
}

function sampleInput(toolId: string) {
  if (toolId === 'json-format') return '{"name":"可爱依依","features":["reminder","toolbox"]}';
  if (toolId === 'regex') return '云依助手的本地工具现在和可爱依依住在一起。';
  if (toolId === 'diff') return '可爱依依\n提醒事项\n桌面互动';
  if (toolId === 'url-encode') return 'https://example.com/search?q=可爱依依';
  if (toolId === 'numfmt') return '-1234567890.50';
  if (toolId === 'timestamp') return String(Date.now());
  if (toolId === 'uuid') return '5';
  if (toolId === 'password') return '24';
  return '云依助手 可爱依依';
}

function workspaceInputLabel(toolId: string) {
  if (toolId === 'diff') return '原始文本';
  if (toolId === 'numfmt') return '十进制数字';
  if (toolId === 'timestamp') return 'Unix 时间戳';
  if (toolId === 'uuid') return '生成数量（1–50）';
  if (toolId === 'password') return '密码长度（4–128）';
  return '输入';
}

function sampleSecondaryInput(toolId: string) {
  return toolId === 'diff' ? '可爱依依\n开发工具箱\n桌面互动' : '';
}

function toNativeRequest(toolId: string, operation: string, input: string): ToolExecuteRequest {
  return {
    toolId: toolId as ToolExecuteRequest['toolId'],
    operation,
    input,
    padded: true,
  };
}

/** Small deterministic line diff used until CloudYiCSC's richer plugin moves. */
function createLineDiff(left: string, right: string) {
  const before = left.split(/\r?\n/);
  const after = right.split(/\r?\n/);
  const length = Math.max(before.length, after.length);
  const lines: string[] = [];
  for (let index = 0; index < length; index += 1) {
    const oldLine = before[index];
    const newLine = after[index];
    if (oldLine === newLine) lines.push(`  ${oldLine ?? ''}`);
    else {
      if (oldLine !== undefined) lines.push(`- ${oldLine}`);
      if (newLine !== undefined) lines.push(`+ ${newLine}`);
    }
  }
  return lines.join('\n');
}
