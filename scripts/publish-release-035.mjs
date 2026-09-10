// One-release operator. Immutable artifacts first; public pointers only after QA.
import assert from 'node:assert/strict'
import { createHash, createHmac, createPublicKey } from 'node:crypto'
import { readFile, realpath, writeFile } from 'node:fs/promises'
import https from 'node:https'
import path from 'node:path'
import { fetchBoundedBytes } from './bounded-fetch.mjs'
import { verifyRuntimeCatalogManifest } from './runtime-catalog-validation.mjs'
const mode=process.argv[2], root=path.resolve(import.meta.dirname,'..'), release=path.join(root,'release')
assert.ok(['check','artifacts','pointers'].includes(mode),'Use check, artifacts or pointers')
const sha=b=>createHash('sha256').update(b).digest('hex')
const planBytes=await readFile(path.join(release,'release-035-plan.json'))
assert.equal(sha(planBytes),'34e37f2c4a7410004e31dd7340a77b5380f40ff5e5bbad7bbc2bca79515e4914')
const plan=JSON.parse(planBytes), bucket='ailishishu-deepseek-harness', hostname=bucket+'.oss-cn-beijing.aliyuncs.com'
const objectPath=key=>'/'+key.split('/').map(encodeURIComponent).join('/'), publicUrl=key=>'https://'+hostname+objectPath(key)
const catalogKey='release-v2/launcher-manifest.json'
const candidateBytes=await readFile(path.join(release,'launcher-manifest.035.json')), candidate=JSON.parse(candidateBytes)
const beforeBytes=await readFile(path.join(release,'launcher-manifest.before-035.json')), before=JSON.parse(beforeBytes)
const key=createPublicKey(await readFile(path.join(root,'resources/runtime-update-public-key.pem')))
assert.equal(sha(beforeBytes),plan.baselineSha256)
for(const value of [before,candidate]) assert.ok(verifyRuntimeCatalogManifest(value,key),'Invalid signature or catalog graph')
assert.equal(candidate.payload.launcher.version,'0.10.35');assert.ok(Date.parse(candidate.payload.generatedAt)>Date.parse(before.payload.generatedAt))
assert.deepEqual(Object.keys(candidate.payload).sort(),Object.keys(before.payload).sort())
for(const field of Object.keys(before.payload)) if(!['generatedAt','launcher','runtimeModules'].includes(field)) assert.deepEqual(candidate.payload[field],before.payload[field])
assert.deepEqual(candidate.payload.runtimeModules.map(m=>m.id),before.payload.runtimeModules.map(m=>m.id))
for(const old of before.payload.runtimeModules) {
 const current=candidate.payload.runtimeModules.find(m=>m.id===old.id)
 if(!['agent-host','launcher-ui'].includes(old.id)) assert.deepEqual(current,old)
 else { const item=plan.items.find(i=>i.file.startsWith('modules/'+old.id+'-'));assert.equal(current.artifacts[0].sha256,item.sha256);assert.equal(current.artifacts[0].size,item.size);assert.deepEqual(current.artifacts[0].mirrors.map(m=>m.id),['oss','github']) }
}
assert.deepEqual(candidate.payload.launcher.artifacts,[{platform:'win32',arch:'x64',distribution:'online',url:publicUrl(plan.alias.key),sha256:plan.alias.sha256,size:plan.alias.size}])
const bodies=new Map()
for(const item of plan.items) { const b=await readFile(path.join(release,item.file));assert.equal(b.length,item.size);assert.equal(sha(b),item.sha256);bodies.set(item.key,b) }
const get=async(key,max)=>fetchBoundedBytes(publicUrl(key),{maxBytes:max,redirect:'error',timeoutMs:120000})
const live=await get(catalogKey,256*1024)
assert.equal(live.response.status,200);assert.ok([plan.baselineSha256,sha(candidateBytes)].includes(sha(live.bytes)),'Live catalog moved')
if(mode==='check'){console.log(JSON.stringify({ok:true,mode,items:plan.items.length,baselineSha256:plan.baselineSha256,candidateSha256:sha(candidateBytes)}))}
else {
// Credentials stay external and are never logged or accepted inline.
const profilePath=await realpath(process.env.OSS_PUBLISHER_PROFILE||'')
const outside=p=>{const r=path.relative(root,p);return r==='..'||r.startsWith('..'+path.sep)||path.isAbsolute(r)}
assert.ok(outside(profilePath))
const profile=JSON.parse((await readFile(profilePath,'utf8')).replace(/^\uFEFF/,''))
const exact=(v,keys)=>v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).every(k=>keys.includes(k))
assert.ok(exact(profile,['profile','provider','endpoint','region','bucket','credentialFile','defaultObjectAcl','scope']))
assert.equal(profile.provider,'aliyun-oss');assert.equal(profile.region,'oss-cn-beijing');assert.equal(profile.bucket,bucket);assert.equal(profile.scope,'bucket-only');assert.equal(profile.defaultObjectAcl,'public-read')
assert.equal(new URL(profile.endpoint).href,'https://oss-cn-beijing.aliyuncs.com/')
const credentialPath=await realpath(path.resolve(path.dirname(profilePath),profile.credentialFile)), relative=path.relative(path.dirname(profilePath),credentialPath)
assert.ok(relative&&!relative.startsWith('..')&&!path.isAbsolute(relative)&&outside(credentialPath))
const document=JSON.parse((await readFile(credentialPath,'utf8')).replace(/^\uFEFF/,'')), credential=document.AccessKey
assert.ok(exact(document,['AccessKey','RequestId'])&&exact(credential,['AccessKeyId','AccessKeySecret','CreateDate','Status']))
assert.equal(credential.Status,'Active');assert.ok(credential.AccessKeyId&&credential.AccessKeySecret)
async function put(key,body,immutable) {
 const type=key.endsWith('.json')?'application/json; charset=utf-8':key.endsWith('.exe')?'application/vnd.microsoft.portable-executable':'application/octet-stream'
 const date=new Date().toUTCString(),md5=createHash('md5').update(body).digest('base64')
 const headers={...(immutable?{'x-oss-forbid-overwrite':'true'}:{}),'x-oss-object-acl':'public-read'}
 const canonical=Object.entries(headers).sort(([a],[b])=>a.localeCompare(b)).map(([k,v])=>`${k}:${v}\n`).join('')
 const signature=createHmac('sha1',credential.AccessKeySecret).update(`PUT\n${md5}\n${type}\n${date}\n${canonical}/${bucket}/${key}`).digest('base64')
 return new Promise((resolve,reject)=>{
  const req=https.request({hostname,port:443,method:'PUT',path:objectPath(key),headers:{Host:hostname,Date:date,'Content-Type':type,'Content-Length':body.length,'Content-MD5':md5,...headers,Authorization:`OSS ${credential.AccessKeyId}:${signature}`}},response=>{response.resume();response.on('end',()=>response.headers['x-oss-version-id']?reject(Error('Versioned bucket unsupported')):resolve(response.statusCode))})
  req.setTimeout(120000,()=>req.destroy(Error('OSS upload timeout')));req.on('error',reject);req.end(body)
 })
}
async function verify(key,body) {const r=await get(key,Math.max(4096,body.length));assert.equal(r.response.status,200);assert.equal(r.bytes.length,body.length);assert.equal(sha(r.bytes),sha(body));return r}
// Confirm actual overwrite exclusion before relying on immutable release claims.
const probeKey='release-v2/locks/forbid-overwrite-capability-v1.json',probe=Buffer.from('{"schemaVersion":1,"purpose":"verify x-oss-forbid-overwrite before runtime publication"}\n')
await verify(probeKey,probe);assert.equal(await put(probeKey,probe,true),409)
const receipt={mode,createdAt:new Date().toISOString(),candidateSha256:sha(candidateBytes),verified:[]}
if(mode==='artifacts') {
 for(const item of plan.items) {
  const body=bodies.get(item.key),existing=await get(item.key,Math.max(4096,item.size))
  if(existing.response.status===404) {const status=await put(item.key,body,true);assert.ok([200,409].includes(status),`Upload HTTP ${status}`)}
  else {assert.equal(existing.response.status,200);assert.equal(sha(existing.bytes),item.sha256,'Immutable object differs')}
  await verify(item.key,body);receipt.verified.push({key:item.key,sha256:item.sha256,size:item.size});console.log(JSON.stringify(receipt.verified.at(-1)))
 }
} else {
 assert.equal(process.env.CONFIRM_RELEASE_035,'publish-0.10.35-after-public-install-smoke')
 const gate=JSON.parse(await readFile(path.join(release,'release-035-public-qa.json'),'utf8'))
 assert.equal(gate.passed,true);assert.equal(gate.bootstrapSha256,plan.alias.sha256);assert.equal(gate.shellSha256,plan.items.find(i=>i.file.endsWith('.7z')).sha256)
 for(const item of plan.items) {
  await verify(item.key,bodies.get(item.key))
  const github=`https://github.com/pingta-guangpingwang/deepblue-deepseek-harness-launcher/releases/download/${item.githubTag}/${path.basename(item.file)}`
  const remote=await fetchBoundedBytes(github,{maxBytes:item.size,allowedRedirectHosts:['github.com','.githubusercontent.com'],maxRedirects:5,timeoutMs:120000})
  assert.equal(remote.response.status,200);assert.equal(remote.bytes.length,item.size);assert.equal(sha(remote.bytes),item.sha256)
 }
 const lockKey=`release-v2/locks/manifest-from-${plan.baselineSha256}.json`,lock=Buffer.from(JSON.stringify({schemaVersion:1,fromSha256:plan.baselineSha256,toSha256:sha(candidateBytes),launcherVersion:'0.10.35'})+'\n')
 const status=await put(lockKey,lock,true);assert.ok([200,409].includes(status));await verify(lockKey,lock)
 const check=await get(catalogKey,256*1024);assert.equal(check.response.status,200);assert.ok([plan.baselineSha256,sha(candidateBytes)].includes(sha(check.bytes)))
 const alias=await get(plan.alias.key,2*1024*1024);assert.equal(alias.response.status,200);assert.ok([plan.previousAliasSha256,plan.alias.sha256].includes(sha(alias.bytes)),'Stable alias moved')
 const body=bodies.get(plan.items.find(i=>i.file===plan.alias.file).key)
 if(sha(alias.bytes)!==plan.alias.sha256) assert.equal(await put(plan.alias.key,body,false),200)
 await verify(plan.alias.key,body)
 if(sha(check.bytes)!==sha(candidateBytes)) assert.equal(await put(catalogKey,candidateBytes,false),200)
 await verify(catalogKey,candidateBytes);receipt.verified.push({key:plan.alias.key,sha256:plan.alias.sha256},{key:catalogKey,sha256:sha(candidateBytes)})
}
await writeFile(path.join(release,`release-035-${mode}-receipt.json`),JSON.stringify(receipt,null,2)+'\n')
console.log(JSON.stringify({ok:true,mode,verified:receipt.verified.length}))
}
