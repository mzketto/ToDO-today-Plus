/**
 * 静态资源内联表 —— 为「不用命令行、只在 Cloudflare 网页控制台部署」准备。
 *
 * 两种部署方式：
 *
 *  1. wrangler / Workers Builds 部署（推荐）
 *     public/ 目录由 `assets` 配置托管，env.ASSETS 生效，
 *     此文件保持 INLINE_ASSETS = null，完全不会被用到。
 *
 *  2. 纯网页控制台部署（单文件粘贴）
 *     网页编辑器不支持配置 `assets`，也不支持上传静态文件。
 *     因此 scripts/build-dashboard.mjs 会把 public/ 下的文件
 *     以 base64 打进 dist/worker.cloudflare-dashboard.js，
 *     由 Worker 自己返回这些资源。
 *
 * 资源分两类：文本型（body 为 UTF-8 字符串）与二进制型（bytes 为 Uint8Array，
 * 如 PNG 图标）。用错解码方式会损坏文件，构建脚本按扩展名标注 binary。
 */

/* BUILD_MARKER:INLINE_ASSETS_B64 —— 打包脚本会替换下面这一行 */
const INLINE_ASSETS_B64 = null;

/** base64 -> Uint8Array（二进制资源直接用） */
function decodeBase64Bytes(b64) {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** base64 -> UTF-8 字符串（文本资源用，atob 只处理 Latin-1，中文必须再走一次 TextDecoder） */
function decodeBase64Utf8(b64) {
  return new TextDecoder().decode(decodeBase64Bytes(b64));
}

/**
 * 形如 `{ '/index.html': { body: '...', type: 'text/html; charset=utf-8' },
 *        '/icons/icon-192.png': { bytes: Uint8Array, type: 'image/png' } }`
 * @type {Record<string, {body?: string, bytes?: Uint8Array, type: string}>|null}
 */
export const INLINE_ASSETS = INLINE_ASSETS_B64
  ? Object.fromEntries(
      Object.entries(INLINE_ASSETS_B64).map(([path, entry]) => [
        path,
        {
          type: entry.type,
          ...(entry.binary
            ? { bytes: decodeBase64Bytes(entry.body) }
            : { body: decodeBase64Utf8(entry.body) }),
        },
      ]),
    )
  : null;
