# Rhine Music for Windows · 最终方案

> **定调：效果优先。** 在「不全重写、不用自带浏览器、纯本地」的约束下，追求**最好的成品**，而不是最省事的成品。
> 对象：上游 `Rhine-Music-Demo` 的本地工作副本，V0.4.1 @ `dd2370f` · 已实测 `npm ci` / `npm run build` / 音乐服务在 Windows 全部通过。

---

## 0. 「效果优先」意味着什么

| 效果维度 | 目标 | 因此的选择 |
| --- | --- | --- |
| **视觉保真** | 与 macOS 版**逐像素一致**，且**可复现** | 固定版本 Chromium（Electron），不用随系统更新的 WebView2 |
| **音频输出** | **不低于** macOS 版，且提供更高上限 | 自研 Windows 原生音频服务，支持 **WASAPI 独占** |
| **性能** | 不退化，并修掉已识别的浪费 | 保留 60 FPS，做**不改变外观**的优化 |
| **桌面体验** | 像原生 Windows 应用 | 媒体键/SMTC、托盘、原生文件夹选择器、无边框窗口 |
| **自包含** | 用户装什么都不影响运行 | 内置 Chromium + 内置 FFmpeg，零外部依赖 |
| **首次观感** | 无 SmartScreen 警告 | 代码签名证书 |

**代价**：体积约 250 MB，工作量约 **30–50 人日**（可用 MVP 约 10 人日）。
**收益**：前端零改动、后端零改动、视觉 100% 保真、音频超过 macOS 版上限。

---

## 1. 为什么是 Electron（效果优先视角）

不是因为它最省事，而是因为**它是唯一同时满足这四条的**：

1. **渲染确定性** —— Chromium 版本随包固定，视觉结果可复现、可回归。WebView2 随系统 Edge 更新而变，同一份代码在不同机器上可能渲染不同 —— 这与「效果优先」直接冲突。
2. **完全自包含** —— 不依赖用户装浏览器、不依赖系统 WebView2 运行时。开箱即用。
3. **Chromium + Node 一体** —— 现有 44 KB 曲库逻辑（`music-metadata`，APE/WavPack/DSD 标签支持成熟）**原样复用**，不必赌 Rust/C# 重写的标签解析不会回归。
4. **前端零改动** —— 8 个 `fetch()` / 13 个端点通过自定义协议原样工作，Three.js 场景与 130 KB CSS 一个字节都不用动。

> 换句话说：**效果优先 = 不拿视觉和音质去赌技术栈的差异。**

---

## 2. 总体架构

```
RhineMusic.exe  (Electron, 自带固定版 Chromium)
│
├─ 主进程  (内置 Node 22)
│   ├─ protocol.handle("app")  ── 取代 music-server.mjs 的 HTTP 层，无 TCP 端口
│   │    ├─ app://-/api/*      → 直接调用抽出来的路由处理函数
│   │    └─ 其它路径             → dist/ 静态资源（保留 Range，音频拖动必需）
│   ├─ music-library.mjs (44 KB) ── 原样复用，零改动
│   ├─ music-audio.mjs   (24 KB) ── 仅改「选哪个原生二进制」约 5 行
│   ├─ dialog.showOpenDialog     ── 原生文件夹选择器
│   └─ shell.openExternal        ── 外链走系统浏览器
│
├─ 渲染进程  (固定版 Chromium)
│   └─ app://-/index.html ── dist/ 原样复用；前端 0 改动
│
├─ RhineWinService.exe  (C# / .NET，本次新增)
│   ├─ WASAPI 输出：共享 / 独占，双槽精确帧排程（无缝播放）
│   ├─ 设备枚举与热插拔
│   ├─ SMTC：媒体键、音量 OSD、锁屏控制
│   └─ JSON-lines 协议 ←→ music-audio.mjs（协议逐字不变）
│
├─ ffmpeg.exe / ffprobe.exe  (自建 LGPL 最小构建，内置)
│
└─ resources/
    ├─ app.asar          (dist/ + 主进程代码)
    └─ unpacked/         (ffmpeg.exe, ffprobe.exe, RhineWinService.exe)
```

