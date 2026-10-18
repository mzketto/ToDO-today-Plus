/**
 * 部署路径对照测试：验证「GitHub 自动构建」与「网页粘贴单文件」两条路径
 * 产出的前端运行结果完全一致（尤其是多账号数据隔离修复）。
 *
 * 差异只在【静态资源从哪来】：
 *   - GitHub 路径：wrangler.jsonc 的 assets.directory = ./public，浏览器直接拿 public/ 下的文件
 *   - 网页路径：assets 不生效，由 dist 单文件里的 INLINE_ASSETS_B64 内联返回
 *
 * 所以本测试要证明：两条路径返回的 app.js / index.html / style.css 内容一致，
 * 且都包含多账号隔离的修复代码。
 *
 * 2026-10-16 增强：不再只比静态资源，而是把两条路径当两个真实 Worker 各跑一套
 * 登录 → 建待办 → 设到期 → 读提醒预览 → 触发 Cron 的全流程，
 * 逐条 diff 两次的响应体，确保「后端行为」也没有分叉。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join, extname } from 'node:path';

import { createD1 } from './d1-shim.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

/** 解码单文件产物里的内联资源表 */
function decodeBundleAssets() {
  const src = readFileSync(join(ROOT, 'dist/worker.cloudflare-dashboard.js'), 'utf8');
  const start = src.indexOf('const INLINE_ASSETS_B64 = {');
  assert.ok(start !== -1, '单文件产物里应存在 INLINE_ASSETS_B64');
  const from = src.indexOf('{', start);
  let depth = 0;
  let end = -1;
  for (let i = from; i < src.length; i += 1) {
    const c = src[i];
    if (c === '{') depth += 1;
    else if (c === '}') { depth -= 1; if (depth === 0) { end = i; break; } }
  }
  assert.ok(end !== -1, '应能定位内联资源对象的结尾');
  // eslint-disable-next-line no-eval
  const obj = eval(`(${src.slice(from, end + 1)})`);
  return Object.fromEntries(
    Object.entries(obj).map(([p, entry]) => [
      p,
      // 二进制资源（PNG 等）不能过 UTF-8 解码（会丢字节），保留原始 base64
      entry.binary ? entry.body : Buffer.from(entry.body, 'base64').toString('utf8'),
    ]),
  );
}

const bundleAssets = decodeBundleAssets();

/** 二进制资源按 base64 比对（PNG 不能过 UTF-8 解码），文本按 utf8 */
function onDiskAssetB64(p) {
  return readFileSync(join(ROOT, 'public', p)).toString('base64');
}

test('两条部署路径的静态资源内容一致（GitHub 版 === 网页粘贴版）', () => {
  for (const name of ['/app.js', '/index.html', '/style.css']) {
    const onDisk = readFileSync(join(ROOT, 'public', name), 'utf8');
    assert.equal(
      bundleAssets[name],
      onDisk,
      `${name}：GitHub 路径直接用 public/ 文件，单文件路径用内联副本，两者必须一致`,
    );
  }
});

test('多账号隔离修复已包含在两条路径共用的前端代码里', () => {
  const app = bundleAssets['/app.js'];
  // 关键修复点必须存在
  for (const key of ['resetUserState', 'handleSessionLost', 'syncRegistrationTab']) {
    assert.ok(app.includes(key), `app.js 应包含 ${key}`);
  }
  // 登录流程必须调用 resetUserState（这是原来缺失的那一环）
  const loginBlock = app.slice(app.indexOf('auth/${state.authMode}'), app.indexOf('resetUserState();'));
  assert.ok(loginBlock.length < 400, '登录成功后应紧接着调用 resetUserState()');
  // 退出登录也必须调用
  const logoutIdx = app.indexOf('logoutBtn.addEventListener');
  const logoutBlock = app.slice(logoutIdx, logoutIdx + 300);
  assert.ok(logoutBlock.includes('resetUserState'), '退出登录应调用 resetUserState()');
  // 旧的 401 裸分支不应再存在（已统一收口）
  assert.ok(!/if \(err\.status === 401\) \{ showAuth\(\); return; \}/.test(app),
    '401 分支应统一走 handleSessionLost()');
});

