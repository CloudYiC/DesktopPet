import { useEffect, useRef, useState } from 'react';
import { executeTool } from '../bridge/hostBridge';
import { ToolWorkspaceHeader } from '../../../shared/tool-workspace/ToolWorkspaceHeader';
import type { ToolDefinition } from './catalog';
import type { ToolExecuteRequest } from '../types';
import { boundedInteger, localDateText, timestampMilliseconds, unixSecondsText } from './utilitySpecializedModel';
import styles from './UtilitySpecializedWorkspace.module.scss';

interface Props { tool: ToolDefinition; onBack(): void; }
interface Result { key: string; revision: number; value: string; milliseconds?: number; }

/** Keyed children keep secrets and pending replies isolated when tools are switched. */
export function UtilitySpecializedWorkspace(props: Props) {
  return <SpecializedWorkspace key={props.tool.id} {...props} />;
}

function SpecializedWorkspace({ tool, onBack }: Props) {
  const isTimestamp = tool.id === 'timestamp';
  const isUuid = tool.id === 'uuid';
  const isPassword = tool.id === 'password';
  const [input, setInput] = useState(() => isTimestamp ? String(Date.now()) : isUuid ? '5' : '24');
  const [operation, setOperation] = useState(isTimestamp ? 'milliseconds' : isUuid ? 'v4' : 'strong');
  const [result, setResult] = useState<Result | null>(null);
  const [busy, setBusy] = useState(false);
  const [visible, setVisible] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const lifecycle = useRef(0);
  const revision = useRef(0);
  const inFlight = useRef(false);
  const copySequence = useRef(0);
  const key = JSON.stringify([tool.id, input, operation]);
  const current = result?.key === key && result.revision === revision.current ? result : null;
  const fresh = !!current && !busy;
  const stale = !!result && !current;

  useEffect(() => {
    lifecycle.current += 1;
    return () => {
      // Pending bridge callbacks cannot repopulate an unmounted password panel.
      lifecycle.current += 1;
      revision.current += 1;
      copySequence.current += 1;
    };
  }, []);

  const invalidate = () => {
    revision.current += 1;
    copySequence.current += 1;
    setVisible(false);
    setError('');
    setNotice('');
  };
  const editInput = (value: string) => { invalidate(); setInput(value); };
  const editOperation = (value: string) => { invalidate(); setOperation(value); };
  const clear = () => {
    invalidate();
    setResult(null);
    if (isTimestamp) setInput('');
    setNotice(isTimestamp ? '时间戳与结果已清空。' : '生成结果已清空。');
  };

  const run = async () => {
    if (inFlight.current) return;
    setError('');
    setNotice('');
    let normalized: number;
    let milliseconds: number | undefined;
    try {
      if (isTimestamp) {
        milliseconds = timestampMilliseconds(input, operation);
        normalized = Number(input.trim());
      } else if (isUuid) {
        normalized = boundedInteger(input, 1, 50, 'UUID 数量');
      } else {
        normalized = boundedInteger(input, 4, 128, '密码长度');
      }
    } catch (validationError) {
      setResult(null);
      setError(validationError instanceof Error ? validationError.message : '请检查参数。');
      return;
    }
    const requestRevision = ++revision.current;
    const requestLifecycle = lifecycle.current;
    inFlight.current = true;
    setBusy(true);
    setVisible(false);
    setResult(null);
    try {
      const value = await executeTool({ toolId: tool.id as ToolExecuteRequest['toolId'], operation, input: String(normalized), padded: true });
      if (lifecycle.current !== requestLifecycle || revision.current !== requestRevision) return;
      if (isTimestamp && new Date(value.trim()).getTime() !== milliseconds) {
        throw new Error('时间转换结果无效，请重试。');
      }
      if (!value) throw new Error('未收到有效结果，请重试。');
      setResult({ key, revision: requestRevision, value: isTimestamp ? value.trim() : value, milliseconds });
      setNotice(isTimestamp ? '已转换为 UTC 与本机时间。' : isUuid ? `已生成 ${normalized} 个 UUID。` : '密码已生成，默认隐藏。');
    } catch (runError) {
      if (lifecycle.current !== requestLifecycle || revision.current !== requestRevision) return;
      setError(runError instanceof Error ? runError.message : '执行失败，请重试。');
    } finally {
      inFlight.current = false;
      if (lifecycle.current === requestLifecycle) setBusy(false);
    }
  };

  const copy = async (value: string, label: string) => {
    if (!fresh) return;
    const requestLifecycle = lifecycle.current;
    const requestRevision = revision.current;
    const sequence = ++copySequence.current;
    setNotice('');
    try {
      await navigator.clipboard.writeText(value);
      if (lifecycle.current === requestLifecycle && revision.current === requestRevision && copySequence.current === sequence) {
        setNotice(`${label}已复制。`);
      }
    } catch {
      if (lifecycle.current === requestLifecycle && revision.current === requestRevision && copySequence.current === sequence) {
        setNotice('复制失败，请检查剪贴板权限后重试。');
      }
    }
  };

  const setNow = () => editInput(String(operation === 'seconds' ? Math.floor(Date.now() / 1000) : Date.now()));
  const values = current?.milliseconds === undefined ? [] : [
    { label: 'UTC', hint: 'ISO 8601', value: current.value },
    { label: '本机时间', hint: Intl.DateTimeFormat().resolvedOptions().timeZone || '当前系统时区', value: localDateText(current.milliseconds) },
    { label: 'Unix 秒', hint: '保留毫秒小数', value: unixSecondsText(current.milliseconds) },
    { label: 'Unix 毫秒', hint: '整数毫秒', value: String(current.milliseconds) },
  ];
  const uuidValues = current?.value.split(/\r?\n/).filter(Boolean) ?? [];
  const operationLabel = operation === 'strong' ? '大小写字母 + 数字 + 符号' : operation === 'letters-digits' ? '大小写字母 + 数字' : '仅数字';
  const action = isTimestamp ? '转换时间' : isUuid ? '生成 UUID' : '生成密码';

  return (
    <section className={styles.workspace} data-testid="specialized-workspace" onKeyDown={(event) => {
      if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') { event.preventDefault(); void run(); }
    }}>
      <ToolWorkspaceHeader title={tool.name} onBack={onBack} />
      <section className={styles.controls} aria-label="工具参数">
        <div className={styles.controlHeading}>
          <h3>{isTimestamp ? '时间戳转换' : isUuid ? '生成设置' : '密码设置'}</h3>
          <div className={styles.modeGroup} aria-label={isTimestamp ? '时间单位' : isUuid ? 'UUID 版本' : '密码规则'}>
            {(isTimestamp
              ? [['seconds', '秒（s）'], ['milliseconds', '毫秒（ms）']]
              : isUuid ? [['v4', 'UUID v4'], ['v7', 'UUID v7']]
                : [['strong', '含符号'], ['letters-digits', '字母与数字'], ['pin', '纯数字 PIN']]
            ).map(([value, label]) => <button type="button" key={value} aria-pressed={operation === value} onClick={() => editOperation(value)}>{label}</button>)}
          </div>
        </div>
        <div className={styles.inputRow}>
          <label className={isTimestamp ? styles.timestampInput : styles.numberInput}>
            <span>{isTimestamp ? 'Unix 时间戳' : isUuid ? '生成数量' : '密码长度'}</span>
            <input type={isTimestamp ? 'text' : 'number'} inputMode="numeric" spellCheck={false} autoComplete="off"
              aria-label={isTimestamp ? 'Unix 时间戳' : isUuid ? '生成数量' : '密码长度'} value={input}
              min={isUuid ? 1 : 4} max={isUuid ? 50 : 128} step={1} maxLength={isTimestamp ? 32 : undefined}
              onChange={(event) => editInput(event.target.value)} placeholder={isTimestamp ? '输入完整的整数时间戳' : undefined} />
          </label>
          {isPassword && <input className={styles.lengthRange} type="range" min="4" max="128" step="1" aria-label="调整密码长度"
            value={Math.min(128, Math.max(4, Number(input) || 4))} onChange={(event) => editInput(event.target.value)} />}
          {isUuid && <p className={styles.parameterHint}>每次 1–50 个<br />{operation === 'v7' ? '时间戳前缀 + 随机位' : '随机标识符'}</p>}
          <div className={styles.actions}>
            {isTimestamp && <button type="button" onClick={setNow}>使用当前时间</button>}
            <button type="button" className={styles.primary} disabled={busy} onClick={() => void run()}>{busy ? '处理中…' : action}<kbd>Ctrl Enter</kbd></button>
          </div>
        </div>
        <div className={styles.controlFooter}>
          <span>{isTimestamp ? `输入单位：${operation === 'seconds' ? '秒' : '毫秒'} · 不自动猜测单位` : isUuid ? '使用系统安全随机源；结果仅保留在本次页面中。' : `${operationLabel} · 长度 4–128`}</span>
          <button type="button" onClick={clear}>{isTimestamp ? '清空' : '清空结果'}</button>
        </div>
      </section>

      <section className={styles.resultPanel} data-testid="specialized-result" aria-label={isTimestamp ? '时间转换结果' : isUuid ? 'UUID 生成结果' : '密码生成结果'}>
        <header className={styles.resultHeading}>
          <div><h3>{isTimestamp ? '转换结果' : isUuid ? 'UUID 列表' : '生成的密码'}</h3><span>{current ? isTimestamp ? '同一时刻的不同表示' : isUuid ? `${uuidValues.length} 个 · ${operation.toUpperCase()}` : `${current.value.length} 个字符` : stale ? '参数已修改' : '尚未生成结果'}</span></div>
          {isUuid && <button type="button" disabled={!fresh} onClick={() => void copy(current?.value ?? '', '全部 UUID')}>复制全部</button>}
          {isPassword && <div className={styles.actions}>
            <button type="button" aria-pressed={visible} disabled={!fresh} onClick={() => setVisible(!visible)}>{visible ? '隐藏密码' : '显示密码'}</button>
            <button type="button" disabled={!fresh} onClick={() => void copy(current?.value ?? '', '密码')}>复制密码</button>
          </div>}
        </header>
        <div className={styles.resultScroll}>
          {error && <p className={styles.error} role="alert">{error}</p>}
          {current ? isTimestamp ? <div className={styles.timeValues}>
            {values.map((item) => <article className={styles.timeValue} key={item.label}>
              <div><strong>{item.label}</strong><small>{item.hint}</small></div>
              <code>{item.value}</code>
              <button type="button" aria-label={`复制 ${item.label}`} disabled={!fresh} onClick={() => void copy(item.value, item.label)}>复制</button>
            </article>)}
          </div> : isUuid ? <ol className={styles.uuidList}>
            {uuidValues.map((value, index) => <li key={`${index}-${value}`}><span>{String(index + 1).padStart(2, '0')}</span><code>{value}</code>
              <button type="button" disabled={!fresh} aria-label={`复制第 ${index + 1} 个 UUID`} onClick={() => void copy(value, `第 ${index + 1} 个 UUID`)}>复制</button></li>)}
          </ol> : <div className={styles.passwordResult}>
            <div className={styles.passwordValue} aria-label={visible ? '明文密码' : '密码已隐藏'}><code>{visible ? current.value : '•'.repeat(Math.min(current.value.length, 32))}</code></div>
            <p>{visible ? '当前显示明文，请留意屏幕共享与旁人视线。' : '点击“显示密码”查看明文，或直接复制使用。'}</p>
            <div className={styles.passwordRules}><strong>本次规则</strong><span>{operationLabel}</span><span>{current.value.length} 个字符</span></div>
            <p className={styles.privacyNote}>不保存到历史记录。复制后，内容可能保留在系统剪贴板或剪贴板历史中。</p>
          </div> : <div className={styles.empty}>
            <i aria-hidden="true">{isTimestamp ? '◷' : isUuid ? 'ID' : '•••'}</i>
            <strong>{busy ? '正在处理' : stale ? '参数已修改，请重新生成' : isTimestamp ? '将时间戳转为清晰的日期' : isUuid ? '按需生成，逐条使用' : '为当前用途生成一个新密码'}</strong>
            <p>{busy ? '等待本地处理完成。' : stale ? '旧结果不可复制，避免误用。' : isTimestamp ? '选择秒或毫秒，再点击“转换时间”。' : isUuid ? '选择版本和数量，点击“生成 UUID”。' : '选择字符规则和长度，点击“生成密码”。'}</p>
          </div>}
        </div>
        <footer className={styles.status} role="status" aria-live="polite"><span>{notice || (busy ? '处理中，可调整参数；旧请求完成后不会覆盖新参数。' : isPassword ? '关闭此页面后不保留生成结果。' : '结果区独立滚动，参数始终可见。')}</span></footer>
      </section>
    </section>
  );
}
