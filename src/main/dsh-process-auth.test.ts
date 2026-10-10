import { expect, it } from 'vitest'
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { clearDshProcessAuth, prepareDshProcessAuthentication, publishDshProcessAuth } from './dsh-process-auth'

it('publishes only in the fixed private directory and only the owning PID can clear it', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'dsh-private-auth-'))
  try {
    await publishDshProcessAuth(home, { version: '0.2.1-alpha.2', pid: process.pid, cwd: home, url: 'http://127.0.0.1:3080/?token=SYNTHETIC_LOCAL_ONLY_TOKEN' })
    const file = path.join(home, 'launcher/process-auth.json')
    expect(JSON.parse(await readFile(file, 'utf8')).pid).toBe(process.pid)
    await expect(prepareDshProcessAuthentication(home)).rejects.toThrow('已有 DSH 进程')
    expect(JSON.parse(await readFile(file, 'utf8')).pid).toBe(process.pid)
    if (process.platform === 'win32') {
      const encoded = Buffer.from(file, 'utf8').toString('base64')
      const script = `$p=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encoded}')); $a=[IO.File]::GetAccessControl($p); $ids=@($a.Access | ForEach-Object { $_.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value }); $allowed=@([Security.Principal.WindowsIdentity]::GetCurrent().User.Value,'S-1-5-18','S-1-5-32-544'); if($ids.Count -ne 3 -or @($ids | Where-Object { $_ -notin $allowed }).Count) { exit 2 }; Write-Output 'PRIVATE_ACL_OK'`
      const result = await promisify(execFile)('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { windowsHide: true })
      expect(result.stdout.trim()).toBe('PRIVATE_ACL_OK')
    }
    clearDshProcessAuth(home, process.pid + 1000)
    expect((await stat(file)).isFile()).toBe(true)
    clearDshProcessAuth(home, process.pid)
    await expect(stat(file)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await publishDshProcessAuth(home, { version: '0.2.1-alpha.2', pid: process.pid, cwd: home, url: 'http://127.0.0.1:3080/?token=SYNTHETIC_LOCAL_ONLY_TOKEN' }, () => false)).toBe(false)
    await expect(stat(file)).rejects.toMatchObject({ code: 'ENOENT' })
  } finally { await rm(home, { recursive: true, force: true }) }
})
