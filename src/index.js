// dsh-active-sessions — 服务端装配层
//
// 为什么需要这一层：Cordis 插件需要单一入口（package.json main），
// 而功能被拆成 states / approval / overview / rpc 四个模块，便于并行开发与单测。
// 这里只做「组装 + 注册」，不含业务逻辑，业务逻辑全在被 import 的模块里。
//
// 只读原则：本插件不写任何 DSH 会话/配置数据。
// 0 token 原则：不注册任何模型可见工具（inject 里没有 tools/agents）。
import fs from 'node:fs'
import z from '@deepseek-ai/schemastery'
import { scanStates } from './states.js'
import { scanApprovals, buildSessionLogMtimeIndex, defaultSessionsRoot } from './approval.js'
import { scanOverview, buildSummaryPrompt } from './overview.js'
import { registerRoutes, ROUTES, normalizeWorkspaceCwd } from './rpc.js'
import { listAvailableModels, resolveModelRoute } from './models.js'
import { summarizeWorkspace } from './summarize.js'

export const name = 'active-sessions'

/**
 * 诊断串的统一格式（2026-10-07）：[operation] target -> ERROR_CODE: message {contextJson}
 *
 * ⚠️ 与 src/overview.js 的 warnLine、src/states.js 的 describeError **逐字一致**。
 *   三个产出方曾经各写各的（key=value、竖线分隔），而前端 parseWarningLine 只认
 *   这一种形状 → 匹配不上的全部落进「未分组」逐条刷屏（用户实测噪音的根因）。
 *   归一之后前端只认一种形状，且能按 error_code 区分「预期降级」与「真故障」。
 */
function diagLine(operation, target, code, errorOrMessage, context) {
  const raw = errorOrMessage instanceof Error ? errorOrMessage.message : String(errorOrMessage ?? '')
  const message = raw
    .slice(0, 300)
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\{/g, '(')
    .replace(/\}/g, ')')
  const op = String(operation).replace(/\[/g, '(').replace(/\]/g, ')')
  const tgt = String(target).replace(/ -> /g, ' → ')
  const json = context !== null && typeof context === 'object' && !Array.isArray(context) && Object.keys(context).length > 0
    ? ' ' + JSON.stringify(context)
    : ''
  return '[' + op + '] ' + tgt + ' -> ' + String(code) + ': ' + message + json
}

/**
 * 服务依赖。
 * - webServer:  HTTP 端点的**回退**注册入口（无鉴权，见 rpc.js 的说明）
 * - connection: HTTP 端点的**首选**注册入口 —— 它挂在 /api 的鉴权门内
 *   （Host fence + 浏览器 cookie）。实测确认：直接 webServer.register 的 exact 路由
 *   会绕过鉴权（/plugins/events 无 cookie 返回 200），本机 webServer 又监听 0.0.0.0，
 *   等于同网段可直读用户会话标题 —— 故首选 connection。
 *
 * 两个都注入是安全的：web profile 里两者都有提供者
 * （webServer ← dsh-host-webserver；connection ← dsh-client-connection，
 *  经 @deepseek-ai/dsh-web-app bundle 挂载）。
 * rpc.js 仍保留"任一可用即可"的降级，避免其它组合下硬失败。
 *
 * 注意：这里刻意不注入 tools/agents/llm，避免任何模型可见注册面（保持 0 token）。
 */
export const inject = ['webServer', 'connection']

/**
 * 配置 schema（Cordis 约定，必须用 schemastery 的 z.object 构造）。
 *
 * 为什么值得写：没有 schema 时，配置里写错的键（例如把 approvalScanLimit 拼错）
 * 会被**静默忽略**并回落到默认值，用户以为改了却没生效。
 * 有 schema 时 DSH 在加载期就校验并报错，问题在启动期暴露。
 *
 * ⚠️ 格式必须与 dsh-image-relay 等一致：z.object({ key: z.boolean().default(...) })。
 * 曾经误写成普通对象字面量 —— 那会让插件在加载期直接失败。
 */
export const Config = z.object({
  /** false = 完全不加载（不注册任何端点）。 */
  enabled: z.boolean().default(true),
  /** 保留此键以与其它插件一致；本插件本就没有模型可见注册面。 */
  defaultLocked: z.boolean().default(true),
  /** 审批扫描的日志文件数上限（首次加载耗时与之线性相关）。 */
  approvalScanLimit: z.number().default(60),
  /** 客户端轮询间隔（秒）。 */
  refreshSeconds: z.number().default(15),
  /** 工作总览：单个笔记文件大小上限（字节）。 */
  noteMaxBytes: z.number().default(204800),
  /** 单次总结的超时（毫秒）。 */
  summarizeTimeoutMs: z.number().default(120000),
  /**
   * 「运行中」的会话日志新鲜度闸门（毫秒）。默认 15 分钟。
   * 调大 = 更少误报僵尸、更多漏报「单个工具调用跑很久」的会话；改成 0 可关闭该闸门（退回旧行为，不建议）。
   */
  runningFreshMs: z.number().default(15 * 60 * 1000),
  /** 「运行中」的 openStep.startTime 陈旧闸门（毫秒）。默认 2 小时。 */
  runningStaleMs: z.number().default(2 * 60 * 60 * 1000),
  /** 「已完成未查看」是否默认排除已归档会话（用户 2026-10-06 决策：排除）。 */
  excludeArchived: z.boolean().default(true),
  /**
   * 工作总览：最多并发生成几个工作区。
   *
   * 用户 2026-10-07 决策：**6**（此前是 3）。依据：本机实测 21 个工作区、并发 3 时
   * 单次生成要 7 批、约 48 分钟；跳空工作区后目标降到 13 个，6 并发 = 3 批。
   * 硬上限见 index.js 的 MAX_SUMMARIZE_CONCURRENCY（配置写更大值会被夹紧）。
   */
  summarizeConcurrency: z.number().default(6),
  /**
   * 单个工作区生成失败后的**额外重试次数**（用户 2026-10-07 决策：1 次）。
   * 0 = 不重试；只重试失败的那一个工作区，不重复整批。
   */
  summarizeRetryAttempts: z.number().default(1),
  /**
   * 重试前的退避毫秒数。默认 1500（1.5 秒）。
   * ⚠️ 必须可关：设为 0 时不等待，单测（以及「立刻重试一次」的实验）不会被拖慢。
   */
  summarizeRetryBackoffMs: z.number().default(1500),
})

/**
 * 已读水位：key=sessionId, value=epoch ms。
 *
 * **持久化**（用户明确要求）：原来放进程内 Map，重启即丢，
 * 于是重启后「已完成未查看」会把早已看过的会话又列一遍。
 * 现在落到 `$DSH_HOME/active-sessions-seen.json` —— 独立文件，
 * 不碰 DSH 自己的配置/会话（保持"只读 DSH 数据"的边界，
 * 只写自己名下的这一个文件）。
 *
 * 写入策略：**延迟批量**（debounce）。上报是高频交互动作（每次点会话一次），
 * 每次都 fsync 会拖慢点击；这里合并到 1.5 秒后一次写盘，
 * 进程退出前（effect 的 cleanup）再补一次同步写，避免丢最后几次。
 */
const seen = new Map()

/** 持久化文件名（放在 DSH_HOME 根，与插件同名，便于用户识别与删除）。 */
const SEEN_FILE_NAME = 'active-sessions-seen.json'
/** 延迟写盘间隔（毫秒）。 */
const SEEN_FLUSH_DELAY_MS = 1500
/** 防止无限增长：最多保留的会话水位条数（按时间保留最新的）。 */
const SEEN_MAX_ENTRIES = 4000

