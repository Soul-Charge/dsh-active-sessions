// dsh-active-sessions / src/rpc.js
//
// 职责：把服务端能力暴露成 5 个 localhost HTTP 端点，供 src/client.js fetch。
// 为什么走 HTTP 而不是宿主 RPC：客户端 UI 在浏览器里跑，HTTP 是最短路径；
// 契约 4.2 也指定"RPC 通道未通时降级为 fetch 本插件注册的 localhost 端点"。
//
// ── 已实测的注册 API（不得改动）─────────────────────────────────────────────
// ctx.webServer.register({ kind: 'exact', path, handler(req, res) })
//   dsh-host-webserver 的 register() 把 kind==='exact' 收进 exact 表、其余收进 prefix 表，
//   命中后直接 await route.handler(req, res)，handler **完全拥有响应生命周期**
//   （没有 next()、没有自动 JSON 包装），所以本模块自己写 head/body。
//   重复注册同一个 (kind, path) 会抛异常，因此每个 path 只注册一次，且用 ctx.effect
//   挂上 disposer，插件卸载时路由会被摘掉。
//
// 安全边界（本模块是唯一对外的门）：
//   1. 只允许 GET/HEAD/POST，其余 405；
//   2. 路径必须与注册路径逐字节相等，且拒绝任何编码后的穿越序列；
//   3. 请求体上限 64KB，超限 413 且不再累积；
//   4. 所有外部输入（body/url）先窄化再用，错误一律带 operation/target/error_code。
import { Buffer } from 'node:buffer'
import path from 'node:path'

/** 端点基路径。集中一处，避免 5 个字符串字面量漂移。 */
export const BASE_PATH = '/api/active-sessions'

/** 五个端点的规范路径（契约固定）。 */
export const ROUTES = {
  state: BASE_PATH + '/state',
  seen: BASE_PATH + '/seen',
  overview: BASE_PATH + '/overview',
  overviewGenerate: BASE_PATH + '/overview/generate',
  /**
   * 隐藏名单切换（2026-10-07 新增，第 5 条）。
   *
   * ⚠️ 路径带 /overview/ 前缀是有意的：它是**工作总览页的显示控制**，
   *    与 DSH 自己的 workspaces 服务（从注册表移除条目、影响侧栏与未分组会话）毫无关系。
   *    用户原话：「只从列表移除，但是不能影响到我 dsh 本身的工作区」——
   *    这里的语义严格是「不写 workspace.json，只写插件自己的隐藏名单文件」。
   */
  overviewHidden: BASE_PATH + '/overview/hidden',
}

/** 请求体上限 64KB。超限直接拒绝，绝不"读完再截断"——那等于把内存交给调用方控制。 */
const MAX_BODY_BYTES = 64 * 1024

/** 读 body 的超时：客户端只发一半就挂住时不能把 handler 永久占住。 */
const BODY_TIMEOUT_MS = 10_000

/** 允许的 HTTP 方法。HEAD 与 GET 同路由，只是不回 body。 */
const ALLOWED_METHODS = new Set(['GET', 'HEAD', 'POST'])

/** sessionId 上限：DSH 的会话 id 是 uuid（36 字符），留足余量但不接受任意长串。 */
const MAX_SESSION_ID_LENGTH = 200

/** 非数组对象判定。deps 的返回值与请求体都是外部输入，只在这个形状下才允许继续取字段。 */
function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * 批量标记已读的条数上限（问题二：「全部标记已读」）。
 *
 * 为什么有上限：请求体总上限 64KB，一个 uuid 是 38 字节，理论上能塞 ~1700 条，
 * 但那意味着服务端一次性改 1700 个 Map 项 + 一次同步写盘。这里取 1000，
 * 够覆盖实测最大场景（本机过滤后 unseen 484 条），又不至于把内存/IO 一次性打满。
 * 超限直接 400，**不截断** —— 截断会让用户以为清干净了，其实还剩一截。
 */
const MAX_BATCH_SESSION_IDS = 1000

/** 诊断串前缀，与 approval.js 保持同一风格便于日志里 grep。 */
const LOG_PREFIX = '[active-sessions/rpc]'

/**
 * 组装带上下文的诊断串。
 * 为什么是字符串：契约规定失败响应是 {ok:false, error:string}，错误必须有足够信息
 * 才能在浏览器 Network 面板里一眼定位，不需要再去翻服务端日志。
 */
export function describeError(operation, target, errorCode, context) {
  const parts = ['operation=' + operation, 'target=' + target, 'error_code=' + errorCode]
  if (context !== undefined) {
    let text
    try {
      text = JSON.stringify(context)
    } catch {
      text = '"<unserializable>"'
    }
    parts.push('context=' + String(text === undefined ? '"<undefined>"' : text).slice(0, 500))
  }
  return LOG_PREFIX + ' ' + parts.join(' | ')
}

/** 统一成功响应：{ok:true, data}。 */
export function sendOk(res, data, status = 200, headOnly = false) {
  const body = JSON.stringify({ ok: true, data: data === undefined ? null : data })
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.statusCode = status
  if (headOnly) {
    res.setHeader('content-length', Buffer.byteLength(body, 'utf8'))
    res.end()
    return
  }
  res.end(body)
}

