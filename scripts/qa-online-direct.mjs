import { chromium } from 'playwright';
import { build } from 'esbuild';
import { createServer, request as httpRequest } from 'node:http';
import { createHmac, createHash } from 'node:crypto';
import { once } from 'node:events';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import assert from 'node:assert/strict';
const root=path.resolve(import.meta.dirname,'..'),site=path.resolve(root,'../remove-codex-quota-release');
const output=path.join(root,'output/playwright/online-direct',String(Date.now()));await mkdir(output,{recursive:true});
await build({entryPoints:[path.join(root,'src/main/agent-host/online-channel.ts')],outfile:path.join(output,'online-channel.mjs'),platform:'node',format:'esm',bundle:true});
const {LocalOnlineChannel}=await import(pathToFileURL(path.join(output,'online-channel.mjs')));
const {LocalDirector}=await import(pathToFileURL(path.join(site,'packages/agent-connector/src/local-control/child.mjs')));
const {createRelayServer}=await import(pathToFileURL(path.join(site,'services/agent-relay/server.mjs')));
const secret='synthetic-test-only-online-direct-secret',owner='b'.repeat(64),deviceId='a'.repeat(32);
const ticket=(role,channel)=>{const payload=Buffer.from(JSON.stringify({v:2,role,owner,deviceId,channel,exp:Math.floor(Date.now()/1000)+60})).toString('base64url');return payload+'.'+createHmac('sha256',secret).update(payload).digest('base64url')};
const relay=createRelayServer({secret});relay.listen(0,'127.0.0.1');await once(relay,'listening');const relayBase='http://127.0.0.1:'+relay.address().port;
const project=path.join(output,'project');await mkdir(project,{recursive:true});
const director=new LocalDirector({directory:path.join(output,'local-state'),ownerId:owner,descriptors:[{id:'qa',name:'Synthetic',adapter:'codex',projects:[{id:'p',name:'Project',path:project}],capabilities:{approvalControl:true}}],execute:async()=>{throw Error('No model invocation authorized in this transport fixture')}});await director.initialize();
const {roomId}=await director.command('create_room',{name:'在线直读真实链路验收',members:[{id:'1'.repeat(32),displayName:'主控',mentionHandle:'主控',agentId:'qa',projectId:'p'}]});
director.store.transaction(()=>{for(let i=1;i<=10000;i++)director.store.append(roomId,'message',{authorType:'assistant',memberId:'1'.repeat(32),body:'合成在线历史 '+i});});
const fixtureFile='E:/ObsidianRes/obRes1/AIlishishu/tmp/pdfs/local-control/local-preview-acceptance.pdf';await director.command('attach_files',{roomId,paths:[fixtureFile]});
let hostRequests=0,fileRequests=0,channel;const originalFetch=globalThis.fetch;
globalThis.fetch=(url,init)=>originalFetch(String(url).replace('https://ailishishu.com/v2/local',relayBase+'/v2/local'),init);
channel=new LocalOnlineChannel({ticket:async c=>({relayUrl:'https://ailishishu.com/v2/local',token:ticket('host',c)}),request:async(command,input,id)=>{hostRequests++;if(command==='preview_file')fileRequests++;return director.command(command,input,id)},current:()=>true,changed:()=>{}});
const proxy=createServer(async(req,res)=>{
  const url=new URL(req.url,'http://localhost');
  if(url.pathname.startsWith('/v2/local/')){const upstream=httpRequest(relayBase+req.url,{method:req.method,headers:req.headers},incoming=>{res.writeHead(incoming.statusCode,incoming.headers);incoming.pipe(res)});upstream.on('error',()=>res.destroy());req.pipe(upstream);res.on('close',()=>upstream.destroy());return;}
  if(url.pathname==='/'){res.setHeader('content-type','text/html; charset=utf-8');res.end(`<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head><body style="margin:0"><div id="workbench" data-workspace-mode="local"><section id="agentOnlineWorkspace" style="height:95vh;padding:12px"></section></div><script>window.Auth={user:{id:'${owner}'}};window.agentWorkspaceRequest=async(action)=>action==='devices'?{devices:[{id:'${deviceId}',name:'隔离测试启动器'}]}:{relayUrl:location.origin+'/v2/local',token:'${ticket('viewer','d'.repeat(32))}',expiresAt:new Date(Date.now()+55000).toISOString()};window.showSaveFilePicker=undefined;</script><script type="module" src="/online-workspace.js"></script></body></html>`);return;}
  const relative=url.pathname.slice(1);if(!/^[\w./-]+$/.test(relative)||relative.includes('..')){res.writeHead(404);res.end();return;}
  try{const file=await readFile(path.join(root,'out/online-workspace',relative));res.setHeader('content-type',relative.endsWith('.js')?'application/javascript':'text/css');res.end(file)}catch{res.writeHead(404);res.end()}
});proxy.listen(0,'127.0.0.1');await once(proxy,'listening');const base='http://127.0.0.1:'+proxy.address().port;
const report={passed:false,output,realNetwork:true,syntheticIdentity:true,productionWrites:false,checks:[],pageErrors:[]};let browser;
try{
  channel.start();for(let i=0;i<100&&!relay.localOnline.stats().hosts;i++)await new Promise(r=>setTimeout(r,25));assert.equal(relay.localOnline.stats().hosts,1);
  browser=await chromium.launch({channel:'msedge',headless:true});const page=await browser.newPage({viewport:{width:1440,height:900},acceptDownloads:true});page.on('pageerror',e=>report.pageErrors.push(e.message));await page.goto(base);
  await page.getByRole('heading',{name:'在线直读真实链路验收'}).waitFor({timeout:20000});assert.equal(fileRequests,0);report.checks.push('actual browser → relay → Host channel → LocalDirector SQLite reads, without any file request');
  for(let i=0;i<5;i++){await page.getByRole('button',{name:'加载更早的本地记录',exact:true}).click();await page.waitForFunction(()=>!document.querySelector('#agentOnlineWorkspace').shadowRoot.querySelector('.lcr-older')?.disabled)}
  assert.ok(await page.locator('.lcr-message').count()<=120);await page.screenshot({path:path.join(output,'desktop-history.png')});report.checks.push('10,000 stored messages remain pageable with <=120 mounted rows');
  await page.getByRole('tab',{name:'文件',exact:true}).click();assert.equal(fileRequests,0);
  await page.getByRole('button',{name:'预览',exact:true}).click();await page.locator('canvas[data-rendered-page="1"]').waitFor({timeout:20000});assert.equal(fileRequests,1);
  await page.screenshot({path:path.join(output,'desktop-pdf.png')});report.checks.push('explicit preview streams the real PDF through relay without server storage');
  await page.getByRole('button',{name:'关闭文件预览'}).click();const downloadWait=page.waitForEvent('download');await page.getByRole('button',{name:'另存 local-preview-acceptance.pdf'}).click();const download=await downloadWait;const downloaded=path.join(output,'download.pdf');await download.saveAs(downloaded);assert.equal(createHash('sha256').update(await readFile(downloaded)).digest('hex'),createHash('sha256').update(await readFile(fixtureFile)).digest('hex'));report.checks.push('explicit download has exactly the source SHA-256');
  channel.stop();await page.getByRole('heading',{name:'启动器未连接'}).waitFor({timeout:10000});assert.equal(await page.locator('.lcr-message').count(),0);await page.screenshot({path:path.join(output,'desktop-offline.png')});report.checks.push('disconnection hides stale history and refuses offline execution');
  director.store.append(roomId,'message',{authorType:'assistant',body:'重新连接后读取的本机最新记录',memberId:'1'.repeat(32)});await new Promise(r=>setTimeout(r,100));channel.start();await page.getByRole('heading',{name:'在线直读真实链路验收'}).waitFor({timeout:15000});await page.getByRole('tab',{name:'对话',exact:true}).click();await page.getByText('重新连接后读取的本机最新记录',{exact:true}).waitFor({timeout:15000});report.checks.push('reconnection retrieves new local data rather than replaying a cloud snapshot');
  await page.setViewportSize({width:480,height:850});await page.screenshot({path:path.join(output,'mobile-online.png'),animations:'disabled'});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);assert.deepEqual(report.pageErrors,[]);report.passed=true;
}catch(error){report.error=error.stack;process.exitCode=1}
finally{await browser?.close();channel.stop();relay.localOnline.close();relay.closeAllConnections();relay.close();proxy.closeAllConnections();proxy.close();await director.close();globalThis.fetch=originalFetch;await writeFile(path.join(output,'report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));}
