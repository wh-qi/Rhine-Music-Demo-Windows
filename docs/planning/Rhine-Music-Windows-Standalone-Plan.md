# Rhine Music · Windows 纯本地独立版方案

> 目标：**Windows 独立应用** —— 双击一个 `.exe` 即用，不要外部浏览器标签页，不要 localhost 网址，不要终端，不要求用户预装 Node.js。
> 分析基础：上游 `Rhine-Music-Demo` 的本地工作副本（V0.4.1 @ `dd2370f`），已在 Windows 实测 `npm ci` / `npm run build` / 音乐服务全部通过。

---

## 零、先把「不用浏览器」拆成两种含义

这决定了工作量差 **20 倍以上**，必须先选：

| | 含义 | 做法 | 工作量 |
| --- | --- | --- | --- |
| **R1（弱）** | 不要用户**自己的** Chrome/Edge、不要地址栏、不要网址、不要终端 | 内嵌 WebView（Electron / WebView2 / Tauri） | 3–25 人日 |
| **R2（强）** | **完全不要任何 Web 引擎**，纯原生 GPU 渲染 | 用 Rust+wgpu / C++ D3D12 重写整个界面 | 150–300 人日 |

**R1 不是「用浏览器」**：Electron 自带 Chromium、WebView2 是系统组件，两者都没有地址栏、没有标签页、用户无法察觉也无需安装——从用户视角就是一个普通桌面软件。

**R2 为什么这么贵**：这个项目的界面**远不止一块 3D 画布**。实测依赖：

| 依赖面 | 规模 |
| --- | --- |
| WebGL / canvas | **103 处，16 个文件**（含 `scene.ts` 94 KB、`cover-atlas.ts` 22 KB、`model-viewer.ts` 27 KB） |
| DOM 布局读取（`getBoundingClientRect` 等） | **42 处，12 个文件** |
| CSS 总量 | `music.css` 47 KB + `style.css` 38 KB + `responsive.css` 19 KB + 其余 ≈ **130 KB** |
| 高级 CSS 特效 | `backdrop-filter` 磨砂、`clip-path`、`mask-image`、字轮动画、分阶段过渡 |
| 业务逻辑 | `music-app.ts` **115 KB** + `music-player.ts` 47 KB |

R2 意味着重写**约 700 KB TypeScript + 130 KB CSS 的全部视觉效果**，包括磨砂玻璃、CD 盒立体动效、专辑列波浪、开场字轮。除非你的目标就是「摆脱 Web 技术栈」，否则不建议。

> **下面的方案 1–4 属于 R1，方案 5 是 R2 的诚实评估。**

---

## 一、所有方案共用的三个架构决策

### 决策 A：本地 HTTP 服务要不要保留？

前端只有 **8 个 `fetch()` 调用点、13 个端点**，改造成本极低：

```
/api/library  /api/library/scan  /api/library/enrich  /api/library/introductions
/api/library/credits  /api/config  /api/genre-rules  /api/audio/capabilities
/api/audio/prepare/:id  /api/audio/:id  /api/decoded-audio/:id  /api/output/state  /api/output/command
```

三条路：

| 路线 | 做法 | 评价 |
| --- | --- | --- |
| **A1 保留 127.0.0.1** | 随机端口跑 `music-server.mjs`，窗口加载 `http://127.0.0.1:<随机端口>` | **零改动**，但仍有 TCP 端口、仍需 Origin/Host 校验 |
| **A2 自定义协议（推荐）** | 注册 `app://` 为 standard+secure scheme，在进程内处理 | **无需改前端**（相对路径 `fetch("/api/x")` 自动解析为 `app://-/api/x`），**彻底没有端口**，端口冲突问题（原 G5）自动消失 |
| **A3 纯 IPC** | 把 8 个 fetch 改成 `invoke()` | 要动前端，收益不比 A2 大 |

**推荐 A2**。Electron 侧：

