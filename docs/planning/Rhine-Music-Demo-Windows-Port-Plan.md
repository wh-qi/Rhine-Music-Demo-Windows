# Rhine Music Demo V0.4.1 → Windows 移植方案

> 分析对象：`https://github.com/RonaldDeng/Rhine-Music-Demo`
> 分析对象：上游 `Rhine-Music-Demo` 的本地工作副本（main @ `dd2370f`，2026-10-07，package.json 版本 0.4.1）
> 本文件由只读分析 + Windows 实机验证得出，未修改被克隆仓库的任何文件。

---

## 一、项目全貌

这不是一个普通网页，而是「**本机 Node 服务 + 浏览器界面**」的本地音乐终端，macOS 主线用启动器脚本把两者串起来。

```
双击 启动音乐播放器.command (bash)
  └─ node scripts/launch-music.mjs        启动器：选端口 / 装依赖 / 构建 / 拉起服务 / 开浏览器
       ├─ 构建：tsc → vite build → scripts/build-pwa.mjs   （产物 dist/）
       └─ spawn 后台：node scripts/music-server.mjs --port 5175
            ├─ music-library.mjs   44KB  扫描曲库、读标签、封面、流派规则、MusicBrainz/QQ 资料
            ├─ music-audio.mjs     24KB  AudioDecoder（FFmpeg → PCM WAV 缓存）
            │                            NativeAudioOutput（驱动原生音频进程）
            └─ 静态服务 dist/ + /api/*
                 └─ 浏览器端 src/（Three.js 三维专辑架 + music-player.ts 播放控制）
```

**技术栈**：TypeScript + Three.js 0.183 + Vite 7 + Node ≥ 22.12；依赖仅 4 个运行时包（three / music-metadata / opencc-js / rolling-number）。

### 两条音频路线（这是移植的核心）

| | 浏览器路线 `browser` | 原生路线 `coreaudio` |
| --- | --- | --- |
| 实现 | `HTMLAudioElement` + Web Audio（`music-browser-gapless.ts`） | `native/RhineAudio.swift`，首次使用时用 `swiftc` 现编译 |
| 通信 | 浏览器内 | JSON-lines 过 stdin/stdout 子进程 |
| 无缝播放 | Web Audio 时钟排程 | `AVAudioEngine` + **两个** `AVAudioPlayerNode`，按引擎时钟精确排程 |
| 设备选择 | 无 | CoreAudio 设备枚举 + 切换 |
| 限制 | 单曲 PCM ≤ 128 MiB，预算 384 MiB | 流式，2 GiB 上限 |
| Windows 可用 | ✅ 可用 | ❌ `music-audio.mjs:211` 直接抛「CoreAudio 输出仅适用于 macOS」 |

后端选择在 UI 设置里的「音频输出」；`src/music-app.ts:1404` 会在 `nativeAvailable=false` 时**自动禁用**原生选项。

### 关键观察：原生进程其实只是一个「WAV 播放器」

`AudioDecoder.prepare()` 无论源文件是 APE / DSD / WV / FLAC，最终都产出 **WAV PCM** 缓存文件；原生侧拿到的 `path` 永远是 `.wav`（`music-audio.mjs:183`、`:313`），Swift 端只调用 `AVAudioFile(forReading:)`。

> **这意味着 Windows 原生桥不需要任何解码器、不需要 minimp3/libFLAC，只需要「WAV 解析 + WASAPI 输出 + 时钟排程」。** 移植难度比看起来低得多。

---

## 二、Windows 实机验证结果

环境：Windows，Node v24.19.0，git 2.48，npm 11.11。未安装 FFmpeg / swiftc。

| 步骤 | 命令 | 结果 |
| --- | --- | --- |
| 安装依赖 | `npm ci` | ✅ **成功**，41 个包，10 秒 |
| 生产构建 | `npm run build` | ✅ **成功**，`tsc` 无错，vite 118 模块，PWA 75 文件 28.6 MiB，86 文件 / 37.4 MiB |
| 启动服务 | `node scripts/music-server.mjs --port 5199` | ✅ **成功** |
| 健康检查 | `GET /api/health` | ✅ 200 `{service, projectDir:"E:\\dsh\\...", pid}` |
| 音频能力 | `GET /api/audio/capabilities` | ✅ 200，`decoderAvailable:false`（无 FFmpeg）、`nativeAvailable:false` |
| 原生状态 | `GET /api/output/state` | ❌ **503** 「CoreAudio 输出仅适用于 macOS」 |
| 曲库接口 | `GET /api/library` 等 | ✅ 正常（`path`/`url` 模块使用规范） |

