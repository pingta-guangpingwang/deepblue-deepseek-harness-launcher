export type PageId = 'home' | 'skins' | 'pets' | 'versions' | 'prompts' | 'skills' | 'workflows' | 'knowledge' | 'tools' | 'agents' | 'library' | 'models' | 'news' | 'games' | 'careers' | 'workspaces' | 'diagnostics' | 'settings'
export type RunStatus = 'stopped' | 'starting' | 'running' | 'stopping' | 'error'
export type TaskStatus = 'queued' | 'running' | 'completed' | 'failed' | 'paused'
export type DistributionMode = 'online' | 'offline'
export type SkinMediaKind = 'image' | 'animated-image' | 'video'
export type SkinStyle = 'realistic' | 'anime' | 'cyber' | 'pixel' | 'nature' | 'minimal'
export type PetMediaKind = 'static' | 'animated'
export type PetSpecies = 'cat' | 'dog' | 'whale' | 'fantasy' | 'robot' | 'pixel' | 'other'
export type PetStyle = 'cute' | 'calm' | 'playful' | 'cyber' | 'pixel'

export interface SourceConfig {
  id: 'github' | 'gitee' | 'oss' | 'runtime-v2' | 'npmmirror'
  name: string
  baseUrl: string
  enabled: boolean
  kind: 'manifest' | 'repository' | 'registry' | 'artifacts'
}

export interface SourceHealth extends SourceConfig {
  status: 'checking' | 'available' | 'slow' | 'unavailable' | 'unconfigured'
  latencyMs?: number
  message?: string
}

export interface EnvironmentItem {
  id: 'node' | 'harness' | 'pnpm' | 'network'
  label: string
  version?: string
  status: 'ready' | 'missing' | 'checking' | 'warning'
  detail: string
}

export interface LauncherTask {
  id: string
  title: string
  detail?: string
  status: TaskStatus
  progress: number
  speed?: string
  createdAt: string
}

export interface LogLine {
  id: number
  time: string
  level: 'INFO' | 'WARN' | 'ERROR'
  message: string
}

export interface HarnessVersion {
  version: string
  channel: 'stable' | 'preview'
  installed: boolean
  active: boolean
  rollbackReady: boolean
  sizeMb?: number
  publishedAt?: string
  notes: string[]
}

export interface CatalogPlugin {
  id: string
  name: string
  packageSpec: string
  description: string
  author: string
  version: string
  installed: boolean
  updateAvailable: boolean
  featured: boolean
  tags: string[]
}

export interface ModelCatalogItem {
  id: string
  provider: string
  model: string
  displayName: string
  description: string
  context: string
  capabilities: string[]
  status: 'available' | 'preview' | 'deprecated'
  configured: boolean
  docsUrl?: string
}

export interface ModelProviderTemplate {
  id: string
  name: string
  description: string
  region: 'china' | 'global' | 'custom'
  api: 'deepseek' | 'openai-responses' | 'openai-completions' | 'anthropic-messages' | 'google-generative-ai'
  baseURL: string
  apiKeyEnv: string
  docsUrl: string
  billingUrl?: string
  custom: boolean
  featured: boolean
  catalogUpdatedAt: string
  suggestedModels: Array<{ id: string; name: string; description?: string; recommended?: boolean }>
}

export interface ModelProviderConnection {
  id: string
  name: string
  api: ModelProviderTemplate['api']
  baseURL: string
  apiKeyEnv: string
  configured: boolean
  secureStorage: boolean
  custom: boolean
  models: Array<{ id: string; name: string }>
  updatedAt: string
  docsUrl?: string
  billingUrl?: string
}

export interface ActiveModelSelection {
  provider: string
  model: string
  displayName: string
}

export interface ModelUsageSummary {
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  requests: number
  updatedAt: string
  source: 'harness-session-log'
}

export interface MultimodalTestRequest {
  provider: string
  model: string
  prompt: string
  image: {
    name: string
    mimeType: 'image/jpeg' | 'image/png' | 'image/webp' | 'image/gif'
    dataUrl: string
  }
}

export interface MultimodalTestUsage {
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
}

export interface MultimodalTestResult {
  status: 'success' | 'unsupported' | 'error'
  provider: string
  model: string
  text?: string
  error?: string
  latencyMs: number
  usage?: MultimodalTestUsage
  completedAt: string
}

export interface ModelHubState {
  active: ActiveModelSelection
  templates: ModelProviderTemplate[]
  providers: ModelProviderConnection[]
  usage: Record<string, ModelUsageSummary>
  secureStorageAvailable: boolean
  message?: string
}

