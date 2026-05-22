export interface TextRange {
  start: number;
  end: number;
}

export interface MarkdownLine {
  text: string;
  start: number;
  end: number;
}

interface MarkdownFence {
  char: "`" | "~";
  length: number;
  start: number;
}

export function markdownLines(markdown: string): MarkdownLine[] {
  const lines: MarkdownLine[] = [];
  const lineEndPattern = /\r?\n/g;
  let cursor = 0;
  for (const match of markdown.matchAll(lineEndPattern)) {
    const index = match.index ?? 0;
    const lineEnd = index + match[0]!.length;
    lines.push({ text: markdown.slice(cursor, index), start: cursor, end: lineEnd });
    cursor = lineEnd;
  }
  if (cursor < markdown.length) {
    lines.push({ text: markdown.slice(cursor), start: cursor, end: markdown.length });
  }
  return lines;
}

export function markdownCodeRanges(markdown: string): TextRange[] {
  const blockRanges = markdownCodeBlockRanges(markdown);
  const inlineRanges = markdownInlineCodeRanges(markdown, blockRanges);
  return mergeTextRanges([...blockRanges, ...inlineRanges]);
}

export function isPositionInTextRanges(position: number, ranges: TextRange[]): boolean {
  for (const range of ranges) {
    if (position < range.start) {
      return false;
    }
    if (position < range.end) {
      return true;
    }
  }
  return false;
}

function markdownCodeBlockRanges(markdown: string): TextRange[] {
  const ranges: TextRange[] = [];
  let fence: MarkdownFence | undefined;

  for (const line of markdownLines(markdown)) {
    if (fence) {
      if (isClosingFence(line.text, fence)) {
        ranges.push({ start: fence.start, end: line.end });
        fence = undefined;
      }
      continue;
    }

    const openingFence = openingMarkdownFence(line.text);
    if (openingFence) {
      fence = { ...openingFence, start: line.start };
      continue;
    }

    if (isIndentedCodeLine(line.text)) {
      ranges.push({ start: line.start, end: line.end });
    }
  }

  if (fence) {
    ranges.push({ start: fence.start, end: markdown.length });
  }

  return mergeTextRanges(ranges);
}

function markdownInlineCodeRanges(markdown: string, blockRanges: TextRange[]): TextRange[] {
  const ranges: TextRange[] = [];
  let index = 0;

  while (index < markdown.length) {
    const blockRange = rangeContainingOrAfter(index, blockRanges);
    if (blockRange && index >= blockRange.start) {
      index = blockRange.end;
      continue;
    }

    if (markdown[index] !== "`") {
      index += 1;
      continue;
    }

    const length = countBackticks(markdown, index);
    const close = findClosingBacktickRun(markdown, index + length, length, blockRanges);
    if (close === -1) {
      index += length;
      continue;
    }

    const end = close + length;
    ranges.push({ start: index, end });
    index = end;
  }

  return ranges;
}

function openingMarkdownFence(line: string): Pick<MarkdownFence, "char" | "length"> | undefined {
  const match = /^ {0,3}(`{3,}|~{3,})/.exec(line);
  if (!match) {
    return undefined;
  }
  const sequence = match[1]!;
  return {
    char: sequence[0] as "`" | "~",
    length: sequence.length
  };
}

function isClosingFence(line: string, fence: MarkdownFence): boolean {
  const match = /^ {0,3}(`+|~+)[ \t]*$/.exec(line);
  if (!match) {
    return false;
  }
  const sequence = match[1]!;
  return sequence[0] === fence.char && sequence.length >= fence.length;
}

function isIndentedCodeLine(line: string): boolean {
  return line.trim().length > 0 && /^(?: {4,}|\t)/.test(line);
}

function findClosingBacktickRun(markdown: string, start: number, length: number, blockRanges: TextRange[]): number {
  let index = start;
  while (index < markdown.length) {
    const blockRange = rangeContainingOrAfter(index, blockRanges);
    if (blockRange && index >= blockRange.start) {
      index = blockRange.end;
      continue;
    }

    if (markdown[index] !== "`") {
      index += 1;
      continue;
    }

    const runLength = countBackticks(markdown, index);
    if (runLength === length) {
      return index;
    }
    index += runLength;
  }
  return -1;
}

function countBackticks(markdown: string, start: number): number {
  let index = start;
  while (markdown[index] === "`") {
    index += 1;
  }
  return index - start;
}

function rangeContainingOrAfter(position: number, ranges: TextRange[]): TextRange | undefined {
  return ranges.find((range) => position < range.end);
}

function mergeTextRanges(ranges: TextRange[]): TextRange[] {
  const sorted = ranges
    .filter((range) => range.end > range.start)
    .sort((left, right) => left.start - right.start || left.end - right.end);
  const merged: TextRange[] = [];
  for (const range of sorted) {
    const previous = merged.at(-1);
    if (previous && range.start <= previous.end) {
      previous.end = Math.max(previous.end, range.end);
      continue;
    }
    merged.push({ ...range });
  }
  return merged;
}
