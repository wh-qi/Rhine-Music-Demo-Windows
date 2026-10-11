import path from 'node:path'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { createMusicRuntime } from '../scripts/music-server.mjs'
import { createAppProtocol } from './protocol.js'

// Electron 的 ESM 外观没有提供具名导出（cjs-module-lexer 无法静态识别它动态挂载的成员），
// 主进程统一用 require('electron') 取内置模块。
const require = createRequire(import.meta.url)
const { app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, protocol, screen, shell, Tray } = require('electron')

const ELECTRON_DIR = path.dirname(fileURLToPath(import.meta.url))
const PROJECT_DIR = path.dirname(ELECTRON_DIR)
const DIST_DIR = path.join(PROJECT_DIR, 'dist')
const PRELOAD_PATH = path.join(ELECTRON_DIR, 'preload.js')
const APP_ORIGIN = 'app://-'
const VERSION = process.env.RHINE_VERSION ?? '0.4.1'
// 打包后内置二进制由 electron-builder 解包到 resources/unpacked；开发时留在工程目录。
const UNPACKED = app.isPackaged ? path.join(process.resourcesPath, 'unpacked') : PROJECT_DIR

// ① 自定义协议：standard + secure + supportFetchAPI + stream（必须在 app ready 之前注册）
// allowServiceWorkers 是规范给的权限集之外必须补的一项：缺少它时 Chromium 对 app:// 直接禁用
// Service Worker API，music-app.ts 启动时调用的 navigator.serviceWorker.getRegistrations() 会抛
// InvalidStateError，整个 start() 被拒绝，界面永远停在开场动画。
// 补上之后该调用返回空数组，行为与浏览器一致，且 src/ 保持零改动。
protocol.registerSchemesAsPrivileged([
  { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, allowServiceWorkers: true } },
])
// ② 双显卡笔记本走独显
app.commandLine.appendSwitch('force_high_performance_gpu')

// 用户数据统一放 %LOCALAPPDATA%\RhineMusic：不写 Roaming，也不写安装目录（安装目录只读）。
const LOCAL_APP_DATA = process.env.LOCALAPPDATA ?? path.join(app.getPath('home'), 'AppData', 'Local')
const USER_DIR = path.join(LOCAL_APP_DATA, 'RhineMusic')
app.setPath('userData', USER_DIR)
const STATE_FILE = path.join(USER_DIR, 'window-state.json')
const SETTINGS_FILE = path.join(USER_DIR, 'settings.json')

// 无边框窗口需要可拖拽区域；仓库的视觉代码不允许改动，因此由主进程注入一条最小规则。
const DRAG_CSS = '#rhine-drag-strip{position:fixed;top:0;left:0;right:140px;height:12px;-webkit-app-region:drag;z-index:2147483647}'
const DRAG_SCRIPT = `(() => {
  if (document.getElementById('rhine-drag-strip')) return
  const strip = document.createElement('div')
  strip.id = 'rhine-drag-strip'
  document.body.appendChild(strip)
})()`

let mainWindow = null
let runtime = null
let tray = null
let quitting = false

function readSettings() {
  try { return JSON.parse(readFileSync(SETTINGS_FILE, 'utf8')) ?? {} } catch { return {} }
}
function writeSettings(value) {
  try { mkdirSync(USER_DIR, { recursive: true }); writeFileSync(SETTINGS_FILE, JSON.stringify(value, null, 2)) } catch {}
}

// ⑤ 窗口尺寸 / 位置 / 最大化记忆
function readWindowState() {
  try {
    const state = JSON.parse(readFileSync(STATE_FILE, 'utf8'))
    const value = { width: Number(state.width), height: Number(state.height), maximized: state.maximized === true }
    const x = Number(state.x), y = Number(state.y)
    const onScreen = Number.isFinite(x) && Number.isFinite(y) && screen.getAllDisplays().some((display) => {
      const area = display.bounds
      return x < area.x + area.width && x + value.width > area.x && y < area.y + area.height && y + value.height > area.y
    })
    if (Number.isFinite(value.width) && value.width >= 800) value.width = Math.round(value.width)
    else delete value.width
    if (Number.isFinite(value.height) && value.height >= 600) value.height = Math.round(value.height)
    else delete value.height
    if (onScreen) { value.x = Math.round(x); value.y = Math.round(y) }
    return value
  } catch { return null }
}

function saveWindowState(win) {
  try {
    const maximized = win.isMaximized()
    const bounds = maximized || win.isMinimized() || win.isFullScreen() ? win.getNormalBounds() : win.getBounds()
    mkdirSync(USER_DIR, { recursive: true })
    writeFileSync(STATE_FILE, JSON.stringify({ ...bounds, maximized }))
  } catch {}
}

