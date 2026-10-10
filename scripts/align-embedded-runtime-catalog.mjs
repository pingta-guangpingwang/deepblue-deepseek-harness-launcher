// Keep an already-published dependency graph in a new shell. Only trusted signed
// input is accepted; UI and Agent Host stay on this build's candidate versions.
import assert from 'node:assert/strict'
import { createPublicKey } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { verifyRuntimeCatalogManifest } from './runtime-catalog-validation.mjs'
const root=path.resolve(import.meta.dirname,'..'), input=process.argv[2]||process.env.LAUNCHER_EMBEDDED_BASELINE_CATALOG
if(!input) throw Error('Provide the verified production catalog file')
const baseline=JSON.parse(await readFile(path.resolve(input),'utf8'))
const key=createPublicKey(await readFile(path.join(root,'resources/runtime-update-public-key.pem')))
assert.ok(verifyRuntimeCatalogManifest(baseline,key),'Baseline signature or runtime graph is invalid')
const target=path.join(root,'release/win-unpacked/resources/resources/runtime-modules.generated.json')
const generated=JSON.parse(await readFile(target,'utf8'))
const dsh02=process.env.LAUNCHER_RELEASE_DSH02==='1'
if(dsh02) {
 const pkg=JSON.parse(await readFile(path.join(root,'package.json'),'utf8'))
 assert.equal(pkg.version,'0.10.37')
 assert.equal(generated.modules.find(m=>m.id==='harness-core')?.version,'0.2.1-alpha.2')
 assert.equal(baseline.payload.runtimeModules.find(m=>m.id==='harness-core')?.version,'0.1.1-rc.2')
}
const preserved=dsh02?['node-runtime','package-manager']:['node-runtime','harness-core','package-manager']
for(const id of preserved) {
 const index=generated.modules.findIndex(m=>m.id===id),existing=baseline.payload.runtimeModules.find(m=>m.id===id)
 assert.ok(index>=0&&existing,'Missing baseline dependency')
 // Do not silently undo an intentional dependency version upgrade.
 assert.equal(generated.modules[index].version,existing.version,`Version upgrade for ${id} needs its own release`)
 generated.modules[index]=existing
}
await writeFile(target,JSON.stringify(generated,null,2)+'\n')
if(dsh02) {
 const record=path.join(root,'release/runtime-modules.generated.json')
 const runtime=JSON.parse(await readFile(record,'utf8'))
 for(const id of preserved) {
  const index=runtime.modules.findIndex(m=>m.id===id)
  assert.ok(index>=0)
  assert.equal(runtime.modules[index].version,baseline.payload.runtimeModules.find(m=>m.id===id).version)
  runtime.modules[index]=baseline.payload.runtimeModules.find(m=>m.id===id)
 }
 await writeFile(record,JSON.stringify(runtime,null,2)+'\n')
}
console.log('Preserved signed dependency definitions: '+preserved.join(', ')+'; intentional DSH 0.2/UI/Host candidates retained.')
