/**
 * RhineWinService 协议与语义验收（规范 5.1–5.4）。
 *
 * 直接驱动 native/rhine-win-service 的可执行文件：13 个动作、状态字段名、
 * 错误原文、endedSerial / boundarySerial 语义、设备切换保留位置、无缝接续。
 * 真实音频设备一律零音量。可执行文件不存在时显式跳过，绝不伪装通过。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, promises as fs } from 'node:fs'
import { createInterface } from 'node:readline'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const SUFFIX = process.platform === 'win32' ? '.exe' : ''
const EXE = process.env.RHINE_WIN_SERVICE ?? path.join(ROOT, 'native', 'rhine-win-service', 'publish', `rhine-win-service${SUFFIX}`)
const FFMPEG = process.env.FFMPEG_PATH ?? path.join(ROOT, 'ffmpeg', `ffmpeg${SUFFIX}`)
const available = process.platform === 'win32' && existsSync(EXE)
const skip = available ? false : '需要 Windows 与已构建的 rhine-win-service.exe（dotnet publish -c Release -r win-x64）'

const STATE_FIELDS = ['trackId', 'playing', 'currentTime', 'duration', 'volume', 'deviceId', 'endedSerial', 'transitionMode', 'nextTrackId', 'boundarySerial', 'outputSampleRate']
const RAMP_FRAMES = 44100

/** 生成一段递增斜坡的 WAV；相邻样本连续，因此接缝处的丢样/重样可以直接量出来。 */
async function writeRamp(file, { frames = RAMP_FRAMES, rate = 44100, channels = 2, offset = 0 } = {}) {
  const blockAlign = channels * 2
  const dataBytes = frames * blockAlign
  const header = Buffer.alloc(44)
  header.write('RIFF', 0, 'ascii'); header.writeUInt32LE(36 + dataBytes, 4); header.write('WAVE', 8, 'ascii')
  header.write('fmt ', 12, 'ascii'); header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20)
  header.writeUInt16LE(channels, 22); header.writeUInt32LE(rate, 24)
  header.writeUInt32LE(rate * blockAlign, 28); header.writeUInt16LE(blockAlign, 32); header.writeUInt16LE(16, 34)
  header.write('data', 36, 'ascii'); header.writeUInt32LE(dataBytes, 40)
  const body = Buffer.alloc(dataBytes)
  for (let frame = 0; frame < frames; frame++) {
    const value = (((frame + offset) % 20000) - 10000)
    for (let channel = 0; channel < channels; channel++) body.writeInt16LE(value, frame * blockAlign + channel * 2)
  }
  await fs.writeFile(file, Buffer.concat([header, body]))
  return file
}

function startService() {
  const child = spawn(EXE, [], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
  const pending = new Map()
  const stderr = []
  const events = []
  child.stderr.on('data', (chunk) => stderr.push(String(chunk)))
  createInterface({ input: child.stdout }).on('line', (line) => {
    let message
    try { message = JSON.parse(line) } catch { return }
    // 没有 id 的行是服务主动推的事件（SMTC 媒体键）。
    if (message.event) { events.push(message); return }
    const entry = pending.get(message.id)
    if (!entry) return
    pending.delete(message.id)
    entry(message)
  })
  let serial = 0
  const call = (action, params = {}) => new Promise((resolve, reject) => {
    const id = ++serial
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`${action} 超时`)) }, 15000)
    pending.set(id, (message) => { clearTimeout(timer); resolve(message) })
    child.stdin.write(`${JSON.stringify({ id, action, ...params })}\n`)
  })
  return {
    call,
    stderr,
    events,
    async close() {
      child.stdin.end()
      await new Promise((resolve) => setTimeout(resolve, 300))
      child.kill()
    },
  }
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

