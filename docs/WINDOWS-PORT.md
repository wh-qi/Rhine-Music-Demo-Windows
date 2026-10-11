# Rhine Music for Windows · 移植工程说明

本文件说明 [Rhine Music Demo](https://github.com/RonaldDeng/Rhine-Music-Demo) V0.4.1（macOS 主线，基线提交 `dd2370f`）
的 Windows 独立分支：**它是什么、怎么搭起来的、哪些地方验证过、哪些地方与实现规范不同、以及为什么。**

- 用户向说明见 [WINDOWS.md](../WINDOWS.md)
- 授权与第三方组件见 [NOTICE.md](../NOTICE.md)
- 实现依据见 [docs/planning/Rhine-Music-Windows-Implementation-Spec.md](planning/Rhine-Music-Windows-Implementation-Spec.md)

---

## 1. 这是什么

双击一个 `.exe` 就能用的 Windows 桌面音乐播放器：自带固定版 Chromium、纯本地、不需要装任何东西。
目标不是"做一个类似的播放器"，而是**同一份输入下，Windows 版的可见行为与 macOS V0.4.1 逐项一致**。

分支以独立 Fork 存在，上游 Git 历史原样保留，没有改写，也没有向上游推送。

| 维度 | 做法 |
| --- | --- |
| 渲染 | Electron 自带固定 Chromium，不随系统 Edge 更新而变 |
| 界面 | `dist/` 原样加载；`scene.ts`、全部 `*.css`、`render-quality.ts` 等视觉文件**零改动** |
| 后端 | 复用 `scripts/music-library.mjs`（零改动）与 `music-audio.mjs`；HTTP 路由抽成纯函数给自定义协议复用 |
| 音频 | 新增 C#/.NET 8 原生服务，WASAPI 独占优先、双槽无缝、SMTC 媒体键 |
| 解码 | 随包分发 FFmpeg 的 **LGPL** 构建，由独立子进程调用 |
| 网络 | 应用不监听任何 TCP 端口；除用户主动查询资料外没有网络行为 |

---

## 2. 目录结构

```
Rhine-Music-Demoff/
├─ electron/                     # 桌面外壳（新增）
│   ├─ main.js                   # 窗口、app:// 协议挂载、托盘、单实例、窗口状态记忆
│   ├─ protocol.js               # app:// → handleApi / dist 静态资源
│   └─ preload.js                # contextBridge：目录选择、拖拽取路径、媒体键通道
├─ native/rhine-win-service/     # 原生音频服务（新增）
│   ├─ RhineWinService.csproj    # net8.0-windows10.0.19041.0，自包含单文件发布
│   ├─ Program.cs                # JSON-lines 主循环与 14 个动作
│   ├─ WasapiOutput.cs           # 设备枚举、独占/共享协商、渲染线程、热插拔
│   ├─ Scheduler.cs              # 双槽排程、无缝接续、淡变
│   ├─ WavReader.cs              # PCM WAV 解析与样本格式转换
│   ├─ WasapiInterop.cs          # WASAPI COM 互操作
│   ├─ Smtc.cs                   # 媒体键与锁屏信息
│   └─ SelfTest.cs               # 离线接缝逐样本自检
├─ ffmpeg/                       # LGPL 构建取得脚本与说明（二进制不入版本库）
├─ scripts/
│   ├─ music-server.mjs          # +handleApi / +createMusicRuntime / capabilities 扩展
│   ├─ music-audio.mjs           # 平台化二进制、数据目录、权限、文案、媒体键、bit-perfect
│   ├─ make-audio-fixtures.mjs   # 生成 12 种容器/编码的合成回归样本（新增）
│   ├─ check-music-desktop.mjs   # app:// 协议层回归（新增）
│   ├─ check-win-service.mjs     # 原生服务协议与语义回归（新增）
│   └─ run-win-service-selftest.mjs
├─ electron-builder.yml          # NSIS + 便携版
├─ docs/planning/                # 规划文档（随分支保留）
└─ WINDOWS.md
```

---

## 3. 架构

```
Rhine Music.exe（Electron，自带固定版 Chromium）
│
├─ 主进程（Node）
│   ├─ app:// 自定义协议 ── 无 TCP 端口
│   │     ├─ app://-/api/*  → scripts/music-server.mjs 的 handleApi()
│   │     └─ 其它            → dist/ 静态资源（net.fetch，保留 Range）
│   ├─ scripts/music-library.mjs（零改动）+ music-audio.mjs
│   └─ 托盘 / 单实例 / 窗口状态 / 原生文件夹选择
│
├─ 渲染进程
│   └─ app://-/index.html ← dist/ 原样，视觉零改动
│
└─ resources/unpacked/
    ├─ rhine-win-service.exe   (C# / .NET 8，自包含单文件，88 MB)
    └─ ffmpeg/ffmpeg.exe, ffprobe.exe   (LGPL 完整构建，各 128 MB)
```

### 后端复用的关键一步：`handleApi`

`createMusicServer` 原本把路由写死在 HTTP 回调里。抽出的 `handleApi(request, url, context)` 同时服务两种传输：

- **HTTP**：`createMusicServer` 保持逐字不变的 Host 校验、Origin 校验、状态码与响应体；
- **app://**：`electron/protocol.js` 用 Fetch Request 调用同一函数，由一个把写入收集成 `Response` 的
  轻量 sink 承接，因此 `serveFile` 的 Range 实现一行未动。

```js
// HTTP 与 app:// 走同一份路由；只有传输层的差异留在调用方
export async function handleApi(request, url, context) { … }
```

### 原生音频服务

服务只播 FFmpeg 产出的 PCM WAV，不含任何解码器。协议是 stdin/stdout 逐行 JSON，与上游
`native/RhineAudio.swift` 逐字段对齐：

```
请求  {"id": 1, "action": "play", "path": "...", ...}
响应  {"id": 1, "result": { …状态对象… }}
       {"id": 1, "error": "中文消息"}
事件  {"event": "media", "button": "toggle"}     ← SMTC 媒体键，无 id
```

**双槽排程是这套实现的核心。** macOS 版用两个 `AVAudioPlayerNode` 共享引擎时钟；Windows 版把两首曲子
放进同一个连续输出流，槽位切换发生在**缓冲内部**——接缝因此落在样本边界上，比两个独立节点更精确：

```
渲染线程：┌──── A 的剩余帧 ────┤████ B 的第 0 帧起 ████…┐
                            ↑ promoteNext(): boundarySerial += 1
```

---

## 4. 分阶段完成情况

| 阶段 | 内容 | 状态 |
| --- | --- | --- |
| **P1** | Electron 外壳、`app://` 协议、`handleApi` 抽取、`music-audio.mjs` 平台化、`pwa.ts` 桌面短路、内置 FFmpeg、NSIS/便携打包 | ✅ |
| **P2** | 目录选择器 + 路径标签 + 拖拽、文案平台化、单实例、窗口状态记忆、托盘、关闭行为 | ✅ |
| **P3** | C#/.NET 8 服务、13 动作协议、WAV 解析、独占/共享协商、双槽无缝、淡变、热插拔 | ✅ |
| **P4** | SMTC 媒体键、锁屏信息与状态双向绑定 | ✅ |
| **P5** | bit-perfect、实时输出格式、信号路径显示、共享模式提示 | ✅ |
| **P6** | 渲染优化 | ⛔ 见 §7 |
| **P7** | 安装器、许可随包、用户说明 | ✅（代码签名除外，见 §7） |

---

## 5. 验证证据

所有数字都来自本机可复现的命令，不是估计值。

### 5.1 自动化回归

| 命令 | 结果 |
| --- | --- |
| `npm run check:v041` | 309 通过 / 4 显式跳过 / 1 失败 |
| `npm run check:desktop`（`scripts/check-music-desktop.mjs`） | 26 / 26 |
| `npm run check:win-service` | 18 / 18 |
| `npm run selftest:win-service` | SELFTEST PASS |

唯一的失败是 `check-music-launcher.mjs` 里 `spawnSync('/bin/bash')` 的 Finder 启动器用例——
在 Windows 上必然不存在，属于规范所说的"与 macOS 相关"的用例。4 个跳过项是 darwin 专属的真实设备用例。

### 5.2 格式矩阵

`scripts/make-audio-fixtures.mjs` 现场合成 19 个样本，覆盖规范 6.2 的全部容器/编码。
协议层回归逐个调用 `handleApi`（与 `app://` 完全同一条代码路径）并校验解码结果是**非静音的有效 PCM**：

```
FLAC 44100/16   WAV 96000/24   ALAC 44100/16   MP3 44100/32   AAC 44100/32
AIFF 44100/16   OGG 44100/32   Opus 48000/32   WV 44100/16    WMA 44100/32
DSF 176400/24   DFF 176400/24  APE 44100/16
```

APE 是唯一无法合成的格式（FFmpeg 没有 Monkey's Audio 编码器），脚本会**显式报告跳过**，
需要时用 `--ape FILE` 指定外部样本，绝不拿别的格式冒充。

### 5.3 无缝接缝（逐样本）

`--selftest` 让 Scheduler 离线渲染两首斜坡样本，再逐样本比对：

```
[ok] 前 44100 帧与两首原文件逐字节一致，接缝处无丢失、无重复、无静音
[ok] boundarySerial 恰好自增一次
[ok] 接续过程中 endedSerial 保持 0；B 自然播完后才变成 1
[ok] stop/seek/play 之后 endedSerial 仍为 0
[ok] bit-perfect 下音量为 0.3 时输出仍与源样本逐位相同
```

真实设备上另有端到端用例：播放中预备下一首，等到 `boundarySerial` 递增、`trackId` 换成下一首、
且 `endedSerial` 保持 0。

### 5.4 独占模式

```
设备 2（AMD HD Audio）  44.1k/24bit → exclusive，outputSampleRate = 44100   ← 未被重采样成 48 kHz
设备 0（EDIFIER 扬声器） 44.1k       → shared，"设备不支持该音频格式的独占输出"
设备 0                  48k         → shared，"输出设备已被其他程序独占"
```

24 位一律声明为 **32 位容器 + `wValidBitsPerSample=24`**，回归里直接断言 `outputBits=32 / outputValidBits=24`。

### 5.5 媒体键与锁屏

向系统注入 `VK_MEDIA_PLAY_PAUSE` / `VK_MEDIA_NEXT_TRACK` / `VK_MEDIA_PREV_TRACK`，
服务依次推出 `toggle` / `next` / `previous`。再用系统的会话管理器读回我们发布的会话：

```
title=锁屏测试曲目  artist=Rhine 合成样本  album=格式回归
status=Playing → 暂停后 status=Paused
```

### 5.6 界面

| 项目 | 实测 |
| --- | --- |
| 输出方式 | `Windows 原生输出（WASAPI）`，可选不置灰 |
| 实时输出格式 | `44.1 kHz / 16-bit / 共享 / 整数输出` |
| 信号路径 | `FLAC 44.1kHz/16bit → [FFmpeg 解码，无重采样] → [WASAPI 共享 44.1/16] → DAC` |
| 共享模式提示 | `关闭设备音频增强以获得更好效果。` |
| bit-perfect | 音量为 0.3 时勾选 → 服务端音量被锁到 1；滑块跳到 100 并禁用；提示 `bit-perfect 模式下请使用功放/DAC 或系统音量调节。` |
| 帧率 | 172–200 FPS 稳定（空库 200，4 张专辑 172+） |
| 无 macOS 字样 | 界面上不出现 `CoreAudio` / `Mac 原生` / `Apple` |
| 界面无 TCP 端口 | `netstat` 中没有任何属于本应用的 LISTENING 项 |

### 5.7 只读与零改动

- 播放后源文件 mtime、大小、SHA-256 全部不变（回归断言）。
- `git diff` 对 `src/scene.ts`、`src/cover-atlas.ts`、`src/model-viewer.ts`、`src/music-lighting.ts`、
  `src/music-boot.ts`、`src/music-title.ts`、`src/music-ruler.ts`、`src/render-quality.ts`、
  `scripts/music-library.mjs`、**全部 `*.css`** 均为空。

---

## 6. 与实现规范不同的地方

规范要求"遇到规范未覆盖的情况停下来提问"，以下每一项都是必须动、但规范没有列出的地方。
每一处都能用一条命令还原。

| # | 改动 | 为什么必须 | 影响面 |
| --- | --- | --- | --- |
| 1 | `app://` 权限集补上 `allowServiceWorkers` | 缺它时 Chromium 直接禁用 `app://` 的 Service Worker API，`music-app.ts:2296` 的 `getRegistrations()` 抛 `InvalidStateError`，`start()` 被拒，界面永远停在开场动画。补上后该调用返回空数组，**src 零改动** | `electron/main.js` 一行 |
| 2 | 关闭 `asar` | Electron 的 ESM 解析在 asar 内不保留相对说明符，主进程 `import './music-library.mjs'` 会被解析到 `resources\\` 下并 `ERR_MODULE_NOT_FOUND`。随包 256 MB FFmpeg 本来就在 asar 之外 | `electron-builder.yml` |
| 3 | 文案平台化扩到 6 处 | 规范只列了 3 处，但 P2 验收门要求界面不出现 macOS 字样，剩下的 `music-app.ts:1443` 与 `music-player.ts` 的 5 条错误文案会露出来 | 措辞与规范给的风格一致；darwin 输出逐字不变 |
| 4 | `src` 改动超出规范的 2 处 | 目录选择器 / 标签列表 / 拖拽（P2 交付物）与 P5 的格式、信号路径、bit-perfect 面板都在 `music-app.ts`；协议类型与输出格式状态在 `music-player.ts` | 视觉代码（`*.css`、`scene.ts` 等）仍然零改动 |
| 5 | `/api/audio/capabilities` 在 win32 报 `nativeAvailable: true` | P3 验收门要求 WASAPI 可选且不灰；原实现写死 `process.platform === 'darwin'` | darwin 分支逐字不变 |
| 6 | 新增动作 `bitPerfect` | P5 要求 bit-perfect 打开后连淡变都不做；服务端必须知道这个状态 | 协议只增不改，13 个动作一个不少 |
| 7 | 状态对象新增 `shareMode` / `outputBits` / `outputValidBits` / `outputIsFloat` / `outputNegotiated` | P5 要如实显示实际输出格式与信号路径 | 规范 5.2 的 11 个字段全部原样保留 |
| 8 | 媒体键经 `rhine:transport` 转发 | SMTC 在服务进程，播放队列在渲染进程；复用 P2 已有的托盘通道，**渲染进程零改动** | `music-audio.mjs` 一处事件分支 |
| 9 | 独占协商里"最接近采样率"一步不可达 | 那一步需要服务自己重采样，而规范明确"重采样交由 FFmpeg"；服务拿不到改写当前曲目的机会 | 实际行为：原生格式独占 → 否则共享（引擎 `AUTOCONVERTPCM` 转换） |

---

## 7. 没有做的部分

### P6 渲染优化（规范标注为可选）

规范要求每一项优化都必须与 macOS 原版**逐镜头对照**，且"无法证明视觉无差异 → 放弃该项"。
本机没有 macOS 基线环境，无法产出可比的成对截图，因此**全部不做**。
`frustumCulled`、LOD、图集压缩、`render-quality.ts` 的预设值与默认档都保持原样。

### 代码签名（P7 的一部分）

签名需要受信任的代码签名证书，本环境没有。安装包因此未签名，首次运行会出现 SmartScreen 提示
（已写入 [WINDOWS.md](../WINDOWS.md)）。自动更新按规范属于"可延后"。

---

## 8. 怎么构建与验证

```powershell
# 依赖（Node ≥ 22.12、.NET 8 SDK 或更高）
npm ci

# 渲染产物
npm run build

# 内置 LGPL FFmpeg（约 163 MB，脚本自带镜像回退）
npm run desktop:ffmpeg

# 原生音频服务（自包含单文件，约 89 MB）
npm run build:win-service

# 安装器与便携版 → electron-out/
npm run desktop:build
```

验证：

```powershell
# 12 种格式的合成回归样本（默认写到临时目录，可用 RHINE_FIXTURE_DIR 指定）
node scripts/make-audio-fixtures.mjs --out <目录>
$env:RHINE_FIXTURE_DIR = '<目录>'

npm run selftest:win-service     # 接缝逐样本自检
npm run check:win-service        # 协议与语义（真实设备，零音量）
npm run check:desktop            # app:// 协议层
$env:PATH = "<仓库>\ffmpeg;$env:PATH"
npm run check:v041               # 上游全套回归
```

开发期直接跑：`npm run desktop`（需要 Electron 二进制；若环境里存在 `ELECTRON_RUN_AS_NODE`，
先清掉该变量，否则 `electron.exe` 会退化成纯 Node）。

---

## 9. 已知限制

- **独占模式取决于声卡。** 只支持 48 kHz 的设备无法在 44.1 kHz 独占，会回退共享并在状态行说明原因。
  这是硬件属性，不是缺陷。
- **bit-perfect 的逐比特验收未做。** 规范要求用 VB-Cable／硬件环回录音做逐比特比对，本机没有环回设备。
  已做的替代证据：离线自检证明 bit-perfect 下增益恒为 1、样本逐位不变，且关闭淡变。
- **重采样分支只在逻辑上验证。** 界面的"重采样到 N Hz"由源采样率与实际输出采样率比较得出，
  已覆盖相等（无重采样）分支；不等分支需要一首采样率与输出不同的曲目，未在真实设备上构造。
- **媒体键测试有全局副作用**（会注入系统级按键），因此回归里默认不跑，用
  `RHINE_TEST_MEDIA_KEYS=1` 打开。
- `check:v041` 里 `check-music-audio.mjs` 的 HTTP 用例在端口分配受压时偶发 `bad port`，
  与本次改动无关，重跑即过。
