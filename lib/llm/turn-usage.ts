/**
 * 一轮对话（含工具循环）的用量汇总。
 * 缓存率按本轮全部请求的 token 加权；速度按整轮墙钟估算。
 */

function num(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function parseTime(value) {
  if (value == null) return null;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  const ms = Date.parse(String(value));
  return Number.isFinite(ms) ? ms : null;
}

function isSessionReplyEntry(entry) {
  if (!entry || (entry.status && entry.status !== "ok")) return false;
  const source = entry.source || {};
  if (source.subsystem && source.subsystem !== "session") return false;
  if (source.operation && source.operation !== "reply") return false;
  return true;
}

function cacheWeight(entry) {
  const usage = entry.usage || {};
  const cache = usage.cache || {};
  if (cache.support && cache.support !== "reported") return null;
  const read = num(cache.readTokens);
  const uncached = usage.input?.uncachedTokens;
  const inputTotal = num(usage.input?.totalTokens);
  const miss = uncached == null ? Math.max(0, inputTotal - read) : num(uncached);
  let denom = read + miss;
  if (denom <= 0 && inputTotal > 0) denom = inputTotal;
  if (denom <= 0) return null;
  return { read, denom };
}

export function summarizeTurnUsage(entries, {
  startedAt = null,
  endedAt = Date.now(),
} = {}) {
  const usable = (Array.isArray(entries) ? entries : []).filter(isSessionReplyEntry);
  if (usable.length === 0) return null;

  let input = 0;
  let output = 0;
  let cacheRead = 0;
  let cacheWrite = 0;
  let weightedRead = 0;
  let weightedDenom = 0;

  for (const entry of usable) {
    const usage = entry.usage || {};
    const cache = usage.cache || {};
    input += num(usage.input?.totalTokens);
    output += num(usage.output?.totalTokens);
    cacheRead += num(cache.readTokens);
    cacheWrite += num(cache.writeTokens);
    const weight = cacheWeight(entry);
    if (weight) {
      weightedRead += weight.read;
      weightedDenom += weight.denom;
    }
  }

  const startMs = parseTime(startedAt) ?? parseTime(usable[0]?.startedAt);
  const endMs = parseTime(endedAt) ?? parseTime(usable[usable.length - 1]?.endedAt) ?? Date.now();
  const wallMs = startMs != null ? Math.max(0, endMs - startMs) : null;
  const usableWall = wallMs != null && wallMs >= 400;
  const tokensPerSec = usableWall && output > 0 ? output / (wallMs / 1000) : null;
  const hitRatio = weightedDenom > 0 ? weightedRead / weightedDenom : null;

  return {
    calls: usable.length,
    input,
    output,
    cacheRead,
    cacheWrite,
    hitRatio,
    tokensPerSec,
    durationMs: usableWall ? wallMs : null,
  };
}

export function turnUsageFromPiAssistantUsage(usage, {
  startedAt = null,
  endedAt = Date.now(),
} = {}) {
  if (!usage || typeof usage !== "object") return null;
  const input = num(usage.input);
  const output = num(usage.output);
  const cacheRead = num(usage.cacheRead);
  if (input <= 0 && output <= 0 && cacheRead <= 0) return null;
  const startMs = parseTime(startedAt);
  const endMs = parseTime(endedAt) ?? Date.now();
  const wallMs = startMs != null ? Math.max(0, endMs - startMs) : null;
  const usableWall = wallMs != null && wallMs >= 400;
  const denom = Math.max(input, cacheRead);
  return {
    calls: 1,
    input,
    output,
    cacheRead,
    cacheWrite: num(usage.cacheWrite),
    hitRatio: denom > 0 ? cacheRead / denom : null,
    tokensPerSec: usableWall && output > 0 ? output / (wallMs / 1000) : null,
    durationMs: usableWall ? wallMs : null,
  };
}

export function assignTurnUsageToAssistants(assistants, entries) {
  const list = Array.isArray(assistants) ? assistants : [];
  const usable = (Array.isArray(entries) ? entries : [])
    .filter(isSessionReplyEntry)
    .slice()
    .sort((a, b) => (parseTime(a.endedAt || a.startedAt) || 0) - (parseTime(b.endedAt || b.startedAt) || 0));

  let cursor = 0;
  return list.map((assistant, index) => {
    const bound = parseTime(assistant?.timestamp);
    const nextBound = parseTime(list[index + 1]?.timestamp);
    const bucket = [];
    while (cursor < usable.length) {
      const ended = parseTime(usable[cursor].endedAt || usable[cursor].startedAt);
      if (index < list.length - 1) {
        if (nextBound != null && ended != null && ended > nextBound) break;
        if (bound != null && ended != null && ended > bound + 2_000) break;
      }
      bucket.push(usable[cursor]);
      cursor += 1;
    }
    const turnUsage = summarizeTurnUsage(bucket, {
      startedAt: bucket[0]?.startedAt,
      endedAt: bound ?? bucket[bucket.length - 1]?.endedAt,
    });
    return turnUsage;
  });
}

export function compactTokenCount(value) {
  const v = Math.round(num(value));
  if (v >= 1000) return `${(v / 1000).toFixed(1)}k`;
  return String(v);
}

export function formatTurnUsageSpeed(value) {
  const n = num(value);
  if (!Number.isFinite(n) || n <= 0) return null;
  if (n >= 100) return String(Math.round(n));
  if (n >= 10) return n.toFixed(1);
  return n.toFixed(2);
}
