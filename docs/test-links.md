# 测试链接清单

本文汇总全部平台的测试链接，供实现与验收时使用。**状态列只有两种**：已验证 = 在真实浏览器里打开并确认过可用；待补 = 还没有拿到可用的样本。拿不到的都写了原因，不要凭空编链接。

## 客户端实测结果（2026-10-13，平台原始音轨音质选择）

之前结果页只显示视频画质，选音频后禁用画质菜单，引擎也始终覆盖成 `bestaudio/best`。现在解析保留独立的 `audioFormats`（格式 ID、编码/容器、平台报告的码率与大小），音频模式显示「音质（原始音轨）」；音视频同时下载时两个菜单分别生效。合集复用已有的首条视频采样请求取得音轨，翻页保留所选音轨。只有真实可用的源音轨会显示，默认「最高音质」，不提供凭空创建的码率档位。

`audioFormatId` 由主进程验证是否属于当前解析结果，再作为音频任务的 `format` 持久化；队列重新解析并确认音轨存在后传给本地引擎，缺失时记录提示并回落到最高音质。导出格式继续遵循设置里的 `audioFormat`：`best` 保留原始音轨，mp3/m4a/flac 是单独的转换设置；转码时不把原始文件大小当成导出大小。

以真实 Windows Electron 客户端解析 <https://b23.tv/uU1hUUC>，合集仍为 64 条、视频画质仍为 4 档；首条「娃娃脸【灰泽满Hazel】」（`BV1cyba6eEAv`）实际提供三档 M4A/AAC：`30280` 160.679 kbps、`30232` 122.981 kbps、`30216` 65.728 kbps。菜单显示「最高音质」与约 161 / 123 / 66 kbps 三档。

单条回归：`BV1bK411W797?p=3` 仍只解析 1 项，视频画质为 3 档，独立音轨为 AAC 约 177 / 133 / 67 kbps；通过当前客户端 `cli:parse` 验证，没有替换用户窗口的合集结果。

一次性 Playwright 探针在临时用户目录中，通过真实结果页的菜单选择音轨并点击「下载 1 个音频」；输出仅放在临时下载目录，`audioFormat=best`，关闭封面嵌入。没有向用户任务列表添加验证任务。

| 所选源音轨 | 真实文件 | 验证 |
| --- | --- | --- |
| `30216`，约 66 kbps | M4A，986,258 字节，120 秒，文件平均码率 65,750 bit/s | AAC、48 kHz、双声道；日志确认不转码，FFmpeg 完整解码退出 0；估算 985,920 字节，误差 0.034% |
| `30280`，约 161 kbps | M4A，2,410,527 字节，120 秒，文件平均码率 160,701 bit/s | AAC、48 kHz、双声道；日志确认不转码，FFmpeg 完整解码退出 0；估算 2,410,185 字节，误差 0.014% |

不存在于解析结果中的 `audioFormatId` 被主进程拒绝，未创建任务；renderer `pageerror` 为 0。`pnpm check` 通过（typecheck、lint、65 条现有单测通过 / 1 跳过、build）。一次性探针已删除，没有新增或修改测试用例。截图：`test-results/driver/audio-source-30216.png`、`test-results/driver/audio-source-30280.png`。

## 客户端实测结果（2026-10-13，全部任务滚动）

在用户正在运行的真实 Electron 窗口复现：任务外层 `Card` 在纵向 flex 容器里默认收缩，卡片实际高度 667 像素、内容高度超过 2200 像素；卡片自身的 `overflow-hidden` 裁掉任务，页面 `main` 的可视高度与内容高度均为 747 像素，即使设 `scrollTop=500` 也停在 0。

为 `src/App.tsx` 中任务页外层卡片增加 `shrink-0`，使其按任务内容撑开，由现有 `main overflow-auto` 滚动。这处布局由全部任务、下载中、已完成共用。

构建后仅重载原窗口 renderer，主进程与下载队列继续运行。一次性 Playwright 探针连接这个客户端自己的调试端口，使用真实鼠标滚轮验证当前 21 条任务；没有新增、删除或暂停任务，视图切换验证后恢复原设置，探针已删除。

| 视图 | 滚轮结果 | 滚到底部结果 |
| --- | --- | --- |
| 列表 | `scrollTop=600`；页面高 747、内容高 2274 像素 | `scrollTop=1527`，最后一条完整可见 |
| 卡片 | `scrollTop=600`；页面高 747、内容高 4561 像素 | `scrollTop=3814`，最后一条完整可见 |

`pnpm check` 通过（typecheck、lint、65 条现有单测通过 / 1 跳过、build）。没有新增或修改测试用例。截图：`test-results/driver/tasks-scroll-before.png`、`test-results/driver/tasks-scroll-list-bottom.png`、`test-results/driver/tasks-scroll-grid-bottom.png`。

## 客户端实测结果（2026-10-13，B 站分享短链所属合集）

修复前，<https://b23.tv/uU1hUUC> 只显示「暖暖【灰泽满Hazel】」单条视频。短链实际跳到 `BV1kwa86KEmG`，所属合集是「Hazel歌切」（season `8865032`，64 条）。Electron `session.fetch` 跟随跳转后 `Response.url` 为空，`redirect: manual` 又报 `Redirect was cancelled`，导致地址没有进入合集适配器；分享地址自动携带的 `p=1` 也被旧逻辑当成指定分 P，跳过合集。

现在通过客户端 `persist:media` 会话的 `net.request` 重定向事件读目标地址，最多追踪 10 跳，每次请求最多 15 秒，并响应解析取消；失败时仍回落到原地址。单 P 视频携带 `p=1` 时读取所属合集，真正的多 P 视频指定 `p=1` 或更高分 P 时仍只解析对应分 P。

验证使用运行中的真实 Windows 客户端命令行通道，以及项目 `run-electron-client/driver.mjs` 在临时用户目录启动的真实 Electron 窗口，只解析，不入队下载；一次性网络诊断脚本已删除，没有新增或修改测试用例。

| 链接 | 客户端结果 | 结论 |
| --- | --- | --- |
| <https://b23.tv/uU1hUUC> | `method=browser`、`listing=collection`，合集组「Hazel歌切」；三页分别 30、30、4 条，共 64 条，无重复，包含分享视频 `BV1kwa86KEmG`；窗口累计加载 30 → 60 → 64，末页 `hasMore=false`；首批 30 张封面全部加载成功；无 renderer `pageerror` | ✅ 短链与单 P 分享链接的所属合集可显示、翻页 |
| <https://www.bilibili.com/video/BV1bK411W797?p=1> | 1 项，无列表，标题含 `p01 Staple Stable/战场原+羽川` | ✅ 真正多 P 视频仍只解析指定的第一 P |
| <https://www.bilibili.com/video/BV1bK411W797?p=3> | 1 项，无列表，标题含 `p03 Ambivalent World/战场原+神原` | ✅ 更高分 P 的单条解析保持可用 |

`pnpm typecheck`、`pnpm lint`、`pnpm build` 通过；`pnpm test` 为 65 通过、1 跳过。`pnpm test:e2e` 仍因现有脚本等待旧按钮「下载所选 (1)」40 秒超时而失败，当前按钮是「下载 1 项」，未修改测试文件。结果页截图：`test-results/driver/bilibili-share-collection.png`、`test-results/driver/bilibili-share-collection-all.png`。

## 客户端实测结果（2026-10-10，B 站番剧 adapter 与 CI）

以 `bilibili-bangumi` adapter 为准。使用 `.agents/skills/run-electron-client/driver.mjs` 启动构建后的真实 Electron 客户端，在临时用户目录中匿名访问真实 B 站，通过 `media:parse` 解析并检查结果页封面；没有入队或下载。以下结果取代旧表中「番剧走引擎，客户端不另写解析」的路由约定。

| 链接 | 客户端结果 | 结论 |
| --- | --- | --- |
| <https://www.bilibili.com/bangumi/play/ss113506> | 《致不灭的你 第三季》，`method=browser`、`listing=collection`，8 集；首集「安稳的世界」，链接 `bangumi/play/ep2214939`；8 张封面均加载成功 | ✅ 新番剧 adapter 可用，单集下载仍交给本地引擎 |
| <https://www.bilibili.com/video/BV1bK411W797?p=3> | `method=direct`，1 项，无列表，标题含 `p03 Ambivalent World/战场原+神原` | ✅ 指定分 P 仍交给引擎，不展开全部分 P |

验证：`pnpm check` 通过（类型检查、lint、构建与 65 条 Vitest 用例）；Vitest 配置精确排除 1 条仍要求「番剧没有 adapter」的旧用例，原型阶段不修改测试文件。客户端探针无 renderer `pageerror`。

额外运行 `pnpm test:e2e` 未通过：旧脚本等待按钮「下载所选 (1)」超时，当前界面文案为「下载 1 项」。此 E2E 不在 GitHub `verify` 的 `pnpm check` 中，本次未修改该脚本。

额外运行 Markdown 检查未通过：`docs/requirements.md` 有 13 处、本文有 37 处格式问题；与本次修改前的 HEAD 对照，错误数量与内容相同，没有新增错误。

## 客户端实测结果（2026-09-23，requirements.md 里 ⚠️ 项的复测）

跑法：先 `pnpm test:live:links` 跑一遍下表的回归，再用一次性探针脚本（启动客户端，调 `media:parse` / `media:page`，跑完删掉）补测回归脚本里没有的地址。原型阶段不新增测试用例，结果只记在这里。抖音、哔哩哔哩、YouTube 一开始就已登录；X、Instagram、微博是当天在客户端的登录窗口里登录的，公众号也在登录窗口里过了一次验证，标「登录后」的行是登录之后跑的。

| 链接 | 客户端结果 | 结论 |
| --- | --- | --- |
| 抖音 `/collection/7331672245112965129` | 合集 6 条 | ✅ `douyinCollection` 直接链接可用 |
| 抖音 `/series?modal_id=7676329918745054500` 翻页 | 标题「嫌疑人的秘密」，6 页共 85 集，无重复 | ✅ 短剧集数列表就是合集（修改后标题取合集名） |
| 抖音 `/user/self` | 修改前列出「天爱Talk的作品」（别人）；修改后是本人作品 | ✅ 已修 |
| 抖音 `/user/self?showTab=recommend` | 修改前报「验证页面」；修改后推荐 16 条 | ✅ 已修（接口改为 `familiar/recommend/feed/`） |
| 抖音 他人主页 `?showTab=recommend` | 「对方没有公开推荐列表」 | ✅ 如实说明，网页上同样「推荐内容不可见」 |
| YouTube `@MrBeast/shorts` | 48 条，第 2 页 48 条全新 | ✅ |
| 公众号合集「守桥人」 | 8 篇 | ✅ |
| 公众号合集「枣法案例」 | 修改后连翻 3 页 30 篇无重复 | ✅ 翻页已修（原来第 2 页是空的） |
| 公众号两篇文章 | 在登录窗口里过了一次验证后都能打开：视频那篇 1 个视频，图片那篇 1 张图（修复后，原来收的是头像和引导图） | ✅ |
| Instagram 主页 / Reels 标签页（登录后） | 适配器重写后各连翻 3 页、每页 12 条全新，封面与链接各自正确 | ✅ 已修（改走 GraphQL） |
| Instagram 图文帖 `/p/DdUG_iuEf3E/` | 修改前：引擎没解出来，兜底嗅到 30 条同封面；修改后：单帖适配器列出 8 个文件，真实下载 7 张 JPEG + 1 段 mp4 | ✅ 已修 |
| X 时间线 `@FinanceYF5`（登录后） | 修改前：适配器放弃，兜底列出 16 条同一张默认封面；修改后：适配器改走 `UserMedia`（媒体标签页），3 页 13 / 14 / 10 条全不重复，每条有自己的封面与正文 | ✅ 已修 |
| X 图片帖（登录后） | 修改前：「页面没有提供可下载的媒体」；修改后：单帖适配器列出 2 张图，真实下载 2 张原图 JPEG | ✅ 已修 |
| 抖音短剧列表页 `/series` | 修改前：报「接口还没确认」；修改后：列出剧目，两页各 16 部无重复；整部剧入队《我成全儿媳丁克，她却后悔了》得 57 个任务、一个批次一个目录，真实下载 3 集 | ✅ 已实现 |
| X 主页里挑一条图片帖下载 | 入队后任务走单帖适配器重新解析，下到 1 张 PNG | ✅ |
| 短剧《嫌疑人的秘密》第 1 集（免费） | 从合集下载，落在「嫌疑人的秘密/」，54.63 秒，HEVC + AAC | ✅ 真实下载 |
| X 视频帖（登录后） | 走引擎，1 项 | ✅ |
| 微博主页（登录后） | 适配器列出 18 条，第 2 页 12 条全新 | ✅ 已修（补请求头） |

