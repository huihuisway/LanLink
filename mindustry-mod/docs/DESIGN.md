# MDT-LanLink 设计方案

Mindustry V8 联机 Mod：免公网 IP 开房 + P2P 打洞直连 + 联机大厅，
接入 MindProject 生态（MindAuth 账号体系 + MindFourm 论坛）。

## 1. 总体架构

三个目标不是三套系统，而是分层递进的一套系统：

```
┌─────────────────────────────────────────────────────────┐
│  L4 生态层：MindAuth 账号 / 论坛大厅页 / 举报封禁          │
│  L3 大厅层：公开房间列表 / 房间码                          │
│  L2 直连层：UDP 打洞 + KCP 可靠通道（双端装 Mod 时）        │
│  L1 保底层：frp 式中继隧道（原版客户端也能加入）            │
└─────────────────────────────────────────────────────────┘
```

- **L1 是地基**：房主装 Mod，一键开房，中继服务器分配 `公网IP:端口`，任何原版客户端
  （包括手机端、Steam 端）用「加入游戏 → 输入 IP」即可进入。100% 可用，但走服务器带宽。
- **L2 是优化**：客人也装了 Mod 时，输入房间码加入，先尝试 UDP 打洞直连（延迟最低、
  不耗服务器带宽），3 秒内失败则自动回落到中继。对玩家透明。
- **L3 是社区层**：房主可勾选「公开房间」，其他玩家在 Mod 内大厅或论坛网页浏览并加入。
- **L4 是生态层**：公开房间与治理挂在 MindAuth/论坛账号体系上，不另造一套用户系统。

### 组件

| 组件 | 技术 | 位置 |
|------|------|------|
| LanLink Mod | Java（Gradle，桌面 + Android 同等优先） | 本仓库 `mod/`，房主必装、客人可选 |
| LanLink 控制面 | Node.js/TypeScript（并入 MindProject monorepo） | `MindProject/LanLink/`，与论坛同机 |
| LanLink 边缘节点 | 同仓库的独立轻量进程（`lanlink-node`） | **多台独立服务器**，可随时增减 |
| MindAuth | 既有 OAuth 2.0 SSO（端口 4001） | 增加设备授权流（见 §7.1） |
| MindFourm | 既有论坛 | 增加「联机大厅」页面（见 §7.3） |

**控制面与数据面分离是第一天就定下的架构**（部署形态为多个独立中继节点）：
控制面只管房间/信令/鉴权/大厅（流量极小），游戏流量只经过边缘节点，
论坛所在服务器不承载中继流量。

## 2. 为什么原版客户端能直接加入

Mindustry 联机协议 = TCP（可靠包）+ UDP（快照等不可靠包），默认端口 6567。
中继只做**字节级透明转发**，不解析游戏协议，因此：

- 原版客户端连中继的公网端口，与连普通服务器无区别；
- 游戏本身的版本校验、Mod 校验逻辑原样生效；
- Mindustry v8 各 beta 版本间协议怎么变都不影响本 Mod（对游戏是黑盒）。

同理，Mod 在房主侧也不侵入游戏网络栈：本地正常 `net.host()`，Mod 只做一个
本地代理，把隧道流量转发到 `127.0.0.1:6567`。**全程把游戏当黑盒**，这是跨
v8 各 beta 版本存活的关键。

## 3. L1：中继隧道（MVP）

### 流程

1. 房主点「LanLink 开房」→ Mod 确认本地已 `net.host()`；
2. Mod 向服务端发起**出站** TLS 控制连接（出站连接不需要房主有公网 IP）；
3. 服务器分配：房间码（如 `MDT-7K3F9Q`）+ 公网端口（端口池，如 20000–29999 中取一个）；
4. Mod 界面显示 `relay.example.com:23456` 和房间码，一键复制发给朋友。

### 数据面（frp 同款思路）

- **TCP**：客人连中继公网端口 → 中继通过控制连接通知房主 Mod → Mod 出站建立一条
  数据连接 → 中继把两条连接对接（splice），Mod 再桥接到 `127.0.0.1:6567`。
- **UDP**：中继在公网端口收 UDP；房主 Mod 预先向中继打开出站 UDP 会话并定时心跳
  保活 NAT 映射；中继按「客人源地址」区分会话转发。房主侧**每个客人一个本地 UDP
  socket** 发往 `127.0.0.1:6567`，保证本地服务器能区分不同客人（KryoNet/ArcNet
  按源端口绑定 UDP 与 TCP 连接，混用一个 socket 会串包）。
