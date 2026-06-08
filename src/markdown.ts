import { fromMarkdown } from "mdast-util-from-markdown";

export interface TextRange {
  start: number;
  end: number;
}

export interface MarkdownLine {
  text: string;
  start: number;
  end: number;
}

export interface MarkdownImageReference {
  altText: string;
  target: string;
  start: number;
  end: number;
}

interface MarkdownFence {
  char: "`" | "~";
  length: number;
  start: number;
}

interface MarkdownAstNode {
  type?: string;
  url?: unknown;
  alt?: unknown;
  position?: {
    start?: { offset?: number };
    end?: { offset?: number };
  };
  children?: unknown[];
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

export function renderLocalPathMarkdownLinksAsCode(markdown: string): string {
  if (!markdown.includes("](")) {
    return markdown;
  }

  const codeRanges = markdownCodeRanges(markdown);
  let rendered = "";
  let cursor = 0;
  let index = 0;
  while (index < markdown.length) {
    if (markdown[index] !== "[" || isPositionInTextRanges(index, codeRanges) || markdown[index - 1] === "!") {
      index += 1;
      continue;
    }

    const link = parseInlineMarkdownLinkAt(markdown, index);
    if (!link) {
      index += 1;
      continue;
    }

    if (!isLocalPathMarkdownLinkTarget(link.target)) {
      index = link.end;
      continue;
    }

    rendered += markdown.slice(cursor, index);
    rendered += markdownCodeSpan(link.target);
    cursor = link.end;
    index = link.end;
  }

  if (cursor === 0) {
    return markdown;
  }
  return rendered + markdown.slice(cursor);
}

export function markdownImageReferences(markdown: string): MarkdownImageReference[] {
  if (!markdown.includes("![")) {
    return [];
  }

  const references: MarkdownImageReference[] = [];
  visitMarkdownAst(fromMarkdown(markdown), (node) => {
    if (node.type !== "image" || typeof node.url !== "string") {
      return;
    }
    const start = node.position?.start?.offset;
    const end = node.position?.end?.offset;
    if (typeof start !== "number" || typeof end !== "number" || end <= start) {
      return;
    }
    references.push({
      altText: typeof node.alt === "string" ? node.alt : "",
      target: node.url,
      start,
      end
    });
  });

  return references.sort((left, right) => left.start - right.start || left.end - right.end);
}

function visitMarkdownAst(node: unknown, visitor: (node: MarkdownAstNode) => void): void {
  if (!isMarkdownAstNode(node)) {
    return;
  }
  visitor(node);
  for (const child of node.children ?? []) {
    visitMarkdownAst(child, visitor);
  }
}

function isMarkdownAstNode(value: unknown): value is MarkdownAstNode {
  return typeof value === "object" && value !== null;
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

interface InlineMarkdownLink {
  label: string;
  target: string;
  end: number;
}

interface InlineMarkdownLinkDestination {
  target: string;
  end: number;
}

function parseInlineMarkdownLinkAt(markdown: string, start: number): InlineMarkdownLink | undefined {
  const labelEnd = findClosingMarkdownLinkLabel(markdown, start);
  if (labelEnd === -1 || markdown[labelEnd + 1] !== "(") {
    return undefined;
  }

  const destination = parseMarkdownLinkDestination(markdown, labelEnd + 1);
  return destination ? { label: markdown.slice(start + 1, labelEnd), target: destination.target, end: destination.end } : undefined;
}

function findClosingMarkdownLinkLabel(markdown: string, start: number): number {
  let depth = 1;
  let index = start + 1;
  while (index < markdown.length) {
    const char = markdown[index];
    if (char === "\\") {
      index += 2;
      continue;
    }
    if (char === "[") {
      depth += 1;
    } else if (char === "]") {
      depth -= 1;
      if (depth === 0) {
        return index;
      }
    }
    index += 1;
  }
  return -1;
}

function parseMarkdownLinkDestination(markdown: string, openParenIndex: number): InlineMarkdownLinkDestination | undefined {
  let depth = 0;
  let index = openParenIndex + 1;
  while (index < markdown.length) {
    const char = markdown[index];
    if (char === "\\") {
      index += 2;
      continue;
    }
    if (char === "(") {
      depth += 1;
      index += 1;
      continue;
    }
    if (char === ")") {
      if (depth > 0) {
        depth -= 1;
        index += 1;
        continue;
      }
      const target = extractMarkdownLinkTarget(markdown.slice(openParenIndex + 1, index));
      return target ? { target, end: index + 1 } : undefined;
    }
    index += 1;
  }
  return undefined;
}

function extractMarkdownLinkTarget(rawDestination: string): string | undefined {
  const trimmed = rawDestination.trim();
  if (trimmed.length === 0) {
    return undefined;
  }

  if (trimmed.startsWith("<")) {
    const close = trimmed.indexOf(">");
    const target = close === -1 ? "" : trimmed.slice(1, close);
    return target.length > 0 ? target : undefined;
  }

  const whitespace = trimmed.search(/\s/);
  return whitespace === -1 ? trimmed : trimmed.slice(0, whitespace);
}

function isLocalPathMarkdownLinkTarget(target: string): boolean {
  const trimmed = target.trim();
  return trimmed.startsWith("/");
}

function markdownCodeSpan(value: string): string {
  const longestBacktickRun = Math.max(0, ...Array.from(value.matchAll(/`+/g), (match) => match[0]!.length));
  const marker = "`".repeat(longestBacktickRun + 1);
  return longestBacktickRun > 0 ? `${marker} ${value} ${marker}` : `${marker}${value}${marker}`;
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