/** 统一失败响应：{ok:false, error:string}。error 必须是字符串（契约）。 */
export function sendFail(res, status, errorText, headOnly = false) {
  const body = JSON.stringify({ ok: false, error: String(errorText) })
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.statusCode = status
  if (headOnly) {
    res.setHeader('content-length', Buffer.byteLength(body, 'utf8'))
    res.end()
    return
  }
  res.end(body)
}

/**
 * 解析请求 URL。
 * 为什么不用 new URL(req.url, base) 后直接信 pathname：这里要显式检查原始字节里的
 * 穿越序列。req.url 是攻击者可控的，'..%2F' 之类在部分中间件里会被二次解码，
 * 所以对**原始串**和**解码后串**都做一次判断，双保险。
 *
 * @returns {{ok:true, pathname:string, searchParams:URLSearchParams} | {ok:false, reason:string}}
 */
export function parseRequestUrl(rawUrl) {
  if (typeof rawUrl !== 'string' || rawUrl === '') {
    return { ok: false, reason: 'missing request url' }
  }
  let parsed
  try {
    parsed = new URL(rawUrl, 'http://active-sessions.local')
  } catch (error) {
    return { ok: false, reason: 'malformed request url: ' + String(error?.message ?? error).slice(0, 120) }
  }
  const pathname = parsed.pathname
  // 路径穿越防御：本模块不读任何文件，但拒绝异常路径能在边界处就闭合掉攻击面。
  // 关键：只检查**路径部分**（'?' 之前）。若连同查询串一起检查，
  // 未来加过滤参数时 '?path=a%2Fb' 会被误判成穿越——那是假阳性。
  const rawPath = rawUrl.split('?')[0]
  if (pathname.includes('..') || /%2e|%2f|%5c/i.test(rawPath) || rawPath.includes('\\')) {
    return { ok: false, reason: 'path traversal sequence rejected' }
  }
  if (!pathname.startsWith(BASE_PATH)) {
    return { ok: false, reason: 'path outside ' + BASE_PATH }
  }
  return { ok: true, pathname, searchParams: parsed.searchParams }
}

/**
 * 读取并解析 JSON 请求体。
 * 契约要求：限制 body 大小 64KB。
 * 关键设计：超过上限时**立刻**停止累积并拒绝（413），而不是继续吃数据再截断——
 * 否则一个恶意大 body 仍然会把进程内存顶上去。
 *
 * @returns {Promise<{ok:true,value:object} | {ok:false,status:number,error:string}>}
 */
export function readJsonBody(req, limitBytes = MAX_BODY_BYTES, timeoutMs = BODY_TIMEOUT_MS) {
  return new Promise((resolve) => {
    const operation = '读取请求体'
    const target = String(req?.url ?? '')
    const chunks = []
    let size = 0
    let settled = false
    let timer = null

    const detach = () => {
      req.removeListener('data', onData)
      req.removeListener('end', onEnd)
      req.removeListener('error', onError)
      req.removeListener('aborted', onAborted)
    }

    const finish = (outcome) => {
      if (settled) return
      settled = true
      if (timer !== null) clearTimeout(timer)
      detach()
      resolve(outcome)
    }

    // 关键：超限后**不能** req.destroy()。销毁 socket 会让调用方随后要写的
    // 413 响应根本没有信道可回，客户端只能看到 "fetch failed"（实测踩过）。
    // 正确做法是暂停读取（不再消耗内存），把错误交回 handler，
    // 由 handler 写响应并置 connection: close 让 Node 收尾时再拆连接。
    const rejectWith = (status, errorCode, context) => {
      try {
        req.pause()
      } catch {
        /* pause 失败不影响错误上报：我们已停止累积数据 */
      }
      finish({ ok: false, status, error: describeError(operation, target, errorCode, context), closeConnection: true })
    }

    function onData(chunk) {
      if (settled) return
      size += chunk.length
      if (size > limitBytes) {
        rejectWith(413, 'BODY_TOO_LARGE', { limit: limitBytes, received: size })
        return
      }
      chunks.push(chunk)
    }

    function onEnd() {
      if (settled) return
      const raw = Buffer.concat(chunks).toString('utf8').trim()
      if (raw === '') {
        // 空 body 视为 {}：'记已读'之外的动作都由显式字段驱动，缺字段会走各自的校验分支。
        finish({ ok: true, value: {} })
        return
      }
      let parsed
      try {
        parsed = JSON.parse(raw)
      } catch (error) {
        finish({ ok: false, status: 400, error: describeError(operation, target, 'INVALID_JSON', { bytes: size, message: String(error?.message ?? error).slice(0, 160) }) })
        return
      }
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        finish({ ok: false, status: 400, error: describeError(operation, target, 'BODY_NOT_OBJECT', { received: Array.isArray(parsed) ? 'array' : typeof parsed }) })
        return
      }
      finish({ ok: true, value: parsed })
    }

    function onError(error) {
      finish({ ok: false, status: 400, error: describeError(operation, target, error?.code ?? error?.name ?? 'REQUEST_ERROR', { message: String(error?.message ?? error).slice(0, 160) }) })
    }

    function onAborted() {
      finish({ ok: false, status: 400, error: describeError(operation, target, 'REQUEST_ABORTED', { received: size }) })
    }

    timer = setTimeout(() => {
      rejectWith(408, 'BODY_TIMEOUT', { timeoutMs, received: size })
    }, timeoutMs)
    if (typeof timer.unref === 'function') timer.unref()

    req.on('data', onData)
    req.on('end', onEnd)
    req.on('error', onError)
    req.on('aborted', onAborted)
  })
}

