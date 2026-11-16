/**
 * 手机应答页（v2.2.0 B 链，设计 §3.4）。
 *
 * 独立 http server，仅监听 127.0.0.1（公网入口经 Cloudflare 隧道反向代理到本端口）。
 * 路由仅两个族：
 * - GET  /a/<token>          单页 HTML（内联 CSS/JS，无外部资源）
 * - GET  /api/state?token=   2 秒轮询：该 token 可见的全部 pending（D6 平铺）
 * - POST /api/answer         {token,pendingId,choice} 选项索引/自由文本作答
 * - POST /api/cancel         {token,pendingId}「回电脑处理」→ 空响应放行
 * - POST /api/stop           {token,taskId} 手机停止任务（2.17=B）
 *
 * 安全：token 只在 URL 中（不落日志）；页面只渲染问题原文/选项 label（2.11=A）；
 * CSP 禁外部资源、X-Frame-Options DENY、Cache-Control no-store、Referrer-Policy
 * no-referrer（防 token 经 Referer 泄漏）。
 */
import { createServer, type IncomingMessage, type Server as HttpServer, type ServerResponse } from 'node:http'
import type { AnswerService } from './answer-store'
import type { AnswerChoice } from './shared/answer-decision'

/** POST body 上限（选择/文本远小于此） */
const BODY_MAX_BYTES = 64 * 1024

export interface AnswerPageOptions {
  answer: AnswerService
  /** 监听端口（notify.json answer.pagePort；0=OS 动态分配） */
  port?: number
  /** 手机停止任务（远程=registry.kill；本地=answer.stop 帧）；返回 false=未知任务 */
  onStop: (taskId: string) => boolean
  log?: (level: 'info' | 'warn', message: string) => void
}

export class AnswerPage {
  private server: HttpServer | undefined
  private boundPort: number | undefined

  constructor(private readonly opts: AnswerPageOptions) {}

  async start(): Promise<number> {
    if (this.boundPort !== undefined) return this.boundPort
    const server = createServer((req, res) => {
      this.handle(req, res).catch((err: unknown) => {
        this.opts.log?.('warn', `answer page error: ${errText(err)}`)
        if (!res.headersSent) sendJson(res, 500, { ok: false, error: 'internal' })
        else res.end()
      })
    })
    this.server = server
    const port = await new Promise<number>((resolve, reject) => {
      server.once('error', reject)
      server.listen(this.opts.port ?? 0, '127.0.0.1', () => {
        const addr = server.address()
        resolve(typeof addr === 'object' && addr !== null ? addr.port : (this.opts.port ?? 0))
      })
    })
    this.boundPort = port
    this.opts.log?.('info', `answer page listening on 127.0.0.1:${port}`)
    return port
  }

  get port(): number | undefined {
    return this.boundPort
  }