- 严禁 UDP-over-TCP（延迟抖动灾难），UDP 走原生 UDP 转发。

### 附加功能（因为流量过 Mod，白送的能力）

- **加入审批**：原版 Mindustry 开房没有密码。Mod 可在房主端弹「xxx 正在加入，
  允许/拒绝」，或设置白名单——中继连接在放行前不转发。
- 流量/延迟统计面板，每个玩家标注「直连/中继」。

## 4. L2：打洞直连（双端 Mod）

### 信令与打洞

1. 客人在 Mod 内输房间码 → 信令服务器撮合双方；
2. 双方向服务器的 STUN 端口发 UDP，服务器回显各自公网 `IP:端口`（即内置简易 STUN）；
3. 双方同时向对方公网端点发 UDP 探测包（经典打洞），2–3 秒内通即成功；
4. 失败（对称 NAT / CGNAT 双方都严格）→ 自动回落：同一条 UDP 通道改经服务器
  转发（TURN 式），上层无感知。

国内环境预期：光纤家宽 + 手机热点组合下打洞成功率约 50–70%，所以回落必须无缝。

### 可靠层：KCP over UDP

打洞打出来的只有一条 UDP 通路，而游戏需要 TCP+UDP 两个通道。方案：

- 在 UDP 通路上用 1 字节前缀复用两个信道：`0x01` = KCP（承载游戏 TCP 流），
  `0x02` = 裸转发（承载游戏 UDP 包）；
- KCP 用纯 Java 实现（如 kcp-java），桌面和 Android 都能跑；
- 客人侧 Mod 起一个 `127.0.0.1:随机端口` 的本地假服务器做 TCP↔KCP 翻译，
  然后内部调用 `net.connect("127.0.0.1", port)` ——游戏代码路径完全原版。

### 加入体验

客人 Mod 界面：「加入房间 → 输入房间码」→ 自动完成 打洞/回落 → 进游戏。
连接后 HUD 角标显示 `P2P直连 32ms` 或 `中继 68ms`。

## 5. L3：联机大厅

- 房主开房时可勾选「公开到大厅」，附带：房名、地图、模式、人数、游戏版本、
  Mod 列表摘要、是否支持原版加入、房主论坛身份（用户名/头衔）；
- **Mod 内大厅**：列表、按版本/模式过滤、显示延迟（对中继节点 ping）、一键加入；
- **论坛联机中心**（见 §7.3）：同一组 API 的网页呈现——在线房间 + 节点状态 +
  发起人身份；未装 Mod 的玩家也能看到公开房间的中继地址，复制进游戏即可加入。

### 治理（公开大厅必须做）

- **公开房间要求 MindAuth 登录**（私密房间无需登录，保持低门槛）；
- 房名/描述敏感词过滤（可复用论坛既有过滤；国内合规底线）；
- 举报走论坛既有举报体系；封禁按账号生效（比按 IP 可靠），MindAuth 的
  IP 封禁（`ipBanMatcher`）同样在 LanLink 服务端生效；
- 按账号限流：每账号同时房间数、建房频率。

## 6. 服务端设计：控制面 + 多边缘节点

### 技术选型：Node.js/TypeScript，控制面并入 monorepo，节点独立部署

理由：

- MindProject 全栈是 Node + PM2 + MySQL/Redis，统一技术栈统一运维；
- 中继本质是字节搬运，单节点几 Mbps~几十 Mbps 规模下 Node 的 `net`/`dgram`
  完全够用，瓶颈在带宽不在 CPU；
- **EasyManager（暂停中）已有可直接借用的实现模式**：Redis 端口池分配、
  带宽统计（`bandwidth_logs`）、配额（`user_quotas`）；
- 节点是无状态轻量进程（一个 js 入口 + 一个配置文件），加机器 = 装 Node、
  填控制面地址和 node token、PM2 拉起，即完成扩容。

### 结构

```
MindProject/LanLink/
├── src/
│   ├── control/     # 控制面：房间生命周期、打洞撮合、审批转发、节点注册表
│   ├── lobby/       # 大厅 HTTP API（Mod 与论坛前端共用）
│   ├── auth/        # MindAuth 对接：introspect 校验、IP 封禁检查
│   └── node/        # 边缘节点进程入口（同仓库，独立启动）
│       ├── relay/   # TCP splice + UDP 转发（net/dgram），本地端口池
│       └── stun/    # 简易 STUN：UDP 回显公网端点
├── .env             # 控制面：PORT=5100
└── node.env.example # 节点：CONTROL_URL、NODE_TOKEN、PUBLIC_ADDR、PORT_RANGE
```