```js
// main.js
import { protocol, net } from "electron";
protocol.registerSchemesAsPrivileged([
  { scheme: "app", privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } },
]);
app.whenReady().then(() => {
  protocol.handle("app", async (request) => {
    const url = new URL(request.url);          // app://-/api/library 或 app://-/assets/x.js
    if (url.pathname.startsWith("/api/")) return handleApi(request, url);   // 直接调用 music-server 里的处理函数
    return net.fetch(pathToFileURL(path.join(DIST, url.pathname)).toString()); // dist/ 静态资源，自动支持 Range
  });
});
```

关键点：`music-server.mjs` 的 `serveFile` 已实现 **Range 请求**（音频拖动进度必需），`net.fetch` 走 `file://` 会保留 Range 支持，直接复用。

### 决策 B：曲库逻辑放哪？（这是选型的分水岭）

`scripts/music-library.mjs` 有 **44 KB**，依赖两个 npm 包：

- `music-metadata` —— 支持 APE / WavPack / DSD(DSF/DFF) / WMA 等冷门格式的标签与封面读取，非常成熟
- `opencc-js` —— 简繁转换（中文曲库检索必需）

| 宿主 | 曲库逻辑 | 代价 |
| --- | --- | --- |
| **Electron** | **原样复用**（内置 Node） | ⭐ 接近 0 |
| **WebView2 + C#** | C# 重写（`TagLib#` 或 `ATL.NET`）+ 简繁转换库 | 中 |
| **Tauri** | Rust 重写（`lofty` + `opencc-rust`，冷门格式覆盖度存疑） | **高，且有功能倒退风险** |
| **Node SEA** | 原样复用（就是 Node） | ⭐ 接近 0 |

> ⚠️ **`music-metadata` 是这个项目最被低估的资产。** 换成 Rust 的 `lofty` 很可能在 APE / DSD / WavPack 标签上出现回归，而这类文件恰恰是本项目的目标用户群的收藏。**选 Electron 或 Node SEA 可以直接白拿这块能力。**

### 决策 C：音频输出走哪条？（所有外壳方案通用）

| 音频层 | 实现 | 能力 | 工作量 |
| --- | --- | --- | --- |
| **C1 Web Audio** | Chromium/WebView2 内置 | WASAPI **共享**模式；无设备选择；44.1→48 kHz 会被系统重采样；无缝播放受 128 MiB PCM 上限 | ⭐ 0 |
| **C2 原生 WASAPI 桥（推荐）** | 复刻 `native/RhineAudio.swift` 的 JSON-lines 协议，用 C# + NAudio 或 Rust + `wasapi` crate 实现 | 设备枚举与切换、**独占模式**、精确帧排程无缝、流式无上限 | 8–15 人日 |
| **C3 委托 foobar2000 / mpv** | 走已有的 `/api/foobar/*` Beefweb 代理 | 独占 / ASIO / 原生 DSD 全部白拿 | 3–6 人日 |

**C2 的关键事实（上一轮已验证）**：原生进程**只是个 WAV 播放器**——FFmpeg 已把一切格式转成 WAV 缓存，Swift 端只调 `AVAudioFile`。所以 Windows 桥**不需要任何解码器**，只要「WAV 解析 + WASAPI 输出 + 时钟排程」。

Windows 侧映射：

| Swift / CoreAudio | Windows / WASAPI |
| --- | --- |
| `AVAudioEngine` | `IAudioClient` + 专用渲染线程 |
| `AVAudioPlayerNode` ×2（双槽无缝） | 两个环形缓冲源，渲染回调里求混合和，**按输出帧计数**切换槽位 |
| `AudioObjectGetPropertyData` 枚举设备 | `IMMDeviceEnumerator::EnumAudioEndpoints(eRender)` |
| `kAudioOutputUnitProperty_CurrentDevice` | 对目标 `IMMDevice` `Activate` 新 `IAudioClient` |
| `playerTime(forNodeTime:)` | 已写出帧数 ÷ 采样率 |

必须保留的协议语义（否则上层 `music-audio.mjs` 要改）：`boundarySerial` 递增、`endedSerial` 仅自然播完自增、`prepareNext` 需在结束前 ≥20 ms 完成排程、真实上报 `outputSampleRate`、`fadeOut` 为 28×16 ms smoothstep。

