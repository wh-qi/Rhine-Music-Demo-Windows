# Rhine Music · Windows 独立版方案（不全重写 · 不用自带浏览器）

> 前提：**保留现有的 TypeScript + Three.js 前端（700 KB TS + 130 KB CSS）与 Node 后端**，只换外壳。
> 目标：双击 `.exe` 即用，**不打开用户自己的浏览器**，无地址栏、无标签页、无终端。
> 分析基础：上游 `Rhine-Music-Demo` 的本地工作副本（V0.4.1 @ `dd2370f`），已在 Windows 实测构建与服务通过。

---

## 零、先定义「不用自带浏览器」——它有三个层次

这是选型的分水岭，必须逐条确认：

| 层次 | 含义 | 哪些方案满足 |
| --- | --- | --- |
| **L1** | 不弹出用户浏览器标签页 / 不要网址 | ✅ **所有内嵌方案都满足**（Electron、WebView2、CEF、Tauri） |
| **L2** | 不依赖用户装没装浏览器，运行时不从系统取 | ✅ Electron / CEF（**自带**） ❌ WebView2 / Tauri（**用系统的**） |
| **L3** | 不共享用户的浏览器配置、登录态、扩展、书签 | ✅ **所有方案都满足** |

### ⚠️ 关键澄清：WebView2 ≠ 用户的 Edge

很多人把 WebView2 等同于「用自带浏览器」，这是误解：

- WebView2 只共享 Edge 的**运行时二进制文件**（省磁盘）
- 它是**独立进程**、**独立 user data folder**，读不到用户的 Edge 标签页、书签、扩展、登录态
- 用户**看不到** Edge 窗口，也无法察觉
- Win11 **预装**；Win10 通过 Edge 更新分发，覆盖率很高但**不能保证 100%**

所以真正的问题只有一个：**你能否接受依赖系统里的 WebView2 运行时？**
- 能 → 可用 WebView2/Tauri，体积小
- 不能（要求绝对自包含）→ 必须自带 Chromium（Electron / CEF）

> 📌 **反直觉但重要的事实**：Tauri 若选择**内置固定版本 WebView2**（`webviewInstallMode: fixedRuntime`）以摆脱系统依赖，
> 实测代价是 **+212 MB**——体积优势直接归零，与 Electron 持平。即「Tauri 小」只在**依赖系统运行时**时成立。

---

## 一、三条决策轴

| 轴 | 选项 | 影响 |
| --- | --- | --- |
| **① 运行时从哪来** | 自带 Chromium / 系统 WebView2 / 固定版本 WebView2 | 体积、是否依赖系统、渲染一致性 |
| **② 后端怎么跑** | Node 原样复用 / Node SEA sidecar / 用宿主语言重写 | **工作量差异的主要来源** |
| **③ 音频输出** | Web Audio（共享模式）/ 原生 WASAPI 桥 / foobar2000 代理 | 正交，可后加 |

---

## 二、一条决定性结论

> **如果你既要「自带 Chromium」又要「跑现有 Node 后端」，Electron 几乎是唯一理性选择。**

因为 **Electron 本质上就是「Chromium + Node 集成好的成品」**。自己用 CefSharp（自带 Chromium）+ Node SEA（自带 Node）拼装，等于把 Electron 重造一遍，而且更差：

- 进程里跑**两个 V8 实例**（Chromium 的 + Node 的），内存比 Electron 更高
- 要自己实现协议桥接、进程管理、打包、更新
- 生态里现成的问题都要重新踩

**所以：接受自带运行时 → 直接 Electron；想要小体积 → 用系统 WebView2。中间地带不存在。**

---

## 三、四个方案

### 方案 1 · Electron（自带 Chromium）⭐ 推荐

**架构**

```
RhineMusic.exe
├─ 主进程（内置 Node 22）
│   ├─ 复用 music-library.mjs (44 KB)  ← 零改动
│   ├─ 复用 music-audio.mjs  (24 KB)  ← 零改动
│   ├─ protocol.handle("app")          ← 取代 music-server.mjs 的 HTTP 层
│   └─ spawn ffmpeg / ffprobe          ← 随包内置
├─ 渲染进程（自带 Chromium，独立于用户浏览器）
│   └─ 加载 app://-/index.html         ← dist/ 原样复用，前端零改动
└─ 原生音频（可选）
    └─ rhine-audio.exe                 ← WAV + WASAPI，复刻 JSON-lines 协议
```

| 项 | 值 |
| --- | --- |
| 工作量 | **3–6 人日**（+ 原生音频 8–15 人日） |
| 安装包 / 安装后 | ~90–110 MB / ~240 MB |
| 前端复用 | **100%** |
| 后端复用 | **100%** |
| 依赖系统组件 | **无** |
| 渲染一致性 | ✅ 完全可控（固定 Chromium 版本） |
| 内存 | ~250–350 MB |
| 风险 | 🟢 低 |