test('wrangler.jsonc 走 GitHub 路径时，静态资源确实由 public/ 目录提供', () => {
  const cfgRaw = readFileSync(join(ROOT, 'wrangler.jsonc'), 'utf8');
  const cfg = JSON.parse(cfgRaw.replace(/^\s*\/\/.*$/gm, ''));
  assert.equal(cfg.main, 'src/index.js', 'Worker 入口');
  assert.equal(cfg.assets.directory, './public', '静态资源目录');
  assert.equal(cfg.assets.binding, 'ASSETS', 'assets 绑定名');
  assert.ok(existsSync(join(ROOT, 'public', 'app.js')), 'public/app.js 必须存在并入库');
  assert.ok(existsSync(join(ROOT, 'public', 'index.html')), 'public/index.html 必须存在并入库');
  assert.ok(existsSync(join(ROOT, 'public', 'style.css')), 'public/style.css 必须存在并入库');
});

test('后端隔离逻辑在 src/ 里（两条路径共用同一个 Worker 入口）', () => {
  const index = readFileSync(join(ROOT, 'src/index.js'), 'utf8');
  // 所有 todos.* 调用都必须传 user.id
  const calls = index.match(/todos\.\w+\([^)]*\)/g) || [];
  const offenders = calls.filter((c) => !/\buser\.id\b/.test(c) && !/DATE_RE|normalize/.test(c));
  assert.equal(offenders.length, 0, `这些调用没带 user.id：\n${offenders.join('\n')}`);

  // 会话校验：只能通过 Cookie 里的 token 查 sessions 表
  const auth = readFileSync(join(ROOT, 'src/lib/auth.js'), 'utf8');
  assert.ok(auth.includes('FROM sessions s'), '会话必须查 sessions 表');
  assert.ok(auth.includes('JOIN users u ON u.id = s.user_id'), '会话与用户必须 JOIN 关联');
});

test('单文件产物与 public/ 完全同步（不会出现「修了这个没修那个」）', () => {
  const files = Object.keys(bundleAssets);
  assert.deepEqual(
    files.sort(),
    [
      '/app.js', '/icon.svg', '/index.html', '/manifest.webmanifest', '/notify-channels.json',
      '/style.css', '/sw.js',
      '/icons/icon-192.png', '/icons/icon-512.png', '/icons/icon-512-maskable.png',
      '/icons/apple-touch-180.png', '/icons/favicon-32.png',
    ].sort(),
    '内联资源清单应与 public/ 目录一致',
  );
  // 每个内联文件都必须与磁盘上的 public/ 逐字节相同（统一按 base64 比对）
  const binaryExt = new Set(['.png', '.jpg', '.jpeg', '.webp', '.ico', '.woff2']);
  for (const p of files) {
    const bundledB64 = binaryExt.has(extname(p).toLowerCase())
      ? bundleAssets[p]   // 二进制：bundleAssets 里存的就是原始 base64
      : Buffer.from(bundleAssets[p], 'utf8').toString('base64');
    assert.equal(bundledB64, onDiskAssetB64(p), `${p} 与磁盘不一致，需要重新执行打包脚本`);
  }
  // sw.js 里不应残留版本占位符（版本号直接写在源文件里，两条路径共用）
  assert.ok(!bundleAssets['/sw.js'] || !Buffer.from(bundleAssets['/sw.js'], 'base64').toString('utf8').includes('[[SW_CACHE_VERSION]]'),
    'sw.js 残留版本占位符');
});

test('两套部署的 Cron 表达式一致（方案 A 靠 wrangler.jsonc，方案 B 靠控制台手填）', () => {
  const cfgRaw = readFileSync(join(ROOT, 'wrangler.jsonc'), 'utf8');
  const cfg = JSON.parse(cfgRaw.replace(/^\s*\/\/.*$/gm, ''));
  const crons = cfg.triggers?.crons || [];
  assert.equal(crons.length, 1, '应只有一个 Cron：备份与提醒共用同一个 5 分钟心跳');
  assert.match(crons[0], /^\*\/5 /, `Cron 应为每 5 分钟：${crons[0]}`);

  // 单文件产物里的 CRON_SCHEDULE 必须与 wrangler.jsonc 一致，
  // 否则两条部署路径的「定时任务」跑在不同节奏上。
  const dist = readFileSync(join(ROOT, 'dist/worker.cloudflare-dashboard.js'), 'utf8');
  const m = dist.match(/const CRON_SCHEDULE = \[([^\]]*)\]/);
  assert.ok(m, '单文件产物里应存在 CRON_SCHEDULE');
  const inBundle = m[1].split(',').map((s) => s.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean);
  assert.deepEqual(inBundle, crons, '单文件产物与 wrangler.jsonc 的 Cron 表达式必须一致');
});

