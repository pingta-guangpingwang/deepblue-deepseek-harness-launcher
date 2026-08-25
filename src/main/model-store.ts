import { safeStorage } from 'electron'
import { createReadStream, unwatchFile, watchFile } from 'node:fs'
import { mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'
import readline from 'node:readline'
import { withFileLock, writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import { launcherDataPaths, writeConfig, type PersistedConfig } from './config'
import { parseModelUsageLine } from './model-usage'
import { mergeHarnessModelSettings, parseHarnessModelSettings, type HarnessProviderProfile } from './model-settings'
import { mergeHarnessCredentials, parseHarnessCredentials } from './model-credentials'
import { runMultimodalApi } from './multimodal'
import { queryDeepSeekBalance } from './deepseek-balance'
import { modelProviderTemplates } from '../shared/model-provider-catalog'
export { modelProviderTemplates } from '../shared/model-provider-catalog'
import type {
  ModelHubState,
  DeepSeekBalanceSummary,
  ModelProviderConnection,
  ModelProviderDraft,
  ModelProviderTemplate,
  ModelUsageSummary,
  MultimodalTestRequest,
  MultimodalTestResult
} from '../shared/types'

const DEEPSEEK_PROVIDER = 'deepseek-official'
interface SecretDocument {
  version: 1
  values: Record<string, string>
}

function secretPath(): string {
  return path.join(launcherDataPaths().root, 'model-secrets.json')
}

function validBaseURL(value: string): boolean {
  try {
    const url = new URL(value)
    return url.protocol === 'https:' || (url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname))
  } catch {
    return false
  }
}

function envName(providerId: string, explicit?: string, templates: ModelProviderTemplate[] = modelProviderTemplates): string {
  if (explicit && /^[A-Za-z_][A-Za-z0-9_]*$/.test(explicit)) return explicit
  const template = templates.find((item) => item.id === providerId)
  if (template) return template.apiKeyEnv
  return `${providerId.replace(/[^a-z0-9]/gi, '_').toUpperCase()}_API_KEY`
}

function providerEnvName(provider: PersistedConfig['modelRouting']['providers'][number]): string {
  return envName(provider.id, provider.apiKeyEnv)
}

export function normalizeModelProviderDraft(
  draft: ModelProviderDraft,
  templates: ModelProviderTemplate[] = modelProviderTemplates
): Omit<ModelProviderDraft, 'apiKey'> {
  const id = draft.id.trim().toLowerCase()
  if (!/^[a-z][a-z0-9-]{1,39}$/.test(id)) throw new Error('提供方 ID 必须以小写字母开头，只能包含小写字母、数字和连字符')
  if ((draft.apiKey?.length || 0) > 16_384) throw new Error('API Key 长度异常，请检查后重试')
  const template = templates.find((item) => item.id === id)
  if (template && !template.custom) {
    const selectedIds = new Set(draft.models.map((model) => model.id.trim()))
    const models = template.suggestedModels
      .filter((model) => selectedIds.has(model.id))
      .map((model) => ({ ...model }))
    if (!models.length) throw new Error('请至少选择一个官方模型')
    return {
      id: template.id,
      name: template.name,
      api: template.api,
      baseURL: template.baseURL,
      models,
      docsUrl: template.docsUrl,
      billingUrl: template.billingUrl,
      custom: false
    }
  }
  if (!draft.name.trim()) throw new Error('请填写提供方名称')
  if (draft.name.trim().length > 80) throw new Error('提供方名称不能超过 80 个字符')
  if (draft.baseURL.trim().length > 2_048 || !validBaseURL(draft.baseURL.trim())) throw new Error('API 地址必须是 HTTPS；仅本机 localhost 可使用 HTTP')
  if (draft.models.length > 50) throw new Error('单个提供方最多保存 50 个模型')
  const models = draft.models
    .map((model) => ({ id: model.id.trim(), name: (model.name || model.id).trim() }))
    .filter((model) => model.id)
  if (!models.length) throw new Error('至少选择或填写一个模型')
  if (models.some((model) => !/^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,127}$/.test(model.id))) throw new Error('模型 ID 只能包含字母、数字、点、下划线、斜杠、冒号和连字符')
  if (models.some((model) => model.name.length > 100)) throw new Error('模型显示名称不能超过 100 个字符')
  if (new Set(models.map((model) => model.id)).size !== models.length) throw new Error('模型 ID 不能重复')
  return {
    id,
    name: draft.name.trim(),
    api: draft.api,
    baseURL: draft.baseURL.trim().replace(/\/$/, ''),
    models,
    docsUrl: draft.docsUrl?.trim(),
    billingUrl: draft.billingUrl?.trim(),
    custom: Boolean(draft.custom)
  }
}

