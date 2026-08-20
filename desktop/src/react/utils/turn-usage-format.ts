import { compactTokenCount, formatTurnUsageSpeed } from '../../../../lib/llm/turn-usage.ts';
import type { ChatMessage } from '../stores/chat-types';

function tr(key: string, vars?: Record<string, string | number>): string {
  const fn = typeof window !== 'undefined' ? window.t : undefined;
  return typeof fn === 'function' ? fn(key, vars) : key;
}

export function formatTurnUsageLine(usage: ChatMessage['turnUsage']): string | null {
  if (!usage) return null;
  const parts: string[] = [];
  if ((usage.calls || 0) > 1) {
    parts.push(tr('chat.turnUsage.calls', { n: String(usage.calls) }));
  }
  if (usage.hitRatio != null && Number.isFinite(usage.hitRatio)) {
    const rate = Math.round(usage.hitRatio * 1000) / 10;
    parts.push(tr('chat.turnUsage.cache', { rate: String(rate) }));
  } else {
    parts.push(tr('chat.turnUsage.cacheUnknown'));
  }
  parts.push(tr('chat.turnUsage.io', {
    input: compactTokenCount(usage.input),
    output: compactTokenCount(usage.output),
  }));
  const speed = formatTurnUsageSpeed(usage.tokensPerSec);
  if (speed) parts.push(tr('chat.turnUsage.speed', { speed }));
  return parts.join(' · ');
}