**优点**：唯一「前端不改、后端不改、视觉 100% 保真」的方案；内置 Chromium 自带 AAC/H.264 解码；`electron-builder` 一条命令出 NSIS + portable 单文件 exe。
**缺点**：体积和内存最大。

---

### 方案 2 · WebView2 + C# 宿主 + Node SEA sidecar（系统运行时）

**架构**

```
RhineMusic.exe (C# WinForms/WPF, ~5 MB)
├─ WebView2 控件（系统运行时，Chromium 内核）
│   └─ 加载 http://127.0.0.1:<随机端口> 或自定义 scheme
├─ NAudio → WASAPI（可独占，同进程，无需额外桥）
└─ 启动 sidecar: rhine-server.exe (Node SEA, ~60–90 MB)
    ├─ music-library.mjs + music-audio.mjs  ← 原样复用
    └─ spawn ffmpeg / ffprobe               ← 随包内置
```

| 项 | 值 |
| --- | --- |
| 工作量 | **12–20 人日** |
| 安装包 / 安装后 | ~110–150 MB / ~180 MB |
| 前端复用 | 100% |
| 后端复用 | **100%**（打成 Node SEA 单 exe） |
| 依赖系统组件 | ⚠️ WebView2 Runtime |
| 内存 | ~180–260 MB（比 Electron 低，部分与 Edge 共享） |
| 风险 | 🟡 中（Node SEA 打包、sidecar 生命周期、WebView2 渲染差异） |

**优点**：比 Electron 小一档；**C# 与音频同进程**，NAudio 把 WASAPI 独占封装得很好，不用再写独立音频进程；WinForms/WPF 的托盘、媒体键、SMTC 是一等公民。
**缺点**：两个运行时（Chromium V8 + Node V8）；sidecar 的启动、退出、崩溃重启要自己管；WebView2 版本随系统更新，渲染行为不如自带 Chromium 可控。

---

### 方案 3 · Tauri 2（系统运行时，外壳最小）

**架构**

```
RhineMusic.exe (~10 MB, Rust)
├─ WebView2（系统运行时）
└─ 后端二选一：
    a) Node sidecar（复用 .mjs）→ 体积回到 ~150–180 MB，但工作量降到 15–20 人日
    b) Rust 重写曲库（lofty + opencc-rust）→ 体积最小，工作量 30–50 人日
```

| 项 | 值 |
| --- | --- |
| 工作量 | 15–20 人日（sidecar）/ **30–50 人日**（Rust 重写） |
| 安装包 | ~150–180 MB（sidecar）/ ~90 MB（重写 + FFmpeg） |
| 后端复用 | 100%（sidecar）/ **0%**（重写） |
| 依赖系统组件 | ⚠️ WebView2 Runtime（自带固定版则 **+212 MB**） |
| 风险 | 🟡 中（sidecar）/ 🟠 中高（重写，APE/DSD 标签可能回归） |

**优点**：窗口层最轻、启动最快、内存最低；Rust 侧做 WASAPI 独占很自然。
**缺点**：**体积优势被 FFmpeg sidecar 抵消**（symphonia 覆盖不了 APE/DSD，FFmpeg 跑不掉）；若不想依赖系统 WebView2，+212 MB 后与 Electron 持平。

---

### 方案 4 · CefSharp / CEF + .NET（自带 Chromium，非 Electron）

**架构**：`CefSharp.WinForms` 自带完整 CEF（~150–180 MB），.NET 宿主，后端重写为 C#（`TagLib#` + NAudio）。

| 项 | 值 |
| --- | --- |
| 工作量 | **18–28 人日**（后端必须重写，否则又要塞 Node SEA = 两个 V8） |
| 安装包 | ~220–260 MB |
| 后端复用 | 0% |
| 依赖系统组件 | **无** |
| 风险 | 🟠 中（`TagLib#` 对 APE/DSD 支持弱于 `music-metadata`） |

**评价**：只有在「坚持自带运行时 + 坚持 .NET + 愿意重写后端」时才选。否则方案 1 完胜。

---

## 四、方案对比

