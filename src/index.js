/**
 * 今日待办 · Cloudflare Worker 入口
 *
 * 路由策略：
 *   /api/*  -> 由本 Worker 处理
 *   其它    -> 交给静态资源绑定 ASSETS（public/ 目录）
 */

import { ok, fail, json, readJson } from './lib/http.js';
import { INLINE_ASSETS } from './lib/assets.js';
import * as auth from './lib/auth.js';
import * as todos from './lib/todos.js';
import * as backup from './lib/backup.js';
import * as notify from './lib/notify.js';

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (!url.pathname.startsWith('/api/')) {
      return serveStatic(request, env);
    }

    try {
      return await route(request, env, ctx, url);
    } catch (err) {
      const status = err instanceof auth.HttpError ? err.status : 500;
      if (status >= 500) console.error('[api-error]', err?.stack || err);
      return fail(explainError(err, status), status);
    }
  },

  /**
   * 定时任务：由 Cron Trigger 唤起（默认每 5 分钟一次）。
   *  1. 到期提醒 —— 扫描「即将到期」的待办并按配置的渠道推送
   *  2. 定时备份 —— 只对「配置了定时备份且已到周期」的用户真正执行上传
   */
  async scheduled(event, env, ctx) {
    const task = (async () => {
      const nowMs = Number(event?.scheduledTime);
      const now = new Date(Number.isFinite(nowMs) && nowMs > 0 ? nowMs : Date.now());

      const [notifyReport, backupReport] = await Promise.all([
        notify.runScheduledNotify(env, { now }).catch((err) => {
          console.error('[cron-notify] 失败', err?.stack || err);
          return null;
        }),
        backup.runScheduledBackups(env, { now: Math.floor(now.getTime() / 1000) }).catch((err) => {
          console.error('[cron-backup] 失败', err?.stack || err);
          return null;
        }),
      ]);

      const report = { notify: notifyReport, backup: backupReport };
      console.log('[cron] 完成', JSON.stringify(report));
      return report;
    })();
    if (ctx?.waitUntil) ctx.waitUntil(task);
    return task;   // 也直接返回，便于本地调用 / 测试拿到结果
  },
};

const REQUIRED_TABLES = ['users', 'sessions', 'todos', 'settings', 'notifications', 'notify_log'];

/**
 * 把底层报错翻译成「能照着做」的提示。
 * 最常见的一类是 D1 建好了但没执行过 schema.sql，原始报文只有
 * "D1_ERROR: no such table: users: SQLITE_ERROR"，对使用者毫无指向性。
 */
function explainError(err, status) {
  const raw = String(err?.message || err || '');
  if (status < 500) return raw || '请求有误';

  if (/no such table/i.test(raw)) {
    const table = raw.match(/no such table:\s*([^\s:]+)/i)?.[1] || '数据表';
    return `数据库尚未初始化（缺少 ${table}）。请在 Cloudflare 控制台进入 D1 → 选择该数据库 → Console，粘贴执行项目里的 schema.sql；`
      + '或在本地执行 npm run db:remote。执行完访问 /api/health?check=1 可确认。';
  }
  if (/no such column/i.test(raw)) {
    return '数据库表结构过旧（缺少字段）。请重新执行一遍 schema.sql 升级表结构，再访问 /api/health?check=1 确认。';
  }
  if (/UNIQUE constraint failed/i.test(raw)) {
    return '该记录已存在（唯一约束冲突）。';
  }
  if (/network connection lost|internal error|storage.*(error|failure)/i.test(raw)) {
    return '数据库暂时不可用，请稍后重试。';
  }
  return raw || '服务器内部错误';
}

