import { cp, mkdir } from 'node:fs/promises';
import path from 'node:path';
const root=path.resolve(import.meta.dirname,'..');
const source=path.join(root,'out/online-workspace');
const target=path.resolve(root,'../remove-codex-quota-release/apps/agents/local-control');
await mkdir(target,{recursive:true});
await cp(source,target,{recursive:true});
console.log('Online workspace bundle copied to '+target);
