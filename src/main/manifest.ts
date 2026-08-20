import { app } from 'electron'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { verify } from 'node:crypto'
import type { RuntimeModuleArtifact, RuntimeModuleId, RuntimeModuleRelease, SignedCatalogManifest, SignedCatalogPayload, SourceConfig } from '../shared/types'

const RUNTIME_MODULE_IDS = new Set<RuntimeModuleId>([
  'node-runtime',
  'harness-core',
  'package-manager',
  'terminal-native',
  'launcher-ui'
])
const RUNTIME_MIRROR_HOSTS = new Map([
  ['github', new Set(['github.com'])],
  ['gitee', new Set(['gitee.com'])],
  ['oss', new Set(['ailishishu-deepseek-harness.oss-cn-beijing.aliyuncs.com'])]
])
const SHA256_PATTERN = /^[a-f0-9]{64}$/
const VERSION_PATTERN = /^[0-9A-Za-z][0-9A-Za-z.+-]{0,63}$/
const SAFE_RELATIVE_PATH = /^(?![A-Za-z]:)(?![\\/])(?!.*(?:^|[\\/])\.\.(?:[\\/]|$))[0-9A-Za-z._\\/-]+$/
const RUNTIME_CATALOG_KEY_ID = 'runtime-production-v2-1'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function validRuntimeArtifact(value: unknown): value is RuntimeModuleArtifact {
  if (!isRecord(value)) return false
  const artifact = value as unknown as RuntimeModuleArtifact
  if (!['win32', 'darwin', 'linux'].includes(artifact.platform)) return false
  if (!['x64', 'arm64'].includes(artifact.arch) || artifact.format !== 'tar.gz') return false
  if (!SHA256_PATTERN.test(artifact.sha256) || !Number.isSafeInteger(artifact.size) || artifact.size < 1) return false
  if (!Number.isSafeInteger(artifact.unpackedSize) || artifact.unpackedSize < artifact.size || artifact.unpackedSize > 2_000_000_000) return false
  if (!Array.isArray(artifact.mirrors) || artifact.mirrors.length < 1 || artifact.mirrors.length > 3) return false
  const mirrorIds = new Set<string>()
  return artifact.mirrors.every((mirror) => {
    if (mirrorIds.has(mirror.id)) return false
    mirrorIds.add(mirror.id)
    try {
      const url = new URL(mirror.url)
      const hosts = RUNTIME_MIRROR_HOSTS.get(mirror.id)
      const validPath = mirror.id === 'github'
        ? url.pathname.startsWith('/pingta-guangpingwang/deepblue-deepseek-harness-launcher/releases/download/')
        : mirror.id === 'gitee'
          ? ['/wanggp123/deepseek-harness-launcher/', '/pingta-guangpingwang/deepblue-deepseek-harness-launcher/'].some((prefix) => url.pathname.startsWith(prefix))
          : url.pathname.startsWith('/modules/')
      return url.protocol === 'https:' && !url.username && !url.password && !url.hash && !!hosts?.has(url.hostname) && validPath
    } catch {
      return false
    }
  })
}

