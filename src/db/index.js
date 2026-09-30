'use strict';

const mysql = require('./mysql');
const redis = require('./redis');
const { runMigrations } = require('./migrator');

// 初始化数据库（迁移走 NNN_slug.sql + schema_version 表）
async function initDatabase() {
  await runMigrations(mysql.pool);
  console.log('Database initialized (MySQL + Redis)');
}

module.exports = {
  mysql,
  redis,

  initDatabase,

  close: async () => {
    await mysql.close();
    await redis.close();
  }
};
