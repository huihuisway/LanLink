# LanLink 服务端

Mindustry 联机中继：房主装 Mod 一键开房，客人用**原版游戏**直连节点的房间
公网端口即可加入。协议 v2 冻结于 `mindustry-mod/proto/PROTOCOL.md`，
本服务逐字实现该协议，不得偏离；ArcNet UDP 按源地址路由的铁律见
`mindustry-mod/docs/RESEARCH.md` §2。

## 架构：两个独立进程

1. **控制面** `src/app.js`（HTTP :5100，同端口 WS 升级）
   - `/ws/mod`：房主 Mod 连接（hello / create_room / close_room / ping，断线 60s 宽限，
     `hello.resume=room_token` 可恢复）
   - `/ws/node`：节点连接（register 校验 tokenMap 白名单 / heartbeat 10s，
     30s 无心跳摘除并销毁其上房间 / open_room / room_opened / room_stat）
   - `/ws/guest`：客人 Mod 连接（hello / join_request / join_accepted / peer_join / peer_left，
     5 分钟未加入房间空闲超时，支持直连候选交换用于 P2P 打洞）
   - MySQL：`rooms_history`、`bandwidth_logs`（room_stat 随心跳批量落库）；
     迁移走 `src/db/migrations/NNN_slug.sql` + `schema_version` 表
   - Redis：全部 `lanlink:` 前缀（`lanlink:room:{code}` Hash、
     `lanlink:node:{id}` TTL 30s、`lanlink:invite:{userId}:{roomCode}` 邀请、
     `lanlink:auth:device:{sessionId}` 设备会话、`lanlink:auth:refresh:{userId}` 刷新限流、
     `lanlink:login:ip:{ip}` / `lanlink:login:user:{name}` 登录限流）
   - HTTP API：
     - `GET /api/health`、`GET /api/version`
     - `GET /api/nodes/available`、`GET /api/rooms/public`、`GET /api/rooms/:code`
     - `POST /api/auth/login`（用户名密码 + IP/用户名双限流）
     - `POST /api/auth/code/exchange`（论坛识别码换 token）
     - `GET /api/auth/me`、`POST /api/auth/refresh`
     - `POST /api/auth/device/start`、`POST /api/auth/device/poll`（已废弃，过渡期保留）
     - `GET /api/friends`、`GET /api/friends/requests`、`POST /api/invites/send`、`POST /api/invites/respond`
     - `GET /api/admin/`、`/admin/rooms`、`/admin/nodes`、`/admin/nodes/tokens`、`/admin/audit`
   - 认证：论坛登录桥接（forumClient）+ MindAuth 设备授权流（Phase C，已废弃）
   - 安全：Security headers（X-Content-Type-Options / X-Frame-Options 等）、CORS 白名单、
     客户端 IP 统一解析（ali-real-client-ip → x-real-ip → cf-connecting-ip → x-forwarded-for[0]）

2. **边缘节点** `src/node/agent.js`（独立进程，只连控制面 WS，不连数据库）
   - 隧道端口（TUNNEL_PORT）：TCP listener（控制链 0x01 / 数据链 0x02，
     首帧 25 字节 `LLK1` 握手）+ UDP socket（`LLKU` 注册 0x03 / 数据 0x01 / 关闭 0x02）
   - 每房间一个公网端口（PORT_RANGE 内分配，TCP+UDP 同号）：
     TCP 客人 → new_conn → accept_conn + 数据链 → splice；
     UDP 按客人源地址分 sessionId（2 分钟无流量过期），回程**必须从房间公网
     UDP socket 发回**——保证客人视角源端口稳定（ArcNet 铁律）
   - 掉线指数退避重连，重连后重新 register；房间状态以控制面为准
     （控制面重发 open_room，节点幂等处理）

## 认证与权限

- **匿名模式**：未登录用户可创建/加入房间（部分节点可能要求登录）
- **论坛登录**：用户名密码登录、论坛识别码兑换 token
- **手机号验证**：已登录用户需验证手机号才能创建/加入房间（`phone_verification_required`）
- **节点访问控制**：
  - `NODE_ACCESS_CONFIG_JSON` 配置默认访问策略（`anonymous` / `login`）
  - 可按节点设置 `roles`（角色白名单）、`tags`、`region`
  - 社区节点 token 通过 `COMMUNITY_TOKENS_FILE` 或 `COMMUNITY_TOKENS_JSON` 配置
