import path from 'node:path'

export function installedLauncherRoot(executablePath: string): string | undefined {
  const versionRoot = path.dirname(path.resolve(executablePath))
  const shellsRoot = path.dirname(versionRoot)
  if (path.basename(shellsRoot).toLowerCase() !== 'shells') return undefined
  return path.dirname(shellsRoot)
}

export function silentLauncherUpdateArgs(installRoot: string): string[] {
  // NSIS requires /D to be the final argument and does not accept quotes around it.
  return ['/S', '/AUTOSTART', `/D=${path.resolve(installRoot)}`]
}
