/**
 * 截取「到期提醒」设置卡片与任务卡片到期徽标，用于验收视觉。
 * 前置：public/ 已在 127.0.0.1:8791 上提供静态服务。
 * 用法：node scripts/shot-notify.mjs [输出目录]
 */
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PORT = 9336;
const OUT = process.argv[2] || 'shots';
const BASE = 'http://127.0.0.1:8791/index.html?demo=1';

const chrome = spawn(CHROME, [
  '--headless=new', '--disable-gpu', `--remote-debugging-port=${PORT}`,
  '--window-size=1400,1100', '--user-data-dir=C:/Users/ketto/AppData/Local/Temp/chrome-cdp-notify',
  'about:blank',
], { stdio: 'ignore' });
await sleep(2500);

const list = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json();
const page = list.find((t) => t.type === 'page');
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((r) => (ws.onopen = r));

let id = 0;
const pending = new Map();
ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
};
const send = (method, params = {}) => new Promise((res) => {
  const mid = ++id;
  pending.set(mid, res);
  ws.send(JSON.stringify({ id: mid, method, params }));
});
const evalJs = async (e) => (await send('Runtime.evaluate', {
  expression: e, returnByValue: true, awaitPromise: true,
})).result?.result?.value;

async function shoot(name, { selector, full = false } = {}) {
  const params = { format: 'png', captureBeyondViewport: full };
  if (selector) {
    const box = await evalJs(`(() => {
      const n = document.querySelector(${JSON.stringify(selector)});
      if (!n) return null;
      const r = n.getBoundingClientRect();
      return { x: r.left, y: r.top, width: r.width, height: r.height };
    })()`);
    if (!box || !box.width) throw new Error(`没找到元素：${selector}`);
    params.clip = { ...box, scale: 2 };
  }
  const res = await send('Page.captureScreenshot', params);
  const data = res.result?.data;
  if (!data) throw new Error(`截图失败：${name}`);
  const path = `${OUT}/${name}.png`;
  writeFileSync(path, Buffer.from(data, 'base64'));
  console.log(`✓ ${path}`);
}

await send('Page.enable');
await send('Runtime.enable');

// 用 ?panel=settings 直接打开设置抽屉
await send('Page.navigate', { url: `${BASE}&panel=settings` });
await sleep(1500);
await evalJs('localStorage.clear()');
await send('Page.navigate', { url: `${BASE}&panel=settings` });
await sleep(3000);

// 勾上两个渠道、打开开关，让面板呈现"使用中"的样子
await evalJs(`(() => {
  const on = document.getElementById('notify-enabled');
  on.checked = true; on.dispatchEvent(new Event('change'));
  for (const id of ['bark','wecom']) {
    const tag = document.querySelector('#notify-channels .channel-tag[data-channel="' + id + '"]');
    tag.querySelector('input').checked = true;
    tag.classList.add('on');
  }
  document.getElementById('notify-channels').dispatchEvent(new Event('change', { bubbles: true }));
  document.getElementById('notify-lead').value = '7';
})()`);
await sleep(500);
await evalJs(`document.querySelector('.preview-box').open = true`);
await sleep(300);

await shoot('notify-panel', { selector: '.card:has(#notify-enabled)' }).catch(async () => {
  // :has 不被支持时退化成整页
  await shoot('notify-panel', { full: true });
});

await shoot('notify-full', { full: true });

ws.close();
chrome.kill();
