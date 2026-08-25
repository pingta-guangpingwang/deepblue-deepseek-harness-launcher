# @deepblue/dsh-skin-runtime

DeepSeekHarness 启动器外观商店的本地运行插件。Host 端只读取启动器写入的 `DEEPBLUE_DSH_SKIN_CONFIG` 和 `DEEPBLUE_DSH_PET_CONFIG`，并通过固定的环回 HTTP 路由提供经过选择的皮肤或宠物媒体；浏览器端通过 Harness 的 `theme` 服务和 `shell.overlay` 插槽应用背景与互动宠物。

网页宠物支持透明帧动画和像素精灵表状态行。单击会从全部有效非待机动作中随机选择并避免连续重复；待机一段时间会主动随机互动；按住可拖动位置并自动记忆，同时尊重系统的“减少动态效果”设置。插件不执行资源仓库中的 CSS 或 JavaScript。

启用皮肤后，应用右上角始终显示“清透壁纸 / 恢复蒙版”快捷按钮，空白首页和已有会话都可使用。清透状态只降低 Harness 内容表面的遮挡并移除壁纸蒙版，不改变文字和交互控件；用户选择保存在浏览器本机，下次打开会自动恢复。
