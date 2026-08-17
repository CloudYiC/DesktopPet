import { useEffect, useState, type CSSProperties } from 'react';
import type { CharacterLayout } from '../types';
import { READY_TOOL_COUNT, TOOL_CATEGORIES, type ToolCategoryId } from '../toolbox/catalog';
import type { DashboardView } from './types';
import styles from './AppSidebar.module.scss';

interface AppSidebarProps {
  activeView: DashboardView;
  activeCategory: ToolCategoryId | null;
  petName: string;
  petMood: string;
  petImageUrl: string;
  petLayout: CharacterLayout;
  todayCount: number;
  reminderCount: number;
  onViewChange(view: DashboardView): void;
  onToolboxChange(category: ToolCategoryId | null): void;
  onCreateDemoReminder(): void;
}

function readExpandedState(key: string, fallback: boolean) {
  try {
    const saved = window.localStorage.getItem(key);
    return saved === null ? fallback : saved === '1';
  } catch {
    return fallback;
  }
}

function rememberExpandedState(key: string, value: boolean) {
  try {
    window.localStorage.setItem(key, value ? '1' : '0');
  } catch {
    // A locked-down WebView profile can reject storage; navigation still works.
  }
}

/** Grouped navigation shared by CloudYi tools and the desktop-pet features. */
export function AppSidebar(props: AppSidebarProps) {
  const [toolsExpanded, setToolsExpanded] = useState(
    () => readExpandedState('yiyi.sidebar.tools', true),
  );
  const [petExpanded, setPetExpanded] = useState(
    () => readExpandedState('yiyi.sidebar.pet', true),
  );

  useEffect(() => {
    if (props.activeView === 'toolbox') setToolsExpanded(true);
    if (['today', 'all', 'status', 'settings'].includes(props.activeView)) {
      setPetExpanded(true);
    }
  }, [props.activeView]);

  const toggleTools = () => {
    setToolsExpanded((current) => {
      rememberExpandedState('yiyi.sidebar.tools', !current);
      return !current;
    });
  };
  const togglePet = () => {
    setPetExpanded((current) => {
      rememberExpandedState('yiyi.sidebar.pet', !current);
      return !current;
    });
  };
  const petImageStyle: CSSProperties = {
    backgroundImage: `url(${JSON.stringify(props.petImageUrl)})`,
  };

  return (
    <aside className={styles.sidebar}>
      <div className={styles.brand}>
        <div className={styles.brandMark}>依</div>
        <div><strong>依依工作台</strong><span>{props.petName} · CloudYi 工具箱</span></div>
      </div>

      <div className={styles.scrollArea}>
        <section className={styles.navGroup}>
          <button className={styles.groupHeading} type="button" aria-expanded={toolsExpanded} onClick={toggleTools}>
            <span>CloudYiCSC</span><em>{toolsExpanded ? '−' : '+'}</em>
          </button>
          {toolsExpanded && (
            <nav aria-label="CloudYi 工具箱">
              <button
                type="button"
                className={props.activeView === 'toolbox' && props.activeCategory === null ? styles.activeNav : undefined}
                onClick={() => props.onToolboxChange(null)}
              >
                <i>⌂</i><span>工具首页</span><small>{READY_TOOL_COUNT}</small>
              </button>
              {TOOL_CATEGORIES.map((category) => (
                <button
                  key={category.id}
                  type="button"
                  className={props.activeView === 'toolbox' && props.activeCategory === category.id ? styles.activeNav : undefined}
                  onClick={() => props.onToolboxChange(category.id)}
                >
                  <i>{category.glyph}</i><span>{category.shortLabel}</span>
                </button>
              ))}
            </nav>
          )}
        </section>

        <section className={styles.navGroup}>
          <button className={styles.groupHeading} type="button" aria-expanded={petExpanded} onClick={togglePet}>
            <span>{props.petName}</span><em>{petExpanded ? '−' : '+'}</em>
          </button>
          {petExpanded && (
            <>
              <nav aria-label="小助手功能">
                <PetNavButton glyph="⌁" label="今天" count={props.todayCount} active={props.activeView === 'today'} onClick={() => props.onViewChange('today')} />
                <PetNavButton glyph="◷" label="全部事项" count={props.reminderCount} active={props.activeView === 'all'} onClick={() => props.onViewChange('all')} />
                <PetNavButton glyph="✦" label={`${props.petName}状态`} active={props.activeView === 'status'} onClick={() => props.onViewChange('status')} />
                <PetNavButton glyph="⚙" label="设置" active={props.activeView === 'settings'} onClick={() => props.onViewChange('settings')} />
              </nav>
              <button className={styles.petCard} type="button" onClick={() => props.onViewChange('status')}>
                <i
                  className={props.petLayout === 'single' ? styles.singlePortrait : undefined}
                  style={petImageStyle}
                />
                <span><small>{props.petName}现在</small><strong>{props.petMood}</strong></span>
                <em />
              </button>
              <button className={styles.testReminder} type="button" onClick={props.onCreateDemoReminder}>10 秒后测试提醒</button>
            </>
          )}
        </section>
      </div>

      <div className={styles.sidebarBottom}>
        <button
          className={`${styles.storeButton} ${props.activeView === 'marketplace' ? styles.bottomActive : ''}`}
          type="button"
          onClick={() => props.onViewChange('marketplace')}
        >
          <i>◇</i><span><strong>插件商店</strong><small>扩展本地工具</small></span><em>›</em>
        </button>
        <button
          className={`${styles.profileButton} ${props.activeView === 'account' ? styles.bottomActive : ''}`}
          type="button"
          onClick={() => props.onViewChange('account')}
        >
          <i>依</i><span><strong>CloudYi 中心</strong><small>账户、主题与本机设置</small></span><em>›</em>
        </button>
      </div>
    </aside>
  );
}

interface PetNavButtonProps {
  glyph: string;
  label: string;
  count?: number;
  active: boolean;
  onClick(): void;
}

function PetNavButton({ glyph, label, count, active, onClick }: PetNavButtonProps) {
  return (
    <button type="button" className={active ? styles.activeNav : undefined} onClick={onClick}>
      <i>{glyph}</i><span>{label}</span>{count !== undefined && <small>{count}</small>}
    </button>
  );
}
