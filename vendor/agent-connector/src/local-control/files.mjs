import path from 'node:path';
import { constants, createReadStream } from 'node:fs';
import { mkdir, realpath, stat, lstat, open, rename, unlink, chmod } from 'node:fs/promises';
import { createHash, randomBytes } from 'node:crypto';
import http from 'node:http';
import { pipeline } from 'node:stream/promises';
import { newId, requireId } from './contracts.mjs';
import { canonicalInside, protectedPath } from './permissions.mjs';

export function detectFileType(bytes) {
  if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return { mime: 'image/png', previewKind: 'image' };
  if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return { mime: 'image/jpeg', previewKind: 'image' };
  if (/^GIF8[79]a/.test(bytes.subarray(0, 6).toString('ascii'))) return { mime: 'image/gif', previewKind: 'image' };
  if (bytes.subarray(0, 4).toString('ascii') === 'RIFF' && bytes.subarray(8, 12).toString('ascii') === 'WEBP') return { mime: 'image/webp', previewKind: 'image' };
  if (bytes.subarray(0, 5).toString('ascii') === '%PDF-') return { mime: 'application/pdf', previewKind: 'pdf' };
  const beginning = bytes.toString('utf8').trimStart();
  if (/^(?:<!doctype\s+html|<html|<svg|<\?xml)/i.test(beginning)) return { mime: 'application/octet-stream', previewKind: 'download' };
  if (!bytes.includes(0) && !beginning.includes('\uFFFD')) return { mime: 'text/plain; charset=utf-8', previewKind: 'text' };
  return { mime: 'application/octet-stream', previewKind: 'download' };
}
export class LocalFileVault {
  constructor({ directory, store, onProgress = () => {} }) { Object.assign(this, { directory, store, onProgress }); }
  async initialize() { await mkdir(this.directory, { recursive: true, mode: 0o700 }); if ((await lstat(this.directory)).isSymbolicLink()) throw new Error('文件版本库不能使用目录链接'); this.directory = await realpath(this.directory); }
  async snapshot({ roomId, sourcePath, projectRoot, explicitlyChosen = false, fileId }) {
    requireId(roomId);
    if (!path.isAbsolute(sourcePath || '')) throw new Error('本地文件路径无效');
    const source = await realpath(sourcePath);
    if (fileId) { requireId(fileId); const previous = this.store.get('file', fileId); if (previous) { if (previous.roomId !== roomId || previous.sourcePath !== source) throw new Error('文件准备请求已被用于其他文件'); return this.file(fileId); } }
    if (!explicitlyChosen && (protectedPath(source) || !(await canonicalInside(source, projectRoot)))) throw new Error('文件不在智能体已授权的项目内');
    const before = await stat(source); if (!before.isFile()) throw new Error('只能附加普通文件，不能附加目录或设备');
    const id = fileId || newId(), temporary = path.join(this.directory, id + '.partial'), destination = path.join(this.directory, id + '.blob');
    const reader = await open(source, constants.O_RDONLY | (constants.O_NOFOLLOW || 0)); let writer;
    try {
      const opened = await reader.stat();
      if (before.ino !== opened.ino || before.dev !== opened.dev || before.size !== opened.size || before.mtimeMs !== opened.mtimeMs || await realpath(sourcePath) !== source) throw new Error('文件在读取前发生变化，请重新选择');
      writer = await open(temporary, 'wx', 0o600);
      const hash = createHash('sha256'), buffer = Buffer.alloc(256 * 1024); let position = 0, signature = Buffer.alloc(0);
      for (;;) {
        const { bytesRead } = await reader.read(buffer, 0, buffer.length, position); if (!bytesRead) break;
        const chunk = buffer.subarray(0, bytesRead); hash.update(chunk); if (!signature.length) signature = Buffer.from(chunk.subarray(0, 4096));
        let written = 0; while (written < bytesRead) { const result = await writer.write(chunk, written, bytesRead - written, position + written); if (!result.bytesWritten) throw new Error('本地磁盘未能写入文件版本'); written += result.bytesWritten; }
        position += bytesRead; this.onProgress({ fileId: id, phase: 'preparing', bytes: position, total: before.size });
      }
      const after = await reader.stat();
      if (after.size !== before.size || after.mtimeMs !== before.mtimeMs || position !== before.size) throw new Error('文件正在被修改，未固定版本，请稍后重试');
      await writer.sync(); await writer.close(); writer = null; await rename(temporary, destination); await chmod(destination, 0o400).catch(() => {});
      const file = { id, roomId, name: path.basename(source), byteSize: position, sha256: hash.digest('hex'), ...detectFileType(signature), sourcePath: source,
        localPath: destination, sourceModifiedAt: new Date(before.mtimeMs).toISOString(), createdAt: new Date().toISOString(), cloudStatus: 'local_only', source: explicitlyChosen ? 'user' : 'agent' };
      this.store.put('file', file); this.onProgress({ fileId: id, phase: 'local_ready', bytes: position, total: position }); return file;
    } catch (error) { await unlink(temporary).catch(() => {}); await unlink(destination).catch(() => {}); throw error; }
    finally { await writer?.close().catch(() => {}); await reader.close(); }
  }
  metadata(id) { const file = this.store.get('file', requireId(id)); if (!file) throw new Error('文件记录不存在'); return { id: file.id, roomId: file.roomId, name: file.name, byteSize: file.byteSize, sha256: file.sha256, mime: file.mime, previewKind: file.previewKind, cloudStatus: file.cloudStatus, createdAt: file.createdAt }; }
  async file(id) {
    const file = this.store.get('file', requireId(id)); if (!file || file.localPath !== path.join(this.directory, id + '.blob')) throw new Error('文件版本不存在');
    const info = await lstat(file.localPath).catch(() => null);
    if (!info?.isFile() || info.isSymbolicLink() || info.size !== file.byteSize) throw new Error('本地原版本不可用，请重新附加文件');
    return file;
  }
  async verify(id) { const file = await this.file(id), hash = createHash('sha256'); for await (const chunk of createReadStream(file.localPath)) hash.update(chunk); return hash.digest('hex') === file.sha256; }
  markCloudRemoved(id) { const file = this.store.get('file', requireId(id)); if (!file) return; file.cloudStatus = 'removed'; delete file.cloudObject; this.store.put('file', file); /* Local versions and source files intentionally remain. */ }
}
export function parseByteRange(header, size) {
  if (!header) return { start: 0, end: size - 1, partial: false };
  const match = /^bytes=(\d*)-(\d*)$/.exec(header); if (!match || !match[1] && !match[2] || size < 1) throw new Error('invalid range');
  const start = match[1] ? Number(match[1]) : Math.max(0, size - Number(match[2]));
  const end = match[1] ? (match[2] ? Math.min(size - 1, Number(match[2])) : size - 1) : size - 1;
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || start >= size || end < start) throw new Error('invalid range');
  return { start, end, partial: true };
}
export class LocalFileServer {
  constructor(vault) { this.vault = vault; this.capabilities = new Map(); }
  async start() {
    if (this.server) return;
    this.server = http.createServer((request, response) => { this.handle(request, response).catch(() => { if (!response.headersSent) response.writeHead(404); response.end(); }); });
    await new Promise((resolve, reject) => { this.server.once('error', reject); this.server.listen(0, '127.0.0.1', resolve); });
    this.origin = 'http://127.0.0.1:' + this.server.address().port;
  }
  async url(id, { download = false, ttlMs = 5 * 60 * 1000 } = {}) {
    await this.start(); const file = await this.vault.file(id); const token = randomBytes(32).toString('base64url');
    for (const [key, value] of this.capabilities) if (value.expiresAt <= Date.now()) this.capabilities.delete(key);
    if (this.capabilities.size > 256) this.capabilities.delete(this.capabilities.keys().next().value);
    this.capabilities.set(token, { id, download: download || file.previewKind === 'download', expiresAt: Date.now() + Math.min(30 * 60 * 1000, Math.max(1000, ttlMs)) });
    return this.origin + '/file/' + token;
  }
  async handle(request, response) {
    if (!['GET', 'HEAD'].includes(request.method) || request.headers.host !== new URL(this.origin).host || !['127.0.0.1', '::ffff:127.0.0.1'].includes(request.socket.remoteAddress)) { response.writeHead(403); response.end(); return; }
    const match = /^\/file\/([A-Za-z0-9_-]{43})$/.exec(request.url || ''), grant = match && this.capabilities.get(match[1]);
    if (!grant || grant.expiresAt <= Date.now()) { response.writeHead(404); response.end(); return; }
    const file = await this.vault.file(grant.id); let range;
    try { range = parseByteRange(request.headers.range, file.byteSize); } catch { response.writeHead(416, { 'Content-Range': 'bytes */' + file.byteSize }); response.end(); return; }
    if (request.headers['if-range'] && request.headers['if-range'] !== '"' + file.sha256 + '"') range = parseByteRange(undefined, file.byteSize);
    const headers = { 'Content-Type': file.mime, 'Content-Length': Math.max(0, range.end - range.start + 1), 'Accept-Ranges': 'bytes', ETag: '"' + file.sha256 + '"',
      'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'Content-Security-Policy': "sandbox; default-src 'none'",
      'Content-Disposition': (grant.download ? 'attachment' : 'inline') + "; filename*=UTF-8''" + encodeURIComponent(file.name),
      'Access-Control-Allow-Origin': 'null', 'Access-Control-Expose-Headers': 'Content-Length,Content-Range,ETag' };
    if (range.partial) headers['Content-Range'] = `bytes ${range.start}-${range.end}/${file.byteSize}`;
    response.writeHead(range.partial ? 206 : 200, headers);
    if (request.method === 'HEAD' || file.byteSize === 0) { response.end(); return; }
    await pipeline(createReadStream(file.localPath, { start: range.start, end: range.end }), response);
  }
  async close() { this.capabilities.clear(); if (this.server) { this.server.closeAllConnections?.(); await new Promise(resolve => this.server.close(resolve)); this.server = null; } }
}
