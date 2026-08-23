import { mkdir, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'

const NO_BROWSER_PATCH = `# Managed by DeepBlue Launcher.
# The launcher owns the single default-browser handoff for this process.
- id: web-runtime
  name: '@deepseek-ai/dsh-web-app'
  config:
    openBrowser: false
    printUrl: true
    surfaceContext: true
    trustedHosts: !!js ctx.webStartup.trustedHosts
`

/**
 * Add a final launcher-only overlay that disables the Harness browser opener.
 * `--no-open` remains on the command line for older profiles, while this patch
 * also covers profiles whose own configuration accidentally re-enables it.
 */
export async function prepareHarnessNoBrowserPatch(dshHome: string): Promise<string> {
  const directory = path.join(dshHome, 'launcher')
  const target = path.join(directory, 'no-browser.patch.yml')
  const staged = `${target}.next`
  await mkdir(directory, { recursive: true })
  await writeFile(staged, NO_BROWSER_PATCH, 'utf8')
  await rename(staged, target)
  return target
}

export type BrowserOpener = (url: string) => Promise<unknown>

/** One successful automatic browser handoff at most for each launch cycle. */
export class HarnessBrowserHandoff {
  private currentCycle = 0
  private claimedCycle = 0

  begin(): number {
    this.currentCycle += 1
    return this.currentCycle
  }

  async openOnce(cycle: number, url: string, enabled: boolean, opener: BrowserOpener): Promise<boolean> {
    if (!enabled || cycle !== this.currentCycle || this.claimedCycle === cycle) return false
    // Claim before awaiting the operating-system handoff so concurrent readiness
    // signals cannot both open a browser while the first call is still pending.
    this.claimedCycle = cycle
    await opener(url)
    return true
  }
}