export function mergeSignedModelTemplates(templates: ModelProviderTemplate[]): ModelProviderTemplate[] {
  const signedById = new Map(templates.map((template) => [template.id, template]))
  const merged = modelProviderTemplates.map((bundled) => {
    const signed = signedById.get(bundled.id)
    if (!signed) return structuredClone(bundled)
    signedById.delete(bundled.id)
    if (signed.catalogUpdatedAt >= bundled.catalogUpdatedAt) return structuredClone(signed)

    const bundledIds = new Set(bundled.suggestedModels.map((model) => model.id))
    return {
      ...signed,
      ...bundled,
      suggestedModels: [
        ...bundled.suggestedModels.map((model) => ({ ...model })),
        ...signed.suggestedModels.filter((model) => !bundledIds.has(model.id)).map((model) => ({ ...model }))
      ]
    }
  })
  return [...merged, ...[...signedById.values()].map((template) => structuredClone(template))]
}

export class ModelStore {
  private templates: ModelProviderTemplate[] = structuredClone(modelProviderTemplates)
  private secrets: SecretDocument = { version: 1, values: {} }
  private usage: Record<string, ModelUsageSummary> = {}
  private readonly watchTargets: string[] = []
  private syncQueue: Promise<void> = Promise.resolve()
  private deepSeekBalanceCache?: { encryptedKey: string; expiresAt: number; value: DeepSeekBalanceSummary }
  private deepSeekBalanceRequest?: Promise<DeepSeekBalanceSummary>

  constructor(
    private readonly config: PersistedConfig,
    private readonly onExternalChange?: (state: ModelHubState) => void
  ) {}

  async initialize(): Promise<void> {
    try {
      const parsed = JSON.parse(await readFile(secretPath(), 'utf8')) as SecretDocument
      if (parsed.version === 1 && parsed.values && typeof parsed.values === 'object') this.secrets = parsed
    } catch {
      this.secrets = { version: 1, values: {} }
    }
    const settingsImported = await this.importHarnessSettings()
    const modelsMigrated = this.includeOfficialDeepSeekModels()
    if (settingsImported || modelsMigrated) {
      await Promise.all([writeConfig(this.config), this.writeHarnessSettings()])
    }
    await this.initializeHarnessCredentials()
    this.startWatchers()
    await this.refreshUsage()
  }

  dispose(): void {
    for (const target of this.watchTargets.splice(0)) unwatchFile(target)
  }

  state(message?: string): ModelHubState {
    const providers: ModelProviderConnection[] = this.config.modelRouting.providers.map((provider) => {
      const template = this.templates.find((item) => item.id === provider.id)
      const key = providerEnvName(provider)
      return {
        ...provider,
        apiKeyEnv: key,
        configured: Boolean(this.secrets.values[key]),
        secureStorage: safeStorage.isEncryptionAvailable(),
        updatedAt: new Date().toISOString(),
        docsUrl: provider.docsUrl || template?.docsUrl,
        billingUrl: provider.billingUrl || template?.billingUrl,
        custom: Boolean(provider.custom)
      }
    })
    const activeProvider = providers.find((item) => item.id === this.config.modelRouting.active.provider)
    const activeModel = activeProvider?.models.find((item) => item.id === this.config.modelRouting.active.model)
    return {
      active: {
        provider: activeProvider?.id || DEEPSEEK_PROVIDER,
        model: activeModel?.id || 'deepseek-v4-flash',
        displayName: activeModel?.name || 'DeepSeek V4 Flash'
      },
      templates: structuredClone(this.templates),
      providers,
      usage: this.usage,
      secureStorageAvailable: safeStorage.isEncryptionAvailable(),
      message: message || (!safeStorage.isEncryptionAvailable() ? 'Windows 安全存储当前不可用，暂不能保存新的 API Key。' : undefined)
    }
  }

