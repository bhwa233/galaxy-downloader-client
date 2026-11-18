# 合集与分P 支持（哔哩哔哩、抖音、YouTube）

本文是实施清单。目标：粘一个视频链接时，如果它是多P 视频或属于某个合集，客户端把这些内容列出来供选择下载；粘一个合集链接时，列出该合集本身，而不是该作者的全部作品。

哔哩哔哩的部分（第 1 至 5 节）三个上游接口都已实测可用，可以直接动手。抖音的部分（第 6 节）在客户端外无法验证，必须先在应用内浏览器里跑通第 6.3 节那几个问题，再写实现。YouTube（第 7 节）今天就能用，只剩一个上限问题要处理。

## 1. 现状

以下都是实测结论，不是推断。

| 场景 | 今天的行为 | 依据 |
| --- | --- | --- |
| 分P 视频（`/video/BVxxx`，不带 `?p=`） | 能用。yt-dlp 把它当 playlist 展开，但扁平条目的 `title`、`duration` 全是 `null` | `BV1bK411W797` 扁平解析得到 23 条，`title` 全空 |
| ↑ 代价 | `parser.ts` 的兜底判断命中，改用 `flat: false` 重抽一遍：5 个分P 花 3.9 秒，23 个约 18 秒 | 同上，两次实测 |
| 合集链接（`space.bilibili.com/<mid>/lists/<sid>`） | 被主页适配器吞掉。`listings/bilibili.ts` 的 `matches()` 只检查 host 与路径开头的数字，`sid` 被丢弃，最终调的是投稿列表接口 | 代码 |
| 视频所属合集（`ugc_season`） | 无任何支持，yt-dlp 也不展开 | yt-dlp `BiliBiliIE` 只读取 season 元数据 |

三个上游接口都验过，匿名、无 cookie、无 wbi 签名即可调用，只需带 `Referer`：

- `x/web-interface/wbi/view?bvid=` —— 一次同时给出 `pages[]`（分P）与 `ugc_season`（合集元信息与 episodes）
- `x/player/pagelist?bvid=` —— 分P 全量，含 `part` 原名与 `duration`，一次返回（82 个分P 也是一次）
- `x/polymer/web-space/seasons_archives_list?mid=&season_id=&page_num=&page_size=30` —— 合集条目，含标题、封面、时长、播放数、`pubdate`，`page.total` 给总数

## 2. 路由（哔哩哔哩）

解析入口仍然是 `electron/services/parser.ts`，只有两种入口链接：

| 粘进来的 | 走哪条 | 结果 |
| --- | --- | --- |
| `space.bilibili.com/<mid>` 主页 | 现有主页适配器 | 全部投稿，行为不变 |
| `bilibili.com/video/BVxxx` | 先打一次 `wbi/view` | 见下 |
| `space.bilibili.com/<mid>/lists/<sid>` 等合集链接 | 新增合集适配器 | 该合集的条目 |

视频链接拿到 `wbi/view` 之后：

- `pages.length > 1` —— 列分P，标题取 `part` 原名，不加序号前缀
- 单P 且存在 `ugc_season` —— 先列**单视频**这一个条目，再列合集条目；两个 tab，默认开单视频（见第 3 节）
- 多P 且存在 `ugc_season` —— 多P 与合集两个 tab，默认开多P
- 都没有 —— **放弃**，回落到现在的引擎直解，行为与今天完全一致

合集条目直接从同一次回复的 `data.ugc_season.sections[].episodes[]` 构造（`arc` 带标题、封面、时长、播放数、发布时间），所以「视频所属合集」这条路**不再**额外调 `seasons_archives_list`；只有 `episodes` 缺失时才回落到那个分页接口。

普通单视频因此多付一次 `wbi/view`；多P 视频反过来省掉今天那 18 秒的全量重抽。

**这里的代价比原先估的 0.3 秒高，实现时才看清。** 适配器的请求只能从站内页面里发出（见 `browser.ts` 的 `readListing`），所以单视频要付的是「开隐藏窗口 + 加载视频页 + 停顿 + 一次接口」，不是一次裸的 API 调用。窗口在 5 分钟内复用，预热本来也要付，但首次仍是秒级而非亚秒级。要把它压回 0.3 秒，得让 `wbi/view` 从主进程的 session 直接发出——第 1 节说这三个接口匿名带 Referer 即可，但那是在浏览器里验的，主进程直发尚未实测，所以没有这么做。

