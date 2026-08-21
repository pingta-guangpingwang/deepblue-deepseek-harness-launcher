# 交接说明：外部皮肤来源、镜像回退与动图冻帧

本文件是给**另一个在同一工作目录协作的智能体（Codex）**看的交接记录。这一轮改动由 Cursor 侧完成，已提交但**未推送**；推送、打包和上线由持有账号凭据的一方执行。

- 分支：`cursor/external-skin-sources-and-mirror-fallback`
- 基线：`main`（`03de57f`）
- 提交：`git log --oneline main..HEAD` 查看本轮全部提交
- 远端：`origin` → `https://github.com/pingta-guangpingwang/deepblue-deepseek-harness-launcher.git`
- 状态：本地已提交，**没有 upstream，没有推送**

## 一、先读这段：工作目录里有不属于本轮的改动

同一个工作目录同时被两侧使用，交接时工作区里留有**未提交且不属于本轮**的内容，推送和打包前不要把它们一起带走：

```
 M src/renderer/src/App.tsx                    (11 行，online-page-refresh 相关)
?? src/renderer/src/online-page-refresh.ts
?? src/renderer/src/online-page-refresh.test.ts
```

这三处是另一侧正在做的「切换页面时自动刷新在线目录」功能。本轮两个提交里已经刻意排除了它们：`App.tsx` 提交的是不含 `onlinePageRefreshTarget` 引用的版本，所以本分支单独 checkout 也能通过 typecheck。

`src/renderer/src/online-page-refresh.test.ts` 会被 `npm test` 收集并通过，这不影响本轮验证结论，但它属于另一侧的功能。

## 二、这一轮做了什么

### 1. 下载渠道回退（`src/main/asset-mirrors.ts`）

起因是实测：从国内网络直连 `raw.githubusercontent.com`，8 次里 3 次 20 秒超时，成功率 50%。

| 渠道 | 成功率 | 中位首字节 | 中位吞吐 |
| --- | ---: | ---: | ---: |
| gh-proxy.com | 100% | 414 ms | 422 KB/s |
| cdn.statically.io | 100% | 966 ms | 357 KB/s |
| ghfast.top | 100% | 714 ms | 244 KB/s |
| cdn.jsdelivr.net | 100% | 818 ms | 191 KB/s |
| raw.githubusercontent.com | 50% | 579 ms | 120 KB/s |
| raw.gitmirror.com | 0% | — | — |

实测条件：2026-08-21，单机单网络，4 个真实素材 × 每渠道 2 次 × 512 KB 分片。样本量小，只用于排序，不是 SLA。

落地顺序为 statically → jsdelivr → gh-proxy → ghfast → 原始 host：正规 CDN 在前，志愿代理在后，权威 host 因为失败率高而不放第一位。超过 20 MB 的素材自动跳过两个 CDN（它们有体积上限）。皮肤与宠物下载都接入了。

**注意：只对 GitHub 托管的素材生效。** jsDelivr 与 Statically 只代理 GitHub，Gitee raw 没有对应镜像，所以 `mirrorCandidates` 对 `gitee.com` 返回单渠道，现有官方商店仍是 Gitee 直连（实测热请求 251 ms，是全渠道最快；但首次冷请求出现过 6.2 秒）。

同时补了一处加固：原先只靠 `Content-Length` 判断超限，而代理常用分块传输不带这个头，现在改为流式计数，超过声明大小立即中断。

下载超时也一并修了，这原本是个会导致失败的缺陷。原先是固定 90 秒，而 `AbortSignal.timeout` 会不论进度地中断整个请求：按 jsDelivr 实测的 191 KB/s，16.5 MB 的 `rose-pine/generative/circle.png` 需要约 86 秒，已经贴着上限；25 MiB 图片和任何视频必然超时。现在 `downloadTimeoutMs` 按签名清单里钉死的体积计算预算（60 秒起，按 80 KB/s 的保守吞吐下限累加，上限 15 分钟）。

### 2. 外部来源展示（链接，不再分发）

