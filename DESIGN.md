---
name: 深蓝 DeepSeekHarness 启动器
description: 以 DeepSeek 鲸鱼标志和清晰操作状态为核心的浅色桌面工具界面
colors:
  deepseek-blue: "#4d6bfe"
  deepseek-blue-hover: "#3e57d8"
  deepseek-blue-soft: "#eef1ff"
  paper: "#ffffff"
  canvas: "#f7f8fa"
  ink: "#202124"
  ink-secondary: "#666970"
  divider: "#e4e6ea"
  success: "#23ad79"
  warning: "#d58a1e"
  danger: "#dc4c58"
typography:
  display:
    fontFamily: "Microsoft YaHei UI, PingFang SC, Noto Sans CJK SC, system-ui, sans-serif"
    fontSize: "clamp(28px, 3vw, 42px)"
    fontWeight: 700
    lineHeight: 1.08
    letterSpacing: "-0.03em"
  headline:
    fontFamily: "Microsoft YaHei UI, PingFang SC, Noto Sans CJK SC, system-ui, sans-serif"
    fontSize: "24px"
    fontWeight: 700
    lineHeight: 1.3
    letterSpacing: "-0.025em"
  body:
    fontFamily: "Microsoft YaHei UI, PingFang SC, Noto Sans CJK SC, system-ui, sans-serif"
    fontSize: "14px"
    fontWeight: 400
    lineHeight: 1.65
  label:
    fontFamily: "Microsoft YaHei UI, PingFang SC, Noto Sans CJK SC, system-ui, sans-serif"
    fontSize: "12px"
    fontWeight: 600
    lineHeight: 1.4
rounded:
  control: "10px"
  card: "16px"
  feature: "20px"
spacing:
  compact: "8px"
  standard: "16px"
  section: "24px"
components:
  button-primary:
    backgroundColor: "{colors.deepseek-blue}"
    textColor: "{colors.paper}"
    rounded: "{rounded.control}"
    padding: "0 16px"
    height: "36px"
  button-primary-hover:
    backgroundColor: "{colors.deepseek-blue-hover}"
  launch-button:
    backgroundColor: "{colors.deepseek-blue}"
    textColor: "{colors.paper}"
    rounded: "12px"
    height: "58px"
  api-billing-button:
    backgroundColor: "{colors.deepseek-blue-soft}"
    textColor: "{colors.deepseek-blue}"
    rounded: "12px"
    height: "58px"
  card:
    backgroundColor: "{colors.paper}"
    textColor: "{colors.ink}"
    rounded: "{rounded.card}"
    padding: "18px"
---

# Design System: 深蓝 DeepSeekHarness 启动器

## Overview

**Creative North Star: "DeepSeek 操作台"**

界面以 DeepSeek 鲸鱼标志作为身份锚点，以浅色产品界面承载环境检测、下载源和进程状态。首页先建立产品识别，再把一键启动作为最强操作，其他信息保持紧凑但不拥挤。

视觉保持克制、平面和可信。品牌蓝只用于身份、选中状态和主要动作；白色、浅灰与黑灰文字承担大部分阅读面积。

**Key Characteristics:**

- 大型 DeepSeek 鲸鱼标志与真实运行状态并置。
- 纸白内容面、浅灰画布和单一 DeepSeek 蓝强调色。
- 无装饰性玻璃、霓虹和赛博网格。
- 操作名称与状态优先于装饰。

## Colors

主色是清晰、偏冷的 DeepSeek 蓝，配合接近纸张的白色和轻灰分区。状态色只表达成功、警告和错误。

**The One Blue Rule.** DeepSeek 蓝只承担品牌、选中状态、链接和主要动作，不能把每个信息块都涂成蓝色。

## Typography

**Display Font:** Microsoft YaHei UI（回退到 PingFang SC、Noto Sans CJK SC、system-ui）

**Body Font:** Microsoft YaHei UI（同回退栈）
**Label/Mono Font:** Cascadia Code、SFMono-Regular、Consolas，仅用于版本、端口、路径和日志。