X 与微博这几条是用一次性的 Electron 入口跑的：直接加载构建好的主进程，通过主窗口的 `executeJavaScript` 调 `media:parse`，**不挂 Playwright**。用 Playwright 启动时页面里 `navigator.webdriver` 为 true、调试协议连着，登录态账号容易被判成自动化。

在 Chrome 里补测的（不经过客户端）：公众号音乐卡片是 `<mp-common-clmusic>` 元素，没有音频地址，取曲接口要微信会话，网页上拿不到，详见 requirements.md；短剧付费集的标记是 `charge_info` / `entertainment_video_paid_way.paid_type=1`，第 12 集起。

## 客户端实测结果（2026-09-22）

下面这张表是**把这些链接喂给真实客户端**跑出来的，不是在浏览器里点出来的。回归脚本是 `test/live/links.live.spec.ts`，跑法 `pnpm test:live:links`——它驱动真实的 Electron 客户端、用真实的用户数据目录（因此能看到你在 设置 → 浏览器 里登过的账号），**只解析，不入队也不下载**。

脚本里分两类：能断言的写成断言（哔哩哔哩的接口匿名可用，地址改写在任何网络请求之前发生），依赖登录的只打印结果——"抖音拒绝了一个陌生人"是一个结果，不是代码的失败。

本次运行时客户端的登录态：抖音、哔哩哔哩、YouTube **已登录**；微信公众号、X、Instagram、微博 **未登录**。

| 链接 | 客户端结果 | 结论 |
| --- | --- | --- |
| B站 BV1bK411W797 | 分P 23 条 | ✅ |
| B站 BV1uT4y1P7CX | 分P 2 条 | ✅ |
| B站 BV1xx411c7mD | 不是列表、1 项、走引擎 | ✅ 放弃并回落 |
| B站 lists/8566628 | 合集 18 条，标题「合集·喵喵网络狠人2.0」 | ✅ 不再列出全部投稿 |
| B站 lists/4940048 | 合集 3 条，标题「合集·少女乐队」 | ✅ |
| B站 BV1Ps421u7ju / BV11dbH6LEm2 | 展开 `ugc_season`，3 条 / 18 条 | ✅ |
| B站 space/242020511 | 投稿 40/1224 | ✅ 主页仍是主页 |
| B站 bangumi ss113506 | 走引擎，8 话 | ✅ 番剧不另写解析 |
| 抖音 `/series?modal_id=…` | 改写成 `/video/<id>`，并展开合集 14 条「大马猴剧场的合集」 | ✅ 短剧链接形态 + 合集都通 |
| 抖音 `v.douyin.com` 短链 | 跟随重定向后解析出该集 | ✅ |
| 抖音 `/video/7331258875343113512` | 展开所属合集 6 条「差评硬件部的合集」 | ✅ `aweme/detail` → `mix_info` → `mix/aweme` 全通 |
| 抖音 用户主页 | 「小糊涂蝶的作品」19 条 | ✅ |
| 抖音 用户主页 `?showTab=like` | 「成都第二可爱🥭的**喜欢**」16 条 | ✅ **作者与作品页不同**，证明 `favorite/` 接口与 tab 分流真的生效 |
| 抖音 `/series`（无 modal_id） | 报「接口还没确认，请用某一集的分享链接」 | ✅ 如实说明，不含糊失败 |
| YouTube @MrBeast | 频道 30 条 | ✅ |
| YouTube Shorts 单条 | 1 项 | ✅ |
| YouTube 播放列表 | 5 项，无截断标记 | ✅ |
| YouTube Mix | 100 项，**标记截断于 100** | ✅ 不再静默截断 |
| 公众号 两篇文章 | 客户端会话被转到 `wappoc_appmsgcaptcha` 验证页 | ⚠️ 见下 |
| X 单条视频帖 | 走引擎，1 项 | ✅ |
| X 单条图片帖 / 用户时间线 | 未登录，分别报「没有可下载媒体」与「没有请求令牌，通常是还没登录」 | ⚠️ 待登录后复测 |
| Instagram Reels 单条 | 走引擎，1 项 | ✅ |
| Instagram 帖子 / 用户主页 | 未登录，报需要登录 | ⚠️ 待登录后复测 |
| 微博 单条 | 走引擎，1 项 | ✅ |
| 微博 用户主页 | **新适配器放弃**（匿名请求被 302 到 `passport.weibo.com`），**引擎接手列出 100 条** | ⚠️ 见下 |

**公众号文章**：客户端自己的会话被微信风控转到验证页，文章根本没渲染，所以文章里的图片/音乐/视频采集**在客户端里没被执行到**。错误信息已改成如实说明是「转到了验证页面」，而不是原来的「页面没有提供可下载的媒体」——后者对验证页是对的，对文章什么也没说。

采集脚本本身**单独验证过**：把客户端构建产物里的 `mediaScript` 取出来，在一个普通 Chromium 里对这两篇真实文章跑了一遍——
- `…/s/kgrMPE4Sl6oXVTYGKCnzdQ`：标题正确，**图片 5 张**（`mmbiz.qpic.cn`），无视频。
- `…/s/OHPkIAjecIO-AH8jicfXKQ`：标题正确，**图片 5 张 + 视频 1 条 `mpvideo.qpic.cn/….f10002.mp4`**，与本文下方记录的实测结论一致。
- **音乐卡片仍未验证**：这两篇在运行时只有 1 个子框架（`open.weixin.qq.com/pcopensdk/frame`），里面没有媒体。跨框架采集的代码写了，但没有在一张真实的音乐卡片上验证过。

**微博主页**：匿名调 `ajax/statuses/mymblog` 会 302 到访客通行证页，于是新适配器按设计「放弃」，地址交回引擎——**而 yt-dlp 自己就能列出用户主页（本次 100 条）**。所以微博主页在用户那里是能用的，只是走的不是新适配器；新适配器要等登录态下才能验。这也意味着值得重新考虑微博适配器还有没有必要。


## 哔哩哔哩

| 内容形态 | 链接 | 用途 | 状态 |
| --- | --- | --- | --- |
| 分P（主样本） | https://www.bilibili.com/video/BV1bK411W797 | 23 个分P，`part` 名齐全 | 已验证 |
| 分P（规模样本） | https://www.bilibili.com/video/BV1h54y1B7J4 | 82 个分P | 已验证 |
| 分P（小样本） | https://www.bilibili.com/video/BV1uT4y1P7CX | 2 个分P | 已验证 |
| 单P 反例 | https://www.bilibili.com/video/BV1xx411c7mD | 验证"放弃并回落" | 已验证 |
| 合集 | https://space.bilibili.com/3494376638516086/lists/8566628?type=season | 18 集，喵喵网络狠人2.0 | 已验证 |
| 合集 | https://space.bilibili.com/339087866/lists/4940048?type=season | 3 集，少女乐队 | 已验证 |
| 合集对应视频页 | https://www.bilibili.com/video/BV11dbH6LEm2 | 验证 `ugc_season` 展开 | 已验证 |
| 合集对应视频页 | https://www.bilibili.com/video/BV1Ps421u7ju | 同上 | 已验证 |
| 专栏 | — | 已决定不做 | 不做 |
| 收藏夹 | — | 已决定不做 | 不做 |
| 追番追剧 | https://www.bilibili.com/bangumi/play/ss113506 | 《致不灭的你 第三季》番剧播放页，第一话为 `BV1Lsn1zxEem` | 已验证 |

## 抖音

| 内容形态 | 链接 | 用途 | 状态 |
| --- | --- | --- | --- |
| 单条视频 | https://www.douyin.com/video/7331258875343113512 | 属于合集的作品 | 已验证（客户端实测展开合集 6 条） |
| 单条视频 | https://www.douyin.com/video/7642260730959514934 | 第二个合集样本 | 已打开，内容未核 |
| 用户主页 | https://www.douyin.com/user/MS4wLjABAAAAiDM_L0EfQosQEKfhAPkrFau6cBPMtNu1d3E2em0hzUZ6I1VGFH5oS6NuV4cfsd2o | 验证作品列表与翻页 | 已打开 |
| 用户主页（喜欢） | https://www.douyin.com/user/MS4wLjABAAAAiDM_L0EfQosQEKfhAPkrFau6cBPMtNu1d3E2em0hzUZ6I1VGFH5oS6NuV4cfsd2o?from_tab_name=main&showSubTab=playlet&showTab=like | 验证 `showTab` 分流 | 已验证（客户端实测列出的是喜欢，作者与作品页不同） |
| 合集链接 | https://www.douyin.com/collection/7331672245112965129 | 「Apple Vision Pro」6 条，上面那条作品所属的合集 | 已验证 |
| 我的主页 | https://www.douyin.com/user/self | 列出的必须是登录账号本人 | 已验证 |
| **短剧付费集** | https://www.douyin.com/video/7676330186320678150 | 《嫌疑人的秘密》第 12 集，第一个付费集 | 已打开，下载未测 |
| **短剧入口（列表页）** | https://www.douyin.com/series | 短剧列表页，含分类与剧目；无 `modal_id` 时就是列表 | 已验证 |
| **短剧分享短链** | 自己复制的 `v.douyin.com/…` 链接 | 短链跳转后带着分享者的 `u_code`、设备与安装标识，不放进仓库；回归脚本从环境变量 `LIVE_DOUYIN_SHARE_LINK` 读取，没设置就跳过 | 已验证 |
| **短剧解析后地址** | https://www.douyin.com/series?modal_id=7676329918745054500 | 上一条短链的落地地址，《嫌疑人的秘密》第 2 集，@大马猴剧场，可选 1080P | 已验证 |

**抖音短剧的链接形态与剧集清单（实测）**：

- 分享出来的是 `v.douyin.com` 短链，解析后落地为 `douyin.com/series?modal_id=<id>`。**路径是 `/series`，内容 ID 在查询参数 `modal_id` 里**——与其它平台"ID 在路径里"不同，解析分流要单独认这个形态。
- `modal_id` 指向**某一集**而非整部剧。点开列表页里的剧目卡片是页内弹层播放、地址不变——**只有走"分享"才能拿到带 `modal_id` 的链接**。
- **集数清单可以枚举**：弹层右侧"短剧"标签里有完整剧集列表（每项含集数、时长、播放量），虚拟化渲染、滚动加载。
- **付费是常态**：实测《嫌疑人的秘密》87 集、"含 77 集付费"——前 11 集免费，第 12 集起每集都带"付费"标记。

## 微信公众号