「放弃」是现在的 `ProfileAdapter` 接口没有的语义：适配器匹配了 URL，但读完之后判断自己不该接管。接口需要表达这一点，否则单P 视频会被困在列表路线里。

## 3. 展示

结果区的 tab 规则（2026-10-31 起，11-01 收敛文案）：

| 粘进来的 | tab | 默认打开 |
| --- | --- | --- |
| 单P 视频，属于某合集 | `单视频` + `合集`（徽章 `59/72`） | 单视频 |
| 多P 视频，属于某合集 | `多P` + `合集`（徽章 `N` / `1/17`） | 多P |
| 单P 视频，不属于合集 | 不出 tab（回落引擎） | — |
| 多P 视频，不属于合集 | 不出 tab，直接列分P | — |
| 已带 `?p=` 的多P 视频 | 不出 tab，只解析该分P（用户已指定） | — |

- 为什么「单视频」而不是把合集排第一：粘单支视频链接的人要的就是这一支。合集有几十上百条时，原视频按发布时间排在中间（样本 `BV19dx369EDD` 在第 59 条），既不好找，也会被默认选中坑到——旧行为默认勾选合集第一条，「下载」下的是别的视频。
- **单视频与多P 不并排成两个 tab**：同一个 BV 只有一种形态，多P 视频本身没有「整部可单独下载」的条目（按 BV 下整部会产出 N 个分P 文件），所以多P 时 `多P` 就代表它自己，单P 时 `单视频` 代表它自己。三个 tab 的方案因此否决。
- 合集 tab 的条目来自同一次 `wbi/view` 的 `ugc_season` 全量，`pagination` 是 `{index:1, size:N, total:N, hasMore:false}`，没有「加载更多」。因此切 tab 不重新请求，也不做「切到 tab 再解析」的懒加载：数据在回复里已经拿到了，懒加载只会把同一次请求推后，还要多一个「tab 未加载」状态。
- **长列表分批挂载**（2026-11-01）：合集一次给全之后，结果区只先挂 120 张卡，滚到底部前 320px 时再挂下一批，直到全部挂完（`src/components/ui/in-view.tsx` 的 `InView`，底层是 `react-intersection-observer`）；浏览器没有 `IntersectionObserver` 时退化成底部一个「加载更多」按钮。实测 494 条合集：全量挂载滚动 `p50` 18–24ms/帧、主线程 100% 饱和；首屏 120 张时 `p50` 6–12ms，DOM 节点 11075 → 2727。取舍是滚到后面挂载数仍会累积回全部，真正封顶要靠虚拟化（没做）；全选、下载、筛选仍按整个 `visible` 算，没挂载的条目也会被选中。
- 合集里与当前视频同一个 BV 的条目打「原视频」角标（`MediaItem.mark`）。条目形态不变，id 仍是 `bvid`。
- 单视频条目 id 是 `<bvid>-p1`（多P 时沿用 `<bvid>-p<n>` 的分P 组），与合集里的 `bvid` 不撞。
- 结果超过 500 条时按既有 `MOST` 截断，并设 `MediaResult.truncated`（复用结果区「只列出了前 N 条」的提示）；合集链接那条路仍按 30 条一页翻。
- 跨 tab 的选择保留，「下载所选 (N)」是两个 tab 的合计；分页归属跟着 tab 走（合集链接仍分页，视频页的合集会一次给全）。
- **徽章只说位置，不说数量。**「单视频」不挂徽章；合集/多P 的徽章是「这条视频在其中第几条 / 共几条」（`59/72`），因为列表有多长在副标题里已经说了。抖音合集的游标不报总数，所以只有在整段一次给完（`hasMore:false`）时才给位置。
- **有多个 tab 时不显示结果区的大标题**：粘进来的就是这一条，标题与下面那张卡片重复，tab 自己已经说明了有什么。副标题「平台 · 共 N 项，已加载 N 项」挪到 tab 条下方，跟着 多P/合集 tab 走；「单视频」tab 只有一张卡，不显示。
- **tab 条与按钮同排**（2026-11-01）：tab 不再单独占一行，而是与 关键字 / 时间 / 视图 / 关闭 同排——tab 在左、按钮在右，没有 tab 时这一行仍是标题。
- **只看只在列表真的混着图文与视频时出现**（2026-11-01）：纯视频列表（视频页的 多P/合集、UP 主页）没有可筛的东西，`图片` 在那里只能等于「把每张封面各入队一个任务」，所以不显示；图文与视频混排的列表（抖音主页、X / Instagram 单帖等）照旧显示，仍同时作用于显示与全选。单个作品的卡片仍有右键「下载封面」。
- **时长与 时间 并排**（2026-11-01）：三档 —— 1 分钟以内（`d ≤ 60`）、1–10 分钟（`60 < d < 600`）、10 分钟以上（`d ≥ 600`），外加「自定义…」：对话框按分钟填「最短 / 最长」，留空表示不限，两端都包含，最短填得比最长大会自动对调。只在列表状态、当前 tab 带时长的条目超过一条、且长度能分出差别时出现（两档非空，或长度不完全相同——后者是给自定义留的入口）；不满足时控件隐藏且筛不生效，与「只看」同一套写法。与 关键字 / 时间 / 只看 按 AND 组合，同时作用于显示与全选；平台没给时长的条目在筛选开启时被排除（无法证明在区间内）。所选只属于本次结果，解析新结果或清除后回到「全部时长」。
- 合集链接、UP 主页这类只有一个列表的结果不受影响：标题与副标题仍在原来的位置。