**结论：整个 Web 部分在 Windows 上开箱即用，`git status` 干净。** 构建产物、静态服务、曲库 API 全部正常。

**唯一危险的 503**：`/api/output/state` 与 `/api/output/command` 在 Windows 必然失败。但前端只在 `backend === "coreaudio"` 时轮询（`music-player.ts:966`），而该后端在 `nativeAvailable=false` 时被禁用，所以**当前不会触发**——这是一个「只要用户不点就没事」的隐患，仍需修掉。

---

## 三、移植缺口清单

| # | 缺口 | 位置 | 严重度 |
| --- | --- | --- | --- |
| **G2** | **FFmpeg 永远找不到** | `music-audio.mjs:23` | 🔴 **致命** |
| G1 | 原生音频后端缺失 | `native/RhineAudio.swift`、`music-audio.mjs:211` | 🟠 高（功能缺失，不崩） |
| G3 | 启动器是 bash `.command` | 根目录 + `tools/launchers/*` | 🟠 高（无法双击启动） |
| G4 | 开浏览器用 `/usr/bin/open` | `launch-music.mjs:219` | 🟠 高 |
| G5 | 端口占用识别用 `lsof`/`ps` | `launch-music.mjs:42-54` | 🟡 中（已有 darwin 守卫，退化为保守判定） |
| G6 | `chmod 0600/0700` | `music-audio.mjs:179,180,219` | 🟢 低（NTFS 上为无害空操作） |
| G7 | `constants.X_OK` 语义 | `music-audio.mjs:17` | 🟡 中（与 G2 合并修） |
| G8 | 数据目录 `../music-data-v3` | `launch-music.mjs:225` | 🟡 中（建议迁到 `%LOCALAPPDATA%`） |
| G9 | 检查脚本大量 `skip: darwin` | `scripts/check-*.mjs` | 🟡 中 |
| G10 | `detached` 子进程 / 信号 | `launch-music.mjs:198`、`music-server.mjs:222` | 🟡 中（Windows 下 detached 会弹控制台窗口） |
| G11 | UI 示例路径写死 `/Users/你/Music` | README、设置页占位符 | 🟢 低（曲库代码本身用 `path`，正确） |
| G12 | 已有 `/api/foobar/*` Beefweb 代理**未被利用** | `music-server.mjs:183-195` | 🟢 低（但这是方案 D 的现成抓手） |

### 🔴 G2 详情（已实测复现）

```js
// scripts/music-audio.mjs:23
for (const candidate of [`/opt/homebrew/bin/${name}`, `/usr/local/bin/${name}`, `/usr/bin/${name}`,
    ...(process.env.PATH ?? '').split(path.delimiter).map((dir) => path.join(dir, name))]) {
```

Windows 上可执行文件是 `ffmpeg.exe`，而 `path.join(dir, 'ffmpeg')` 得到无扩展名路径，`fs.access` 必然 `ENOENT`。

**实测**：把 `node.exe` 复制为 `ffmpeg.exe`/`ffprobe.exe` 并放进 PATH 后——

```
ffmpeg  (current code) => NOT FOUND
ffprobe (current code) => NOT FOUND
```

改成扩展名感知（`['ffmpeg.exe','ffmpeg.cmd','ffmpeg']`，并可优先读 `PATHEXT`）后：

```
FIXED => found C:\...\rhine-ffmpeg-probe\ffmpeg.exe
```

**后果**：即使 Windows 用户正确安装了 FFmpeg，`decoderAvailable` 仍为 `false`，于是 **APE / WV / WMA / DSF / DFF / ALAC 等格式完全无法播放，无缝播放也彻底不可用**——只剩浏览器能原生解的 MP3/AAC/FLAC/WAV。这是移植的第一优先级。

---

## 四、四个方案

### 方案 A — 最小可行移植：「Web + 浏览器输出」

**思路**：不动原生层，只把「跑不起来」的地方修好，让 V0.4.1 在 Windows 上完整可用（浏览器音频路线）。