| 内容形态 | 链接 | 用途 | 状态 |
| --- | --- | --- | --- |
| 图片 + 音乐卡片 | https://mp.weixin.qq.com/s/kgrMPE4Sl6oXVTYGKCnzdQ | 音乐卡片是 `<mp-common-clmusic>` 元素（不是 iframe），没有音频地址，网页上取不到；正文里只有 1 张内容图 | 已验证 |
| 视频 | https://mp.weixin.qq.com/s/OHPkIAjecIO-AH8jicfXKQ | 视频是运行时注入的原生 `<video>`，实际媒体为 `mpvideo.qpic.cn/…mp4` 直链 | 已验证 |
| 语音 | — | 还没遇到带 `<mpvoice>` 的文章 | 待补 |
| 合集（小） | https://mp.weixin.qq.com/mp/appmsgalbum?__biz=MzI3OTM1OTgwMQ%3D%3D&action=getalbum&album_id=4605122105674661897 | 「守桥人」8 篇，一页装完 | 已验证 |
| 合集（翻页） | https://mp.weixin.qq.com/mp/appmsgalbum?__biz=MjM5OTk3NDAyOQ%3D%3D&action=getalbum&album_id=2579133734549946369 | 「枣法案例」65 篇，验证游标翻页 | 已验证 |

## YouTube

| 内容形态 | 链接 | 用途 | 状态 |
| --- | --- | --- | --- |
| 频道（主页批量） | https://www.youtube.com/@MrBeast | 频道列表 | 已验证 |
| Shorts | https://www.youtube.com/shorts/T_SMf9j50uc | 短视频形态单条 | 已验证 |
| 频道 Shorts 标签页 | https://www.youtube.com/@MrBeast/shorts | Shorts 的主页批量 | 已验证 |
| 普通播放列表 | https://www.youtube.com/watch?v=oBeBVjOBZPs&list=PLZOc7e59B5BY | 5 条，标题时长齐全 | 已验证 |
| Mix（电台） | https://www.youtube.com/watch?v=l54zu9rjpYc&list=RDl54zu9rjpYc&start_radio=1 | 验证 100 条静默截断 | 已验证 |
| 频道 RSS feed | https://www.youtube.com/feeds/videos.xml?channel_id=UCX6OQ3DkcsbYNE6H8uQQuVA | 唯一有官方 feed 的平台 | 已验证 |
| 节目 | — | 已决定不做 | 不做 |
| 帖子（社区） | — | 已决定不做 | 不做 |

## X

| 内容形态 | 链接 | 用途 | 状态 |
| --- | --- | --- | --- |
| 单条帖子（图片） | https://x.com/Russell3402/status/2101991269291741588 | 图片帖，详情页实测可打开 | 已验证 |
| 单条帖子（视频） | https://x.com/FinanceYF5/status/2101585391140905034 | 视频帖，详情页实测可打开 | 已验证 |

X 的视频与图片两种帖子形态都有了样本，链接由使用者提供并确认。

**拿 permalink 的方式**：X 的帖子链接在页面无障碍树里不暴露 href，点时间线里的卡片跳的是媒体页（实测 `/elonmusk/photo`）而不是帖子详情。上面两条是人工用「分享 → 复制链接」拿到的。链接尾部的 `?s=20` 是分享来源参数，可剥掉。

## Instagram

| 内容形态 | 链接 | 用途 | 状态 |
| --- | --- | --- | --- |
| Reels | https://www.instagram.com/reel/DdcI4o0Prsz/ | 短视频形态单条 | 已验证 |
| 帖子 | https://www.instagram.com/p/DdUG_iuEf3E/ | 单条帖子（图文或视频待核） | 已验证 |
| 用户主页 | https://www.instagram.com/instagram/ | 官方账号，主页批量样本 | 已打开 |
| Reels 标签页 | https://www.instagram.com/instagram/reels/ | Reels 的主页批量（`clips/user`） | 已打开，要登录 |

注意：分享复制出来的链接带着 `?utm_source=ig_web_copy_link&stkn=…` 一类跟踪参数，上面已剥掉；解析时要像剥 X 的 `?s=20` 一样处理这些尾参。

**同样的问题**：Reels 网格的条目在无障碍树里也不暴露 href，是点开第一条后从标签地址里拿到的。

## 微博

| 内容形态 | 链接 | 用途 | 状态 |
| --- | --- | --- | --- |
| 单条微博 | https://weibo.com/7285442599/RixTsFiDJ | 微博正文详情页，实测可打开 | 已验证 |
| 头条文章 | — | 已决定不做 | 不做 |
| 超话 | — | 已决定不做 | 不做 |

链接打开后落在"微博正文"详情页（`weibo.com/<uid>/<bid>` 形式）。微博同样存在"点卡片不改地址"的问题，permalink 要用分享菜单复制。

## 2026-10-12：origin/main 合并验证与功能分支对比

合并来源为 `origin/main`（`316527d`），合并前本地 `main` 为 `e7d9507`，备份分支为 `backup/main-before-origin-merge`。两段历史没有共同祖先；采用远端当前实现，并移除远端已删除而无共同祖先合并留下的 16 个旧文件。追加本节前，暂存树与 `origin/main` 完全一致。

本次在 Windows、Node 24.0.2、pnpm 11.8.0 下从仓库根目录执行验证；当前独立仓库没有 `electron-client/` 子目录。没有新增或修改测试用例，窗口补充验证使用一次性探测代码和现有 Electron driver。

| 验证 | 本次结果 |
| --- | --- |
| `pnpm install --frozen-lockfile` / `pnpm engine:dev` | 通过；Electron 二进制下载完成后再执行测试 |
| `pnpm typecheck` / `pnpm lint` / `pnpm build` | 通过；构建保留现有大于 500 kB 的 chunk 提示 |
| `pnpm test` | 10 个文件通过，65 项通过、1 项跳过；跳过项来自现有 `vitest.config.ts` 对旧番剧行为用例的过滤 |
| 既有 E2E | 未通过：仍查找旧按钮名「下载所选 (1)」，当前界面为「下载 1 项」，点击等待 40 秒后超时；遵守原型阶段约束，保留既有用例 |
| 真实 Electron 本地下载 | 临时目录运行，使用真实 FFmpeg 生成视频、本地 HTTP 服务和实际 UI 解析下载；点击「下载 1 项」后完成，12360 字节与源文件一致；重启后保留 1 个已完成任务和 1 条解析历史 |
| 渲染隔离 | `window.require` 与 `window.ipcRenderer` 均为 `undefined`；下载探测和 driver 未发现渲染错误 |
| YouTube 主页 `https://www.youtube.com/@Fatcat996` | 新建临时客户端数据目录、浏览器路线解析 30 项，30 项有封面；首张封面在渲染窗口成功加载；第二页追加后为 60 项，其中 30 项为新内容 |
| B 站主页 `https://space.bilibili.com/242020511` | 本次收到验证页面，客户端返回 `needs-login` 并提示打开验证页面；未确认列表和第二页可用 |

### `feat/embedded-browser-shadcn-bilibili` 是否需要合并

结论：不需要再合并其代码。该分支只有 `c068890` 一个功能提交；相对其父提交 `e7d9507` 改动 97 个文件。对照 `origin/main` 的文件内容：57 个完全相同，32 个已有后续修改，6 个删除在两边一致。剩余两项是旧 `ResultCardHeader.tsx` 已在远端删除、功能分支曾删除的 `dialog.tsx` 已被远端以 Base UI 实现重新引入。

| 功能分支内容 | 远端当前实现及处理结论 |
| --- | --- |
| 应用内浏览器登录与解析 | `electron/services/browser.ts` 保留 `persist:media` 独立会话及 sandbox/contextIsolation，禁用 nodeIntegration；远端继续扩展验证、预览和平台适配 |
| shadcn / Base UI 界面 | 大部分 UI 原语和技能文件与功能分支完全一致；远端结果和任务界面已有后续演进 |
| B 站签名与分页 | `listings/wbi.ts` 完全一致；B 站适配器已扩展设备描述、合集、分P 和番剧，结果按分组加载更多；无需恢复旧页码跳转 |
| 旧通用主页抓取与代理配置 | 远端改为明确的平台适配器，小红书主页主动拒绝；代理设置按既有需求移除，见 `docs/listing-and-identity.md` 第 2.4、6 节与 `docs/requirements.md`，不从旧分支恢复 |
| 测试与文档 | 远端已有对应内容和后续更新；旧 E2E 的按钮名称问题已单独记录，不以合并旧分支方式处理 |

远端还包含双语界面、CLI、解析历史、媒体预览、批次管理、字幕与封面处理等后续改动。功能分支保留不动；Git 会继续显示其历史尚未合入，但这不代表其功能缺失。


## 2026-10-13：可配置软字幕、硬字幕与中英双语

实现入口：设置 → 文件与媒体 → 字幕；解析结果下载区域可临时覆盖字幕模式和语言。任务保存所选配置，下载覆盖不会修改默认设置。软字幕和硬字幕均输出 MP4；独立文件与关闭模式保留平台原媒体容器。

### 本地完整链路与打包引擎验证

使用临时 Playwright `_electron` 探针操作真实构建后的客户端，访问本机 HTTP 字幕页面，走实际解析器 → 队列 → yt-dlp → FFmpeg，未替换 IPC、解析器、下载器或 FFmpeg。临时页面提供 6 秒 VP9/Opus 视频与两份时间边界不一致的中英文 VTT（中文 0–1.5、1.5–4、4–6 秒；英文 0–2.5、2.5–6 秒）。另运行 `pnpm engine:build`，客户端自动使用 `resources/engine/media-engine.exe` 和打包字体完成验证。探针脚本执行后删除，没有新增或修改测试规格。

| 检查 | 结果 |
| --- | --- |
| 设置默认模式/语言、下载时覆盖 | 设置保存硬字幕/英文，下载区域选择软字幕/双语；入队任务使用覆盖值，默认设置保持不变 |
| 软字幕 × 英文、中文、中英双语 | 三种均完成；视频保留 VP9，音频由 Opus 转为 AAC；字幕为 mov_text |
| 双语软字幕轨道 | 中文（zho）、英文（eng）、中文 + English 三轨，双语轨 default；不是两条语言轨要求播放器同时开启 |
| 软字幕不重编码视频 | 提取原 WebM 与软字幕 MP4 的视频包数据 SHA-256 均为 `28ce06c7b5488be350588ac1a6a18b341abd4d79998c7fbd1e3a2eef5cdf087b` |
| 硬字幕 × 英文、中文、中英双语 | 三种均完成；H.264/AAC MP4，无可关闭字幕轨；抽帧目视确认白字黑描边、中文无方框、中文在上英文在下 |
| 双语对齐 | 生成 0–1.5、1.5–2.5、2.5–4、4–6 秒四段，按时间边界组合文本 |
| 独立双语字幕 | 原 WebM + 中文、英文、双语三份 SRT，文件列表记录全部产物 |
| 关闭字幕 | 原 WebM，不生成字幕或执行字幕合成 |
| 缺少中文、全部无字幕 | 分别使用英文烧录、输出无字幕 MP4；任务完成并展示对应提示 |
| 字幕 CDN 返回 403 | 页面仍列出字幕，但字幕下载被拒绝；视频仍保存为无字幕 MP4，任务提示字幕缺失 |
| 阶段与进度 | 实际收到 download、subtitles、embed、burn、convert 阶段；后处理独立显示进度，结束后任务 completed |
| 重启持久化 | 重启后保留 11 条完成任务及硬字幕/英文默认配置；没有 renderer pageerror |
| 字体缺失失败与重试 | 单独使用真实后处理器使字体目录不可用：失败保留视频和 SRT；恢复字体目录后同素材成功合成；路径含中文和单引号可处理 |
| MP4 不支持源编码 | VP8 素材首次复制封装失败后自动转 H.264，MP4 成功保存 |
| 语言选择 | 人工 en-US 优先于自动 en；中文只取 zh-Hans 一条，不下载全部翻译轨；这是本地选择器探针，不是 YouTube 在线实测 |

本机证据保存在忽略的 `test-results/subtitles/`：`summary.json`、`settings.png`、`download-options.png`、`completed.png`、`bilingual-frame.png`、`output/`；网络尝试另存 `youtube-network.json`。

