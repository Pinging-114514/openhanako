import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SessionCoordinator } from '../core/session-coordinator.ts';

let root: string;
beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'hana-abort-thinking-')); });
afterEach(() => { vi.restoreAllMocks(); fs.rmSync(root, { recursive: true, force: true }); });

function setup() {
  const agentsDir = path.join(root, 'agents');
  const sessionDir = path.join(agentsDir, 'hana', 'sessions');
  fs.mkdirSync(sessionDir, { recursive: true });
  const file = path.join(sessionDir, 'stopped.jsonl');
  fs.writeFileSync(file, JSON.stringify({ type: 'session', version: 3, id: 'test-stopped', timestamp: new Date().toISOString(), cwd: root }) + '\n');
  const agent = { id: 'hana', agentDir: path.dirname(sessionDir), sessionDir };
  const model = { id: 'test-model', provider: 'test-provider', reasoning: true, thinkingLevels: ['low', 'medium', 'high', 'xhigh'] };
  const emitEvent = vi.fn();
  const coordinator = new SessionCoordinator({
    agentsDir, getAgent: () => agent, getActiveAgentId: () => 'hana',
    getModels: () => ({ resolveThinkingLevel: (level: string) => level, availableModels: [model], currentModel: model }),
    getResourceLoader: () => ({ getSystemPrompt: () => 'test' }), getSkills: () => null,
    buildTools: () => ({ tools: [], customTools: [] }), emitEvent, emitDevLog: vi.fn(),
    getHomeCwd: () => root, agentIdFromSessionPath: () => 'hana', switchAgentOnly: async () => {},
    getConfig: () => ({}), getPrefs: () => ({ getThinkingLevel: () => 'medium' }),
    getAgents: () => new Map([['hana', agent]]), getAgentById: () => agent,
    getActivityStore: () => null, listAgents: () => [agent],
  } as any);
  vi.spyOn(coordinator as any, '_cleanupAbortedSessionSidecars').mockImplementation(() => {});
  vi.spyOn(coordinator as any, '_teardownSessionEntry').mockResolvedValue(undefined);
  const old = { isStreaming: true, model, abort: vi.fn(() => new Promise(() => {})), dispose: vi.fn(), prompt: vi.fn(), sessionManager: { getSessionFile: () => file } };
  const restored = { isStreaming: false, model, setThinkingLevel: vi.fn(), prompt: vi.fn(), sessionManager: { getSessionFile: () => file } };
  const attach = vi.spyOn(coordinator as any, '_loadSessionForAttach').mockImplementation(async (p: any) => {
    coordinator.sessions.set(p, { session: restored, agentId: 'hana', thinkingLevel: 'medium', modelId: model.id, modelProvider: model.provider } as any);
    return restored;
  });
  const putOld = () => coordinator.sessions.set(file, { session: old, agentId: 'hana', thinkingLevel: 'medium', modelId: model.id, modelProvider: model.provider, unsub: vi.fn() } as any);
  return { coordinator, file, old, restored, attach, emitEvent, putOld };
}

describe('thinking level after a stopped turn', () => {
  it('saves immediately after forced abort without waiting for a new model reply', async () => {
    const f = setup(); f.putOld();
    await expect(f.coordinator.abortSession(f.file)).resolves.toBe(true);
    expect(f.coordinator.getSessionByPath(f.file)).toBeNull();
    expect(f.old.dispose).toHaveBeenCalled();
    const result = await f.coordinator.setSessionThinkingLevel(f.file, 'high');
    expect(result).toEqual({ ok: true, thinkingLevel: 'high' });
    expect(f.attach).toHaveBeenCalledTimes(1);
    expect(f.restored.setThinkingLevel).toHaveBeenCalledWith('high');
    expect(f.old.prompt).not.toHaveBeenCalled();
    expect(f.restored.prompt).not.toHaveBeenCalled();
    expect(f.coordinator.getSessionThinkingLevel(f.file)).toBe('high');
    const meta = JSON.parse(fs.readFileSync(path.join(path.dirname(f.file), 'session-meta.json'), 'utf8'));
    expect(meta[path.basename(f.file)].thinkingLevel).toBe('high');
  });
  it('uses the existing quiet-load deduplication for concurrent post-stop changes', async () => {
    const f = setup();
    const results = await Promise.all([f.coordinator.setSessionThinkingLevel(f.file, 'low'), f.coordinator.setSessionThinkingLevel(f.file, 'high')]);
    expect(results.every(result => result.ok)).toBe(true);
    expect(f.attach).toHaveBeenCalledTimes(1);
    expect(f.restored.prompt).not.toHaveBeenCalled();
  });
  it('does not recreate a runtime for an already-live session', async () => {
    const f = setup();
    f.coordinator.sessions.set(f.file, { session: f.restored, agentId: 'hana', thinkingLevel: 'medium' } as any);
    await expect(f.coordinator.setSessionThinkingLevel(f.file, 'high')).resolves.toMatchObject({ ok: true, thinkingLevel: 'high' });
    expect(f.attach).not.toHaveBeenCalled();
  });
  it('keeps the lightweight metadata-only path for a hibernated session', async () => {
    const f = setup();
    (f.coordinator as any)._hibernatedSessionMeta.set(f.file, { thinkingLevel: 'medium' });
    await expect(f.coordinator.setSessionThinkingLevel(f.file, 'high')).resolves.toMatchObject({ ok: true, thinkingLevel: 'high' });
    expect(f.attach).not.toHaveBeenCalled();
  });
  it('rejects nonexistent, outside and archived paths instead of creating sessions', async () => {
    const f = setup();
    for (const target of [path.join(path.dirname(f.file), 'missing.jsonl'), path.join(root, 'outside.jsonl'), path.join(path.dirname(f.file), 'archive', 'old.jsonl')]) {
      await expect(f.coordinator.setSessionThinkingLevel(target, 'high')).resolves.toMatchObject({ ok: false, error: 'session not found' });
    }
    expect(f.attach).not.toHaveBeenCalled();
  });
  it('does not revive a deleted agent session', async () => {
    const f = setup();
    (f.coordinator as any)._d.isAgentDeleted = () => true;
    await expect(f.coordinator.setSessionThinkingLevel(f.file, 'high')).resolves.toMatchObject({ ok: false });
    expect(f.attach).not.toHaveBeenCalled();
  });
  it('does not steal the focus pointer from another conversation when attaching', async () => {
    const f = setup();
    const focused = { sessionManager: { getSessionFile: () => '/another-session.jsonl' } };
    (f.coordinator as any)._session = focused;
    (f.coordinator as any)._currentSessionPath = '/another-session.jsonl';
    await expect(f.coordinator.setSessionThinkingLevel(f.file, 'high')).resolves.toMatchObject({ ok: true });
    expect(f.coordinator.session).toBe(focused);
    expect(f.restored.prompt).not.toHaveBeenCalled();
  });
});
