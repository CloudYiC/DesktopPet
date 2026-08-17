import { FormEvent, type ReactNode, useMemo, useState } from 'react';
import packageInfo from '../../package.json';
import { setPluginEnabled, usePluginRegistry } from '../plugins/pluginRegistry';
import { permissionsForTool, READY_TOOL_COUNT, TOOL_DEFINITIONS } from '../toolbox/catalog';
import type { AppState, WorkspaceTextSize, WorkspaceTheme } from '../types';
import styles from './ShellViews.module.scss';

/** Read-only first migration of the signed CloudYi plugin catalog. */
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
    (tool) => tool.runtime !== 'planned' && pluginState[tool.id] !== false,
  ).length;

  return (
    <section className={styles.storeView}>
      <div className={styles.storeHero}>
        <div><span>PLUGIN MANAGER</span><h2>按需启用，让每项权限都看得见。</h2><p>内置插件的启用状态保存在本机；系统与进程权限仍由 C++11 原生层再次校验。</p></div>
        <div><strong>{enabledCount}</strong><span>Local</span><strong>{READY_TOOL_COUNT - enabledCount}</strong><span>Available</span></div>
      </div>
      <label className={styles.storeSearch}>
        <span>⌕</span>
        <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索插件或功能…" />
        <em>{filteredTools.length} 个结果</em>
      </label>
      <div className={styles.pluginGrid}>
        {filteredTools.map((tool) => {
          const ready = tool.runtime !== 'planned';
          const enabled = ready && pluginState[tool.id] !== false;
          return (
            <article key={tool.id} className={!enabled && ready ? styles.pluginDisabled : undefined}>
              <i>{tool.glyph}</i>
              <div>
                <span>{!ready ? 'COMING SOON' : enabled ? 'BUILT IN · LOCAL' : 'BUNDLED · AVAILABLE'}</span>
                <h3>{tool.name}</h3><p>{tool.description}</p>
                <ul className={styles.permissionList}>
                  {permissionsForTool(tool).map((permission) => <li key={permission}>{permission}</li>)}
                </ul>
              </div>
              <button
                type="button"
                disabled={!ready}
                onClick={() => setPluginEnabled(tool.id, !enabled)}
              >
                {!ready ? 'Coming Soon' : enabled ? 'Remove' : 'Install'}
              </button>
            </article>
          );
        })}
      </div>
    </section>
  );
}

type CloudYiCenterTab = 'account' | 'appearance' | 'plugins' | 'storage' | 'about';

const CLOUDYI_CENTER_TABS: { id: CloudYiCenterTab; label: string; glyph: string }[] = [
  { id: 'account', label: '账户', glyph: '依' },
  { id: 'appearance', label: '常规', glyph: '◐' },
  { id: 'plugins', label: '插件与版本', glyph: '◇' },
  { id: 'storage', label: '本机数据', glyph: '▤' },
  { id: 'about', label: '关于', glyph: 'i' },
];

interface AccountViewProps {
  state: AppState;
  onPreferencesChange(patch: {
    workspaceTheme?: WorkspaceTheme;
    workspaceTextSize?: WorkspaceTextSize;
    openLastView?: boolean;
  }): void;
  onOpenPluginStore(): void;
}

