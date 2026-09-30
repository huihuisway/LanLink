# LanLink 配置指南

## 概述

LanLink 分为两部分：
- **控制面（服务端）**：管理房间、节点、用户认证
- **边缘节点**：实际的数据中转服务器

两者通过配置文件区分，使用不同的 `.env` 文件。

---

## 一、控制面配置

### 配置文件：`.env`（从 `.env.example` 复制）

```bash
cp .env.example .env
```

### 必需配置项

#### 1. 基础配置
```bash
# HTTP + WS 端口
PORT=5100

# 服务端版本（可选，默认读取 package.json）
LANLINK_SERVER_VERSION=0.2.0
```

#### 2. 数据库配置
```bash
# MySQL
MYSQL_HOST=localhost
MYSQL_PORT=3306
MYSQL_USER=root
MYSQL_PASSWORD=your_password
MYSQL_DATABASE=lanlink
MYSQL_POOL_SIZE=10

# Redis
REDIS_HOST=localhost
REDIS_PORT=6379
REDIS_PASSWORD=
REDIS_DB=0
```

#### 3. 节点配置
```bash
# 官方节点 token 白名单（逗号分隔）
# 第 i 个 token 注册的节点 id 为 node-i
NODE_TOKENS=token-for-node-1,token-for-node-2

# 社区节点 token 配置（JSON 文件或环境变量）
COMMUNITY_TOKENS_FILE=/path/to/community-tokens.json
# 或
COMMUNITY_TOKENS_JSON={"tokens":[{"token":"xxx","id":"community-1","name":"社区节点1"}]}

# 节点访问策略
# 示例：默认匿名可用，但 node-2 需要登录
NODE_ACCESS_CONFIG_JSON={"default_access":"anonymous","nodes":{"node-2":{"access":"login"}}}
```

#### 4. 认证配置
```bash
# JWT 密钥（生产环境必须修改！）
LANLINK_TOKEN_SECRET=your-secure-secret-key-here

# Token 有效期（秒，默认 30 天）
LANLINK_TOKEN_TTL_SECONDS=2592000
```

#### 5. 论坛集成配置
```bash
# 论坛基础 URL
FORUM_BASE_URL=https://forum.example.com

# 论坛外部 API 密钥（用于验证识别码）
FORUM_EXTERNAL_API_KEY=your-forum-api-key

# 论坛 API 路径
FORUM_QUICK_CODE_PATH=/api/external/v1/lanlink/quick-code/validate
FORUM_VERIFY_ENDPOINT=/api/auth/verify

# 手机号验证页面 URL（用户未验证时跳转）
FORUM_VERIFICATION_PAGE_URL=https://forum.example.com/verify-phone
```

#### 6. Mod 版本控制 ⭐ v2 新增
```bash
# 最新版本号（用于提示用户更新）
VERSION_LATEST=0.13.0

# Mod 下载页面 URL（用于提示用户从哪里下载）
VERSION_URL=https://forum.example.com/lanlink-download
```

**版本控制机制（协议 v2）**：
- 使用协议版本号（`protocolVersion`）控制 Mod 兼容性
- 当前协议版本：2
- 旧版本 Mod 连接时发送旧协议版本号，被服务端拒绝
- 用户收到 `upgrade_required` 错误，提示更新到最新版本

**强制用户升级流程**：
1. 服务端修改 `src/config.js`：`protocolVersion: 2 → 3`
2. Mod 端修改 `TunnelManager.java`：`PROTOCOL_VER = 3`
3. 重新编译 Mod 并部署
4. 旧版本 Mod 自动被拒绝，提示用户更新

**优势**：无需维护 Mod 版本白名单，升级简单直接。

**效果**：
- 旧版本 Mod（协议版本 1）连接时会收到错误：
  ```
  LanLink Mod 版本过旧，请更新到最新版本

  最新版本: 0.13.0
  需要协议版本: 2

  下载地址: https://forum.example.com/lanlink-download
  或访问论坛获取最新版本
  ```