  syncTemplates(templates: ModelProviderTemplate[]): ModelHubState {
    this.templates = mergeSignedModelTemplates(templates)
    if (this.includeOfficialDeepSeekModels()) {
      this.syncQueue = this.syncQueue.then(async () => {
        await Promise.all([writeConfig(this.config), this.writeHarnessSettings()])
      }).catch(() => {
        this.onExternalChange?.(this.state('官方 DeepSeek 模型目录同步失败，请稍后重新检查更新'))
      })
    }
    return this.state('模型目录已从签名在线目录更新；已添加连接保持不变')
  }

  async saveProvider(draft: ModelProviderDraft): Promise<ModelHubState> {
    const normalized = normalizeModelProviderDraft(draft, this.templates)
    const existing = this.config.modelRouting.providers.findIndex((item) => item.id === normalized.id)
    const apiKeyEnv = envName(normalized.id, existing >= 0 ? this.config.modelRouting.providers[existing]?.apiKeyEnv : undefined, this.templates)
    const persisted = { ...normalized, apiKeyEnv }
    if (existing >= 0) this.config.modelRouting.providers[existing] = persisted
    else this.config.modelRouting.providers.push(persisted)
    if (this.config.modelRouting.active.provider === normalized.id && !normalized.models.some((model) => model.id === this.config.modelRouting.active.model)) {
      this.config.modelRouting.active.model = normalized.models[0]!.id
    }
    if (draft.apiKey?.trim()) {
      if (!safeStorage.isEncryptionAvailable()) throw new Error('Windows 安全存储不可用，无法安全保存 API Key')
      await this.writeHarnessCredential(apiKeyEnv, draft.apiKey.trim())
      this.secrets.values[apiKeyEnv] = safeStorage.encryptString(draft.apiKey.trim()).toString('base64')
      await this.writeSecrets()
    }
    await writeConfig(this.config)
    await this.writeHarnessSettings()
    return this.state(`${normalized.name} 已加入模型切换列表`)
  }

  async removeProvider(providerId: string): Promise<ModelHubState> {
    if (providerId === DEEPSEEK_PROVIDER) throw new Error('DeepSeek 默认提供方不能移除，可以更新它的 Key')
    const provider = this.config.modelRouting.providers.find((item) => item.id === providerId)
    if (!provider) return this.state()
    this.config.modelRouting.providers = this.config.modelRouting.providers.filter((item) => item.id !== providerId)
    const apiKeyEnv = providerEnvName(provider)
    await this.writeHarnessCredential(apiKeyEnv, undefined)
    delete this.secrets.values[apiKeyEnv]
    if (this.config.modelRouting.active.provider === providerId) {
      this.config.modelRouting.active = { provider: DEEPSEEK_PROVIDER, model: 'deepseek-v4-flash' }
    }
    await Promise.all([writeConfig(this.config), this.writeSecrets()])
    await this.writeHarnessSettings(providerId)
    return this.state(`${provider.name} 已移除，密钥也已从安全存储删除`)
  }

  async setActive(providerId: string, modelId: string): Promise<ModelHubState> {
    const provider = this.config.modelRouting.providers.find((item) => item.id === providerId)
    const model = provider?.models.find((item) => item.id === modelId)
    if (!provider || !model) throw new Error('所选模型尚未添加到启动器')
    this.config.modelRouting.active = { provider: providerId, model: modelId }
    await writeConfig(this.config)
    await this.writeHarnessSettings()
    return this.state(`已切换到 ${model.name}；新会话立即使用，正在运行的旧会话保持原模型`)
  }

  async environment(): Promise<NodeJS.ProcessEnv> {
    // Explicitly remove inherited model-key variables from the child. Harness
    // resolves the shared writable .credentials.yaml instead; an inherited
    // variable would outrank that file and make its web Models editor read-only.
    return Object.fromEntries(this.config.modelRouting.providers.map((provider) => [providerEnvName(provider), undefined]))
  }

