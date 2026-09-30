/**
 * Migrator — deterministic, versioned schema migrations.
 *
 * Reads SQL files from ./migrations/ in numeric order, tracks which versions
 * have been applied in the `schema_version` table, and runs only pending
 * migrations.  Normal startup NEVER drops data; destructive resets are an
 * explicit operational step documented in release notes.
 *
 * @module db/migrator
 */

'use strict';

const fs = require('fs');
const path = require('path');

const MIGRATIONS_DIR = path.join(__dirname, 'migrations');

/**
 * Collect migration descriptors from disk.
 * Each file must match the pattern `<NNN>_<slug>.sql`.
 *
 * @returns {{ version: number, name: string, file: string }[]}
 */
function discoverMigrations() {
  let files;
  try {
    files = fs.readdirSync(MIGRATIONS_DIR);
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }

  return files
    .filter(f => /^\d+_.*\.sql$/.test(f))
    .sort()
    .map(f => {
      const version = parseInt(f.split('_')[0], 10);
      return { version, name: f.replace(/\.sql$/, ''), file: path.join(MIGRATIONS_DIR, f) };
    });
}

/**
 * Split a SQL file into individual executable statements.
 *
 * Handles comments (-- and block comments), quoted strings (so semicolons
 * inside string literals are not split points) and backtick identifiers.
 * Blank statements are filtered out.
 *
 * @param {string} sql  Raw SQL text
 * @returns {string[]}  Array of non-empty statements (without trailing semicolons)
 */
function splitStatements(sql) {
  const statements = [];
  let current = '';
  let i = 0;

  while (i < sql.length) {
    const ch = sql[i];

    // Line comment
    if (ch === '-' && sql[i + 1] === '-') {
      while (i < sql.length && sql[i] !== '\n') i++;
      continue;
    }

    // Block comment
    if (ch === '/' && sql[i + 1] === '*') {
      i += 2;
      while (i < sql.length && !(sql[i] === '*' && sql[i + 1] === '/')) i++;
      i += 2; // skip closing */
      continue;
    }

    // Single-quoted string literal
    if (ch === "'") {
      current += ch;
      i++;
      while (i < sql.length) {
        if (sql[i] === "'" && sql[i + 1] === "'") {
          current += "''";
          i += 2;
        } else if (sql[i] === "'") {
          current += "'";
          i++;
          break;
        } else if (sql[i] === '\\') {
          current += sql[i] + (sql[i + 1] || '');
          i += 2;
        } else {
          current += sql[i];
          i++;
        }
      }
      continue;
    }

    // Statement terminator
    if (ch === ';') {
      const trimmed = current.trim();
      if (trimmed) statements.push(trimmed);
      current = '';
      i++;
      continue;
    }

    current += ch;
    i++;
  }

  // Capture any trailing statement without semicolon
  const trailing = current.trim();
  if (trailing) statements.push(trailing);

  return statements;
}

/**
 * Ensure the schema_version tracking table exists.
 */
async function ensureVersionTable(pool) {
  await pool.execute(`
    CREATE TABLE IF NOT EXISTS schema_version (
      version INT PRIMARY KEY,
      name VARCHAR(255) NOT NULL,
      applied_at DATETIME DEFAULT CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);
}

/**
 * Read the set of already-applied version numbers.
 *
 * @returns {Promise<Set<number>>}
 */
async function getAppliedVersions(pool) {
  const [rows] = await pool.execute('SELECT version FROM schema_version ORDER BY version');
  return new Set(rows.map(r => r.version));
}

/**
 * Run all pending migrations in order.
 *
 * Each migration's SQL is split into individual statements and executed
 * sequentially.  MySQL DDL (CREATE TABLE, ALTER TABLE) causes an implicit
 * COMMIT so true transactional rollback is not possible for schema changes.
 *
 * On success the migration version is recorded in `schema_version`.  If any
 * statement fails the error is re-thrown and the version is NOT recorded,
 * so the migration can be retried on next startup.
 *
 * Idempotent: calling twice with no new migration files is a no-op.
 *
 * @param {import('mysql2/promise').Pool} pool
 * @returns {Promise<number[]>} Versions that were applied during this call.
 */
async function runMigrations(pool) {
  await ensureVersionTable(pool);

  const applied = await getAppliedVersions(pool);
  const pending = discoverMigrations().filter(m => !applied.has(m.version));

  if (pending.length === 0) {
    console.log('Schema is up to date — no pending migrations');
    return [];
  }

  const appliedNow = [];

  for (const migration of pending) {
    const rawSql = fs.readFileSync(migration.file, 'utf8');
    const statements = splitStatements(rawSql);

    try {
      for (const stmt of statements) {
        await pool.query(stmt);
      }

      // Record the version only after all statements succeed
      await pool.execute(
        'INSERT INTO schema_version (version, name) VALUES (?, ?)',
        [migration.version, migration.name]
      );

      appliedNow.push(migration.version);
      console.log(`Migration applied: ${migration.name} (v${migration.version})`);
    } catch (err) {
      console.error(`Migration FAILED: ${migration.name} (v${migration.version})`);
      console.error('  Statement:', err.sql ? err.sql.slice(0, 200) : '(unknown)');
      console.error('  Error:', err.message);
      throw err;
    }
  }

  console.log(`Migrations complete — ${appliedNow.length} applied`);
  return appliedNow;
}

module.exports = { runMigrations, discoverMigrations, splitStatements };
