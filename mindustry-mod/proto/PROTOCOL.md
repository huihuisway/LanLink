# LanLink 协议 v2（强制版本检查）

三条链路：**Mod ↔ 控制面**（WSS/JSON）、**节点 ↔ 控制面**（WSS/JSON）、
**Mod ↔ 节点**（TCP/UDP 隧道，二进制）。客人（原版游戏）不感知任何协议，
连节点房间公网端口即为原生 Mindustry 协议。

## 版本历史

- **v1**：初始版本
- **v2**：强制版本检查，旧版本 Mod 将被拒绝连接。移除 Mod 版本白名单机制，简化版本控制。

## 版本升级策略

当需要强制用户升级 Mod 时：
1. 服务端升级 `protocolVersion`（如 2 → 3）
2. Mod 端更新 `PROTOCOL_VER` 常量并重新编译
3. 旧版本 Mod 连接时发送旧版本号，被服务端拒绝并返回 `upgrade_required` 错误
4. 用户看到更新提示，前往论坛下载新版本

**优势**：无需维护 Mod 版本白名单，升级时只需 bump 协议版本号。

## M2 新增（均为 additive，旧端忽略）

- `create_room.direct_candidates` 数组（多候选直连）
- 客人 WS 端点 `/ws/guest`（独立于 `/ws/mod`）
- 节点 `official` / `owner` / `region` / `description` 字段

## 通用约定

- WS 消息为单条 JSON 对象，必含 `op` 字段；错误统一 `{"op":"error","code":"...","msg":"..."}`；
- `ver` 为协议版本，当前 `2`；控制面对过旧 `ver` 返回 `code:"upgrade_required"` + 下载链接 + 需要的协议版本；
- 手机号验证：创建房间或加入房间时需要验证手机号，未验证返回 `code:"phone_verification_required"` + 验证页面链接（`verify_url`）；
- 房间码格式 `MDT-XXXXXX`（6 位，字母表剔除 `0O1I`）；
- `roomToken` = 32 字符 hex（16 随机字节），控制面生成，房间生命周期内有效，
  是 Mod 与节点之间的唯一凭证。

## 1. Mod ↔ 控制面　`wss://<control>/ws/mod`

```
C→S {"op":"hello","ver":1,"build":146,"platform":"desktop|android","mod_version":"0.1.0","token":""}
      // mod_version 可选；token: MindAuth access_token，M1 恒空
S→C {"op":"hello_ok","motd":"...","latest":"0.1.0","server_version":"0.1.0"}

C→S {"op":"create_room","name":"周末打波","public":false,"vanilla_join":true,"game_port":6567,
      "node_id":"node-2","relay_addr":"2.2.2.2","relay_tunnel_port":21000,
      "direct":{"mode":"upnp","addr":"8.8.8.8","tcp_port":6567,"udp_port":6567,"ttl":3600},
      "direct_candidates":[
        {"mode":"upnp","addr":"8.8.8.8","tcp_port":6567,"udp_port":6567,"ttl":3600},
        {"mode":"stun","addr":"8.8.8.8","tcp_port":6567,"udp_port":6567,"ttl":0},
        {"mode":"manual","addr":"1.2.3.4","tcp_port":6567,"udp_port":6567,"ttl":0}
      ]}
      // node_id / relay_addr / relay_tunnel_port / direct / direct_candidates 均可选；不传时仍由控制面自动选点并只提供中继
S→C {"op":"room_ok","code":"MDT-7K3F9Q","room_token":"<hex32>",
     "display_name":"[green]MDTBBS>LL[orange] M0.1.0/S0.1.0[purple] 上海节点",
     "mod_version":"0.1.0","server_version":"0.1.0",
     "node":{"id":"cn-sh-1","name":"上海节点","addr":"1.2.3.4","room_port":23456,"tunnel_port":20000}}

S→C {"op":"peer_join","conn":17,"addr":"5.6.7.8:54321"}     // 信息通知（审批在隧道控制链上，见 §3.2）
C→S {"op":"close_room"}                                     // 主动关房
S→C {"op":"room_closed","reason":"owner|node_down|kicked"}
双向 {"op":"ping"} / {"op":"pong"}                           // 30s 心跳
```

- `display_name` 是 LanLink 展示用彩色标识，格式由控制面统一生成；`create_room.name` 保持房主原始房名，不能写入品牌/版本/节点标签。
- `public` 是房主对论坛公开展示的明确授权；Mod 默认为 `false`，字段缺失或不是 JSON 布尔值 `true` 时，控制面必须按不公开处理。不公开房间不得出现在 `GET /api/rooms/public`。
- `node_id` 用于显式选择控制面已注册的在线节点；`relay_addr` + `relay_tunnel_port` 用于手填匹配当前控制面名下节点；两者都缺省时控制面继续自动选点。
- 手填中继不会绕过控制面：只有匹配到当前控制面已注册、已在线的节点时才会开房，否则返回 `code:"node_not_found"`。
- `direct` 是可选直连候选，第一版仅定义 `mode:"upnp"`，表示房主 Mod 已把本地原生 Mindustry `game_port` 映射到公网 `addr:tcp_port/udp_port`；控制面会过滤非法候选，且第一版要求 TCP/UDP 外部端口同号，不可用时收端必须回退中继。
- `direct_candidates`（M2）是可选直连候选数组，元素结构与 `direct` 相同；`mode` 扩展为 `"upnp" | "stun" | "manual"`：
  - `upnp`：UPnP IGD 映射；要求 `tcp_port == udp_port`
  - `stun`：STUN 服务器发现的公网地址；tcp/udp 端口可以不同
  - `manual`：用户手动填写的公网地址；无 TTL（无映射需清理）
  - `ttl` 为 0 表示无映射需清理；非 0 表示存在 UPnP 等有时效的映射（秒）
  - 控制面对数组中每个元素独立校验，丢弃非法项；旧 Mod 忽略该字段，新控制面会同时返回 `direct`（兼容）与 `direct_candidates`