### 真实 YouTube 与检查限制

真实地址：`https://www.youtube.com/watch?v=jNQXAC9IVRw`。本机 Python 引擎网页/API 请求均返回 `[SSL: UNEXPECTED_EOF_WHILE_READING] EOF occurred in violation of protocol`。真实 Electron 客户端同地址解析 35 秒未完成后主动取消；本机旧代理地址 127.0.0.1:7897 没有监听。没有更改系统代理设置。因此 YouTube 在线字幕/自动翻译获取仍未验证，本地合成验证不能替代真实 YouTube 验证；网络恢复后应以有人工英文字幕、自动字幕、中文字幕/平台翻译字幕的视频分别复验。

`pnpm typecheck`、`pnpm test`、`pnpm build`、`pnpm engine:build` 通过；Vitest 65 项通过、1 项跳过。首次 `pnpm lint` 通过；末次检查时另一个并行工作留下的未跟踪 `.probe-audio.mjs` 触发 window/setTimeout 的 no-undef，未改动该探针，使用 `pnpm lint --ignore-pattern .probe-audio.mjs` 检查源码通过。`pnpm test:e2e` 仍在原有 `下载所选 (1)` 按钮选择器等待 40 秒后失败，当前真实按钮为 `下载 1 项`；按原型约束未修改测试，临时真实客户端探针使用当前按钮完成上述验证。构建仅有现存 bundle 大小提示。


## 2026-10-13 18:42：YouTube 媒体 403 原任务修复与双语实测

用户链接：`https://www.youtube.com/watch?v=m53ysyhjDJs`，标题 `How Kaz Nejatian Is Rebuilding Opendoor`。原任务 `3e1ddfb8-0816-4988-813d-a0e53c2f1656` 已取得中英文字幕，但媒体格式 `399+251-20` 每次立即返回 `unable to download video data: HTTP Error 403: Forbidden`，20/60 秒的自动续传始终重复同一失败。

定位证据：读取原任务日志，连接正在运行的客户端（其自身 Electron 的调试端口，不连接外部 Chrome），观察主进程传给引擎的实际参数。原请求来自客户端 persist:media 的 7 个访客 cookie，没有 Google/YouTube 登录 cookie，没有 Authorization。原样重放仍返回 403；匿名请求同一画质/音轨完整成功。携带访客会话时，1 KiB 范围请求可能得到 206，但实际大分段请求可返回 403，不能把小范围 HEAD/GET 成功当作可下载证明。本文不能据此确定 YouTube 内部具体是哪种风控规则或某一个 cookie 导致拒绝。

修复：`engine/main.py` 将下载器初始化与后处理挂接复用。只有 YouTube/youtu.be、下载视频数据的 HTTP 403、请求携带浏览器身份且没有登录 cookie/Authorization 时，立即建立新的匿名下载器重新解析并重试一次。只移除本次引擎调用的浏览器 cookie/profile，不修改 Chromium 的 persist:media、外部浏览器数据或用户设置；保持原格式选择、质量上限、音轨、字幕、输出命名及续传配置。登录/会员内容的授权会话不走匿名回退。失败仍交给原队列错误与续传机制处理。

实际通过原客户端的“重试”操作完成，不手工修改 state.json、不把独立探针的文件伪装成完成任务。18:41:22 原媒体请求再次 403 后，日志出现 `YouTube 媒体请求返回 403，使用匿名会话重新解析并重试。`；匿名会话下载 139.99 MiB 视频与 21.23 MiB 原音轨，使用原来已下载的中英文字幕，18:42:47 任务进入 completed，warnings 为空。

| 产物检查 | 实际结果 |
| --- | --- |
| 文件 | `C:/Users/40417/Downloads/How Kaz Nejatian Is Rebuilding Opendoor-3e1ddfb8.mp4` |
| 文件大小 | 188,768,302 字节（约 180.0 MiB） |
| 时长、分辨率 | 00:28:33.31，1920×1080，24 fps |
| 视频/音频 | 保留 AV1 视频，AAC 192 kbps、48 kHz、双声道 |
| 字幕 | 中文、English、中文 + English 三条 mov_text；双语轨 default |
| 双语正文 | 从 MP4 导出双语轨，确认同一 cue 中中文在前、英文在后；不依赖外置 SRT |
| 完整性 | FFmpeg 解码最后 3 秒音视频（1710 秒开始），退出码 0，无解码错误 |
| 队列 | 原任务 completed、文件路径记录正确、无字幕警告 |

没有新增或修改测试规格。诊断脚本已删除；脱敏原任务结果和导出的字幕证据位于忽略的 `test-results/youtube-403/client-retry.json`、`actual-bilingual.srt`。此结果补足前一节 YouTube 网络验证限制；早先 `jNQXAC9IVRw` 的 TLS 失败不应与本次媒体 403 混为一谈。

本次修复后 `pnpm typecheck`、`pnpm lint`、`pnpm test`、`pnpm build`、`pnpm engine:build` 均通过；Vitest 65 项通过、1 项跳过。现有 E2E 的旧按钮选择器问题仍按前文记录，本次未修改测试。


## 2026-10-14：真实 YouTube 双语硬字幕 1 分钟效果验证

来源仍为 `https://www.youtube.com/watch?v=m53ysyhjDJs`。临时 `_electron` 探针启动真实用户目录的客户端，在实际窗口选择「硬字幕（固定显示）」+「中英双语」并点击「下载 1 项」，新任务 ID `3c4ee3ad-94f6-4591-934f-3cb410e53394`。默认设置保持软字幕/双语。再次遇到访客媒体 403 后，引擎匿名回退成功；139.99 MiB 视频、21.23 MiB 原音轨和中英文字幕均已从真实站点下载，进入 burn 阶段。

用户随后明确只烧录 1 分钟，因此通过客户端暂停完整的 28 分钟任务，保留原素材与字幕。将这次真实下载的 MKV 前 60 秒无损裁剪，在临时探针中调用生产实现 `SubtitleProcessor`，采用与客户端下载相同的硬字幕处理器、Noto Sans CJK SC、CRF 20 / medium、中文在上英文在下；没有用图片文字覆盖模拟效果。此预览是离线处理刚刚真实下载的素材，完整任务仍为 paused，未伪造 completed 状态。

| 检查 | 结果 |
| --- | --- |
| 文件 | `C:/Users/40417/Downloads/How Kaz Nejatian Is Rebuilding Opendoor-双语硬字幕-1分钟-3c4ee3ad.mp4` |
| 时长/画面 | 00:01:00.00，1920×1080，24 fps |
| 编码 | H.264 High、yuv420p，AAC 48 kHz 双声道 |
| 文件大小 | 19,098,152 字节，约 18.2 MiB |
| 硬字幕确认 | 容器只有视频和音频，没有字幕轨；20 秒、45 秒直接从视频抽帧，均有中文在上、英文在下的白字黑描边字幕，中文字体正常 |
| 完整解码 | 对全部 60 秒音视频执行 FFmpeg `-f null -`，退出码 0，无解码错误 |
| 合成耗时 | 77.7 秒，无字幕警告 |
| 原任务/设置 | 完整任务 paused；默认字幕模式 embed、语言 bilingual 保持不变 |

证据在忽略的 `test-results/hard-youtube/minute/summary.json`、`frame-20s.png`、`frame-45s.png`，下载配置截图在 `test-results/hard-youtube/options.png`。临时 Node/Python 探针执行后删除，没有新增或修改测试规格，也没有更改产品代码。此检查验证真实素材的单语言/双语生产处理链中的双语硬字幕效果，不等同于完整 28 分钟硬字幕产物验收。


## 2026-10-14：B 站固定字幕样式参考下载与观察（方案阶段）

用户提供 `https://www.bilibili.com/video/BV11ipB6rEho/` 并确认字幕样式固定，允许使用 downloader 下载查看；仍要求开始实现前不生成产品代码。本次仅下载、抽帧观察与记录，没有修改字幕实现或测试规格。

通过 Galaxy Downloader 本地 CLI/控制通道解析。此视频属于 869 条目的合集，指定 BV 号位于第 29 页第 29 条；准确按 `BV11ipB6rEho` 选择这一条，字幕模式临时设为 off，以保存参考原画面。任务 `9f6fbd27-478c-493e-bfa1-3d59432babfb` 于 09:46:21 completed，下载器实际合并 `30080+30280`。

产物：`C:/Users/40417/Downloads/心理·情感·人文健康/[附文稿] 关于锻炼，你被灌输的最大谎言（请改做这个） _ 香农·里奇博士-9f6fbd27.mp4`，274,272,783 字节，00:47:25.68，1920×1080、29.97 fps，H.264/AAC。没有独立字幕轨，但直接从视频抽帧可见双语字幕，确认参考为画面内的硬字幕。

检查 15、45、120、900、1800 秒五个时间点，证据为忽略的 `test-results/subtitle-reference/frame-*.png` 和 `summary.json`。共同外观：中文在上、英文在下；两种语言均为大号粗体无衬线白字；深色较厚描边，并有轻微偏移阴影；字幕在底部居中，位置稳定、行间紧凑、长句保留明显的大字号。仅凭编码后的视频不能确认作者使用的具体字体文件。

方案结论（待实现）：固定为这一套样式，不增加字号、描边、间距或位置配置项；两种语言分别控制字重/字号/行位置，随输出分辨率等比缩放。以后仍以相同的 1 分钟素材对比参考帧校准。此次没有实施这些样式调整。

运行恢复说明：此前保留的临时 Electron 实例出现 console EPIPE，造成 CLI 请求异常等待；恢复测试实例后正常完成下载，结束时通过 driver quit 正常关闭，以避免悬空的输出管道再次产生错误。任务、登录数据与用户默认设置保留。

## 2026-10-14：固定参考硬字幕样式实现与验证

用户授权实现后，硬字幕固定为参考视频的近似样式：Noto Sans CJK SC Bold、白字、深色描边 3、半透明轻微阴影 1.5、底部居中、留白 80。以画面短边 1080 为基准，中文 ASS 字号 64、英文 60；两种语言按各自时间边界进入同一排版块，中文在上、英文在下。单语言在底部显示，双语暂时缺一行时保留行位。没有添加字号、字体、位置等 UI 设置。

当前 FFmpeg 的 libass 对没有空格的中文不会自动折行，因此按固定字体的保守宽度加入中文断行及超长单词断行，再交给 libass 排版。检查了英文、中文、双语、临时缺行、长句、720p、1080×1920 竖屏和 ASS 命令文本转义的实际渲染；长句字号保持固定，两种语言分开排版，检查帧无重叠或边缘裁切。字体日志确认使用打包的 `NotoSansCJKsc-Bold`，并非系统合成粗体。编码后的参考视频无法证明其原始字体，因此不声称字体完全相同。

| 验证 | 实际结果 |
| --- | --- |
| 1 分钟样片来源 | 原 YouTube 任务 `3c4ee3ad-94f6-4591-934f-3cb410e53394` 的真实素材，裁剪前 60 秒，通过生产 `SubtitleProcessor` 处理 |
| 样片 | `C:/Users/40417/Downloads/How Kaz Nejatian Is Rebuilding Opendoor-双语硬字幕-固定样式-1分钟.mp4` |
| 产物 | 00:01:00.00、1920×1080、24 fps、H.264 High / yuv420p、AAC 48 kHz 双声道；19,111,557 字节，约 18.2 MiB |
| 完整性和外观 | 全部 60 秒完整解码退出码 0；20 / 45 秒直接从最终 MP4 抽帧可见双语粗体白字、描边阴影；只有音视频轨，无独立字幕轨 |
| 处理耗时 | 合成加完整解码 83.9 秒，无字幕警告 |
| 真实客户端在线下载 | `_electron` 启动真实用户目录，通过客户端 `media:parse` / `media:download` 下载 `https://www.youtube.com/watch?v=jNQXAC9IVRw`，指定 burn / bilingual |
| 在线任务结果 | `df2f947d-62a5-4df3-97a3-28f57f89cb85` 于 10:17:40 completed；中文和英文字幕均成功下载并烧录，warnings 为空；最终 `Me at the zoo-df2f947d.mp4` 完整解码通过，6 秒抽帧可见固定双语样式 |
| 设置与原任务 | 默认配置仍为 embed / bilingual；28 分钟原任务仍 paused，没有把样片伪装成完整下载任务；renderer pageerror 为空 |
| 软字幕回归 | 对同一真实视频的完整中英 SRT 再执行时间轴合并，与此前保存的双语 SRT 逐条比较相同 |
| 字体打包 | 引擎构建成功，源目录和 `resources/engine/fonts/` 中 Bold 字体 SHA256 一致；打包引擎 version 请求成功。未重新生成完整安装包 |

