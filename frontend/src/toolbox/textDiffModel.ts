/** Pure, bounded text diff. Offsets in groups are zero-based and inclusive. */
export interface DiffSegment {
  text: string;
  changed: boolean;
}

export interface DiffLine {
  lineNumber: number;
  text: string;
  segments: DiffSegment[];
}

export interface DiffRow {
  kind: 'same' | 'add' | 'remove' | 'change';
  left: DiffLine | null;
  right: DiffLine | null;
}

export interface DiffResult {
  rows: DiffRow[];
  groups: { startRow: number; endRow: number }[];
  stats: { added: number; removed: number; modified: number; unchanged: number };
  identical: boolean;
  notice?: string;
}

type Match = [left: number, right: number];
interface WorkBudget { remaining: number }
interface Precision { lines: boolean; inline: boolean }

// Myers' trace is bounded independently of input size: at most ~1.2 MiB for
// lines and ~80 KiB for characters, never an input-sized N × M matrix.
const LINE_DISTANCE_LIMIT = 384;
const INLINE_DISTANCE_LIMIT = 96;
const LINE_WORK_LIMIT = 500_000;
const INLINE_WORK_LIMIT = 600_000;

function splitLines(text: string): string[] {
  // CRLF, LF and standalone CR have identical line-separator semantics.
  // Empty input has no lines; a terminal separator creates an extra empty line,
  // which intentionally distinguishes "text" from "text\n".
  return text === '' ? [] : text.split(/\r\n|\n|\r/u);
}

function myersMatches(
  left: readonly string[], right: readonly string[],
  leftStart: number, leftEnd: number, rightStart: number, rightEnd: number,
  budget: WorkBudget, distanceLimit: number,
): Match[] | null {
  const n = leftEnd - leftStart;
  const m = rightEnd - rightStart;
  if (n === 0 || m === 0) return [];
  const limit = Math.min(n + m, distanceLimit);
  if (Math.abs(n - m) > limit || budget.remaining <= 0) return null;
  const offset = limit + 1;
  const frontier = new Int32Array(limit * 2 + 3).fill(-1);
  frontier[offset + 1] = 0;
  const trace: Int32Array[] = [];
  for (let distance = 0; distance <= limit; distance += 1) {
    for (let diagonal = -distance; diagonal <= distance; diagonal += 2) {
      if (--budget.remaining < 0) return null;
      const index = offset + diagonal;
      let x = diagonal === -distance
        || (diagonal !== distance && frontier[index - 1] < frontier[index + 1])
        ? frontier[index + 1] : frontier[index - 1] + 1;
      let y = x - diagonal;
      while (x < n && y < m && left[leftStart + x] === right[rightStart + y]) {
        if (--budget.remaining < 0) return null;
        x += 1;
        y += 1;
      }
      frontier[index] = x;
      if (x >= n && y >= m) {
        const matches: Match[] = [];
        // Backtrack only equal "snakes"; gaps are rendered as paired changes
        // plus any unpaired insertions/deletions by the caller.
        for (let d = distance; d > 0; d -= 1) {
          const previous = trace[d - 1];
          const k = x - y;
          const previousK = k === -d
            || (k !== d && previous[offset + k - 1] < previous[offset + k + 1])
            ? k + 1 : k - 1;
          const previousX = previous[offset + previousK];
          const previousY = previousX - previousK;
          while (x > previousX && y > previousY) {
            matches.push([leftStart + --x, rightStart + --y]);
          }
          x = previousX;
          y = previousY;
        }
        while (x > 0 && y > 0) matches.push([leftStart + --x, rightStart + --y]);
        return matches.reverse();
      }
    }
    trace.push(frontier.slice());
  }
  return null;
}

