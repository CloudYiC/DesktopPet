import { useEffect, useMemo, useRef, useState, type CSSProperties, type PointerEvent } from 'react';
import { requestDatabaseClose, requestDatabaseExecute, requestDatabasePick, requestDatabaseRefresh } from '../bridge/hostBridge';
import { ConfirmDialog } from '../components/ConfirmDialog';
import type { DatabaseObject, DatabaseOverview, DatabaseQueryResult } from '../types';
import type { ToolDefinition } from './catalog';
import { ToolWorkspaceHeader } from '../../../shared/tool-workspace/ToolWorkspaceHeader';
import { DatabaseSqlEditor } from './DatabaseSqlEditor';
import { quoteIdentifier, resultToTsv } from './databaseWorkbenchModel';
import styles from './DatabaseStudio.module.scss';

const INITIAL_SQL = "SELECT name, type, tbl_name\nFROM sqlite_master\nWHERE type IN ('table', 'view', 'index', 'trigger')\nORDER BY type, name;";
const GROUPS = [{ type: 'table', label: '表', icon: '▤' }, { type: 'view', label: '视图', icon: '▥' }, { type: 'index', label: '索引', icon: '◉' }, { type: 'trigger', label: '触发器', icon: 'ϟ' }] as const;
type WorkspaceTab = 'query' | 'structure' | 'ddl';
type DatabaseConfirmation = { kind: 'enable' | 'execute'; path: string; fileName: string; statement: string; generation: number };
const TABS = [{ id: 'query', label: 'SQL 查询' }, { id: 'structure', label: '表结构' }, { id: 'ddl', label: '建表语句' }] as const;
const objectKey = (object: DatabaseObject) => `${object.type}:${object.name}`;
const previewSql = (name: string) => `SELECT *\nFROM ${quoteIdentifier(name)}\nLIMIT 200;`;
function fileSize(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  return bytes < 1024 ** 2 ? `${(bytes / 1024).toFixed(1)} KB` : `${(bytes / 1024 ** 2).toFixed(1)} MB`;
}

