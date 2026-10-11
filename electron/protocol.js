import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { createRequire } from 'node:module'
import { handleApi, toNodeRequest } from '../scripts/music-server.mjs'

// Electron 的 ESM 外观没有导出 net，只能用 require 拿。
const { net } = createRequire(import.meta.url)('electron')

function json(status, data) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
  })
}

/** dist/ 下的静态资源。net.fetch 走 Electron 自己的 file:// 处理器，不做任何路径拼接假设。 */
async function serveStatic(distDir, url) {
  let route
  try { route = decodeURIComponent(url.pathname) } catch { return json(400, { error: '无效路径' }) }
  if (route.includes('\0') || route.includes('\\')) return json(400, { error: '无效路径' })
  const file = path.resolve(distDir, `.${route === '/' ? '/index.html' : route}`)
  const relative = path.relative(distDir, file)
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return json(403, { error: '无效路径' })
  try {
    return await net.fetch(pathToFileURL(file).toString())
  } catch {
    return new Response('Not Found', { status: 404, headers: { 'Content-Type': 'text/plain; charset=utf-8' } })
  }
}

/**
 * app:// 协议处理：/api/* 交给 music-server.mjs 的 handleApi，其余从 dist/ 提供静态资源。
 * 自定义协议不经 TCP 端口，天然只在本机；仍校验 Origin，拒绝跨站点访问本地曲库。
 */
export function createAppProtocol({ store, decoder, output, distDir, appOrigin }) {
  return async function handleAppRequest(request) {
    const url = new URL(request.url)
    if (url.pathname.startsWith('/api/')) return handleApi(toNodeRequest(request), url, { store, decoder, output, distDir, origin: appOrigin })
    const origin = request.headers.get('origin')
    if (origin && origin !== appOrigin) return json(403, { error: '不接受跨站点访问本地曲库' })
    return serveStatic(distDir, url)
  }
}
