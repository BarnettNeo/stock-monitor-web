import fs from 'node:fs';
import path from 'node:path';
import mysql, { type Pool, type ResultSetHeader } from 'mysql2/promise';
import initSqlJs, { type Database as SqlJsDb, type SqlJsStatic } from 'sql.js';

const DATA_DIR = path.resolve(__dirname, '../data');
const SQLITE_PATH = path.join(DATA_DIR, 'db.sqlite');
const MIGRATION_KEY = 'sqlite_import_v1_done';

let pool: Pool | null = null;
let initPromise: Promise<void> | null = null;
let SQL: SqlJsStatic | null = null;

function getDbConfig(): {
  host: string;
  port: number;
  database: string;
  user: string;
  password: string;
} {
  // Windows 上 `localhost` 常解析为 IPv6 `::1`，而本机 MySQL 往往只监听 IPv4，会导致 ECONNREFUSED ::1:3306。
  let host = String(process.env.DB_HOST || '127.0.0.1').trim();
  const lower = host.toLowerCase();
  if (lower === 'localhost' || host === '::1') {
    host = '127.0.0.1';
  }
  return {
    host,
    port: Number(process.env.DB_PORT || 3306),
    database: String(process.env.DB_NAME || 'stock_monitor'),
    user: String(process.env.DB_USER || 'root'),
    password: String(process.env.DB_PASSWORD || ''),
  };
}

// 在 pool 已创建、且尚未 await initPromise 时执行 SQL（避免 execute→getDb→ensureInitialized→initPromise 递归）
async function executeOnPool(
  sql: string,
  params: any[] = [],
): Promise<ResultSetHeader> {
  const p = pool as Pool;
  const [result] = await p.execute(sql, params);
  return result as ResultSetHeader;
}

async function queryOnPool<T = any>(sql: string, params: any[] = []): Promise<T[]> {
  const p = pool as Pool;
  const [rows] = await p.query(sql, params);
  return rows as T[];
}

async function queryOneOnPool<T = any>(sql: string, params: any[] = []): Promise<T | null> {
  const rows = await queryOnPool<T>(sql, params);
  return rows[0] || null;
}

async function ensureMySqlColumn(
  tableName: string,
  columnName: string,
  columnDdl: string,
): Promise<void> {
  const cfg = getDbConfig();
  const row = await queryOneOnPool<{ ok: number }>(
    `SELECT 1 as ok
     FROM information_schema.columns
     WHERE table_schema = ?
       AND table_name = ?
       AND column_name = ?
     LIMIT 1`,
    [cfg.database, tableName, columnName],
  );
  if (row) return;
  await executeOnPool(`ALTER TABLE \`${tableName}\` ADD COLUMN ${columnDdl}`);
}

// 确保数据库连接池已初始化
async function ensureInitialized(): Promise<void> {
  if (!pool) {
    const cfg = getDbConfig();
    pool = mysql.createPool({
      host: cfg.host,
      port: cfg.port,
      user: cfg.user,
      password: cfg.password,
      database: cfg.database,
      waitForConnections: true,
      connectionLimit: 10,
      queueLimit: 0,
      charset: 'utf8mb4',
    });
  }

  if (!initPromise) {
    // 只初始化一次：先确保 MySQL schema 可用，再尝试执行 SQLite 历史数据导入。
    // 迁移阶段必须用 executeOnPool，禁止调用 execute()/getDb()，否则会再次进入 ensureInitialized 造成栈溢出。
    initPromise = (async () => {
      try {
        await migrateMySqlSchema();
        await migrateFromSqliteIfNeeded();
      } catch (e: any) {
        const cfg = getDbConfig();
        const code = e?.code;
        if (code === 'ECONNREFUSED' || code === 'ETIMEDOUT') {
          throw new Error(
            [
              `无法连接 MySQL：${cfg.host}:${cfg.port}（${code}）`,
              '请在本机启动 MySQL 服务，或确认端口与防火墙设置。',
              '若尚未安装 MySQL，可在项目根目录执行：',
              '  docker compose -f docker-compose.mysql.yml up -d',
              '并保证根目录 .env 中 DB_HOST/DB_PORT/DB_NAME/DB_USER/DB_PASSWORD 与 compose 中配置一致。',
              `原始错误：${e?.message || String(e)}`,
            ].join('\n'),
          );
        }
        if (code === 'ER_ACCESS_DENIED_ERROR' || code === 'ER_BAD_DB_ERROR') {
          throw new Error(
            [
              `MySQL 拒绝连接或数据库不存在：${e?.message || String(e)}`,
              `当前配置：host=${cfg.host} port=${cfg.port} database=${cfg.database} user=${cfg.user}`,
              '请检查 .env 中 DB_* 是否与 MySQL 实例一致，并确认已创建数据库（如 CREATE DATABASE stock_monitor）。',
            ].join('\n'),
          );
        }
        throw e;
      }
    })();
  }
  await initPromise;
}