  async refreshUsage(): Promise<ModelHubState> {
    const totals: Record<string, ModelUsageSummary> = {}
    const files = await this.sessionLogs(path.join(launcherDataPaths().dshHome, 'sessions'))
    for (const file of files.slice(-200)) {
      const input = createReadStream(file, { encoding: 'utf8' })
      const lines = readline.createInterface({ input, crlfDelay: Infinity })
      for await (const line of lines) {
        if (!line.includes('assistant/message') || !line.includes('usage')) continue
        try {
          const usage = parseModelUsageLine(line)
          if (!usage) continue
          const key = `${usage.provider}:${usage.model}`
          const current = totals[key] || {
            inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0,
            requests: 0, updatedAt: new Date().toISOString(), source: 'harness-session-log' as const
          }
          current.inputTokens += usage.inputTokens
          current.outputTokens += usage.outputTokens
          current.cacheReadTokens += usage.cacheReadTokens
          current.cacheWriteTokens += usage.cacheWriteTokens
          current.requests += 1
          totals[key] = current
        } catch {
          // Ignore unrelated or partially-written lines while Harness is appending.
        }
      }
    }
    this.usage = totals
    return this.state('已从 Harness 本地会话日志重新统计 Token 用量')
  }

  async deepSeekBalance(): Promise<DeepSeekBalanceSummary> {
    const checkedAt = new Date().toISOString()
    const provider = this.config.modelRouting.providers.find(item => item.id === DEEPSEEK_PROVIDER)
    if (!provider) return { status: 'unconfigured', message: '请先在模型连接中添加 DeepSeek 官方连接', checkedAt }
    if (!safeStorage.isEncryptionAvailable()) return { status: 'error', message: 'Windows 安全存储不可用，暂时无法读取 DeepSeek API Key', checkedAt }
    const encryptedKey = this.secrets.values[providerEnvName(provider)]
    if (!encryptedKey) return { status: 'unconfigured', message: '请先在模型连接中设置 DeepSeek API Key', checkedAt }
    if (this.deepSeekBalanceCache?.encryptedKey === encryptedKey && this.deepSeekBalanceCache.expiresAt > Date.now()) {
      return structuredClone(this.deepSeekBalanceCache.value)
    }
    if (this.deepSeekBalanceRequest) return this.deepSeekBalanceRequest
    let apiKey: string
    try {
      apiKey = safeStorage.decryptString(Buffer.from(encryptedKey, 'base64'))
    } catch {
      return { status: 'error', message: 'DeepSeek API Key 无法解密，请在模型连接中重新保存', checkedAt }
    }
    const request = queryDeepSeekBalance(apiKey).catch((error): DeepSeekBalanceSummary => ({
      status: 'error',
      message: error instanceof Error ? error.message : 'DeepSeek 余额暂时查询失败，请稍后再点我',
      checkedAt: new Date().toISOString()
    })).then((value) => {
      this.deepSeekBalanceCache = {
        encryptedKey,
        expiresAt: Date.now() + (value.status === 'available' || value.status === 'unavailable' ? 60_000 : 15_000),
        value
      }
      return structuredClone(value)
    }).finally(() => {
      if (this.deepSeekBalanceRequest === request) this.deepSeekBalanceRequest = undefined
    })
    this.deepSeekBalanceRequest = request
    return request
  }

  async testMultimodal(request: MultimodalTestRequest): Promise<MultimodalTestResult> {
    const provider = this.state().providers.find((item) => item.id === request.provider)
    if (!provider) throw new Error('所选模型提供方尚未加入启动器')
    if (!provider.models.some((model) => model.id === request.model)) throw new Error('所选模型不在当前连接中')
    if (!safeStorage.isEncryptionAvailable()) throw new Error('Windows 安全存储不可用，无法读取 API Key')
    const encrypted = this.secrets.values[provider.apiKeyEnv]
    if (!encrypted) throw new Error(`请先为 ${provider.name} 保存 API Key`)
    let apiKey = ''
    try { apiKey = safeStorage.decryptString(Buffer.from(encrypted, 'base64')) } catch { throw new Error('API Key 无法解密，请重新保存') }
    if (!apiKey.trim()) throw new Error(`请先为 ${provider.name} 保存 API Key`)
    return runMultimodalApi(provider, request, apiKey)
  }

