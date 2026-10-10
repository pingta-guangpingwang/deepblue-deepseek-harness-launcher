import { execFile } from 'node:child_process'
import { readFileSync, unlinkSync } from 'node:fs'
import { lstat, mkdir, realpath, rename, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'
const execute = promisify(execFile)
const windowsPowerShell = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
const publishers = new Map<string, Promise<unknown>>()

export async function prepareDshPrivateDirectory(dshHome: string): Promise<string> {
  const directory = path.join(dshHome, 'launcher')
  await mkdir(directory, { recursive: true, mode: 0o700 })
  const [home, actual, metadata] = await Promise.all([realpath(dshHome), realpath(directory), lstat(directory)])
  if (metadata.isSymbolicLink() || path.relative(home, actual) !== 'launcher') throw new Error('DSH 本机认证目录不属于当前启动器')
  if (process.platform === 'win32') {
    const encodedDirectory = Buffer.from(actual, 'utf8').toString('base64')
    const script = `$ErrorActionPreference='Stop'; $target=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encodedDirectory}')); $user=[Security.Principal.WindowsIdentity]::GetCurrent().User; $acl=New-Object Security.AccessControl.DirectorySecurity; $acl.SetAccessRuleProtection($true,$false); foreach($sid in @($user.Value,'S-1-5-18','S-1-5-32-544')) { $id=New-Object Security.Principal.SecurityIdentifier($sid); $rule=New-Object Security.AccessControl.FileSystemAccessRule($id,'FullControl','ContainerInherit,ObjectInherit','None','Allow'); $acl.AddAccessRule($rule) }; [IO.Directory]::SetAccessControl($target,$acl); $actualAcl=[IO.Directory]::GetAccessControl($target); if(!$actualAcl.AreAccessRulesProtected -or @($actualAcl.Access).Count -ne 3) { throw 'Private ACL verification failed' }`
    await execute(windowsPowerShell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { windowsHide: true, timeout: 10000 }).catch(() => { throw new Error('无法限制 DSH 本机认证目录权限') })
  }
  return actual
}

export async function publishDshProcessAuth(dshHome: string, value: { version: string; pid: number; cwd: string; url: string }, current: () => boolean = () => true): Promise<boolean> {
  const key = path.resolve(dshHome)
  const previous = publishers.get(key) || Promise.resolve()
  const pending = previous.catch(() => {}).then(async () => {
  const actual = await prepareDshPrivateDirectory(dshHome)
  if (!current()) return false
  const target = path.join(actual, 'process-auth.json'), staged = `${target}.${value.pid}.next`
  await writeFile(staged, JSON.stringify(value), { encoding: 'utf8', mode: 0o600 })
  if (!current()) { await rm(staged, { force: true }); return false }
  await rename(staged, target)
  return true
  })
  publishers.set(key, pending)
  try { return await pending } finally { if (publishers.get(key) === pending) publishers.delete(key) }
}

/** Runs synchronously before Electron exits; never removes another process's marker. */
export function clearDshProcessAuth(dshHome: string, pid?: number): void {
  if (!pid) return
  const target = path.join(dshHome, 'launcher/process-auth.json')
  try { const value = JSON.parse(readFileSync(target, 'utf8')); if (value.pid === pid) unlinkSync(target) } catch { /* Absent or unowned markers are left alone. */ }
}