- 第一版 direct 不增加 LanLink 层准入授权；房间码仍只用于从控制面解析房间信息，但拿到直连 IP/端口的人可尝试原生 Mindustry 连接。
- `mod_version`、`server_version`、`node.name` 均为诊断/展示字段，不参与 v1 协议兼容判断；缺省时收端必须降级显示。

断线重连：Mod 断开后 60s 内携 `{"op":"hello",...,"resume":"<room_token>"}` 可恢复房间；
超时房间销毁、节点端口回收。

## 1b. 客人 ↔ 控制面 `wss://<control>/ws/guest`（M2 新增）

客人（加入方）专用端点。消息集与 `/ws/mod` 分离，职责清晰：

```
C→S {"op":"hello","ver":1,"build":146,"platform":"desktop|android","mod_version":"0.1.0","token":""}
S→C {"op":"hello_ok","motd":"...","latest":"0.1.0","server_version":"0.1.0"}

C→S {"op":"join_request","code":"MDT-7K3F9Q",
      "candidates":[{"mode":"stun","addr":"5.6.7.8","udp_port":54321},...]}
      // candidates 可选；客人自己的直连候选（用于打洞）
S→C {"op":"join_accepted","room":{"code":"MDT-7K3F9Q","node":{...}},
      "host_candidates":[{"mode":"upnp","addr":"8.8.8.8","udp_port":6567},...],
      "peer_id":"<uuid>"}
      // host_candidates 为房主 create_room 时登记的直连候选
S→C {"op":"peer_left","peer_id":"<uuid>","reason":"owner|kicked"}

双向 {"op":"ping"} / {"op":"pong"}                                   // 30s 心跳
```

房主侧 `/ws/mod` 收到的 `peer_join` 在 M2 扩展为携带 `peer_id` 与客人候选：

```
S→C {"op":"peer_join","conn":17,"addr":"5.6.7.8:54321",
      "peer_id":"<uuid>","peer_candidates":[...]}
```

旧房主 Mod 忽略新增字段，行为不变。

## 2. 节点 ↔ 控制面　`wss://<control>/ws/node`

```
N→S {"op":"register","ver":1,"token":"<node_token>","name":"上海节点","addr":"1.2.3.4",
     "tunnel_port":20000,"port_range":[[20001,20099],[30001,30099]],"mbps":30,
     "region":"华东","description":"官方上海节点"}    // region / description 可选
S→N {"op":"register_ok","id":"cn-sh-1","official":true}
N→S {"op":"heartbeat","rooms":3,"sessions":12,"mbps_used":8.5}   // 10s 一次；控制面 30s 未收到即摘除
S→N {"op":"open_room","code":"MDT-7K3F9Q","room_token":"<hex32>"}
N→S {"op":"room_opened","code":"MDT-7K3F9Q","room_port":23456}   // 节点本地分配端口（TCP+UDP 同号）
S→N {"op":"close_room","code":"MDT-7K3F9Q"}
N→S {"op":"room_stat","code":"...","conns":2,"rx":123456,"tx":654321}  // 随心跳批量上报亦可
```

- 节点 `official` 身份由控制面根据 token 配置决定，节点不能自封；`register_ok` 回显告知节点身份
- 社区节点 token 由管理员预生成，`official=false`；官方节点 token 由 `NODE_TOKENS` 环境变量配置，`official=true`
- `port_range` 为节点可用端口池配置，格式为 `[min, max]` 对的数组；旧节点可能发送扁平二元组 `[min, max]`，控制面自动归一化为 `[[min, max]]`。该字段仅用于诊断，控制面不据此做调度决策

## 3. Mod ↔ 节点隧道

节点两类监听：**房间公网端口**（`room_port`，TCP+UDP 同号，面向客人，原生
Mindustry 协议）与**隧道端口**（`tunnel_port`，全节点固定一个，面向房主 Mod）。

### 3.1 TCP 隧道握手（隧道端口）

Mod 出站连接节点 `tunnel_port`，首帧固定 25 字节：

```
[4B magic "LLK1"][1B type][16B roomToken(原始字节)][4B connId(大端)]
type: 0x01 = 控制链（connId 填 0）
      0x02 = 数据链（connId = new_conn 下发的 id）
```

节点校验 roomToken 失败立即断开。握手后：

