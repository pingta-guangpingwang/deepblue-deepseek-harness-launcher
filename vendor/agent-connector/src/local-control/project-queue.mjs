import path from 'node:path';
export const projectKey = value => process.platform === 'win32' ? path.resolve(value).toLowerCase() : path.resolve(value);
const overlaps = (left, right) => left === right || left.startsWith(right + path.sep) || right.startsWith(left + path.sep);
const conflicts = (left, right) => left.some(a => right.some(b => overlaps(a, b)));

// One queue per local director, shared by all rooms. Permission reviewers are
// read-only and intentionally do not acquire this execution writer lease.
export class ProjectQueue {
  held = new Map();
  quarantined = new Map();
  pending = [];
  quarantine(owner, paths) { this.quarantined.set(owner, [...new Set(paths.map(projectKey))]); this.drain(); }
  resolve(owner) { this.quarantined.delete(owner); this.drain(); }
  acquire(paths, { owner, signal, onWait = () => {} }) {
    const keys = [...new Set(paths.map(projectKey))].sort();
    if (!keys.length) return Promise.reject(new Error('缺少项目写入范围'));
    return new Promise((resolve, reject) => {
      const item = { keys, owner, signal, resolve, reject, onWait, abort: null, waiting: '' };
      item.abort = () => { this.pending = this.pending.filter(row => row !== item); signal?.removeEventListener('abort', item.abort); reject(new Error('项目排队已取消')); this.drain(); };
      if (signal?.aborted) { item.abort(); return; }
      signal?.addEventListener('abort', item.abort, { once: true }); this.pending.push(item); this.drain();
    });
  }
  drain() {
    const blockedEarlier = [];
    for (const item of [...this.pending]) {
      const uncertain = [...this.quarantined.entries()].some(([id, keys]) => id !== item.owner && conflicts(keys, item.keys));
      const occupied = [...this.held.values()].some(keys => conflicts(keys, item.keys)) || blockedEarlier.some(keys => conflicts(keys, item.keys));
      if (uncertain || occupied) {
        const reason = uncertain ? '同项目有原生结果尚未确认的任务，请先只读核对；本轮保持排队' : '同项目正在被另一房间使用，等待写入锁';
        blockedEarlier.push(item.keys);
        if (item.waiting !== reason) { item.waiting = reason; item.onWait(reason); }
        continue;
      }
      this.pending = this.pending.filter(row => row !== item); item.signal?.removeEventListener('abort', item.abort); this.held.set(item.owner, item.keys);
      let released = false;
      item.resolve(() => { if (!released) { released = true; this.held.delete(item.owner); this.drain(); } });
    }
  }
}