/** 延迟写盘状态（模块级：一个插件实例一份）。 */
const seenFlush = { timer: null, dirty: false, file: null }

/** 解析 DSH_HOME（与其它模块一致的取法）。 */
function resolveSeenFile() {
  const home = process.env.DSH_HOME || (process.env.HOME ? process.env.HOME + '/.dsh' : null)
  if (home === null) return null
  return home + '/' + SEEN_FILE_NAME
}

/** 从磁盘读回已读水位；文件不存在或损坏都只记 warning 并返回空表。 */
function loadSeenFromDisk(file, warnings) {
  if (file === null) return
  let raw
  try {
    raw = fs.readFileSync(file, 'utf8')
  } catch (error) {
    // ENOENT 是首次运行的正常情况，不记 warning；其它错误要留痕。
    if (error?.code !== 'ENOENT') {
      warnings.push('读取已读水位失败（按空表继续）: ' + String(error?.message ?? error).slice(0, 160))
    }
    return
  }
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch (error) {
    warnings.push('已读水位文件不是合法 JSON（按空表继续，不覆盖原文件以免丢数据）: ' + String(error?.message ?? error).slice(0, 160))
    return
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return
  const entries = parsed.seen !== null && typeof parsed.seen === 'object' ? parsed.seen : parsed
  for (const [id, at] of Object.entries(entries)) {
    if (typeof id === 'string' && Number.isFinite(at)) seen.set(id, at)
  }
}

/** 同步写盘（进程退出/卸载前调用，保证不丢最近的上报）。 */
function flushSeenNow(file) {
  if (file === null || seenFlush.dirty !== true) return
  seenFlush.dirty = false
  if (seenFlush.timer !== null) {
    clearTimeout(seenFlush.timer)
    seenFlush.timer = null
  }
  try {
    // 有界：超过上限时按水位时间保留最新的 N 条（旧的已读记录价值低）。
    let entries = [...seen.entries()]
    if (entries.length > SEEN_MAX_ENTRIES) {
      entries.sort((a, b) => b[1] - a[1])
      entries = entries.slice(0, SEEN_MAX_ENTRIES)
    }
    fs.writeFileSync(file, JSON.stringify({ version: 1, seen: Object.fromEntries(entries) }), { mode: 0o600 })
  } catch (error) {
    console.warn('[active-sessions] 写已读水位失败（不影响本次会话）: ' + String(error?.message ?? error).slice(0, 200))
  }
}

/** 标记需要写盘，并安排一次延迟落盘（合并高频上报）。 */
function scheduleSeenFlush(file) {
  seenFlush.dirty = true
  if (file === null || seenFlush.timer !== null) return
  seenFlush.timer = setTimeout(() => {
    seenFlush.timer = null
    flushSeenNow(file)
  }, SEEN_FLUSH_DELAY_MS)
  // 不让这个定时器拖住进程退出。
  if (typeof seenFlush.timer.unref === 'function') seenFlush.timer.unref()
}

/**
 * 计算笔记集合的指纹，用于判断"是否值得重新调用模型"。
 * 只依赖路径/mtime/大小，不读内容，保证廉价。
 * @param {object} scanned scanOverview({generate:true}) 的结果
 * @returns {string}
 */
function fingerprintOf(scanned) {
  const parts = []
  for (const ws of scanned?.workspaces ?? []) {
    const cwd = typeof ws?.cwd === 'string' ? ws.cwd : ''
    const items = []
    for (const f of ws?.files ?? []) {
      const rel = typeof f?.relPath === 'string' ? f.relPath : ''
      items.push(rel + ':' + Number(f?.mtimeMs ?? 0) + ':' + Number(f?.size ?? 0))
    }
    // 显式排序：文件枚举顺序不保证稳定，不排序会让指纹抖动、缓存永不命中。
    items.sort()
    parts.push(cwd + '|' + items.join(','))
  }
  parts.sort()
  return parts.join(';')
}

/** 工作总览最近一次生成结果缓存（避免重复烧 token）。 */
const overviewCache = { generatedAt: 0, data: null }

/* ===========================================================================
 * 问题四：工作总览结果的**落盘**（刷新/重启不丢）
 *
 * 为什么必须落盘：generateCache / overviewCache 都是进程内内存，实测用户刷新页面
 * 或 DSH 重启后总结全部消失，只能重新点一次「立即生成」——而那意味着再烧一遍 token
 * （21 个工作区，最坏 42 分钟）。落盘文件与既有 active-sessions-seen.json
 * 同目录、同风格（{version, ...}，mode 0600），不碰 DSH 自己的任何配置/会话数据。
 *
 * 落盘内容必须带**指纹**：只有笔记集合变了才值得重新调用模型，
 * 否则刷新一次页面就重烧一次。
 * =========================================================================== */
const OVERVIEW_FILE_NAME = 'active-sessions-overview.json'

/** 解析落盘路径；无 DSH_HOME 时返回 null（此时只用内存缓存，不报错）。 */
function resolveOverviewFile() {
  const home = process.env.DSH_HOME || (process.env.HOME ? process.env.HOME + '/.dsh' : null)
  if (home === null) return null
  return home + '/' + OVERVIEW_FILE_NAME
}

/** 开机读回落盘总结。文件缺失/损坏都只记 warning 并按「无总结」继续，不覆盖原文件。 */
function loadOverviewFromDisk(file, warnings) {
  if (file === null) return { summaries: {}, fingerprint: '' }
  let raw
  try {
    raw = fs.readFileSync(file, 'utf8')
  } catch (error) {
    // ENOENT 是首次运行的正常情况，不记 warning。
    if (error?.code !== 'ENOENT') {
      warnings.push(diagLine('读取工作总览落盘', file, String(error?.code ?? error?.name ?? 'UNKNOWN'), error, { degraded: '本次按「无总结」继续' }))
    }
    return { summaries: {}, fingerprint: '' }
  }
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch (error) {
    warnings.push(diagLine('解析工作总览落盘', file, 'JSON_PARSE_FAILED', error, { hint: '按空总结继续，不覆盖原文件以免丢数据' }))
    return { summaries: {}, fingerprint: '' }
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return { summaries: {}, fingerprint: '' }
  const summaries = {}
  // 外部文件是不可信输入：逐条窄化，非字符串/超长一律丢弃。
  if (parsed.summaries !== null && typeof parsed.summaries === 'object' && !Array.isArray(parsed.summaries)) {
    for (const [cwd, text] of Object.entries(parsed.summaries)) {
      if (typeof cwd !== 'string' || cwd === '' || cwd.length > 4096) continue
      if (typeof text !== 'string' || text.length === 0) continue
      summaries[cwd] = text
    }
  }
  return {
    summaries: summaries,
    fingerprint: typeof parsed.fingerprint === 'string' ? parsed.fingerprint : '',
  }
}

/** 同步写盘（与水位同风格）。写失败只 warn，不影响本次生成结果。 */
function saveOverviewToDisk(file, payload) {
  if (file === null) return false
  try {
    fs.writeFileSync(file, JSON.stringify(payload), { mode: 0o600 })
    return true
  } catch (error) {
    console.warn('[active-sessions] operation=写工作总览落盘 target=' + file + ' error_code=' + String(error?.code ?? error?.name ?? 'UNKNOWN') + ' context=' + JSON.stringify({ message: String(error?.message ?? error).slice(0, 200) }))
    return false
  }
}

/**
 * =========================================================================== */

/* ===========================================================================
 * 工作总览「隐藏工作区」名单（2026-10-07）
 *
 * ⚠️⚠️ 语义边界（用户明确要求，改动前务必读一遍）：
 *   「只从列表移除，但是不能影响到我 dsh 本身的工作区，只是这个插件的工作总览的工作区显示」。
 *   所以这里**不是** DSH 的工作区删除：
 *     - 不写 ~/.dsh/storages/workspace.json（DSH 的工作区注册表）；
 *     - 不调 DSH 的 workspaces 服务，侧栏与会话记录一律不受影响；
 *     - 不删任何文件、不动任何目录。
 *   唯一的新写入就是下面这一个插件自己名下的文件。
 *
 * 为什么 key 用 **cwd 绝对路径**而不是 workspaceId：
 *   实测本机 21 个工作区里，只有 13 个在 workspace.json 登记（即有 workspaceId），
 *   另外 8 个只来自会话投影的 identity.cwd（见 overview.js 的 discoverWorkspaceRoots）。
 *   按 workspaceId 只能覆盖 13/21，剩下 8 个用户根本藏不掉；
 *   而用户要的是「总览页的显示控制」，按 cwd 才能一视同仁覆盖全部。
 *   代价：cwd 变了就等于换了一个条目。实测工作区路径极稳定，可接受。
 *
 * 落盘结构与既有两个文件同风格：{ version:1, hidden:{ "<cwd>": <epoch ms> } }，mode 0600。
 * =========================================================================== */
const HIDDEN_WORKSPACES_FILE_NAME = 'active-sessions-hidden-workspaces.json'

/**
 * 隐藏名单：cwd -> 隐藏时刻（epoch ms）。与 seen 水位同一套「内存镜像 + 同步落盘」模式。
 * 保留时间戳而不是纯数组：将来若要做「最近隐藏的先恢复」之类排序，不用再改文件格式。
 */
const hiddenWorkspaces = new Map()

/**
 * 名单状态。`corrupt` 是本轮最要紧的一个字段：
 * 落盘文件读不出来时置 true，此后**任何写入都被拒绝**——
 * 因为我们无法知道那份文件里原本有什么，覆盖它就是在毁掉用户的数据。
 * 此时 GET 照常按「空名单」工作（其余功能不受阻），只有切换端点会明确报错。
 */
const hiddenState = { corrupt: false, corruptReason: '' }

/** 解析落盘路径；无 DSH_HOME 时返回 null（此时只用内存名单，不报错）。 */
function resolveHiddenWorkspacesFile() {
  const home = process.env.DSH_HOME || (process.env.HOME ? process.env.HOME + '/.dsh' : null)
  if (home === null) return null
  return home + '/' + HIDDEN_WORKSPACES_FILE_NAME
}

/**
 * 开机读回隐藏名单。缺失/损坏的处理刻意不同：
 *   缺失（ENOENT）→ 首次运行的正常态，静默按空名单继续；
 *   损坏        → 记 warning + 置 corrupt，**按空名单继续，但此后禁止写回**。
 * 为什么损坏时仍然继续而不是整个功能不可用：隐藏只是显示控制，
 * 它坏了不该让整个工作总览页打不开（那会连带影响用户真正在用的功能）。
 */
function loadHiddenWorkspacesFromDisk(file, warnings) {
  hiddenState.corrupt = false
  hiddenState.corruptReason = ''
  hiddenWorkspaces.clear()
  if (file === null) return
  let raw
  try {
    raw = fs.readFileSync(file, 'utf8')
  } catch (error) {
    if (error?.code !== 'ENOENT') {
      warnings.push(diagLine('读取隐藏名单', file, String(error?.code ?? error?.name ?? 'UNKNOWN'), error, { degraded: '按空名单继续' }))
    }
    return
  }
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch (error) {
    hiddenState.corrupt = true
    hiddenState.corruptReason = String(error?.message ?? error).slice(0, 160)
    warnings.push(diagLine('解析隐藏名单', file, 'JSON_PARSE_FAILED', error, { hint: '按空名单继续，且不覆盖原文件以免丢数据' }))
    return
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    hiddenState.corrupt = true
    hiddenState.corruptReason = 'top-level value is not an object'
    warnings.push(diagLine('解析隐藏名单', file, 'SHAPE_UNEXPECTED', new Error('顶层不是对象'), { hint: '按空名单继续，且不覆盖原文件' }))
    return
  }
  // 外部文件不可信：逐条窄化，非法条目丢弃而不是整份作废。
  const hidden = parsed.hidden !== null && typeof parsed.hidden === 'object' && !Array.isArray(parsed.hidden)
    ? parsed.hidden
    : {}
  let dropped = 0
  for (const [cwd, at] of Object.entries(hidden)) {
    const key = normalizeWorkspaceCwd(cwd)
    if (key === null || !Number.isFinite(at)) { dropped += 1; continue }
    hiddenWorkspaces.set(key, Number(at))
  }
  if (dropped > 0) {
    warnings.push(diagLine('窄化隐藏名单', file, 'ENTRIES_DROPPED', new Error(dropped + ' 条非法条目已丢弃'), { dropped: dropped, kept: hiddenWorkspaces.size }))
  }
}

/**
 * 同步写盘（与水位/总览同风格）。
 * corrupt 时**直接拒绝写入并返回 false**——不覆盖一份我们读不懂的文件。
 */
function saveHiddenWorkspacesToDisk(file) {
  if (file === null) return false
  if (hiddenState.corrupt === true) return false
  try {
    const entries = [...hiddenWorkspaces.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    fs.writeFileSync(file, JSON.stringify({ version: 1, hidden: Object.fromEntries(entries) }), { mode: 0o600 })
    return true
  } catch (error) {
    console.warn('[active-sessions] operation=写隐藏名单 target=' + file + ' error_code=' + String(error?.code ?? error?.name ?? 'UNKNOWN') + ' context=' + JSON.stringify({ message: String(error?.message ?? error).slice(0, 200) }))
    return false
  }
}

/**
 * 有界并发 map（问题四：工作区间并行，最多 N 并发）。
 * 用 allSettled 语义：单个工作区失败只体现在该项的 error 上，不带走整批。
 * 结果按输入顺序返回，便于测试与诊断。
 */
async function mapLimited(items, limit, worker) {
  const results = new Array(items.length)
  let cursor = 0
  const width = Math.max(1, Math.min(limit, items.length))
  const runners = new Array(width).fill(null).map(async () => {
    for (;;) {
      const index = cursor
      cursor += 1
      if (index >= items.length) return
      try {
        results[index] = { ok: true, value: await worker(items[index], index) }
      } catch (error) {
        results[index] = { ok: false, error: error }
      }
    }
  })
  await Promise.all(runners)
  return results
}

/* ===========================================================================
 * 并发硬上限
 * ===========================================================================
 * 此前写死 8（与「用户 2026-10-06 决策：3」配套的上限）。2026-10-07 提到 12，依据：
 *
 *   1. 默认值 6 是它的一半 —— 硬上限必须**明显高于**默认值才有意义，
 *      否则「配置写大一点」这条唯一的用途直接失效（写 7 就等于写 6）。2x 是最小可用余量。
 *   2. 本机实测规模：跳空工作区后 13 个目标（全量工作区 21 个）。
 *      上限 12 时 13 个目标只需 2 批；再放宽到 16 以上换不来批次数的收益
 *      （13 到 12 这一跳就已经是 2 批），却要继续线性抬高对上游的并发压力。
 *   3. 上游现实约束：并发超过 8~12 时 429/过载概率显著上升，而限流失败
 *      恰好是本次新增的「可恢复错误」—— 会触发重试，把总调用数和总时长都放大。
 *      也就是说：并发再往上，收益递减而失败率上升，属于负收益区。
 *   4. 内存/连接：每条并发都是一条独立的 LLM 流 + 一份大 prompt
 *      （实测单工作区最大 28410 字符）。12 条同时在飞是可控的量级，
 *      再高就有把 DSH 进程推进内存压力的风险。
 *
 * => 取 12。配置里写更大的值会被**夹紧**到 12，而不是无限放开（见 resolved 的 Math.min）。
 * =========================================================================== */
export const MAX_SUMMARIZE_CONCURRENCY = 12

/** 重试次数的夹紧区间（0 = 不重试；3 是有意义的封顶，再多是自伤）。 */
const MAX_SUMMARIZE_RETRY_ATTEMPTS = 3
/** 退避时长的夹紧区间：0（单测/不等待）~ 10 秒。 */
const MAX_SUMMARIZE_RETRY_BACKOFF_MS = 10_000

/**
 * 数值夹紧。undefined / NaN / 非数值 → fallback；其余夹进 [min, max]。
 *
 * 为什么不能用 `Number(x) || fallback`：0 是**合法输入**（重试次数 0 = 不重试，
 * 退避 0 = 不等待），`||` 会把 0 当成「没配」而悄悄改回默认值 —— 单测里最难查的一类 bug。
 */
function clampNumber(value, min, max, fallback) {
  const n = Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.max(min, Math.min(max, n))
}

/**
 * 默认退避用的 sleep。**刻意不 unref**。
 *
 * ⚠️ 这里踩过一个真实的坑（2026-10-07 自测当场抓到）：unref 过的定时器**不计入**
 *   事件循环存活判定。一旦事件循环里只剩这个退避定时器（比如所有工作区的 mock 流
 *   都已结束、只剩几个待重试的），Node 会直接退出进程，于是调用方的 await 永远
 *   落不了地 —— 表现为「请求卡住 / unsettled top-level await」。
 *   退避本来就只在一次生成请求的在途期间等待（上限 10 秒），拖着循环是应该的。
 *
 * 可注入替换：单测传 summarizeRetryBackoffMs: 0 即可完全不走这里。
 */
function defaultSleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms)
  })
}

