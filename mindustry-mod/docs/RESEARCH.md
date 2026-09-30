# M0 调研结论（2026-07-27）

## 1. 版本与依赖（已实证）

- **v8 已正式发布**，不再是 beta：最新 v8 Build 159.7（2026-07-19）。v7 最终版为
  Build 146。双支持策略不变（国内仍有大量 v7 玩家）。
- 编译目标与依赖通道（均已编译通过）：
  - **v7 = `v146`**：jitpack `com.github.Anuken.Arc:arc-core:v146` +
    `com.github.Anuken.Mindustry:core:v146`。注意 core 的 POM 把 Arc 模块锁在
    commit 哈希（如 `arcnet:152e49944a`，jitpack 无现成构建）——需用
    `resolutionStrategy` 把 Arc 组强制到 `v146`（官方模板同款做法）。
  - **v8 = `v159.7`**：GitHub Releases 的 `dependencies.jar`（Ivy 仓库直拉，
    官方新模板做法；v146 无此资产，故 v7 走 jitpack）。`v147`/`v149` 两个 tag
    在 jitpack 均为 404，不可用。
- **字节码策略**：Jabel（`com.github.Anuken:jabel:93fde537c7`）+ `--release 8`，
  Java 17 语法编译为 **Java 8 字节码（major 52，已验证）**。v7 桌面/Android 要求
  8 字节码，v8 的 17 JVM 向下兼容——**单一 jar 通吃 v7+v8**。
  Jabel 在 JDK 17 需要 `gradle.properties` 里一串 `--add-exports`（已配）。
- `mod.hjson` 关键项：`minGameVersion: 146` + **`hidden: true`**（工具型 Mod，
  不参与客户端 Mod 校验——原版客人可进房的前提）+ `java: true`
  + **`legacyCompatible: true`**（见下，缺它 v8 直接拒载）。
- **v8 的 Java Mod 门槛（实测踩坑，2026-07-27）**：v8 源码
  `Vars.minJavaModGameVersion = 154`——Java Mod 的 `minGameVersion` < 154 会被
  标记"不兼容 v8"拒绝加载（用户在 159 实测复现）。官方豁免位：
  `ModMeta.legacyCompatible`（注释原文 "Mod from an older major version that is
  compatible with the latest one as well"）。已确认：v157.4（v8 稳定线起点
  157.1 之后）含此字段；v146 的 Arc Json `ignoreUnknownFields` 默认 true，
  未知字段安全忽略。结论：`minGameVersion: 146` + `legacyCompatible: true`
  单 jar 通吃 **v7(146) + v8 稳定版(157.1+)**；v8 早期预发布版（147–153，
  mdtbbs 版本库里标 prerelease 的那批）不保证，不作为支持目标。
- 版本分布参考（file.mdtbbs.cn/category/Mindustry/v8）：147→157 为 prerelease，
  157.1 起为 stable，最新 159.7 与 GitHub 一致。

## 2. ArcNet TCP/UDP 绑定机制（源码级确认，v146 commit `152e49944a`）

来源：`Arc/extensions/arcnet/src/arc/net/Server.java`（v146 与 master 均已核对）。

1. **UDP 是必需的**：连接建立后若 `udpRemoteAddress == null`，服务器在下一次
   TCP 事件时直接 `close(DcReason.error)`——**只转发 TCP 连不上游戏**。
2. **绑定机制**：客户端经 TCP 连上后，通过 **UDP** 发 `RegisterUDP{connectionID}`；
   服务器把该 UDP 包的**源地址**记为 `connection.udpRemoteAddress`，并经 TCP 回
   `RegisterUDP` 确认，连接才算完成。
3. **路由机制**：后续所有入站 UDP 按**源地址精确匹配**路由到连接
   （v146 线性扫描，v8 master 改为 `udpAddressToConnection` HashMap，语义相同）。
4. **推论（中继数据面铁律）**：到达房主游戏 socket 的每个客人流量必须来自
   **彼此不同且全程稳定的源地址** →
   - 房主 Mod 侧：每客人（每 session）一个独立本地 UDP socket；
   - 节点侧：按客人源地址分 UDP 会话，会话期内映射不变；
   - 共用一个 socket 必然串包/挤掉注册（`relay-poc.js --shared` 可实证）。

待实机验证（进入 M1 联调时顺带做）：`scratch/relay-poc.js` 默认模式双客人正常、
`--shared` 模式异常。源码结论已足够冻结协议。

## 3. Android 打包链路（已跑通）

- 无需完整 SDK：`build-tools_r34-windows.zip`（含 d8）+ `platform-33_r02.zip`
  （含 android.jar）两个包即可（注：`platform-34_r0x.zip` 在 dl.google.com 是 404，
  33 的 android.jar 用于 desugar classpath 足够）。
- `gradle deploy` 产出合并 jar：`.class`（桌面）+ `classes.dex`（Android，
  d8 `--min-api 14` desugar）共存于一个 `LanLink.jar`。
- **待办**：真机（v7 与 v8 各一）加载空 Mod 验证 —— 需要在手机上安装测试。

## 4. 本地工具链

`tools/`（已 gitignore）：Temurin JDK 17.0.19、Gradle 8.14、Android SDK 精简版
（build-tools 34.0.0 + platforms/android-33）。构建命令：

```
cd mod
# v7 目标（默认）           # v8 目标
gradlew jar                 gradlew jar -PgameVersion=v159.7
# 最终分发产物（桌面+Android 合并，需 ANDROID_HOME）
gradlew deploy
```
