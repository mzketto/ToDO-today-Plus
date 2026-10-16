-- ============================================================
--  今日待办 · Cloudflare D1 数据库结构
--  初始化：
--    本地  npx wrangler d1 execute todo-today --local  --file=./schema.sql
--    线上  npx wrangler d1 execute todo-today --remote --file=./schema.sql
--  该脚本可重复执行（IF NOT EXISTS），不会清空已有数据。
-- ============================================================

-- 用户
CREATE TABLE IF NOT EXISTS users (
  id            TEXT    PRIMARY KEY,
  username      TEXT    NOT NULL UNIQUE,
  password_hash TEXT    NOT NULL,          -- PBKDF2-SHA256 派生结果（hex）
  salt          TEXT    NOT NULL,          -- 随机盐（hex）
  created_at    INTEGER NOT NULL           -- Unix 秒
);

-- 登录会话（HttpOnly Cookie 里的 token 指向这里）
CREATE TABLE IF NOT EXISTS sessions (
  token      TEXT    PRIMARY KEY,
  user_id    TEXT    NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_user    ON sessions (user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions (expires_at);

-- 待办事项
CREATE TABLE IF NOT EXISTS todos (
  id         TEXT    PRIMARY KEY,
  user_id    TEXT    NOT NULL,
  title      TEXT    NOT NULL,
  done       INTEGER NOT NULL DEFAULT 0,   -- 0 未完成 / 1 已完成
  todo_date  TEXT    NOT NULL,             -- 归属日期 YYYY-MM-DD
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_todos_user_date ON todos (user_id, todo_date);
CREATE INDEX IF NOT EXISTS idx_todos_user_done ON todos (user_id, done);

-- 到期日（可空）：为空表示不设提醒；有值时到期提醒功能据此计算「还剩几天」
-- 可重复执行：老库补列时若已存在会报 duplicate column，属预期，忽略即可。
ALTER TABLE todos ADD COLUMN due_date TEXT;
CREATE INDEX IF NOT EXISTS idx_todos_user_due ON todos (user_id, due_date, done);

-- 用户设置（云备份配置等）
CREATE TABLE IF NOT EXISTS settings (
  user_id     TEXT    PRIMARY KEY,
  backup_json TEXT,                        -- 备份配置 JSON
  last_backup INTEGER,                     -- 上次备份时间（Unix 秒，用于自动备份节流）
  updated_at  INTEGER NOT NULL
);

-- 到期提醒配置（每人一份，渠道参数存在 notify_json 里）
-- 说明：老库执行本文件时若 notifications 表已用另一种结构建过，
--       下面的 ALTER 会被忽略（重复列报错），Worker 会自动兼容读取。
CREATE TABLE IF NOT EXISTS notifications (
  user_id     TEXT    PRIMARY KEY,
  notify_json TEXT,                        -- 通知配置 JSON（渠道 / 提前天数 / 各渠道参数）
  last_scan   INTEGER,                     -- 上次扫描时间（Unix 秒，用于节流）
  updated_at  INTEGER NOT NULL
);

-- 已推送记录：同一任务的同一个「到期日」只推一次，避免重复打扰
CREATE TABLE IF NOT EXISTS notify_log (
  user_id      TEXT    NOT NULL,
  todo_id      TEXT    NOT NULL,
  due_date     TEXT    NOT NULL,            -- 推送时该任务的到期日（改期后会重新推送）
  channel      TEXT    NOT NULL,            -- 渠道标识
  sent_at      INTEGER NOT NULL,
  ok           INTEGER NOT NULL DEFAULT 1,  -- 1 发送成功 / 0 发送失败（失败不写库，可重试）
  detail       TEXT,                        -- 失败原因
  PRIMARY KEY (user_id, todo_id, due_date, channel)
);
CREATE INDEX IF NOT EXISTS idx_notify_log_user ON notify_log (user_id, sent_at);
