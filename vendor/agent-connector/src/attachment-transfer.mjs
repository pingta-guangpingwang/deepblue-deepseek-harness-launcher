import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';

export const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;
export const MAX_ATTACHMENT_FILES = 8;

export class AttachmentTransferError extends Error {
  constructor(message, code = 'attachment_transfer_failed') { super(message);this.name = 'AttachmentTransferError';this.code = code;this.retryable = true; }
}

function safeName(value, index) {
  const cleaned = String(value || '').replace(/[\x00-\x1f\x7f/\\]+/g, '_').trim().slice(0, 150) || `attachment-${index + 1}`;
  return `${String(index + 1).padStart(2, '0')}-${cleaned}`;
}

export function validateAttachmentManifest(value) {
  const items = Array.isArray(value) ? value : [];
  if (items.length > MAX_ATTACHMENT_FILES) throw new AttachmentTransferError('一次最多接收 8 个附件', 'attachment_count_invalid');
  let total = 0;
  return items.map((item) => {
    const id = String(item?.id || '');const byteSize = Number(item?.byteSize || 0);const sha256 = String(item?.sha256 || '').toLowerCase();
    if (!/^[a-f0-9]{32}$/.test(id) || !Number.isInteger(byteSize) || byteSize < 1 || byteSize > MAX_ATTACHMENT_BYTES || !/^[a-f0-9]{64}$/.test(sha256)) throw new AttachmentTransferError('附件元数据无效，已拒绝接收', 'attachment_manifest_invalid');
    total += byteSize;if (total > MAX_ATTACHMENT_BYTES) throw new AttachmentTransferError('单次附件合计超过 20MB', 'attachment_total_too_large');
    return { id, name: String(item.name || '附件').slice(0, 180), mediaKind: ['image', 'video', 'audio', 'file'].includes(item.mediaKind) ? item.mediaKind : 'file', mimeType: String(item.mimeType || 'application/octet-stream').slice(0, 120), byteSize, sha256 };
  });
}

async function responseMessage(response) {
  const text = await response.text().catch(() => '');
  try { const payload = JSON.parse(text);return payload.message || payload.error || `HTTP ${response.status}`; }
  catch { return `HTTP ${response.status}`; }
}

async function downloadOne({ api, taskId, attachment, directory, fetchImpl, signal, index }) {
  const ticket = await api.request('attachment_ticket', { method: 'GET', query: { taskId, attachmentId: attachment.id } });
  const response = await fetchImpl(ticket.relayUrl, { method: 'GET', headers: { authorization: `Bearer ${ticket.downloadToken}`, accept: 'application/octet-stream' }, signal });
  if (!response.ok || !response.body) throw new AttachmentTransferError(`等待浏览器发送“${attachment.name}”失败：${await responseMessage(response)}`, 'attachment_relay_unavailable');
  const contentLength = Number(response.headers.get('content-length'));
  if (contentLength !== attachment.byteSize) throw new AttachmentTransferError(`附件“${attachment.name}”大小不一致`, 'attachment_integrity_mismatch');
  const filePath = path.join(directory, safeName(attachment.name, index));const hash = createHash('sha256');let bytes = 0;
  const verifier = new Transform({ transform(chunk, encoding, callback) { bytes += chunk.length;if (bytes > attachment.byteSize) return callback(new AttachmentTransferError('附件超过声明大小', 'attachment_integrity_mismatch'));hash.update(chunk);callback(null, chunk); } });
  await pipeline(Readable.fromWeb(response.body), verifier, createWriteStream(filePath, { flags: 'wx', mode: 0o600 }));
  const digest = hash.digest('hex');if (bytes !== attachment.byteSize || digest !== attachment.sha256) throw new AttachmentTransferError(`附件“${attachment.name}”完整性校验失败`, 'attachment_integrity_mismatch');
  return { ...attachment, path: filePath };
}

export async function downloadTaskAttachments({ api, taskId, attachments, fetchImpl = globalThis.fetch, control = {}, onProgress = async () => {} }) {
  const manifest = validateAttachmentManifest(attachments);if (!manifest.length) return { root: '', files: [] };
  if (typeof fetchImpl !== 'function') throw new AttachmentTransferError('当前 Node.js 缺少附件流式下载能力', 'attachment_fetch_unavailable');
  const root = await mkdtemp(path.join(os.tmpdir(), 'shenlan-agent-attachments-'));const controller = new AbortController();const previousCancel = control.cancel;
  control.cancel = async () => { controller.abort();if (typeof previousCancel === 'function') await previousCancel(); };
  try {
    const files=[];
    for (let index=0; index<manifest.length; index += 1) {
      if (control.cancelled) throw new AttachmentTransferError('附件接收已取消', 'attachment_transfer_cancelled');
      await onProgress({ summary: `正在等待浏览器直传附件 ${index + 1}/${manifest.length}`, progressPercent: Math.max(2, Math.round(index / manifest.length * 8)) });
      files.push(await downloadOne({ api, taskId, attachment: manifest[index], directory: root, fetchImpl, signal: controller.signal, index }));
    }
    return { root, files };
  } catch (error) {
    await rm(root, { recursive: true, force: true }).catch(() => {});
    if (error?.name === 'AbortError') throw new AttachmentTransferError('附件接收已取消', 'attachment_transfer_cancelled');
    throw error instanceof AttachmentTransferError ? error : new AttachmentTransferError(error.message || '附件中转失败');
  } finally { if (!control.cancelled) control.cancel = previousCancel || null; }
}

export async function cleanupTaskAttachments(bundle) {
  if (bundle?.root) await rm(bundle.root, { recursive: true, force: true }).catch(() => {});
}
