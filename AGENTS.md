# AI Agent Context

See [CLAUDE.md](CLAUDE.md) for the authoritative AI context of this repository.

## Quick Reference

- **协议 v2**：见 `mindustry-mod/proto/PROTOCOL.md`，本服务逐字实现
- **ArcNet UDP 铁律**：按源地址路由，见 `mindustry-mod/docs/RESEARCH.md` §2
- **两个独立进程**：控制面 (`src/app.js`, :5100) + 边缘节点 (`src/node/agent.js`)
- **三个 WS 端点**：`/ws/mod`（房主）、`/ws/node`（节点）、`/ws/guest`（客人）
- **认证**：匿名 + 论坛登录 + 设备授权（已废弃）+ 手机号验证
- **测试**：`npm test` — 97 个测试全部通过，不依赖真实数据库

## 命令

```bash
npm install
cp .env.example .env          # 控制面配置
cp node.env.example node.env  # 节点配置
npm run dev        # 控制面（node --watch）
npm run dev:node   # 边缘节点
npm start / npm run start:node
npm test           # node --test tests/
```