**四个组件，各司其职，互不侵入。**

---

## 3. 组件 A · Electron 外壳

### 关键实现

```js
// main.js
protocol.registerSchemesAsPrivileged([{
  scheme: "app",
  privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true },
}]);

app.commandLine.appendSwitch("force_high_performance_gpu");   // 双显卡笔记本走独显

const win = new BrowserWindow({
  frame: false,                    // 无边框 + 自绘标题栏，贴合现有暗色玻璃设计
  backgroundColor: "#0b0d12",      // 与主题一致的底色，避免白闪
  show: false,                     // ready-to-show 后再显示
  webPreferences: {
    backgroundThrottling: false,   // ⚠️ 音乐播放器必须：失焦不降频，音乐与动效不受影响
    contextIsolation: true, nodeIntegration: false, preload: PRELOAD,
  },
});

// 外链走系统浏览器
win.webContents.setWindowOpenHandler(({ url }) => { shell.openExternal(url); return { action: "deny" }; });
```

### 三条必须的处理

**① `backgroundThrottling: false`**
Chromium 默认会在窗口失焦/遮挡时把定时器降到 1 Hz。对音乐播放器是**致命的** —— 会让无缝排程、进度轮询、氛围音全部失真。

**② 显式禁用 Service Worker（这是个真坑）**
`src/pwa.ts:44` 的守卫是：
```ts
if (started || !import.meta.env.PROD || !window.isSecureContext || !("serviceWorker" in navigator)) return;
```
把 `app://` 注册为 **secure** 后 `window.isSecureContext` 变 **true**，生产构建下它会**真的去注册 sw.js**。必须短路，并屏蔽「安装到设备」提示。

**③ 首屏观感**
Cold start 约 1–2 s。**好消息**：应用自带设计好的开场序列（6.32 s 二维序章 + 5.2 s 三维段），冷启动被自然掩盖。用 `show:false` + `ready-to-show` 保证不出现白屏。

---

## 4. 组件 B · 复用现有 Node 后端

### 改动极小

| 文件 | 改动 |
| --- | --- |
| `scripts/music-server.mjs` | 把 `createMusicServer` 里的路由分支**抽成纯函数** `handleApi(request, url)`；HTTP 外壳保留给开发用，Electron 直接调纯函数 |
| `scripts/music-library.mjs` | **零改动** |
| `scripts/music-audio.mjs` | ① 修 `findExecutable` 的 `.exe` 感知（**已实测复现的 bug**）② `NativeAudioOutput` 按平台选二进制 ③ 数据目录 |
| `scripts/launch-music.mjs` | **桌面版不用**（保留给开发者） |
| `src/**` | **零改动**（除 pwa.ts 一处 SW 短路） |

### ⭐ 音乐目录：`<textarea>` → 原生文件夹选择器

`src/music-app.ts:1525` 现在是一个 **`<textarea>`，要求用户手打绝对路径**。这是桌面版**最大的 UX 缺口**，必须改：

- 「添加文件夹」按钮 → `dialog.showOpenDialog({ properties: ['openDirectory','multiSelections'] })`
- 展示为可删除的**路径标签列表**
- 保留手工粘贴作为兜底
- `/api/config` 的 `roots` 契约不变（后端无需改）
- 加分项：支持**拖拽文件夹**进窗口

---

## 5. 组件 C · RhineWinService（本次新增，效果的关键）

### 5.1 为什么用 C#

| 方案 | 决策 |
| --- | --- |
| **C# + NAudio** ✅ | NAudio 的 `WasapiOut` 把共享/独占、设备枚举、事件驱动封装得成熟；**WinRT 的 SMTC 在 C# 里是一等公民**；.NET 8 可 `PublishSingleFile` 自包含或 Native AOT |
| Rust + `wasapi` crate | 二进制更小、控制更细，但 SMTC 要额外绕 WinRT，开发更慢 |

