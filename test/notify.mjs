/**
 * 到期提醒（通知推送）专项测试。
 *
 * 分两层：
 *   A. 纯函数层 —— 配置归一化、掩码、消息组装、日期计算、模板渲染
 *   B. 端到端层 —— 用内存 SQLite 冒充 D1，把 Worker 的全流程跑一遍：
 *      建任务 → 设到期日 → 配置渠道 → 立即检查 → 断言「请求真的发出去了」
 *
 * 所有渠道都用注入的假 fetch 拦截，断言 URL / 请求头 / 请求体，
 * 这样既不联网，也能验证 12 个渠道各自拼的报文是否正确。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import worker from '../src/index.js';
import { createD1 } from './d1-shim.mjs';
import {
  CHANNELS,
  CHANNEL_FIELDS,
  CHANNEL_LABELS,
  normalizeNotifyConfig,
  maskNotifyConfig,
  buildMessage,
  humanizeDays,
  daysBetween,
  offsetDay,
  todayInZone,
  clockInZone,
  splitList,
  feishuSign,
  sendOne,
  describeRequest,
} from '../src/lib/notify.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

/* ============================================================
 * 0. 公共工具
 * ============================================================ */

/** 假 fetch：把每次请求记下来，并按渠道返回「业务成功」的报文 */
function installFetchMock() {
  const calls = [];
  const original = globalThis.fetch;

  globalThis.fetch = async (url, init = {}) => {
    const target = String(url);
    const headers = {};
    const rawHeaders = init.headers || {};
    for (const [k, v] of Object.entries(rawHeaders)) headers[k.toLowerCase()] = v;
    // AbortSignal 触发时按超时处理
    if (init.signal?.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' });

    calls.push({
      url: target,
      method: (init.method || 'GET').toUpperCase(),
      headers,
      body: init.body,
      json: (() => {
        try { return JSON.parse(init.body); } catch { return null; }
      })(),
      form: typeof init.body === 'string' && headers['content-type']?.includes('form-urlencoded')
        ? Object.fromEntries(new URLSearchParams(init.body))
        : null,
    });

    // 按渠道返回形状正确的成功响应
    const okBody = (() => {
      if (target.includes('api.day.app') || target.includes('/push')) return { code: 200, message: 'success' };
      if (target.includes('wxpusher')) return { code: 1000, msg: '处理成功' };
      if (target.includes('sctapi.ftqq.com') || target.includes('push.ft07.com')) return { code: 0, message: 'ok' };
      if (target.includes('pushplus')) return { code: 200, msg: '请求成功' };
      if (target.includes('api.telegram.org')) return { ok: true, result: { message_id: 1 } };
      if (target.includes('feishu')) return { code: 0, msg: 'success' };
      if (target.includes('qyapi.weixin.qq.com')) return { errcode: 0, errmsg: 'ok' };
      if (target.includes('/message?token=')) return { id: 1, errorCode: 0 };
      if (target.includes('api.resend.com')) return { id: 'email_1' };
      if (target.includes('ntfy')) return { id: 'ntfy_1' };
      return { ok: true };
    })();

    return new Response(JSON.stringify(okBody), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };

  return {
    calls,
    restore() { globalThis.fetch = original; },
    last() { return calls[calls.length - 1]; },
    byHost(part) { return calls.filter((c) => c.url.includes(part)); },
  };
}

function makeEnv() {
  const db = createD1(':memory:');
  db._raw.exec(readFileSync(join(ROOT, 'schema.sql'), 'utf8'));
  const env = { DB: db, APP_NAME: '今日待办', ALLOW_REGISTRATION: 'true' };
  const ctx = { waitUntil: () => {}, passThroughOnException() {} };
  return { env, ctx, db };
}

function makeClient(env, ctx) {
  let cookie = '';
  return {
    async call(method, path, body, extraHeaders) {
      const headers = { 'x-tz': TZ };
      if (body !== undefined) headers['content-type'] = 'application/json';
      if (cookie) headers.cookie = cookie;
      Object.assign(headers, extraHeaders || {});
      const res = await worker.fetch(
        new Request(`https://todo.example.com${path}`, {
          method,
          headers,
          body: body === undefined ? undefined : JSON.stringify(body),
        }),
        env,
        ctx,
      );
      const setCookie = res.headers.get('set-cookie');
      if (setCookie) cookie = setCookie.split(';')[0];
      const text = await res.text();
      let data = null;
      try { data = JSON.parse(text); } catch { /* 非 JSON */ }
      return { status: res.status, data, text };
    },
  };
}

/** 本地日期字符串，偏移 delta 天（按系统时区，用 UTC 日号做天数加减，避免夏令时漂移） */
function localDate(delta = 0, tz) {
  const now = new Date();
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric', month: '2-digit', day: '2-digit',
  });
  const base = fmt.format(now);
  if (!delta) return base;
  const [y, m, d] = base.split('-').map(Number);
  const shifted = new Date(Date.UTC(y, m - 1, d) + delta * 86400000);
  const p = (n) => String(n).padStart(2, '0');
  return `${shifted.getUTCFullYear()}-${p(shifted.getUTCMonth() + 1)}-${p(shifted.getUTCDate())}`;
}

/** 测试默认时区：跟通知模块计算「今天」的方式保持一致 */
const TZ = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';

/* ============================================================
 * A. 纯函数层
 * ============================================================ */

test('渠道清单齐全：主流推送方式都在（含 bark/gotify/wxpusher/邮件/telegram/微信/飞书/企业微信/webhook/server酱）', () => {
  const required = [
    'bark', 'gotify', 'wxpusher', 'email', 'telegram',
    'wechat', 'feishu', 'wecom', 'webhook', 'serverchan',
  ];
  for (const c of required) {
    assert.ok(CHANNELS.includes(c), `缺少渠道 ${c}`);
    assert.ok(CHANNEL_FIELDS[c]?.fields?.length, `渠道 ${c} 没有字段定义`);
  }
  // 另外还额外支持了 pushplus 与 ntfy
  assert.ok(CHANNELS.includes('pushplus'));
  assert.ok(CHANNELS.includes('ntfy'));
});

test('演示模式用的 public/notify-channels.json 与后端定义一致（Git 部署不能漏传/过期）', () => {
  const file = join(ROOT, 'public/notify-channels.json');
  assert.ok(existsSync(file), 'public/notify-channels.json 不存在，请执行 npm run gen:catalog');
  const onDisk = JSON.parse(readFileSync(file, 'utf8'));

  assert.deepEqual(
    onDisk.map((c) => c.id),
    CHANNELS.slice(),
    '渠道清单与后端不一致，请重新执行 npm run gen:catalog',
  );
  for (const entry of onDisk) {
    const spec = CHANNEL_FIELDS[entry.id];
    assert.equal(entry.label, CHANNEL_LABELS[entry.id], `${entry.id} 中文名不一致`);
    assert.deepEqual(
      entry.fields.map((f) => f.key),
      spec.fields.map((f) => f.key),
      `${entry.id} 字段清单不一致，请重新执行 npm run gen:catalog`,
    );
    // 是否密钥字段会决定前端渲染成 password 还是 text，必须同步
    assert.deepEqual(
      entry.fields.map((f) => !!f.secret),
      spec.fields.map((f) => !!f.secret),
      `${entry.id} 密钥标记不一致，请重新执行 npm run gen:catalog`,
    );
  }
});

test('每个渠道都提供中文名与字段说明，设置页才能渲染表单', () => {
  for (const c of CHANNELS) {
    for (const f of CHANNEL_FIELDS[c].fields) {
      assert.equal(typeof f.key, 'string');
      assert.equal(typeof f.label, 'string');
      assert.ok(f.label.length > 0, `${c}.${f.key} 缺少中文标签`);
    }
  }
});

test('配置归一化：提前天数被夹到 0~365，非法值回退', () => {
  assert.equal(normalizeNotifyConfig({ leadDays: 3 }, {}).leadDays, 3);
  assert.equal(normalizeNotifyConfig({ leadDays: 0 }, {}).leadDays, 0);
  assert.equal(normalizeNotifyConfig({ leadDays: -5 }, {}).leadDays, 0);
  assert.equal(normalizeNotifyConfig({ leadDays: 9999 }, {}).leadDays, 365);
  assert.equal(normalizeNotifyConfig({ leadDays: 'abc' }, { leadDays: 7 }).leadDays, 7);
});

test('配置归一化：检查频率默认 5 分钟，夹到 5~1440', () => {
  assert.equal(normalizeNotifyConfig({}, {}).checkInterval, 5, '缺省 = 每 5 分钟');
  assert.equal(normalizeNotifyConfig({ checkInterval: 30 }, {}).checkInterval, 30);
  assert.equal(normalizeNotifyConfig({ checkInterval: 1 }, {}).checkInterval, 5, '低于 5 分钟没意义，夹回 5');
  assert.equal(normalizeNotifyConfig({ checkInterval: 9999 }, {}).checkInterval, 1440, '上限一天');
  assert.equal(normalizeNotifyConfig({ checkInterval: 'abc' }, { checkInterval: 15 }).checkInterval, 15, '非法值沿用旧值');
  assert.equal(normalizeNotifyConfig({ checkInterval: 7.6 }, {}).checkInterval, 8, '小数四舍五入');
});

test('配置归一化：未知渠道被过滤掉，时间格式非法则沿用旧值', () => {
  const cfg = normalizeNotifyConfig(
    { channels: ['bark', 'not-a-channel', 'telegram', 'telegram'], time: '25:99' },
    { time: '08:30' },
  );
  assert.deepEqual([...new Set(cfg.channels)].sort(), ['bark', 'telegram'], '未知渠道应被过滤、重复项应去重');
  assert.equal(cfg.time, '08:30');
  assert.equal(normalizeNotifyConfig({ time: '07:05' }, {}).time, '07:05');
});

test('配置归一化：密钥留空表示不修改，非密钥留空则清空', () => {
  const previous = {
    params: {
      bark: { key: 'old-key', group: '旧分组' },
      telegram: { botToken: 'old-bot', chatId: '111' },
    },
  };
  const cfg = normalizeNotifyConfig({
    channels: ['bark', 'telegram'],
    params: {
      bark: {
        key: '',            // 密钥留空 -> 沿用旧值（前端不回显密钥，留空代表「不修改」）
        group: '新分组',     // 非密钥照常覆盖
      },
      telegram: { botToken: 'new-bot' },       // 换了新 bot
    },
  }, previous);

  assert.equal(cfg.params.bark.key, 'old-key', '密钥留空应沿用旧值');
  assert.equal(cfg.params.bark.group, '新分组', '非密钥应被覆盖');
  assert.equal(cfg.params.telegram.botToken, 'new-bot');
  assert.equal(cfg.params.telegram.chatId, '111', '未提交的字段应保留');

  // 想清空某个非密钥字段：显式传空串即可（模板渲染时会被当成默认值）
  const cleared = normalizeNotifyConfig({
    params: { bark: { group: '' } },
  }, { params: { bark: { key: 'k', group: '旧分组' } } });
  assert.equal(cleared.params.bark.group, '', '非密钥字段提交空串应清空');
  assert.equal(cleared.params.bark.key, 'k', '密钥未被提交，应保留');
});

