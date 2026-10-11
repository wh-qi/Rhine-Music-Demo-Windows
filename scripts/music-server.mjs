import http from 'node:http'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { promises as fs, createReadStream } from 'node:fs'
import { PassThrough, Readable, Writable } from 'node:stream'
import { MusicLibraryStore, safeRootList } from './music-library.mjs'
import { AudioDecoder, NativeAudioOutput, defaultDataDir } from './music-audio.mjs'

const PROJECT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.woff': 'font/woff', '.woff2': 'font/woff2', '.glb': 'model/gltf-binary', '.gltf': 'model/gltf+json', '.wav': 'audio/wav', '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg', '.opus': 'audio/ogg', '.ico': 'image/x-icon', '.webmanifest': 'application/manifest+json' }
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]'])

function json(response, status, data) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
  response.end(JSON.stringify(data))
}

async function bodyJson(request) {
  if (!request.headers['content-type']?.toLowerCase().startsWith('application/json')) throw Object.assign(new Error('请使用 application/json 请求体'), { status: 415 })
  let size = 0
  const chunks = []
  for await (const chunk of request) {
    size += chunk.length
    if (size > 128 * 1024) throw Object.assign(new Error('请求体过大'), { status: 413 })
    chunks.push(chunk)
  }
  const value = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('JSON 请求体必须是对象')
  return value
}

/** Returns null for no Range; false for invalid or unsatisfiable single ranges. */
export function parseRange(header, size) {
  if (header === undefined) return null
  const match = /^bytes=(\d*)-(\d*)$/.exec(header)
  if (!match || (!match[1] && !match[2]) || size === 0) return false
  let start
  let end
  if (!match[1]) {
    const suffix = Number(match[2])
    if (!Number.isSafeInteger(suffix) || suffix <= 0) return false
    start = Math.max(0, size - suffix)
    end = size - 1
  } else {
    start = Number(match[1])
    end = match[2] ? Number(match[2]) : size - 1
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start >= size || end < start) return false
    end = Math.min(end, size - 1)
  }
  return { start, end }
}

async function serveFile(request, response, descriptor, { cache = 'no-cache' } = {}) {
  const [actualPath, actualRoot] = await Promise.all([fs.realpath(descriptor.path), fs.realpath(descriptor.allowedRoot)])
  const relative = path.relative(actualRoot, actualPath)
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw Object.assign(new Error('文件已移出配置的音乐目录'), { status: 403 })
  const stat = await fs.stat(actualPath)
  if (!stat.isFile()) throw Object.assign(new Error('文件不存在'), { status: 404 })
  const range = parseRange(request.headers.range, stat.size)
  const headers = {
    'Content-Type': descriptor.mime ?? MIME[path.extname(actualPath).toLowerCase()] ?? 'application/octet-stream',
    'Accept-Ranges': 'bytes', 'Cache-Control': cache,
    'Last-Modified': stat.mtime.toUTCString(), 'X-Content-Type-Options': 'nosniff',
  }
  if (range === false) {
    response.writeHead(416, { ...headers, 'Content-Range': `bytes */${stat.size}`, 'Content-Length': 0 })
    response.end()
    return
  }
  if (range) {
    headers['Content-Range'] = `bytes ${range.start}-${range.end}/${stat.size}`
    headers['Content-Length'] = range.end - range.start + 1
  } else headers['Content-Length'] = stat.size
  response.writeHead(range ? 206 : 200, headers)
  if (request.method === 'HEAD' || stat.size === 0) return response.end()
  const stream = createReadStream(actualPath, range ?? {})
  stream.on('error', () => response.destroy())
  response.on('close', () => stream.destroy())
  stream.pipe(response)
}

