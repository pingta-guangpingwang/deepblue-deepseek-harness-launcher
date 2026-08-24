import { createHash } from 'node:crypto'
import { readFile, readdir } from 'node:fs/promises'
import path from 'node:path'

async function filesUnder(root, directory = root) {
  const files = []
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name)
    if (entry.isDirectory()) files.push(...await filesUnder(root, target))
    else if (entry.isFile()) files.push(path.relative(root, target).split(path.sep).join('/'))
  }
  return files.sort()
}

export async function launcherUiMetadata(rendererRoot) {
  const digest = createHash('sha256')
  const files = await filesUnder(rendererRoot)
  if (!files.includes('index.html')) throw new Error(`Launcher UI has no index.html: ${rendererRoot}`)
  for (const relative of files) {
    const body = await readFile(path.join(rendererRoot, ...relative.split('/')))
    digest.update(relative)
    digest.update('\0')
    digest.update(String(body.byteLength))
    digest.update('\0')
    digest.update(body)
  }
  const sha256 = digest.digest('hex')
  return {
    schemaVersion: 1,
    version: `ui-${sha256.slice(0, 16)}`,
    sha256,
    files: files.length
  }
}
