# 内置 FFmpeg

Rhine Music for Windows 随包分发 **FFmpeg 的 LGPL 构建**，用于解码工程不原生支持的格式
（APE、WavPack、WMA/ASF、DSF/DFF、ALAC、AIFF、Ogg、Opus 等）。

## 来源

- 项目：[BtbN/FFmpeg-Builds](https://github.com/BtbN/FFmpeg-Builds)
- 产物：`ffmpeg-n8.1-latest-win64-lgpl-8.1.zip`
- 许可：**LGPL v3**（构建命令含 `--disable-gpl --disable-nonfree`，不含任何 GPL / nonfree 组件）

## 取得方式

```powershell
node ffmpeg/fetch-ffmpeg.mjs          # 已存在则跳过
node ffmpeg/fetch-ffmpeg.mjs --force  # 强制重新下载
```

脚本只取 `bin/ffmpeg.exe`、`bin/ffprobe.exe` 与 `LICENSE.txt`，写入本目录。
二进制文件不入版本库（见 `.gitignore`），打包由 `electron-builder` 的
`extraResources` 复制到 `resources/unpacked/ffmpeg/`。

## 许可与源码获取

- FFmpeg 许可全文：本目录 `LICENSE.txt`（下载后生成）
- 对应源码：<https://github.com/FFmpeg/FFmpeg> 的 `n8.1` 分支，
  或 BtbN 构建脚本 <https://github.com/BtbN/FFmpeg-Builds>
- 本项目**不修改** FFmpeg 源码，仅以独立可执行文件形式调用。

FFmpeg 是独立程序，通过命令行子进程调用，不作为本项目的链接库，
因此本项目代码的 MIT 许可以及其余第三方许可不受影响。