**效果优先 → 选 C#**：它能用**一个进程**同时把「音频输出」和「媒体键/SMTC」都做到位，而这两个恰恰是最影响桌面体验的。

> 这也让这个原生进程的存在更值得：它不是「只为音频写的一个桥」，而是**Windows 集成服务**。

### 5.2 必须逐字保持的 JSON-lines 协议

`music-audio.mjs` 的 `NativeAudioOutput` 一行不改，靠的就是这个契约：

- **传输**：stdin 逐行收 JSON，stdout 逐行回 `{"id":n,"result":{...}}` 或 `{"id":n,"error":"..."}`
- **命令**：`devices` `state` `device` `play` `pause` `stop` `seek` `volume` `transition` `prepareNext` `cancelNext` `fadeOut`
- **状态字段**：`trackId playing currentTime duration volume deviceId endedSerial transitionMode nextTrackId boundarySerial outputSampleRate`
- **不能简化的语义**：
  1. **双槽** —— 当前 + 预备各占一槽；`promoteNext()` 时 `boundarySerial += 1`
  2. **`endedSerial`** —— 仅自然播完时自增，手动停止不自增
  3. **无缝排程** —— `prepareNext` 必须在当前曲目结束前 **≥20 ms** 完成，否则报错让上层降级
  4. **`outputSampleRate`** —— 必须真实上报（上层据此让 FFmpeg 把下一首归一化到同一采样率，这是整数帧对齐的前提）
  5. **`fadeOut`** —— 28 步 × 16 ms 的 smoothstep 斜坡
  6. **切设备** —— 保留播放位置与状态，重建输出后从该位置续播

### 5.3 实现要点

**关键前提（已确认）**：原生进程**只是个 WAV 播放器** —— FFmpeg 已把 APE/DSD/FLAC 等全部转成 WAV 缓存，桥只需要「WAV 解析 + WASAPI 输出 + 时钟排程」，**不需要任何解码器**。

| CoreAudio（macOS） | WASAPI（Windows） |
| --- | --- |
| `AVAudioFile(forReading:)` | 自己解析 WAV（固定 PCM 格式，几十行） |
| `AVAudioEngine` | `IAudioClient` + 专用渲染线程 |
| `AVAudioPlayerNode` ×2 | 两个环形缓冲源，渲染回调里求混合和，按**输出帧计数**切槽 |
| `AudioObjectGetPropertyData` 枚举 | `IMMDeviceEnumerator::EnumAudioEndpoints(eRender)` |
| `kAudioOutputUnitProperty_CurrentDevice` | 对目标 `IMMDevice` `Activate` 新 `IAudioClient` |
| `playerTime(forNodeTime:)` | 已写出帧数 ÷ 采样率 |

**独占模式（效果优先的加分项）**：
- 设置里给「共享 / 独占」选项，**默认共享**（与 macOS 版行为一致，避免惊吓）
- 独占流程：`IsFormatSupported(AUDCLNT_SHAREMODE_EXCLUSIVE)` → 成功则用 `Initialize` 独占；失败或 `AUDCLNT_E_DEVICE_IN_USE` → **自动回退共享并在 UI 说明原因**
- 独占开启时按设备原生格式输出，**不重采样**
- 独占是**唯一能超过 macOS 主线（CoreAudio 共享模式）音质上限**的路径

**设备热插拔**：监听 `IMMNotificationClient`，设备断开时保留播放位置、置错误状态，提示重新选择（对应 Swift 里的 `setDevice` 语义）。

**SMTC**：`SystemMediaTransportControls` 绑定播放状态 → 媒体键、蓝牙耳机控制、音量 OSD、锁屏信息全部可用。

---

## 6. 组件 D · 自建 LGPL 最小 FFmpeg

**效果优先 → 内置 FFmpeg，用户无需安装任何东西**，并且**修掉已实测复现的发现 bug**。

