import { copyFile, link, rm, stat, writeFile } from 'node:fs/promises'
import { createReadStream } from 'node:fs'
import { createHash } from 'node:crypto'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const release = path.join(projectRoot, 'release')
const packageJson = JSON.parse(await (await import('node:fs/promises')).readFile(path.join(projectRoot, 'package.json'), 'utf8'))
const version = packageJson.version
const specs = [
  {
    edition: 'online',
    fileName: `deepblue-deepseek-harness-launcher-${version}-win-x64-online.exe`,
    alias: '深蓝DeepSeekHarness启动器-在线轻量版.exe',
    stableAlias: 'deepblue-deepseek-harness-launcher-win-x64-online.exe'
  },
  {
    edition: 'offline',
    fileName: `deepblue-deepseek-harness-launcher-${version}-win-x64-offline.exe`,
    alias: '深蓝DeepSeekHarness启动器-完整离线版.exe',
    stableAlias: 'deepblue-deepseek-harness-launcher-win-x64-offline.exe'
  }
]

async function sha256(file) {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(file)) hash.update(chunk)
  return hash.digest('hex')
}

const artifacts = []
for (const spec of specs) {
  const target = path.join(release, spec.fileName)
  const alias = path.join(release, spec.alias)
  const stableAlias = path.join(release, spec.stableAlias)
  if (path.dirname(target) !== release || path.dirname(alias) !== release || path.dirname(stableAlias) !== release) {
    throw new Error('Artifact path escaped the release directory.')
  }
  const info = await stat(target)
  for (const publicAlias of [alias, stableAlias]) {
    await rm(publicAlias, { force: true })
    try {
      await link(target, publicAlias)
    } catch {
      await copyFile(target, publicAlias)
    }
  }
  artifacts.push({ edition: spec.edition, fileName: spec.fileName, size: info.size, sha256: await sha256(target) })
}

await writeFile(path.join(release, 'windows-artifacts.json'), `${JSON.stringify(artifacts, null, 2)}\n`, 'utf8')
console.log(JSON.stringify(artifacts, null, 2))