### tab 只写类型词

tab 文案不再由各适配器拼字符串，而是由组上的 `kind` 决定（`shared/contracts.ts` 的 `GroupKind`），渲染层查 `result.json` 的 `groups.*`：

| `kind` | 中文 | 英文 | 谁在用 |
| --- | --- | --- | --- |
| `work` | 单视频 | Single video | 哔哩哔哩视频页、抖音作品页 |
| `parts` | 多P | Multi-part | 哔哩哔哩多P 视频 |
| `collection` | 合集 | Collection | 哔哩哔哩合集/系列/番剧、抖音合集 |
| `files` | 文件 | Files | X / Instagram 单帖的图片视频列表 |
| `uploads` | 作品 | Posts | 各平台作者主页（哔哩哔哩投稿、抖音作品、YouTube 频道、微博、公众号） |
| `shorts` | 短视频 | Shorts | 预留：YouTube 频道的 Shorts 列表 |
| `streams` | 直播 | Streams | 预留：频道/主播的直播列表 |
| `shows` | 短剧 | Shows | 抖音短剧目录 |

- 列表自己的名字（合集名、视频标题）留在组的 `title` 里，只作为 tab 的 `title` 悬停提示（如「合集 · 小松绿💚」），不进 tab 文案——名字长短差太多，写进 tab 会把 tab 条撑乱。
- `kind` 是可选的：没有 `kind` 的组仍显示自己的 `title`，所以单列表结果（只有一个组、根本不出 tab 条）与旧适配器行为不变。
- 新增平台/新列表类型时先在这里挑一个 `kind`；确实没有合适的再加词条，不要为某个平台临时拼中文。
- 已知代价：`kind` 只选词不选语言，适配器不再关心界面语言；悬停提示仍是适配器给的原文。

### id 冲突

`ugc_season` 的 episodes **包含当前视频自己**（实测：`BV1Ps421u7ju` 出现在《少女乐队》的 3 集里）。合集条目用 `bvid` 作 id 时，分P 条目必须用别的形式（如 `<bvid>-p<n>`），否则同一个 BV 在两个 tab 里撞 id，选择状态和 `catalog` 都会串。

视频页现在正是这么做的：单视频组用 `<bvid>-p1`，合集条目用 `bvid`；抖音同理，单视频组用 `<aweme_id>-work`。

### 抖音作品与合集

抖音作品页读到 `mix_info.mix_id` 时同样出 单视频 + 合集 两个 tab（`kind` 与哔哩哔哩共用，所以抖音的作品也叫「单视频」，不再有「本作品」这套词），默认单视频；合集里同一个作品打「原作品」角标，单视频条目 id 是 `<aweme_id>-work`。改法与哔哩哔哩同批，尚未在登录账号下复验（需要客户端 `persist:media` 会话里的真实响应）。

## 4. 落盘

合集与分P 的任务保存到以合集名（分P 用父视频标题）命名的子目录：