**改动**（约 4 个文件）：
1. `music-audio.mjs` — `findExecutable` 加 Windows 扩展名感知（`.exe/.cmd/.bat` + `PATHEXT`）；`X_OK` 在 win32 退化为 `F_OK`；保留 `FFMPEG_PATH`/`FFPROBE_PATH` 覆盖。
2. `music-audio.mjs` — `NativeAudioOutput.init()` 的 `platform !== 'darwin'` 改成「返回明确的不可用状态」而非抛错，让 `/api/output/state` 不再 503（改为 200 + `nativeAvailable:false`），避免任何边缘路径炸 UI。
3. `launch-music.mjs` — `openBrowser` 按平台分支：win32 用 `start "" url`（经 `cmd /c`）或 `explorer.exe url`；Linux 用 `xdg-open`。
4. 新增 `启动音乐播放器.cmd`（等价于现有 `.command`）+ `tools/launchers/*.cmd`；`spawn` 加 `windowsHide: true`；数据目录默认改 `%LOCALAPPDATA%\RhineMusic\music-data-v3`（保留 `MUSIC_DATA_DIR` 覆盖）。

**优点**：成本最低（1–2 人日）；全部 40+ 项既有回归检查仍能复用；零新依赖。
**缺点**：没有设备选择；无缝播放受 128 MiB PCM 上限约束；仍是「浏览器标签页」而非桌面应用。
**适合**：想最快验证 / 自己听歌够用 / 作为后续方案的基线。

---

### 方案 B — 对称移植：用 Windows 原生音频桥替换 Swift

**思路**：保持 `NativeAudioOutput` 的 **JSON-lines 协议逐字不变**，只把对端从 `RhineAudio.swift` 换成 Windows 实现。前端 `music-player.ts`、`music-server.mjs` **一行都不用改**，只改 `music-audio.mjs` 里的「选哪个二进制 / 怎么构建」。

**协议契约**（必须完全实现，取自 `RhineAudio.swift` 与 `music-audio.mjs`）：

- 传输：stdin 逐行收 JSON，stdout 逐行回 `{"id":n,"result":{...}}` 或 `{"id":n,"error":"..."}`
- 命令：`devices` `state` `device` `play` `pause` `stop` `seek` `volume` `transition` `prepareNext` `cancelNext` `fadeOut`
- 状态字段：`trackId playing currentTime duration volume deviceId endedSerial transitionMode nextTrackId boundarySerial outputSampleRate`
- 关键语义（不能简化）：
  - **双槽**：当前 + 预备各占一个播放槽，`promoteNext()` 时 `boundarySerial += 1`
  - **`endedSerial`** 仅在自然播完时自增（手动停止不自增）
  - **无缝**：`prepareNext` 必须在当前曲目**结束前至少 20 ms** 完成排程，否则报错让上层降级
  - **`outputSampleRate`** 必须真实上报——上层据此让 FFmpeg 把下一首归一化到同一采样率，这是整数帧对齐的前提
  - **`fadeOut`**：28 步 × 16 ms 的 smoothstep 音量斜坡
  - **切设备**：保留播放位置与播放状态，重建输出后 `schedule(at: position)`

**Windows 侧映射**：

| Swift / macOS | Windows 等价 |
| --- | --- |
| `AVAudioFile(forReading:)` | 自己解析 WAV（PCM 已是固定格式，几十行即可） |
| `AVAudioEngine` | `IAudioClient`（WASAPI 共享模式）+ 专用渲染线程 |
| `AVAudioPlayerNode` ×2 | 两个环形缓冲源，在渲染回调里求混合和 |
| `AVAudioPlayerNode.play(at:)` | 在渲染循环里按**输出帧计数**到点切换槽位 |
| `AudioObjectGetPropertyData` 枚举设备 | `IMMDeviceEnumerator::EnumAudioEndpoints(eRender)` |
| `kAudioOutputUnitProperty_CurrentDevice` | 对目标 `IMMDevice` `Activate` 出新的 `IAudioClient` |
| `playerTime(forNodeTime:)` | 已写出的帧数 ÷ 采样率 |

**技术栈三选一**：

- **B1 · C# / .NET 8 + NAudio**：最快落地。`dotnet publish -c Release -r win-x64 --self-contained` 或 framework-dependent；NAudio 的 `WasapiOut`/`WaveOutEvent` 与 `MMDeviceEnumerator` 直接覆盖设备枚举与共享模式输出。开发效率最高。
- **B2 · Rust + `windows` crate**：单一 exe、无运行时依赖、启动快，最接近 Swift 那种「现编译小工具」的手感；坑在于 WASAPI 事件驱动回调写法较繁琐。**综合推荐**。
- **B3 · C++ / Win32 + WASAPI**：与 CoreAudio 语义最贴近，且**独占模式 / 事件驱动 / 硬件采样率切换**都能做到，是唯一能真正超越 macOS 主线音质上限的选项。开发成本最高。

