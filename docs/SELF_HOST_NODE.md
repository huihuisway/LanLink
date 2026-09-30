# 自建 LanLink 节点指南

本文档说明如何在自己的服务器上部署 LanLink 边缘节点，作为"社区节点"加入控制面。

## 前置要求

- **公网 IPv4 地址**：节点必须能从公网直接访问
- **Node.js 18+**：运行 `agent.js`
- **开放端口**：
  - 1 个隧道端口（默认 20000，TCP + UDP）
  - 一个端口范围作为房间端口（默认 20001-20099，TCP + UDP）
- **稳定带宽**：每并发会话约 0.5-2 Mbps，根据预期并发设置上限

## 1. 申请节点 token

社区节点不能自行注册，必须由控制面管理员签发 token。
联系管理员并提供：
- 节点名称（如 "广州社区节点"）
- 地区（如 "华南"）
- 简短描述（可选）
- 维护者论坛账号（可选，会显示在节点列表）

管理员会通过 `/api/admin/nodes/tokens` 生成 token 并把完整的 token 字符串返回给你。**token 只显示一次**，请立即保存。

## 2. 准备服务器

### 2.1 克隆 / 获取代码

```bash
git clone <control-plane-repo-url> LanLink
cd LanLink
npm install
```

（或直接下载发布包）

### 2.2 配置 `.env` 或 `node.env`

在 LanLink 目录下创建 `node.env`：

```env
# 控制面 WS 地址
CONTROL_URL=ws://control.example.com:5100/ws/node

# 管理员签发的 token
NODE_TOKEN=abc123def456...

# 节点显示名称
NODE_NAME=广州社区节点

# 公网地址（客人用这个地址连你；必须是公网可达的 IP）
PUBLIC_ADDR=1.2.3.4

# 隧道端口（TCP+UDP 都要开放）
TUNNEL_PORT=20000

# 房间端口范围（TCP+UDP 都要开放）
PORT_RANGE_MIN=20001
PORT_RANGE_MAX=20099

# 带宽上限（Mbps）
MBPS_LIMIT=30

# 心跳间隔（毫秒，默认 10000）
HEARTBEAT_MS=10000
```

### 2.3 防火墙 / 安全组

开放以下端口（TCP + UDP）：

```
20000      # 隧道端口
20001-20099  # 房间端口范围
```

**示例：ufw**
```bash
ufw allow 20000:20099/tcp
ufw allow 20000:20099/udp
```

**示例：阿里云安全组**
- 入方向添加 2 条规则：TCP 20000-20099 / UDP 20000-20099，源 0.0.0.0/0

## 3. 启动节点

```bash
node src/node/agent.js
```

正常输出：
```
[agent] connecting to ws://control.example.com:5100/ws/node
[agent] registered as node-xyz
[relay] tunnel TCP listening on 0.0.0.0:20000
[relay] tunnel UDP listening on 0.0.0.0:20000
[relay] port pool: 20001-20099
```

## 4. 配置 systemd 服务（生产推荐）

创建 `/etc/systemd/system/lanlink-node.service`：

```ini
[Unit]
Description=LanLink Edge Node
After=network.target

[Service]
Type=simple
User=lanlink
WorkingDirectory=/opt/LanLink
EnvironmentFile=/opt/LanLink/node.env
ExecStart=/usr/bin/node src/node/agent.js
Restart=always
RestartSec=5
LimitNOFILE=65535

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now lanlink-node
sudo systemctl status lanlink-node
```

## 5. 验证

1. 让管理员通过 `/api/admin/nodes` 确认你的节点 `online: true`
2. 让管理员在 `/api/nodes/available` 看到你的节点
3. 在 Mod 里刷新节点列表，应看到 "社区节点 · <你的维护者名>" 分组下有你的节点
4. 选你的节点开房，验证游戏流量确实走你的服务器（看节点日志的 `room_stat`）

## 6. 运维

### 监控

```bash
# 查看节点日志
journalctl -u lanlink-node -f

# 手动触发心跳查看状态
# （节点每 10s 自动心跳到控制面，无需手动干预）
```

### 升级

节点代码与控制面解耦，可直接 `git pull` + 重启：

```bash
cd /opt/LanLink
git pull
sudo systemctl restart lanlink-node
```

### 故障排查

| 现象 | 可能原因 |
|---|---|
| `auth_failed: 节点 token 无效` | token 错误 / 已被管理员撤销 |
| 控制面看不到节点在线 | 防火墙未开 / `PUBLIC_ADDR` 错误 / WS 地址错误 |
| 客人能加入但游戏中途断开 | 端口范围不够 / 带宽打满 / 节点进程被 OOM |
| 节点频繁重启 | 控制面心跳超时（默认 30s），检查节点到控制面网络 |

## 7. 下线节点

- **临时下线**：`systemctl stop lanlink-node`，控制面 30s 内自动摘除
- **永久撤销**：联系管理员调用 `DELETE /api/admin/nodes/tokens/:id`，token 失效后节点即使重启也注册不上

## 8. 治理约定

- 社区节点应保持稳定在线（建议 ≥ 80% 时间）
- 不得用于非 LanLink 流量（控制面会审计 bandwidth_logs）
- 不得修改 agent.js 协议（不同版本会被控制面拒绝）
- 严重违规会被管理员撤销 token

## 参考

- 协议：`proto/PROTOCOL.md`
- 控制面：本仓库根目录
- Mod：`mindustry-mod/`