`pnpm typecheck`、`pnpm lint`、`pnpm build`、`pnpm engine:build` 通过。`pnpm test` 首次在并行编码/构建期间出现已有 `test/pace.test.ts` 计时断言失败；单独重跑 65 项通过、1 项跳过。`pnpm test:e2e` 重现已有 `下载所选 (1)` 旧按钮选择器的 40 秒等待失败，按原型要求未修改测试。实际客户端在线下载已完成上述验证。

证据位于忽略的 `test-results/hard-youtube/fixed-style/`：`summary.json`、`client-job.json`、`encoded-frame-20s.png`、`encoded-frame-45s.png`、`real-client-frame.png`、`layout-*.png`；客户端截图为 `test-results/driver/fixed-subtitles-completed.png`。Playwright 会清空其整个 test-results 输出目录，因此本次最终抽帧证据在 E2E 运行后重新生成；下载目录中的用户样片和原素材保持完整。临时样式探针已删除，没有新增或修改测试规格。

## 2026-10-14：长字幕分页、烧录恢复说明与预计时间

用户授权增加三项：超长字幕分段、明确烧录中断后从头重新合成、显示烧录预计剩余时间。没有新增或修改 Vitest / Playwright / live 测试规格；使用临时探针调用生产处理器并驱动真实 Electron 用户目录，完成后删除探针。

**长字幕**：每种语言最多显示两行，双语最多四行。每条源字幕先按固定字号换行，再将超出的行按正文长度分配到原 cue 的时间范围；随后合并语言时间边界，避免另一种语言换句时让长句重新分页。源字幕重叠时再限制合并后的显示行数。ASS 采用明确换行，保持固定字号；短到无法用 ASS 的厘秒精度安排全部段落时明确失败并保留素材。

将真实 YouTube 字幕前 30 条连成 20 秒的长段落作为压力输入：1920×1080 下中文 6 页、英文 8 页；1080×1920 下中文 11 页、英文 15 页。验证分页前后非空白正文完全相同，首尾时间保持 0 / 20000 ms，各页连续、每种语言最多两行；再使英文每两秒换句，验证中文分页顺序没有重复或漏字。横竖屏在 2 / 9 / 17 秒实际用 FFmpeg / libass 渲染，最多四行，无画面边缘裁切或两种语言重叠。这是压力探针输入，不代表原视频存在这样的超长 cue；分段不改变平台字幕的翻译质量。

**1 分钟真实素材**：对原任务 `3c4ee3ad-94f6-4591-934f-3cb410e53394` 的真实 MKV 前 60 秒调用生产 `SubtitleProcessor`。生成 `C:/Users/40417/Downloads/How Kaz Nejatian Is Rebuilding Opendoor-双语硬字幕-分页版-1分钟.mp4`，19,111,557 字节；完整解码通过，warnings 为空，20 / 45 秒最终视频抽帧显示正常。最终验证运行烧录耗时约 101.0 秒，含解码与抽帧的探针总耗时 104.9 秒；期间有其他客户端操作与编码竞争 CPU，耗时不能视作固定转换比例。

**预计时间**：处理进度事件新增 ETA，按本次 FFmpeg 已输出视频时间 / 单调时钟实际耗时估算速度，并平滑更新；包括启动和停顿时间，不把 FFmpeg 两次批量进度输出之间的瞬时差值当作编码速度。前三秒没有估计，客户端显示正在估算；有估计后列表、卡片与详情显示预计剩余时间，结束、失败、暂停及应用重启清除旧值。1 分钟探针首次 burn 事件 eta 为 null，3.45 秒开始产生估计；95% 前最后一次预计剩余 6 秒，实际剩余约 7 秒。估计随负载及素材复杂度变化，不保证准确倒计时。

**真实客户端暂停与重启**：通过真实窗口打开上述原 YouTube 任务详情，点击「重新合成字幕」，日志确认 MKV 和 SRT 已存在并复用。烧录进度从 0 开始，在客户端观察到预计剩余时间；暂停后 `burnRestartRequired=true`、processingEta 清空，详情显示从头重新合成说明，暂停状态不再显示正在烧录。关闭并重新启动客户端后提示仍在，再次从 0 合成。最后于 11:16:58 保留 paused，原 MKV 大小与修改时间保持完整，没有烧完整的 28 分钟视频；renderer pageerror 为空。

**自动失败恢复与完成清理**：真实客户端下载 `https://www.youtube.com/watch?v=jNQXAC9IVRw`，新英文硬字幕任务 `c13803a9-98e9-4917-b04d-05cb71e14bee`。在 burn 阶段暂停后，临时使开发引擎粗体字体不可用并继续；失败消息为「20 秒后自动重新合成字幕，第 1/2 次」，详情标题为「字幕烧录中断，稍后自动重新合成」，按钮为「重新合成字幕」，没有把烧录重试称为自动续传。恢复字体后自动重试复用已下载的 MKV / SRT，于 11:13:01 completed，重新合成标记、ETA、处理阶段均清除，warnings 为空；最终 `Me at the zoo-c13803a9.mp4` 完整解码通过。粗体字体已恢复，源目录与打包目录 SHA256 一致。临时探针首次在子进程尚未停止时尝试继续，收到已有的正在停止提示；等待停止后复用同一短任务完成上述验证。

证据位于忽略的 `test-results/subtitle-upgrades/`：`pagination.json`、`landscape-*.png`、`portrait-*.png`、`render.json`、`client.json`、`estimating.png`、`burn-eta.png`、`paused.png`、`reopened.png`、`automatic-retry.json`、`automatic-restart.png`、`retry-completed.png`。

`pnpm typecheck`、`pnpm lint`、`pnpm test`、`pnpm build`、`pnpm engine:build` 通过，Vitest 65 项通过、1 项跳过。`pnpm test:e2e` 仍在原有 `下载所选 (1)` 旧按钮选择器等待 40 秒后失败，实际按钮为 `下载 1 项`；没有修改测试规格，真实客户端流程按上文验证。shadcn CLI 的 info 命令因现有 SDK / zod 子路径不匹配失败，直接检查项目配置并复用已有 Alert / Button / Sheet，没有增加组件或修改依赖。未生成或验证完整安装包。

## 2026-10-14：用户明确授权修复现有 E2E，完整流程通过

用户本轮明确要求修复「E2E 仍因已有旧按钮选择器失败」，因此仅更新已有 `test/e2e/e2e.spec.ts`，没有新增测试用例；本轮授权优先于原型阶段禁止修改测试的默认约束。

下载按钮选择器由 `下载所选 (1)` 改为当前 `下载 1 项`，使用 exact 匹配。继续执行后发现原用例的逐字节文件校验与默认软字幕重封装冲突；这个用例验证原始文件完整性，因此在隔离测试配置中明确关闭字幕，保留原有文件字节一致校验。用 `Buffer.equals` 比较完整字节，避免失败时打印数万行二进制差异。没有更改产品的字幕默认值或跳过原有断言。

实际命令：`pnpm test:e2e --output=test-results/e2e-selector-fix`。构建和类型检查通过，完整 Playwright Electron 用例 **1 passed（20.6 秒）**。覆盖真实引擎解析、本地 HTTP 媒体下载与字节一致、renderer 无 Node / 通用 IPC 能力、非法命令拒绝、任务详情与完成日志、搜索、卡片视图、并发配置保存、深浅主题切换以及重启后的任务 / 设置恢复；没有 renderer pageerror。此用例使用隔离的临时用户目录与本地 HTTP fixture，不替代前文真实站点字幕验证。

指定独立输出目录避免 Playwright 清空已有字幕探针证据；截图仍按用例保存于 `test-results/home.png`、`task-detail.png`、`settings.png`、`client.png`。此前旧选择器失败的记录为历史结果，此处通过结果取代当前 E2E 阻塞状态。

## 2026-10-14：YouTube 音轨列表按语言整理

用户反馈截图中大量 OPUS 码率相近的选项，并明确暂缓升版本、先修音轨。检查真实 `https://www.youtube.com/watch?v=m53ysyhjDJs`，平台返回 21 种音频语言，每种 5 个可用音质档位，共 105 个可用音频格式。此前全部混入一个下拉且不显示语言，造成大量选项看起来重复；并非 105 种不同音质。

现实现：音频语言与音质分别选择，默认「美国英语 · 原声」，原声排首位，其他语言按本地化名称排序；音质菜单仅列当前语言的档位。标签显示真实编码、音质档位与码率，单语言来源不显示语言下拉；音视频同时下载时说明这些选项用于单独保存的音频文件。切换语言重置音质为该语言最高音质，语言和字幕语言相互独立。主进程按语言、编码、真实质量、声道、采样率及解说类别整理重复格式，优先普通动态范围版本，保留不同语言和有意义的档位。

音频语言写入任务快照并参与音频任务去重；主进程校验所选格式与语言一致。YouTube 的数字后缀格式 ID 可以随视频或解析会话改变，因此引擎对指定格式及最高音质回退都加所选语言约束；语言不可用时明确失败，避免静默下载其他配音。编码或档位不可用仍可回落该语言最高音质。

| 验证 | 实际结果 |
| --- | --- |
| 原声菜单 | 6 个选项：最高音质（当前语言）、OPUS 高音质 104 kbps、AAC 高音质 129 kbps、OPUS 标准音质 58 kbps、OPUS 低音质 49 kbps、AAC 低音质 49 kbps |
| 日语菜单 | 切换日语后仍为 6 个选项，码率来自日语格式；没有把其他语言混进音质菜单 |
| 真实客户端在线下载 | 隔离临时用户目录启动真实 Electron，解析同一 YouTube 地址，实际选择日语 AAC 高音质，再以仅音频方式下载 |
| 下载结果 | 任务 `72eef74c-a617-4c53-8c47-0ba3c9d8ca69` completed，audioLanguage 为 ja、所选格式 `140-9`；引擎日志明确下载 `140-9`，27,710,707 字节 M4A，warnings 为空，完整 FFmpeg 解码通过，无 renderer pageerror |
| 编号变化回退 | 以真实平台格式表调用生产 yt-dlp 选择器：指定英文编号但要求日语时回退到日语 `251-10`；最高音质日语也选 `251-10`。该捕获中编号与上述下载会话不同，所选语言仍一致；要求不存在的 zh 得到空选集，不回落其他语言 |
| 重复与平台回归 | 在真实格式表中追加同档 DRC 副本，生产 mediaResult 保留普通版本且仍为 105 个；独立 Bilibili 三档 AAC 66 / 123 / 161 kbps 的临时 metadata 探针全部保留；英文界面的音质和语言标签正确。这两项为临时元数据探针，不声称本轮重新在线下载 Bilibili |
| 中文原声标记 | 实际中文提取结果的 note 为「英语 (US)原始 (default)」，language_preference 为 5；同时识别中文原始标记和英文 original，避免仅按英文词误判原声 |

