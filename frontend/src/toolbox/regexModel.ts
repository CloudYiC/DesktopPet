/** Matching runs only inside a disposable worker; validation is safe on the UI thread. */
export const REGEX_LIMITS = { text: 200_000, pattern: 4096, matches: 1000, output: 600_000, capture: 4096, groups: 32 };

export interface RegexInput { pattern: string; flags: string; text: string }
export interface RegexGroup { name: string; value: string | null; truncated: boolean }
export interface RegexMatch { text: string; start: number; end: number; groups: RegexGroup[]; groupsTruncated: boolean }
export interface RegexResult { matches: RegexMatch[]; limited: boolean; elapsedMs: number }

export function validateRegexInput(input: RegexInput): string | null {
  if (input.text.length > REGEX_LIMITS.text) return '文本最多 200,000 个 UTF-16 字符，请缩小范围后重试；输入不会被截断。';
  if (input.pattern.length > REGEX_LIMITS.pattern) return '表达式最多 4,096 个字符，请缩短后重试。';
  if (/[^gimsuy]/.test(input.flags)) return '匹配标志仅支持 g、i、m、s、u、y；不要输入斜杠或空格。';
  if (new Set(input.flags).size !== input.flags.length) return '匹配标志不能重复。';
  return null;
}

/** AdvanceStringIndex from ECMAScript semantics prevents empty global matches looping forever. */
function nextIndex(text: string, index: number, unicode: boolean): number {
  if (!unicode || index + 1 >= text.length) return index + 1;
  const first = text.charCodeAt(index);
  const second = text.charCodeAt(index + 1);
  return first >= 0xd800 && first <= 0xdbff && second >= 0xdc00 && second <= 0xdfff ? index + 2 : index + 1;
}

export function executeRegex(input: RegexInput): RegexResult {
  const invalid = validateRegexInput(input);
  if (invalid) throw new Error(invalid);
  const started = performance.now();
  const expression = new RegExp(input.pattern, input.flags);
  const matches: RegexMatch[] = [];
  let outputSize = 0;
  let limited = false;
  let found: RegExpExecArray | null;
  while ((found = expression.exec(input.text)) !== null) {
    // Stop before copying excessive overlapping captures into the reply object.
    if (matches.length >= REGEX_LIMITS.matches || outputSize + found[0].length > REGEX_LIMITS.output) { limited = true; break; }
    const groups: RegexGroup[] = [];
    const captures: [string, string | undefined][] = found.slice(1).map((value, index) => [String(index + 1), value]);
    Object.entries(found.groups ?? {}).forEach(([name, value]) => captures.push([name, value]));
    outputSize += found[0].length;
    for (const [name, value] of captures.slice(0, REGEX_LIMITS.groups)) {
      const available = Math.max(0, Math.min(REGEX_LIMITS.capture, REGEX_LIMITS.output - outputSize));
      const content = value === undefined ? null : value.slice(0, available);
      groups.push({ name, value: content, truncated: value !== undefined && value.length > available });
      outputSize += content?.length ?? 0;
    }
    matches.push({ text: found[0], start: found.index, end: found.index + found[0].length, groups, groupsTruncated: captures.length > REGEX_LIMITS.groups });
    if (!expression.global) break;
    if (found[0].length === 0) expression.lastIndex = nextIndex(input.text, expression.lastIndex, expression.unicode);
  }
  return { matches, limited, elapsedMs: Math.round((performance.now() - started) * 10) / 10 };
}
