'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const { test } = require('node:test');
const root = path.resolve(__dirname, '..');
const ts = require(path.join(root, 'frontend/node_modules/typescript'));
const filename = path.join(root, 'frontend/src/toolbox/databaseWorkbenchModel.ts');
const source = fs.readFileSync(filename, 'utf8');
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } });
const loaded = new Module(filename, module);
loaded._compile(compiled.outputText, filename);
const { quoteIdentifier, resultToTsv, highlightSql } = loaded.exports;

test('SQLite identifier quoting preserves malicious-looking names as one identifier', () => {
  assert.equal(quoteIdentifier('user";DROP TABLE t;--'), '"user"";DROP TABLE t;--"');
  assert.equal(quoteIdentifier('名字'), '"名字"');
});
test('TSV retains headers, all rows, Unicode, quotes, tabs and newlines', () => {
  const result = { columns: ['id', 'na\tme'], rows: [['1', '云依'], ['2', 'hello\n"test"'], ['3']] };
  assert.equal(resultToTsv(result), 'id\t"na\tme"\r\n1\t云依\r\n2\t"hello\n""test"""\r\n3\tNULL');
});
test('SQL colors preserve every input character and distinguish literal/comment keywords', () => {
  for (const sql of ['', "SELECT 'it''s SELECT', \"WHERE\" FROM t -- LIMIT 1\n/* UPDATE */\nLIMIT 5;", "SELECT '<img src=x onerror=alert(1)>'", "SELECT 'unfinished", '/* unfinished', "''''''''", '中文 😀 \t\r\n']) {
    assert.equal(highlightSql(sql).map((token) => token.text).join(''), sql);
  }
  const tokens = highlightSql("SELECT 'WHERE' -- FROM\n42");
  assert.equal(tokens.find((token) => token.text === 'SELECT').kind, 'keyword');
  assert.equal(tokens.find((token) => token.text === "'WHERE'").kind, 'string');
  assert.equal(tokens.find((token) => token.text === '-- FROM').kind, 'comment');
  assert.equal(tokens.find((token) => token.text === '42').kind, 'number');
});
test('large scripts retain exact text with a bounded display token count', () => {
  const sql = 'SELECT 1;\n'.repeat(26000);
  assert.deepEqual(highlightSql(sql), [{ text: sql, kind: 'plain' }]);
});
