import { compactTokenCount, formatTurnUsageSpeed } from '../../../../lib/llm/turn-usage.ts';
import type { ChatMessage } from '../stores/chat-types';

declare function t(key: string, vars?: Record<string, string | number>): string;

export function formatTurnUsageLine(usage: ChatMessage['turnUsage']): string | null {
  if (!usage) return null;
  const parts: string[] = [];
  if (usage.hitRatio != null && Number.isFinite(usage.hitRatio)) {
    const rate = Math.round(usage.hitRatio * 1000) / 10;
    parts.push(t('chat.turnUsage.cache', { rate: String(rate) }));
  } else {
    parts.push(t('chat.turnUsage.cacheUnknown'));
  }
  parts.push(t('chat.turnUsage.io', {
    input: compactTokenCount(usage.input),
    output: compactTokenCount(usage.output),
  }));
  const speed = formatTurnUsageSpeed(usage.tokensPerSec);
  if (speed) parts.push(t('chat.turnUsage.speed', { speed }));
  return parts.join(' · ');
}
