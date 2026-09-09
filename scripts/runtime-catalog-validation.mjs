import { verify } from 'node:crypto'

const RUNTIME_MODULE_IDS = new Set(['node-runtime', 'harness-core', 'package-manager', 'terminal-native', 'launcher-ui', 'agent-host'])
const RUNTIME_MIRROR_HOSTS = new Map([
  ['github', new Set(['github.com'])],
  ['gitee', new Set(['gitee.com'])],
  ['oss', new Set(['ailishishu-deepseek-harness.oss-cn-beijing.aliyuncs.com'])]
])
const SHA256_PATTERN = /^[a-f0-9]{64}$/
const VERSION_PATTERN = /^[0-9A-Za-z][0-9A-Za-z.+-]{0,63}$/
const SAFE_RELATIVE_PATH = /^(?![A-Za-z]:)(?![\\/])(?!.*(?:^|[\\/])\.\.(?:[\\/]|$))[0-9A-Za-z._\/-]+$/
const MODEL_PROVIDER_ID = /^[a-z][a-z0-9-]{1,39}$/
const MODEL_ID = /^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,127}$/
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/

const isRecord = (value) => typeof value === 'object' && value !== null && !Array.isArray(value)

function validRuntimeArtifact(value) {
  if (!isRecord(value)) return false
  if (!['win32', 'darwin', 'linux'].includes(value.platform)) return false
  if (!['x64', 'arm64'].includes(value.arch) || value.format !== 'tar.gz') return false
  if (!SHA256_PATTERN.test(value.sha256) || !Number.isSafeInteger(value.size) || value.size < 1) return false
  if (!Number.isSafeInteger(value.unpackedSize) || value.unpackedSize < value.size || value.unpackedSize > 2_000_000_000) return false
  if (!Array.isArray(value.mirrors) || value.mirrors.length < 1 || value.mirrors.length > 3) return false
  const mirrorIds = new Set()
  return value.mirrors.every((mirror) => {
    if (!isRecord(mirror) || typeof mirror.id !== 'string' || typeof mirror.url !== 'string' || mirrorIds.has(mirror.id)) return false
    mirrorIds.add(mirror.id)
    try {
      const url = new URL(mirror.url)
      const hosts = RUNTIME_MIRROR_HOSTS.get(mirror.id)
      const validPath = mirror.id === 'github'
        ? url.pathname.startsWith('/pingta-guangpingwang/deepblue-deepseek-harness-launcher/releases/download/')
        : mirror.id === 'gitee'
          ? ['/wanggp123/deepseek-harness-launcher/', '/wanggp123/deepseek-harness-skins-video/', '/pingta-guangpingwang/deepblue-deepseek-harness-launcher/'].some((prefix) => url.pathname.startsWith(prefix))
          : url.pathname.startsWith('/modules/')
      if (url.protocol !== 'https:' || url.username || url.password || url.hash || !hosts?.has(url.hostname) || !validPath) return false
      if (mirror.parts === undefined) return true
      if (mirror.id !== 'gitee' || !Array.isArray(mirror.parts) || mirror.parts.length < 1 || mirror.parts.length > 64 || mirror.url !== mirror.parts[0]?.url) return false
      const partUrls = new Set()
      let partBytes = 0
      for (const part of mirror.parts) {
        if (!isRecord(part) || !SHA256_PATTERN.test(part.sha256) || !Number.isSafeInteger(part.size) || part.size < 1 || part.size > 8 * 1024 * 1024 || partUrls.has(part.url)) return false
        partUrls.add(part.url)
        partBytes += part.size
        try {
          const partUrl = new URL(part.url)
          if (partUrl.protocol !== 'https:' || partUrl.hostname !== 'gitee.com' || partUrl.username || partUrl.password || partUrl.hash) return false
          if (!['/wanggp123/deepseek-harness-launcher/raw/runtime-assets/', '/wanggp123/deepseek-harness-skins-video/raw/runtime-assets/'].some((prefix) => partUrl.pathname.startsWith(prefix))) return false
        } catch {
          return false
        }
      }
      return partBytes === value.size
    } catch {
      return false
    }
  })
}

export function validateRuntimeModules(modules) {
  if (!Array.isArray(modules) || modules.length < 1 || modules.length > RUNTIME_MODULE_IDS.size) return false
  const byId = new Map()
  for (const module of modules) {
    if (!isRecord(module) || !RUNTIME_MODULE_IDS.has(module.id) || byId.has(module.id) || !VERSION_PATTERN.test(module.version)) return false
    if (!['bootstrap', 'harness', 'plugin-manager', 'terminal', 'launcher'].includes(module.installWhen)) return false
    if (!Array.isArray(module.dependencies) || new Set(module.dependencies).size !== module.dependencies.length) return false
    if (!Array.isArray(module.artifacts) || module.artifacts.length < 1 || module.artifacts.length > 6 || !module.artifacts.every(validRuntimeArtifact)) return false
    const targets = new Set(module.artifacts.map((artifact) => `${artifact.platform}-${artifact.arch}`))
    if (targets.size !== module.artifacts.length) return false
    if (module.probe) {
      if (!isRecord(module.probe) || !SAFE_RELATIVE_PATH.test(module.probe.path) || !Array.isArray(module.probe.args) || module.probe.args.length > 12 || module.probe.args.some((argument) => typeof argument !== 'string' || argument.length > 256) || typeof module.probe.expectedPattern !== 'string' || module.probe.expectedPattern.length < 1 || module.probe.expectedPattern.length > 256 || !Number.isSafeInteger(module.probe.timeoutMs) || module.probe.timeoutMs < 1_000 || module.probe.timeoutMs > 30_000) return false
      try { new RegExp(module.probe.expectedPattern, 'u') } catch { return false }
    }
    byId.set(module.id, module)
  }
  for (const module of modules) if (module.dependencies.some((dependency) => dependency === module.id || !byId.has(dependency))) return false
  const visiting = new Set()
  const visited = new Set()
  const visit = (id) => {
    if (visited.has(id)) return true
    if (visiting.has(id)) return false
    visiting.add(id)
    for (const dependency of byId.get(id)?.dependencies || []) if (!visit(dependency)) return false
    visiting.delete(id)
    visited.add(id)
    return true
  }
  return modules.every((module) => visit(module.id))
}

