# 主页列表解析与客户端身份

本文记录本轮实现的两件事：把创作者主页的列表解析做成可扩展的适配器结构（哔哩哔哩、YouTube），以及让客户端发出的每一个请求在身份、节奏和头部上保持自洽，以降低触发平台风控的概率。

## 1. 三条解析路线

客户端解析一个链接时，按以下顺序选路。`electron/services/parser.ts` 是唯一的分流点。

| 路线 | 触发条件 | 执行位置 | 网络栈 |
| --- | --- | --- | --- |
| 拒绝 | `refusalFor(url)` 命中停用清单 | 主进程 | 无 |
| 主页列表 | `isProfileUrl(url)` 为真 | `EmbeddedBrowser.inspectProfile` | Chromium（分区 session 或隐藏窗口） |
| 直连解析 | 其余链接 | yt-dlp（Python 引擎） | Python urllib |
| 浏览器兜底 | 直连失败且失败原因像是登录/风控 | `EmbeddedBrowser.inspect` + yt-dlp | Chromium + Python |

主页列表只有**一条**路线，没有降级阶梯：隐藏窗口加载 `entryUrl`，然后**由页面自己**调平台的列表接口（`adapter.fetchPage`）。

这样选的理由是：主进程只能"声称"的东西，页面是"本来就是"的 —— cookie、`Origin`、`Referer`、客户端提示、TLS 握手，全部由浏览器供给，无一需要伪造。

被删掉的两条：

- **主进程直连列表接口**。它能用（实测登录/匿名都通），但它发出的每一项关于调用者的信息都得自己拼，而页面路线本来就要开窗口，省下的只是一次页面加载。
- **栅格抓取兜底**。滚动列表正是平台风控重点监测的动作；而且一次失败会短时锁住 profile（见已知限制 11），所以"接口被拒 → 去滚栅格"这个降级，很可能两条一起失败。拒绝如实报成拒绝，比包装成"这个主页作品比较少"对调用者更有用。

代价：没有 `fetchPage` 的平台不再有列表路线，地址落到 yt-dlp。目前三个平台都有（哔哩哔哩、抖音、YouTube）。

### 1.1 窗口复用

`inspectProfile` 开的隐藏窗口在读完一页之后**不销毁**，挂在 `EmbeddedBrowser.open` 上等下一页。

- **命中条件**：下一次请求的 `entryUrl` 与窗口当前停留的地址一致，且窗口未被销毁。命中就跳过页面加载和 `PACE.settle`，实测省下约 4 秒。
- **关闭时机**：换了别的列表、`close()` / `clear()`、或者 5 分钟没再用（每次翻页都会把这个定时器往后推）。不留活页面在后台，本身也是一种特征。
- **失效兜底**：复用的页面可能已被回收、被站点导航走、或单纯过期。因此复用失败会**丢掉窗口重开一次**，只重试这一次；`LoginRequired` 不重试 —— 重开一次照样会被拒。

### 1.2 页内 fetcher

`pageFetch(evaluate)`（`browser.ts`）返回一个普通 `Fetcher`：

```
主进程：把 address 与 init 序列化成字面量，拼进一段表达式
页面：  fetch(address, { ...init, credentials: 'include' })
返回：  { status, body } 或 { failed }
主进程：重建成 Response 交给适配器
```

几个必须注意的点：

- 走 `watch()` 的 `evaluate`，即 CDP `Runtime.evaluate` + `awaitPromise`。它**绕得过页面 CSP**，而 `executeJavaScript` 不行 —— 哔哩哔哩禁 `unsafe-eval`。
- `credentials: 'include'`，否则跨域 fetch 不带 cookie。实测 `api.bilibili.com` 对 `space.bilibili.com` 回显 `Access-Control-Allow-Origin` 并允许凭据；换一个无关 Origin 则直接 412。**判据：凡是页面自己会发的请求，页内 fetch 一定能发。**
- 网络层失败返回 `{ failed }` 并在主进程抛错，与"服务器拒绝"（有 HTTP 状态）区分开。适配器不能把风控拒绝读成"这个主页没有作品"。
- `204` / `304` 一类状态不允许带 body，`new Response('x', { status: 204 })` 会抛 `TypeError`，因此这些状态重建时传 `null`。
- 适配器不传 body 时，`JSON.stringify` 会丢掉 `body: undefined` 这一项，展开后 GET 不会莫名带上 body。

