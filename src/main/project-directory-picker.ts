/** A native picker result belongs to one caller; never share a grant with a
 * second window or open nested Windows shell dialogs for the same operation. */
export class ProjectDirectoryPicker {
  private pending = false
  async choose(show: () => Promise<string | undefined>): Promise<string | undefined> {
    if (this.pending) throw new Error('已有项目目录选择窗口，请先选择或取消，不会重复打开')
    this.pending = true
    try { return await show() } finally { this.pending = false }
  }
}
