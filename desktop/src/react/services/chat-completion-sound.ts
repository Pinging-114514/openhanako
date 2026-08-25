// Cursor composer chime default: done1.mp3 (not VS Code responseReceived*).
import soundUrl from '../../assets/sounds/cursor-done.mp3';
import { hanaFetch } from '../hooks/use-hana-fetch';

const STORAGE_KEY = 'hana.chatCompletionSound';

let enabled = false;
let audio: HTMLAudioElement | null = null;

function asPrefsRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

export function readStoredChatCompletionSound(): boolean | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw === '1') return true;
    if (raw === '0') return false;
  } catch {
    // Ignore quota / private-mode failures.
  }
  return null;
}

export function resolveChatCompletionSoundFlag(source: unknown, fallback = false): boolean {
  const record = asPrefsRecord(source);
  if (record && Object.prototype.hasOwnProperty.call(record, 'chatCompletionSound')) {
    return record.chatCompletionSound === true;
  }
  const stored = readStoredChatCompletionSound();
  if (stored !== null) return stored;
  return fallback;
}

export function setChatCompletionSoundEnabled(next: boolean, options: { persist?: boolean } = {}): void {
  enabled = next === true;
  if (options.persist === false) return;
  try {
    localStorage.setItem(STORAGE_KEY, enabled ? '1' : '0');
  } catch {
    // Ignore quota / private-mode failures.
  }
}

export function isChatCompletionSoundEnabled(): boolean {
  return enabled;
}

export function hydrateChatCompletionSound(prefs?: { chatCompletionSound?: unknown } | null): void {
  if (prefs) {
    setChatCompletionSoundEnabled(resolveChatCompletionSoundFlag(prefs), { persist: false });
    return;
  }
  const stored = readStoredChatCompletionSound();
  if (stored !== null) setChatCompletionSoundEnabled(stored, { persist: false });
  void hanaFetch('/api/preferences/notifications')
    .then((res) => res.json())
    .then((data) => {
      setChatCompletionSoundEnabled(resolveChatCompletionSoundFlag(data?.notifications, stored === true));
    })
    .catch(() => {});
}

export function playChatCompletionSound(options: { force?: boolean } = {}): void {
  if (!options.force && !enabled) return;
  if (typeof Audio !== 'function') return;
  try {
    if (!audio) audio = new Audio(soundUrl);
    audio.currentTime = 0;
    const playResult = audio.play();
    if (playResult && typeof playResult.catch === 'function') {
      playResult.catch(() => {});
    }
  } catch {
    // Autoplay or missing asset should not break the chat turn.
  }
}
