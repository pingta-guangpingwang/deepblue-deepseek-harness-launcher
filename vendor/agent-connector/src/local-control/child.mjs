import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { realpath, stat } from 'node:fs/promises';
import { LocalControlStore } from './store.mjs';
import { LocalRoomEngine } from './engine.mjs';
import { LocalFileVault, LocalFileServer } from './files.mjs';
import { createNativeExecutor } from './native-executor.mjs';
import { RoomWorktrees } from './worktrees.mjs';
import { newId, digest, requireId } from './contracts.mjs';
import { safeRuntimeDiagnostic } from '../runtime-diagnostics.mjs';

export class LocalDirector {
  constructor({ directory, descriptors = [], ownerId = null, notify = () => {}, execute }) { Object.assign(this, { directory, descriptors, ownerId, notify, suppliedExecute: execute }); this.version = 0; }
  async initialize() {
    this.store = await LocalControlStore.open(this.directory);
    this.directory = this.store.directory;
    this.vault = new LocalFileVault({ store: this.store, directory: path.join(this.directory, 'files'), onProgress: progress => { this.fileProgress = progress; this.changed(); } }); await this.vault.initialize();
    this.fileServer = new LocalFileServer(this.vault);
    this.execute = this.suppliedExecute || createNativeExecutor({ outputRoot: path.join(this.directory, 'tasks') });
    this.worktrees = new RoomWorktrees({ store: this.store, directory: path.join(this.directory, 'worktrees') });
    this.engine = new LocalRoomEngine({ store: this.store, resolveMember: member => this.resolve(member), execute: this.execute,
      prepareRoom: room => this.worktrees.prepare(room),
      registerArtifact: async ({ roomId, actionId, member, sourcePath }) => {
        const currentRoot = await realpath(member.projectPath); if (currentRoot.toLowerCase() !== member.projectPath.toLowerCase()) throw new Error('原项目路径发生变化');
        const file = await this.vault.snapshot({ roomId, sourcePath, projectRoot: member.projectPath, fileId: digest({ actionId, sourcePath }).slice(0, 32) });
        this.store.append(roomId, 'file.registered', this.vault.metadata(file.id)); return file;
      },
      resolveAttachments: async (ids, roomId) => Promise.all(ids.map(async id => { const file = await this.vault.file(id); if (file.roomId !== roomId) throw new Error('附件不属于房间'); return { ...this.vault.metadata(id), path: file.localPath, mediaKind: file.previewKind === 'image' ? 'image' : 'file' }; })),
      onChange: () => this.changed() });
    await this.engine.initialize();
  }
  changed() {
    this.version++;
    if (!this.notifyTimer) this.notifyTimer = setTimeout(() => { this.notifyTimer = null; this.notify({ type: 'changed', version: this.version, busy: this.engine.running.size > 0 }); }, 100);
  }
  async resolve(member) {
    const descriptor = this.descriptors.find(item => item.id === member.agentId), project = descriptor?.projects?.find(item => item.id === member.projectId);
    if (!descriptor || !project) throw new Error('本机智能体或授权项目已失效，请刷新本机目录');
    const actual = await realpath(project.path); if (!(await stat(actual)).isDirectory()) throw new Error('本地项目目录不可用');
    const executionPath = member.workspaceId ? await this.worktrees.resolve(member, actual) : actual;
    return { ...descriptor.runtime, adapter: descriptor.adapter, local: true, project: { path: executionPath }, capabilities: descriptor.capabilities };
  }
  accessible(room) { return room && (!room.cloudOwnerId || room.cloudOwnerId === this.ownerId); }
  requireRoom(id) { const room = this.engine.room(id); if (!this.accessible(room)) throw new Error('当前账号不能查看这个同步房间'); return room; }
  catalog() { return this.descriptors.map(({ id, name, adapter, projects, capabilities }) => ({ id, name, adapter, projects, capabilities })); }
  snapshot() {
    const rooms = this.store.list('room', undefined, { limit: 500 }).filter(room => this.accessible(room)).map(room => {
      const runs = this.store.list('run', room.id, { limit: 100 });
      return { id: room.id, name: room.name, permissionMode: room.permissionMode, permissionRevision: room.permissionRevision, memberCount: room.members.length, cloudSync: room.cloudSync, syncState: room.syncState || 'local_only', lastSyncedAt: room.lastSyncedAt, syncError: room.syncError, executionLocation: 'local', status: runs[0]?.status || 'idle', updatedAt: room.updatedAt, pendingApprovals: this.store.list('approval', room.id).filter(item => item.status === 'pending').length };
    });
    return { supported: true, protocol: 1, collaborationSafety: 1, replicaId: this.store.replicaId, version: this.version, busy: this.engine.running.size > 0, rooms, catalog: this.catalog(), fileProgress: this.fileProgress };
  }
  async command(command, input = {}, requestId = newId()) {
    if (command === 'snapshot') return this.snapshot();
    if (command === 'create_room') return this.engine.create(input, requestId);
    const room = this.requireRoom(input.roomId);
    if (command === 'read_room') {
      const kinds = input.view === 'native' ? ['native', 'progress', 'action.started', 'action.completed', 'action.failed', 'approval.requested', 'approval.decided', 'approval.awaiting_user'] : ['message', 'delegation'];
      const detail = this.engine.detail(room.id, input.metadataOnly ? { limit: 1, kinds, maxBytes: 1024 * 1024 } : { before: input.before, after: input.after, limit: input.limit || 50, kinds, maxBytes: 1024 * 1024 });
      if (room.workspaceMode === 'worktree') detail.room.workspaces = [...new Set(room.members.map(member => member.workspaceId))].map(id => this.store.get('workspace', id));
      if (input.metadataOnly) { detail.history.latestSeq = detail.history.items.at(-1)?.seq || 0; detail.history.items = []; }
      detail.runs = detail.runs.map(run => ({ ...run, instruction: run.instruction?.length > 4000 ? run.instruction.slice(0, 4000) + '…（完整任务见对话记录）' : run.instruction, summary: run.summary?.slice(0, 4000) }));
      const fileIds = new Set(detail.files.map(file => file.id));
      for (const event of detail.history.items) for (const id of event.payload.fileIds || []) if (!fileIds.has(id)) { const file = this.store.get('file', id); if (file?.roomId === room.id) { detail.files.push(file); fileIds.add(id); } }
      detail.files = detail.files.map(file => this.vault.metadata(file.id)); return detail;
    }
    if (command === 'read_event') {
      const id = requireId(input.eventId), offset = input.offset || 0;
      if (!Number.isSafeInteger(offset) || offset < 0) throw new Error('内容读取位置无效');
      const row = this.store.db.prepare('SELECT substr(CAST(payload AS BLOB),?,65536) AS chunk,length(CAST(payload AS BLOB)) AS total FROM events WHERE room_id=? AND event_id=?').get(offset + 1, room.id, id);
      if (!row) throw new Error('事件不存在'); return { chunk: Buffer.from(row.chunk).toString('base64'), encoding: 'base64', total: row.total, offset, nextOffset: offset + row.chunk.length };
    }
    if (command === 'send_room') return this.engine.submit(room.id, input, requestId);
    if (command === 'cancel_run') return this.engine.cancel(room.id, input.runId);
    if (command === 'reconcile_run') return this.engine.reconcile(room.id, input.runId);
    if (command === 'accept_run') return this.engine.accept(room.id, input.runId, requestId, input.confirmed === true);
    if (command === 'preflight_merge') {
      // Bounded, cancel-on-timeout queue; never wait forever behind uncertain work.
      const release = await this.engine.projects.acquire(room.members.flatMap(member => [member.projectPath, member.baseProjectPath].filter(Boolean)), { owner: 'preflight-' + requestId, signal: AbortSignal.timeout(1500) });
      try { const result = await this.worktrees.preflight(room); this.changed(); return result; } finally { release(); }
    }
    if (command === 'set_permission') return this.engine.setPermission(room.id, input.mode, requestId, { confirmFull: input.confirmFull === true });
    if (command === 'decide_approval') {
      const approval = this.store.get('approval', requireId(input.approvalId)); if (approval?.roomId !== room.id) throw new Error('审批不属于这个房间');
      return this.engine.permissions.decide(approval.id, input.approved === true, input.reason || '', input.expectedHash);
    }
    if (command === 'attach_files') {
      if (!Array.isArray(input.paths) || input.paths.length > 100) throw new Error('文件选择无效');
      const files = [];
      for (const [index, sourcePath] of input.paths.entries()) {
        const file = await this.vault.snapshot({ roomId: room.id, sourcePath, explicitlyChosen: true, fileId: digest({ requestId, index }).slice(0, 32) }); files.push(this.vault.metadata(file.id));
      }
      this.changed(); return { files };
    }
    if (command === 'preview_file' || command === 'open_file') {
      const file = await this.vault.file(input.fileId); if (file.roomId !== room.id) throw new Error('文件不属于这个房间');
      return { file: this.vault.metadata(file.id), ...(command === 'preview_file' ? { url: await this.fileServer.url(file.id) } : { localPath: file.localPath }) };
    }
    throw new Error('不支持的本地总控操作');
  }
  async close() { clearTimeout(this.notifyTimer); await this.engine?.close(); await this.execute?.close?.(); await this.fileServer?.close(); await this.store?.close(); }
}

