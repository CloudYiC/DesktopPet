import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';
import { requestSystemSnapshot } from '../bridge/hostBridge';
import type { SystemSnapshot } from '../types';
import type { ToolDefinition } from './catalog';
import { ToolWorkspaceHeader } from '../../../shared/tool-workspace/ToolWorkspaceHeader';
import styles from './SystemCenterWorkspace.module.scss';

interface SystemCenterProps {
  tool: ToolDefinition;
  onBack(): void;
}

type SectionId = 'device' | 'processor' | 'memory' | 'network';
const sections: { id: SectionId; label: string }[] = [
  { id: 'device', label: '设备与系统' },
  { id: 'processor', label: '处理器与显示' },
  { id: 'memory', label: '内存与存储' },
  { id: 'network', label: '网络与环境' },
];

/** Read-only system overview: compact metrics stay visible while details change by tab. */
export function SystemCenterWorkspace({ tool, onBack }: SystemCenterProps) {
  const [snapshot, setSnapshot] = useState<SystemSnapshot | null>(null);
  const [section, setSection] = useState<SectionId>('device');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [readAt, setReadAt] = useState(0);
  const generation = useRef(0);
  const tabRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const tabId = useId();

  const refresh = async () => {
    const request = ++generation.current;
    setBusy(true);
    setError('');
    try {
      const next = await requestSystemSnapshot();
      if (request !== generation.current) return;
      setSnapshot(next);
      setReadAt(Date.now());
    } catch (refreshError) {
      if (request !== generation.current) return;
      setError(refreshError instanceof Error ? refreshError.message : '系统信息读取失败。');
    } finally {
      if (request === generation.current) setBusy(false);
    }
  };

  useEffect(() => {
    void refresh();
    return () => { generation.current += 1; };
  }, []);

  const moveTab = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    let next = index;
    if (event.key === 'ArrowRight') next = (index + 1) % sections.length;
    else if (event.key === 'ArrowLeft') next = (index + sections.length - 1) % sections.length;
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = sections.length - 1;
    else return;
    event.preventDefault();
    setSection(sections[next].id);
    tabRefs.current[next]?.focus();
  };

  return (
    <section className={styles.workspace} data-testid="system-center-workspace">
      <div className={styles.topbar}>
        <ToolWorkspaceHeader title={tool.name} onBack={onBack} />
        <button className={styles.refresh} type="button" disabled={busy} onClick={() => void refresh()}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true"><path d="M20 7v5h-5M4 17v-5h5" /><path d="M5.4 7a8 8 0 0 1 13.2-1L20 8M4 16l1.4 2A8 8 0 0 0 18.6 17" /></svg>
          {busy ? '读取中…' : '刷新信息'}
        </button>
      </div>
      {error && <p className={styles.error} role="alert">{error}</p>}
      {!snapshot && <div className={styles.loading} role="status">{busy ? '正在读取设备信息…' : '暂未获取设备信息'}</div>}
      {snapshot && <>
        <SnapshotMetrics snapshot={snapshot} />
        <div className={styles.details}>
          <div className={styles.tabs} role="tablist" aria-label="系统信息分类">
            {sections.map((item, index) => <button
              type="button"
              key={item.id}
              id={`${tabId}-${item.id}`}
              role="tab"
              aria-selected={section === item.id}
              aria-controls={`${tabId}-panel-${item.id}`}
              tabIndex={section === item.id ? 0 : -1}
              ref={(element) => { tabRefs.current[index] = element; }}
              onKeyDown={(event) => moveTab(event, index)}
              onClick={() => setSection(item.id)}
            >{item.label}</button>)}
          </div>
          <div id={`${tabId}-panel-${section}`} className={styles.panel} role="tabpanel" aria-labelledby={`${tabId}-${section}`} tabIndex={0}>
            <dl className={styles.infoGrid}>
              {rowsForSection(snapshot, section, readAt).map((row) => <div key={row.label} className={row.wide ? styles.wide : undefined}>
                <dt>{row.label}</dt>
                <dd>{row.value || '未报告'}</dd>
              </div>)}
            </dl>
          </div>
          <footer className={styles.updated}><span className={styles.liveDot} aria-hidden="true" />最近读取 <time dateTime={new Date(readAt).toISOString()}>{formatTime(readAt)}</time></footer>
        </div>
      </>}
    </section>
  );
}