同时**自建最小构建**（顺带解决体积与许可）：

```bash
./configure --disable-everything --disable-gpl --disable-nonfree --disable-doc \
  --enable-ffmpeg --enable-ffprobe --enable-avcodec --enable-avformat --enable-swresample \
  --enable-protocol=file,pipe \
  --enable-demuxer=ape,wav,flac,mov,mp3,aac,aiff,ogg,wv,asf,dsf,iff \
  --enable-decoder=ape,wavpack,flac,alac,mp3,aac,aiff,pcm_s16le,pcm_s24le,pcm_s32le,pcm_f32le,\
vorbis,opus,wmav1,wmav2,wmapro,dsd_lsbf,dsd_msbf,dsd_lsbf_planar,dsd_msbf_planar,dst \
  --enable-muxer=wav --enable-encoder=pcm_s16le,pcm_s24le,pcm_s32le,pcm_f32le \
  --enable-filter=aresample,anull --enable-parser=... 
```

要点：
- 解复用器列表**直接取自** `music-audio.mjs:11` 的 `AUDIO_DEMUXERS`，不多不少
- **必须保留 WAV muxer 与 PCM 编码器** —— 应用的核心流程就是「解码成 PCM WAV 缓存」
- **必须保留 `file,pipe` 协议** —— 代码里传了 `-protocol_whitelist file,pipe`
- **LGPL 构建**（`--disable-gpl --disable-nonfree`）覆盖全部所需解码器，规避 GPL 传染
- 预计 **80 MB → 25–35 MB**

**并且必须修 G2**：`music-audio.mjs:23` 用 `path.join(dir,'ffmpeg')` 拼路径，Windows 上永远匹配不到 `ffmpeg.exe`（已实测：即使 `ffmpeg.exe` 在 PATH 里也返回 `NOT FOUND`）。不改这个，**APE/WV/WMA/DSD/ALAC 全部无法播放，无缝播放彻底不可用**。

---

## 7. 视觉保真与性能优化

原则：**只做不改变外观的优化**。项目文档明确写过「原型不能直接替换用户确认的外观」。

### 7.1 保持什么（一个字节都不动）

- `scene.ts` 的几何、材质、光照、相机、波浪、动效时序
- 130 KB CSS：磨砂玻璃（`backdrop-filter`）、`clip-path`、字轮、分阶段过渡
- 画质预设（`render-quality.ts`）、开场时间轴、真实专辑列行为

### 7.2 安全优化（用户不可感知）

| # | 优化 | 依据 | 收益 |
| --- | --- | --- | --- |
| 1 | **隐藏/最小化时停止 RAF** | `music-app.ts` 仍是连续 RAF | 省电、省 GPU |
| 2 | **着色器管线缓存持久化** | 启动有 30 个 program 编译 | 二次启动明显更快 |
| 3 | **图集改 BC7 压缩纹理** | 图集 **108 MiB** RGBA（4096×6912） | 显存/带宽 **-75%** |
| 4 | **`backgroundThrottling:false`** | 见组件 A | 失焦不降频 |
| 5 | **`force_high_performance_gpu`** | 双显卡笔记本 | 走独显，帧率更稳 |

### 7.3 需要视觉验证的优化（做，但要对照）

| # | 优化 | 依据 | 风险 |
| --- | --- | --- | --- |
| 6 | **分块剔除** | `scene.ts:404` 所有阵列 InstancedMesh 都是 `frustumCulled = false`，外围与雾中卡片仍全量提交（157 万三角形） | 处理不当会**跳变**，需逐镜头对照 |
| 7 | **背景 LOD** | `Ivory_Edges` 占阵列三角形 **69.5%**，是背景边框 | 需与原 GLB 做视觉对照 |

> ⚠️ **不要动** `performance` 画质档的默认值，也不要为了提高帧率把默认档从「高」降下来 —— 那是牺牲效果换性能，与本次目标相反。**用户已 60 FPS（p95 16.8 ms / 0 长帧），没有降档的必要。**