/** Patience anchors keep distinctive unchanged lines aligned after a fallback. */
function uniqueAnchors(
  left: readonly string[], right: readonly string[],
  leftStart: number, leftEnd: number, rightStart: number, rightEnd: number,
): Match[] {
  const positions = (values: readonly string[], start: number, end: number) => {
    const result = new Map<string, number>();
    for (let i = start; i < end; i += 1) {
      result.set(values[i], result.has(values[i]) ? -1 : i);
    }
    return result;
  };
  const leftPositions = positions(left, leftStart, leftEnd);
  const rightPositions = positions(right, rightStart, rightEnd);
  const candidates: Match[] = [];
  for (let i = leftStart; i < leftEnd; i += 1) {
    const rightIndex = rightPositions.get(left[i]);
    if (leftPositions.get(left[i]) === i && rightIndex !== undefined && rightIndex >= 0) {
      candidates.push([i, rightIndex]);
    }
  }
  // Longest increasing subsequence in O(n log n), without recursive partitions.
  const tails: number[] = [];
  const previous = new Int32Array(candidates.length).fill(-1);
  for (let i = 0; i < candidates.length; i += 1) {
    let low = 0;
    let high = tails.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (candidates[tails[middle]][1] < candidates[i][1]) low = middle + 1;
      else high = middle;
    }
    if (low > 0) previous[i] = tails[low - 1];
    tails[low] = i;
  }
  const matches: Match[] = [];
  let index = tails.length === 0 ? -1 : tails[tails.length - 1];
  while (index >= 0) {
    matches.push(candidates[index]);
    index = previous[index];
  }
  return matches.reverse();
}

function boundedMatches(
  left: readonly string[], right: readonly string[],
  budget: WorkBudget, distanceLimit: number, fallback?: () => void,
  useAnchors = false,
): Match[] {
  let start = 0;
  while (start < left.length && start < right.length && left[start] === right[start]) start += 1;
  let leftEnd = left.length;
  let rightEnd = right.length;
  while (leftEnd > start && rightEnd > start && left[leftEnd - 1] === right[rightEnd - 1]) {
    leftEnd -= 1;
    rightEnd -= 1;
  }
  const matches: Match[] = [];
  for (let i = 0; i < start; i += 1) matches.push([i, i]);
  const middle = myersMatches(left, right, start, leftEnd, start, rightEnd, budget, distanceLimit);
  if (middle !== null) {
    for (const match of middle) matches.push(match);
  } else {
    fallback?.();
    if (useAnchors) {
      const anchors = uniqueAnchors(left, right, start, leftEnd, start, rightEnd);
      let previousLeft = start;
      let previousRight = start;
      for (let i = 0; i <= anchors.length; i += 1) {
        const anchor = anchors[i] ?? [leftEnd, rightEnd];
        const gap = myersMatches(left, right, previousLeft, anchor[0], previousRight, anchor[1], budget, distanceLimit);
        if (gap) for (const match of gap) matches.push(match);
        if (i < anchors.length) matches.push(anchor);
        previousLeft = anchor[0] + 1;
        previousRight = anchor[1] + 1;
      }
    }
    // Without a precise path, the unmatched middle is one replacement block.
    // This does not omit text, and the caller explicitly reports lower precision.
  }
  for (let i = leftEnd, j = rightEnd; i < left.length; i += 1, j += 1) matches.push([i, j]);
  return matches;
}

function appendSegment(segments: DiffSegment[], text: string, changed: boolean): void {
  if (text === '') return;
  const last = segments[segments.length - 1];
  if (last?.changed === changed) last.text += text;
  else segments.push({ text, changed });
}

function inlineSegments(
  left: string, right: string, ignoreWhitespace: boolean,
  budget: WorkBudget, precision: Precision,
): [DiffSegment[], DiffSegment[]] {
  const parts = (text: string) => {
    const start = ignoreWhitespace ? text.length - text.trimStart().length : 0;
    const end = ignoreWhitespace ? Math.max(start, text.trimEnd().length) : text.length;
    // Array.from iterates Unicode code points; highlight boundaries therefore
    // cannot bisect a surrogate pair (grapheme clusters are not the unit here).
    return { prefix: text.slice(0, start), points: Array.from(text.slice(start, end)), suffix: text.slice(end) };
  };
  const leftParts = parts(left);
  const rightParts = parts(right);
  const matches = boundedMatches(leftParts.points, rightParts.points, budget, INLINE_DISTANCE_LIMIT,
    () => { precision.inline = true; });
  const leftSegments: DiffSegment[] = [];
  const rightSegments: DiffSegment[] = [];
  appendSegment(leftSegments, leftParts.prefix, false);
  appendSegment(rightSegments, rightParts.prefix, false);
  let leftIndex = 0;
  let rightIndex = 0;
  // Append contiguous runs rather than one string concatenation per character.
  // In particular a 200k-character unchanged prefix is processed linearly.
  for (let i = 0; i <= matches.length;) {
    const match = matches[i] ?? [leftParts.points.length, rightParts.points.length];
    appendSegment(leftSegments, leftParts.points.slice(leftIndex, match[0]).join(''), true);
    appendSegment(rightSegments, rightParts.points.slice(rightIndex, match[1]).join(''), true);
    if (i === matches.length) break;
    const runLeft = match[0];
    const runRight = match[1];
    let count = 1;
    while (i + count < matches.length
      && matches[i + count][0] === runLeft + count && matches[i + count][1] === runRight + count) count += 1;
    appendSegment(leftSegments, leftParts.points.slice(runLeft, runLeft + count).join(''), false);
    appendSegment(rightSegments, rightParts.points.slice(runRight, runRight + count).join(''), false);
    leftIndex = runLeft + count;
    rightIndex = runRight + count;
    i += count;
  }
  appendSegment(leftSegments, leftParts.suffix, false);
  appendSegment(rightSegments, rightParts.suffix, false);
  return [leftSegments, rightSegments];
}

