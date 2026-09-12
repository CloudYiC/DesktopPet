import { Fragment, useEffect, useRef, useState } from 'react';
import { ToolWorkspaceHeader } from '../../../shared/tool-workspace/ToolWorkspaceHeader';
import { validateRegexInput, type RegexInput, type RegexResult } from './regexModel';
import type { RegexWorkerReply } from './regex.worker';
import styles from './RegexWorkspace.module.scss';

const SAMPLE: RegexInput = { pattern: '(?<name>云依|依依)', flags: 'g', text: '云依助手，让工作更轻松。\n今天也和依依一起加油！\n云依工具箱 · 全部在本地处理' };
const FLAGS = [['g', '全局匹配'], ['i', '忽略大小写'], ['m', '多行锚点'], ['s', '点匹配换行'], ['u', 'Unicode'], ['y', '粘连匹配']];
const keyFor = (input: RegexInput) => JSON.stringify(input);

/** Isolated workers can be terminated even while a pathological expression is backtracking. */
export function RegexWorkspace({ onBack }: { onBack(): void }) {
  const [input, setInput] = useState<RegexInput>(SAMPLE);
  const [snapshot, setSnapshot] = useState<{ key: string; input: RegexInput; result: RegexResult } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [feedback, setFeedback] = useState('');
  const [view, setView] = useState<'edit' | 'highlight'>('edit');
  const [selected, setSelected] = useState(-1);
  const worker = useRef<Worker | null>(null);
  const timeout = useRef<ReturnType<typeof setTimeout> | null>(null);
  const sequence = useRef(0);
  const preview = useRef<HTMLPreElement>(null);
  const currentKey = keyFor(input);
  const latestKey = useRef(currentKey);
  latestKey.current = currentKey;
  const dirty = !!snapshot && snapshot.key !== currentKey;
  const current = snapshot && !dirty ? snapshot.result : null;

  function cancelWorker() {
    sequence.current += 1;
    worker.current?.terminate();
    worker.current = null;
    if (timeout.current !== null) clearTimeout(timeout.current);
    timeout.current = null;
  }
  useEffect(() => () => cancelWorker(), []);

  function change(next: RegexInput) {
    cancelWorker();
    setBusy(false); setInput(next); setError(''); setFeedback(''); setView('edit'); setSelected(-1);
  }

  function run() {
    cancelWorker();
    setError(''); setFeedback(''); setBusy(false); setSelected(-1);
    const invalid = validateRegexInput(input);
    if (invalid) { setError(invalid); return; }
    const id = sequence.current;
    const requestedKey = currentKey;
    try {
      const active = new Worker(new URL('./regex.worker.ts', import.meta.url), { type: 'module' });
      worker.current = active;
      setBusy(true);
      const fail = (message: string) => {
        if (id !== sequence.current) return;
        cancelWorker(); setBusy(false); setError(message); setSnapshot(null);
      };
      timeout.current = setTimeout(() => fail('匹配超过 2.5 秒，已安全停止。请简化表达式或缩小文本范围后重试。'), 2500);
      active.onerror = () => fail('匹配任务执行失败，请检查表达式后重试。');
      active.onmessage = ({ data }: MessageEvent<RegexWorkerReply>) => {
        if (id !== sequence.current || data.id !== id || latestKey.current !== requestedKey) return;
        if ('error' in data) { fail(`表达式无效：${data.error}`); return; }
        cancelWorker(); setBusy(false);
        setSnapshot({ key: requestedKey, input: { ...input }, result: data.result });
      };
      active.postMessage({ id, input });
    } catch { cancelWorker(); setBusy(false); setError('无法启动本地匹配任务，请重试。'); setSnapshot(null); }
  }

  function selectMatch(index: number) {
    setSelected(index); setView('highlight');
  }
  useEffect(() => {
    const container = preview.current;
    const match = container?.querySelector<HTMLElement>(`[data-match-index="${selected}"]`);
    if (container && match) {
      const rect = match.getBoundingClientRect();
      const bounds = container.getBoundingClientRect();
      if (rect.top < bounds.top || rect.bottom > bounds.bottom) container.scrollTop += rect.top - bounds.top - 20;
      if (rect.left < bounds.left || rect.right > bounds.right) container.scrollLeft += rect.left - bounds.left - 20;
    }
  }, [selected, view]);

  async function copyMatches() {
    if (!current || !current.matches.length || busy) return;
    const key = currentKey;
    try {
      await navigator.clipboard.writeText(current.matches.map((match, index) => `${index + 1}. [${match.start}, ${match.end}) ${match.text || '（空匹配）'}`).join('\n'));
      if (latestKey.current === key) setFeedback('已复制当前匹配结果。');
    } catch { if (latestKey.current === key) setFeedback('无法访问剪贴板，请在结果中选择文本后复制。'); }
  }

  const highlighted = () => {
    if (!current) return input.text || '没有文本';
    let offset = 0;
    const pieces = current.matches.map((match, index) => {
      const before = input.text.slice(offset, match.start);
      offset = match.end;
      return <Fragment key={index}>{before}<mark data-match-index={index} data-active={selected === index} title={`匹配 ${index + 1} · [${match.start}, ${match.end})`}>{match.text || <span className={styles.emptyMark} aria-label="零长度匹配">▏</span>}</mark></Fragment>;
    });
    return <>{pieces}{input.text.slice(offset)}</>;
  };

  return <section className={styles.workspace} data-testid="regex-workspace" onKeyDown={(event) => {
    if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') { event.preventDefault(); run(); }
  }}>
    <ToolWorkspaceHeader title="正则表达式" onBack={onBack} />
    <section className={styles.expressionPanel} aria-label="匹配设置">
      <div className={styles.expressionRow}>
        <label className={styles.patternLabel}><span>正则表达式</span><div className={styles.patternField}><span aria-hidden="true">/</span><input aria-label="正则表达式" spellCheck={false} value={input.pattern} onChange={(event) => change({ ...input, pattern: event.target.value })} placeholder="输入表达式，不含两侧斜杠" /><span aria-hidden="true">/</span></div></label>
        <label className={styles.flagsLabel}><span>匹配标志</span><input aria-label="匹配标志" spellCheck={false} value={input.flags} onChange={(event) => change({ ...input, flags: event.target.value })} placeholder="gim" /></label>
        <button type="button" className={styles.primary} onClick={run}>{busy ? '重新测试' : '测试匹配'}</button>
      </div>
      <div className={styles.flagHints}>{FLAGS.map(([flag, text]) => <button type="button" key={flag} aria-label={`${flag} ${text}`} aria-pressed={input.flags.includes(flag)} onClick={() => change({ ...input, flags: input.flags.includes(flag) ? input.flags.split(flag).join('') : input.flags + flag })}><b>{flag}</b>{text}</button>)}<span>Ctrl + Enter</span></div>
    </section>
    <div className={styles.columns}>
      <section className={styles.editorPanel} aria-label="原始文本区域">
        <div className={styles.panelHeader}><h3>原始文本</h3><div className={styles.actions}><button type="button" onClick={() => change({ ...SAMPLE })}>载入示例</button><button type="button" onClick={() => change({ ...input, text: '' })}>清空文本</button></div></div>
        <div className={styles.subbar}><div className={styles.tabs}><button type="button" aria-pressed={view === 'edit'} onClick={() => setView('edit')}>编辑文本</button><button type="button" disabled={!current || busy} aria-pressed={view === 'highlight'} onClick={() => setView('highlight')}>高亮预览</button></div><span>{input.text.length.toLocaleString()} 字符</span></div>
        {view === 'edit' ? <textarea aria-label="待匹配文本" wrap="off" spellCheck={false} value={input.text} onChange={(event) => change({ ...input, text: event.target.value })} placeholder="粘贴要测试的文本…" /> : <pre ref={preview} tabIndex={0} aria-label="文本匹配高亮" className={styles.highlight}>{highlighted()}</pre>}
        <div className={styles.panelFooter}>位置从 0 开始，按 UTF-16 字符计数；结束位置不包含在匹配内。</div>
      </section>
      <section className={styles.resultPanel} aria-label="匹配结果区域">
        <div className={styles.panelHeader}><h3>匹配结果{current && <span className={styles.count}>{current.matches.length}</span>}</h3><button type="button" className={styles.copy} disabled={!current?.matches.length || busy} onClick={copyMatches}>复制匹配</button></div>
        <div className={styles.results} data-testid="regex-results">
          {busy ? <div className={styles.emptyState}>正在本地测试…<small>耗时过长会自动停止。</small><button type="button" onClick={() => { cancelWorker(); setBusy(false); setFeedback('已停止匹配。'); }}>停止匹配</button></div>
            : error ? <div className={styles.error} role="alert">{error}</div>
              : !current ? <div className={styles.emptyState}>{dirty ? '内容已修改，请重新测试' : '准备好后，点击“测试匹配”'}<small>结果显示匹配文本、起止位置与捕获分组。</small></div>
                : !current.matches.length ? <div className={styles.emptyState}>没有匹配结果<small>试试调整表达式或匹配标志。</small></div>
                  : current.matches.map((match, index) => <article className={styles.match} data-testid="regex-match" data-match-index={index} data-selected={selected === index} key={index}>
                    <button type="button" className={styles.matchSelect} aria-label={`定位匹配 ${index + 1}`} onClick={() => selectMatch(index)} aria-pressed={selected === index}><strong>匹配 {index + 1}</strong><span>[{match.start}, {match.end}) · {match.end - match.start} 字符 <i aria-hidden="true">↖</i></span></button>
                    <pre className={styles.matchText}>{match.text || '（空匹配）'}</pre>
                    {!!match.groups.length && <div className={styles.groups}>{match.groups.map((group) => <div key={group.name}><span>组 {group.name}</span><code>{group.value === null ? '未参与匹配' : group.value === '' ? '（空字符串）' : group.value}{group.truncated && ' …（分组预览已截断）'}</code></div>)}{match.groupsTruncated && <small>仅显示前 32 个捕获分组。</small>}</div>}
                  </article>)}
        </div>
        <div className={styles.panelFooter} role="status">{feedback || (current ? `本机匹配 · ${current.limited ? '已达展示上限，请缩小范围；' : ''}${current.matches.length} 个匹配 · ${current.elapsedMs} ms${input.flags.includes('g') ? '' : ' · 单次匹配（未启用 g）'}` : '所有匹配在本机运行，不上传文本。')}</div>
      </section>
    </div>
  </section>;
}