  async stop(): Promise<void> {
    const server = this.server
    this.server = undefined
    this.boundPort = undefined
    if (server === undefined) return
    await Promise.race([
      new Promise<void>((resolve) => server.close(() => resolve())),
      new Promise<void>((resolve) => setTimeout(resolve, 2000))
    ])
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    // 安全响应头（含错误路径——页面同源 API）
    res.setHeader('cache-control', 'no-store')
    res.setHeader('x-frame-options', 'DENY')
    res.setHeader('x-content-type-options', 'nosniff')
    res.setHeader('referrer-policy', 'no-referrer')
    res.setHeader(
      'content-security-policy',
      "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; form-action 'none'; frame-ancestors 'none'"
    )

    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    const path = url.pathname

    if (req.method === 'GET' && /^\/a\/[A-Za-z0-9_-]{20,}$/.test(path)) {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      res.end(PAGE_HTML)
      return
    }
    if (req.method === 'GET' && path === '/api/state') {
      const auth = this.opts.answer.authorize(url.searchParams.get('token') ?? '')
      if (auth === 'invalid') {
        sendJson(res, 410, { ok: false, error: 'invalid-token' })
        return
      }
      if (auth === 'settled') {
        sendJson(res, 200, { ok: true, ended: true, now: Date.now(), pendings: [], tasks: [] })
        return
      }
      sendJson(res, 200, this.stateView())
      return
    }
    if (req.method === 'POST' && path === '/api/answer') {
      const body = await readJson(req)
      if (body === null) return sendJson(res, 400, { ok: false, error: 'bad-body' })
      const token = str(body['token'])
      const pendingId = str(body['pendingId'])
      const choice = body['choice'] as AnswerChoice | undefined
      if (this.opts.answer.authorize(token) === 'invalid') {
        return sendJson(res, 410, { ok: false, error: 'invalid-token' })
      }
      if (pendingId === '' || typeof choice !== 'object' || choice === null) {
        return sendJson(res, 400, { ok: false, error: 'bad-body' })
      }
      const result = this.opts.answer.submit(token, pendingId, choice)
      if (result === 'ok') return sendJson(res, 200, { ok: true })
      const status =
        result === 'unauthorized' ? 401 : result === 'bad-choice' ? 400 : 410
      return sendJson(res, status, { ok: false, error: result })
    }
    if (req.method === 'POST' && path === '/api/cancel') {
      const body = await readJson(req)
      if (body === null) return sendJson(res, 400, { ok: false, error: 'bad-body' })
      const token = str(body['token'])
      const pendingId = str(body['pendingId'])
      if (this.opts.answer.authorize(token) === 'invalid') {
        return sendJson(res, 410, { ok: false, error: 'invalid-token' })
      }
      if (pendingId === '' || !this.opts.answer.cancelPending(pendingId, 'phone')) {
        return sendJson(res, 410, { ok: false, error: 'not-found' })
      }
      return sendJson(res, 200, { ok: true })
    }
    if (req.method === 'POST' && path === '/api/stop') {
      const body = await readJson(req)
      if (body === null) return sendJson(res, 400, { ok: false, error: 'bad-body' })
      const token = str(body['token'])
      const taskId = str(body['taskId'])
      if (this.opts.answer.authorize(token) === 'invalid') {
        return sendJson(res, 410, { ok: false, error: 'invalid-token' })
      }
      if (taskId === '') return sendJson(res, 400, { ok: false, error: 'bad-body' })
      const ok = this.opts.onStop(taskId)
      return sendJson(res, ok ? 200 : 404, ok ? { ok: true } : { ok: false, error: 'unknown-task' })
    }
    sendJson(res, 404, { ok: false, error: 'not-found' })
  }

  /** 平铺 pending（expiresAt/expired 供页面展示；不含 token） */
  private stateView(): Record<string, unknown> {
    const list = this.opts.answer.list()
    const pendings = list.map((view) => {
      const detail = this.opts.answer.detail(view.pendingId)
      return {
        ...view,
        expiresAt: detail?.expiresAt ?? 0,
        expired: detail?.expired ?? false
      }
    })
    const tasks: Array<Record<string, unknown>> = []
    const seen = new Set<string>()
    for (const view of list) {
      if (seen.has(view.taskId)) continue
      seen.add(view.taskId)
      tasks.push({
        taskId: view.taskId,
        taskName: view.taskName,
        ...(view.projectName !== undefined ? { projectName: view.projectName } : {})
      })
    }
    return { ok: true, ended: false, now: Date.now(), pendings, tasks }
  }
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  if (res.headersSent) return
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(body))
}

function readJson(req: IncomingMessage): Promise<Record<string, unknown> | null> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = []
    let total = 0
    let done = false
    const finish = (value: Record<string, unknown> | null): void => {
      if (done) return
      done = true
      resolve(value)
    }
    req.on('data', (chunk: Buffer) => {
      total += chunk.length
      if (total <= BODY_MAX_BYTES) chunks.push(chunk)
    })
    req.on('end', () => {
      if (total > BODY_MAX_BYTES) return finish(null)
      try {
        const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'))
        finish(typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
          ? (parsed as Record<string, unknown>)
          : null)
      } catch {
        finish(null)
      }
    })
    req.on('error', () => finish(null))
    req.on('aborted', () => finish(null))
  })
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : ''
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message.split('\n', 1)[0]!.slice(0, 120) : String(err)
}

/**
 * 单页应用（内联；无外部资源）。页面只拿得到自己的 URL（含 token），所有数据经
 * 同源 /api/*；DOM 全部 textContent 渲染（问题原文不做 HTML 注入——XSS 防线）。
 */