/** 内置 FFmpeg 与原生音频服务：绝对路径写进环境变量，music-audio.mjs 的覆盖机制会直接采用。 */
function prepareBinaries() {
  const exe = process.platform === 'win32' ? '.exe' : ''
  const ffmpeg = path.join(UNPACKED, 'ffmpeg', `ffmpeg${exe}`)
  const ffprobe = path.join(UNPACKED, 'ffmpeg', `ffprobe${exe}`)
  if (existsSync(ffmpeg) && existsSync(ffprobe)) {
    process.env.FFMPEG_PATH = ffmpeg
    process.env.FFPROBE_PATH = ffprobe
  }
  if (process.platform !== 'win32') return
  const candidates = [
    path.join(UNPACKED, 'rhine-win-service.exe'),
    path.join(PROJECT_DIR, 'native', 'rhine-win-service', 'publish', 'rhine-win-service.exe'),
    path.join(PROJECT_DIR, 'native', 'rhine-win-service', 'rhine-win-service.exe'),
  ]
  const service = candidates.find((candidate) => existsSync(candidate))
  if (service) process.env.RHINE_WIN_SERVICE = service
}

/** RHINE_DEBUG=1 时把渲染进程的关键环境事实打到主进程日志，便于定位 app:// 与 Web 平台的差异。 */
async function probeRenderer(win) {
  const source = `(async () => {
    const out = { secure: window.isSecureContext, origin: location.origin, hasSW: 'serviceWorker' in navigator, desktop: typeof window.rhineDesktop, platform: window.rhineDesktop?.platform, version: window.rhineDesktop?.version }
    try { await navigator.serviceWorker.getRegistrations(); out.serviceWorker = 'ok' } catch (error) { out.serviceWorker = error.name + ': ' + error.message }
    try { localStorage.setItem('rhine-probe', '1'); out.localStorage = 'ok' } catch (error) { out.localStorage = error.name }
    try { await caches.open('rhine-probe'); out.caches = 'ok' } catch (error) { out.caches = error.name }
    try { out.indexedDB = String(!!window.indexedDB) } catch (error) { out.indexedDB = error.name }
    return JSON.stringify(out)
  })()`
  try { console.log('[probe]', await win.webContents.executeJavaScript(source)) } catch (error) { console.error('[probe]', error.message) }
}

async function createWindow() {
  const state = readWindowState() ?? {}
  const win = new BrowserWindow({
    frame: false,                     // 无边框 + 原生窗口按钮覆盖层，贴合暗色玻璃设计
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: '#0b0d12', symbolColor: '#e8eaf0', height: 32 },
    backgroundColor: '#0b0d12',       // 与主题一致，避免白闪
    show: false,                      // ready-to-show 后再显示
    width: state.width ?? 1290, height: state.height ?? 871,   // 与 macOS 参考视口一致
    ...(state.x === undefined ? {} : { x: state.x, y: state.y }),
    minWidth: 1024, minHeight: 640,
    webPreferences: {
      backgroundThrottling: false,    // 硬性要求：失焦不得降频
      contextIsolation: true,
      nodeIntegration: false,
      additionalArguments: [`--rhine-version=${VERSION}`],
      preload: PRELOAD_PATH,
    },
  })
  if (state.maximized) win.maximize()
  win.once('ready-to-show', () => win.show())

  // ④ 外链走系统浏览器（代码里有 GitHub / 资料来源外链）
  win.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url)
    return { action: 'deny' }
  })
  win.webContents.on('will-navigate', (event, url) => {
    if (url.startsWith(APP_ORIGIN)) return
    event.preventDefault()
    void shell.openExternal(url)
  })
  // 渲染进程的控制台错误与加载失败必须能在主进程日志里看到，否则问题只在窗口里一闪而过。
  win.webContents.on('console-message', (event) => {
    const level = typeof event.level === 'string' ? event.level : ['debug', 'info', 'warning', 'error'][event.level] ?? 'info'
    if (level === 'error' || process.env.RHINE_DEBUG) console.log(`[renderer:${level}] ${event.message ?? ''}`)
  })
  win.webContents.on('did-fail-load', (_event, code, description, url) => console.error(`[renderer] 加载失败 ${code} ${description} ${url}`))
  win.webContents.on('render-process-gone', (_event, details) => console.error(`[renderer] 进程退出 ${details.reason}`))
  win.webContents.on('preload-error', (_event, preload, error) => { console.error(`[preload] ${preload} ${error.message}`); process.exitCode = 1 })
  win.webContents.on('did-finish-load', () => {
    void win.webContents.insertCSS(DRAG_CSS)
    void win.webContents.executeJavaScript(DRAG_SCRIPT)
    if (process.env.RHINE_DEBUG) void probeRenderer(win)
  })

  if (process.env.RHINE_DEBUG) {
    // 失焦不降频是硬性要求，这里周期性把渲染进程的帧率读数打到主进程日志以便核验。
    const sampler = setInterval(() => {
      void win.webContents.executeJavaScript(`[...document.querySelectorAll('*')].filter((el) => !el.children.length && /FPS/.test(el.textContent)).map((el) => el.textContent.trim()).join(' | ')`)
        .then((text) => console.log(`[fps] ${text}`)).catch(() => {})
    }, 4000)
    win.on('closed', () => clearInterval(sampler))
  }

  let timer = null
  const schedule = () => { clearTimeout(timer); timer = setTimeout(() => saveWindowState(win), 400) }
  win.on('resize', schedule)
  win.on('move', schedule)
  win.on('maximize', schedule)
  win.on('unmaximize', schedule)
  win.on('close', (event) => {
    clearTimeout(timer)
    saveWindowState(win)
    if (quitting) return
    // showMessageBox 是异步的，必须同步先拦住这次关闭，再决定是退出还是隐藏到托盘。
    event.preventDefault()
    void decideClose(win)
  })

  await win.loadURL(`${APP_ORIGIN}/index.html`)
  return win
}