/* --------------------------------------------------------------------------
 * 重试的可恢复性判定表（2026-10-07）
 *
 * 判据只有一条：**换一个时间点再打一次，有没有可能变成成功？**
 *   会  → 重试（省掉一次用户手动重来的完整生成）
 *   不会 → 不重试（重试只是把同一个确定性失败再付一遍钱）
 *
 * ⚠️ 判定顺序是刻意的：先查不可恢复表，再查可恢复表。
 *    因为码会互相撞（例如 'AbortError' 既可能来自用户切走页面，
 *    也可能来自上游 5xx），**显式的不可恢复表优先**才是安全的默认。
 * -------------------------------------------------------------------------- */

/** 明确「重试也没用」的码：同一个输入必然得到同一个结果。 */
const NON_RETRYABLE_CODES = new Set([
  // 超时：单工作区 120s 超时是「内容太大 / 模型太慢」，重试只会**再等 120s 还失败**，
  // 把最坏总时长直接翻倍。任务书明确要求 TIMEOUT 不重试。
  'TIMOUT',
  // 用户主动取消（外部 AbortSignal）—— 再打一次违背用户意图。
  // ABORTERROR 也在这张表里：能走到这一层的 AbortError 已经不是 summarize.js 自己
  // 的超时（那已被映射成 TIMEOUT），而是上游/用户侧的中断，重试没有意义。
  'ABORTED', 'ABORTERROR', 'CANCELED', 'CANCELLED', 'USER_ABORTED',
  // 路由/服务配置问题：确定性。
  'INVALID_ROUTE', 'MODEL_NOT_FOUND', 'NOT_FOUND', 'LLM_UNAVAILABLE',
  // 鉴权/配额/计费：确定性，且重试可能触发风控。
  'AUTH', 'UNAUTHORIZED', 'FORBIDDEN', 'INVALID_API_KEY', 'PERMISSION_DENIED',
  'QUOTA_EXCEEDED', 'INSUFFICIENT_QUOTA', 'BILLING', 'PAYMENT_REQUIRED',
  // 内容本身装不下：prompt 太大是**我们**的问题，重试解决不了。
  'CONTEXT_LENGTH_EXCEEDED', 'PROMPT_TOO_LONG', 'MAX_TOKENS_EXCEEDED',
  // 参数非法：确定性。
  'INVALID_REQUEST', 'INVALID_ARGUMENT', 'BAD_REQUEST',
])

