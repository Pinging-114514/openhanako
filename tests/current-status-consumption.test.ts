import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {afterEach, describe, expect, it, vi} from 'vitest';
import {createCurrentStatusTool} from '../lib/tools/current-status-tool.ts';
import {DeferredResultStore} from '../lib/deferred-result-store.ts';
import {DeferredResultCoordinator} from '../lib/deferred-result-coordinator.ts';
import {SubagentThreadStore} from '../lib/subagent-thread-store.ts';

const PARENT = '/sessions/status-parent.jsonl';
const OTHER = '/sessions/status-other.jsonl';
const cleanup: Array<() => void> = [];
afterEach(() => { for (const dispose of cleanup.splice(0)) dispose(); });
const ctx = (sessionPath = PARENT) => ({sessionManager:{getSessionFile:()=>sessionPath}});
function fixture() {
  const results = new DeferredResultStore(null, null);
  const threads = new SubagentThreadStore();
  cleanup.push(() => results.dispose());
  const tool = createCurrentStatusTool({getDeferredStore:()=>results,listOpenSubagentThreads:(sp)=>threads.listOpenDirectBySession(sp)});
  const start = (taskId: string, threadId = 'thread', parent = PARENT, meta = {}) => {
    results.defer(taskId, parent, {type:'subagent',threadId,deliveryIntent:'trigger_parent_turn',...meta});
    threads.beginRun(threadId, {taskId,kind:'direct',parentSessionPath:parent,summary:'working'});
  };
  const finish = (taskId: string, text: string, threadId = 'thread', status = 'resolved') => {
    if (status === 'resolved') results.resolve(taskId, text);
    else if (status === 'failed') results.fail(taskId, text);
    else results.abort(taskId, text);
    threads.finishRun(threadId, {status,summary:text,close:false});
  };
  const read = (signal: AbortSignal | null = null) => tool.execute('status', {action:'get',key:'subagents'}, signal, null, ctx());
  return {results,threads,tool,start,finish,read};
}

