import { app } from 'electron'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { verify } from 'node:crypto'
import type { ModelProviderTemplate, RuntimeModuleArtifact, RuntimeModuleId, RuntimeModuleRelease, SignedCatalogManifest, SignedCatalogPayload, SourceConfig } from '../shared/types'

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
const MODEL_PROVIDER_ID = /^[a-z][a-z0-9-]{1,39}$/
const MODEL_ID = /^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,127}$/
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/

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

/**
 * Reads the runtime graph that travelled inside the launcher shell. The shell
 * archive is itself content-addressed by the signed bootstrap catalog, so this
 * fallback remains trustworthy while keeping first install available when the
 * remote catalog object is temporarily unavailable.
 */
export function runtimeModulesFromBundle(value: unknown): RuntimeModuleRelease[] {
  if (!isRecord(value) || value.schemaVersion !== 1 || !validateRuntimeModules(value.modules)) return []
  return structuredClone(value.modules)
}

/**
 * The signed online catalog remains authoritative for versions and hashes.
 * When the bundled shell describes the exact same artifact, its independently
 * packaged mirrors can safely extend availability without changing bytes.
 */
export function mergeBundledRuntimeMirrors(
  online: RuntimeModuleRelease[],
  bundled: RuntimeModuleRelease[]
): RuntimeModuleRelease[] {
  return online.map((release) => {
    const local = bundled.find((candidate) => candidate.id === release.id && candidate.version === release.version)
    if (!local) return structuredClone(release)
    return {
      ...structuredClone(release),
      artifacts: release.artifacts.map((artifact) => {
        const localArtifact = local.artifacts.find((candidate) =>
          candidate.platform === artifact.platform &&
          candidate.arch === artifact.arch &&
          candidate.format === artifact.format &&
          candidate.sha256 === artifact.sha256 &&
          candidate.size === artifact.size &&
          candidate.unpackedSize === artifact.unpackedSize
        )
        if (!localArtifact) return structuredClone(artifact)
        const mirrors = [...artifact.mirrors]
        for (const mirror of localArtifact.mirrors) {
          if (!mirrors.some((candidate) => candidate.id === mirror.id) && mirrors.length < 3) mirrors.push(structuredClone(mirror))
        }
        return { ...structuredClone(artifact), mirrors }
      })
    }
  })
}

export function isNewerVersion(candidate: string, current: string): boolean {
  const parse = (value: string): { core: number[]; prerelease?: string } | undefined => {
    const match = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(value)
    if (!match) return undefined
    return { core: match.slice(1, 4).map(Number), prerelease: match[4] }
  }
  const next = parse(candidate)
  const active = parse(current)
  if (!next || !active) return false
  for (let index = 0; index < next.core.length; index += 1) {
    if (next.core[index] !== active.core[index]) return next.core[index]! > active.core[index]!
  }
  if (!next.prerelease && active.prerelease) return true
  if (next.prerelease && !active.prerelease) return false
  if (!next.prerelease || !active.prerelease) return false
  return next.prerelease.localeCompare(active.prerelease, undefined, { numeric: true }) > 0
}

function safeCatalogUrl(value: unknown, allowEmpty = false): boolean {
  if (allowEmpty && value === '') return true
  if (typeof value !== 'string' || value.length > 2_048) return false
  try {
    const url = new URL(value)
    return url.protocol === 'https:' && !url.username && !url.password
  } catch {
    return false
  }
}

