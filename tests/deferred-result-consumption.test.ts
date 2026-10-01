import {afterEach,describe,expect,it,vi} from 'vitest';
import {DeferredResultStore} from '../lib/deferred-result-store.ts';
import {DeferredResultCoordinator} from '../lib/deferred-result-coordinator.ts';
import {createCheckDeferredTool} from '../lib/tools/check-deferred-tool.ts';
const disposables:Array<{dispose():void}>=[];
afterEach(()=>{for(const x of disposables.splice(0))x.dispose();});
function fixture(){
  const store=new (DeferredResultStore as any)(); disposables.push(store);
  let busy=true;
  const queued:any[]=[];
  const delivery={deliverCustomMessage:vi.fn(async(_path:any,msg:any,opts:any)=>{
    if(!opts.shouldDeliver())return {mode:'suppressed'};
    if(busy&&opts.requireIdle)throw new Error('session_busy');
    queued.push(msg);return {mode:busy?'followUp':'triggerTurn'};
  })};
  const coordinator=new DeferredResultCoordinator({store,sessionCoordinator:delivery,retryIntervalMs:0,log:{warn:vi.fn()}});
  coordinator.start();disposables.push(coordinator);
  const tool=createCheckDeferredTool({getDeferredStore:()=>store,getSessionPath:()=>'/parent'});
  return {store,coordinator,queued,delivery,tool,idle:()=>{busy=false;}};
}
describe('background result exactly-once consumption',()=>{
  it('does not enqueue a future wake for a busy parent that reads the result itself',async()=>{
    const f=fixture();f.store.defer('a','/parent',{type:'subagent',deliveryIntent:'trigger_parent_turn'});f.store.resolve('a','complete review');
    await f.coordinator.deliverTask('a');expect(f.queued).toEqual([]);
    const answer=await f.tool.execute('check',{},undefined,undefined,{sessionManager:{getSessionFile:()=>'/parent'}});
    expect(answer.content[0].text).toContain('complete review');
    expect(f.store.query('a')).toMatchObject({delivered:true,observedVia:'check_pending_tasks'});
    f.idle();await f.coordinator.flushUndelivered();expect(f.queued).toEqual([]);
  });
  it('unread results still wake the parent when idle',async()=>{
    const f=fixture();f.store.defer('a','/parent',{type:'subagent'});f.store.resolve('a','done');
    await f.coordinator.deliverTask('a');expect(f.queued).toHaveLength(0);
    f.idle();await f.coordinator.flushUndelivered();expect(f.queued).toHaveLength(1);
    await f.coordinator.flushUndelivered();expect(f.queued).toHaveLength(1);
  });
  it('never acknowledges another session, pending tasks, or successful bridge/UI-only media',async()=>{
    const f=fixture();f.store.defer('other','/other',{type:'subagent'});f.store.resolve('other','other result');
    f.store.defer('pending','/parent',{type:'subagent'});
    f.store.defer('image','/parent',{type:'image-generation',deliveryIntent:'ui_only',deliveryTarget:{kind:'bridge'}});f.store.resolve('image',{fileId:'sf_fake'});
    await f.tool.execute('check',{},undefined,undefined,{sessionManager:{getSessionFile:()=>'/parent'}});
    expect(f.store.query('other').observedAt).toBeUndefined();expect(f.store.query('pending').delivered).toBe(false);expect(f.store.query('image').delivered).toBe(false);
  });
  it('a result too large to return safely is not silently acknowledged; taskId narrows the query',async()=>{
    const f=fixture();f.store.defer('huge','/parent',{type:'subagent'});f.store.resolve('huge','x'.repeat(40000));
    f.store.defer('small','/parent',{type:'subagent'});f.store.resolve('small','small result');
    await f.tool.execute('check',{},undefined,undefined,{sessionManager:{getSessionFile:()=>'/parent'}});
    expect(f.store.query('huge').observedAt).toBeUndefined();
    const answer=await f.tool.execute('check',{taskId:'small'},undefined,undefined,{sessionManager:{getSessionFile:()=>'/parent'}});
    expect(answer.content[0].text).not.toContain('huge');expect(f.store.query('small').observedAt).toBeTypeOf('number');
  });
  it('retry clears observation and a stale delivery receipt cannot consume the new generation',()=>{
    const f=fixture();f.store.defer('a','/parent',{type:'subagent'});f.store.resolve('a','first');
    const old=f.store.query('a');f.store.markObserved('a','/parent',old.generation);
    f.store.retry('a','/parent',{type:'subagent'});f.store.resolve('a','second');
    expect(f.store.markDelivered('a',old.generation)).toBe(false);
    expect(f.store.query('a').observedAt).toBeUndefined();expect(f.store.query('a').delivered).toBe(false);
  });
});