## 2. 适配器契约

`electron/services/listings/types.ts` 定义 `ProfileAdapter`，只剩三项：

- `matches(url)` / `entryUrl(url)`：识别主页地址，并把它改写为真正承载列表的那个页签。
- `fetchPage(request)`：平台自己的列表接口。**这是唯一的路线** —— 没有 `fetchPage` 的适配器不可用，身后没有栅格抓取接着。

`listenTo` / `collect` / `advance` / `hasNext` / `pageSize` / `random` 随栅格抓取一起删掉了。

注册在 `electron/services/listings/index.ts`。没有适配器的平台落到 yt-dlp。

### 2.1 哔哩哔哩

`listings/bilibili.ts`。走 `x/space/wbi/arc/search`，请求需要 wbi 签名：从 `x/web-interface/nav` 取 `img_url` / `sub_url`，按固定表混淆出 mixin key，对排序后的查询串签名（`listings/wbi.ts`）。密钥每日轮换，进程内缓存半小时。

密钥优先从站点自己的 localStorage 取（`wbi_img_url` / `wbi_sub_url`，或合并形式 `wbi_img_urls`），这份由预热访问顺带读回（`PageRequest.storage`）；只有在没预热过窗口时才退回打 `nav`。少一个请求就是少一个风控信号。

**未登录时，签名正确并不足够。** 风控还要求请求自报客户端的图形栈，缺这几个参数时，即使签名无误、即使带着本站下发的访客 cookie，接口照样回 `-352`：

| 参数 | 值 |
| --- | --- |
| `dm_img_str` | base64(`gl.getParameter(gl.VERSION)`)，去掉 `=` 补位 |
| `dm_cover_img_str` | base64(UNMASKED_RENDERER + UNMASKED_VENDOR)，**截断到 130 字符** |
| `dm_img_inter` | `{"ds":[],"wh":[…],"of":[…]}` |
| `dm_img_list` | `[]` |

前两个是真实 WebGL 字符串，只有跑过页面的地方才有。`EmbeddedBrowser.fingerprint()` 因此在每次运行时开一个隐藏窗口加载 `about:blank`，读一次并缓存；值随 `PageRequest.fingerprint` 传入，适配器不碰窗口。

取不到时**如实上报**而不是关闭路线：没有 debug 扩展就用遮蔽后的 `RENDERER` / `VENDOR`，完全没有 WebGL 上下文就报空串。这是这台机器能说的全部，而接口接受它（见已知限制 13）。早先的实现要求拿到真实渲染器、否则抛错，结果在一台 WebGL 不可用的 Linux 机器上把哔哩哔哩整条路线关死了 —— 而这个门槛对着的是一组根本不校验值的参数。

在隔离的匿名上下文里逐项实测（每组变体前后都夹一次完整参数的对照请求）：

| 变体 | 结果 |
| --- | --- |
| 删掉 `dm_img_inter` | 412（三次，每次旁边的对照都通过） |
| 删掉 `dm_img_list` | 412 |
| `dm_img_inter` 换成本实现填的 `{"ds":[],"wh":[1280,900,0],"of":[0,0,0]}` | `code: 0`，40 条 |
| `dm_cover_img_str` 换成另一张显卡（NVIDIA）的字符串 | `code: 0`，40 条 |

结论：**校验的是"在不在"，不是"对不对"。** 值本身不被核对。

那为什么还去读真实值？因为写死一个常量意味着全体安装共用同一个指纹，这本身就是让这批客户端可被识别的特征。读一次本机的真值代价是每次运行一个空白窗口，换来的是这个字段不撒谎。

代价是：**没有 WebGL 的机器上快路线会整体关闭**（`fetchPage` 抛错、退回页面抓取），尽管理论上随便填一个合理字符串就能过。这是有意选择，退化路径仍然出结果。

