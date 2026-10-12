# Electron 本地客户端方案

## 1. 目标

创建一个独立的 Electron 客户端项目，复用 `galaxy-downloader` 的 React 界面和交互，同时把解析、登录态处理、下载、音视频合并、历史记录全部放到用户本机执行。

客户端不依赖 `bhwa233-download-api` 的远程 Worker，不上传用户 Cookie，也不把下载任务转发到远程解析服务。

## 2. 为什么做客户端

现有 Worker 架构中的请求来自固定的服务器环境，无法自然复用用户本地浏览器的登录态、IP、浏览器指纹和动态页面上下文。对于小红书、抖音、微博、YouTube 等平台，单独携带 Cookie 往往还不够。

客户端可以在本机完成以下工作：

- 使用用户本机网络和代理；
- 读取用户明确选择的浏览器 Cookie；
- 在应用自己的浏览器会话中保存并复用登录态；
- 在真实浏览器上下文中执行页面解析和签名计算；
- 直接启动 yt-dlp、FFmpeg 和其他本地工具；
- 将媒体文件直接保存到用户选择的目录。

## 3. 项目边界

### 客户端包含

- 平台 URL 识别和规范化；
- 平台解析器；
- 浏览器会话和 Cookie 管理；
- yt-dlp 调用和版本管理；
- FFmpeg 调用和音视频合并；
- 下载队列、暂停、取消、重试和进度；
- 本地文件保存和命名；
- 本地下载历史、设置和日志；
- React 用户界面。

### 客户端不包含

- Cloudflare Worker API 调用；
- 远程 DLP 服务调用；
- 服务端限流、缓存和管理接口；
- 公开 API 文档、SEO、广告和网站部署逻辑；
- 将用户 Cookie 上传到服务器。

现有 API 项目继续作为独立的 Web/API 服务保留，客户端不把它作为运行时依赖。

## 4. 技术方案

```text
Electron + Vite + React + TypeScript
Electron Builder 或 Electron Forge
pnpm
yt-dlp
FFmpeg
SQLite 或本地 JSON 存储
Electron 内嵌浏览器会话（BrowserWindow + webContents.debugger）
```

选择 Electron 的原因：

- 可以直接复用现有 React 和 TypeScript 组件；
- 主进程具备完整 Node.js 文件、进程和网络能力；
- 适合启动 yt-dlp、FFmpeg 等本地二进制程序；
- 可以实现系统托盘、剪贴板监听、协议唤起和自动更新；
- 便于接入内嵌浏览器窗口，并通过 webContents.debugger 观察页面网络。

项目不会直接复制一个完整下载器，而是参考以下开源项目：

