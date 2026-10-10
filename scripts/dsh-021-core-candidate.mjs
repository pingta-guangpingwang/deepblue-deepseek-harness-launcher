import { cp, mkdir, readFile, writeFile, stat, rename } from 'node:fs/promises'
import { createReadStream } from 'node:fs'
import { createHash } from 'node:crypto'
import path from 'node:path'
import * as tar from 'tar'
const runtime = path.resolve(process.argv[2])
const output = path.resolve(import.meta.dirname, '../output/dsh-021-candidate')
await mkdir(output, { recursive: true })
const manifest = JSON.parse(await readFile(path.join(runtime, 'node_modules/@deepseek-ai/dsh/package.json'), 'utf8'))
const lock = JSON.parse(await readFile(path.join(runtime, 'package-lock.json'), 'utf8'))
const integrity = 'sha512-CkRE0uAOg2ldL2VpfF4cNRsl178CH5nM+8YklPrlMZl5ln0KhVfd42dJuRlgOXZmkpizCRvrVS8LAL+GKfgk0w=='
if (manifest.version !== '0.2.1-alpha.2' || lock.packages['node_modules/@deepseek-ai/dsh'].integrity !== integrity) throw new Error('Official package pin mismatch')
let archive = path.join(output, 'harness-core-0.2.1-alpha.2-next.tar.gz')
await tar.c({ file: archive, cwd: runtime, gzip: { level: 6, mtime: 0 }, portable: true, mtime: new Date(0), strict: true }, ['node_modules', 'package.json', 'package-lock.json'])
const digest = createHash('sha256')
for await (const chunk of createReadStream(archive)) digest.update(chunk)
const sha256 = digest.digest('hex')
const addressed = path.join(output, `harness-core-0.2.1-alpha.2-${sha256.slice(0, 16)}-candidate.tar.gz`)
await rename(archive, addressed)
archive = addressed
const coldRoot = path.join(output, 'cold-install')
await mkdir(coldRoot, { recursive: true })
await tar.x({ file: archive, cwd: coldRoot, strict: true, preservePaths: false })
await cp(path.resolve(import.meta.dirname, '../node_modules/node/bin/node.exe'), path.join(coldRoot, 'node.exe'))
const report = { version: manifest.version, channel: 'preview', upstreamTag: 'dsh-v0.2.1-alpha.2', upstreamCommit: 'd743267388641bc76f17c45ce8b4c231aed1d32c', npmIntegrity: integrity, file: archive, sha256, size: (await stat(archive)).size, coldRoot, acceptance: 'Official core protocol candidate; synthetic task is not real-model acceptance; not a launcher release.' }
await writeFile(path.join(output, 'core-candidate.json'), JSON.stringify(report, null, 2) + '\n')
console.log(JSON.stringify(report, null, 2))