/** 连库核对必需的数据表是否都已建好，供 /api/health?check=1 使用 */
async function inspectSchema(env) {
  try {
    const { results } = await env.DB
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all();
    const existing = new Set((results || []).map((r) => r.name));
    const tables = REQUIRED_TABLES.filter((t) => existing.has(t));
    const missing = REQUIRED_TABLES.filter((t) => !existing.has(t));
    return {
      ok: missing.length === 0,
      tables,
      missing,
      hint: missing.length
        ? '缺少数据表：在 Cloudflare 控制台进入该 D1 数据库 → Console，执行 schema.sql 后重试'
        : '数据表齐全',
    };
  } catch (err) {
    return {
      ok: false,
      error: String(err?.message || err),
      hint: '无法读取数据库结构：请确认 Worker 的绑定名称是 DB，且指向的是正确的数据库',
    };
  }
}

/**
 * 静态资源：
 *  1. 有 ASSETS 绑定时交给它（wrangler / Workers Builds 部署）
 *  2. 否则回落到内联资源表（单文件粘贴到网页控制台的部署方式）
 */
async function serveStatic(request, env) {
  if (env.ASSETS) return env.ASSETS.fetch(request);

  if (INLINE_ASSETS) {
    const { pathname } = new URL(request.url);
    const path = pathname === '/' ? '/index.html' : pathname;
    const asset = INLINE_ASSETS[path];
    if (asset) {
      return new Response(request.method === 'HEAD' ? null : asset.body, {
        status: 200,
        headers: {
          'content-type': asset.type,
          'cache-control': path === '/index.html'
            ? 'no-cache'
            : 'public, max-age=3600',
        },
      });
    }
  }

  return new Response('Not Found', { status: 404 });
}

/* ============================== 路由 ============================== */

