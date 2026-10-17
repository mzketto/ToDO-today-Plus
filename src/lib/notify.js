/**
 * 到期提醒模块 —— 给「即将到期」的待办推送通知。
 *
 * 支持的渠道（可同时开启多个）：
 *   bark       iOS Bark App（自建或官方 api.day.app）
 *   gotify     自建 Gotify 推送服务
 *   wxpusher   WxPusher 微信推送
 *   email      邮件（Resend HTTP API，Workers 里不能开 SMTP）
 *   telegram   Telegram Bot
 *   wechat     微信机器人（企业微信应用 / 自建 webhook 机器人）
 *   feishu     飞书自定义机器人
 *   wecom      企业微信群机器人
 *   webhook    通用 Webhook（POST JSON，可自定义请求体模板）
 *   serverchan Server 酱（sctapi.ftqq.com）
 *   pushplus   PushPlus 推送加
 *   ntfy       ntfy 自建 / 官方服务
 *
 * 关键设计：
 *  1. 配置整体存成一段 JSON（notifications.notify_json），渠道参数与开关都在里面，
 *     与云备份一样「写进去的密钥永不回显」。
 *  2. 去重靠 notify_log 表主键 (user_id, todo_id, due_date, channel)：
 *     同一任务的同一到期日同一渠道只推一次；改期后 due_date 变了会重新推。
 *  3. 只有发送成功才写日志，失败留待下轮 Cron 重试，不会因为一次网络抖动漏提醒。
 *  4. 所有渠道最终都收敛成 sendOne(channel, config)，便于单测逐个渠道断言请求内容。
 */

import { HttpError, nowSeconds } from './auth.js';
// 「没设到期日的未完成任务」统计：新任务默认到期日 = 所属日期，
// 查出来的基本是历史数据，用来提示用户一键补齐。
import { countMissingDue } from './todos.js';

/* ============================== 常量 ============================== */

export const NOTIFY_VERSION = 2;

/** 支持的渠道清单（顺序即设置页的展示顺序） */
export const CHANNELS = [
  'bark',
  'gotify',
  'wxpusher',
  'email',
  'telegram',
  'wechat',
  'feishu',
  'wecom',
  'webhook',
  'serverchan',
  'pushplus',
  'ntfy',
];

/** 渠道中文名，用于通知正文与设置页 */
export const CHANNEL_LABELS = {
  bark: 'Bark',
  gotify: 'Gotify',
  wxpusher: 'WxPusher',
  email: '邮件',
  telegram: 'Telegram',
  wechat: '微信机器人',
  feishu: '飞书',
  wecom: '企业微信',
  webhook: 'Webhook',
  serverchan: 'Server 酱',
  pushplus: 'PushPlus',
  ntfy: 'ntfy',
};

/** 提前天数上限：最多提前 365 天提醒，避免一个任务天天推 */
export const MAX_LEAD_DAYS = 365;
/** 单次扫描最多推送多少条任务，防止极端情况下把 Cron 卡住 */
const MAX_PER_SCAN = 50;
/** 单个渠道的请求超时（毫秒） */
const TIMEOUT_MS = 10_000;

const EMPTY_NOTIFY_CONFIG = {
  version: NOTIFY_VERSION,
  enabled: false,           // 总开关
  channels: [],             // 启用的渠道（CHANNELS 的子集）
  leadDays: 1,              // 提前多少天开始提醒（0 = 当天提醒）
  dailyRepeat: true,        // true = 进入提醒窗口后每天提醒（默认）；false = 只在进窗口那天提醒一次
  includeOverdue: true,     // 是否连「已过期」的一起提醒
  tz: '',                   // 用户时区（Cron 触发时没有请求上下文，用它算「今天」）
  time: '09:00',            // 每天几点之后才推送（本地时间，避免半夜吵人）
  checkInterval: 5,         // 检查频率（分钟）：云端定时器每 5 分钟醒来，这里控制实际多久检查一次
  lastScan: null,
  params: {},               // 各渠道参数：{ bark: {...}, telegram: {...} }
};

/** 每个渠道需要哪些字段（前端据此渲染表单；secrets 里的字段不回显） */
export const CHANNEL_FIELDS = {
  bark: {
    fields: [
      { key: 'server', label: '服务器地址', placeholder: 'https://api.day.app（自建可改；粘贴 App 里复制的完整地址也行）', optional: true },
      { key: 'key', label: 'Device Key', placeholder: '在 Bark App 首页复制', secret: true },
      { key: 'group', label: '分组', placeholder: '可留空', optional: true },
      { key: 'sound', label: '铃声', placeholder: '可留空，如 bell', optional: true },
    ],
  },
  gotify: {
    fields: [
      { key: 'server', label: '服务器地址', placeholder: 'https://gotify.example.com' },
      { key: 'token', label: 'App Token', placeholder: '在 Gotify 里创建的 Application Token', secret: true },
      { key: 'priority', label: '优先级', placeholder: '0-10，默认 5', optional: true },
    ],
  },
  wxpusher: {
    fields: [
      { key: 'appToken', label: 'AppToken', placeholder: 'AT_xxx（应用管理页获取）', secret: true },
      { key: 'uids', label: 'UID', placeholder: 'UID_xxx，多个用逗号分隔', secret: true },
      { key: 'topicIds', label: '主题 ID', placeholder: '可选，填了则推给主题', optional: true },
      { key: 'url', label: '点击跳转链接', placeholder: '可留空', optional: true },
    ],
  },
  email: {
    fields: [
      { key: 'apiKey', label: 'Resend API Key', placeholder: 're_xxx', secret: true },
      { key: 'from', label: '发件人', placeholder: '提醒 <todo@yourdomain.com>' },
      { key: 'to', label: '收件人', placeholder: '多个用逗号分隔' },
    ],
  },
  telegram: {
    fields: [
      { key: 'botToken', label: 'Bot Token', placeholder: '123456:ABC-DEF...', secret: true },
      { key: 'chatId', label: 'Chat ID', placeholder: '可填 @channelusername 或数字 ID', secret: true },
      { key: 'baseUrl', label: 'API 地址', placeholder: 'https://api.telegram.org（代理时改）', optional: true },
      { key: 'threadId', label: '话题 ID', placeholder: '群组话题可选', optional: true },
    ],
  },
  wechat: {
    fields: [
      { key: 'url', label: 'Webhook 地址', placeholder: '企业微信应用 / 自建机器人的 webhook' },
      { key: 'token', label: 'Token / 密钥', placeholder: '可留空', secret: true, optional: true },
      { key: 'field', label: '文本字段名', placeholder: '默认 text', optional: true },
      { key: 'template', label: '请求体模板', placeholder: '可留空，用 {"{field}":"{text}"}', optional: true },
    ],
  },
  feishu: {
    fields: [
      { key: 'url', label: 'Webhook 地址', placeholder: 'https://open.feishu.cn/open-apis/bot/v2/hook/xxx' },
      { key: 'secret', label: '签名密钥', placeholder: '开启了签名校验才需要', secret: true, optional: true },
      { key: 'msgType', label: '消息类型', placeholder: 'text 或 post（默认 text）', optional: true },
    ],
  },
  wecom: {
    fields: [
      { key: 'url', label: 'Webhook 地址', placeholder: 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=xxx' },
      { key: 'msgType', label: '消息类型', placeholder: 'text 或 markdown（默认 markdown）', optional: true },
    ],
  },
  webhook: {
    fields: [
      { key: 'url', label: '地址', placeholder: 'https://example.com/hook' },
      { key: 'method', label: '方法', placeholder: 'POST / PUT（默认 POST）', optional: true },
      { key: 'contentType', label: 'Content-Type', placeholder: '默认 application/json', optional: true },
      { key: 'headers', label: '额外请求头', placeholder: 'JSON，如 {"Authorization":"Bearer xxx"}', optional: true, secret: true },
      { key: 'template', label: '请求体模板', placeholder: '如 {"token":"xxx","title":"{title}","content":"{text}"}；可留空用默认 {title,text,count}', optional: true },
    ],
  },
  serverchan: {
    fields: [
      { key: 'sendKey', label: 'SendKey', placeholder: 'SCTxxx / sctp 开头的 key', secret: true },
      { key: 'channel', label: '通道', placeholder: '可留空，如 9（微信服务号）', optional: true },
    ],
  },
  pushplus: {
    fields: [
      { key: 'token', label: 'Token', placeholder: 'pushplus 个人中心获取', secret: true },
      { key: 'topic', label: '群组编码', placeholder: '一对多推送时填写', optional: true },
      { key: 'template', label: '模板', placeholder: 'html / markdown / txt', optional: true },
    ],
  },
  ntfy: {
    fields: [
      { key: 'server', label: '服务器地址', placeholder: 'https://ntfy.sh（自建可改）', optional: true },
      { key: 'topic', label: '主题', placeholder: '仅字母/数字/-/_，不支持中文，如 todo-today' },
      { key: 'token', label: '访问令牌', placeholder: '自建服务开启了鉴权才需要', secret: true, optional: true },
      { key: 'priority', label: '优先级', placeholder: '1-5，默认 3', optional: true },
    ],
  },
};

/* ============================== 工具函数 ============================== */

function notify_pickString(value, fallback = '') {
  return typeof value === 'string' ? value.trim() : fallback;
}

function pickBool(value, fallback = false) {
  return value === undefined ? fallback : !!value;
}

/**
 * 允许的 URL：必须是 http/https。
 * 这一层不是「防 SSRF」（用户本来就能填任意地址），而是防止写出
 * `javascript:`、`file:` 这类明显不该出现在 fetch 里的协议。
 */
function normalizeUrl(raw, { allowEmpty = false } = {}) {
  const value = notify_pickString(raw);
  if (!value) {
    if (allowEmpty) return '';
    throw new HttpError('请填写完整地址（以 http:// 或 https:// 开头）');
  }
  let u;
  try {
    u = new URL(value);
  } catch {
    throw new HttpError(`地址格式不正确：${value}`);
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    throw new HttpError('地址必须以 http:// 或 https:// 开头');
  }
  return value.replace(/\/+$/, '');
}

/** 解析 JSON 字符串输入（前端可能传字符串） */
function parseJsonInput(value) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value === 'object') return value;
  try {
    return JSON.parse(String(value));
  } catch {
    throw new HttpError('这段内容需要是合法的 JSON');
  }
}

