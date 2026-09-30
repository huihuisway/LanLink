-- LanLink 初始表结构

-- 房间历史（房间销毁时写入一行）
CREATE TABLE IF NOT EXISTS rooms_history (
  id INT AUTO_INCREMENT PRIMARY KEY,
  code VARCHAR(16) NOT NULL,
  name VARCHAR(255),
  node_id VARCHAR(64),
  room_port INT,
  reason VARCHAR(32),
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  closed_at TIMESTAMP NULL,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

  INDEX idx_code (code),
  INDEX idx_node (node_id),
  INDEX idx_created (created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 流量统计（节点心跳携带的 room_stat 批量落库）
CREATE TABLE IF NOT EXISTS bandwidth_logs (
  id INT AUTO_INCREMENT PRIMARY KEY,
  node_id VARCHAR(64) NOT NULL,
  room_code VARCHAR(16) NOT NULL,
  conns INT DEFAULT 0,
  rx_bytes BIGINT NOT NULL DEFAULT 0,
  tx_bytes BIGINT NOT NULL DEFAULT 0,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

  INDEX idx_node_time (node_id, created_at),
  INDEX idx_room (room_code)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
