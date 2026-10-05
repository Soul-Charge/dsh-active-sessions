/**
 * states.js — dsh-active-sessions 服务端核心逻辑（三态扫描 + 相关会话 IDF 聚类）
 *
 * 硬约束：只读、0 token。本模块不注册任何模型可见工具，也不写任何 DSH 数据。
 * 事实来源：tasks/dsh-active-sessions-plugin/CONTRACT.md 第 3 节（冻结契约，不得自行改接口）。
 *
 * 为什么把"读投影 + 判态 + 聚类"放在同一个纯函数模块里：
 *   RPC 端点（由 B 代理提供）与自测脚本都要用同一份判定逻辑，逻辑一旦分叉，
 *   "面板计数"与"验证脚本计数"就会不一致（验收标准第 2 条），所以判定只此一处。
 */

import { readFile, readdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'

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
 * 「已完成未查看」在无水位记录时的回看窗口默认值：**有史以来**（用户明确要求）。
 *
 * 背景：unseen 的语义是「已完成但用户还没看过」。若严格要求「必须有水位记录」
 * 才判定，用户**从未点开过**的已完成会话永远不会出现 —— 与语义相反。
 * 用户选择不设时间上限，即所有历史未查看会话都算。
 *
 * ⚠️ 这个取值的实测代价（本机）：unseen 从 48 条增至 **448 条**
 * （用户会话 397 + 子代理 51）。其中 7 天内仅 115 条，30 天以上 332 条。
 * 因此**可读性不能靠时间窗**，改由前端做时间分层与分页（见 ui/sidebar.js
 * 的 as_timeFold 折叠）。这里的常数只负责"不设上限"。
 *
 * 设为任意毫秒数可恢复时间窗（例如 72h = 72*60*60*1000）；0 = 只认水位记录。
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
 * 同一个会话在系统里有两套 id 写法：投影文件名带 \`session-\` 前缀，而会话日志目录
 * （approval.js 的扫描结果）给的是裸 uuid。契约也写明 SessionEntry.id 允许
 * "session-xxxx 或裸 uuid"。
 *
 * 实测踩坑：scanApprovals() 返回裸 uuid \`d683695c-...\`，而投影 entry 的 id 是
 * \`session-d683695c-...\`，直接 Set.has 永远不命中 → approval 态在生产里恒为 0（整个第二态失效）。
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
    candidates.add(`session-${bare}`)
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
 * 统一的错误描述：禁止静默吞错，警告串必须自带 operation/target/error_code/context，
 * 否则前端只能显示"加载失败"，无法定位是哪个文件坏了。
 */
function describeError({ operation, target, inputSummary = '', error, context = {} }) {
  const errorCode = (error && (error.code || error.name)) || 'UNKNOWN_ERROR'
  const message = error instanceof Error ? error.message : String(error)
  return [
    '[states]',
    `operation=${operation}`,
    `target=${target}`,
    `input_summary=${inputSummary || '(n/a)'}`,
    `error_code=${errorCode}`,
    `message=${message}`,
    `context=${JSON.stringify(context)}`,
  ].join(' ')
}

/**
 * cwd 可用性校验：必须是 POSIX 绝对路径（以 "/" 开头）。
 *
 * 为什么不能对 `E:\\MyData\\...` 这类 Windows 原始路径做 path.resolve：
 * resolve 会把它当成相对路径，凭空拼出 `<cwd>/E:\\MyData\\...` 这样的假工作区。
 * 更糟的是取 basename 会得到 `temp`，与真实存在的 `/mnt/e/.../temp`（73 个会话）
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
 * 标题 → 词元集合。小写化与 validate-states.py 的 `s.lower()` 对齐，
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
        context: { source: 'session_projcache/sessions' },
      }),
    )
    return []
  }
}

/**
 * workspace.json：只用于两件契约允许的事——
 *   1) 会话投影缺 cwd 时用 tables.workspaces[*].sessionIds 反查工作区路径补全；
 *   2) 提供 archivedSessionIds（默认不参与判态，见 excludeArchived 选项）。
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
        inputSummary: `${raw.length}B`,
        error,
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
 * @returns {Promise<null|{file:string,id:string,title:string,cwd:string,steps:number,lastPromptAt:number,blank:boolean,isSubagent:boolean,subagentLabel:string,running:boolean}>}
 */
async function readProjectionFile(filePath, warnings) {
  let raw
  try {
    raw = await readFile(filePath, 'utf8')
  } catch (error) {
    warnings.push(
      describeError({ operation: '读取会话投影文件', target: filePath, error, context: {} }),
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
        inputSummary: `${raw.length}B`,
        error,
        context: {},
      }),
    )
    return null
  }
  if (!isPlainObject(doc)) {
    warnings.push(
      describeError({
        operation: '校验会话投影结构',
        target: filePath,
        inputSummary: `${raw.length}B`,
        error: new TypeError('投影根节点不是对象'),
        context: { version: doc === null ? 'null' : typeof doc },
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

  const openStep = sessionStats.openStep
  const running = openStep !== null && openStep !== undefined
    ? true
    : hasEntries(sessionStats.pendingCalls)

  return {
    file: filePath,
    id: path.basename(filePath, '.json'),
    title: asString(rowScalar(rows.title, '')),
    cwd: asString(identity.cwd),
    steps: asNumber(sessionStats.steps, 0),
    lastPromptAt: asNumber(sessionListMetadata.lastPromptAt, 0),
    blank: sessionListMetadata.blank === true,
    isSubagent: subagentIdentity !== null && subagentIdentity.mode !== null && subagentIdentity.mode !== undefined,
    subagentLabel: subagentIdentity ? asString(subagentIdentity.label) : '',
    running,
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
 * 第二个参数是可选的，不改变契约里 `clusterRelated(entries)` 的调用方式。
 * 为什么必须让调用方能把"全库词频"传进来：契约 3.3.3 说的是"丢弃在**全库**出现 ≥5 次的词"，
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

  /** @type {Map<number, Set<string>>} index → 该条目与其他成员命中的共同词 */
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
 *   - running  : sessionStats.openStep != null 或 pendingCalls 非空（本函数唯一自行判定的态）
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
  const requested = Number.isInteger(opts.concurrency) && opts.concurrency > 0 ? opts.concurrency : MAX_CONCURRENCY
  const concurrency = Math.min(requested, MAX_CONCURRENCY)

  const seen = isPlainObject(opts.seen) ? opts.seen : null
  const approvalIds = toStringSet(opts.approvalIds)
  const excludeArchived = opts.excludeArchived === true
  const generatedAt =
    typeof opts.now === 'function'
      ? asNumber(opts.now(), Date.now())
      : asNumber(opts.now, Date.now())
  // 「已完成未查看」在无水位记录时的回看窗口（毫秒）。
  // 72 小时覆盖「这两天做完但还没点开看的会话」，同时把 460+ 个历史会话挡在外面。
  // 可通过 options.lookbackMs 覆盖（0 表示禁用回退，退回旧行为：只认水位记录）。
  const lookbackMs =
    Number.isFinite(opts.lookbackMs) && opts.lookbackMs >= 0
      ? opts.lookbackMs
      : DEFAULT_UNSEEN_LOOKBACK_MS

  const [files, workspaceMeta] = await Promise.all([
    listProjectionFiles(sessionsDir, warnings),
    loadWorkspaceMeta(workspaceFile, warnings),
  ])

  const records = await readAllProjections(files, concurrency, warnings)

  /** @type {SessionEntry[]} */
  const entries = []
  const seenIds = new Set()
  // 非绝对 cwd 无法可靠归组（见 isUsableCwd），统计后统一告警，不逐条刷屏。
  let nonAbsoluteCwdCount = 0
  for (const record of records) {
    // 文件系统大小写/符号链接理论上可能让两个文件映射到同一 id，去重避免 UI key 冲突。
    if (seenIds.has(record.id)) {
      warnings.push(
        describeError({
          operation: '去重会话投影',
          target: record.file,
          inputSummary: `id=${record.id}`,
          error: new Error('同一会话 id 出现多次，已保留首个'),
          context: {},
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
        if (isUsableCwd(hit)) { fallback = hit; break }
      }
      cwd = fallback || ''
    }

    let state = null
    if (record.running) {
      state = 'running'
    } else if (matchesAnyCandidate(candidates, approvalIds)) {
      state = 'approval'
    } else if (seen && !record.blank && !(excludeArchived && (matchesAnyCandidate(candidates, workspaceMeta.archivedSessionIds)))) {
      const watermark = lookupSeenWatermark(seen, candidates)
      // 判定用两条路，缺一不可：
      //   1) 有水位记录 → 严格按 lastPromptAt > watermark（用户明确标记过已读）；
      //   2) 无水位记录 → 回落到「回看窗口」：只看最近 lookbackMs 内活动过的会话。
      //
      // 为什么需要第 2 条（语义修复）：unseen 的中文是「已完成未查看」。
      // 若只认第 1 条，那么「已完成、但用户从未点开过」的会话**永远不会出现**——
      // 恰好与该状态名的语义相反（没看过才叫未查看）。
      // 但若完全放开（无记录即算 unseen），实测本机 463 个投影文件会一次性刷屏，
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

  if (nonAbsoluteCwdCount > 0) {
    warnings.push(
      describeError({
        operation: '校验会话 cwd',
        target: sessionsDir,
        inputSummary: `${nonAbsoluteCwdCount} 个会话的 cwd 不是 POSIX 绝对路径`,
        error: new Error('非绝对 cwd 已降级为空工作区，不参与分组'),
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
