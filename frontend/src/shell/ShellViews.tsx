import { type ReactNode, useMemo, useState } from 'react';
import packageInfo from '../../package.json';
import { setPluginEnabled, usePluginRegistry } from '../plugins/pluginRegistry';
import { permissionsForTool, READY_TOOL_COUNT, TOOL_DEFINITIONS } from '../toolbox/catalog';
import type { AppState, WorkspaceTextSize, WorkspaceTheme } from '../types';
import styles from './ShellViews.module.scss';

/** Enables or disables only the working modules bundled with the app. */
export function PluginStoreView() {
  const [query, setQuery] = useState('');
  const pluginState = usePluginRegistry();
  const filteredTools = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase('zh-CN');
    if (!normalized) return TOOL_DEFINITIONS;
    return TOOL_DEFINITIONS.filter((tool) =>
      `${tool.name} ${tool.shortName} ${tool.description}`
        .toLocaleLowerCase('zh-CN')
        .includes(normalized),
    );
  }, [query]);
  const enabledCount = TOOL_DEFINITIONS.filter(
    (tool) => pluginState[tool.id] !== false,
  ).length;

  return (
    <section className={styles.storeView}>
      <div className={styles.storeHero}>
        <div><span>LOCAL MODULES</span><h2>按需启用，让每项权限都看得见。</h2><p>内置模块的启用状态保存在本机；系统与进程权限仍由 C++11 原生层再次校验。</p></div>
        <div><strong>{enabledCount}</strong><span>Local</span><strong>{READY_TOOL_COUNT - enabledCount}</strong><span>Available</span></div>
      </div>
      <label className={styles.storeSearch}>
        <span>⌕</span>
        <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索模块或功能…" />
        <em>{filteredTools.length} 个结果</em>
      </label>
      <div className={styles.pluginGrid}>
        {filteredTools.map((tool) => {
          const enabled = pluginState[tool.id] !== false;
          return (
            <article key={tool.id} className={!enabled ? styles.pluginDisabled : undefined}>
              <i>{tool.glyph}</i>
              <div>
                <span>{enabled ? 'BUILT IN · LOCAL' : 'BUNDLED · AVAILABLE'}</span>
                <h3>{tool.name}</h3><p>{tool.description}</p>
                <ul className={styles.permissionList}>
                  {permissionsForTool(tool).map((permission) => <li key={permission}>{permission}</li>)}
                </ul>
              </div>
              <button
                type="button"
                onClick={() => setPluginEnabled(tool.id, !enabled)}
              >
                {enabled ? '停用' : '启用'}
              </button>
            </article>
          );
        })}
      </div>
    </section>
  );
}

type WorkbenchCenterTab = 'appearance' | 'plugins' | 'storage' | 'about';

const WORKBENCH_CENTER_TABS: { id: WorkbenchCenterTab; label: string; glyph: string }[] = [
  { id: 'appearance', label: '常规', glyph: '◐' },
  { id: 'plugins', label: '模块与版本', glyph: '◇' },
  { id: 'storage', label: '本机数据', glyph: '▤' },
  { id: 'about', label: '关于', glyph: 'i' },
];

interface WorkspaceCenterViewProps {
  state: AppState;
  onPreferencesChange(patch: {
    workspaceTheme?: WorkspaceTheme;
    workspaceTextSize?: WorkspaceTextSize;
    openLastView?: boolean;
  }): void;
  onOpenPluginStore(): void;
}

