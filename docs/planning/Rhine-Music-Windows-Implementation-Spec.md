# Rhine Music for Windows · 实现规范（Implementation Specification）

| | |
| --- | --- |
| **文档性质** | **实现规范，不是建议书。** 执行方按此实现，不得自行发挥。 |
| **目标产物** | Windows 独立桌面应用：双击 `.exe` 即用，不用自带浏览器，纯本地，**还原 macOS V0.4.1，效果优先** |
| **基准代码** | `Rhine-Music-Demo` V0.4.1 @ `dd2370f` |
| **前端改动** | 仅 2 个文件（`src/pwa.ts`、`src/music-app.ts`），**视觉代码零改动** |
| **后端改动** | `scripts/music-server.mjs`、`scripts/music-audio.mjs`；**`scripts/music-library.mjs` 零改动** |

---

## 0. 执行规则（先读这一节）

### 0.1 强制规则

1. **按阶段执行。** 第 7 节每阶段有验收门，**未通过不得进入下一阶段**。
2. **遇到规范未覆盖的情况：停下来提问，不要自行决定。**
3. **所有"必须"项都是硬性要求，不得以"更好的做法"为由替换。**
4. **所有"禁止"项都是硬性禁令，不得以"顺手优化"为由违反。**
5. 改动前先 `git init` 到独立分支，**不改写既有 Git 历史**。

### 0.2 「还原」的定义（可验收）

> **还原 = 同一份输入，Windows 版的可见行为与 macOS V0.4.1 逐项一致。**

具体到可验证的层面：

| 维度 | 还原要求 |
| --- | --- |
| 视觉 | 几何、材质、光照、相机、波浪、磨砂玻璃、`clip-path`、字轮、分阶段过渡 —— **逐像素一致** |
| 排版 | 130 KB CSS 不变；横竖屏、超宽屏、响应式断点行为一致 |
| 交互 | 方向键/滚轮/Enter/Space/`V`/`Esc`/搜索快捷键行为一致 |
| 动效 | 开场时间轴、动效倍率、减少动态效果支持一致 |
| 产品行为 | 播放/界面音效/氛围音乐相互独立；搜索定位不改变播放；真实列独立浏览且首尾停止；列浏览记忆默认开启 |
| 画质档 | 四档预设值与默认档**不变** |
| 数据 | `music-data-v3` 目录结构、`MUSIC_DATA_DIR` 覆盖、只读源文件、目录越界校验 |
| 音频 | 见第 6 节 |

### 0.3 「效果优先」的定义

> **效果优先 = 在所有取舍中，选择更好听、更好看、更稳的那一个，而不是更省事的那一个。**

已为执行方做完的取舍（**不要重新权衡**）：

| 取舍 | 决定 | 理由 |
| --- | --- | --- |
| 自带 Chromium vs 系统 WebView2 | **自带**（Electron） | 渲染可复现，不随系统 Edge 更新而变 |
| 默认音频模式 | **独占** | 效果优先；自动回退保证不出错 |
| 是否重写后端 | **不重写** | `music-metadata` 对 APE/DSD 标签支持成熟，重写有回归风险 |
| 是否降默认画质档 | **不降** | 已 60 FPS，降档是拿效果换性能 |
| FFmpeg | **内置完整 LGPL 构建** | 正确性优先于体积；最小构建留作 P6 可选 |
| DSD | 默认转 PCM，DoP 为可选 | 兼容性优先 |

---

## 1. 禁止事项（不要自由发挥）

**以下每一条都是禁令。违反即视为不合格。**

### 1.1 禁止改动

| 禁止 | 范围 |
| --- | --- |
| ❌ 改视觉代码 | `src/scene.ts`、`src/cover-atlas.ts`、`src/model-viewer.ts`、`src/music-lighting.ts`、`src/music-boot.ts`、`src/music-title.ts`、`src/music-ruler.ts`、全部 `*.css` |
| ❌ 改渲染管线 | 不得合并/删除/新增后处理 pass；不得改 `EffectComposer` 结构 |
| ❌ 改默认画质 | `src/render-quality.ts` 四档预设值与默认档不得变 |
| ❌ 改渲染优化 | 不得动 `frustumCulled`、不得加 LOD、不得加图集压缩（**均留给 P6 且必须带视觉对照**） |
| ❌ 改曲库逻辑 | `scripts/music-library.mjs` **一行都不改** |
| ❌ 改解码参数 | `music-audio.mjs` 里 ffmpeg 命令行的解码/编码参数（除非第 5.3 节明确列出） |
| ❌ 改既有 API 契约 | `/api/*` 的路径、请求体、响应体结构 |
| ❌ 改产品行为 | 见 0.2「产品行为」一行 |
| ❌ 引入新框架 | 不得引入 React/Vue/Svelte/Tailwind 等；不得改构建链（保持 tsc + vite） |
| ❌ 改构建产物结构 | `dist/` 的布局、`build-pwa.mjs` 行为 |

