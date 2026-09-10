import path from 'node:path';
import { lstat } from 'node:fs/promises';

// Managed legacy connectors may still scan the same native runtime. Their
// cloud snapshots must never include local-director or permission-review turns.
export async function localOnlySessionIds(adapter, directory = process.env.SHENLAN_LOCAL_CONTROL_ROOT) {
  if (!directory) return new Set();
  if (!path.isAbsolute(directory)) throw new Error('本地会话隐私目录无效');
  const filename = path.join(directory, 'local-control.sqlite');
  let info; try { info = await lstat(filename); } catch (error) { if (error.code === 'ENOENT') return new Set(); throw error; }
  if (!info.isFile() || info.isSymbolicLink()) throw new Error('本地会话隐私索引不可用，已停止旧同步');
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(filename, { readOnly: true });
  try {
    db.exec('PRAGMA busy_timeout=1000');
    const ids = db.prepare("SELECT json_extract(payload,'$.runtimeSessionId') AS id FROM records WHERE kind='private_session' AND json_extract(payload,'$.adapter')=?").all(adapter).map(row => row.id);
    for (const row of db.prepare("SELECT json_extract(m.value,'$.runtimeSessionId') AS id FROM records r,json_each(r.payload,'$.members') m WHERE r.kind='room' AND json_extract(m.value,'$.adapter')=?").all(adapter)) if (row.id) ids.push(row.id);
    return new Set(ids.filter(Boolean));
  } finally { db.close(); }
}
