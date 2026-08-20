# @deepblue/dsh-skin-runtime

DeepSeekHarness 启动器外观商店的本地运行插件。Host 端只读取启动器写入的 `DEEPBLUE_DSH_SKIN_CONFIG` 和 `DEEPBLUE_DSH_PET_CONFIG`，并通过固定的环回 HTTP 路由提供经过选择的皮肤或宠物媒体；浏览器端通过 Harness 的 `theme` 服务和 `shell.overlay` 插槽应用背景与互动宠物。

网页宠物支持透明帧动画、悬停回应、点击动作、双击爱心、定时主动问候、拖动位置和位置记忆，并尊重系统的“减少动态效果”设置。插件不执行资源仓库中的 CSS 或 JavaScript。远程目录只允许声明媒体 URL、SHA-256、许可信息以及受限的显示或互动参数。