**构建方式**：仿照 Swift 的「首次使用时编译」，Windows 可改为
- C#：检测 `dotnet`，无则回退 `Add-Type`/`csc.exe`；或**直接以自包含发布产物随包分发**（更稳，用户无需装 SDK）
- Rust/C++：**预编译二进制随包分发**（用户机器上不该要求装 MSVC）

> 建议：**把编译产物预置进发行包**，而不是像 macOS 那样要求用户有 `swiftc`。Windows 用户装 Build Tools 的意愿远低于 Mac 用户装 Command Line Tools。

**优点**：功能与 macOS 主线对齐（设备选择、流式、真无缝、2 GiB 上限）；前端零改动；彻底摆脱 128 MiB 浏览器上限。
**缺点**：需要真正的原生开发；额外的构建/分发链；WASAPI 排程正确性需要专门测试。
**适合**：目标就是「Windows 上也有 macOS 那样的完整体验」。

---

### 方案 C — 桌面应用封装：Electron / Tauri / WebView2

**思路**：方案 A 或 B 之上再套一层原生窗口，做成真正的 `.exe` / 安装包，双击即用、无需终端、无需浏览器。

| 子方案 | 体积 | 工作量 | 关键点 |
| --- | --- | --- | --- |
| **C1 · Electron** | ~150 MB | ⭐ 最低 | **主进程本身就是 Node**，`music-server.mjs` 几乎原样跑在 `utilityProcess`/`fork` 里；Chromium 固定，WebGL 表现一致；自带 AAC/H.264 解码。几乎等于「把方案 A 装进壳里」。 |
| **C2 · Tauri 2** | ~8 MB | ⭐⭐⭐ 中高 | 安装包小、内存低；但后端是 Rust，要么把 Node 服务当 sidecar 打包（体积回去且要处理进程管理），要么用 Rust 重写 `music-library.mjs`（44 KB，很重）。 |
| **C3 · WebView2 + .NET WinForms/WPF** | ~30 MB | ⭐⭐ 中 | 依赖系统 WebView2 Runtime（Win11 自带，Win10 需装）；WebGL 与音频行为随 Edge 版本浮动，风险高于 Chromium。 |

**优点**：真正的 Windows 应用体验；可加托盘、开机自启、文件关联、单实例锁、原生菜单。
**缺点**：多一层打包维护；Electron 体积大；Tauri/WebView2 有重写成本。
**适合**：要发给不懂命令行的用户。

---

### 方案 D — 复用成熟 Windows 播放器后端（性价比最高的音质方案）

**思路**：不自己写音频输出，让 foobar2000 / mpv 去解码和输出，本工程只当**遥控器和界面**。

**已有抓手**：`music-server.mjs:183-195` **已经实现了 `/api/foobar/*` → Beefweb 的反向代理**（含 `foobarBaseUrl` 配置项、`/api/foobar/status` 探测），只是 macOS 主线没用起来。`src/music-app.ts` 里对应的 UI 面板也是现成的骨架。

**三个子方案**：

- **D1 · foobar2000 + Beefweb 组件**（推荐）
  - foobar 负责 APE / WV / DSD / WMA 等一切解码 + **独占 WASAPI / ASIO / DSD 原生输出**，音质上限远高于本工程自研的任何路线
  - Beefweb 提供 HTTP API，本工程已有代理层，补一个 `FoobarBackend` 实现即可（对齐 `MusicPlayer` 的 `backend` 接口）
  - 需新增：`music-player.ts` 里第三个 backend 分支 + 状态同步（轮询 `/api/foobar/player`）
  - **顺带绕过了 G2**：解码交给 foobar，本工程不再需要 FFmpeg

- **D2 · mpv + JSON IPC**
  - `mpv --input-ipc-server=\\.\pipe\mpv`，命名管道 JSON 协议，能力覆盖 WASAPI 独占、gapless、DSD
  - 需新增一个 Node 侧的命名管道客户端（`net.connect('\\\\.\\pipe\\mpv')`）
  - 比 D1 更轻量、更可脚本化，但没有曲库管理（本工程已有自己的曲库，正好互补）