**登录之后这套要求整体消失。** 同一 profile、同一时刻，用已登录 cookie 实测四组参数集：全量（含 `dm_*`）、去掉全部 `dm_*`、本次改动前的旧参数集、以及只有 `{mid, pn, ps, order}` 的最小集 —— **四组全部返回 `code: 0`**。也就是说这条快路线对已登录用户一直是通的，坏掉的只有匿名场景。

因此仍然发 `dm_*`：页面无论登录与否都发，跟着页面走在两种状态下都成立，而客户端不能假定用户已登录（`sites()` 的注释也写了，有 cookie 不等于已登录）。

其余参数与页面自己发的那一份对齐：`ps=40`、`tid=0`、`index=0`、`keyword=`、`special_type=`、`order_avoided=true`、`web_location=333.1387`（不是 `1550101`），外加 `x-bili-locale-json` 与 `x-bili-device-req-json`。语言字段由 `PageRequest.locale` 决定，以免它和会话的 `Accept-Language` 互相矛盾。

三个易错点写在代码注释里：`video_review` 是弹幕数而非评论数；Referer 必须通过 fetch 的 `referrer` 选项传递，手工设置的 Referer 头会在发出前被剥掉；`dm_cover_img_str` 不截断就是另一个字符串。

`entryUrl` 给出 `/{mid}/upload/video` —— 站点本来就把 `/{mid}/video` 302 到这里。

风控拒绝（`-352`、`-799`）作为错误抛出，而不是被读成"这个主页没有作品"。

### 2.2 YouTube

`listings/youtube.ts`。没有公开列表接口，流程是：

1. 抓取频道 `/videos` 页面 HTML（附 `hl=en&gl=US`，让计数以 `1,234 views` 这类固定格式返回）。
2. 用括号配平从 HTML 中取出 `ytInitialData`（`embeddedJson`）。正则会在第一个含 `};` 的视频标题处提前截断，所以必须逐字符配平并跳过字符串字面量。
3. 从选中页签的 `richGridRenderer.contents` 中收集条目，同时取出 continuation token。
4. 第 N 页：带 token POST `/youtubei/v1/browse`（`key` 与 `clientVersion` 均从页面 HTML 中提取），逐页前进，途中各页读完即丢，只返回目标页。

频道页给出的 `key`、`clientVersion`、频道名在读这份列表期间都不会变，所以和**每页结束时的 continuation token** 一起缓存（`walked`，`tokens.get(n)` 是取第 n+1 页的那个 token）。于是顺序前进只发 **1 次** POST —— 连频道页 HTML 都不用再抓。只有首次读或跳进未读区段才走完整流程。换个频道就整体替换。

支持三种条目形态，它们会同时出现在不同页签和不同版本的响应里：

- `lockupViewModel`：当前频道栅格。标题、播放量、时长分别在 `metadata.lockupMetadataViewModel`、`metadataRows` 与缩略图角标里。
- `shortsLockupViewModel`：短片页签。id 在 `onTap.innertubeCommand.reelWatchEndpoint.videoId`，标题与播放量在 `overlayMetadata`。
- `videoRenderer`：旧版渲染器，搜索与部分页签仍在使用。

**实现中最隐蔽的一个坑**：频道页里有多个 shelf 各自携带 continuation token，若在整份 `ytInitialData` 上深度遍历并取"最后一个" token，拿到的不是栅格的那个，接口会回 400。因此 `fetchPage` 只在选中页签的栅格范围内取 token（`gridOf`），continuation 响应也只在 `appendContinuationItemsAction.continuationItems` 范围内取（`appendedOf`）。

发布时间只有相对文本（`4 days ago`），无法还原为确切时间戳，因此不填 `publishedAt`，而不是猜一个。标题由栅格自身截断（长标题以 `...` 结尾），这是页面给出的全部信息。

### 2.3 抖音

`listings/douyin.ts`。走 `/aweme/v1/web/aweme/post/`。

页面真实请求带 `a_bogus`、`msToken`、`x-secsdk-web-signature`、`verifyFp`，全部由混淆脚本计算。**一个都不用复现** —— 抖音的安全 SDK **改写了页面的 `window.fetch`**（实测 `String(window.fetch)` 里没有 `[native code]`），所以页内发出的请求在出门时被自动签名。

