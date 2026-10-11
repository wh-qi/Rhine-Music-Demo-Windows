/**
 * Windows 桌面版的协议层回归。
 *
 * 这里不启动 Electron，而是用 Fetch Request 直接调用 handleApi —— 与
 * electron/protocol.js 在 app:// 协议里走的完全是同一段代码，所以能自动
 * 覆盖路由、校验、Range、静态目录越界与 12 种格式的实际解码。
 *
 * 样本来自 scripts/make-audio-fixtures.mjs；缺少样本时显式跳过，不伪装通过。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createMusicRuntime, handleApi, toNodeRequest } from './music-server.mjs'
import { safeRootList } from './music-library.mjs'

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const DIST = path.join(ROOT, 'dist')
const FIXTURES = path.resolve(process.env.RHINE_FIXTURE_DIR ?? path.join(os.tmpdir(), 'rhine-format-matrix'))
// 规范 6.2 的 12 种容器/编码，缺一不可。
const MATRIX = [
  ['FLAC', '.flac'], ['WAV', '.wav'], ['ALAC', '.m4a'], ['MP3', '.mp3'],
  ['AAC', '.aac'], ['AIFF', '.aiff'], ['OGG/Vorbis', '.ogg'], ['Opus', '.opus'],
  ['WavPack', '.wv'], ['WMA', '.wma'], ['DSF', '.dsf'], ['DFF', '.dff'], ['APE', '.ape'],
]
const APP_ORIGIN = 'app://-'

// 与 electron/main.js 的 prepareBinaries() 保持一致：优先用随包分发的 LGPL FFmpeg。
const SUFFIX = process.platform === 'win32' ? '.exe' : ''
const BUNDLED_FFMPEG = path.join(ROOT, 'ffmpeg', `ffmpeg${SUFFIX}`)
if (!process.env.FFMPEG_PATH && existsSync(BUNDLED_FFMPEG)) {
  process.env.FFMPEG_PATH = BUNDLED_FFMPEG
  process.env.FFPROBE_PATH = path.join(ROOT, 'ffmpeg', `ffprobe${SUFFIX}`)
}

function appRequest(route, { method = 'GET', headers = {}, body } = {}) {
  return {
    method,
    url: `${APP_ORIGIN}${route}`,
    headers: new Headers(headers),
    body: body === undefined ? null : new ReadableStream({
      start(controller) { controller.enqueue(new TextEncoder().encode(body)); controller.close() },
    }),
  }
}

function call(route, options) {
  const request = appRequest(route, options)
  return handleApi(toNodeRequest(request), new URL(request.url), context)
}

const post = (route, value = {}) => call(route, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(value) })

/** 解析 PCM WAV 的 fmt/data，并算出前若干帧的 RMS —— 用来证明真的解码出了信号。 */
function pcmStats(buffer) {
  assert.equal(buffer.toString('ascii', 0, 4), 'RIFF', '不是 RIFF')
  assert.equal(buffer.toString('ascii', 8, 12), 'WAVE', '不是 WAVE')
  let offset = 12
  let bits = 0, channels = 0, sampleRate = 0, format = 0, dataStart = 0, dataSize = 0
  while (offset + 8 <= buffer.length) {
    const id = buffer.toString('ascii', offset, offset + 4)
    const size = buffer.readUInt32LE(offset + 4)
    if (id === 'fmt ') {
      format = buffer.readUInt16LE(offset + 8)
      channels = buffer.readUInt16LE(offset + 10)
      sampleRate = buffer.readUInt32LE(offset + 12)
      bits = buffer.readUInt16LE(offset + 22)
      if (format === 0xfffe) format = buffer.readUInt16LE(offset + 32)
    }
    if (id === 'data') { dataStart = offset + 8; dataSize = size; break }
    offset += 8 + size + (size % 2)
  }
  assert.ok(dataStart > 0 && dataSize > 0, '没有 data 块')
  const width = bits / 8
  const frames = Math.min(Math.floor(dataSize / width / channels), sampleRate)
  let sum = 0
  for (let frame = 0; frame < frames; frame++) {
    for (let channel = 0; channel < channels; channel++) {
      const at = dataStart + (frame * channels + channel) * width
      const value = format === 3 ? buffer.readFloatLE(at)
        : width === 1 ? buffer.readInt8(at) / 128
        : width === 2 ? buffer.readInt16LE(at) / 32768
        : width === 3 ? ((buffer.readUInt8(at) | (buffer.readUInt8(at + 1) << 8) | (buffer.readInt8(at + 2) << 16)) / 8388608)
        : buffer.readInt32LE(at) / 2147483648
      sum += value * value
    }
  }
  return { bits, channels, sampleRate, bytes: dataSize, rms: Math.sqrt(sum / (frames * channels)) }
}

