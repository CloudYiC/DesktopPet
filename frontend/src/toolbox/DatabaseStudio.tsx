import { useEffect, useMemo, useState } from 'react';
import {
  requestDatabaseClose,
  requestDatabaseExecute,
  requestDatabasePick,
  requestDatabaseRefresh,
} from '../bridge/hostBridge';
import type {
  DatabaseObject,
  DatabaseOverview,
  DatabaseQueryResult,
} from '../types';
import type { ToolDefinition } from './catalog';
import styles from './DatabaseStudio.module.scss';

interface DatabaseStudioProps {
  tool: ToolDefinition;
  onBack(): void;
}

const initialSql = `SELECT name, type, tbl_name
FROM sqlite_master
WHERE type IN ('table', 'view', 'index', 'trigger')
ORDER BY type, name;`;

function quoteIdentifier(value: string) {
  return `"${value.replace(/"/g, '""')}"`;
}

function formatFileSize(bytes: number) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value >= 100 ? value.toFixed(0) : value.toFixed(1)} ${units[unit]}`;
}

function objectTypeLabel(type: DatabaseObject['type']) {
  if (type === 'table') return 'TABLE';
  if (type === 'view') return 'VIEW';
  if (type === 'index') return 'INDEX';
  return 'TRIGGER';
}

/** Full SQLite workspace backed by the native C API and C++11 permission gate. */
export function DatabaseStudio({ tool, onBack }: DatabaseStudioProps) {
  const [overview, setOverview] = useState<DatabaseOverview | null>(null);
  const [selectedName, setSelectedName] = useState('');
  const [filter, setFilter] = useState('');
  const [sql, setSql] = useState(initialSql);
  const [result, setResult] = useState<DatabaseQueryResult | null>(null);
  const [writeEnabled, setWriteEnabled] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const selectedObject = overview?.objects.find((item) => item.name === selectedName) ?? null;
  const visibleObjects = useMemo(() => {
    const normalized = filter.trim().toLocaleLowerCase('zh-CN');
    if (!overview || !normalized) return overview?.objects ?? [];
    return overview.objects.filter((object) =>
      `${object.name} ${object.type} ${object.tableName} ${object.columns.map((column) => `${column.name} ${column.type}`).join(' ')}`
        .toLocaleLowerCase('zh-CN')
        .includes(normalized),
    );
  }, [filter, overview]);
  const counts = useMemo(() => ({
    table: overview?.objects.filter((object) => object.type === 'table').length ?? 0,
    view: overview?.objects.filter((object) => object.type === 'view').length ?? 0,
    index: overview?.objects.filter((object) => object.type === 'index').length ?? 0,
    trigger: overview?.objects.filter((object) => object.type === 'trigger').length ?? 0,
  }), [overview]);

  const chooseDatabase = async (createNew: boolean) => {
    setBusy(true);
    setError('');
    try {
      const picked = await requestDatabasePick(createNew);
      if (picked.cancelled || !picked.overview) return;
      setOverview(picked.overview);
      setSelectedName(picked.overview.objects[0]?.name ?? '');
      setSql(initialSql);
      setResult(null);
      setWriteEnabled(false);
    } catch (pickError) {
      setError(pickError instanceof Error ? pickError.message : '数据库打开失败。');
    } finally {
      setBusy(false);
    }
  };

  const refresh = async () => {
    if (!overview) return;
    setBusy(true);
    setError('');
    try {
      const next = await requestDatabaseRefresh();
      setOverview(next);
      if (!next.objects.some((object) => object.name === selectedName)) {
        setSelectedName(next.objects[0]?.name ?? '');
      }
    } catch (refreshError) {
      setError(refreshError instanceof Error ? refreshError.message : '数据库刷新失败。');
    } finally {
      setBusy(false);
    }
  };

  const close = async () => {
    await requestDatabaseClose();
    setOverview(null);
    setSelectedName('');
    setResult(null);
    setWriteEnabled(false);
    setError('');
  };

  const execute = async (statement = sql) => {
    if (!overview || !statement.trim()) return;
    if (writeEnabled && !window.confirm(
      '当前已启用数据库写入。确定执行这段 SQL 吗？\n\n写入、删除和结构变更可能无法撤销，请确认已经备份重要数据。',
    )) return;
    setBusy(true);
    setError('');
    try {
      const response = await requestDatabaseExecute(statement, writeEnabled);
      setResult(response.result);
      if (response.overview) {
        setOverview(response.overview);
        if (!response.overview.objects.some((object) => object.name === selectedName)) {
          setSelectedName(response.overview.objects[0]?.name ?? '');
        }
      }
    } catch (executeError) {
      setResult(null);
      setError(executeError instanceof Error ? executeError.message : 'SQL 执行失败。');
    } finally {
      setBusy(false);
    }
  };

  const chooseObject = (object: DatabaseObject) => {
    setSelectedName(object.name);
    if (object.type === 'table' || object.type === 'view') {
      setSql(`SELECT *\nFROM ${quoteIdentifier(object.name)}\nLIMIT 200;`);
    }
  };

  useEffect(() => {
    const runWithKeyboard = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
        event.preventDefault();
        void execute();
      }
    };
    window.addEventListener('keydown', runWithKeyboard);
    return () => window.removeEventListener('keydown', runWithKeyboard);
  });

  return (
    <section className={styles.databaseStudio}>
      <header className={styles.workspaceHeader}>
        <button type="button" onClick={onBack}>← 返回工具列表</button>
        <div>
          <i>{tool.glyph}</i>
          <span><small>SQLITE C API · LOCAL FILE</small><strong>{tool.name}</strong><em>{tool.description}</em></span>
        </div>
      </header>

      <div className={styles.databaseToolbar}>
        <div className={styles.fileIdentity}>
          <i>DB</i>
          <span>
            <strong>{overview?.fileName ?? '尚未打开数据库'}</strong>
            <small title={overview?.path}>{overview?.path ?? '通过 Windows 文件选择器连接本机 SQLite 文件'}</small>
          </span>
        </div>
        <div className={styles.fileActions}>
          {overview && <button type="button" disabled={busy} onClick={() => void refresh()}>刷新结构</button>}
          {overview && <button type="button" disabled={busy} onClick={() => void close()}>关闭</button>}
          <button type="button" disabled={busy} onClick={() => void chooseDatabase(false)}>打开数据库</button>
          <button type="button" className={styles.primaryAction} disabled={busy} onClick={() => void chooseDatabase(true)}>新建数据库</button>
        </div>
      </div>

      {error && <p className={styles.databaseError}>{error}</p>}

      {!overview ? (
        <div className={styles.databaseEmpty}>
          <i>◉</i>
          <span>LOCAL SQLITE WORKSPACE</span>
          <h3>打开一个数据库，开始查看结构和运行 SQL。</h3>
          <p>文件仅由本机 SQLite C 引擎读取；默认只读，写入操作必须先单独授权。</p>
          <div><button type="button" onClick={() => void chooseDatabase(false)}>选择现有数据库</button><button type="button" onClick={() => void chooseDatabase(true)}>新建空数据库</button></div>
        </div>
      ) : (
        <>
          <div className={styles.databaseMetrics}>
            <Metric label="Tables" value={counts.table} />
            <Metric label="Views" value={counts.view} />
            <Metric label="Indexes" value={counts.index} />
            <Metric label="Triggers" value={counts.trigger} />
            <Metric label="Page size" value={formatFileSize(overview.pageSize)} />
            <Metric label="File size" value={formatFileSize(overview.fileSizeBytes)} />
          </div>

          <div className={styles.databaseWorkspace}>
            <aside className={styles.schemaPane}>
              <header><span>SCHEMA OBJECTS</span><strong>数据库结构</strong><small>Journal: {overview.journalMode || 'unknown'} · user_version {overview.userVersion}</small></header>
              <label><span>⌕</span><input value={filter} onChange={(event) => setFilter(event.target.value)} placeholder="筛选表、列或类型…" /></label>
              <div className={styles.objectList}>
                {visibleObjects.map((object) => (
                  <button key={`${object.type}-${object.name}`} type="button" className={selectedName === object.name ? styles.objectActive : undefined} onClick={() => chooseObject(object)}>
                    <i>{object.type === 'table' ? 'T' : object.type === 'view' ? 'V' : object.type === 'index' ? 'I' : '⚡'}</i>
                    <span><strong>{object.name}</strong><small>{objectTypeLabel(object.type)}{object.columns.length ? ` · ${object.columns.length} 列` : object.tableName ? ` · ${object.tableName}` : ''}</small></span>
                  </button>
                ))}
                {!visibleObjects.length && <p>当前数据库还没有可显示的对象。</p>}
              </div>
            </aside>

            <main className={styles.queryPane}>
              {selectedObject && (
                <section className={styles.objectDetail}>
                  <header><span><small>{objectTypeLabel(selectedObject.type)}</small><strong>{selectedObject.name}</strong></span>{(selectedObject.type === 'table' || selectedObject.type === 'view') && <button type="button" disabled={busy} onClick={() => void execute(`SELECT * FROM ${quoteIdentifier(selectedObject.name)} LIMIT 200;`)}>预览数据</button>}</header>
                  {selectedObject.columns.length > 0 && <div className={styles.columnChips}>{selectedObject.columns.map((column) => <span key={column.name}><strong>{column.name}</strong><small>{column.type || 'ANY'}{column.primaryKey ? ' · PK' : ''}{column.notNull ? ' · NOT NULL' : ''}</small></span>)}</div>}
                  {selectedObject.sql && <code>{selectedObject.sql}</code>}
                </section>
              )}

              <section className={styles.sqlEditor}>
                <header>
                  <div><span>SQL EDITOR</span><strong>查询编辑器</strong></div>
                  <div className={styles.editorActions}>
                    <button type="button" className={`${styles.writeSwitch} ${writeEnabled ? styles.writeActive : ''}`} role="switch" aria-checked={writeEnabled} onClick={() => {
                      if (writeEnabled) setWriteEnabled(false);
                      else if (window.confirm('启用写入后，数据库工作室可以执行 INSERT、UPDATE、DELETE 和结构变更。是否继续？')) setWriteEnabled(true);
                    }}><i /><span>{writeEnabled ? '允许写入' : '只读模式'}</span></button>
                    <button type="button" onClick={() => setSql('')}>清空</button>
                    <button type="button" className={styles.runButton} disabled={busy || !sql.trim()} onClick={() => void execute()}>{busy ? '执行中…' : '运行 SQL'}</button>
                  </div>
                </header>
                <textarea value={sql} onChange={(event) => setSql(event.target.value)} spellCheck={false} aria-label="SQL 编辑器" />
                <footer><span>Ctrl + Enter 运行</span><span>{writeEnabled ? '写入操作仍会在执行前二次确认' : '原生层将拒绝所有非只读语句'}</span></footer>
              </section>

              <QueryResults result={result} />
            </main>
          </div>
        </>
      )}
    </section>
  );
}

function Metric({ label, value }: { label: string; value: string | number }) {
  return <article><span>{label}</span><strong>{value}</strong></article>;
}

function QueryResults({ result }: { result: DatabaseQueryResult | null }) {
  return (
    <section className={styles.queryResults}>
      <header>
        <div><span>QUERY RESULT</span><strong>执行结果</strong></div>
        {result && <p>{result.message} · {result.statementCount} 条语句 · {result.elapsedMilliseconds} ms</p>}
      </header>
      {!result ? (
        <div className={styles.resultEmpty}>运行查询后，列名、数据行和执行信息会显示在这里。</div>
      ) : result.columns.length ? (
        <div className={styles.resultTableWrap}>
          <table><thead><tr><th>#</th>{result.columns.map((column, index) => <th key={`${column}-${index}`}>{column || `column_${index + 1}`}</th>)}</tr></thead><tbody>{result.rows.map((row, rowIndex) => <tr key={rowIndex}><td>{rowIndex + 1}</td>{result.columns.map((_, columnIndex) => <td key={columnIndex} title={row[columnIndex]} className={row[columnIndex] === 'NULL' ? styles.nullCell : undefined}>{row[columnIndex] ?? 'NULL'}</td>)}</tr>)}</tbody></table>
          {result.truncated && <p>只显示前 500 行，请在 SQL 中增加 WHERE 或 LIMIT。</p>}
        </div>
      ) : (
        <div className={styles.changeResult}><i>✓</i><strong>{result.message}</strong><span>Last insert rowid: {result.lastInsertId || '—'}</span></div>
      )}
    </section>
  );
}