- 目录名走与文件名同一套清洗（`queue.ts` 的 `filename()`：去掉 `<>:"/\|?*` 与控制字符，截 100 码点）
- 单个作品、单P 视频不建目录，维持现状
- 与 `organizeByPlatform` 叠加时顺序为 `<下载目录>/<平台>/<合集名>/`
- 新增设置项 `organizeByCollection`，默认 `true`，位置在 `shared/contracts.ts` 的 `organizeByPlatform` 旁边，UI 放在「文件与媒体」页紧随「按平台创建子目录」
- 该合集最后一个任务被删除后，若目录为空则一并清理

`job.directory` 本来就是每个任务自己的字段，因此 `queue.discard()` 的 `readdir(job.directory)` + stem 前缀查残留、以及「打开文件位置」的 `dirname(file) === job.directory` 校验都原样成立。

## 5. 任务清单

按此顺序做，每一步都能单独验证。

- [x] **1. 适配器接口支持「放弃」**。`listings/types.ts` 的 `fetchPage` 增加一种返回，表示「匹配了但不接管」；`parser.ts` 收到它时回落引擎直解。先用主页适配器验证不受影响。
- [x] **2. 主页适配器停止劫持合集链接**。`listings/bilibili.ts` 的 `matches()` 排除 `/lists/`、`/channel/collectiondetail`、`/channel/seriesdetail`、`/favlist`。验收：粘合集链接不再列出全部投稿。
- [x] **3. 新增合集适配器**。认第 2 步排除掉的那几种路径，`fetchPage` 调 `seasons_archives_list`（合集）与 `series/archives`（系列），转成 `ListingEntry[]`，在 `listings/index.ts` 注册。验收：两条样本合集列出正确的条目数与标题。
- [x] **4. 视频链接走 `wbi/view`**。分P 直接取 `wbi/view` 自带的 `pages[]`（id 形如 `<bvid>-p<n>`，标题取 `part`），因此没有再调 `pagelist`；有 `ugc_season` 时复用第 3 步的拉取出合集条目，都没有则放弃回落。带 `?p=` 的链接是用户已经指定的那一P，不接管。
- [x] **5. `MediaResult` 表达分组与 tab**。`profile: boolean` 换成 `listing: 'profile' | 'collection'` 加 `groups: MediaGroup[]`；三处读它的地方都已跟上（结果区列表态、`queue.enqueue` 的 `itemId`、空列表文案）。分页从 `MediaResult` 移到 `MediaGroup`，`media:page` 增加 `groupId`。
- [x] **6. 结果区 tab**。两者都有时出现，切换不发请求，选择跨 tab 保留。
- [x] **7. 子目录与 `organizeByCollection`**。默认开，UI 在「文件与媒体」页紧随「按平台创建子目录」，叠加顺序 `<下载目录>/<平台>/<合集名>/`，删任务后空目录一并清理。
- [ ] **8. 抖音：在应用内浏览器里回答第 6.3 节的四个问题**。**仍然没做，而后面几步是在没有它的情况下写的**——接口与字段按 `aweme/post/` 那条的形状推出来，全部写成「响应形状不符就放弃」。这一步做完之后，应该拿真实响应校对第 9–12 步，并把本文 6.2 的「待验证」改成实测结果。
- [x] **9. 抖音合集适配器**（`douyinCollection`）。认 `douyin.com/collection/<mix_id>` 与 `/mix/detail/<id>`，`fetchPage` 调 `mix/aweme`，游标分页复用 `resume()`，条目构造复用 `entryOf()`。**未验证**，验收仍待第 8 步。
- [x] **10. 抖音视频页 → 所属合集**（`douyinVideo`）。`aweme/detail/` 里读到 `mix_info.mix_id` 就走第 9 步，读不到就放弃回落，行为与今天一致。与哔哩哔哩共用第 1 步的放弃语义。**未验证**。
- [x] **11. 抖音用户页按 tab 分流**。三处都改了：`entryUrl()` 保留原本的 `showTab`，`fetchPage` 按 tab 选接口，游标缓存键是 `sec_user_id|tab`。有单元测试钉住「粘喜欢链接打的是 favorite 接口」与「游标不串」。**喜欢与推荐两个接口名未验证**。
- [x] **12. 抖音 `user/self`**。从页面 storage 里找本人的 `sec_user_id`；取不到就报 `LoginRequired`，且**一个请求都不发**——有测试钉住这一点。
- [x] **13. 引擎路线的 100 条上限**。上限本身没动（`engine/main.py` 的 `playlistend: 100` 与 `media.ts` 的 `ENTRY_LIMIT`），改为不再静默：撞上限的结果带 `truncated`，结果区显示「只列出了前 100 条」，平台给了总数就一并说出来。
- [x] **14. 测试**。哔哩哔哩：合集/系列/视频页的 URL 匹配与放弃分支、`ugc_season` 与 `pages` 的条目构造、两个 tab 的 id 不冲突、翻一个 tab 不动另一个、子目录路径拼接与开关关闭时的回退。抖音与新增平台（`test/platforms.test.ts`）：各自认领哪些地址、单个作品留给引擎、**不认识的响应一律放弃而不是猜**、`showTab` 分流与游标键隔离、`user/self` 不发请求就报登录。`mix` 的条目构造复用 `entryOf()`，由既有测试覆盖。