export function compareTexts(
  left: string, right: string, options: { ignoreWhitespace?: boolean } = {},
): DiffResult {
  const leftLines = splitLines(left);
  const rightLines = splitLines(right);
  const ignoreWhitespace = options.ignoreWhitespace === true;
  const leftKeys = ignoreWhitespace ? leftLines.map((line) => line.trim()) : leftLines;
  const rightKeys = ignoreWhitespace ? rightLines.map((line) => line.trim()) : rightLines;
  const precision: Precision = { lines: false, inline: false };
  const matches = boundedMatches(leftKeys, rightKeys, { remaining: LINE_WORK_LIMIT }, LINE_DISTANCE_LIMIT,
    () => { precision.lines = true; }, true);
  const inlineBudget: WorkBudget = { remaining: INLINE_WORK_LIMIT };
  const rows: DiffRow[] = [];
  const stats = { added: 0, removed: 0, modified: 0, unchanged: 0 };
  const makeLine = (lines: string[], index: number, changed: boolean): DiffLine => ({
    lineNumber: index + 1,
    text: lines[index],
    segments: [{ text: lines[index], changed }],
  });
  let leftIndex = 0;
  let rightIndex = 0;
  for (let i = 0; i <= matches.length; i += 1) {
    const match = matches[i] ?? [leftLines.length, rightLines.length];
    while (leftIndex < match[0] || rightIndex < match[1]) {
      const leftLine = leftIndex < match[0] ? makeLine(leftLines, leftIndex++, true) : null;
      const rightLine = rightIndex < match[1] ? makeLine(rightLines, rightIndex++, true) : null;
      if (leftLine && rightLine) {
        // A coarse alignment can coincidentally pair equal lines; classify those
        // truthfully even when other lines in the block could not be aligned.
        if (leftKeys[leftLine.lineNumber - 1] === rightKeys[rightLine.lineNumber - 1]) {
          leftLine.segments[0].changed = false;
          rightLine.segments[0].changed = false;
          rows.push({ kind: 'same', left: leftLine, right: rightLine });
          stats.unchanged += 1;
        } else {
          [leftLine.segments, rightLine.segments] = inlineSegments(leftLine.text, rightLine.text, ignoreWhitespace, inlineBudget, precision);
          rows.push({ kind: 'change', left: leftLine, right: rightLine });
          stats.modified += 1;
        }
      } else if (leftLine) {
        rows.push({ kind: 'remove', left: leftLine, right: null });
        stats.removed += 1;
      } else {
        rows.push({ kind: 'add', left: null, right: rightLine });
        stats.added += 1;
      }
    }
    if (i < matches.length) {
      rows.push({ kind: 'same', left: makeLine(leftLines, leftIndex++, false), right: makeLine(rightLines, rightIndex++, false) });
      stats.unchanged += 1;
    }
  }
  const groups: DiffResult['groups'] = [];
  rows.forEach((row, index) => {
    if (row.kind === 'same') return;
    const last = groups[groups.length - 1];
    if (last && last.endRow === index - 1) last.endRow = index;
    else groups.push({ startRow: index, endRow: index });
  });
  const notices: string[] = [];
  if (precision.lines) notices.push('差异较大，部分行采用简化对齐');
  if (precision.inline) notices.push('部分行采用区段高亮');
  return {
    rows, groups, stats, identical: groups.length === 0,
    ...(notices.length ? { notice: `${notices.join('；')}，文本内容未截断。` } : {}),
  };
}