/** Node ServerResponse 的等价物：把路由写入收集成 Fetch Response，供 Electron 的 app:// 协议返回。 */
class ResponseSink extends Writable {
  #status = 200
  #headers = {}
  #sent = false
  #body = new PassThrough()
  get headersSent() { return this.#sent }
  setHeader(name, value) { this.#headers[name] = value; return this }
  writeHead(status, headers) { this.#status = status; Object.assign(this.#headers, headers ?? {}); this.#sent = true; return this }
  _write(chunk, encoding, callback) { this.#body.write(chunk, encoding, callback) }
  _final(callback) { this.#body.end(callback) }
  destroy(error) { this.#body.destroy(); return super.destroy(error) }
  toResponse() { return new Response(Readable.toWeb(this.#body), { status: this.#status, headers: this.#headers }) }
}

function respondError(response, error) {
  if (!response.headersSent) json(response, error.status ?? (['ENOENT', 'ENOTDIR'].includes(error.code) ? 404 : 400), { error: error.message })
  else response.destroy()
}

/** 原 createMusicServer 内部的路由分支逐行搬入：判断顺序、状态码与响应体保持不变。 */
async function routeApi(request, url, response, { store, decoder, output, distDir }) {
  const route = decodeURIComponent(url.pathname)
  if (route.includes('\0') || route.includes('\\')) return json(response, 400, { error: '无效路径' })
  const get = request.method === 'GET' || request.method === 'HEAD'
  if (route === '/api/health' && get) return json(response, 200, { service: 'rhine-local-music', projectDir: PROJECT_DIR, pid: process.pid })
  if (route === '/api/audio/capabilities' && get) {
    await decoder.init()
    let devices = [], nativeError = null
    // 原生输出按平台选择：darwin 走 CoreAudio，win32 走内置的 RhineWinService。
    const nativePlatform = process.platform === 'darwin' || process.platform === 'win32'
    let nativeFormat = null
    if (decoder.ffmpeg && nativePlatform) {
      try { devices = await output.devices() } catch (error) { nativeError = error.message }
      // 只增不改：P5 需要如实显示当前实际输出格式。darwin 侧没有这些字段，保持原样。
      if (!nativeError && process.platform === 'win32') {
        try {
          const state = await output.command({ action: 'state' })
          if (state.outputNegotiated === true)
            nativeFormat = { sampleRate: state.outputSampleRate, bits: state.outputBits, validBits: state.outputValidBits, isFloat: state.outputIsFloat, shareMode: state.shareMode, bitPerfect: state.bitPerfect === true }
        } catch {}
      }
    }
    return json(response, 200, { decoderAvailable: !!decoder.ffmpeg, decoder: decoder.version ?? null, decoderError: decoder.error ?? null, nativeAvailable: !!decoder.ffmpeg && nativePlatform && !nativeError, nativeError, devices: [{ id: 'default', name: '系统默认输出' }, ...devices], mode: 'shared', formats: ['APE', 'WAV', 'FLAC', 'ALAC', 'AIFF', 'MP3', 'AAC', 'OGG', 'OPUS', 'WV', 'DSF', 'DFF'], dsdPlayback: 'pcm', nativeFormat })
  }
  const prepare = /^\/api\/audio\/prepare\/([a-zA-Z0-9-]+)$/.exec(route)
  const decodedAudio = /^\/api\/decoded-audio\/([a-zA-Z0-9-]+)$/.exec(route)
  if ((prepare && request.method === 'POST') || (decodedAudio && get)) {
    if (prepare) await bodyJson(request)
    const id = (prepare ?? decodedAudio)[1]
    const controller = new AbortController()
    const cancel = () => { if (!response.writableEnded) controller.abort() }
    response.once('close', cancel)
    try {
      const decoded = await decoder.prepare(store.trackFile(id), { signal: controller.signal })
      if (prepare) {
        const { path: _path, allowedRoot: _root, ...metadata } = decoded
        return json(response, 200, { ...metadata, audioUrl: `/api/decoded-audio/${id}` })
      }
      return await serveFile(request, response, decoded, { cache: 'private, no-cache' })
    } finally { response.removeListener('close', cancel) }
  }
  if (route === '/api/output/state' && get) return json(response, 200, await output.command({ action: 'state' }))
  if (route === '/api/output/command' && request.method === 'POST') return json(response, 200, await output.command(await bodyJson(request)))
  if (route === '/api/library' && get) {
    // A user or Codex can edit genre-rules.json while the player is running.
    await store.reloadRules()
    return json(response, 200, store.snapshot())
  }
  if (route === '/api/library/scan' && request.method === 'POST') {
    const value = await bodyJson(request)
    if (store.scanPromise) return json(response, 202, store.snapshot())
    const roots = value.roots === undefined ? undefined : safeRootList(value.roots)
    void store.scan({ roots }).catch(() => {})
    return json(response, 202, store.snapshot())
  }
  if (route === '/api/genre-rules' && get) {
    await store.reloadRules()
    return json(response, 200, store.rules)
  }
  if (route === '/api/genre-rules' && request.method === 'POST') return json(response, 200, await store.updateRules(await bodyJson(request)))
  if (['/api/config', '/api/library/config'].includes(route)) {
    if (get) return json(response, 200, { ...store.config, musicBrainzConfigured: !!store.musicBrainzContact })
    if (request.method === 'POST') {
      const value = await bodyJson(request)
      if (value.roots !== undefined && store.scanPromise) return json(response, 409, { error: '正在扫描，请完成后再更改根目录' })
      return json(response, 200, { ...await store.updateConfig(value), musicBrainzConfigured: !!store.musicBrainzContact })
    }
  }
  if (route === '/api/library/enrich' && request.method === 'POST') {
    const value = await bodyJson(request)
    if (!store.musicBrainzContact) return json(response, 400, { error: '在线资料库尚未配置：请在资料库设置填写自己的联系邮箱或项目网址。音乐仍可本地播放。' })
    if (value.albumIds !== undefined && (!Array.isArray(value.albumIds) || value.albumIds.some((id) => typeof id !== 'string'))) return json(response, 400, { error: 'albumIds 必须是专辑 ID 数组' })
    void store.enrich({ albumIds: value.albumIds, force: true }).catch(() => {})
    return json(response, 202, store.snapshot())
  }
  if (route === '/api/library/introductions' && request.method === 'POST') {
    const value = await bodyJson(request)
    if (value.albumIds !== undefined && (!Array.isArray(value.albumIds) || value.albumIds.length > 10000 || value.albumIds.some((id) => typeof id !== 'string'))) return json(response, 400, { error: 'albumIds 必须是专辑 ID 数组' })
    if (value.force !== undefined && typeof value.force !== 'boolean') return json(response, 400, { error: 'force 必须为布尔值' })
    void store.updateIntroductions({ albumIds: value.albumIds, force: value.force ?? false }).catch(() => {})
    return json(response, 202, store.snapshot())
  }
  if (route === '/api/library/credits' && request.method === 'POST') {
    const value = await bodyJson(request)
    if (value.albumIds !== undefined && (!Array.isArray(value.albumIds) || value.albumIds.length > 10000 || value.albumIds.some((id) => typeof id !== 'string'))) return json(response, 400, { error: 'albumIds 必须是专辑 ID 数组' })
    if (value.force !== undefined && typeof value.force !== 'boolean') return json(response, 400, { error: 'force 必须为布尔值' })
    void store.updateCredits({ albumIds: value.albumIds, force: value.force ?? false }).catch(() => {})
    return json(response, 202, store.snapshot())
  }
  const audio = /^\/api\/audio\/([a-zA-Z0-9-]+)$/.exec(route)
  const artwork = /^\/api\/artwork\/([a-zA-Z0-9-]+)$/.exec(route)
  if ((audio || artwork) && get) {
    const file = audio ? store.trackFile(audio[1]) : store.artworkFile(artwork[1])
    if (!file) return json(response, 404, { error: '索引中没有此文件' })
    return await serveFile(request, response, file, { cache: artwork ? 'private, max-age=3600' : 'private, no-cache' })
  }
  if (route === '/api/foobar/status' && get) return json(response, 200, { configured: !!store.config.foobarBaseUrl, baseUrl: store.config.foobarBaseUrl, connected: false, note: 'configured 仅代表已保存地址；连接状态需读取 /api/foobar/player 实际响应。' })
  if (route.startsWith('/api/foobar/')) {
    if (!store.config.foobarBaseUrl) return json(response, 503, { error: 'foobar2000 / Beefweb 尚未配置连接' })
    const suffix = route.slice('/api/foobar/'.length)
    if (!/^[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+)*$/.test(suffix) || !['GET', 'POST'].includes(request.method)) return json(response, 400, { error: '不支持的 Beefweb 请求' })
    const target = new URL(`/api/${suffix}`, store.config.foobarBaseUrl)
    target.search = url.search
    const payload = request.method === 'POST' ? JSON.stringify(await bodyJson(request)) : undefined
    const upstream = await fetch(target, { method: request.method, body: payload, headers: payload ? { 'Content-Type': 'application/json' } : {}, signal: AbortSignal.timeout(5000), redirect: 'error' })
    response.writeHead(upstream.status, { 'Content-Type': upstream.headers.get('content-type') ?? 'application/json', 'Cache-Control': 'no-store' })
    response.end(Buffer.from(await upstream.arrayBuffer()))
    return
  }
  if (route.startsWith('/api/')) return json(response, 404, { error: 'API 不存在或请求方法不支持' })
  if (!get) return json(response, 405, { error: '只接受 GET/HEAD' })
  const asset = path.resolve(distDir, `.${route === '/' ? '/index.html' : route}`)
  return await serveFile(request, response, { path: asset, allowedRoot: distDir }, { cache: route.startsWith('/assets/') ? 'public, max-age=31536000, immutable' : 'no-cache' })
}

/** Fetch Request → handleApi 需要的 Node 风格请求（method / headers / 可异步迭代的 body）。 */
export function toNodeRequest(request) {
  const url = new URL(request.url)
  return {
    method: request.method,
    url: `${url.pathname}${url.search}`,
    headers: Object.fromEntries(request.headers),
    async *[Symbol.asyncIterator]() {
      if (!request.body) return
      const reader = request.body.getReader()
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        yield Buffer.from(value)
      }
    },
  }
}

/**
 * 路由纯函数：HTTP 服务与 Electron 的 app:// 协议共用同一份实现。
 * @param request Node 风格请求（method / headers / 可异步迭代的 body）
 * @param url     已解析的绝对 URL；HTTP 传输层在 host 校验后构造
 * @param context { response?, store, decoder, output, distDir, origin? }
 *        传入 response 时写入该 Node 风格响应对象；不传则返回 Fetch Response。
 *        origin 是本次传输的可信来源：HTTP 用 Host 推出的源，app:// 用协议层声明的应用源。
 */
export async function handleApi(request, url, context) {
  const response = context.response ?? new ResponseSink()
  response.setHeader('X-Content-Type-Options', 'nosniff')
  response.setHeader('Referrer-Policy', 'same-origin')
  try {
    // 跨站点校验放在这里，两种传输共用同一份判断，避免各写一遍后慢慢走样。
    if (request.headers.origin && request.headers.origin !== (context.origin ?? url.origin)) json(response, 403, { error: '不接受跨站点访问本地曲库' })
    else await routeApi(request, url, response, context)
  } catch (error) {
    respondError(response, error)
  }
  return context.response ?? response.toResponse()
}

/** 建立曲库、解码器与原生输出的共享运行时，HTTP 服务与 Electron 主进程复用同一份接线。 */
export async function createMusicRuntime({ dataDir = defaultDataDir(PROJECT_DIR), defaultRoots = [], store: providedStore } = {}) {
  const store = providedStore ?? await new MusicLibraryStore({ dataDir, defaultRoots }).init()
  const decoder = new AudioDecoder({ dataDir: store.dataDir ?? dataDir })
  // 锁屏与媒体面板需要曲目信息。直接读索引，避免每次播放都做一次完整快照。
  const trackInfo = (id) => {
    for (const album of store.index.albums) {
      if (!store.config.roots.includes(album._root)) continue
      const track = album.tracks.find((entry) => entry.id === id)
      if (track) return { title: track.title ?? '', artist: track.artist ?? '', album: album.title ?? '' }
    }
    return null
  }
  const output = new NativeAudioOutput({ dataDir: store.dataDir ?? dataDir, decoder, trackFile: (id) => store.trackFile(id), trackInfo })
  return { store, decoder, output }
}

export async function createMusicServer({
  dataDir = defaultDataDir(PROJECT_DIR),
  distDir = path.join(PROJECT_DIR, 'dist'),
  defaultRoots = process.env.MUSIC_ROOTS ? process.env.MUSIC_ROOTS.split(path.delimiter).filter(Boolean) : [],
  store: providedStore,
  autoScan = true,
} = {}) {
  const { store, decoder, output } = await createMusicRuntime({ dataDir, defaultRoots, store: providedStore })
  const server = http.createServer(async (request, response) => {
    try {
      // HTTP 传输层校验，与抽出前逐字一致：Host 必须指向本机（Origin 同源校验在 handleApi 内）。
      const host = new URL(`http://${request.headers.host ?? ''}`)
      if (!LOOPBACK.has(host.hostname)) return json(response, 403, { error: '本服务仅接受 localhost 请求' })
      const url = new URL(request.url, host)
      await handleApi(request, url, { response, store, decoder, output, distDir })
    } catch (error) {
      respondError(response, error)
    }
  })
  server.once('close', () => { decoder.dispose(); output.dispose() })
  server.requestTimeout = 30_000
  if (autoScan) server.once('listening', () => { void store.scan().catch(() => {}) })
  return { server, store, decoder, output }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const portFlag = process.argv.indexOf('--port')
  const port = Number(portFlag >= 0 ? process.argv[portFlag + 1] : process.env.PORT ?? 5173)
  const { server, store } = await createMusicServer()
  server.on('error', (error) => { console.error(error.message); process.exitCode = 1 })
  server.listen(port, '127.0.0.1', () => {
    console.log(`Rhine Local Music  http://127.0.0.1:${port}/`)
    console.log(`音乐索引：${store.dataDir}`)
    console.log(`音乐目录：${store.config.roots.join('、') || '尚未配置，在界面添加目录'}`)
  })
  const close = () => { server.close(() => process.exit()); server.closeAllConnections() }
  process.once('SIGINT', close)
  process.once('SIGTERM', close)
}
