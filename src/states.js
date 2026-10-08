/**
 * states.js — dsh-active-sessions 服务端核心逻辑（三态扫描 + 相关会话 IDF 聚类）
 *
 * 硬约束：只读、0 token。本模块不注册任何模型可见工具，也不写任何 DSH 数据。
 * 事实来源：tasks/dsh-active-sessions-plugin/CONTRACT.md 第 3 节（冻结契约，不得自行改接口）。
 *
 * 为什么把"读投影 + 判态 + 聚类"放在同一个纯函数模块里：
 *   RPC 端点与自测脚本都要用同一份判定逻辑，逻辑一旦分叉，
 *   "面板计数"与"验证脚本计数"就会不一致（验收标准第 2 条），所以判定只此一处。
 *
 * ⚠️ 2026-10-06 重建说明：本次重构末尾，一次 python 行切片误操作把本文件截断成 18 行
 *    （事故留底：/mnt/<drive>/.../workspace/temp/20261006-states-truncated-incident.js）。
 *    已按「已安装的旧版 + 本次改动」逐段重建；重建后所有既有自测复跑结果与改动前一致。
 */

import { readFile, readdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'
// 2026-10-06：引入会话日志 mtime 索引的构造器（见 classifyRunning 的闸门 0）。
// 循环依赖检查：approval.js 只 import node 内置模块，不 import 本文件，故无环。
// 为什么由本模块自己兜底构造、而不是强制调用方传：
//   - states.js 是「判态」的唯一事实来源，让它依赖调用方记得传一个可选参数，
//     等于把正确性外包给了调用方 —— 实测 temp-a-test 里的 scanStates({concurrency:9999})
//     就因为没传而在真实数据上返回 0 条；
//   - 索引成本实测 509 会话 / 20ms，且**可缓存**，所以自带兜底几乎没有代价。
import { buildSessionLogMtimeIndex, defaultSessionsRoot } from './approval.js'

/** 并发读取上限：契约要求 ≤5。一次性打开 450 个句柄在低配置机器上会 EMFILE。 */
const MAX_CONCURRENCY = 5
/** IDF 过滤阈值：全库出现 ">= 该次数" 的词视为通用词丢弃（契约 3.3.3 是 >=5）。 */
const IDF_DROP_DF = 5
/** 判定"相关"所需的最少共同词数（契约 3.3.6）。 */
const MIN_SHARED_TOKENS = 2
/** 标题切分：非 数字/字母/汉字 即分隔符。与 validate-states.py 保持逐字一致。 */
const TITLE_SPLIT = /[^0-9A-Za-z\u4e00-\u9fff]+/
/** 词元最小长度（契约 3.3.2）。 */
const MIN_TOKEN_LENGTH = 2
/** 三态展示/排序优先级：running > approval > unseen（契约 3.2）。 */
const STATE_ORDER = { running: 0, approval: 1, unseen: 2 }

/**
 * 「运行中」的**会话日志新鲜度闸门**（毫秒）：会话日志
 * ~/.dsh/sessions/<工作区扁平名>/<sessionId>/session*.jsonl.zstd 的 mtime
 * 距 now 超过这个值，就认为这个会话**根本没在被进程写过**。
 *
 * 为什么必须有它（2026-10-06 本机实测定案，样本见 tests/temp-e2e-running-gates.mjs）：
 *   - 「整理评论.txt文件内容」openStep 是 null，走的是 pendingCalls 分支，
 *     用户拍板的 turn 闸门与 startTime 闸门**都覆盖不到它**；
 *   - 「你是 DSH Web GUI…」这类崩溃的子代理会话，openStep.turn == lastTurn，
 *     turn 闸门同样拦不住（实测它距崩溃 26 分钟，仍在 2 小时 startTime 窗口内）。
 *   而日志 mtime 对活体会话是**持续刷新**的（实测两条活体都是 0~1 分钟前），
 *   对僵尸是 40~51 天前 —— 判别力极强，且比任何回合推断都便宜（只 stat，不解压）。
 *
 * 取 15 分钟的依据（实测阈值扫描）：5 分钟与 15 分钟得到同一组 running（3 openStep + 2 pending），
 * 30/60/120 分钟会多出 2 条 —— 正是那两条 26 分钟前死掉的子代理。
 * 15 分钟是「不误杀活体」与「不误报僵尸」的分界中点，且远小于 2 小时的 startTime 闸门。
 *
 * 已知代价：单个工具调用本身跑超过 15 分钟且期间不写日志（例如 sleep 20 分钟）时，
 * 该会话会被降级为 unseen，下一轮轮询会恢复。这是可接受的降级（用户抱怨的是**长期误报**），
 * 且比 40 天的僵尸强得多。
 */
export const RUNNING_FRESH_MS = 15 * 60 * 1000

/**
 * 「运行中」的 **openStep.startTime 陈旧闸门**（毫秒，2 小时）。
 *
 * 用户 2026-10-06 拍板的原决策：崩溃残留的开放步骤必然很旧，2 小时以上的直接不算运行中。
 * 它在 RUNNING_FRESH_MS 之后是**冗余的**（新鲜度闸门更严），但保留有两个理由：
 *   1. 语义正确、零成本，且它是用户明确写进决策的判据；
 *   2. 一旦有人把 logMtimeFreshMs 调大（实测扫描需要），startTime 闸门是第二道防线。
 */
export const RUNNING_STALE_MS = 2 * 60 * 60 * 1000

/**
 * 「已完成未查看」在无水位记录时的回看窗口默认值：**有史以来**。
 *
 * ⚠️ 这个取值的实测代价（本机 2026-10-06）：unseen 曾从 48 条增至 495 条。
 * 2026-10-06 用户改判为「客户端默认只显示最近 7 天、可切全部」，
 * 且服务端**继续返回全量**（见 ui/sidebar.js 的 partitionUnseen）——
 * 服务端过滤会让 counts.unseen 与列表长度对不上，制造新的不一致。
 * 因此这里的常数仍为有史以来；收窄发生在客户端，且以 lastPromptAt 为基准。
 *
 * 设为任意毫秒数可恢复服务端时间窗（例如 72h = 72*60*60*1000）；0 = 只认水位记录。
 */
const DEFAULT_UNSEEN_LOOKBACK_MS = Number.POSITIVE_INFINITY

/**
 * @typedef {'running'|'approval'|'unseen'} StateKind
 *
 * @typedef {Object} SessionEntry
 * @property {string} id             'session-xxxx' 或裸 uuid
 * @property {string} title
 * @property {string} cwd            工作区绝对路径
 * @property {string} workspace      cwd 的 basename，用于分组显示
 * @property {StateKind} state
 * @property {number} lastPromptAt   epoch ms，0 = 未知
 * @property {number} steps
 * @property {boolean} isSubagent
 * @property {string} subagentLabel
 * @property {string[]} relationKeys IDF 过滤后的共同关键词
 * @property {string} groupId        相关会话组 id；无关系时 = 自身 id
 *
 * @typedef {Object} StateSnapshot
 * @property {number} generatedAt
 * @property {{running:number, approval:number, unseen:number, total:number}} counts
 * @property {number} workspaces
 * @property {SessionEntry[]} entries
 * @property {string[]} warnings
 */

// ---------------------------------------------------------------------------
// 通用防御工具：外部输入（文件、JSON）一律不可信，取字段前先窄化类型
// ---------------------------------------------------------------------------

/** @returns {boolean} */
function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * 投影行统一是 { ver, seq, val }，取 val 前必须确认整条链路都是对象，
 * 否则 val 可能是 null（projection 未落值）或字符串（格式漂移）。
 * @returns {Record<string, unknown>|null}
 */
function rowValue(row) {
  if (!isPlainObject(row)) return null
  return isPlainObject(row.val) ? row.val : null
}

/**
 * 标量型投影行（如 title.val 是字符串，不是对象）必须走这个访问器。
 * 曾用 rowValue 读 title 导致 454 个会话标题全空、聚类整体失效——投影行的 val
 * 既可能是对象也可能是标量，两者不能共用一个访问器。
 */
function rowScalar(row, fallback = null) {
  if (!isPlainObject(row)) return fallback
  return row.val === undefined ? fallback : row.val
}

/** 安全取字符串，失败回退空串（UI 层依赖不会拿到 undefined）。 */
function asString(value) {
  return typeof value === 'string' ? value : ''
}

/** 安全取有限数字，失败回退 fallback（避免 NaN 污染排序/比较）。 */
function asNumber(value, fallback) {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

/** 数组或 Set 归一化为 Set（approvalIds 由 B 代理以任一形式传入都接受）。 */
function toStringSet(value) {
  if (value instanceof Set) {
    return new Set([...value].filter((v) => typeof v === 'string' && v.length > 0))
  }
  if (Array.isArray(value)) {
    return new Set(value.filter((v) => typeof v === 'string' && v.length > 0))
  }
  return new Set()
}

/**
 * 同一个会话在系统里有两套 id 写法：投影文件名带 session- 前缀，而会话日志目录
 * （approval.js 的扫描结果）给的是裸 uuid。契约也写明 SessionEntry.id 允许
 * "session-xxxx 或裸 uuid"。
 *
 * 实测踩坑：scanApprovals() 返回裸 uuid，而投影 entry 的 id 是带前缀形式，
 * 直接 Set.has 永远不命中 → approval 态在生产里恒为 0（整个第二态失效）。
 * 因此所有按 id 的匹配都必须用候选集，而不是裸字符串比较。
 * @returns {string[]} 该 id 所有可能写法（自身、去前缀、加前缀）
 */
function sessionIdCandidates(id) {
  const text = asString(id)
  if (!text) return []
  const bare = text.replace(/^session-/, '')
  const candidates = new Set([text])
  if (bare) {
    candidates.add(bare)
    candidates.add('session-' + bare)
  }
  return [...candidates]
}

/** 用候选 id 集匹配 approvalIds（两套 id 写法都能命中）。 */
function matchesAnyCandidate(candidates, idSet) {
  for (const candidate of candidates) {
    if (idSet.has(candidate)) return true
  }
  return false
}

/** 用候选 id 集在 seen 水位对象里取值；取不到返回 undefined。 */
function lookupSeenWatermark(seen, candidates) {
  for (const candidate of candidates) {
    if (Object.prototype.hasOwnProperty.call(seen, candidate)) {
      return seen[candidate]
    }
  }
  return undefined
}

/** pendingCalls 契约上是 {callId: ts}，但数组/字符串等其他形状也要能判断"非空"。 */
function hasEntries(value) {
  if (Array.isArray(value)) return value.length > 0
  if (isPlainObject(value)) return Object.keys(value).length > 0
  return false
}

/**
 * pendingCalls 取其**最新**一条的时间戳（毫秒）。契约是 {callId: issuedAt}。
 * 取不到有限数就返回 0（表示"时间未知"），由调用方按保守路径处理。
 */
function newestPendingCallAt(value) {
  if (!isPlainObject(value)) return 0
  let newest = 0
  for (const item of Object.values(value)) {
    const at = asNumber(item, 0)
    if (at > newest) newest = at
  }
  return newest
}

/**
 * 在候选 id 集里查会话日志 mtime 索引。
 * 索引键是**会话目录名原样**（裸 uuid 或 session- 前缀都可能出现），所以必须按候选集查。
 * @returns {number|undefined} 未命中返回 undefined（与 mtime=0 的「命中但极旧」区分开）
 */
function lookupLogMtime(index, candidates) {
  if (index === null || index === undefined) return undefined
  for (const candidate of candidates) {
    if (index instanceof Map) {
      if (index.has(candidate)) return asNumber(index.get(candidate), 0)
      continue
    }
    if (Object.prototype.hasOwnProperty.call(index, candidate)) return asNumber(index[candidate], 0)
  }
  return undefined
}

/**
 * 判定单个会话是不是「运行中」。纯函数，导出以便单测直接覆盖每一条闸门。
 *
 * 最终判据（2026-10-06 实测定案，用户已决策的两条闸门全部保留并叠加新鲜度闸门）：
 *
 *   fresh   = 日志 mtime 存在 且 now - mtime <= freshMs
 *   stepRun = openStep 非空
 *             && openStep.turn <= lastTurn            （闸门1：回合已推进 → 开放步骤是残留）
 *             && now - openStep.startTime <= staleMs  （闸门2：崩溃残留必然很旧）
 *   pendRun = pendingCalls 非空
 *   running = fresh && (stepRun || pendRun)
 *
 * 缺日志时 fresh=false → 不判 running：本机唯一一条这种情况是
 * import-sess_3b4aed87-…（导入的会话，本地没有日志文件），它显然不可能正在跑。
 *
 * ⚠️ 时间全部来自入参 now，函数体内不出现 Date.now() —— 否则单测不可重现。
 *
 * @param {{openStep?:unknown, pendingCallCount?:number, lastTurn?:unknown}} record 投影里的原始信号
 * @param {{now:number, logMtimeMs?:number, freshMs?:number, staleMs?:number}} gate
 * @returns {boolean}
 */
export function classifyRunning(record, gate) {
  const g = isPlainObject(gate) ? gate : {}
  const now = asNumber(g.now, 0)
  const freshMs = asNumber(g.freshMs, RUNNING_FRESH_MS)
  const staleMs = asNumber(g.staleMs, RUNNING_STALE_MS)
  // 闸门 0：日志新鲜度。没有 mtime 的会话一律不判活（fail-closed，避免把僵尸放进来）。
  const mtime = asNumber(g.logMtimeMs, -1)
  if (mtime < 0) return false
  if (now - mtime > freshMs) return false

  const r = isPlainObject(record) ? record : {}
  const openStep = r.openStep
  const hasOpenStep = openStep !== null && openStep !== undefined
  // openStep 实测是对象 {turn, step, startTime, firstTokenTime}；但外部输入不可信，
  // 出现标量（例如夹具里的 openStep: 5）时不能直接判死 —— 那会让「有开放步骤」这个
  // 信号被悄悄吞掉。此时 turn/startTime 两道闸门**无从施加**，判据退化为「有就是有」，
  // 而最关键的日志新鲜度闸门（上面那道 fail-closed）已经先过了，僵尸仍被挡在外面。
  const structuredOpenStep = isPlainObject(openStep) ? openStep : null
  const stepRun =
    hasOpenStep &&
    (structuredOpenStep === null ||
      (asNumber(structuredOpenStep.turn, Number.POSITIVE_INFINITY) <= asNumber(r.lastTurn, Number.POSITIVE_INFINITY) &&
        // startTime 缺失不等于陈旧：闸门的本意是「若它自称很旧就别信」，不是「没有它就别信」。
        // 实测本机 7 条 openStep 全都带 startTime，但投影格式会漂移（老版本/裁剪过的导出可能没有）；
        // 若把缺失当 0 处理，now - 0 = 1.8e12ms 会把所有缺字段的会话一律判死 —— 那是静默的假阴性。
        // 所以只有「存在且确实是有限数」时才比大小；缺失时交给上面的日志新鲜度闸门裁决。
        (typeof structuredOpenStep.startTime !== 'number' ||
          !Number.isFinite(structuredOpenStep.startTime) ||
          now - structuredOpenStep.startTime <= staleMs)))
  const pendRun = asNumber(r.pendingCallCount, 0) > 0
  return stepRun || pendRun
}

// ---------------------------------------------------------------------------
// 警告串的**规范格式**（2026-10-07，用户实测「左窗底部两条噪音」的根因）
// ---------------------------------------------------------------------------
//
//     [operation] target -> ERROR_CODE: message {contextJson}
//
// ⚠️ 此前本模块产出的是 key=value 形态：
//       [states] operation=… target=… input_summary=… error_code=Error message=… context=…
//   两个问题：
//     1) 客户端 parseWarningLine 的正则只认上面那种 ' -> CODE:' 形态 → **一条都匹配不上**
//        → 全部落进「未分组」分支逐条铺开（用户截图里的那两条）；
//     2) error_code 取的是 `error.code || error.name`，对新建的 Error 一律是 `Error`
//        —— 于是前端**没有稳定的键**去区分「预期降级」与「真故障」。
//   所以这里是**根本修法**：格式与总览页的 warnLine 对齐，并给每条告警一个真实、
//   稳定的 error_code。前端只认 error_code，不再做字符串猜测。
//
// 三处清洗（缺一不可，否则格式会被内容里的符号打穿）：
//   · operation/target 里的 ' -> ' 会被改写成 ' → '：target 是路径，不能与分隔符混淆；
//   · ERROR_CODE 强制成 [A-Za-z0-9_]：客户端按这个字符类切分；
//   · message 里的 '{' '}' 改成 '(' ')'：它后面紧跟 context 的 JSON，转义掉歧义来源。
// ---------------------------------------------------------------------------

/** 单行化 + 去首尾空白（诊断串必须是一行，否则前端 title 与解析都会错位）。 */
function oneLine(value) {
  return String(value === undefined || value === null ? '' : value)
    .replace(/[\r\n\t]+/g, ' ')
    .trim()
}

/** 把任意错误码收敛成 [A-Za-z0-9_]+（非法字符换下划线，空则 UNKNOWN_ERROR）。 */
function sanitizeCode(value) {
  const text = oneLine(value).replace(/[^A-Za-z0-9_]/g, '_')
  return text === '' ? 'UNKNOWN_ERROR' : text
}

/** 花括号转圆括号：message 后面紧跟 context JSON，不能让 message 里的 '{' 抢位置。 */
function sanitizeMessage(value) {
  return oneLine(value).replace(/\{/g, '(').replace(/\}/g, ')')
}

/**
 * 统一的错误描述：禁止静默吞错，警告串必须自带 operation/target/error_code/context，
 * 否则前端只能显示"加载失败"，无法定位是哪个文件坏了。
 *
 * @param {object} input
 * @param {string} input.operation 人类可读的动作名（会进方括号）
 * @param {string} input.target被操作的对象（通常是路径）
 * @param {string} [input.inputSummary] 输入摘要，进 context.input_summary
 * @param {any} input.error原始错误；提供 errorCode 时它只用来取 message
 * @param {object} [input.context] 附加上下文，合并进尾部的 JSON
 * @param {string} [input.errorCode] **真实的**错误码。
 *   必须显式给出：`error.code || error.name` 对新建 Error 一律是 'Error'，
 *   前端需要稳定键来区分「预期降级」与「真故障」。缺省时才回落到原启发式。
 * @returns {string} 规范格式诊断串
 */
function describeError({ operation, target, inputSummary = '', error, context = {}, errorCode }) {
  const rawCode = errorCode !== undefined && errorCode !== null && oneLine(errorCode) !== ''
    ? errorCode
    : (error && (error.code || error.name)) || 'UNKNOWN_ERROR'
  const message = error instanceof Error ? error.message : String(error)
  const op = oneLine(operation).replace(/\[/g, '(').replace(/\]/g, ')')
  const tgt = oneLine(target).replace(/ -> /g, ' → ')
  const merged = {}
  const summary = oneLine(inputSummary)
  if (summary !== '') merged.input_summary = summary
  if (context !== null && typeof context === 'object' && !Array.isArray(context)) {
    for (const key of Object.keys(context)) merged[key] = context[key]
  }
  const json = Object.keys(merged).length > 0 ? ' ' + JSON.stringify(merged) : ''
  return '[' + op + '] ' + tgt + ' -> ' + sanitizeCode(rawCode) + ': ' + sanitizeMessage(message) + json
}

/**
 * cwd 可用性校验：必须是 POSIX 绝对路径（以 "/" 开头）。
 *
 * 为什么不能对 E:\MyData\... 这类 Windows 原始路径做 path.resolve：
 * resolve 会把它当成相对路径，凭空拼出 <cwd>/E:\MyData\... 这样的假工作区。
 * 更糟的是取 basename 会得到 temp，与真实存在的 /mnt/e/.../temp（73 个会话）
 * 撞成同一个分组，把两个无关工作区合并——实测本机就有 2 个会话是这种值。
 * 因此非绝对路径一律判为不可用（保留空 cwd），宁可少分组也不能错分组。
 */
function isUsableCwd(cwd) {
  const text = asString(cwd)
  return text.startsWith('/') && text.length > 1
}

/** 取 cwd 的 basename 作为展示用工作区名；先归一化尾斜杠避免得到空串。 */
function workspaceOf(cwd) {
  const normalized = asString(cwd).replace(/\/+$/, '')
  return normalized ? path.basename(normalized) : ''
}

/**
 * 标题 → 词元集合。小写化与 validate-states.py 的 s.lower() 对齐，
 * 否则 "Run"/"run" 会被算成两个词，df 统计随之失真。
 * @returns {Set<string>}
 */
function titleTokens(title) {
  const text = asString(title)
  const out = new Set()
  if (!text) return out
  for (const piece of text.split(TITLE_SPLIT)) {
    const token = piece.toLowerCase()
    if (token.length >= MIN_TOKEN_LENGTH) out.add(token)
  }
  return out
}

// ---------------------------------------------------------------------------
// 数据源读取
// ---------------------------------------------------------------------------

/** 默认数据根：DSH_HOME 优先（本机 WSL 原生配置指向 ~/.dsh）。 */
function resolveDshHome(options) {
  if (typeof options.dshHome === 'string' && options.dshHome) return options.dshHome
  if (typeof process.env.DSH_HOME === 'string' && process.env.DSH_HOME) return process.env.DSH_HOME
  return path.join(homedir(), '.dsh')
}

/**
 * 会话日志 mtime 索引的进程内短 TTL 缓存。
 *
 * 为什么需要：左窗每 15 秒轮询一次，若每次都重扫 509 个目录（实测 20ms）
 * 就是每秒白烧 1.3ms 的纯 stat；更重要的是**语义**：
 * 15 分钟的新鲜度闸门本来就对「秒级抖动」不敏感，2 秒的缓存不会改变任何判态。
 * 只缓存 2 秒（而不是 15 秒）是为了让「刚启动的会话」下一轮就能被认出来，
 * 不至于因为缓存而延迟显示。
 */
const LOG_INDEX_TTL_MS = 2000
/** @type {Map<string, {index: Map<string, number>, at: number}>} */
const logIndexCache = new Map()

/**
 * 取缓存的索引（Map 本身，不是 buildSessionLogMtimeIndex 的返回记录）。
 * ⚠️ 返回类型必须与未命中路径保持一致 —— 首次实现里这里返回记录、
 * 而 scanStates 里按记录读 .index，于是**缓存命中反而拿到 undefined**，
 * 结果是「第一次调用正常、第二次调用 running 全变 0」。这类 bug 只有复跑才暴露。
 */
function readLogIndexCache(root) {
  const hit = logIndexCache.get(root)
  if (hit === undefined) return null
  if (nowMs() - hit.at > LOG_INDEX_TTL_MS) {
    logIndexCache.delete(root)
    return null
  }
  return hit.index
}

function writeLogIndexCache(root, index) {
  // 有界：防止测试里不断换临时目录导致 Map 无限增长（实测夹具会创建大量临时 root）。
  if (logIndexCache.size > 32) logIndexCache.clear()
  logIndexCache.set(root, { index, at: nowMs() })
}

/** 缓存用的单调时钟源；单独一个函数是为了让「取时间」这一步也可被测试替换。 */
function nowMs() {
  return Date.now()
}

/**
 * 列出投影文件。排序是必须的：readdir 的返回顺序依赖文件系统，
 * 不排序会让"每次刷新条目顺序抖动"，也会让聚类组 id 在两次调用间漂移。
 */
async function listProjectionFiles(sessionsDir, warnings) {
  try {
    const dirents = await readdir(sessionsDir, { withFileTypes: true })
    return dirents
      .filter((d) => (d.isFile() || d.isSymbolicLink()) && d.name.endsWith('.json'))
      .map((d) => path.join(sessionsDir, d.name))
      .sort()
  } catch (error) {
    // 目录整体不可读属于可降级情形：返回空快照 + 警告，比抛异常更利于 UI 存活。
    warnings.push(
      describeError({
        operation: '列目录',
        target: sessionsDir,
        error,
        errorCode: 'SESSIONS_DIR_UNREADABLE',
        context: { source: 'session_projcache/sessions', degraded: '会话列表为空' },
      }),
    )
    return []
  }
}

/**
 * workspace.json：只用于两件契约允许的事——
 *   1) 会话投影缺 cwd 时用 tables.workspaces[*].sessionIds 反查工作区路径补全；
 *   2) 提供 archivedSessionIds（2026-10-06 起由 options.excludeArchived 实际启用）。
 * 整个文件视为不可信：结构漂移时降级为空映射而不是中断扫描。
 */
async function loadWorkspaceMeta(workspaceFile, warnings) {
  const meta = {
    sessionWorkspacePath: new Map(),
    archivedSessionIds: new Set(),
  }
  let raw
  try {
    raw = await readFile(workspaceFile, 'utf8')
  } catch (error) {
    warnings.push(
      describeError({
        operation: '读取工作区元数据',
        target: workspaceFile,
        error,
        errorCode: 'WORKSPACE_META_UNREADABLE',
        context: { degraded: 'cwd 缺失的会话将无法补全工作区' },
      }),
    )
    return meta
  }
  let doc
  try {
    doc = JSON.parse(raw)
  } catch (error) {
    warnings.push(
      describeError({
        operation: '解析工作区元数据 JSON',
        target: workspaceFile,
        inputSummary: raw.length + 'B',
        error,
        errorCode: 'WORKSPACE_META_INVALID_JSON',
        context: { degraded: 'cwd 缺失的会话将无法补全工作区' },
      }),
    )
    return meta
  }
  // global.workspaceIds 只是工作区键名列表，不是路径——真正的工作区路径在
  // tables.workspaces[*].path，两者都不能互相替代（当成路径读会全错）。
  const global = isPlainObject(doc) && isPlainObject(doc.global) ? doc.global : {}
  if (Array.isArray(global.archivedSessionIds)) {
    for (const id of global.archivedSessionIds) {
      if (typeof id === 'string' && id) meta.archivedSessionIds.add(id)
    }
  }
  const tables = isPlainObject(doc) && isPlainObject(doc.tables) ? doc.tables : {}
  const workspaces = isPlainObject(tables.workspaces) ? tables.workspaces : {}
  for (const record of Object.values(workspaces)) {
    if (!isPlainObject(record)) continue
    const workspacePath = asString(record.path)
    if (!isUsableCwd(workspacePath)) continue // 只接受 POSIX 绝对路径，理由同 isUsableCwd
    const sessionIds = Array.isArray(record.sessionIds) ? record.sessionIds : []
    for (const id of sessionIds) {
      if (typeof id === 'string' && id && !meta.sessionWorkspacePath.has(id)) {
        meta.sessionWorkspacePath.set(id, workspacePath)
      }
    }
  }
  return meta
}

/**
 * 解析单个投影文件 → 中间记录。
 * 任何一步失败都只记警告并返回 null：450 个文件里坏 1 个不应该让整个面板空掉。
 * @returns {Promise<null|Object>} 中间记录（含判 running 所需的原始信号）
 */
async function readProjectionFile(filePath, warnings) {
  let raw
  try {
    raw = await readFile(filePath, 'utf8')
  } catch (error) {
    warnings.push(
      describeError({
        operation: '读取会话投影文件',
        target: filePath,
        error,
        errorCode: 'PROJECTION_READ_FAILED',
        context: { degraded: '该会话被跳过' },
      }),
    )
    return null
  }
  let doc
  try {
    doc = JSON.parse(raw)
  } catch (error) {
    warnings.push(
      describeError({
        operation: '解析会话投影 JSON',
        target: filePath,
        inputSummary: raw.length + 'B',
        error,
        errorCode: 'PROJECTION_INVALID_JSON',
        context: { degraded: '该会话被跳过' },
      }),
    )
    return null
  }
  if (!isPlainObject(doc)) {
    warnings.push(
      describeError({
        operation: '校验会话投影结构',
        target: filePath,
        inputSummary: raw.length + 'B',
        error: new TypeError('投影根节点不是对象'),
        errorCode: 'PROJECTION_SHAPE_INVALID',
        context: { version: doc === null ? 'null' : typeof doc, degraded: '该会话被跳过' },
      }),
    )
    return null
  }
  const record = isPlainObject(doc.record) ? doc.record : {}
  const rows = isPlainObject(record.rows) ? record.rows : {}

  const identity = isPlainObject(record.identity) ? record.identity : {}
  const sessionStats = rowValue(rows.sessionStats) || {}
  const sessionListMetadata = rowValue(rows.sessionListMetadata) || {}
  const subagent = rowValue(rows.subagent)
  const subagentIdentity =
    subagent && isPlainObject(subagent.identity) ? subagent.identity : null

  // ⚠️ 这里**不再**判 running：判定需要 now（可注入）与会话日志 mtime 索引，
  // 二者都只在 scanStates 里可解析。读文件阶段只把原始信号带出去，判定集中在 classifyRunning，
  // 这样「哪条闸门拦住了」只有一处逻辑，单测能逐条覆盖。
  const openStep =
    sessionStats.openStep === null || sessionStats.openStep === undefined
      ? null
      : sessionStats.openStep
  const pendingCalls = sessionStats.pendingCalls
  const pendingCallCount = hasEntries(pendingCalls) ? 1 : 0

  return {
    file: filePath,
    id: path.basename(filePath, '.json'),
    title: asString(rowScalar(rows.title, '')),
    cwd: asString(identity.cwd),
    steps: asNumber(sessionStats.steps, 0),
    lastPromptAt: asNumber(sessionListMetadata.lastPromptAt, 0),
    blank: sessionListMetadata.blank === true,
    isSubagent:
      subagentIdentity !== null &&
      subagentIdentity.mode !== null &&
      subagentIdentity.mode !== undefined,
    subagentLabel: subagentIdentity ? asString(subagentIdentity.label) : '',
    openStep,
    pendingCallCount,
    // pendingCalls 最新时间戳留作诊断/未来的第二判据（本次未参与判定，但要可观测）。
    newestPendingCallAt: newestPendingCallAt(pendingCalls),
    lastTurn: sessionStats.lastTurn === undefined ? null : sessionStats.lastTurn,
  }
}

/** 分批 + Promise.allSettled：并发严格 ≤ limit，且单文件失败不会中断整批。 */
async function readAllProjections(files, concurrency, warnings) {
  const records = []
  for (let start = 0; start < files.length; start += concurrency) {
    const batch = files.slice(start, start + concurrency)
    const settled = await Promise.allSettled(batch.map((file) => readProjectionFile(file, warnings)))
    settled.forEach((outcome, index) => {
      if (outcome.status === 'fulfilled') {
        if (outcome.value) records.push(outcome.value)
        return
      }
      // readProjectionFile 内部已捕获，这里是兜底，防止未预期的同步抛出被吞掉。
      warnings.push(
        describeError({
          operation: '并发读取会话投影',
          target: batch[index],
          error: outcome.reason,
          context: { batch_start: start, concurrency },
        }),
      )
    })
  }
  return records
}

// ---------------------------------------------------------------------------
// 相关会话聚类（契约 3.3）
// ---------------------------------------------------------------------------

/**
 * 在同 cwd 内做 IDF 过滤后的标题词聚类，并把 groupId / relationKeys 回填到入参对象上。
 *
 * 为什么不返回"组"而返回入参数组：调用方（scanStates / RPC）需要的是带 groupId 的
 * 完整条目列表，回填 + 返回同一引用可以让"就地写入"和"拿返回值"两种用法都不出错。
 * 组数可由调用方按 groupId 去重得出，组内成员是 Entries 中 groupId 相同的项。
 *
 * 第二个参数是可选的，不改变契约里 clusterRelated(entries) 的调用方式。
 * 为什么必须让调用方能把"全库词频"传进来：契约 3.3.3 说的是"丢弃在全库出现 ≥5 次的词"，
 * 而 entries 在 scanStates 里只是三态命中的少量会话（常态个位数）。若用 entries 自己算 df，
 * 任何词都到不了 5，IDF 过滤形同虚设——正是契约要消除的那批误报会全部回来。
 * 独立调用且未传词频时，退化为按 entries 自算，并把该局限写进注释而非假装等价。
 *
 * @param {SessionEntry[]} entries
 * @param {Map<string, number>|null} [tokenDocumentFrequency] 全库词频（词 → 出现会话数）
 * @returns {SessionEntry[]} 同一个数组引用（已就地回填）
 */
export function clusterRelated(entries, tokenDocumentFrequency) {
  if (!Array.isArray(entries)) return entries

  // 默认值先行：既保证"无关系时 = 自身 id"的契约，也让本函数可重复调用（幂等）。
  for (const entry of entries) {
    if (!isPlainObject(entry)) continue
    if (typeof entry.id !== 'string') entry.id = ''
    entry.groupId = entry.id
    entry.relationKeys = []
  }

  // df 优先用调用方给的"全库词频"；缺失时才退回按 entries 自算（有上述局限）。
  let df
  if (tokenDocumentFrequency instanceof Map) {
    df = tokenDocumentFrequency
  } else {
    df = new Map()
    for (const entry of entries) {
      if (!isPlainObject(entry)) continue
      for (const token of titleTokens(entry.title)) {
        df.set(token, (df.get(token) || 0) + 1)
      }
    }
  }

  // 只在同 cwd 内比较；cwd 为空说明工作区未知，把它们相互连起来会制造假关系。
  const buckets = new Map()
  entries.forEach((entry, index) => {
    if (!isPlainObject(entry)) return
    if (entry.isSubagent === true) return // 契约 3.3.4：子代理不参与聚类
    const cwd = asString(entry.cwd)
    if (!cwd) return
    const bucket = buckets.get(cwd) || []
    bucket.push(index)
    buckets.set(cwd, bucket)
  })

  // 并查集：A~B、B~C 必须把 A/B/C 合成一组，逐对打标会漏掉传递闭包。
  const parent = entries.map((_, index) => index)
  const find = (index) => {
    let root = index
    while (parent[root] !== root) root = parent[root]
    // 路径压缩，避免大工作区（120 会话）退化成链式查找。
    let cursor = index
    while (parent[cursor] !== root) {
      const next = parent[cursor]
      parent[cursor] = root
      cursor = next
    }
    return root
  }
  const union = (a, b) => {
    const rootA = find(a)
    const rootB = find(b)
    if (rootA !== rootB) parent[rootA] = rootB
  }

  /** index → 该条目与其他成员命中的共同词 */
  const sharedByIndex = new Map()

  for (const bucket of buckets.values()) {
    for (let i = 0; i < bucket.length; i += 1) {
      for (let j = i + 1; j < bucket.length; j += 1) {
        const indexA = bucket[i]
        const indexB = bucket[j]
        const a = entries[indexA]
        const b = entries[indexB]
        // 契约 3.3.5：标题完全相同视为模板重复，不连（空标题不参与判定）。
        if (a.title && a.title === b.title) continue
        const tokensA = titleTokens(a.title)
        const tokensB = titleTokens(b.title)
        const shared = []
        for (const token of tokensA) {
          if (!tokensB.has(token)) continue
          if ((df.get(token) || 0) >= IDF_DROP_DF) continue // 契约 3.3.3：通用词丢弃
          shared.push(token)
        }
        if (shared.length < MIN_SHARED_TOKENS) continue
        union(indexA, indexB)
        for (const index of [indexA, indexB]) {
          const bag = sharedByIndex.get(index) || new Set()
          for (const token of shared) bag.add(token)
          sharedByIndex.set(index, bag)
        }
      }
    }
  }

  // groupId 取组内最小 id：与 entries 的输入顺序无关，保证刷新之间稳定。
  const membersByRoot = new Map()
  entries.forEach((entry, index) => {
    if (!isPlainObject(entry)) return // 容忍垃圾元素，不能让一条脏数据炸掉整轮聚类
    if (entry.isSubagent === true) return
    const cwd = asString(entry.cwd)
    if (!cwd) return
    const root = find(index)
    const members = membersByRoot.get(root) || []
    members.push(index)
    membersByRoot.set(root, members)
  })

  for (const members of membersByRoot.values()) {
    if (members.length < 2) continue // 无关系 → 保持自身 id
    const groupId = members.map((index) => entries[index].id).sort()[0]
    for (const index of members) {
      entries[index].groupId = groupId
    }
  }

  for (const [index, tokens] of sharedByIndex) {
    entries[index].relationKeys = [...tokens].sort()
  }

  return entries
}

// ---------------------------------------------------------------------------
// 三态扫描（契约 3.2）
// ---------------------------------------------------------------------------

/**
 * 扫描全部工作区的会话投影，输出三态快照。
 *
 * 三态判定严格按契约 3.2，优先级 running > approval > unseen：
 *   - running  : classifyRunning() —— 日志新鲜度 ∧ (openStep 双闸门 ∨ pendingCalls 非空)
 *   - approval : options.approvalIds（Set<string>）由 B 代理的 scanApprovals() 提供；
 *                本模块不实现审批逻辑，空集合时不产出 approval 态
 *   - unseen   : 依赖 options.seen（{sessionId: 已读水位 epoch ms}）；未传时恒为空
 * 只有落在这三态里的会话才会进入 entries（state 是 StateKind 三选一，无第四态）。
 *
 * @param {{
 *   seen?: Record<string, number>|null,
 *   approvalIds?: Set<string>|string[]|null,
 *   excludeArchived?: boolean,
 *   dshHome?: string,
 *   sessionsDir?: string,
 *   workspaceFile?: string,
 *   concurrency?: number,
 *   now?: number|(() => number),
 *   logMtimeIndex?: Map<string,number>|Record<string,number>|null,
 *   sessionsRoot?: string,
 *   logMtimeFreshMs?: number,
 *   runningStaleMs?: number,
 * }} [options]
 * @returns {Promise<StateSnapshot>}
 */
export async function scanStates(options = {}) {
  const opts = isPlainObject(options) ? options : {}
  const warnings = []

  const dshHome = resolveDshHome(opts)
  const sessionsDir =
    typeof opts.sessionsDir === 'string' && opts.sessionsDir
      ? opts.sessionsDir
      : path.join(dshHome, 'storages', 'session_projcache', 'sessions')
  const workspaceFile =
    typeof opts.workspaceFile === 'string' && opts.workspaceFile
      ? opts.workspaceFile
      : path.join(dshHome, 'storages', 'workspace.json')

  // 并发上限是硬要求，外部传入更大值也夹紧到 MAX_CONCURRENCY。
  const requested =
    Number.isInteger(opts.concurrency) && opts.concurrency > 0 ? opts.concurrency : MAX_CONCURRENCY
  const concurrency = Math.min(requested, MAX_CONCURRENCY)

  const seen = isPlainObject(opts.seen) ? opts.seen : null
  const approvalIds = toStringSet(opts.approvalIds)
  const excludeArchived = opts.excludeArchived === true
  const generatedAt =
    typeof opts.now === 'function' ? asNumber(opts.now(), Date.now()) : asNumber(opts.now, Date.now())
  // 「已完成未查看」在无水位记录时的回看窗口（毫秒）。
  // 默认有史以来（服务端仍返回全量）；收窄到 7 天发生在客户端，见 ui/sidebar.js。
  // 可通过 options.lookbackMs 覆盖（0 表示禁用回退，退回旧行为：只认水位记录）。
  const lookbackMs =
    Number.isFinite(opts.lookbackMs) && opts.lookbackMs >= 0
      ? opts.lookbackMs
      : DEFAULT_UNSEEN_LOOKBACK_MS

  // ── 「运行中」的三道闸门（2026-10-06 实测定案，见常量注释）──────────────
  // 调用方（src/index.js）可以用 approval.js 的 buildSessionLogMtimeIndex 预先构造好传进来
  // （这样它能把索引构建的耗时/告警一并记进自己的日志）；没传就**本模块自己建**
  // （有 2 秒 TTL 缓存，实测构建成本 509 会话 / 20ms）。
  //
  // 自己兜底不是可选优化：把正确性外包给「调用方记得传一个可选参数」已经踩过一次坑 ——
  // temp-a-test 里的 scanStates({concurrency:9999}) 没传，于是真实数据上 running
  // 被判成 0、整张列表空掉，而面板看起来只是「什么都没有」。
  //
  // 两者都拿不到时（构造抛错）才 fail-closed：不判任何 running 并记告警。
  const injected =
    opts.logMtimeIndex instanceof Map
      ? opts.logMtimeIndex
      : isPlainObject(opts.logMtimeIndex)
        ? opts.logMtimeIndex
        : null
  let indexRoot = null
  let logMtimeIndex = injected
  if (logMtimeIndex === null) {
    try {
      indexRoot =
        typeof opts.sessionsRoot === 'string' && opts.sessionsRoot !== ''
          ? opts.sessionsRoot
          : defaultSessionsRoot()
      const cached = readLogIndexCache(indexRoot)
      if (cached !== null) {
        logMtimeIndex = cached
      } else {
        const built = buildSessionLogMtimeIndex(indexRoot, [])
        logMtimeIndex = built.index
        writeLogIndexCache(indexRoot, built.index)
      }
    } catch (error) {
      warnings.push(
        describeError({
          operation: '构建会话日志 mtime 索引',
          target: String(indexRoot),
          error,
          errorCode: 'LOG_MTIME_INDEX_BUILD_FAILED',
          context: { degraded: '本次不产出任何 running 态（fail-closed）' },
        }),
      )
      logMtimeIndex = null
    }
  }
  if (logMtimeIndex === null) {
    warnings.push(
      describeError({
        operation: '判定运行中',
        target: sessionsDir,
        inputSummary: '会话日志 mtime 索引不可用',
        error: new Error('缺少会话日志 mtime 索引，本次不产出任何 running 态'),
        errorCode: 'LOG_MTIME_INDEX_MISSING',
        context: {
          degraded: '所有会话降级为 unseen（fail-closed，优先避免把僵尸误报为运行中）',
          freshMs: RUNNING_FRESH_MS,
        },
      }),
    )
  }
  const freshMs = asNumber(opts.logMtimeFreshMs, RUNNING_FRESH_MS)
  const staleMs = asNumber(opts.runningStaleMs, RUNNING_STALE_MS)

  const [files, workspaceMeta] = await Promise.all([
    listProjectionFiles(sessionsDir, warnings),
    loadWorkspaceMeta(workspaceFile, warnings),
  ])

  const records = await readAllProjections(files, concurrency, warnings)

  // 目录本身读不到时（files 为空），上面那条 fail-closed 告警是**多余**的：
  // 真实原因（「列目录」/「读工作区元数据」的 ENOENT）已经在 warnings 里，
  // 再补一条只会把真正的原因埋掉（还会让「目录缺失」从 2 条 warning 变 3 条）。
  if (logMtimeIndex === null && files.length === 0) {
    const marker = warnings.findIndex((w) => String(w).includes('LOG_MTIME_INDEX_MISSING'))
    if (marker !== -1) warnings.splice(marker, 1)
  }

  /** @type {SessionEntry[]} */
  const entries = []
  const seenIds = new Set()
  // 非绝对 cwd 无法可靠归组（见 isUsableCwd），统计后统一告警，不逐条刷屏。
  let nonAbsoluteCwdCount = 0
  // 「有投影但会话日志索引里查不到」的会话数与样本：末尾汇总成一条告警（不逐条刷屏）。
  let missingLogSessions = 0
  const missingLogSamples = []
  for (const record of records) {
    // 文件系统大小写/符号链接理论上可能让两个文件映射到同一 id，去重避免 UI key 冲突。
    if (seenIds.has(record.id)) {
      warnings.push(
        describeError({
          operation: '去重会话投影',
          target: record.file,
          inputSummary: 'id=' + record.id,
          error: new Error('同一会话 id 出现多次，已保留首个'),
          errorCode: 'DUPLICATE_SESSION_ID',
          context: { sessionId: record.id },
        }),
      )
      continue
    }
    seenIds.add(record.id)

    // id 两套写法（裸 uuid / session- 前缀）都要能对上，见 sessionIdCandidates 的实测说明。
    // 必须在 cwd 补全之前算好：补全也要用候选集查 workspace.json。
    const candidates = sessionIdCandidates(record.id)

    // cwd 缺失或非绝对路径时，用 workspace.json 的工作区→会话映射补全（只读、只补空值）。
    // workspace.json 的 sessionIds 与投影文件名同形（都带 session- 前缀），但同样按候选集查，
    // 避免两套 id 写法再次造成静默失配。
    let cwd = record.cwd
    if (!isUsableCwd(cwd)) {
      if (cwd) nonAbsoluteCwdCount += 1
      let fallback
      for (const candidate of candidates) {
        const hit = workspaceMeta.sessionWorkspacePath.get(candidate)
        if (isUsableCwd(hit)) {
          fallback = hit
          break
        }
      }
      cwd = fallback || ''
    }

    // 「运行中」判定集中在这里（classifyRunning 是纯函数，单测直接覆盖每道闸门）。
    // 三道闸门全过才判活：日志新鲜度 ∧ (openStep 双闸门 ∨ pendingCalls 非空)。
    //
    // ⚠️ 「索引整体缺失」与「这条会话不在索引里」是**两条必须能区分的路径**：
    //   - 索引整体缺失 → 上面已 fail-closed 过一次，并对**全部**会话都不判 running；
    //   - 个别会话查不到 → 只影响这一条，且**必须被单独计数并在末尾汇总上报**。
    // 混为一谈会让运维看到「running 全没了」却不知道是配置错了还是日志被清理了。
    const logMtimeMs = lookupLogMtime(logMtimeIndex, candidates)
    if (logMtimeIndex !== null && logMtimeMs === undefined) {
      missingLogSessions += 1
      if (missingLogSamples.length < 5) missingLogSamples.push(record.id)
    }
    let state = null
    if (
      classifyRunning(record, {
        now: generatedAt,
        logMtimeMs,
        freshMs,
        staleMs,
      })
    ) {
      state = 'running'
    } else if (matchesAnyCandidate(candidates, approvalIds)) {
      state = 'approval'
    } else if (
      seen &&
      !record.blank &&
      !(excludeArchived && matchesAnyCandidate(candidates, workspaceMeta.archivedSessionIds))
    ) {
      const watermark = lookupSeenWatermark(seen, candidates)
      // 判定用两条路，缺一不可：
      //   1) 有水位记录 → 严格按 lastPromptAt > watermark（用户明确标记过已读）；
      //   2) 无水位记录 → 回落到「回看窗口」：只看最近 lookbackMs 内活动过的会话。
      //
      // 为什么需要第 2 条（语义修复）：unseen 的中文是「已完成未查看」。
      // 若只认第 1 条，那么「已完成、但用户从未点开过」的会话**永远不会出现**——
      // 恰好与该状态名的语义相反（没看过才叫未查看）。
      // 但若完全放开（无记录即算 unseen），实测本机 495 个投影文件会一次性刷屏，
      // 所以用回看窗口给出上界。
      const effectiveWatermark =
        typeof watermark === 'number' && Number.isFinite(watermark)
          ? watermark
          : generatedAt - lookbackMs
      if (record.lastPromptAt > effectiveWatermark) {
        state = 'unseen'
      }
    }

    if (state === null) continue // 不落三态 → 不进列表

    entries.push({
      id: record.id,
      title: record.title,
      cwd,
      workspace: workspaceOf(cwd),
      state,
      lastPromptAt: record.lastPromptAt,
      steps: record.steps,
      isSubagent: record.isSubagent,
      subagentLabel: record.subagentLabel,
      relationKeys: [],
      groupId: record.id,
    })
  }

  if (missingLogSessions > 0) {
    warnings.push(
      describeError({
        operation: '判定运行中',
        target: sessionsDir,
        inputSummary: missingLogSessions + ' 个会话在日志 mtime 索引里查不到',
        error: new Error('这些会话没有可读的 session*.jsonl.zstd，已按「无日志 → 不判活」处理'),
        // 与「索引整体缺失」（LOG_MTIME_INDEX_MISSING）是两条不同的路径：
        // 运维要能一眼分清「索引整体没建起来」和「只有这几条没有日志文件」。
        errorCode: 'SESSION_LOG_MISSING',
        context: {
          affected: missingLogSessions,
          samples: missingLogSamples,
          degraded: '这些会话不会被判为 running（fail-closed，优先避免把僵尸误报为运行中）',
          indexPresent: true,
        },
      }),
    )
  }

  if (nonAbsoluteCwdCount > 0) {
    warnings.push(
      describeError({
        operation: '校验会话 cwd',
        target: sessionsDir,
        inputSummary: nonAbsoluteCwdCount + ' 个会话的 cwd 不是 POSIX 绝对路径',
        error: new Error('非绝对 cwd 已降级为空工作区，不参与分组'),
        // 与服务端 overview.js 的 CWD_NOT_ABSOLUTE 是**同一件事**（两处扫描各自统计），
        // 故用同一个 error_code —— 前端按 code 合并，两边表现一致。
        errorCode: 'CWD_NOT_ABSOLUTE',
        context: { reason: 'Windows 原始路径或相对路径，resolve 后会拼出假工作区' },
      }),
    )
  }

  // 全库词频：覆盖所有已解析的会话（含子代理、含未落三态的），与 validate-states.py
  // 在全部会话上统计 df 的做法一致——这是"全库"二字的落点，不能只统计 entries。
  const tokenDocumentFrequency = new Map()
  for (const record of records) {
    for (const token of titleTokens(record.title)) {
      tokenDocumentFrequency.set(token, (tokenDocumentFrequency.get(token) || 0) + 1)
    }
  }

  clusterRelated(entries, tokenDocumentFrequency)

  // 分组排序：先按三态优先级，再按最近活跃倒序，最后用 id 兜底保证完全确定。
  entries.sort((a, b) => {
    const orderDiff = (STATE_ORDER[a.state] ?? 99) - (STATE_ORDER[b.state] ?? 99)
    if (orderDiff !== 0) return orderDiff
    if (a.lastPromptAt !== b.lastPromptAt) return b.lastPromptAt - a.lastPromptAt
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
  })

  const counts = { running: 0, approval: 0, unseen: 0, total: entries.length, subagent: 0 }
  for (const entry of entries) {
    if (entry.state === 'running') counts.running += 1
    else if (entry.state === 'approval') counts.approval += 1
    else if (entry.state === 'unseen') counts.unseen += 1
    // 子代理会话单独计数：实测本机 47 条 unseen 里有 16 条是子代理
    // （标题是统一模板「你是「…」任务」），会把用户真正关心的会话淹没。
    // 前端据此默认折叠成「还有 N 条子代理」，而不是删除数据（它们仍是真实会话）。
    if (entry.isSubagent === true) counts.subagent += 1
  }

  return {
    generatedAt,
    counts,
    workspaces: new Set(entries.map((entry) => entry.workspace)).size,
    entries,
    warnings,
  }
}
