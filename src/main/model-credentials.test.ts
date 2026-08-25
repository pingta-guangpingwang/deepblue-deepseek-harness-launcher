import { describe, expect, it } from 'vitest'
import { mergeHarnessCredentials, parseHarnessCredentials } from './model-credentials'

describe('Harness credential synchronization', () => {
  it('preserves unrelated credentials while setting and removing managed keys', () => {
    const output = mergeHarnessCredentials(`# keep this comment\nSEARCH_KEY: search-secret\nOLD_KEY: old\n`, {
      DEEPSEEK_API_KEY: 'deepseek-secret',
      OLD_KEY: undefined
    })
    expect(output).toContain('# keep this comment')
    expect(output).toContain('version: 1')
    expect(output).toContain('refs:')
    expect(parseHarnessCredentials(output)).toEqual({
      SEARCH_KEY: 'search-secret',
      DEEPSEEK_API_KEY: 'deepseek-secret'
    })
  })

  it('reads and updates the official version-1 refs layout while preserving records', () => {
    const source = `version: 1\nrefs:\n  DEEPSEEK_API_KEY: old-key\nrecords:\n  vendor/account:\n    type: oauth\n`
    expect(parseHarnessCredentials(source)).toEqual({ DEEPSEEK_API_KEY: 'old-key' })
    const output = mergeHarnessCredentials(source, { DEEPSEEK_API_KEY: 'new-key', SEARCH_KEY: 'search-key' })
    expect(parseHarnessCredentials(output)).toEqual({ DEEPSEEK_API_KEY: 'new-key', SEARCH_KEY: 'search-key' })
    expect(output).toContain('vendor/account:')
    expect(output).toContain('type: oauth')
  })

  it('fails without echoing malformed secret material', () => {
    const malformed = 'TOP_SECRET: [unterminated'
    expect(() => parseHarnessCredentials(malformed)).toThrow('Harness 密钥文件格式不正确')
    try {
      parseHarnessCredentials(malformed)
    } catch (error) {
      expect(String(error)).not.toContain('TOP_SECRET')
      expect(String(error)).not.toContain('unterminated')
    }
  })
})