describe('current_status(subagents) result consumption', () => {
  it('prevents a second wake when status already returned the completed result while the parent was busy', async () => {
    const f = fixture();
    let busy = true;
    const wakes: unknown[] = [];
    const delivery = new DeferredResultCoordinator({store:f.results,retryIntervalMs:0,log:{warn:vi.fn()},sessionCoordinator:{
      deliverCustomMessage:async (_sp, message, options) => {
        if (!options.shouldDeliver()) return {mode:'suppressed'};
        if (busy && options.requireIdle) throw new Error('session_busy');
        wakes.push(message);return {mode:'triggerTurn'};
      },
    }});
    delivery.start();cleanup.push(() => delivery.dispose());
    f.start('run-a');f.finish('run-a','complete audit result');
    await delivery.deliverTask('run-a');
    expect(wakes).toHaveLength(0);
    const output = await f.read();
    expect(JSON.parse(output.content[0].text).subagents.open[0]).toMatchObject({lastRunTaskId:'run-a',summary:'complete audit result'});
    expect(output.details.observedTaskIds).toEqual(['run-a']);
    expect(f.results.query('run-a')).toMatchObject({delivered:true,observedVia:'current_status.subagents'});
    busy = false;await delivery.flushUndelivered();expect(wakes).toHaveLength(0);
  });

  it('acknowledges only the exact latest run even when two runs have identical text', async () => {
    const f=fixture();f.start('old');f.finish('old','same result');f.start('new');f.finish('new','same result');
    await f.read();
    expect(f.results.query('old').delivered).toBe(false);
    expect(f.results.query('new').delivered).toBe(true);
  });

  it('does not consume a queued continuation that has not started', async () => {
    const f=fixture();f.start('old');f.finish('old','old result');
    f.results.defer('queued',PARENT,{type:'subagent',threadId:'thread'});
    await f.read();
    expect(f.results.query('old').delivered).toBe(true);
    expect(f.results.query('queued').delivered).toBe(false);
  });

  it('does not consume pending-run task descriptions, even if a description equals an old result', async () => {
    const f=fixture();f.start('old');f.finish('old','working');f.start('new');
    await f.read();
    expect(f.results.query('old').delivered).toBe(false);
    expect(f.results.query('new').delivered).toBe(false);
  });

  it('holds the snapshot identity when another continuation completes during the async return boundary', async () => {
    const f=fixture();f.start('old');f.finish('old','old report');
    const reading=f.read();
    f.start('new');f.finish('new','new report');
    const output=await reading;
    expect(JSON.parse(output.content[0].text).subagents.open[0].summary).toBe('old report');
    expect(f.results.query('old').delivered).toBe(true);
    expect(f.results.query('new').delivered).toBe(false);
  });

  it('cannot consume a new generation of the same taskId using an older observation', async () => {
    const f=fixture();f.start('reused');f.finish('reused','same text');
    const reading=f.read();
    f.results.retry('reused',PARENT,{type:'subagent',threadId:'thread'});f.results.resolve('reused','same text');
    await reading;
    expect(f.results.query('reused').delivered).toBe(false);
  });

  it.each(['failed', 'aborted'])('observes the exact terminal reason for %s runs', async (status) => {
    const f=fixture();f.start('a');f.finish('a','terminal reason','thread',status);
    await f.read();
    expect(f.results.query('a')).toMatchObject({status,delivered:true,observedVia:'current_status.subagents'});
  });

  it('listing status keys and querying unrelated status never consumes subagent results', async () => {
    const f=fixture();f.start('a');f.finish('a','result');
    await f.tool.execute('list',{action:'list'},null,null,ctx());
    await f.tool.execute('time',{action:'get',key:'time'},null,null,ctx());
    expect(f.results.query('a').delivered).toBe(false);
  });

  it('does not mark a shortened summary as the full result', async () => {
    const f=fixture();f.start('a');f.finish('a','the complete report with its final conclusions');
    f.threads.finishRun('thread',{status:'resolved',summary:'the complete report',close:false});
    await f.read();expect(f.results.query('a').delivered).toBe(false);
  });

  it('does not acknowledge output exceeding the UTF-8 byte budget', async () => {
    const f=fixture();f.start('a');f.finish('a','汉'.repeat(12000));
    const output=await f.read();
    expect(f.results.query('a').delivered).toBe(false);
    expect(output.content[1].text).toContain('NOT been marked observed');
  });

  it('does not mark results observed when the query is aborted before return', async () => {
    const f=fixture();f.start('a');f.finish('a','result');
    const controller=new AbortController();const reading=f.read(controller.signal);controller.abort();
    await reading;expect(f.results.query('a').delivered).toBe(false);
  });

  it('keeps another parent session untouched even if a status provider returns a foreign thread', async () => {
    const f=fixture();f.start('foreign','foreign-thread',OTHER);f.finish('foreign','foreign report','foreign-thread');
    const tool=createCurrentStatusTool({getDeferredStore:()=>f.results,listOpenSubagentThreads:()=>f.threads.listOpenDirectBySession(OTHER)});
    await tool.execute('status',{action:'get',key:'subagents'},null,null,ctx());
    expect(f.results.query('foreign').delivered).toBe(false);
  });

  it.each([{deliveryIntent:'ui_only'},{deliveryIntent:'notify_ui_only'},{deliveryTarget:{kind:'bridge'}},{type:'image-generation'}])('does not consume UI/Bridge media delivery: %j', async (meta) => {
    const f=fixture();f.start('a','thread',PARENT,meta);f.finish('a','result');
    await f.read();expect(f.results.query('a').delivered).toBe(false);
  });

  it('recovers legacy run identity only from a unique exact full result in the same session', async () => {
    const f=fixture();f.start('a');f.finish('a','unique full report');
    f.threads.upsert('thread',{lastRunTaskId:null});
    const output=await f.read();
    expect(JSON.parse(output.content[0].text).subagents.open[0].lastRunTaskId).toBe('a');
    expect(f.results.query('a').delivered).toBe(true);
  });

  it('does not guess a run id for ambiguous legacy summaries', async () => {
    const f=fixture();f.start('a');f.finish('a','same');f.start('b');f.finish('b','same');
    f.threads.upsert('thread',{lastRunTaskId:null});
    await f.read();
    expect(f.results.query('a').delivered).toBe(false);expect(f.results.query('b').delivered).toBe(false);
  });

  it('persists the exact run identity, preserves it on finish, and clears it on identity-less begin', () => {
    const root=fs.mkdtempSync(path.join(os.tmpdir(),'hana-status-run-'));cleanup.push(()=>fs.rmSync(root,{recursive:true,force:true}));
    const file=path.join(root,'threads.json');const store=new SubagentThreadStore(file);
    store.beginRun('thread',{taskId:'a',parentSessionPath:PARENT});store.finishRun('thread',{status:'resolved',summary:'a result'});
    store.beginRun('thread',{taskId:'b',parentSessionPath:PARENT});store.finishRun('thread',{status:'resolved',summary:'b result'});
    const reloaded=new SubagentThreadStore(file);
    expect(reloaded.get('thread').lastRunTaskId).toBe('b');
    reloaded.beginRun('thread',{parentSessionPath:PARENT});expect(reloaded.get('thread').lastRunTaskId).toBeNull();
  });
});