### 节点协作方式

- **节点 → 控制面**：启动时出站 WebSocket 注册（预共享 node token 认证），
  上报公网地址、端口池范围、带宽上限；之后心跳上报负载/水位/会话数。
  掉线的节点从调度池摘除，其上房间标记为中断（Mod 自动重连换节点）。
- **开房调度**：Mod 向控制面请求开房 → 控制面按负载筛出候选节点（2–3 个）→
  **Mod 对候选节点 UDP 测速，选延迟最低的** → 控制面向该节点下发建房指令 →
  节点分配公网端口 → 房间登记 `节点地址:端口`。
- **游戏流量只走节点**：房主隧道、原版客人、打洞失败的回落转发全在节点上；
  控制面只有 JSON 信令，和论坛同机也不占带宽。
- 节点定期把流量计数上报控制面，落 MySQL `bandwidth_logs`。

### 控制协议（WebSocket，JSON）

```
# Mod ↔ 控制面
C→S  {"op":"hello","ver":1,"token":"<MindAuth access_token 或空>"}
C→S  {"op":"create_room","name":"周末打波","public":true,"vanilla_join":true}
S→C  {"op":"candidates","nodes":[{"id":"cn-sh-1","addr":"1.2.3.4","ping_port":20000},...]}
C→S  {"op":"pick_node","id":"cn-sh-1"}
S→C  {"op":"room_ok","code":"MDT-7K3F9Q","addr":"1.2.3.4:23456"}
S→C  {"op":"new_conn","id":17}                  // 有客人接入（经节点转报）
C→S  {"op":"accept_conn","id":17}               // 房主放行（审批功能）
C→S  {"op":"join_room","code":"MDT-7K3F9Q"}     // 客人 Mod
S→C  {"op":"peer_info","addr":"1.2.3.4:54321"}  // 打洞交换端点

# 节点 ↔ 控制面
N→S  {"op":"register","token":"...","addr":"1.2.3.4","ports":"20000-29999","mbps":30}
N→S  {"op":"heartbeat","sessions":12,"mbps_used":8.5}
S→N  {"op":"open_room","room":"MDT-7K3F9Q"}
S→N  {"op":"close_room","room":"MDT-7K3F9Q"}
```

### 对外 HTTP API（Mod 与论坛共用）

```
GET  /api/version               # Mod 更新检查：最新版本号 + MindFileList 下载链接
GET  /api/rooms/public          # 公开房间列表，含 owner:{id,username,title}、node:"cn-sh-1"
GET  /api/nodes/status          # 节点公开摘要：[{id,name,region,online,load:"low|mid|high",rooms}]
GET  /api/nodes/detail          # 管理员：精确带宽/会话/每房间流量明细（API key）
POST /api/admin/rooms/:code/close   # 管理员强制关房（论坛后台调用，API key）
```

- 公开的 `nodes/status` 只给摘要（名称/地域/负载档位），**不含节点 IP 清单**；
  节点数据来自 Redis 注册表 + 心跳（`sessions`/`mbps_used`），历史曲线来自
  MySQL `bandwidth_logs`，无需节点侧额外改动。

- 状态：房间/节点注册表放 Redis（房主控制连接断开销毁房间，60 秒宽限支持
  闪断重连）；MySQL `lanlink` 库存房间历史、流量日志；
- 节点安全组：放行端口池范围 TCP+UDP + 出站 WebSocket；
- 部署：控制面进 `ecosystem.config.js`/`deploy.sh` 与其他服务同流程；
  节点单独一份 PM2 配置，后续可写一键部署脚本。

### 带宽账（按节点算）

Mindustry 高峰期每客户端约 10–50 KB/s。单节点 5 Mbps ≈ 12–30 个中继客人，
30 Mbps ≈ 上百人。调度按节点水位分流：

- 双端 Mod 用户优先打洞，直连流量不走任何节点；
- 每节点水位上限（拒新不断旧）+ 每房间带宽上限 + 每账号配额；
- 节点可异构（不同带宽、不同地域），未来甚至可接受社区贡献节点
  （node token 准入 + 只承载勾选「允许第三方节点」的房间）。

## 7. 与 MindProject 生态集成

### 7.1 身份：MindAuth 设备授权流