/** 尝试解析，失败返回 null（用于模板试探：非法 JSON 是回退信号而不是用户错误） */
function tryParseJson(value) {
  try {
    return parseJsonInput(value);
  } catch {
    return null;
  }
}

/** 时区安全的「今天」：返回 YYYY-MM-DD */
export function todayInZone(timeZone = 'UTC', date = new Date()) {
  const options = { year: 'numeric', month: '2-digit', day: '2-digit' };
  const fmt = (tz) => new Intl.DateTimeFormat('en-CA', { ...options, timeZone: tz });
  try {
    return fmt(timeZone || 'UTC').format(date);
  } catch {
    return fmt('UTC').format(date);
  }
}

/** 时区安全的「现在几点」：返回 HH:mm */
export function clockInZone(timeZone = 'UTC', date = new Date()) {
  const options = { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' };
  const fmt = (tz) => new Intl.DateTimeFormat('en-GB', { ...options, timeZone: tz });
  try {
    return fmt(timeZone || 'UTC').format(date);
  } catch {
    return fmt('UTC').format(date);
  }
}

/** YYYY-MM-DD -> 距 1970 的天数（用 UTC 避免夏令时干扰） */
export function dayNumber(dateStr) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dateStr || ''));
  if (!m) return null;
  const ms = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return Math.floor(ms / 86_400_000);
}

/** 两个 YYYY-MM-DD 相隔几天（b - a） */
export function daysBetween(a, b) {
  const na = dayNumber(a);
  const nb = dayNumber(b);
  if (na === null || nb === null) return null;
  return nb - na;
}

/**
 * 把相对天数说成人话：-2 / -1 / 0 / 1 / 3
 *  →  已过期 2 天 / 今天到期 / 明天到期 / 3 天后到期
 */
export function humanizeDays(n) {
  if (n === null || n === undefined) return '';
  if (n < 0) return `已过期 ${-n} 天`;
  if (n === 0) return '今天到期';
  if (n === 1) return '明天到期';
  if (n === 2) return '后天到期';
  return `${n} 天后到期`;
}

/**
 * 有效的「今天」该按哪个时区算。
 *
 * 优先用用户配置里存的 IANA 时区；没填则回退到前端每次请求带来的
 * `x-tz`（浏览器时区）。这样即使用户从没打开过设置页，「今天」也不会
 * 因为 Worker 跑在 UTC 而跟用户本地的日期差一天。
 */
export function resolveTimeZone(config = {}, fallback = '') {
  const candidates = [config.tz, fallback].map((v) => notify_pickString(v)).filter(Boolean);
  for (const tz of candidates) {
    if (isValidTimeZone(tz)) return tz;
  }
  return 'UTC';
}

/** 该时区名能不能被 Intl 认出来 */
export function isValidTimeZone(tz) {
  if (!tz) return false;
  try {
    new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(new Date());
    return true;
  } catch {
    return false;
  }
}

/* ============================== 配置读写 ============================== */

/** 过滤掉未知渠道，并按 CHANNELS 的固定顺序去重（避免同一渠道推两次） */
function dedupeChannels(list) {
  const allowed = new Set(list.filter((c) => CHANNELS.includes(c)));
  return CHANNELS.filter((c) => allowed.has(c));
}

/** 归一化 + 合并旧密钥（前端留空 = 不修改） */
export function normalizeNotifyConfig(input = {}, previous = {}) {
  const prevParams = previous.params || {};
  const leadDaysRaw = Math.round(Number(input.leadDays));
  const leadDays = Number.isFinite(leadDaysRaw)
    ? Math.min(Math.max(leadDaysRaw, 0), MAX_LEAD_DAYS)
    : (previous.leadDays ?? EMPTY_NOTIFY_CONFIG.leadDays);

  const enabledChannels = dedupeChannels(
    Array.isArray(input.channels)
      ? input.channels
      : (Array.isArray(previous.channels) ? previous.channels : []),
  );

  const time = /^([01]\d|2[0-3]):[0-5]\d$/.test(notify_pickString(input.time))
    ? notify_pickString(input.time)
    : (previous.time || EMPTY_NOTIFY_CONFIG.time);

  // 检查频率（分钟）：下限 5（云端 Cron 就是最快 5 分钟一次，设更小没意义），上限一天
  const intervalRaw = Math.round(Number(input.checkInterval));
  const checkInterval = Number.isFinite(intervalRaw)
    ? Math.min(Math.max(intervalRaw, 5), 1440)
    : (previous.checkInterval ?? EMPTY_NOTIFY_CONFIG.checkInterval);

  const rawParams = input.params && typeof input.params === 'object' ? input.params : {};

  return {
    version: NOTIFY_VERSION,
    enabled: pickBool(input.enabled, !!previous.enabled),
    channels: enabledChannels,
    leadDays,
    dailyRepeat: pickBool(input.dailyRepeat, previous.dailyRepeat ?? EMPTY_NOTIFY_CONFIG.dailyRepeat),
    includeOverdue: input.includeOverdue === undefined
      ? (previous.includeOverdue !== false)
      : !!input.includeOverdue,
    tz: notify_pickString(input.tz) || notify_pickString(previous.tz) || '',
    time,
    checkInterval,
    lastScan: previous.lastScan ?? null,
    // 每个渠道单独合并：未提交的渠道保留旧值，提交了但密钥留空则沿用旧密钥
    params: mergeParams(rawParams, prevParams),
  };
}

/** 逐渠道合并参数，secret 字段留空表示不修改 */
function mergeParams(input, previous) {
  const out = {};
  for (const channel of CHANNELS) {
    const next = input[channel];
    const prev = previous[channel] || {};
    if (next === undefined) {
      if (Object.keys(prev).length) out[channel] = { ...prev };
      continue;
    }
    if (next === null) continue;              // 显式清空
    if (typeof next !== 'object') continue;

    const spec = CHANNEL_FIELDS[channel]?.fields || [];
    const merged = { ...prev };
    for (const field of spec) {
      const value = next[field.key];
      if (value === undefined) continue;              // 没提交 = 不修改
      const str = typeof value === 'string' ? value.trim() : value;
      // 密钥类字段：前端不回显，提交空串只能理解为「别动它」
      if (field.secret && (str === '' || str === undefined)) continue;
      // 非密钥字段：空串就是「清空」，照实写入
      merged[field.key] = str;
    }
    out[channel] = merged;
  }
  return out;
}