/** Local SQLite workbench. A synchronous lock guards every native operation, including hotkeys. */
export function DatabaseStudio({ tool, onBack }: { tool: ToolDefinition; onBack(): void }) {
  const [overview, setOverview] = useState<DatabaseOverview | null>(null);
  const [selection, setSelection] = useState('');
  const [filter, setFilter] = useState('');
  const [expanded, setExpanded] = useState<Record<string, boolean>>({ table: true });
  const [schemaOpen, setSchemaOpen] = useState(true);
  const [infoOpen, setInfoOpen] = useState(false);
  const [tab, setTab] = useState<WorkspaceTab>('query');
  const [sql, setSql] = useState(INITIAL_SQL);
  const [result, setResult] = useState<DatabaseQueryResult | null>(null);
  const [resultView, setResultView] = useState<'rows' | 'info'>('rows');
  const [lastSql, setLastSql] = useState('');
  const [writeEnabled, setWriteEnabled] = useState(false);
  const [busy, setBusy] = useState(false);
  const [queryBusy, setQueryBusy] = useState(false);
  const [error, setError] = useState('');
  const [feedback, setFeedback] = useState('');
  const [split, setSplit] = useState(44);
  const [confirmation, setConfirmation] = useState<DatabaseConfirmation | null>(null);
  const [confirmationBusy, setConfirmationBusy] = useState(false);
  const pendingConfirmation = useRef<DatabaseConfirmation | null>(null);
  const operation = useRef({ active: false, generation: 0, mounted: true });
  const rightPane = useRef<HTMLDivElement>(null);
  const dragOrigin = useRef<{ y: number; value: number; height: number } | null>(null);
  const selected = overview?.objects.find((item) => objectKey(item) === selection) ?? null;
  const canPreview = selected?.type === 'table' || selected?.type === 'view';
  const sqlBytes = useMemo(() => new TextEncoder().encode(sql).length, [sql]);
  const sqlTooLarge = sqlBytes > 256 * 1024;
  const counts = useMemo(() => GROUPS.map((group) => ({ ...group, count: overview?.objects.filter((object) => object.type === group.type).length ?? 0 })), [overview]);
  const visible = useMemo(() => {
    const normalized = filter.trim().toLocaleLowerCase('zh-CN');
    return (overview?.objects ?? []).filter((object) => !normalized ||
      `${object.name} ${object.type} ${object.tableName} ${object.columns.map((column) => `${column.name} ${column.type}`).join(' ')}`.toLocaleLowerCase('zh-CN').includes(normalized));
  }, [overview, filter]);

  useEffect(() => {
    operation.current.mounted = true;
    return () => { operation.current.mounted = false; operation.current.generation += 1; };
  }, []);
  function begin() {
    if (operation.current.active) return null;
    operation.current.active = true;
    setBusy(true); setError(''); setFeedback('');
    return ++operation.current.generation;
  }
  function current(generation: number) { return operation.current.mounted && generation === operation.current.generation; }
  function finish(generation: number) {
    if (!current(generation)) return;
    operation.current.active = false; setBusy(false); setQueryBusy(false);
  }
  function fail(reason: unknown, fallback: string) {
    setError(reason instanceof Error ? reason.message : fallback);
    // File/refresh errors must remain visible even when an older result grid exists.
    setResultView('info');
  }
  function updateOverview(next: DatabaseOverview) {
    setOverview(next);
    setSelection((previous) => next.objects.some((item) => objectKey(item) === previous) ? previous : next.objects[0] ? objectKey(next.objects[0]) : '');
  }
  async function chooseDatabase(createNew: boolean) {
    const generation = begin(); if (generation === null) return;
    try {
      const response = await requestDatabasePick(createNew);
      if (!current(generation) || response.cancelled || !response.overview) return;
      const next = response.overview;
      setOverview(next); setSelection(next.objects[0] ? objectKey(next.objects[0]) : '');
      setSql(INITIAL_SQL); setLastSql(''); setResult(null); setWriteEnabled(false);
      setFilter(''); setExpanded({ table: true }); setTab('query'); setResultView('rows'); setInfoOpen(false);
    } catch (reason) { if (current(generation)) fail(reason, '数据库打开失败。'); }
    finally { finish(generation); }
  }
  async function refresh() {
    if (!overview) return;
    const generation = begin(); if (generation === null) return;
    try { const next = await requestDatabaseRefresh(); if (current(generation)) updateOverview(next); }
    catch (reason) { if (current(generation)) fail(reason, '数据库刷新失败。'); }
    finally { finish(generation); }
  }
  async function close() {
    const generation = begin(); if (generation === null) return;
    try {
      await requestDatabaseClose();
      if (current(generation)) { setOverview(null); setSelection(''); setResult(null); setLastSql(''); setWriteEnabled(false); setInfoOpen(false); }
    } catch (reason) { if (current(generation)) fail(reason, '数据库关闭失败。'); }
    finally { finish(generation); }
  }
  async function executeStatement(statement: string, allowWrite: boolean, generation: number) {
    try {
      setQueryBusy(true); setResult(null); setLastSql(statement); setResultView('rows'); setTab('query');
      const response = await requestDatabaseExecute(statement, allowWrite);
      if (!current(generation)) return;
      setResult(response.result);
      if (response.overview) updateOverview(response.overview);
    } catch (reason) { if (current(generation)) { setResult(null); fail(reason, 'SQL 执行失败。'); setResultView('info'); } }
    finally { finish(generation); }
  }
  function askConfirmation(kind: DatabaseConfirmation['kind'], generation: number, statement = '') {
    if (!overview) { finish(generation); return; }
    const next = { kind, path: overview.path, fileName: overview.fileName, statement, generation };
    pendingConfirmation.current = next;
    setConfirmation(next);
  }
  async function execute(statement = sql, preview = false) {
    if (!overview || !statement.trim() || operation.current.active) return;
    if (new TextEncoder().encode(statement).length > 256 * 1024) { fail(null, '单次 SQL 不能超过 256 KB，输入已保留，请缩小范围。'); return; }
    const generation = begin(); if (generation === null) return;
    // Hold the operation lock while reviewing: another database cannot replace the target.
    // Preview always takes the native read-only path, even if the editor allows writes.
    if (writeEnabled && !preview) { askConfirmation('execute', generation, statement); return; }
    await executeStatement(statement, false, generation);
  }
  function cancelConfirmation() {
    const pending = pendingConfirmation.current;
    if (!pending) return;
    pendingConfirmation.current = null;
    setConfirmation(null);
    finish(pending.generation);
  }
  async function approveConfirmation() {
    const pending = pendingConfirmation.current;
    if (!pending) return;
    // Consume this approval synchronously, before posting any native write request.
    pendingConfirmation.current = null;
    if (!current(pending.generation) || overview?.path !== pending.path) {
      setConfirmation(null);
      if (current(pending.generation)) fail(null, '数据库连接已变化，请重新检查后再操作。');
      finish(pending.generation);
      return;
    }
    if (pending.kind === 'enable') {
      setWriteEnabled(true); setConfirmation(null); finish(pending.generation);
      return;
    }
    setConfirmationBusy(true);
    try { await executeStatement(pending.statement, true, pending.generation); }
    finally {
      // Even an error consumes approval. A retry must open a new SQL review dialog.
      if (current(pending.generation)) { setConfirmation(null); setConfirmationBusy(false); }
    }
  }
  function chooseObject(object: DatabaseObject) {
    setSelection(objectKey(object));
    setExpanded((previous) => ({ ...previous, [objectKey(object)]: !previous[objectKey(object)] }));
    // Browsing objects must never replace the user's unfinished SQL.
  }
  function toggleReadOnly() {
    if (!overview || operation.current.active) return;
    if (writeEnabled) setWriteEnabled(false);
    else { const generation = begin(); if (generation !== null) askConfirmation('enable', generation); }
  }
  async function copy(text: string, label: string) {
    const generation = operation.current.generation;
    try { await navigator.clipboard.writeText(text); if (current(generation)) setFeedback(`${label}已复制`); }
    catch { if (current(generation)) setFeedback('复制失败，请检查剪贴板权限。'); }
  }
  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
        event.preventDefault();
        if (!event.repeat && tab === 'query') void execute();
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  });
  function startResize(event: PointerEvent<HTMLDivElement>) {
    if (event.button !== 0 || !rightPane.current) return;
    event.preventDefault(); event.currentTarget.setPointerCapture(event.pointerId);
    dragOrigin.current = { y: event.clientY, value: split, height: rightPane.current.clientHeight - 12 };
  }
  const resultStatus = queryBusy ? '执行中…' : error ? '操作失败' : result ? `执行成功 · ${result.rows.length} 行 · ${result.elapsedMilliseconds} ms` : '尚未执行';

  return <section className={styles.databaseStudio}>
    <ToolWorkspaceHeader title={tool.name} onBack={onBack} />
    <section className={styles.databaseToolbar} aria-label="数据库文件">
      <div className={styles.fileRow}>
        <div className={styles.fileIdentity}><i aria-hidden="true">▤</i><span><strong>{overview?.fileName ?? '尚未打开数据库'}</strong><small title={overview?.path}>{overview?.path ?? 'SQLite · 选择本机数据库文件'}</small></span></div>
        <div className={styles.fileActions}>
          {overview && <><button disabled={busy} onClick={() => void refresh()}>刷新结构</button><button disabled={busy} onClick={() => void close()}>关闭</button></>}
          <button disabled={busy} onClick={() => void chooseDatabase(false)}>打开数据库</button>
          <button disabled={busy} className={styles.primaryAction} onClick={() => void chooseDatabase(true)}>新建数据库</button>
        </div>
      </div>
      {overview && <div className={styles.metrics}>
        <div>{counts.map((group) => <span key={group.type}>{group.label} <b>{group.count}</b></span>)}</div>
        <span>{fileSize(overview.fileSizeBytes)} <button aria-expanded={infoOpen} onClick={() => setInfoOpen(!infoOpen)}>数据库信息 {infoOpen ? '⌃' : '⌄'}</button></span>
        {infoOpen && <div className={styles.databaseInfo}><span>页大小 {fileSize(overview.pageSize)}</span><span>页数 {overview.pageCount}</span><span>Journal {overview.journalMode}</span><span>user_version {overview.userVersion}</span></div>}
      </div>}
    </section>
    {!overview ? <div className={styles.databaseEmpty}>
      <i aria-hidden="true">▤</i><h3>选择一个 SQLite 数据库</h3><p>默认只读打开；需要写入时再单独确认。</p>
      <div className={styles.fileActions}><button disabled={busy} onClick={() => void chooseDatabase(false)}>选择现有数据库</button><button disabled={busy} onClick={() => void chooseDatabase(true)}>新建空数据库</button></div>
      {error && <p role="alert" className={styles.error}>{error}</p>}
    </div> : <div className={`${styles.databaseWorkspace} ${schemaOpen ? '' : styles.schemaCollapsed}`} data-testid="db-workspace">
      <aside className={styles.schemaPane} aria-label="数据库结构">
        <header><strong>{schemaOpen ? '数据库结构' : '结构'}</strong><button aria-label={schemaOpen ? '收起数据库结构' : '展开数据库结构'} aria-expanded={schemaOpen} onClick={() => setSchemaOpen(!schemaOpen)}>{schemaOpen ? '‹' : '›'}</button></header>
        {schemaOpen && <><label className={styles.search}><span aria-hidden="true">⌕</span><input aria-label="搜索表、字段" placeholder="搜索表、字段…" value={filter} onChange={(event) => setFilter(event.target.value)} /></label>
          <div className={styles.schemaScroll} data-testid="db-schema-scroll">
            {counts.map((group) => {
              const objects = visible.filter((object) => object.type === group.type);
              const open = !!filter.trim() || !!expanded[group.type];
              return <section key={group.type} className={styles.schemaGroup}>
                <button className={styles.groupButton} aria-expanded={open} onClick={() => setExpanded((previous) => ({ ...previous, [group.type]: !open }))}><span aria-hidden="true">{open ? '⌄' : '›'}　{group.icon}</span>{group.label}<small>{filter ? `${objects.length} / ` : ''}{group.count}</small></button>
                {open && objects.map((object) => <div key={objectKey(object)}>
                  <button className={`${styles.objectButton} ${selection === objectKey(object) ? styles.objectActive : ''}`} title={object.name} aria-label={`选择 ${object.name}`} aria-expanded={object.columns.length ? !!expanded[objectKey(object)] : undefined} onClick={() => chooseObject(object)}><span aria-hidden="true">{object.columns.length ? expanded[objectKey(object)] ? '⌄' : '›' : '·'}</span><i aria-hidden="true">{group.icon}</i><span>{object.name}</span></button>
                  {!!expanded[objectKey(object)] && object.columns.map((column) => <div className={styles.columnRow} key={column.name} title={`${column.name} · ${column.type || 'ANY'}${column.primaryKey ? ' · PRIMARY KEY' : ''}${column.notNull ? ' · NOT NULL' : ''}`}><i className={column.primaryKey ? styles.keyIcon : ''} aria-hidden="true">{column.primaryKey ? '⚿' : '▫'}</i><span>{column.name}</span><small>{column.type || 'ANY'}</small></div>)}
                </div>)}
              </section>;
            })}
            {!visible.length && <p className={styles.muted}>没有匹配的数据库对象。</p>}
          </div>
        </>}
      </aside>
      <div className={styles.queryPane}>
        <header className={styles.workspaceTabs}>
          <div role="tablist" aria-label="数据库工作区">{TABS.map((item) => <button key={item.id} role="tab" id={`db-tab-${item.id}`} aria-selected={tab === item.id} aria-controls="db-active-panel" onClick={() => setTab(item.id)}>{item.label}</button>)}</div>
          <div className={styles.selectedActions}><span title={selected?.name}>{selected?.name ?? '未选择对象'}</span>{canPreview && <button disabled={busy} onClick={() => selected && void execute(previewSql(selected.name), true)}>预览数据</button>}</div>
        </header>
        <div className={styles.activePanel} role="tabpanel" id="db-active-panel" aria-labelledby={`db-tab-${tab}`}>
          {tab === 'query' ? <div ref={rightPane} className={styles.querySplit} style={{ '--editor-share': `${split}%` } as CSSProperties}>
            <section className={styles.editorPane} aria-label="SQL 查询">
              <header className={styles.editorActions}>
                <button role="switch" aria-label="只读模式" aria-checked={!writeEnabled} disabled={busy} className={`${styles.writeSwitch} ${writeEnabled ? styles.writeActive : ''}`} onClick={toggleReadOnly}><span>{writeEnabled ? '允许写入' : '只读模式'}</span><i /></button>
                <div><button disabled={busy} onClick={() => setSql('')}>清空</button><button className={styles.primaryAction} disabled={busy || !sql.trim() || sqlTooLarge} onClick={() => void execute()}>{queryBusy ? '执行中…' : '▶ 运行 SQL'}<kbd>Ctrl Enter</kbd></button></div>
              </header>
              <DatabaseSqlEditor value={sql} onChange={setSql} disabled={busy} />
              <footer className={styles.editorFooter}><span className={writeEnabled || sqlTooLarge ? styles.warningText : ''}>{sqlTooLarge ? 'SQL 超过 256 KB，请缩小范围后运行。' : writeEnabled ? '允许写入 · 每次执行前确认，请先备份' : '只读保护已开启'}</span><span>{sqlBytes.toLocaleString()} B</span></footer>
            </section>
            <div className={styles.splitter} role="separator" aria-label="调整编辑区高度" aria-orientation="horizontal" aria-valuemin={30} aria-valuemax={65} aria-valuenow={split} tabIndex={0}
              onPointerDown={startResize} onPointerMove={(event) => { const origin = dragOrigin.current; if (origin) setSplit(Math.min(65, Math.max(30, origin.value + (event.clientY - origin.y) / origin.height * 100))); }}
              onPointerUp={(event) => { dragOrigin.current = null; if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId); }} onPointerCancel={() => { dragOrigin.current = null; }} onLostPointerCapture={() => { dragOrigin.current = null; }}
              onKeyDown={(event) => { if (['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) { event.preventDefault(); setSplit((value) => event.key === 'Home' ? 30 : event.key === 'End' ? 65 : Math.max(30, Math.min(65, value + (event.key === 'ArrowUp' ? -3 : 3)))); } }}><span aria-hidden="true">⠿</span></div>
            <section className={styles.queryResults} aria-label="执行结果">
              <header className={styles.resultHeader}>
                <div role="tablist" aria-label="结果视图"><button role="tab" aria-selected={resultView === 'rows'} onClick={() => setResultView('rows')}>查询结果</button><button role="tab" aria-selected={resultView === 'info'} onClick={() => setResultView('info')}>执行信息</button></div>
                <span className={error ? styles.errorText : result ? styles.successText : styles.muted} role="status">{resultStatus}</span>
                <button disabled={!result?.columns.length || busy} onClick={() => result && void copy(resultToTsv(result), '结果')}>复制结果</button>
              </header>
              {resultView === 'rows' && result?.columns.length ? <ResultGrid result={result} /> : <div className={styles.resultInfo} data-testid="db-result-scroll">
                {error ? <p role="alert" className={styles.error}>{error}</p> : queryBusy ? <p>正在执行查询，请稍候…</p> : !result ? <p>运行 SQL 或点击“预览数据”查看结果。</p> : <><strong>{result.message}</strong><dl><dt>执行语句</dt><dd>{result.statementCount} 条（多语句仅显示最后一条结果）</dd><dt>耗时</dt><dd>{result.elapsedMilliseconds} ms</dd><dt>影响行数</dt><dd>{result.affectedRows}</dd><dt>最后插入 ID</dt><dd>{result.lastInsertId || '—'}</dd><dt>执行方式</dt><dd>{result.wroteData ? '包含写入' : '只读查询'}</dd></dl></>}
                {resultView === 'info' && lastSql && <details><summary>本次执行的 SQL</summary><pre>{lastSql}</pre></details>}
              </div>}
              <footer className={styles.resultsFooter} data-testid="db-results-footer"><span>{feedback || (result ? `${result.rows.length} 行 · ${result.columns.length} 列` : '等待查询')}</span><span className={result?.truncated ? styles.warningText : ''}>{result?.truncated ? '已截断为前 500 行，请用 WHERE / LIMIT 筛选' : '最多返回 500 行'}</span></footer>
            </section>
          </div> : <section className={styles.objectDetail}>
            {error && <p role="alert" className={styles.error}>{error}</p>}
            {!selected ? <p>请从左侧选择一个数据库对象。</p> : tab === 'structure' ? <>
              <h3>{selected.name}</h3><p className={styles.muted}>{GROUPS.find((group) => group.type === selected.type)?.label} · {selected.columns.length} 列{selected.tableName && selected.tableName !== selected.name ? ` · 所属表 ${selected.tableName}` : ''}</p>
              {selected.columns.length ? <div className={styles.structureTable}><table><thead><tr><th>字段</th><th>类型</th><th>主键</th><th>非空</th><th>默认值</th></tr></thead><tbody>{selected.columns.map((column) => <tr key={column.name}><td>{column.name}</td><td>{column.type || 'ANY'}</td><td>{column.primaryKey ? '是' : '—'}</td><td>{column.notNull ? '是' : '—'}</td><td>{column.defaultValue || '—'}</td></tr>)}</tbody></table></div> : <p>此对象没有列信息，请切换“建表语句”查看定义。</p>}
            </> : <><header><h3>{selected.name}</h3><button disabled={!selected.sql} onClick={() => void copy(selected.sql, '创建语句')}>复制语句</button></header><pre className={styles.ddl}>{selected.sql || '此对象没有可显示的创建语句。'}</pre><p className={styles.muted}>只读展示对象的创建 SQL，不会自动执行。</p>{feedback && <p role="status">{feedback}</p>}</>}
          </section>}
        </div>
      </div>
    </div>}
    <ConfirmDialog open={confirmation !== null} title={confirmation?.kind === 'execute' ? '确认执行 SQL' : '启用数据库写入？'} confirmLabel={confirmation?.kind === 'execute' ? '确认执行' : '启用写入'} busy={confirmationBusy} size={confirmation?.kind === 'execute' ? 'wide' : 'normal'} onCancel={cancelConfirmation} onConfirm={() => void approveConfirmation()}>
      <dl><dt>数据库</dt><dd>{confirmation?.fileName}</dd><dt>位置</dt><dd>{confirmation?.path}</dd></dl>
      {confirmation?.kind === 'execute' ? <><p>请检查本次 SQL。写入、删除和结构变更可能无法撤销。</p><pre className={styles.confirmationSql} aria-label="待执行 SQL">{confirmation.statement}</pre></> : <p>启用后可执行 INSERT、UPDATE、DELETE 和结构变更；每次运行前仍需确认。请先备份重要数据。</p>}
    </ConfirmDialog>
  </section>;
}

/** Keep a bounded number of table rows mounted; scrolling never grows the outer page. */
function ResultGrid({ result }: { result: DatabaseQueryResult }) {
  const viewport = useRef<HTMLDivElement>(null);
  const [scroll, setScroll] = useState(0);
  const [height, setHeight] = useState(300);
  const [cell, setCell] = useState('');
  useEffect(() => { setScroll(0); setCell(''); if (viewport.current) viewport.current.scrollTop = 0; }, [result]);
  useEffect(() => {
    if (!viewport.current) return;
    const observer = new ResizeObserver(() => setHeight(viewport.current?.clientHeight ?? 300));
    observer.observe(viewport.current); return () => observer.disconnect();
  }, []);
  const start = Math.min(Math.max(0, result.rows.length - 1), Math.max(0, Math.floor((scroll - 32) / 32) - 6));
  const end = Math.min(result.rows.length, start + Math.ceil(height / 32) + 14);
  return <div ref={viewport} className={styles.resultTableWrap} data-testid="db-result-scroll" onScroll={(event) => setScroll(event.currentTarget.scrollTop)}>
    <table aria-label="查询数据"><thead><tr><th>#</th>{result.columns.map((column, index) => <th key={index}>{column || `column_${index + 1}`}</th>)}</tr></thead><tbody>
      {start > 0 && <tr className={styles.spacer} aria-hidden="true"><td colSpan={result.columns.length + 1} style={{ height: start * 32 }} /></tr>}
      {result.rows.slice(start, end).map((row, relative) => { const index = start + relative; return <tr key={index}><td>{index + 1}</td>{result.columns.map((_, column) => <td key={column} title={row[column] ?? 'NULL'} tabIndex={0} onFocus={() => setCell(`${index}:${column}`)} onClick={() => setCell(`${index}:${column}`)} className={`${row[column] === 'NULL' ? styles.nullCell : ''} ${cell === `${index}:${column}` ? styles.selectedCell : ''}`}>{row[column] ?? 'NULL'}</td>)}</tr>; })}
      {end < result.rows.length && <tr className={styles.spacer} aria-hidden="true"><td colSpan={result.columns.length + 1} style={{ height: (result.rows.length - end) * 32 }} /></tr>}
    </tbody></table>
  </div>;
}