/** 明确「值得再试一次」的码（限流 / 过载 / 上游瞬时故障 / 空响应）。 */
const RETRYABLE_CODES = new Set([
  // 空响应是典型的**上游瞬时故障**（流被掐断、适配器返回了空块），重试有意义。
  'EMPTY_OUTPUT', 'EMPTY_RESPONSE', 'STREAM_INTERRUPTED', 'PREMATURE_CLOSE',
])

/** 传输层错误码（Node errno / undici）。这些几乎总是「连接被复用坏了」而非「请求本身不对」。 */
const RETRYABLE_ERRNO = new Set([
  'ECONNRESET', 'ECONNREFUSED', 'ECONNABORTED', 'EPIPE', 'ETIMEDOUT', 'EPROTO',
  'EHOSTUNREACH', 'ENETUNREACH', 'ENETDOWN', 'ENETRESET',
  'EAI_AGAIN', 'ENOTFOUND',
  'UND_ERR_SOCKET', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT',
  'ERR_SOCKET_TIMEOUT', 'ERR_STREAM_PREMATURE_CLOSE', 'ERR_HTTP2_STREAM_ERROR',
])

/** 字符串形态的可恢复码（不同供应商命名不一，只能按形态匹配；先过不可恢复表）。 */
const RETRYABLE_CODE_PATTERNS = [
  /^429$/,               // 限流（纯数字形态最常见的一种）
  /^5[0-9]{2}$/,         // 5xx 服务端错误
  /RATE_LIMIT/i, /TOO_MANY_REQUESTS/i, /QUOTA_RATE/i,
  /OVERLOAD/i, /CAPACITY/i,
  /INTERNAL_ERROR/i, /SERVER_ERROR/i, /SERVICE_UNAVAILABLE/i,
  /BAD_GATEWAY/i, /GATEWAY_TIMEOUT/i,
]

/**
 * 判断一次生成失败是否值得重试。纯函数，无副作用、无 IO —— 可直接单测。
 * @param {any} error summarize.js 抛出的错误（带 errorCode）
 * @returns {boolean}
 */
export function isRetryableSummarizeError(error) {
  const code = String(error?.errorCode ?? error?.code ?? error?.name ?? '').trim().toUpperCase()
  if (code === '') return false
  if (NON_RETRYABLE_CODES.has(code)) return false
  if (RETRYABLE_CODES.has(code)) return true
  if (RETRYABLE_ERRNO.has(code)) return true
  return RETRYABLE_CODE_PATTERNS.some((re) => re.test(code))
}

/**
 * 调用模型生成一个工作区的总结，失败时最多重试 attempts-1 次。
 *
 * 关键约束（任务书 §4）：
 *   - **只重试失败的那一个**工作区（它就是这里的调用者），绝不重复整批；
 *   - 退避可注入/可关闭（backoffMs=0 时完全不等待，单测零成本）；
 *   - 超时不重试（见 NON_RETRYABLE_CODES 里的 TIMEOUT）；
 *   - 失败时把 attempt 挂在 error 上，供调用方在告警里如实说明「重试过没有」。
 *
 * @returns {Promise<{text:string, attempts:number}>}
 */