// 获取数据库连接池
export async function getDb(): Promise<Pool> {
  await ensureInitialized();
  return pool as Pool;
}

// 执行多行查询
export async function query<T = any>(
  sql: string,
  params: any[] = [],
): Promise<T[]> {
  const p = await getDb();
  const [rows] = await p.query(sql, params);
  return rows as T[];
}

// 执行单行查询
export async function queryOne<T = any>(
  sql: string,
  params: any[] = [],
): Promise<T | null> {
  const rows = await query<T>(sql, params);
  return rows[0] || null;
}

// 执行 SQL 语句
export async function execute(
  sql: string,
  params: any[] = [],
): Promise<ResultSetHeader> {
  const p = await getDb();
  const [result] = await p.execute(sql, params);
  return result as ResultSetHeader;
}

export function persist(): void {
  // MySQL 无需手动 persist；保留空实现，兼容旧调用方。
}

// 迁移 MySQL 数据库架构
async function migrateMySqlSchema(): Promise<void> {
  await executeOnPool(`
    CREATE TABLE IF NOT EXISTS users (
      id VARCHAR(64) PRIMARY KEY,
      username VARCHAR(64) NOT NULL UNIQUE,
      password_salt VARCHAR(128) NOT NULL,
      password_hash VARCHAR(256) NOT NULL,
      role VARCHAR(16) NOT NULL,
      user_package VARCHAR(16) NOT NULL DEFAULT 'free',
      package_expire VARCHAR(40),
      max_strategy_count INT NOT NULL DEFAULT 3,
      created_at VARCHAR(40) NOT NULL,
      updated_at VARCHAR(40) NOT NULL
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
  `);

  // MySQL compatibility: "ADD COLUMN IF NOT EXISTS" is not supported on many versions.
  await ensureMySqlColumn('users', 'user_package', "user_package VARCHAR(16) NOT NULL DEFAULT 'free'");
  await ensureMySqlColumn('users', 'package_expire', 'package_expire VARCHAR(40)');
  await ensureMySqlColumn('users', 'max_strategy_count', 'max_strategy_count INT NOT NULL DEFAULT 3');

  await executeOnPool(
    "UPDATE users SET user_package = 'free' WHERE user_package IS NULL OR user_package = ''",
  );
  await executeOnPool(
    'UPDATE users SET max_strategy_count = 3 WHERE max_strategy_count IS NULL OR max_strategy_count <= 0',
  );
  await executeOnPool(
    "UPDATE users SET package_expire = DATE_FORMAT(DATE_ADD(UTC_TIMESTAMP(), INTERVAL 5 DAY), '%Y-%m-%dT%H:%i:%s.000Z') WHERE package_expire IS NULL OR package_expire = ''",
  );

  await executeOnPool(`
    CREATE TABLE IF NOT EXISTS strategies (
      id VARCHAR(64) PRIMARY KEY,
      user_id VARCHAR(64),
      name VARCHAR(255) NOT NULL,
      enabled TINYINT NOT NULL,
      symbols TEXT NOT NULL,
      market_time_only TINYINT NOT NULL DEFAULT 1,
      alert_mode VARCHAR(16),
      target_price_up DOUBLE,
      target_price_down DOUBLE,
      interval_ms INT NOT NULL,
      cooldown_minutes INT NOT NULL,
      price_alert_percent DOUBLE NOT NULL,
      enable_macd_golden_cross TINYINT NOT NULL,
      enable_rsi_oversold TINYINT NOT NULL,
      enable_rsi_overbought TINYINT NOT NULL,
      enable_moving_averages TINYINT NOT NULL,
      enable_pattern_signal TINYINT NOT NULL,
      subscription_ids_json TEXT,
      created_at VARCHAR(40) NOT NULL,
      updated_at VARCHAR(40) NOT NULL,
      INDEX idx_strategies_user_id (user_id),
      INDEX idx_strategies_updated_at (updated_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
  `);

  await executeOnPool(`
    CREATE TABLE IF NOT EXISTS subscriptions (
      id VARCHAR(64) PRIMARY KEY,
      user_id VARCHAR(64),
      name VARCHAR(255) NOT NULL,
      type VARCHAR(32) NOT NULL,
      enabled TINYINT NOT NULL,
      webhook_url TEXT,
      keyword VARCHAR(255),
      wecom_app_corp_id VARCHAR(255),
      wecom_app_corp_secret VARCHAR(255),
      wecom_app_agent_id INT,
      wecom_app_to_user VARCHAR(255),
      wecom_app_to_party VARCHAR(255),
      wecom_app_to_tag VARCHAR(255),
      created_at VARCHAR(40) NOT NULL,
      updated_at VARCHAR(40) NOT NULL,
      INDEX idx_subscriptions_user_id (user_id),
      INDEX idx_subscriptions_updated_at (updated_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
  `);

  await executeOnPool(`
    CREATE TABLE IF NOT EXISTS trigger_logs (
      id VARCHAR(64) PRIMARY KEY,
      user_id VARCHAR(64),
      strategy_id VARCHAR(64),
      subscription_id VARCHAR(64),
      symbol VARCHAR(32) NOT NULL,
      stock_name VARCHAR(255),
      reason TEXT NOT NULL,
      snapshot_json LONGTEXT NOT NULL,
      send_status VARCHAR(32),
      send_error TEXT,
      created_at VARCHAR(40) NOT NULL,
      INDEX idx_trigger_logs_user_id (user_id),
      INDEX idx_trigger_logs_symbol (symbol),
      INDEX idx_trigger_logs_created_at (created_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
  `);

  await executeOnPool(`
    CREATE TABLE IF NOT EXISTS _meta (
      meta_key VARCHAR(128) PRIMARY KEY,
      meta_value TEXT,
      updated_at VARCHAR(40) NOT NULL
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
  `);

  await executeOnPool(
    "UPDATE strategies SET alert_mode = 'percent' WHERE alert_mode IS NULL OR alert_mode = ''",
  );
  await executeOnPool(
    'UPDATE strategies SET market_time_only = 1 WHERE market_time_only IS NULL',
  );
}

