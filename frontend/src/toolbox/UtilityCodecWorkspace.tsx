import { useEffect, useMemo, useRef, useState } from 'react';
import { executeTool } from '../bridge/hostBridge';
import type { ToolExecuteRequest } from '../types';
import type { ToolDefinition } from './catalog';
import { ToolWorkspaceHeader } from '../../../shared/tool-workspace/ToolWorkspaceHeader';
import { CODEC_INPUT_LIMIT, codecModes, codecSample, formatHexOutput, textMetrics } from './utilityCodecModel';
import styles from './UtilityCodecWorkspace.module.scss';

interface OutputSnapshot { key: string; output: string; elapsed: number; inputBytes: number }

/** A fixed-height text workbench. Conversion stays in the existing native C bridge. */
export function UtilityCodecWorkspace({ tool, onBack }: { tool: ToolDefinition; onBack(): void }) {
  const modes = codecModes(tool.id);
  const [operation, setOperation] = useState(modes[0].id);
  const [input, setInput] = useState(() => codecSample(tool.id, modes[0].id));
  const [urlSafe, setUrlSafe] = useState(false);
  const [padded, setPadded] = useState(true);
  const [plusAsSpace, setPlusAsSpace] = useState(true);
  const [uppercase, setUppercase] = useState(true);
  const [spaced, setSpaced] = useState(true);
  const [indent, setIndent] = useState(2);
  const [wrap, setWrap] = useState(true);
  const [snapshot, setSnapshot] = useState<OutputSnapshot | null>(null);
  const [failure, setFailure] = useState<{ key: string; message: string } | null>(null);
  const [feedback, setFeedback] = useState('');
  const [expectedHash, setExpectedHash] = useState('');
  const [busy, setBusy] = useState(false);
  const request = useRef({ mounted: true, active: false, generation: 0 });
  // A revision also catches clear-on-empty and edit-away-then-back during clipboard prompts.
  const editRevision = useRef(0);
  const lastUrlEncode = useRef('encode-component');
  const inputArea = useRef<HTMLTextAreaElement>(null);
  const resultArea = useRef<HTMLTextAreaElement>(null);
  const makeKey = (text = input, mode = operation, decodePlus = plusAsSpace) => JSON.stringify([tool.id, mode, text, urlSafe, padded, uppercase, spaced, indent, decodePlus]);
  const key = makeKey();
  const latestKey = useRef(key); latestKey.current = key;
  const current = snapshot?.key === key ? snapshot : null;
  const error = failure?.key === key ? failure.message : '';
  const metrics = useMemo(() => textMetrics(input), [input]);
  const outputMetrics = useMemo(() => textMetrics(current?.output ?? ''), [current?.output]);
  const tooLarge = metrics.bytes > CODEC_INPUT_LIMIT;
  const isHash = tool.id === 'hash';
  const isJson = tool.id === 'json-format';
  const reversible = !isHash && !isJson;
  const decoding = operation === 'decode';
  const typeLabel = tool.id === 'base64' ? urlSafe ? 'Base64 URL' : 'Base64' : tool.id === 'hex' ? 'Hex' : tool.id === 'url-encode' ? 'URL' : 'JSON';
  const runLabel = isHash ? '计算哈希' : isJson ? '处理 JSON' : '执行转换';
  const hashMatch = current && expectedHash.trim() ? current.output.toLowerCase() === expectedHash.trim().toLowerCase() : null;

  useEffect(() => {
    request.current.mounted = true;
    return () => { request.current.mounted = false; request.current.generation += 1; };
  }, []);
  useEffect(() => { setFeedback(''); }, [key]);

  async function run(text = input, mode = operation, decodePlus = plusAsSpace) {
    if (request.current.active) return;
    const runKey = makeKey(text, mode, decodePlus);
    if (new TextEncoder().encode(text).length > CODEC_INPUT_LIMIT) {
      setFailure({ key: runKey, message: '输入超过 1 MiB，请缩小后重试；原内容已保留。' }); return;
    }
    const generation = ++request.current.generation;
    request.current.active = true; setBusy(true); setFailure(null); setFeedback('');
    const started = performance.now();
    try {
      let output: string;
      if (isJson) {
        const value = JSON.parse(text) as unknown;
        output = JSON.stringify(value, null, mode === 'format' ? indent : 0);
      } else {
        // The existing form decoder maps '+' to space. Escape literal plus signs when
        // decoding a full URL so reversing encodeURI semantics preserves the original.
        const nativeInput = tool.id === 'url-encode' && mode === 'decode' && !decodePlus ? text.replace(/\+/g, '%2B') : text;
        output = await executeTool({ toolId: tool.id as ToolExecuteRequest['toolId'], operation: mode, input: nativeInput, urlSafe, padded });
        if (tool.id === 'hex' && mode === 'encode') output = formatHexOutput(output, uppercase, spaced);
      }
      if (request.current.mounted && request.current.generation === generation) {
        setSnapshot({ key: runKey, output, elapsed: Math.max(0, Math.round(performance.now() - started)), inputBytes: new TextEncoder().encode(text).length });
        if (latestKey.current === runKey) resultArea.current?.scrollTo({ top: 0, left: 0 });
      }
    } catch (reason) {
      if (request.current.mounted && request.current.generation === generation) {
        setSnapshot(null); setFailure({ key: runKey, message: reason instanceof Error ? reason.message : '处理失败，请检查输入。' });
      }
    } finally {
      if (request.current.mounted && request.current.generation === generation) { request.current.active = false; setBusy(false); }
    }
  }
  function chooseMode(next: string) {
    editRevision.current += 1;
    if (tool.id === 'url-encode' && next !== 'decode') lastUrlEncode.current = next;
    setOperation(next);
  }
  async function paste() {
    const before = latestKey.current;
    const revision = editRevision.current;
    try {
      const text = await navigator.clipboard.readText();
      if (!request.current.mounted) return;
      if (latestKey.current !== before || editRevision.current !== revision) { setFeedback('输入已变化，本次粘贴已取消。'); return; }
      changeInput(text); inputArea.current?.focus();
    } catch { if (request.current.mounted && latestKey.current === before && editRevision.current === revision) setFeedback('无法读取剪贴板，请使用 Ctrl+V 粘贴。'); }
  }
  async function copy() {
    if (!current || busy || error) return;
    const before = key;
    const revision = editRevision.current;
    try { await navigator.clipboard.writeText(current.output); if (request.current.mounted && latestKey.current === before && editRevision.current === revision) setFeedback('结果已复制'); }
    catch { if (request.current.mounted && latestKey.current === before && editRevision.current === revision) setFeedback('复制失败，请选中结果后按 Ctrl+C。'); }
  }
  function reverse() {
    if (!current || busy || error) return;
    const next = decoding ? tool.id === 'url-encode' ? lastUrlEncode.current : 'encode' : 'decode';
    const decodePlus = tool.id === 'url-encode' && !decoding ? operation !== 'encode-url' : plusAsSpace;
    setPlusAsSpace(decodePlus); changeInput(current.output); chooseMode(next); void run(current.output, next, decodePlus);
  }
  function changeInput(text: string) { editRevision.current += 1; setInput(text); }
  function clear() { changeInput(''); setSnapshot(null); setFailure(null); setExpectedHash(''); setFeedback(''); inputArea.current?.focus(); }
  useEffect(() => {
    const listener = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') { event.preventDefault(); if (!event.repeat) void run(); }
    };
    window.addEventListener('keydown', listener); return () => window.removeEventListener('keydown', listener);
  });

  return <section className={styles.workspace} data-testid="codec-workspace">
    <ToolWorkspaceHeader title={tool.name} onBack={onBack} />
    <div className={styles.toolbar}>
      <div className={styles.modes} role="tablist" aria-label="处理模式">{modes.map((mode) => <button key={mode.id} type="button" role="tab" aria-selected={operation === mode.id} onClick={() => chooseMode(mode.id)}>{mode.label}</button>)}</div>
      <div className={styles.options}>
        {tool.id === 'url-encode' && decoding && <label><input type="checkbox" checked={plusAsSpace} onChange={(event) => { editRevision.current += 1; setPlusAsSpace(event.target.checked); }} />加号转空格</label>}
        {tool.id === 'base64' && <><label><input type="checkbox" checked={urlSafe} disabled={decoding} onChange={(event) => { editRevision.current += 1; setUrlSafe(event.target.checked); }} />URL 安全</label><label><input type="checkbox" checked={padded} disabled={decoding} onChange={(event) => { editRevision.current += 1; setPadded(event.target.checked); }} />保留补位</label></>}
        {tool.id === 'hex' && <><label><input type="checkbox" checked={uppercase} disabled={decoding} onChange={(event) => { editRevision.current += 1; setUppercase(event.target.checked); }} />大写</label><label><input type="checkbox" checked={spaced} disabled={decoding} onChange={(event) => { editRevision.current += 1; setSpaced(event.target.checked); }} />分隔字节</label></>}
        {isJson && <label>缩进<select aria-label="JSON 缩进" value={indent} disabled={operation === 'minify'} onChange={(event) => { editRevision.current += 1; setIndent(Number(event.target.value)); }}><option value={2}>2 空格</option><option value={4}>4 空格</option></select></label>}
      </div>
      <button className={styles.primary} type="button" disabled={busy || tooLarge} onClick={() => void run()}>{busy ? '处理中…' : runLabel}<kbd>Ctrl Enter</kbd></button>
    </div>
    <div className={`${styles.panes} ${isHash ? styles.hashLayout : ''}`}>
      <section className={styles.inputPane} aria-label="输入区域">
        <header><div><h3>{isHash ? '待校验文本' : isJson ? 'JSON 输入' : decoding ? '编码文本' : '原始文本'}</h3><span>{isHash || !decoding ? 'UTF-8' : typeLabel}</span></div><nav aria-label="输入操作"><button type="button" onClick={() => void paste()}>粘贴文本</button><button type="button" onClick={() => { changeInput(codecSample(tool.id, operation)); setSnapshot(null); setFailure(null); }}>载入示例</button><button type="button" disabled={busy} onClick={clear}>清空输入</button></nav></header>
        <textarea ref={inputArea} aria-label="输入文本" data-testid="codec-input" value={input} onChange={(event) => changeInput(event.target.value)} wrap={wrap ? 'soft' : 'off'} spellCheck={false} placeholder="在这里输入或粘贴内容…" />
        <footer><span data-testid="codec-input-stats">{metrics.characters.toLocaleString()} 字符 · {metrics.lines.toLocaleString()} 行 · {metrics.bytes.toLocaleString()} B</span><label><input type="checkbox" checked={wrap} onChange={(event) => setWrap(event.target.checked)} />自动换行</label></footer>
      </section>
      <section className={`${styles.outputPane} ${isHash ? styles.hashPane : ''}`} aria-label="输出区域">
        <header><div><h3>{isHash ? '摘要校验' : isJson ? '处理结果' : decoding ? '解码结果' : '编码结果'}</h3><span className={current && !error && !busy ? styles.ready : ''}>{busy ? '处理中' : error ? '失败' : current ? '已完成' : snapshot ? '待更新' : '待处理'}</span></div><button type="button" disabled={!current || busy || !!error} onClick={() => void copy()}>复制结果</button></header>
        {error || tooLarge ? <div className={styles.outputMessage}><p role="alert" data-testid="result-error">{tooLarge ? '输入超过 1 MiB，请缩小后重试；原内容已保留。' : error}</p><span>输入内容保持不变，修改后可重新执行。</span></div>
          : isHash ? <div className={styles.digestContent}>
            <div className={styles.digestHeading}><strong>{operation === 'sha256' ? 'SHA-256' : 'MD5'}</strong><span>{operation === 'sha256' ? '256 bit' : '128 bit'}</span></div>
            <pre data-testid="codec-output" aria-label="哈希结果">{current?.output ?? (busy ? '正在计算…' : '执行计算后显示摘要')}</pre>
            <div className={styles.digestFacts}><span>UTF-8 输入<strong>{current ? `${current.inputBytes.toLocaleString()} B` : '—'}</strong></span><span>十六进制长度<strong>{current ? `${current.output.length} 位` : '—'}</strong></span></div>
            <label className={styles.compareHash}>核对摘要<input aria-label="期望哈希值" value={expectedHash} onChange={(event) => setExpectedHash(event.target.value)} placeholder="粘贴期望哈希值（可选）" spellCheck={false} /></label>
            {hashMatch !== null && <p className={hashMatch ? styles.match : styles.mismatch} role="status">{hashMatch ? '✓ 摘要一致' : '× 摘要不一致'}</p>}
            {operation === 'md5' && <p className={styles.note}>MD5 仅用于兼容校验，不用于密码存储或安全认证。</p>}
          </div>
          : <textarea ref={resultArea} readOnly aria-label="输出文本" data-testid="codec-output" value={current?.output ?? ''} placeholder={current ? '' : busy ? '正在处理…' : snapshot ? '输入或选项已修改，请重新处理。' : '执行后在这里查看结果'} wrap={wrap ? 'soft' : 'off'} spellCheck={false} />}
        <footer><span>{current && !error ? `${outputMetrics.characters.toLocaleString()} 字符 · ${outputMetrics.bytes.toLocaleString()} B` : '等待有效结果'}</span>{reversible && <button type="button" disabled={!current || busy || !!error} onClick={reverse}>反向转换 ⇄</button>}{isJson && <button type="button" disabled={!current || busy || !!error} onClick={() => { if (current) { changeInput(current.output); setSnapshot(null); } }}>结果作为输入 ←</button>}</footer>
      </section>
    </div>
    <div className={styles.statusBar} role="status"><span>{feedback || (error || tooLarge ? '请检查输入内容' : current ? `处理完成 · ${current.elapsed} ms${!isHash && !isJson && current.output === '' ? ' · 结果为空文本' : ''}` : snapshot ? '输入或选项已修改，旧结果不可复制' : '准备就绪')}</span><span>{tool.id === 'base64' || tool.id === 'hex' ? 'UTF-8 文本编解码' : isJson ? '本机 JSON 处理' : '本机处理'} · 最大 1 MiB</span></div>
  </section>;
}
