import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  configureOmpNative, approvalGranted, guardVerdict,
  nativeGuidance, nativeModeState, nativeStatus, memoryCoexistenceWarning,
} from '../targets/omp-native.mjs';
import bridge from '../targets/omp-bridge.mjs';

function fakeRegistry(start={}, userKeys=[]) {
  const values = structuredClone(start), user = new Set(userKeys), calls=[];
  const lookup = key => ({
    get: () => values[key],
    isConfigured: () => user.has(key),
    override(_scope,value) {
      if (key === 'todo.midRunNudges' && value !== 'capped') throw Error('Invalid value');
      values[key] = value; calls.push([key,value]);
    },
  });
  return {values,calls,lookup};
}
const runtime = {pi:{settings:{}}};

test('Native OMP defaults enable stepped workers and suggest-only concurrency, not auto-parallel on',()=>{
  const r = fakeRegistry({'tools.approval':{bash:'prompt'},'memory.backend':'off'});
  const status=configureOmpNative(runtime,r.lookup);
  assert.equal(r.values['task.steps'], true);
  assert.equal(r.values['task.autoParallel'], 'suggest');
  assert.equal(status.effective['task.steps'], true);
  assert.equal(status.effective['task.autoParallel'], 'suggest');
  assert.equal(r.values['commit.enabled'], false);
  assert.deepEqual(r.values['tools.approval'],{bash:'prompt'});
  assert.ok(!r.calls.some(([key])=>key==='tools.approval'),'rsc never writes a per-tool policy');
  assert.equal(r.values['todo.midRunNudges'],'capped');
  assert.ok(status.applied.includes('task.steps'));
  assert.ok(!r.calls.some(([key])=>key==='todo.eager'));
});

test('Operator settings win, including explicit commits and eval allowances (with warnings)',()=>{
  const r=fakeRegistry({
    'task.steps':false,'task.autoParallel':'off','commit.enabled':true,
    'tools.approval':{bash:'deny',eval:'allow'},'todo.midRunNudges':'off',
  },['task.steps','task.autoParallel','commit.enabled','tools.approval','todo.midRunNudges']);
  const result=configureOmpNative(runtime,r.lookup);
  assert.equal(r.values['task.steps'],false);
  assert.equal(r.values['task.autoParallel'],'off');
  assert.equal(r.values['commit.enabled'],true);
  assert.equal(r.values['tools.approval'].bash,'deny');
  assert.equal(r.values['tools.approval'].eval,'allow');
  assert.ok(result.warnings.some(x=>x.includes('commit.enabled')));
  assert.ok(result.warnings.some(x=>x.includes('eval=allow')));
});

test('Bridge-applied defaults are not reported as operator-preserved in another scope',()=>{
  const state=new Map();
  const slot=(scope)=>{ if(!state.has(scope)) state.set(scope,{values:{},configured:new Set()}); return state.get(scope); };
  const lookup=(key)=>({
    get:(scope)=>slot(scope).values[key],
    isConfigured:(scope)=>slot(scope).configured.has(key),
    override:(scope,value)=>{ slot(scope).values[key]=value; slot(scope).configured.add(key); },
  });
  const first={pi:{settings:{}}},second={pi:{settings:{}}};
  const secondScope=second.pi.settings;
  slot(secondScope).values['task.steps']=false;
  slot(secondScope).configured.add('task.steps');
  const applied=configureOmpNative(first,lookup);
  assert.ok(applied.applied.includes('task.steps'));
  const report=configureOmpNative(second,lookup);
  assert.ok(report.preserved.includes('task.steps'),'the operator value in the second scope is preserved');
  assert.equal(report.effective['task.steps'],false);
});

test('A strict one-operation approval is required; UI answers and cached grants do not leak',()=>{
  assert.equal(approvalGranted('once'),true);
  for(const value of [undefined,null,'deny','session',true,{},'yes',{decision:'allow'}])
    assert.equal(approvalGranted(value),false,String(value));
});

test('Critical subprocess errors fail closed, valid no-output guards allow',()=>{
  assert.equal(guardVerdict(new Error('ETIMEDOUT'),'',true).decision,'deny');
  assert.equal(guardVerdict(new Error('killed'),'',false),null);
  assert.equal(guardVerdict(null,'garbage',true).decision,'deny');
  assert.equal(guardVerdict(null,'',true),null);
  assert.equal(guardVerdict(null,'{"hookSpecificOutput":{"permissionDecision":"deny"}}',true).decision,'deny');
  assert.equal(guardVerdict(null,'{"hookSpecificOutput":{"permissionDecision":"ask"}}',false).decision,'ask');
  assert.equal(guardVerdict(null,'{"hookSpecificOutput":{"permissionDecision":"allow"}}',true),null);
});