async function summarizeWithRetry(ctx, input) {
  const maxAttempts = Math.max(1, Math.floor(Number(input.attempts) || 1))
  const backoffMs = Math.max(0, Number(input.backoffMs) || 0)
  const sleep = typeof input.sleep === 'function' ? input.sleep : defaultSleep
  let attempt = 1
  let lastError = null
  for (;;) {
    try {
      const out = await summarizeWorkspace(ctx, {
        prompt: input.prompt,
        workspace: input.workspace,
        route: input.route,
        timeoutMs: input.timeoutMs,
      })
      return { text: out.text, attempts: attempt }
    } catch (error) {
      lastError = error
      const isLast = attempt >= maxAttempts
      if (isLast || !isRetryableSummarizeError(error)) break
      // 短暂退避：立刻重打往往正撞在同一个限流窗口里。
      if (backoffMs > 0) await sleep(backoffMs)
      attempt += 1
    }
  }
  // 附上尝试信息：调用方要把它写进告警，用户才能区分「瞬时抖动」与「稳定失败」。
  lastError.attempt = attempt
  lastError.retried = attempt > 1
  throw lastError
}

/**
 * 工作区的结构化「有没有笔记」判定 —— 刻意用 files 的**长度**这个事实，
 * 而不是 prompt 的字符数：空工作区的 prompt 仍有约 270 字符（表头 + 任务说明），
 * 按长度做启发式会误伤真实的短笔记工作区。
 */
function noteFileCountOf(ws) {
  if (Array.isArray(ws?.files)) return ws.files.length
  if (Number.isFinite(ws?.fileCount)) return Number(ws.fileCount)
  return 0
}

/**
 * 生成结果的去重缓存。
 *
 * 为什么服务端也需要这层（前端已有 changed 检测）：
 *   - 自动模式是定时器，前端若因任何 bug 反复调用，会**重复烧真实 token**；
 *   - 多标签页同时打开工作总览时，各自独立触发；
 *   - 服务端是唯一的一致性点，防护放这里才可靠。
 * key = 模型路由 + 笔记指纹；命中即直接返回上次结果。
 */
const generateCache = new Map()
/** 单飞锁：同一时刻只允许一个生成在跑，其余请求等待它（避免并发重复烧）。 */
let inflight = null