设计前提是：**素材字节始终由上游仓库提供，本项目不转存、不再分发。** 目录里只保存地址加校验值。

关键结论：因为投递必须经过具备中间人能力的第三方代理，所以**不能**同时放宽 SHA-256 校验，否则等于接受无问责中间人提供的任意字节。因此每个素材的摘要在生成目录时钉死，运行时沿用现有严格校验。上游改文件表现为一次可解释的失效提示，而不是安全缺口。`skins.ts` 的校验链路因此一行未改。

结构上禁止再分发：`assertExternalCatalog` 强制素材 host 必须是 `raw.githubusercontent.com` 且路径属于声明的仓库，并有测试断言任何外部素材 URL 都不含 `gitee.com`。

界面上是皮肤商店里的独立页签，**默认关闭**，首次进入显示确认面板，说明素材不属于本商店、部分上游没有 LICENSE、上游改动会导致失效。每张卡片带来源角标、许可证状态徽章、上游仓库链接和原样显示的权利说明，页脚有「恢复 Harness 默认皮肤」入口（否则应用了外部皮肤后必须切回官方页签才能取消）。外部条目是独立类型 `ExternalSkinCatalogItem`，不复用官方 `SkinLicense`（那是 CC0/CC-BY 闭集）。

外部预览图**不钉摘要**，用的是 `cdn.statically.io` 实时缩放。原因是自己生成并托管缩略图就等于复制。预览图只用于展示、不写进插件配置，与官方目录缩略图在渲染层同样不校验的现状一致。

### 3. 动图冻帧（`bundled-plugins/deepblue-dsh-skin-runtime`，0.4.0 → 0.5.0）

发现的问题：动画 GIF 与动态 WebP 的帧由解码器驱动，CSS 管不着。视频有 `visibilitychange` 暂停和 reduced-motion 隐藏，动图两者都没有——原先那条 reduced-motion 规则只关掉了 CSS 漂移动画。也就是说用户开了「减少动态效果」仍会看到循环动画，切到后台也不停。

修法是 `useAnimationHold`：reduced-motion 或页面隐藏时，把当前帧画进 canvas 并隐藏原 `<img>`。皮肤与宠物都接入（宠物 56 个里 50 个是动态 WebP，暴露面更大）。静态皮肤与视频走原路径不变。

插件版本号原先在 `controller.ts` 里硬编码，与插件 manifest 不同步时只打一条 WARN、皮肤和宠物直接静默失效。现在有 `npm run plugin:pack`（打包前校验两处版本一致）和一个锁死一致性的测试。`resources/plugins/deepblue-dsh-skin-runtime-0.5.0.tgz` 已生成并提交。

**旧版本 tarball（0.2.0 / 0.3.0 / 0.4.0）是被 git 跟踪的，不是构建产物，不要清理**，仓库保留它们是为了让已安装的 profile 仍能解析当初的压缩包。

### 4. 素材来源与筛选

三轮扫描的结论，供判断后续投入方向：

- **静态图**：26 个仓库共 14,273 张，但许可证清白的极少。真正无争议的只有 `rose-pine/wallpapers`（85 张，CC0）。「MIT 壁纸合集」多数是给别人的作品套 MIT——`SleepyCatHey/CozyPixels` 自述 gathered、`FrenzyExists/wallpapers` 自述 personal pick。
- **视频**：573 个候选里 65 个带视频，但**没有一个是真正的视频壁纸素材库**，全是播放器与引擎的演示资源。四项规格筛选后全网剩约 47 个候选，分散 12 个仓库，许可证覆盖大多存疑。对比之下自有 skin-store 已有 22 个视频皮肤（5 秒循环、1920×1080、24 fps、无音轨、约 3.7 MB、CC0 原创）——**外部可用视频还不如自己已有的多**。
- **动图**：76 个仓库有动画媒体，只 18 个横屏可用，绝大多数是库与工具的 README 演示动图。动态 WebP 在 GitHub 上基本不存在（只有一个 Rust crate 演示）。