test('Native modes and guidance respect Plan, removed taskFile/blocked, and formal consent',()=>{
  const ctx={agent:{kind:'main'},sessionModes:{getState:()=>({plan:'active'})}};
  const pi={getActiveTools:()=>['task','ask','todo']};
  assert.equal(nativeModeState(ctx).plan,'active');
  const real = { plan: { status: 'active', planFilePath: 'local://PLAN.md' } };
  assert.equal(nativeModeState({ sessionModes: { getState: () => real } }).plan, 'active');
  assert.equal(nativeModeState({}, real).plan, 'active');
  assert.deepEqual(real.plan, { status: 'active', planFilePath: 'local://PLAN.md' });
  const msg=nativeGuidance(ctx,pi);
  for (const term of ['task.steps','task.autoParallel','taskFile','pending','ask({html})','Plan is ACTIVE','native /commit'])
    assert.match(msg,new RegExp(term.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')));
  assert.equal(nativeGuidance({agent:{kind:'sub'}},pi),'');
});

test('Native mode/settings and dual memory diagnostics are read-only',()=>{
  const project=mkdtempSync(join(tmpdir(),'omp-native-test-'));
  try {
    mkdirSync(join(project,'.rsc'));
    writeFileSync(join(project,'.rsc','danger-guard.mjs'),'ok');
    const r=fakeRegistry({'memory.backend':'local','commit.enabled':true,'tools.approval':{eval:'allow'},'session.worktreeScope':'directory'});
    const report=nativeStatus(runtime,r.lookup,{sessionModes:{getState:()=>({plan:'inactive'})}},project);
    assert.equal(report['memory.backend'],'local');
    assert.equal(report['session.worktreeScope'],'directory');
    assert.equal(report.guardFiles[0].present,true);
    assert.equal(report.guardFiles[1].present,false);
    assert.ok(report.notes.length>=2);
    assert.match(memoryCoexistenceWarning(r.lookup,runtime),/local/);
  } finally {rmSync(project,{recursive:true,force:true});}
});

test('Bridge registers OMP native events and preserves context on before_agent_start retries',async()=>{
  const project=mkdtempSync(join(tmpdir(),'omp-bridge-test-'));
  const previous=process.env.RSC_NO_UPDATE_CHECK;
  process.env.RSC_NO_UPDATE_CHECK='1';
  try {
    writeFileSync(join(project,'.rsc.json'),'{}');
    const handlers=new Map();const commands=new Map();
    const pi={on:(event,handler)=>handlers.set(event,handler),registerCommand:(name,o)=>commands.set(name,o),getActiveTools:()=>['task','ask','todo']};
    await bridge(pi);
    for(const name of ['session_clear','mode_changed','turn_start','before_subagent_spawn','before_agent_start'])
      assert.ok(handlers.has(name),`missing ${name}`);
    assert.ok(commands.has('rsc-native-status'));
    assert.ok(handlers.has('tool_result'));
    const ctx={cwd:project,mode:'tui',hasUI:true,agent:{kind:'main'},
      sessionManager:{getSessionId:()=> 'native-test'},sessionModes:{getState:()=>({plan:{status:'active'}})}};
    await handlers.get('session_start')({},ctx);
    const first=await handlers.get('before_agent_start')({reason:'prompt'},ctx);
    const second=await handlers.get('before_agent_start')({reason:'prompt'},ctx);
    assert.match(first.message.content,/Plan is ACTIVE/);
    assert.match(second.message.content,/Plan is ACTIVE/);
    const blocked=handlers.get('before_subagent_spawn')({agent:'developer'},ctx);
    assert.equal(blocked.block,true);
    const timeout = await handlers.get('tool_result')({toolName:'ask', details:{timedOut:true}},ctx);
    assert.match(timeout.additionalContext,/NOT explicit approval/);
    await handlers.get('session_clear')({},ctx);
    const third=await handlers.get('before_agent_start')({reason:'prompt'},ctx);
    assert.match(third.message.content,/Plan is ACTIVE/);
    handlers.get('turn_start')({},ctx);
    handlers.get('mode_changed')({state:{plan:'inactive'}},{...ctx,sessionModes:undefined});
    const inactive=await handlers.get('before_agent_start')({reason:'prompt'},{...ctx,sessionModes:undefined});
    assert.doesNotMatch(inactive.message.content,/Plan is ACTIVE/);
  } finally {
    if (previous===undefined) delete process.env.RSC_NO_UPDATE_CHECK; else process.env.RSC_NO_UPDATE_CHECK=previous;
    rmSync(project,{recursive:true,force:true});
  }
});

test('Guidance follows explicit operator settings, not the bridge defaults',()=>{
  const ctx={agent:{kind:'main'},sessionModes:{getState:()=>({plan:'inactive'})}};
  const pi={getActiveTools:()=>['task','todo','ask']};
  const off=nativeGuidance(ctx,pi,null,{effective:{'task.steps':false,'task.autoParallel':'off','commit.enabled':false}});
  assert.doesNotMatch(off,/use native task\.steps/);
  assert.match(off,/task\.steps is off/);
  assert.doesNotMatch(off,/autoParallel=suggest/);
  assert.match(off,/autoParallel=off/);
  assert.doesNotMatch(off,/are ENABLED/);
  const on=nativeGuidance(ctx,pi,null,{effective:{'task.steps':true,'task.autoParallel':'on','commit.enabled':true}});
  assert.match(on,/use native task\.steps/);
  assert.match(on,/autoParallel=on/);
  assert.match(on,/are ENABLED/);
  const warned=nativeGuidance(ctx,pi,null,{effective:{},warnings:['dual memory active']});
  assert.match(warned,/integration notices/);
  const quiet=nativeGuidance(ctx,pi,null,{effective:{},warnings:['dual memory active']},{warnings:false});
  assert.doesNotMatch(quiet,/integration notices/,'one-time warnings are withheld after the first turn');
});

test('A bridge copied without its native sibling still loads, blocks Plan and fails closed',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'omp-bridge-alone-'));
  const project=mkdtempSync(join(tmpdir(),'omp-alone-project-'));
  const previous=process.env.RSC_NO_UPDATE_CHECK;
  process.env.RSC_NO_UPDATE_CHECK='1';
  try {
    writeFileSync(join(project,'.rsc.json'),'{}');
    mkdirSync(join(project,'.rsc'));
    writeFileSync(join(project,'.rsc','danger-guard.mjs'),'process.exit(2);\n');
    copyFileSync(new URL('../targets/omp-bridge.mjs',import.meta.url),join(dir,'omp-bridge.mjs'));
    const {default:factory}=await import(pathToFileURL(join(dir,'omp-bridge.mjs')).href);
    const handlers=new Map();
    await factory({on:(name,fn)=>handlers.set(name,fn),getActiveTools:()=>['task']});
    assert.ok(handlers.has('session_start'),'the lifecycle still registers without the native module');
    assert.ok(handlers.has('tool_call'),'the bash guards still register without the native module');
    const ctx={cwd:project,mode:'tui',hasUI:false,agent:{kind:'main'},
      sessionManager:{getSessionId:()=>'alone'},sessionModes:{getState:()=>({plan:{status:'active'}})}};
    await handlers.get('session_start')({},ctx);
    const blocked=await handlers.get('before_subagent_spawn')({agent:'developer'},ctx);
    assert.equal(blocked?.block,true,'Plan mode still blocks the developer without the native module');
    const start=await handlers.get('before_agent_start')({reason:'prompt'},ctx);
    assert.match(start.message.content,/Plan is ACTIVE/,'the Plan warning survives without the native module');
    const denied=await handlers.get('tool_call')({toolName:'bash',input:{command:'echo hola'}},ctx);
    assert.equal(denied.block,true,'the local guard fallback still fails closed');
  } finally {
    if (previous===undefined) delete process.env.RSC_NO_UPDATE_CHECK; else process.env.RSC_NO_UPDATE_CHECK=previous;
    rmSync(dir,{recursive:true,force:true});
    rmSync(project,{recursive:true,force:true});
  }
});