function safeCatalogUrl(value, allowEmpty = false) {
  if (allowEmpty && value === '') return true
  if (typeof value !== 'string' || value.length > 2_048) return false
  try {
    const url = new URL(value)
    return url.protocol === 'https:' && !url.username && !url.password
  } catch {
    return false
  }
}

export function validateModelTemplates(value) {
  if (!Array.isArray(value) || value.length < 1 || value.length > 50) return false
  const ids = new Set()
  const envNames = new Set()
  return value.every((template) => {
    if (!isRecord(template) || !MODEL_PROVIDER_ID.test(template.id) || ids.has(template.id)) return false
    if (typeof template.name !== 'string' || template.name.length < 1 || template.name.length > 80 || typeof template.description !== 'string' || template.description.length < 1 || template.description.length > 300) return false
    if (!['china', 'global', 'custom'].includes(template.region) || !['deepseek', 'openai-responses', 'openai-completions', 'anthropic-messages', 'google-generative-ai'].includes(template.api)) return false
    if (!safeCatalogUrl(template.baseURL, template.custom) || !safeCatalogUrl(template.docsUrl, template.custom) || (template.billingUrl !== undefined && !safeCatalogUrl(template.billingUrl))) return false
    if (!ENV_NAME.test(template.apiKeyEnv) || envNames.has(template.apiKeyEnv) || typeof template.catalogUpdatedAt !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(template.catalogUpdatedAt) || typeof template.custom !== 'boolean' || typeof template.featured !== 'boolean') return false
    if (!Array.isArray(template.suggestedModels) || template.suggestedModels.length > 50) return false
    if (template.suggestedModels.some((model) => !isRecord(model) || !MODEL_ID.test(model.id) || typeof model.name !== 'string' || model.name.length < 1 || model.name.length > 100 || (model.description !== undefined && (typeof model.description !== 'string' || model.description.length > 300)) || (model.recommended !== undefined && typeof model.recommended !== 'boolean') || (model.inputModalities !== undefined && (!Array.isArray(model.inputModalities) || model.inputModalities.length < 1 || model.inputModalities.length > 2 || model.inputModalities.some((modality) => modality !== 'text' && modality !== 'image') || new Set(model.inputModalities).size !== model.inputModalities.length)) || (model.imagePixelBudget !== undefined && (!Number.isSafeInteger(model.imagePixelBudget) || model.imagePixelBudget < 1 || model.imagePixelBudget > 100_000_000)) || (model.imageMaxBytes !== undefined && (!Number.isSafeInteger(model.imageMaxBytes) || model.imageMaxBytes < 1 || model.imageMaxBytes > 100_000_000)) || (model.imageDetail !== undefined && model.imageDetail !== 'auto' && model.imageDetail !== 'low'))) return false
    if (new Set(template.suggestedModels.map((model) => model.id)).size !== template.suggestedModels.length) return false
    ids.add(template.id)
    envNames.add(template.apiKeyEnv)
    return true
  })
}

export function verifyRuntimeCatalogManifest(manifest, publicKey, expectedKeyId = 'runtime-production-v2-1') {
  try {
    if (!isRecord(manifest) || JSON.stringify(Object.keys(manifest).sort()) !== JSON.stringify(['algorithm', 'keyId', 'payload', 'signature']) || manifest.keyId !== expectedKeyId || manifest.algorithm !== 'ed25519' || manifest.payload?.schemaVersion !== 2) return false
    if (typeof manifest.payload.generatedAt !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(manifest.payload.generatedAt)) return false
    if (typeof manifest.signature !== 'string' || !/^[A-Za-z0-9+/]{86}==$/.test(manifest.signature)) return false
    const signature = Buffer.from(manifest.signature, 'base64')
    if (signature.length !== 64 || signature.toString('base64') !== manifest.signature) return false
    if (!validateRuntimeModules(manifest.payload.runtimeModules)) return false
    if (manifest.payload.modelTemplates !== undefined && !validateModelTemplates(manifest.payload.modelTemplates)) return false
    return verify(null, Buffer.from(JSON.stringify(manifest.payload), 'utf8'), publicKey, signature)
  } catch {
    return false
  }
}
