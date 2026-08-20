import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import * as tar from 'tar'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RuntimeModuleRelease } from '../shared/types'
import { RuntimeModuleStore } from './runtime-modules'

const roots: string[] = []

function responseBody(buffer: Buffer): ArrayBuffer {
  return Uint8Array.from(buffer).buffer
}

afterEach(async () => {
  vi.unstubAllGlobals()
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function fixture(version: string, contents: string): Promise<{ module: RuntimeModuleRelease; archive: Buffer }> {
  const root = await mkdtemp(path.join(tmpdir(), 'deepblue-runtime-module-fixture-'))
  roots.push(root)
  await mkdir(path.join(root, 'payload', 'bin'), { recursive: true })
  await mkdir(path.join(root, 'payload', 'node_modules', '@scope', 'package'), { recursive: true })
  await writeFile(path.join(root, 'payload', 'bin', 'runtime.txt'), contents)
  await writeFile(path.join(root, 'payload', 'node_modules', '@scope', 'package', 'package.json'), '{"name":"@scope/package"}\n')
  const archivePath = path.join(root, `${version}.tar.gz`)
  await tar.c({ cwd: path.join(root, 'payload'), file: archivePath, gzip: true }, ['bin', 'node_modules'])
  const archive = await readFile(archivePath)
  return {
    archive,
    module: {
      id: 'node-runtime',
      version,
      required: true,
      installWhen: 'harness',
      dependencies: [],
      artifacts: [{
        platform: 'win32',
        arch: 'x64',
        format: 'tar.gz',
        sha256: createHash('sha256').update(archive).digest('hex'),
        size: archive.byteLength,
        unpackedSize: 4_096,
        mirrors: [
          { id: 'gitee', url: `https://gitee.com/wanggp123/deepseek-harness-launcher/releases/download/${version}/node.tar.gz` },
          { id: 'github', url: `https://github.com/pingta-guangpingwang/deepblue-deepseek-harness-launcher/releases/download/${version}/node.tar.gz` }
        ]
      }]
    }
  }
}

describe('runtime module store', () => {
  it('falls back between mirrors, verifies, installs and reuses an immutable module', async () => {
    const installationRoot = await mkdtemp(path.join(tmpdir(), 'deepblue-runtime-modules-'))
    roots.push(installationRoot)
    const item = await fixture('24.16.0', 'node-runtime-v1')
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response('rate limited', { status: 429 }))
      .mockResolvedValueOnce(new Response(responseBody(item.archive), { status: 200, headers: { 'content-length': String(item.archive.byteLength) } }))
    vi.stubGlobal('fetch', fetchMock)
    const store = new RuntimeModuleStore(installationRoot)
    const progress: string[] = []
    const installed = await store.install(item.module, [item.module], 'win32', 'x64', (entry) => progress.push(`${entry.phase}:${entry.mirrorId || ''}`))
    expect(installed.reused).toBe(false)
    expect(installed.mirrorId).toBe('github')
    expect(await readFile(path.join(installed.root, 'bin', 'runtime.txt'), 'utf8')).toBe('node-runtime-v1')
    expect(await readFile(path.join(installed.root, 'node_modules', '@scope', 'package', 'package.json'), 'utf8')).toContain('@scope/package')
    expect(await store.activeRoot('node-runtime')).toBe(installed.root)
    expect(progress).toContain('verify:github')

    const reused = await store.install(item.module, [item.module], 'win32', 'x64')
    expect(reused.reused).toBe(true)
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('keeps the previous immutable version available for atomic rollback', async () => {
    const installationRoot = await mkdtemp(path.join(tmpdir(), 'deepblue-runtime-rollback-'))
    roots.push(installationRoot)
    const first = await fixture('24.16.0', 'first')
    const second = await fixture('24.17.0', 'second')
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(new Response(responseBody(first.archive), { status: 200 }))
      .mockResolvedValueOnce(new Response(responseBody(second.archive), { status: 200 })))
    const store = new RuntimeModuleStore(installationRoot)
    await store.install(first.module, [first.module], 'win32', 'x64')
    const active = await store.install(second.module, [second.module], 'win32', 'x64')
    expect(await readFile(path.join(active.root, 'bin', 'runtime.txt'), 'utf8')).toBe('second')
    const rolledBack = await store.rollback('node-runtime')
    expect(await readFile(path.join(rolledBack, 'bin', 'runtime.txt'), 'utf8')).toBe('first')
    expect(await store.activeRoot('node-runtime')).toBe(rolledBack)
  })

  it('rejects a downloaded artifact that does not match the signed digest', async () => {
    const installationRoot = await mkdtemp(path.join(tmpdir(), 'deepblue-runtime-reject-'))
    roots.push(installationRoot)
    const item = await fixture('24.16.0', 'trusted')
    const tampered = Buffer.from(item.archive)
    tampered[tampered.length - 1] = tampered[tampered.length - 1]! ^ 0xff
    vi.stubGlobal('fetch', vi.fn().mockImplementation(() => Promise.resolve(new Response(responseBody(tampered), { status: 200 }))))
    const store = new RuntimeModuleStore(installationRoot)
    await expect(store.install(item.module, [item.module], 'win32', 'x64')).rejects.toThrow('SHA-256 校验失败')
    expect(await store.activeRoot('node-runtime')).toBeUndefined()
  })
})