export function apply(ctx, config = {}) {
  const resolved = {
    enabled: config.enabled !== false,
    defaultLocked: config.defaultLocked !== false,
    approvalScanLimit: Number(config.approvalScanLimit ?? 60),
    refreshSeconds: Number(config.refreshSeconds ?? 15),
    noteMaxBytes: Number(config.noteMaxBytes ?? 200 * 1024),
    /** 单次总结的超时（毫秒）。交互式操作超时应让用户重试而非干等。 */
    summarizeTimeoutMs: Number(config.summarizeTimeoutMs ?? 120_000),
    /** 见 Config.runningFreshMs 的注释（2026-10-06 实测定案：15 分钟）。 */
    runningFreshMs: Number(config.runningFreshMs ?? 15 * 60_000),
    /** 见 Config.runningStaleMs 的注释（用户拍板：2 小时）。 */
    runningStaleMs: Number(config.runningStaleMs ?? 2 * 60 * 60_000),
    /** 已归档会话默认不进 unseen —— 2026-10-06 修掉的真实缺陷：
     *  workspace.json 里 archivedSessionIds 被 loadWorkspaceMeta 构造出来，却因为
     *  这里没传 excludeArchived 而**从未被使用**，于是 349 个已归档会话全落进 unseen。 */
    excludeArchived: config.excludeArchived !== false,
    /** 工作区并发生成上限（用户 2026-10-07 决策：默认 6，硬上限 12 —— 见上方依据）。 */
    // ⚠️ 配置写 999 会被**夹紧**到硬上限，而不是无限放开：
    //   12 条 LLM 流同时在飞已经是可控量级，再高会把 DSH 进程推进内存压力区。
    // 注意取值语义：0 是**合法值**（重试次数=0 表示不重试），不能用 `|| fallback` 判定，
    // 否则配置写 0 会被悄悄改回默认值。clampNumber 用 Number.isFinite 判「配没配」。
    summarizeConcurrency: clampNumber(config.summarizeConcurrency, 1, MAX_SUMMARIZE_CONCURRENCY, 6),
    /** 单个工作区失败后的额外重试次数（用户 2026-10-07 决策：1）。0 = 不重试。 */
    summarizeRetryAttempts: Math.round(clampNumber(config.summarizeRetryAttempts, 0, MAX_SUMMARIZE_RETRY_ATTEMPTS, 1)),
    /** 重试前的退避（毫秒）。0 = 立刻重试（单测用这个值，整套测试零等待）。 */
    summarizeRetryBackoffMs: Math.round(clampNumber(config.summarizeRetryBackoffMs, 0, MAX_SUMMARIZE_RETRY_BACKOFF_MS, 1500)),
  }

  if (!resolved.enabled) {
    ctx.logger?.info?.('[active-sessions] disabled by config')
    return
  }

  // ── 已读水位：开机读回，变更延迟落盘，卸载前补写 ──────────────────────
  // 为什么必须持久化：原实现放进程内 Map，重启即丢 —— 于是重启后
  // 「已完成未查看」会把早就看过的会话重新列一遍（用户明确要求修复）。
  const loadWarnings = []
  const seenFile = resolveSeenFile()
  seenFlush.file = seenFile
  loadSeenFromDisk(seenFile, loadWarnings)
  for (const w of loadWarnings) ctx.logger?.warn?.('[active-sessions] ' + w)
  ctx.logger?.info?.(
    '[active-sessions] 已读水位: ' + (seenFile === null ? '无 DSH_HOME，仅进程内' : seenFile)
      + ' | 已载入 ' + seen.size + ' 条',
  )
  // ── 工作总览落盘：开机读回（问题四：刷新/重启不丢）────────────────────
  // 为什么与已读水位同等对待：两者都是「用户已经付出过成本（点过会话 / 烧过 token）
  // 的状态」，放内存就等于让用户每次重启都要重来一遍。
  const overviewLoadWarnings = []
  const overviewFile = resolveOverviewFile()
  /** @type {{summaries: Record<string,string>, fingerprint: string}} 落盘文件的进程内镜像 */
  const persisted = loadOverviewFromDisk(overviewFile, overviewLoadWarnings)
  for (const w of overviewLoadWarnings) ctx.logger?.warn?.('[active-sessions] ' + w)
  // ── 隐藏工作区名单：开机读回（2026-10-07）──────────────────────────────
  // 与前两者同等对待：这是用户主动做过的选择，重启后必须还在。
  // 损坏时按空名单继续并禁止写回（见 hiddenState.corrupt 的注释）。
  const hiddenLoadWarnings = []
  const hiddenFile = resolveHiddenWorkspacesFile()
  loadHiddenWorkspacesFromDisk(hiddenFile, hiddenLoadWarnings)
  for (const w of hiddenLoadWarnings) ctx.logger?.warn?.('[active-sessions] ' + w)
  ctx.logger?.info?.(
    '[active-sessions] 隐藏名单: ' + (hiddenFile === null ? '无 DSH_HOME，仅进程内' : hiddenFile)
      + ' | 已载入 ' + String(hiddenWorkspaces.size) + ' 条'
      + (hiddenState.corrupt === true ? ' | 状态=损坏(禁止写回)' : ''),
  )
  ctx.logger?.info?.(
    '[active-sessions] 工作总览落盘: ' + (overviewFile === null ? '无 DSH_HOME，仅进程内' : overviewFile)
      + ' | 已载入 ' + String(Object.keys(persisted.summaries).length) + ' 条工作区总结',
  )
  // 卸载时把最后几次上报落盘（延迟写盘可能还没触发）。
  // 注意：这里用同步写，保证在进程退出前完成。
  if (typeof ctx.effect === 'function') {
    ctx.effect(() => () => {
      flushSeenNow(seenFile)
    }, 'dsh-active-sessions: flush seen watermark')
  }

  /**
   * 实际生成实现（由 deps.generateSummaries 的单飞锁调用）。
   * 单独提出来是为了让锁的 try/finally 结构清晰，业务逻辑不嵌在锁里。
   * @param {{provider:string, model:string}} route 已解析的模型路由
   * @param {{models:Array, warnings:Array}} catalog 模型目录（含其 warnings）
   * @returns {Promise<{summaries:object, warnings:string[], model:object, cached?:boolean}>}
   */
  async function runGeneration(route, catalog) {
    // 注意：本函数依赖闭包里的 resolved/overviewCache/generateCache/summarizeWorkspace。
    const scanned = await scanOverview({
      generate: true,
      maxBytes: resolved.noteMaxBytes,
      // 生成路径同样吃隐藏名单：藏起来的工作区不该继续占并发槽位、烧 token。
      hiddenCwds: hiddenWorkspaces,
    })

    // 指纹缓存：笔记没变就复用上次结果，不重复调用模型。
    const fingerprint = fingerprintOf(scanned)
    const cacheKey = route.provider + '/' + route.model + '\u0000' + fingerprint
    const cached = generateCache.get(cacheKey)
    if (cached !== undefined) {
      return {
        summaries: cached.summaries,
        // NOTE_CACHE_REUSED 是**预期行为**（笔记没变就不该烧 token），
        // 前端按 code 归入「说明性提示」折叠区，不常驻打扰。
        warnings: [
          ...(scanned.warnings ?? []),
          // ⚠️ target 用 provider/model 而不是 cacheKey：cacheKey 里塞着整份文件指纹
          // （实测能到 8KB+），它会整条进折叠块的 title，把提示撑成一面墙。
          // 指纹本身对用户没有可读性，需要时从 context 里的 fingerprint 取。
          diagLine('复用上次生成', route.provider + '/' + route.model, 'NOTE_CACHE_REUSED',
            new Error('笔记未变化，复用上次生成的总结（未重复调用模型）'),
            { fingerprintLength: fingerprint.length }),
        ],
        model: route,
        cached: true,
      }
    }

    // 问题四：进程重启后 generateCache 是空的，但**落盘文件里的指纹**还在。
    // 指纹一致就直接复用落盘总结，一个 token 都不烧 —— 这正是「刷新即丢」的正解。
    if (persisted.fingerprint !== '' && persisted.fingerprint === fingerprint && Object.keys(persisted.summaries).length > 0) {
      overviewCache.generatedAt = Date.now()
      overviewCache.data = persisted.summaries
      generateCache.set(cacheKey, { summaries: persisted.summaries, at: Date.now() })
      return {
        summaries: persisted.summaries,
        warnings: [
          ...(scanned.warnings ?? []),
          diagLine('复用落盘结果', '$DSH_HOME/' + OVERVIEW_FILE_NAME, 'NOTE_PERSISTED_REUSED',
            new Error('笔记指纹与落盘结果一致，复用已落盘的总结（未调用模型）'),
            { provider: route.provider, model: route.model }),
        ],
        model: route,
        cached: true,
      }
    }

    const summaries = {}
    const warnings = [...(catalog.warnings ?? []), ...(scanned.warnings ?? [])]
    // 逐工作区失败要**指名道姓**：旧实现只 push error.message，界面上只有一条笼统 warning，
    // 用户根本看不出 21 个工作区里是哪几个没生成。这里按 rpc.js 的诊断格式拼：
    // operation=生成总结 target=<cwd> error_code=<code> —— 界面摘要能直接显示 target。
    const allWorkspaces = Array.isArray(scanned.workspaces) ? scanned.workspaces : []

    // ── 跳过空工作区（2026-10-07，用户决策 2）────────────────────────────────
    // 实测依据：本机 21 个工作区里 **8 个是 0 文件**。旧过滤只判 prompt.length > 0，
    // 而空工作区的 prompt 仍有约 270 字符（表头 + 任务说明 + 「无可读摘录」）
    // → 照样发起一次完整模型调用，模型只能回「摘录不足以判断」，8 次调用全白烧。
    //
    // 判据刻意用 `files.length === 0` 这个**结构化事实**，不用 prompt 长度做启发式：
    //   真实工作区的 prompt 长度与笔记量强相关（实测 1 个文件 = 1617 字符），
    //   用长度猜早晚会误伤「只有一两篇短笔记」的正经工作区。
    //
    // 空工作区**仍然出现在界面上**（扫描结果 workspaces 原样透传给前端，
    // ui/overview.js 继续渲染「此工作区没有笔记类文件。」），只是不占并发槽位、不烧 token。
    const emptyWorkspaces = allWorkspaces.filter((ws) => noteFileCountOf(ws) === 0)
    const skipWarnings = []
    for (const ws of emptyWorkspaces) {
      skipWarnings.push(
        diagLine('跳过空工作区', String(ws?.cwd ?? ''), 'EMPTY_WORKSPACE_SKIPPED',
          new Error('该工作区没有任何笔记类文件，已跳过模型调用（仍会照常列在界面上）'),
          { workspace: String(ws?.name ?? ws?.cwd ?? ''), totalWorkspaces: allWorkspaces.length }),
      )
    }
    // ⚠️ 放**最前面**（unshift 而不是 push）：当所有工作区都为空时，summaries 会是空的，
    //   前端会显示 NO_SUMMARIES 错误条，而它只截取服务端 warnings 的**前 5 条**。
    //   把「为什么没有总结」放在最前，用户才不会对着一个空错误条猜。
    warnings.unshift(...skipWarnings)
    // 先过滤再交给 mapLimited：并发槽位不浪费在注定不调用的工作区上。
    const targets = allWorkspaces
      .filter((ws) => noteFileCountOf(ws) > 0 && typeof ws?.prompt === 'string' && ws.prompt.length > 0)
      .map((ws) => ({ cwd: String(ws.cwd), prompt: ws.prompt, name: ws.name ?? ws.cwd }))

    // 问题四：工作区之间并行（默认 6 并发，硬上限 12）。实测 21 个工作区串行最坏 42 分钟
    // （每个 120s 超时）—— 用户看到「只有部分工作区出现总结」的直接原因不是失败，
    // 是根本没等到。不设上限则最坏 21 分钟，但会同时开 21 条 LLM 流。
    const outcomes = await mapLimited(targets, resolved.summarizeConcurrency, async (item) => {
      // 只重试**这一个**失败的工作区（重试发生在单个 worker 内部，整批不重跑）。
      const out = await summarizeWithRetry(ctx, {
        prompt: item.prompt,
        workspace: item.name,
        route,
        timeoutMs: resolved.summarizeTimeoutMs,
        attempts: resolved.summarizeRetryAttempts + 1,
        backoffMs: resolved.summarizeRetryBackoffMs,
      })
      return out.text
    })

    outcomes.forEach((outcome, index) => {
      const item = targets[index]
      if (outcome.ok) {
        if (typeof outcome.value === 'string' && outcome.value.length > 0) summaries[item.cwd] = outcome.value
        return
      }
      // 单工作区失败只记 warning：部分成功比整体失败对用户更有用
      const error = outcome.error
      // ⚠️ 必须让用户看得出**这条是不是重试过的**：
      //   界面上默认只显示 message 前 60 字符，attempt 放在 message 开头才看得见；
      //   context 里再放一份结构化字段，供程序/展开区读取。
      const attempt = Number(error?.attempt) >= 1 ? Number(error.attempt) : 1
      const head = attempt > 1 ? ('重试 ' + String(attempt - 1) + ' 次后仍失败') : '首次尝试即失败'
      warnings.push(
        diagLine('生成总结', item.cwd,
          String(error?.errorCode ?? error?.code ?? error?.name ?? 'LLM_ERROR'),
          new Error(head + '：' + String(error?.message ?? error).slice(0, 240)),
          {
            workspace: item.name,
            provider: route.provider,
            model: route.model,
            attempt: attempt,
            maxAttempts: resolved.summarizeRetryAttempts + 1,
            retried: attempt > 1,
            retryable: isRetryableSummarizeError(error),
          }),
      )
    })
    if (Object.keys(summaries).length > 0) {
      overviewCache.generatedAt = Date.now()
      overviewCache.data = summaries
      // 只缓存"确实产出内容"的结果：全失败不缓存，否则重试会一直命中空结果。
      generateCache.set(cacheKey, { summaries, at: Date.now() })
      // 缓存无界增长会吃内存：只保留最近 20 条（按插入序淘汰最早的）。
      if (generateCache.size > 20) {
        const oldest = generateCache.keys().next().value
        if (oldest !== undefined) generateCache.delete(oldest)
      }
      // 问题四：落盘。写失败不阻断返回（用户仍能用本次结果），只是下次刷新又要重来。
      const written = saveOverviewToDisk(overviewFile, {
        version: 1,
        updatedAt: overviewCache.generatedAt,
        fingerprint: fingerprint,
        model: route,
        summaries: summaries,
      })
      if (written === true) {
        persisted.summaries = summaries
        persisted.fingerprint = fingerprint
      }
    }
    return { summaries, warnings, model: route }
  }

  // 组装依赖交给 rpc 层注册端点。
  // scanStates 需要的 approvalIds 由 approval 模块产出，此处做编排
  // （业务模块之间不互相 import，避免循环依赖）。
  const deps = {
    config: resolved,
    seen,
    overviewCache,
    async scanStates() {
      const result = await scanApprovals({ limit: resolved.approvalScanLimit })
      // 会话日志 mtime 索引：判「运行中」的必要条件（见 states.js 的 RUNNING_FRESH_MS）。
      // 为什么每轮都重算而不是缓存：实测本机 509 个会话 / 513 个日志文件只要 **19ms**
      //（只 readdir + stat，不解压），比维护缓存失效逻辑简单得多，也不会拿到过期的「活」判定。
      // 绝不能复用 scanApprovals 的结果：它按 limit=60 只扫最近改动的日志，
      // 而僵尸会话恰恰是最旧的，一定落在窗口之外 —— 复用会把僵尸全部漏掉。
      const mtime = buildSessionLogMtimeIndex(defaultSessionsRoot(), result.warnings)
      if (resolved.runningFreshMs <= 0) {
        ctx.logger?.warn?.('[active-sessions] operation=判定运行中 error_code=FRESH_DISABLED target=runningFreshMs context=' + JSON.stringify({ value: resolved.runningFreshMs }))
      }
      return await scanStates({
        approvalIds: result.pending,
        seen: Object.fromEntries(seen),
        // 问题二修掉的真实缺陷：以前从未传过，349 个已归档会话全落进 unseen。
        excludeArchived: resolved.excludeArchived,
        logMtimeIndex: mtime.index,
        logMtimeFreshMs: resolved.runningFreshMs,
        runningStaleMs: resolved.runningStaleMs,
      })
    },
    async scanOverview(options = {}) {
      const scanned = await scanOverview({
        generate: options.generate === true,
        maxBytes: resolved.noteMaxBytes,
        cached: overviewCache.data,
        // 隐藏名单传进去：被隐藏的工作区**不扫描、不显示、不生成总结**（连 token 都不烧）。
        // 口径说明见 overview.js 末尾 counts 的注释。
        hiddenCwds: hiddenWorkspaces,
      })
      // 问题四：GET /overview 也要带上**已落盘**的 summaries —— 否则刷新页面后
      // 前端拿到的是空 summaries，用户以为总结丢了，实际只是服务端内存缓存被清空。
      // 内存缓存优先（它可能比落盘更新），落盘兜底。
      const live = overviewCache.data !== null && typeof overviewCache.data === 'object' ? overviewCache.data : persisted.summaries
      return {
        ...scanned,
        summaries: live,
        summariesUpdatedAt: overviewCache.generatedAt > 0 ? overviewCache.generatedAt : null,
        // 完整隐藏名单：工具栏「已隐藏（N）」与恢复入口由它渲染。
        // 必须回全量而不是只回本页被滤掉的：被隐藏的 cwd 可能已经不是工作区根了，
        // 但用户仍然需要一个能把它恢复回来的入口。
        hiddenList: [...hiddenWorkspaces.keys()].sort(),
        hiddenStateCorrupt: hiddenState.corrupt,
      }
    },
    /**
     * 切换某个工作区的隐藏状态（2026-10-07）。
     *
     * 返回 {ok:true, hiddenList, hiddenWorkspaces} 表示成功；
     * 返回 {ok:false, errorCode, message, hint} 表示**拒绝**（目前只有一种：名单文件损坏）。
     * 用返回值而不是抛异常表达「拒绝」，是为了让 rpc 层能给出 409 与可读文案，
     * 而不是笼统的 500 —— 用户需要知道「去修那个文件」，而不是「插件崩了」。
     *
     * ⚠️ 名单文件损坏时拒绝写入的取舍：
     *   另一种做法是「内存里改了、落盘失败只记 warning」，但那样界面会显示
     *   「已隐藏」而刷新后原样回来 —— 一次静默的谎言。宁可当场报错让用户去处理那个文件。
     */
    setWorkspaceHidden(rawCwd, hidden, at = Date.now()) {
      // 窄化 cwd → 再改名单 → 再落盘，顺序不可颠倒（外部输入必须最先收紧）。
      const cwd = normalizeWorkspaceCwd(rawCwd)
      if (cwd === null) {
        const err = new Error('cwd 不是合法的 POSIX 绝对路径')
        err.errorCode = 'INVALID_WORKSPACE_CWD'
        throw err
      }
      if (hidden !== true && hidden !== false) {
        const err = new Error('hidden 必须是布尔值')
        err.errorCode = 'INVALID_HIDDEN_FLAG'
        throw err
      }
      if (hiddenState.corrupt === true) {
        return {
          ok: false,
          errorCode: 'HIDDEN_LIST_UNREADABLE',
          message: '隐藏名单文件无法解析，为避免覆盖你的原有数据，本次写入已被拒绝。原因：' + hiddenState.corruptReason,
          hint: '请手工检查或删除 ' + String(hiddenFile) + ' 后重试',
        }
      }
      const before = hiddenWorkspaces.size
      if (hidden === true) hiddenWorkspaces.set(cwd, Number.isFinite(at) ? Number(at) : Date.now())
      else hiddenWorkspaces.delete(cwd)
      if (hiddenWorkspaces.size === before && hidden === false) {
        // 取消一个本来就没隐藏的条目：幂等，直接回报当前状态，不必写盘。
        return { ok: true, hiddenList: [...hiddenWorkspaces.keys()].sort(), hiddenWorkspaces: hiddenWorkspaces.size }
      }
      const written = saveHiddenWorkspacesToDisk(hiddenFile)
      if (written === false && hiddenFile !== null) {
        // 写盘失败必须回滚内存态，否则又是一次「界面说成功、磁盘没有」的谎。
        //（corrupt 分支在上面已经提前返回了，走到这里的失败只可能是 IO 错误。）
        if (hidden === true) hiddenWorkspaces.delete(cwd)
        else hiddenWorkspaces.set(cwd, Number.isFinite(at) ? Number(at) : Date.now())
        const err = new Error('隐藏名单写盘失败，已回滚本次变更')
        err.errorCode = 'HIDDEN_LIST_WRITE_FAILED'
        throw err
      }
      return {
        ok: true,
        hiddenList: [...hiddenWorkspaces.keys()].sort(),
        hiddenWorkspaces: hiddenWorkspaces.size,
      }
    },
    buildSummaryPrompt,
    /**
     * 模型目录（模型下拉的数据源）。惰性取 ctx.llm，缺席时返回空列表并附 warning，
     * 让前端降级为「跟随会话默认模型」而不是整页报错。
     */
    async listModels() {
      return await listAvailableModels(ctx)
    },
    /**
     * 生成工作区总结：组装 prompt → 解析模型路由 → 真正调用模型。
     *
     * 这是插件里**唯一**烧 token 的路径，因此：
     *   - 只在用户显式点「立即生成」时进入（GET 端点绝不触发）；
     *   - 结果按 cwd 缓存，避免同一份笔记反复烧；
     *   - 单个工作区失败不影响其他工作区（逐个 try）。
     */
    async generateSummaries(options = {}) {
      const selectedModel = typeof options.model === 'string' ? options.model : ''
      const catalog = await listAvailableModels(ctx)

      // ⚠️ **llm 服务缺席**才短路，不能按「目录为空」短路：
      //   resolveModelRoute 对自描述形式 'provider/model' 的退化分支**不做目录校验**，
      //   目录为空照样解析得出来（models.js 的既有设计，给「目录服务临时不可用」兜底）。
      //   这里若按目录空一刀切，会把「适配器不声明 listModels、但自描述形式仍调得通」
      //   这类合法用法也打死（2026-10-07 端到端自测实测：temp-e2e-overview-persist 的
      //   mock llm 就�� listModels，被一刀切后整条落盘/指纹/并发用例全红）。
      //
      //   而 llm 真缺席时必须在这里拦：否则会一路走到 summarizeWorkspace，
      //   报出 N 条逐工作区的 "llm.stream is not a function" ——用户看到的是
      //   「一堆工作区生成失败」，真实原因只有一个：模型服务不可用。
      if (catalog.llmAvailable !== true) {
        return {
          summaries: {},
          warnings: [
            diagLine('解析模型路由', ROUTES.overviewGenerate, 'LLM_SERVICE_UNAVAILABLE',
              new Error('llm 服务不可用，无法生成总结'),
              {
                selected: selectedModel,
                catalogSize: catalog.models.length,
                llmWarnings: Array.isArray(catalog.warnings) ? catalog.warnings.slice(0, 3) : [],
                hint: '请检查 dsh-llm 服务是否正常；这是服务端问题，不是你的选择问题',
              }),
          ],
        }
      }

      const route = resolveModelRoute(selectedModel, catalog.models)
      if (route === null) {
        // ⚠️ 区分两种失败，界面上要给出**不同的可执行建议**：
        //   MODEL_CATALOG_EMPTY  → 服务在，但没有任何适配器声明模型目录（前端会禁用按钮）；
        //   MODEL_ROUTE_UNRESOLVED → 目录有模型，但前端传来的 id 解析不出路由（前端防线漏了）。
        // 两者都**不调用任何模型**（summaries 为空），一条 token 都不烧。
        const code = catalog.models.length === 0 ? 'MODEL_CATALOG_EMPTY' : 'MODEL_ROUTE_UNRESOLVED'
        return {
          summaries: {},
          warnings: [
            diagLine(
              '解析模型路由',
              ROUTES.overviewGenerate,
              code,
              new Error(
                catalog.models.length === 0
                  ? 'llm 服务不可用：模型目录为空，无法生成总结'
                  : '未解析出模型路由：所选模型不在目录中，且不含可解析的 provider 前缀',
              ),
              {
                selected: selectedModel,
                catalogSize: catalog.models.length,
                hint: catalog.models.length === 0
                  ? '请检查 dsh-llm 服务是否正常；这是服务端问题，不是你的选择问题'
                  : '请在页面的模型下拉里选择一个具体模型后重试',
              },
            ),
          ],
        }
      }
      // 并发单飞：已有生成在跑就复用它的结果，绝不并发烧两份 token。
      // （自动模式定时器 + 多标签页都可能同时触发。）
      if (inflight !== null) {
        return await inflight
      }
      // try/finally 保证锁一定释放：否则任一次异常都会把插件永久锁死，
      // 之后所有生成请求都挂在别人的旧 Promise 上，表现为"永远没反应"。
      inflight = runGeneration(route, catalog)
      try {
        return await inflight
      } finally {
        inflight = null
      }
    },
    /**
     * 标记已读。为什么放服务端：多标签页时会话可能被别的标签标记，
     * 单一进程内 Map 是天然的一致性点。
     */
    markSeen(sessionId, at = Date.now()) {
      if (typeof sessionId !== 'string' || sessionId.length === 0) return false
      // 取 max 保证水位只前进（乱序到达的请求不能把已读回退）
      const prev = seen.get(sessionId)
      const next = prev === undefined ? at : Math.max(prev, at)
      // 水位没前进就不必写盘（重复上报很常见）。
      if (prev !== next) {
        seen.set(sessionId, next)
        scheduleSeenFlush(seenFlush.file)
      }
      return true
    },
    /**
     * 批量标记已读（问题二：「全部标记已读」按钮）。
     *
     * 为什么是**批量**而不是逐条 POST：实测 unseen 过滤后仍有 115~484 条，
     * 逐条 POST 意味着同一次点击打出上百个 HTTP 请求（keepalive 也要维持上百次往返），
     * 且中途断连就会留下半清不清的列表。一个请求一次落盘，语义也更接近用户的直觉
     * （"我这一下全清了"）。
     *
     * 与单条 markSeen 共享同一份 seen Map 与同一套延迟落盘，因此**水位语义完全一致**：
     * 取 max、只前进不后退、推进了才写盘。
     */
    markSeenMany(sessionIds, at = Date.now()) {
      if (!Array.isArray(sessionIds)) return 0
      const stamp = Number.isFinite(at) ? Number(at) : Date.now()
      let applied = 0
      for (const raw of sessionIds) {
        if (typeof raw !== 'string' || raw.length === 0 || raw.length > 200) continue
        // 控制字符/路径分隔符一律拒绝：它会进内存 Map 的键，也会被回显。
        if (/[\u0000-\u001f\u007f/\\]/.test(raw)) continue
        const prev = seen.get(raw)
        const next = prev === undefined ? stamp : Math.max(prev, stamp)
        if (prev !== next) {
          seen.set(raw, next)
          applied += 1
        }
      }
      // 整批处理完后只安排**一次**延迟落盘，而不是每条一次。
      if (applied > 0) scheduleSeenFlush(seenFlush.file)
      return applied
    },
  }

  try {
    registerRoutes(ctx, deps)
    ctx.logger?.info?.('[active-sessions] ready locked=' + resolved.defaultLocked + ' refresh=' + resolved.refreshSeconds + 's')
  } catch (error) {
    // 不静默吞错：注册失败必须显式报告，否则客户端只会看到 404 且无从诊断
    ctx.logger?.error?.('[active-sessions] 注册 HTTP 端点失败 | operation=registerRoutes | error_code=' + (error?.name ?? 'Error') + ' | context=' + JSON.stringify({ message: String(error?.message ?? error).slice(0, 300) }))
    throw error
  }
}