| 维度 | 1 Electron | 2 WebView2+C# | 3 Tauri 2 | 4 CefSharp |
| --- | --- | --- | --- | --- |
| 工作量（人日） | **3–6** | 12–20 | 15–50 | 18–28 |
| 安装包 | 90–110 MB | 110–150 MB | 90–180 MB | 220–260 MB |
| 安装后 | ~240 MB | ~180 MB | ~120–180 MB | ~300 MB |
| 前端复用 | 100% | 100% | 100% | 100% |
| **后端复用** | **100%** | **100%** | 100%/0% | **0%** |
| 自带运行时（L2） | ✅ | ❌ | ❌（可 +212 MB 买） | ✅ |
| 无系统依赖 | ✅ | ❌ | ❌ | ✅ |
| 渲染一致性 | ✅ 高 | 🟡 中 | 🟡 中 | ✅ 高 |
| 内存 | 250–350 MB | 180–260 MB | 120–220 MB | 250–350 MB |
| WASAPI 独占 | 需独立桥 | ✅ 同进程 | ✅ 原生 | ✅ 同进程 |
| 风险 | 🟢 | 🟡 | 🟡 | 🟠 |

---

## 五、无论选哪个，都要做的 7 件事

### 1. 用自定义协议取代 HTTP（消除端口）

前端只有 **8 个 `fetch()`、13 个端点**。把 `app://` 注册为 standard + secure，相对路径 `fetch("/api/library")` 会自动解析为 `app://-/api/library`，**前端一行都不用改**，而且**彻底没有 TCP 端口**（上一轮的端口冲突问题自动消失）。

```js
protocol.registerSchemesAsPrivileged([
  { scheme: "app", privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } },
]);
protocol.handle("app", async (request) => {
  const url = new URL(request.url);
  if (url.pathname.startsWith("/api/")) return handleApi(request, url);   // 复用 music-server 的路由逻辑
  return net.fetch(pathToFileURL(path.join(DIST, url.pathname)).toString()); // dist/ 静态资源，保留 Range 支持
});
```

> `music-server.mjs` 的 `serveFile` 已实现 **Range 请求**（音频拖动必需），`net.fetch` 走 `file://` 会保留它，直接复用。

### 2. ⚠️ 必须显式禁用 Service Worker

**这是个坑**：`src/pwa.ts:44` 的守卫是
```ts
if (started || !import.meta.env.PROD || !window.isSecureContext || !("serviceWorker" in navigator)) return;
```
把 `app://` 注册为 **secure** 后，`window.isSecureContext` 变成 **true**，生产构建里 `serviceWorker in navigator` 也是 true → **它会去注册 sw.js**（在自定义协议上会失败并报错）。
必须加一个桌面环境判断短路掉，同时屏蔽「安装到设备」提示。

### 3. 音乐目录：`<textarea>` → 原生文件夹选择器 ⭐ 最大 UX 缺口

现在 `src/music-app.ts:1525` 是一个 **`<textarea>`，要求用户手打绝对路径**（"多个目录各占一行"）——在浏览器里合理，在桌面应用里非常别扭。桌面版必须加：
- 「添加文件夹」按钮 → 宿主原生目录选择器（Electron `dialog.showOpenDialog`）
- 显示为可删除的路径标签列表，保留手工粘贴作为兜底
- 保留 `/api/config` 的 `roots` 契约不变

### 4. `target="_blank"` 链接 → 系统浏览器

代码里有外链（GitHub、资料来源）：`music-app.ts:1256`、`archive-main.ts:447` 等。
Electron 必须拦截，否则会开出一个空白窗口：
```js
mainWindow.webContents.setWindowOpenHandler(({ url }) => {
  shell.openExternal(url); return { action: "deny" };
});
```

### 5. FFmpeg 打包 + 修 G2

- 随包放 `resources/ffmpeg/ffmpeg.exe`、`ffprobe.exe`，启动时设 `process.env.FFMPEG_PATH`（**项目已支持这个覆盖机制**，`music-audio.mjs:68`）
- **必须 `asarUnpack`**，否则 `spawn` 不到
- **必须修 G2**：`findExecutable` 用 `path.join(dir,'ffmpeg')`，在 Windows 上永远匹配不到 `ffmpeg.exe`（已实测复现）
- 💡 **体积优化**：应用只用到 `ape,wav,flac,mov,mp3,aac,aiff,ogg,wv,asf,dsf,iff` 这些解复用器（`music-audio.mjs:11`）。**自己编一个最小 FFmpeg 可把 ~80 MB 压到 ~25–35 MB**，还能顺带规避 GPL 问题（用 LGPL 构建）

### 6. 数据目录 → `%LOCALAPPDATA%\RhineMusic\music-data-v3`

保留 `MUSIC_DATA_DIR` 覆盖约定。

### 7. 桌面质感

单实例锁（`requestSingleInstanceLock`）、窗口尺寸/位置记忆、无边框 + 自绘标题栏、托盘 + 最小化到托盘、关闭行为选择、SMTC 媒体键集成。

---

## 六、音频层（正交，可后加）