/** Local-first settings center containing only operational preferences. */
export function WorkspaceCenterView({ state, onPreferencesChange, onOpenPluginStore }: WorkspaceCenterViewProps) {
  const [tab, setTab] = useState<WorkbenchCenterTab>('appearance');
  const pluginState = usePluginRegistry();
  const readyTools = TOOL_DEFINITIONS;
  const enabledTools = readyTools.filter((tool) => pluginState[tool.id] !== false).length;
  const customCharacters = state.characters.filter((character) => !character.builtIn).length;

  return (
    <section className={styles.centerView}>
      <div className={styles.centerShell}>
        <nav className={styles.centerTabs} aria-label="云依助手设置">
          <div><span>CLOUDYI ASSISTANT</span><strong>助手设置</strong></div>
          {WORKBENCH_CENTER_TABS.map((item) => (
            <button
              key={item.id}
              type="button"
              className={tab === item.id ? styles.centerTabActive : undefined}
              aria-current={tab === item.id ? 'page' : undefined}
              onClick={() => setTab(item.id)}
            >
              <i>{item.glyph}</i><span>{item.label}</span>
            </button>
          ))}
        </nav>

        <div className={styles.centerContent}>
          {tab === 'appearance' && (
            <SettingsPane kicker="GENERAL" title="常规与外观" description="设置会写入本机 SQLite，并在下次启动时恢复。">
              <SettingsSection title="主题颜色">
                <div className={styles.themeChoices}>
                  {([
                    ['warm', '暖杏', '陪伴模式', '#f8f4ee', '#eaa06e'],
                    ['cloud', '云青', '工具模式', '#edf6f4', '#168b85'],
                    ['rose', '柔粉', '轻松模式', '#fbf1f2', '#d98291'],
                  ] as const).map(([value, label, detail, background, accent]) => (
                    <button
                      key={value}
                      type="button"
                      aria-pressed={state.workspaceTheme === value}
                      className={state.workspaceTheme === value ? styles.choiceActive : undefined}
                      onClick={() => onPreferencesChange({ workspaceTheme: value })}
                    >
                      <i style={{ background: `linear-gradient(135deg, ${background} 62%, ${accent} 62%)` }} />
                      <span><strong>{label}</strong><small>{detail}</small></span>
                    </button>
                  ))}
                </div>
                <p className={styles.settingHint}>当前三套浅色主题均已完整可用。</p>
              </SettingsSection>
              <SettingsSection title="界面显示">
                <SettingLine label="界面字号" detail="同时缩放侧栏、工具和表单，避免只放大部分文字。">
                  <div className={styles.segmentedControl}>
                    {([
                      ['compact', '紧凑'], ['comfortable', '标准'], ['large', '放大'],
                    ] as const).map(([value, label]) => (
                      <button key={value} type="button" className={state.workspaceTextSize === value ? styles.segmentActive : undefined} onClick={() => onPreferencesChange({ workspaceTextSize: value })}>{label}</button>
                    ))}
                  </div>
                </SettingLine>
                <SettingLine label="记住上次页面" detail="重新打开工作台时回到上次使用的页面或工具分类。">
                  <button
                    type="button"
                    role="switch"
                    aria-checked={state.openLastView}
                    className={`${styles.miniSwitch} ${state.openLastView ? styles.miniSwitchActive : ''}`}
                    onClick={() => onPreferencesChange({ openLastView: !state.openLastView })}
                  ><i /></button>
                </SettingLine>
              </SettingsSection>
            </SettingsPane>
          )}

          {tab === 'plugins' && (
            <SettingsPane kicker="MODULES & VERSION" title="模块与版本" description="这里只展示内置模块的真实启用状态和当前应用版本。">
              <div className={styles.summaryCards}>
                <article><span>已启用</span><strong>{enabledTools}</strong><small>Local</small></article>
                <article><span>未启用</span><strong>{readyTools.length - enabledTools}</strong><small>Available</small></article>
                <article><span>当前版本</span><strong>v{packageInfo.version}</strong><small>Release</small></article>
              </div>
              <SettingsSection title="模块管理">
                <SettingLine label="本地模块目录" detail={`${READY_TOOL_COUNT} 项功能已经接入；启用状态保存在当前 WebView 用户数据中。`}>
                  <button type="button" className={styles.secondaryButton} onClick={onOpenPluginStore}>打开模块管理</button>
                </SettingLine>
              </SettingsSection>
            </SettingsPane>
          )}

          {tab === 'storage' && (
            <SettingsPane kicker="LOCAL STORAGE" title="本机数据" description="这些内容全部保存在本机，不会上传到云端。">
              <div className={styles.summaryCards}>
                <article><span>未完成事项</span><strong>{state.reminders.length}</strong><small>SQLite</small></article>
                <article><span>自定义角色</span><strong>{customCharacters}</strong><small>Characters</small></article>
                <article><span>偏好设置</span><strong>本机</strong><small>Settings</small></article>
              </div>
              <SettingsSection title="保存位置与边界">
                <SettingLine label="事项与偏好" detail="保存在应用数据目录的 yiyi.db 中，由 C++11 SQLite 层读写。"><span className={styles.statusPill}>本机保存</span></SettingLine>
                <SettingLine label="角色图片" detail="保存在应用数据目录的 Characters 文件夹中，不会嵌入数据库。"><span className={styles.statusPill}>不上云</span></SettingLine>
                <SettingLine label="工具输入" detail="代码、SQL 和转换文本只在当前界面内处理，默认不保存。"><span className={styles.statusPill}>不持久化</span></SettingLine>
              </SettingsSection>
            </SettingsPane>
          )}

          {tab === 'about' && (
            <SettingsPane kicker="ABOUT CLOUDYI ASSISTANT" title="关于云依助手" description="桌面陪伴、事项提醒与本地工具共用一个本地优先的 Windows 客户端。">
              <SettingsSection title="版本信息">
                <SettingLine label="云依助手" detail="当前应用版本"><strong className={styles.aboutValue}>v{packageInfo.version}</strong></SettingLine>
                <SettingLine label="原生层" detail="C Win32 探针、C++11 应用与 WebView2 桥接"><strong className={styles.aboutValue}>C / C++11</strong></SettingLine>
                <SettingLine label="界面层" detail="组件、动画与 SCSS Modules"><strong className={styles.aboutValue}>React 18</strong></SettingLine>
                <SettingLine label="数据层" detail="事项、角色元数据与工作台偏好"><strong className={styles.aboutValue}>SQLite</strong></SettingLine>
              </SettingsSection>
            </SettingsPane>
          )}
        </div>
      </div>
    </section>
  );
}

function SettingsPane({ kicker, title, description, children }: {
  kicker: string;
  title: string;
  description: string;
  children: ReactNode;
}) {
  return <div className={styles.settingsPane}><header><span>{kicker}</span><h2>{title}</h2><p>{description}</p></header>{children}</div>;
}

function SettingsSection({ title, children }: { title: string; children: ReactNode }) {
  return <section className={styles.settingsSection}><h3>{title}</h3><div>{children}</div></section>;
}

function SettingLine({ label, detail, children }: { label: string; detail: string; children: ReactNode }) {
  return <div className={styles.settingLine}><span><strong>{label}</strong><small>{detail}</small></span><div>{children}</div></div>;
}