export function runDirectorChild() {
  if (!process.send || !path.isAbsolute(process.env.SHENLAN_LOCAL_CONTROL_ROOT || '')) throw new Error('本地总控必须由启动器受控启动');
  let director, initializing, closing = false;
  const send = body => { if (process.connected) process.send(body); };
  process.on('message', message => {
    if (!message || typeof message !== 'object') return;
    if (message.type === 'initialize' && !initializing) {
      if (path.resolve(message.directory || '') !== path.resolve(process.env.SHENLAN_LOCAL_CONTROL_ROOT)) { send({ type: 'fatal', message: '总控数据目录不匹配' }); return; }
      director = new LocalDirector({ directory: message.directory, descriptors: message.descriptors || [], ownerId: message.ownerId || null, notify: send });
      initializing = director.initialize().then(() => send({ type: 'ready', snapshot: director.snapshot() })).catch(error => send({ type: 'fatal', message: safeRuntimeDiagnostic(error.message, 300) })); return;
    }
    if (message.type === 'context' && director) { director.descriptors = message.descriptors || []; director.ownerId = message.ownerId || null; director.changed(); return; }
    if (message.type === 'request' && initializing) {
      void initializing.then(() => director.command(message.command, message.input, message.requestId)).then(result => send({ type: 'result', requestId: message.requestId, result })).catch(error => send({ type: 'result', requestId: message.requestId, error: safeRuntimeDiagnostic(error.message, 500) }));
    }
    if (message.type === 'shutdown' && !closing) { closing = true; void director?.close().finally(() => { send({ type: 'closed' }); if (process.connected) process.disconnect(); }); }
  });
  process.on('disconnect', () => { if (!closing) { closing = true; void director?.close().finally(() => process.exit(0)); } });
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) runDirectorChild();