/**
 * 窄化 sessionId 外部输入。
 * 拒绝空串、非字符串、超长、以及含控制字符/路径分隔符的串——
 * 这个值会进内存 Map 的键，也会被回显，必须先在边界处收紧。
 */
export function normalizeSessionId(value) {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  if (trimmed === '' || trimmed.length > MAX_SESSION_ID_LENGTH) return null
  // eslint-disable-next-line no-control-regex -- 控制字符检测正是这里的意图
  if (/[\u0000-\u001f\u007f/\\]/.test(trimmed)) return null
  return trimmed
}

/**
 * 工作区 cwd 上限。
 * 4096 与 Linux 的 PATH_MAX 一致；实测本机最长的真实工作区路径不足 200 字符，
 * 取 4096 是为了「远超真实值、又不至于让 Map 键被一个巨型串撑爆」。
 */
export const MAX_WORKSPACE_CWD_LENGTH = 4096

/**
 * 窄化**工作区 cwd**外部输入（隐藏名单的 key）。
 *
 * 这是全插件**唯一**的 cwd 校验入口：rpc.js 的端点用它，index.js 落盘前也用它，
 * 两边共用同一个函数，避免「一处放宽一处收紧」导致隐藏名单写进去却匹配不上。
 *
  * 逐条拒绝规则（每项都有理由）：
  *   1. **非字符串** -> null。body 里的 cwd 可能是 null / 数字 / 对象 / 数组。
 *   2. **首尾空白** → trim。抓取、复制粘贴最容易带上不可见空白。
 *   3. **空串 / 超长**（>4096） → null。它会进 Map 键并落盘，不能无界。
 *   4. **非 POSIX 绝对路径**（不以 `/` 开头） → null。
 *      ⚠️ 这一条同时挡掉了会话投影里实测存在的 Windows 原始路径
 *      （`E:\MyData\...`，见 overview.js 的 CWD_NOT_ABSOLUTE）——
 *      path.isAbsolute 在 Linux 上会把它当相对路径，凭空造出假工作区。
 *   5. **含 `..`** → null。这个值会变成 Map 键并写进 JSON 文件，
 *      带穿越段的键一旦将来被人拿去拼路径就是漏洞；现在没有理由接受它。
 *   6. **含反斜杠 `\\`** → null。POSIX 路径里它是纯噪声，却常是「混进来的 Windows 路径」。
 *   7. **含控制字符** → null。会破坏日志、JSON 展示与终端。
 *
 * 通过后返回的是 **path.resolve 归一化后的绝对路径**，而不是原串。
 * 为什么必须归一化（否则会静默失效）：扫描侧 overview.js 的 discoverWorkspaceRoots
 * 用 `path.resolve(raw)` 作为工作区键，所以用户发来的 `/mnt/<drive>/.../workspace/`（带尾斜杠）
 * 或 `//mnt/<drive>/.../workspace`（双斜杠）若原样入库，就与扫描侧的键不相等，
 * 结果是「接口回 ok=true、界面卡片也消失了、刷新后原样回来」——最难查的一类 bug。
 * 此处已经排除 `..`，所以 resolve 在这里**只做归一化不做上跳**，是安全的。
 *
 * @returns {string|null} 归一化后的 cwd；不合法时为 null
 */
export function normalizeWorkspaceCwd(value) {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  if (trimmed === '' || trimmed.length > MAX_WORKSPACE_CWD_LENGTH) return null
  if (!trimmed.startsWith('/')) return null
  if (trimmed.includes('..')) return null
  if (trimmed.includes('\\')) return null
  // eslint-disable-next-line no-control-regex -- 控制字符检测正是这里的意图
  if (/[\u0000-\u001f\u007f]/.test(trimmed)) return null
  const resolved = path.resolve(trimmed)
  // 双保险：resolve 之后仍必须是绝对路径（理论上不会走到，但这个键会落盘，值得多看一眼）。
  if (!resolved.startsWith('/')) return null
  return resolved
}
/**
 * 把 deps 上的能力适配成"可 await 的调用"，并在缺失时给出可诊断的错误。
 * 为什么不直接调用：deps 由 src/index.js 组装，缺字段是集成事故，
 * 必须变成一条能定位的 500 响应，而不是 TypeError: xxx is not a function。
 */
