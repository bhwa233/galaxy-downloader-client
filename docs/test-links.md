# 测试链接清单

本文汇总全部平台的测试链接，供实现与验收时使用。**状态列只有两种**：已验证 = 在真实浏览器里打开并确认过可用；待补 = 还没有拿到可用的样本。拿不到的都写了原因，不要凭空编链接。

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
