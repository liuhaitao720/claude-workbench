import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { IS_LINUX, IS_WIN } from './platform'

const execFileAsync = promisify(execFile)

/**
 * v0.9.4 本机等宽字体扫描（自动检测已安装字体→字体下拉）：
 * - win：System.Drawing InstalledFontCollection 枚举 + 字形宽度实测（iii/WWW/000
 *   等宽判定），PowerShell 子进程执行（不落盘脚本文件、不用 -ExecutionPolicy——
 *   EDR 防御篡改红线）
 * - linux（v1.3）：fontconfig `fc-list :spacing=mono family` 由 fontconfig 元数据
 *   判定等宽（宽度实测启发式是 PS 脚本内逻辑，无法跨平台复用——此处为平行实现）
 * - 图标/符号字体（Segoe MDL2/Marlett/Webdings 等）按名过滤（win 字体名为主，
 *   linux 下无害保留）
 * - 结果内存缓存（字体安装极少变化；设置弹窗每次打开不重扫）
 * - 失败回空数组——下拉退回白名单（SettingsDialog 兜底），不阻塞
 */
const PS_SCRIPT = `
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Add-Type -AssemblyName System.Drawing
$fams = [System.Drawing.Text.InstalledFontCollection]::new().Families
$bmp = New-Object System.Drawing.Bitmap 200,50
$g = [System.Drawing.Graphics]::FromImage($bmp)
$sf = [System.Drawing.StringFormat]::GenericTypographic
$out = @()
foreach ($f in $fams) {
  try {
    $font = New-Object System.Drawing.Font($f.Name, 12)
    $wi = $g.MeasureString('iiiiii', $font, [System.Drawing.PointF]::new(0,0), $sf).Width
    $ww = $g.MeasureString('WWWWWW', $font, [System.Drawing.PointF]::new(0,0), $sf).Width
    $w0 = $g.MeasureString('000000', $font, [System.Drawing.PointF]::new(0,0), $sf).Width
    if ([Math]::Abs($wi - $ww) -lt 0.5 -and [Math]::Abs($wi - $w0) -lt 0.5 -and $wi -gt 1) { $out += $f.Name }
  } catch {}
}
Write-Output ($out -join [char]10)
`.trim()

/** 图标/符号字体过滤（通过宽度判定但非文本等宽字体） */
const ICON_FONT_PATTERN = /MDL2|Fluent|Assets|icons?|symbols?|marlett|MT Extra|MS Outlook|webdings|wingdings|segoui|holoLens/i

export class FontScanner {
  private cache: string[] | null = null

  /** 已安装等宽字体（去重排序；缓存后直接返回；扫描失败回空数组——下拉退回白名单） */
  async getInstalledMonoFonts(): Promise<string[]> {
    if (this.cache !== null) return [...this.cache]
    try {
      const stdout = IS_WIN
        ? (
            await execFileAsync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', PS_SCRIPT], {
              timeout: 30_000,
              encoding: 'utf8'
            })
          ).stdout
        : await this.scanLinux()
      const list = stdout
        .split('\n')
        .map((l) => l.trim())
        .filter((l) => l.length > 0 && !ICON_FONT_PATTERN.test(l))
      this.cache = [...new Set(list)].sort((a, b) => a.localeCompare(b))
      return [...this.cache]
    } catch {
      this.cache = []
      return []
    }
  }

  /**
   * Linux：`fc-list :spacing=mono family` 输出形如
   * `/usr/share/fonts/.../DejaVuSansMono.ttf: DejaVu Sans Mono`——取最后一个
   * `: ` 之后的部分（family 元素值，可能逗号分隔多族名）。fontconfig 未装（极简
   * 系统）抛错 → 上层 catch 回空数组退白名单。
   */
  private async scanLinux(): Promise<string> {
    if (!IS_LINUX) return ''
    const { stdout } = await execFileAsync('fc-list', [':spacing=mono', 'family'], {
      timeout: 15_000,
      encoding: 'utf8'
    })
    return stdout
      .split('\n')
      .map((l) => {
        const idx = l.lastIndexOf(': ')
        return idx >= 0 ? l.slice(idx + 2) : l
      })
      .flatMap((families) => families.split(','))
      .map((f) => f.trim())
      .filter((f) => f.length > 0)
      .join('\n')
  }
}