- **D3 · LX Music 后端**
  - 参考社区分支 [RelaxFish01/rhine-lab-music](https://github.com/RelaxFish01/rhine-lab-music) 的做法
  - 适合已用 LX Music 的用户，但引入第三方强耦合

**优点**：**开发量最小、音质上限最高**；独占输出、DSD 原生、ASIO 全部免费获得；不需要任何原生编译工具链。
**缺点**：用户必须额外装 foobar2000/mpv；播放状态是「外部真相」，UI 同步要做轮询与容错；播放列表所有权需要明确划分。
**适合**：目标用户是发烧友 / 本地曲库党，且不介意多装一个软件。

---

### 方案 E — 直接采用社区 Windows 分支

README 与 `docs/COMMUNITY-VERSIONS.md` 已登记 5 个衍生版本，其中 3 个是 Windows 方向：

| 项目 | 方向 | 基准 |
| --- | --- | --- |
| [Bong712/Rhine-Music-Windows](https://github.com/Bong712/Rhine-Music-Windows) | Windows 桌面移植、WebView2、LRC 歌词、播放队列 | 未标注 |
| [1494948/rhine-music-windows](https://github.com/1494948/rhine-music-windows) | WebView2 本地改造 + 歌词动效 + 资料来源扩展（另有 Electron 路线） | v0.3.0-local.4 |
| [MT-gar/Rhine-Music-Demo-Win-](https://github.com/MT-gar/Rhine-Music-Demo-Win-) | V0.3.0 的 Windows 适配 + 在线专辑架（Internet Archive / Subsonic） | **V0.3.0** |

**优点**：几乎零开发；可能已解决 G1/G3/G4。
**缺点**：基准落后于 V0.4.1（缺真实专辑列、列位置记忆、无缝播放三档、词轮标题等）；主线明确声明**不审查、不验证**这些分支；引入未知代码安全面。
**适合**：只求能跑、不想投入开发；或作为方案 A/B 的**参考实现**去抄启动器和打包部分。

> ⚠️ 注意仓库约定：主线**不接收 PR**（`AGENTS.md` / `CONTRIBUTING.md`）。移植工作应作为**独立 Fork**进行，并按 `community_fork.md` 模板登记 Issue；不要改写已有 Git 历史，保留 LICENSE / NOTICE.md / README.original.md 与全部第三方许可。

---

## 五、方案对比

| 维度 | A 最小可行 | B 原生桥 | C 桌面封装 | D 复用播放器 | E 社区分支 |
| --- | --- | --- | --- | --- | --- |
| 工作量 | 1–2 人日 | 8–15 人日 | A/B + 3–6 人日 | 3–6 人日 | ~0 |
| 全格式播放 | ⚠️ 修 G2 后可用 | ✅ | ✅ | ✅ | 视分支 |
| 无缝播放 | ⚠️ 128 MiB 上限 | ✅ 流式 | ✅ | ✅ | 视分支 |
| 设备选择 | ❌ | ✅ | ✅ | ✅（且独占/ASIO） | 视分支 |
| 音质上限 | 浏览器重采样 | WASAPI 共享 | 同左 | **独占 / ASIO / DSD** | 视分支 |
| 依赖用户装 | Node + FFmpeg | Node + FFmpeg | 无 | Node + foobar/mpv | 无 |
| 新依赖 | 无 | .NET / Rust / MSVC | Electron/Tauri | 无（复用已有代理） | 未知 |
| 保持 V0.4.1 主线同步 | ✅ 容易 | ✅ 容易 | ✅ 容易 | 🟡 中（多一个后端） | ❌ 分叉 |
| 回归检查可复用 | ✅ 全部 | ✅ 大部分 | ✅ | 🟡 音频类需重写 | ❌ |

---

## 六、推荐路线（分阶段，可随时停下）

**阶段 0 · 立刻可做（半天）** — 先让它在 Windows 上真的能听
1. 修 **G2**（FFmpeg 扩展名感知）—— 这是投入产出比最高的一处
2. 修 **G4**（`openBrowser` 平台分支）+ **G10**（`windowsHide: true`）
3. 新增 `启动音乐播放器.cmd` + `tools/launchers/*.cmd`
4. 修 G1 的 503（`/api/output/*` 在非 darwin 返回 200 + 明确不可用）

→ 此时你得到一个**功能完整的 Windows 版 V0.4.1**，浏览器音频路线，全格式（除浏览器原生解码外由 FFmpeg→WAV 覆盖）。

**阶段 1 · 桌面化（2–4 人日）** — 选 **方案 C1（Electron）**
把阶段 0 的成果装进 Electron：`music-server.mjs` 跑在 `utilityProcess`，主窗口加载 `http://127.0.0.1:<port>`，加单实例锁 + 托盘 + 退出时清理服务。产出 `.exe` 与安装包，用户不再需要终端和 Node。

**阶段 2 · 音质与体验对齐（按需选一条）**
- 想**完全对齐 macOS 主线** → 走 **方案 B**，先把 JSON-lines 协议用 C# + NAudio 实现一版（B1，最快），跑通后再考虑 Rust 重写（B2）与独占模式（B3）
- 想**音质上限最高且最省力** → 走 **方案 D1**（foobar2000 + Beefweb），因为它连 G2 都一并绕过

**阶段 3 · 回归与分发**
- 把 `scripts/check-*.mjs` 里 `skip: process.platform !== 'darwin'` 的用例按平台拆分，Windows 侧补 WASAPI / Beefweb 的对应断言
- 用 `npm run check:v041` 作为回归基线，缺样本时**显式跳过**而不是伪装通过（这是仓库既有约定）
- 分发：方案 C 出安装包；纯 Web 方案出「解压即用」zip + `.cmd`

---

## 七、逐文件改动清单（阶段 0，可直接照做）

| 文件 | 改动 |
| --- | --- |
| `scripts/music-audio.mjs` | ① `findExecutable`：候选名按平台加 `.exe/.cmd/.bat`，优先 `PATHEXT`；win32 用 `F_OK`。② `AudioDecoder.init`：`mode: 0o700` 在 win32 省略。③ `decode`/`init` 的 `chmod` 在 win32 跳过。④ `NativeAudioOutput.init`：非 darwin 不抛错，置 `unavailable` 标志；`command()` 在不可用时返回带 `error` 的正常状态 |
| `scripts/music-server.mjs` | `/api/audio/capabilities`：`nativeAvailable` 改为「非 darwin 时也返回 false 但带 `nativeError` 说明」；`/api/output/state`、`/api/output/command` 在原生不可用时返回 200 + 明确错误，避免 503 泄漏到 UI |
| `scripts/launch-music.mjs` | ① `openBrowser`：`win32 → start "" url`、`darwin → open`、`else → xdg-open`。② `sameLegacyProcess`：win32 可用 `netstat -ano` + `tasklist` 实现，或保持返回 `false`（保守，可接受）。③ `startServer` 的 `spawn` 加 `windowsHide: true`。④ 数据目录默认值：win32 → `%LOCALAPPDATA%/RhineMusic/music-data-v3` |
| `启动音乐播放器.cmd`（新增） | 检查 `node`/`npm`；`cd /d %~dp0`；`node scripts\launch-music.mjs`；失败时 `pause` |
| `tools/launchers/*.cmd`（新增） | 对应 `启动演示.command`、`启动光照实验.command` |
| `README.md` / 设置页 | 路径示例改为 `D:\Music`，依赖表标注 Windows 差异 |

---

## 八、需要留意的既有约定

- 音乐服务**只监听 127.0.0.1**，保留 Origin / Host 校验、目录边界校验（`serveFile` / `checkedSource` 的 `path.relative` 越界检查）。移植时**不要**为了方便改成监听 `0.0.0.0`。
- 源文件与标签**只读**；不提交真实歌曲、封面缓存、索引、令牌、本机路径。
- 数据目录默认 `../music-data-v3`，可用 `MUSIC_DATA_DIR` 覆盖——移植时保留这个约定。
- 播放、界面音效、氛围音乐三者相互独立；搜索定位**不**改变播放状态。
- 无缝播放**必须**用音频时钟连续排程实现，**不允许**用「关掉淡入淡出」或 `HTMLAudio.preload` 冒充。
- 真实音频设备的自动测试必须**零音量**；样本缺失要显式跳过，不能把模拟测试说成真实格式验收。
- Node.js 最低 22.12.0；用锁文件安装。

---

## 九、一句话总结

**这个项目 90% 已经是跨平台的**——`npm ci`、`npm run build`、音乐服务、曲库 API 在 Windows 上实测全部通过。真正的移植工作只集中在三处：**FFmpeg 发现逻辑（一个必现的 bug，改 5 行就能解封全部高级格式）**、**macOS 专属的音频输出后端（可修可换可绕过）**、**bash 启动器（重写成 .cmd 即可）**。建议按「阶段 0 → Electron → 按需选原生桥或 foobar2000」推进。