#### 7. CORS 配置
```bash
# 允许的前端域名（逗号分隔；生产环境必须配置）
CORS_ALLOWED_ORIGINS=https://forum.example.com,https://lanlink.example.com
```

#### 8. 阿里云 ESA 反向代理配置

控制面始终使用 `X-Forwarded-For` 的第一个有效 IP 作为客户端地址，以便登录限流和管理审计在 ESA 后保持按用户分隔。

- 确保 ESA（或最后一层 Nginx/Caddy）覆盖该请求头，而不是保留客户端自行提交的首个值。
- 若源站可以被客户端直接访问，客户端可以伪造该头来规避基于 IP 的限流；应通过安全组或防火墙限制源站入口。
- 论坛和边缘节点不是控制面 HTTP 入站代理，无需配置它们的 IP。

#### 9. 其他配置
```bash
# 公告消息
MOTD=欢迎使用 LanLink 联机中继

# STUN 服务器（可选，用于 P2P 打洞）
STUN_SERVERS=stun:stun.example.com:3478
```

---

## 二、边缘节点配置

### 配置文件：`node.env`（从 `node.env.example` 复制）

```bash
cp node.env.example node.env
```

### 必需配置项

```bash
# 控制面 WS 地址
CONTROL_URL=ws://control-server:5100/ws/node

# 节点 token（必须在控制面 NODE_TOKENS 白名单里）
NODE_TOKEN=your-node-token

# 节点名称（玩家可见）
NODE_NAME=上海节点

# 节点公网地址（玩家连接使用）
PUBLIC_ADDR=1.2.3.4

# 隧道端口（TCP + UDP 同号）
TUNNEL_PORT=20000

# 房间端口池（TCP + UDP 同号）
# 支持多段范围：20001-20099,30001-30099
PORT_RANGE=20001-20099

# 带宽上限（Mbps）
MBPS_LIMIT=30

# 是否要求用户登录
REQUIRES_LOGIN=false
```

### 节点配置说明

| 配置项 | 说明 | 示例 |
|--------|------|------|
| `CONTROL_URL` | 控制面 WebSocket 地址 | `ws://control:5100/ws/node` |
| `NODE_TOKEN` | 节点认证 token | `token-for-node-1` |
| `NODE_NAME` | 节点显示名称 | `上海节点` |
| `PUBLIC_ADDR` | 节点公网 IP | `1.2.3.4` |
| `TUNNEL_PORT` | 隧道端口 | `20000` |
| `PORT_RANGE` | 房间端口范围 | `20001-20099` |
| `MBPS_LIMIT` | 带宽上限 | `30` |
| `REQUIRES_LOGIN` | 是否需要登录 | `false` |

---

## 三、部署检查清单

### 控制面部署前检查

- [ ] 配置 MySQL 和 Redis 连接
- [ ] 设置 `LANLINK_TOKEN_SECRET`（生产环境必须修改！）
- [ ] 配置 `NODE_TOKENS`（官方节点 token）
- [ ] 配置 `FORUM_BASE_URL` 和 `FORUM_EXTERNAL_API_KEY`
- [ ] 配置 `FORUM_VERIFICATION_PAGE_URL`（手机号验证页面）
- [ ] 配置 `VERSION_LATEST` 和 `VERSION_URL`
- [ ] 配置 `CORS_ALLOWED_ORIGINS`（生产环境）
- [ ] 确认 ESA 在 `X-Forwarded-For` 首位传递客户端 IP，并覆盖客户端自带的同名请求头
- [ ] 限制控制面源站入口，避免客户端绕过 ESA 直接伪造 `X-Forwarded-For`
- [ ] 初始化数据库：`node scripts/init-db.js`

### 边缘节点部署前检查

