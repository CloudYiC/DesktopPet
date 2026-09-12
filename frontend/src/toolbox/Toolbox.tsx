import { useEffect, useMemo, useRef, useState } from 'react';
import {
  categoryById,
  READY_TOOL_COUNT,
  TOOL_CATEGORIES,
  TOOL_DEFINITIONS,
  type ToolCategoryId,
  toolsForCategory,
} from './catalog';
import styles from './Toolbox.module.scss';
import { DatabaseStudio } from './DatabaseStudio';
import { ImageToolbox } from './ImageToolbox';
import { SoftwareUninstaller } from './SoftwareUninstaller';
import { PacketInspector } from './PacketInspector';
import { NetworkDebugger } from './NetworkDebugger';
import { SerialDebugger } from './SerialDebugger';
import { MqttDebugger } from './MqttDebugger';
import { ModbusDebugger } from './ModbusDebugger';
import { TextDiffWorkspace } from './TextDiffWorkspace';
import { UtilityCodecWorkspace } from './UtilityCodecWorkspace';
import { UtilitySpecializedWorkspace } from './UtilitySpecializedWorkspace';
import { RegexWorkspace } from './RegexWorkspace';
import { SystemCenterWorkspace } from './SystemCenterWorkspace';
import { PortManagerWorkspace } from './PortManagerWorkspace';

interface ToolboxProps {
  category: ToolCategoryId | null;
  onOpenCategory(category: ToolCategoryId): void;
  onWorkspaceChange(): void;
}

/** CloudYi tool catalog and workbench embedded in the pet dashboard. */
export function Toolbox({ category, onOpenCategory, onWorkspaceChange }: ToolboxProps) {
  const [activeToolId, setActiveToolId] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const searchInput = useRef<HTMLInputElement>(null);
  const activeTool = TOOL_DEFINITIONS.find((tool) => tool.id === activeToolId) ?? null;
  const selectedCategory = categoryById(category);
  const visibleTools = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase('zh-CN');
    return toolsForCategory(category).filter((tool) => {
      return !normalized || `${tool.name} ${tool.shortName} ${tool.description}`
        .toLocaleLowerCase('zh-CN')
        .includes(normalized);
    });
  }, [category, query]);

  useEffect(() => {
    if (activeTool && category && activeTool.category !== category) {
      setActiveToolId(null);
    }
  }, [activeTool, category]);

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
    if (activeTool.id === 'network-debugger') {
      return <NetworkDebugger tool={activeTool} onBack={() => setActiveToolId(null)} />;
    }
    if (activeTool.id === 'serial-debugger') {
      return <SerialDebugger tool={activeTool} onBack={() => setActiveToolId(null)} />;
    }
    if (activeTool.id === 'mqtt-debugger') {
      return <MqttDebugger tool={activeTool} onBack={() => setActiveToolId(null)} />;
    }
    if (activeTool.id === 'modbus-debugger') {
      return <ModbusDebugger tool={activeTool} onBack={() => setActiveToolId(null)} />;
    }
    if (activeTool.id === 'diff') {
      return <TextDiffWorkspace onBack={() => setActiveToolId(null)} />;
    }
    if (activeTool.id === 'regex') {
      return <RegexWorkspace key={activeTool.id} onBack={() => setActiveToolId(null)} />;
    }
    if (['timestamp', 'uuid', 'password'].includes(activeTool.id)) {
      return <UtilitySpecializedWorkspace key={activeTool.id} tool={activeTool} onBack={() => setActiveToolId(null)} />;
    }
    return <UtilityCodecWorkspace key={activeTool.id} tool={activeTool} onBack={() => setActiveToolId(null)} />;
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
      </div>

      {!selectedCategory && (
        <div className={styles.catalogHeading}>
          <div><span>TOOL CATALOG</span><h2>全部工具</h2><p>所有内置工具均可直接打开使用。</p></div>
        </div>
      )}

      <div className={styles.toolGrid}>
        {visibleTools.map((tool) => {
          return (
            <article key={tool.id}>
              <div className={styles.toolGlyph}>{tool.glyph}</div>
              <div className={styles.toolCopy}>
                <h3>{tool.name}</h3>
                <p>{tool.description}</p>
              </div>
              <footer className={styles.toolActions}>
                <button
                  type="button"
                  onClick={() => setActiveToolId(tool.id)}
                >
                  打开
                </button>
              </footer>
            </article>
          );
        })}
        {!visibleTools.length && <p className={styles.emptyCatalog}>没有符合当前搜索的工具。</p>}
      </div>
    </section>
  );
}