/** 根据环境变量补默认值（与备份密钥同样的兜底策略） */
function applyEnvDefaults(config, env = {}) {
  const params = { ...config.params };
  const fill = (channel, key) => {
    const spec = CHANNEL_FIELDS[channel]?.fields.find((f) => f.key === key);
    if (!spec?.secret) return;
    params[channel] = params[channel] || {};
    if (!params[channel][key]) params[channel][key] = '';
  };
  fill('bark', 'key');
  fill('gotify', 'token');
  fill('wxpusher', 'appToken');
  fill('telegram', 'botToken');
  fill('serverchan', 'sendKey');
  fill('pushplus', 'token');
  fill('email', 'apiKey');
  fill('ntfy', 'token');
  return params;
}

/** 返回给前端时抹掉密钥，只告知「是否已配置」 */
export function maskNotifyConfig(config = EMPTY_NOTIFY_CONFIG, env = {}) {
  const params = {};
  for (const channel of CHANNELS) {
    const raw = config.params?.[channel] || {};
    const spec = CHANNEL_FIELDS[channel]?.fields || [];
    const masked = {};
    for (const field of spec) {
      if (field.secret) {
        masked[field.key] = '';
        masked[`has_${field.key}`] = !!raw[field.key];
      } else {
        masked[field.key] = raw[field.key] ?? '';
      }
    }
    params[channel] = masked;
  }
  return {
    version: NOTIFY_VERSION,
    enabled: !!config.enabled,
    channels: Array.isArray(config.channels) ? config.channels : [],
    leadDays: config.leadDays ?? EMPTY_NOTIFY_CONFIG.leadDays,
    dailyRepeat: !!config.dailyRepeat,
    includeOverdue: config.includeOverdue !== false,
    tz: config.tz || '',
    time: config.time || EMPTY_NOTIFY_CONFIG.time,
    checkInterval: config.checkInterval ?? EMPTY_NOTIFY_CONFIG.checkInterval,
    lastScan: config.lastScan ?? null,
    params,
    catalog: CHANNELS.map((c) => ({
      id: c,
      label: CHANNEL_LABELS[c],
      fields: CHANNEL_FIELDS[c].fields,
    })),
    hasEnvFallback: Object.keys(env || {}).some((k) => k.startsWith('NOTIFY_')),
  };
}

/**
 * 建表缺失时的兜底建表：D1 里跑不了多语句 DDL，
 * 这里逐条执行并忽略「表已存在」。
 */
export async function ensureNotifyTables(env) {
  // 1) 老库补 due_date 列：失败说明已经存在，忽略即可
  try {
    await env.DB.prepare('ALTER TABLE todos ADD COLUMN due_date TEXT').run();
  } catch { /* 列已存在 */ }

  const ddl = [
    `CREATE TABLE IF NOT EXISTS notifications (
       user_id TEXT PRIMARY KEY,
       notify_json TEXT,
       last_scan INTEGER,
       updated_at INTEGER NOT NULL
     )`,
    `CREATE TABLE IF NOT EXISTS notify_log (
       user_id TEXT NOT NULL,
       todo_id TEXT NOT NULL,
       due_date TEXT NOT NULL,
       channel TEXT NOT NULL,
       sent_at INTEGER NOT NULL,
       ok INTEGER NOT NULL DEFAULT 1,
       detail TEXT,
       PRIMARY KEY (user_id, todo_id, due_date, channel)
     )`,
  ];
  const run = async (sql) => {
    try {
      await env.DB.prepare(sql).run();
      return true;
    } catch {
      return false;
    }
  };
  for (const sql of ddl) {
    // eslint-disable-next-line no-await-in-loop
    if (!(await run(sql))) return false;
  }
  return true;
}

/** 读取通知配置；表不存在或字段不兼容时安全降级为空配置 */
export async function readNotifyConfig(env, userId) {
  try {
    const row = await env.DB
      .prepare('SELECT notify_json, last_scan FROM notifications WHERE user_id = ?')
      .bind(userId)
      .first();
    if (!row) return { config: { ...EMPTY_NOTIFY_CONFIG }, exists: false, schemaReady: true };
    let stored = {};
    if (row.notify_json) {
      try {
        stored = JSON.parse(row.notify_json) || {};
      } catch {
        stored = {};
      }
    }
    // v1 迁移：v1 的「每天提醒」默认是关的，实际表现是「只在进入提醒窗口那天推一次」，
    // 与「提前 N 天提醒」的直觉（N 天内每天提醒）相悖，被用户当成 bug。
    // v2 起默认改为每天提醒；老配置统一按新默认跑一次，之后用户再关就是明确选择。
    if ((Number(stored.version) || 0) < NOTIFY_VERSION) stored.dailyRepeat = undefined;
    return {
      config: normalizeNotifyConfig({ ...stored, lastScan: row.last_scan ?? null }, stored),
      exists: true,
      schemaReady: true,
    };
  } catch {
    // notifications 表不存在或结构不兼容：返回空配置 + 让调用方知道需要补建表
    return { config: { ...EMPTY_NOTIFY_CONFIG }, exists: false, schemaReady: false };
  }
}

export async function writeNotifyConfig(env, userId, config) {
  const ts = nowSeconds();
  const payload = JSON.stringify({ ...config, lastScan: undefined });
  await env.DB.prepare(
    `INSERT INTO notifications (user_id, notify_json, last_scan, updated_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(user_id) DO UPDATE SET
       notify_json = excluded.notify_json,
       updated_at  = excluded.updated_at`,
  )
    .bind(userId, payload, config.lastScan ?? null, ts)
    .run();
  return config;
}

/**
 * 记录扫描时间（顺手记住时区，供 Cron 触发时算「今天」）。
 * last_scan 是「上次自动检查」的时间戳，驱动用户自选的检查频率门控，
 * 所以只有定时检查（stampScan = true）才更新它；打开设置页只保存时区，不重置节奏。
 */
export async function rememberNotifyMeta(env, userId, config, { timeZone = '', now = nowSeconds(), stampScan = false } = {}) {
  const next = { ...config };
  const tz = notify_pickString(timeZone);
  if (tz && next.tz !== tz) {
    next.tz = tz;
    await writeNotifyConfig(env, userId, next);
  }
  if (stampScan) {
    try {
      await env.DB
        .prepare('UPDATE notifications SET last_scan = ?, updated_at = ? WHERE user_id = ?')
        .bind(now, now, userId)
        .run();
    } catch {
      /* 表不存在时忽略 */
    }
  }
  return next;
}

/** 定时检查结束后盖章：记录「这次检查发生在何时」，供下轮频率门控比较 */
async function stampLastScan(env, userId, ts) {
  try {
    await env.DB
      .prepare('UPDATE notifications SET last_scan = ?, updated_at = ? WHERE user_id = ?')
      .bind(ts, ts, userId)
      .run();
  } catch {
    /* 表不存在时忽略 */
  }
}

/* ============================== 消息组装 ============================== */

/**
 * 把一批到期任务拼成通知正文。
 * @param {Array<{title:string, dueDate:string, days:number}>} items
 */
export function buildMessage(items, { appName = '今日待办', now = new Date(), timeZone = 'UTC' } = {}) {
  const today = todayInZone(timeZone, now);
  const overdue = items.filter((t) => t.days < 0);
  const due = items.filter((t) => t.days === 0);
  const soon = items.filter((t) => t.days > 0);

  const title = items.length === 1
    ? `待办提醒：${truncate(items[0].title, 24)}`
    : `待办到期提醒（${items.length} 项）`;

  const lines = [`【${appName}】${today}`, ''];

  if (overdue.length) {
    lines.push(`⏰ 已过期（${overdue.length}）`);
    overdue.forEach((t) => lines.push(`  · ${truncate(t.title, 60)}（${humanizeDays(t.days)}，${t.dueDate}）`));
    lines.push('');
  }
  if (due.length) {
    lines.push(`📌 今天到期（${due.length}）`);
    due.forEach((t) => lines.push(`  · ${truncate(t.title, 60)}`));
    lines.push('');
  }
  if (soon.length) {
    lines.push(`🔔 即将到期（${soon.length}）`);
    soon.forEach((t) => lines.push(`  · ${truncate(t.title, 60)}（${humanizeDays(t.days)}，${t.dueDate}）`));
    lines.push('');
  }

  const text = lines.join('\n').trimEnd();
  return { title, text, markdown: text, count: items.length, overdue: overdue.length, due: due.length, soon: soon.length };
}