### 1.2 禁止行为

- ❌ **不得"顺手优化"任何规范未要求的东西**
- ❌ **不得把 UI 文案改成规范未给出的措辞**
- ❌ **不得引入遥测、崩溃上报、联网检查更新以外的新网络行为**（默认关闭）
- ❌ **不得让服务监听 `0.0.0.0`** —— 必须仅本机
- ❌ **不得以"性能"为由降低画质、动效或音频质量**
- ❌ **不得用"关闭淡入淡出"或 `HTMLAudio.preload` 冒充无缝播放** —— 必须音频时钟连续排程
- ❌ **不得把模拟测试称为真实格式/设备验收**
- ❌ **不得提交**真实歌曲、封面缓存、索引、令牌、本机绝对路径

---

## 2. 目标架构

```
RhineMusic.exe  (Electron，自带固定版 Chromium)
│
├─ 主进程（内置 Node 22）
│   ├─ electron/protocol.js   ── app:// 自定义协议（取代 HTTP，无 TCP 端口）
│   │      ├─ app://-/api/*   → 调用 music-server.mjs 抽出的 handleApi()
│   │      └─ 其它             → dist/ 静态资源（保留 Range）
│   ├─ scripts/music-library.mjs   ── 零改动
│   ├─ scripts/music-audio.mjs     ── 仅按 5.3 节改动
│   └─ dialog / shell / tray / 单实例
│
├─ 渲染进程（固定版 Chromium）
│   └─ app://-/index.html      ── dist/ 原样；视觉零改动
│
├─ native/rhine-win-service/rhine-win-service.exe  (C# / .NET 8)
│   ├─ WASAPI 共享/独占 + 逐曲采样率与位深协商
│   ├─ 双槽精确帧排程（无缝播放）
│   ├─ 设备枚举与热插拔
│   ├─ SMTC（媒体键 / 锁屏 / 音量 OSD）
│   └─ JSON-lines 协议 ←→ music-audio.mjs（协议逐字不变）
│
└─ resources/unpacked/
    ├─ ffmpeg/ffmpeg.exe, ffprobe.exe
    └─ rhine-win-service.exe
```

---

## 3. 组件 A · Electron 外壳

新建 `electron/` 目录。

### 3.1 `electron/main.js` 必须包含的配置

```js
// ① 自定义协议：standard + secure + supportFetchAPI + stream
protocol.registerSchemesAsPrivileged([{
  scheme: "app",
  privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true },
}]);

// ② 双显卡笔记本走独显
app.commandLine.appendSwitch("force_high_performance_gpu");

// ③ 单实例锁
if (!app.requestSingleInstanceLock()) app.quit();
app.on("second-instance", () => { if (win) { if (win.isMinimized()) win.restore(); win.focus(); } });

const win = new BrowserWindow({
  frame: false,                 // 无边框 + 自绘标题栏，贴合暗色玻璃设计
  backgroundColor: "#0b0d12",   // 与主题一致，避免白闪
  show: false,                  // ready-to-show 后再显示
  width: 1290, height: 871,     // 与 macOS 参考视口一致
  webPreferences: {
    backgroundThrottling: false,   // ⚠️ 硬性要求：失焦不得降频
    contextIsolation: true,
    nodeIntegration: false,
    preload: PRELOAD_PATH,
  },
});
win.once("ready-to-show", () => win.show());

// ④ 外链走系统浏览器（代码里有 GitHub / 资料来源外链）
win.webContents.setWindowOpenHandler(({ url }) => { shell.openExternal(url); return { action: "deny" }; });

// ⑤ 窗口尺寸/位置/最大化记忆（用 electron 的 electron-store 或自写 JSON，存 %LOCALAPPDATA%）
```

### 3.2 `protocol.handle("app")` 规格

```js
protocol.handle("app", async (request) => {
  const url = new URL(request.url);          // app://-/api/library
  if (url.pathname.startsWith("/api/")) return handleApi(request, url);       // 见 4.1
  const file = path.join(DIST_DIR, url.pathname === "/" ? "/index.html" : url.pathname);
  return net.fetch(pathToFileURL(file).toString());   // 保留 Range，音频拖动必需
});
```

**必须验证**：`net.fetch(file://)` 保留 `Range` 头支持。用大 FLAC 拖动进度条验证。

### 3.3 `electron/preload.js` 暴露的 API（仅这几个）

```js
contextBridge.exposeInMainWorld("rhineDesktop", {
  showOpenDirectories: () => ipcRenderer.invoke("dialog:openDirectories"),  // 返回 string[]
  platform: "win32",
  version: APP_VERSION,
});
```

### 3.4 托盘

- 托盘图标 + 菜单：`播放/暂停`、`上一首`、`下一首`、`显示主窗口`、`退出`
- 关闭窗口时行为可选（退出 / 留在托盘播放），**记住选择**