test('RhineWinService 协议与语义', { skip }, async (t) => {
  const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'rhine-service-check-'))
  const service = startService()
  const mediaKeyService = process.env.RHINE_TEST_MEDIA_KEYS === '1' ? startService() : null
  t.after(() => mediaKeyService?.close())
  t.after(async () => { await service.close(); await fs.rm(scratch, { recursive: true, force: true }) })

  const rampA = await writeRamp(path.join(scratch, 'a.wav'), { offset: 0 })
  const rampB = await writeRamp(path.join(scratch, 'b.wav'), { offset: 7000 })
  const short = await writeRamp(path.join(scratch, 'short.wav'), { frames: 4410 })
  // 24 位样本：用 ffmpeg 生成，验证 32 位容器 + 24 有效位的映射。
  const wide24 = path.join(scratch, 'wide24.wav')
  if (existsSync(FFMPEG)) {
    spawnSync(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'sine=frequency=330:duration=1:sample_rate=44100', '-c:a', 'pcm_s24le', '-y', wide24])
  }

  await t.test('devices 返回有名字的输出设备', async () => {
    const reply = await service.call('devices')
    assert.ok(Array.isArray(reply.result.devices), 'devices 必须是数组')
    for (const device of reply.result.devices) {
      assert.equal(typeof device.id, 'string')
      assert.ok(device.name.length > 0, '设备名不得为空')
    }
  })

  await t.test('state 的字段名与规范 5.2 逐字一致', async () => {
    const { result } = await service.call('state')
    for (const field of STATE_FIELDS) assert.ok(field in result, `缺少字段 ${field}`)
    assert.equal(typeof result.trackId, 'string')
    assert.equal(typeof result.playing, 'boolean')
    assert.equal(typeof result.endedSerial, 'number')
    assert.equal(typeof result.boundarySerial, 'number')
    assert.equal(result.transitionMode, 'fade-in-out', '默认衔接方式是 fade-in-out')
    if (result.error !== undefined) assert.equal(typeof result.error, 'string')
  })

  await t.test('未知动作报「未知音频指令」', async () => {
    const reply = await service.call('nonsense')
    assert.equal(reply.error, '未知音频指令')
  })

  await t.test('无效衔接方式报「无效歌曲衔接方式」', async () => {
    const reply = await service.call('state', { transitionMode: 'crossfade' })
    assert.equal(reply.error, '无效歌曲衔接方式')
  })

  await t.test('缺少下一首音频报「缺少下一首音频」', async () => {
    const reply = await service.call('prepareNext', {})
    assert.equal(reply.error, '缺少下一首音频')
  })

  await t.test('非无缝模式下 prepareNext 报规范原文', async () => {
    await service.call('play', { path: short, trackId: 'short', position: 0, deviceId: 'default', volume: 0, transitionMode: 'fade-in-out' })
    const reply = await service.call('prepareNext', { path: rampB, trackId: 'b' })
    assert.equal(reply.error, '当前未在无缝模式播放，无法预备下一首')
    await service.call('stop')
  })

  await t.test('过期的 afterBoundarySerial 报「当前歌曲已接续，已取消过期预备」', async () => {
    await service.call('play', { path: rampA, trackId: 'a', position: 0, deviceId: 'default', volume: 0, transitionMode: 'gapless' })
    const reply = await service.call('prepareNext', { path: rampB, trackId: 'b', afterTrackId: 'a', afterBoundarySerial: 99 })
    assert.equal(reply.error, '当前歌曲已接续，已取消过期预备')
    await service.call('stop')
  })

  await t.test('真实播放：位置推进且阶段零音量', async () => {
    const started = await service.call('play', { path: rampA, trackId: 'a', position: 0, deviceId: 'default', volume: 0, transitionMode: 'gapless' })
    assert.equal(started.result.playing, true)
    assert.equal(started.result.trackId, 'a')
    assert.equal(started.result.volume, 0, '真实设备测试必须零音量')
    assert.ok(Math.abs(started.result.duration - 1) < 0.05, `时长应约 1 秒，实际 ${started.result.duration}`)
    await wait(400)
    const live = await service.call('state')
    await wait(300)
    const later = await service.call('state')
    assert.ok(later.result.currentTime > live.result.currentTime, '播放位置应当在推进')
    assert.equal(later.result.endedSerial, 0, '播放过程中 endedSerial 必须保持 0')
    await service.call('stop')
  })

  await t.test('pause / seek 保留位置且不自增 endedSerial', async () => {
    await service.call('play', { path: rampA, trackId: 'a', position: 0, deviceId: 'default', volume: 0, transitionMode: 'gapless' })
    await wait(400)
    const paused = await service.call('pause')
    const at = paused.result.currentTime
    assert.equal(paused.result.playing, false)
    await wait(250)
    const steady = await service.call('state')
    assert.equal(steady.result.currentTime, at, '暂停后位置不得继续前进')
    const seeked = await service.call('seek', { position: 0.5 })
    assert.ok(Math.abs(seeked.result.currentTime - 0.5) < 0.01)
    assert.equal(seeked.result.playing, false, 'seek 必须保持原来的暂停状态')
    assert.equal(seeked.result.endedSerial, 0)
    await service.call('stop')
  })

  await t.test('volume 生效且 stop 清空曲目', async () => {
    await service.call('play', { path: rampA, trackId: 'a', position: 0, deviceId: 'default', volume: 0, transitionMode: 'gapless' })
    const louder = await service.call('volume', { volume: 0.25 })
    assert.equal(louder.result.volume, 0.25)
    await service.call('volume', { volume: 0 })
    const stopped = await service.call('stop')
    assert.equal(stopped.result.trackId, '')
    assert.equal(stopped.result.playing, false)
    assert.equal(stopped.result.endedSerial, 0, 'stop 不得自增 endedSerial')
  })

  await t.test('device 切换保留播放位置', async () => {
    const devices = (await service.call('devices')).result.devices
    if (!devices.length) return
    await service.call('play', { path: rampA, trackId: 'a', position: 0, deviceId: 'default', volume: 0, transitionMode: 'gapless' })
    await wait(400)
    const before = await service.call('state')
    const switched = await service.call('device', { deviceId: devices[0].id })
    assert.equal(switched.result.deviceId, devices[0].id)
    assert.ok(Math.abs(switched.result.currentTime - before.result.currentTime) < 0.25, '切换设备后位置必须保持')
    assert.equal(switched.result.playing, before.result.playing, '切换设备后播放状态必须保持')
    await service.call('stop')
  })

  await t.test('无缝接续：boundarySerial 递增且换曲', async () => {
    await service.call('play', { path: rampA, trackId: 'a', position: 0, deviceId: 'default', volume: 0, transitionMode: 'gapless' })
    const prepared = await service.call('prepareNext', { path: rampB, trackId: 'b', afterTrackId: 'a', afterBoundarySerial: 0 })
    if (prepared.error) {
      // 设备拒绝（例如刚切走）时不得静默通过。
      assert.fail(`预备失败：${prepared.error}`)
    }
    assert.equal(prepared.result.nextTrackId, 'b')
    assert.equal(prepared.result.boundarySerial, 0)
    const deadline = Date.now() + 3000
    let promoted = null
    while (Date.now() < deadline) {
      const state = await service.call('state')
      if (state.result.boundarySerial > 0) { promoted = state.result; break }
      await wait(100)
    }
    assert.ok(promoted, '应在当前曲结束前完成接续')
    assert.equal(promoted.trackId, 'b', '接续后当前曲应为下一首')
    assert.equal(promoted.nextTrackId, '', '接续后不应再有预备曲')
    assert.equal(promoted.boundarySerial, 1, 'boundarySerial 恰好自增一次')
    assert.equal(promoted.endedSerial, 0, '接续不是自然结束，endedSerial 不得自增')
    await service.call('stop')
  })

  await t.test('自然播完才自增 endedSerial', async () => {
    await service.call('play', { path: short, trackId: 'short', position: 0, deviceId: 'default', volume: 0, transitionMode: 'gapless' })
    const deadline = Date.now() + 4000
    let ended = 0
    while (Date.now() < deadline) {
      const state = await service.call('state')
      ended = state.result.endedSerial
      if (ended > 0) break
      await wait(100)
    }
    assert.equal(ended, 1, '自然播完后 endedSerial 应为 1')
    await wait(300)
    const after = await service.call('state')
    assert.equal(after.result.endedSerial, 1, '不得重复自增')
    assert.equal(after.result.playing, false)
    await service.call('stop')
  })

  await t.test('输出格式如实上报（P5 数据来源）', async () => {
    await service.call('play', { path: rampA, trackId: 'a', position: 0, deviceId: 'default', volume: 0, transitionMode: 'gapless' })
    const { result } = await service.call('state')
    assert.ok([0, 16, 24, 32].includes(result.outputBits), `outputBits 异常：${result.outputBits}`)
    if (result.outputBits === 32) {
      assert.ok(result.outputValidBits >= 16 && result.outputValidBits <= 32)
      assert.equal(typeof result.outputIsFloat, 'boolean')
    }
    assert.ok(typeof result.outputSampleRate === 'number' && result.outputSampleRate > 0)
    assert.ok(['shared', 'exclusive'].includes(result.shareMode))
    // 24 位必须是 32 位容器 + wValidBitsPerSample=24（规范 5.6 的位深映射）
    const wide = await service.call('play', { path: wide24, trackId: 'w', position: 0, deviceId: 'default', volume: 0, transitionMode: 'gapless' })
    if (!wide.error) {
      const state = (await service.call('state')).result
      assert.equal(state.outputBits, 32, '24 位音频必须以 32 位容器输出')
      assert.equal(state.outputValidBits, 24, '有效位深必须如实为 24')
    }
    await service.call('stop')
  })

  await t.test('三种衔接方式都可设置', async () => {
    for (const mode of ['fade-out', 'fade-in-out', 'gapless']) {
      const reply = await service.call('transition', { transitionMode: mode })
      assert.equal(reply.result.transitionMode, mode)
    }
    const legacy = await service.call('transition', { fadeEnabled: true })
    assert.equal(legacy.result.transitionMode, 'fade-in-out')
    const off = await service.call('transition', { fadeEnabled: false })
    assert.equal(off.result.transitionMode, 'gapless')
  })

  await t.test('cancelNext 清空预备曲且不动 boundarySerial', async () => {
    await service.call('play', { path: rampA, trackId: 'a', position: 0, deviceId: 'default', volume: 0, transitionMode: 'gapless' })
    const before = await service.call('state')
    await service.call('prepareNext', { path: rampB, trackId: 'b', afterTrackId: 'a', afterBoundarySerial: before.result.boundarySerial })
    const withNext = await service.call('state')
    assert.equal(withNext.result.nextTrackId, 'b', '预备成功后应报出下一首')
    const cancelled = await service.call('cancelNext')
    assert.equal(cancelled.result.nextTrackId, '', '取消后不应再有预备曲')
    assert.equal(cancelled.result.boundarySerial, before.result.boundarySerial, '取消预备不得改动 boundarySerial')
    await service.call('stop')
  })
})

