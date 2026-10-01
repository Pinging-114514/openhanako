import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { ActivityStore, ACTIVITY_RETENTION_MS as WEEK } from '../lib/desk/activity-store.ts';

const NOW = Date.UTC(2026, 9, 1, 1);
let root: string;
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(NOW); root = fs.mkdtempSync(path.join(os.tmpdir(), 'hana-activity-retention-')); });
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); fs.rmSync(root, { recursive: true, force: true }); });
function setup(entries: any[]) {
  const dir = path.join(root, 'activity'); fs.mkdirSync(dir);
  const file = path.join(root, 'activities.json'); fs.writeFileSync(file, JSON.stringify(entries));
  const store = new ActivityStore(file, dir, { finalizeOrphanedRunning: false });
  return { store, dir, file };
}
function done(id: string, age = 0, extra: any = {}) { return { id, status: 'done', startedAt: NOW - age, finishedAt: NOW - age, ...extra }; }

describe('seven-day activity history retention', () => {
  it('expires records at exactly seven days, retaining records one millisecond younger', () => {
    const { store, file } = setup([done('expired', WEEK), done('old', WEEK + 1), done('recent', WEEK - 1)]);
    expect(store.list().map(e => e.id)).toEqual(['recent']);
    expect(JSON.parse(fs.readFileSync(file, 'utf8')).map(e => e.id)).toEqual(['recent']);
  });
  it('uses completion time rather than start time for long-running work', () => {
    const { store } = setup([done('long', 0, { startedAt: NOW - 2 * WEEK })]);
    expect(store.list()).toHaveLength(1);
  });
  it('falls back to startedAt for historical completed records without finishedAt', () => {
    const { store } = setup([done('legacy', WEEK, { finishedAt: undefined }), done('recent', 1, { finishedAt: undefined })]);
    expect(store.list().map(e => e.id)).toEqual(['recent']);
  });
  it('expires history on list access without creating a new activity', () => {
    const { store } = setup([done('recent')]);
    vi.setSystemTime(NOW + WEEK);
    expect(store.list()).toEqual([]);
  });
  it('keeps active/queued/unknown records even when older than seven days', () => {
    const { store } = setup(['running', 'queued', 'pending', 'unknown'].map(status => done(status, 2 * WEEK, { status })));
    expect(store.list()).toHaveLength(4);
  });
  it('keeps 100 newest terminal records in addition to active entries', () => {
    const rows = Array.from({ length: 105 }, (_, i) => done('done-' + i, i));
    const { store } = setup([...rows, done('active', 2 * WEEK, { status: 'running' })]);
    expect(store.list()).toHaveLength(101);
    expect(store.get('active')).not.toBeNull();
    expect(store.get('done-99')).not.toBeNull();
    expect(store.get('done-100')).toBeNull();
  });
  it('caps terminal history after add and update', () => {
    const { store } = setup(Array.from({ length: 100 }, (_, i) => done('done-' + i, i + 1)));
    store.add(done('new'));
    expect(store.get('done-99')).toBeNull();
    store.add(done('active', 0, { status: 'running' }));
    store.update('active', { status: 'error', finishedAt: NOW });
    expect(store.list()).toHaveLength(100);
    expect(store.get('active')?.status).toBe('error');
  });
  it('deletes a dedicated expired session but leaves unrelated files and task settings alone', () => {
    const { store, dir } = setup([done('entry', 0, { sessionFile: 'old.jsonl' })]);
    const history = path.join(dir, 'old.jsonl'); fs.writeFileSync(history, 'history');
    const task = path.join(root, 'cron-jobs.json'); fs.writeFileSync(task, 'task settings');
    const product = path.join(dir, 'result.pdf'); fs.writeFileSync(product, 'user output');
    vi.setSystemTime(NOW + WEEK);
    expect(store.list()).toEqual([]);
    expect(fs.existsSync(history)).toBe(false);
    expect(fs.readFileSync(task, 'utf8')).toBe('task settings');
    expect(fs.readFileSync(product, 'utf8')).toBe('user output');
  });
  it('does not delete session files still referenced by retained activities', () => {
    const { store, dir } = setup([done('old', 0, { sessionFile: 'shared.jsonl' }), done('active', 0, { status: 'running', sessionFile: 'shared.jsonl' })]);
    const shared = path.join(dir, 'shared.jsonl'); fs.writeFileSync(shared, 'shared');
    vi.setSystemTime(NOW + WEEK);
    expect(store.list().map(e => e.id)).toEqual(['active']);
    expect(fs.existsSync(shared)).toBe(true);
  });
  it.skipIf(process.platform !== 'win32')('protects shared file references with different Windows casing', () => {
    const { store, dir } = setup([done('old', 0, { sessionFile: 'shared.jsonl' }), done('active', 0, { status: 'running', sessionFile: 'SHARED.JSONL' })]);
    const shared = path.join(dir, 'shared.jsonl'); fs.writeFileSync(shared, 'shared');
    vi.setSystemTime(NOW + WEEK); store.list();
    expect(fs.existsSync(shared)).toBe(true);
  });
  it('never follows a traversal filename into normal sessions', () => {
    const outside = path.join(root, 'normal.jsonl'); fs.writeFileSync(outside, 'promoted');
    const { store } = setup([done('bad', WEEK, { sessionFile: '../normal.jsonl' })]);
    expect(store.list()).toEqual([]);
    expect(fs.readFileSync(outside, 'utf8')).toBe('promoted');
  });
  it('does not delete directories disguised with a jsonl extension', () => {
    const { store, dir } = setup([done('old', 0, { sessionFile: 'folder.jsonl' })]);
    const folder = path.join(dir, 'folder.jsonl'); fs.mkdirSync(folder);
    vi.setSystemTime(NOW + WEEK); store.list();
    expect(fs.statSync(folder).isDirectory()).toBe(true);
  });
  it('keeps index and session files intact when persisting the pruned index fails', () => {
    const { store, dir } = setup([done('entry', 0, { sessionFile: 'old.jsonl' })]);
    const session = path.join(dir, 'old.jsonl'); fs.writeFileSync(session, 'history');
    const save = vi.spyOn(store as any, '_save').mockImplementation(() => { throw new Error('disk failure'); });
    vi.setSystemTime(NOW + WEEK);
    expect(() => store.list()).toThrow('disk failure');
    expect(store.get('entry')).not.toBeNull();
    expect(fs.readFileSync(session, 'utf8')).toBe('history');
    save.mockRestore();
  });
  it('removes expired history through the existing list API without a new run', async () => {
    const { store } = setup([done('expired-on-next-read')]);
    const { Hono } = await import('hono');
    const { createDeskRoute } = await import('../server/routes/desk.ts');
    const engine = { listAgents: () => [{ id: 'test', name: 'Test' }], getActivityStore: () => store };
    const app = new Hono(); app.route('/api', createDeskRoute(engine, { eventBus: { emit: vi.fn() } }));
    vi.setSystemTime(NOW + WEEK);
    const response = await app.request('/api/desk/activities');
    expect(response.status).toBe(200);
    expect((await response.json()).activities).toEqual([]);
  });
  it('does not rewrite the index when no history is removed', () => {
    const { store } = setup([done('recent')]);
    const save = vi.spyOn(store as any, '_save');
    store.list(); store.list();
    expect(save).not.toHaveBeenCalled();
  });
});