function truncate(str, max) {
  const s = String(str ?? '');
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

/* ============================== HTTP 小工具 ============================== */

async function postJson(url, payload, headers = {}) {
  const res = await fetchWithTimeout(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json; charset=utf-8', ...headers },
    body: JSON.stringify(payload),
  });
  return readResult(res);
}

/**
 * Server 酱推送 URL。
 * 官方文档（doc.sc3.ft07.com）：
 *  - 三代 key（sctp…，形如 sctp{uid}txxxxxxxx）：
 *      https://{uid}.push.ft07.com/send/{SendKey}.send   （uid = sctp 与 t 之间的数字）
 *  - Turbo key（SCT… 或其它）：https://sctapi.ftqq.com/{SendKey}.send
 * 注意：不能把整个 sendKey 当子域名（会 404），路径里的 .send 后缀也不能少。
 */
function serverchanUrl(sendKey) {
  const key = String(sendKey || '').trim();
  const m = /^sctp(\d+)t/i.exec(key);
  if (m) return `https://${m[1]}.push.ft07.com/send/${key}.send`;
  return `https://sctapi.ftqq.com/${key}.send`;
}

async function postForm(url, pairs, headers = {}) {
  const body = new URLSearchParams(pairs).toString();
  const res = await fetchWithTimeout(url, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded; charset=utf-8', ...headers },
    body,
  });
  return readResult(res);
}

async function fetchWithTimeout(url, init = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch (err) {
    if (err?.name === 'AbortError') throw new HttpError(`请求超时（${TIMEOUT_MS / 1000} 秒）：${url}`, 504);
    throw new HttpError(`请求失败：${err?.message || err}`, 502);
  } finally {
    clearTimeout(timer);
  }
}

/** 读取响应，非 2xx 直接把上游返回的内容抛出来，便于排查 */
async function readResult(res) {
  const text = await res.text().catch(() => '');
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  if (!res.ok) {
    const detail = json ? JSON.stringify(json).slice(0, 300) : text.slice(0, 300);
    throw new HttpError(`上游返回 ${res.status}：${detail || '(空响应)'}`, 502);
  }
  return { status: res.status, json, text, ok: true };
}

/** 按点号路径取值：'data.0.title' */
function readPath(obj, path) {
  return String(path).split('.').reduce((acc, key) => {
    if (acc === null || acc === undefined) return undefined;
    return acc[key];
  }, obj);
}

/** 上游常见的「HTTP 200 但业务失败」：按渠道规则判断 */
function assertUpstreamOk(channel, result) {
  const body = result.json;
  if (!body || typeof body !== 'object') return;

  const failPath = UPSTREAM_STATUS[channel];
  if (!failPath) return;
  const code = readPath(body, failPath.pointer);
  if (code === undefined) return;
  if (failPath.success.includes(code)) return;

  // 按「可读性」挑一条最能说明问题的字段
  const readText = (v) => (typeof v === 'string' && v.trim() ? v.trim() : '');
  const reason = readText(readPath(body, 'description'))
    || readText(readPath(body, 'errmsg'))
    || readText(readPath(body, 'message'))
    || readText(readPath(body, 'msg'))
    || readText(readPath(body, 'error'))
    || String(code);
  throw new HttpError(
    `${CHANNEL_LABELS[channel] || channel} 返回失败：${reason}\n${JSON.stringify(body).slice(0, 300)}`,
    502,
  );
}

/** 各渠道在 JSON 里的成功标志（HTTP 200 也要看业务码） */
const UPSTREAM_STATUS = {
  bark: { pointer: 'code', success: [200, 0] },
  wxpusher: { pointer: 'code', success: [1000] },
  serverchan: { pointer: 'code', success: [0] },
  pushplus: { pointer: 'code', success: [200] },
  telegram: { pointer: 'ok', success: [true] },
  feishu: { pointer: 'code', success: [0, undefined] },
  wecom: { pointer: 'errcode', success: [0] },
  gotify: { pointer: 'errorCode', success: [0, undefined] },
};

/* ============================== 渠道实现 ============================== */

/**
 * 给单个渠道发一条消息。
 * 所有渠道都返回 { channel, detail }，失败一律抛 HttpError。
 */