游戏 Mod 不方便做浏览器跳转回调，采用**设备授权流（RFC 8628）**，需在
MindAuth 增加两个端点（工作量小，复用既有 `oauthIssuer`/`tokenStore`）：

```
POST /api/oauth/device/code    → { device_code, user_code: "MDTA-3F9Q", verification_uri }
POST /api/oauth/device/token   → Mod 轮询，用户确认后发 access_token + refresh_token
```

体验：Mod 里点「登录」→ 显示 8 位码和网址（桌面端直接帮开浏览器）→ 用户在
论坛/MindAuth 页面登录并确认 → Mod 拿到 token 长期保存（refresh 续期）。
桌面端也可选 PKCE + loopback 回调作为快捷路径，Android 统一走设备流。

注册 OAuth client：`client_id=lanlink`（照 forum client 的方式在 MindAuth 注册）。

### 7.2 服务端鉴权

- LanLink 服务端拿 Mod 传来的 access_token 调 MindAuth `introspect`/`userinfo`
  校验并取用户信息，结果短缓存于 Redis；
- 匿名（不带 token）只能开**私密**房间；公开到大厅必须登录；
- MindAuth 的 IP 封禁与账号封禁在 create_room 时检查。

### 7.3 论坛「联机中心」页（MindFourm）

新页面 `/rooms`，集成方式照搬「MindFourm ↔ EasyManager」既有模式
（feature flag：`feature_lanlink_enabled`，后端 `LANLINK_URL` + API key），
数据来自控制面对外 API（见 §6），分两个区块：

**节点状态栏**（页面顶部，数据源 `GET /api/nodes/status`）：

- 每个中继节点一张卡片：节点名（如 `华东-上海-1`）、在线/离线、地域、
  负载档位（高/中/低）、承载房间数；顶部 `StatsGrid` 汇总（在线节点数、
  总房间数、总在线人数）；
- 游客即可见，但只有摘要——**不暴露全量节点 IP 清单**（单个房间的中继地址
  本就对加入者可见，但不提供可整体扫描的节点列表）。

**在线房间列表**（数据源 `GET /api/rooms/public`）：

- 复用 `shared` 包 `ServerCard`（状态/人数/延迟字段现成）：房名、地图/模式、
  人数、游戏版本（v7/v8 标签）、所在节点、是否支持原版加入；
- **发起人**：公开房间强制 MindAuth 登录（§5），因此每个房间必有账号——
  显示论坛用户名 + 头衔/勋章（`Medal`/`Title` 组件），点击跳转论坛个人主页；
- 「加入」按钮 = 复制中继地址；装了 Mod 的玩家另显示房间码。

**管理员视图**（论坛既有管理员权限，数据源 `GET /api/nodes/detail`）：

- 节点精确带宽曲线（`ActivityChart` + `bandwidth_logs` 24h）、每房间流量明细；
- 「强制关房」按钮（调 `POST /api/admin/rooms/:code/close`）+ 下架/封禁账号；
- 举报按钮走论坛既有举报流程。

### 7.4 与 EasyManager 的关系

- 定位不重叠：EasyManager = **托管**专用服务器（Docker 常驻），LanLink =
  玩家**自己电脑**开的房对外可达（游戏开着才在）；
- 直接借用其实现模式：Redis 端口池分配、`bandwidth_logs`、`user_quotas`；
- 未来 EasyManager 恢复后，论坛大厅页可同时列「托管服务器」和「玩家房间」两栏。

## 8. Mod 端设计

### 版本支持：v7（146/147）+ v8 双支持

国内大量玩家仍在 v7，v8 为 beta。黑盒代理架构下网络层与游戏版本无关，
兼容成本只在 UI 注入点和少量 API 差异：

- 单一代码库，`mod.hjson` 标 `minGameVersion: 146`；编译依赖取 v7 稳定版
  （API 下限），v8 差异处用运行时探测 + 反射适配（集中在一个 `Compat` 类）；
- CI 同时对 v7 与 v8 的 jitpack 依赖各编译一遍，v8 beta 更新破坏 API 时
  第一时间发现；
- 房间信息携带游戏版本，大厅按版本过滤，避免 v7 玩家进 v8 房。

### Android 与桌面同等优先（首发即支持）

- **禁用任何桌面专属 API**，全部用 java.net/java.nio + 纯 Java KCP；
  TLS 用标准 SSLSocket；
- M0 起每个里程碑都在 Android 真机验收（手机开房、手机房间码加入）；
- UI 布局按小屏优先设计（Mindustry 的 Scene UI 本身跨平台，注意对话框尺寸）。