因此**共创投稿是动态素材唯一能持续扩量的路径**，不是补充手段。

当前目录：7 个来源、28 个素材（4 个循环动图）。清单与收录/排除理由写在 `scripts/external-skin-sources.json` 的 `$comment` 里。已排除的典型案例：

- `dxnst/nord-backgrounds`：分子渲染图按管制药物命名（cocaine、diazepam 等），面向新手用户的产品不适合。
- `HyDE-Project/hyde-gallery`：6 个 1920×1080 GIF 实为各主题桌面演示录屏（均名为 `overview.gif`）。
- `elapse-d/foo-Wallpaper-Feh-Gif`：feh 循环脚本仓库，MIT 覆盖脚本，README 用 imgur 相册提供素材。
- `dharmx/walls`、`JoydeepMallick/Wallpapers` 等：作者自述不拥有版权，或文件名含 wallhaven / Unsplash / Pixiv 作品编号。

被自动规则误杀、**值得人工救回**的两个：`elementary/wallpapers`（自定义许可证未被 SPDX 识别，实际按图署名）和 `pop-os/wallpapers`（System76 官方集，实为 Unsplash 摄影师授权）。

## 三、验证状态

### 换皮链路已实测打通

外部来源的视频与 GIF **能够正常换皮**，这一点原先只有推理没有证据：既有的 `smoke-appearance-runtime-cache.mjs` 只检查 config 路由的 URL 版本号，从未真正请求 `/deepblue-skin/media`，也没验证过 Content-Type 与 Range。而 Content-Type 错误会让浏览器拒绝渲染壁纸，缺少 Range 支持会让视频无法拖动。

新增的 `scripts/smoke-appearance-media-routes.mjs` 覆盖了这一段，已接入 `npm test`。它对 `image/gif`、`image/webp`、`video/mp4`、`image/png` 四种逐一断言：config 路由声明的 mediaKind 与内容版本参数、媒体路由的 Content-Type 与完整字节、`accept-ranges` 与 `nosniff` 头、HEAD 无响应体、`bytes=2-5` 返回 206 且 Content-Range 正确、越界 Range 返回 416，另外覆盖带 poster 的视频、无 poster 的动图返回 404、动态 WebP 宠物路由，以及媒体路由拒绝 POST。

结论：插件服务端的 `mimeFor` 已正确处理 gif/mp4/webm，Range 与内容版本缓存均实现完整，**无需改动启动器功能**。

### 命令

```
npm run typecheck                  # 干净
npm test                           # 82 passed | 1 skipped（含两个外观 smoke 与代码签名就绪检查）
npm run test:plugin                # install -> compose -> update -> remove 全流程
npm run verify:external            # 结构校验：7 个来源 / 28 个素材
npm run verify:external -- --live  # 2026-08-22 全部 28 项与上游摘要一致
```

素材 ID 形如 `ext-rose-pine-wallpapers-anime-bocchi-studio`，由所有者、仓库名和完整路径生成。目录尚未签名发布，所以这套 ID 还没有对外承诺，改动生成规则不会影响已有用户；一旦上线就不要再改，它会作为 `skinId` 持久化进用户的 `active.json`。

**未完成的两项：**

1. **目录尚未签名。** `skin-store/external-catalog.payload.json` 已生成，但签成 `external-catalog.json` 需要 Ed25519 私钥。
2. **界面可视化验收未跑。** `scripts/qa-skin-store-ui.mjs` 已就绪（走完整流程并断言页签、确认面板、来源列表、角标数量与卡片数一致、无元素溢出、无控制台错误，失败非零退出），但沙箱内 `npx playwright install chromium` 下载 170 MB 后卡在解压，没能执行。

## 四、上线步骤

沿用 [RELEASE.md](RELEASE.md)，本轮只增加两处。

### 1. 推送分支

```sh
git push -u origin cursor/external-skin-sources-and-mirror-fallback
```

不要把第一节列出的三处未提交内容带进来。

### 2. 补跑未完成的验证