- **控制链**（每房间恒一条）：换行分隔 JSON——
  ```
  N→M {"op":"new_conn","id":17,"addr":"5.6.7.8:54321"}   // 有客人 TCP 接入
  M→N {"op":"accept_conn","id":17}                        // 审批放行（关闭审批时 Mod 自动立刻回）
  M→N {"op":"reject_conn","id":17}
  N→M {"op":"conn_closed","id":17}
  双向 {"op":"ping"} / {"op":"pong"}                      // 30s
  ```
  客人连接在节点侧最多挂起 10s 等待 accept + 数据链，超时断开。
- **数据链**（每客人一条）：握手帧之后即为**裸字节流**，节点将其与对应客人的
  TCP 连接对接（splice）；Mod 将其与 `127.0.0.1:game_port` 的本地连接对接。
  任一端关闭即双向关闭。

### 3.2 UDP 隧道（隧道端口 UDP）

```
注册（Mod→节点，建立会话后每 25s 重发保活 NAT）：
  [4B magic "LLKU"][1B 0x03][16B roomToken]
数据（双向）：
  [4B magic "LLKU"][1B 0x01][2B sessionId(大端)][payload = 原生游戏 UDP 包]
节点→Mod 会话关闭通知：
  [4B magic "LLKU"][1B 0x02][2B sessionId]
```

- 节点：房间公网 UDP 端口收到**未知源地址**的包 → 分配 `sessionId`（与该源地址
  绑定，2 分钟无流量过期）→ 封帧转给 Mod 注册的 UDP 地址；Mod 回来的数据帧
  解封后**从房间公网 UDP socket** 发回对应客人源地址（保证客人视角源端口稳定）。
- Mod：每个 `sessionId` 一个**独立本地 UDP socket** 与 `127.0.0.1:game_port`
  通信（ArcNet 按源地址路由，铁律，见 RESEARCH.md §2）；本地 socket 收到的
  回程包按 sessionId 封帧发回节点。
- sessionId 与 TCP 的 connId **无需对应**（游戏服务器自己通过 RegisterUDP 关联）。

## 4. 对外 HTTP API（控制面）

```
GET /api/health     # 依赖健康（MySQL/Redis/在线节点数）
GET /api/version    # {"latest":"0.1.0","url":"<MindFileList 下载页>","min":"0.1.0","allowed_mod_versions":["0.10.0","0.9.0"]}
                      # allowed_mod_versions 为 Mod 版本白名单；空数组表示不限制
POST /api/auth/refresh
  # Authorization: Bearer <Mod token>
  # 从论坛重新读取用户和手机验证状态，返回新 token 与 user；无需重新输入密码
GET /api/nodes/available
  # {"nodes":[{"id":"node-1","name":"上海节点","addr":"1.2.3.4","tunnel_port":20000,
  #            "rooms":1,"sessions":4,"mbps_used":3.5,
  #            "official":true,"region":"华东","description":"官方上海节点","owner":""}]}
  # official=false 的节点为社区节点，owner 为节点拥有者的论坛用户名
GET /api/rooms/:code
  # 用房间码解析原版加入地址，不返回 room_token
  # direct 可选；存在时新 Mod 先尝试 direct，失败后回退 node.addr:room_port 中继
  # direct_candidates（M2）为数组，按优先级排序；旧 Mod 只读 direct
  # {"code":"MDT-7K3F9Q","name":"周末打波","display_name":"...",
  #  "node":{"id":"node-1","name":"上海节点","addr":"1.2.3.4","room_port":23456},
  #  "direct":{"mode":"upnp","addr":"8.8.8.8","port":6567},
  #  "direct_candidates":[{"mode":"upnp","addr":"8.8.8.8","port":6567},
  #                       {"mode":"stun","addr":"8.8.8.8","port":6567}]}
GET /api/rooms/public
  # 公开房间列表（结构同 /api/rooms/:code），可按 online/owner/node 过滤

# 管理端（需要论坛 admin session）
GET    /api/admin/nodes/tokens          # 列出所有 token（脱敏，不返回完整 token）
POST   /api/admin/nodes/tokens          # 生成新社区节点 token → 返回 {token, id, registration}
DELETE /api/admin/nodes/tokens/:id      # 撤销 token
GET    /api/admin/rooms
POST   /api/admin/rooms/:code/close
POST   /api/admin/rooms/:code/hide
```

## 5. 版本演进规则

- 新增字段不升版本（收端忽略未知字段）；改变语义/删字段升 `ver`；
- `create_room.node_id`、`relay_addr`、`relay_tunnel_port`、`direct`、`/api/nodes/available`、`/api/auth/refresh` 与 `/api/rooms/:code` 都是 additive change：旧 Mod 不传/不查，新控制面仍自动选点；新 Mod 连旧控制面时节点列表/验证状态刷新/房间码解析或 direct 可能不可用，但基础开房流程不变；
- 新增展示字段必须可选，例如 `mod_version`、`server_version`、`node.name`、`display_name` 缺省时降级显示；
- 控制面同时兼容至少前一个 `ver`；
- 隧道二进制帧以 magic 区分，不认识的 type 丢弃。
