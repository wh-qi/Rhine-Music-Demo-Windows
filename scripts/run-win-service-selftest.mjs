// 运行原生服务的离线自检（接缝逐样本比对）。可执行文件不存在时显式说明而不是静默通过。
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const SUFFIX = process.platform === 'win32' ? '.exe' : ''
const EXE = process.env.RHINE_WIN_SERVICE ?? path.join(ROOT, 'native', 'rhine-win-service', 'publish', `rhine-win-service${SUFFIX}`)

if (!existsSync(EXE)) {
  console.log(`跳过：尚未构建原生服务（${EXE}）。先运行 npm run build:win-service。`)
  process.exit(0)
}
const result = spawnSync(EXE, ['--selftest'], { encoding: 'utf8', windowsHide: true })
process.stderr.write(result.stderr ?? '')
process.exit(result.status ?? 1)
