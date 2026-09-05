// Pure merge shared by full runtime builds and module-only releases.
export function mergeRuntimeModules(existing, replacements, requiredIds = []) {
  if (!Array.isArray(existing) || !Array.isArray(replacements)) throw new Error('Expected runtime module arrays');
  const validate = (entries) => {
    const seen = new Set();
    for (const entry of entries) {
      if (!entry || typeof entry.id !== 'string' || !entry.id || typeof entry.version !== 'string' || !Array.isArray(entry.artifacts) || !entry.artifacts.length || seen.has(entry.id)) {
        throw new Error('Malformed or duplicate runtime module');
      }
      seen.add(entry.id);
    }
  };
  validate(existing); validate(replacements);
  const changed = new Set(replacements.map(entry => entry.id));
  const result = [...existing.filter(entry => !changed.has(entry.id)), ...replacements];
  for (const id of requiredIds) if (!result.some(entry => entry.id === id)) throw new Error(`Incomplete runtime catalog: missing ${id}`);
  return result;
}
