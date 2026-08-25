import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { parse } from 'yaml'
import type { PersistedConfig } from './config'

const runtime = vi.hoisted(() => ({ root: '' }))

vi.mock('electron', () => ({
  app: { getPath: () => runtime.root },
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (value: string) => Buffer.from(value, 'utf8'),
    decryptString: (value: Buffer) => value.toString('utf8')
  }
}))

import { ModelStore } from './model-store'

function config(): PersistedConfig {
  return {
    settings: {} as PersistedConfig['settings'],
    activeVersion: 'test',
    workspaces: [],
    resourceLibrary: [],
    modelRouting: {
      active: { provider: 'deepseek-official', model: 'deepseek-v4-flash' },
      providers: [{
        id: 'deepseek-official', name: 'DeepSeek 官方', api: 'deepseek',
        baseURL: 'https://api.deepseek.com', apiKeyEnv: 'DEEPSEEK_API_KEY',
        models: [
          { id: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash' },
          { id: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro' }
        ],
        custom: false
      }]
    }
  }
}

describe('ModelStore two-way Harness synchronization', () => {
  let store: ModelStore | undefined

  beforeEach(async () => {
    runtime.root = await mkdtemp(path.join(tmpdir(), 'deepblue-model-sync-'))
    await mkdir(path.join(runtime.root, 'harness-data'), { recursive: true })
    await writeFile(path.join(runtime.root, 'model-secrets.json'), `${JSON.stringify({
      version: 1,
      values: { DEEPSEEK_API_KEY: Buffer.from('launcher-initial').toString('base64') }
    })}\n`)
  })

  afterEach(async () => {
    delete process.env.DEEPSEEK_API_KEY
    store?.dispose()
    store = undefined
    await rm(runtime.root, { recursive: true, force: true })
  })

  it('migrates launcher secrets, writes launcher edits, then imports web edits live', async () => {
    const pushed: string[] = []
    store = new ModelStore(config(), (state) => { if (state.message) pushed.push(state.message) })
    await store.initialize()

    const credentialsPath = path.join(runtime.root, 'harness-data', '.credentials.yaml')
    expect(parse(await readFile(credentialsPath, 'utf8'))).toEqual({ version: 1, refs: { DEEPSEEK_API_KEY: 'launcher-initial' } })
    expect(await store.environment()).toEqual({ DEEPSEEK_API_KEY: undefined })

    await store.saveProvider({
      id: 'deepseek-official', name: 'ignored', api: 'deepseek', baseURL: 'https://wrong.example',
      apiKey: 'launcher-updated', models: [{ id: 'deepseek-v4-flash', name: 'ignored' }], custom: false
    })
    expect(parse(await readFile(credentialsPath, 'utf8'))).toEqual({ version: 1, refs: { DEEPSEEK_API_KEY: 'launcher-updated' } })

    await new Promise(resolve => setTimeout(resolve, 500))
    await writeFile(path.join(runtime.root, 'harness-data', 'settings.yaml'), `agent-default-model:\n  provider: deepseek-official\n  model: deepseek-v4-pro\nllm-deepseek:\n  baseURL: https://api.deepseek.com\n  apiKeyEnv: DEEPSEEK_API_KEY\n  models:\n    - id: deepseek-v4-pro\n      name: DeepSeek V4 Pro\n`)
    await vi.waitFor(() => {
      expect(store?.state().active.model).toBe('deepseek-v4-pro')
      expect(pushed).toContain('已同步 Harness 网页中的模型与默认选择')
    }, { timeout: 6_000, interval: 100 })

    await new Promise(resolve => setTimeout(resolve, 500))
    await writeFile(credentialsPath, 'version: 1\nrefs:\n  DEEPSEEK_API_KEY: web-updated\n')
    await vi.waitFor(() => {
      expect(pushed).toContain('已同步 Harness 网页中更新的 API Key')
    }, { timeout: 6_000, interval: 100 })
    const secretDocument = JSON.parse(await readFile(path.join(runtime.root, 'model-secrets.json'), 'utf8')) as { values: Record<string, string> }
    expect(Buffer.from(secretDocument.values.DEEPSEEK_API_KEY!, 'base64').toString('utf8')).toBe('web-updated')
  }, 10_000)

  it('recovers a legacy environment key only before Harness creates its credential document', async () => {
    await writeFile(path.join(runtime.root, 'model-secrets.json'), `${JSON.stringify({ version: 1, values: {} })}\n`)
    process.env.DEEPSEEK_API_KEY = 'legacy-environment-key'
    const migrated = config()
    migrated.modelRouting.credentialSyncVersion = 1
    store = new ModelStore(migrated)
    await store.initialize()

    const credentialsPath = path.join(runtime.root, 'harness-data', '.credentials.yaml')
    expect(parse(await readFile(credentialsPath, 'utf8'))).toEqual({ version: 1, refs: { DEEPSEEK_API_KEY: 'legacy-environment-key' } })
    expect(store.state().providers[0]?.configured).toBe(true)

    store.dispose()
    await writeFile(credentialsPath, '{}\n', 'utf8')
    store = new ModelStore(migrated)
    await store.initialize()
    expect(parse(await readFile(credentialsPath, 'utf8'))).toEqual({})
    expect(store.state().providers[0]?.configured).toBe(false)
  })
})