实测：只带业务参数与设备描述、**不带任何签名字段**的调用返回 `status_code: 0` 与整页作品。这正是小红书做不到的那一点（见 2.4），差别在于抖音钩的是全局原生 `fetch`，而小红书钩的是它自己的 HTTP 客户端。

几个字段上的决定：

- `statistics.play_count` 在 web 列表里**恒为 0**，因此不填 `views`。给一个 40 万赞的作品标"0 播放"比什么都不标更糟。
- 图文帖（`images` 非空）链接成 `/note/<id>`，视频链接成 `/video/<id>` —— 跟页面自己的 `<a>` 一致，省掉一次重定向。
- `video.duration` 单位是毫秒，图文帖为 0，换算后留空。
- 屏幕与视口尺寸**故意不发**。精简参数集已被接受，而主进程编不出真实的屏幕尺寸。

分页按 `max_cursor` 游标推进。模块内记住**每一页结束时的游标**（`walked`），所以：

- 顺序前进（读过第 N 页再要第 N+1 页）只发 **1 次**请求
- 往回翻也只从前一页的游标走 1 次
- 只有跳进从未读过的区段才需要走完中间各页

换个主页就整体替换 —— 屏幕上同时只可能有一个列表。没有这层缓存时，顺序翻到第 N 页累计要发 N(N+1)/2 次请求，每次之间还各带一个节奏间隔。

**匿名只能拿第 1 页。** 第 2 页返回只有 `status_code` 的空信封（页面自己那次请求的响应头里是 `whale-decision-custom: black_no_login`）。这种情况抛出明确的登录提示，而不是报成"这个作者没有更多作品"。

### 2.4 小红书（已停用）

`listings/xiaohongshu.ts` 完整保留但**不注册**，并由 `parser.ts` 的 `REFUSED` 清单直接拒绝，错误信息为"暂不支持小红书主页解析，请改用单篇笔记链接"。

原因：小红书每个 API 调用都带 `x-s` 签名，由页面内混淆脚本计算。**页内 fetch 也救不了它** —— 它的拦截器装在自己的 HTTP 客户端上，不拦原生 `fetch`，所以从页面里直接调接口同样缺 `x-s`。上游 MediaCrawler 的做法是用纯算法重写签名（`sign_with_xhshow`），而不是在页面里求值；模块名 `playwright_sign` 说明页面求值那条路以前有过、后来被替换掉了。抛普通 `Error` 而非 `LoginRequired`，界面因此显示为错误而不是引导用户去登录。单篇笔记链接不受影响。

## 3. 分页语义

`shared/contracts.ts` 的 `Pagination` 为 `{ index, size, total?, hasMore }`。

- 哔哩哔哩：接口返回总数，`total` 真实可用；一页 40 条，与页面自己请求的份量一致。
- YouTube：无总数，`hasMore` 取决于是否还有 continuation token；`size` 上报该页实际条数——短片一次返回 48 条，影片 30 条，写死常量会撒谎。

解析结果最多保留 500 条（`parser.ts`），单次 yt-dlp 展开最多 100 条（`services/media.ts` 的 `flattenEntries`）。

## 4. 请求节奏

`electron/services/listings/pace.ts`。固定间隔与连发请求是风控最容易识别的特征之一，所有等待因此都取随机值，并且全部挂在解析自身的 `AbortSignal` 上——取消必须立即返回，不能让用户等完一个正在进行的停顿。

`Pace` 按 host 排队，`pace.wrap(fetch)` 把一个 fetcher 挂进来：

| 参数 | 取值 |
| --- | --- |
| 同 host 相邻请求间隔 | 900–2400 ms，首个请求不等待 |
| 逐次递增 | 间隔 × (1 + 0.15 × (n − 1))，上限 5000 ms |
| 随机长停顿 | 10% 概率额外 3000–7000 ms，**仅在连发第 3 次起**（`wanderAfter`） |
| 遗忘 | 同 host 静默 60 s 后计数归零（`forget`） |

**`Pace` 实例属于 `EmbeddedBrowser`，活到进程结束，不是每次翻页新建。** 这点是改过的，原因是旧写法把节奏搞反了：