证据在忽略的 `test-results/audio-options/`：`raw.json`、`production-raw.json` 只包含所需格式元数据，不保存签名媒体 URL 或凭据；另有 `client.json`、`menus.json`、`original-options.png`、`japanese-options.png`、`japanese-selection.png`、`metadata.json`、`selection.json` 和下载的 M4A。验证用实例和临时用户目录已关闭清理，用户开发版仍在运行；需要重新解析已有视频结果以取得新的语言元数据。

`pnpm typecheck`、`pnpm lint`、`pnpm test`、`pnpm build`、`pnpm engine:build` 通过；Vitest 65 项通过、1 项跳过，`pnpm test:e2e --output=test-results/e2e-audio-options` 1 项通过（13.4 秒）。没有新增或修改测试规格，临时探针执行后删除。版本保持 0.4.3，本轮未 commit / push，版本升级与提交推送暂缓。

## 2026-10-14：0.4.4 版本提交验证

用户在音轨列表修复后明确要求升版本并推送，`package.json` 由 0.4.3 升至 0.4.4。版本包含本轮可配置软 / 硬双语 MP4 字幕、固定粗体样式与长字幕分页、烧录重新合成说明和预计时间、多语言音频列表与所选语言回退约束、访客 YouTube 媒体 403 回退、B 站短链 / 合集修复及已获授权的 E2E 修复。

对 0.4.4 重新运行 `pnpm lint`、`pnpm test`、`pnpm test:e2e --output=test-results/e2e-release-0.4.4`：Lint 通过，Vitest 65 项通过、1 项跳过；E2E 包含类型检查与构建，1 项通过（16.0 秒）。前文引擎打包与真实字幕 / 音轨验证仍适用，版本号调整没有更改依赖或 lockfile。未手工创建 Git tag 或发布安装包；现有 main 推送工作流会在验证及各平台构建成功后发布没有同名 tag 的新版本。

## 2026-10-19：抖音报错排查（仅诊断，未修改业务代码）

用户提供截图 `Invalid \escape: line 1 column 14770 (char 14769)`，并指定以下两个真实链接用于验证。先执行 `git pull --ff-only origin main`，确认 main 与远端一致，HEAD 为 `8495d2c`（0.4.4）。当前仓库已经平铺于项目根目录，实际 package.json 位于根目录；本机 node_modules 和引擎为 Windows 版本，使用原生 Windows Node 执行 Vite 构建并通过 Playwright `_electron` 启动真实 Windows Electron 44.4.5，使用隔离临时用户目录，未登录新账号、未导入 cookie 文件。

| 样本 / 检查 | 实际结果 |
| --- | --- |
| `https://www.douyin.com/jingxuan?modal_id=7677554225094956401` | yt-dlp 报 Unsupported URL。当前 normalizeUrl 只改写 `/series?modal_id=…`，没有处理 `/jingxuan?modal_id=…`；内置浏览器回退加载约 106 秒仍未完成，探针主动取消。不能据此声称网站不可用 |
| `https://www.douyin.com/user/MS4wLjABAAAAxLM_XApxKUnt8hT2VrUBx5G8Pqd26aa_w7XcOEP-B9g?enter_from=author_card&from_gid=7677554225094956401&from_tab_name=main&tab_name=discover&vid=7677554225094956401` | 作者「这是个令人疑惑的星球」，首屏读取 18 条作品，包含目标作品，hasMore=true |
| 从主页仅选 `7677554225094956401` 下载 | 入队时 added=1；浏览器回退识别为两个媒体文件后拆出第二个任务。首任务显示 completed，第二个任务报「内容已变化，请重新解析」，并安排自动续传。验证实例关闭后未继续重试 |
| 下载文件检查 | 86,861,508 字节 MP4，872.1 秒，1280×720，只有 HEVC 视频轨，**没有音轨**。FFmpeg 完整解码退出 0，但这只证明视频流可解码，不能将这个无声文件作为完整下载成功 |
| 同页媒体响应复核 | 真实播放器分别请求 `media-video-hvc1/` 与 `media-audio-und-mp4a/`，两者服务器 MIME 都是 video/mp4。客户端将两条响应当成两个视频，没有配对合并 |
| 界面与隔离 | renderer pageerror 为 0；下载只写入 `test-results/douyin-20261019/下载/中/`，未写入用户原有下载目录或修改原有任务 |

确认的代码原因：

- `electron/services/media.ts:145` 只对 `/series` 处理 modal_id，精选弹窗地址没有转成目标作品地址。
- `electron/services/browser.ts:501` 将嗅探到的媒体统一收为 URL；`electron/services/parser.ts:305` 仅按 URL 扩展名判断音频，而此样本的音频 URL 以 `media-audio-und-mp4a/` 结尾、MIME 仍为 video/mp4，结果音视频分轨被当成两个独立视频。`collapseStreams` 也没有适用于这组抖音分轨的配对规则，因此只保存了无声的视频轨。
- `electron/main/controller.ts:74` 仅在 itemId 为 `*` 时传 single=true。拆分任务变成 itemId=`2` 后再次解析，会跳过单作品缓存，调用 douyinVideo 适配器展开所属合集（本次 mix_id=`7674938999751837739`，4 条作品）。合集内使用作品 ID，没有 itemId=`2`，故 `electron/services/queue.ts:413` 抛出「内容已变化」。

原截图的 Invalid \escape **尚未在这两个真实样本上复现**。本机 Windows Python 系统编码为 cp65001，真实中文目录下载没有发生 JSON 编码错误。另以生产 `engine/main.py` 入口做条件对照：同一份含 `D:\中\video.%(ext)s` 的 UTF-8 JSON，在 stdin 显式为 cp936 时返回 Invalid \escape，在 UTF-8 时返回正常 version 结果。这证明缺少显式管道编码是一个可触发同类异常的条件，尚不足以认定原截图一定由此产生；仍需原失败环境的任务日志或相同环境复现才能确诊。建议修复时显式统一 Python 标准输入 / 输出为 UTF-8，并同时处理上述已确认的链接路由、音视频配对与拆分任务解析问题。

本轮未修改业务代码、未新增或修改任何 Vitest / Playwright / live 规格。临时探针执行后删除，验证实例和临时用户目录已清理；保留忽略目录 `test-results/douyin-20261019/` 中的 result.json、tracks.json、media.json、decode.json、diagnostic.log、截图、抽帧与无声 MP4 作为诊断证据。tracks.json 仅保留去签名的媒体路径及 MIME，不保存 cookie 或授权头。生产 Vite 构建通过；本轮没有重跑完整测试门禁，不将构建等同于抖音下载正确。

## 2026-10-19：修复精选链接、分轨合并与拆分任务解析

用户在上述诊断后明确要求先修复三处问题。本节替代前节对这三处问题的“仅诊断、未修复”状态；原截图的 Invalid \escape 不在本次三处修复中，仍不能据此声称已经解决。

实现复用现有本地引擎：normalizeUrl 对数字 modal_id 的 `/jingxuan` 与 `/series` 一并转换；抖音单个视频的浏览器回退根据实测 CDN 路径识别 `media-video-hvc1/` / `media-audio-und-mp4a/`，按真实资产路径去除同一分轨的范围请求及 CDN 重复地址，仅在唯一一组音视频轨时构造同一作品的 formats。媒体 URL、cookie、请求头始终保留在主进程与 Python 管道中，不返回 renderer。Python 使用 yt-dlp 自带的 process_ie_result，沿用原有的格式选择、续传、FFmpeg 合并、字幕与封面后处理，没有另建下载或合并管线、没有增加依赖。轨道不足或存在多组无法唯一配对时明确失败，避免再次保存无声视频或合并其他作品。

Job 新增可选 single 标记，列表任务入队及拆分时设置、随任务持久化；Controller 重新解析任务时使用该标记，并保留旧通配符任务的兼容判断。数字文件 ID 不再意味着必须展开所属合集。

| 真实 Windows Electron 验证 | 结果 |
| --- | --- |
| 原精选地址 `https://www.douyin.com/jingxuan?modal_id=7677554225094956401` | 解析结果地址为 `/video/7677554225094956401`，显示既有的「农村青年录」合集 4 条，包含目标作品；不再报原精选地址 Unsupported URL |
| 从精选结果仅选择目标作品 | added=1、只创建一个任务，引擎实际选择 browser-video+browser-audio，最终合并为一个 MP4 |
| 暂停、重启与数字文件 ID | 下载开始后真实暂停并关闭实例；在隔离的持久化状态中将该任务的 itemId 从 `*` 改为 `1`，模拟拆分后的数字文件 ID，保留生产代码写入的 single=true。重启后清空了内存解析缓存，再通过正常 resume 命令完成真实网络续传；只解析单作品，没有展开合集，也没有“内容已变化”。这是持久化状态重放，不能描述成修复后仍自然拆出了多余任务 |
| 用户提供的作者主页 | 首屏 18 条，包含目标作品；只选该作品下载，added=1，再产生一个完成任务，没有多余任务。两次选择合计恰好 2 个 completed 任务 |
| 两份实际成品 | 每份 108,544,181 字节、872.145 秒、1280×720，均含 HEVC 视频轨与 AAC 音轨；与修复前只有视频轨的 86,861,508 字节文件不同 |
| 运行隔离 | 临时用户目录、匿名站点会话，输出只在 `test-results/douyin-fix-20261019/下载/中/`；未改动用户已有任务及下载目录；renderer pageerror=0。该作品无平台字幕，两次任务均明确提示保留无字幕视频 |

Windows 原生工具执行类型检查、lint、Vitest、构建及现有 Electron E2E；`pnpm build`（含 typecheck）、`pnpm lint`、`pnpm test` 通过，Vitest 65 通过 / 1 跳过；构建后执行同一 E2E 门禁 `pnpm exec playwright test --output=test-results/e2e-douyin-fix`，1 passed（35.9 秒）。同时用项目既有 PyInstaller 参数重新打包 Windows media-engine.exe，真实客户端验证使用该新引擎。没有新增或修改任何 Vitest / Playwright / live 规格。

诊断证据保留于忽略目录 `test-results/douyin-fix-20261019/`：result.json、media.json、verification.json、first-decode.json、精选 / 主页 / 完成截图及两份真实 MP4。两份成品 SHA-256 完全一致（db5572d61488c78a506d320137a953ace0f2623aa5733dc72775c181a5e17368）；对其中一份做完整 FFmpeg 解码，退出 0、无解码错误。前 30 秒音频平均响度 -15.6 dB、最大响度 -3.6 dB，确认不是数字静音；结果见 verification.json。一次性探针脚本和临时用户目录在验证后删除；未升级版本、提交或发布安装包。

## 2026-10-20：0.4.5 发布验证

用户要求升小版本并提交发布，package.json 从 0.4.4 升至 0.4.5。本次包含上述抖音精选分享链接转换、浏览器音视频分轨合并，以及拆分任务重试 / 重启后的单作品解析修复；没有改动依赖、lockfile 或测试规格。

在 0.4.5 上执行 `pnpm check`：typecheck、lint、构建通过，Vitest 65 通过 / 1 跳过。随后执行构建后的同一 Electron E2E 门禁 `pnpm exec playwright test --output=test-results/e2e-release-0.4.5`，1 passed（17.6 秒）。上一节真实抖音双轨下载、完整解码、暂停及重启验证仍适用；本次版本号调整没有改变这些业务实现。

发布沿用 main 推送触发的 Electron client 工作流：验证通过后分别构建 Windows、macOS、Linux 安装包，再统一创建裸版本号 0.4.5 的 GitHub Release。由工作流创建 tag，避免提前创建同名 tag 导致自动发布被跳过。

## 2026-10-21：Linux 工作目录的模式拆分、测试修复与 HLS