  private async sessionLogs(root: string): Promise<string[]> {
    const files: string[] = []
    const walk = async (directory: string): Promise<void> => {
      let entries
      try { entries = await readdir(directory, { withFileTypes: true }) } catch { return }
      for (const entry of entries) {
        const target = path.join(directory, entry.name)
        if (entry.isDirectory()) await walk(target)
        else if (entry.isFile() && entry.name.endsWith('.jsonl')) files.push(target)
      }
    }
    await walk(root)
    return files.sort()
  }

  private async writeSecrets(): Promise<void> {
    const target = secretPath()
    await mkdir(path.dirname(target), { recursive: true })
    const temporary = `${target}.next`
    await writeFile(temporary, `${JSON.stringify(this.secrets, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
    await rename(temporary, target)
  }

  private providerProfiles(): HarnessProviderProfile[] {
    return this.config.modelRouting.providers.map((provider) => ({
      ...provider,
      apiKeyEnv: providerEnvName(provider)
    }))
  }

  private includeOfficialDeepSeekModels(): boolean {
    const provider = this.config.modelRouting.providers.find((item) => item.id === DEEPSEEK_PROVIDER)
    const template = this.templates.find((item) => item.id === DEEPSEEK_PROVIDER)
    if (!provider || !template) return false
    const byId = new Map(provider.models.map((model) => [model.id, model]))
    const officialIds = new Set(template.suggestedModels.map((model) => model.id))
    const next = [
      ...template.suggestedModels.map((model) => ({ ...byId.get(model.id), ...model })),
      ...provider.models.filter((model) => !officialIds.has(model.id))
    ].slice(0, 50)
    if (JSON.stringify(next) === JSON.stringify(provider.models)) return false
    provider.models = next
    return true
  }

  /** Import provider profiles and the active route changed from Harness web. */
  private async importHarnessSettings(): Promise<boolean> {
    const target = path.join(launcherDataPaths().dshHome, 'settings.yaml')
    let source: string
    try {
      source = await readFile(target, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return true
      throw error
    }
    const previousProviders = this.config.modelRouting.providers
    const parsed = parseHarnessModelSettings(source, this.providerProfiles(), this.config.modelRouting.active)
    const nextProviders: PersistedConfig['modelRouting']['providers'] = parsed.providers.map((provider) => ({ ...provider }))
    const changed = JSON.stringify({ active: this.config.modelRouting.active, providers: previousProviders })
      !== JSON.stringify({ active: parsed.active, providers: nextProviders })
    if (!changed) return false

    const nextRefs = new Set(nextProviders.map(providerEnvName))
    for (const provider of previousProviders) {
      const ref = providerEnvName(provider)
      if (!nextRefs.has(ref)) delete this.secrets.values[ref]
    }
    this.config.modelRouting.active = parsed.active
    this.config.modelRouting.providers = nextProviders
    await Promise.all([writeConfig(this.config), this.writeSecrets()])
    await this.importHarnessCredentials()
    return true
  }

  private async initializeHarnessCredentials(): Promise<void> {
    const target = path.join(launcherDataPaths().dshHome, '.credentials.yaml')
    let source = '{}\n'
    let targetExists = true
    try {
      source = await readFile(target, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      targetExists = false
    }
    const stored = parseHarnessCredentials(source)
    // Older launchers either encrypted keys locally or inherited them from the
    // launch environment. Import an environment value only before Harness has
    // created its shared credential document. Once that file exists, a missing
    // entry is an intentional user deletion and must never be resurrected.
    if (this.config.modelRouting.credentialSyncVersion !== 1 || !targetExists) {
      const updates: Record<string, string> = {}
      for (const provider of this.config.modelRouting.providers) {
        const ref = providerEnvName(provider)
        if (stored[ref] !== undefined) continue
        if (safeStorage.isEncryptionAvailable()) {
          const encrypted = this.secrets.values[ref]
          if (encrypted) {
            try {
              const value = safeStorage.decryptString(Buffer.from(encrypted, 'base64'))
              if (value.trim()) updates[ref] = value
            } catch {
              // Damaged launcher ciphertext cannot be migrated; try the legacy
              // environment source below without exposing either value.
            }
          }
        }
        if (updates[ref] === undefined && !targetExists) {
          const legacyValue = process.env[ref]
          if (legacyValue?.trim()) updates[ref] = legacyValue.trim()
        }
      }
      if (Object.keys(updates).length) await this.writeHarnessCredentials(updates)
      this.config.modelRouting.credentialSyncVersion = 1
      await writeConfig(this.config)
    }
    await this.importHarnessCredentials()
  }

  /** Mirror Harness's writable credential source into Windows encrypted storage. */
  private async importHarnessCredentials(): Promise<boolean> {
    const target = path.join(launcherDataPaths().dshHome, '.credentials.yaml')
    let source = '{}\n'
    try {
      source = await readFile(target, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    const values = parseHarnessCredentials(source)
    if (!safeStorage.isEncryptionAvailable()) return false
    let changed = false
    for (const provider of this.config.modelRouting.providers) {
      const ref = providerEnvName(provider)
      const next = values[ref]
      const encrypted = this.secrets.values[ref]
      let current: string | undefined
      if (encrypted) {
        try { current = safeStorage.decryptString(Buffer.from(encrypted, 'base64')) } catch { /* replace below */ }
      }
      if (next === undefined) {
        if (encrypted !== undefined) {
          delete this.secrets.values[ref]
          changed = true
        }
      } else if (next !== current) {
        this.secrets.values[ref] = safeStorage.encryptString(next).toString('base64')
        changed = true
      }
    }
    if (changed) await this.writeSecrets()
    return changed
  }

  private async writeHarnessCredential(ref: string, value: string | undefined): Promise<void> {
    await this.writeHarnessCredentials({ [ref]: value })
  }

  private async writeHarnessCredentials(updates: Record<string, string | undefined>): Promise<void> {
    const target = path.join(launcherDataPaths().dshHome, '.credentials.yaml')
    await mkdir(path.dirname(target), { recursive: true, mode: 0o700 })
    await withFileLock(target, async () => {
      let source = '{}\n'
      try {
        source = await readFile(target, 'utf8')
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
      await writeFileAtomic(target, mergeHarnessCredentials(source, updates), { mode: 0o600, dirMode: 0o700 })
    })
  }

  private startWatchers(): void {
    const paths = launcherDataPaths()
    const targets = [
      { path: path.join(paths.dshHome, 'settings.yaml'), kind: 'settings' as const },
      { path: path.join(paths.dshHome, '.credentials.yaml'), kind: 'credentials' as const }
    ]
    for (const target of targets) {
      const watcher = watchFile(target.path, { interval: 400, persistent: false }, (current, previous) => {
        if (current.mtimeMs === previous.mtimeMs && current.size === previous.size) return
        this.queueExternalSync(target.kind)
      })
      watcher.unref()
      this.watchTargets.push(target.path)
    }
  }

  private queueExternalSync(kind: 'settings' | 'credentials'): void {
    this.syncQueue = this.syncQueue.then(async () => {
      const changed = kind === 'settings'
        ? await this.importHarnessSettings()
        : await this.importHarnessCredentials()
      if (changed) {
        this.onExternalChange?.(this.state(kind === 'settings'
          ? '已同步 Harness 网页中的模型与默认选择'
          : '已同步 Harness 网页中更新的 API Key'))
      }
    }).catch(() => {
      this.onExternalChange?.(this.state('Harness 网页模型配置同步失败，请检查设置文件'))
    })
  }

  private async writeHarnessSettings(removedProviderId?: string): Promise<void> {
    const target = path.join(launcherDataPaths().dshHome, 'settings.yaml')
    await mkdir(path.dirname(target), { recursive: true, mode: 0o700 })
    await withFileLock(target, async () => {
      let source = '{}\n'
      try {
        source = await readFile(target, 'utf8')
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
      const merged = mergeHarnessModelSettings(source, this.config.modelRouting.active, this.providerProfiles(), removedProviderId)
      await writeFileAtomic(target, merged, { mode: 0o600, dirMode: 0o700 })
    })
  }
}