- [x] **15. 视频链接优先列原视频**（2026-10-31）。单P + 合集时本视频组排第一并默认打开（原先默认勾选合集第一条，点下载会下错视频）；合集条目改由 `ugc_season` 全量构造（`arc` 缺失逐条兜底，`episodes` 整段缺失才回落 `seasons_archives_list` 分页），合集里同 BV 的条目打「原视频」角标（`MediaItem.mark`）；结果超过 500 条时走既有 `truncated` 提示；抖音作品页同批出「本作品」+ 合集。既有 `test/collections.test.ts` 的旧断言已于 2026-11-01 按用户授权更新：单视频在合集之前，首组指向原视频且无后续页，合集保留分页；0.6.0 回归 66 项单测通过。
- [x] **16. tab 与头部的显示收敛**（2026-11-01）。`ListingGroup`/`MediaGroup` 增加 `position: {index,total}`（哔哩哔哩来自 `ugc_season` 的下标，抖音来自整段一次给完的合集），tab 徽章改成 `59/72`；「本视频」不再带集数也不再挂徽章；有多个 tab 时结果区不显示大标题，副标题挪到 tab 条下方、只在 分P/合集 tab 显示（`Result.tsx`）。真实窗口复验：两个 tab「本视频」/「小松绿💚 59/72」，合集 tab 下显示「哔哩哔哩 · 共 72 项，已加载 72 项」。

## 6. 抖音：合集与喜欢列表

### 6.1 现状

| 事实 | 依据 |
| --- | --- |
| yt-dlp 帮不上忙 | `DouyinIE` 只认 `/video/<id>`，没有合集提取器；而且实测对样本链接直接拒绝：`Fresh cookies (not necessarily logged in) are needed` |
| `bhwa233-download-api` 也没有 | `mix_id`、`mix_info`、`/collection/` 全仓库零命中，抖音解析器只处理单条视频、图文和音乐 |
| 匿名抓页面拿不到数据 | 样本链接匿名请求返回 72 KB 的壳页面，`mix_info`、`_ROUTER_DATA` 等关键字出现次数全是 0，数据不在首屏 HTML 里 |
| 喜欢、推荐列表被当成投稿列表 | `listings/douyin.ts` 的 `matches()` 只看 host 与 `/user/<something>`，`?showTab=like`、`?showTab=recommend` 照样命中；随后 `entryUrl()` 把 `showTab` 强行改成 `post`，`fetchPage` 调的是 `aweme/post/`。结果是粘喜欢或推荐链接，列出的都是该用户的投稿 | 代码 |
| `user/self` 没有 `sec_user_id` | 同一段正则会把路径里的 `self` 当成用户标识交给接口，那不是一个有效的 `sec_user_id`；这个地址天然只对已登录的本人有意义 | 代码 |

结论：抖音这三件事只有一条路——在应用内浏览器的页面里调站方接口，也就是 `listings/douyin.ts` 已经在用的那条路（页面里的 `window.fetch` 被安全 SDK 接管，请求出站时自动签名，主进程不需要复现 `a_bogus`）。合集换一个接口，喜欢和推荐换接口并且别改 `showTab`。

### 6.2 设计

与哔哩哔哩共用第 3 节的展示规则、第 4 节的落盘规则和第 1 步的放弃语义，只有数据来源不同：