const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'rhine-desktop-check-'))
const { store, decoder, output } = await createMusicRuntime({ dataDir: scratch })
const context = { store, decoder, output, distDir: DIST, origin: APP_ORIGIN }

let available = false
let tracks = []
try {
  await store.scan({ roots: safeRootList([FIXTURES]) })
  await store.scanPromise
  tracks = store.snapshot().albums.flatMap((album) => album.tracks.map((track) => ({ album, track })))
  available = tracks.length > 0
} catch (error) {
  console.error(`曲库样本不可用（${FIXTURES}）：${error.message}`)
}
if (!available) console.error(`曲库样本目录为空：${FIXTURES}，请先运行 node scripts/make-audio-fixtures.mjs`)
const sourceOf = (id) => store.trackFile(id)?.path ?? ''

test.after(async () => {
  decoder.dispose()
  output.dispose()
  await fs.rm(scratch, { recursive: true, force: true })
})

test('app:// 路由保持与 HTTP 服务一致的状态码与响应体', async (t) => {
  await t.test('健康检查', async () => {
    const response = await call('/api/health')
    assert.equal(response.status, 200)
    const value = await response.json()
    assert.equal(value.service, 'rhine-local-music')
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff')
    assert.equal(response.headers.get('referrer-policy'), 'same-origin')
  })
  await t.test('未知 API 返回 404 且文案不变', async () => {
    const response = await call('/api/nope')
    assert.equal(response.status, 404)
    assert.deepEqual(await response.json(), { error: 'API 不存在或请求方法不支持' })
  })
  await t.test('反斜杠与 NUL 路径被拒', async () => {
    for (const route of ['/api/audio/a\\b', '/api/audio/a%00b']) {
      const response = await call(route)
      assert.equal(response.status, 400, route)
      assert.deepEqual(await response.json(), { error: '无效路径' })
    }
  })
  await t.test('POST 必须带 JSON 内容类型', async () => {
    const response = await call('/api/library/scan', { method: 'POST', body: '{}' })
    assert.equal(response.status, 415)
  })
  await t.test('非 GET/HEAD 的静态请求返回 405', async () => {
    const response = await call('/index.html', { method: 'PUT' })
    assert.equal(response.status, 405)
  })
  await t.test('跨站点 Origin 被拒', async () => {
    const request = appRequest('/api/library')
    request.headers.set('origin', 'https://evil.example')
    const response = await handleApi(toNodeRequest(request), new URL(request.url), context)
    assert.equal(response.status, 403)
    assert.deepEqual(await response.json(), { error: '不接受跨站点访问本地曲库' })
  })
  await t.test('本应用 Origin 放行', async () => {
    const request = appRequest('/api/library')
    request.headers.set('origin', APP_ORIGIN)
    const response = await handleApi(toNodeRequest(request), new URL(request.url), context)
    assert.equal(response.status, 200)
  })
})

test('dist/ 静态资源与索引存在', async () => {
  assert.ok(existsSync(path.join(DIST, 'index.html')), '请先运行 npm run build')
  assert.ok(existsSync(path.join(DIST, 'sw.js')))
  const html = await fs.readFile(path.join(DIST, 'index.html'), 'utf8')
  assert.match(html, /RHINE MUSIC/)
})

