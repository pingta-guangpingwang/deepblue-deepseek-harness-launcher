import { builtinModules } from 'node:module'

const builtins = new Set(builtinModules.flatMap((name) => [name, `node:${name}`]))

export function runtimePackageName(specifier) {
  if (!specifier || specifier.startsWith('.') || specifier.startsWith('/') || builtins.has(specifier) || specifier === 'electron') return undefined
  const parts = specifier.split('/')
  return specifier.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0]
}

export function discoverMainRuntimePackages(source) {
  const specifiers = new Set()
  const patterns = [
    /(?:import|export)\s+(?:[^'"\n]*?\s+from\s+)?['"]([^'"]+)['"]/g,
    /import\(\s*['"]([^'"]+)['"]\s*\)/g
  ]
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) specifiers.add(match[1])
  }
  return [...new Set([...specifiers].map(runtimePackageName).filter(Boolean))].sort()
}
