import { DatabaseSync } from 'node:sqlite';
import { mkdir, realpath, lstat, open, unlink, readFile, chmod } from 'node:fs/promises';
import path from 'node:path';
import { canonical, digest, newId, requireId } from './contracts.mjs';

const schema = `
  PRAGMA foreign_keys=ON;
  PRAGMA busy_timeout=5000;
  PRAGMA journal_mode=WAL;
  PRAGMA synchronous=FULL;
  CREATE TABLE IF NOT EXISTS control_meta (key TEXT PRIMARY KEY,value TEXT NOT NULL);
  INSERT OR IGNORE INTO control_meta VALUES ('schema','1');
  CREATE TABLE IF NOT EXISTS records(kind TEXT NOT NULL,id TEXT NOT NULL,room_id TEXT NOT NULL,payload TEXT NOT NULL,revision INTEGER NOT NULL DEFAULT 1,updated_at TEXT NOT NULL,PRIMARY KEY(kind,id));
  CREATE INDEX IF NOT EXISTS records_by_room ON records(room_id,kind);
  CREATE TABLE IF NOT EXISTS events(room_id TEXT NOT NULL,seq INTEGER NOT NULL,event_id TEXT NOT NULL UNIQUE,kind TEXT NOT NULL,payload TEXT NOT NULL,created_at TEXT NOT NULL,PRIMARY KEY(room_id,seq));
  CREATE INDEX IF NOT EXISTS events_by_kind ON events(room_id,kind,seq);
  CREATE TABLE IF NOT EXISTS requests(id TEXT PRIMARY KEY,request_hash TEXT NOT NULL,result TEXT NOT NULL,created_at TEXT NOT NULL);
`;
export class LocalControlStore {
  constructor(db, directory, lock, identity) { this.db = db; this.directory = directory; this.lock = lock; this.identity = identity; this.inTransaction = false; this.closed = false; }
  static async open(directory, { clock = () => new Date().toISOString() } = {}) {
    if (!path.isAbsolute(directory) || path.resolve(directory) === path.parse(directory).root) throw new Error('本地总控存储目录无效');
    await mkdir(directory, { recursive: true, mode: 0o700 });
    if ((await lstat(directory)).isSymbolicLink()) throw new Error('本地总控存储不能使用目录链接');
    directory = await realpath(directory);
    const database = path.join(directory, 'local-control.sqlite');
    if (await lstat(database).then(info => info.isSymbolicLink() || !info.isFile()).catch(error => { if (error.code === 'ENOENT') return false; throw error; })) throw new Error('本地总控数据库路径无效');
    const lock = path.join(directory, 'writer.lock'), identity = newId();
    let handle;
    try { handle = await open(lock, 'wx', 0o600); }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      if ((await lstat(lock)).isSymbolicLink()) throw new Error('本地总控锁路径无效');
      let existing; try { existing = JSON.parse(await readFile(lock, 'utf8')); } catch { throw new Error('本地总控锁状态未知，不会抢占'); }
      if (!Number.isInteger(existing.pid) || existing.pid < 1) throw new Error('本地总控锁状态未知，不会抢占');
      let alive = true; try { process.kill(existing.pid, 0); } catch (failure) { if (failure.code === 'ESRCH') alive = false; }
      if (alive) throw new Error('已有本地总控进程，不能重复派发');
      // Re-check identity before removing this exact stale lock, never a tree.
      if ((await readFile(lock, 'utf8')) !== JSON.stringify(existing)) throw new Error('本地总控锁已变化');
      await unlink(lock); handle = await open(lock, 'wx', 0o600);
    }
    await handle.writeFile(JSON.stringify({ pid: process.pid, identity })); await handle.sync(); await handle.close();
    try {
      const db = new DatabaseSync(database); db.exec(schema);
      if (db.prepare("SELECT value FROM control_meta WHERE key='schema'").get()?.value !== '1') throw new Error('本地总控数据库版本不兼容');
      await chmod(database, 0o600).catch(() => {});
      db.prepare("INSERT OR IGNORE INTO control_meta(key,value) VALUES ('replica',?)").run(newId());
      const store = new LocalControlStore(db, directory, lock, identity); store.clock = clock; store.replicaId = db.prepare("SELECT value FROM control_meta WHERE key='replica'").get().value; return store;
    } catch (error) { await unlink(lock).catch(() => {}); throw error; }
  }
  transaction(operation) {
    if (this.inTransaction) return operation();
    this.db.exec('BEGIN IMMEDIATE'); this.inTransaction = true;
    try { const result = operation(); if (result?.then) throw new Error('存储事务不得等待外部操作'); this.db.exec('COMMIT'); return result; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
    finally { this.inTransaction = false; }
  }
  get(kind, id) { const row = this.db.prepare('SELECT payload FROM records WHERE kind=? AND id=?').get(kind, id); return row ? JSON.parse(row.payload) : null; }
  put(kind, record, roomId = record.roomId || record.id, expectedRevision) {
    requireId(record.id); requireId(roomId, '房间编号');
    return this.transaction(() => {
      const previous = this.db.prepare('SELECT revision FROM records WHERE kind=? AND id=?').get(kind, record.id);
      if (expectedRevision !== undefined && (previous?.revision ?? 0) !== expectedRevision) throw new Error('记录已变化，请刷新后重试');
      const revision = (previous?.revision ?? 0) + 1;
      this.db.prepare('INSERT INTO records(kind,id,room_id,payload,revision,updated_at) VALUES (?,?,?,?,?,?) ON CONFLICT(kind,id) DO UPDATE SET room_id=excluded.room_id,payload=excluded.payload,revision=excluded.revision,updated_at=excluded.updated_at').run(kind, record.id, roomId, canonical({ ...record, revision }), revision, this.clock());
      return { ...record, revision };
    });
  }
  list(kind, roomId, { offset = 0, limit = 100 } = {}) {
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 500) throw new Error('本地列表分页无效');
    const query = roomId ? this.db.prepare('SELECT payload FROM records WHERE kind=? AND room_id=? ORDER BY updated_at DESC,id LIMIT ? OFFSET ?') : this.db.prepare('SELECT payload FROM records WHERE kind=? ORDER BY updated_at DESC,id LIMIT ? OFFSET ?');
    return query.all(...(roomId ? [kind, roomId, limit, offset] : [kind, limit, offset])).map(row => JSON.parse(row.payload));
  }
  append(roomId, kind, payload, eventId = newId()) {
    requireId(roomId); requireId(eventId, '事件编号');
    return this.transaction(() => {
      const previous = this.db.prepare('SELECT * FROM events WHERE event_id=?').get(eventId);
      const body = canonical(payload);
      if (previous) { if (previous.room_id !== roomId || previous.kind !== kind || previous.payload !== body) throw new Error('同一事件编号不能写入不同内容'); return this.event(previous); }
      const seq = Number(this.db.prepare('SELECT COALESCE(MAX(seq),0)+1 AS seq FROM events WHERE room_id=?').get(roomId).seq);
      const createdAt = this.clock();
      this.db.prepare('INSERT INTO events(room_id,seq,event_id,kind,payload,created_at) VALUES (?,?,?,?,?,?)').run(roomId, seq, eventId, kind, body, createdAt);
      return { roomId, seq, id: eventId, kind, payload: JSON.parse(body), createdAt };
    });
  }
  event(row) { return { roomId: row.room_id, seq: row.seq, id: row.event_id, kind: row.kind, payload: JSON.parse(row.payload), createdAt: row.created_at }; }
  events(roomId, { before, after, limit = 50, kinds, maxBytes } = {}) {
    requireId(roomId);
    if (before !== undefined && after !== undefined || !Number.isInteger(limit) || limit < 1 || limit > 200 || [before, after].some(value => value !== undefined && (!Number.isSafeInteger(value) || value < 0))) throw new Error('本地历史分页无效');
    if (kinds && (!Array.isArray(kinds) || !kinds.length || kinds.length > 20 || kinds.some(kind => typeof kind !== 'string' || !/^[a-z._]+$/.test(kind)))) throw new Error('历史类型筛选无效');
    const filter = kinds ? ' AND kind IN (' + kinds.map(() => '?').join(',') + ')' : '', parameters = kinds || [];
    let rows;
    if (maxBytes !== undefined) {
      if (!Number.isSafeInteger(maxBytes) || maxBytes < 65536 || maxBytes > 4 * 1024 * 1024) throw new Error('分页传输预算无效');
      const candidates = this.db.prepare('SELECT room_id,seq,event_id,kind,created_at,length(CAST(payload AS BLOB)) AS payload_bytes FROM events WHERE room_id=? AND seq' + (after !== undefined ? '>' : '<') + '?' + filter + ' ORDER BY seq ' + (after !== undefined ? 'ASC' : 'DESC') + ' LIMIT ?').all(roomId, after ?? before ?? Number.MAX_SAFE_INTEGER, ...parameters, limit);
      rows = []; let bytes = 0;
      for (const row of candidates) {
        if (rows.length && bytes + row.payload_bytes > maxBytes) break;
        if (row.payload_bytes > maxBytes) { rows.push({ ...row, payload: JSON.stringify({ body: '这条原生记录较长，可按需读取完整内容。', deferred: true, payloadBytes: row.payload_bytes }) }); break; }
        rows.push(this.db.prepare('SELECT * FROM events WHERE room_id=? AND seq=?').get(roomId, row.seq)); bytes += row.payload_bytes;
      }
      if (after === undefined) rows.reverse();
    } else if (after !== undefined) rows = this.db.prepare('SELECT * FROM events WHERE room_id=? AND seq>?' + filter + ' ORDER BY seq ASC LIMIT ?').all(roomId, after, ...parameters, limit);
    else rows = this.db.prepare('SELECT * FROM events WHERE room_id=? AND seq<?' + filter + ' ORDER BY seq DESC LIMIT ?').all(roomId, before ?? Number.MAX_SAFE_INTEGER, ...parameters, limit).reverse();
    const total = Number(this.db.prepare('SELECT COUNT(*) AS count FROM events WHERE room_id=?' + filter).get(roomId, ...parameters).count);
    const hasEarlier = rows.length > 0 && !!this.db.prepare('SELECT 1 FROM events WHERE room_id=? AND seq<?' + filter + ' LIMIT 1').get(roomId, rows[0].seq, ...parameters);
    const hasLater = rows.length > 0 && !!this.db.prepare('SELECT 1 FROM events WHERE room_id=? AND seq>?' + filter + ' LIMIT 1').get(roomId, rows.at(-1).seq, ...parameters);
    return { items: rows.map(row => this.event(row)), total, hasEarlier, hasLater };
  }
  request(id, payload, operation) {
    requireId(id, '请求编号'); const hash = digest(payload);
    return this.transaction(() => {
      const row = this.db.prepare('SELECT request_hash,result FROM requests WHERE id=?').get(id);
      if (row) { if (row.request_hash !== hash) throw new Error('请求编号已被用于不同操作'); return { result: JSON.parse(row.result), replayed: true }; }
      const result = operation(); if (result?.then) throw new Error('幂等事务不得执行异步任务');
      this.db.prepare('INSERT INTO requests VALUES (?,?,?,?)').run(id, hash, canonical(result), this.clock());
      return { result, replayed: false };
    });
  }
  async close() {
    if (this.closed) return; this.closed = true; this.db.close();
    const current = await readFile(this.lock, 'utf8').then(JSON.parse).catch(() => null);
    if (current?.identity === this.identity) await unlink(this.lock);
  }
}