**Character:** 中文系统无衬线保证 Windows 清晰度；标题依靠字号和重量建立层级，不使用装饰字体。英文字标保持紧凑、直接。

**The Measurement Rule.** 等宽字体只用于真实测量值、标识符和日志，不作为科技感装饰。

模型目录在“模型接入与用量 / 多模态实测”之间使用紧凑二级页签。实测台采用左侧深色图片检视区、右侧任务输入区和底部可审计结果区：用户始终能看到正在测试的模型、是否只发一次请求、图片去向、耗时与 Token。成功、模型不支持图片、接口失败三种状态必须通过文字与图标共同表达，不能只依赖颜色。

## Layout

桌面使用固定侧栏、固定顶栏和可滚动内容区。侧栏按“运行 / 个性化 / 扩展 / 发现 / 管理”分组，组名只承担定位，不与页面入口竞争。首页品牌区跨越双列网格，其后启动与配置并列，再进入环境、源站、任务和日志。1240、1050、860 和 540 像素断点逐步减少列数；窄屏把侧栏改为抽屉，并将品牌区改成两列紧凑结构。

## Elevation & Depth

系统以色块和一像素分隔线表达层级，常规卡片不使用阴影。只有主要启动按钮在静止和悬停时带有柔和向下投影，表明它是可执行动作。

**The Flat Workspace Rule.** 信息容器保持平面；阴影只属于主要动作或移动侧栏，不用于每张卡片。

## Shapes

导航和常规控件使用轻度圆角，卡片使用 16 像素圆角，首页品牌区使用 20 像素圆角。小型版本标签可以使用胶囊形，其余内容块不使用胶囊形容器。

## Components

### Buttons

- 主要按钮使用 DeepSeek 蓝、白字和清晰动词；首页启动按钮高 58 像素。
- 次要按钮使用白底或淡蓝底与一像素边界。
- DeepSeek API 充值是紧邻启动按钮的次级官网动作，不与启动动作争夺主视觉权重。
- 键盘焦点使用半透明蓝色三像素轮廓；禁用状态降低透明度并停止位移和阴影。

### Cards / Containers

- 常规内容卡片为纸白背景、16 像素圆角和一像素浅灰边界。
- 首页品牌区使用淡蓝色面和 20 像素圆角，不再嵌套卡片。
- 密集数据通过行分隔和对齐表达，而不是继续套小卡片。

### Inputs / Fields

- 输入框使用浅灰底、一像素边界和 7 像素圆角。
- 聚焦时边界切换为品牌蓝，并保留键盘可见轮廓。

### Navigation

- 桌面侧栏为白色；默认项使用中灰，悬停转为浅灰背景。
- 当前项使用淡蓝背景、品牌蓝文字和一个六像素蓝色状态点。
- 860 像素以下侧栏成为带遮罩的抽屉。
- 能力区按用户心智独立为“提示词 / Skill / 工作流 / 知识库 / AI 工具 / 智能体 / 安装列表 / 模型连接”；ChatGPT 一类工具与同类 Agent 排在可复用能力之后。
- 账号登录固定在侧栏左下角，不与页面标题或窗口控制争夺注意力。

### Model Routing Hub

- 首屏先显示当前默认模型、全局切换器和 Key 是否已安全保存，再显示 Token 用量与平台连接。
- 主页面只显示已经保存的模型连接；未添加平台不在页面长列表中出现。
- 点击“添加模型”后用受保护弹窗分两步完成：先在“国内平台 / 海外与自定义 / 全部”列表中选择；已知平台直接勾选带更新时间的官方模型并填写 Key，连接名称、协议、API 地址和模型 ID 均锁定；只有“自定义模型服务”显示手填参数。保存成功后才进入“我的模型连接”和全局切换器。
- 平台选择弹窗每页最多九项，参数弹窗固定显示保存动作，启动器最小窗口下不依赖上下滚动完成添加。
- Key 输入允许临时显示，但保存后永不回填明文。用量卡只报告本地会话 Token，并把金额判断明确交给服务商官方账单。
- 自定义接口允许 HTTPS；只有本机 localhost 可使用 HTTP。模型 ID 与连接数量都有明确上限。