test('A crashing critical guard blocks, including ship, and an optional crash allows',async()=>{
  const project=mkdtempSync(join(tmpdir(),'omp-guard-crash-'));
  const previous=process.env.RSC_NO_UPDATE_CHECK;
  process.env.RSC_NO_UPDATE_CHECK='1';
  try {
    writeFileSync(join(project,'.rsc.json'),'{}');
    mkdirSync(join(project,'.rsc'));
    const handlers=new Map();
    await bridge({on:(name,fn)=>handlers.set(name,fn),getActiveTools:()=>[]});
    const ctx={cwd:project,mode:'tui',hasUI:false,agent:{kind:'main'},sessionManager:{getSessionId:()=>'crash-test'}};
    await handlers.get('session_start')({},ctx);
    const run=()=>handlers.get('tool_call')({toolName:'bash',input:{command:'echo hola'}},ctx);
    // Ship alone: danger is well behaved, so only ship's critical flag can deny.
    writeFileSync(join(project,'.rsc','danger-guard.mjs'),'');
    writeFileSync(join(project,'.rsc','ship-guard.mjs'),'process.exit(3);\n');
    const ship=await run();
    assert.equal(ship.block,true,'a crashed ship guard must deny');
    assert.match(ship.reason,/critical guard/);
    // Danger alone.
    writeFileSync(join(project,'.rsc','danger-guard.mjs'),'process.exit(2);\n');
    writeFileSync(join(project,'.rsc','ship-guard.mjs'),'');
    const danger=await run();
    assert.equal(danger.block,true,'a crashed danger guard must deny');
    // Optional guard only: an internal failure must not brick the shell.
    writeFileSync(join(project,'.rsc','danger-guard.mjs'),'');
    writeFileSync(join(project,'.rsc','gitmoji-guard.mjs'),'process.exit(4);\n');
    assert.equal(await run(),undefined,'an optional guard crash still fails open');
  } finally {
    if (previous===undefined) delete process.env.RSC_NO_UPDATE_CHECK; else process.env.RSC_NO_UPDATE_CHECK=previous;
    rmSync(project,{recursive:true,force:true});
  }
});