/** Local-first CloudYi center; cloud authentication remains intentionally inert. */
export function AccountView({ state, onPreferencesChange, onOpenPluginStore }: AccountViewProps) {
  const [tab, setTab] = useState<CloudYiCenterTab>('account');
  const [mode, setMode] = useState<'login' | 'register'>('login');
  const [notice, setNotice] = useState('');
  const pluginState = usePluginRegistry();
  const readyTools = TOOL_DEFINITIONS.filter((tool) => tool.runtime !== 'planned');
  const enabledTools = readyTools.filter((tool) => pluginState[tool.id] !== false).length;
  const customCharacters = state.characters.filter((character) => !character.builtIn).length;
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setNotice('账户界面已经迁移；云端接口接入前不会创建虚假的登录状态。');
  };

  return (
    <section className={styles.accountView}>
      <div className={styles.centerShell}>
        <nav className={styles.centerTabs} aria-label="CloudYi 中心">
          <div><span>CLOUDYI CENTER</span><strong>账户与偏好</strong></div>
          {CLOUDYI_CENTER_TABS.map((item) => (
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
          {tab === 'account' && (
            <article className={styles.accountCard}>
              <div className={styles.accountIntro}>
                <span>CLOUDYI ACCOUNT</span>
                <h2>登录后管理插件权限与多设备设置。</h2>
                <p>提醒事项、角色图片和工具输入默认仍只保存在本机，不会因为登录自动上传。</p>
                <ul>
                  <li><i>✓</i><span><strong>本地优先</strong><small>未登录也可使用内置工具和小助手。</small></span></li>
                  <li><i>✓</i><span><strong>权限透明</strong><small>高权限插件安装前显示文件、网络或进程权限。</small></span></li>
                  <li><i>✓</i><span><strong>按需同步</strong><small>以后可单独选择同步设置，不默认同步私人数据。</small></span></li>
                </ul>
              </div>
              <div className={styles.authPanel}>
                <div className={styles.authTabs}>
                  <button type="button" className={mode === 'login' ? styles.activeTab : undefined} onClick={() => setMode('login')}>登录</button>
                  <button type="button" className={mode === 'register' ? styles.activeTab : undefined} onClick={() => setMode('register')}>注册</button>
                </div>
                <form onSubmit={submit}>
                  {mode === 'register' && <label><span>显示名称</span><input required maxLength={30} placeholder="怎么称呼你" /></label>}
                  <label><span>邮箱</span><input required type="email" placeholder="name@example.com" /></label>
                  <label><span>密码</span><input required type="password" minLength={8} placeholder="至少 8 位" /></label>
                  <button type="submit">{mode === 'login' ? '登录 CloudYi' : '创建账户'}</button>
                </form>
                {notice && <p className={styles.accountNotice}>{notice}</p>}
                <small>当前为账户界面预览，尚未向任何服务器发送数据。</small>
              </div>
            </article>
          )}

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
                <p className={styles.settingHint}>当前提供三套完整浅色主题；深色主题会在所有工具完成对比度校准后加入。</p>
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
            <SettingsPane kicker="PLUGINS & VERSION" title="插件与版本" description="这里只展示真实的本地安装状态，不模拟在线更新。">
              <div className={styles.summaryCards}>
                <article><span>已启用</span><strong>{enabledTools}</strong><small>Local</small></article>
                <article><span>可安装</span><strong>{readyTools.length - enabledTools}</strong><small>Available</small></article>
                <article><span>当前版本</span><strong>v{packageInfo.version}</strong><small>Release</small></article>
              </div>
              <SettingsSection title="插件管理">
                <SettingLine label="本地插件目录" detail={`${READY_TOOL_COUNT} 项功能已经接入；安装状态保存在当前 WebView 用户数据中。`}>
                  <button type="button" className={styles.secondaryButton} onClick={onOpenPluginStore}>打开插件商店</button>
                </SettingLine>
                <SettingLine label="在线更新" detail="尚未配置签名清单与校验服务，因此不会展示一个无效的检查按钮。"><span className={styles.statusPill}>待接服务</span></SettingLine>
              </SettingsSection>
            </SettingsPane>
          )}

          {tab === 'storage' && (
            <SettingsPane kicker="LOCAL STORAGE" title="本机数据" description="这些内容默认不会因为打开账户页面而上传。">
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
            <SettingsPane kicker="ABOUT CLOUDYI" title="关于依依工作台" description="桌面小助手与 CloudYi 工具箱共用一个本地优先的 Windows 客户端。">
              <SettingsSection title="版本信息">
                <SettingLine label="依依工作台" detail="当前应用版本"><strong className={styles.aboutValue}>v{packageInfo.version}</strong></SettingLine>
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
