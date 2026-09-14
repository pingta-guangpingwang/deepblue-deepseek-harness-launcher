import { parseDocument } from 'yaml'

const CREDENTIAL_REF = /^[A-Za-z_][A-Za-z0-9_]*$/
export type HarnessCredentialsLayout = 'flat' | 'versioned'

function rootDocument(source: string): Record<string, unknown> {
  const document = parseDocument(source || '{}\n', { prettyErrors: false, uniqueKeys: true })
  if (document.errors.length) throw new Error('Harness 密钥文件格式不正确')
  const root: unknown = document.toJS() ?? {}
  if (typeof root !== 'object' || root === null || Array.isArray(root)) throw new Error('Harness 密钥文件必须是键值对象')
  return root as Record<string, unknown>
}

function credentialRefs(root: Record<string, unknown>): Record<string, unknown> {
  if (!Object.keys(root).length) return {}
  if (!('version' in root)) return root
  if (root.version !== 1) throw new Error('Harness 密钥文件版本不受支持')
  if (Object.keys(root).some(key => !['version', 'refs', 'records'].includes(key))) throw new Error('Harness 密钥文件包含未知顶层字段')
  const refs = root.refs ?? {}
  if (typeof refs !== 'object' || refs === null || Array.isArray(refs)) throw new Error('Harness 密钥文件 refs 必须是键值对象')
  return refs as Record<string, unknown>
}

/** DSH 0.1.0 prereleases use the flat document; 0.1.1 and later use numeric version 1 with refs. */
export function harnessCredentialsLayoutForVersion(version: string): HarnessCredentialsLayout {
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(version)
  if (!match) return 'versioned'
  const [major, minor, patch] = match.slice(1).map(Number)
  return major! > 0 || minor! > 1 || (minor === 1 && patch! >= 1) ? 'versioned' : 'flat'
}

export function harnessCredentialsNeedLayoutMigration(source: string, version: string): boolean {
  const root = rootDocument(source)
  if (!Object.keys(root).length) return false
  return harnessCredentialsLayoutForVersion(version) === 'versioned' ? !('version' in root) : 'version' in root
}

/** Parse either supported on-disk layout without quoting secret values in failures. */
export function parseHarnessCredentials(source: string): Record<string, string> {
  const result: Record<string, string> = {}
  for (const [ref, value] of Object.entries(credentialRefs(rootDocument(source)))) {
    if (!CREDENTIAL_REF.test(ref) || typeof value !== 'string' || !value.trim()) throw new Error('Harness 密钥文件包含无效条目')
    result[ref] = value
  }
  return result
}

/** Patch selected keys and render the layout required by the Harness version that will read it. */
export function mergeHarnessCredentials(source: string, updates: Record<string, string | undefined>, layout: HarnessCredentialsLayout = 'versioned'): string {
  const root = rootDocument(source)
  const parsed = parseHarnessCredentials(source)
  for (const [ref, value] of Object.entries(updates)) {
    if (!CREDENTIAL_REF.test(ref)) throw new Error('密钥引用名称不合法')
    if (value === undefined) delete parsed[ref]
    else {
      if (!value.trim()) throw new Error('API Key 不能为空')
      parsed[ref] = value
    }
  }

  const sourceVersioned = 'version' in root
  if (layout === 'flat') {
    const records = sourceVersioned ? root.records : undefined
    if (records && typeof records === 'object' && !Array.isArray(records) && Object.keys(records).length) throw new Error('旧版 Harness 不支持当前 OAuth 凭据记录，请先升级 Harness')
    if (!sourceVersioned) {
      const document = parseDocument(source || '{}\n')
      for (const [ref, value] of Object.entries(updates)) value === undefined ? document.delete(ref) : document.set(ref, value)
      return document.toString()
    }
    const document = parseDocument('{}\n')
    for (const [ref, value] of Object.entries(parsed)) document.set(ref, value)
    return document.toString()
  }

  let normalized = source || '{}\n'
  if (!sourceVersioned) normalized = Object.keys(parsed).length
    ? `version: 1\nrefs:\n${(source || '{}\n').split('\n').map(line => line.length ? `  ${line}` : line).join('\n')}${source.endsWith('\n') ? '' : '\n'}`
    : 'version: 1\nrefs: {}\n'
  const document = parseDocument(normalized)
  document.set('version', 1)
  for (const [ref, value] of Object.entries(updates)) value === undefined ? document.deleteIn(['refs', ref]) : document.setIn(['refs', ref], value)
  return document.toString()
}