// 迁移 SQLite 历史数据
async function migrateFromSqliteIfNeeded(): Promise<void> {
  const marker = await queryOneOnPool<{ meta_key: string }>(
    'SELECT meta_key FROM _meta WHERE meta_key = ? LIMIT 1',
    [MIGRATION_KEY],
  );
  if (marker) return;
  if (!fs.existsSync(SQLITE_PATH)) {
    await markMigrationDone('sqlite file not found');
    return;
  }

  if (!SQL) {
    SQL = await initSqlJs({
      locateFile: (file: string) => require.resolve(`sql.js/dist/${file}`),
    });
  }

  const fileBuffer = fs.readFileSync(SQLITE_PATH);
  const sqliteDb = new SQL.Database(fileBuffer);
  try {
    // 按表顺序导入，使用 ON DUPLICATE KEY 跳过已存在主键，保证可幂等重试。
    await migrateSqliteTable(sqliteDb, 'users', [
      'id',
      'username',
      'password_salt',
      'password_hash',
      'role',
      'created_at',
      'updated_at',
    ]);
    await migrateSqliteTable(sqliteDb, 'strategies', [
      'id',
      'user_id',
      'name',
      'enabled',
      'symbols',
      'market_time_only',
      'alert_mode',
      'target_price_up',
      'target_price_down',
      'interval_ms',
      'cooldown_minutes',
      'price_alert_percent',
      'enable_macd_golden_cross',
      'enable_rsi_oversold',
      'enable_rsi_overbought',
      'enable_moving_averages',
      'enable_pattern_signal',
      'subscription_ids_json',
      'created_at',
      'updated_at',
    ]);
    await migrateSqliteTable(sqliteDb, 'subscriptions', [
      'id',
      'user_id',
      'name',
      'type',
      'enabled',
      'webhook_url',
      'keyword',
      'wecom_app_corp_id',
      'wecom_app_corp_secret',
      'wecom_app_agent_id',
      'wecom_app_to_user',
      'wecom_app_to_party',
      'wecom_app_to_tag',
      'created_at',
      'updated_at',
    ]);
    await migrateSqliteTable(sqliteDb, 'trigger_logs', [
      'id',
      'user_id',
      'strategy_id',
      'subscription_id',
      'symbol',
      'stock_name',
      'reason',
      'snapshot_json',
      'send_status',
      'send_error',
      'created_at',
    ]);
    await markMigrationDone('ok');
  } finally {
    sqliteDb.close();
  }
}

// 按表顺序导入，使用 ON DUPLICATE KEY 跳过已存在主键，保证可幂等重试。
async function migrateSqliteTable(
  sqliteDb: SqlJsDb,
  table: string,
  columns: string[],
): Promise<void> {
  const sql = `SELECT ${columns.join(',')} FROM ${table}`;
  const result = sqliteDb.exec(sql);
  const rows = result[0]?.values || [];
  if (!rows.length) return;

  const placeholders = columns.map(() => '?').join(',');
  const insertSql = `INSERT INTO ${table} (${columns.join(',')}) VALUES (${placeholders}) ON DUPLICATE KEY UPDATE id=id`;

  for (const row of rows) {
    await executeOnPool(insertSql, row as any[]);
  }
}

// 标记迁移完成，用于幂等重试。
async function markMigrationDone(status: string): Promise<void> {
  await executeOnPool(
    `INSERT INTO _meta (meta_key, meta_value, updated_at)
     VALUES (?, ?, ?)
     ON DUPLICATE KEY UPDATE meta_value = VALUES(meta_value), updated_at = VALUES(updated_at)`,
    [MIGRATION_KEY, status, new Date().toISOString()],
  );
}