// 注入系统级媒体键会影响机器上其它播放器，因此默认不跑。
test('SMTC 媒体键与锁屏元数据', { skip: available ? (process.env.RHINE_TEST_MEDIA_KEYS === '1' ? false : '默认跳过（会注入系统级媒体键）；设 RHINE_TEST_MEDIA_KEYS=1 打开') : skip }, async (t) => {
  const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'rhine-media-key-'))
  const service = startService()
  t.after(async () => { await service.close(); await fs.rm(scratch, { recursive: true, force: true }) })
  const ramp = await writeRamp(path.join(scratch, 'ramp.wav'), { frames: 44100 * 30 })

  await service.call('play', {
    path: ramp, trackId: 'smtc', position: 0, deviceId: 'default', volume: 0, transitionMode: 'gapless',
    metadata: { title: '锁屏测试曲目', artist: 'Rhine 合成样本', album: '格式回归' },
  })
  await new Promise((resolve) => setTimeout(resolve, 1500))

  const script = [
    'Add-Type @"',
    'using System; using System.Runtime.InteropServices;',
    'public class KeySender { [DllImport("user32.dll")] public static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, UIntPtr dwExtraInfo); }',
    '"@',
    'foreach ($vk in 0xB3, 0xB0, 0xB1) {',
    '  [KeySender]::keybd_event([byte]$vk, 0, 0, [UIntPtr]::Zero)',
    '  Start-Sleep -Milliseconds 60',
    '  [KeySender]::keybd_event([byte]$vk, 0, 2, [UIntPtr]::Zero)',
    '  Start-Sleep -Milliseconds 500',
    '}',
  ].join('\n')
  spawnSync('powershell', ['-NoProfile', '-Command', script], { encoding: 'utf8' })
  await new Promise((resolve) => setTimeout(resolve, 1500))

  const buttons = service.events.filter((event) => event.event === 'media').map((event) => event.button)
  assert.deepEqual(buttons, ['toggle', 'next', 'previous'], `应收到三个媒体键事件，实际 ${JSON.stringify(buttons)}`)

  // 系统读回来的会话必须带着刚才那首曲子的信息
  const read = spawnSync(EXE, ['--smtc-read'], { encoding: 'utf8', windowsHide: true })
  assert.match(read.stderr ?? '', /title=锁屏测试曲目/)
  assert.match(read.stderr ?? '', /status=Playing/)
  await service.call('pause')
  await new Promise((resolve) => setTimeout(resolve, 1200))
  const paused = spawnSync(EXE, ['--smtc-read'], { encoding: 'utf8', windowsHide: true })
  assert.match(paused.stderr ?? '', /status=Paused/)
  await service.call('stop')
})

test('WAV 解析拒绝非 PCM WAV', async (t) => {
  const service = startService()
  t.after(() => service.close())
  const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'rhine-service-bad-'))
  t.after(() => fs.rm(scratch, { recursive: true, force: true }))
  const bogus = path.join(scratch, 'bogus.wav')
  await fs.writeFile(bogus, Buffer.from('not a wav file at all, really', 'utf8'))
  const reply = await service.call('play', { path: bogus, trackId: 'x', position: 0, deviceId: 'default', volume: 0 })
  assert.ok(reply.error, '损坏文件必须报错而不是静默播放')
  assert.match(reply.error, /RIFF|WAV/)
})