> **音质上限排序：C3（独占+ASIO+原生DSD）> C2（独占 WASAPI）> C1（共享，系统重采样）。**

---

## 二、方案 1 · Electron 单文件桌面版 ⭐ 推荐

**一句话**：把现有的一切原封不动塞进 Electron，产出单个 `.exe`。

### 架构

```
RhineMusic.exe (Electron)
├─ 主进程 (Node 内置)
│   ├─ music-library.mjs      ← 原样复用（44 KB）
│   ├─ music-audio.mjs        ← 原样复用（FFmpeg 解码 + PCM 缓存）
│   ├─ protocol.handle("app") ← 取代 music-server.mjs 的 HTTP 层
│   └─ child_process.spawn    ← ffmpeg / ffprobe 桥
├─ 渲染进程 (Chromium)
│   └─ 直接加载 app://-/index.html ← dist/ 原样复用，前端零改动
└─ 原生音频（可选）
    └─ rhine-audio.exe (C#+NAudio 或 Rust) ← 复刻 JSON-lines 协议
```

### 关键实现点

1. **自定义协议替代 HTTP**（决策 A2）——前端 8 个 `fetch` 全部不用改
2. **保留 music-server.mjs 的业务函数**：把 `createMusicServer` 里的路由处理抽成纯函数 `handleApi(request, url)`，HTTP 外壳丢掉、逻辑全留
3. **FFmpeg 打包**：随包放 `resources/ffmpeg/ffmpeg.exe`、`ffprobe.exe`，启动时设 `process.env.FFMPEG_PATH`（这个覆盖机制**项目已经支持**，见 `music-audio.mjs:68`）；electron-builder 里必须 `asarUnpack` 二进制，否则无法 `spawn`
4. **数据目录**：默认 `%LOCALAPPDATA%\RhineMusic\music-data-v3`（保留 `MUSIC_DATA_DIR` 覆盖）
5. **顺带修掉上一轮的 G2**：`findExecutable` 加 `.exe` 感知
6. **Windows 原生质感**：
   - `app.requestSingleInstanceLock()` 单实例
   - 窗口尺寸/位置记忆、无边框 + 自绘标题栏（贴合现有暗色设计）
   - 托盘图标 + 最小化到托盘 + 播放/暂停/上一首/下一首菜单
   - **SMTC（系统媒体传输控件）**：媒体键、锁屏控制、音量键 OSD —— 需要原生模块或 `@nodert-win10-*` / 自己写小 addon
   - 关闭窗口时选择「退出」还是「留在托盘继续播放」
   - 文件关联 `.flac/.dsf/.ape`（可选）
7. **禁用 PWA 层**：`src/pwa.ts` 的 service worker 注册在自定义协议下本就不会触发（`import.meta.env.PROD` + scheme 判断），但建议显式短路，避免「安装到设备」提示出现在桌面应用里

### 打包

```
electron-builder → NSIS 安装包 (可选 portable 单文件 exe)
```

### 评估

| 项 | 值 |
| --- | --- |
| 工作量 | **3–6 人日**（MVP，含原生音频 +8–12 人日） |
| 安装体积 | 安装后 ~200–260 MB，安装包 ~90–110 MB |
| 复用率 | **前端 100%、曲库 100%、解码 100%** |
| 风险 | 🟢 低 —— 几乎不重写业务逻辑 |
| 缺点 | 体积大；内存占用 ~300 MB 起 |

---

## 三、方案 2 · Tauri 2 + Rust 后端重写

**一句话**：体积最小，但要把 Node 后端搬到 Rust。

### 架构

```
RhineMusic.exe (~10 MB)
├─ Rust 后端
│   ├─ 曲库扫描  ← 重写 music-library.mjs (44 KB) 用 lofty + opencc-rust + image
│   ├─ 音频解码  ← 仍需要 FFmpeg sidecar（symphonia 覆盖不了 APE/DSD）
│   └─ WASAPI 输出 ← cpal / wasapi crate（可独占）
└─ WebView2（系统组件，Chromium 内核）
    └─ 加载 dist/，相对 fetch 走 Tauri 自定义协议 → Rust command
```