- [VidBee](https://github.com/nexmoe/VidBee)：Electron + React 下载器和产品功能；
- [arcdlp](https://github.com/archisvaze/arcdlp)：Electron 主进程、IPC、队列和 yt-dlp 调用拆分；
- [StreamFetch](https://github.com/Shripad735/streamfetch)：下载队列、日志和任务控制；
- [MediaCrawler](https://github.com/NanmiCoder/MediaCrawler)：连接已有浏览器、复用登录态和页面上下文。

## 5. 建议的项目结构

```text
galaxy-downloader/
├─ electron/
│  ├─ main/
│  │  ├─ main.ts                 # 窗口和应用生命周期
│  │  ├─ ipc.ts                  # IPC 通道注册
│  │  └─ protocol.ts             # 可选的自定义 URL 协议
│  ├─ preload/
│  │  └─ index.ts                # 通过 contextBridge 暴露安全 API
│  └─ services/
│     ├─ parser/                 # 本地平台解析器
│     ├─ browser/                # 内嵌浏览器会话和页面抓取
│     ├─ cookies/                # Cookie 读取和清理
│     ├─ downloader/             # HTTP、yt-dlp 和 FFmpeg
│     ├─ queue/                  # 任务状态和调度
│     ├─ storage/                # 设置、历史和任务持久化
│     └─ updater/                # 应用和工具更新
├─ src/
│  ├─ app/                       # 客户端页面
│  ├─ components/                # 从 galaxy-downloader 迁移的组件
│  ├─ hooks/
│  ├─ stores/
│  └─ styles/
├─ shared/
│  ├─ types/                     # Renderer 和 Main 共用类型
│  └─ constants/
└─ resources/
   ├─ yt-dlp/                    # 可选的内置或按需下载的二进制
   └─ ffmpeg/                    # 可选的内置或按需下载的二进制
```

## 6. 运行时数据流

```text
用户粘贴 URL
    ↓
React Renderer
    ↓ IPC
Electron 主进程
    ├─ 识别平台
    ├─ 选择普通 HTTP、yt-dlp 或浏览器上下文解析
    ├─ 获取本地 Cookie / 应用内浏览器会话
    ├─ 创建下载任务
    ├─ 下载并调用 FFmpeg
    └─ 保存历史和日志
    ↓ IPC 事件
React 更新解析结果、进度和错误
```

Renderer 不直接访问文件系统、Cookie 数据库或子进程。所有这些操作都通过白名单 IPC 通道完成，避免把 Node 能力暴露给页面代码。

## 7. 浏览器登录态方案

### 7.0 默认用户体验：优先 yt-dlp，失败时用应用内浏览器

客户端不要求用户了解 CDP、远程调试端口或开发者工具。认证路径固定为两跳：

```text
yt-dlp 直接解析（尽量带上系统浏览器的登录态）
    ↓ 失败或需要真实页面环境
应用内浏览器会话（客户端自己持有的登录态）
```

第一跳对公开内容就足够，不需要任何登录态。客户端仍会尝试读取系统浏览器（Chrome / Edge /
Firefox）的 Cookie 作为顺带的便利，但这只是 best-effort：读取失败不阻断解析，客户端去掉 Cookie
重试一次，并记住本机读不出来，后续不再重复尝试。

需要登录的内容走第二跳。用户在应用内的登录窗口里完成一次登录，登录态保存在客户端自己的
`persist:media` partition 中，本机持久化，重启后继续有效。界面只显示「是否已在应用内登录」，
不暴露 DPAPI、Profile 路径、partition 名称等实现细节。

### 7.0.2 yt-dlp 的直接读取方式

客户端不需要自行发明 Cookie 数据库格式，而是复用 yt-dlp 的 `--cookies-from-browser BROWSER[+KEYRING][:PROFILE][::CONTAINER]` 机制。

yt-dlp 的实现大致分为以下步骤：

1. 根据浏览器名称和 Profile 计算本机 User Data 目录；
2. 在 Profile 中寻找最新的 `Cookies` SQLite 数据库；
3. 将数据库复制到临时目录后读取，避免直接操作正在使用的原文件；
4. 查询 `cookies` 表中的域名、名称、明文值、加密值、路径、过期时间和 Secure 标志；
5. 根据操作系统和浏览器版本解密 `encrypted_value`；
6. 将有效 Cookie 转换为标准 Cookie Jar，注入 yt-dlp 的请求；
7. 对多个来源的 Cookie 去重合并，并忽略已过期或无法解密的项。

不同平台的解密方式由 yt-dlp 按 Chromium 的加密实现处理：Windows 使用 DPAPI 或 AES-GCM，macOS 使用系统 Keychain 派生密钥，Linux 使用 Secret Service / KWallet 等系统密钥环。Firefox 则直接读取其 Cookies SQLite 数据库。具体实现位于 yt-dlp 的 [`yt_dlp/cookies.py`](https://github.com/yt-dlp/yt-dlp/blob/master/yt_dlp/cookies.py)。

客户端应优先启动随应用提供的 yt-dlp 进程完成读取，而不是在 Electron Renderer 中读取 Cookie 数据库。主进程只接收解析状态、Cookie 数量和错误分类，不把 Cookie 值传入 Renderer。

### 7.1 应用内浏览器会话

需要真实页面环境时，客户端在自己的隐藏窗口里加载目标页面，用于：

- 携带并刷新客户端自己的登录态；
- 打开目标页面并执行页面脚本；
- 获取动态签名、页面数据和真实媒体请求；
- 通过 `webContents.debugger` 的 Network 域监听响应，发现 m3u8、mpd、CDN 地址，
  以及抖音、小红书主页列表接口的 JSON 响应体。

创作者主页列表只能走这条路径：列表由 JavaScript 渲染，yt-dlp 拿不到。

不使用外部 Chrome 的 CDP。Chrome 127+ 用 App-Bound Encryption 封存 Cookie，读不出来；
而连接一个正在运行的 Chrome 需要 `--remote-debugging-port`，客户端无权给一个不是自己启动的
浏览器设置启动参数。这两条在 Windows 上同时失效，所以这条路线已从客户端移除。

### 7.2 登录态的两个来源

| 来源 | 用途 | 失败时 |
|---|---|---|
| 系统浏览器 Cookie（yt-dlp `--cookies-from-browser`） | 顺带复用用户已有登录态 | 静默跳过，去掉 Cookie 重试 |
| 应用内浏览器 partition | 客户端自己持有的登录态 | 提示用户打开登录窗口 |

两者都只在本机主进程中使用，不上传服务器，也不传给 Renderer。设置中提供清除应用内登录态的入口。

### 7.3 Cookie 文件导入

不提供 Cookie 文件导入。需要登录态时使用应用内登录窗口，不要求用户导出、粘贴或维护 Cookie 文件。

## 8. 解析器迁移策略

现有 `src/parsers/` 和平台检测逻辑作为迁移起点，但不能直接复制所有 Worker 代码。

| 现有内容 | 客户端迁移方式 |
|---|---|
| URL 检测和短链接展开 | 迁移到本地共享模块 |
| 普通 API / HTML 请求 | 改为 Node `fetch` 或浏览器上下文请求 |
| 依赖 Cookie 的解析 | 使用系统浏览器 Cookie 或应用内浏览器会话 |
| 依赖动态 JS 签名的解析 | 在应用内浏览器页面中执行 |
| Bilibili 代理 API | 移除，改为本地请求或 yt-dlp |
| Generic DLP | 改为本地 yt-dlp，不能继续依赖远程 DLP |
| Worker 流式下载 | 改为本地文件流和下载任务 |
| HLS Worker 代理 | 改为本地 m3u8 下载器和 FFmpeg |

第一阶段优先迁移 Bilibili、YouTube、抖音和小红书；其他平台保留清晰的适配器接口，按实际成功率逐个平台迁移。

## 9. 下载引擎

下载器分为三条路径：

1. **普通 HTTP 下载**：适合已经拿到稳定直链的资源，支持 Range、重试和进度。
2. **yt-dlp 下载**：适合 YouTube、Bilibili 及大量通用平台，解析格式并处理音视频合并。
3. **浏览器网络捕获**：适合必须经过登录页面、动态签名或播放器请求才能获取的资源。

每个任务都需要保存：URL、平台、标题、状态、进度、目标路径、错误信息、解析方式和创建时间。

## 10. Galaxy 界面迁移

优先复用：

- `components/downloader`
- `components/ui`
- 平台徽标和平台支持列表
- 视频、音频、图片和多分 P 结果面板
- 多语言资源
- 主题和基础样式
- 下载历史界面

需要重写：

- 依赖 Next/vinext Server Component 的页面边界；
- 直接调用 Web API 的数据层；
- 浏览器端专用下载逻辑；
- 网站 SEO、广告和 PWA 相关组件。

目标是保留用户已经熟悉的交互，而把数据来源替换为本地 IPC 服务。

## 11. 分阶段实施

### 阶段一：客户端骨架

- 创建独立 Electron + Vite + React 项目；
- 建立主进程、preload 和 Renderer；
- 定义 IPC API 和共享类型；
- 迁移 Galaxy 基础 UI；
- 实现本地设置和文件目录选择。

### 阶段二：本地下载闭环

- 集成 yt-dlp 和 FFmpeg；
- 实现 Bilibili、YouTube 的解析和下载；
- 实现队列、进度、取消、重试；
- 实现历史记录和日志。

### 阶段三：浏览器登录态

- 实现浏览器选择和 Cookie 配置；
- 直接读取用户选择的浏览器登录态；
- 直接读取失败或不足时使用应用内浏览器会话；
- 用登录态完成一个平台的端到端验证。

### 阶段四：平台迁移

- 迁移抖音和小红书；
- 再迁移微博、TikTok、X、Instagram 等平台；
- 按平台记录普通请求、Cookie、浏览器上下文三种模式的成功率。

### 阶段五：发布能力

- Windows、macOS、Linux 打包；
- yt-dlp / FFmpeg 下载和更新策略；
- 应用自动更新；
- 崩溃日志和用户可导出的诊断日志；
- 文件签名和发布校验。

## 12. 需要提前确认的产品决策

以下决策会影响第一版设计：

1. 首发平台是否只覆盖 Windows，还是同时支持 macOS 和 Linux；
2. yt-dlp 和 FFmpeg 是随安装包内置，还是首次启动时下载；
3. ~~是否首版就支持 Chrome CDP~~：已决定移除外部 Chrome CDP，见 7.1；
4. ~~是否允许客户端内嵌登录~~：已决定采用应用内登录窗口，见 7.0；
5. 历史记录使用 SQLite，还是先使用 JSON 文件；
6. 是否需要浏览器扩展，把当前网页 URL 一键发送到客户端；
7. 客户端是否需要保留现有 Web API 作为可选的远程模式。

## 13. 推荐的首版范围

首版建议包含：

- Windows 优先；
- Galaxy 首页和结果卡片；
- Bilibili、YouTube、抖音、小红书；
- 本地 yt-dlp 和 FFmpeg；
- 下载队列、历史和日志；
- 自动检测浏览器并直接读取登录态；
- 直接读取失败后自动引导 Chrome CDP；
- 本地界面、历史和工具链不调用远程 Worker；访问目标平台时仍需要网络。

首版暂不包含：

- 多账号管理；
- 代理池；
- 远程任务同步；
- 浏览器扩展；
- 复杂的批量订阅和 RSS；
- 移动端版本。

## 14. 验收标准

第一版完成后，应满足：

- 断开网络后仍能打开客户端和查看历史记录；
- 客户端解析与下载流程不请求 `bhwa233-download-api`；
- 用户选择的下载目录中可以得到最终文件；
- 视频和音频合并由本地 FFmpeg 完成；
- 下载失败可以看到可读错误和原始日志；
- 用户可以清除 Cookie 配置和本地历史；
- Renderer 无法直接访问 Node 文件系统和任意子进程；
- 至少一个需要登录态的平台可以通过本地浏览器会话完成解析和下载。

## 15. 已确定的认证决策

本方案最终只保留两条登录态路径：

1. 使用 yt-dlp 直接读取用户选择的浏览器 Profile；
2. 直接读取失败或登录态不足时，连接用户授权的 Chrome CDP。

首版不实现以下路径：

- Cookie 文件导入；
- Electron 内嵌登录窗口；
- Edge CDP；
- 远程 Worker 或远程 DLP 认证代理；
- 让用户手动填写调试端口、Cookie 数据库路径或解密参数。

客户端需要自动完成浏览器发现、Profile 列表展示、直接读取、失败判断和 Chrome CDP 引导。用户只需要登录浏览器、选择浏览器，并在 Chrome CDP 流程中确认授权。

## 16. 当前实现落点（2026-09-15）

客户端工程位于 `electron-client/`，基于 `electron-vite/electron-vite-react` 固定提交创建，使用独立 pnpm workspace。Galaxy 的 `ResultCardHeader`、Radix UI 原语、Tailwind 主题变量、平台图标和多语言 JSON 已迁移，页面数据层通过受限 IPC 接入本地主进程。

已落地的运行链路：

- 主进程负责 Profile 发现、yt-dlp Cookie 读取、Chrome CDP、解析、下载、队列、持久化和更新；Renderer 只得到脱敏状态。
- yt-dlp 以本地 Python NDJSON 引擎运行；安装包通过 PyInstaller 内置引擎和 `ffmpeg-static` 的 FFmpeg。开发环境运行 `pnpm engine:dev`。
- 直接解析优先使用选中的 Chrome / Edge / Firefox Profile；失败后只进入 Chrome CDP。客户端不提供 cookies.txt 导入、Electron 内嵌登录或远程 Worker/DLP。
- CDP 自动读取 Chrome `DevToolsActivePort`，用户只需打开 `chrome://inspect/#remote-debugging` 并接受授权提示；客户端只新建和关闭自己的任务页。
- 下载支持本地 HTTP 资源、yt-dlp 格式下载、FFmpeg 合并、断点续传、重试、暂停/取消/重试、历史和脱敏诊断日志。
- Renderer 启用 `contextIsolation`、sandbox、禁用 Node integration；IPC 使用固定命令 schema、发送方校验和文件路径校验。
- CI 在 Ubuntu 上执行类型检查、lint、单元边界测试、引擎安装和真实 Electron E2E；main 分支在 Ubuntu、Windows、macOS 分别构建原生引擎和安装包。electron-updater 使用 GitHub Releases，正式发布应配置签名证书和 release 权限。

开发命令：

```bash
cd electron-client
pnpm install
pnpm engine:dev
pnpm dev
pnpm check
pnpm test:e2e
pnpm package
```

“离线可打开”指客户端界面、设置和历史不依赖远程 Worker；平台解析和媒体下载仍按目标平台需要访问其站点。自动更新仅更新应用安装包及其中的 yt-dlp/FFmpeg，运行时不会下载未校验的可执行文件。

## 17. 主页批量采集

输入小红书 `/user/profile/`、Bilibili `/space/` 或抖音 `/user/` 地址时，客户端进入主页采集流程，不把主页当成单条媒体解析。主进程在应用内浏览器的隐藏窗口中打开主页，滚动加载页面并收集笔记/视频链接、标题、缩略图和媒体类型，最多收集 500 条。

结果页不提供媒体类型筛选：条目的类型由页面结构推断，判断并不可靠，把猜错的条目直接藏起来比让用户自己挑更糟。结果按视频/音频/图片分组展示，用户自行勾选。下载进入同一个本地队列；任务保存原始条目 URL，因此重启或重试不会依赖结果列表的临时序号。

主页采集需要用户登录态和页面可见内容。验证码、隐私主页、未加载完成的分页和平台限制会返回可读错误，不尝试绕过平台访问控制。首版采用页面滚动采集，后续可按平台增加“加载更多”按钮和平台专用游标。