- 每次 `inspectProfile` 新建一个 `paced()` 闭包
- 于是**一次翻页内部**的游标走查被限速（本来是一个逻辑操作，被拆成几次还互相等）
- 而**连续快速翻页之间**完全不限速（新闭包，"首个请求不等待"重新生效）

也就是说：它节流了单次操作，却放过了真正像机器的行为 —— 用户连点下一页。改成长期实例后两边都对了。

配套两项：

- **`wanderAfter`**：长停顿模拟"注意力转移"，但发生在用户点了翻页正在等的时候，代价由用户承担。现在只在连发第 3 次起才考虑 —— 用户显式翻页是一次请求，碰不到；自动走查才碰得到。
- **`forget`**：长期实例不能无限递增，否则跑一小时后每个间隔都顶到 5 秒上限。静默 60 秒即视为脱离连发。

页面节奏（`PACE`）。栅格抓取删掉之后只剩两项：

| 场景 | 取值 |
| --- | --- |
| 页面加载后，问它任何事之前 | 1200–3500 ms |
| 媒体页等待播放器发起请求 | 1800–3600 ms |

所有取值都是浮点随机数，不会落在整秒上。

接入点只有一处：`EmbeddedBrowser.readListing` 把交给适配器的 fetcher 包成 `this.pace.wrap(...)`。适配器代码不感知节奏，单元测试直接调用 `fetchPage` 并传入假 fetcher，因此不受影响、不会变慢。

### 4.1 翻页为什么慢，以及改了什么

原型阶段实测过一轮（抖音创作者页，已登录，真实 Electron 窗口，驱动构建后的客户端）。`inspectProfile` 每读完一页打一行 `[listing ...]`，下面的数字都出自它 —— 要复现只需跑起客户端翻两页，看主进程输出。

改之前：

```
media:parse                                                       19478ms
  第 1 页  加载 1021ms · 停顿 1940ms · 取数 1311ms · 合计  4272ms
media:page 2                                                      12202ms
  第 2 页  加载 1080ms · 停顿 2915ms · 取数 8165ms · 合计 12160ms
media:page 3                                                      10123ms
  第 3 页  加载 1010ms · 停顿 2851ms · 取数 6216ms · 合计 10077ms
```

以第 2 页为例拆开：页面加载 1.1 s（9%）、`PACE.settle` 停顿 2.9 s（24%）、两次实际请求 1.7 s（14%）、**节奏等待 6.4 s（53%）**。

结论和直觉相反：**页面加载根本不是瓶颈**，节奏等待才是，而且方差极大（那 6.4 s 里约 5 s 是 10% 概率的长停顿正好撞上）。

三项改动：

1. **`Pace` 长期实例 + `wanderAfter`**（见上）—— 去掉了走查内部的自我节流和用户翻页时的长停顿。
2. **窗口复用**：同一个列表的连续翻页共用隐藏窗口，省掉每次的页面加载与 `PACE.settle`。见 4.2。
3. **游标缓存**：抖音与 YouTube 都是游标分页，原实现 `fetchPage(N)` 每次从第 1 页重走，顺序翻到第 N 页共发 N(N+1)/2 次请求。现在记住每页结束时的游标，顺序前进只需 1 次。见 2.2 与 2.3。

改之后：

```
media:parse                                                       21718ms
  第 1 页  预热 15116ms · 加载 1179ms · 停顿 3171ms · 取数 2151ms · 合计 21617ms
media:page 2                                                       1976ms
  第 2 页  预热 0ms · 加载 0ms · 停顿 0ms · 取数 1947ms · 合计 1947ms
media:page 3                                                       2091ms
  第 3 页  预热 0ms · 加载 0ms · 停顿 1ms · 取数 2066ms · 合计 2067ms
```

翻页 **12.2 s → 2.0 s**、**10.1 s → 2.1 s**。剩下的 2 秒里约 0.7–0.9 s 是真实网络请求，其余是同 host 间隔 —— 那是有意保留的。

**首次解析没有变快，21.7 s 里 15.1 s 是 `warm()`。** 预热要对站点首页加载最多三次，每次之间还有 1.2–3.5 s 的随机停顿（见 5.4）。这是目前最大的一块，尚未处理；它每个 host 每次运行只付一次。