```sh
npx playwright install chromium
npm run dev:web                      # 另开一个终端
node scripts/qa-skin-store-ui.mjs    # 截图写入 docs/qa/skin-store-external/
```

### 3. 签名外部目录（新增步骤）

`sign-store-catalogs.mjs` 本轮已扩展，会在 `external-catalog.payload.json` 存在时一并签名，用的是**皮肤商店同一把私钥和同一个 keyId**（`skin-production-20260817`），因为启动器通过皮肤信任根解析这份目录。命令没变：

```sh
node scripts/sign-store-catalogs.mjs --skin-key /secure/skin-private.pem --pet-key /secure/pet-private.pem
```

产出会多一条 `skin-store (external sources)`。

### 4. 发布前复核上游摘要（新增步骤，重要）

```sh
npm run verify:external -- --live
```

会重新下载全部 28 个素材并比对钉死的摘要。**任何一项 drift 都必须先重新生成目录再发布**，否则该条目对所有用户都会校验失败：

```sh
npm run catalog:external -- --limit 6
```

`--reuse` 只供本地迭代，发布前不要用（复用摘要检测不到上游换文件）。

### 5. 同步到 Gitee 皮肤仓库

按 RELEASE.md 第 4 节第 9 步，把签名后的 `external-catalog.json` 与 `catalog.json` 一起同步到公开 Gitee 皮肤仓库。启动器读取的固定地址是：

```
https://gitee.com/wanggp123/deepseek-harness-skins/raw/master/external-catalog.json
```

**只上传目录正文，不要上传任何外部素材文件。** 一旦把上游素材放进自己的仓库，性质就从链接展示变为再分发，本轮的整套设计前提失效。

### 6. 打包

`npm run dist:win` 之前确认 `resources/plugins/deepblue-dsh-skin-runtime-0.5.0.tgz` 在位——它是首次启动 Harness 时安装外观插件的来源，缺失只会打一条 WARN 然后静默失去皮肤与宠物。

## 五、遗留事项

- 官方 Gitee 商店没有镜像回退（无对应镜像服务）。若要享受回退，需把素材同时放一份到 GitHub，那是独立决定。
- 皮肤下载没有进度反馈，任务只显示「正在校验本地缓存并按需下载原媒体」。超时预算改为按体积计算后，大素材在慢网络下可能静默等待数分钟。若后续引入视频类外部来源，建议补上按字节的进度上报（运行模块下载已有这套机制可参考）。
- `verify:external` 未接入 RELEASE.md 第 3 节的质量检查清单，目前需手工执行；建议正式化时并入。
- 共创投稿流程（CC0 模板、审核、签名、上架脚本）尚未开始，这是动态素材扩量的唯一可持续路径。
- 本轮涉及外部素材权利判断，基于公开资料与项目自身约束，不构成法律意见。正式对外分发前建议就「外部来源展示」单独征询法律意见。

## 六、调研原始数据

已归档进仓库：`docs/research/wallpaper-sources/`。六份扫描结果 JSON 加 `scans/` 下的七个扫描脚本，索引与三条主要结论见该目录的 [README](../research/wallpaper-sources/README.md)。

后续增删 `scripts/external-skin-sources.json` 里的来源时先看 `curate-result.json`，它记着 52 个候选仓库的许可证分级与来源瑕疵标记；`mirror-result.json` 是 `asset-mirrors.ts` 渠道顺序和超时吞吐假设的依据。数据是 2026-08-21 的 API 快照，判断某个来源当前是否仍合适需要重跑对应脚本。

扫描脚本是一次性调研工具，不属于产品代码，未接入 `npm test`，都需要 `gh auth token` 提供凭据。

另有两份可视化审计报告在 Cursor 画布目录（不在仓库内，随会话保存）：`wallpaper-repo-gallery.canvas.tsx` 是 26 个图片仓库的缩略图画廊，`wallpaper-source-audit.canvas.tsx` 是镜像实测与 52 个仓库的许可证审计矩阵。