- 合集列表接口预计是 `https://www.douyin.com/aweme/v1/web/mix/aweme/?mix_id=<id>&cursor=<n>&count=<n>`，参数里的客户端描述符沿用 `listings/douyin.ts` 的 `CLIENT` 常量
- 分页是游标式，与主页列表相同，因此 `resume()` 那套「记住每页结束游标，翻下一页只付一次请求」可以照搬
- 条目构造直接复用同文件的 `entryOf()`：合集条目、喜欢、推荐和主页作品都是同一种 `aweme`，视频与图文的区分、封面、时长、点赞数的读法都一样
- 视频页归属合集的判断来自作品详情里的合集字段，读不到就放弃，回落到今天的解析路线

用户页三个 tab（作品、喜欢、推荐）是同一个适配器按 `showTab` 分流，不是三个适配器：

| `showTab` | 接口 | 状态 |
| --- | --- | --- |
| `post`（默认） | `aweme/v1/web/aweme/post/` | 已实现 |
| `like` | 预计 `aweme/v1/web/aweme/favorite/`，参数形状与 `post` 同族 | 待验证 |
| `recommend` | 未知，见 6.3 | 待验证 |

三处必须跟着改：

- `entryUrl()` 现在无条件写 `showTab=post`，要改成保留地址原本的 tab，只有缺省时才补 `post`
- `resume()` 的游标缓存键现在只有 `sec_user_id`，加了 tab 之后同一个用户的不同 tab 会互相污染游标，键要带上 tab
- `matches()` 现在把 `/user/self` 里的 `self` 当作用户标识。`user/self` 是已登录本人的页面，没有 `sec_user_id`，要么从页面里取到本人的标识，要么用不需要它的接口；取不到就按 `LoginRequired` 报，而不是拿 `self` 去调接口

### 6.3 动手前必须在应用内浏览器里确认的事

合集：

1. **合集链接长什么样**。`douyin.com/collection/<mix_id>` 是否是页面自己用的形状，还是只在分享链接里出现
2. **`mix_id` 从哪里拿**。作品详情接口里合集字段的确切路径，以及一个属于合集的作品是否一定带它
3. **分页字段**。`mix/aweme` 的响应用 `cursor` / `has_more` 还是别的名字，一页实际返回多少条

喜欢与推荐：

4. **喜欢列表的接口与参数**。是否就是 `aweme/favorite/`，参数是否与 `post/` 同族（`sec_user_id` + `max_cursor` + `count`）
5. **喜欢不公开时的响应**。抖音允许用户隐藏喜欢列表，那种情况下是空列表、错误码还是别的形状——决定客户端该报"对方未公开喜欢列表"还是报登录
6. **推荐列表的接口**。`showTab=recommend` 到底打的是哪个接口，参数和游标字段是什么；它是否每次返回都不同（像 YouTube 的 Mix 那样即时生成）
7. **`user/self` 怎么解析**。本人标识从哪里读（页面状态、某个接口的响应，还是根本不需要），未登录时应当直接报 `LoginRequired`

共通：

8. **登录门槛**。主页列表从第 2 页起会被 `black_no_login` 挡住（`listings/douyin.ts` 里已按 `LoginRequired` 处理），合集、喜欢、推荐各自是否同样，第 1 页是否也要登录

这些只能在客户端里验：样本链接在客户端外拿不到任何数据（见 6.1）。验证方式是打开应用内浏览器访问对应页面，在页面上下文里手动发一次接口请求，把响应形状记回本文。

## 7. YouTube 播放列表与 Mix

**今天就能用，不需要新写解析。**两种形态都实测过（样本见第 8 节），扁平解析的条目**标题、时长全都有**，因此 `parser.ts` 那条"条目缺标题就全量重抽"的兜底不会触发，条目直接进现有的列表界面：

| 形态 | 实测 |
| --- | --- |
| 普通播放列表（`list=PL...`） | 1.9 秒 5 条，全部有标题与时长，`playlist_count` 给出总数，列表标题是《台湾豪门家族恩怨录》 |
| Mix / 电台（`list=RD...`） | 3.7 秒 100 条，全部有标题与时长，标题形如 `Mix - <当前视频标题>` |

YouTube 的列表适配器只认频道（`listings/youtube.ts` 的 `matches()` 要求 `handleOf(url)` 非空），带 `list=` 的观看页落到引擎路线，没有劫持问题。

