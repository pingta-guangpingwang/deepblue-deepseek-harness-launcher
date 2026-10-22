const NATIVE_GAME_WINDOW_VERSION = [0, 10, 40] as const

export function supportsNativeGameWindow(version: string): boolean {
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(version.trim())
  if (!match) return false
  const current = match.slice(1).map(Number)
  for (const [index, minimum] of NATIVE_GAME_WINDOW_VERSION.entries()) {
    if (current[index]! > minimum) return true
    if (current[index]! < minimum) return false
  }
  return true
}
