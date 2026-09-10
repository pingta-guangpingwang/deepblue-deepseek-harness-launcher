import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, realpath, lstat } from 'node:fs/promises';
import { digest, requireId } from './contracts.mjs';
import { projectKey } from './project-queue.mjs';
const exec = promisify(execFile);

export class RoomWorktrees {
  constructor({ store, directory }) { Object.assign(this, { store, directory }); this.pending = new Map(); }
  async git(cwd, args, allowed = [0]) {
    const hooks = path.join(this.directory, 'empty-hooks'); await mkdir(hooks, { recursive: true });
    try { const result = await exec('git', ['-c', `core.hooksPath=${hooks}`, '-c', 'core.quotePath=false', ...args], { cwd, windowsHide: true, timeout: 30000, maxBuffer: 2 * 1024 * 1024, env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' } }); return { code: 0, stdout: result.stdout.trimEnd() }; }
    catch (error) { if (allowed.includes(error.code)) return { code: error.code, stdout: String(error.stdout || '').trimEnd() }; throw new Error(`Git 工作树操作未完成（${args[0]}）。请检查 Git、项目状态和目录权限；没有修改原分支。`); }
  }
  async prepare(room) {
    if (room.workspaceMode !== 'worktree') return room;
    for (const member of room.members) {
      const source = await realpath(member.projectPath), id = digest({ roomId: room.id, source: projectKey(source) }).slice(0, 32);
      let record = this.store.get('workspace', id);
      if (!record) {
        const top = await this.git(source, ['rev-parse', '--show-toplevel']);
        if (projectKey(await realpath(top.stdout)) !== projectKey(source)) throw new Error('Git 隔离需要授权仓库根目录；不能自动扩大子目录授权');
        if ((await this.git(source, ['status', '--porcelain', '--untracked-files=all'])).stdout) throw new Error('原项目有未提交修改，请先处理后重试，或明确选择共享目录模式；不会自动暂存');
        const head = (await this.git(source, ['rev-parse', 'HEAD'])).stdout;
        record = { id, roomId: room.id, sourcePath: source, path: path.join(this.directory, room.id, id), branch: `shenlan/room/${room.id}/${id.slice(0, 10)}`, baseHead: head, status: 'creating' };
        this.store.put('workspace', record);
      }
      if (record.roomId !== room.id || projectKey(record.sourcePath) !== projectKey(source)) throw new Error('工作树归属不一致');
      const exists = await lstat(record.path).then(() => true).catch(error => { if (error.code === 'ENOENT') return false; throw error; });
      if (!exists) {
        if (record.status !== 'creating') throw new Error('已登记的工作树缺失，不能自动重建或丢失原改动');
        await mkdir(path.dirname(record.path), { recursive: true });
        await this.git(source, ['worktree', 'add', '-b', record.branch, record.path, record.baseHead]);
      }
      await this.validate(record, source);
      record.status = 'ready'; this.store.put('workspace', record);
      member.baseProjectPath = source; member.projectPath = record.path; member.workspaceId = id; member.roomId = room.id;
    }
    room.workspaces = [...new Set(room.members.map(member => member.workspaceId))].map(id => this.store.get('workspace', id));
    return room;
  }
  async validate(record, source) {
    requireId(record.roomId); requireId(record.id);
    const expected = path.join(this.directory, record.roomId, record.id);
    if (projectKey(record.path) !== projectKey(expected) || projectKey(await realpath(record.path)) !== projectKey(expected) || projectKey(record.sourcePath) !== projectKey(await realpath(source))) throw new Error('工作树目录或授权源发生变化');
    const entries = (await this.git(source, ['worktree', 'list', '--porcelain'])).stdout.split(/\r?\n\r?\n/);
    const owned = entries.some(entry => { const lines = entry.split(/\r?\n/); return lines.some(line => line.startsWith('worktree ') && projectKey(line.slice(9)) === projectKey(expected)) && lines.includes('branch refs/heads/' + record.branch); });
    if (!owned) throw new Error('工作树未登记在原项目，或分支已被切换；需要人工核对');
  }
  async resolve(member, source) {
    const record = this.store.get('workspace', requireId(member.workspaceId));
    if (!record || record.roomId !== member.roomId || record.status !== 'ready' || projectKey(record.sourcePath) !== projectKey(member.baseProjectPath)) throw new Error('工作树与房间成员不匹配');
    await this.validate(record, source); return record.path;
  }
  async preflight(room) {
    if (room.workspaceMode !== 'worktree') throw new Error('共享目录模式没有独立分支可供检查');
    const results = [];
    for (const id of new Set(room.members.map(member => member.workspaceId))) {
      const record = this.store.get('workspace', requireId(id)); await this.validate(record, record.sourcePath);
      const dirty = (await this.git(record.path, ['status', '--porcelain', '--untracked-files=all'])).stdout;
      const baseDirty = (await this.git(record.sourcePath, ['status', '--porcelain', '--untracked-files=all'])).stdout;
      let result;
      if (dirty || baseDirty) result = { workspaceId: id, status: 'needs_checkpoint', message: '工作树或原项目有未提交修改；请在原生工具审查并提交后重新检查，不会自动暂存或提交。' };
      else {
        const targetHead = (await this.git(record.sourcePath, ['rev-parse', 'HEAD'])).stdout, sourceHead = (await this.git(record.path, ['rev-parse', 'HEAD'])).stdout;
        const merge = await this.git(record.sourcePath, ['merge-tree', '--write-tree', '--name-only', '--no-messages', '-z', targetHead, sourceHead], [0, 1]);
        const parts = merge.stdout.split('\0');
        result = { workspaceId: id, status: merge.code === 0 ? 'clean' : 'conflict', targetHead, sourceHead, conflictPaths: parts.slice(1).filter(Boolean), checkedAt: new Date().toISOString(), message: merge.code === 0 ? '已提交版本未发现文本合并冲突；尚未合并，也不代表功能验证通过。' : '存在合并冲突；需要人工解决，没有修改原分支或工作区。' };
      }
      record.preflight = result; this.store.put('workspace', record); results.push(result);
    }
    return { merged: false, results };
  }
}
