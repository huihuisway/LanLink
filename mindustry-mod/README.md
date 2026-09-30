# LanLink Mod

Mindustry 联机 Mod：通过公共控制面 + 边缘中继节点让原版 / Mod 客户端跨网络联机。
同时支持 v7（build 146/147）与 v8（build 159+），桌面与 Android 同等优先。

## 安装

1. 从 [论坛资源区 / MindFileList / QQ 群] 下载 `LanLink.jar`
2. 把 jar 放到 Mindustry 的 `mods/` 目录
   - 桌面：`%APPDATA%\Mindustry\mods\`（Windows）或 `~/.local/share/Mindustry/mods/`（Linux）
   - Android：`/sdcard/Mindustry/mods/`
3. 启动游戏，Mod 会自动加载（不改变原版行为）

## 使用

### 房主

1. 游戏内点「开放主机」（设置想要的游戏参数）
2. 在 host 对话框点 `LanLink` 按钮（或暂停菜单点 `LanLink 联机`）
3. 配置控制面地址（默认需要填写管理员提供的地址）
4. 可选：用论坛识别码登录（解锁更多中继节点）
5. 可选：勾选"优先直连"（UPnP + STUN + 手动，减少中继流量）
6. 选择中继节点（或让控制面自动选）
7. 点「开放联机」
8. 把显示的**房间码**发给朋友

### 客人

1. 主菜单或暂停菜单点「LanLink 联机」
2. 配置同样的控制面地址
3. 输入房主给的房间码
4. 点「加入联机」
5. Mod 会自动尝试直连 → 回退中继

### 原版玩家

- 不需要装 Mod
- 直接输入房主给的**公网地址**（`addr:port`）加入

## 直连模式

Mod 会按下列优先级尝试直连，全部失败自动回退中继：

| 模式 | 说明 |
|---|---|
| 手动直连 | 用户填写已知公网 IP + 端口（优先级最高） |
| UPnP | 自动请求路由器映射端口（成功率依赖路由器） |
| STUN | 通过 STUN 服务器发现公网地址（默认用 `stun.nextcloud.com`） |
| UDP 打洞 | 双方各向对方候选发探测包，验证双向可达 |

直连失败才会走中继。客人侧对每个候选最多尝试 8 秒。

## 控制面与中继节点

- **控制面**：只走信令（HTTP + WS），不转发游戏流量
- **中继节点**：转发游戏 TCP/UDP 流量，部署在公网服务器上
- **官方节点**：由控制面管理员部署
- **社区节点**：由社区成员自建，通过管理员签发的 token 注册

控制面支持多节点，Mod 会自动列出可用节点，按"官方 / 社区"分组显示。

## 配置项

Mod 通过 `Core.settings` 存储下列配置（可在 UI 中编辑）：

| Key | 说明 |
|---|---|
| `lanlink-control-url` | 控制面 WS 地址（如 `ws://control.example.com:5100`） |
| `lanlink-enable-direct` | 是否启用直连（默认 `true`） |
| `lanlink-manual-direct-addr` | 手动直连公网 IP（可选） |
| `lanlink-manual-direct-port` | 手动直连端口（可选） |
| `lanlink-stun-server` | 自定义 STUN 服务器（可选，留空用公共） |
| `lanlink-auth-quick-code` | 论坛识别码（登录成功后自动清空） |

## 构建

```powershell
# Use an installed JDK 17. Run these commands from mindustry-mod/.
# 桌面 jar
& ".\mod\gradlew.bat" -p ".\mod" jar "-PgameVersion=v146"

# v8 目标
& ".\mod\gradlew.bat" -p ".\mod" jar "-PgameVersion=v159.7"

# 桌面 + Android 部署包（需要 ANDROID_HOME）
& ".\mod\gradlew.bat" -p ".\mod" deploy "-PgameVersion=v146"
```

### 发布构建

使用 Gradle 的 `releaseBuild` 任务生成桌面与 Android 合并包：

```bash
cd mod
./gradlew clean releaseBuild -PgameVersion=v146
```

任务会生成并校验：

- `mod/build/libs/LanLink.jar`：桌面 + Android 合并分发包
- `mod/build/libs/LanLink.jar.sha256`：SHA-256 校验文件

本地执行 `releaseBuild` 同样需要 JDK 17，以及包含 `android.jar` 和 `d8` 的 Android SDK；通过 `ANDROID_HOME` 或 `ANDROID_SDK_ROOT` 指定 SDK 路径。

## 协议

`proto/PROTOCOL.md` 是控制面 / 节点 / Mod 三端的共享协议契约。
Mod 与控制面协议为 v2，包含强制版本检查和 M2 扩展；完整约定见 `proto/PROTOCOL.md`。

## 反馈

- 问题 / 建议：QQ 群 / 论坛 LanLink 板块
- 自建节点申请：联系控制面管理员
