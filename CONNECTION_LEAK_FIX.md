# 连接泄漏修复说明

## 问题描述
控制服务器运行约一天后出现连接超时和崩溃，重启后恢复正常。

## 根本原因
**WebSocket 连接泄漏**：客户端连接后如果不发送业务消息（如客人只发 `hello` 但不 `join_request`），连接会永远保持，导致：
1. 文件描述符耗尽
2. 内存持续增长
3. 最终无法接受新连接

## 修复内容

### 1. guestSocket.js - 客人连接空闲超时
- **问题**：客人连接后如果不加入房间，连接永不超时
- **修复**：添加 5 分钟空闲超时，超时后自动断开
- **代码位置**：
  ```javascript
  const IDLE_TIMEOUT_MS = 5 * 60 * 1000;  // 5 分钟

  // 连接时启动定时器
  state.idleTimer = setTimeout(() => {
    if (!state.room) {
      log.info(`[guest] 空闲超时，断开连接（未加入房间）`);
      try { ws.close(); } catch { /* ignore */ }
    }
  }, IDLE_TIMEOUT_MS);

  // 加入房间后清除定时器
  if (state.idleTimer) {
    clearTimeout(state.idleTimer);
    state.idleTimer = null;
  }

  // 连接关闭时清除定时器
  ws.on('close', () => {
    if (state.idleTimer) {
      clearTimeout(state.idleTimer);
      state.idleTimer = null;
    }
    // ... 原有清理逻辑
  });
  ```

### 2. modSocket.js - 房主连接空闲超时
- **问题**：房主连接后如果不创建房间，连接永不超时
- **修复**：添加 30 分钟空闲超时（房主需要更多准备时间）
- **代码位置**：
  ```javascript
  const HOST_IDLE_TIMEOUT_MS = 30 * 60 * 1000;  // 30 分钟

  // 连接时启动定时器
  state.idleTimer = setTimeout(() => {
    if (!state.room) {
      log.info(`[mod] 空闲超时，断开连接（未创建房间）`);
      try { ws.close(); } catch { /* ignore */ }
    }
  }, HOST_IDLE_TIMEOUT_MS);

  // 创建房间后清除定时器
  if (state.idleTimer) {
    clearTimeout(state.idleTimer);
    state.idleTimer = null;
  }
  ```

### 3. app.js - 修复优雅关闭
- **问题**：关闭时只清理了 `modWss` 和 `nodeWss`，遗漏了 `guestWss`
- **修复**：
  ```javascript
  // 2. 关闭所有 WS 连接与后台定时器
  for (const ws of modWss.clients) ws.terminate();
  for (const ws of nodeWss.clients) ws.terminate();
  for (const ws of guestWss.clients) ws.terminate();  // 新增
  ```

### 4. connectionMonitor.js - 连接监控（新增）
- **功能**：每 60 秒输出连接统计和内存使用情况
- **告警条件**：
  - Guest 连接数 > 100
  - Mod 连接数 > 50
  - 内存使用 > 500MB
- **启用方式**：已在 `app.js` 中集成，自动启动

## 部署步骤

1. **重启控制服务器**（应用代码更改）：
   ```bash
   cd .
   pm2 restart lanlink-control  # 或其他进程管理器
   ```

2. **观察日志**：
   ```bash
   pm2 logs lanlink-control --lines 100
   ```

   应该能看到每 60 秒的连接统计输出：
   ```
   [monitor] 连接统计:
     Mod 连接: 3
     Node 连接: 2
     Guest 连接: 5
     活跃房间: 1
     在线节点: 2
     内存使用: 85MB / 128MB
   ```

3. **监控 24 小时**：
   - 观察连接数是否稳定
   - 观察内存是否持续增长
   - 观察是否有"空闲超时"日志

## 预期效果

### 修复前
- 运行 24 小时后，连接数可能累积到数百个
- 内存持续增长（可能超过 500MB）
- 最终无法接受新连接，用户报超时

### 修复后
- 连接数保持在合理范围（< 50 Mod, < 100 Guest）
- 内存稳定（通常 < 200MB）
- 空闲连接自动清理，不会累积

## 进一步诊断

如果问题仍然存在，可以：

1. **调整监控频率**：
   ```javascript
   // app.js 中修改 intervalMs
   const monitor = createConnectionMonitor({
     // ...
     intervalMs: 30000  // 改为 30 秒
   });
   ```

2. **启用详细日志**：
   ```bash
   # 设置环境变量
   export DEBUG=lanlink:*
   ```

3. **检查系统资源**：
   ```bash
   # Linux/Mac
   ulimit -n  # 查看文件描述符限制
   lsof -p <pid> | wc -l  # 查看打开的文件数

   # Windows (PowerShell)
   (Get-Process -Id <pid>).HandleCount
   ```

4. **堆快照分析**（高级）：
   ```bash
   # 生成堆快照
   kill -USR2 <pid>

   # 或使用 Chrome DevTools
   node --inspect app.js
   ```

## 相关文件
- `src/control/guestSocket.js` - 客人网关
- `src/control/modSocket.js` - 房主网关
- `src/control/connectionMonitor.js` - 连接监控（新增）
- `src/app.js` - 主入口

## 回滚方案
如果修复后出现问题，可以临时禁用空闲超时：

```javascript
// guestSocket.js 和 modSocket.js 中注释掉 setTimeout 部分
// state.idleTimer = setTimeout(() => { ... }, TIMEOUT_MS);
```

但这会导致连接泄漏问题重新出现，仅作为临时方案。