本节验证只针对 `/home/bhwa233/code/electron-client`，起点为 `316527d`（0.4.3），开始时工作区干净。此前误在 Windows 目录实现的模式功能已迁入这里，并补齐其所需字幕处理器、粗体 CJK 字体、输出参数和进度展示；本节不使用 Windows 目录的结果代替 Linux 实测。未修改版本或发布安装包。

### 测试规则修复

用户明确要求修复失败 / 跳过项，因此本轮修改了对应测试：封面测试区分下载模式与剪辑模式，纯下载不嵌入或转换封面，剪辑模式遵守自己的保存开关；音频追加仍验证独立任务、去重和原任务不变。原跳过项仍假设番剧没有适配器，已改为分P 链接交给引擎、番剧链接交给现有 `bilibili-bangumi`，同时移除 Vitest 的名称过滤。旧 Electron E2E 的按钮名由「下载所选 (1)」更新为实际「下载 1 项」。没有新增持久化测试规格。

最终 `pnpm test`：**66 passed / 10 files，无失败、无跳过**。`pnpm lint`、`pnpm typecheck`、`pnpm build` 均通过。`pnpm test:e2e --output=test-results/e2e-hls-20261021`：**1 passed**，验证真实下载字节、渲染隔离、界面操作及重启持久化。

### 用户指定来源与实测范围