test('The presenter compacts only finished cards and the status command answers',async(t)=>{
  const prior = process.env.RSC_OMP_COMPACT_TOOL_CARDS;
  process.env.RSC_OMP_COMPACT_TOOL_CARDS = '1';
  t.after(() => {
    if (prior === undefined) delete process.env.RSC_OMP_COMPACT_TOOL_CARDS;
    else process.env.RSC_OMP_COMPACT_TOOL_CARDS = prior;
  });
  const project=mkdtempSync(join(tmpdir(),'omp-status-cmd-'));
  try {
    writeFileSync(join(project,'.rsc.json'),'{}');
    mkdirSync(join(project,'.rsc'));
    writeFileSync(join(project,'.rsc','danger-guard.mjs'),'');
    let presenter=null;const commands=new Map();
    await bridge({
      pi:{settings:{}},on(){},registerTranscriptPresenter:(fn)=>{presenter=fn;},
      registerCommand:(name,options)=>commands.set(name,options),getActiveTools:()=>['task','todo','ask'],
    }, { lookup: key => ({ get: () => key === 'session.worktreeScope' ? 'directory' : undefined }) });
    assert.equal(presenter({type:'toolCall',toolName:'task'}),'compact');
    assert.equal(presenter({type:'toolCall',toolName:'todo'}),'compact');
    assert.equal(presenter({type:'toolCall',toolName:'task',isError:true}),undefined,'an error card stays visible');
    assert.equal(presenter({type:'toolCall',toolName:'todo',isPartial:true}),undefined,'a partial card stays visible');
    assert.equal(presenter({type:'toolCall',toolName:'bash'}),undefined);
    let notified=null;
    await commands.get('rsc-native-status').handler([],{
      cwd:project,ui:{notify:(text,level)=>{notified={text,level};}},
      sessionModes:{getState:()=>({plan:'inactive'})},
    });
    assert.equal(notified.level,'info');
    assert.match(notified.text,/rsc\/OMP native/);
    assert.match(notified.text,/tools\.approval\.eval=/,'the documented validation value is printed');
    assert.match(notified.text,/session\.worktreeScope=directory/);
    assert.match(notified.text,/danger-guard\.mjs:present/);
    assert.match(notified.text,/Settings registry: available/);
    assert.match(notified.text,/Native tools: task:active, todo:active, ask:active/);
  } finally { rmSync(project,{recursive:true,force:true}); }
});

test('guard notices are independent from authorization decisions', () => {
  assert.deepEqual(guardVerdict(null, '{"systemMessage":"Branch parked"}', true),
    { decision: 'allow', message: 'Branch parked' });
  for (const decision of ['allow', 'ask', 'deny']) {
    const verdict = guardVerdict(null, JSON.stringify({
      systemMessage: 'Recovery instructions',
      hookSpecificOutput: { permissionDecision: decision, permissionDecisionReason: 'Expected reason' },
    }), true);
    assert.equal(verdict.decision, decision);
    assert.equal(verdict.message, 'Recovery instructions');
    if (decision !== 'allow') assert.equal(verdict.reason, 'Expected reason');
  }
  assert.equal(guardVerdict(null, '{"systemMessage":"Ignored","hookSpecificOutput":{}}', true).decision, 'deny');
  assert.equal(guardVerdict(null, 'invalid', true).decision, 'deny');
  assert.equal(guardVerdict(null, '', true), null);
});