export interface ModelProviderDraft {
  id: string
  name: string
  api: ModelProviderTemplate['api']
  baseURL: string
  apiKey?: string
  models: Array<{ id: string; name: string }>
  docsUrl?: string
  billingUrl?: string
  custom?: boolean
}

export interface LauncherNewsItem {
  id: string
  title: string
  summary: string
  category: string
  publishedAt: string
  sourceCount: number
  heat: number
  url: string
  sourceName?: string
  trustStatus?: string
}

export interface LauncherNewsDetail extends LauncherNewsItem {
  content: string
  contentLabel: string
  sources: Array<{
    name: string
    title: string
    url: string
    publishedAt: string
  }>
}

export interface LauncherGameItem {
  slug: string
  title: string
  summary: string
  coverUrl?: string
  category: string
  tags: string[]
  featured: boolean
  loginRequired: boolean
  url: string
  mode: 'hosted_playable' | 'external_playable' | 'source_only' | 'official_landmark'
  sourceName?: string
  stars?: number
  sourceUrl?: string
}

export interface LauncherResourceItem {
  id: string
  type: 'ai_native_tool' | 'software_tool' | 'workflow_platform' | 'skill' | 'workflow' | 'agent' | 'knowledge_base' | 'prompt' | string
  title: string
  author: string
  summary: string
  firstStep: string
  capabilities: string[]
  difficulty: string
  pricingMode: string
  url?: string
  canonicalUrl: string
  editorialScore: number
  popularityScore: number
  rating: number
  ratingCount: number
  stars?: number
  forks?: number
  openIssues?: number
  repositoryUrl?: string
  editorialComment?: string
  installPaths?: string[]
  longDescription?: string
  executionMode?: string
  modelRequirement?: string
  tokenEstimate?: string
  inputs?: string[]
  steps?: string[]
  outcomes?: string[]
  limitations?: string
  promptText?: string
  skillContent?: string
  workflowBlueprint?: unknown
  verifiedAt?: string
  sourceName?: string
  sourceUrl?: string
}

export interface LauncherResourceComment {
  id: string
  parentId?: string
  body: string
  createdAt: string
  authorName: string
  avatarUrl?: string
  mine: boolean
}

export interface LauncherResourceEngagement {
  resourceId: string
  counts: { favorite: number; like: number; comment: number; share: number }
  comments: LauncherResourceComment[]
}

export interface LauncherLibraryEntry {
  id: string
  type: LauncherResourceItem['type']
  title: string
  repositoryUrl?: string
  sourceUrl?: string
  status: 'queued' | 'installed' | 'failed'
  addedAt: string
  installedAt?: string
  installedPath?: string
  message?: string
}

export interface LauncherCareerTask {
  id: string
  title: string
  summary: string
}

export interface LauncherCareerItem {
  id: string
  industryId: string
  industryName: string
  title: string
  summary: string
  tasks: LauncherCareerTask[]
}

export interface LauncherAccountState {
  status: 'checking' | 'signed_out' | 'signed_in' | 'unavailable'
  user?: { id: string; name: string; email?: string; avatarUrl?: string }
  message?: string
  sessionRemembered: boolean
}

export interface LauncherFavoriteState {
  status: 'signed_out' | 'loading' | 'ready' | 'unavailable'
  resourceIds: string[]
  ownerId?: string
  updatedAt?: string
  message?: string
}

export interface DiscoveryHubState {
  status: 'loading' | 'ready' | 'offline'
  updatedAt: string
  news: LauncherNewsItem[]
  hotNews: LauncherNewsItem[]
  games: LauncherGameItem[]
  tools: LauncherResourceItem[]
  extensions: LauncherResourceItem[]
  prompts: LauncherResourceItem[]
  skills: LauncherResourceItem[]
  workflows: LauncherResourceItem[]
  knowledgeBases: LauncherResourceItem[]
  agents: LauncherResourceItem[]
  careers: LauncherCareerItem[]
  totals: { games: number; tools: number; extensions: number; prompts: number; skills: number; workflows: number; knowledgeBases: number; agents: number; careers: number }
  message?: string
}

export interface WorkspaceEntry {
  path: string
  name: string
  lastOpenedAt: string
  pinned: boolean
}

export interface LauncherSettings {
  workspace: string
  port: number
  autoOpen: boolean
  theme: 'light' | 'dark' | 'system'
  channel: 'stable' | 'preview'
  backupBeforeUpdate: boolean
  keepBackups: number
  installMode: 'package' | 'source'
  skinCatalogUrl: string
  petCatalogUrl: string
  sources: SourceConfig[]
}