function SnapshotMetrics({ snapshot }: { snapshot: SystemSnapshot }) {
  const memoryUsed = Math.max(0, snapshot.totalMemoryBytes - snapshot.availableMemoryBytes);
  const memoryPercent = usagePercent(snapshot, memoryUsed);
  const diskUsed = Math.max(0, snapshot.systemDiskTotalBytes - snapshot.systemDiskFreeBytes);
  const diskPercent = percentage(diskUsed, snapshot.systemDiskTotalBytes);
  const processorSummary = snapshot.physicalCores
    ? `${snapshot.physicalCores} 核 / ${snapshot.logicalProcessors} 线程`
    : `${snapshot.logicalProcessors} 个逻辑处理器`;
  return <div className={styles.metrics} aria-label="设备概览">
    <MetricCard tone="blue" icon="system" label="操作系统" value={snapshot.operatingSystem} detail={osDetail(snapshot) || snapshot.architecture} />
    <MetricCard tone="violet" icon="processor" label="处理器" value={processorSummary} detail={snapshot.processorName || '未报告处理器型号'} />
    <MetricCard tone="teal" icon="memory" label="物理内存" value={`${formatBytes(memoryUsed)} 已用`} detail={`总计 ${formatBytes(snapshot.totalMemoryBytes)} · 可用 ${formatBytes(snapshot.availableMemoryBytes)}`} progress={memoryPercent} />
    <MetricCard tone="amber" icon="storage" label={`${snapshot.systemDrive || '系统盘'} 存储`} value={`${formatBytes(snapshot.systemDiskFreeBytes)} 可用`} detail={`总计 ${formatBytes(snapshot.systemDiskTotalBytes)} · 已用 ${formatBytes(diskUsed)}`} progress={diskPercent} />
  </div>;
}

function MetricCard({ tone, icon, label, value, detail, progress }: {
  tone: 'blue' | 'violet' | 'teal' | 'amber';
  icon: 'system' | 'processor' | 'memory' | 'storage';
  label: string;
  value: string;
  detail: string;
  progress?: number;
}) {
  return <article className={`${styles.metric} ${styles[tone]}`}>
    <header><span className={styles.metricIcon}><MetricIcon kind={icon} /></span><span>{label}</span>{progress !== undefined && <b>{progress}%</b>}</header>
    <strong>{value || '未报告'}</strong>
    <small>{detail}</small>
    {progress !== undefined && <div className={styles.progress} role="progressbar" aria-label={`${label}使用率`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={progress}><i style={{ width: `${progress}%` }} /></div>}
  </article>;
}

function MetricIcon({ kind }: { kind: 'system' | 'processor' | 'memory' | 'storage' }) {
  const paths = {
    system: <><rect x="3" y="4" width="18" height="13" rx="2" /><path d="M8 21h8M12 17v4M6 8h5v5H6zM14 8h4M14 11h4" /></>,
    processor: <><rect x="6" y="6" width="12" height="12" rx="2" /><rect x="9" y="9" width="6" height="6" rx="1" /><path d="M9 3v3m6-3v3M9 18v3m6-3v3M3 9h3m-3 6h3m12-6h3m-3 6h3" /></>,
    memory: <><path d="M3 6h18v5a2 2 0 0 0 0 4v3H3v-3a2 2 0 0 0 0-4zM6 18v3m4-3v3m4-3v3m4-3v3" /><path d="M7 10v4m5-4v4m5-4v4" /></>,
    storage: <><path d="M6 4h12l3 11v5H3v-5zM3 15h18" /><path d="M6 18h.01M9 18h.01M8 8h8" /></>,
  };
  return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[kind]}</svg>;
}

interface InfoRow { label: string; value: string; wide?: boolean }