## 5. 客户端身份

`electron/services/identity.ts`（纯函数，不依赖 electron，可直接单测）与 `services/browser.ts` 共同保证：客户端发出的每个请求，在 UA、语言、客户端提示、cookie 上都是同一个人。

### 5.1 User-Agent

Electron 默认 UA 同时包含应用名与 `Electron/x.y.z` 两个标记，任何一个都足以唯一标识本客户端。`chromeUserAgent()` 剥掉 `Electron/...`，并移除 `(KHTML, like Gecko)` 与 `Chrome/` 之间的应用名段，结果是该平台上一个普通 Chrome 的 UA。

### 5.2 客户端提示与 sec-fetch

页面加载由 Chromium 自动携带 `sec-ch-ua` 系列；主进程发起的 fetch 不带，却又自称 Chrome——这是自相矛盾，比什么都不声明更可疑。分区上挂 `onBeforeSendHeaders`，**仅补齐请求中缺失的字段**：

- `sec-ch-ua` / `sec-ch-ua-mobile` / `sec-ch-ua-platform`，版本号取 `process.versions.chrome`，不硬编码。
- `sec-fetch-site` / `-mode` / `-dest`，仅在请求声明了 Referer 时按同源 / 同站 / 跨站计算；没有 Referer 就不写，猜测会与请求已声明的事实冲突。

`Accept-Language` 通过 `setUserAgent(ua, acceptLanguage)` 随界面语言设定。

### 5.3 Cookie 归集

登录态很少只落在被解析的那个域上：YouTube 的账号 cookie 有一部分在 `google.com`，哔哩哔哩与抖音各有独立的登录主机。`relatedTo(url)` 给出应一并查询的地址：

| 平台 | 额外查询 |
| --- | --- |
| YouTube | `www.google.com`、`accounts.google.com` |
| 哔哩哔哩 | `www.bilibili.com`、`passport.bilibili.com` |
| 抖音 | `www.douyin.com`、`sso.douyin.com` |

列表路线与单页媒体解析两处的 cookie 归集都经由它。

### 5.4 预热访问

访客 cookie（哔哩哔哩的 `buvid3` / `bili_ticket`、YouTube 的同意与访客标识）由站点首页下发，别处不给。直接调用列表接口意味着这是本客户端对该站点发出的第一个请求，而这正是风控要找的形态。

`EmbeddedBrowser.warm(url, signal)`：当该 host 没有 cookie，或已有 cookie 中存在一小时内到期者（哔哩哔哩的 ticket 以天计），就先用隐藏窗口访问一次首页，停顿一个随机间隔后关闭。同一 host 12 小时内不重复预热。

实测补充：哔哩哔哩的访客凭据不是由 `Set-Cookie` 下发，而是页面 JavaScript **算出来**的 —— `x/frontend/finger/spi` 产出 `buvid_fp`，`Ticket/GenWebTicket`（`hexsign` 在页面内计算）产出 `bili_ticket`，再加 `gaia-gateway/ExGetAxe` 与 `ExClimbCongLing` 两步挑战。在一个全新的匿名 profile 上，**页面自己那次列表请求也会 412**，前两次加载栅格都是空的，第三次才渲染出来。

因此预热不是"访问一次就关"：只要这次访问仍在改变该 origin 的 cookie（名或值），就再加载一次，最多三次；某次访问什么都没改变就停。刚好铸造完的站点停在两次，什么都不铸造的站点也停在两次。

判据刻意只看 cookie 罐是否变化，不认任何平台的具体 cookie 名 —— "还在铸造"从外部看就是这个样子。这是启发式，不是保证：三次之后仍未就绪时，`fetchPage` 照常失败并退回页面抓取。

调用点两处：主页列表路线在调用适配器接口前；直连解析路线在构造 yt-dlp 请求前，且**仅对已知平台触发**——用户粘贴某个文件站直链时，为它加载一次首页毫无意义。

### 5.5 身份传递到下载