export interface SkinLicense {
  name: 'CC0-1.0' | 'CC-BY-4.0' | 'CC-BY-SA-4.0'
  url: string
  author: string
  sourceUrl: string
  attribution?: string
}

export interface SkinAsset {
  url: string
  sha256: string
  size: number
  mime: 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif' | 'video/mp4' | 'video/webm'
}

export interface SkinCatalogItem {
  id: string
  name: string
  description: string
  mediaKind: SkinMediaKind
  styles: SkinStyle[]
  tags: string[]
  featured: boolean
  contentRating: 'everyone'
  thumbnail: SkinAsset
  media: SkinAsset
  poster?: SkinAsset
  license: SkinLicense
  presentation: {
    position: string
    overlay: string
    blurPx: number
    surfaceOpacity: number
  }
}

export interface SkinStoreState {
  status: 'idle' | 'loading' | 'ready' | 'offline' | 'error'
  source: 'remote' | 'bundled'
  generatedAt: string
  activeSkinId?: string
  downloadedSkinIds: string[]
  items: SkinCatalogItem[]
  message?: string
}

export interface PetLicense {
  name: 'CC0-1.0' | 'CC-BY-4.0' | 'CC-BY-SA-4.0' | 'LOCAL'
  url: string
  author: string
  sourceUrl: string
  attribution?: string
}

export interface PetAsset {
  url: string
  sha256: string
  size: number
  mime: 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif'
}

export interface PetBehavior {
  widthPx: number
  idleMotion: 'float' | 'bounce' | 'none'
  clickMotion: 'hop' | 'spin' | 'heart'
  speechLines: string[]
  autoSpeakIntervalSec?: number
  hoverMotion?: 'perk' | 'none'
}

export interface PetCatalogItem {
  id: string
  name: string
  description: string
  mediaKind: PetMediaKind
  species: PetSpecies
  styles: PetStyle[]
  tags: string[]
  featured: boolean
  contentRating: 'everyone'
  thumbnail: PetAsset
  media: PetAsset
  license: PetLicense
  behavior: PetBehavior
  origin?: 'catalog' | 'custom'
  previewDataUrl?: string
}

export interface PetStoreState {
  status: 'idle' | 'loading' | 'ready' | 'offline' | 'error'
  source: 'remote' | 'bundled'
  generatedAt: string
  activePetId?: string
  downloadedPetIds: string[]
  items: PetCatalogItem[]
  message?: string
}

export interface LauncherSnapshot {
  launcherVersion: string
  platform: string
  distributionMode: DistributionMode
  runStatus: RunStatus
  serviceUrl?: string
  activeHarnessVersion: string
  latestHarnessVersion: string
  launcherUpdate?: LauncherUpdateInfo
  environment: EnvironmentItem[]
  sources: SourceHealth[]
  tasks: LauncherTask[]
  logs: LogLine[]
  versions: HarnessVersion[]
  plugins: CatalogPlugin[]
  models: ModelCatalogItem[]
  modelHub: ModelHubState
  account: LauncherAccountState
  favorites: LauncherFavoriteState
  resourceLibrary: LauncherLibraryEntry[]
  discovery: DiscoveryHubState
  workspaces: WorkspaceEntry[]
  skins: SkinStoreState
  pets: PetStoreState
  settings: LauncherSettings
}

export interface LauncherUpdateInfo {
  version: string
  notes: string[]
  artifact: { platform: string; arch: string; distribution?: DistributionMode; url: string; sha256: string; size: number }
}

export type RuntimeModuleId =
  | 'node-runtime'
  | 'harness-core'
  | 'package-manager'
  | 'terminal-native'
  | 'launcher-ui'

export interface RuntimeModuleMirror {
  id: 'gitee' | 'github' | 'oss'
  url: string
}

export interface RuntimeModuleArtifact {
  platform: 'win32' | 'darwin' | 'linux'
  arch: 'x64' | 'arm64'
  format: 'tar.gz'
  sha256: string
  size: number
  unpackedSize: number
  mirrors: RuntimeModuleMirror[]
}

export interface RuntimeModuleProbe {
  path: string
  args: string[]
  expectedPattern: string
  timeoutMs: number
}

export interface RuntimeModuleRelease {
  id: RuntimeModuleId
  version: string
  required: boolean
  installWhen: 'bootstrap' | 'harness' | 'plugin-manager' | 'terminal' | 'launcher'
  dependencies: RuntimeModuleId[]
  artifacts: RuntimeModuleArtifact[]
  probe?: RuntimeModuleProbe
}