### 评估

| 项 | 值 |
| --- | --- |
| 工作量 | **30–50 人日**（曲库重写占 2/3） |
| 体积 | exe ~8–12 MB；**但 FFmpeg 仍要 sidecar（~80 MB）**，实际分发 ~100 MB+ |
| 复用率 | 前端 100%；**后端 0%** |
| 风险 | 🟠 中高 —— `lofty` 对 APE/DSD/WavPack 标签的覆盖需逐个验证；WebView2 的 `backdrop-filter`/复杂 WebGL 表现需实测 |
| 优点 | 内存低、启动快、原生 WASAPI 独占唾手可得 |
| 缺点 | **体积优势被 FFmpeg 抵消**；后端重写是真正的大工程 |

> 如果走这条路，**建议先做「Rust 曲库扫描 vs `music-metadata` 的对照测试」**，对同一批 APE/DSF/WV 文件比对专辑/曲名/封面/时长解析结果，确认无回归再继续。

---

## 四、方案 3 · WebView2 + C# / .NET 原生宿主

**一句话**：C# 写外壳和音频，曲库用 Node SEA sidecar 或 C# 重写。

### 两个变体

- **3a · Node sidecar**：主程序 C#/WinForms + `Microsoft.Web.WebView2`；用 Node SEA 把 `music-server.mjs` 打成 `rhine-server.exe` 随包分发，C# 启动它并加载 `http://127.0.0.1:<随机端口>`
  - 曲库/解码 **100% 复用**，C# 只负责窗口 + 音频 + 打包
  - 工作量 **12–20 人日**，体积 ~120–160 MB（Node SEA ~60 MB + FFmpeg ~80 MB）
- **3b · 全 C#**：曲库用 `TagLib#` 重写，音频用 NAudio
  - 工作量 **20–30 人日**，体积 ~40–70 MB
  - `TagLib#` 对 APE/DSD 的支持弱于 `music-metadata`，有回归风险

### 评估

| 项 | 3a Node sidecar | 3b 全 C# |
| --- | --- | --- |
| 工作量 | 12–20 人日 | 20–30 人日 |
| 体积 | ~120–160 MB | ~40–70 MB |
| 后端复用 | 100% | 0% |
| 音频 | NAudio（可独占） | NAudio（可独占） |
| 风险 | 🟢 低 | 🟠 中（标签解析回归） |

**优点**：**外壳 + 音频同一种语言（C#）**，NAudio 把 WASAPI 封装得很好；WinForms/WPF 的托盘、媒体键、SMTC 都是一等公民。
**缺点**：WebView2 Runtime 依赖（Win11 自带；Win10 需装，可用 `MicrosoftEdgeWebView2Setup.exe` 随包引导安装）。

---

## 五、方案 4 · Node SEA：把服务变成单个 exe

**一句话**：先让 `music-server.mjs` 变成 `rhine-music.exe`，再解决窗口。

- **打包**：Node ≥ 22 内置 SEA（`--experimental-sea-config`），或用 `@yao-pkg/pkg` / `bun build --compile`（Bun 更省事，产物更小）
- **窗口**：SEA 本身不能开窗口，需要一个极简原生宿主（C++/C# 各 ~200 行）创建窗口 + WebView2 指向 SEA 起的本地服务
- **结果**：两个 exe（宿主 + 服务），或宿主把服务当子进程

| 项 | 值 |
| --- | --- |
| 工作量 | 10–20 人日 |
| 体积 | 宿主 ~2 MB + Node SEA ~50–90 MB + FFmpeg ~80 MB |
| 复用率 | 后端 100% |
| 风险 | 🟡 中 —— Electron/Tauri 已把这件事做完了，自己造轮子的收益主要是体积和启动速度 |

> **评价**：除非你特别在意「不用 Electron」的洁癖或要极致启动速度，否则**方案 1 用 Electron 是同一件事的成熟版本**。这个方案更适合作为方案 3a 的一个组件。

---

## 六、方案 5 · 真·纯原生重写（零 Web 引擎）

**一句话**：如果 R2 是硬需求，这是唯一路径，但请先看清代价。

