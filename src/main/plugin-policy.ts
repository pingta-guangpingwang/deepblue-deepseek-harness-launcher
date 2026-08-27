export interface WebProfileManifest {
  dependencies?: Record<string, unknown>
  dsh?: {
    profile?: {
      bundles?: unknown
    }
  }
}

// Build scripts stay blocked by default. Only dependencies required by a
// reviewed catalog plugin are admitted here, package by package.
const TRUSTED_PLUGIN_BUILDS: Readonly<Record<string, readonly string[]>> = {
  '@linxin666/dsh-remote-web-ui': ['cloudflared']
}

export function pluginAllowedBuilds(packageName: string): readonly string[] {
  return TRUSTED_PLUGIN_BUILDS[packageName] || []
}

export function pluginPnpmArguments(
  action: 'install' | 'update' | 'remove',
  packageSpec: string,
  packageName: string
): string[] {
  const verb = action === 'install' ? 'add' : action
  const args = [verb]
  if (action !== 'update' || packageSpec) args.push(action === 'remove' ? packageName : packageSpec)
  if (action !== 'remove') {
    args.push(...pluginAllowedBuilds(packageName).map((dependency) => `--allow-build=${dependency}`))
  }
  return args
}

export function profileHasActivePlugin(
  manifest: WebProfileManifest,
  packageName: string,
  packageFilesPresent: boolean
): boolean {
  if (!Object.hasOwn(manifest.dependencies || {}, packageName) || !packageFilesPresent) return false
  const bundles = manifest.dsh?.profile?.bundles
  return Array.isArray(bundles) && bundles.includes(packageName)
}

export function pluginOperationTimeoutMs(packageName: string): number {
  // cloudflared's reviewed postinstall downloads its platform binary. On a
  // slow connection this can legitimately take longer than the normal plugin
  // timeout even while pnpm remains healthy.
  return pluginAllowedBuilds(packageName).length > 0 ? 12 * 60_000 : 5 * 60_000
}
