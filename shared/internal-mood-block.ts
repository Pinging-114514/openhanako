export const INTERNAL_MOOD_TAGS = Object.freeze([
  "mood",
  "pulse",
  "reflect",
] as const);

export type InternalMoodTag = (typeof INTERNAL_MOOD_TAGS)[number];

type LeadingMoodInspection =
  | {
    kind: "open";
    prefix: string;
    tag: InternalMoodTag;
    openTag: string;
    remainder: string;
  }
  | {
    kind: "pending";
    prefix: string;
    pending: string;
  }
  | {
    kind: "text";
  };

export interface LeadingInternalMoodBlock {
  prefix: string;
  tag: InternalMoodTag;
  content: string;
  rest: string;
}

function isLeadingWhitespace(char: string): boolean {
  return char === "\uFEFF" || /\s/u.test(char);
}

/**
 * Classify only the response-leading position. `pending` means a streaming
 * caller must retain the partial opener until another chunk or flush arrives.
 */
export function inspectLeadingInternalMoodOpener(input: string): LeadingMoodInspection {
  let openerIndex = 0;
  while (openerIndex < input.length && isLeadingWhitespace(input[openerIndex])) {
    openerIndex += 1;
  }

  const prefix = input.slice(0, openerIndex);
  const candidate = input.slice(openerIndex);
  if (!candidate) return { kind: "pending", prefix, pending: "" };

  for (const tag of INTERNAL_MOOD_TAGS) {
    const openTag = `<${tag}>`;
    if (candidate.startsWith(openTag)) {
      return {
        kind: "open",
        prefix,
        tag,
        openTag,
        remainder: candidate.slice(openTag.length),
      };
    }
  }

  if (INTERNAL_MOOD_TAGS.some((tag) => `<${tag}>`.startsWith(candidate))) {
    return { kind: "pending", prefix, pending: candidate };
  }
  return { kind: "text" };
}

/** Parse one complete, correctly paired internal block at response start. */
export function parseLeadingInternalMoodBlock(input: string): LeadingInternalMoodBlock | null {
  const inspection = inspectLeadingInternalMoodOpener(input);
  if (inspection.kind !== "open") return null;

  const closeTag = `</${inspection.tag}>`;
  const closeIndex = inspection.remainder.indexOf(closeTag);
  if (closeIndex < 0) return null;

  return {
    prefix: inspection.prefix,
    tag: inspection.tag,
    content: inspection.remainder.slice(0, closeIndex),
    rest: inspection.remainder.slice(closeIndex + closeTag.length),
  };
}

function fenceIsOpen(input: string, index: number): boolean {
  let count = 0;
  let cursor = 0;
  while (cursor < index) {
    if (input.startsWith("```", cursor)) {
      count += 1;
      cursor += 3;
    } else {
      cursor += 1;
    }
  }
  return count % 2 === 1;
}

function atLineStart(input: string, index: number): boolean {
  let cursor = index - 1;
  while (cursor >= 0 && (input[cursor] === " " || input[cursor] === "\t")) cursor -= 1;
  return cursor < 0 || input[cursor] === "\n" || input[cursor] === "\r";
}

function openerIsLiteral(input: string, index: number): boolean {
  return input[index - 1] === "`"
    || fenceIsOpen(input, index)
    || !atLineStart(input, index);
}

export interface InternalMoodBlockMatch extends LeadingInternalMoodBlock {
  index: number;
}

export interface InternalMoodOpenerMatch {
  index: number;
  prefix: string;
  tag: InternalMoodTag;
  remainder: string;
}

/** First mood opener on its own line. A closer is not required, so streaming can enter the block. */
export function findInternalMoodOpener(input: string): InternalMoodOpenerMatch | null {
  let best: InternalMoodOpenerMatch | null = null;
  for (const tag of INTERNAL_MOOD_TAGS) {
    const openTag = `<${tag}>`;
    let from = 0;
    while (from < input.length) {
      const index = input.indexOf(openTag, from);
      if (index < 0) break;
      from = index + openTag.length;
      if (openerIsLiteral(input, index)) continue;
      if (best && index >= best.index) continue;
      best = {
        index,
        prefix: input.slice(0, index),
        tag,
        remainder: input.slice(index + openTag.length),
      };
      break;
    }
  }
  return best;
}

/** Trailing `<mo`-style fragment that is still on its own line and must not be emitted as text yet. */
export function internalMoodOpenerHoldLength(input: string): number {
  let best = 0;
  for (const tag of INTERNAL_MOOD_TAGS) {
    const openTag = `<${tag}>`;
    const maxCheck = Math.min(input.length, openTag.length - 1);
    for (let len = maxCheck; len >= 1; len--) {
      if (!input.endsWith(openTag.slice(0, len))) continue;
      const start = input.length - len;
      if (input[start - 1] === "`" || fenceIsOpen(input, start) || !atLineStart(input, start)) break;
      if (len > best) best = len;
      break;
    }
  }
  return best;
}

/** First complete mood block on its own line, including one that follows the answer. */
export function findInternalMoodBlock(input: string): InternalMoodBlockMatch | null {
  let best: InternalMoodBlockMatch | null = null;
  for (const tag of INTERNAL_MOOD_TAGS) {
    const openTag = `<${tag}>`;
    const closeTag = `</${tag}>`;
    let from = 0;
    while (from < input.length) {
      const index = input.indexOf(openTag, from);
      if (index < 0) break;
      from = index + openTag.length;
      if (openerIsLiteral(input, index)) continue;
      const closeIndex = input.indexOf(closeTag, index + openTag.length);
      if (closeIndex < 0) continue;
      if (best && index >= best.index) continue;
      best = {
        index,
        prefix: input.slice(0, index),
        tag,
        content: input.slice(index + openTag.length, closeIndex),
        rest: input.slice(closeIndex + closeTag.length),
      };
      break;
    }
  }
  return best;
}
