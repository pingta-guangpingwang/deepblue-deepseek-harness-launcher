import { parseDocument } from 'yaml'

const CREDENTIAL_REF = /^[A-Za-z_][A-Za-z0-9_]*$/

/** Parse Harness's private credential document without quoting secret values in failures. */
export function parseHarnessCredentials(source: string): Record<string, string> {
  const document = parseDocument(source || '{}\n', { prettyErrors: false, uniqueKeys: true })
  if (document.errors.length) throw new Error('Harness 密钥文件格式不正确')
  const root: unknown = document.toJS() ?? {}
  if (typeof root !== 'object' || root === null || Array.isArray(root)) {
    throw new Error('Harness 密钥文件必须是键值对象')
  }
  const result: Record<string, string> = {}
  for (const [ref, value] of Object.entries(root as Record<string, unknown>)) {
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
  parseHarnessCredentials(source)
  const document = parseDocument(source || '{}\n')
  for (const [ref, value] of Object.entries(updates)) {
    if (!CREDENTIAL_REF.test(ref)) throw new Error('密钥引用名称不合法')
    if (value === undefined) document.deleteIn([ref])
    else {
      if (!value.trim()) throw new Error('API Key 不能为空')
      document.setIn([ref], value)
    }
  }
  return document.toString()
}