async function invoke(depName, fn, options) {
  if (typeof fn !== 'function') {
    throw new Error(
      describeError('调用依赖', depName, 'DEPENDENCY_MISSING', {
        hint: 'src/index.js 组装 deps 时必须提供该函数',
        options: options === undefined ? null : Object.keys(options),
      }),
    )
  }
  return await fn(options)
}

/**
 * 为某个端点构造 handler。
 *
 * 契约"只允许 GET/HEAD/POST，其他返回 405"在**最前面**执行，因为一个
 * DELETE/PUT 请求不该有机会触达任何业务逻辑或 body 读取。
 *
 * @param {string} path 该 handler 负责的规范路径
 * @param {(req,res,flags:{headOnly:boolean})=>Promise<void>} run 业务体
 */
function createHandler(path, run) {
  return async function handler(req, res) {
    const method = String(req?.method ?? 'GET').toUpperCase()
    const headOnly = method === 'HEAD'
    if (!ALLOWED_METHODS.has(method)) {
      res.setHeader('allow', 'GET, HEAD, POST')
      sendFail(res, 405, describeError('处理方法', path, 'METHOD_NOT_ALLOWED', { method }))
      return
    }
    const parsed = parseRequestUrl(req?.url)
    if (!parsed.ok) {
      sendFail(res, 400, describeError('解析请求路径', String(req?.url ?? ''), 'INVALID_REQUEST_PATH', { reason: parsed.reason }))
      return
    }
    // 逐字节相等：不做前缀/尾斜杠模糊匹配，'.../state/' 这类变体直接 404。
    if (parsed.pathname !== path) {
      sendFail(res, 404, describeError('路由匹配', parsed.pathname, 'ROUTE_NOT_FOUND', { expected: path }))
      return
    }
    try {
      await run(req, res, { headOnly, searchParams: parsed.searchParams })
    } catch (error) {
      // 业务失败必须变成结构化 JSON，而不是让 webserver 兜底的 400 空响应。
      const detail = describeError('执行端点', path, error?.errorCode ?? error?.code ?? error?.name ?? 'INTERNAL_ERROR', {
        message: String(error?.message ?? error).slice(0, 400),
      })
      if (res.headersSent) {
        // 已经写过 head 就没法再改状态码，只能断连，同时把详情留给服务端日志。
        res.destroy()
        throw new Error(detail)
      }
      sendFail(res, 500, detail, headOnly)
    }
  }
}

/**
 * 注册 5 个 HTTP 端点。
 *
 * @param {object} ctx Cordis 插件上下文；需要 ctx.webServer（或 ctx.get('webServer')）
 * @param {object} deps 由 src/index.js 组装：
 *   - scanStates(): StateSnapshot
 *   - scanOverview(options?: {generate?:boolean}): Promise<OverviewResult>
 *   - setWorkspaceHidden(cwd, hidden): {ok, hiddenList, hiddenWorkspaces} | {ok:false, errorCode}
 *                                        （可选；缺省时端点回 501，见 ROUTES.overviewHidden）
 *   - markSeen(sessionId, at?): boolean   （可选；缺省时退化为本模块内部 Map）
 *   - seen: Map<string, number>           （可选；与 markSeen 二选一即可）
 * @returns {Array<() => void>} 各端点的 disposer（ctx.effect 可用时由 cordis 托管）
 */
