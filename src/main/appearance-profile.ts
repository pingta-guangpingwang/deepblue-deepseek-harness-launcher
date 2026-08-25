import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import * as tar from 'tar'

const APPEARANCE_PACKAGE = '@deepblue/dsh-skin-runtime'
const DEFAULT_WEB_BUNDLES = ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app']

interface WebProfile {
  name?: string
  private?: boolean
  dependencies?: Record<string, string>
  dsh?: { profile?: { bundles?: string[] } }
}

export function appearanceProfileWithArchive(profile: WebProfile, archive: string): WebProfile {
  const normalizedArchive = archive.split(path.sep).join('/')
  // DSH initializes these bundles only when the profile file does not exist.
  // The launcher must create the file early to install the appearance plugin,
  // so a genuinely fresh profile needs the same defaults seeded here.
  const existingBundles = profile.dsh?.profile?.bundles
  const bundles = existingBundles?.length ? existingBundles : DEFAULT_WEB_BUNDLES
  return {
    ...profile,
    name: profile.name || 'dsh-profile-web',
    private: true,
    dsh: {
      ...profile.dsh,
      profile: {
        ...profile.dsh?.profile,
        bundles: [...new Set([...bundles, APPEARANCE_PACKAGE])]
      }
    },
    dependencies: {
      ...profile.dependencies,
      [APPEARANCE_PACKAGE]: `file:${normalizedArchive}`
    }
  }
}

/**
 * Older launcher builds left the web profile pointing at a tarball inside the
 * previous installation directory. Rewrite only this managed dependency before
 * invoking `dsh plugin add`, so pnpm never has to open a deleted old installer.
 */
export async function prepareAppearanceProfile(dshHome: string, archive: string): Promise<void> {
  const profilePath = path.join(dshHome, 'profiles', 'web', 'package.json')
  let profile: WebProfile = {}
  try { profile = JSON.parse(await readFile(profilePath, 'utf8')) as WebProfile } catch { /* The first plugin install creates a new profile. */ }
  const next = appearanceProfileWithArchive(profile, archive)
  await mkdir(path.dirname(profilePath), { recursive: true })
  await writeFile(`${profilePath}.next`, `${JSON.stringify(next, null, 2)}\n`, 'utf8')
  await rename(`${profilePath}.next`, profilePath)
}

/**
 * Upgrade the launcher's own trusted appearance package without asking pnpm to
 * resolve every unrelated third-party dependency in the user's web profile.
 * Harness is stopped when this runs, so a sibling rename gives us an atomic
 * replacement and a recoverable backup on Windows.
 */
export async function installAppearanceRuntimeAtomically(dshHome: string, archive: string, expectedVersion: string): Promise<void> {
  const scopeDirectory = path.join(dshHome, 'profiles', 'web', 'node_modules', '@deepblue')
  const target = path.join(scopeDirectory, 'dsh-skin-runtime')
  const nonce = randomUUID()
  const staging = path.join(scopeDirectory, `.dsh-skin-runtime-next-${nonce}`)
  const backup = path.join(scopeDirectory, `.dsh-skin-runtime-backup-${nonce}`)
  await mkdir(staging, { recursive: true })
  try {
    await tar.x({
      cwd: staging,
      file: archive,
      strip: 1,
      strict: true,
      preservePaths: false,
      filter: (entryPath, entry) => entryPath.startsWith('package/') && (!('type' in entry) || (entry.type !== 'SymbolicLink' && entry.type !== 'Link'))
    })
    const manifest = JSON.parse(await readFile(path.join(staging, 'package.json'), 'utf8')) as { name?: string; version?: string }
    if (manifest.name !== APPEARANCE_PACKAGE || manifest.version !== expectedVersion) {
      throw new Error(`外观插件归档不匹配：${manifest.name || 'unknown'}@${manifest.version || 'unknown'}`)
    }
    await Promise.all([
      readFile(path.join(staging, 'lib', 'client.js')),
      readFile(path.join(staging, 'lib', 'index.js'))
    ])

    let previousMoved = false
    try {
      await rename(target, backup)
      previousMoved = true
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    try {
      await rename(staging, target)
    } catch (error) {
      if (previousMoved) await rename(backup, target).catch(() => undefined)
      throw error
    }
    if (previousMoved) await rm(backup, { recursive: true, force: true })
  } finally {
    await rm(staging, { recursive: true, force: true })
  }
}
