import { expect, it } from 'vitest'
import { parseHarnessStartupUrl, redactHarnessAuthentication } from './dsh-startup-url'
it('keeps the process token only for the launched local listener and redacts logs', () => {
  const line = 'dsh web: http://127.0.0.1:3080/?token=synthetic-process-token'
  expect(parseHarnessStartupUrl(line, 3080)).toBe('http://127.0.0.1:3080/?token=synthetic-process-token')
  expect(redactHarnessAuthentication(line)).not.toContain('synthetic-process-token')
  expect(parseHarnessStartupUrl(line, 3081)).toBeUndefined()
  expect(parseHarnessStartupUrl('http://127.0.0.1:3080/?token=one&token=two', 3080)).toBeUndefined()
  expect(parseHarnessStartupUrl('http://127.0.0.1:3080/?target=https://evil.invalid', 3080)).toBeUndefined()
  expect(parseHarnessStartupUrl('http://127.0.0.1:3080/path?token=one', 3080)).toBeUndefined()
})
