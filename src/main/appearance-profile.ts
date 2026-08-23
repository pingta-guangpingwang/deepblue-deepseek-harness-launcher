import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'

const APPEARANCE_PACKAGE = '@deepblue/dsh-skin-runtime'

interface WebProfile {
  name?: string
  private?: boolean
  dependencies?: Record<string, string>
  dsh?: { profile?: { bundles?: string[] } }
}

export function appearanceProfileWithArchive(profile: WebProfile, archive: string): WebProfile {
  const normalizedArchive = archive.split(path.sep).join('/')
  const bundles = profile.dsh?.profile?.bundles || []
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
