import { describe, expect, it } from 'vitest'
import { generateKeyPairSync, sign } from 'node:crypto'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { isNewerVersion, mergeBundledRuntimeMirrors, runtimeModulesFromBundle, validateModelTemplates, validateRuntimeModules, verifyCatalogManifest } from './manifest'
import { modelProviderTemplates } from '../shared/model-provider-catalog'
import type { RuntimeModuleRelease, SignedCatalogManifest, SignedCatalogPayload } from '../shared/types'

const payload: SignedCatalogPayload = {
  schemaVersion: 1,
  generatedAt: '2026-08-15T00:00:00.000Z',
  harness: [],
  plugins: [],
  models: []
}

const runtimeModule: RuntimeModuleRelease = {
  id: 'node-runtime',
  version: '24.16.0',
  required: true,
  installWhen: 'harness',
  dependencies: [],
  artifacts: [{
    platform: 'win32',
    arch: 'x64',
    format: 'tar.gz',
    sha256: 'a'.repeat(64),
    size: 10,
    unpackedSize: 20,
    mirrors: [
      { id: 'gitee', url: 'https://gitee.com/wanggp123/deepseek-harness-launcher/releases/download/v1/node.tar.gz' },
      { id: 'github', url: 'https://github.com/pingta-guangpingwang/deepblue-deepseek-harness-launcher/releases/download/v1/node.tar.gz' }
    ]
  }],
  probe: { path: 'bin/node.exe', args: ['--version'], expectedPattern: '^v24\\.', timeoutMs: 5_000 }
}