test('规范 6.2 的全部容器/编码解码为有效 PCM', { skip: !available && '需要先运行 make-audio-fixtures.mjs' }, async (t) => {
  const observed = new Map()

  for (const [label, extension] of MATRIX) {
    await t.test(`${label} (${extension})`, async () => {
      const item = tracks.find((entry) => sourceOf(entry.track.id).toLowerCase().endsWith(extension))
      assert.ok(item, `曲库里没有 ${label} 样本`)
      const id = item.track.id

      const prepared = await post(`/api/audio/prepare/${id}`)
      const payload = await prepared.text()
      assert.equal(prepared.status, 200, payload)
      const metadata = JSON.parse(payload)
      assert.ok(['pcm_s16le', 'pcm_s24le', 'pcm_s32le', 'pcm_f32le'].includes(metadata.pcmCodec), metadata.pcmCodec)
      assert.ok(metadata.duration > 0.5, `时长异常 ${metadata.duration}`)
      assert.ok(metadata.channels >= 1)
      assert.equal(metadata.audioUrl, `/api/decoded-audio/${id}`)
      observed.set(label, { codec: item.track.codec, container: path.extname(sourceOf(id)).slice(1), sampleRate: metadata.sampleRate, bits: metadata.bitsPerSample })

      const response = await call(`/api/decoded-audio/${id}`)
      assert.equal(response.status, 200)
      assert.equal(response.headers.get('accept-ranges'), 'bytes')
      assert.equal(response.headers.get('content-type'), 'audio/wav')
      const buffer = Buffer.from(await response.arrayBuffer())
      assert.equal(Number(response.headers.get('content-length')), buffer.length)
      const stats = pcmStats(buffer)
      assert.ok(stats.rms > 0.001, `解码结果是静音，RMS=${stats.rms}`)
      assert.equal(stats.channels, metadata.channels)
      assert.equal(stats.sampleRate, metadata.sampleRate)
    })
  }
  console.log('    实际解码结果：')
  for (const [label, value] of observed) console.log(`      ${label.padEnd(12)} ${String(value.codec).padEnd(18)} .${value.container}  ${value.sampleRate} Hz / ${value.bits} bit`)
})

test('拖动进度条依赖的 Range 语义', { skip: !available && '需要样本' }, async () => {
  const track = tracks[0].track
  assert.ok(track, '曲库为空')

  const full = await call(`/api/decoded-audio/${track.id}`)
  const size = Number(full.headers.get('content-length'))
  await full.arrayBuffer()
  assert.ok(size > 1024)

  const head = await call(`/api/decoded-audio/${track.id}`, { headers: { range: 'bytes=0-1023' } })
  assert.equal(head.status, 206)
  assert.equal(head.headers.get('content-range'), `bytes 0-1023/${size}`)
  assert.equal(head.headers.get('content-length'), '1024')
  assert.equal((await head.arrayBuffer()).byteLength, 1024)

  const tail = await call(`/api/decoded-audio/${track.id}`, { headers: { range: `bytes=${size - 100}-` } })
  assert.equal(tail.status, 206)
  assert.equal((await tail.arrayBuffer()).byteLength, 100)

  const suffix = await call(`/api/decoded-audio/${track.id}`, { headers: { range: 'bytes=-64' } })
  assert.equal(suffix.status, 206)
  assert.equal((await suffix.arrayBuffer()).byteLength, 64)

  const broken = await call(`/api/decoded-audio/${track.id}`, { headers: { range: `bytes=${size}-` } })
  assert.equal(broken.status, 416)
  assert.equal(broken.headers.get('content-range'), `bytes */${size}`)
  await broken.arrayBuffer()
})

test('播放不改写源文件', { skip: !available && '需要样本' }, async () => {
  const track = tracks[0].track
  const file = sourceOf(track.id)
  const before = await fs.stat(file)
  const digest = createHash('sha256').update(await fs.readFile(file)).digest('hex')
  const prepared = await post(`/api/audio/prepare/${track.id}`)
  assert.equal(prepared.status, 200)
  await prepared.arrayBuffer()
  const decoded = await call(`/api/decoded-audio/${track.id}`)
  await decoded.arrayBuffer()
  const after = await fs.stat(file)
  assert.equal(after.mtimeMs, before.mtimeMs, 'mtime 被改写')
  assert.equal(after.size, before.size, '大小被改写')
  assert.equal(createHash('sha256').update(await fs.readFile(file)).digest('hex'), digest, '内容被改写')
})

test('目录越界被拒', async () => {
  const response = await call('/api/audio/..%2f..%2fpackage.json')
  assert.ok([400, 404].includes(response.status), `得到 ${response.status}`)
  await response.arrayBuffer()
})
