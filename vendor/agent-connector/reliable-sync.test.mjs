import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,readdir,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {commandExpired,syncFailurePolicy} from './src/command-lifecycle.mjs';
import {AgentConnector,selectRunnableCommands} from './src/connector.mjs';
import {LocalStateStore} from './src/state.mjs';
import {runtimeReadiness} from './src/runtime-health.mjs';
import {HostChildController} from './src/host-child.mjs';
test('explicit Beijing SQL deadline, invalid deadline, future and legacy',()=>{
 const now=Date.parse('2026-09-22T04:00:00Z');
 assert.equal(commandExpired({expires_at:'2026-09-22 12:00:00'},now),true);
 assert.equal(commandExpired({expires_at:'2026-09-22T04:00:01Z'},now),false);
 assert.equal(commandExpired({expires_at:'broken'},now),true);
 assert.equal(commandExpired({},now),false);
});
test('expired task cannot enter runnable set; finals reserve lanes',()=>{
 const items=[{id:'old',command_type:'run_task',expires_at:'2000-01-01T00:00:00Z'},{id:'new',command_type:'run_task'}];
 assert.deepEqual(selectRunnableCommands(items,new Map()).map(x=>x.command.id),['new']);
});
test('dependency repair bounded; auth and network failures are not discarded',()=>{
 const command={command_type:'refresh_session_history'};
 assert.equal(syncFailurePolicy(command,{status:409,code:'history_session_not_synced'}),'repair_catalog');
 assert.equal(syncFailurePolicy({...command,_catalogRepairAttempts:2},{status:409,code:'history_session_not_synced'}),'archive');
 assert.equal(syncFailurePolicy(command,{status:401}),'wait_auth');
 assert.equal(syncFailurePolicy(command,{status:500}),'retry');
});
test('80 expired history commands archived with results intact, no execution or network',async()=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'reliable-sync-'));
 try{
 const store=new LocalStateStore(path.join(root,'state.json'));const state=await store.load();
 state.pendingCommands=Array.from({length:80},(_,i)=>({id:'old-'+i,command_type:'refresh_session_history',expires_at:'2026-01-01T00:00:00Z',_localStatus:i<6?'final_pending':'pending',_localFinal:i<6?{reply:'preserved-'+i}:undefined}));await store.save(state);
 const connector=new AgentConnector({adapterCode:'codex',stateFile:store.filePath},{store,api:{request(){throw Error('unexpected network');}},logger:{}});
 connector.state=state;await connector.drainCommandsOnce();
 assert.equal(connector.state.pendingCommands.length,0);assert.equal(connector.state.commandArchive.length,80);
 const files=await readdir(store.filePath+'.archive');assert.equal(files.length,80);
 const archived=await Promise.all(files.map(f=>readFile(path.join(store.filePath+'.archive',f),'utf8').then(JSON.parse)));
 assert.equal(archived.filter(x=>x.command._localFinal).length,6);
 assert.equal((await store.load()).pendingCommands.length,0);
 }finally{await rm(root,{recursive:true,force:true});}
});
test('archive failure leaves active record in place',async()=>{
 const command={id:'keep',command_type:'refresh_session_history',expires_at:'2000-01-01T00:00:00Z'};
 const connector=new AgentConnector({adapterCode:'codex',stateFile:'unused'},{store:{archiveCommand:async()=>{throw Error('disk full');}},api:{},logger:{}});
 connector.state={pendingCommands:[command]};await assert.rejects(connector.drainCommandsOnce(),/disk full/);assert.equal(connector.state.pendingCommands[0],command);
});
test('health maps controlled codes without leaking error message',()=>{
 const r=runtimeReadiness(null,{code:'ENOENT',message:'secret-key private-path'});assert.equal(r.status,'not_installed');assert.ok(!JSON.stringify(r).includes('secret-key'));
 assert.equal(runtimeReadiness(null,{code:'ECONNREFUSED'}).code,'gateway_unreachable');
 assert.equal(runtimeReadiness(null,{status:401}).status,'needs_login');
 assert.equal(runtimeReadiness(true).status,'ready');
});
test('host IPC preserves structured health code, redacts detail, and never reports stopped as ready',async()=>{
 const host=new HostChildController({probeRuntime:async()=>{throw Object.assign(new Error('private'),{code:'ECONNREFUSED'});}});
 host.connector={config:{},runningTasks:new Map(),state:{pendingCommands:[]}};host.phase='ready';
 await host.checkReadiness({});const status=host.emitStatus();assert.equal(status.runtimeReady,false);assert.equal(status.health.code,'gateway_unreachable');assert.ok(!JSON.stringify(status).includes('private'));
 host.phase='stopped';assert.equal(host.emitStatus().runtimeStatus,'stopped');
});