test('掩码：密钥永不回显，只给出 has_xxx 布尔标记', () => {
  const cfg = normalizeNotifyConfig({
    channels: ['bark', 'gotify'],
    params: {
      bark: { key: 'secret-key', group: 'g' },
      gotify: { server: 'https://g.example.com', token: 'secret-token' },
    },
  }, {});
  const masked = maskNotifyConfig(cfg, {});

  assert.equal(masked.params.bark.key, '', 'Bark key 不应回显');
  assert.equal(masked.params.bark.has_key, true);
  assert.equal(masked.params.bark.group, 'g', '非密钥字段正常回显');
  assert.equal(masked.params.gotify.token, '', 'Gotify token 不应回显');
  assert.equal(masked.params.gotify.has_token, true);

  // 整个返回体里不应出现任何密钥明文
  const text = JSON.stringify(masked);
  assert.ok(!text.includes('secret-key'));
  assert.ok(!text.includes('secret-token'));
  assert.ok(masked.catalog.length === CHANNELS.length, '应带上渠道目录供前端渲染');
});

test('日期计算：daysBetween / offsetDay / humanizeDays', () => {
  assert.equal(daysBetween('2026-10-16', '2026-10-16'), 0);
  assert.equal(daysBetween('2026-10-16', '2026-10-19'), 3);
  assert.equal(daysBetween('2026-10-16', '2026-10-14'), -2);
  assert.equal(daysBetween('2026-10-16', 'bad'), null);

  assert.equal(offsetDay('2026-10-16', 5), '2026-10-21');
  assert.equal(offsetDay('2026-10-31', 1), '2026-11-01');
  assert.equal(offsetDay('2026-03-01', -1), '2026-02-28');

  assert.match(humanizeDays(-2), /已过期 2 天/);
  assert.match(humanizeDays(0), /今天到期/);
  assert.match(humanizeDays(1), /明天到期/);
  assert.match(humanizeDays(3), /3 天后到期/);
});

test('时区换算：按指定时区算「今天」和「现在几点」', () => {
  // UTC 2026-10-16T23:30Z → 上海已经是 17 日凌晨，洛杉矶还是 16 日下午
  const at = new Date('2026-10-16T23:30:00Z');
  assert.equal(todayInZone('UTC', at), '2026-10-16');
  assert.equal(todayInZone('Asia/Shanghai', at), '2026-10-17');
  assert.equal(todayInZone('America/Los_Angeles', at), '2026-10-16');
  assert.equal(clockInZone('Asia/Shanghai', at), '07:30');
  assert.equal(clockInZone('UTC', at), '23:30');
  // 非法时区回退到 UTC，不抛错
  assert.equal(todayInZone('Not/AZone', at), '2026-10-16');
});

test('消息组装：按「已过期 / 今天到期 / 即将到期」分组，带标题与条数', () => {
  const msg = buildMessage([
    { title: '交房租', dueDate: '2026-10-14', days: -2 },
    { title: '开会', dueDate: '2026-10-16', days: 0 },
    { title: '买礼物', dueDate: '2026-10-18', days: 2 },
  ], { appName: '今日待办', now: new Date('2026-10-16T02:00:00Z'), timeZone: 'Asia/Shanghai' });

  assert.equal(msg.count, 3);
  assert.equal(msg.overdue, 1);
  assert.equal(msg.due, 1);
  assert.equal(msg.soon, 1);
  assert.match(msg.text, /已过期（1）/);
  assert.match(msg.text, /今天到期（1）/);
  assert.match(msg.text, /即将到期（1）/);
  assert.match(msg.text, /交房租/);
  assert.match(msg.text, /已过期 2 天/);
});

test('消息组装：单条任务时标题直接带任务名', () => {
  const msg = buildMessage([{ title: '给妈妈打电话', dueDate: '2026-10-16', days: 0 }], {
    now: new Date('2026-10-16T02:00:00Z'), timeZone: 'Asia/Shanghai',
  });
  assert.match(msg.title, /给妈妈打电话/);
});

test('消息组装：超长标题被截断，避免推送内容爆掉', () => {
  const long = '很长的任务'.repeat(30);
  const msg = buildMessage([{ title: long, dueDate: '2026-10-16', days: 0 }], {});
  assert.ok(msg.text.includes('…'), '应出现截断省略号');
  assert.ok(msg.text.length < 400);
});

test('列表解析：逗号 / 空格 / 换行 / 中文顿号都能拆开', () => {
  assert.deepEqual(splitList('a,b;c d\ne，f、g'), ['a', 'b', 'c', 'd', 'e', 'f', 'g']);
  assert.deepEqual(splitList(''), []);
  assert.deepEqual(splitList(undefined), []);
});

test('飞书签名：同样的时间戳与密钥产生稳定的 base64 签名', async () => {
  const a = await feishuSign('my-secret', 1750000000);
  const b = await feishuSign('my-secret', 1750000000);
  const c = await feishuSign('my-secret', 1750000001);
  assert.equal(a, b, '相同输入应得到相同签名');
  assert.notEqual(a, c, '时间戳不同签名应不同');
  assert.match(a, /^[A-Za-z0-9+/]+=*$/, '应是 base64');
});

/* ============================================================
 * B. 各渠道报文正确性（直接调 sendOne，逐个断言）
 * ============================================================ */

const SAMPLE = buildMessage([{ title: '交房租', dueDate: '2026-10-19', days: 3 }], {
  appName: '今日待办', now: new Date('2026-10-16T02:00:00Z'), timeZone: 'Asia/Shanghai',
});

test('Bark Key 失效自动自救：服务器报未知 device token 时，用地址路径里的 Key 重试一次', async () => {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body) });
    const key = JSON.parse(init.body).device_key;
    if (key === 'staleKey0001') {
      return new Response(JSON.stringify({
        code: 400, message: 'failed to get device token: failed to get [staleKey0001] device token from database',
      }), { status: 400, headers: { 'content-type': 'application/json' } });
    }
    return new Response(JSON.stringify({ code: 200, message: 'success' }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  try {
    // 已保存的 Key 失效，但服务器地址路径里带着 App 复制的正确 Key → 自动重试成功
    const r = await sendOne(
      'bark',
      { server: 'https://api.day.app/goodKey9999', key: 'staleKey0001' },
      SAMPLE,
      {},
    );
    assert.equal(r.channel, 'bark');
    assert.equal(calls.length, 2, '应发起两次请求（失效一次 + 重试一次）');
    assert.equal(calls[1].url, 'https://api.day.app/push');
    assert.equal(calls[1].body.device_key, 'goodKey9999', '重试应使用路径段里的 Key');

    // 没有路径 Key 可重试时，报错要直接告诉用户怎么改
    calls.length = 0;
    await assert.rejects(
      () => sendOne('bark', { server: 'https://api.day.app', key: 'staleKey0001' }, SAMPLE, {}),
      /请把 Bark App 首页复制的 Key/,
    );
  } finally {
    globalThis.fetch = original;
  }
});

test('Bark 自检回显：说明真实请求，且绝不泄漏完整密钥', () => {
  const req = describeRequest('bark', { server: 'https://bark.example.com/', key: 'abcdef123456' }, {});
  assert.equal(req.method, 'POST');
  assert.equal(req.url, 'https://bark.example.com/push', '尾部斜杠应去掉');
  assert.deepEqual(req.bodyKeys, ['device_key', 'title', 'body', 'group']);
  assert.equal(req.deviceKeyTail, '…3456', '只回显尾 4 位');
  assert.ok(!JSON.stringify(req).includes('abcdef123456'), '完整密钥不能出现在回显里');

  // 未配置时不炸，且标出未配置
  assert.equal(describeRequest('bark', {}, {}).deviceKeyTail, '(未配置)');
  // 非 bark 渠道没有这层回显
  assert.equal(describeRequest('gotify', {}, {}), null);
});

test('Bark：POST /push，Device Key 按 官方格式 放 JSON body（device_key 字段）', async () => {
  const m = installFetchMock();
  try {
    await sendOne('bark', { key: 'bk123', group: '工作', sound: 'bell' }, SAMPLE, {});
    const call = m.last();
    assert.equal(call.method, 'POST');
    assert.equal(call.url, 'https://api.day.app/push');
    assert.equal(call.json.device_key, 'bk123', 'Device Key 应按官方 API 放 JSON body（部分服务器不认 x-bark-key 头，会把 URL 路径当正文）');
    assert.ok(!call.headers['x-bark-key'], '不再使用非官方请求头');
    assert.equal(call.json.group, '工作');
    assert.equal(call.json.sound, 'bell');
    assert.match(call.json.body, /交房租/);
    assert.match(call.json.title, /待办提醒/);
    // 自建服务器
    await sendOne('bark', { server: 'https://bark.example.com/', key: 'k' }, SAMPLE, {});
    assert.equal(m.last().url, 'https://bark.example.com/push', '自定义服务器应生效且去掉尾部斜杠');

    // 常见误填：把 App 里复制的完整推送 URL（带 key 的路径）当服务器地址——
    // 应剥出路径段当 key、打到站点根 /push，而不是 /<key>/push（那会让正文变成 "push"）
    await sendOne('bark', { server: 'https://api.day.app/HCq3XxjZl4uCLnItSpLE7', key: 'realKey8899' }, SAMPLE, {});
    assert.equal(m.last().url, 'https://api.day.app/push', '路径里混入的 key 应被剥掉');
    assert.equal(m.last().json.device_key, 'realKey8899', '优先用 Device Key 字段里的值');

    // Device Key 留空时，路径段可作为兜底 key
    await sendOne('bark', { server: 'https://api.day.app/pathKey777' }, SAMPLE, {});
    assert.equal(m.last().url, 'https://api.day.app/push');
    assert.equal(m.last().json.device_key, 'pathKey777', '路径段应作为 key 兜底');
  } finally { m.restore(); }
});

