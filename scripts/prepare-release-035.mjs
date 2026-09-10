import assert from 'node:assert/strict'
import { createHash, createPublicKey } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fetchBoundedBytes } from './bounded-fetch.mjs'
import { verifyRuntimeCatalogManifest } from './runtime-catalog-validation.mjs'
const root = path.resolve(import.meta.dirname, '..'), dir = path.join(root, 'release')
const sha = bytes => createHash('sha256').update(bytes).digest('hex')
const json = async file => JSON.parse(await readFile(path.join(dir,file),'utf8'))
const url = 'https://ailishishu-deepseek-harness.oss-cn-beijing.aliyuncs.com/release-v2/launcher-manifest.json'
const response = await fetchBoundedBytes(url,{ maxBytes: 256*1024, redirect:'error' })
assert.equal(response.response.status,200)
const before = JSON.parse(response.bytes), key = createPublicKey(await readFile(path.join(root,'resources/runtime-update-public-key.pem')))
assert.ok(verifyRuntimeCatalogManifest(before,key)); assert.equal(before.payload.launcher.version,'0.10.34')
const modules = await json('runtime-modules.generated.json'), shell = await json('launcher-shell.generated.json'), windows = await json('windows-artifacts.json')
assert.equal(shell.version,'0.10.35'); assert.equal(shell.sha256,'eb77bd356c6a37eda6e111b67be3058610b4fdf16cd4d75baebc6c76d992aae3')
const ui = modules.modules.find(m=>m.id==='launcher-ui'), host = modules.modules.find(m=>m.id==='agent-host')
// This release publishes only the verified OSS and GitHub mirrors.
for (const module of [ui, host]) for (const artifact of module.artifacts) artifact.mirrors=artifact.mirrors.filter(m=>['oss','github'].includes(m.id))
assert.equal(ui.version,'ui-9aeb4cd5205a4e07');assert.equal(ui.artifacts[0].sha256,'ac829e501cc4368acfe9df3eacc2d5414bd0e2f80ff0c7e9a6914e25cf093b22')
assert.equal(host.version,'1.0.0+64e1b81d45e2');assert.equal(host.artifacts[0].sha256,'aa28af665c0eaadb5e205a33a1804c23043bd1b06722570bffab3c2178ff8c34')
const online = windows.find(w=>w.edition==='online'); assert.equal(online.sha256,'c95cc22d9edc1552e2164c9505ecd3ca73503924a92945fd00fea090f6f339c7')
const payload=structuredClone(before.payload)
payload.generatedAt=new Date().toISOString()
payload.runtimeModules=payload.runtimeModules.map(m=>m.id==='launcher-ui'?ui:m.id==='agent-host'?host:m)
payload.launcher={...payload.launcher,version:'0.10.35',notes:[
 '本地群聊支持多角色执行、同目录排队取消和可选 Git worktree；原生单聊跨轮续接，独立窗口共享同一会话。',
 '网页工作区在线读取本机历史及主动打开的文件；离线明确断开，不保存云端聊天正文、文件正文或离线指令。',
 '修复官方 Claude 原生程序发现与桌面桥接连接归属，加固目录选择取消和重复打开；不修改全局 Codex 配置。',
 ...payload.launcher.notes
],artifacts:[{platform:'win32',arch:'x64',distribution:'online',url:'https://ailishishu-deepseek-harness.oss-cn-beijing.aliyuncs.com/download/deepblue-deepseek-harness-launcher-win-x64-online.exe',sha256:online.sha256,size:online.size}]}
const items=[]
for (const m of [host,ui]) { const a=m.artifacts[0], mirror=a.mirrors.find(x=>x.id==='oss'), name=decodeURIComponent(new URL(mirror.url).pathname.split('/').pop());items.push({key:`modules/${name}`,file:`modules/${name}`,sha256:a.sha256,size:a.size,githubTag:m.id==='agent-host'?`agent-host-${m.version}`:`launcher-ui-${m.version}`}) }
items.push({key:`modules/${shell.fileName}`,file:shell.fileName,sha256:shell.sha256,size:shell.size,githubTag:'runtime-v0.10.35'})
for (const w of windows) items.push({key:`download/${w.fileName}`,file:w.fileName,sha256:w.sha256,size:w.size,githubTag:'v0.10.35'})
// First launch can use the embedded catalog before the online catalog arrives.
// Publish any rebuilt dependency archive even when the stable catalog is retained.
for (const m of modules.modules.filter(m=>['node-runtime','harness-core','package-manager'].includes(m.id))) {
 const a=m.artifacts[0], old=before.payload.runtimeModules.find(x=>x.id===m.id).artifacts[0]
 if(a.sha256===old.sha256) continue
 const mirror=a.mirrors.find(x=>x.id==='oss'), name=decodeURIComponent(new URL(mirror.url).pathname.split('/').pop()), gh=a.mirrors.find(x=>x.id==='github')
 items.push({key:`modules/${name}`,file:`modules/${name}`,sha256:a.sha256,size:a.size,githubTag:decodeURIComponent(new URL(gh.url).pathname.split('/').at(-2))})
}
for (const item of items) {const b=await readFile(path.join(dir,item.file));assert.equal(b.length,item.size);assert.equal(sha(b),item.sha256)}
const alias=await fetchBoundedBytes(payload.launcher.artifacts[0].url,{maxBytes:2*1024*1024,redirect:'error'});assert.equal(alias.response.status,200)
const plan={schemaVersion:1,version:'0.10.35',sourceCommit:'d95e0f7071861402dde356b4134de1467481c2ba',baselineSha256:sha(response.bytes),baselineGeneratedAt:before.payload.generatedAt,previousAliasSha256:sha(alias.bytes),items,alias:{key:'download/deepblue-deepseek-harness-launcher-win-x64-online.exe',file:online.fileName,sha256:online.sha256,size:online.size}}
await writeFile(path.join(dir,'launcher-manifest.before-035.json'),response.bytes)
await writeFile(path.join(dir,'launcher-online.before-035.exe'),alias.bytes)
await writeFile(path.join(dir,'launcher-catalog-035-payload.json'),JSON.stringify(payload,null,2)+'\n')
await writeFile(path.join(dir,'release-035-plan.json'),JSON.stringify(plan,null,2)+'\n')
console.log(JSON.stringify({baselineSha256:plan.baselineSha256,baselineGeneratedAt:plan.baselineGeneratedAt,oldModules:before.payload.runtimeModules.map(m=>({id:m.id,version:m.version})),planSha256:sha(await readFile(path.join(dir,'release-035-plan.json'))),items:items.map(i=>({file:i.file,size:i.size}))}))