describe('catalog signature verification', () => {
  it('accepts an unchanged Ed25519-signed payload', () => {
    const { publicKey, privateKey } = generateKeyPairSync('ed25519')
    const manifest: SignedCatalogManifest = {
      keyId: 'test',
      algorithm: 'ed25519',
      payload,
      signature: sign(null, Buffer.from(JSON.stringify(payload)), privateKey).toString('base64')
    }
    expect(verifyCatalogManifest(manifest, publicKey.export({ type: 'spki', format: 'pem' }).toString())).toBe(true)
    expect(verifyCatalogManifest(manifest, publicKey.export({ type: 'spki', format: 'pem' }).toString(), 'another-key')).toBe(false)
  })

  it('rejects a payload changed after signing', () => {
    const { publicKey, privateKey } = generateKeyPairSync('ed25519')
    const signature = sign(null, Buffer.from(JSON.stringify(payload)), privateKey).toString('base64')
    const manifest: SignedCatalogManifest = {
      keyId: 'test',
      algorithm: 'ed25519',
      payload: { ...payload, generatedAt: 'tampered' },
      signature
    }
    expect(verifyCatalogManifest(manifest, publicKey.export({ type: 'spki', format: 'pem' }).toString())).toBe(false)
  })

  it('accepts only a closed acyclic signed runtime module graph', () => {
    expect(validateRuntimeModules([
      runtimeModule,
      {
        ...runtimeModule,
        id: 'harness-core',
        version: '0.1.0-rc.6',
        dependencies: ['node-runtime'],
        probe: undefined
      }
    ])).toBe(true)
    expect(validateRuntimeModules([{ ...runtimeModule, dependencies: ['node-runtime'] }])).toBe(false)
    expect(validateRuntimeModules([{
      ...runtimeModule,
      artifacts: [{
        ...runtimeModule.artifacts[0]!,
        mirrors: [{ id: 'github', url: 'https://github.com/another-owner/malware/releases/download/v1/node.tar.gz' }]
      }]
    }])).toBe(false)
  })

  it('accepts signed Gitee multipart mirrors only when every part is bounded and totals the artifact size', () => {
    const first = {
      url: 'https://gitee.com/wanggp123/deepseek-harness-skins-video/raw/runtime-assets/runtime-v0.10.20/node.tar.gz.part001',
      sha256: 'b'.repeat(64),
      size: 4
    }
    const multipart = {
      ...runtimeModule,
      artifacts: [{
        ...runtimeModule.artifacts[0]!,
        mirrors: [{ id: 'gitee' as const, url: first.url, parts: [first, { ...first, url: first.url.replace('001', '002'), sha256: 'c'.repeat(64), size: 6 }] }]
      }]
    }
    expect(validateRuntimeModules([multipart])).toBe(true)
    expect(validateRuntimeModules([{ ...multipart, artifacts: [{ ...multipart.artifacts[0]!, mirrors: [{ ...multipart.artifacts[0]!.mirrors[0]!, parts: [first] }] }] }])).toBe(false)
  })

  it('requires schema 2 before accepting runtime modules', () => {
    const { publicKey, privateKey } = generateKeyPairSync('ed25519')
    const modularPayload: SignedCatalogPayload = { ...payload, schemaVersion: 2, runtimeModules: [runtimeModule] }
    const manifest: SignedCatalogManifest = {
      keyId: 'test',
      algorithm: 'ed25519',
      payload: modularPayload,
      signature: sign(null, Buffer.from(JSON.stringify(modularPayload)), privateKey).toString('base64')
    }
    expect(verifyCatalogManifest(manifest, publicKey.export({ type: 'spki', format: 'pem' }).toString())).toBe(true)
    const legacyPayload = { ...modularPayload, schemaVersion: 1 as const }
    const legacyManifest = {
      ...manifest,
      payload: legacyPayload,
      signature: sign(null, Buffer.from(JSON.stringify(legacyPayload)), privateKey).toString('base64')
    }
    expect(verifyCatalogManifest(legacyManifest, publicKey.export({ type: 'spki', format: 'pem' }).toString())).toBe(false)
  })

  it('accepts only a validated launcher-bundled runtime fallback', () => {
    expect(runtimeModulesFromBundle({ schemaVersion: 1, modules: [runtimeModule] })).toEqual([runtimeModule])
    expect(runtimeModulesFromBundle({ schemaVersion: 2, modules: [runtimeModule] })).toEqual([])
    expect(runtimeModulesFromBundle({
      schemaVersion: 1,
      modules: [{ ...runtimeModule, dependencies: ['node-runtime'] }]
    })).toEqual([])
  })

  it('never offers an older signed launcher as an update', () => {
    expect(isNewerVersion('0.10.6', '0.10.5')).toBe(true)
    expect(isNewerVersion('0.10.4', '0.10.5')).toBe(false)
    expect(isNewerVersion('0.10.5', '0.10.5')).toBe(false)
    expect(isNewerVersion('0.11.0-rc.1', '0.10.5')).toBe(true)
    expect(isNewerVersion('0.10.5-rc.2', '0.10.5')).toBe(false)
  })

  it('extends only byte-identical signed runtime artifacts with bundled mirrors', () => {
    const ossMirror = { id: 'oss' as const, url: 'https://ailishishu-deepseek-harness.oss-cn-beijing.aliyuncs.com/modules/node.tar.gz' }
    const runtimeArtifact = runtimeModule.artifacts[0]!
    const bundled = [{ ...runtimeModule, artifacts: [{ ...runtimeArtifact, mirrors: [...runtimeArtifact.mirrors, ossMirror] }] }]
    expect(mergeBundledRuntimeMirrors([runtimeModule], bundled)[0]?.artifacts[0]?.mirrors).toHaveLength(3)
    const changed = [{ ...runtimeModule, artifacts: [{ ...runtimeArtifact, sha256: 'b'.repeat(64), mirrors: [...runtimeArtifact.mirrors, ossMirror] }] }]
    expect(mergeBundledRuntimeMirrors([runtimeModule], changed)[0]?.artifacts[0]?.mirrors).toHaveLength(2)
  })

  it('accepts a signed live model directory and rejects unsafe or duplicate templates', () => {
    expect(validateModelTemplates(modelProviderTemplates)).toBe(true)
    expect(validateModelTemplates(modelProviderTemplates.map((template, index) => index === 0 ? { ...template, baseURL: 'http://attacker.example' } : template))).toBe(false)
    expect(validateModelTemplates(modelProviderTemplates.map((template, index) => index === 0 ? {
      ...template,
      suggestedModels: template.suggestedModels.map((model, modelIndex) => modelIndex === 0
        ? { ...model, inputModalities: ['text', 'camera'] }
        : model)
    } : template))).toBe(false)
    expect(validateModelTemplates([...modelProviderTemplates, modelProviderTemplates[0]])).toBe(false)
    const { publicKey, privateKey } = generateKeyPairSync('ed25519')
    const modularPayload: SignedCatalogPayload = { ...payload, schemaVersion: 2, runtimeModules: [runtimeModule], modelTemplates: modelProviderTemplates }
    const manifest: SignedCatalogManifest = {
      keyId: 'test', algorithm: 'ed25519', payload: modularPayload,
      signature: sign(null, Buffer.from(JSON.stringify(modularPayload)), privateKey).toString('base64')
    }
    expect(verifyCatalogManifest(manifest, publicKey.export({ type: 'spki', format: 'pem' }).toString())).toBe(true)
  })

  it('publishes launcher updates through permanent download URLs', () => {
    const script = readFileSync(path.resolve('scripts/update-release-payload.mjs'), 'utf8')
    expect(script).toContain("const stableDownloadBaseUrl = 'https://ailishishu-deepseek-harness.oss-cn-beijing.aliyuncs.com/download'")
    expect(script).toContain('deepblue-deepseek-harness-launcher-win-x64-online.exe')
    expect(script).toContain("distribution: 'online'")
    expect(script).toContain('payload.modelTemplates = modelProviderTemplates')
    expect(script).toContain('payload.harness = bundledVersions.map')
    expect(script).toContain('installed: false')
    expect(script).toContain('active: false')
    expect(script).not.toContain("distribution: 'offline'")
    expect(script).not.toContain('`https://ailishishu-deepseek-harness.oss-cn-beijing.aliyuncs.com/releases/${packageJson.version}`')
  })

  it('publishes every modular artifact in the Gitee, OSS, GitHub fallback order without resume prompts', () => {
    const runtimeBuilder = readFileSync(path.resolve('scripts/build-runtime-modules.mjs'), 'utf8')
    const shellBuilder = readFileSync(path.resolve('scripts/build-launcher-shell.mjs'), 'utf8')
    const bootstrapBuilder = readFileSync(path.resolve('scripts/build-bootstrap-installer.ps1'), 'utf8')
    const bootstrapInstaller = readFileSync(path.resolve('scripts/bootstrap/installer.nsi'), 'utf8')
    for (const source of [runtimeBuilder, shellBuilder]) {
      const gitee = source.indexOf("{ id: 'gitee'")
      const github = source.indexOf("{ id: 'github'")
      const oss = source.indexOf("{ id: 'oss'")
      expect(gitee).toBeGreaterThan(-1)
      expect(gitee).toBeLessThan(oss)
      expect(oss).toBeLessThan(github)
    }
    expect(bootstrapBuilder).toContain('SHELL_URL_GITEE')
    expect(bootstrapBuilder).toContain('DownloadGiteeParts')
    expect(bootstrapInstaller.indexOf('DownloadGiteeParts')).toBeLessThan(bootstrapInstaller.indexOf('SHELL_URL_OSS'))
    expect(bootstrapInstaller.indexOf('SHELL_URL_OSS')).toBeLessThan(bootstrapInstaller.indexOf('SHELL_URL_GITHUB'))
    expect(bootstrapInstaller).toContain('/RECEIVETIMEOUT 15')
    expect(bootstrapInstaller).not.toContain('/RESUME')
  })

  it('keeps local artifact smoke separate from the mandatory public fresh-install gate', () => {
    const packageJson = JSON.parse(readFileSync(path.resolve('package.json'), 'utf8')) as { scripts: Record<string, string> }
    const windowsBuilder = readFileSync(path.resolve('scripts/build-windows-variants.ps1'), 'utf8')
    const publicGate = readFileSync(path.resolve('scripts/smoke-public-fresh-install.ps1'), 'utf8')
    expect(packageJson.scripts['bootstrap:smoke-local-artifact']).toBeTruthy()
    expect(packageJson.scripts['release:smoke-public-fresh-install']).toBeTruthy()
    expect(packageJson.scripts['bootstrap:smoke']).toBeUndefined()
    expect(windowsBuilder).toContain('bootstrap:smoke-local-artifact')
    expect(publicGate).toContain('deepblue-deepseek-harness-launcher-win-x64-online.exe')
    expect(publicGate).not.toContain('LOCAL_SHELL')
  })

  it('keeps the modular catalog on an isolated v2 trust root and endpoint', () => {
    const manifestSource = readFileSync(path.resolve('src/main/manifest.ts'), 'utf8')
    const configSource = readFileSync(path.resolve('src/main/config.ts'), 'utf8')
    const windowsBuilder = readFileSync(path.resolve('scripts/build-windows-variants.ps1'), 'utf8')
    expect(manifestSource).toContain("RUNTIME_CATALOG_KEY_ID = 'runtime-production-v2-1'")
    expect(manifestSource).toContain("'runtime-update-public-key.pem'")
    expect(configSource).toContain('/release-v2/launcher-manifest.json')
    expect(configSource).not.toContain('/release/launcher-manifest.json')
    expect(windowsBuilder).toContain("runtime-modules.generated.json")
  })
})