- [ ] 配置 `CONTROL_URL`（指向控制面）
- [ ] 配置 `NODE_TOKEN`（必须在控制面白名单中）
- [ ] 配置 `PUBLIC_ADDR`（节点公网 IP）
- [ ] 配置 `TUNNEL_PORT` 和 `PORT_RANGE`
- [ ] 确保防火墙开放相关端口
- [ ] 测试与控制面的连接

---

## 四、环境变量快速参考

### 控制面必需环境变量

```bash
# 最小化配置（开发环境）
PORT=5100
MYSQL_HOST=localhost
MYSQL_DATABASE=lanlink
NODE_TOKENS=dev-node-token
LANLINK_TOKEN_SECRET=dev-secret
FORUM_BASE_URL=http://localhost:4000
```

### 控制面生产环境配置

```bash
PORT=5100
MYSQL_HOST=db.example.com
MYSQL_USER=lanlink
MYSQL_PASSWORD=secure_password
MYSQL_DATABASE=lanlink
REDIS_HOST=redis.example.com
REDIS_PASSWORD=redis_password
NODE_TOKENS=prod-token-1,prod-token-2
LANLINK_TOKEN_SECRET=production-secret-key
FORUM_BASE_URL=https://forum.example.com
FORUM_EXTERNAL_API_KEY=forum-api-key
FORUM_VERIFICATION_PAGE_URL=https://forum.example.com/verify-phone
VERSION_LATEST=0.13.0
VERSION_URL=https://forum.example.com/download
CORS_ALLOWED_ORIGINS=https://forum.example.com
# 阿里云 ESA 必须将客户端 IP 放在 X-Forwarded-For 首位
```

### 边缘节点配置

```bash
CONTROL_URL=ws://control.example.com:5100/ws/node
NODE_TOKEN=prod-token-1
NODE_NAME=上海节点
PUBLIC_ADDR=1.2.3.4
TUNNEL_PORT=20000
PORT_RANGE=20001-20099
MBPS_LIMIT=30
REQUIRES_LOGIN=false
```

---

## 五、常见问题

### Q: 如何强制用户升级到最新版本？
A: 升级协议版本号：
1. 服务端修改 `src/config.js`：`protocolVersion: 2 → 3`
2. Mod 端修改 `TunnelManager.java`：`PROTOCOL_VER = 3`
3. 重新编译 Mod 并部署服务端
4. 旧版本 Mod 自动被拒绝，提示用户更新

### Q: 协议版本升级后，旧 Mod 会看到什么提示？
A: 旧 Mod 连接时会收到 `upgrade_required` 错误，显示：
```
LanLink Mod 版本过旧，请更新到最新版本
最新版本: 0.13.0
需要协议版本: 3
下载地址: https://forum.example.com/lanlink-download
```

### Q: `FORUM_VERIFICATION_PAGE_URL` 什么时候使用？
A: 当用户未验证手机号时，创建/加入房间会返回此 URL，引导用户去验证。

### Q: 节点token如何生成？
A: 可以使用任意字符串，建议 32 位以上的随机字符串：
```bash
openssl rand -hex 32
```

### Q: 如何添加社区节点？
A: 使用 `COMMUNITY_TOKENS_FILE` 或 `COMMUNITY_TOKENS_JSON` 配置，详见 `.env.example`。

---

## 六、配置文件位置

```
LanLink/
├── .env                    # 控制面配置（不要提交到 git）
├── .env.example            # 控制面配置模板
├── node.env                # 边缘节点配置（不要提交到 git）
└── node.env.example        # 边缘节点配置模板
```

---

## 七、安全建议

1. **不要提交 `.env` 和 `node.env` 到 git**
2. **生产环境必须修改 `LANLINK_TOKEN_SECRET`**
3. **使用强密码保护 MySQL 和 Redis**
4. **配置 HTTPS（通过反向代理）**
5. **定期轮换节点 token**
6. **监控异常连接和错误日志**