export async function sendOne(channel, params, message, env = {}) {
  const p = params || {};
  const title = message.title;
  const text = message.text;

  switch (channel) {
    /* ---------------- Bark：POST /push ---------------- */
    case 'bark': {
      // 常见误填：把 App 里复制的完整推送 URL（https://api.day.app/<key>）当服务器地址。
      // 路径里带着 key 时，请求会打到 /<key>/push，bark-server 按路径格式解析，
      // 把路径段 push 当成正文（通知只剩标题、正文显示 "push"）。
      // 这里把路径段剥出来，统一 POST 到 站点根/push。
      const base = new URL(normalizeUrl(p.server || 'https://api.day.app'));
      const pathKey = base.pathname.split('/').filter(Boolean).pop() || '';
      const key = required(p.key || pathKey, 'Bark Device Key', env.NOTIFY_BARK_KEY);
      // 官方 API：POST /push，device_key / title / body 放在 JSON body 里。
      // 不要用 x-bark-key 这类自创请求头 —— 部分 bark-server 不认，回退解析
      // URL 路径时会把路径段当成正文，通知就只剩标题。
      const send = (deviceKey) => {
        const payload = { device_key: deviceKey, title, body: text, group: p.group || '今日待办' };
        if (p.sound) payload.sound = p.sound;
        return postJson(`${base.origin}/push`, payload);
      };
      let result;
      try {
        result = await send(key);
      } catch (err) {
        // 已保存的 Key 若失效（服务器报「未知 device token」），而服务器地址路径里
        // 恰好带着另一个 Key（App 复制的完整 URL），就用它自动重试一次
        const msg = String(err?.message || err);
        if (pathKey && pathKey !== key && /device token/i.test(msg)) {
          result = await send(pathKey);
        } else if (/device token/i.test(msg)) {
          throw new HttpError(`Bark 服务器不认识这个 Device Key（${msg.slice(0, 160)}）。`
            + '请把 Bark App 首页复制的 Key（或完整推送地址末尾那段）填进「Device Key」后保存', 502);
        } else {
          throw err;
        }
      }
      assertUpstreamOk('bark', result);
      return { channel, detail: 'Bark 已推送' };
    }

    /* ---------------- Gotify：POST /message?token= ---------------- */
    case 'gotify': {
      const server = normalizeUrl(p.server);
      const token = required(p.token, 'Gotify App Token', env.NOTIFY_GOTIFY_TOKEN);
      const url = `${server}/message?token=${encodeURIComponent(token)}`;
      const result = await postJson(url, {
        title,
        message: text,
        priority: clampInt(p.priority, 5, 0, 10),
      });
      assertUpstreamOk('gotify', result);
      return { channel, detail: 'Gotify 已推送' };
    }

    /* ---------------- WxPusher：POST /api/send/message ---------------- */
    case 'wxpusher': {
      const appToken = required(p.appToken, 'WxPusher AppToken', env.NOTIFY_WXPUSHER_APPTOKEN);
      const uids = splitList(p.uids);
      const topicIds = splitList(p.topicIds).map((v) => Number(v)).filter((v) => Number.isFinite(v));
      if (!uids.length && !topicIds.length) throw new HttpError('WxPusher 需要填写 UID 或主题 ID');
      const result = await postJson('https://wxpusher.zjiecode.com/api/send/message', {
        appToken,
        content: text.replace(/\n/g, '<br/>'),
        summary: title,
        contentType: 2,           // 2 = HTML
        uids: uids.length ? uids : undefined,
        topicIds: topicIds.length ? topicIds : undefined,
        url: p.url || undefined,
      });
      assertUpstreamOk('wxpusher', result);
      return { channel, detail: 'WxPusher 已推送' };
    }

    /* ---------------- 邮件：Resend HTTP API ---------------- */
    case 'email': {
      const apiKey = required(p.apiKey, 'Resend API Key', env.NOTIFY_RESEND_API_KEY);
      const from = required(p.from, '发件人地址');
      const to = splitList(p.to);
      if (!to.length) throw new HttpError('邮件收件人不能为空');
      const result = await postJson('https://api.resend.com/emails', {
        from,
        to,
        subject: title,
        text,
      }, { authorization: `Bearer ${apiKey}` });
      return { channel, detail: `邮件已发送至 ${to.join(', ')}` };
    }

    /* ---------------- Telegram：POST /bot<token>/sendMessage ---------------- */
    case 'telegram': {
      const botToken = required(p.botToken, 'Telegram Bot Token', env.NOTIFY_TELEGRAM_BOT_TOKEN);
      const chatId = required(p.chatId, 'Telegram Chat ID');
      const base = normalizeUrl(p.baseUrl || 'https://api.telegram.org');
      const payload = {
        chat_id: chatId,
        text: `*${escapeMarkdown(title)}*\n\n${escapeMarkdown(text)}`,
        parse_mode: 'MarkdownV2',
        disable_web_page_preview: true,
      };
      if (p.threadId) payload.message_thread_id = Number(p.threadId) || undefined;
      const result = await postJson(`${base}/bot${botToken}/sendMessage`, payload);
      assertUpstreamOk('telegram', result);
      return { channel, detail: 'Telegram 已推送' };
    }

    /* ---------------- 微信机器人：任意 webhook + 文本字段 ---------------- */
    case 'wechat': {
      const url = normalizeUrl(p.url);
      const field = notify_pickString(p.field) || 'text';
      const headers = {};
      if (p.token) headers.authorization = /^bearer /i.test(p.token) ? p.token : `Bearer ${p.token}`;
      const result = await postJson(url, renderTextBody(p.template, {
        field,
        title,
        text,
        count: String(message.count ?? 1),
      }, { [field]: `${title}\n\n${text}` }), headers);
      return { channel, detail: '微信机器人已推送' };
    }

    /* ---------------- 飞书自定义机器人 ---------------- */
    case 'feishu': {
      const url = normalizeUrl(p.url);
      const usePost = String(p.msgType || 'text').toLowerCase() === 'post';
      const payload = usePost
        ? {
            msg_type: 'post',
            content: {
              post: {
                zh_cn: {
                  title,
                  content: text.split('\n').filter(Boolean).map((line) => [{ tag: 'text', text: line }]),
                },
              },
            },
          }
        : { msg_type: 'text', content: { text: `${title}\n\n${text}` } };

      if (p.secret) {
        const ts = Math.floor(Date.now() / 1000);
        payload.timestamp = String(ts);
        payload.sign = await feishuSign(p.secret, ts);
      }
      const result = await postJson(url, payload);
      assertUpstreamOk('feishu', result);
      return { channel, detail: '飞书已推送' };
    }

    /* ---------------- 企业微信群机器人 ---------------- */
    case 'wecom': {
      const url = normalizeUrl(p.url);
      const asText = String(p.msgType || 'markdown').toLowerCase() === 'text';
      const payload = asText
        ? { msgtype: 'text', text: { content: `${title}\n\n${text}` } }
        : { msgtype: 'markdown', markdown: { content: `**${title}**\n\n${text}` } };
      const result = await postJson(url, payload);
      assertUpstreamOk('wecom', result);
      return { channel, detail: '企业微信已推送' };
    }

    /* ---------------- 通用 Webhook ---------------- */
    case 'webhook': {
      const url = normalizeUrl(p.url);
      const method = (notify_pickString(p.method) || 'POST').toUpperCase();
      const contentType = notify_pickString(p.contentType) || 'application/json';
      const headers = parseJsonInput(p.headers) || {};
      if (!headers || typeof headers !== 'object') throw new HttpError('额外请求头需要是 JSON 对象');

      const vars = {
        title,
        text,
        count: String(message.count ?? 1),
        items: JSON.stringify(message.items || []),
      };
      const fallback = { title, text, count: message.count ?? 1 };
      if (/\{items\}/.test(notify_pickString(p.template))) fallback.items = message.items || [];

      let bodyText;
      if (/json/i.test(contentType)) {
        // JSON：优先对象式渲染（正确转义换行/引号），模板不是合法 JSON 时退回
        // 文本替换 + 解析校验，再不行用默认体——绝不把非法 JSON 发出去
        const obj = renderTemplateObject(p.template, vars, message.items || []);
        const reparsed = obj || tryParseJson(renderTemplate(p.template, vars));
        bodyText = JSON.stringify(
          reparsed && typeof reparsed === 'object' && !Array.isArray(reparsed) ? reparsed : fallback,
        );
      } else {
        // 非 JSON（如表单模板）：按纯文本替换后原样发送
        bodyText = renderTemplate(p.template, vars) || JSON.stringify(fallback);
      }

      const res = await fetchWithTimeout(url, {
        method,
        headers: { 'content-type': contentType, ...headers },
        body: method === 'GET' || method === 'HEAD' ? undefined : bodyText,
      });
      await readResult(res);
      return { channel, detail: `Webhook 已请求（${method}）` };
    }

    /* ---------------- Server 酱 ---------------- */
    case 'serverchan': {
      const sendKey = required(p.sendKey, 'Server 酱 SendKey', env.NOTIFY_SERVERCHAN_KEY);
      const url = serverchanUrl(sendKey);
      const pairs = [['title', title], ['desp', text]];
      if (p.channel) pairs.push(['channel', String(p.channel)]);
      const result = await postForm(url, pairs);
      assertUpstreamOk('serverchan', result);
      return { channel, detail: 'Server 酱已推送' };
    }

    /* ---------------- PushPlus ---------------- */
    case 'pushplus': {
      const token = required(p.token, 'PushPlus Token', env.NOTIFY_PUSHPLUS_TOKEN);
      const payload = {
        token,
        title,
        content: text,
        template: notify_pickString(p.template) || 'txt',
      };
      if (p.topic) payload.topic = p.topic;
      const result = await postJson('https://www.pushplus.plus/send', payload);
      assertUpstreamOk('pushplus', result);
      return { channel, detail: 'PushPlus 已推送' };
    }

    /* ---------------- ntfy ---------------- */
    case 'ntfy': {
      const server = normalizeUrl(p.server || 'https://ntfy.sh');
      const topic = required(p.topic, 'ntfy 主题');
      // ntfy 官方规定主题只能是 字母/数字/-/_（1-64 位），中文等其它字符会被
      // 服务器当成不存在的路径返回 404 "page not found"（实测踩过的坑）
      if (!/^[-_A-Za-z0-9]{1,64}$/.test(topic)) {
        throw new HttpError(`ntfy 主题「${topic}」不合法：只能用英文字母、数字、- 和 _（最长 64 位），不能用中文或空格。比如改成 todo-today`);
      }
      const headers = {
        'content-type': 'text/plain; charset=utf-8',
        title: encodeHeaderValue(title),
        priority: String(clampInt(p.priority, 3, 1, 5)),
        tags: 'bell',
      };
      if (p.token) headers.authorization = /^bearer /i.test(p.token) ? p.token : `Bearer ${p.token}`;
      const res = await fetchWithTimeout(`${server}/${encodeURIComponent(topic)}`, {
        method: 'POST',
        headers,
        body: text,
      });
      await readResult(res);
      return { channel, detail: 'ntfy 已推送' };
    }

    default:
      throw new HttpError(`不支持的通知渠道：${channel}`);
  }
}

/** 必填项校验，支持环境变量兜底 */
function required(value, label, envFallback = '') {
  const v = notify_pickString(value) || notify_pickString(envFallback);
  if (!v) throw new HttpError(`请先填写${label}`);
  return v;
}

function clampInt(value, fallback, min, max) {
  const n = Math.round(Number(value));
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(n, min), max);
}

/** 取相对天数，优先保留更小的值（负的优先级最高） */
function preferDays(a, b) {
  if (a === null || a === undefined) return b;
  if (b === null || b === undefined) return a;
  return Math.min(Number(a), Number(b));
}

/** 逗号 / 空格 / 换行 / 分号分隔的列表 */
export function splitList(value) {
  return String(value ?? '')
    .split(/[\s,;，、]+/)
    .map((v) => v.trim())
    .filter(Boolean);
}

