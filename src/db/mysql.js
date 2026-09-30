'use strict';

const mysql = require('mysql2/promise');
const config = require('../config');

// 创建连接池
const pool = mysql.createPool({
  host: config.mysql.host,
  port: config.mysql.port,
  user: config.mysql.user,
  password: config.mysql.password,
  database: config.mysql.database,
  connectionLimit: config.mysql.connectionLimit,
  waitForConnections: true,
  charset: 'utf8mb4',
  // DECIMAL 列默认以字符串返回，会让算术退化成字符串拼接
  decimalNumbers: true,
  connectTimeout: 30000,
  enableKeepAlive: true,
  keepAliveInitialDelay: 10000
});

// 异步查询封装
async function query(sql, params = []) {
  const [results] = await pool.execute(sql, params);
  return results;
}

// 获取单行
async function getOne(sql, params = []) {
  const results = await query(sql, params);
  return results[0] || null;
}

// 获取所有行
async function getAll(sql, params = []) {
  return await query(sql, params);
}

// 执行写入操作，返回影响信息
async function run(sql, params = []) {
  const [result] = await pool.execute(sql, params);
  return {
    affectedRows: result.affectedRows,
    insertId: result.insertId,
    changedRows: result.changedRows
  };
}

/**
 * 房间销毁时写入历史表
 * @param {{code:string,name?:string,nodeId?:string,roomPort?:number,reason?:string,createdAt?:number}} entry
 */
async function insertRoomHistory(entry) {
  await pool.execute(
    `INSERT INTO rooms_history (code, name, node_id, room_port, reason, created_at, closed_at)
     VALUES (?, ?, ?, ?, ?, FROM_UNIXTIME(? / 1000), NOW())`,
    [
      entry.code,
      entry.name || null,
      entry.nodeId || null,
      entry.roomPort || null,
      entry.reason || null,
      entry.createdAt || Date.now()
    ]
  );
}

/**
 * 批量写入 room_stat（每心跳一批，一条多行 INSERT）
 * @param {{nodeId:string,code:string,conns:number,rx:number,tx:number}[]} rows
 */
async function insertBandwidthLogs(rows) {
  if (!Array.isArray(rows) || rows.length === 0) return;
  const placeholders = rows.map(() => '(?, ?, ?, ?, ?)').join(', ');
  const params = [];
  for (const r of rows) {
    params.push(r.nodeId, r.code, r.conns || 0, r.rx || 0, r.tx || 0);
  }
  await pool.query(
    `INSERT INTO bandwidth_logs (node_id, room_code, conns, rx_bytes, tx_bytes) VALUES ${placeholders}`,
    params
  );
}

// 关闭连接池
async function close() {
  await pool.end();
}

module.exports = {
  pool,
  query,
  getOne,
  getAll,
  run,
  insertRoomHistory,
  insertBandwidthLogs,
  close
};