export interface LauncherApi {
  getSnapshot(): Promise<LauncherSnapshot>
  refreshEnvironment(): Promise<LauncherSnapshot>
  checkSources(): Promise<LauncherSnapshot>
  startHarness(): Promise<LauncherSnapshot>
  stopHarness(): Promise<LauncherSnapshot>
  installHarness(version?: string): Promise<LauncherSnapshot>
  downloadLauncherUpdate(): Promise<LauncherSnapshot>
  rollbackHarness(version: string): Promise<LauncherSnapshot>
  repair(): Promise<LauncherSnapshot>
  chooseWorkspace(): Promise<LauncherSnapshot>
  openPath(path: string): Promise<void>
  openExternal(url: string): Promise<void>
  saveSettings(patch: Partial<LauncherSettings>): Promise<LauncherSnapshot>
  pluginAction(action: 'install' | 'update' | 'remove', packageSpec: string): Promise<LauncherSnapshot>
  refreshDiscovery(): Promise<LauncherSnapshot>
  newsDetail(id: string): Promise<LauncherNewsDetail>
  resourceDetail(id: string): Promise<LauncherResourceItem>
  resourceEngagement(id: string): Promise<LauncherResourceEngagement>
  commentResource(id: string, body: string): Promise<LauncherResourceEngagement>
  queueResource(id: string): Promise<LauncherSnapshot>
  installLibraryResource(id: string): Promise<LauncherSnapshot>
  removeLibraryResource(id: string): Promise<LauncherSnapshot>
  copyText(text: string): Promise<void>
  accountLogin(): Promise<LauncherSnapshot>
  accountLogout(): Promise<LauncherSnapshot>
  refreshFavorites(): Promise<LauncherSnapshot>
  toggleResourceFavorite(id: string): Promise<LauncherSnapshot>
  playGame(slug: string): Promise<LauncherSnapshot>
  saveModelProvider(draft: ModelProviderDraft): Promise<LauncherSnapshot>
  removeModelProvider(providerId: string): Promise<LauncherSnapshot>
  setActiveModel(provider: string, model: string): Promise<LauncherSnapshot>
  refreshModelUsage(): Promise<LauncherSnapshot>
  testMultimodal(request: MultimodalTestRequest): Promise<MultimodalTestResult>
  refreshSkins(): Promise<LauncherSnapshot>
  applySkin(skinId: string): Promise<LauncherSnapshot>
  clearSkin(): Promise<LauncherSnapshot>
  refreshPets(): Promise<LauncherSnapshot>
  applyPet(petId: string): Promise<LauncherSnapshot>
  clearPet(): Promise<LauncherSnapshot>
  importPet(): Promise<LauncherSnapshot>
  removeCustomPet(petId: string): Promise<LauncherSnapshot>
  windowAction(action: 'minimize' | 'maximize' | 'close'): Promise<void>
  onSnapshot(listener: (snapshot: LauncherSnapshot) => void): () => void
}

export interface SignedCatalogPayload {
  schemaVersion: 1 | 2
  generatedAt: string
  launcher?: { version: string; notes: string[]; artifacts: Array<{ platform: string; arch: string; distribution?: DistributionMode; url: string; sha256: string; size: number }> }
  harness: HarnessVersion[]
  plugins: CatalogPlugin[]
  models: ModelCatalogItem[]
  runtimeModules?: RuntimeModuleRelease[]
}

export interface SignedCatalogManifest {
  keyId: string
  algorithm: 'ed25519'
  payload: SignedCatalogPayload
  signature: string
}

export interface SkinCatalogPayload {
  schemaVersion: 1
  generatedAt: string
  pageSize: 20
  items: SkinCatalogItem[]
}

export interface SignedSkinCatalogManifest {
  keyId: string
  algorithm: 'ed25519'
  payload: SkinCatalogPayload
  signature: string
}

export interface PetCatalogPayload {
  schemaVersion: 1
  generatedAt: string
  pageSize: 20
  items: PetCatalogItem[]
}

export interface SignedPetCatalogManifest {
  keyId: string
  algorithm: 'ed25519'
  payload: PetCatalogPayload
  signature: string
}

export type StoreTrustKind = 'skin' | 'pet'

export interface StoreTrustKey {
  keyId: string
  algorithm: 'ed25519'
  publicKeyPem: string
  status: 'active' | 'retired'
}

export interface StoreTrustPayload {
  schemaVersion: 1
  generatedAt: string
  store: StoreTrustKind
  catalogUrl: string
  keys: StoreTrustKey[]
}

export interface SignedStoreTrustManifest {
  keyId: string
  algorithm: 'ed25519'
  payload: StoreTrustPayload
  signature: string
}
