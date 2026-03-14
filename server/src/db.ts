import fs from 'node:fs';
import path from 'node:path';
import initSqlJs, { type Database, type SqlJsStatic } from 'sql.js';

const DATA_DIR = path.resolve(__dirname, '../data');
const DB_PATH = path.join(DATA_DIR, 'db.sqlite');

let SQL: SqlJsStatic | null = null;
let db: Database | null = null;

function ensureDataDir(): void {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
}

/**
 * 获取（并初始化）本地 SQLite 数据库。
 * 使用 sql.js（WASM）避免在 Windows 上安装原生 sqlite 依赖。
 */
export async function getDb(): Promise<Database> {
  if (db) return db;

  ensureDataDir();

  if (!SQL) {
    SQL = await initSqlJs({
      locateFile: (file: string) => {
        return require.resolve(`sql.js/dist/${file}`);
      },
    });
  }

  const fileBuffer = fs.existsSync(DB_PATH) ? fs.readFileSync(DB_PATH) : null;
  db = fileBuffer ? new SQL.Database(fileBuffer) : new SQL.Database();

  // 首次启动或升级后：确保表结构存在且字段齐全
  migrate(db);
  // 初始化/迁移后立即落盘，避免意外退出造成 schema 丢失
  persist();

  return db;
}

export function persist(): void {
  if (!db) return;
  ensureDataDir();

  // sql.js 属于内存数据库，这里通过 export() + 写文件的方式持久化到磁盘。
  const data = db.export();
  fs.writeFileSync(DB_PATH, Buffer.from(data));
}

/**
 * 获取表的当前列集合，用于判断是否需要 ALTER TABLE。
 */
function getTableColumns(database: Database, table: string): Set<string> {
  const result = database.exec(`PRAGMA table_info(${table});`);
  const rows = result[0]?.values || [];
  // PRAGMA table_info columns: cid, name, type, notnull, dflt_value, pk
  const names = rows.map((r: any[]) => String(r[1]));
  return new Set(names);
}

/**
 * 数据库迁移：
 * - 新库：CREATE TABLE IF NOT EXISTS 创建完整结构
 * - 老库：通过 PRAGMA table_info 判断缺失字段后 ALTER TABLE 增量升级
 */
function migrate(database: Database): void {
  // 基础表结构（全新数据库会走这里创建完整表）
  database.run(`
    CREATE TABLE IF NOT EXISTS strategies (
      id TEXT PRIMARY KEY,
      user_id TEXT,
      name TEXT NOT NULL,
      enabled INTEGER NOT NULL,
      symbols TEXT NOT NULL,
      market_time_only INTEGER NOT NULL DEFAULT 1,
      -- 报警模式（策略级别二选一）：
      -- - percent: 大幅异动监控（使用 price_alert_percent）
      -- - target: 目标价触发（使用 target_price_up/down，忽略 price_alert_percent）
      alert_mode TEXT,
      -- 目标价触发：上行/下行（可空；为兼容旧版 monitor.ts 的功能）
      target_price_up REAL,
      target_price_down REAL,
      interval_ms INTEGER NOT NULL,
      cooldown_minutes INTEGER NOT NULL,
      price_alert_percent REAL NOT NULL,
      enable_macd_golden_cross INTEGER NOT NULL,
      enable_rsi_oversold INTEGER NOT NULL,
      enable_rsi_overbought INTEGER NOT NULL,
      enable_moving_averages INTEGER NOT NULL,
      enable_pattern_signal INTEGER NOT NULL,
      -- JSON 数组字符串：该策略绑定的订阅 ID 列表
      subscription_ids_json TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);

  database.run(`
    CREATE TABLE IF NOT EXISTS subscriptions (
      id TEXT PRIMARY KEY,
      user_id TEXT,
      name TEXT NOT NULL,
      type TEXT NOT NULL,
      enabled INTEGER NOT NULL,
      webhook_url TEXT,
      keyword TEXT,
      wecom_app_corp_id TEXT,
      wecom_app_corp_secret TEXT,
      wecom_app_agent_id INTEGER,
      wecom_app_to_user TEXT,
      wecom_app_to_party TEXT,
      wecom_app_to_tag TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);

  database.run(`
    CREATE TABLE IF NOT EXISTS trigger_logs (
      id TEXT PRIMARY KEY,
      user_id TEXT,
      strategy_id TEXT,
      subscription_id TEXT,
      symbol TEXT NOT NULL,
      stock_name TEXT,
      reason TEXT NOT NULL,
      snapshot_json TEXT NOT NULL,
      -- 推送结果（每个订阅一条记录）
      send_status TEXT,
      send_error TEXT,
      created_at TEXT NOT NULL
    );
  `);

  // 对已有数据库做增量迁移（ALTER TABLE）
  const strategyCols = getTableColumns(database, 'strategies');
  if (!strategyCols.has('subscription_ids_json')) {
    database.run('ALTER TABLE strategies ADD COLUMN subscription_ids_json TEXT;');
  }
  if (!strategyCols.has('alert_mode')) {
    database.run('ALTER TABLE strategies ADD COLUMN alert_mode TEXT;');
  }
  if (!strategyCols.has('market_time_only')) {
    database.run('ALTER TABLE strategies ADD COLUMN market_time_only INTEGER;');
  }
  if (!strategyCols.has('target_price_up')) {
    database.run('ALTER TABLE strategies ADD COLUMN target_price_up REAL;');
  }
  if (!strategyCols.has('target_price_down')) {
    database.run('ALTER TABLE strategies ADD COLUMN target_price_down REAL;');
  }

  // 为存量数据回填默认告警模式，避免前端展示空值
  if (strategyCols.has('alert_mode')) {
    database.run("UPDATE strategies SET alert_mode = 'percent' WHERE alert_mode IS NULL OR alert_mode = ''; ");
  }

  // 为存量数据回填默认仅交易时间推送（默认开启）
  if (strategyCols.has('market_time_only')) {
    database.run('UPDATE strategies SET market_time_only = 1 WHERE market_time_only IS NULL;');
  }

  const logCols = getTableColumns(database, 'trigger_logs');
  if (!logCols.has('send_status')) {
    database.run('ALTER TABLE trigger_logs ADD COLUMN send_status TEXT;');
  }
  if (!logCols.has('send_error')) {
    database.run('ALTER TABLE trigger_logs ADD COLUMN send_error TEXT;');
  }
}
