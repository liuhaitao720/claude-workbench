import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

/**
 * v0.9.4 本机等宽字体扫描（自动检测已安装字体→字体下拉）：
 * - System.Drawing InstalledFontCollection 枚举 + 字形宽度实测（iii/WWW/000 等宽判定），
 *   PowerShell 子进程执行（不落盘脚本文件、不用 -ExecutionPolicy——EDR 防御篡改红线）
 * - 图标/符号字体（Segoe MDL2/Marlett/Webdings 等）按名过滤
 * - 结果内存缓存（字体安装极少变化；设置弹窗每次打开不重扫）
 * - UTF-8 输出保 CJK 字体名（宋体/等线等中文等宽字体对终端有效）
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
      const { stdout } = await execFileAsync(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-Command', PS_SCRIPT],
        { timeout: 30_000, encoding: 'utf8' }
      )
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
}