export function registerRoutes(ctx, deps) {
  if (ctx === null || typeof ctx !== 'object') {
    throw new Error(describeError('注册端点', BASE_PATH, 'INVALID_CTX', { received: typeof ctx }))
  }
  const d = deps !== null && typeof deps === 'object' ? deps : {}
  // 两个注册入口在部分组合里是"稍后就位"的服务，apply 时可能还没挂上，故两处都探一次。
  // ⚠️ 校验必须**任一可用即通过**：早期版本只检查 webServer，导致某组合里
  //    connection 可用但 webServer 缺席时直接抛错（实测踩到）。
  const webServer = ctx.webServer ?? (typeof ctx.get === 'function' ? ctx.get('webServer') : undefined)
  const hasWebServer = webServer !== null && webServer !== undefined && typeof webServer.register === 'function'
  const connectionProbe = ctx.connection ?? (typeof ctx.get === 'function' ? ctx.get('connection') : undefined)
  const hasConnection = connectionProbe !== null && connectionProbe !== undefined &&
    connectionProbe.fetch !== null && connectionProbe.fetch !== undefined &&
    typeof connectionProbe.fetch.register === 'function'
  if (hasWebServer !== true && hasConnection !== true) {
    throw new Error(
      describeError('注册端点', BASE_PATH, 'WEBSERVER_UNAVAILABLE', {
        hasWebServer: webServer !== undefined && webServer !== null,
        hasConnection: connectionProbe !== undefined && connectionProbe !== null,
        inject: 'src/index.js 声明 inject = ["webServer"]',
      }),
    )
  }

  // 已读水位：优先用 index.js 注入的 markSeen/seen（多标签页下的单一一致性点），
  // 两者都没有时退化为本模块内部 Map，保证端点永远可用而非 500。
  const fallbackSeen = d.seen instanceof Map ? d.seen : new Map()
  const markSeen =
    typeof d.markSeen === 'function'
      ? d.markSeen
      : (sessionId, at) => {
          const previous = fallbackSeen.get(sessionId)
          // 取 max：乱序到达的上报不能把已读水位往回拨。
          fallbackSeen.set(sessionId, previous === undefined ? at : Math.max(previous, at))
          return true
        }

  const handlers = new Map()

  // 批量已读（问题二）。缺席时 /seen 的 sessionIds 分支返回 501 并给出可诊断的说明，
  // 而不是回退成「悄悄只处理第一条」——后者会让用户以为清干净了其实没有。
  const markSeenMany =
    typeof d.markSeenMany === 'function'
      ? d.markSeenMany
      : typeof d.seen instanceof Map
        ? (ids, at) => {
          let applied = 0
          for (const id of ids) {
            const prev = d.seen.get(id)
            const next = prev === undefined ? at : Math.max(prev, at)
            if (prev !== next) { d.seen.set(id, next); applied += 1 }
          }
          return applied
        }
        : null

  handlers.set(ROUTES.state, createHandler(ROUTES.state, async (req, res, flags) => {
    const data = await invoke('scanStates', d.scanStates)
    sendOk(res, data, 200, flags.headOnly)
  }))

  handlers.set(ROUTES.seen, createHandler(ROUTES.seen, async (req, res, flags) => {
    const body = await readJsonBody(req)
    if (!body.ok) {
      // 413/408 场景下连接里还有未读完的字节，必须显式告诉客户端本连接就此结束，
      // 否则 keep-alive 会把残余字节当成下一个请求来解析。
      if (body.closeConnection === true) res.setHeader('connection', 'close')
      sendFail(res, body.status, body.error, flags.headOnly)
      return
    }
    const at = Number.isFinite(body.value.at) ? Number(body.value.at) : Date.now()

    // ── 批量分支（问题二：「全部标记已读」）─────────────────────────────
    // 为什么复用**同一条路由**而不是新加一条 /seen/batch：
    //   1) 批量与单条本就是同一动作，少一条路由就少一处要同步的冻结契约
    //      （注：2026-10-07 已因「隐藏工作区」加到 5 条，契约数随之同步，见 acceptance.sh）；
    //   2) 语义上它们就是同一个动作「把这些会话标记已读」，只是数量不同。
    // 载荷形状 {sessionIds:[...]} 与单条 {sessionId} 互斥，两个都传以 sessionIds 为准。
    if (Array.isArray(body.value.sessionIds)) {
      if (body.value.sessionIds.length > MAX_BATCH_SESSION_IDS) {
        sendFail(res, 400, describeError('批量标记已读', ROUTES.seen, 'BATCH_TOO_LARGE', {
          received: body.value.sessionIds.length,
          max: MAX_BATCH_SESSION_IDS,
          hint: '请分批上报；服务端不做静默截断（截断会让用户以为清干净了）',
        }), flags.headOnly)
        return
      }
      // 逐条窄化：服务端只认 normalizeSessionId 通过的那些，坏的单独计数不静默丢。
      const accepted = []
      let rejected = 0
      for (const raw of body.value.sessionIds) {
        const id = normalizeSessionId(raw)
        if (id === null) rejected += 1
        else accepted.push(id)
      }
      if (typeof markSeenMany !== 'function') {
        sendFail(res, 501, describeError('批量标记已读', ROUTES.seen, 'NOT_IMPLEMENTED', {
          hint: '服务端未提供 markSeenMany（src/index.js 的 deps 缺字段）',
        }), flags.headOnly)
        return
      }
      let applied = 0
      try {
        applied = markSeenMany(accepted, at)
      } catch (error) {
        throw new Error(describeError('批量标记已读', ROUTES.seen, error?.code ?? error?.name ?? 'MARK_SEEN_BATCH_FAILED', {
          requested: accepted.length,
          message: String(error?.message ?? error).slice(0, 200),
        }))
      }
      if (rejected > 0) {
        ctx.logger?.warn?.(describeError('批量标记已读', ROUTES.seen, 'PARTIAL_REJECT', { rejected, accepted: accepted.length }))
      }
      sendOk(res, { applied, requested: accepted.length, rejected, at }, 200, flags.headOnly)
      return
    }

    const sessionId = normalizeSessionId(body.value.sessionId)
    if (sessionId === null) {
      sendFail(res, 400, describeError('标记已读', ROUTES.seen, 'INVALID_SESSION_ID', {
        receivedType: typeof body.value.sessionId,
        hint: 'sessionId 必须是长度 1..200 的裸 uuid 或 session-<uuid> 字符串',
      }), flags.headOnly)
      return
    }
    let applied = false
    try {
      applied = markSeen(sessionId, at) !== false
    } catch (error) {
      throw new Error(describeError('标记已读', sessionId, error?.code ?? error?.name ?? 'MARK_SEEN_FAILED', { message: String(error?.message ?? error).slice(0, 200) }))
    }
    sendOk(res, { sessionId, at, applied }, 200, flags.headOnly)
  }))

  /**
   * 模型目录诊断串。格式与 warnLine / describeError 一致（[op] target -> CODE: msg {json}），
   * 前端 parseWarningLine 只认这一种形状 —— 这里若另写一套就会落进「未分组」逐条刷屏。
   */
  const modelDiag = (operation, target, code, error) => {
    const message = String(error?.message ?? error)
      .slice(0, 200)
      .replace(/[\r\n\t]+/g, ' ')
      .replace(/\{/g, '(')
      .replace(/\}/g, ')')
    return '[' + String(operation) + '] ' + String(target) + ' -> ' + String(code) + ': ' + message +
      ' ' + JSON.stringify({ plugin: 'dsh-active-sessions/rpc', degraded: '模型下拉为空，「立即生成」不可用' })
  }

  handlers.set(ROUTES.overview, createHandler(ROUTES.overview, async (req, res, flags) => {
    // GET 永远不触发模型调用（0 token 保证）：只回文件清单与统计。
    const data = await invoke('scanOverview', d.scanOverview, { generate: false })
    // models 供模型下拉使用；取不到时给空数组 + warning，前端降级为占位提示。
    // 不把 models 失败当作整个请求失败 —— 笔记清单本身仍然有用。
    let models = []
    let modelWarnings = []
    if (typeof d.listModels === 'function') {
      try {
        const catalog = await d.listModels()
        models = Array.isArray(catalog?.models) ? catalog.models : []
        modelWarnings = Array.isArray(catalog?.warnings) ? catalog.warnings : []
      } catch (error) {
        modelWarnings = [modelDiag('列举模型', 'd.listModels()', 'LIST_MODELS_FAILED', error)]
      }
    } else {
      modelWarnings = [modelDiag('列举模型', 'deps.listModels', 'LIST_MODELS_UNAVAILABLE', new Error('服务端未提供 listModels，无法生成总结'))]
    }
    const merged = {
      ...(data !== null && typeof data === 'object' ? data : {}),
      models,
      warnings: [
        ...(Array.isArray(data?.warnings) ? data.warnings : []),
        ...modelWarnings,
      ],
    }
    sendOk(res, merged, 200, flags.headOnly)
  }))

  handlers.set(ROUTES.overviewGenerate, createHandler(ROUTES.overviewGenerate, async (req, res, flags) => {
    // 读 body 拿用户选的模型 id。
    // 必须消费掉请求流，否则 keep-alive 连接上残留的字节会被当作下一个请求解析。
    let body = { ok: false, status: 400, error: '请求体不可读' }
    if (req.readableEnded !== true) body = await readJsonBody(req)
    if (body.ok !== true) {
      sendFail(res, body.status ?? 400, body.error ?? '请求体不可读', flags.headOnly)
      return
    }
    const selectedModel = body.value !== null && typeof body.value === 'object' && typeof body.value.model === 'string'
      ? body.value.model
      : ''
    // 这一步会真正调用模型（插件里唯一烧 token 的路径）。
    if (typeof d.generateSummaries !== 'function') {
      sendFail(res, 501, '服务端未实现 generateSummaries（operation=generateOverview target=' + ROUTES.overviewGenerate + ' error_code=NOT_IMPLEMENTED）', flags.headOnly)
      return
    }
    const generated = await d.generateSummaries({ model: selectedModel })
    // 同时回文件清单，前端据此渲染每个工作区的分区与摘要
    const listing = await invoke('scanOverview', d.scanOverview, { generate: false })
    const data = {
      ...(listing !== null && typeof listing === 'object' ? listing : {}),
      summaries: generated?.summaries ?? {},
      model: generated?.model ?? null,
      warnings: [
        ...(Array.isArray(listing?.warnings) ? listing.warnings : []),
        ...(Array.isArray(generated?.warnings) ? generated.warnings : []),
      ],
    }
    sendOk(res, data, 200, flags.headOnly)
  }))

  /**
   * 隐藏名单切换（2026-10-07，第 5 条路由）。
   *
   * ⚠️ **这不是 DSH 的工作区删除**：不碰 workspace.json、不碰 workspaces 服务、
   *    不影响侧栏与会话记录。用户原话：「只从列表移除，但是不能影响到我 dsh 本身的工作区，
   *    只是这个插件的工作总览的工作区显示」。实现方式是切一份**插件自己**的隐藏名单（cwd -> epoch ms），
   *    由 src/index.js 落盘到 $DSH_HOME/active-sessions-hidden-workspaces.json。
   *
   * 载荷 {cwd, hidden}：hidden=true 隐藏、false 取消隐藏（= 恢复）。
   * 刻意做成**切换**而不是两个端点（隐藏/恢复）：动作对称、载荷同构，
   * 且少一条路由就少一处要同步的冻结契约。
   *
   * 校验顺序刻意为「先窄化 cwd -> 再看 hidden 标志 -> 最后才改名单并落盘」：
   *   cwd 是唯一会进 Map 键与落盘文件的外部输入，必须最先收紧；
   *   hidden 不是布尔就整个拒绝，绝不「当成 false 顺手取消隐藏」——
   *   那样一次客户端 bug 就会静默清掉用户的心智负担。
   */
  handlers.set(ROUTES.overviewHidden, createHandler(ROUTES.overviewHidden, async (req, res, flags) => {
    let body = { ok: false, status: 400, error: '请求体不可读' }
    if (req.readableEnded !== true) body = await readJsonBody(req)
    if (body.ok !== true) {
      if (body.closeConnection === true) res.setHeader('connection', 'close')
      sendFail(res, body.status ?? 400, body.error ?? '请求体不可读', flags.headOnly)
      return
    }
    const cwd = normalizeWorkspaceCwd(body.value.cwd)
    if (cwd === null) {
      sendFail(res, 400, describeError('切换工作区隐藏状态', ROUTES.overviewHidden, 'INVALID_WORKSPACE_CWD', {
        receivedType: typeof body.value.cwd,
        receivedLength: typeof body.value.cwd === 'string' ? body.value.cwd.length : -1,
        hint: 'cwd 必须是 POSIX 绝对路径、不含 .. 、长度 <= ' + MAX_WORKSPACE_CWD_LENGTH,
      }), flags.headOnly)
      return
    }
    if (body.value.hidden !== true && body.value.hidden !== false) {
      sendFail(res, 400, describeError('切换工作区隐藏状态', ROUTES.overviewHidden, 'INVALID_HIDDEN_FLAG', {
        receivedType: typeof body.value.hidden,
        hint: 'hidden 必须是布尔值；缺失或非法一律拒绝，不默认当成 false（那会静默取消隐藏）',
      }), flags.headOnly)
      return
    }
    if (typeof d.setWorkspaceHidden !== 'function') {
      sendFail(res, 501, describeError('切换工作区隐藏状态', ROUTES.overviewHidden, 'NOT_IMPLEMENTED', {
        hint: '服务端未提供 setWorkspaceHidden（src/index.js 的 deps 缺字段）',
      }), flags.headOnly)
      return
    }
    let result
    try {
      result = d.setWorkspaceHidden(cwd, body.value.hidden)
    } catch (error) {
      throw new Error(describeError('切换工作区隐藏状态', cwd,
        error?.errorCode ?? error?.code ?? error?.name ?? 'SET_HIDDEN_FAILED', {
          message: String(error?.message ?? error).slice(0, 200),
        }))
    }
    if (isRecord(result) && result.ok === false) {
      // 依赖层可诊断地拒绝（例如名单文件损坏，拒绝覆盖原文件）。转成 409 而不是 500：
      // 这不是服务端崩了，是「当前状态不允许这次写入」，客户端要照原文展示给用户。
      sendFail(res, 409, describeError('切换工作区隐藏状态', cwd, String(result.errorCode ?? 'HIDDEN_REJECTED'), {
        message: String(result.message ?? '').slice(0, 300),
        hint: result.hint === undefined ? '' : String(result.hint).slice(0, 200),
      }), flags.headOnly)
      return
    }
    sendOk(res, {
      cwd: cwd,
      hidden: body.value.hidden,
      // 回带完整名单：工具栏的「已隐藏（N）」入口与恢复列表都由它渲染，
      // 客户端不必为了画这个入口再打一次 GET。
      hiddenList: isRecord(result) && Array.isArray(result.hiddenList) ? result.hiddenList : [],
      hiddenWorkspaces: isRecord(result) && Number.isFinite(result.hiddenWorkspaces) ? result.hiddenWorkspaces : 0,
    }, 200, flags.headOnly)
  }))
  // ── 注册层：优先走 connection（带鉴权），回退 webServer（**无鉴权**）──────
  //
  // 为什么必须优先 connection：实测确认（见 README 第 13 轮）
  //   - dsh-host-webserver 的 match() 是「exact 表优先，未命中才走 prefix」；
  //   - 鉴权门 requestRejection（Host fence + 浏览器 cookie）只挂在
  //     dsh-client-connection 注册的 /api **prefix** 路由内部；
  //   - 所以一个直接 webServer.register 的 exact 路由会**绕过鉴权**。
  //     实证：/plugins/events（官方 exact）无 cookie 返回 200 可直读，
  //     而 /api/present.open（走 connection）无 cookie 返回 401。
  // 本机 webServer 监听 0.0.0.0，绕过鉴权意味着**同网段任何设备**都能读到
  // 用户的会话标题与工作区路径 —— 这是真实的数据暴露，不可接受。
  //
  // connection.fetch.register 用 Web Fetch API（返回 Response），与 webServer 的
  // 原生 (req,res) 形状不同，故这里做一层适配：把 Request 转成现有 handler 需要的
  // 形状，再把结果包成 Response —— 业务 handler 一行不用改。
  const connection = ctx.connection ?? (typeof ctx.get === 'function' ? ctx.get('connection') : undefined)
  const useConnection = connection !== null && connection !== undefined &&
    connection.fetch !== null && connection.fetch !== undefined &&
    typeof connection.fetch.register === 'function'

  // 每个端点允许的方法。**按 path 建表**，而不是靠三元链挑 key ——
  // 三元链每加一条路由就要改一次（改漏了会静默把新端点声明成 state 的 GET/HEAD，
  // 表现为「POST 上来就 405」，是最难查的一类装配 bug）。
  const METHODS_BY_PATH = new Map([
    [ROUTES.state, ['GET', 'HEAD']],
    [ROUTES.seen, ['POST']],
    [ROUTES.overview, ['GET', 'HEAD']],
    [ROUTES.overviewGenerate, ['POST']],
    [ROUTES.overviewHidden, ['POST']],
  ])

  const toFetchRoute = (path, handler) => ({
    path,
    methods: METHODS_BY_PATH.get(path) ?? ['GET', 'HEAD'],
    requestBody: 'buffered',
    fetch: async (request) => {
      // 用 Web 标准 Request/Response 复刻 handler 语义：
      // 把 Request 包成 { method, url, headers, body } 形状交给同一个 run 函数。
      const url = new URL(request.url)
      const method = String(request.method ?? 'GET').toUpperCase()
      const headOnly = method === 'HEAD'
      let rawBody = ''
      if (method === 'POST') {
        try { rawBody = await request.text() } catch { rawBody = '' }
      }
      // fakeReq 必须模拟最小 EventEmitter：readJsonBody 用 req.on('data'/'end')
      // 读 body；只给 bodyText 字段会让它抛 "req.on is not a function"（实测踩到）。
      // 这里在 next tick 把缓存的 body 通过事件发出去，语义与真实流一致。
      const listeners = new Map()
      const fakeReq = {
        method,
        url: url.pathname + url.search,
        headers: Object.fromEntries(request.headers),
        readableEnded: false,
        on(event, cb) {
          const list = listeners.get(event) ?? []
          list.push(cb)
          listeners.set(event, list)
          return fakeReq
        },
        removeListener(event, cb) {
          const list = listeners.get(event) ?? []
          listeners.set(event, list.filter((fn) => fn !== cb))
          return fakeReq
        },
        pause() {},
        resume() {},
        destroy() {},
      }
      const emit = (event, arg) => {
        for (const cb of listeners.get(event) ?? []) {
          try { cb(arg) } catch (error) {
            // 监听器异常不该吞：交给外层 catch 转成结构化 500。
            throw error
          }
        }
      }
      // 先注册再投递：handler 内部会同步挂上监听器，故推迟到 microtask 之后再发。
      queueMicrotask(() => {
        if (rawBody.length > 0) emit('data', Buffer.from(rawBody, 'utf8'))
        emit('end')
      })
      const result = await runHandlerToResponse(path, handler, fakeReq, headOnly)
      return result
    },
  })

  /**
   * 把既有 (req,res) 风格的 handler 跑一遍，收集它写出的状态码/头/体，
   * 再包成 Web Response。这样业务逻辑与注册层解耦，不必改写每个 handler。
   */
  async function runHandlerToResponse(path, handler, fakeReq, headOnly) {
    let status = 200
    const headers = {}
    const chunks = []
    const fakeRes = {
      statusCode: 200,
      headersSent: false,
      setHeader(name, value) { headers[String(name).toLowerCase()] = String(value) },
      writeHead(code, h) { status = code; fakeRes.headersSent = true; if (h) for (const [k, v] of Object.entries(h)) headers[String(k).toLowerCase()] = String(v) },
      end(body) { if (body !== undefined && body !== null && headOnly !== true) chunks.push(typeof body === 'string' ? body : String(body)); fakeRes.headersSent = true },
      destroy() {},
      pause() {}, resume() {}, on() {}, removeListener() {},
      get statusCodeValue() { return status },
    }
    await handler(fakeReq, fakeRes)
    status = Number.isFinite(fakeRes.statusCode) ? fakeRes.statusCode : status
    const body = chunks.join('')
    // HEAD 不带 body（由 headOnly 控制），但 content-length 仍应反映完整长度。
    const payload = headOnly === true ? null : body
    return new Response(payload, { status, headers })
  }

  const disposers = []
  for (const [path, handler] of handlers) {
    const install = () => {
      try {
        if (useConnection) return connection.fetch.register(toFetchRoute(path, handler))
        return webServer.register({ kind: 'exact', path, handler })
      } catch (error) {
        // 重复注册会抛。这属于装配错误，必须冒泡并在 index.js 里记 error 日志，
        // 否则客户端只会看到 404。
        throw new Error(
          describeError('注册路由', path, error?.code ?? error?.name ?? 'REGISTER_FAILED', {
            message: String(error?.message ?? error).slice(0, 300),
          }),
        )
      }
    }
    if (typeof ctx.effect === 'function') {
      // 走 cordis 生命周期：插件卸载时路由自动摘除，避免热重载后重复注册报冲突。
      ctx.effect(install, 'dsh-active-sessions: ' + path)
    } else {
      const dispose = install()
      if (typeof dispose === 'function') disposers.push(dispose)
    }
  }

  ctx.logger?.info?.(
    LOG_PREFIX + ' 已注册 ' + handlers.size + ' 个端点 | target=' + BASE_PATH + ' | error_code=NONE',
  )
  return disposers
}

export default registerRoutes