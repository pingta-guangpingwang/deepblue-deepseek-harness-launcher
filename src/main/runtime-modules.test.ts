import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import * as tar from 'tar'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RuntimeModuleRelease } from '../shared/types'
import { readRuntimeDownloadChunk, RuntimeModuleStore } from './runtime-modules'

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
          { id: 'oss', url: `https://ailishishu-deepseek-harness.oss-cn-beijing.aliyuncs.com/modules/${version}/node.tar.gz` },
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
    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      if (init?.method === 'HEAD') return new Response(null, { status: 200 })
      if (String(url).includes('gitee.com')) return new Response('rate limited', { status: 429 })
      return new Response(responseBody(item.archive), { status: 200, headers: { 'content-length': String(item.archive.byteLength) } })
    })
    vi.stubGlobal('fetch', fetchMock)
    const store = new RuntimeModuleStore(installationRoot)
    const progress: string[] = []
    const installed = await store.install(item.module, [item.module], 'win32', 'x64', (entry) => progress.push(`${entry.phase}:${entry.mirrorId || ''}`))
    expect(installed.reused).toBe(false)
    expect(installed.mirrorId).toBe('oss')
    expect(await readFile(path.join(installed.root, 'bin', 'runtime.txt'), 'utf8')).toBe('node-runtime-v1')
    expect(await readFile(path.join(installed.root, 'node_modules', '@scope', 'package', 'package.json'), 'utf8')).toContain('@scope/package')
    expect(await store.activeRoot('node-runtime')).toBe(installed.root)
    expect(progress).toEqual(expect.arrayContaining([
      'source-check:gitee',
      'source-ready:gitee',
      'source-fallback:gitee',
      'source-check:oss',
      'source-ready:oss',
      'verify:oss',
      'activate:oss'
    ]))

    const reused = await store.install(item.module, [item.module], 'win32', 'x64')
    expect(reused.reused).toBe(true)
    expect(fetchMock).toHaveBeenCalledTimes(4)
  })

  it('keeps the previous immutable version available for atomic rollback', async () => {
    const installationRoot = await mkdtemp(path.join(tmpdir(), 'deepblue-runtime-rollback-'))
    roots.push(installationRoot)
    const first = await fixture('24.16.0', 'first')
    const second = await fixture('24.17.0', 'second')
    vi.stubGlobal('fetch', vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      if (init?.method === 'HEAD') return new Response(null, { status: 200 })
      const archive = String(url).includes('24.17.0') ? second.archive : first.archive
      return new Response(responseBody(archive), { status: 200 })
    }))
    const store = new RuntimeModuleStore(installationRoot)
    await store.install(first.module, [first.module], 'win32', 'x64')
    const active = await store.install(second.module, [second.module], 'win32', 'x64')
    expect(await readFile(path.join(active.root, 'bin', 'runtime.txt'), 'utf8')).toBe('second')
    const rolledBack = await store.rollback('node-runtime')
    expect(await readFile(path.join(rolledBack, 'bin', 'runtime.txt'), 'utf8')).toBe('first')
    expect(await store.activeRoot('node-runtime')).toBe(rolledBack)
  })

  it('switches directly from an unavailable Gitee mirror to OSS without waiting for GitHub', async () => {
    const installationRoot = await mkdtemp(path.join(tmpdir(), 'deepblue-runtime-channel-probe-'))
    roots.push(installationRoot)
    const item = await fixture('24.16.0', 'probe-before-download')
    const calls: Array<{ url: string; method: string }> = []
    vi.stubGlobal('fetch', vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), method: String(init?.method || 'GET') })
      if (init?.method === 'HEAD') {
        return String(url).includes('gitee.com') ? new Response(null, { status: 404 }) : new Response(null, { status: 200 })
      }
      return new Response(responseBody(item.archive), { status: 200 })
    }))
    const progress: string[] = []
    const store = new RuntimeModuleStore(installationRoot)
    const result = await store.install(item.module, [item.module], 'win32', 'x64', (entry) => progress.push(`${entry.phase}:${entry.mirrorId || ''}`))
    expect(result.mirrorId).toBe('oss')
    expect(calls.filter((call) => call.method === 'GET')).toEqual([
      expect.objectContaining({ url: expect.stringContaining('aliyuncs.com') })
    ])
    expect(calls.some((call) => call.url.includes('github.com'))).toBe(false)
    expect(progress).toContain('source-fallback:gitee')
    expect(progress).toContain('download:oss')
  })

  it('reassembles and verifies signed Gitee parts before installing the module', async () => {
    const installationRoot = await mkdtemp(path.join(tmpdir(), 'deepblue-runtime-gitee-parts-'))
    roots.push(installationRoot)
    const item = await fixture('24.16.0', 'gitee-parts')
    const splitAt = Math.max(1, Math.floor(item.archive.byteLength / 2))
    const parts = [item.archive.subarray(0, splitAt), item.archive.subarray(splitAt)]
    const gitee = item.module.artifacts[0]!.mirrors[0]!
    gitee.parts = parts.map((part, index) => ({
      url: `${gitee.url}.part${String(index + 1).padStart(3, '0')}`,
      sha256: createHash('sha256').update(part).digest('hex'),
      size: part.byteLength
    }))
    gitee.url = gitee.parts[0]!.url
    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      if (init?.method === 'HEAD') return new Response(null, { status: 200 })
      const index = Number(String(url).match(/part(\d+)$/)?.[1] || 0) - 1
      const body = parts[index]
      if (!body) return new Response(null, { status: 404 })
      return new Response(responseBody(body), { status: 200, headers: { 'content-length': String(body.byteLength) } })
    })
    vi.stubGlobal('fetch', fetchMock)
    const progress: string[] = []
    const store = new RuntimeModuleStore(installationRoot)
    const installed = await store.install(item.module, [item.module], 'win32', 'x64', (entry) => {
      if (entry.message) progress.push(entry.message)
    })
    expect(installed.mirrorId).toBe('gitee')
    expect(await readFile(path.join(installed.root, 'bin', 'runtime.txt'), 'utf8')).toBe('gitee-parts')
    expect(progress).toContain('Gitee 分片 1/2')
    expect(progress).toContain('Gitee 分片 2/2')
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes('aliyuncs.com'))).toBe(false)
  })

  it('rejects a body read after sustained zero-byte progress', async () => {
    const stream = new ReadableStream<Uint8Array>({ start: () => undefined })
    const reader = stream.getReader()
    await expect(readRuntimeDownloadChunk(reader, 20)).rejects.toThrow('持续 1 秒无下载进度')
    await reader.cancel()
  })

  it('rejects a downloaded artifact that does not match the signed digest', async () => {
    const installationRoot = await mkdtemp(path.join(tmpdir(), 'deepblue-runtime-reject-'))
    roots.push(installationRoot)
    const item = await fixture('24.16.0', 'trusted')
    const tampered = Buffer.from(item.archive)
    tampered[tampered.length - 1] = tampered[tampered.length - 1]! ^ 0xff
    vi.stubGlobal('fetch', vi.fn(async (_url: string | URL | Request, init?: RequestInit) => init?.method === 'HEAD'
      ? new Response(null, { status: 200 })
      : new Response(responseBody(tampered), { status: 200 })))
    const store = new RuntimeModuleStore(installationRoot)
    await expect(store.install(item.module, [item.module], 'win32', 'x64')).rejects.toThrow('SHA-256 校验失败')
    expect(await store.activeRoot('node-runtime')).toBeUndefined()
  })
})