test('Gotify：POST /message?token=，带优先级', async () => {
  const m = installFetchMock();
  try {
    await sendOne('gotify', { server: 'https://gotify.example.com', token: 'gt', priority: 8 }, SAMPLE, {});
    const call = m.last();
    assert.equal(call.url, 'https://gotify.example.com/message?token=gt');
    assert.equal(call.json.priority, 8);
    assert.match(call.json.message, /交房租/);
  } finally { m.restore(); }
});

test('WxPusher：POST /api/send/message，内容转 HTML、UID 拆成数组', async () => {
  const m = installFetchMock();
  try {
    await sendOne('wxpusher', { appToken: 'AT_x', uids: 'UID_a,UID_b', topicIds: '1,2' }, SAMPLE, {});
    const call = m.last();
    assert.equal(call.url, 'https://wxpusher.zjiecode.com/api/send/message');
    assert.equal(call.json.appToken, 'AT_x');
    assert.deepEqual(call.json.uids, ['UID_a', 'UID_b']);
    assert.deepEqual(call.json.topicIds, [1, 2]);
    assert.equal(call.json.contentType, 2, 'HTML 模式才能显示换行');
    assert.match(call.json.content, /<br\/>/, '换行应转成 <br/>');
  } finally { m.restore(); }
});

test('WxPusher：既没 UID 也没主题时给出可照做的报错', async () => {
  const m = installFetchMock();
  try {
    await assert.rejects(
      () => sendOne('wxpusher', { appToken: 'AT_x' }, SAMPLE, {}),
      /UID 或主题 ID/,
    );
  } finally { m.restore(); }
});

test('邮件：走 Resend HTTP API，收件人支持多人', async () => {
  const m = installFetchMock();
  try {
    await sendOne('email', { apiKey: 're_123', from: '提醒 <a@b.com>', to: 'x@y.com, z@w.com' }, SAMPLE, {});
    const call = m.last();
    assert.equal(call.url, 'https://api.resend.com/emails');
    assert.equal(call.headers.authorization, 'Bearer re_123');
    assert.deepEqual(call.json.to, ['x@y.com', 'z@w.com']);
    assert.match(call.json.subject, /待办/);
    assert.match(call.json.text, /交房租/);
  } finally { m.restore(); }
});

test('Telegram：POST /bot<token>/sendMessage，用 MarkdownV2 并转义特殊字符', async () => {
  const m = installFetchMock();
  try {
    await sendOne('telegram', { botToken: '123:ABC', chatId: '-100123', threadId: '9' }, SAMPLE, {});
    const call = m.last();
    assert.equal(call.url, 'https://api.telegram.org/bot123:ABC/sendMessage');
    assert.equal(call.json.chat_id, '-100123');
    assert.equal(call.json.parse_mode, 'MarkdownV2');
    assert.equal(call.json.message_thread_id, 9);
    // 「【今日待办】2026-10-17」里的 - 与 . 都被转义
    assert.match(call.json.text, /\\-/, 'MarkdownV2 需要转义连字符');
    assert.match(call.json.text, /交房租/);
  } finally { m.restore(); }
});

