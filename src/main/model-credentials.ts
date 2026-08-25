import { parseDocument } from 'yaml'

const CREDENTIAL_REF = /^[A-Za-z_][A-Za-z0-9_]*$/

function credentialRefs(root: Record<string, unknown>): Record<string, unknown> {
  if (!Object.keys(root).length) return {}
  if (!('version' in root)) return root
  if (root.version !== 1) throw new Error('Harness 密钥文件版本不受支持')
  if (Object.keys(root).some(key => !['version', 'refs', 'records'].includes(key))) {
    throw new Error('Harness 密钥文件包含未知顶层字段')
  }
  const refs = root.refs ?? {}
  if (typeof refs !== 'object' || refs === null || Array.isArray(refs)) {
    throw new Error('Harness 密钥文件 refs 必须是键值对象')
  }
  return refs as Record<string, unknown>
}

/** Parse Harness's private credential document without quoting secret values in failures. */
export function parseHarnessCredentials(source: string): Record<string, string> {
  const document = parseDocument(source || '{}\n', { prettyErrors: false, uniqueKeys: true })
  if (document.errors.length) throw new Error('Harness 密钥文件格式不正确')
  const root: unknown = document.toJS() ?? {}
  if (typeof root !== 'object' || root === null || Array.isArray(root)) {
    throw new Error('Harness 密钥文件必须是键值对象')
  }
  const result: Record<string, string> = {}
  for (const [ref, value] of Object.entries(credentialRefs(root as Record<string, unknown>))) {
    if (!CREDENTIAL_REF.test(ref) || typeof value !== 'string' || !value.trim()) {
      throw new Error('Harness 密钥文件包含无效条目')
    }
    result[ref] = value
  }
  return result
}

/** Patch selected keys while preserving every credential the launcher does not own. */
export function mergeHarnessCredentials(
  source: string,
  updates: Record<string, string | undefined>
): string {
  const parsed = parseHarnessCredentials(source)
  let normalized = source || '{}\n'
  const initial = parseDocument(normalized, { prettyErrors: false, uniqueKeys: true }).toJS() ?? {}
  const versioned = typeof initial === 'object' && initial !== null && !Array.isArray(initial) && 'version' in initial
  if (!versioned) {
    normalized = Object.keys(parsed).length
      ? `version: 1\nrefs:\n${normalized.split('\n').map(line => line.length ? `  ${line}` : line).join('\n')}${normalized.endsWith('\n') ? '' : '\n'}`
      : 'version: 1\nrefs: {}\n'
  }
  const document = parseDocument(normalized)
  for (const [ref, value] of Object.entries(updates)) {
    if (!CREDENTIAL_REF.test(ref)) throw new Error('密钥引用名称不合法')
    if (value === undefined) document.deleteIn(['refs', ref])
    else {
      if (!value.trim()) throw new Error('API Key 不能为空')
      document.setIn(['refs', ref], value)
    }
  }
  return document.toString()
}
