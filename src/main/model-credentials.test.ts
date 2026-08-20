import { describe, expect, it } from 'vitest'
import { mergeHarnessCredentials, parseHarnessCredentials } from './model-credentials'

describe('Harness credential synchronization', () => {
  it('preserves unrelated credentials while setting and removing managed keys', () => {
    const output = mergeHarnessCredentials(`# keep this comment\nSEARCH_KEY: search-secret\nOLD_KEY: old\n`, {
      DEEPSEEK_API_KEY: 'deepseek-secret',
      OLD_KEY: undefined
    })
    expect(output).toContain('# keep this comment')
    expect(parseHarnessCredentials(output)).toEqual({
      SEARCH_KEY: 'search-secret',
      DEEPSEEK_API_KEY: 'deepseek-secret'
    })
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