test('Telegram：HTTP 200 但 ok=false 也要报错（上游业务失败不能当成功）', async () => {
  const m = installFetchMock();
  const original = globalThis.fetch;
  let restored = false;
  try {
    globalThis.fetch = async () => new Response(
      JSON.stringify({ ok: false, description: 'chat not found' }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
    await assert.rejects(
      () => sendOne('telegram', { botToken: 't', chatId: '1' }, SAMPLE, {}),
      (err) => {
        assert.match(err.message, /Telegram 返回失败/);
        assert.match(err.message, /chat not found/, '应带上上游给的原因');
        return true;
      },
    );
  } finally {
    globalThis.fetch = original;
    if (!restored) m.restore();
  }
});

test('微信机器人：可自定义文本字段名与请求体模板', async () => {
  const m = installFetchMock();
  try {
    // 默认字段 text
    await sendOne('wechat', { url: 'https://bot.example.com/hook' }, SAMPLE, {});
    assert.match(m.last().json.text, /交房租/);

    // 自定义字段名 content（有些自建机器人这么要求）
    await sendOne('wechat', { url: 'https://bot.example.com/hook', field: 'content' }, SAMPLE, {});
    assert.ok(m.last().json.content, '自定义字段名应生效');

    // 自定义模板 + Bearer token
    await sendOne('wechat', {
      url: 'https://bot.example.com/hook',
      token: 'my-token',
      template: '{"msg_type":"text","content":{"text":"{title}|{count}"}}',
    }, SAMPLE, {});
    const last = m.last();
    assert.equal(last.headers.authorization, 'Bearer my-token');
    assert.equal(last.json.msg_type, 'text');
    assert.match(last.json.content.text, /待办/);
  } finally { m.restore(); }
});

test('飞书：msg_type=text 与 post 两种形态，带签名时附 timestamp/sign', async () => {
  const m = installFetchMock();
  try {
    await sendOne('feishu', { url: 'https://open.feishu.cn/open-apis/bot/v2/hook/abc' }, SAMPLE, {});
    assert.equal(m.last().json.msg_type, 'text');
    assert.match(m.last().json.content.text, /交房租/);

    await sendOne('feishu', { url: 'https://open.feishu.cn/open-apis/bot/v2/hook/abc', msgType: 'post' }, SAMPLE, {});
    assert.equal(m.last().json.msg_type, 'post');
    assert.ok(Array.isArray(m.last().json.content.post.zh_cn.content), 'post 形态是二维数组');

    await sendOne('feishu', { url: 'https://open.feishu.cn/open-apis/bot/v2/hook/abc', secret: 's' }, SAMPLE, {});
    assert.ok(m.last().json.timestamp, '开启签名校验时必须带 timestamp');
    assert.match(m.last().json.sign, /^[A-Za-z0-9+/]+=*$/);
  } finally { m.restore(); }
});

test('企业微信：默认 markdown，可切 text；errcode != 0 视为失败', async () => {
  const m = installFetchMock();
  try {
    await sendOne('wecom', { url: 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=x' }, SAMPLE, {});
    assert.equal(m.last().json.msgtype, 'markdown');
    assert.match(m.last().json.markdown.content, /\*\*/);

    await sendOne('wecom', { url: 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=x', msgType: 'text' }, SAMPLE, {});
    assert.equal(m.last().json.msgtype, 'text');
  } finally { m.restore(); }

  // 业务码非 0
  const original = globalThis.fetch;
  globalThis.fetch = async () => new Response(
    JSON.stringify({ errcode: 93000, errmsg: 'invalid webhook url' }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );
  try {
    await assert.rejects(
      () => sendOne('wecom', { url: 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=x' }, SAMPLE, {}),
      (err) => {
        assert.match(err.message, /企业微信 返回失败/);
        assert.match(err.message, /invalid webhook url/, '应优先展示 errmsg 而不是错误码');
        return true;
      },
    );
  } finally { globalThis.fetch = original; }
});

test('通用 Webhook：默认 POST JSON，支持自定义方法/请求头/模板', async () => {
  const m = installFetchMock();
  try {
    await sendOne('webhook', { url: 'https://hook.example.com/a' }, SAMPLE, {});
    assert.equal(m.last().method, 'POST');
    assert.match(m.last().json.text, /交房租/);
    assert.equal(m.last().json.items, undefined, '默认请求体不带 items，只有模板里写了 {items} 才带');

    await sendOne('webhook', {
      url: 'https://hook.example.com/b',
      method: 'PUT',
      contentType: 'application/json',
      headers: '{"Authorization":"Bearer abc","X-Trace":"1"}',
      template: '{"msg":"{title}","n":{count}}',
    }, { ...SAMPLE, count: 2 }, {});
    const last = m.last();
    assert.equal(last.method, 'PUT');
    assert.equal(last.headers.authorization, 'Bearer abc');
    assert.equal(last.headers['x-trace'], '1');
    assert.equal(last.json.n, 2, '模板里的 {count} 应被替换成数字');
  } finally { m.restore(); }
});

test('Server 酱：按 key 前缀自动选择 sctapi 或 push.ft07 端点，用表单提交', async () => {
  const m = installFetchMock();
  try {
    await sendOne('serverchan', { sendKey: 'SCT123abc' }, SAMPLE, {});
    assert.equal(m.last().url, 'https://sctapi.ftqq.com/SCT123abc.send');
    assert.equal(m.last().form.title, SAMPLE.title);
    assert.match(m.last().form.desp, /交房租/);

    await sendOne('serverchan', { sendKey: 'sctp123txxx', channel: '9' }, SAMPLE, {});
    assert.equal(m.last().url, 'https://sctp123txxx.push.ft07.com/send');
    assert.equal(m.last().form.channel, '9');
  } finally { m.restore(); }
});

test('Server 酱：code != 0 视为失败并带上原因', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => new Response(
    JSON.stringify({ code: 40001, message: 'bad pushtoken' }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );
  try {
    await assert.rejects(
      () => sendOne('serverchan', { sendKey: 'SCTbad' }, SAMPLE, {}),
      /bad pushtoken/,
    );
  } finally { globalThis.fetch = original; }
});

test('PushPlus：POST /send，支持群组与模板', async () => {
  const m = installFetchMock();
  try {
    await sendOne('pushplus', { token: 'pp', topic: 'group1', template: 'markdown' }, SAMPLE, {});
    const call = m.last();
    assert.equal(call.url, 'https://www.pushplus.plus/send');
    assert.equal(call.json.token, 'pp');
    assert.equal(call.json.topic, 'group1');
    assert.equal(call.json.template, 'markdown');
  } finally { m.restore(); }
});

test('ntfy：POST /<topic>，标题走 header，中文标题自动编码', async () => {
  const m = installFetchMock();
  try {
    await sendOne('ntfy', { server: 'https://ntfy.sh', topic: 'my-topic', priority: 5 }, SAMPLE, {});
    const call = m.last();
    assert.equal(call.url, 'https://ntfy.sh/my-topic');
    assert.equal(call.headers.priority, '5');
    assert.ok(call.headers.title, '标题应放 header');
    assert.ok(!/[\u4e00-\u9fa5]/.test(call.headers.title), 'HTTP 头不能直接带中文，应被编码');
    assert.match(call.body, /交房租/, '正文走 body');

    await sendOne('ntfy', { server: 'https://ntfy.example.com', topic: 't', token: 'tk_1' }, SAMPLE, {});
    assert.equal(m.last().headers.authorization, 'Bearer tk_1');
  } finally { m.restore(); }
});

test('所有渠道：必填项缺失时给出「中文 + 字段名」的报错，而不是 undefined', async () => {
  const m = installFetchMock();
  const cases = [
    ['bark', {}, /Device Key/],
    ['gotify', {}, /完整地址|服务器地址/],
    ['email', {}, /Resend API Key/],
    ['telegram', {}, /Bot Token/],
    ['wechat', {}, /完整地址|Webhook 地址/],
    ['feishu', {}, /完整地址|Webhook 地址/],
    ['wecom', {}, /完整地址|Webhook 地址/],
    ['webhook', {}, /完整地址|地址/],
    ['serverchan', {}, /SendKey/],
    ['pushplus', {}, /Token/],
    ['ntfy', {}, /主题/],
  ];
  try {
    for (const [channel, params, pattern] of cases) {
      await assert.rejects(
        () => sendOne(channel, params, SAMPLE, {}),
        pattern,
        `${channel} 应提示缺少必填项`,
      );
    }
  } finally { m.restore(); }
});

test('地址校验：只接受 http/https，拒绝 javascript: / file: 之类协议', async () => {
  const m = installFetchMock();
  try {
    for (const bad of ['javascript:alert(1)', 'file:///etc/passwd', 'not-a-url']) {
      await assert.rejects(
        () => sendOne('webhook', { url: bad }, SAMPLE, {}),
        /地址/,
        `${bad} 应被拒绝`,
      );
    }
  } finally { m.restore(); }
});

test('环境变量兜底：配置里没填密钥时用 Worker 密钥', async () => {
  const m = installFetchMock();
  try {
    await sendOne('bark', {}, SAMPLE, { NOTIFY_BARK_KEY: 'env-key' });
    assert.equal(m.last().json.device_key, 'env-key');

    await sendOne('telegram', { chatId: '1' }, SAMPLE, { NOTIFY_TELEGRAM_BOT_TOKEN: 'env-bot' });
    assert.match(m.last().url, /botenv-bot/);
  } finally { m.restore(); }
});

/* ============================================================
 * C. 端到端：Worker 全流程
 * ============================================================ */

test('接口：未登录访问通知配置应 401（不泄漏任何配置）', async () => {
  const { env, ctx } = makeEnv();
  const anon = makeClient(env, ctx);
  assert.equal((await anon.call('GET', '/api/notify/config')).status, 401);
  assert.equal((await anon.call('PUT', '/api/notify/config', {})).status, 401);
  assert.equal((await anon.call('POST', '/api/notify/test', { channel: 'bark' })).status, 401);
  assert.equal((await anon.call('POST', '/api/notify/run')).status, 401);
});

test('接口：首次读取配置会自动建表，并返回渠道目录', async () => {
  const { env, ctx, db } = makeEnv();
  // 故意用一份没有 notifications 表的老 schema
  db._raw.exec('DROP TABLE IF EXISTS notify_log; DROP TABLE IF EXISTS notifications;');

  const c = makeClient(env, ctx);
  await c.call('POST', '/api/auth/register', { username: 'notify1', password: 'secret123' });
  const res = await c.call('GET', '/api/notify/config');

  assert.equal(res.status, 200, '表不存在时也应能用，接口会自动补建');
  assert.equal(res.data.config.enabled, false);
  assert.equal(res.data.config.catalog.length, CHANNELS.length);
  const tables = db._raw
    .prepare("SELECT name FROM sqlite_master WHERE type='table'")
    .all()
    .map((r) => r.name);
  assert.ok(tables.includes('notifications'), '应自动建出 notifications 表');
  assert.ok(tables.includes('notify_log'), '应自动建出 notify_log 表');
});

test('接口：保存配置后密钥不回显，再次读取仍为「已配置」', async () => {
  const { env, ctx } = makeEnv();
  const c = makeClient(env, ctx);
  await c.call('POST', '/api/auth/register', { username: 'notify2', password: 'secret123' });

  const saved = await c.call('PUT', '/api/notify/config', {
    enabled: true,
    channels: ['bark'],
    leadDays: 3,
    params: { bark: { key: 'super-secret-key' } },
  });
  assert.equal(saved.status, 200);
  assert.equal(saved.data.config.leadDays, 3);
  assert.equal(saved.data.config.params.bark.key, '', '密钥绝不能回显');
  assert.equal(saved.data.config.params.bark.has_key, true);
  assert.ok(!saved.text.includes('super-secret-key'), '响应体里不应出现密钥明文');

  const again = await c.call('GET', '/api/notify/config');
  assert.equal(again.data.config.enabled, true);
  assert.equal(again.data.config.params.bark.has_key, true);
  assert.ok(!again.text.includes('super-secret-key'));

  // 直接查库确认真的落盘了
  const row = (await env.DB.prepare('SELECT notify_json FROM notifications WHERE user_id = (SELECT id FROM users WHERE username = ?)').bind('notify2').first());
  assert.match(row.notify_json, /super-secret-key/);
});

test('到期日：新增任务可带 dueDate，改期可清空，非法格式被拒', async () => {
  const { env, ctx } = makeEnv();
  const c = makeClient(env, ctx);
  await c.call('POST', '/api/auth/register', { username: 'due1', password: 'secret123' });

  const created = await c.call('POST', '/api/todos', { title: '交房租', date: localDate(), dueDate: localDate(5) });
  assert.equal(created.status, 201);
  assert.equal(created.data.todo.dueDate, localDate(5));

  // 列表里也要带上
  const list = await c.call('GET', `/api/todos?date=${localDate()}`);
  assert.equal(list.data.todos[0].dueDate, localDate(5));

  // 改期
  const moved = await c.call('PATCH', `/api/todos/${created.data.todo.id}`, { dueDate: localDate(9) });
  assert.equal(moved.data.todo.dueDate, localDate(9));

  // 清空（传空串 -> null）
  const cleared = await c.call('PATCH', `/api/todos/${created.data.todo.id}`, { dueDate: '' });
  assert.equal(cleared.data.todo.dueDate, null);

  // 非法格式
  assert.equal((await c.call('PATCH', `/api/todos/${created.data.todo.id}`, { dueDate: '2026/10/16' })).status, 400);
  assert.equal((await c.call('POST', '/api/todos', { title: 'x', date: localDate(), dueDate: '不是日期' })).status, 400);
});

test('端到端：设了到期日的任务，到点后「立即检查」会把消息发到所有启用的渠道', async () => {
  const { env, ctx } = makeEnv();
  const c = makeClient(env, ctx);
  await c.call('POST', '/api/auth/register', { username: 'e2e1', password: 'secret123' });

  // 提前 2 天提醒，两条渠道
  await c.call('PUT', '/api/notify/config', {
    enabled: true,
    channels: ['bark', 'wecom'],
    leadDays: 2,
    time: '00:00',
    params: {
      bark: { key: 'bk-e2e' },
      wecom: { url: 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=e2e' },
    },
  });

  // 明天到期（在 2 天窗口内）、10 天后到期（窗口外）、
  // 显式不要到期日（dueDate 传空串）、以及不传 dueDate（默认等于所属日期 = 今天，也在窗口内）
  await c.call('POST', '/api/todos', { title: '明天要交的活', date: localDate(), dueDate: localDate(1) });
  await c.call('POST', '/api/todos', { title: '很久以后', date: localDate(), dueDate: localDate(10) });
  await c.call('POST', '/api/todos', { title: '不要到期日', date: localDate(), dueDate: '' });
  const auto = await c.call('POST', '/api/todos', { title: '不传到期的活', date: localDate() });
  assert.equal(auto.data.todo.dueDate, localDate(), '不传 dueDate 时到期日应默认等于所属日期');

  const m = installFetchMock();
  try {
    const run = await c.call('POST', '/api/notify/run');
    assert.equal(run.status, 200);
    assert.equal(run.data.report.due, 2, '窗口内应有 2 条：明天到期的 + 默认今天到期的');
    assert.equal(run.data.report.sent, 2, '同一渠道的多条任务合并成一条消息，两个渠道各推一次');

    const bark = m.byHost('api.day.app');
    const wecom = m.byHost('qyapi.weixin.qq.com');
    assert.equal(bark.length, 1);
    assert.equal(wecom.length, 1);
    const bodies = bark.map((r) => r.json.body).join('\n');
    assert.match(bodies, /明天要交的活/);
    assert.match(bodies, /不传到期的活/, '默认到期日 = 所属日期，也应被提醒');
    assert.ok(!bodies.includes('很久以后'), '窗口外的任务不应出现');
    assert.ok(!bodies.includes('不要到期日'), '显式清空到期日的任务不应出现');
    assert.match(bodies, /明天到期/);
  } finally { m.restore(); }
});

test('去重：dailyRepeat=false 时同一条任务同一到期日只推一次，再点「立即检查」不重复打扰', async () => {
  const { env, ctx } = makeEnv();
  const c = makeClient(env, ctx);
  await c.call('POST', '/api/auth/register', { username: 'dedupe1', password: 'secret123' });
  await c.call('PUT', '/api/notify/config', {
    enabled: true, channels: ['bark'], leadDays: 1, time: '00:00', dailyRepeat: false,
    params: { bark: { key: 'k' } },
  });
  await c.call('POST', '/api/todos', { title: '只提醒一次', date: localDate(), dueDate: localDate(1) });

  const m = installFetchMock();
  try {
    const first = await c.call('POST', '/api/notify/run');
    assert.equal(first.data.report.sent, 1);
    assert.equal(m.calls.length, 1);

    const second = await c.call('POST', '/api/notify/run');
    assert.equal(second.data.report.sent, 0, '已推过就不该再推');
    assert.equal(m.calls.length, 1, '不应发出第二次请求');
    assert.match(second.data.message, /已推送过/);

    // 改期后 due_date 变了 -> 应该重新推
    const list = await c.call('GET', `/api/todos?date=${localDate()}`);
    await c.call('PATCH', `/api/todos/${list.data.todos[0].id}`, { dueDate: localDate(0) });
    const third = await c.call('POST', '/api/notify/run');
    assert.equal(third.data.report.sent, 1, '改期后应重新提醒');
    assert.equal(m.calls.length, 2);
  } finally { m.restore(); }
});

test('去重：发送失败不写成功日志，下一轮会重试', async () => {
  const { env, ctx } = makeEnv();
  const c = makeClient(env, ctx);
  await c.call('POST', '/api/auth/register', { username: 'retry1', password: 'secret123' });
  await c.call('PUT', '/api/notify/config', {
    enabled: true, channels: ['bark'], leadDays: 1, time: '00:00',
    params: { bark: { key: 'k' } },
  });
  await c.call('POST', '/api/todos', { title: '会重试的任务', date: localDate(), dueDate: localDate(1) });

  const original = globalThis.fetch;

  // 第一轮：上游 500，推送失败
  globalThis.fetch = async () => new Response('boom', { status: 500 });
  const failed = await c.call('POST', '/api/notify/run');
  assert.equal(failed.data.report.sent, 0);
  assert.equal(failed.data.report.failed.length, 1);
  assert.match(failed.data.report.failed[0].error, /500/);

  // 第二轮：上游恢复 -> 应该重试成功（关键：失败时没有写 ok=1 的日志）
  const m = installFetchMock();
  try {
    const retried = await c.call('POST', '/api/notify/run');
    assert.equal(retried.data.report.sent, 1, '上一轮失败，这一轮应重试');
    assert.equal(m.calls.length, 1, '成功那次只发一次请求');
  } finally {
    m.restore();
    globalThis.fetch = original;
  }
});

test('每日提醒开关：dailyRepeat=true 时，同一条任务每天都会推一次', async () => {
  const { env, ctx, db } = makeEnv();
  const c = makeClient(env, ctx);
  await c.call('POST', '/api/auth/register', { username: 'daily1', password: 'secret123' });
  await c.call('PUT', '/api/notify/config', {
    enabled: true, channels: ['bark'], leadDays: 3, dailyRepeat: true, time: '00:00',
    params: { bark: { key: 'k' } },
  });
  await c.call('POST', '/api/todos', { title: '每天提醒我', date: localDate(), dueDate: localDate(3) });

  const m = installFetchMock();
  try {
    const r1 = await c.call('POST', '/api/notify/run');
    assert.equal(r1.data.report.sent, 1);

    // 模拟「已经是第二天」：把上次推送记录的时间挪到昨天
    const userId = db._raw.prepare("SELECT id FROM users WHERE username = 'daily1'").get().id;
    const yesterday = Math.floor(Date.now() / 1000) - 86400;
    db._raw.prepare('UPDATE notify_log SET sent_at = ? WHERE user_id = ?').run(yesterday, userId);

    const r2 = await c.call('POST', '/api/notify/run');
    assert.equal(r2.data.report.sent, 1, 'dailyRepeat 下第二天应再次提醒');
    assert.equal(m.calls.length, 2);

    // 同一天里再跑一次仍然不重复
    const r3 = await c.call('POST', '/api/notify/run');
    assert.equal(r3.data.report.sent, 0, '同一天内不重复推');
    assert.equal(m.calls.length, 2);
  } finally { m.restore(); }
});

test('默认每天提醒：提前 N 天设置下，N/N-1/…/1 天内每天都会提醒（用户报告的主 bug）', async () => {
  const { env, ctx, db } = makeEnv();
  const c = makeClient(env, ctx);
  await c.call('POST', '/api/auth/register', { username: 'dailydef1', password: 'secret123' });
  // 不传 dailyRepeat -> v2 起默认每天提醒
  await c.call('PUT', '/api/notify/config', {
    enabled: true, channels: ['bark'], leadDays: 5, time: '00:00',
    params: { bark: { key: 'k' } },
  });
  await c.call('POST', '/api/todos', { title: '五天后到期', date: localDate(), dueDate: localDate(5) });

  const m = installFetchMock();
  try {
    // 第 5 天：进窗口第一轮，推送
    const r1 = await c.call('POST', '/api/notify/run');
    assert.equal(r1.data.report.sent, 1, '第 5 天（进窗口）应推送');
    assert.equal(m.calls.length, 1);

    const userId = db._raw.prepare("SELECT id FROM users WHERE username = 'dailydef1'").get().id;
    // 依次把推送记录拨回「昨天」，模拟过了 4/3/2/1 天，每天都要再提醒
    for (let i = 0; i < 4; i += 1) {
      const yesterday = Math.floor(Date.now() / 1000) - 86400;
      db._raw.prepare('UPDATE notify_log SET sent_at = ? WHERE user_id = ?').run(yesterday, userId);
      const r = await c.call('POST', '/api/notify/run');
      assert.equal(r.data.report.sent, 1, `窗口内第 ${4 - i} 次检查（提前 ${4 - i} 天）也应提醒`);
      assert.equal(m.calls.length, 2 + i, '每天都应发出一次请求');
    }
  } finally { m.restore(); }
});

test('v1 配置迁移：老库存的 dailyRepeat=false（旧默认）自动升级为每天提醒', async () => {
  const { env, ctx, db } = makeEnv();
  const c = makeClient(env, ctx);
  await c.call('POST', '/api/auth/register', { username: 'migr1', password: 'secret123' });
  await c.call('PUT', '/api/notify/config', {
    enabled: true, channels: ['bark'], leadDays: 5, time: '00:00',
    params: { bark: { key: 'k' } },
  });
  // 手工把存储降级成 v1 形态：version=1、dailyRepeat=false（v1 时代的默认值）
  const userId = db._raw.prepare("SELECT id FROM users WHERE username = 'migr1'").get().id;
  const row = db._raw.prepare('SELECT notify_json FROM notifications WHERE user_id = ?').get(userId);
  const v1 = { ...JSON.parse(row.notify_json), version: 1, dailyRepeat: false };
  db._raw.prepare('UPDATE notifications SET notify_json = ? WHERE user_id = ?').run(JSON.stringify(v1), userId);

  await c.call('POST', '/api/todos', { title: '迁移后每天提醒', date: localDate(), dueDate: localDate(5) });

  const m = installFetchMock();
  try {
    const r1 = await c.call('POST', '/api/notify/run');
    assert.equal(r1.data.report.sent, 1);

    const yesterday = Math.floor(Date.now() / 1000) - 86400;
    db._raw.prepare('UPDATE notify_log SET sent_at = ? WHERE user_id = ?').run(yesterday, userId);
    const r2 = await c.call('POST', '/api/notify/run');
    assert.equal(r2.data.report.sent, 1, 'v1 老配置迁移后应每天提醒，而不是只推一次');

    // 读取配置应看到 version 已是当前版本、dailyRepeat=true
    const cfg = await c.call('GET', '/api/notify/config');
    assert.equal(cfg.data.config.dailyRepeat, true);
  } finally { m.restore(); }
});

test('开关：关闭总开关后一条都不推', async () => {
  const { env, ctx } = makeEnv();
  const c = makeClient(env, ctx);
  await c.call('POST', '/api/auth/register', { username: 'off1', password: 'secret123' });
  await c.call('PUT', '/api/notify/config', {
    enabled: false, channels: ['bark'], leadDays: 1, time: '00:00',
    params: { bark: { key: 'k' } },
  });
  await c.call('POST', '/api/todos', { title: '不该被推送', date: localDate(), dueDate: localDate(0) });

  const m = installFetchMock();
  try {
    const run = await c.call('POST', '/api/notify/run');
    assert.equal(run.data.report.due, 0);
    assert.equal(run.data.report.sent, 0);
    assert.equal(m.calls.length, 0, '关闭后不应发出任何请求');
  } finally { m.restore(); }
});

test('已完成的任务不再提醒', async () => {
  const { env, ctx } = makeEnv();
  const c = makeClient(env, ctx);
  await c.call('POST', '/api/auth/register', { username: 'done1', password: 'secret123' });
  await c.call('PUT', '/api/notify/config', {
    enabled: true, channels: ['bark'], leadDays: 1, time: '00:00',
    params: { bark: { key: 'k' } },
  });
  const t = await c.call('POST', '/api/todos', { title: '已经做完了', date: localDate(), dueDate: localDate(0) });
  await c.call('PATCH', `/api/todos/${t.data.todo.id}`, { done: true });

  const m = installFetchMock();
  try {
    const run = await c.call('POST', '/api/notify/run');
    assert.equal(run.data.report.due, 0, '已完成的任务不该出现在提醒里');
    assert.equal(m.calls.length, 0);
  } finally { m.restore(); }
});

test('已过期：默认会一起提醒，关掉 includeOverdue 后不再提', async () => {
  const { env, ctx } = makeEnv();
  const c = makeClient(env, ctx);
  await c.call('POST', '/api/auth/register', { username: 'over1', password: 'secret123' });

  const base = { enabled: true, channels: ['bark'], leadDays: 3, time: '00:00', params: { bark: { key: 'k' } } };
  await c.call('PUT', '/api/notify/config', { ...base, includeOverdue: true });
  await c.call('POST', '/api/todos', { title: '三天前就该做', date: localDate(), dueDate: localDate(-3) });

  const m = installFetchMock();
  try {
    const withOverdue = await c.call('POST', '/api/notify/run');
    assert.equal(withOverdue.data.report.due, 1, '默认应把已过期的一起提醒');
    assert.match(m.last().json.body, /已过期 3 天/);

    // 关掉后清掉日志再跑
    await env.DB.prepare('DELETE FROM notify_log').run();
    await c.call('PUT', '/api/notify/config', { ...base, includeOverdue: false });
    const without = await c.call('POST', '/api/notify/run');
    assert.equal(without.data.report.due, 0);
  } finally { m.restore(); }
});

test('免打扰时间：默认「每天 9 点后推送」，未到点不推；「立即检查」不受限制', async () => {
  const { env, ctx } = makeEnv();
  const c = makeClient(env, ctx);
  await c.call('POST', '/api/auth/register', { username: 'quiet1', password: 'secret123' });
  await c.call('PUT', '/api/notify/config', {
    enabled: true, channels: ['bark'], leadDays: 1, time: '23:59',
    tz: 'UTC',
    params: { bark: { key: 'k' } },
  });
  await c.call('POST', '/api/todos', { title: '免打扰测试', date: localDate(), dueDate: localDate(0) });

  // 用 Cron 触发（会走免打扰判断）
  const m = installFetchMock();
  try {
    const report = await worker.scheduled({ scheduledTime: Date.now() }, env, { waitUntil: (p) => p });
    assert.equal(report.notify.due, 0, 'UTC 时间还没到 23:59，Cron 不应推送');
    assert.equal(m.calls.length, 0);
  } finally { m.restore(); }

  // 「立即检查」跳过免打扰
  const m2 = installFetchMock();
  try {
    const run = await c.call('POST', '/api/notify/run');
    assert.equal(run.data.report.sent, 1, '手动触发应无视免打扰时间');
    assert.equal(m2.calls.length, 1);
  } finally { m2.restore(); }
});

test('测试按钮：能针对单个渠道发测试消息，且失败时把上游原因带回来', async () => {
  const { env, ctx } = makeEnv();
  const c = makeClient(env, ctx);
  await c.call('POST', '/api/auth/register', { username: 'testbtn1', password: 'secret123' });

  const m = installFetchMock();
  try {
    const res = await c.call('POST', '/api/notify/test', {
      channel: 'bark',
      config: { params: { bark: { key: 'k' } } },
    });
    assert.equal(res.status, 200);
    assert.match(res.data.message, /测试消息已发出/);
    assert.equal(m.byHost('api.day.app').length, 1);
  } finally { m.restore(); }

  // 未填必填项 -> 明确报错
  const bad = await c.call('POST', '/api/notify/test', { channel: 'bark', config: {} });
  assert.equal(bad.status, 400);
  assert.match(bad.data.error, /Device Key/);

  // 不存在的渠道
  assert.equal((await c.call('POST', '/api/notify/test', { channel: 'nope' })).status, 400);
  assert.equal((await c.call('POST', '/api/notify/test', {})).status, 400);
});

test('Cron：只给开启了提醒的用户推送，且与定时备份互不影响', async () => {
  const { env, ctx } = makeEnv();
  const a = makeClient(env, ctx);
  await a.call('POST', '/api/auth/register', { username: 'cronN1', password: 'secret123' });
  await a.call('PUT', '/api/notify/config', {
    enabled: true, channels: ['bark'], leadDays: 1, time: '00:00', tz: 'UTC',
    params: { bark: { key: 'k' } },
  });
  await a.call('POST', '/api/todos', { title: 'A 的到期任务', date: localDate(), dueDate: localDate(0) });

  const b = makeClient(env, ctx);
  await b.call('POST', '/api/auth/register', { username: 'cronN2', password: 'secret123' });
  // B 也从没配过通知

  const m = installFetchMock();
  try {
    const report = await worker.scheduled({ scheduledTime: Date.now() }, env, { waitUntil: (p) => p });
    assert.ok(report.notify, 'scheduled 应返回 notify 报告');
    assert.equal(report.notify.checked, 1, '只有 A 配过通知');
    assert.equal(report.notify.sent, 1);
    assert.ok(report.backup, '定时备份报告应保留');
    assert.equal(m.byHost('api.day.app').length, 1);
  } finally { m.restore(); }
});

test('检查频率：Cron 尊重用户自选的检查间隔，默认每 5 分钟一次', async () => {
  const { env, ctx } = makeEnv();
  const c = makeClient(env, ctx);
  await c.call('POST', '/api/auth/register', { username: 'interval1', password: 'secret123' });
  await c.call('PUT', '/api/notify/config', {
    enabled: true, channels: ['bark'], leadDays: 1, time: '00:00', tz: 'UTC',
    checkInterval: 30,                       // 调成 30 分钟检查一次
    params: { bark: { key: 'k' } },
  });
  await c.call('POST', '/api/todos', { title: '今天到期的任务', date: localDate(), dueDate: localDate(0) });

  const m = installFetchMock();
  try {
    // 第一轮：从没检查过，立即检查并推送
    const r1 = await worker.scheduled({ scheduledTime: Date.now() }, env, { waitUntil: (p) => p });
    assert.equal(r1.notify.gated, 0, '第一轮不应被门控拦下');
    assert.equal(r1.notify.sent, 1);
    assert.equal(m.byHost('api.day.app').length, 1);

    // 第二轮（几秒后）：距上次检查远小于 30 分钟 → 被门控跳过
    const r2 = await worker.scheduled({ scheduledTime: Date.now() + 10_000 }, env, { waitUntil: (p) => p });
    assert.equal(r2.notify.gated, 1, '检查间隔内不应重复检查');
    assert.equal(r2.notify.sent, 0);
    assert.equal(m.byHost('api.day.app').length, 1, '门控期间不应发消息');

    // 把 last_scan 拨回 31 分钟前 → 又到了检查时间
    await env.DB.prepare('UPDATE notifications SET last_scan = last_scan - 1860').run();
    const r3 = await worker.scheduled({ scheduledTime: Date.now() + 20_000 }, env, { waitUntil: (p) => p });
    assert.equal(r3.notify.gated, 0, '超过检查间隔后应放行');
    // 去重日志保证同一任务不重复推，sent 仍是 0 是正常行为
    assert.equal(r3.notify.sent, 0);
    assert.equal(m.byHost('api.day.app').length, 1);
  } finally { m.restore(); }
});

test('检查频率：默认 5 分钟时，下一轮 Cron 不被门控误拦（容差生效）', async () => {
  const { env, ctx } = makeEnv();
  const c = makeClient(env, ctx);
  await c.call('POST', '/api/auth/register', { username: 'interval2', password: 'secret123' });
  // 不传 checkInterval → 默认 5 分钟，与 Cron 周期一致，每轮都应放行
  await c.call('PUT', '/api/notify/config', {
    enabled: true, channels: ['bark'], leadDays: 1, time: '00:00', tz: 'UTC',
    params: { bark: { key: 'k' } },
  });
  await c.call('POST', '/api/todos', { title: '今天到期', date: localDate(), dueDate: localDate(0) });

  const m = installFetchMock();
  try {
    await worker.scheduled({ scheduledTime: Date.now() }, env, { waitUntil: (p) => p });
    // 恰好 5 分钟后（Cloudflare Cron 的名义周期），30 秒容差应放行
    const r2 = await worker.scheduled({ scheduledTime: Date.now() + 300_000 }, env, { waitUntil: (p) => p });
    assert.equal(r2.notify.gated, 0, '默认周期下不应被门控误拦');
  } finally { m.restore(); }
});

test('Cron：通知配置坏了不影响其它用户，也不会抛出去', async () => {
  const { env, ctx, db } = makeEnv();
  const good = makeClient(env, ctx);
  await good.call('POST', '/api/auth/register', { username: 'cronNg', password: 'secret123' });
  await good.call('PUT', '/api/notify/config', {
    enabled: true, channels: ['bark'], leadDays: 1, time: '00:00', tz: 'UTC',
    params: { bark: { key: 'k' } },
  });
  await good.call('POST', '/api/todos', { title: '好用户', date: localDate(), dueDate: localDate(0) });

  const bad = makeClient(env, ctx);
  await bad.call('POST', '/api/auth/register', { username: 'cronNb', password: 'secret123' });
  await bad.call('PUT', '/api/notify/config', { enabled: true, channels: ['bark'] });
  db._raw.prepare('UPDATE notifications SET notify_json = ? WHERE user_id = (SELECT id FROM users WHERE username = ?)')
    .run('{坏掉的 JSON', 'cronNb');

  const m = installFetchMock();
  try {
    const report = await worker.scheduled({ scheduledTime: Date.now() }, env, { waitUntil: (p) => p });
    assert.equal(report.notify.checked, 2);
    assert.equal(report.notify.sent, 1, '配置损坏的用户被跳过，好用户照常推送');
    assert.equal(m.byHost('api.day.app').length, 1);
  } finally { m.restore(); }
});

test('隔离：A 的通知配置与推送记录看不见也改不到 B 的', async () => {
  const { env, ctx, db } = makeEnv();
  const a = makeClient(env, ctx);
  await a.call('POST', '/api/auth/register', { username: 'isoA', password: 'secret123' });
  await a.call('PUT', '/api/notify/config', {
    enabled: true, channels: ['bark'], leadDays: 5, time: '07:00',
    params: { bark: { key: 'A-KEY' } },
  });
  await a.call('POST', '/api/todos', { title: 'A 的任务', date: localDate(), dueDate: localDate(0) });

  const b = makeClient(env, ctx);
  await b.call('POST', '/api/auth/register', { username: 'isoB', password: 'secret123' });

  // B 读到的是自己的空配置
  const bCfg = await b.call('GET', '/api/notify/config');
  assert.equal(bCfg.data.config.enabled, false);
  assert.equal(bCfg.data.config.leadDays, 1, '默认值，不是 A 的 5');
  assert.equal(bCfg.data.config.params.bark.has_key, false);
  assert.ok(!bCfg.text.includes('A-KEY'));

  // B 的「立即检查」不会推 A 的任务（A 没配时 B 也没配 -> 都推不出）
  const m = installFetchMock();
  try {
    const bRun = await b.call('POST', '/api/notify/run');
    assert.equal(bRun.data.report.sent, 0, 'B 没配渠道，不应推出任何东西');
    assert.equal(m.calls.length, 0);
  } finally { m.restore(); }

  // 库层面确认日志按 user_id 隔离
  const rows = db._raw.prepare('SELECT user_id FROM notify_log').all();
  const aId = db._raw.prepare("SELECT id FROM users WHERE username = 'isoA'").get().id;
  assert.ok(rows.every((r) => r.user_id === aId), '推送日志只能属于 A');
});

test('备份往返：导出再导入后，到期日不丢', async () => {
  const { env, ctx } = makeEnv();
  const c = makeClient(env, ctx);
  await c.call('POST', '/api/auth/register', { username: 'due2', password: 'secret123' });
  await c.call('POST', '/api/todos', { title: '带到期日的任务', date: localDate(), dueDate: localDate(6) });

  const exported = await c.call('GET', '/api/export');
  assert.equal(exported.data.todos[0].dueDate, localDate(6));

  // 清空后用导出内容导入
  await env.DB.prepare('DELETE FROM todos').run();
  const imported = await c.call('POST', '/api/import', { payload: exported.data, mode: 'replace' });
  assert.equal(imported.status, 200);

  const list = await c.call('GET', `/api/todos?date=${localDate()}`);
  assert.equal(list.data.todos[0].dueDate, localDate(6), '导入后到期日应保留');
});

test('备份兼容：旧备份（无 dueDate 字段）仍能导入，且不会写出脏值', async () => {
  const { env, ctx } = makeEnv();
  const c = makeClient(env, ctx);
  await c.call('POST', '/api/auth/register', { username: 'due3', password: 'secret123' });

  const legacy = {
    app: 'todo-today', version: 1, exportedAt: '2026-01-01T00:00:00.000Z',
    todos: [
      { title: '老数据没有到期日', done: false, date: localDate(), order: 0, createdAt: 1 },
      { title: '到期日格式不对', done: false, date: localDate(), dueDate: '乱七八糟', order: 1, createdAt: 2 },
    ],
  };
  const res = await c.call('POST', '/api/import', { payload: legacy, mode: 'replace' });
  assert.equal(res.status, 200);
  assert.equal(res.data.result.inserted, 2);

  const list = await c.call('GET', `/api/todos?date=${localDate()}`);
  const byTitle = Object.fromEntries(list.data.todos.map((t) => [t.title, t]));
  assert.equal(
    byTitle['老数据没有到期日'].dueDate, localDate(),
    '老备份缺 dueDate 字段：按所属日期补上（与新任务默认规则一致）',
  );
  assert.equal(byTitle['到期日格式不对'].dueDate, null, '非法到期日当作没有');
});

test('老库兼容：todos 表没有 due_date 列时，提醒功能安全降级不报错', async () => {
  const db = createD1(':memory:');
  // 老 schema：没有 due_date 列，也没有通知两张表
  db._raw.exec(`
    CREATE TABLE users (id TEXT PRIMARY KEY, username TEXT NOT NULL UNIQUE, password_hash TEXT NOT NULL, salt TEXT NOT NULL, created_at INTEGER NOT NULL);
    CREATE TABLE sessions (token TEXT PRIMARY KEY, user_id TEXT NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL);
    CREATE TABLE todos (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, title TEXT NOT NULL, done INTEGER NOT NULL DEFAULT 0, todo_date TEXT NOT NULL, sort_order INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
    CREATE TABLE settings (user_id TEXT PRIMARY KEY, backup_json TEXT, last_backup INTEGER, updated_at INTEGER NOT NULL);
  `);
  const env = { DB: db, APP_NAME: '今日待办', ALLOW_REGISTRATION: 'true' };
  const ctx = { waitUntil: () => {}, passThroughOnException() {} };
  const c = makeClient(env, ctx);

  await c.call('POST', '/api/auth/register', { username: 'legacy1', password: 'secret123' });
  // 老库没有 due_date，新增任务不带到期日仍应正常
  const created = await c.call('POST', '/api/todos', { title: '老库任务', date: localDate() });
  assert.equal(created.status, 201, '老库不带 dueDate 时仍应能新增');

  await c.call('PUT', '/api/notify/config', { enabled: true, channels: ['bark'], params: { bark: { key: 'k' } } });
  const run = await c.call('POST', '/api/notify/run');
  assert.equal(run.status, 200, '缺 due_date 列时应安全降级而不是 500');
  assert.equal(run.data.report.due, 0);

  // Cron 也不应因为列缺失而崩掉
  const report = await worker.scheduled({ scheduledTime: Date.now() }, env, { waitUntil: (p) => p });
  assert.ok(report.notify, 'Cron 应正常返回报告');
});

test('设置页预览：返回「今天」与当前配置下会被提醒的任务清单', async () => {
  const { env, ctx } = makeEnv();
  const c = makeClient(env, ctx);
  await c.call('POST', '/api/auth/register', { username: 'preview1', password: 'secret123' });
  await c.call('POST', '/api/todos', { title: '明天到期', date: localDate(), dueDate: localDate(1) });
  await c.call('POST', '/api/todos', { title: '五天后到期', date: localDate(), dueDate: localDate(5) });

  const cfg = await c.call('PUT', '/api/notify/config', { enabled: true, channels: ['bark'], leadDays: 2 });
  assert.equal(cfg.data.preview.leadDays, 2);
  assert.equal(cfg.data.preview.today, localDate(), '预览里的「今天」应跟本地日期一致');
  assert.equal(cfg.data.preview.items.length, 1);
  assert.equal(cfg.data.preview.items[0].title, '明天到期');
  assert.equal(cfg.data.preview.items[0].days, 1, `实际 ${JSON.stringify(cfg.data.preview)}`);

  // 放宽到 5 天 -> 两条都在
  const wider = await c.call('PUT', '/api/notify/config', { enabled: true, channels: ['bark'], leadDays: 5 });
  assert.equal(wider.data.preview.items.length, 2);
});

test('诊断：「立即检查」对不同类型的空结果给出具体原因，而不是笼统一句话', async () => {
  const { env, ctx } = makeEnv();
  const c = makeClient(env, ctx);
  await c.call('POST', '/api/auth/register', { username: 'diag1', password: 'secret123' });

  // 场景 A：任务存在但到期日是空的（规则上线前的历史数据 = NULL；
  // 用户显式清空的空串不算，因为它代表「明确不要提醒」）
  const plain = await c.call('POST', '/api/todos', { title: '普通任务', date: localDate(), dueDate: '' });
  await env.DB.prepare('UPDATE todos SET due_date = NULL WHERE id = ?').bind(plain.data.todo.id).run();
  await c.call('PUT', '/api/notify/config', { enabled: true, channels: ['bark'], leadDays: 1 });
  const a = await c.call('POST', '/api/notify/run');
  assert.match(a.data.message, /到期日为空/, `实际：${a.data.message}`);
  assert.match(a.data.message, /补齐到期日/, '应引导用户一键补齐');

  // 预览同样给出原因
  const pv = await c.call('GET', '/api/notify/config');
  assert.match(pv.data.preview.hint, /到期日为空/);
  assert.equal(pv.data.preview.missingDue, 1, 'preview 应带上待补齐条数');

  // 场景 B：有到期日但都在窗口外
  await c.call('POST', '/api/todos', { title: '一周后到期', date: localDate(), dueDate: localDate(7) });
  const b = await c.call('POST', '/api/notify/run');
  assert.match(b.data.message, /超出/, `实际：${b.data.message}`);
  assert.match(b.data.message, /提前 1 天/);
  const pvb = await c.call('GET', '/api/notify/config');
  assert.match(pvb.data.preview.hint, /超出/);

  // 场景 C：开关没开
  await c.call('PUT', '/api/notify/config', { enabled: false, channels: ['bark'], leadDays: 1 });
  await c.call('POST', '/api/todos', { title: '今天到期', date: localDate(), dueDate: localDate() });
  const cc = await c.call('POST', '/api/notify/run');
  assert.match(cc.data.message, /未开启/, `实际：${cc.data.message}`);

  // 场景 D：开了但没选渠道
  await c.call('PUT', '/api/notify/config', { enabled: true, channels: [], leadDays: 1 });
  const d = await c.call('POST', '/api/notify/run');
  assert.match(d.data.message, /推送渠道/, `实际：${d.data.message}`);
});

test('诊断：任务有到期日且在窗口内时，不附加任何「原因」提示', async () => {
  const { env, ctx } = makeEnv();
  const c = makeClient(env, ctx);
  await c.call('POST', '/api/auth/register', { username: 'diag2', password: 'secret123' });
  await c.call('POST', '/api/todos', { title: '今天到期', date: localDate(), dueDate: localDate() });
  await c.call('PUT', '/api/notify/config', { enabled: true, channels: ['bark'], leadDays: 1 });
  const pv = await c.call('GET', '/api/notify/config');
  assert.equal(pv.data.preview.items.length, 1);
  assert.equal(pv.data.preview.hint, undefined, '有到期任务时不应带 hint');
});

test('默认到期日：不传 dueDate 时等于所属日期，显式传空串才是「不要到期日」', async () => {
  const { env, ctx } = makeEnv();
  const c = makeClient(env, ctx);
  await c.call('POST', '/api/auth/register', { username: 'due1', password: 'secret123' });

  // 10-19 的待办，到期日就是 10-19
  const auto = await c.call('POST', '/api/todos', { title: '默认到期', date: localDate(3) });
  assert.equal(auto.data.todo.dueDate, localDate(3), '到期日应等于任务所属日期');

  // 显式清空 = 这条任务不参与提醒
  const off = await c.call('POST', '/api/todos', { title: '不要到期日', date: localDate(3), dueDate: '' });
  assert.equal(off.data.todo.dueDate, null, '空串应归一成 null');

  // 移动归属日期时，默认态（到期日 == 所属日期）的到期日跟着走
  const move = await c.call('PATCH', `/api/todos/${auto.data.todo.id}`, { date: localDate(5) });
  assert.equal(move.data.todo.dueDate, localDate(5), '默认态到期日应跟随所属日期一起移动');

  // 手动改过到期日的，再移动归属日期时不能被动
  await c.call('PATCH', `/api/todos/${auto.data.todo.id}`, { dueDate: localDate(9) });
  const move2 = await c.call('PATCH', `/api/todos/${auto.data.todo.id}`, { date: localDate(6) });
  assert.equal(move2.data.todo.dueDate, localDate(9), '手动设过的到期日不应被覆盖');
});

test('顺延未完成任务时，默认态的到期日一起顺延，手动改过的不动', async () => {
  const { env, ctx } = makeEnv();
  const c = makeClient(env, ctx);
  await c.call('POST', '/api/auth/register', { username: 'carrydue', password: 'secret123' });

  const a = await c.call('POST', '/api/todos', { title: '昨天没做完', date: localDate(-1) });          // 默认态
  const b = await c.call('POST', '/api/todos', { title: '手动改过', date: localDate(-1), dueDate: localDate(-1) });
  await c.call('PATCH', `/api/todos/${b.data.todo.id}`, { dueDate: localDate(9) });                     // 手动改到 9 天后

  const res = await c.call('POST', '/api/todos/batch', { action: 'carry-over', date: localDate() });
  assert.equal(res.data.moved, 2);

  const list = await c.call('GET', `/api/todos?date=${localDate()}`);
  const byTitle = Object.fromEntries(list.data.todos.map((t) => [t.title, t]));
  assert.equal(byTitle['昨天没做完'].dueDate, localDate(), '默认态到期日应跟着顺延到今天');
  assert.equal(byTitle['手动改过'].dueDate, localDate(9), '手动设过的到期日不应被顺延改掉');
});

test('历史数据补齐：把「从没设过到期日」的任务补成所属日期，不动显式清空的', async () => {
  const { env, ctx } = makeEnv();
  const c = makeClient(env, ctx);
  await c.call('POST', '/api/auth/register', { username: 'backfill1', password: 'secret123' });

  const a = await c.call('POST', '/api/todos', { title: '历史任务A', date: localDate(-1), dueDate: '' });
  const b = await c.call('POST', '/api/todos', { title: '历史任务B', date: localDate(-2), dueDate: '' });
  await c.call('POST', '/api/todos', { title: '明确不要到期日', date: localDate(-3), dueDate: '' });
  await c.call('POST', '/api/todos', { title: '正常任务', date: localDate(2), dueDate: localDate(7) });

  // 模拟「默认到期日」规则上线前的历史数据：due_date 是 NULL（而不是空串）
  await env.DB.prepare('UPDATE todos SET due_date = NULL WHERE id IN (?, ?)')
    .bind(a.data.todo.id, b.data.todo.id)
    .run();

  const before = await c.call('GET', '/api/notify/config');
  assert.equal(before.data.preview.missingDue, 2, '只统计从没设过到期日的任务，不含显式清空的');

  const res = await c.call('POST', '/api/todos/backfill-due');
  assert.equal(res.status, 200);
  assert.equal(res.data.updated, 2);
  assert.match(res.data.message, /已把 2 条任务/);

  // 补齐后到期日 = 所属日期
  const listA = await c.call('GET', `/api/todos?date=${localDate(-1)}`);
  assert.equal(listA.data.todos[0].dueDate, localDate(-1));
  const listB = await c.call('GET', `/api/todos?date=${localDate(-2)}`);
  assert.equal(listB.data.todos[0].dueDate, localDate(-2));

  // 已有到期日、以及用户显式清空的都不动
  const listNormal = await c.call('GET', `/api/todos?date=${localDate(2)}`);
  assert.equal(listNormal.data.todos[0].dueDate, localDate(7), '已有到期日不应被覆盖');
  const listOff = await c.call('GET', `/api/todos?date=${localDate(-3)}`);
  assert.equal(listOff.data.todos[0].dueDate, null, '显式清空的任务不应被补齐');

  const after = await c.call('GET', '/api/notify/config');
  assert.equal(after.data.preview.missingDue, 0);
});

test('「立即检查」接受当前表单：未保存的开关/渠道修改也能立即验证', async () => {
  const { env, ctx } = makeEnv();
  const c = makeClient(env, ctx);
  await c.call('POST', '/api/auth/register', { username: 'runform', password: 'secret123' });
  await c.call('POST', '/api/todos', { title: '明天到期', date: localDate(), dueDate: localDate(1) });
  // 保存的配置：未开启
  await c.call('PUT', '/api/notify/config', { enabled: false, channels: ['bark'], leadDays: 1 });

  // 不带表单跑 -> 提示未开启
  const saved = await c.call('POST', '/api/notify/run');
  assert.match(saved.data.message, /未开启/);

  // 带上表单（开关已打开）跑 -> 能识别到到期任务（bark 发送失败不影响 due 计数）
  const fresh = await c.call('POST', '/api/notify/run', {
    config: { enabled: true, channels: ['bark'], leadDays: 1 },
  });
  assert.equal(fresh.data.report.due, 1, `实际：${JSON.stringify(fresh.data)}`);
  assert.match(fresh.data.message, /有 1 项到期任务/);
});

test('提前天数：0 = 只在当天提醒，不会提前', async () => {
  const { env, ctx } = makeEnv();
  const c = makeClient(env, ctx);
  await c.call('POST', '/api/auth/register', { username: 'lead0', password: 'secret123' });
  await c.call('POST', '/api/todos', { title: '今天到期', date: localDate(), dueDate: localDate(0) });
  await c.call('POST', '/api/todos', { title: '明天到期', date: localDate(), dueDate: localDate(1) });

  const cfg = await c.call('PUT', '/api/notify/config', { enabled: true, channels: ['bark'], leadDays: 0 });
  assert.equal(cfg.data.preview.items.length, 1);
  assert.equal(cfg.data.preview.items[0].title, '今天到期');

  // 提前 1 天 -> 当天 + 明天都提醒
  const one = await c.call('PUT', '/api/notify/config', { enabled: true, channels: ['bark'], leadDays: 1 });
  assert.equal(one.data.preview.items.length, 2);
});

test('提前天数调小：已推过的任务不会因为改配置被重新推一遍', async () => {
  const { env, ctx } = makeEnv();
  const c = makeClient(env, ctx);
  await c.call('POST', '/api/auth/register', { username: 'shrink1', password: 'secret123' });
  await c.call('POST', '/api/todos', { title: '三天后到期', date: localDate(), dueDate: localDate(3) });

  // 先按提前 7 天推一次（显式单次模式：进窗口那天推完就不再推）
  await c.call('PUT', '/api/notify/config', {
    enabled: true, channels: ['bark'], leadDays: 7, time: '00:00', dailyRepeat: false, params: { bark: { key: 'k' } },
  });
  const m = installFetchMock();
  try {
    const first = await c.call('POST', '/api/notify/run');
    assert.equal(first.data.report.sent, 1);
    assert.equal(m.calls.length, 1);

    // 改成提前 2 天：这条任务仍在窗口内，但已经推过 -> 不该重复推
    await c.call('PUT', '/api/notify/config', {
      enabled: true, channels: ['bark'], leadDays: 2, time: '00:00',
    });
    const second = await c.call('POST', '/api/notify/run');
    assert.equal(second.data.report.sent, 0, '已推过就不该再推');
    assert.equal(m.calls.length, 1, '不应发出第二次请求');
  } finally { m.restore(); }
});

test('不漏推：应用长期没打开，任务「进窗口」那轮 Cron 一定会推出去', async () => {
  const { env, ctx } = makeEnv();
  const c = makeClient(env, ctx);
  await c.call('POST', '/api/auth/register', { username: 'noleak1', password: 'secret123' });

  // 提前 3 天提醒，任务 3 天后到期（刚好进窗口）
  await c.call('PUT', '/api/notify/config', {
    enabled: true, channels: ['bark'], leadDays: 3, time: '00:00', tz: 'UTC',
    params: { bark: { key: 'k' } },
  });
  await c.call('POST', '/api/todos', { title: '别漏掉我', date: localDate(), dueDate: localDate(3) });

  const m = installFetchMock();
  try {
    // 本轮 Cron 就是「刚进窗口」的那一轮：必须推
    const report = await worker.scheduled({ scheduledTime: Date.now() }, env, { waitUntil: (p) => p });
    assert.equal(report.notify.sent, 1, '任务刚进入提醒窗口时必须推送，不能攒到明天');
    assert.equal(m.byHost('api.day.app').length, 1);
    assert.match(m.last().json.body, /别漏掉我/);
  } finally { m.restore(); }
});

test('边界：完全没进窗口的任务不会被推出去', async () => {
  const { env, ctx } = makeEnv();
  const c = makeClient(env, ctx);
  await c.call('POST', '/api/auth/register', { username: 'bound1', password: 'secret123' });
  await c.call('POST', '/api/todos', { title: '四天后', date: localDate(), dueDate: localDate(4) });

  // 提前 3 天 -> 4 天后到期的还在窗口外
  const cfg = await c.call('PUT', '/api/notify/config', { enabled: true, channels: ['bark'], leadDays: 3 });
  assert.equal(cfg.data.preview.items.length, 0, '窗口外的任务不该进提醒清单');

  // 提前 4 天 -> 进窗口
  const wider = await c.call('PUT', '/api/notify/config', { enabled: true, channels: ['bark'], leadDays: 4 });
  assert.equal(wider.data.preview.items.length, 1);
  assert.equal(wider.data.preview.items[0].days, 4);
});

test('健康检查会列出通知相关的表，缺失时提示去执行 schema.sql', async () => {
  const db = createD1(':memory:');
  const env = { DB: db, APP_NAME: '今日待办' };
  const ctx = { waitUntil: () => {}, passThroughOnException() {} };
  const c = makeClient(env, ctx);

  const empty = await c.call('GET', '/api/health?check=1');
  assert.equal(empty.data.schema.ok, false);
  assert.ok(empty.data.schema.missing.includes('notifications'));
  assert.ok(empty.data.schema.missing.includes('notify_log'));
  assert.match(empty.data.schema.hint, /schema\.sql/);

  db._raw.exec(readFileSync(join(ROOT, 'schema.sql'), 'utf8'));
  const full = await c.call('GET', '/api/health?check=1');
  assert.equal(full.data.schema.ok, true);
  assert.deepEqual(full.data.schema.missing, []);
});

test('一次推送涵盖多个渠道：某个渠道挂了不影响其它渠道', async () => {
  const { env, ctx } = makeEnv();
  const c = makeClient(env, ctx);
  await c.call('POST', '/api/auth/register', { username: 'multi1', password: 'secret123' });
  await c.call('PUT', '/api/notify/config', {
    enabled: true, channels: ['bark', 'wecom', 'telegram'], leadDays: 1, time: '00:00',
    params: {
      bark: { key: 'k' },
      wecom: { url: 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=x' },
      telegram: { botToken: 't', chatId: '1' },
    },
  });
  await c.call('POST', '/api/todos', { title: '多渠道路由', date: localDate(), dueDate: localDate(1) });

  const original = globalThis.fetch;
  const hits = { bark: 0, wecom: 0, telegram: 0 };
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (u.includes('api.telegram.org')) {
      hits.telegram += 1;
      return new Response(JSON.stringify({ ok: false, description: 'chat not found' }), {
        status: 200, headers: { 'content-type': 'application/json' },
      });
    }
    if (u.includes('qyapi')) { hits.wecom += 1; return new Response(JSON.stringify({ errcode: 0 }), { status: 200, headers: { 'content-type': 'application/json' } }); }
    hits.bark += 1;
    return new Response(JSON.stringify({ code: 200 }), { status: 200, headers: { 'content-type': 'application/json' } });
  };

  try {
    const run = await c.call('POST', '/api/notify/run');
    assert.equal(run.data.report.sent, 2, 'Bark 与企业微信成功');
    assert.equal(run.data.report.failed.length, 1);
    assert.equal(run.data.report.failed[0].channel, 'telegram');
    assert.deepEqual(hits, { bark: 1, wecom: 1, telegram: 1 }, '三个渠道都尝试了');
  } finally { globalThis.fetch = original; }
});

test('去重粒度是「渠道」：新增渠道后，老任务会在新渠道上补推一次', async () => {
  const { env, ctx } = makeEnv();
  const c = makeClient(env, ctx);
  await c.call('POST', '/api/auth/register', { username: 'addch1', password: 'secret123' });
  await c.call('PUT', '/api/notify/config', {
    enabled: true, channels: ['bark'], leadDays: 1, time: '00:00', dailyRepeat: false, params: { bark: { key: 'k' } },
  });
  await c.call('POST', '/api/todos', { title: '补推测试', date: localDate(), dueDate: localDate(1) });

  const m = installFetchMock();
  try {
    assert.equal((await c.call('POST', '/api/notify/run')).data.report.sent, 1);

    await c.call('PUT', '/api/notify/config', {
      channels: ['bark', 'wecom'],
      params: { wecom: { url: 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=y' } },
    });
    const second = await c.call('POST', '/api/notify/run');
    assert.equal(second.data.report.sent, 1, '只有新加的渠道需要补推');
    assert.equal(m.byHost('api.day.app').length, 1, 'Bark 不应重复推');
    assert.equal(m.byHost('qyapi.weixin.qq.com').length, 1, '企业微信补推一次');
  } finally { m.restore(); }
});