/* ============================================================
 * 端到端对照：两条路径各跑一遍同样的请求，逐条 diff 响应
 * ============================================================ */

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
};

/** index.html 与 sw.js 必须 no-cache：SW 更新检查与前端版本迭代都依赖每次拿最新 */
const noCachePaths = new Set(['/index.html', '/sw.js']);

/**
 * 模拟 Workers Builds 的 assets 绑定：直接从磁盘的 public/ 目录取文件。
 * 必须真取文件（而不是返回一个假字符串），否则静态资源对照测试没有意义——
 * 那正是「两条路径是否一致」要验证的东西。
 */
function makeAssetsBinding() {
  return {
    async fetch(request) {
      const { pathname } = new URL(request.url);
      const rel = pathname === '/' ? '/index.html' : pathname;
      const full = join(ROOT, 'public', rel.replace(/^\//, ''));
      // 防目录穿越：只允许 public/ 下的文件
      if (!full.startsWith(join(ROOT, 'public'))) return new Response('Not Found', { status: 404 });
      if (!existsSync(full)) return new Response('Not Found', { status: 404 });
      const body = readFileSync(full);
      return new Response(request.method === 'HEAD' ? null : body, {
        status: 200,
        headers: {
          'content-type': MIME[extname(full).toLowerCase()] || 'application/octet-stream',
          'cache-control': noCachePaths.has(rel) ? 'no-cache' : 'public, max-age=3600',
        },
      });
    },
  };
}

/**
 * 两条路径「理应不同」的字段白名单：只描述静态资源的分发方式，
 * 不涉及任何业务行为。除这些之外的所有差异都必须视为分叉。
 */
const EXPECTED_DIFF = new Set(['health.deploy.assets']);

function stripExpectedDiff(steps) {
  for (const step of steps) {
    if (step.label === 'health' && step.body?.deploy) {
      step.body.deploy = { ...step.body.deploy, assets: '<静态资源来源>' };
    }
  }
  return steps;
}

/** 把某个 Worker 挂在一个独立的内存 D1 上，返回可发请求的客户端 */
function makeHarness(worker, { assets = null } = {}) {
  const db = createD1(':memory:');
  db._raw.exec(readFileSync(join(ROOT, 'schema.sql'), 'utf8'));

  const env = {
    DB: db,
    APP_NAME: '今日待办',
    ALLOW_REGISTRATION: 'true',
    ...(assets ? { ASSETS: assets } : {}),
  };
  const ctx = { waitUntil: (p) => Promise.resolve(p).catch(() => {}), passThroughOnException() {} };
  let cookie = '';

  /**
   * 注意：两条路径都必须收到同样的请求头（含 x-tz），
   * 否则时区兜底会让「今天」差一天，diff 会出现假阳性。
   */
  async function call(method, path, body, { headers = {} } = {}) {
    const h = { 'x-tz': 'Asia/Shanghai', ...headers };
    if (body !== undefined) h['content-type'] = 'application/json';
    if (cookie) h.cookie = cookie;

    const res = await worker.fetch(
      new Request(`https://todo.example.com${path}`, {
        method,
        headers: h,
        body: body === undefined ? undefined : JSON.stringify(body),
      }),
      env,
      ctx,
    );
    const setCookie = res.headers.get('set-cookie');
    if (setCookie) cookie = setCookie.split(';')[0];
    return res;
  }

  return { call, env, get cookie() { return cookie; }, set cookie(v) { cookie = v; } };
}

/** 一次完整流程：返回每一步的「响应快照」（易变字段已归一） */
async function runFlow(h) {
  const steps = [];
  const snap = async (label, res) => {
    const text = await res.text();
    let parsed = null;
    try { parsed = JSON.parse(text); } catch { /* 非 JSON 原样保留 */ }
    steps.push({ label, status: res.status, body: normalize(parsed ?? text) });
  };

  const TODAY = '2026-10-16';
  const TOMORROW = '2026-10-17';

  await snap('health', await h.call('GET', '/api/health'));
  await snap('register', await h.call('POST', '/api/auth/register', { username: '对照用户', password: 'secret123' }));
  await snap('me', await h.call('GET', '/api/auth/me'));

  await snap('create-with-due', await h.call('POST', '/api/todos', {
    title: '交房租 #生活', date: TODAY, dueDate: TODAY,
  }));
  await snap('create-tomorrow', await h.call('POST', '/api/todos', {
    title: '开会', date: TODAY, dueDate: TOMORROW,
  }));
  await snap('list', await h.call('GET', `/api/todos?date=${TODAY}`));
  await snap('search', await h.call('GET', '/api/search?q=房租'));
  await snap('tags', await h.call('GET', '/api/tags'));

  // 到期提醒：配置 + 预览 + 发送测试 + 手动跑一轮
  await snap('notify-get-empty', await h.call('GET', '/api/notify/config'));
  await snap('notify-put', await h.call('PUT', '/api/notify/config', {
    enabled: true,
    channels: ['bark', 'gotify', 'webhook'],
    leadDays: 3,
    dailyRepeat: false,
    includeOverdue: true,
    time: '08:00',
    tz: 'Asia/Shanghai',
    params: {
      bark: { server: 'https://api.day.app', key: 'k' },
      gotify: { server: 'https://gotify.example.com', token: 't' },
      webhook: { url: 'https://hook.example.com/x' },
    },
  }));
  await snap('notify-get', await h.call('GET', '/api/notify/config'));
  await snap('notify-test-missing', await h.call('POST', '/api/notify/test', { channel: '' }));
  await snap('notify-test-gotify', await h.call('POST', '/api/notify/test', {
    channel: 'gotify', config: { params: { gotify: { server: 'https://gotify.example.com', token: 't' } } },
  }));

  // 人为把 due_date 改到「今天」，验证「到期」判定两条路径一致
  await h.env.DB.prepare("UPDATE todos SET due_date = ? WHERE title LIKE '开会%'").bind(TODAY).run();

  const preview = await h.call('GET', '/api/notify/config');
  await snap('notify-preview', preview);
  await snap('notify-run', await h.call('POST', '/api/notify/run'));

  // Cron：备份 + 提醒并行，两条路径的返回值结构必须一致
  const cron = await worker0.scheduled({ scheduledTime: Date.parse('2026-10-16T08:30:00Z') }, h.env, { waitUntil: (p) => p });
  steps.push({ label: 'cron', status: 200, body: normalize(cron) });

  await snap('backup-config', await h.call('GET', '/api/backup/config'));
  await snap('export', await h.call('GET', '/api/export'));

  return steps;
}

/** 抹掉天然易变的字段（时间戳 / 随机 id / 心跳），只保留结构性差异 */
function normalize(value) {
  const volatileKeys = new Set([
    'time', 'createdAt', 'updatedAt', 'sent_at', 'sentAt', 'lastScan', 'lastRun',
    'scheduledTime', 'duration', 'password_hash', 'salt', 'id', 'todoId',
    'user', 'userId', 'deviceKey', 'timestamp', 'exportedAt',
  ]);
  const walk = (v) => {
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === 'object') {
      const out = {};
      for (const [k, val] of Object.entries(v)) {
        if (volatileKeys.has(k)) { out[k] = `<${typeof val}>`; continue; }
        out[k] = walk(val);
      }
      return out;
    }
    if (typeof v === 'string') {
      // 上游报文里会带自己的时间戳，属于外部系统噪声，不是两条路径的差异
      return v.replace(/"timestamp":\d+/g, '"timestamp":<n>');
    }
    return v;
  };
  return walk(value);
}

// 两条路径的 Worker：多文件版（Git/Workers Builds）与单文件版（网页粘贴）
const worker0 = (await import(pathToFileURL(join(ROOT, 'src/index.js')).href)).default;
const worker1 = (await import(pathToFileURL(join(ROOT, 'dist/worker.cloudflare-dashboard.js')).href + `?t=${Date.now()}`)).default;

test('两条部署路径的后端行为逐步一致（登录/待办/提醒/Cron 全流程 diff）', async () => {
  // 路径 A：assets 绑定从 public/ 取文件（模拟 Workers Builds）
  const a = makeHarness(worker0, { assets: makeAssetsBinding() });
  // 路径 B：没有 assets 绑定，静态资源全由内联表返回（模拟网页粘贴部署）
  const b = makeHarness(worker1);

  const stepsA = stripExpectedDiff(await runFlow(a));
  const stepsB = stripExpectedDiff(await runFlow(b));

  assert.equal(stepsA.length, stepsB.length, '两条路径执行的步骤数应相同');
  for (let i = 0; i < stepsA.length; i += 1) {
    assert.equal(stepsB[i].label, stepsA[i].label);
    assert.equal(
      stepsB[i].status,
      stepsA[i].status,
      `步骤「${stepsA[i].label}」状态码不一致：B=${stepsB[i].status} vs A=${stepsA[i].status}`,
    );
    assert.deepEqual(
      stepsB[i].body,
      stepsA[i].body,
      `步骤「${stepsA[i].label}」响应体不一致（两条部署路径行为分叉）`,
    );
  }

  // 白名单只有一项：静态资源来源标记。把它单独断言清楚，避免以后有人往里加东西。
  const rawA = await runFlow(makeHarness(worker0, { assets: makeAssetsBinding() }));
  const rawB = await runFlow(makeHarness(worker1));
  const diffLabels = [];
  for (let i = 0; i < rawA.length; i += 1) {
    if (JSON.stringify(rawA[i]) !== JSON.stringify(rawB[i])) diffLabels.push(rawA[i].label);
  }
  assert.deepEqual(
    diffLabels,
    ['health'],
    '两条路径的差异应当只出现在 /api/health 的 deploy 字段上（静态资源来源标记）',
  );
  assert.equal(EXPECTED_DIFF.size, 1, '白名单应只有一项');
});

test('两条路径的静态资源都可用，且内容一致', async () => {
  const a = makeHarness(worker0, { assets: makeAssetsBinding() });
  const b = makeHarness(worker1);

  for (const p of ['/index.html', '/app.js', '/style.css', '/notify-channels.json', '/manifest.webmanifest', '/icon.svg', '/sw.js', '/icons/icon-192.png', '/icons/icon-512.png', '/icons/icon-512-maskable.png', '/icons/apple-touch-180.png', '/icons/favicon-32.png']) {
    const ra = await a.call('GET', p);
    const rb = await b.call('GET', p);
    assert.equal(ra.status, 200, `路径 A 取不到 ${p}`);
    assert.equal(rb.status, 200, `路径 B 取不到 ${p}`);
    // PNG 是二进制：按字节比对，文本按字符串比对
    const isPng = p.endsWith('.png');
    const [ta, tb] = isPng ? [await ra.arrayBuffer(), await rb.arrayBuffer()] : [await ra.text(), await rb.text()];
    assert.deepEqual(tb, ta, `${p} 两条路径内容不一致`);
    assert.equal(
      rb.headers.get('content-type'),
      ra.headers.get('content-type'),
      `${p} 两路径的 content-type 不一致`,
    );
    // sw.js 必须 no-cache，否则浏览器永远发现不了 SW 更新，卡死在旧版本
    if (p === '/sw.js' || p === '/index.html') {
      assert.equal(ra.headers.get('cache-control'), 'no-cache', `${p} 路径 A 必须 no-cache`);
      assert.equal(rb.headers.get('cache-control'), 'no-cache', `${p} 路径 B 必须 no-cache`);
    }
  }

  // 首页（/）两条路径都应回落到 index.html
  const [ha, hb] = [await (await a.call('GET', '/')).text(), await (await b.call('GET', '/')).text()];
  assert.equal(hb, ha, '/ 两条路径的首页内容不一致');
  assert.match(hb, /今日待办/);

  // 不存在的路径两边都应 404
  assert.equal((await b.call('GET', '/nope.txt')).status, (await a.call('GET', '/nope.txt')).status);
});

test('/api/health 报出的部署形态能把两条路径区分开，且 Cron 表达式一致', async () => {
  const a = makeHarness(worker0, { assets: makeAssetsBinding() });
  const b = makeHarness(worker1);

  const ha = await (await a.call('GET', '/api/health')).json();
  const hb = await (await b.call('GET', '/api/health')).json();

  assert.equal(ha.deploy.assets, 'assets', '路径 A 应报告静态资源由 assets 绑定提供');
  assert.equal(hb.deploy.assets, 'inline', '路径 B 应报告静态资源来自内联表');
  assert.deepEqual(ha.deploy.cron, hb.deploy.cron, '两条路径的 Cron 表达式必须一致');
  assert.deepEqual(ha.deploy.cron, ['*/5 * * * *']);
});