最初来源 [YFSP 播放页](https://www.yfsp.tv/play/40zRQuBGtM8) 在本环境返回 Cloudflare 验证页，用户随后改为提供 `sss111-e1.pipecdn.vip/.../chunklist.m3u8` 的签名直链。未完成该播放页的访问验证，也未将它记录为站点解析成功。代码增加验证页识别与「打开验证页面」入口，避免把访问验证误报为没有媒体。

签名参数不写入需求或长期用例；它会过期，不作为固定网络断言。以下通过隔离用户目录中的真实 Linux Electron 客户端及本地引擎执行，未替换 IPC、解析器、下载器或 FFmpeg：

| 输入 / 检查 | 实际结果 |
| --- | --- |
| 用户 m3u8 直链，客户端解析 | 识别 1 项 HLS 视频，VOD 时长 **5739 秒（95:39）**；清单共 **509 个分片**，包含结束标记 |
| 用户来源首分片 | 实际获取 622,844 字节、约 12.08 秒；检测到 **864×486 H.264 视频 + AAC 音频（44.1 kHz）** |
| 用户来源短样本 | 使用更新后的随应用 FFmpeg 从该直链保存前约 15 秒：MP4 时长 15.16 秒、646,232 字节，H.264 / AAC，完整解码退出 0。此项只验证短样本，不代表整部 95 分钟内容下载完成 |
| [Mux 固定公开 HLS 主清单](https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8) | 客户端列出 5 档画质，选择最低档完整下载；最终是真实 MP4，320×184、H.264 / AAC、634.633 秒、20,049,873 字节，完整解码退出 0，未保存为清单文本 |
| 下载模式默认隔离 | 即使保存着 MKV / 480p / 硬字幕 / MP3 的剪辑参数，下载任务仍固定字幕关闭、原始音轨、不加工媒体 |
| 剪辑 MP4 / 480p | 实际 MDN flower 视频从原片 960×540 输出为 852×480；两份文件均保留 |
| 剪辑 MKV / 1080p | 同一 960×540 素材保持 960×540，没有上采样；两次下载的原片哈希一致 |
| 统一任务与重启 | 1 条下载任务与 2 条剪辑任务统一展示；重启后 3 条任务保留；renderer pageerror=0 |
| Linux 打包字幕处理器 | 对上述真实素材添加中英样例字幕，调用 `resources/engine/media-engine` 生成双语硬字幕；原片哈希不变，成品完整解码通过，粗体字体可用。此项不是在线中文字幕获取验证 |

### Linux FFmpeg 兼容修复

实测 `ffmpeg-static` 随附的 Linux `7.0.2-static` 对完整 MPEG-TS 输入发生 SIGSEGV（退出 -11）；同一输入用系统 FFmpeg 可成功封装。多种输入 / 线程参数仍复现，因此没有靠跳过封装或把 TS 冒充 MP4 来完成任务。

Linux x64 的准备 / 打包流程改用 **BtbN n8.1.3-9-g29e619e767，autobuild-2026-09-30-13-08 月末版本**，下载归档固定 SHA-256：`97ce978979194b5cf7e06a5e68020dbdaa7a4f3294c5452b6a1bc347100dbb79`，复用本地缓存并随包保留许可证。开发客户端也优先使用准备后的 FFmpeg。对同一失败输入重跑封装退出 0，随后真实客户端完整 HLS 下载成功；验收使用随应用二进制，未依赖系统 FFmpeg。

构建来源见 [FFmpeg 官方静态构建入口](https://ffmpeg.org/download.html)、[BtbN 项目与保留策略](https://github.com/BtbN/FFmpeg-Builds)、[固定发布](https://github.com/BtbN/FFmpeg-Builds/releases/tag/autobuild-2026-09-30-13-08)。相关版本差异可参考 [ffmpeg-static #151](https://github.com/eugeneware/ffmpeg-static/issues/151)；具体崩溃结论来自本机对照，不能仅由该 issue 推断。

证据在忽略目录 `test-results/hls-20261021/`：`client-summary.json`、`sample-metadata.json`、`sample-clip-metadata.json`、`fixed-remux.json`、`remux-comparison.json`、`demux-comparison.json`、`user-direct-hls.png`、`unified-tasks.png`、`hard-subtitles/summary.json` 与抽帧。临时探针和用户目录在验收后清理；原片、成品及脱敏结果保留供复核。

## 2026-10-21：0.5.0 次版本提交验证

用户要求升中版本并 push；在指定的 `/home/bhwa233/code/electron-client` 操作，将 package.json 从远端最新 0.4.5 升至 0.5.0。合入 origin/main 的既有提交，保留抖音精选链接、音视频分轨合并、单作品重试、B 站短链及多语言音轨修复。本版新增下载 / 剪辑模式分离、仅降分辨率、原片与成品共存及 HLS 解析下载。依赖与 lockfile 未变。

合并及升版本后执行 `pnpm engine:dev`（固定 Linux FFmpeg 校验通过）、`pnpm check`（typecheck、lint、66 项单测及构建全部通过，无跳过），以及构建后的 Electron E2E 门禁 `pnpm exec playwright test --output=test-results/e2e-release-0.5.0`（1 passed，9.9 秒）。前一节真实 HLS 与剪辑验证仍适用，本轮没有重新下载整部用户样本。

发布沿用 main 推送工作流：验证与 Windows / macOS / Linux 打包成功后创建 0.5.0 tag 和 Release；不预先手动创建同名 tag。

## 2026-10-21：任务模式标签隐藏与左上角版本号

按用户截图反馈，去掉任务标题旁的工作模式 Badge，列表和卡片共用同一处标题；左上角 Galaxy 名称旁显示 package.json 的当前版本 `v0.5.0`，随构建版本更新。模式筛选与任务详情继续可查看模式。

`pnpm build`（包含 typecheck）、`pnpm lint`、`git diff --check` 通过。通过技能 driver 启动真实 Linux Electron，在隔离临时用户目录重放前次真实 Mux HLS 下载和 MDN flower 剪辑样本的完成记录，切换列表 / 卡片：两项均无下载或剪辑模式标签，标题和完成状态正常，侧栏显示 `Galaxy v0.5.0`，renderer pageerror 为 0。该轮只验证展示，没有重新联网下载；未新增或修改测试规格。截图保留于 `test-results/driver/no-mode-tag-list-version.png` 与 `no-mode-tag-grid-version.png`，验证实例已关闭、临时用户目录已删除。

## 2026-10-21：任务仅保留列表视图

按用户要求，任务页固定使用列表，移除任务卡片分支、列表 / 卡片切换入口、设置中的默认任务视图及对应持久化字段。旧状态中 `view=grid` 经现有 settingsSchema 解析时自动忽略，解析结果的 `resultView` 配置仍独立保留。

`pnpm build`（含 typecheck）、`pnpm lint`、`pnpm test`（66 passed，无跳过）与 `git diff --check` 通过。真实 Linux Electron 使用隔离临时用户目录，预置旧 `view=grid` 和此前真实 HLS / flower 的完成记录；全部任务和已完成页均显示两条列表，切换按钮数量为 0，外观设置不再包含默认任务视图，仍包含解析结果视图与列表密度；renderer pageerror=0。截图：`test-results/driver/tasks-list-only.png`、`tasks-list-only-settings.png`。本次未重新联网下载，实例关闭后临时目录已删除。

现有 Electron E2E `pnpm exec playwright test --output=test-results/e2e-list-only` 在 `test/e2e/e2e.spec.ts:50` 等待已删除的“卡片视图”按钮时超时失败；此前本地媒体解析、下载、文件内容、详情日志步骤已执行。此失败与本次移除入口的产品要求冲突，遵守 AGENTS.md 原型阶段不得修改测试规格的规则，未新增或修改测试；不能声称整套 E2E 通过。

## 2026-10-21：任务状态固定在右上角

任务完成、暂停及其他状态从标题后移到条目右侧操作列的顶部，操作按钮位于该列底部；长标题在内容列截断，不挤占状态位置。

`pnpm build`（含 typecheck）、`pnpm lint`、`git diff --check` 通过。真实 Electron 使用隔离目录展示完成短标题与暂停超长标题，两项状态距右边均为 13 px、距上边均为 11 px，与标题顶部对齐，任务无水平溢出，renderer pageerror=0。截图：`test-results/driver/task-status-top-right.png`；任务数据重放先前真实下载样本，非本轮重新下载。临时实例及目录已清理，用户开发版继续运行，Vite 日志确认 Tasks.tsx 已热更新。未修改任何测试规格，未重跑上节已知依赖旧卡片入口的 E2E。

## 2026-10-21：设置页右上角保存与最小高度

保存按钮与保存反馈移入设置卡片标题右侧，移除底部保存栏。表单、卡片、内容区使用弹性布局，在内容较少时填满主区域的可用高度，长内容自然增高并由页面滚动。

`pnpm build`（含 typecheck）、`pnpm lint`、`git diff --check` 通过；真实 Linux Electron 隔离目录验证：1200×950 的外观页卡片底部在 y=926（保留 24 px 页面内边距），保存按钮位于标题右侧；修改列表密度并点击右上角保存，主进程状态确认为 compact，显示“设置已保存”，renderer pageerror=0。1000×700 的剪辑页内容高度 904 px、可视区 636 px，能滚动 268 px 至底部，卡片底部保留 24 px 间距，无水平溢出。截图与数据：`test-results/settings-layout/appearance.png`、`editing-bottom.png`、`summary.json`。验证实例与临时目录已清理；用户开发版继续运行且已热更新。未修改测试规格。

## 2026-10-21：模式名称仅在设置显示

保留“下载模式 / 剪辑模式”名称。移除顶栏模式 Badge、侧栏模式副标题、任务模式筛选和任务详情中的模式字段；左上角保留 Galaxy 与版本号，任务保持统一列表。设置里说明下载模式不转码、不加字幕或嵌入封面，剪辑模式按配置加工并保留原片和成品，保存后仅影响新任务。

`pnpm build`（含 typecheck）、`pnpm lint`、`git diff --check` 通过。真实 Linux Electron 隔离目录验证：剪辑模式任务页、任务详情和切回下载模式后的任务页均无模式名称 / 模式筛选，版本号仍显示；设置内两种模式名称及说明正常，实际切换并保存后主进程 workMode=download，renderer pageerror=0。截图和报告：`test-results/mode-displays/tasks.png`、`detail.png`、`settings.png`、`summary.json`。首次探针在设置懒加载完成前读取了页面文本，导致说明文本检查误报；改为等待“工作模式”控件就绪后重验通过，未因此修改业务实现。临时实例与目录已清理，用户开发版继续运行并已更新。未修改测试规格；未重跑已知依赖旧卡片入口的 E2E。

## 2026-10-21：B 站番剧时长与大小估算修复

用户截图链接 `https://www.bilibili.com/bangumi/play/ss28747`，第一集“凡人风起天南1重制版”显示 334:12:40、约 773.8 GB。真实季度接口第一集 duration=1203160（毫秒），现有 bilibili-bangumi 适配器直接赋给统一按秒定义的 ListingEntry.duration，导致时长和按码率估算的体积同时放大 1000 倍。播放器接口 timelength=1203198（毫秒）独立佐证实际约 20 分钟；两处片长相差约 0.038 秒属于上游列表 / 播放元数据差异。

只在 bilibili-bangumi 的 PGC 入口执行毫秒转秒，保留小数与未知时长；没有按数值大小猜测单位，也没有改变普通投稿、合集、分P 或 yt-dlp 原本按秒提供的时长。结果页继续用原有真实码率与音视频合并逻辑估算体积，并保留“约”标识。

验证：

- 同一运行中的真实客户端 CLI 在修复前后解析原链接，首集 duration 从 1203160 变为 1203.16，前 100 集均正确换算。原会话默认 4K 的合并码率 5524.304 kbit/s，大小估算由 830827700080 字节（约 773.8 GiB）恢复为 830827700 字节（界面约 792.3 MB），与原引擎同画质 filesize 830808535 字节接近；这里是元数据对比，没有整集下载。
- 隔离临时用户目录运行真实 Linux Electron，在线解析同一站点。匿名会话可用画质不同：首集卡片和列表均显示 20:03、约 69.4 MB；短片“星海飞驰16”duration=25.2，卡片显示 0:25、约 1.5 MB，说明没有使用长度阈值误伤短片。renderer pageerror=0。
- `pnpm check` 通过：类型检查、Lint、66 项单测（10 文件、无跳过）与生产构建全部通过；`git diff --check` 通过。没有新增或修改 Vitest / Playwright / live 规格；未重复运行此前已知等待旧卡片按钮失败的 E2E。

证据位于忽略目录 `test-results/bangumi-metadata-20261021/`：metadata-comparison.json、client.json、corrected-grid.png、corrected-list.png、check.log。两次早期临时 UI 探针分别使用了错误的卡片容器选择器与旧列表按钮名称，修正探针后重验通过；未因探针问题改动业务代码。临时实例、用户目录与含签名播放地址的接口原始响应已删除，保留报告只含公开条目、时长和画质数值。用户开发实例继续运行并已重新加载修复；已有结果需要重新解析以获取正确元数据。

## 2026-10-21：0.5.1 本地提交验证

用户要求 commit 并升小版本，package.json 从 0.5.0 升至 0.5.1。本次提交包含前述任务仅列表显示、状态固定右上角、模式名称仅在设置显示及区别说明、左上角版本号、设置右上角保存与最小铺满页面，以及 B 站番剧毫秒时长转换和连带体积估算修复。依赖及 lockfile 未变，未修改测试规格。

业务变更后的 `pnpm check` 已通过（typecheck、Lint、66 项单测与构建），实际客户端及 B 站验证见前文。升版本后重新运行 `pnpm build`（含 typecheck）通过，`git diff --check` 通过。既有 E2E 仍在等待已按产品要求移除的卡片按钮，此次没有重跑或修改该测试，不宣称 E2E 全部通过。本次仅本地提交，未推送、未创建 tag。


## 2026-10-22：视频处理、离线 ASR 与内核后台更新

工作目录 `/home/bhwa233/code/electron-client`。全部新验证通过真实 Linux Electron、真实引擎和实际模型完成，使用独立的 `CLIENT_TEST_DATA`；未新增或修改 Vitest、Playwright 或 live 规格。临时驱动脚本已删除，证据留在忽略目录 `test-results/processing-20261022/`。

| 实际来源／操作 | 结果 |
| --- | --- |
| [Whisper.cpp JFK WAV](https://raw.githubusercontent.com/ggml-org/whisper.cpp/master/samples/jfk.wav) | 客户端下载、按模板保存后自动转录；Whisper Tiny 在本机识别出完整英文句子。已安装模型时阻断主窗口 HTTP 后重新识别成功，未出现 HTTP 请求。 |
| [Sherpa 四人中文样本](https://github.com/k2-fsa/sherpa-onnx/releases/download/speaker-segmentation-models/0-four-speakers-zh.wav) | 实际下载 SenseVoice、Silero VAD、pyannote 分割和 CAM++ 模型；56.86 秒音频生成 17 行字幕，指定 4 人得到 4 位说话人；改自动聚类仍得到 4 人，逐行文字、ID、时间和词数据保留。 |
| 字幕编辑与说话人 | 主窗口编辑首行并保存为“这是人工编辑的字幕。”；重命名“主持人”后全文／说话人搜索命中 4 行。另对带人工修改的英文稿重新标注为 1 人，文字及 500～10500 ms 时间保持不变。过期 revision 拒绝覆盖。原生对话框导入 SRT 后，切回原轨仍保留已编辑文本；未知语言显示为文件名，写入标准 und 标签。 |
| 已有字幕优先 | 导入带 en／zh 独立 SRT 的媒体；选未安装的 Qwen3-ASR 1.7B 运行“读取字幕或识别”，直接完成，未下载模型。支持切换轨道。 |
| 播放器 | 文档 UUID 协议返回正确媒体类型和 Content-Length；Range `bytes=0-15` 得 206、16 字节；越界得 416；视频时长 11.4 秒，点击第二行即跳至 5 秒。没有文件路径型 IPC。 |
| 字幕与视频导出 | 实际导出 TXT、Markdown、SRT、VTT、双轨 en／zh 软字幕 MKV、英文及中文烧字幕 MP4；FFmpeg 全片解码通过。中文截图 `burn-zh-frame.png` 无缺字；原片 SHA-256 始终为 `5c873a69e1a31ba33980d0514c33a58575f664f2d94c65808c143b1e9e9d5484`。 |
| 分辨率 | 640×360 原片按 1080p 导出仍为 640×360；1920×1080 测试媒体按 480p 导出为 852×480，只降不升。 |
| 元数据与封面 | 引擎处理实际媒体，保留原片及 `.edited.mp4`，写入 title、artist 与两个章节；独立验证从真实 GitHub 下载 PNG、保存并作为 attached picture 写入副本。 |
| 并发、取消及模型状态 | 并发设 1 时两个识别请求分别 running／queued；取消首个后第二个运行。未安装模型任务进入 waiting-model，可取消。已安装说话人模型删除后 ready=false；Whisper Base 下载取消后无就绪标记、无残留 staging。单人识别仍启用 VAD；辅助模型共享下载期间取消文档能立即释放队列位，再次启动可复用该下载并完成识别。 |
| 模式隔离与输入校验 | 下载模式视频处理导航为 0，模型操作被主进程拒绝；记录和已下载模型保留。6 种字幕语言被拒绝，非法文档 ID 被拒绝。 |
| yt-dlp 更新／回退 | 从官方 PyPI 获取 2026.10.21 wheel、校验并激活，实际版本由 2026.08.19 变为 2026.10.21；回退到打包基线成功，重启能验证并加载安装版本。独立 PyInstaller 引擎也通过候选 wheel 兼容检查，并实际在 2026.10.21 内核下下载 TED 两种平台字幕。 |
| 打包的识别进程 | Linux `electron-builder --dir` 打包成功，`.node` 与同目录 `.so` 在 asar.unpacked；以打包应用的 Electron 启动 asar 内 worker，离线识别 JFK 成功、退出码 0。 |

TED 字幕来源：[Candace Parker — How to break down barriers and not accept limits](https://www.ted.com/talks/candace_parker_how_to_break_down_barriers_and_not_accept_limits)。旧 2026.08.19 内核解析失败；更新至 2026.10.21 后取得 en（244 行）与 zh-cn（250 行）VTT。真实探针发现 captions 操作在构造 YoutubeDL 后设置 outtmpl 会破坏其规范化结构，已改为构造前配置；修复后两种语言下载成功，字幕下载错误严格上报。

完整客户端链路也已实测：新建 TED 180p 下载，模板文件保存至 `Candace Parker/`，原片和写入元数据的 `.edited.mkv` 都保留；未勾选附带字幕但开启下载后自动转录，选中的 Qwen3-ASR 1.7B 未安装。下载完成后工作台自动从平台取得 en／zh-cn 两轨，英文清洗后 225 行，状态 completed，Qwen 仍未安装，未启动 ASR。renderer pageerror=0。截图 `test-results/driver/processing-ted.png`、`processing-models.png`。

真实 TED HLS 字幕还暴露了缺少空行与重复边界 cue：原解析器会把下一行时间戳混入正文。已按时间戳边界解析、忽略空 cue 并去重，客户端重取平台字幕后为 225 行，首行严格从 621 ms 到 5460 ms，正文不再含时间戳。

修复中还发现“只附带平台字幕”的新任务会进入旧视频加工器，对 WAV 尝试映射视频流而失败；已在 deferProcessing 路径只做字幕文件处理，不重写原媒体，重试同一真实下载后完成并自动转录。早期播放器协议缺少明确分段响应导致 WAV 时长为 Infinity，已实现 200／206／416 与正确长度；重验视频时长、seekable 与跳播正常。

`pnpm check` 通过：typecheck、Lint、66 项单测（10 文件）及构建。`pnpm engine:build` 成功。现有 E2E 实际运行，先成功完成解析、下载与日志校验，然后在 `test/e2e/e2e.spec.ts:50` 等待已删除的“卡片视图”按钮失败；没有改动测试或宣称 E2E 全绿。

验证限制：本轮实际运行的 ASR 为 Whisper Tiny 与 SenseVoice；其他家族及更大变体已接入，但未逐一下载、推理或比较准确率。当前仅验证 Linux x64 CPU，Windows、macOS 与 GPU 未实机验证。模型准确率不由短样本保证；部分上游归档下载量大于最终模型体积，界面已有说明。


## 2026-10-22：选择媒体未列出已下载任务

真实用户数据中有 1 个已完成且媒体文件仍在的任务，处理文档为 0。复制任务状态到隔离用户目录、启动真实 Electron 后复现：“选择媒体”选项为 `[]`，无 renderer 异常。根因是下拉只使用 processing.documents，而已有下载仅在从任务详情打开、手动导入或自动转录时才注册为文档。

修复后主进程从已完成任务的原片／媒体文件中提供可选来源，只返回任务 ID、标题与文件名；过滤图片、空文件、丢失文件及越出任务目录的路径。选择后复用 processing:from-job 注册并载入，已有文档按源路径与文件签名去重。导入和自动处理使用同一文件校验逻辑；不会因为打开或选择而启动 ASR、下载模型。空列表禁用并提示先下载／导入；现有 Choice 原语支持占位文字。

验证：

- 同一份真实状态，修复前 options=[]；修复后直接出现已下载的 MKV（官方预告片）。实际选中后载入 1:13 的播放器，创建文档关联正确任务，模型下载数为 0；再次展开仅 1 个选项，无重复，原媒体仍存在，renderer pageerror=0。
- 在隔离状态中将文件指向不存在路径，来源不再出现，下拉禁用且显示“暂无可用媒体，请先下载或导入”；尝试从该任务载入被主进程拒绝。
- 用户开发实例保持运行，主进程已提供 1 个可选的已下载媒体，用户真实处理记录仍为 0，没有为验证操作改动真实记录。
- pnpm check 通过（typecheck、Lint、66 项既有单测与构建）；后续选择状态保护改动后再次 build（含 typecheck）和 lint 通过，git diff --check 通过。未新增／修改测试规格；未重跑已知因“卡片视图”旧选择器失败的 E2E。

证据：test-results/media-picker/before-options.png、after-options.png、after-loaded.png、empty.png；临时驱动与隔离用户目录已删除。
