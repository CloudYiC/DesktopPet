import { useMemo, useRef, useState } from 'react';
import { ToolWorkspaceHeader } from '../../../shared/tool-workspace/ToolWorkspaceHeader';
import { compareTexts, type DiffLine, type DiffResult } from './textDiffModel';
import styles from './TextDiffWorkspace.module.scss';

const SAMPLE_LEFT = '云依助手\n日志级别：info\n\n服务地址：127.0.0.1\n服务端口：8000\n提醒事项\n旧版调试日志\n\n桌面互动：开启';
const SAMPLE_RIGHT = '云依助手\n日志级别：debug\n\n服务地址：127.0.0.1\n服务端口：9000\n提醒事项\n\n桌面互动：开启\n自动重连：开启';
const MAX_CHARACTERS = 200_000;
const MAX_LINES = 3000;

function lineCount(text: string) {
  return text ? text.split(/\r\n|\r|\n/).length : 0;
}

/** A read-only, aligned comparison. Editing never silently changes the other side. */
export function TextDiffWorkspace({ onBack }: { onBack(): void }) {
  const [left, setLeft] = useState(SAMPLE_LEFT);
  const [right, setRight] = useState(SAMPLE_RIGHT);
  const [ignoreWhitespace, setIgnoreWhitespace] = useState(false);
  const [snapshot, setSnapshot] = useState({ left: SAMPLE_LEFT, right: SAMPLE_RIGHT, ignoreWhitespace: false });
  const [result, setResult] = useState<DiffResult>(() => compareTexts(SAMPLE_LEFT, SAMPLE_RIGHT));
  const [onlyChanges, setOnlyChanges] = useState(false);
  const [inputOpen, setInputOpen] = useState(true);
  const [activeGroup, setActiveGroup] = useState(0);
  const [feedback, setFeedback] = useState('');
  const [error, setError] = useState('');
  const scrollArea = useRef<HTMLDivElement>(null);
  const dirty = left !== snapshot.left || right !== snapshot.right || ignoreWhitespace !== snapshot.ignoreWhitespace;
  const selectedGroup = result.groups[activeGroup];

  const visibleRows = useMemo(() => {
    const items: ({ index: number } | { skipped: number; key: number })[] = [];
    let skipped = 0;
    result.rows.forEach((row, index) => {
      if (onlyChanges && row.kind === 'same') { skipped += 1; return; }
      if (skipped) { items.push({ skipped, key: index }); skipped = 0; }
      items.push({ index });
    });
    if (skipped) items.push({ skipped, key: result.rows.length });
    return items;
  }, [result, onlyChanges]);

  function compare(nextLeft = left, nextRight = right, nextIgnore = ignoreWhitespace) {
    setFeedback('');
    if ([nextLeft, nextRight].some((text) => text.length > MAX_CHARACTERS || lineCount(text) > MAX_LINES)) {
      setError('单侧最多比较 3,000 行、200,000 个 UTF-16 字符。请缩小文本范围后重试，输入不会被截断。');
      return;
    }
    setError('');
    setResult(compareTexts(nextLeft, nextRight, { ignoreWhitespace: nextIgnore }));
    setSnapshot({ left: nextLeft, right: nextRight, ignoreWhitespace: nextIgnore });
    setActiveGroup(0);
    scrollArea.current?.scrollTo({ top: 0 });
  }

  function navigate(direction: number) {
    if (!result.groups.length || dirty) return;
    const index = (activeGroup + direction + result.groups.length) % result.groups.length;
    setActiveGroup(index);
    const viewport = scrollArea.current;
    const row = viewport?.querySelector<HTMLElement>(`[data-diff-row="${result.groups[index].startRow}"]`);
    // Scroll just the result viewport, never the surrounding workbench or its editors.
    if (viewport && row) viewport.scrollTop += row.getBoundingClientRect().top - viewport.getBoundingClientRect().top - 12;
  }

  async function copyDiff() {
    const lines = ['--- 原始文本', '+++ 修改后文本'];
    result.rows.forEach((row) => {
      if (row.kind === 'same') lines.push(`  ${row.left?.text ?? ''}`);
      else {
        if (row.left) lines.push(`- ${row.left.text}`);
        if (row.right) lines.push(`+ ${row.right.text}`);
      }
    });
    try {
      await navigator.clipboard.writeText(lines.join('\n'));
      setFeedback('差异已复制');
    } catch { setFeedback('无法访问剪贴板，请在对照区选择文字后复制。'); }
  }

  return (
    <section className={styles.workspace} onKeyDown={(event) => {
      if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') { event.preventDefault(); compare(); }
    }}>
      <ToolWorkspaceHeader title="文本比较" onBack={onBack} />

      <section className={styles.inputPanel} aria-label="比较文本输入">
        <div className={styles.inputToolbar}>
          <strong>比较文本</strong>
          <div className={styles.actions}>
            <button type="button" onClick={() => { setLeft(right); setRight(left); compare(right, left); }}>交换文本</button>
            <button type="button" onClick={() => { setLeft(SAMPLE_LEFT); setRight(SAMPLE_RIGHT); compare(SAMPLE_LEFT, SAMPLE_RIGHT); }}>载入示例</button>
            <button type="button" onClick={() => { setLeft(''); setRight(''); compare('', ''); }}>清空文本</button>
            <button type="button" aria-expanded={inputOpen} onClick={() => setInputOpen(!inputOpen)}>{inputOpen ? '收起输入' : '展开输入'} <span aria-hidden="true">{inputOpen ? '⌃' : '⌄'}</span></button>
          </div>
        </div>
        {inputOpen && <div className={styles.editors}>
          <label>
            <span><strong><i className={styles.beforeDot} />原始文本</strong><small>{lineCount(left).toLocaleString()} 行</small></span>
            <textarea aria-label="原始文本" wrap="off" value={left} onChange={(event) => { setLeft(event.target.value); setFeedback(''); }} placeholder="粘贴原始文本…" spellCheck={false} />
          </label>
          <label>
            <span><strong><i className={styles.afterDot} />修改后文本</strong><small>{lineCount(right).toLocaleString()} 行</small></span>
            <textarea aria-label="修改后文本" wrap="off" value={right} onChange={(event) => { setRight(event.target.value); setFeedback(''); }} placeholder="粘贴修改后文本…" spellCheck={false} />
          </label>
        </div>}
        <div className={styles.compareToolbar}>
          <label className={styles.check}><input type="checkbox" checked={ignoreWhitespace} onChange={(event) => setIgnoreWhitespace(event.target.checked)} />忽略行首尾空白</label>
          <span className={styles.keyboardHint}>Ctrl + Enter</span>
          <button className={styles.primaryButton} type="button" onClick={() => compare()}>开始比较</button>
        </div>
      </section>

      {error && <p role="alert" className={styles.error}>{error}</p>}
      {dirty && <p role="status" className={styles.pending}>输入已修改，请重新比较。下方为上次比较结果。</p>}
      {!dirty && result.notice && <p role="status" className={styles.pending}>{result.notice}</p>}

      <section className={styles.resultPanel} aria-label="文本比较结果">
        <div className={styles.resultToolbar}>
          <div className={styles.summary}>
            <h3>差异对照</h3>
            <output aria-label="差异统计" className={styles.stats}>
              <span className={styles.addBadge}>+ 新增 {result.stats.added}</span>
              <span className={styles.removeBadge}>− 删除 {result.stats.removed}</span>
              <span className={styles.changeBadge}>~ 修改 {result.stats.modified}</span>
            </output>
          </div>
          <div className={styles.actions}>
            <label className={styles.check}><input type="checkbox" checked={onlyChanges} onChange={(event) => { setOnlyChanges(event.target.checked); scrollArea.current?.scrollTo({ top: 0 }); }} />只看差异</label>
            <button type="button" disabled={dirty || !result.rows.length} onClick={() => void copyDiff()}>复制差异</button>
          </div>
        </div>
        <div className={styles.resultSubbar}>
          <span>{result.identical ? (snapshot.ignoreWhitespace ? '忽略行首尾空白后相同' : '两侧文本内容相同') : `${result.groups.length} 处差异 · ${result.stats.unchanged} 行未变`}</span>
          <div className={styles.navigation}>
            <button type="button" aria-label="上一处差异" title="上一处差异" disabled={dirty || !result.groups.length} onClick={() => navigate(-1)}>↑</button>
            <output aria-label="差异位置">{result.groups.length ? `${activeGroup + 1} / ${result.groups.length}` : '0 / 0'}</output>
            <button type="button" aria-label="下一处差异" title="下一处差异" disabled={dirty || !result.groups.length} onClick={() => navigate(1)}>↓</button>
          </div>
        </div>
        <div className={styles.columnHeads} aria-hidden="true">
          <div><i className={styles.beforeDot} />原始文本 <small>删除 / 修改前</small></div>
          <div><i className={styles.afterDot} />修改后文本 <small>新增 / 修改后</small></div>
        </div>
        <div ref={scrollArea} className={styles.diffScroll} role="region" aria-label="文本对照结果" tabIndex={0} data-testid="diff-scroll">
          {!result.rows.length ? <div className={styles.empty}><strong>还没有需要比较的文本</strong><span>在上方粘贴两段文本，或载入示例。</span></div> : visibleRows.map((item) => {
            if ('skipped' in item) return <div className={styles.skipped} key={`skip-${item.key}`}>··· 已隐藏 {item.skipped} 行相同内容 ···</div>;
            const row = result.rows[item.index];
            const active = selectedGroup && item.index >= selectedGroup.startRow && item.index <= selectedGroup.endRow;
            return <div key={item.index} className={`${styles.diffRow} ${active ? styles.activeRow : ''}`} data-diff-row={item.index} data-kind={row.kind}>
              <DiffCell line={row.left} side="left" changed={row.kind !== 'same'} />
              <DiffCell line={row.right} side="right" changed={row.kind !== 'same'} />
            </div>;
          })}
        </div>
        <footer className={styles.resultFooter}>
          <span>深色块定位改动文字 · 斜纹为对齐占位 · 换行符统一比较</span>
          <span role="status">{feedback || '仅在本机比较'}</span>
        </footer>
      </section>
    </section>
  );
}

function DiffCell({ line, side, changed }: { line: DiffLine | null; side: 'left' | 'right'; changed: boolean }) {
  const sign = changed && line ? (side === 'left' ? '−' : '+') : '';
  return <div data-side={side} className={`${styles.diffCell} ${!line ? styles.missing : changed ? (side === 'left' ? styles.removed : styles.added) : ''}`}>
    <span className={styles.lineNumber} aria-label={line ? `第 ${line.lineNumber} 行` : '无对应行'}>{line?.lineNumber ?? ''}</span>
    <span className={styles.sign} aria-label={sign ? (side === 'left' ? '删除或修改前' : '新增或修改后') : undefined}>{sign}</span>
    <code>{line && (line.text === '' ? <span className={styles.emptyLine}>空行</span> : line.segments.map((segment, index) => segment.changed ? <mark key={index}>{segment.text}</mark> : <span key={index}>{segment.text}</span>))}</code>
  </div>;
}