### 要做的事

| 模块 | 现状 | 重写目标 |
| --- | --- | --- |
| 3D 专辑架 | `scene.ts` 94 KB（Three.js） | wgpu / D3D12 + 自写场景图 |
| 封面图集 | `cover-atlas.ts` 22 KB | GPU 纹理图集 |
| CD 盒查看器 | `model-viewer.ts` 27 KB + glTF | glTF 加载 + PBR 着色器 |
| 全部 UI | `music-app.ts` 115 KB + 130 KB CSS | 原生控件 / 立即模式 GUI（egui、Dear ImGui） |
| 动效 | 开场字轮、分阶段过渡、波浪、磨砂 | 全部重做；**`backdrop-filter` 磨砂玻璃在原生里没有直接等价物**，要自己做高斯模糊后处理 |
| 无缝播放 | 已有 | Rust `wasapi` 独占 + 双缓冲排程 |

### 技术选型（二选一）

- **Rust + wgpu + egui/winit**：跨平台、内存安全、生态现代；适合长期维护
- **C++ + DirectX 12 + Dear ImGui**：最贴近 Windows、性能上限最高；开发效率低

### 评估

| 项 | 值 |
| --- | --- |
| 工作量 | **150–300 人日**（单人 6–12 个月） |
| 体积 | ~20–40 MB（+ FFmpeg） |
| 复用率 | **前端 0%、视觉资产需重新实现** |
| 风险 | 🔴 高 —— 三个月的投入后才看得出「像不像原来的样子」 |
| 唯一优势 | 内存占用低、启动快、独占音频、无 Web 依赖 |

> **变体（不推荐）**：保留 Three.js，把 JS 引擎（QuickJS/V8）嵌进原生程序 + 直接用 ANGLE 跑 WebGL。
> 看似省事，**其实省不了**——因为 `music-app.ts` 有大量 DOM 操作和 CSS 布局依赖（42 处布局读取 + 130 KB CSS），你仍然要自己实现一套 DOM/CSS。等于把浏览器的活重干一遍，却得不到浏览器的成熟度。

---

## 七、方案对比

| 维度 | 1 Electron | 2 Tauri | 3a WebView2+Node | 3b WebView2+C# | 4 Node SEA | 5 纯原生 |
| --- | --- | --- | --- | --- | --- | --- |
| 工作量（人日） | **3–6** | 30–50 | 12–20 | 20–30 | 10–20 | **150–300** |
| 分发体积 | 90–110 MB | ~100 MB | 120–160 MB | **40–70 MB** | 130–170 MB | **20–40 MB** |
| 安装后占用 | ~200–260 MB | ~120 MB | ~200 MB | ~80 MB | ~250 MB | ~60 MB |
| 前端复用 | 100% | 100% | 100% | 100% | 100% | 0% |
| 后端复用 | **100%** | 0% | **100%** | 0% | **100%** | 0% |
| 音频独占 | 需 C2 | 内置可做 | NAudio | NAudio | 需 C2 | 内置 |
| 冷门格式标签 | ✅ | ⚠️ 风险 | ✅ | ⚠️ 风险 | ✅ | ⚠️ 需自研 |
| 运行内存 | ~300 MB | ~120 MB | ~250 MB | ~150 MB | ~300 MB | ~80 MB |
| 风险 | 🟢 | 🟠 | 🟢 | 🟠 | 🟡 | 🔴 |
| 上手速度 | **最快** | 慢 | 中 | 中 | 中 | 最慢 |

---

## 八、推荐路线

### 结论

**走方案 1（Electron），音频按需叠加 C2。** 理由：

1. **3–6 人日就能拿到可用的单文件 Windows 应用**，而 Tauri 要 30–50 人日且体积优势被 FFmpeg sidecar 抵消
2. **`music-library.mjs`（44 KB）+ `music-metadata` 是白拿的**，换到 Rust/C# 都有冷门格式标签回归风险——而这正是目标用户的核心资产
3. **前端 8 个 fetch 零改动**（自定义协议方案），Three.js/CSS 视觉 100% 保真，不用赌 WebView2 的渲染差异
4. Electron 内置的 Chromium **自带 AAC/H.264 解码**，比系统 WebView2 更可控