async function route(request, env, ctx, url) {
  const path = url.pathname.replace(/\/+$/, '') || '/api';
  const method = request.method.toUpperCase();

  // 数据库绑定体检
  if (!env.DB && path !== '/api/health') {
    return fail('未绑定 D1 数据库：请先创建数据库并在 wrangler.jsonc 中配置 d1_databases', 503);
  }

  /* ---------- 健康检查 ---------- */
  // /api/health          只报绑定情况，不碰数据库
  // /api/health?check=1  额外连库核对数据表是否已建好（部署后自查用）
  if (path === '/api/health' && method === 'GET') {
    const payload = {
      app: env.APP_NAME || '今日待办',
      time: new Date().toISOString(),
      db: !!env.DB,
      r2: !!env.BACKUPS,
      registration: String(env.ALLOW_REGISTRATION ?? 'true').toLowerCase() !== 'false',
      notify: true,
    };
    if (url.searchParams.get('check') === '1' && env.DB) {
      payload.schema = await inspectSchema(env);
    }
    return ok(payload);
  }

  /* ---------- 认证 ---------- */
  if (path === '/api/auth/register' && method === 'POST') {
    const body = await readJson(request);
    const user = await auth.register(env, body);
    const token = await auth.createSession(env, user.id);
    ctx.waitUntil(auth.purgeExpiredSessions(env));
    return json({ ok: true, user }, { headers: { 'set-cookie': auth.sessionCookie(request, token) } });
  }

  if (path === '/api/auth/login' && method === 'POST') {
    const body = await readJson(request);
    const user = await auth.login(env, body);
    const token = await auth.createSession(env, user.id);
    ctx.waitUntil(auth.purgeExpiredSessions(env));
    return json({ ok: true, user }, { headers: { 'set-cookie': auth.sessionCookie(request, token) } });
  }

  if (path === '/api/auth/logout' && method === 'POST') {
    const token = (await auth.getSessionUser(request, env))?.token;
    await auth.destroySession(env, token);
    return json({ ok: true }, { headers: { 'set-cookie': auth.sessionCookie(request, '') } });
  }

  if (path === '/api/auth/me' && method === 'GET') {
    const user = await auth.getSessionUser(request, env);
    return ok({ user: user ? { id: user.id, username: user.username, createdAt: user.createdAt } : null });
  }

  if (path === '/api/auth/password' && method === 'POST') {
    const user = await auth.requireUser(request, env);
    const body = await readJson(request);
    await auth.changePassword(env, user, body);
    return ok({ message: '密码已更新，其它设备需重新登录' });
  }

  /* ---------- 待办 ---------- */
  if (path === '/api/todos' && method === 'GET') {
    const user = await auth.requireUser(request, env);

    // 整月视图：/api/todos?month=YYYY-MM
    if (url.searchParams.get('month')) {
      const { month, todos: list } = await todos.listByMonth(env, user.id, url.searchParams.get('month'));
      const remaining = list.filter((t) => !t.done).length;
      return ok({ month, todos: list, remaining, total: list.length });
    }

    const date = todos.normalizeDate(url.searchParams.get('date'));
    const list = await todos.listTodos(env, user.id, date);
    const stat = await todos.countByDate(env, user.id, date);
    return ok({ date, todos: list, ...stat });
  }

  if (path === '/api/todos' && method === 'POST') {
    const user = await auth.requireUser(request, env);
    const body = await readJson(request);
    const todo = await todos.createTodo(env, user.id, body);
    const stat = await todos.countByDate(env, user.id, todo.date);
    scheduleAutoBackup(ctx, env, user, request.cf?.timezone);
    return json({ ok: true, todo, ...stat }, { status: 201 });
  }

  if (path === '/api/todos/batch' && method === 'POST') {
    const user = await auth.requireUser(request, env);
    const body = await readJson(request);
    // 按月操作时（如 clear-completed + month）可以不带 date
    const date = todos.normalizeDate(body.date, '1970-01-01');

    if (body.action === 'clear-completed') {
      // 支持按月清除：{ action: 'clear-completed', month: 'YYYY-MM' }
      if (body.month) {
        const res = await todos.clearCompletedMonth(env, user.id, body.month);
        scheduleAutoBackup(ctx, env, user, request.cf?.timezone);
        return ok(res);
      }
      const res = await todos.clearCompleted(env, user.id, date);
      const stat = await todos.countByDate(env, user.id, date);
      scheduleAutoBackup(ctx, env, user, request.cf?.timezone);
      return ok({ ...res, ...stat });
    }

    if (body.action === 'toggle-all') {
      const res = await todos.toggleAll(env, user.id, date, !!body.done);
      const stat = await todos.countByDate(env, user.id, date);
      scheduleAutoBackup(ctx, env, user, request.cf?.timezone);
      return ok({ ...res, ...stat });
    }

    if (body.action === 'reorder') {
      const res = await todos.reorderTodos(env, user.id, date, body.ids);
      scheduleAutoBackup(ctx, env, user, request.cf?.timezone);
      return ok(res);
    }

    if (body.action === 'carry-over') {
      const res = await todos.carryOver(env, user.id, { from: body.from || null, to: date });
      const list = await todos.listTodos(env, user.id, date);
      const stat = await todos.countByDate(env, user.id, date);
      scheduleAutoBackup(ctx, env, user, request.cf?.timezone);
      return ok({ ...res, todos: list, ...stat });
    }

    return fail('未知的批量操作');
  }

  if (path === '/api/todos/stats' && method === 'GET') {
    const user = await auth.requireUser(request, env);
    const days = url.searchParams.get('days');
    const stats = await todos.statsByDate(env, user.id, days);
    return ok({ stats });
  }

  /* ---------- 搜索 / 标签 ---------- */
  if (path === '/api/search' && method === 'GET') {
    const user = await auth.requireUser(request, env);
    const q = url.searchParams.get('q') || '';
    return ok({ q, todos: await todos.searchTodos(env, user.id, q) });
  }

  if (path === '/api/tags' && method === 'GET') {
    const user = await auth.requireUser(request, env);
    const limit = url.searchParams.get('limit');
    return ok({ tags: await todos.listTags(env, user.id, limit) });
  }

  const todoMatch = path.match(/^\/api\/todos\/([^/]+)$/);
  if (todoMatch) {
    const id = decodeURIComponent(todoMatch[1]);
    const user = await auth.requireUser(request, env);

    if (method === 'PATCH') {
      const body = await readJson(request);
      const todo = await todos.updateTodo(env, user.id, id, body);
      const stat = await todos.countByDate(env, user.id, todo.date);
      scheduleAutoBackup(ctx, env, user, request.cf?.timezone);
      return ok({ todo, ...stat });
    }

    if (method === 'DELETE') {
      const res = await todos.deleteTodo(env, user.id, id);
      const date = url.searchParams.get('date');
      let stat = { remaining: 0, total: 0 };
      if (date && todos.DATE_RE.test(date)) stat = await todos.countByDate(env, user.id, date);
      scheduleAutoBackup(ctx, env, user, request.cf?.timezone);
      return ok({ ...res, ...stat });
    }
  }

  /* ---------- 到期提醒 ---------- */
  // 浏览器时区：用户没在设置里选时区时用它兜底，避免 Worker 跑在 UTC 导致「今天」差一天
  const reqTz = String(request.headers.get('x-tz') || request.cf?.timezone || '').slice(0, 64);
  if (path === '/api/notify/config' && method === 'GET') {
    const user = await auth.requireUser(request, env);
    // 老库还没建表时顺手补建，用户无需手动执行 SQL 就能用上提醒功能
    await notify.ensureNotifyTables(env);
    const { config, exists } = await notify.readNotifyConfig(env, user.id);
    const fresh = await notify.rememberNotifyMeta(env, user.id, config, {
      timeZone: reqTz,
    });
    const preview = await notify.previewDue(env, user.id, fresh, { now: new Date(), reqTz });
    return ok({
      config: notify.maskNotifyConfig(fresh, env),
      preview,
      lastScan: fresh.lastScan,
      exists,
      cron: await backup.readCronStatus(env),
    });
  }

  if (path === '/api/notify/config' && method === 'PUT') {
    const user = await auth.requireUser(request, env);
    await notify.ensureNotifyTables(env);
    const body = await readJson(request);
    const { config: previous } = await notify.readNotifyConfig(env, user.id);
    const merged = notify.normalizeNotifyConfig(
      { ...body, tz: body.tz || reqTz || previous.tz },
      previous,
    );
    await notify.writeNotifyConfig(env, user.id, merged);
    const preview = await notify.previewDue(env, user.id, merged, { now: new Date(), reqTz });
    return ok({ config: notify.maskNotifyConfig(merged, env), preview });
  }

  if (path === '/api/notify/test' && method === 'POST') {
    const user = await auth.requireUser(request, env);
    const body = await readJson(request);
    const { config: previous } = await notify.readNotifyConfig(env, user.id);
    const channel = String(body.channel || '').trim();
    if (!channel) return fail('请先选择要测试的渠道');
    // 用「提交上来的表单 + 旧配置」合并，这样还没保存也能先测
    const candidate = notify.normalizeNotifyConfig(
      { ...body.config, enabled: true, channels: [channel] },
      previous,
    );
    const result = await notify.testChannel(env, channel, candidate);
    return ok(result);
  }

  if (path === '/api/notify/run' && method === 'POST') {
    const user = await auth.requireUser(request, env);
    await notify.ensureNotifyTables(env);
    const { config } = await notify.readNotifyConfig(env, user.id);
    const report = await notify.runNotifyForUser(env, user.id, config, {
      now: new Date(),
      ignoreQuietHours: true,   // 手动触发不受「每天几点后推送」限制
      reqTz,
    });
    const message = report.sent
      ? `已推送 ${report.sent} 个渠道`
      : (report.due ? `有 ${report.due} 项到期任务，但没有渠道需要推送（可能已推送过）` : '当前没有需要提醒的任务');
    return ok({ message, report });
  }

  /* ---------- 备份 ---------- */
  if (path === '/api/backup/config' && method === 'GET') {
    const user = await auth.requireUser(request, env);
    const { config, lastBackup } = await backup.readConfig(env, user.id);
    // 顺手记住用户时区：定时备份（Cron）没有请求上下文，拼文件名时要用
    const fresh = await backup.rememberTimeZone(env, user.id, config, request.cf?.timezone);
    return ok({
      config: backup.maskConfig(fresh, env),
      lastBackup,
      cron: await backup.readCronStatus(env),
    });
  }

  if (path === '/api/backup/config' && method === 'PUT') {
    const user = await auth.requireUser(request, env);
    const body = await readJson(request);
    const { config: previous } = await backup.readConfig(env, user.id);
    const merged = backup.normalizeConfig(
      { ...body, tz: body.tz || request.cf?.timezone },
      previous,
    );
    await backup.writeConfig(env, user.id, merged);
    return ok({ config: backup.maskConfig(merged, env) });
  }

  if (path === '/api/backup/test' && method === 'POST') {
    const user = await auth.requireUser(request, env);
    const body = await readJson(request);
    const { config: previous } = await backup.readConfig(env, user.id);
    const candidate = backup.normalizeConfig({ ...body, enabled: true }, previous);
    const info = await backup.testConnection(env, candidate);
    return ok({
      message: info.exists ? '连接成功，云端已有备份文件' : '连接成功，云端暂无备份文件',
      info,
    });
  }

  if (path === '/api/backup/run' && method === 'POST') {
    const user = await auth.requireUser(request, env);
    const { config } = await backup.readConfig(env, user.id);
    const result = await backup.runBackup(env, user, config, {
      timeZone: request.cf?.timezone || config.tz,
    });
    return ok({ message: '已备份到云端', result });
  }

  if (path === '/api/backup/restore' && method === 'POST') {
    const user = await auth.requireUser(request, env);
    const body = await readJson(request);
    const { config } = await backup.readConfig(env, user.id);
    const mode = body.mode === 'replace' ? 'replace' : 'merge';
    const result = await backup.restoreBackup(env, user, config, mode);
    return ok({
      message: mode === 'replace' ? '已用云端备份覆盖本地数据' : '已合并云端备份',
      result,
    });
  }

  /* ---------- 本地导入 / 导出 ---------- */
  if (path === '/api/export' && method === 'GET') {
    const user = await auth.requireUser(request, env);
    const payload = await backup.buildPayload(env, user);
    // 文件名带时间戳，同一天多次导出不会互相覆盖
    const filename = `todo-today-${backup.fileStamp(new Date(), request.cf?.timezone)}.json`;
    return new Response(JSON.stringify(payload, null, 2), {
      headers: {
        'content-type': 'application/json; charset=utf-8',
        'content-disposition': `attachment; filename="${filename}"`,
        'cache-control': 'no-store',
      },
    });
  }

  if (path === '/api/import' && method === 'POST') {
    const user = await auth.requireUser(request, env);
    const body = await readJson(request);
    const payload = body.payload || body;
    const mode = body.mode === 'replace' ? 'replace' : 'merge';
    const result = await backup.applyPayload(env, user, payload, { mode });
    scheduleAutoBackup(ctx, env, user, request.cf?.timezone);
    return ok({ message: `导入完成：新增 ${result.inserted} 条`, result });
  }

  return fail(`接口不存在：${method} ${path}`, 404);
}

/** 数据变更后触发自动备份（节流由 maybeAutoBackup 内部处理）
 *  timeZone 用于备份文件名的时间戳，取用户请求里的 Cloudflare 时区信息 */
function scheduleAutoBackup(ctx, env, user, timeZone) {
  if (!ctx?.waitUntil) return;
  ctx.waitUntil(backup.maybeAutoBackup(env, user, { timeZone }));
}
