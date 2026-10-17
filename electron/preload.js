// 预加载脚本：只暴露桌面外壳必需的成员，其余一律不进入渲染进程。
const { contextBridge, ipcRenderer, webUtils } = require('electron')

const prefix = '--rhine-version='
const version = process.argv.find((item) => item.startsWith(prefix))?.slice(prefix.length) ?? ''

contextBridge.exposeInMainWorld('rhineDesktop', {
  showOpenDirectories: () => ipcRenderer.invoke('dialog:openDirectories'),
  // 拖拽进来的 File 在渲染进程里没有绝对路径，必须回主进程取（Electron 32+ 的替代方案）。
  pathForFile: (file) => webUtils.getPathForFile(file),
  onTransport: (handler) => {
    const listener = (_event, action) => handler(action)
    ipcRenderer.on('rhine:transport', listener)
    return () => ipcRenderer.removeListener('rhine:transport', listener)
  },
  // 启动期开关（垂直同步等）由主进程持有，因为 Chromium 只在启动时决定这些。
  getStartupFlags: () => ipcRenderer.invoke('settings:getStartupFlags'),
  setStartupFlag: (flag, value) => ipcRenderer.invoke('settings:setStartupFlag', flag, value),
  // 歌曲文件位置：渲染进程拿不到绝对路径（快照里已剔除 _path），
  // 所以由主进程按曲目 id 解析后再交给系统文件管理器。
  revealTrack: (trackId) => ipcRenderer.invoke('rhine:revealTrack', trackId),
  platform: process.platform,
  version,
})