过去只有浏览器路线会把 cookie 与 UA 交给引擎，直连路线始终以匿名身份发出第一次请求。现在 `parser.ts` 的直连分支同样附带 `identity(url)` 的结果；由于下载源是解析请求的展开（`{ ...request }`），下载自动继承同一身份。

`main/controller.ts` 中 Parser 与 Queue 的 fetcher 也从默认 session 的 `net.fetch` 改为 `browser.fetch`（媒体分区）。图片与直链下载因此与解析同源、同 cookie、同 UA。这两处不套 `paced`：节奏控制服务于"走列表"，套在大流量传输上只会拖慢下载。

## 6. 代理

代理设置项已整体移除（`settingsSchema`、设置界面、`EngineRequest`、`engine/main.py` 的 `options['proxy']`、两处 `session.setProxy`）。所有请求跟随系统代理，这也是 Electron session 的默认行为；旧配置文件里残留的 `proxy` 键由 zod 在读取时丢弃。

一处既有的不对称需要知晓：Electron 的 session 跟随操作系统代理设置，而 yt-dlp 走 Python urllib，只识别 `HTTP_PROXY` / `HTTPS_PROXY` 环境变量。因此在"系统代理开启但未设置环境变量"的机器上，浏览器路线可达而 yt-dlp 可能不可达。本轮未处理。

## 7. 测试与实测

单元测试 35 条，6 个文件：

| 文件 | 覆盖 |
| --- | --- |
| `test/identity.test.ts` | UA 清洗、客户端提示、语言、sec-fetch 计算、关联域归集 |
| `test/pace.test.ts` | 同 host 间隔与逐次递增、跨 host 不互相阻塞、一个 `Pace` 跨多个 fetcher 保持计数并在静默后归零、取消立即返回、每段等待都是区间 |
| `test/listings.test.ts` | wbi 签名与分页、风控错误、三种 YouTube 条目形态、continuation token 取自栅格、小红书已停用但映射仍正确、显示数字解析 |
| `test/profiles.test.ts` | 实测夹具的路由标注与拒绝清单 |
| `test/media.test.ts` | 频道展平、扁平条目下载地址、直连路线携带身份 |
| `test/download.test.ts` | 队列暂停恢复、HTTP 限速与落盘一致性 |

Playwright 端到端（`pnpm test:e2e`）覆盖真实 Electron 窗口的解析与下载。


`pnpm test:live:profiles` 驱动真实 Electron 窗口打真实上游。最近一次结果（Linux/WSL，该机 **WebGL 完全不可用**，客户端分区**未登录**）：

| 平台 | 结果 |
| --- | --- |
| 哔哩哔哩 | 第 1 页 40 条全部带封面；第 2 页 40 条，与第 1 页无重叠 |
| 抖音 | 第 1 页 20 条全部带封面，图文帖正确识别为 `image`；第 2 页按预期被拒（未登录） |
| YouTube | 第 1 页 30 条全部带封面；第 2 页 30 条，与第 1 页无重叠 |

哔哩哔哩这一行同时证明了三件事：页内 fetch 端到端可用、空的图形栈字符串被风控接受、翻页正确。抖音那一行证明了第四件：**签名可以完全交给页面** —— 客户端一个字节的 `a_bogus` 都没算。

针对 YouTube 适配器的联网实测结果：

- `@Fatcat996` 影片页：第 1 页 30 条、第 2 页 30 条且与第 1 页无重叠、第 3 页 11 条后 `hasMore` 为 false。
- `@MrBeast` 短片页：每页 48 条，翻页无重叠。
- 经 `paced` 包装后走到第 3 页：三次请求间隔 2586 ms 与 2167 ms，总耗时约 4.9 秒，结果正确。

## 8. 已知限制