| 选项 | 实现 | 能力 | 工作量 |
| --- | --- | --- | --- |
| **W1 Web Audio** | 内嵌引擎自带 | WASAPI **共享**、无设备选择、系统重采样、无缝受 128 MiB PCM 上限 | ⭐ 0 |
| **W2 原生 WASAPI 桥** | 复刻 `RhineAudio.swift` 的 JSON-lines 协议，C#+NAudio 或 Rust+`wasapi` | 设备选择、**独占**、流式无缝（2 GiB） | 8–15 人日 |
| **W3 foobar2000 代理** | 复用已有的 `/api/foobar/*` Beefweb 代理 | 独占 / ASIO / 原生 DSD 全白拿 | 3–6 人日 |

**W2 的关键事实**（前面已确认）：原生进程**只是个 WAV 播放器**——FFmpeg 已把一切格式转成 WAV 缓存，所以 Windows 桥**不需要任何解码器**，只要「WAV 解析 + WASAPI 输出 + 双槽时钟排程」。
**若想最快拿到独占输出**：走 W3，连 G2 都一并绕过。

---

## 七、推荐

### 选型决策树

```
必须完全自包含（不依赖系统 WebView2）？
├─ 是 → 方案 1 Electron（3–6 人日）   ← 除非你坚持 .NET，才看方案 4
└─ 否 → 想要最小体积/最低内存？
        ├─ 是 → 方案 3 Tauri（但 FFmpeg sidecar 会抵消大部分优势）
        └─ 否 → 方案 2 WebView2 + C#（音频同进程是加分项）
```

### 推荐：方案 1（Electron）

理由：

1. **3–6 人日**就能交付，而方案 2/3/4 都要 12–50 人日
2. **前端与后端双双 100% 复用**——`music-library.mjs`（44 KB）依赖 `music-metadata`，对 APE/WavPack/DSD 标签支持成熟，换语言就是赌这块会回归
3. **前端 8 个 fetch 零改动**（`app://` 自定义协议），Three.js/CSS 视觉 100% 保真
4. **完全自包含**，满足 L2；用户装没装浏览器、系统有没有 WebView2 都无所谓
5. 若要小体积，**方案 2** 是唯一合理的替代（牺牲自包含换 ~60 MB 和更低的音频集成成本）

### 分阶段

| 阶段 | 内容 | 工作量 |
| --- | --- | --- |
| **1 · MVP** | Electron 主进程 + `app://` 协议 + 抽 `createMusicServer` 路由为纯函数 + 修 G2 + 内置 FFmpeg + `%LOCALAPPDATA%` + electron-builder 出 NSIS/portable | **3–4 人日** |
| **2 · 桌面化** | 禁用 SW、原生文件夹选择器、`openExternal`、单实例锁、窗口记忆、托盘、自绘标题栏 | 2–4 人日 |
| **3 · 音频** | W2 原生 WASAPI 桥（C#+NAudio 最快），或先上 W3 foobar2000 代理 | 3–15 人日 |
| **4 · 打磨** | SMTC 媒体键、文件关联、开机自启、自动更新、最小 FFmpeg 构建 | 按需 |

---

## 八、与仓库约定的冲突提示

1. **主线不接收 PR** —— 移植应作为**独立 Fork**，按 `community_fork.md` 登记 Issue；不改写 Git 历史
2. **随包分发 FFmpeg 的许可** —— 默认构建可能是 GPL；建议 **LGPL 最小构建**（顺带从 80 MB 降到 ~30 MB），并同步更新 `NOTICE.md`
3. **保留 `MUSIC_DATA_DIR`、只监听本机、目录越界校验**等既有边界；自定义协议天然满足"只本机"
4. **不提交真实歌曲、封面缓存、索引、令牌、本机路径**
5. **无缝播放必须用音频时钟连续排程**，不允许用关淡入淡出或 preload 冒充
6. **真实音频设备自动测试必须零音量**
7. **保留 LICENSE / NOTICE.md / README.original.md 与全部第三方许可**

---

## 九、一句话总结

**不全重写 + 不用自带浏览器 = 内嵌 WebView**。四种外壳里：
- 要**完全自包含** → **Electron**（3–6 人日，前后端双 100% 复用，唯一"不改一行业务代码"的方案）
- 要**小 60 MB 且接受系统 WebView2** → WebView2 + C#（12–20 人日）
- **Tauri 的体积优势会被 FFmpeg sidecar 抵消**，除非愿意用 Rust 重写 44 KB 的曲库逻辑（30–50 人日，且有 APE/DSD 标签回归风险）
- 若既要自带 Chromium 又要 Node，**Electron 就是"Chromium + Node"的成品**，用 CefSharp+Node SEA 自拼等于重造且更差
