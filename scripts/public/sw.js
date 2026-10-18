/*
 * 今日待办 · Service Worker
 *
 * 职责只有三件事：可安装、离线能打开外壳、有新版时提示用户刷新。
 * 刻意不做的事：缓存任何 /api 响应——待办数据必须来自服务器，
 * 离线时让请求自然失败、界面显示原有错误提示，绝不返回过期数据。
 *
 * 版本约定：CACHE_VERSION 与 public/app.js 的 APP_VERSION 保持一致，
 * 测试里有断言守着（发布前端时两处一起改）。改了名字，activate 阶段
 * 就会清掉旧缓存，客户端拿到新外壳。
 */

const CACHE_VERSION = '1.2.4';
const CACHE_NAME = `todo-today-shell-${CACHE_VERSION}`;

/* 外壳资源：相对路径，部署在子路径下也能用 */
const SHELL_ASSETS = [
  './',
  './index.html',
  './style.css',
  './app.js',
  './manifest.webmanifest',
  './icon.svg',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-512-maskable.png',
  './icons/apple-touch-180.png',
  './icons/favicon-32.png',
  './notify-channels.json',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE_NAME);
      // 逐个缓存，单个失败不让整次安装报废（比如旧版本少了某个图标）
      await Promise.allSettled(
        SHELL_ASSETS.map(async (asset) => {
          const req = new Request(asset, { cache: 'reload' });   // 绕过 HTTP 缓存拿最新
          const res = await fetch(req);
          if (res.ok) await cache.put(req, res.clone());
        }),
      );
      // 不调用 skipWaiting：等用户点「刷新」再接管，避免半个新版半个旧版
    })(),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      // 清掉所有旧版本缓存
      const names = await caches.keys();
      await Promise.all(
        names
          .filter((n) => n.startsWith('todo-today-shell-') && n !== CACHE_NAME)
          .map((n) => caches.delete(n)),
      );
      await self.clients.claim();
    })(),
  );
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // 只处理同源 GET；/api 与非 GET 一律直连，绝不缓存
  if (event.request.method !== 'GET') return;
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/api/')) return;

  // 通知渠道目录：后端会返回 catalog，演示模式兜底文件同名，
  // 网络优先（失败才用缓存），保持和 /api 一样的新鲜度要求
  const networkFirst = url.pathname.endsWith('/notify-channels.json');

  event.respondWith(
    (async () => {
      const cache = await caches.open(CACHE_NAME);
      const cached = await cache.match(event.request);

      if (networkFirst) {
        try {
          const fresh = await fetch(event.request);
          if (fresh.ok) cache.put(event.request, fresh.clone());
          return fresh;
        } catch {
          if (cached) return cached;
          throw new Error('offline');
        }
      }

      // 外壳资源：缓存优先，后台异步校新（stale-while-revalidate）
      const fetchAndCache = fetch(event.request)
        .then((res) => {
          if (res.ok) cache.put(event.request, res.clone());
          return res;
        })
        .catch(() => null);
      if (cached) {
        event.waitUntil?.(fetchAndCache);
        return cached;
      }
      const fresh = await fetchAndCache;
      if (fresh) return fresh;
      // 离线且无缓存：导航请求回退到外壳首页（用户直接打开子路径时）
      if (event.request.mode === 'navigate') {
        const shell = await cache.match('./index.html');
        if (shell) return shell;
      }
      return new Response('offline', { status: 503 });
    })(),
  );
});

/* 页面发来的消息：SKIP_WAITING 让新 SW 立即接管（用户点了「刷新」） */
self.addEventListener('message', (event) => {
  if (event.data === 'SKIP_WAITING') self.skipWaiting();
});
