// Isolated MCP startup regression: a headless CLI must not replace the Desktop
// relay connection. Uses synthetic credentials and a non-existent test pipe.
import {mkdtemp,mkdir,writeFile,readFile} from 'node:fs/promises';
import {spawn} from 'node:child_process';
import {createInterface} from 'node:readline';
import path from 'node:path';
import os from 'node:os';
const root=await mkdtemp(path.join(os.tmpdir(),'shenlan-relay-ownership-')),directory=path.join(root,'shenlan-desktop-relay');await mkdir(directory);
const initial=JSON.stringify({executor:'11111111-1111-4111-8111-111111111111',token:'0'.repeat(64),endpoint:'\\\\.\\pipe\\shenlan-codex-'+'0'.repeat(32)});
await writeFile(path.join(directory,'settings.json'),JSON.stringify({executor:'11111111-1111-4111-8111-111111111111'}));await writeFile(path.join(directory,'connection.json'),initial);
const env=Object.fromEntries(Object.entries(process.env).filter(([key])=>['SYSTEMROOT','WINDIR','PATH','PATHEXT','TEMP','TMP'].includes(key.toUpperCase())));Object.assign(env,{CODEX_HOME:root,USERPROFILE:root});
const child=spawn(process.execPath,[path.resolve(process.argv[2]||'out/agent-host/native-companion.mjs')],{env,windowsHide:true,stdio:['pipe','pipe','pipe']});
const lines=createInterface({input:child.stdout});let stderr='';child.stderr.on('data',b=>{stderr+=b.toString()});
try{
 const receipt=new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('Isolated companion timeout')),15000);lines.on('line',line=>{const r=JSON.parse(line);if(r.id===2){clearTimeout(timer);resolve(r)}});child.once('error',reject)});
 child.stdin.write(JSON.stringify({jsonrpc:'2.0',id:1,method:'initialize'})+'\n');child.stdin.write(JSON.stringify({jsonrpc:'2.0',id:2,method:'tools/call',params:{name:'shenlan_relay_status'}})+'\n');await receipt;
 const unchanged=(await readFile(path.join(directory,'connection.json'),'utf8'))===initial;console.log(JSON.stringify({root,headlessCli:true,connectionPreserved:unchanged,diagnosticWarnings:Boolean(stderr)}));if(!unchanged)process.exitCode=1;
}finally{child.stdin.end();await new Promise(resolve=>child.once('exit',resolve));lines.close();}
