import { useMemo, useRef } from 'react';
import { highlightSql } from './databaseWorkbenchModel';
import styles from './DatabaseStudio.module.scss';

/** A native textarea supplies selection/IME/accessibility; the inert layer supplies color. */
export function DatabaseSqlEditor({ value, onChange, disabled = false }: { value: string; onChange(value: string): void; disabled?: boolean }) {
  const highlight = useRef<HTMLPreElement>(null);
  const gutter = useRef<HTMLPreElement>(null);
  const tokens = useMemo(() => highlightSql(value), [value]);
  const numbers = useMemo(() => Array.from({ length: value.split('\n').length }, (_, index) => index + 1).join('\n'), [value]);
  return <div className={styles.codeEditor} data-testid="db-sql-editor">
    <pre ref={gutter} className={styles.lineNumbers} aria-hidden="true">{numbers}</pre>
    <div className={styles.codeArea}>
      <pre ref={highlight} className={styles.highlight} aria-hidden="true"><code>{tokens.map((token, index) => <span key={index} className={styles[token.kind]}>{token.text}</span>)}{'\n'}</code></pre>
      <textarea aria-label="SQL 编辑器" value={value} onChange={(event) => onChange(event.target.value)}
        onScroll={(event) => {
          if (highlight.current) { highlight.current.scrollTop = event.currentTarget.scrollTop; highlight.current.scrollLeft = event.currentTarget.scrollLeft; }
          if (gutter.current) gutter.current.scrollTop = event.currentTarget.scrollTop;
        }} disabled={disabled} wrap="off" spellCheck={false} autoCapitalize="off" autoCorrect="off" />
    </div>
  </div>;
}