const PAGE_HTML = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>SSH Workbench · 手机答复</title>
<style>
  :root { color-scheme: light dark; --bg:#f5f6f8; --card:#fff; --fg:#1b1f24; --muted:#6b7280;
          --line:#e5e7eb; --accent:#2563eb; --danger:#dc2626; --ok:#059669; }
  @media (prefers-color-scheme: dark) {
    :root { --bg:#0f1115; --card:#171a21; --fg:#e6e8eb; --muted:#9aa1ab; --line:#2a2f39; }
  }
  * { box-sizing: border-box; }
  body { margin:0; padding:12px 12px calc(24px + env(safe-area-inset-bottom)); background:var(--bg);
         color:var(--fg); font:16px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"PingFang SC","Microsoft YaHei",sans-serif; }
  header { display:flex; align-items:baseline; gap:8px; padding:4px 2px 12px; }
  header .title { font-size:18px; font-weight:600; }
  header .count { font-size:13px; color:var(--muted); }
  .card { background:var(--card); border:1px solid var(--line); border-radius:12px;
          padding:14px; margin-bottom:12px; }
  .card .top { display:flex; justify-content:space-between; gap:8px; align-items:center; margin-bottom:10px; }
  .card .task { font-weight:600; font-size:15px; word-break:break-word; }
  .badge { font-size:12px; padding:2px 8px; border-radius:999px; background:rgba(37,99,235,.12); color:var(--accent); white-space:nowrap; }
  .badge.expired { background:rgba(220,38,38,.12); color:var(--danger); }
  .q { margin:10px 0 2px; font-size:15px; word-break:break-word; white-space:pre-wrap; }
  .q .num { color:var(--muted); margin-right:6px; }
  .opts { display:flex; flex-direction:column; gap:8px; margin:10px 0; }
  .opt { text-align:left; padding:12px; border-radius:10px; border:1px solid var(--line);
         background:transparent; color:var(--fg); font-size:15px; word-break:break-word; }
  .opt.sel { border-color:var(--accent); background:rgba(37,99,235,.10); }
  .opt .desc { display:block; color:var(--muted); font-size:13px; margin-top:2px; }
  input[type=text] { width:100%; padding:10px 12px; border-radius:10px; border:1px solid var(--line);
                     background:transparent; color:var(--fg); font-size:15px; margin-top:8px; }
  .row { display:flex; gap:8px; flex-wrap:wrap; margin-top:12px; }
  button { font:inherit; cursor:pointer; border-radius:10px; padding:11px 16px; border:1px solid var(--line);
           background:transparent; color:var(--fg); }
  button.primary { background:var(--accent); border-color:var(--accent); color:#fff; }
  button.danger { color:var(--danger); border-color:rgba(220,38,38,.4); }
  button.armed { background:rgba(220,38,38,.12); }
  button.ghost { color:var(--muted); }
  button:disabled { opacity:.5; cursor:default; }
  .hint { color:var(--muted); font-size:13px; text-align:center; padding:28px 0; }
  .banner { border-radius:10px; padding:10px 12px; margin-bottom:10px; font-size:14px;
            background:rgba(220,38,38,.10); color:var(--danger); }
  .foot { display:flex; justify-content:space-between; align-items:center; gap:8px;
          border-top:1px solid var(--line); margin-top:12px; padding-top:10px; }
  .foot .left { display:flex; gap:8px; }
  .status { position:fixed; left:0; right:0; bottom:0; padding:8px; text-align:center;
            font-size:13px; color:var(--muted); pointer-events:none; }
  .toast { position:fixed; left:50%; top:18px; transform:translateX(-50%); background:#111; color:#fff;
           padding:8px 14px; border-radius:10px; font-size:14px; opacity:.95; }
</style>
</head>
<body>
<header><div class="title">等待答复</div><div class="count" id="count"></div></header>
<main id="list"><div class="hint">加载中…</div></main>
<div class="status" id="status"></div>
<script>
(function () {
  var m = location.pathname.match(/^\\/a\\/([A-Za-z0-9_-]+)$/);
  var TOKEN = m ? m[1] : '';
  var listEl = document.getElementById('list');
  var countEl = document.getElementById('count');
  var statusEl = document.getElementById('status');
  var lastSig = '';
  var lastData = null;
  var ui = Object.create(null);   /* pendingId -> { picks: {qIndex: [optIdx]}, texts: {qIndex} } */
  var armed = Object.create(null);
  var stopped = false;
  var timer = null;

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined && text !== null) n.textContent = String(text);
    return n;
  }
  function toast(text) {
    var t = el('div', 'toast', text);
    document.body.appendChild(t);
    setTimeout(function () { t.remove(); }, 1800);
  }
  function api(path, body) {
    var init = body
      ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }
      : { cache: 'no-store' };
    return fetch(path, init).then(function (res) {
      return res.json().catch(function () { return {}; }).then(function (data) {
        return { status: res.status, data: data };
      });
    });
  }
  function isArmed(key) {
    return armed[key] !== undefined && Date.now() < armed[key];
  }
  function danger(key, label, fn) {
    var btn = el('button', 'danger', label);
    btn.addEventListener('click', function () {
      if (isArmed(key)) {
        delete armed[key];
        fn();
        return;
      }
      armed[key] = Date.now() + 3000;
      btn.textContent = '再按一次确认';
      btn.classList.add('armed');
      setTimeout(function () {
        if (!isArmed(key)) { btn.textContent = label; btn.classList.remove('armed'); delete armed[key]; }
      }, 3200);
    });
    return btn;
  }
  function stateOf(id) {
    if (!ui[id]) ui[id] = { picks: {}, texts: {} };
    return ui[id];
  }
  function rerender() {
    if (lastData) { lastSig = ''; render(lastData); }
  }

  function submitAnswer(p) {
    var st = stateOf(p.pendingId);
    var choice = { kind: p.kind };
    if (p.kind === 'permission' || p.kind === 'plan') return null;
    var selections = [];
    for (var i = 0; i < p.questions.length; i++) {
      var sel = { questionIndex: i };
      var picks = st.picks[i] || [];
      if (picks.length > 0) sel.optionIndexes = picks.slice();
      var text = (st.texts[i] || '').trim();
      if (text) sel.text = text;
      if (!sel.optionIndexes && !sel.text) return null;   /* 每题必答 */
      selections.push(sel);
    }
    choice.selections = selections;
    return choice;
  }

  function renderQuestion(p, q, qi, card, expired) {
    var st = stateOf(p.pendingId);
    var block = el('div', 'q');
    var num = el('span', 'num', (qi + 1) + '.');
    block.appendChild(num);
    block.appendChild(document.createTextNode(q.question));
    card.appendChild(block);
    var opts = el('div', 'opts');
    (q.options || []).forEach(function (o, oi) {
      var btn = el('button', 'opt');
      btn.appendChild(document.createTextNode(o.label));
      if (o.description) btn.appendChild(el('span', 'desc', o.description));
      var selected = (st.picks[qi] || []).indexOf(oi) >= 0;
      if (selected) btn.classList.add('sel');
      if (expired) btn.disabled = true;
      btn.addEventListener('click', function () {
        var cur = st.picks[qi] || [];
        if (q.multiSelect) {
          var at = cur.indexOf(oi);
          if (at >= 0) cur.splice(at, 1); else cur.push(oi);
        } else {
          cur = selected ? [] : [oi];
        }
        st.picks[qi] = cur;
        if (!q.multiSelect) { st.texts[qi] = ''; }
        rerender();
      });
      opts.appendChild(btn);
    });
    card.appendChild(opts);
    var input = el('input');
    input.type = 'text';
    input.placeholder = q.multiSelect ? '补充说明（可选）' : '其他答案（可选）';
    input.value = st.texts[qi] || '';
    input.maxLength = 2000;
    if (expired) input.disabled = true;
    input.addEventListener('input', function () {
      st.texts[qi] = input.value;
      if (!q.multiSelect && input.value.trim() !== '') {
        st.picks[qi] = [];
        opts.querySelectorAll('.opt').forEach(function (b) { b.classList.remove('sel'); });
      }
    });
    card.appendChild(input);
  }

  function renderCard(p) {
    var card = el('div', 'card');
    var top = el('div', 'top');
    var name = p.taskName + (p.projectName ? '（' + p.projectName + '）' : '');
    top.appendChild(el('div', 'task', name));
    var badge = el('span', 'badge', p.kind === 'permission' ? '权限确认' : p.kind === 'plan' ? '计划审批' : '选择');
    if (p.expired) { badge.textContent = '已过期'; badge.classList.add('expired'); }
    top.appendChild(badge);
    card.appendChild(top);
    if (p.expired) card.appendChild(el('div', 'banner', '链接已过期：手机不再接受提交，请回电脑处理（桌面仍可继续）。'));

    var expired = p.expired === true;
    if (p.kind === 'permission' || p.kind === 'plan') {
      var row = el('div', 'row');
      var allowLabel = p.kind === 'permission' ? '允许' : '批准计划';
      var denyLabel = p.kind === 'permission' ? '拒绝' : '拒绝计划';
      var allowBtn = el('button', 'primary', allowLabel);
      var denyBtn = danger(p.pendingId + ':deny', denyLabel, function () {
        postAnswer(p, { kind: p.kind, action: 'deny' });
      });
      allowBtn.addEventListener('click', function () {
        postAnswer(p, { kind: p.kind, action: p.kind === 'permission' ? 'allow' : 'approve' });
      });
      if (expired) { allowBtn.disabled = true; denyBtn.disabled = true; }
      row.appendChild(allowBtn);
      row.appendChild(denyBtn);
      card.appendChild(row);
    } else {
      for (var i = 0; i < p.questions.length; i++) renderQuestion(p, p.questions[i], i, card, expired);
      var submit = el('button', 'primary', '提交回答');
      submit.disabled = expired;
      submit.addEventListener('click', function () {
        var choice = submitAnswer(p);
        if (choice) postAnswer(p, choice);
        else toast('请回答全部问题');
      });
      var row2 = el('div', 'row');
      row2.appendChild(submit);
      card.appendChild(row2);
    }

    var foot = el('div', 'foot');
    var left = el('div', 'left');
    var cancelBtn = el('button', 'ghost', '回电脑处理');
    cancelBtn.addEventListener('click', function () {
      cancelBtn.disabled = true;
      api('/api/cancel', { token: TOKEN, pendingId: p.pendingId }).then(function (r) {
        if (r.status === 200) { toast('已转回电脑'); poll(); }
        else { cancelBtn.disabled = false; toast('处理失败，请重试'); }
      });
    });
    left.appendChild(cancelBtn);
    var stopBtn = danger(p.taskId + ':stop', '停止任务', function () {
      api('/api/stop', { token: TOKEN, taskId: p.taskId }).then(function (r) {
        toast(r.status === 200 ? '已请求停止' : '停止失败');
        poll();
      });
    });
    left.appendChild(stopBtn);
    foot.appendChild(left);
    card.appendChild(foot);
    return card;
  }

  function postAnswer(p, choice) {
    api('/api/answer', { token: TOKEN, pendingId: p.pendingId, choice: choice }).then(function (r) {
      if (r.status === 200) { toast('已提交'); poll(); }
      else if (r.status === 410) { toast('该问题已处理或已过期'); poll(); }
      else if (r.status === 400) toast('答案无效，请重新选择');
      else toast('提交失败，请重试');
    });
  }

  function renderEnded(text) {
    listEl.textContent = '';
    countEl.textContent = '';
    var hint = el('div', 'hint', text);
    listEl.appendChild(hint);
  }

  function render(data) {
    var pendings = data.pendings || [];
    var sig = JSON.stringify(data.pendings || []) + '|' + JSON.stringify(data.tasks || []);
    countEl.textContent = pendings.length > 0 ? pendings.length + ' 个待答复' : '';
    if (sig === lastSig) return;
    lastSig = sig;
    listEl.textContent = '';
    if (pendings.length === 0) {
      listEl.appendChild(el('div', 'hint', '暂无待答复的问题。有新问题时会自动出现。'));
      return;
    }
    pendings.forEach(function (p) { listEl.appendChild(renderCard(p)); });
  }

  function poll() {
    if (stopped) return;
    if (timer) { clearTimeout(timer); timer = null; }
    api('/api/state?token=' + encodeURIComponent(TOKEN)).then(function (r) {
      statusEl.textContent = '';
      if (r.status === 410) {
        stopped = true;
        renderEnded('该链接已失效或任务已结束，请在电脑上处理。');
        return;
      }
      if (r.status !== 200) {
        statusEl.textContent = '连接中断，正在重试…';
        timer = setTimeout(poll, 2000);
        return;
      }
      if (r.data.ended) {
        stopped = true;
        renderEnded('该问题已处理，链接已失效。');
        return;
      }
      render(r.data);
      lastData = r.data;
      timer = setTimeout(poll, 2000);
    }).catch(function () {
      statusEl.textContent = '连接中断，正在重试…';
      timer = setTimeout(poll, 2000);
    });
  }

  if (!TOKEN) { renderEnded('链接不完整，请从推送消息重新打开。'); return; }
  poll();
})();
</script>
</body>
</html>
`

/** 页面 HTML（测试断言用） */
export function answerPageHtml(): string {
  return PAGE_HTML
}

/** token 提取（URL /a/<token>） */
export function tokenFromPath(path: string): string | undefined {
  const m = /^\/a\/([A-Za-z0-9_-]{20,})$/.exec(path)
  return m?.[1]
}

/** 轮询间隔（页面 JS 与测试共用常量） */
export const ANSWER_POLL_MS = 2000