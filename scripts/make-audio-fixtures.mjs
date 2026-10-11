/**
 * 生成实现规范 6.2 要求的 12 种容器/编码的回归样本。
 *
 * 全部为本地合成的正弦波（无版权素材），唯一的例外是 APE：
 * FFmpeg 没有 Monkey's Audio 编码器，必须由外部提供样本文件（--ape 或 RHINE_APE_SAMPLE）。
 * 缺少 APE 样本时脚本明确报告跳过，绝不把其它格式的结果当作 APE 验收。
 *
 * 用法：
 *   node scripts/make-audio-fixtures.mjs [--out DIR] [--ape FILE] [--ffmpeg PATH]
 */
import { createHash } from 'node:crypto'
import { existsSync, promises as fs } from 'node:fs'
import { spawn } from 'node:child_process'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createDsdFixture } from './fixtures/dsd.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.dirname(HERE)

function flag(name, fallback) {
  const index = process.argv.indexOf(`--${name}`)
  return index >= 0 ? process.argv[index + 1] : fallback
}

const OUT = path.resolve(flag('out', process.env.RHINE_FIXTURE_DIR ?? path.join(os.tmpdir(), 'rhine-format-matrix')))
const APE_SAMPLE = flag('ape', process.env.RHINE_APE_SAMPLE ?? '')
const FFMPEG = flag('ffmpeg', process.env.FFMPEG_PATH ?? path.join(ROOT, 'ffmpeg', process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg'))

function run(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-nostdin', ...args], { windowsHide: true })
    let errors = ''
    child.stderr.on('data', (chunk) => { errors = (errors + chunk).slice(-4000) })
    child.on('error', reject)
    child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg 退出码 ${code}: ${errors.trim()}`))))
  })
}

const seconds = '3'
const tone = (frequency, rate) => ['-f', 'lavfi', '-i', `sine=frequency=${frequency}:duration=${seconds}:sample_rate=${rate}`]

/** 每张专辑一张纯色封面，用来验证嵌入封面的读取路径。 */
async function cover(file, color) {
  try {
    await run(['-f', 'lavfi', '-i', `color=c=${color}:s=600x600:d=1`, '-frames:v', '1', '-y', file])
    return true
  } catch { return false }
}

// WAV / AAC / AIFF 等容器不接受 attached_pic，带封面失败就退回不带封面重试。
async function encode(options) {
  try { await encodeOnce(options) }
  catch (error) {
    if (!options.coverFile) throw error
    await encodeOnce({ ...options, coverFile: undefined })
  }
}

async function encodeOnce({ file, frequency = 440, rate = 44100, codec = [], tags = {}, coverFile }) {
  const args = [...tone(frequency, rate)]
  if (coverFile) args.push('-i', coverFile)
  args.push('-map', '0:a:0')
  if (coverFile) args.push('-map', '1:v:0', '-c:v', 'mjpeg', '-disposition:v:0', 'attached_pic')
  args.push(...codec, '-map_metadata', '-1')
  for (const [key, value] of Object.entries(tags)) args.push('-metadata', `${key}=${value}`)
  args.push('-y', file)
  await run(args)
}

const FORMATS = [
  { ext: '.flac', label: 'FLAC', codec: ['-c:a', 'flac'] },
  { ext: '.wav', label: 'WAV', codec: ['-c:a', 'pcm_s24le'] },
  { ext: '.m4a', label: 'ALAC', codec: ['-c:a', 'alac'] },
  { ext: '.mp3', label: 'MP3', codec: ['-c:a', 'libmp3lame', '-b:a', '192k'] },
  { ext: '.aac', label: 'AAC', codec: ['-c:a', 'aac', '-b:a', '192k', '-f', 'adts'] },
  { ext: '.aiff', label: 'AIFF', codec: ['-c:a', 'pcm_s16be'] },
  { ext: '.ogg', label: 'OGG/Vorbis', codec: ['-c:a', 'libvorbis', '-q:a', '5'] },
  { ext: '.opus', label: 'Opus', codec: ['-c:a', 'libopus', '-b:a', '128k'] },
  { ext: '.wv', label: 'WavPack', codec: ['-c:a', 'wavpack'] },
  { ext: '.wma', label: 'WMA', codec: ['-c:a', 'wmav2', '-b:a', '192k'] },
]

const report = { generated: [], skipped: [] }

async function makeMatrix(outDir) {
  const album = '格式回归'
  const dir = path.join(outDir, album)
  await fs.mkdir(dir, { recursive: true })
  const coverFile = path.join(dir, 'cover.png')
  const hasCover = await cover(coverFile, '0x2b4c6f')
  let track = 1
  for (const format of FORMATS) {
    const safeLabel = format.label.replace(/[\\/:*?"<>|]/g, '-')
    const name = `${String(track).padStart(2, '0')} ${safeLabel}${format.ext}`
    const file = path.join(dir, name)
    await encode({
      file, frequency: 220 + track * 55, codec: format.codec, coverFile: hasCover ? coverFile : undefined,
      tags: { title: `${format.label} 回归样本`, artist: 'Rhine 合成样本', album, track: String(track) },
    })
    report.generated.push(path.relative(outDir, file))
    track += 1
  }
  // DSF / DFF：由仓库内的合成 DSD 生成器产出，不经 ffmpeg 编码。
  for (const [index, format] of ['dsf', 'dff'].entries()) {
    const fixture = createDsdFixture({ format, duration: 1 })
    const file = path.join(dir, `${String(track).padStart(2, '0')} ${format.toUpperCase()}${format === 'dff' ? '.dff' : '.dsf'}`)
    await fs.writeFile(file, fixture.buffer)
    report.generated.push(path.relative(outDir, file))
    track += 1
    void index
  }
  // APE：FFmpeg 无编码器，只能由外部样本提供。
  if (APE_SAMPLE && existsSync(APE_SAMPLE)) {
    const file = path.join(dir, `${String(track).padStart(2, '0')} APE.ape`)
    await fs.copyFile(APE_SAMPLE, file)
    report.generated.push(path.relative(outDir, file))
  } else {
    report.skipped.push('APE（未提供样本：FFmpeg 没有 Monkey 的 Audio 编码器，请用 --ape FILE 指定，或设置 RHINE_APE_SAMPLE）')
  }
  if (hasCover) await fs.rm(coverFile, { force: true })
}

async function makeHiRes(outDir) {
  const album = '高解析度'
  const dir = path.join(outDir, album)
  await fs.mkdir(dir, { recursive: true })
  const items = [
    { name: '01 FLAC 96k.flac', rate: 96000, codec: ['-c:a', 'flac'], frequency: 330 },
    { name: '02 FLAC 192k.flac', rate: 192000, codec: ['-c:a', 'flac'], frequency: 440 },
    { name: '03 WAV 96k 24bit.wav', rate: 96000, codec: ['-c:a', 'pcm_s24le'], frequency: 550 },
    { name: '04 FLAC 48k.flac', rate: 48000, codec: ['-c:a', 'flac'], frequency: 660 },
  ]
  for (const [index, item] of items.entries()) {
    const file = path.join(dir, item.name)
    await encode({ file, frequency: item.frequency, rate: item.rate, codec: item.codec, tags: { title: item.name.replace(/^\d+ /, '').replace(/\.[^.]+$/, ''), artist: 'Rhine 合成样本', album, track: String(index + 1) } })
    report.generated.push(path.relative(outDir, file))
  }
}

async function makeSingles(outDir) {
  const items = [
    { name: '独奏 MP3.mp3', codec: ['-c:a', 'libmp3lame', '-b:a', '192k'] },
    { name: '独奏 FLAC.flac', codec: ['-c:a', 'flac'] },
  ]
  for (const [index, item] of items.entries()) {
    const file = path.join(outDir, item.name)
    await encode({ file, frequency: 880 + index * 110, codec: item.codec, tags: { title: item.name.replace(/\.[^.]+$/, ''), artist: 'Rhine 合成样本' } })
    report.generated.push(path.relative(outDir, file))
  }
}

await fs.mkdir(OUT, { recursive: true })
await makeMatrix(OUT)
await makeHiRes(OUT)
await makeSingles(OUT)

const digest = createHash('sha256')
for (const relative of [...report.generated].sort()) digest.update(await fs.readFile(path.join(OUT, relative)))
console.log(`样本目录 ${OUT}`)
console.log(`已生成 ${report.generated.length} 个文件，内容摘要 ${digest.digest('hex').slice(0, 16)}`)
for (const relative of report.generated) console.log(`  ${relative}`)
for (const item of report.skipped) console.log(`  跳过：${item}`)
if (report.skipped.length) process.exitCode = 0