### Discovery Pages

- AI 新闻以最新列表为主、热门排行为辅；双击新闻或按 Enter 打开原生阅读弹窗，显示摘要、为什么重要、影响对象和行动建议；只有“查证原始来源”使用默认浏览器。
- AI 游戏合并网站的托管试玩、官方试玩、开源项目和经典项目目录，使用真实封面和短简介；开源/经典项目先在主窗口详情层阅读，只有实际开始游戏才打开受控试玩窗口。
- 六类能力页面直接同步网站目录，卡片显示评分、热度与可信开源指标；详情层显示完整结构、源码复制和用户评价。能力先加入安装列表，Skill 安装到 DSH 原生目录，其他对象写入受控资料库；绝不把公开条目静默当作可执行插件。
- 六类能力卡片统一以单击打开原生详情；卡片内部的复制、加入列表和安装按钮阻止事件冒泡，不能意外打开或重复执行详情动作。
- 职场进化在启动器内展示 33 个职业及其工作模块，左侧切换职业、右侧查看具体模块；只有长篇教学按需打开网站。

### DeepSeek Brand Panel

鲸鱼标志、产品名、整合包定位和发行类型共同构成首页身份区。标志必须使用项目自带 SVG，不允许重新绘制成其他鲸鱼轮廓。

### Skin Store

- 商店沿用白色卡片和单一品牌蓝，不把皮肤自身的霓虹画风扩散到启动器外壳。
- 页首必须直接显示可点击的公开仓库地址，并邀请用户提交原创素材、完善目录和文档；共创入口不得只藏在图标按钮里。
- 预览固定为 16:9，卡片下方始终显示媒体类型、许可证和明确的“下载并应用”动作。
- 筛选分成媒体与画风两行；窄屏允许横向滚动，不把七个分类压成难读的小字。
- 当前皮肤以绿色状态标记；未缓存项在按钮中显示下载体积，避免用户误以为会批量下载全部素材。

## 宠物商店

- 宠物商店延续启动器的深蓝与青色体系，透明宠物立在柔和的舞台面上，保持资源本身清晰但不让装饰盖过功能信息。
- 页首必须直接显示可点击的公开仓库地址，并邀请所有人参与原创宠物、分类和文档共创。
- 卡片明确显示物种、互动动作、下载体积、许可证和本机来源；添加本地宠物与参与开源贡献位于商店页首屏。
- Harness 内宠物默认位于右下角，可拖动、点击互动并记住位置；窄屏限制尺寸，系统启用减少动态效果时停用非必要动画。
- 每张可运行宠物同时提供“应用到 Harness”和“应用到电脑桌面”，两种状态分别标注；电脑桌面宠物可从卡片、预览和托盘停止。

### DSH 开源生态

- 生态页按“推荐增强 / 高级能力 / 已安装”组织，不把所有插件堆成一张无限列表。
- 每个插件必须显示常规、网络或系统权限等级、用途、源码地址和准确包名；安装按钮只调用 Harness 原生 Web profile 命令。
- 远程控制、SSH、终端与文件系统类插件不得默认安装，也不能伪装成普通界面组件。

## Do's and Don'ts

### Do:

- **Do** 在首页第一屏保留明显的鲸鱼标志和主要启动按钮。
- **Do** 使用真实版本、端口、源站和运行状态。
- **Do** 保持蓝色稀缺，让主要动作和当前状态易于扫描。

### Don't:

- **Don't** 使用通用赛博朋克背景、霓虹网格或渐变文字。
- **Don't** 用新的航船、火箭或抽象 AI 图标替换 DeepSeek 鲸鱼标志。
- **Don't** 用阴影和卡片嵌套代替信息层级。