/** MarkdownV2 需要转义的特殊字符 */
function escapeMarkdown(str) {
  return String(str ?? '').replace(/([_*[\]()~`>#+\-=|{}.!\\])/g, '\\$1');
}

/** HTTP 头值只能是 ASCII 可见字符，中文标题需编码 */
function encodeHeaderValue(value) {
  const s = String(value ?? '');
  // eslint-disable-next-line no-control-regex
  return /^[\x20-\x7E]*$/.test(s) ? s : `=?UTF-8?B?${btoa(unescape(encodeURIComponent(s)))}?=`;
}

/**
 * 极简模板渲染：把 {key} 换成对应值。
 * 只做字符串替换，不 eval，避免模板变成代码执行入口。
 */
function renderTemplate(template, vars) {
  const tpl = notify_pickString(template);
  if (!tpl) return '';
  return tpl.replace(/\{(\w+)\}/g, (whole, key) => (key in vars ? String(vars[key]) : whole));
}

/**
 * 对象型 JSON 模板渲染：先把模板本身解析成对象（此时 {title} 只是普通字符串，合法），
 * 在字符串值里做占位符替换，最后由调用方 JSON.stringify 重新序列化。
 * 这样正文里的换行、引号等字符会被正确转义——直接对模板字符串做文本替换，
 * 多行正文会产生裸换行 → 非法 JSON → 上游解析不出任何参数（实测踩过的坑）。
 * 值恰好是 {items} 时注入真正的数组。
 */
function renderTemplateObject(template, vars, items) {
  const parsed = tryParseJson(template);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const walk = (v) => {
    if (typeof v === 'string') {
      if (v.trim() === '{items}' && Array.isArray(items)) return items;
      return renderTemplate(v, vars);
    }
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === 'object') {
      const o = {};
      for (const k of Object.keys(v)) o[k] = walk(v[k]);
      return o;
    }
    return v;
  };
  return walk(parsed);
}

/**
 * 渲染出「一段 JSON 文本」：模板替换后必须是合法 JSON 对象，否则回退到默认体。
 * 这样用户模板里写了未转义的中文引号也不会把请求打挂，只会退回默认格式。
 */
function renderTextBody(template, vars, fallbackObject) {
  const rendered = renderTemplate(template, vars);
  if (rendered) {
    const parsed = parseJsonInput(rendered);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
  }
  return fallbackObject;
}

/** 飞书签名：HmacSHA256(key = timestamp + "\n" + secret, data = "") 的 base64 */
export async function feishuSign(secret, timestamp) {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(`${timestamp}\n${secret}`),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, new Uint8Array());
  return btoa(String.fromCharCode(...new Uint8Array(sig)));
}

/* ============================== 发送 / 测试 ============================== */

/**
 * 按配置把一条消息发给所有启用渠道。
 * @returns {Promise<{ok:string[], failed:Array<{channel:string,error:string}>}>}
 */
export async function sendToChannels(config, message, env = {}) {
  const channels = (config.channels || []).filter((c) => CHANNELS.includes(c));
  const ok = [];
  const failed = [];

  const tasks = channels.map(async (channel) => {
    const params = config.params?.[channel] || {};
    try {
      const result = await sendOne(channel, params, message, env);
      ok.push(channel);
      return result;
    } catch (err) {
      failed.push({ channel, error: err?.message || String(err) });
      return null;
    }
  });

  await Promise.all(tasks);
  return { ok, failed };
}

/** 设置页的「发送测试」：只发一个渠道，方便逐个排查 */
export async function testChannel(env, channel, config) {
  if (!CHANNELS.includes(channel)) throw new HttpError(`不支持的通知渠道：${channel}`);
  const message = {
    title: '【测试】今日待办通知已配置成功',
    text: [
      '这是一条测试消息 ✅',
      '',
      '收到它就说明该渠道的配置没问题，到期的任务会按你设置的提前天数推送到这里。',
      `渠道：${CHANNEL_LABELS[channel]}`,
      `时间：${new Date().toISOString()}`,
    ].join('\n'),
    count: 0,
    items: [],
  };
  const params = config.params?.[channel] || {};
  let result;
  try {
    result = await sendOne(channel, params, message, env);
  } catch (err) {
    // 失败时同样回显实际请求——用户正是这时候最需要知道「到底发了什么」
    const req = describeRequest(channel, params, env);
    if (req) {
      const parts = [`实际请求：${req.method} ${req.url}`];
      if (req.bodyPreview) parts.push(`请求体 ${req.bodyPreview}`);
      if (req.templateMissingPlaceholders) parts.push(`注意：${req.templateMissingPlaceholders}`);
      err.message = `${err.message}（${parts.join('，')}）`;
    }
    throw err;
  }
  // 回显真实发出的请求，方便排查「收到了但正文不对」这类上游解析问题
  const request = describeRequest(channel, params, env);
  return { message: `测试消息已发出（${result.detail}）`, detail: result.detail, request };
}

/**
 * 生成「将发出什么请求」的可读描述，只暴露结构与正文，绝不回显密钥。
 * 用户在「发送测试」里看到它，就能判断 Worker 跑的是不是最新代码。
 */
export function describeRequest(channel, params = {}, env = {}) {
  if (channel === 'email') {
    const p = params || {};
    const key = notify_pickString(p.apiKey) || notify_pickString(env.NOTIFY_EMAIL_API_KEY);
    return {
      method: 'POST',
      url: 'https://api.resend.com/emails',
      contentType: 'application/json; charset=utf-8',
      bodyKeys: ['from', 'to', 'subject', 'text'],
      apiKeyTail: key ? `…${key.slice(-4)}` : '(未配置)',
      note: '走 Resend 的 HTTPS API（Workers 无法直连 SMTP，因此没有服务器地址/端口）；发件人域名需在 Resend 验证，未验证时只能用 onboarding@resend.dev 发给注册邮箱',
    };
  }
  if (channel === 'webhook') {
    const p = params || {};
    const headers = parseJsonInput(p.headers);
    let url = '(未配置地址)';
    try { url = normalizeUrl(p.url); } catch { /* 保持占位 */ }
    return {
      method: (notify_pickString(p.method) || 'POST').toUpperCase(),
      url,
      contentType: notify_pickString(p.contentType) || 'application/json',
      bodyKeys: notify_pickString(p.template)
        ? ['(自定义模板)']
        : ['title', 'text', 'count'],
      headerKeys: headers && typeof headers === 'object' ? Object.keys(headers) : [],
      bodyPreview: (() => {
        // 用示例值真实渲染一遍，让用户看到「实际会发出什么」而不是模板原文
        const sampleVars = { title: '（标题）', text: '（正文，含待办清单）', count: '2', items: '[]' };
        const sampleItems = [];
        const obj = renderTemplateObject(p.template, sampleVars, sampleItems);
        if (obj) return JSON.stringify(obj).slice(0, 260);
        const tpl = notify_pickString(p.template);
        if (tpl) return renderTemplate(tpl, sampleVars).slice(0, 260);
        return '默认请求体 {"title":"…","text":"…","count":N}；接口要求别的字段名（如 content/token）时，请在「请求体模板」里写 {"token":"…","title":"{title}","content":"{text}"}';
      })(),
      templateMissingPlaceholders: notify_pickString(p.template) && !/\{(title|text|items|count)\}/.test(notify_pickString(p.template))
        ? '模板里没有 {text}/{title} 等占位符，待办内容不会出现在推送里——请把正文放进去，如 {"content":"{text}"}'
        : '',
      note: '请求头/模板里的密钥值不会回显',
    };
  }
  if (channel === 'serverchan') {
    const p = params || {};
    const key = notify_pickString(p.sendKey) || notify_pickString(env.NOTIFY_SERVERCHAN_KEY);
    const gen = /^sctp/i.test(key) ? 'Server酱³（sctp）' : 'Server酱·Turbo（SCT）';
    return {
      method: 'POST',
      url: key ? serverchanUrl(key) : '(未配置 SendKey)',
      contentType: 'application/x-www-form-urlencoded; charset=utf-8',
      bodyKeys: ['title', 'desp'],
      sendKeyTail: key ? `${/^sctp(\d+)t/i.exec(key) ? 'sctp' + (/^sctp(\d+)t/i.exec(key)[1]) + 't…' : key.slice(0, 3) + '…'}${key.slice(-4)}` : '(未配置)',
      note: `${gen} 官方接口格式；sctp 开头走 push.ft07.com，其余走 sctapi.ftqq.com`,
    };
  }
  if (channel !== 'bark') return null;
  const p = params || {};
  // 与 sendOne 的 bark 分支同款归一化：服务器地址里可能混着 device key
  let server = 'https://api.day.app';
  let pathKey = '';
  try {
    const u = new URL(notify_pickString(p.server) || server);
    const segs = u.pathname.split('/').filter(Boolean);
    pathKey = segs.pop() || '';
    server = u.origin;
  } catch { /* 保持默认 */ }
  const key = notify_pickString(p.key) || pathKey || notify_pickString(env.NOTIFY_BARK_KEY);
  return {
    method: 'POST',
    url: `${server}/push`,
    contentType: 'application/json; charset=utf-8',
    bodyKeys: ['device_key', 'title', 'body', 'group'],
    deviceKeyTail: key ? `…${key.slice(-4)}` : '(未配置)',
    serverHadKey: !!pathKey,
    note: 'device_key 放在 JSON body 里（Bark 官方 API）；服务器地址里的路径段会被剥出来当 Key',
  };
}

/* ============================== 到期扫描 ============================== */

/**
 * 找出该提醒的任务。
 *
 * 规则：
 *  - 只取未完成、且设了 due_date 的任务
 *  - days = due_date - today
 *  - 进入窗口的条件：days <= leadDays（includeOverdue=false 时还要求 days >= 0）
 *  - 「只提醒一次」靠 notify_log 去重实现：每条任务 + 到期日 + 渠道只推一次，
 *    所以从「还没进窗口」到「已经进窗口」的那一轮 Cron 就一定会推出去，
 *    哪怕期间应用没被打开过也不会漏。
 *  - dailyRepeat=true 时改为每天都能推（由调用方按「当天」维度去重）
 */
export async function findDueTodos(env, userId, config, { today, limit = MAX_PER_SCAN } = {}) {
  const leadDays = config.leadDays ?? 1;
  const windowStart = config.includeOverdue === false ? today : offsetDay(today, -30);
  // 由调用方传来的「今天是本地第几天」：用它算相对天数，
  // 可以完全避开 UTC 与本地时区之间的日期偏移问题。
  const todayNum = Number.isFinite(config.dateOffset) ? Number(config.dateOffset) : dayNumber(today);
  const sqlToday = offsetDay('1970-01-01', todayNum);

  let rows = [];
  try {
    const res = await env.DB.prepare(
      `SELECT id, title, due_date, todo_date
         FROM todos
        WHERE user_id = ? AND done = 0 AND due_date IS NOT NULL AND due_date != ''
          AND due_date <= ? AND due_date >= ?
        ORDER BY due_date ASC
        LIMIT ?`,
    )
      .bind(userId, offsetDay(sqlToday, leadDays), windowStart, limit * 4)
      .all();
    rows = res.results || [];
  } catch {
    // 老库还没有 due_date 列：直接当作没有到期任务
    return [];
  }

  const candidates = [];
  for (const row of rows) {
    const rowNum = dayNumber(row.due_date);
    if (rowNum === null || todayNum === null) continue;
    const diff = rowNum - todayNum;
    if (diff > leadDays) continue;
    if (diff < 0 && config.includeOverdue === false) continue;
    candidates.push({
      id: row.id,
      title: row.title,
      dueDate: row.due_date,
      // 相对天数：正数 = 还有几天到期，0 = 今天到期，负数 = 已过期几天
      // （曾经误写成 Math.min(0, diff)，会把所有正数压成 0，导致「即将到期」永不出现）
      days: diff,
    });
    if (candidates.length >= limit) break;
  }
  return candidates;
}

/** 日期字符串加减天数 */
export function offsetDay(dateStr, delta) {
  const n = dayNumber(dateStr);
  if (n === null) return dateStr;
  const d = new Date((n + delta) * 86_400_000);
  return d.toISOString().slice(0, 10);
}

/**
 * 诊断「为什么没有任务会被提醒」。
 * 预览为空 / 立即检查没东西可推时，笼统的「没有需要提醒的任务」没法帮用户定位，
 * 这里把数据侧的原因说清楚：到底是没有任务设到期日，还是到期日都在窗口外。
 * （开关未开 / 没选渠道这类配置侧原因由 explainEmptyRun 在外层判断。）
 *
 * @returns {Promise<string>} 人类可读的原因；空串表示说不清（维持原样即可）
 */
export async function describeNotifyGap(env, userId, config, { today, leadDays } = {}) {
  let rows = [];
  try {
    const res = await env.DB.prepare(
      `SELECT due_date, COUNT(*) AS n
         FROM todos
        WHERE user_id = ? AND done = 0 AND due_date IS NOT NULL AND due_date != ''
        GROUP BY due_date
        ORDER BY due_date ASC`,
    )
      .bind(userId)
      .all();
    rows = res.results || [];
  } catch {
    return '';   // 老库没有 due_date 列时不猜原因
  }
  if (!rows.length) {
    const missing = await countMissingDue(env, userId);
    if (missing > 0) {
      return `有 ${missing} 个未完成任务的到期日为空，所以没有可提醒的内容。`
        + '新任务现在默认按「所属日期」自动设到期日，点下面的「补齐到期日」可以把这些历史任务一次性补上';
    }
    return '当前没有未完成的任务，没有可提醒的内容';
  }

  const lead = Number.isFinite(leadDays) ? leadDays : (config.leadDays ?? 1);
  const todayNum = dayNumber(today);
  const windowEnd = offsetDay(today, lead);
  const withDue = rows.reduce((sum, r) => sum + Number(r.n || 0), 0);

  // 窗口外最近的到期日（只在未来的才算「即将到期但超出窗口」）
  const upcoming = rows.find((r) => {
    const n = dayNumber(r.due_date);
    return n !== null && todayNum !== null && n > todayNum + lead;
  });
  if (upcoming) {
    return `有 ${withDue} 个任务设置了到期日，但最近的 ${upcoming.due_date} 超出了「提前 ${lead} 天」的提醒窗口，可把「提前几天」调大`;
  }

  // 剩下的只有已过期任务，而用户关掉了「已过期也提醒」
  const hasOverdueOnly = rows.every((r) => {
    const n = dayNumber(r.due_date);
    return n !== null && todayNum !== null && n < todayNum;
  });
  if (hasOverdueOnly && config.includeOverdue === false) {
    return `有 ${withDue} 个任务设置了到期日但都已过期，而「已过期任务也提醒」是关闭的`;
  }
  return '';
}

/**
 * 「立即检查」没有东西可推时，给出具体原因（配置侧 + 数据侧）。
 */
export async function explainEmptyRun(env, userId, config, { now = new Date(), reqTz = '' } = {}) {
  if (!config.enabled) return '到期提醒未开启：请先打开「启用到期提醒」并保存配置';
  const channels = (config.channels || []).filter((c) => CHANNELS.includes(c));
  if (!channels.length) return '还没有选择推送渠道：请在「推送渠道」里至少勾选一个并保存';
  const tz = resolveTimeZone(config, reqTz);
  const today = todayInZone(tz, now);
  const gap = await describeNotifyGap(env, userId, config, { today, leadDays: config.leadDays });
  return gap || '当前没有需要提醒的任务';
}

/**
 * 查已推送记录，返回 Set('todoId|dueDate|channel')。
 * 主表写不进去时（例如老库结构对不上）降级查一张宽松的备用表，
 * 这样「别重复打扰」这个承诺在任何库结构下都成立。
 */
async function readSentKeys(env, userId, config = {}) {
  const daily = !!config.dailyRepeat;
  const today = config.logDate || '';
  // 「发送日期」必须和 today 用同一个时区：today 是用户本地日期，
  // 如果 sent_at 用 UTC 取日期，北京时间 0~8 点（UTC 还是昨天）就会错判
  // 「这条不是今天推的」，导致同一天重复推/漏推（只在 0 点后 8 点前发作）。
  const tz = resolveTimeZone(config);
  const collect = async (table) => {
    const { results } = await env.DB
      .prepare(`SELECT todo_id, due_date, channel, sent_at FROM ${table} WHERE user_id = ? AND ok = 1`)
      .bind(userId)
      .all();
    const set = new Set();
    for (const r of results || []) {
      if (daily) {
        // 每天重复提醒模式：用「发送日期」当作去重维度，同一天只推一次
        if (today && dayOf(r.sent_at, tz) !== today) continue;
        set.add(`${r.todo_id}|*|${r.channel}`);
      } else {
        set.add(`${r.todo_id}|${r.due_date}|${r.channel}`);
      }
    }
    return set;
  };
  try {
    return await collect('notify_log');
  } catch {
    try {
      return await collect('notify_log_legacy');
    } catch {
      return new Set();
    }
  }
}

/** Unix 秒 -> 该用户的本地日期字符串 YYYY-MM-DD */
function dayOf(ts, timeZone = 'UTC') {
  const ms = Number(ts) * 1000;
  if (!Number.isFinite(ms)) return '';
  return todayInZone(timeZone, new Date(ms));
}

/** 去重用的 key：dailyRepeat 下按「今天」算，否则按「到期日」算 */
function sentKey(todoId, dueDate, channel, daily, today) {
  return daily ? `${todoId}|*|${channel}` : `${todoId}|${dueDate}|${channel}`;
}

/** 备用日志表：主表不存在（老库）时使用，结构更宽松、无主键约束 */
async function ensureLegacyLog(env) {
  try {
    await env.DB.prepare(
      `CREATE TABLE IF NOT EXISTS notify_log_legacy (
         user_id TEXT NOT NULL,
         todo_id TEXT NOT NULL,
         due_date TEXT NOT NULL,
         channel TEXT NOT NULL,
         sent_at INTEGER NOT NULL,
         ok INTEGER NOT NULL DEFAULT 1,
         detail TEXT
       )`,
    ).run();
  } catch { /* 忽略 */ }
}

/** 把某条推送结果写进日志（只有成功才 ok=1，失败留存以便下轮重试） */
async function recordSent(env, userId, { todoId, dueDate, channel, ok, detail }) {
  const at = nowSeconds();
  const detailText = detail ? String(detail).slice(0, 300) : null;
  try {
    await env.DB.prepare(
      `INSERT INTO notify_log (user_id, todo_id, due_date, channel, sent_at, ok, detail)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(user_id, todo_id, due_date, channel)
       DO UPDATE SET sent_at = excluded.sent_at, ok = excluded.ok, detail = excluded.detail`,
    )
      .bind(userId, todoId, dueDate, channel, at, ok ? 1 : 0, detailText)
      .run();
    return;
  } catch { /* 降级到备用表 */ }

  try {
    await ensureLegacyLog(env);
    await env.DB.prepare('DELETE FROM notify_log_legacy WHERE user_id = ? AND todo_id = ? AND due_date = ? AND channel = ?')
      .bind(userId, todoId, dueDate, channel)
      .run();
    await env.DB.prepare(
      'INSERT INTO notify_log_legacy (user_id, todo_id, due_date, channel, sent_at, ok, detail) VALUES (?, ?, ?, ?, ?, ?, ?)',
    )
      .bind(userId, todoId, dueDate, channel, at, ok ? 1 : 0, detailText)
      .run();
  } catch {
    /* 日志写不进去不该影响主流程，但会退化成「可能重复推送」 */
  }
}

/**
 * 给单个用户跑一轮到期提醒。供 Cron 与「立即检查」共用。
 *
 * @returns {Promise<{due:number, sent:number, skipped:number, failed:Array}>}
 */
export async function runNotifyForUser(env, userId, config, { now = new Date(), ignoreQuietHours = false, reqTz = '' } = {}) {
  const report = { due: 0, sent: 0, skipped: 0, failed: [] };
  if (!config.enabled) return report;
  const channels = (config.channels || []).filter((c) => CHANNELS.includes(c));
  if (!channels.length) return report;

  const tz = resolveTimeZone(config, reqTz);

  // 免打扰：每天到点之前不推（「立即检查」可跳过这个限制）
  if (!ignoreQuietHours) {
    const nowClock = clockInZone(tz, now);
    if (config.time && nowClock < config.time) {
      report.skipped = -1;      // -1 表示「没到时间」
      return report;
    }
  }

  const today = todayInZone(tz, now);
  const withOffset = { ...config, dateOffset: dayNumber(today), logDate: today };
  const items = await findDueTodos(env, userId, withOffset, { today });
  report.due = items.length;
  if (!items.length) return report;

  const daily = !!config.dailyRepeat;
  const sent = await readSentKeys(env, userId, withOffset);
  const pending = items.filter(
    (t) => channels.some((c) => !sent.has(sentKey(t.id, t.dueDate, c, daily, today))),
  );
  report.skipped = items.length - pending.length;
  if (!pending.length) return report;

  const message = buildMessage(pending, {
    appName: env.APP_NAME || '今日待办',
    now,
    timeZone: tz,
  });
  message.items = pending.map((t) => ({ title: t.title, dueDate: t.dueDate, days: t.days }));

  for (const channel of channels) {
    const targets = pending.filter((t) => !sent.has(sentKey(t.id, t.dueDate, channel, daily, today)));
    if (!targets.length) continue;
    try {
      const result = await sendOne(channel, config.params?.[channel] || {}, message, env);
      report.sent += 1;
      for (const t of targets) {
        // 日志里的 due_date 始终记真实的到期日，方便排查；去重维度由 dailyRepeat 决定
        await recordSent(env, userId, { todoId: t.id, dueDate: t.dueDate, channel, ok: true, detail: result.detail });
      }
    } catch (err) {
      const error = err?.message || String(err);
      report.failed.push({ channel, error });
      // 失败不写 ok=1，下轮 Cron 会重试
      await recordSent(env, userId, { todoId: targets[0].id, dueDate: targets[0].dueDate, channel, ok: false, detail: error });
      console.error(`[notify] user=${userId} channel=${channel} 失败：${error}`);
    }
  }

  return report;
}

/**
 * Cron 入口：遍历所有开启了通知的用户。
 * 与定时备份共用同一个 5 分钟心跳。
 */
export async function runScheduledNotify(env, { now = new Date() } = {}) {
  let rows = [];
  try {
    const res = await env.DB.prepare(
      `SELECT n.user_id AS user_id, n.notify_json AS notify_json, n.last_scan AS last_scan,
              u.username AS username
         FROM notifications n
         JOIN users u ON u.id = n.user_id
        WHERE n.notify_json IS NOT NULL`,
    ).all();
    rows = res.results || [];
  } catch {
    return { checked: 0, due: 0, sent: 0, users: 0, gated: 0, failed: [] };   // 表还没建
  }

  const report = { checked: rows.length, due: 0, sent: 0, users: 0, gated: 0, failed: [] };
  const nowSec = Math.floor(now.getTime() / 1000);

  for (const row of rows) {
    let config;
    try {
      config = normalizeNotifyConfig(JSON.parse(row.notify_json) || {}, {});
    } catch {
      continue;   // 配置坏了跳过，别让一个用户拖垮整轮
    }
    if (!config.enabled) continue;

    // 检查频率门控：云端定时器每 5 分钟醒来一次，用户可以调大检查间隔（默认 5 分钟）。
    // last_scan 只由这里的定时检查写入；30 秒容差吸收 Cron 的触发抖动。
    const intervalSec = (Number(config.checkInterval) || 5) * 60;
    const lastScan = Number(row.last_scan) || 0;
    if (lastScan && nowSec - lastScan < intervalSec - 30) {
      report.gated += 1;
      continue;
    }

    try {
      const one = await runNotifyForUser(env, row.user_id, config, { now });
      if (one.due > 0) report.users += 1;
      report.due += one.due;
      report.sent += one.sent;
      if (one.failed.length) report.failed.push({ user: row.user_id, ...one.failed[0] });
    } catch (err) {
      report.failed.push({ user: row.user_id, error: err?.message || String(err) });
      console.error(`[notify] user=${row.user_id} 失败：${err?.message || err}`);
    } finally {
      // 检查发生过就要盖章（包括免打扰时段跳过的情况），否则门控永远放行
      await stampLastScan(env, row.user_id, nowSec);
    }
  }

  return report;
}

/** 预览「当前会提醒哪些任务」，供设置页展示；为空时附带原因，帮用户定位 */
export async function previewDue(env, userId, config, { now = new Date(), reqTz = '' } = {}) {
  const tz = resolveTimeZone(config, reqTz);
  const today = todayInZone(tz, now);
  const withOffset = { ...config, dateOffset: dayNumber(today) };
  const items = await findDueTodos(env, userId, withOffset, { today });
  const leadDays = config.leadDays ?? 1;
  const out = { today, tz, leadDays, items };
  // 还有多少未完成任务没设到期日（规则上线前的历史数据），前端据此显示「补齐到期日」按钮
  out.missingDue = await countMissingDue(env, userId);
  if (!items.length) {
    out.hint = await describeNotifyGap(env, userId, config, { today, leadDays });
  }
  return out;
}
