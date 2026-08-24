import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { validateLauncherUiRoot } from './launcher-ui'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function fixture(html: string): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'deepblue-launcher-ui-'))
  roots.push(root)
  await mkdir(path.join(root, 'renderer', 'assets'), { recursive: true })
  await writeFile(path.join(root, 'renderer', 'index.html'), html)
  await writeFile(path.join(root, 'renderer', 'assets', 'app.js'), 'document.body.dataset.hot = "ready"')
  return root
}

describe('launcher UI hot-update entry validation', () => {
  it('accepts a complete renderer module with local assets', async () => {
    const root = await fixture('<!doctype html><html lang="zh-CN"><head><meta charset="UTF-8"></head><body><div id="root"></div><script type="module" src="./assets/app.js"></script></body></html>')
    expect(await validateLauncherUiRoot(root)).toBe(path.join(root, 'renderer', 'index.html'))
  })

  it('rejects missing and traversal assets before switching the active UI', async () => {
    const missing = await fixture('<!doctype html><html lang="zh-CN"><body><div id="root"></div><script type="module" src="./assets/missing.js"></script></body></html>')
    const traversal = await fixture('<!doctype html><html lang="zh-CN"><body><div id="root"></div><script type="module" src="./../escape.js"></script></body></html>')
    expect(await validateLauncherUiRoot(missing)).toBeUndefined()
    expect(await validateLauncherUiRoot(traversal)).toBeUndefined()
  })
})