- **管理员**：论坛 admin/super_admin 角色可访问 `/api/admin/*`

## 选点与直连

- **自动选点**：综合考虑节点会话数、房间数、带宽使用量（权重 0.50 / 0.30 / 0.20）
- **手动选点**：`create_room.node_id` 精确匹配，或 `relay_addr` + `relay_tunnel_port` 地址匹配
- **直连候选（M2 P2P 预留）**：
  - 房主通过 `direct` / `direct_candidates` 上报 UPnP/STUN/manual 地址
  - 客人通过 `candidates` 上报 local/upnp/stun/manual 地址
  - 控制面透传候选用于 P2P 打洞（实际打洞逻辑未实现）

## 公共房间与大厅

- 房主创建房间时 `public: true` 显式同意公开（opt-in）
- `GET /api/rooms/public` 返回所有公开且未隐藏的房间
- 管理员可通过 `/api/admin/rooms/:code/hide` 隐藏房间

## 连接监控

- `connectionMonitor.js` 每 60 秒输出连接统计（Mod/Node/Guest 连接数、活跃房间、在线节点、内存使用）
- 告警阈值：Guest > 100、Mod > 50、内存 > 500MB
- 空闲超时：房主 30 分钟、客人 5 分钟（未创建/加入房间时）

## 命令

```bash
npm install
cp .env.example .env          # 控制面配置
cp node.env.example node.env  # 节点配置
npm run dev        # 控制面（node --watch）
npm run dev:node   # 边缘节点
npm start / npm run start:node
npm test           # node --test tests/ —— 不依赖真实数据库与游戏
```

## 测试

- `tests/tunnel.test.js`：fake-game-server（TCP/UDP echo，UDP 回包携带收到的源端口）
  + 进程内 relay + fake-host + 双 fake-guest，断言 TCP 透传、UDP 防串包
  （两客人到达游戏服务器的源端口不同）、回程各归各家、会话过期
- `tests/control.test.js`：控制面 WS 全流程（mock 节点 + mock mod + mock guest），
  宽限定时器与心跳超时均可注入缩短；覆盖手机号验证、社区节点 token、direct_candidates、
  admin token CRUD
- `tests/auth.test.js`：认证流程（客户端 IP 解析、tokenService、code/exchange、
  refresh、login 限流）
- `tests/nodePicker.test.js`：选点逻辑（自动选点负载均衡）
- `tests/helpers/fakeHost.js`：Node 实现的 Mod 侧隧道协议参考实现，
  真实 Mod 对照它调试

## 环境变量

关键配置项（详见 `.env.example` 和 `node.env.example`）：

**控制面**：
- `NODE_ENV`：生产环境必须设为 `production`
- `NODE_TOKENS`：官方节点 token 白名单（逗号分隔）
- `COMMUNITY_TOKENS_FILE` / `COMMUNITY_TOKENS_JSON`：社区节点 token 配置
- `NODE_ACCESS_CONFIG_JSON`：节点访问策略
- `FORUM_BASE_URL` / `FORUM_EXTERNAL_API_KEY`：论坛登录桥接
- `FORUM_VERIFICATION_PAGE_URL`：手机号验证页面
- `MINDAUTH_BASE_URL`：MindAuth 设备授权（已废弃）
- `LANLINK_TOKEN_SECRET`：token 签名密钥
- `CORS_ALLOWED_ORIGINS`：CORS 白名单（生产环境必须配置）
- `MYSQL_*` / `REDIS_*`：数据库连接

**边缘节点**：
- `CONTROL_URL`：控制面 WS 地址
- `NODE_TOKEN`：管理员签发的 token
- `PUBLIC_ADDR`：节点公网 IP
- `TUNNEL_PORT` / `PORT_RANGE`：隧道端口与房间公网端口范围；支持多个逗号分隔范围
- `MBPS_LIMIT`：带宽上限
- `HEARTBEAT_MS`：节点心跳间隔
- `REQUIRES_LOGIN`：是否要求用户登录才能使用节点

**节点环境变量文件**：默认优先读取当前目录的 `node.env`，不存在时读取 `.env`；可用启动进程环境变量 `LANLINK_NODE_ENV` 指定其他文件。
