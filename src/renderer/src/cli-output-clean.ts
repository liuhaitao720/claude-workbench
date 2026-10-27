/**
 * v1.1.0 CLI 输出清洗（用户报告「点更新后界面无变化」根因之一）：
 * `claude update` 走 npm/原生安装器，输出里混着终端控制序列（清行 ESC[K、光标定位、
 * OSC 标题等）。原实现把原始字节直接塞进 <pre>，渲染结果是成片的空行/乱码——用户看到
 * 「没反应」，要等真正的人类可读文字出现才有变化。
 *
 * 纯函数（独立成模块便于单测）：去掉 CSI/OSC/单字符 ESC 序列、退格覆盖、回车覆盖。
 */

/** CSI（ESC [ … 终止字节）与 OSC（ESC ] … BEL/ST）与其余单字符 ESC 序列 */
const ANSI_PATTERN = new RegExp(
  [
    '[\\u001B\\u009B][[\\]()#;?]*(?:',
    '(?:(?:[a-zA-Z\\d]*(?:;[-a-zA-Z\\d\\/#&.:=?%@~_]*)*)?\\u0007)',
    '|(?:(?:\\d{1,4}(?:;\\d{0,4})*)?[\\dA-PR-TZcf-nq-uy=><~]))',
    '|[\\u001B][@-_]'
  ].join(''),
  'g'
)

/** 去掉 ANSI 控制序列（保留换行/制表）；再清残留的 BEL/孤立 ESC */
export function stripAnsi(text: string): string {
  return text
    .replace(ANSI_PATTERN, '')
    .replace(/\u0007/g, '') // OSC 终止符残留（分片截断时前缀已被上一片吃掉）
    .replace(/\u001b/g, '')
}

/**
 * 逐行应用「本地行编辑」语义：
 * - `\r` 覆盖当前行（npm 进度条同一行反复刷新，只保留最后一次写入的内容）
 * - `\b` 退格删前一个字符
 * 行数不做上限（CI 输出要能看全），仅去掉纯空白行。
 */
export function normalizeCliOutput(raw: string): string {
  const cleaned = stripAnsi(raw).replace(/\r\n/g, '\n')
  const out: string[] = []
  for (const rawLine of cleaned.split('\n')) {
    let line = ''
    for (let i = 0; i < rawLine.length; i++) {
      const ch = rawLine[i]
      if (ch === '\r') {
        line = '' // 回到行首：后续内容覆盖原行
      } else if (ch === '\b') {
        line = line.slice(0, -1)
      } else {
        line += ch
      }
    }
    out.push(line.replace(/\s+$/, ''))
  }
  // 去首部/尾部连续空行（清屏/清行序列留下的空白行——用户报告「点了更新没变化」
  // 的直接观感来源），保留内部空行结构
  let start = 0
  while (start < out.length && out[start] === '') start++
  while (out.length > start && out[out.length - 1] === '') out.pop()
  return out.slice(start).join('\n')
}