### UI 注入点

- `Events.on(ClientLoadEvent)` 后往「开放主机」对话框注入「LanLink 开房」按钮；
- 「加入游戏」界面注入「房间码加入」「LanLink 大厅」入口；
- 设置页：MindAuth 登录状态、控制面地址（默认官方，可自建自填）、
  审批开关、公开房间默认值；
- 注入失败（版本差异）时降级为独立入口按钮，保证功能可用。

### 状态机

游戏退出房间 / 断线 / 换图时正确关闭隧道与房间；节点掉线时自动向控制面
申请换节点重建隧道，并在 HUD 提示。

### 分发与更新（论坛 + MindFileList + QQ 群）

- jar 托管在 MindFileList，论坛资源区发布页为主入口，QQ 群转发同一链接；
  不依赖 GitHub（国内可达性差），仓库是否开源另行决定；
- Mod 启动时向控制面 `GET /api/version` 查最新版本号 + 下载链接（指向
  MindFileList），有新版则游戏内弹提示：桌面端可直接下载到 mods 目录并提示
  重启，Android 端跳转浏览器下载；
- 控制协议带 `ver` 字段，控制面可对过旧客户端返回「需要更新」而不是静默不兼容。

## 9. 风险与对策

| 风险 | 对策 |
|------|------|
| v8 beta 内部 API 变动 | 网络层全走黑盒代理，不 hook 游戏网络内部；UI 注入点做失败降级；CI 双版本编译预警 |
| v7/v8 双版本 API 差异蔓延 | 差异全部收敛进单一 `Compat` 类，禁止散落 |
| ArcNet UDP 与 TCP 绑定细节（串包） | M0 阶段抓包验证；房主侧每客人独立 UDP socket |
| 节点掉线丢房间 | 心跳摘除 + Mod 自动换节点重建隧道 + 60 秒宽限重连 |
| 单节点带宽打满 | 节点水位调度（拒新不断旧）+ 每房间/每账号配额 + 优先打洞分流 |
| 公开大厅内容风险 | 公开房间强制登录 + 敏感词过滤 + 论坛举报/封禁体系 + 管理员强制关房 |
| 中继端口被扫描蹭房 | 加入审批/白名单；房间销毁即关端口；节点状态公开 API 只给摘要不给 IP 清单 |
| Android 兼容返工 | 首发即支持：禁桌面专属 API，M0 起每里程碑真机验收 |

## 10. 里程碑

| 阶段 | 内容 | 预估 |
|------|------|------|
| M0 调研 | v7/v8 API 核对、本地双开抓包验证 TCP/UDP 行为、Android 真机打包验证 | 1 周 |
| M1 MVP | 控制面 + 单节点中继（匿名可用）+ Mod 房主侧一键开房，原版客人可加入；桌面 + Android 验收 | 2–3 周 |
| M2 多节点 | 节点注册/心跳/调度、Mod 测速选点、掉线换节点 | 1 周 |
| M3 直连 | 信令/STUN/打洞/KCP 隧道/自动回落 + 房间码加入 UI | 2–3 周 |
| M4 账号 | MindAuth 设备授权流 + Mod 登录 + 服务端鉴权/配额 | 1 周 |
| M5 大厅 | 公开房间、Mod 内大厅 UI、论坛联机中心页（房间+节点状态+发起人、管理员详情/强制关房）、过滤与举报、更新检查/分发 | 1–2 周 |
| M6 打磨 | 断线重连细化、统计面板、审批白名单、节点一键部署脚本 | 持续 |

M1/M2 不依赖账号体系（匿名私房），M3/M4 才接 MindAuth/论坛——
生态集成失败不阻塞核心联机功能。

## 11. 仓库结构

```
MDT-LanLink/                  # 本仓库：只放 Mod
├── mod/                      # Java Mod（Gradle）
│   ├── src/main/java/lanlink/
│   │   ├── LanLinkMod.java   # 入口
│   │   ├── ui/               # 开房/加入/大厅/登录界面
│   │   ├── tunnel/           # 中继客户端、本地代理、KCP 通道
│   │   ├── punch/            # STUN、打洞
│   │   └── auth/             # MindAuth 设备流客户端
│   ├── assets/
│   └── mod.hjson
├── proto/PROTOCOL.md         # 控制协议定义（单一事实来源）
└── docs/DESIGN.md            # 本文档

MindProject/LanLink/          # 服务端：并入 MindProject monorepo（见 §6）
```