function showMainWindow() {
  if (!mainWindow) return
  if (mainWindow.isMinimized()) mainWindow.restore()
  mainWindow.show()
  mainWindow.focus()
}

function sendTransport(action) {
  if (!mainWindow) return
  mainWindow.webContents.send('rhine:transport', action)
}

/** 托盘：播放/暂停、上一首、下一首、显示主窗口、退出。 */
function createTray() {
  if (tray) return tray
  const source = nativeImage.createFromPath(path.join(DIST_DIR, 'icons', 'icon-192.png'))
  tray = new Tray(source.isEmpty() ? nativeImage.createEmpty() : source.resize({ width: 16, height: 16 }))
  tray.setToolTip('Rhine Music')
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: '播放 / 暂停', click: () => sendTransport('toggle') },
    { label: '上一首', click: () => sendTransport('previous') },
    { label: '下一首', click: () => sendTransport('next') },
    { label: '显示主窗口', click: showMainWindow },
    { label: '退出', click: () => { quitting = true; app.quit() } },
  ]))
  tray.on('double-click', showMainWindow)
  return tray
}

/** 关闭窗口时的行为：首次询问并记住选择（退出 / 留在托盘继续播放）。 */
async function decideClose(win) {
  const settings = readSettings()
  let behavior = settings.closeBehavior
  if (behavior !== 'exit' && behavior !== 'tray') {
    const result = await dialog.showMessageBox(win, {
      type: 'question',
      buttons: ['退出', '留在托盘'],
      defaultId: 1,
      cancelId: 1,
      title: 'Rhine Music',
      message: '要退出 Rhine Music 吗？',
      detail: '选择「留在托盘」会继续在后台播放，之后可以从托盘图标重新打开窗口。',
      checkboxLabel: '记住我的选择',
      checkboxChecked: false,
    })
    behavior = result.response === 0 ? 'exit' : 'tray'
    if (result.checkboxChecked) writeSettings({ ...settings, closeBehavior: behavior })
  }
  if (behavior === 'tray') win.hide()
  else { quitting = true; app.quit() }
}

async function start() {
  prepareBinaries()
  runtime = await createMusicRuntime()
  // 原生服务经 SMTC 收到媒体键后推事件上来，直接复用托盘那条 rhine:transport 通道。
  runtime.output.onMediaKey = (action) => { if (mainWindow) mainWindow.webContents.send('rhine:transport', action) }
  protocol.handle('app', createAppProtocol({ ...runtime, distDir: DIST_DIR, appOrigin: APP_ORIGIN }))
  ipcMain.handle('dialog:openDirectories', async (event) => {
    const parent = BrowserWindow.fromWebContents(event.sender) ?? mainWindow
    const result = await dialog.showOpenDialog(parent, { title: '选择音乐文件夹', buttonLabel: '添加', properties: ['openDirectory', 'multiSelections'] })
    return result.canceled ? [] : result.filePaths
  })
  mainWindow = await createWindow()
  createTray()
  void runtime.store.scan().catch(() => {})
}

function shutdown() {
  runtime?.decoder.dispose()
  runtime?.output.dispose()
  runtime = null
}

// ③ 单实例锁
if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (!mainWindow) return
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.show()
    mainWindow.focus()
  })
  app.on('window-all-closed', () => { shutdown(); app.quit() })
  app.on('before-quit', shutdown)
  app.whenReady().then(start).catch((error) => {
    dialog.showErrorBox('Rhine Music 启动失败', error?.message ?? String(error))
    app.quit()
  })
}