1. **yt-dlp 的 TLS 指纹**：Python urllib 的 JA3/JA4 明显不是浏览器。唯一根治方式是在引擎中引入 `curl_cffi` 并启用 yt-dlp 的 `impersonate`，代价是三平台各增加十余 MB 的原生二进制与相应回归验证。本轮未做，理由是列表解析已走真实 Chromium，而 yt-dlp 主要面对的 CDN 端点对指纹敏感度较低。
2. **小红书主页**不支持，见 2.4。
3. **YouTube 标题截断**：栅格给出的标题本身已被截断，文件名会随之变短。取回完整标题需要额外请求每个视频的观看页。
4. **播放量为显示值**：`247K views` 解析为 247000，并非精确计数。
5. **`Accept-Language` 在 session 首次准备时设定**，运行中切换界面语言需重启生效。
6. **`sec-ch-ua` 中的 GREASE 品牌串是近似值**，真实 Chrome 该字段随版本变化；仅在请求未声明时补齐。
7. **cookie 与 UA 对受限内容的实际效果未实测**，需要已登录账号在真机验证。
8. **节奏不是保证**：时序只是风控信号之一，权重低于出口 IP 信誉与 TLS 指纹。本轮降低的是"高频扫库"这一类特征。
9. **风控要求随登录态变化**：上面 2.1 记的四组实测是在**已登录**下做的，全通；匿名下旧参数集回 `-352`。也就是说这套参数集是按更严的匿名场景定的，对登录用户属于冗余但无害。两种状态下的完整矩阵没有逐格测全。
10. **`dm_img_inter` 的语义仍未知**，只是不再影响实现：页面发的是 `{"ds":[],"wh":[3841,2942,87],"of":[309,618,309]}`，在 929×861 的视口下与视口尺寸没有明显对应关系。已测出的是**它必须存在、但内容不被核对**（见 2.1 的表），所以实现按同样三槽结构填窗口真实尺寸即可，语义无需破解。
11. **风控失败是粘性的，且批次首发容易假阴性**：一次请求被拒之后，紧接着的合法请求也常返回 412；此外每轮实测的**第一个**请求出现过无故 412 而其后同形请求全通。因此单次 412 不能作为结论，2.1 的每组变体都夹了前后对照。这也是单路线设计的一条理由：既然失败会短时下毒，"被拒就换个方式再来一次"本来就大概率再失败一次。重试策略尚未针对这一点设计。
12. **抖音第 2 页起需要登录**：匿名下接口返回只有 `status_code` 的空信封，见 2.3。第 1 页匿名可用。这不是本客户端能绕开的，实测探针对标了 `needsSignIn` 的夹具容忍这一种失败，但会把它打印出来。
13. **没有 WebGL 的机器如实上报空字符串**：实测空的 `dm_img_str` / `dm_cover_img_str` 被接受（匿名下返回 `code: 0`，40 条），与"只校验存在"一致。但这条只成功观测到一次，同一轮里的第二次重复出现 412，而 412 在这个接口上有已知的批次首发假阴性（见第 11 条），所以结论的置信度低于"值不被校验"那条。真机联网实测（见第 7 节）在一台没有 WebGL 的机器上匿名取回了 40 条，算是第二个支持点。
14. **冷 profile 的预热是启发式**：`warm()` 现在按"cookie 罐还在变就再加载一次，最多三次"收敛（见 5.4），匹配实测到的三次加载。但收敛判据是 cookie 变化，不是"握手确实完成"；三次之后仍未就绪的站点会让 `fetchPage` 直接失败，身后没有别的路线接着。代价是冷站点预热从一次页面加载变成两到三次。

## 9. 文件索引

| 文件 | 职责 |
| --- | --- |
| `electron/services/listings/types.ts` | 适配器契约与列表数据结构 |
| `electron/services/listings/index.ts` | 适配器注册与查找 |
| `electron/services/listings/bilibili.ts` | 哔哩哔哩投稿列表 |
| `electron/services/listings/douyin.ts` | 抖音作品列表 |
| `electron/services/listings/wbi.ts` | wbi 签名 |
| `electron/services/listings/youtube.ts` | YouTube 频道列表 |
| `electron/services/listings/xiaohongshu.ts` | 小红书列表（保留未启用） |
| `electron/services/listings/text.ts` | 时长与计数的显示串解析 |
| `electron/services/listings/pace.ts` | 请求与页面节奏 |
| `electron/services/identity.ts` | UA、语言、客户端提示、关联域 |
| `electron/services/browser.ts` | 分区会话、页内 fetcher、列表抓取、单页媒体解析、身份与预热 |
| `electron/services/parser.ts` | 路线分流、拒绝清单、下载源构造 |
