# LanLink

Mindustry 联机中继项目，包含控制面、边缘节点和 Mindustry Java Mod。

## 目录

- `src/`：控制面 HTTP/WebSocket 服务和边缘节点 agent。
- `tests/`：控制面、认证、选点和 TCP/UDP 隧道测试。
- `mindustry-mod/mod/`：Mindustry Java Mod 的 Gradle 工程。
- `mindustry-mod/proto/PROTOCOL.md`：Mod、控制面和边缘节点共用的协议约定。

## 控制面与边缘节点

需要 Node.js 18 或更新版本。复制 `.env.example` 为 `.env`，复制 `node.env.example` 为 `node.env`，然后安装依赖：

```bash
npm install
npm run dev        # 控制面
npm run dev:node   # 边缘节点；存在 node.env 时会自动读取
```

运行测试：`npm test`。生产配置说明见 `CLAUDE.md`、`CONFIG_GUIDE.md` 和 `docs/`。

## Mindustry Mod

需要 JDK 17。构建 v7 桌面包：

```bash
cd mindustry-mod/mod
./gradlew clean jar -PgameVersion=v146
```

构建 v8 桌面包可将版本改为 `v159.7`。桌面与 Android 合并包使用 `deploy`，并需要配置 Android SDK。
更多 Mod 使用说明见 [`mindustry-mod/README.md`](mindustry-mod/README.md)。
