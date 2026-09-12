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
    <section className={styles.centerView} data-testid="assistant-settings">
      <div className={styles.centerShell}>
        <nav className={styles.centerTabs} role="tablist" aria-label="助手设置分类">
          {WORKBENCH_CENTER_TABS.map((item, index) => (
            <button
              key={item.id}
              type="button"
              role="tab"
              id={`assistant-settings-tab-${item.id}`}
              aria-controls={`assistant-settings-panel-${item.id}`}
              className={tab === item.id ? styles.centerTabActive : undefined}
              aria-selected={tab === item.id}
              tabIndex={tab === item.id ? 0 : -1}
              onClick={() => setTab(item.id)}
              onKeyDown={(event) => {
                const total = WORKBENCH_CENTER_TABS.length;
                const next = event.key === 'ArrowRight' ? (index + 1) % total
                  : event.key === 'ArrowLeft' ? (index + total - 1) % total
                    : event.key === 'Home' ? 0 : event.key === 'End' ? total - 1 : null;
                if (next === null) return;
                event.preventDefault();
                setTab(WORKBENCH_CENTER_TABS[next].id);
                event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>('[role="tab"]')[next]?.focus();
              }}
            >
              <i aria-hidden="true">{item.glyph}</i><span>{item.label}</span>
            </button>
          ))}
        </nav>

        <div className={styles.centerContent} role="tabpanel" id={`assistant-settings-panel-${tab}`} aria-labelledby={`assistant-settings-tab-${tab}`}>
          {tab === 'appearance' && (
            <SettingsPane title="常规与外观">
              <SettingsSection title="主题颜色">
                <div className={styles.themeChoices} role="group" aria-label="主题颜色">
                  {([
                    ['warm', '暖杏', '#f8f4ee', '#eaa06e'],
                    ['cloud', '云青', '#edf6f4', '#168b85'],
                    ['rose', '柔粉', '#fbf1f2', '#d98291'],
                  ] as const).map(([value, label, background, accent]) => (
                    <button
                      key={value}
                      type="button"
                      aria-pressed={state.workspaceTheme === value}
                      className={state.workspaceTheme === value ? styles.choiceActive : undefined}
                      onClick={() => onPreferencesChange({ workspaceTheme: value })}
                    >
                      <i aria-hidden="true" style={{ background: `linear-gradient(135deg, ${background} 62%, ${accent} 62%)` }} />
                      <strong>{label}</strong>
                    </button>
                  ))}
                </div>
              </SettingsSection>
              <SettingsSection title="界面显示">
                <SettingLine label="界面字号">
                  <div className={styles.segmentedControl} role="group" aria-label="界面字号">
                    {([
                      ['compact', '紧凑'], ['comfortable', '标准'], ['large', '放大'],
                    ] as const).map(([value, label]) => (
                      <button key={value} type="button" aria-pressed={state.workspaceTextSize === value} className={state.workspaceTextSize === value ? styles.segmentActive : undefined} onClick={() => onPreferencesChange({ workspaceTextSize: value })}>{label}</button>
                    ))}
                  </div>
                </SettingLine>
                <SettingLine label="记住上次页面">
                  <button
                    type="button"
                    role="switch"
                    aria-label="记住上次页面"
                    aria-checked={state.openLastView}
                    className={`${styles.miniSwitch} ${state.openLastView ? styles.miniSwitchActive : ''}`}
                    onClick={() => onPreferencesChange({ openLastView: !state.openLastView })}
                  ><i aria-hidden="true" /></button>
                </SettingLine>
              </SettingsSection>
            </SettingsPane>
          )}

          {tab === 'plugins' && (
            <SettingsPane title="模块与版本">
              <div className={styles.summaryCards}>
                <article><span>已启用</span><strong>{enabledTools}</strong></article>
                <article><span>未启用</span><strong>{readyTools.length - enabledTools}</strong></article>
                <article><span>当前版本</span><strong>v{packageInfo.version}</strong></article>
              </div>
              <SettingsSection title="模块管理">
                <SettingLine label={`内置工具 · ${READY_TOOL_COUNT} 项`}>
                  <button type="button" className={styles.secondaryButton} onClick={onOpenPluginStore}>打开模块管理</button>
                </SettingLine>
              </SettingsSection>
            </SettingsPane>
          )}

          {tab === 'storage' && (
            <SettingsPane title="本机数据">
              <div className={styles.summaryCards}>
                <article><span>未完成事项</span><strong>{state.reminders.length}</strong></article>
                <article><span>自定义角色</span><strong>{customCharacters}</strong></article>
                <article><span>偏好设置</span><strong>本机</strong></article>
              </div>
              <SettingsSection title="保存位置">
                <SettingLine label="事项与偏好"><code className={styles.dataValue}>yiyi.db</code></SettingLine>
                <SettingLine label="角色图片"><code className={styles.dataValue}>Characters/</code></SettingLine>
                <SettingLine label="工具输入"><span className={styles.dataValue}>仅当前会话</span></SettingLine>
              </SettingsSection>
            </SettingsPane>
          )}

          {tab === 'about' && (
            <SettingsPane title="关于云依助手">
              <SettingsSection title="版本信息">
                <SettingLine label="云依助手"><strong className={styles.aboutValue}>v{packageInfo.version}</strong></SettingLine>
                <SettingLine label="原生层"><strong className={styles.aboutValue}>C / C++11</strong></SettingLine>
                <SettingLine label="界面层"><strong className={styles.aboutValue}>React 18</strong></SettingLine>
                <SettingLine label="数据层"><strong className={styles.aboutValue}>SQLite</strong></SettingLine>
              </SettingsSection>
            </SettingsPane>
          )}
        </div>
      </div>
    </section>
  );
}

function SettingsPane({ title, children }: {
  title: string;
  children: ReactNode;
}) {
  return <div className={styles.settingsPane}><h2 className={styles.paneTitle}>{title}</h2>{children}</div>;
}

function SettingsSection({ title, children }: { title: string; children: ReactNode }) {
  return <section className={styles.settingsSection}><h3>{title}</h3><div>{children}</div></section>;
}

function SettingLine({ label, children }: { label: string; children: ReactNode }) {
  return <div className={styles.settingLine}><strong>{label}</strong><div>{children}</div></div>;
}