/** Validates the complete signed runtime module graph before any network or disk action. */
export function validateRuntimeModules(modules: unknown): modules is RuntimeModuleRelease[] {
  if (!Array.isArray(modules) || modules.length < 1 || modules.length > RUNTIME_MODULE_IDS.size) return false
  const byId = new Map<RuntimeModuleId, RuntimeModuleRelease>()
  for (const value of modules) {
    if (!isRecord(value)) return false
    const module = value as unknown as RuntimeModuleRelease
    if (!RUNTIME_MODULE_IDS.has(module.id) || byId.has(module.id) || !VERSION_PATTERN.test(module.version)) return false
    if (!['bootstrap', 'harness', 'plugin-manager', 'terminal', 'launcher'].includes(module.installWhen)) return false
    if (!Array.isArray(module.dependencies) || new Set(module.dependencies).size !== module.dependencies.length) return false
    if (!Array.isArray(module.artifacts) || module.artifacts.length < 1 || module.artifacts.length > 6) return false
    if (!module.artifacts.every(validRuntimeArtifact)) return false
    const targets = new Set(module.artifacts.map((artifact) => `${artifact.platform}-${artifact.arch}`))
    if (targets.size !== module.artifacts.length) return false
    if (module.probe) {
      if (
        !SAFE_RELATIVE_PATH.test(module.probe.path) ||
        !Array.isArray(module.probe.args) ||
        module.probe.args.length > 12 ||
        module.probe.args.some((argument) => typeof argument !== 'string' || argument.length > 256) ||
        typeof module.probe.expectedPattern !== 'string' ||
        module.probe.expectedPattern.length < 1 ||
        module.probe.expectedPattern.length > 256 ||
        !Number.isSafeInteger(module.probe.timeoutMs) ||
        module.probe.timeoutMs < 1_000 ||
        module.probe.timeoutMs > 30_000
      ) return false
      try {
        new RegExp(module.probe.expectedPattern, 'u')
      } catch {
        return false
      }
    }
    byId.set(module.id, module)
  }
  for (const module of modules) {
    if (module.dependencies.some((dependency: RuntimeModuleId) => dependency === module.id || !byId.has(dependency))) return false
  }
  const visiting = new Set<RuntimeModuleId>()
  const visited = new Set<RuntimeModuleId>()
  const visit = (id: RuntimeModuleId): boolean => {
    if (visited.has(id)) return true
    if (visiting.has(id)) return false
    visiting.add(id)
    for (const dependency of byId.get(id)?.dependencies || []) {
      if (!visit(dependency)) return false
    }
    visiting.delete(id)
    visited.add(id)
    return true
  }
  return modules.every((module) => visit(module.id))
}

function stablePayload(payload: SignedCatalogPayload): Buffer {
  return Buffer.from(JSON.stringify(payload), 'utf8')
}

export function verifyCatalogManifest(manifest: SignedCatalogManifest, publicKey: string, expectedKeyId?: string): boolean {
  try {
    if (expectedKeyId && manifest.keyId !== expectedKeyId) return false
    if (manifest.algorithm !== 'ed25519' || ![1, 2].includes(manifest.payload.schemaVersion)) return false
    if (manifest.payload.schemaVersion === 2 && !validateRuntimeModules(manifest.payload.runtimeModules)) return false
    if (manifest.payload.schemaVersion === 1 && manifest.payload.runtimeModules !== undefined) return false
    return verify(null, stablePayload(manifest.payload), publicKey, Buffer.from(manifest.signature, 'base64'))
  } catch {
    return false
  }
}

function manifestUrl(source: SourceConfig): string | undefined {
  if (!source.enabled || source.kind !== 'manifest') return undefined
  const base = source.baseUrl.trim().replace(/\/$/, '')
  if (!base) return undefined
  if (base.endsWith('.json')) return base
  return `${base}/release/launcher-manifest.json`
}

async function readTrustedKey(): Promise<string | undefined> {
  const candidates = [
    path.join(process.resourcesPath, 'resources', 'runtime-update-public-key.pem'),
    path.join(app.getAppPath(), 'resources', 'runtime-update-public-key.pem')
  ]
  for (const candidate of candidates) {
    try {
      return await readFile(candidate, 'utf8')
    } catch {
      // Development builds intentionally have no production signing key yet.
    }
  }
  return undefined
}

export async function fetchSignedCatalog(sources: SourceConfig[]): Promise<SignedCatalogPayload | undefined> {
  const publicKey = await readTrustedKey()
  if (!publicKey) return undefined
  for (const source of sources) {
    const url = manifestUrl(source)
    if (!url) continue
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(6_000), headers: { 'User-Agent': 'DeepSeek-Harness-Launcher' } })
      if (!response.ok) continue
      const manifest = await response.json() as SignedCatalogManifest
      if (verifyCatalogManifest(manifest, publicKey, RUNTIME_CATALOG_KEY_ID)) return manifest.payload
    } catch {
      // Source fallback is expected when a mirror is offline or unconfigured.
    }
  }
  return undefined
}

export async function fetchLatestNpmVersion(registry: string): Promise<string | undefined> {
  const base = registry.replace(/\/$/, '')
  try {
    const response = await fetch(`${base}/@deepseek-ai%2Fdsh/latest`, { signal: AbortSignal.timeout(6_000) })
    if (!response.ok) return undefined
    const metadata = await response.json() as { version?: string }
    return metadata.version
  } catch {
    return undefined
  }
}