### 分阶段

**阶段 1 · MVP（3–4 人日）** — 先跑起来
- Electron 主进程 + `app://` 自定义协议，加载现有 `dist/`
- 把 `createMusicServer` 的路由逻辑抽成纯函数复用
- 修 G2（FFmpeg `.exe` 感知），随包内置 FFmpeg，设 `FFMPEG_PATH`
- 数据目录 → `%LOCALAPPDATA%\RhineMusic`
- electron-builder 出 NSIS 安装包 + portable exe

**阶段 2 · 桌面质感（2–4 人日）**
- 单实例锁、窗口状态记忆、自绘标题栏
- 托盘 + 最小化到托盘 + 关闭行为选择
- 禁用 PWA 安装提示
- 图标、安装向导、卸载清理

**阶段 3 · 音频升级（8–15 人日，可选）** — 决策 C2
- C# + NAudio 实现 JSON-lines 音频桥（最快），或 Rust + `wasapi`（长期）
- 保持 `NativeAudioOutput` 协议不变，只在 `music-audio.mjs` 里按平台选二进制
- 收益：设备选择、**WASAPI 独占**、流式无缝（摆脱 128 MiB 限制）
- 若只想快速拿到独占/DSD，先做 C3（foobar2000 代理，3–6 人日）

**阶段 4 · 打磨（可选）**
- SMTC 媒体键集成、文件关联、开机自启、自动更新（`electron-updater`）

### 什么情况下改选别的

| 你的优先级 | 选 |
| --- | --- |
| 最快拿到可用版本 | **方案 1** |
| 安装包要小（< 70 MB） | 方案 3b |
| 极致轻量 / 内存敏感 | 方案 2，但先做标签解析对照测试 |
| 完全不要 Web 引擎 | 方案 5，先做好 6–12 个月的准备 |
| 音质第一（独占/ASIO/DSD） | 方案 1 + C3（foobar2000），最省力 |

---

## 九、与仓库约定的冲突提示

移植成独立版会触碰几条 `AGENTS.md` / README 的既有约定，需要你自己决策：

1. **主线不接收 PR** —— 移植应作为**独立 Fork**，按 `community_fork.md` 模板登记 Issue；不要改写已有 Git 历史
2. **"Windows 由社区版本提供，不属于 V0.4.1 主线支持范围"** —— 你的分支应明确标注为社区衍生版
3. **随包分发 FFmpeg 的许可** —— FFmpeg 默认构建可能是 GPL，随包分发需同时提供源码/许可声明；建议用 LGPL 构建或改用 `ffmpeg.exe` 由用户自备 + 首启引导下载。仓库的 `NOTICE.md` 已处理第三方许可，新增依赖需同步更新
4. **音乐服务只监听 127.0.0.1** —— 若采用 A2 自定义协议则天然满足；不要为了省事改成 `0.0.0.0`
5. **不提交真实歌曲、封面缓存、索引、令牌、本机路径** —— `.gitignore` 已覆盖，打包配置不要绕过
6. **无缝播放必须用音频时钟连续排程** —— 不允许用「关掉淡入淡出」或 `preload` 冒充；C2 桥必须真做帧级排程
7. **真实音频设备自动测试必须零音量** —— Windows 侧补测试时沿用此约定
8. **保留 LICENSE / NOTICE.md / README.original.md 与全部第三方许可**，代码 MIT 不覆盖字体、图像、模型、声音

---

## 十、一句话总结

**「不用浏览器」如果指不要外部浏览器标签页——Electron 方案 3–6 人日即可交付单文件 Windows 应用，前端零改动、后端零改动、视觉 100% 保真；如果指完全不要 Web 引擎——那是 150–300 人日的整体重写，且会永久失去与原项目的视觉同步能力。**
音频上，原生进程其实只是个 WAV 播放器（FFmpeg 已把一切转成 WAV），所以 Windows 侧只需实现「WAV 解析 + WASAPI 输出 + 双槽时钟排程」，就能拿到独占模式与流式无缝。