---

## 4. 组件 B · 后端复用与改动

### 4.1 `scripts/music-server.mjs`

**唯一改动**：把 `createMusicServer` 内部的路由分支**抽成纯函数**，供 Electron 直接调用。

```js
// 新增导出，签名必须是这个
export async function handleApi(request, url, context) { /* 原路由分支原样搬入 */ }
```

**硬性要求**：
- 现有 `createMusicServer` 的 HTTP 行为**必须保持不变**（开发用 `npm run music` 仍要能跑）
- 抽出的逻辑**不得改变任何路由的判断顺序、状态码、响应体**
- **保留全部校验**：Loopback 主机校验、Origin 校验、`\0`/`\` 路径校验、`path.relative` 目录越界校验
- **保留 Range 请求实现**（`parseRange` / `serveFile` 不动）

**端点清单（13 个，逐一确认都已覆盖）**：

```
GET  /api/health
GET  /api/audio/capabilities
POST /api/audio/prepare/:id
GET  /api/decoded-audio/:id
GET  /api/audio/:id
GET  /api/artwork/:id
GET  /api/library
POST /api/library/scan
POST /api/library/enrich
POST /api/library/introductions
POST /api/library/credits
GET/POST /api/config  (及 /api/library/config)
GET/POST /api/genre-rules
GET  /api/output/state
POST /api/output/command
GET  /api/foobar/status 及 /api/foobar/*（Beefweb 代理）
```

### 4.2 `scripts/music-audio.mjs` 改动点（精确）

**改动 1 —— 平台化原生二进制选择**

现状（第 7 行）：
```js
const SOURCE = fileURLToPath(new URL('../native/RhineAudio.swift', import.meta.url))
```
必须改为同时声明 Windows 服务路径，并在 `NativeAudioOutput.init()` 按 `process.platform` 分支：
- `darwin` → 保持现有 `swiftc` 现编译逻辑**完全不变**
- `win32` → 直接使用内置的 `native/rhine-win-service/rhine-win-service.exe`，不存在则报明确错误
- 其它平台 → 抛 `failure('原生输出仅支持 macOS 与 Windows')`

**改动 2 —— 修复 `findExecutable` 的 Windows 扩展名问题（必修）**

现状（第 23 行）用 `path.join(dir, name)` 拼路径。**已实测复现**：即使 `ffmpeg.exe` 在 PATH 中，Windows 上也返回 `NOT FOUND`，导致 APE/WV/WMA/DSD/ALAC **全部无法播放**。

要求：
- `win32` 下候选名扩展为 `name + .exe / .cmd / .bat / name`，并优先读 `%PATHEXT%`
- `win32` 下 `X_OK` 退化为 `F_OK` 语义
- **删除硬编码的 macOS 路径** `/opt/homebrew/bin`、`/usr/local/bin`、`/usr/bin`（在 `win32` 下跳过，不要删代码）
- 保留 `FFMPEG_PATH` / `FFPROBE_PATH` 覆盖机制**不变**

> 注：应用内置 FFmpeg 并设置 `FFMPEG_PATH` 时会走 `override` 分支直接返回，**绕过此 bug**；但此修复仍必须做，以支持用户系统级安装 FFmpeg 的回退路径。

**改动 3 —— 数据目录**

```js
// win32 默认：%LOCALAPPDATA%\RhineMusic\music-data-v3
// 保留 MUSIC_DATA_DIR 覆盖
```

**改动 4 —— POSIX 权限调用**

`fs.chmod(..., 0o600/0o700)` 与 `fs.mkdir(..., { mode: 0o700 })` 在 `win32` 下跳过（NTFS 上无意义）。

**改动 5 —— 错误文案平台化**

- 第 211 行 `'CoreAudio 输出仅适用于 macOS'` → 按平台给出对应文案
- 第 213 行 `'原生输出需要 Apple Command Line Tools（swiftc）'` → 仅 `darwin` 使用

### 4.3 前端改动（仅 2 个文件）

**`src/pwa.ts` —— 必修，这是坑**

第 44 行守卫：
```ts
if (started || !import.meta.env.PROD || !window.isSecureContext || !("serviceWorker" in navigator)) return;
```
把 `app://` 注册为 **secure** 后 `window.isSecureContext` 变 **true**，生产构建下**会真的去注册 sw.js**。

要求：`initPwa()` 在桌面环境（`window.rhineDesktop` 存在）下**直接 return**，并隐藏「安装到设备」相关 UI。

**`src/music-app.ts` —— 仅两处**

**① 音乐目录输入（第 1525 行，`<textarea id="music-roots">`）**

现状要求用户**手打绝对路径**。改为：
- 「添加文件夹」按钮 → `window.rhineDesktop.showOpenDirectories()` → 多选目录
- 展示为**可删除的路径标签列表**
- **保留手工粘贴能力**（`<textarea>` 可作为"高级"折叠区保留）
- 提交仍走 `POST /api/library/scan` 的 `{ roots: [...] }` 契约，**后端不改**
- 加分：支持拖拽文件夹进窗口

**② UI 文案平台化（第 1397、1427 行）**

现状写死 macOS：
```
第 1397 行: <option value="coreaudio">Mac 原生 CoreAudio</option>
第 1427 行: "本机解码与 CoreAudio 已就绪。"
```
要求：`win32` 下显示 Windows 对应名称（**与 `music-player.ts:172` 的文案保持一致**）：
- 输出方式选项：`Windows 原生输出（WASAPI）`
- 就绪文案：`本机解码与 WASAPI 已就绪。`
- `music-player.ts:172` 的 `"CoreAudio 输出不可用，请检查 FFmpeg 和 Apple Command Line Tools"` → Windows 下 `"WASAPI 输出不可用，请检查 FFmpeg 与音频设备"`

**`src/music-app.ts` 其余部分、以及 `src/` 其它所有文件：零改动。**

---

## 5. 组件 C · RhineWinService（C# / .NET 8）

位置：`native/rhine-win-service/`，产物 `rhine-win-service.exe`。

### 5.1 协议契约（逐字实现，不得增删语义）

**传输**：stdin 逐行读 JSON，stdout 逐行写 JSON。

```
请求:  {"id": <number>, "action": "<string>", ...参数}
响应:  {"id": <number>, "result": {...}}        成功
       {"id": <number>, "error": "<中文消息>"}   失败
```

**动作（13 个，一个不能少）**：

| action | 参数 | 语义 |
| --- | --- | --- |
| `devices` | — | 返回 `{ devices: [{id, name}] }` |
| `state` | — | 返回状态对象（见 5.2） |
| `play` | `path`(可选),`trackId`,`position`,`deviceId`,`volume`,`transitionMode`,`fadeEnabled` | `path` 为 WAV 缓存绝对路径；无 `path` 则从 `base` 续播 |
| `pause` | — | 停止输出，记录 `base = 当前位置` |
| `stop` | — | 停止并清空 `trackId`/`file`，`base = 0` |
| `seek` | `position` | 跳到位置，**保持原播放/暂停状态** |
| `volume` | `volume` (0..1) | 设置音量，取消进行中的淡变 |
| `device` | `deviceId` | `"default"` 或数字 ID；**保留播放位置与播放状态** |
| `transition` | `transitionMode` 或 `fadeEnabled` | 设置衔接方式 |
| `prepareNext` | `path`,`trackId`,`afterTrackId`,`afterBoundarySerial` | 预备下一首（见 5.3） |
| `cancelNext` | — | 取消预备 |
| `fadeOut` | — | 淡出（见 5.4） |
| （未知 action） | — | 返回 `error: "未知音频指令"` |

**`transitionMode` 取值**：`"fade-out"` | `"fade-in-out"` | `"gapless"`。默认 `fade-in-out`。

> ⚠️ `music-audio.mjs` 的 `command()` 白名单是 `['play','pause','stop','seek','volume','device','state','transition','prepareNext','cancelNext']`，`fadeOut` 由内部直接发送。以上全部必须实现。

### 5.2 状态对象（字段名逐字一致）

```json
{
  "trackId": "", "playing": false, "currentTime": 0, "duration": 0,
  "volume": 0.7, "deviceId": "default", "endedSerial": 0,
  "transitionMode": "fade-in-out", "nextTrackId": "",
  "boundarySerial": 0, "outputSampleRate": 44100
}
```

可选字段 `"error": "<消息>"`（如设备断开）。

### 5.3 不可简化的语义（**逐条验收**）

| # | 语义 | 要求 |
| --- | --- | --- |
| 1 | **双槽** | 当前曲与预备曲各占一个播放槽；`promoteNext()` 时 `activeSlot = 1 - activeSlot`，`boundarySerial += 1` |
| 2 | **`endedSerial`** | **仅自然播完时自增**；`stop`/`seek`/`play` 不得自增；手动停止后重播不得自增 |
| 3 | **`boundarySerial`** | 每次 `promoteNext` 递增；`prepareNext` 若 `afterBoundarySerial` 与当前不符，必须报 `"当前歌曲已接续，已取消过期预备"` |
| 4 | **`prepareNext` 前置条件** | 必须校验：`transitionMode == "gapless"`、正在播放、有当前文件、`afterTrackId` 匹配；不满足则报错让上层降级（对应 Swift 的 `"当前未在无缝模式播放，无法预备下一首"`） |
| 5 | **20 ms 提前量** | `prepareNext` 必须在当前曲目结束**前 ≥20 ms** 完成排程，否则取消并按 Swift 原文报 `"下一首未能在当前歌曲结束前准备完成"` |
| 6 | **`outputSampleRate`** | **必须真实上报当前实际输出采样率**。上层据此让 FFmpeg 把下一首归一化到同一采样率——这是整数帧对齐的前提 |
| 7 | **预备曲采样率必须等于输出采样率** | 不等则报 `"下一首尚未转换到当前输出采样率，无法准确无缝接续"` |
| 8 | **声道数不得增加** | 预备曲声道数 > 当前输出声道数则报 `"下一首声道数增加，需要重新配置输出；本次无法无缝接续"` |
| 9 | **`device` 保留位置** | 切换设备后从原位置、原播放状态续播（对应 Swift `setDevice`） |
| 10 | **设备断开** | `state` 时若所选设备不存在，停止播放、保留位置、置 `error: "所选输出设备已断开，请重新选择"` |

### 5.4 淡变

- **`fadeOut`**：28 步 × 16 ms 的 **smoothstep** 斜坡（`p*p*(3-2p)`），从当前音量降到 0
- **`fade-in-out` 模式**：`play` 时从 0 淡入到 `desiredVolume`，同样 28×16 ms
- **`transition` 切换到非淡入淡出时**：取消进行中的淡变，音量立即置为 `desiredVolume`
- 淡变**不得**影响 `base`、`currentTime`、`endedSerial`

### 5.5 WAV 解析

原生服务**只播 FFmpeg 产出的 PCM WAV**，不需要任何解码器。

要求：解析 `RIFF/WAVE`（含 `WAVE_FORMAT_EXTENSIBLE`），读取格式/声道/采样率/位深/数据块；**与设备协商失败时不得静默播放**，必须返回明确错误。

> 注意：FFmpeg 输出用 `-rf64 never`，所以**不会**出现 RF64 大文件格式。

### 5.6 WASAPI 输出（效果优先：默认独占）

```
逐曲协商：
  IsFormatSupported(EXCLUSIVE, 缓存的原生格式)
  ├─ S_OK                       → 独占；原生采样率 + 原生位深，零转换
  ├─ 格式不支持                  → 尝试设备支持的最接近采样率；重采样交由 FFmpeg
  ├─ AUDCLNT_E_DEVICE_IN_USE    → 回退共享，error: "输出设备已被其他程序独占"
  ├─ EXCLUSIVE_MODE_NOT_ALLOWED → 回退共享，error: "系统未允许独占控制该设备，
                                    请在「声音设置 → 设备属性 → 高级」中勾选
                                    「允许应用程序独占控制该设备」"
  └─ 其它失败                    → 回退共享，error 说明原因
```

**位深映射**：

| WAV 缓存 | WASAPI |
| --- | --- |
| `pcm_s16le` | 16-bit PCM |
| `pcm_s24le` | 24-bit（`WAVEFORMATEXTENSIBLE` + `wValidBitsPerSample=24`，32-bit 容器） |
| `pcm_s32le` | 32-bit PCM |
| `pcm_f32le` | 32-bit float（`WAVE_FORMAT_IEEE_FLOAT`） |

**设备热插拔**：监听 `IMMNotificationClient`；设备移除时安全停止，保留位置并置错误。

### 5.7 bit-perfect 模式（规格已定，不要重新设计）

| 项 | 要求 |
| --- | --- |
| 开关 | 设置项，**默认关闭** |
| 开启效果 | 应用内音量**锁定 100%**；UI 提示「bit-perfect 模式下请使用功放/DAC 或系统音量调节」 |
| 关闭效果 | 正常软件音量（float 衰减） |
| 界面标注 | **必须如实显示当前是否处于 bit-perfect**，不得夸大 |

> 依据：软件音量衰减就是重写样本，与 bit-perfect 天然互斥。这是物理必然，不是缺陷。

### 5.8 SMTC

在**同一进程**内实现 `SystemMediaTransportControls`：与播放状态双向绑定，提供媒体键、锁屏信息、音量 OSD。

### 5.9 启动与生命周期

- 由 Electron 主进程 `spawn`，`stdio: ['pipe','pipe','pipe']`，`windowsHide: true`
- stdout 逐行解析；进程退出时，拒绝所有 pending 请求：`"CoreAudio 进程已退出，请重新选择输出"` → Windows 文案改为 `"原生音频进程已退出，请重新选择输出"`
- 主进程退出时必须终止服务进程

---

## 6. 组件 D · FFmpeg

### 6.1 来源与版本

- 使用 **LGPL 构建**（BtbN/FFmpeg-Builds 的 `win64-lgpl` 产物，或自建 `--disable-gpl --disable-nonfree`）
- 随包分发：`resources/unpacked/ffmpeg/ffmpeg.exe`、`ffprobe.exe`
- **必须 `asarUnpack`**，否则 `spawn` 不到
- 启动时设置绝对路径：
  ```js
  process.env.FFMPEG_PATH  = <unpacked>/ffmpeg/ffmpeg.exe
  process.env.FFPROBE_PATH = <unpacked>/ffmpeg/ffprobe.exe
  ```
  （此覆盖机制项目已支持，见 `music-audio.mjs:68`，**会绕过 findExecutable**）

### 6.2 每次回归必须覆盖的容器/编码

应用只扫描这些解复用器（`music-audio.mjs:11`，**不得改动此列表**）：

```
ape, wav, flac, mov, mp3, aac, aiff, ogg, wv, asf, dsf, iff
```

回归必须实测并可播放：**APE**、**WavPack(.wv)**、**WMA**、**FLAC**、**WAV**、**M4A/ALAC**、**DSF/DFF**、**MP3**、**AAC**、**AIFF**、**OGG/Vorbis**、**Opus**。

### 6.3 可选（P6，非必须）

自建最小构建（体积 80 MB → 25–35 MB）。**若做，必须先通过 6.2 的完整格式矩阵**，任一格式失败即回退完整构建。加 `--enable-libsoxr` 可提升受限设备下的重采样质量。

---

## 7. 分阶段实施与验收门

### P1 · MVP（必需）

| 交付 | 内容 |
| --- | --- |
| 1 | `electron/main.js` + `preload.js`：窗口、`app://` 协议、`backgroundThrottling:false`、外链拦截 |
| 2 | `music-server.mjs` 抽出 `handleApi`，HTTP 行为不变 |
| 3 | `music-audio.mjs` 改动 2、3、4、5（扩展名修复、数据目录、权限、文案） |
| 4 | `src/pwa.ts` 桌面短路 |
| 5 | 内置 FFmpeg + `FFMPEG_PATH`/`FFPROBE_PATH` |
| 6 | `electron-builder` 出 NSIS + portable |

**验收门 P1**（全部通过才进 P2）：
- [ ] 双击 exe 启动，无终端窗口、无地址栏
- [ ] 曲库扫描、专辑架、详情、缩略图总览、搜索全部可用
- [ ] 12 种格式（6.2）全部能播放
- [ ] **无 TCP 监听端口**（`netstat -ano | findstr LISTENING` 无本应用条目）
- [ ] 大 FLAC 拖动进度条正常（验证 Range）
- [ ] 窗口失焦时音乐与动效不受影响
- [ ] `git status` 显示 `src/scene.ts`、全部 `*.css`、`music-library.mjs` **未被修改**
- [ ] `npm run check:v041` 中与 macOS 无关的用例全绿

### P2 · 桌面化（必需）

| 交付 | 内容 |
| --- | --- |
| 1 | 音乐目录：`<textarea>` → 路径标签列表 + 原生文件夹选择器 |
| 2 | UI 文案平台化（4.3②） |
| 3 | 单实例锁、窗口状态记忆、无边框 + 自绘标题栏 |
| 4 | 托盘 + 最小化到托盘 + 关闭行为选择 |
| 5 | 拖拽文件夹进窗口添加曲库 |

**验收门 P2**：
- [ ] 能通过文件夹选择器添加曲库，扫描结果与手打路径**完全一致**
- [ ] 窗口尺寸/位置重开后恢复
- [ ] 二次启动聚焦已有窗口，不产生第二个进程
- [ ] 界面上**不出现** `CoreAudio`、`Mac`、`Apple` 等 macOS 字样

### P3 · 原生音频服务（必需，效果核心）

| 交付 | 内容 |
| --- | --- |
| 1 | C# 项目 + JSON-lines 协议（5.1、5.2 全部动作与字段） |
| 2 | WAV 解析 + WASAPI 共享输出 |
| 3 | 双槽无缝排程 + `boundarySerial`/`endedSerial`（5.3 全部 10 条） |
| 4 | 淡变（5.4） |
| 5 | 设备枚举、切换、热插拔（5.9、5.10 条） |
| 6 | **独占模式 + 逐曲采样率与位深协商 + 自动回退**（5.6） |
| 7 | `music-audio.mjs` 改动 1（平台化二进制选择） |

**验收门 P3**：
- [ ] 设置里「Windows 原生输出（WASAPI）」可选且不灰
- [ ] 设备下拉列出真实设备，切换后**从原位置续播**
- [ ] 44.1 kHz 文件在独占下设备锁定 **44.1 kHz**（不是 48 kHz）
- [ ] 拔出设备 → 明确提示「所选输出设备已断开，请重新选择」，不崩溃
- [ ] 独占被占用 → 自动回退共享并给出正确原因
- [ ] **无缝播放接缝**：录制过渡波形，**无样本丢失、无重复、无爆音**
- [ ] `endedSerial` 仅在自然播完时自增（用日志验证）
- [ ] 三种衔接方式（淡出 / 淡出淡入 / 无缝）行为与 macOS 一致
- [ ] `npm run check:audio` 中非 darwin 用例改为按平台断言，**缺样本显式跳过**

### P4 · SMTC（必需）

- [ ] 键盘媒体键（播放/暂停、上一首、下一首）生效
- [ ] 锁屏/音量 OSD 显示曲目信息

### P5 · 音质增强（必需，效果优先）

| 交付 | 内容 |
| --- | --- |
| 1 | **bit-perfect 模式**开关（5.7） |
| 2 | **实时显示当前实际输出格式**：`44.1 kHz / 24-bit / 独占 / 无重采样` |
| 3 | **信号路径显示**：`FLAC 96kHz/24bit → [FFmpeg 解码，无重采样] → PCM 96/24 → [WASAPI 独占 96/24] → DAC` |
| 4 | 共享模式下的提示：「关闭设备音频增强以获得更好效果」 |

数据来源：扩展 `/api/audio/capabilities` 的**响应字段**（**只增不改**，保持既有字段）。

**验收门 P5**：
- [ ] **真 bit-perfect**：已知测试信号 → VB-Cable/硬件环回录音 → **逐比特比对通过**
- [ ] 显示的格式与 `IsFormatSupported` 实测结果一致
- [ ] 信号路径显示与实际链路一致（人为制造重采样，显示必须随之变化）

### P6 · 渲染优化（可选，**必须带视觉对照**）

**仅在 P1–P5 全部验收通过后考虑。** 逐项独立提交，每项都必须：

1. 与原版**逐镜头对照**（开场、专辑架、详情、缩略图总览、真实列）
2. 无法证明视觉无差异 → **放弃该项**

允许的项（按风险从低到高）：
| 项 | 说明 |
| --- | --- |
| a | 隐藏/最小化时停止 RAF（**用户不可感知，推荐**） |
| b | 着色器管线缓存持久化（**仅影响启动**） |
| c | 图集改 BC7 压缩纹理（108 MiB → 约 27 MiB） |
| d | 分块剔除（现状 `frustumCulled = false`） |
| e | 背景 LOD（`Ivory_Edges` 占 69.5% 三角形） |

> ❌ **P6 绝不允许**降低 `render-quality.ts` 的默认档或预设值。

### P7 · 发布

- [ ] **代码签名**（未签名会触发 SmartScreen，直接影响首次观感）
- [ ] 安装器 + 卸载清理
- [ ] 自动更新（`electron-updater` + 静态 feed，可延后）
- [ ] 文件关联（可选）
- [ ] 更新 `NOTICE.md`：新增 Electron、RhineWinService、FFmpeg 及各自许可

---

## 8. 全局验收清单（交付前逐条打勾）

### 8.1 还原

- [ ] `git diff` 显示 `src/scene.ts`、`src/cover-atlas.ts`、`src/model-viewer.ts`、`src/music-lighting.ts`、`src/music-boot.ts`、`src/music-title.ts`、`src/music-ruler.ts`、全部 `*.css`、`scripts/music-library.mjs`、`src/render-quality.ts` **零改动**
- [ ] 与 macOS 版**并排截图**：开场、专辑架、详情、缩略图总览、真实列 —— 逐像素可比
- [ ] 四档画质预设值与默认档不变
- [ ] 键盘/滚轮/快捷键行为一致
- [ ] 减少动态效果、暖昼/深夜、横竖屏、超宽屏全部正常
- [ ] 播放 / 界面音效 / 氛围音乐相互独立
- [ ] 搜索定位不改变播放状态
- [ ] 真实列独立浏览且列内首尾停止；填充模式循环
- [ ] 列浏览记忆默认开启；偏好与会话记忆分开
- [ ] `music-data-v3` 目录结构与 `MUSIC_DATA_DIR` 覆盖不变
- [ ] 源文件与标签**只读**（播放后校验 mtime 与内容未变）
- [ ] 目录越界校验仍然生效（构造越界路径必须被拒）

### 8.2 效果

- [ ] `cpuP95` 与帧率**不低于** macOS 基线（p95 ≤ 16.8 ms，0 个 >50 ms 长帧）
- [ ] 独占模式下 44.1 kHz 不被重采样
- [ ] bit-perfect 模式逐比特比对通过
- [ ] 信号路径显示与实际一致
- [ ] 无缝播放接缝无瑕疵
- [ ] 隐藏/最小化时停止渲染（若做了 P6a）

### 8.3 工程

- [ ] `npm run build` 退出 0
- [ ] `npm run check:v041` 全部通过或**显式跳过**（不得伪装通过）
- [ ] 真实音频设备自动测试**零音量**
- [ ] 无 TCP 监听端口
- [ ] 服务不监听 `0.0.0.0`
- [ ] 无遥测；除用户主动查询资料外无网络行为
- [ ] `LICENSE` / `NOTICE.md` / `README.original.md` 与全部第三方许可保留

---

## 9. 交付物清单

```
rhine-music-windows/
├─ electron/
│   ├─ main.js                     # 窗口、协议、托盘、单实例、对话框
│   ├─ preload.js                  # contextBridge API
│   └─ protocol.js                 # app:// 处理
├─ native/rhine-win-service/       # C# 项目
│   ├─ RhineWinService.csproj
│   ├─ Program.cs                  # JSON-lines 主循环
│   ├─ WasapiOutput.cs             # 共享/独占、设备协商、双槽排程
│   ├─ WavReader.cs                # PCM WAV 解析
│   └─ Scheduler.cs                # 双槽与淡变
├─ ffmpeg/                         # LGPL 构建（构建脚本 + 说明）
├─ scripts/music-server.mjs        # +handleApi 导出
├─ scripts/music-audio.mjs         # 5 处改动
├─ src/pwa.ts                      # 桌面短路
├─ src/music-app.ts                # 目录选择器 + 文案平台化
├─ electron-builder.yml
├─ WINDOWS.md                      # 用户说明（安装、依赖、音质设置）
└─ NOTICE.md                       # 更新第三方许可
```

---

## 10. 合规（硬性）

1. **作为独立 Fork**，不改写既有 Git 历史；按 `community_fork.md` 模板登记 Issue
2. **明确标注为社区衍生版**（主线 README 已写明 Windows 属社区范围，主线不接收 PR）
3. **FFmpeg 用 LGPL 构建**，随包附许可与源码获取方式
4. **保留** `LICENSE` / `NOTICE.md` / `README.original.md` 与全部第三方许可；代码 MIT **不**覆盖字体、图像、模型、声音
5. **不提交**真实歌曲、封面缓存、索引、令牌、本机绝对路径
6. **保留** `MUSIC_DATA_DIR` 约定；自定义协议天然满足「只本机」

---

## 附录 A · 关键代码位置索引

| 位置 | 内容 |
| --- | --- |
| `scripts/music-audio.mjs:7` | Swift 源路径（需平台化） |
| `scripts/music-audio.mjs:11` | `AUDIO_DEMUXERS`（**不得改**） |
| `scripts/music-audio.mjs:13` | `DSD_PCM_RATE = 176400` |
| `scripts/music-audio.mjs:23` | `findExecutable` 候选路径（**必修**） |
| `scripts/music-audio.mjs:68` | `FFMPEG_PATH` / `FFPROBE_PATH` 覆盖入口 |
| `scripts/music-audio.mjs:105,154-163` | 位深保持与重采样逻辑（**不得改**） |
| `scripts/music-audio.mjs:175` | `metadata`（含 `sampleRate`，供采样率跟随读取） |
| `scripts/music-audio.mjs:211-219` | `NativeAudioOutput.init`（**改动点 1**） |
| `scripts/music-audio.mjs:272` | action 白名单 |
| `scripts/music-server.mjs:81-209` | `createMusicServer` 路由（抽出 `handleApi`） |
| `scripts/music-server.mjs:103-109` | `/api/audio/capabilities`（P5 扩展，只增不改） |
| `src/pwa.ts:44` | SW 注册守卫（**必修**） |
| `src/music-app.ts:1397` | 输出方式选项文案（平台化） |
| `src/music-app.ts:1427` | 就绪文案（平台化） |
| `src/music-app.ts:1525` | `<textarea id="music-roots">`（改文件夹选择器） |
| `src/music-player.ts:172` | 原生输出不可用文案（平台化） |
| `native/RhineAudio.swift` | **协议与语义的唯一权威参考，逐条对照实现** |

## 附录 B · 原生服务实现时对照 `RhineAudio.swift` 的检查表

| Swift 位置 | 必须复刻的行为 |
| --- | --- |
| `audioDevices()` | 只枚举有输出流的设备；名称为空时回退 `"Audio output"` |
| `defaultOutputDevice()` | 取不到时报 `"系统默认输出设备不可用"` |
| `setDevice(_:)` | `advanceQueueIfNeeded()` → `cancelNext()` → 记录 offset/resume → 重建 → `schedule(at: offset, play: resume)` |
| `schedule(at:play:)` | `frames <= 0` 且 `play` 时 `endedSerial += 1`；长度超限报错 |
| `enqueue(...)` | 用 token + serial 双重校验，过期回调必须忽略 |
| `advanceQueueIfNeeded()` | 按已播样本数 ≥ `segmentOutputFrames` 判定越界 |
| `promoteNext()` | `boundarySerial += 1`，`base = 0` |
| `prepareNext(...)` | 全部前置校验 + 20 ms 提前量 |
| `fade(to:)` | 28 步 × 16 ms，`p*p*(3-2p)` |
| `command(_:)` 的 `state` 分支 | 默认设备变更检测、设备断开检测、引擎停止检测 |
| `reply(...)` | JSON 序列化后**必须换行** |

---

**规范结束。执行方按第 7 节顺序推进，每阶段过验收门；遇到规范未覆盖的情况，停下来提问。**
