/**
 * 复现「有到期任务但提示当前没有需要提醒的任务」：
 * 用与线上一致的完整流程跑一遍，确认后端在数据正确时的行为。
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import { createD1 } from '../test/d1-shim.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

// 直接用源码版（与 Git 部署同一份代码）
const worker = (await import(pathToFileURL(join(ROOT, 'src/index.js')).href)).default;

const db = createD1(':memory:');
db._raw.exec(readFileSync(join(ROOT, 'schema.sql'), 'utf8'));

const env = { DB: db, APP_NAME: '今日待办', ALLOW_REGISTRATION: 'true' };
const ctx = { waitUntil: (p) => Promise.resolve(p).catch(() => {}), passThroughOnException() {} };
let cookie = '';

async function call(method, path, body) {
  const headers = { 'x-tz': 'Asia/Shanghai' };
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (cookie) headers.cookie = cookie;
  const res = await worker.fetch(
    new Request(`https://x.com${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }),
    env, ctx,
  );
  const sc = res.headers.get('set-cookie');
  if (sc) cookie = sc.split(';')[0];
  return res.json();
}

// 本地时区的今天/明天
const p = (n) => String(n).padStart(2, '0');
const fmt = (d) => `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
const TODAY = fmt(new Date());
const TOMORROW = fmt(new Date(Date.now() + 86400000));

await call('POST', '/api/auth/register', { username: 'repro', password: 'secret123' });

/* 场景 1：任务只设了归属日期，没设到期日（最可能的用户状态） */
await call('POST', '/api/todos', { title: '普通任务（无到期日）', date: TODAY });
let pv = await call('GET', '/api/notify/config');
console.log('场景1（无到期日）preview.items =', pv.preview.items.length);

await call('PUT', '/api/notify/config', {
  enabled: true, channels: ['gotify'], leadDays: 1, time: '09:00',
  params: { gotify: { server: 'https://gotify.example.com', token: 't' } },
});
let run = await call('POST', '/api/notify/run');
console.log('场景1 run =', JSON.stringify(run));

/* 场景 2：任务带今天/明天的到期日 */
await call('POST', '/api/todos', { title: '今天到期', date: TODAY, dueDate: TODAY });
await call('POST', '/api/todos', { title: '明天到期', date: TODAY, dueDate: TOMORROW });
pv = await call('GET', '/api/notify/config');
console.log('\n场景2（今天+明天到期）preview =', JSON.stringify(pv.preview));
run = await call('POST', '/api/notify/run');
console.log('场景2 run =', JSON.stringify(run));

/* 场景 3：到期日都在窗口外（3 天后） */
await call('POST', '/api/todos', { title: '三天后到期', date: TODAY, dueDate: fmt(new Date(Date.now() + 3 * 86400000)) });
pv = await call('GET', '/api/notify/config');
console.log('\n场景3 preview.items =', pv.preview.items.length, ' leadDays =', pv.preview.leadDays);

/* 场景 4：总开关没开（保存的是 enabled:false） */
await call('PUT', '/api/notify/config', { enabled: false, channels: ['gotify'], leadDays: 1 });
run = await call('POST', '/api/notify/run');
console.log('\n场景4（未开启）run =', JSON.stringify(run));

/* 场景 5：开了但没选渠道 */
await call('PUT', '/api/notify/config', { enabled: true, channels: [], leadDays: 1 });
run = await call('POST', '/api/notify/run');
console.log('场景5（无渠道）run =', JSON.stringify(run));
