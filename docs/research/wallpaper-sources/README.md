# 壁纸来源调研原始数据

`scripts/external-skin-sources.json` 里每条来源的取舍都出自这批数据。归档在仓库里是为了让后续增删来源时不必重新扫一遍 GitHub，也便于复核当初的判断。

数据采集于 2026-08-21，来自一台中国大陆网络的机器。仓库的 stars、许可证、体积和最后推送时间都是当时的 GitHub API 快照，会随时间失效；**判断某个来源现在是否还合适，需要重新跑对应脚本**。

## 数据文件

| 文件 | 内容 | 用途 |
| --- | --- | --- |
| `curate-result.json` | 52 个候选仓库的许可证分级与来源瑕疵标记 | 最有参考价值的一份。决定哪些仓库能进 `external-skin-sources.json` |
| `mirror-result.json` | 6 个下载渠道 × 4 个真实素材 × 2 次的实测明细 | `src/main/asset-mirrors.ts` 的渠道顺序和 `downloadTimeoutMs` 的吞吐假设都基于它 |
| `merged.json` | 26 个静态图片壁纸仓库的元数据与抽样 | 图片来源的原始池 |
| `gallery.json` | 上述 26 个仓库各 4 张缩略图，经逐张 HTTP 校验 | 可视化画廊的数据源 |
| `video-result.json` | 573 个候选中筛出的 65 个含视频仓库，含分辨率、时长、有无音轨 | 结论是没有可外链的视频壁纸库 |
| `gif-result.json` | 176 个候选中筛出的 76 个含动画媒体仓库 | 结论是 18 个有横屏可用动图，多数为工具演示录屏 |

## 扫描脚本

放在 `scans/`。这些是一次性调研脚本，不是产品代码，没有接入 `npm test`，也不保证在 API 变化后仍能运行。都需要 `gh auth token` 提供的 GitHub 凭据。

| 脚本 | 作用 |
| --- | --- |
| `scan.mjs` / `scan2.mjs` | 扫描静态图片壁纸仓库，产出 `merged.json`。只收 `png/jpe?g/webp`，要求单文件 >40 KB、宽高比 ≥1.4 |
| `gen.mjs` | 为图片仓库生成并逐张校验缩略图，产出 `gallery.json` |
| `scanvid.mjs` | 搜索并扫描视频壁纸仓库，解析 mp4 的 `moov` 得到分辨率、时长和音轨，产出 `video-result.json` |
| `scangif.mjs` | 扫描动画 GIF 与动态 WebP。GIF 走块遍历数帧并识别 NETSCAPE2.0 循环标记，WebP 读 VP8X 的 ANIM 标志，产出 `gif-result.json` |
| `curate.mjs` | 合并图片与视频结果，按许可证和来源瑕疵分级，产出 `curate-result.json` |
| `mirrorprobe.mjs` | 实测各下载渠道的成功率、首字节延迟与吞吐，产出 `mirror-result.json` |

## 三条结论

**清白的素材远少于总量。** 26 个图片仓库合计 14,273 张，但真正无权利争议的只有 `rose-pine/wallpapers` 的 85 张 CC0。17 个仓库完全没有 LICENSE 文件；多个 MIT 图片合集的 README 自述是 gathered 或 personal pick，即收集转载，作者未必有权用 MIT 授出。

**MIT 出现在工具仓库上时不覆盖随包素材。** 这是筛选中最常见的陷阱。`zeroruka/video-wallpaper-scripts`、`elapse-d/foo-Wallpaper-Feh-Gif`、`legeeknumero1/wpe-setup` 都属于此类：许可证针对脚本或配置，视频是来源不明的演示资源。

**视频和 GIF 都没有可外链的素材库。** 573 个视频候选里 65 个带视频文件，全是播放器与引擎的演示资源；176 个 GIF 候选里命中的多为库和工具的 README 动图。动态 WebP 在 GitHub 上几乎不存在。因此动态皮肤只能靠 `scripts/seedance-store-pipeline.py` 自产加社区共创。