---

## 8. 桌面体验清单（效果优先）

| 项 | 说明 |
| --- | --- |
| **无边框窗口 + 自绘标题栏** | 贴合现有暗色玻璃设计，而非系统默认白条 |
| **窗口尺寸/位置/最大化记忆** | 重开回到原位 |
| **单实例锁** | `requestSingleInstanceLock`，第二次启动聚焦已有窗口 |
| **托盘 + 最小化到托盘** | 托盘菜单：播放/暂停、上一首、下一首、显示主窗口、退出 |
| **关闭行为选择** | 「退出」还是「留在托盘继续播放」，记住选择 |
| **SMTC 媒体键** | 由组件 C 提供：键盘媒体键、蓝牙耳机、音量 OSD、锁屏 |
| **原生文件夹选择器** | 见组件 B |
| **拖拽文件夹/文件进窗口** | 直接添加音乐目录 |
| **文件关联（可选）** | `.flac/.dsf/.ape` 双击用本应用打开 |
| **开机自启（可选）** | 默认关闭 |
| **自动更新** | `electron-updater` + 静态 feed |
| **代码签名** | ⚠️ **必须**。未签名 exe 会触发 SmartScreen 警告，直接影响首次观感 |

---

## 9. 逐文件改动清单

| 文件 | 改动 | 类型 |
| --- | --- | --- |
| `electron/main.js` | 新增：窗口、协议、托盘、单实例、对话框 | 🆕 |
| `electron/preload.js` | 新增：暴露 `showOpenDialog` 等少量 API | 🆕 |
| `scripts/music-server.mjs` | 抽出 `handleApi(request, url)` 纯函数 | ✏️ 小 |
| `scripts/music-audio.mjs` | ① 修 `.exe` 发现 ② 按平台选二进制 ③ 数据目录 ④ 独占模式选项透传 | ✏️ 小 |
| `scripts/music-library.mjs` | **零改动** | — |
| `src/pwa.ts` | 桌面环境短路 SW 注册 | ✏️ 极小 |
| `src/music-app.ts` | 音乐目录 textarea → 路径标签列表 + 原生选择器；隐藏时停 RAF | ✏️ 中 |
| `native/RhineWinService/` | 新增 C# 项目：WASAPI + SMTC + JSON-lines | 🆕 |
| `ffmpeg/` | 自建 LGPL 最小构建脚本 + 产物 | 🆕 |
| `package.json` | 加 `electron`、`electron-builder`、`electron-updater` | ✏️ 小 |

**前端其余 700 KB TS + 130 KB CSS：零改动。**

---

## 10. 构建与打包管线

```
1. npm ci
2. npm run build                    → dist/ (tsc + vite + PWA)
3. dotnet publish RhineWinService   → self-contained single-file exe
4. build-ffmpeg-lgpl.sh             → ffmpeg.exe / ffprobe.exe
5. electron-builder                 → NSIS 安装包 + portable 单文件 exe
     ├─ asarUnpack: ffmpeg/**, RhineWinService.exe   ← ⚠️ 必须，否则 spawn 不到
     ├─ 代码签名
     └─ latest.yml 供 electron-updater
```

---

## 11. 分阶段与验收

| 阶段 | 内容 | 人日 | 产出 |
| --- | --- | --- | --- |
| **P1 · MVP** | Electron 外壳、`app://` 协议、抽路由、修 G2、内置 FFmpeg、数据目录、打包出 exe | **6–8** | 可双击运行的完整播放器（Web Audio 输出） |
| **P2 · 桌面化** | 禁用 SW、原生文件夹选择器、外链、单实例、窗口记忆、托盘、无边框标题栏 | 4–6 | 像原生应用 |
| **P3 · 音频** | C# 服务：WASAPI 共享 + 独占、设备热插拔、JSON-lines、无缝双槽 | **12–18** | 音质超过 macOS 版上限 |
| **P4 · SMTC** | 媒体键、锁屏、音量 OSD（复用 P3 进程） | 2–3 | 完整桌面媒体体验 |
| **P5 · 性能** | 隐藏停 RAF、管线缓存、BC7 图集；分块剔除与背景 LOD（带视觉对照） | 5–8 | 启动更快、显存更低 |
| **P6 · 发布** | 签名、安装器、自动更新、文件关联 | 3–5 | 可分发 |
| **合计** | | **~32–48 人日** | |

