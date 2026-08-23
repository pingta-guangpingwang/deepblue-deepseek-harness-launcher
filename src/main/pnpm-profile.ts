import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { parse } from 'yaml'

export function pnpmProfileEnvironment(modulesYaml: string): NodeJS.ProcessEnv {
  try {
    const value = parse(modulesYaml) as { storeDir?: unknown }
    if (typeof value?.storeDir !== 'string' || !path.isAbsolute(value.storeDir)) return {}
    return {
      npm_config_store_dir: value.storeDir,
      pnpm_config_store_dir: value.storeDir
    }
  } catch {
    return {}
  }
}

/** Keep plugin updates on the store that created the existing web profile. */
export async function readPnpmProfileEnvironment(dshHome: string): Promise<NodeJS.ProcessEnv> {
  try {
    const modulesYaml = await readFile(path.join(dshHome, 'profiles', 'web', 'node_modules', '.modules.yaml'), 'utf8')
    return pnpmProfileEnvironment(modulesYaml)
  } catch {
    return {}
  }
}
