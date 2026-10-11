// 取出 BtbN/FFmpeg-Builds 的 LGPL 构建里的 ffmpeg.exe / ffprobe.exe 与许可文件。
// 用法：node ffmpeg/fetch-ffmpeg.mjs [--force]
// 只下载 LGPL 变体（--disable-gpl --disable-nonfree 的等价产物），不取 ffplay。
import { createWriteStream, existsSync } from 'node:fs'
import { copyFile, mkdir, readdir, rm, stat } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const WINDOWS = process.platform === 'win32'
const EXE = WINDOWS ? '.exe' : ''
const ASSET = 'ffmpeg-n8.1-latest-win64-lgpl-8.1.zip'
const RELEASE_URL = `https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/${ASSET}`
// GitHub 的 release 资源在国内经常被限速到几十 KB/s。默认走可用的加速前缀，
// 用 FFMPEG_MIRROR 覆盖（设为空字符串表示直连 GitHub）。
const MIRRORS = [process.env.FFMPEG_MIRROR ?? 'https://gh-proxy.com/', 'https://ghproxy.net/', '']
const TARGETS = [`ffmpeg${EXE}`, `ffprobe${EXE}`]
const FORCE = process.argv.includes('--force')

if (!WINDOWS) {
  console.log('此脚本面向 Windows 构建；其它平台请自行安装 FFmpeg，或设置 FFMPEG_PATH / FFPROBE_PATH。')
}
if (!FORCE && TARGETS.every((name) => existsSync(path.join(HERE, name)))) {
  console.log('内置 FFmpeg 已存在，跳过下载。需要重新下载请加 --force。')
  process.exit(0)
}

function run(binary, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, { stdio: ['ignore', 'inherit', 'inherit'], windowsHide: true })
    child.on('error', reject)
    child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`${binary} 退出码 ${code}`))))
  })
}

const archive = path.join(HERE, '.download.zip')
const staging = path.join(HERE, '.staging')
await mkdir(HERE, { recursive: true })
await rm(archive, { force: true })
await rm(staging, { recursive: true, force: true })

/** 30 秒没有任何新字节就判定为卡死，交给下一个镜像。 */
async function download(url) {
  const controller = new AbortController()
  const response = await fetch(url, { redirect: 'follow', signal: controller.signal })
  if (!response.ok) { controller.abort(); throw new Error(`HTTP ${response.status}`) }
  const total = Number(response.headers.get('content-length') ?? 0)
  const sink = createWriteStream(archive)
  let received = 0
  let reported = Date.now()
  let lastByte = Date.now()
  const watchdog = setInterval(() => {
    if (Date.now() - lastByte > 30000) { controller.abort(); sink.destroy() }
  }, 5000)
  try {
    for await (const chunk of response.body) {
      lastByte = Date.now()
      if (!sink.write(chunk)) await once(sink, 'drain')
      received += chunk.length
      if (total && Date.now() - reported > 10000) {
        reported = Date.now()
        console.log(`  ${(received / 1048576).toFixed(1)} / ${(total / 1048576).toFixed(1)} MB`)
      }
    }
    await new Promise((resolve, reject) => sink.end(() => resolve()).on('error', reject))
  } finally { clearInterval(watchdog) }
  return received
}

console.log(`下载 ${ASSET}`)
let received = 0
for (const mirror of MIRRORS) {
  const url = `${mirror}${RELEASE_URL}`
  console.log(`来源 ${mirror === '' ? '直连 GitHub' : mirror}`)
  await rm(archive, { force: true })
  try {
    received = await download(url)
    if (received < 1024 * 1024) throw new Error(`只收到 ${received} 字节`)
    break
  } catch (error) {
    console.log(`  失败：${error.message}，换下一个来源`)
    received = 0
  }
}
if (!received) throw new Error('所有来源都下载失败，请设置 FFMPEG_MIRROR 或手动放置 ffmpeg.exe / ffprobe.exe')
console.log(`  已下载 ${(received / 1048576).toFixed(1)} MB`)

await mkdir(staging, { recursive: true })
await run('tar', ['-xf', archive, '-C', staging])
const [root] = (await readdir(staging)).filter((name) => !name.startsWith('.'))
if (!root) throw new Error('压缩包结构不符合预期')
const bin = path.join(staging, root, 'bin')
for (const name of TARGETS) await copyFile(path.join(bin, name), path.join(HERE, name))
for (const name of ['LICENSE.txt', 'README.txt']) {
  if (existsSync(path.join(staging, root, name))) await copyFile(path.join(staging, root, name), path.join(HERE, name))
}
await rm(staging, { recursive: true, force: true })
await rm(archive, { force: true })

for (const name of TARGETS) {
  const info = await stat(path.join(HERE, name))
  console.log(`${name}  ${(info.size / 1048576).toFixed(1)} MB`)
}
console.log('完成。electron-builder 会把 ffmpeg/ 复制到 resources/unpacked/ffmpeg。')