/** Validates model templates before the signed online catalog can replace the bundled fallback. */
export function validateModelTemplates(value: unknown): value is ModelProviderTemplate[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 50) return false
  const ids = new Set<string>()
  const envNames = new Set<string>()
  return value.every((candidate) => {
    if (!isRecord(candidate)) return false
    const template = candidate as unknown as ModelProviderTemplate
    if (!MODEL_PROVIDER_ID.test(template.id) || ids.has(template.id)) return false
    if (typeof template.name !== 'string' || template.name.length < 1 || template.name.length > 80) return false
    if (typeof template.description !== 'string' || template.description.length < 1 || template.description.length > 300) return false
    if (!['china', 'global', 'custom'].includes(template.region)) return false
    if (!['deepseek', 'openai-responses', 'openai-completions', 'anthropic-messages', 'google-generative-ai'].includes(template.api)) return false
    if (!safeCatalogUrl(template.baseURL, template.custom) || !safeCatalogUrl(template.docsUrl, template.custom)) return false
    if (template.billingUrl !== undefined && !safeCatalogUrl(template.billingUrl)) return false
    if (!ENV_NAME.test(template.apiKeyEnv) || envNames.has(template.apiKeyEnv)) return false
    if (typeof template.catalogUpdatedAt !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(template.catalogUpdatedAt)) return false
    if (typeof template.custom !== 'boolean' || typeof template.featured !== 'boolean') return false
    if (!Array.isArray(template.suggestedModels) || template.suggestedModels.length > 50) return false
    if (template.suggestedModels.some((model) => (
      !isRecord(model) || !MODEL_ID.test(model.id) || typeof model.name !== 'string' || model.name.length < 1 || model.name.length > 100 ||
      (model.description !== undefined && (typeof model.description !== 'string' || model.description.length > 300)) ||
      (model.recommended !== undefined && typeof model.recommended !== 'boolean') ||
      (model.inputModalities !== undefined && (
        !Array.isArray(model.inputModalities) || model.inputModalities.length < 1 || model.inputModalities.length > 2 ||
        model.inputModalities.some((modality) => modality !== 'text' && modality !== 'image') ||
        new Set(model.inputModalities).size !== model.inputModalities.length
      )) ||
      (model.imagePixelBudget !== undefined && (!Number.isSafeInteger(model.imagePixelBudget) || model.imagePixelBudget < 1 || model.imagePixelBudget > 100_000_000)) ||
      (model.imageMaxBytes !== undefined && (!Number.isSafeInteger(model.imageMaxBytes) || model.imageMaxBytes < 1 || model.imageMaxBytes > 100_000_000)) ||
      (model.imageDetail !== undefined && model.imageDetail !== 'auto' && model.imageDetail !== 'low')
    ))) return false
    if (new Set(template.suggestedModels.map((model) => model.id)).size !== template.suggestedModels.length) return false
    ids.add(template.id)
    envNames.add(template.apiKeyEnv)
    return true
  })
}

function stablePayload(payload: SignedCatalogPayload): Buffer {
  return Buffer.from(JSON.stringify(payload), 'utf8')
}

export function verifyCatalogManifest(manifest: SignedCatalogManifest, publicKey: string, expectedKeyId?: string): boolean {
  try {
    if (expectedKeyId && manifest.keyId !== expectedKeyId) return false
    if (manifest.algorithm !== 'ed25519' || ![1, 2].includes(manifest.payload.schemaVersion)) return false
    if (manifest.payload.schemaVersion === 2 && !validateRuntimeModules(manifest.payload.runtimeModules)) return false
    if (manifest.payload.modelTemplates !== undefined && !validateModelTemplates(manifest.payload.modelTemplates)) return false
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

export async function readBundledRuntimeModules(): Promise<RuntimeModuleRelease[]> {
  const candidates = [
    ...(typeof process.resourcesPath === 'string'
      ? [path.join(process.resourcesPath, 'resources', 'runtime-modules.generated.json')]
      : []),
    path.join(app.getAppPath(), 'resources', 'runtime-modules.generated.json'),
    path.resolve('release', 'runtime-modules.generated.json')
  ]
  for (const candidate of candidates) {
    try {
      return runtimeModulesFromBundle(JSON.parse(await readFile(candidate, 'utf8')))
    } catch {
      // Continue to the next packaged/development location.
    }
  }
  return []
}

export async function fetchSignedCatalog(sources: SourceConfig[]): Promise<SignedCatalogPayload | undefined> {
  const publicKey = await readTrustedKey()
  if (!publicKey) return undefined
  for (const source of sources) {
    const url = manifestUrl(source)
    if (!url) continue
    try {
      const response = await fetch(url, {
        signal: AbortSignal.timeout(6_000),
        headers: { 'User-Agent': 'DeepSeek-Harness-Launcher', 'Cache-Control': 'no-cache' }
      })
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
