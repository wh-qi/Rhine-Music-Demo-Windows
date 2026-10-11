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
  platform: process.platform,
  version,
})
