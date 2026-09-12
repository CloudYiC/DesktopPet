import type { DatabaseQueryResult } from '../types';

/** SQLite identifiers cannot use value parameters; escape double quotes instead. */
export function quoteIdentifier(value: string) {
  return `"${value.replace(/"/g, '""')}"`;
}

/** Quote TSV fields containing separators without modifying query values. */
export function resultToTsv(result: DatabaseQueryResult) {
  const field = (value: string) => /[\t\r\n"]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
  return [result.columns, ...result.rows.map((row) => result.columns.map((_, index) => row[index] ?? 'NULL'))]
    .map((row) => row.map(field).join('\t')).join('\r\n');
}

export interface SqlToken { text: string; kind: 'plain' | 'keyword' | 'string' | 'comment' | 'number' }
const KEYWORDS = new Set('SELECT FROM WHERE ORDER BY GROUP HAVING LIMIT OFFSET AS ASC DESC JOIN LEFT RIGHT INNER OUTER ON AND OR NOT NULL IS IN LIKE DISTINCT CASE WHEN THEN ELSE END INSERT INTO VALUES UPDATE SET DELETE CREATE TABLE VIEW INDEX TRIGGER DROP ALTER PRAGMA WITH UNION ALL BEGIN COMMIT ROLLBACK EXPLAIN PRIMARY KEY DEFAULT INTEGER TEXT REAL BLOB IF EXISTS'.split(' '));

/** Display-only tokenization, never a SQL validator. React renders all text escaped. */
export function highlightSql(sql: string): SqlToken[] {
  // Very large valid scripts remain editable without creating thousands of spans.
  if (sql.length > 64_000) return [{ text: sql, kind: 'plain' }];
  const parts = sql.split(/(--[^\r\n]*|\/\*[\s\S]*?(?:\*\/|$)|'(?:''|[^'])*(?:'|$)|"(?:""|[^"])*(?:"|$)|\b[A-Za-z_][A-Za-z_0-9]*\b|\b\d+(?:\.\d+)?\b)/g);
  return parts.filter(Boolean).map((text) => ({
    text,
    kind: text.startsWith('--') || text.startsWith('/*') ? 'comment'
      : text.startsWith("'") || text.startsWith('"') ? 'string'
      : KEYWORDS.has(text.toUpperCase()) ? 'keyword'
      : /^\d/.test(text) ? 'number' : 'plain',
  }));
}