**验收口径（沿用仓库既有约定）**：
- `npm run check:v041` 全绿；平台相关用例按平台拆分，**缺样本显式跳过，不伪装通过**
- 真实音频设备自动测试**必须零音量**
- 无缝播放**必须**验证是音频时钟连续排程（不能用关淡入淡出或 preload 冒充）
- 视觉回归：与 macOS 版逐镜头对照开场、专辑架、详情、缩略图总览、真实列
- 性能回归：帧间隔 P50/P95/P99、长帧数、CPU 提交耗时、进程树内存

---

## 12. 风险与对策

| 风险 | 对策 |
| --- | --- |
| WASAPI 独占不被设备支持 / 被占用 | `IsFormatSupported` 预检 + `AUDCLNT_E_DEVICE_IN_USE` 自动回退共享并在 UI 说明 |
| WAV 解析与 FFmpeg 输出格式不匹配 | 桥启动时校验 WAV 头（格式/位深/声道/采样率），不匹配即报错让上层重解码 |
| 无缝播放接缝有爆音 | 严格按 `boundarySerial` + 输出帧计数切槽；接缝处做 1 样本级交叉校验 |
| 自定义协议下 Range 请求异常 | `net.fetch(file://)` 保留 Range；用大文件拖动进度做专项测试 |
| 分块剔除导致画面跳变 | 必须与原版逐镜头对照；不通过就**放弃该优化**（效果优先，不冒险） |
| SmartScreen 拦截 | 代码签名证书（OV/EV） |
| FFmpeg LGPL 合规 | 随包附 LICENSE、源码获取方式；更新 `NOTICE.md` |
| 与上游分叉后无法合并 | 明确为独立 Fork；改动集中在 `electron/`、`native/RhineWinService/`、`ffmpeg/`，**核心 `src/` 几乎不动**，便于跟进上游 |

---

## 13. 合规与约定

1. **主线不接收 PR** —— 作为**独立 Fork**，按 `community_fork.md` 登记 Issue；不改写 Git 历史
2. **明确标注为社区衍生版**（README 已写明 Windows 属社区范围）
3. **FFmpeg 用 LGPL 构建**，随包附许可与源码获取方式，同步更新 `NOTICE.md`
4. **保留** `LICENSE` / `NOTICE.md` / `README.original.md` 与全部第三方许可；MIT 不覆盖字体、图像、模型、声音
5. **不提交**真实歌曲、封面缓存、索引、令牌、本机路径
6. **保留** `MUSIC_DATA_DIR` 覆盖约定；自定义协议天然满足「只本机」
7. **保留**既有产品约定：播放/界面音效/氛围音乐相互独立；搜索定位不改变播放；无缝播放必须用音频时钟排程；减少动态效果、暖昼/深夜、横竖屏与超宽屏支持

---

## 14. 一句话总结

**外壳用 Electron（固定版 Chromium，视觉可复现 + 完全自包含），后端 100% 复用（自定义 `app://` 协议，无端口、前端零改动），音频新增一个 C# 的 `RhineWinService`（WASAPI 共享/独占 + SMTC，同时解决音质与媒体键），FFmpeg 用自建 LGPL 最小构建内置（并修掉已实测复现的 `.exe` 发现 bug）。**

**结果是：视觉与 macOS 版逐像素一致且可复现，音频输出反而超过 macOS 主线（独占 WASAPI），桌面体验达到原生水准，总计约 32–48 人日，其中 6–8 人日即可拿到可运行的第一版。**