两个已知性质需要处理或至少说清楚，都只影响 Mix，不影响普通播放列表：

- **100 条上限是硬的**。`engine/main.py` 的 `playlistend: 100` 和 `media.ts` 的 `flattenEntries(limit = 100)` 一起把结果截断在 100，而 `RD` 开头的 Mix 是自动生成的电台，本身没有尽头。今天的截断是静默的，用户看不到自己只拿到了前 100 条。见任务 13。
- **Mix 的内容每次解析都不一样**。同一个链接两次解析，第三条分别是 `9gh7Lt7tdj8` 和 `c1jLt0EarG4`——这是 YouTube 按会话即时生成的，不是缺陷。意味着"上次选中的条目"在重新解析后可能不存在，跨页选择的语义在这里天然是尽力而为。

另外，粘一个 `watch?v=...&list=...` 链接会列出整个列表，而不是那一个视频（`noplaylist: False`）。当前视频总是列表的第一条，想只下它就只选第一条，不额外做交互。

## 8. 验证样本

哔哩哔哩与 YouTube 的样本均已实测可用（哔哩哔哩的来自 `bhwa233-download-api` 的测试串）；抖音的样本由使用者提供，尚未验证（原因见 6.1）。

### YouTube

| 链接 | 用途 | 状态 |
| --- | --- | --- |
| `https://www.youtube.com/watch?v=oBeBVjOBZPs&list=PLZOc7e59B5BY` | 普通播放列表（《台湾豪门家族恩怨录》，5 条），验证常规列表展示 | 已验证：1.9 秒 5 条，标题时长与总数齐全 |
| `https://www.youtube.com/watch?v=l54zu9rjpYc&list=RDl54zu9rjpYc&start_radio=1` | Mix（自动生成电台），验证 100 条截断与条目不稳定 | 已验证：3.7 秒 100 条，标题时长齐全 |

### 抖音

| 链接 | 用途 | 状态 |
| --- | --- | --- |
| `https://www.douyin.com/video/7331258875343113512` | 属于合集的作品，第 6.3 节四个问题从它入手 | 未验证：客户端外拿不到数据，yt-dlp 亦拒绝 |
| `https://www.douyin.com/video/7642260730959514934` | 第二个属于合集的作品，用来确认合集字段不是个例 | 未验证：同上 |
| `https://www.douyin.com/user/MS4wLjABAAAAiDM_L0EfQosQEKfhAPkrFau6cBPMtNu1d3E2em0hzUZ6I1VGFH5oS6NuV4cfsd2o?from_tab_name=main&showSubTab=playlet&showTab=like` | 喜欢列表，验证按 `showTab` 分流与 `aweme/favorite` | 未验证：同上 |
| `https://www.douyin.com/user/self?from_tab_name=main&showTab=recommend` | 推荐列表，且是 `user/self` 形态，验证本人标识解析与未登录时的报错 | 未验证：同上 |

两条链接的客户端外表现完全一致：匿名请求都返回同一个 72914 字节的壳页面，`mix_info` 与 `_ROUTER_DATA` 出现次数均为 0；yt-dlp 都以 `Fresh cookies (not necessarily logged in) are needed` 拒绝。这正是第 6.3 节必须在应用内浏览器里做的原因。

### 哔哩哔哩分P

| 链接 | 分P 数 | 用途 |
| --- | --- | --- |
| `https://www.bilibili.com/video/BV1bK411W797` | 23 | 主样本，`part` 名齐全 |
| `https://www.bilibili.com/video/BV1h54y1B7J4` | 82 | 规模样本 |
| `https://www.bilibili.com/video/BV1uT4y1P7CX` | 2 | 小样本 |
| `https://www.bilibili.com/video/BV1xx411c7mD` | 1 | 反例，验证放弃与回落 |

### 哔哩哔哩合集

| 合集 | 链接 | 集数 | 对应视频页 |
| --- | --- | --- | --- |
| 喵喵网络狠人2.0 | `https://space.bilibili.com/3494376638516086/lists/8566628?type=season` | 18 | `BV11dbH6LEm2` |
| 少女乐队 | `https://space.bilibili.com/339087866/lists/4940048?type=season` | 3 | `BV1Ps421u7ju` |
