/**
 * 把后端的渠道定义（CHANNELS / CHANNEL_LABELS / CHANNEL_FIELDS）导出成
 * public/notify-channels.json，供前端在演示模式下渲染渠道表单。
 *
 * 前端在线时用的是接口返回的 catalog，这个文件只在「没有后端」时兜底，
 * 因此必须从同一份后端定义生成，避免两边字段漂移。
 *
 * 用法：node scripts/gen-notify-catalog.mjs
 */
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const notify = await import(pathToFileURL(join(ROOT, 'src/lib/notify.js')).href);

const catalog = notify.CHANNELS.map((id) => {
  const spec = notify.CHANNEL_FIELDS[id] || {};
  const entry = { id, label: notify.CHANNEL_LABELS[id], fields: spec.fields || [] };
  if (spec.hint) entry.hint = spec.hint;
  return entry;
});

const out = join(ROOT, 'public/notify-channels.json');
writeFileSync(out, `${JSON.stringify(catalog, null, 2)}\n`);
console.log(`✓ 已生成 public/notify-channels.json（${catalog.length} 个渠道）`);
