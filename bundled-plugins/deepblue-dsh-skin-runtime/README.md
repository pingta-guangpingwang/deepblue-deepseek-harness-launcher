# @deepblue/dsh-skin-runtime

DeepSeekHarness 启动器外观商店的本地运行插件。Host 端只读取启动器写入的 `DEEPBLUE_DSH_SKIN_CONFIG` 和 `DEEPBLUE_DSH_PET_CONFIG`，并通过固定的环回 HTTP 路由提供经过选择的皮肤或宠物媒体；浏览器端通过 Harness 的 `theme` 服务和 `shell.overlay` 插槽应用背景与互动宠物。

网页宠物支持透明帧动画、像素精灵表状态行、Live2D 待机与点击动作、双击爱心、定时主动问候、拖动位置和位置记忆，并尊重系统的“减少动态效果”设置。Live2D 模型必须先通过签名模型清单逐文件校验；插件不执行资源仓库中的 CSS 或 JavaScript。

启用皮肤后，应用右上角始终显示“清透壁纸 / 恢复蒙版”快捷按钮，空白首页和已有会话都可使用。清透状态只降低 Harness 内容表面的遮挡并移除壁纸蒙版，不改变文字和交互控件；用户选择保存在浏览器本机，下次打开会自动恢复。

Live2D 播放能力使用 MIT 许可的 `l2d` 2.1.1 封装；其内含的 Live2D Cubism SDK 仍适用 Live2D Inc. 的专有软件与发布许可。模型资源许可彼此独立，目录会原样展示来源声明。
