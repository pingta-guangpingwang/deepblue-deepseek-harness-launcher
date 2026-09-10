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
for(const id of ['node-runtime','harness-core','package-manager']) {
 const index=generated.modules.findIndex(m=>m.id===id),existing=baseline.payload.runtimeModules.find(m=>m.id===id)
 assert.ok(index>=0&&existing,'Missing baseline dependency')
 // Do not silently undo an intentional dependency version upgrade.
 assert.equal(generated.modules[index].version,existing.version,`Version upgrade for ${id} needs its own release`)
 generated.modules[index]=existing
}
await writeFile(target,JSON.stringify(generated,null,2)+'\n')
console.log('Embedded dependency definitions match the signed baseline; candidate UI and Host retained.')