function rowsForSection(snapshot: SystemSnapshot, section: SectionId, readAt: number): InfoRow[] {
  const memoryUsed = Math.max(0, snapshot.totalMemoryBytes - snapshot.availableMemoryBytes);
  switch (section) {
    case 'device': return [
      { label: '计算机名称', value: snapshot.computerName },
      { label: '当前用户', value: snapshot.userName },
      { label: '设备厂商', value: snapshot.manufacturer },
      { label: '设备型号', value: snapshot.model },
      { label: 'Windows 版本', value: osDetail(snapshot), wide: true },
      { label: 'BIOS', value: joinPresent(snapshot.biosVersion, snapshot.biosDate), wide: true },
      { label: '系统安装日期', value: formatUnixDate(snapshot.installUnixSeconds) },
      { label: '本次启动时间', value: formatDateTime(readAt - snapshot.uptimeMilliseconds) },
      { label: '持续运行', value: formatUptime(snapshot.uptimeMilliseconds) },
      { label: '数据权限', value: '本机只读' },
    ];
    case 'processor': return [
      { label: '处理器型号', value: snapshot.processorName, wide: true },
      { label: '物理核心', value: snapshot.physicalCores ? `${snapshot.physicalCores} 核` : '' },
      { label: '逻辑处理器', value: `${snapshot.logicalProcessors} 线程` },
      { label: '处理器插槽', value: snapshot.processorPackages ? `${snapshot.processorPackages} 个` : '' },
      { label: '标称频率', value: formatFrequency(snapshot.processorMaxMegahertz) },
      { label: '固件虚拟化', value: snapshot.virtualizationEnabled ? '已启用' : '未启用或不可用' },
      { label: '主屏幕', value: snapshot.primaryDisplayWidth && snapshot.primaryDisplayHeight ? `${snapshot.primaryDisplayWidth} × ${snapshot.primaryDisplayHeight} · ${snapshot.primaryDisplayDpi || 96} DPI` : '' },
      { label: '主显示适配器', value: snapshot.primaryGraphics, wide: true },
    ];
    case 'memory': return [
      { label: '物理内存总量', value: formatBytes(snapshot.totalMemoryBytes) },
      { label: '物理内存可用', value: formatBytes(snapshot.availableMemoryBytes) },
      { label: '物理内存已用', value: formatBytes(memoryUsed) },
      { label: '内存负载', value: `${usagePercent(snapshot, memoryUsed)}%` },
      { label: '提交总限制', value: formatBytes(snapshot.totalPageFileBytes) },
      { label: '提交可用', value: formatBytes(snapshot.availablePageFileBytes) },
      { label: '提交已用', value: formatBytes(Math.max(0, snapshot.totalPageFileBytes - snapshot.availablePageFileBytes)) },
      { label: '系统盘', value: snapshot.systemDrive },
      { label: '系统盘总量', value: formatBytes(snapshot.systemDiskTotalBytes) },
      { label: '系统盘可用', value: formatBytes(snapshot.systemDiskFreeBytes) },
    ];
    case 'network': return [
      { label: '主要网络适配器', value: snapshot.primaryNetworkAdapter, wide: true },
      { label: '主要 IPv4', value: snapshot.primaryIpv4 },
      { label: '活动适配器', value: `${snapshot.activeNetworkAdapters} 个` },
      { label: '时区', value: snapshot.timeZone, wide: true },
      { label: '系统区域', value: snapshot.localeName },
      { label: '供电状态', value: formatPower(snapshot) },
    ];
  }
}

function osDetail(snapshot: SystemSnapshot) {
  return [snapshot.osEdition, snapshot.osDisplayVersion, snapshot.osBuild ? `Build ${snapshot.osBuild}` : '', snapshot.architecture].filter(Boolean).join(' · ');
}

function formatBytes(bytes: number) {
  if (!Number.isFinite(bytes) || bytes < 0) return '未报告';
  if (bytes === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit += 1; }
  return `${value >= 100 ? value.toFixed(0) : value.toFixed(1)} ${units[unit]}`;
}

function formatUptime(milliseconds: number) {
  if (!Number.isFinite(milliseconds) || milliseconds < 0) return '未报告';
  const totalMinutes = Math.floor(milliseconds / 60_000);
  if (totalMinutes < 60) return `${totalMinutes} 分钟`;
  const hours = Math.floor(totalMinutes / 60);
  return hours >= 24 ? `${Math.floor(hours / 24)} 天 ${hours % 24} 小时` : `${hours} 小时 ${totalMinutes % 60} 分钟`;
}

function percentage(used: number, total: number) {
  if (!Number.isFinite(used) || !Number.isFinite(total) || total <= 0) return 0;
  return Math.round(Math.max(0, Math.min(1, used / total)) * 100);
}

function usagePercent(snapshot: SystemSnapshot, memoryUsed: number) {
  return snapshot.memoryLoadPercent > 0 && Number.isFinite(snapshot.memoryLoadPercent)
    ? Math.round(Math.max(0, Math.min(100, snapshot.memoryLoadPercent)))
    : percentage(memoryUsed, snapshot.totalMemoryBytes);
}

function joinPresent(...values: string[]) {
  return values.map((value) => value.trim()).filter(Boolean).join(' · ');
}

function formatDateTime(timestamp: number) {
  if (!Number.isFinite(timestamp) || timestamp <= 0) return '未报告';
  return new Intl.DateTimeFormat('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(timestamp));
}

function formatTime(timestamp: number) {
  return new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }).format(new Date(timestamp));
}

function formatUnixDate(timestampSeconds: number) {
  if (!Number.isFinite(timestampSeconds) || timestampSeconds <= 0) return '未报告';
  return new Intl.DateTimeFormat('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(timestampSeconds * 1000));
}

function formatFrequency(megahertz: number) {
  if (!Number.isFinite(megahertz) || megahertz <= 0) return '未报告';
  return megahertz >= 1000 ? `${(megahertz / 1000).toFixed(2)} GHz` : `${Math.round(megahertz)} MHz`;
}

function formatPower(snapshot: SystemSnapshot) {
  const source = snapshot.acLineStatus === 1 ? '外接电源' : snapshot.acLineStatus === 0 ? '电池供电' : '电源状态未知';
  return snapshot.batteryPercent >= 0 && snapshot.batteryPercent <= 100 ? `${source} · ${snapshot.batteryPercent}%` : `${source} · 未报告电池`;
}
