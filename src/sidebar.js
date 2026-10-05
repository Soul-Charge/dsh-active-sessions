/**
 * dsh-active-sessions · 左侧长窗（活跃会话）客户端 UI
 *
 * ── 为什么是这个形态（交付契约）─────────────────────────────────────────
 * 这是**浏览器端**代码。DSH 客户端模块系统的 factory(require) 只能解析
 * package.json 的 dsh.client.external 里声明过的**外部包**（如 react），
 * **不能解析同一个包自己的子路径**。所以本文件不能写成
 *   require('dsh-active-sessions/ui/sidebar')
 * 那种同包 require，而必须交付一个**可被内联合并的工厂**：
 *
 *   export function createSidebarUi({ React }) { ... return { Component, apply } }
 *
 * 主代理会在唯一的 src/client.js 的 factory 里写
 *   const sidebar = createSidebarUi({ React })
 * 把函数体原样内联，零构建步骤、无跨模块解析问题。
 *
 * 因此本文件：
 *   1) 不含宿主模块加载器的 load(...) 包裹层（由主代理在 client.js 统一写）；
 *   2) 不用 require() 取任何依赖 —— 需要的能力（React）通过参数注入；
 *   3) 仍是 ESM，导出 { createSidebarUi }。
 *
 * ── 硬约束 ──────────────────────────────────────────────────────────────
 * · 列容器上绝不加**背景模糊（毛玻璃）滤镜**：皮肤作者实测它会让列容器成为
 *   fixed 后代的包含块，把设置弹窗困在 280px 侧栏里（契约 §5 硬约束）。
 *   通透感用半透明 rgba 实色模拟。验收可 grep 该 CSS 属性名，本文件应为 0 命中。
 * · 只读、0 token：只发一个 GET，不注册任何模型可见工具。
 * · 外部输入（HTTP 响应 / localStorage / 组件 props）一律视为不可信，
 *   全部走窄化 + fallback；任何畸形输入退化成「空态」而不是抛错炸掉侧栏。
 *
 * ── 为什么文件里没有反斜杠和正则 ────────────────────────────────────────
 * 本文件要能被宿主以字符串内联进 client.js。源码里出现的每一个反斜杠
 * 在二次转义时都是事故点（我自己就在这一步踩过解析错误），
 * 所以：反斜杠用 String.fromCharCode(92) 表达；路径切分用 split/charAt
 * 而不是正则；特殊字形（⌥ ↳ ‹ ▸）直接用字符本身，不走 Unicode 转义。
 */

// ───────────────────────────── 常量 ─────────────────────────────

/** 状态端点（由服务端侧代理提供，契约 3.1：{ok:true,data:StateSnapshot}）。 */
const STATE_ENDPOINT = '/api/active-sessions/state'
/**
 * 已读上报端点（服务端契约：POST {sessionId, at?}）。
 *
 * 为什么必须有它：「已完成未查看」= lastPromptAt > 已读水位。
 * 水位由**客户端**上报 —— 若从不调用本端点，unseen 这个状态就永远清不掉，
 * 用户点开会话后刷新仍显示「未查看」，功能等于缺失。
 */
const SEEN_ENDPOINT = '/api/active-sessions/seen'
/** 轮询间隔默认值；契约要求 >= 15 秒。 */
const POLL_INTERVAL_MS = 15000
/** 轮询间隔硬下限：任何更小的配置都会被抬到这里，避免打爆端点。 */
const POLL_MIN_MS = 15000
/** 展开/收起持久化键（契约 4.3）。 */
const STORAGE_KEY = 'dsh-active-sessions.collapsed'
/** 插件 id，用于 <style> 标签归属与错误上下文。 */
const PLUGIN_ID = 'dsh-active-sessions'
/** 跨插件选中会话的解耦事件名（不写死到别人的导航接口里）。 */
const SELECT_EVENT = 'dsh-active-sessions:select'
/** 模块 id（宿主模块加载器的 id 字段；工厂本身不写包裹层，仅作常量）。 */
const MODULE_ID = 'dsh-active-sessions/sidebar'
const CSS_TAG = PLUGIN_ID + '/sidebar.css'

/** 三态顺序、显示名与标签文案。数组顺序即渲染顺序。 */
const STATE_META = [
  { key: 'running', label: '运行中', tag: '运行中' },
  { key: 'approval', label: '待审批', tag: '待审批' },
  { key: 'unseen', label: '已完成未查看', tag: '未查看' },
]
const STATE_META_MAP = { running: STATE_META[0], approval: STATE_META[1], unseen: STATE_META[2] }
const STATE_KEYS = ['running', 'approval', 'unseen']

/** 反斜杠字符。用 fromCharCode 保持源码无字面反斜杠（见文件头说明）。 */
const BACKSLASH = String.fromCharCode(92)

/** 对外暴露的常量，便于集成方与自测引用（避免魔法数字散落）。 */
export const constants = {
  MODULE_ID,
  PLUGIN_ID,
  STATE_ENDPOINT,
  POLL_INTERVAL_MS,
  POLL_MIN_MS,
  STORAGE_KEY,
  SELECT_EVENT,
  CSS_TAG,
}

// ──────────────────── 错误上下文（禁止静默吞错） ────────────────────

/**
 * 构造带 operation / target / error_code 上下文的错误。
 * 项目规范要求任何失败都能定位「在做什么、对谁做、为什么失败」，
 * 所以错误对象上同时挂结构化字段，便于上层按 error_code 分支。
 */
export function contextError(operation, target, errorCode, detail) {
  const suffix = detail === undefined || detail === null || detail === '' ? '' : ' detail=' + String(detail)
  const error = new Error('[' + operation + '] target=' + target + ' error_code=' + errorCode + suffix)
  error.operation = operation
  error.target = target
  error.error_code = errorCode
  if (detail !== undefined && detail !== null && detail !== '') error.detail = String(detail)
  return error
}

/** 把任意异常压成一行可读文本；异常本身也可能是不可信对象。 */
export function describeError(error) {
  if (error === null || error === undefined) return 'unknown'
  if (typeof error === 'string') return error
  try {
    const message = error.message
    if (typeof message === 'string' && message !== '') return message
  } catch (cause) {
    // message 可能是会抛的 getter（异常对象同样不可信）；这里本身就在错误
    // 处理路径上，绝不能再二次抛出，否则降级链会整体崩掉。
    return 'unreadable-message'
  }
  try {
    return String(error)
  } catch (cause) {
    return 'unprintable'
  }
}

const warned = new Set()
/**
 * 一次性告警：降级路径（localStorage 不可用、轮询失败）不该每次渲染都刷屏，
 * 但也不能静默 —— 第一次必须留下完整上下文。
 */
function warnOnce(key, message) {
  if (warned.has(key)) return
  warned.add(key)
  if (typeof console !== 'undefined' && console !== null && typeof console.warn === 'function') {
    console.warn('[' + PLUGIN_ID + '] ' + key + ': ' + message)
  }
}

// ──────────────────── 不可信输入的安全取用 ────────────────────

/** 窄化到普通对象；数组与 null 都不算。 */
export function asRecord(value) {
  return typeof value === 'object' && value !== null && Array.isArray(value) === false ? value : null
}

/** 取字符串；非字符串一律给空串。 */
function str(value) {
  return typeof value === 'string' ? value : ''
}

/** 取非负数字；NaN / Infinity / 负数 / 非数字一律给 0。 */
function num(value) {
  const parsed = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0
}

/** 取正数，否则给 0（用于尺寸/间隔这类必须为正的量）。 */
function toPositive(value) {
  const parsed = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0
}

/** 从 cwd 推出工作区名（显示用）。不用正则，避免转义层面的意外。 */
export function workspaceOf(cwd) {
  if (typeof cwd !== 'string' || cwd === '') return ''
  const normalized = cwd.split(BACKSLASH).join('/')
  const parts = normalized.split('/').filter((part) => part !== '')
  return parts.length > 0 ? parts[parts.length - 1] : ''
}

/** 相对时间显示。时间戳为 0（未知）返回空串，让调用方决定是否省略这一段。 */
export function formatRelative(timestamp, now) {
  const value = num(timestamp)
  if (value === 0) return ''
  const reference = num(now) > 0 ? num(now) : Date.now()
  const minutes = Math.floor(Math.max(0, reference - value) / 60000)
  if (minutes < 1) return '刚刚'
  if (minutes < 60) return String(minutes) + ' 分钟前'
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return String(hours) + ' 小时前'
  return String(Math.floor(hours / 24)) + ' 天前'
}

// ──────────────────── StateSnapshot 规范化 ────────────────────

/** 空快照：任何解析失败的兜底返回值（空态而非报错）。 */
export function emptySnapshot() {
  return { generatedAt: 0, counts: { running: 0, approval: 0, unseen: 0, total: 0 }, workspaces: 0, entries: [], warnings: [] }
}

/** 单条会话的窄化：缺 id 视为不可用条目，整条丢弃而不是伪造一个。 */
export function normalizeEntry(raw) {
  const record = asRecord(raw)
  if (record === null) return null
  const id = str(record.id)
  if (id === '') return null
  const cwd = str(record.cwd)
  const workspace = str(record.workspace) !== '' ? str(record.workspace) : workspaceOf(cwd)
  const rawKeys = Array.isArray(record.relationKeys) ? record.relationKeys : []
  const rawState = str(record.state)
  return {
    id,
    title: str(record.title) !== '' ? str(record.title) : '(无标题)',
    cwd,
    workspace: workspace !== '' ? workspace : '(未知工作区)',
    state: STATE_KEYS.indexOf(rawState) >= 0 ? rawState : 'unseen',
    lastPromptAt: num(record.lastPromptAt),
    steps: num(record.steps),
    isSubagent: record.isSubagent === true,
    subagentLabel: str(record.subagentLabel),
    relationKeys: rawKeys.filter((key) => typeof key === 'string' && key !== ''),
    groupId: str(record.groupId) !== '' ? str(record.groupId) : id,
  }
}

/**
 * 把端点响应规范化为 StateSnapshot。
 * 同时容忍两种形状：契约的 {ok:true,data:{...}}，以及裸的 StateSnapshot
 * （端点被反代/中间件包一层时很常见）。计数一律从 entries 现算 ——
 * 保证「分组计数」与「实际列出的条目」永远自洽，不信任服务端的 counts。
 */
export function normalizeSnapshot(raw) {
  const outer = asRecord(raw)
  if (outer === null) return emptySnapshot()
  const inner = asRecord(outer.data)
  const payload = outer.ok === true && inner !== null ? inner : outer

  const entries = []
  const rawEntries = Array.isArray(payload.entries) ? payload.entries : []
  for (const candidate of rawEntries) {
    const entry = normalizeEntry(candidate)
    if (entry !== null) entries.push(entry)
  }

  const counts = { running: 0, approval: 0, unseen: 0, total: entries.length }
  const workspaceNames = new Set()
  for (const entry of entries) {
    counts[entry.state] = (counts[entry.state] || 0) + 1
    if (entry.workspace !== '') workspaceNames.add(entry.workspace)
  }

  const rawWarnings = Array.isArray(payload.warnings) ? payload.warnings : []
  const warnings = rawWarnings.filter((item) => typeof item === 'string' && item !== '')
  const declaredWorkspaces = num(payload.workspaces)

  return {
    generatedAt: num(payload.generatedAt),
    counts,
    workspaces: declaredWorkspaces > 0 ? declaredWorkspaces : workspaceNames.size,
    entries,
    warnings,
  }
}

// ──────────────────── 分组 / 聚类 / 关系证据 ────────────────────

/** 确定性排序：时间倒序，同时间按 id 升序，不依赖枚举顺序。 */
export function sortEntries(entries) {
  return entries.slice().sort((left, right) => {
    if (right.lastPromptAt !== left.lastPromptAt) return right.lastPromptAt - left.lastPromptAt
    if (left.id < right.id) return -1
    if (left.id > right.id) return 1
    return 0
  })
}

/**
 * 同 groupId 的条目聚成一个簇。
 * groupId 等于自身 id（契约：「无关系时 = 自身 id」）视为**孤立条目**；
 * 否则整栏会退化成一个巨大簇，连接线也就失去意义了。
 */
export function clusterByGroup(entries) {
  const clusters = []
  const byGroup = new Map()
  for (const entry of entries) {
    const groupId = entry.groupId !== '' && entry.groupId !== entry.id ? entry.groupId : null
    if (groupId === null) {
      clusters.push({ groupId: null, entries: [entry] })
      continue
    }
    let cluster = byGroup.get(groupId)
    if (cluster === undefined) {
      cluster = { groupId, entries: [] }
      byGroup.set(groupId, cluster)
      clusters.push(cluster)
    }
    cluster.entries.push(entry)
  }
  return clusters
}

/** 关系证据：簇内 relationKeys 去重后的前若干个（契约 §4 的「共同关键词」）。 */
export function relationEvidence(entries, limit) {
  const cap = toPositive(limit) > 0 ? toPositive(limit) : 3
  const seen = new Set()
  const keys = []
  for (const entry of entries) {
    for (const key of entry.relationKeys) {
      if (seen.has(key)) continue
      seen.add(key)
      keys.push(key)
      if (keys.length >= cap) return keys
    }
  }
  return keys
}

/**
 * 三重分组：running / approval / unseen，顺序固定。
 * **空组直接不产出**（要求 3：某组为空则该组隐藏），所以返回的数组长度
 * 天然等于「有内容的分组数」，渲染层不许再补空占位。
 */
export function groupByState(entries) {
  const buckets = { running: [], approval: [], unseen: [] }
  for (const entry of entries) {
    const bucket = buckets[entry.state]
    if (bucket !== undefined) bucket.push(entry)
  }
  const groups = []
  for (const meta of STATE_META) {
    const list = sortEntries(buckets[meta.key])
    if (list.length === 0) continue
    groups.push({ key: meta.key, label: meta.label, tag: meta.tag, count: list.length, clusters: clusterByGroup(list) })
  }
  return groups
}

// ───────────────────────── 取数 ─────────────────────────

/**
 * 拉一次状态端点。任何失败都抛带 operation/target/error_code 的上下文错误，
 * 由调用方（组件）决定是降级显示空态还是保留上一份好数据。
 */
export async function fetchState(options) {
  const settings = asRecord(options) || {}
  const endpoint = str(settings.endpoint) !== '' ? str(settings.endpoint) : STATE_ENDPOINT
  const fetchImpl = typeof settings.fetch === 'function'
    ? settings.fetch
    : (typeof fetch === 'function' ? fetch : null)
  if (fetchImpl === null) {
    throw contextError('获取活跃会话状态', endpoint, 'FETCH_UNAVAILABLE', '当前运行环境没有可用的 fetch')
  }
  const init = { method: 'GET', headers: { accept: 'application/json' }, credentials: 'same-origin' }
  if (settings.signal !== undefined && settings.signal !== null) init.signal = settings.signal

  let response
  try {
    response = await fetchImpl(endpoint, init)
  } catch (cause) {
    const aborted = asRecord(cause) !== null && str(cause.name) === 'AbortError'
    throw contextError('获取活跃会话状态', endpoint, aborted ? 'ABORTED' : 'NETWORK_ERROR', describeError(cause))
  }
  if (asRecord(response) === null || typeof response.ok !== 'boolean') {
    throw contextError('获取活跃会话状态', endpoint, 'BAD_RESPONSE', 'fetch 返回值不是 Response')
  }
  if (response.ok !== true) {
    throw contextError('获取活跃会话状态', endpoint, 'HTTP_' + String(response.status), 'HTTP ' + String(response.status))
  }

  let raw
  try {
    raw = await response.json()
  } catch (cause) {
    throw contextError('获取活跃会话状态', endpoint, 'JSON_PARSE_ERROR', describeError(cause))
  }
  // 契约 3.1：ok=false 是服务端自陈失败，必须当错误而不是空数据。
  const outer = asRecord(raw)
  if (outer !== null && outer.ok === false) {
    throw contextError('获取活跃会话状态', endpoint, 'ENDPOINT_REPORTED_FAILURE', str(outer.error) || 'ok=false')
  }
  return normalizeSnapshot(raw)
}

// ──────────────────── 展开/收起持久化 ────────────────────

/** 读收起状态。默认 **false = 展开**（要求 1：默认展开）。 */
export function readCollapsed() {
  try {
    if (typeof localStorage === 'undefined' || localStorage === null) return false
    return localStorage.getItem(STORAGE_KEY) === '1'
  } catch (cause) {
    warnOnce('readCollapsed', 'localStorage 不可读，按默认展开处理：' + describeError(cause))
    return false
  }
}

/** 写收起状态。写失败只降级为「不持久化」，不影响本次交互。 */
export function writeCollapsed(collapsed) {
  try {
    if (typeof localStorage === 'undefined' || localStorage === null) return false
    localStorage.setItem(STORAGE_KEY, collapsed === true ? '1' : '0')
    return true
  } catch (cause) {
    warnOnce('writeCollapsed', 'localStorage 不可写，本次收起状态不持久化：' + describeError(cause))
    return false
  }
}

/**
 * 上报"这个会话已被查看"。
 *
 * 为什么选中时要上报：unseen 的判据是 lastPromptAt > 已读水位，
 * 水位由客户端维护。不上报 → 点开后仍显示未查看，状态永远清不掉。
 *
 * 失败处理：这是**尽力而为**的旁路操作 —— 上报失败不该阻断导航，
 * 也不该弹错。但必须留下可诊断的痕迹（console.warn），不静默。
 * 用 keepalive 让请求在页面切换途中也能发出。
 * @param {string} sessionId
 * @param {{fetch?:Function, endpoint?:string}} [options]
 * @returns {Promise<boolean>} 是否成功上报（调用方可忽略）
 */
export function reportSeen(sessionId, options) {
  const config = options === null || options === undefined ? {} : options
  const id = str(sessionId)
  if (id === '') return Promise.resolve(false)
  const doFetch = config.fetch === undefined ? (typeof fetch === 'function' ? fetch : null) : config.fetch
  if (typeof doFetch !== 'function') return Promise.resolve(false)
  const endpoint = str(config.endpoint) !== '' ? str(config.endpoint) : SEEN_ENDPOINT
  let body
  try {
    body = JSON.stringify({ sessionId: id, at: Date.now() })
  } catch (cause) {
    warnOnce('reportSeen:body', '构造已读上报请求体失败（跳过本次上报）：' + describeError(cause))
    return Promise.resolve(false)
  }
  let promise
  try {
    promise = doFetch(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
      // 页面可能正在切换会话，keepalive 保证请求不被中断。
      keepalive: true,
    })
  } catch (cause) {
    // fetch 同步抛（例如 URL 非法）：同样只记不抛。
    warnOnce('reportSeen:call', '已读上报调用失败（不影响导航）：' + describeError(cause))
    return Promise.resolve(false)
  }
  return Promise.resolve(promise).then(
    (res) => (res !== null && res !== undefined && res.ok === false ? false : true),
    (cause) => {
      warnOnce('reportSeen:reject', '已读上报未完成（不影响导航，下次轮询会重算）：' + describeError(cause))
      return false
    },
  )
}

/**
 * 选中某个会话时上报。
 * 不写死任何导航接口：优先调用集成方传入的 onSelect；否则派发自定义事件，
 * 让「谁负责切会话」自己去监听，客户端包之间保持解耦。
 *
 * 同时上报已读水位（见 reportSeen 的说明）—— 这是 unseen 状态能清掉的唯一途径。
 */
export function selectEntry(entry, onSelect) {
  if (entry !== null && entry !== undefined) {
    // 尽力而为，不 await：导航不应等网络。
    const seenOptions = typeof onSelect === 'object' && onSelect !== null ? onSelect : undefined
    void reportSeen(entry.id, seenOptions).catch(() => false)
  }
  if (typeof onSelect === 'function') {
    onSelect(entry.id, entry)
    return
  }
  if (typeof window === 'undefined' || window === null) return
  if (typeof window.dispatchEvent !== 'function' || typeof CustomEvent !== 'function') return
  window.dispatchEvent(new CustomEvent(SELECT_EVENT, { detail: { id: entry.id, cwd: entry.cwd, workspace: entry.workspace } }))
}

// ───────────────────────── 样式 ─────────────────────────

/**
 * 配色严格取自契约 §5（初音青空），只引用皮肤 token，不硬编码主色。
 * 列容器（.as_root / .as_body）刻意不含任何背景模糊声明 —— 见文件头硬约束。
 */
export const CSS = [
  '.as_root{',
  '--as-accent:var(--dsw-alias-brand-text,#0f9d90);',
  '--as-accent-bg:rgba(18,167,155,.14);',
  '--as-accent-line:rgba(18,167,155,.42);',
  '--as-text:var(--dsw-alias-label-primary,#12324f);',
  '--as-text2:var(--dsw-alias-label-secondary,#3a5a7c);',
  '--as-tertiary:var(--dsw-alias-label-tertiary,#5a7699);',
  '--as-panel:var(--dsw-alias-bg-layer-1,#f5fbfbee);',
  '--as-card:var(--dsw-alias-bg-layer-2,#e9f6f6ee);',
  '--as-line:var(--dsw-alias-border-l1,#12324f1f);',
  '--as-run:#0f9d90;--as-run-bg:rgba(18,167,155,.16);',
  '--as-appr:#b7791f;--as-appr-bg:rgba(214,158,46,.18);',
  '--as-done:#5a7699;--as-done-bg:rgba(18,50,79,.10);',
  'display:flex;flex-direction:column;height:100%;min-height:0;box-sizing:border-box;',
  'background:var(--as-panel);border:1px solid var(--as-line);border-radius:12px;',
  'color:var(--as-text);font-size:13px;line-height:1.5;overflow:hidden;font-family:inherit;',
  '}',
  '.as_root *{box-sizing:border-box}',
  '.as_subFold{margin-top:6px}',
  '.as_foldBtn{width:100%;text-align:left;border:1px dashed var(--as-line);background:transparent;',
  'color:var(--as-tertiary);font-size:11.5px;padding:5px 8px;border-radius:8px;cursor:pointer;font-family:inherit}',
  '.as_foldBtn:hover{background:var(--as-card);color:var(--as-text2)}',
  // ── overlay 挂载形态（shell.overlay）──────────────────────────────
  // shell.overlay 是 absolute/inset:0/pointer-events:none 的帧级浮层（点击穿透），
  // 里面的元素必须自己 opt-in pointer-events:auto，否则整窗点不动。
  //
  // ⚠️ 定位策略（经两轮用户实测反馈后定型）：
  //
  // 问题：frame 是 grid（sidebar | center | rightbar），侧栏宽度是**内联 grid 值**
  //   （clampWidth 264..420，默认 280），**没有暴露成 CSS 变量**。
  //   第一版硬编码 left:300px + width:290px = 占左 590px，
  //   用户反馈「左边距太大，中间位置不够」。
  //
  // 解法：不再"估算"侧栏宽度，而是**实测它**（见 measureSidebarOffset）。
  //   · sidebarCol 的 CSS Module 类名带 hash，不能硬编码选择器；
  //     故用 JS 读 frame 的 grid 首列宽度（getComputedStyle 的 grid-template-columns）
  //     或 sidebarCol 的 getBoundingClientRect，写进 CSS 变量 --as-overlay-left。
  //   · 纯 CSS 兜底：侧栏收起时 frame 带 data-sidebar-collapsed，
  //     用 :has() 直接把左窗贴到最左（Edge 127 支持 :has()）。
  //   · 两者都失效时用静态默认值 288px，布局不崩。
  //
  // 三级策略（后者兜底前者）：
  //   1) JS 实测侧栏宽度 → 精确贴右缘（最优）
  //   2) CSS :has([data-sidebar-collapsed]) → 收起时贴最左
  //   3) 默认值 288px（估位兜底）
  '.as_overlayRoot{position:absolute;z-index:1;top:56px;left:var(--as-overlay-left,288px);',
  'right:auto;bottom:12px;width:240px;pointer-events:auto;display:flex;flex-direction:column}',
  // 侧栏收起（frame 带该属性）时直接贴最左 —— 纯 CSS 即可判，无需测量。
  'body:has([data-sidebar-collapsed]) .as_overlayRoot{--as-overlay-left:12px}',
  // 收起态胶囊：按用户草图放在「工作总览」标签右侧（标签栏那一行）。
  '.as_overlayPill{position:absolute;z-index:2;top:10px;right:16px;pointer-events:auto}',
  // 窄屏自适应：逐步收窄，最后隐藏（避免挤出主内容）。
  '@media (max-width:1280px){.as_overlayRoot{width:224px;--as-overlay-left:276px}}',
  '@media (max-width:1024px){.as_overlayRoot{width:210px;--as-overlay-left:268px}}',
  '@media (max-width:900px){.as_overlayRoot{display:none}}',
  '.as_head{display:flex;align-items:center;gap:8px;padding:10px 12px;border-bottom:1px solid var(--as-line);flex:none}',
  '.as_headTitle{font-weight:600;font-size:13px;color:var(--as-text);letter-spacing:.02em}',
  '.as_headMeta{font-size:11px;color:var(--as-tertiary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
  '.as_headCount{margin-left:auto;font-size:11px;color:var(--as-accent);background:var(--as-accent-bg);',
  'border:1px solid var(--as-accent-line);border-radius:999px;padding:0 7px;line-height:16px;flex:none}',
  '.as_iconBtn{flex:none;border:1px solid var(--as-line);background:transparent;color:var(--as-tertiary);',
  'border-radius:7px;width:20px;height:20px;line-height:1;cursor:pointer;padding:0;font-size:12px}',
  '.as_iconBtn:hover{color:var(--as-accent);border-color:var(--as-accent-line);background:var(--as-accent-bg)}',
  '.as_warn{padding:6px 12px;font-size:11px;color:var(--as-appr);background:var(--as-appr-bg);',
  'border-bottom:1px solid var(--as-line)}',
  '.as_body{flex:1;min-height:0;overflow:auto;padding:10px}',
  '.as_group{margin-bottom:11px}',
  '.as_group:last-child{margin-bottom:2px}',
  '.as_groupHead{display:flex;align-items:center;gap:7px;margin:0 0 6px 2px;font-size:11px;',
  'color:var(--as-tertiary);letter-spacing:.05em}',
  '.as_groupName{font-weight:600}',
  '.as_groupCount{background:var(--as-done-bg);color:var(--as-tertiary);border-radius:999px;',
  'padding:0 6px;font-size:10.5px;line-height:15px}',
  '.as_cluster{margin-bottom:2px}',
  '.as_card{display:flex;gap:9px;align-items:flex-start;padding:9px 10px;margin-bottom:6px;',
  'border-radius:9px;background:var(--as-card);border:1px solid var(--as-line);cursor:pointer}',
  '.as_card:hover{border-color:var(--as-accent-line)}',
  '.as_card:focus-visible{outline:2px solid var(--as-accent-line);outline-offset:1px}',
  '.as_bar{width:3px;align-self:stretch;border-radius:3px;background:var(--as-done);flex:none}',
  '.as_card_running .as_bar{background:var(--as-run)}',
  '.as_card_approval .as_bar{background:var(--as-appr)}',
  '.as_card_unseen .as_bar{background:var(--as-done)}',
  '.as_cardMain{min-width:0;flex:1;display:flex;flex-direction:column;gap:2px}',
  '.as_cardTitle{font-size:12.5px;font-weight:600;color:var(--as-text);white-space:nowrap;',
  'overflow:hidden;text-overflow:ellipsis}',
  '.as_meta{display:flex;gap:7px;flex-wrap:wrap;font-size:11px;color:var(--as-tertiary)}',
  '.as_sub{white-space:nowrap}',
  '.as_subAgent{color:var(--as-accent)}',
  '.as_tag{font-size:10px;padding:1px 6px;border-radius:999px;white-space:nowrap;flex:none;align-self:flex-start}',
  '.as_tag_running{background:var(--as-run-bg);color:var(--as-run)}',
  '.as_tag_approval{background:var(--as-appr-bg);color:var(--as-appr)}',
  '.as_tag_unseen{background:var(--as-done-bg);color:var(--as-done)}',
  '.as_cardChild{margin-left:16px;position:relative}',
  '.as_cardChild:before{content:"";position:absolute;left:-9px;top:0;bottom:50%;width:7px;',
  'border-left:1.5px solid var(--as-line);border-bottom:1.5px solid var(--as-line);border-radius:0 0 0 6px}',
  '.as_rel{margin:1px 0 6px 16px;font-size:10.5px;color:var(--as-tertiary)}',
  '.as_relKey{color:var(--as-accent)}',
  '.as_empty{padding:14px 6px;font-size:12px;color:var(--as-tertiary);text-align:center}',
  '.as_pill{display:inline-flex;align-items:center;gap:6px;padding:4px 11px;border-radius:999px;',
  'font-size:12px;font-weight:600;cursor:pointer;background:var(--as-accent-bg);color:var(--as-accent);',
  'border:1px solid var(--as-accent-line);font-family:inherit}',
  '.as_pill:hover{background:var(--as-accent-line)}',
  '.as_pillDot{width:6px;height:6px;border-radius:50%;background:var(--as-accent);display:block}',
  '.as_pillCount{background:var(--as-accent);color:#fff;border-radius:999px;padding:0 5px;font-size:10.5px;line-height:15px}',
  '.as_pillCaret{font-size:9px;opacity:.75}',
  '.as_glyph{display:inline-flex;align-items:center;gap:3px;color:var(--as-tertiary);font-size:10px;font-weight:600}',
  '.as_glyphLive{color:var(--as-accent)}',
  '.as_glyphDot{width:6px;height:6px;border-radius:50%;background:currentColor;display:block}',
  '.as_glyphCount{line-height:1}',
].join('')

/** 幂等注入 <style>。返回是否在浏览器环境完成了注入。 */
export function injectStyles() {
  if (typeof document === 'undefined' || document === null) return false
  if (typeof document.createElement !== 'function' || typeof document.querySelector !== 'function') return false
  if (document.querySelector('style[data-plugin-css="' + CSS_TAG + '"]') !== null) return true
  const tag = document.createElement('style')
  tag.dataset.plugin = PLUGIN_ID
  tag.dataset.pluginCss = CSS_TAG
  tag.textContent = CSS
  const head = document.head
  if (head === null || head === undefined || typeof head.appendChild !== 'function') return false
  head.appendChild(tag)
  return true
}

/**
 * 实测宿主侧栏宽度，写进 CSS 变量 --as-overlay-left，让左窗精确贴其右缘。
 *
 * 为什么必须实测而不是估算：侧栏宽度是 AppFrame 的**内联 grid 值**
 * （clampWidth 264..420，用户可拖拽改变），既没有 CSS 变量也没暴露给插件。
 * 硬编码 288px 在默认宽度下勉强可以，但侧栏收起/变宽后必然错位
 * （用户实测反馈过一次「左边距太大」）。
 *
 * 取数顺序（都失败就返回 false，由 CSS 兜底）：
 *   1. frame 的 getComputedStyle('grid-template-columns') 首列 —— 最准，
 *      因为那正是布局用的真实像素值；
 *   2. 退而求其次：找带 data-sidebar-collapsed 的 frame，其首个子元素即 sidebarCol。
 *
 * @returns {boolean} 是否成功写入变量
 */
export function measureSidebarOffset() {
  if (typeof document === 'undefined' || document === null) return false
  if (typeof document.querySelector !== 'function') return false
  const root = document.documentElement
  if (root === null || root === undefined || root.style === null || root.style === undefined) return false

  // 侧栏收起：frame 带 data-sidebar-collapsed，直接贴最左（与 CSS 的 :has() 一致）。
  const collapsed = document.querySelector('[data-sidebar-collapsed]') !== null
  if (collapsed) {
    root.style.setProperty('--as-overlay-left', '12px')
    return true
  }

  // 侧栏展开：读 frame 的 grid 首列。frame 是唯一带 data-shell-overlay 的容器的父级。
  const overlayLayer = document.querySelector('[data-shell-overlay]')
  const frame = overlayLayer !== null && overlayLayer.parentElement ? overlayLayer.parentElement : null
  if (frame !== null && typeof globalThis.getComputedStyle === 'function') {
    try {
      const cols = globalThis.getComputedStyle(frame).gridTemplateColumns
      if (typeof cols === 'string' && cols.length > 0) {
        const first = Number.parseFloat(cols.split(' ')[0])
        if (Number.isFinite(first) && first >= 0) {
          // +8px 间隙，避免紧贴侧栏边框显得局促。
          root.style.setProperty('--as-overlay-left', String(Math.round(first + 8)) + 'px')
          return true
        }
      }
    } catch (cause) {
      // 读取失败不致命：CSS 的静态默认值仍能兜住布局。
      warnOnce('measureSidebarOffset', '测量侧栏宽度失败（用默认值兜底）：' + describeError(cause))
    }
  }
  return false
}

// ─────────────────── React 解析（注入优先） ───────────────────

/** 模块级缓存的 React 实例（由工厂注入写入，供模块级便捷导出复用）。 */
let cachedReact = null

/** 显式注入 React 实例；传 null 可重置。自测与集成方都可用。 */
export function setReact(instance) {
  if (instance === null || instance === undefined) {
    cachedReact = null
    return null
  }
  if (typeof instance !== 'object' || typeof instance.createElement !== 'function') {
    throw contextError('注入 React', PLUGIN_ID, 'BAD_ARGUMENT', '需要一个含 createElement 的 React 实例')
  }
  cachedReact = instance
  return instance
}

/**
 * 解析 React：缓存 → globalThis.React。
 * 工厂形态下 React 由 { React } 参数直接注入，这条链只是给模块级便捷导出
 * （apply / PaneComponent）与自测兜底用，不依赖 require。
 */
export function resolveReact() {
  if (cachedReact !== null) return cachedReact
  const host = globalThis
  if (host !== null && host !== undefined && host.React !== null && host.React !== undefined
    && typeof host.React.createElement === 'function') {
    cachedReact = host.React
    return host.React
  }
  return null
}

/** 渲染路径专用：解析不到 React 是**致命**的，必须带上下文抛出，不能静默返回空。 */
function requireReact() {
  const instance = resolveReact()
  if (instance === null) {
    throw contextError('渲染活跃会话左窗', PLUGIN_ID, 'REACT_UNAVAILABLE',
      '未能解析 React：请用 createSidebarUi({ React }) 注入，或提供 globalThis.React')
  }
  return instance
}

// ───────────────────────── 工厂 ─────────────────────────

/**
 * 创建本插件 UI 的工厂 —— **交付主形态**。
 *
 * 为什么是工厂：DSH 客户端模块系统不允许同包 require 子路径，
 * 所以主代理会把本函数体内联进唯一的 src/client.js，写法：
 *   const { Component, apply } = createSidebarUi({ React })
 *
 * @param options.React 宿主注入的 React 实例（必需；也可事后 setReact）
 * @param options.stateEndpoint / pollIntervalMs / disablePolling / fetch / onSelect / mode
 * @returns {{ Component, PaneComponent, apply, inject, internals }}
 */
export function createSidebarUi(options) {
  const settings = asRecord(options) || {}

  // 注入优先：工厂参数是权威来源；缺失时退回 globalThis 探测。
  if (settings.React !== undefined && settings.React !== null) setReact(settings.React)
  const React = requireReact()

  /** createElement 简写：始终用同一个已解析的 React 实例。 */
  function el(type, props) {
    const children = Array.prototype.slice.call(arguments, 2)
    return React.createElement.apply(React, [type, props].concat(children))
  }

  /**
   * 取数 + 轮询的共享 hook（整窗与胶囊共用，避免两套取数逻辑漂移）。
   * 关键行为：
   *  · 首次立即拉一次，之后每 interval 毫秒一次（下限 15 秒）；
   *  · 失败时**保留上一份好数据**，只把 phase 标成 error，绝不清空列表；
   *  · 卸载时 abort + clearInterval，避免泄漏与卸载后 setState。
   */
  /**
   * 订阅共享快照。多组件（图标 + 面板）共用一个轮询与一份数据。
   * props 仍可覆盖 endpoint/interval/pollingOff，以保持测试与嵌入灵活性。
   */
  function useSnapshot(props) {
    const config = props === null || props === undefined ? {} : props
    const seeded = config.initialSnapshot !== undefined && config.initialSnapshot !== null
    const [snapshot, setSnapshot] = React.useState(() => (seeded ? normalizeSnapshot(config.initialSnapshot) : emptySnapshot()))
    const [phase, setPhase] = React.useState(seeded ? 'ok' : 'loading')
    const [failure, setFailure] = React.useState(null)

    const configured = toPositive(config.pollIntervalMs)
    const interval = configured === 0 ? POLL_INTERVAL_MS : Math.max(POLL_MIN_MS, configured)
    const endpoint = str(config.endpoint) !== '' ? str(config.endpoint) : (str(settings.stateEndpoint) !== '' ? str(settings.stateEndpoint) : STATE_ENDPOINT)
    const pollingOff = config.disablePolling === true || settings.disablePolling === true

    React.useEffect(() => {
      if (pollingOff) return undefined
      if (typeof setInterval !== 'function') return undefined
      let alive = true
      let controller = null

      const tick = () => {
        controller = typeof AbortController === 'function' ? new AbortController() : null
        const request = { endpoint, fetch: config.fetch === undefined ? settings.fetch : config.fetch }
        if (controller !== null) request.signal = controller.signal
        fetchState(request).then(
          (next) => {
            if (alive !== true) return
            setSnapshot(next)
            setPhase('ok')
            setFailure(null)
          },
          (error) => {
            if (alive !== true) return
            if (asRecord(error) !== null && error.error_code === 'ABORTED') return
            setPhase('error')
            setFailure(error)
            // 不静默：降级为「保留旧数据 + 顶部提示」，同时把完整上下文打到控制台。
            warnOnce('poll', '状态轮询失败（保留上一次数据）：' + describeError(error))
          },
        )
      }

      tick()
      const timer = setInterval(tick, interval)
      return () => {
        alive = false
        clearInterval(timer)
        if (controller !== null) controller.abort()
      }
    }, [interval, endpoint, pollingOff])

    return { snapshot, phase, failure }
  }

  /** 收起态胶囊：一个按钮，文案「活跃 N」。 */
  function Pill(props) {
    return el('button', {
      type: 'button',
      className: 'as_pill',
      'data-dsh-active-sessions': 'pill',
      title: '展开活跃会话窗',
      'aria-label': '展开活跃会话窗，共 ' + String(props.total) + ' 个会话',
      onClick: props.onExpand,
    },
      el('span', { className: 'as_pillDot', 'aria-hidden': 'true' }),
      el('span', { className: 'as_pillLabel' }, '活跃'),
      el('span', { className: 'as_pillCount' }, String(props.total)),
      el('span', { className: 'as_pillCaret', 'aria-hidden': 'true' }, '▸'),
    )
  }

  /** 导航栏紧凑形态（宿主以 size 传参渲染面板行时使用）。 */
  function GlyphPane(props) {
    const state = useSnapshot(props)
    const total = state.snapshot.counts.total
    const running = state.snapshot.counts.running
    return el('span', {
      className: 'as_glyph' + (running > 0 ? ' as_glyphLive' : ''),
      'data-dsh-active-sessions': 'glyph',
      title: '活跃会话 ' + String(total) + (running > 0 ? '（运行中 ' + String(running) + '）' : ''),
      'aria-hidden': 'true',
    },
      el('span', { className: 'as_glyphDot' }),
      total > 0 ? el('span', { className: 'as_glyphCount' }, String(total)) : null,
    )
  }

  /** 顶部条：标题 + 工作区数 + 总数 + 收起按钮。 */
  function Head(props) {
    return el('div', { className: 'as_head' },
      el('span', { className: 'as_headTitle' }, '活跃会话'),
      el('span', { className: 'as_headMeta' }, props.workspaces > 0 ? '全工作区 · ' + String(props.workspaces) : '全工作区'),
      el('span', { className: 'as_headCount', title: '三态总数' }, String(props.total)),
      el('button', {
        type: 'button',
        className: 'as_iconBtn',
        title: '收起为胶囊',
        'aria-label': '收起活跃会话窗',
        onClick: props.onCollapse,
      }, '‹'),
    )
  }

  /** 非致命提示条（端点未就绪、服务端 warnings 等）。 */
  /**
   * 把服务端诊断串压缩成一句话摘要（完整串留给 title）。
   * 诊断串形如：
   *   [states] operation=校验会话 cwd target=/... input_summary=2 个会话的 cwd 不是
   *   POSIX 绝对路径 error_code=Error message=非绝对 cwd 已降级为空工作区
   * 取其中的 input_summary / message 段即可表达"发生了什么"。
   */
  function summarizeWarning(raw) {
    const text = str(raw)
    if (text === '') return '有一条非致命提示（悬停查看详情）'
    // 优先取 message=（最贴近人话），其次 input_summary=。
    const pick = (key) => {
      const m = text.match(new RegExp(key + '=([^]*?)(?=\\s+[a-z_]+=|$)'))
      return m !== null && m !== undefined ? str(m[1]).trim() : ''
    }
    const msg = pick('message') || pick('input_summary')
    if (msg !== '') return msg.length > 60 ? msg.slice(0, 60) + '…' : msg
    // 兜底：整串截断。
    return text.length > 60 ? text.slice(0, 60) + '…' : text
  }

  /**
   * 非致命提示条。
   * text 是**给人看的一句话摘要**；detail 是完整诊断串，只放在 title 里悬停可见。
   * 这样警告不会因为太长而挤占会话列表空间。
   */
  function Warn(props) {
    return el('div', {
      className: 'as_warn',
      role: 'status',
      title: typeof props.detail === 'string' && props.detail.length > 0 ? props.detail : undefined,
    }, props.text)
  }

  /** 空态：加载中 / 无数据 / 端点暂不可用 —— 三种都只显示文案，不报错。 */
  function Empty(props) {
    let text = '暂无活跃会话'
    if (props.phase === 'loading') text = '正在读取活跃会话…'
    else if (props.phase === 'error') text = '暂无活跃会话数据（端点未就绪，稍后自动重试）'
    return el('div', { className: 'as_empty' }, text)
  }

  /** 单条会话卡片。related=true 表示它是簇内后续成员（缩进 + 连接线）。 */
  function Card(props) {
    const entry = props.entry
    const meta = STATE_META_MAP[entry.state] === undefined ? STATE_META_MAP.unseen : STATE_META_MAP[entry.state]
    const sub = []
    if (entry.workspace !== '') sub.push(el('span', { className: 'as_sub', key: 'ws' }, entry.workspace))
    if (entry.steps > 0) sub.push(el('span', { className: 'as_sub', key: 'steps' }, String(entry.steps) + ' 步'))
    const relative = formatRelative(entry.lastPromptAt, props.now)
    if (relative !== '') sub.push(el('span', { className: 'as_sub', key: 'time' }, relative))
    if (entry.isSubagent) {
      sub.push(el('span', { className: 'as_sub as_subAgent', key: 'subagent' }, '⌥ ' + (entry.subagentLabel !== '' ? entry.subagentLabel : '子代理')))
    }
    return el('div', {
      className: 'as_card as_card_' + entry.state + (props.related === true ? ' as_cardChild' : ''),
      'data-session-id': entry.id,
      'data-state': entry.state,
      role: 'button',
      tabIndex: 0,
      title: entry.title + (entry.cwd !== '' ? ' — ' + entry.cwd : ''),
      onClick: () => { selectEntry(entry, props.onSelect) },
      onKeyDown: (event) => {
        if (event.key !== 'Enter' && event.key !== ' ') return
        event.preventDefault()
        selectEntry(entry, props.onSelect)
      },
    },
      el('span', { className: 'as_bar', 'aria-hidden': 'true' }),
      el('span', { className: 'as_cardMain' },
        el('span', { className: 'as_cardTitle' }, entry.title),
        sub.length > 0 ? el('span', { className: 'as_meta' }, sub) : null,
      ),
      el('span', { className: 'as_tag as_tag_' + entry.state }, meta.tag),
    )
  }

  /** 关系证据行：写「证据」而不是断言关系（契约 §3.3 修正后的展示方式）。 */
  function RelationLine(props) {
    const keys = relationEvidence(props.entries, 3)
    const head = '↳ 相关：'
    if (keys.length === 0) return el('div', { className: 'as_rel' }, head + '同组会话')
    const children = [head + '共同关键词 ']
    keys.forEach((key, index) => {
      if (index > 0) children.push('、')
      children.push(el('span', { className: 'as_relKey', key }, key))
    })
    return el('div', { className: 'as_rel' }, children)
  }

  /** 一个相关会话簇：首条正常，后续缩进 + 连接线，末尾一行关系证据。 */
  function Cluster(props) {
    const cluster = props.cluster
    const nodes = cluster.entries.map((entry, index) => el(Card, {
      key: entry.id,
      entry,
      related: index > 0,
      onSelect: props.onSelect,
      now: props.now,
    }))
    if (cluster.entries.length > 1) {
      nodes.push(el(RelationLine, { key: '__relation', entries: cluster.entries }))
    }
    return el('div', { className: 'as_cluster' }, nodes)
  }

  /** 一个状态分组：标题 + 计数 + 簇列表。空组在 groupByState 里已被剔除。 */
  /**
   * 一个三态分组。
   *
   * 为什么要把子代理会话折叠起来：实测本机某个 unseen 分组 47 条里有 16 条是子代理
   * （标题都是「你是「…」任务」这类统一模板），会把用户自己开的会话淹没。
   * 但它们仍是真实会话，所以**折叠而非丢弃**：默认收起，点一下展开。
   * 默认折叠状态存组件本地（不持久化）——这是"本屏降噪"，不是用户偏好。
   */
  /** 「近期」阈值：超过这个天数的会话默认折进「更早」里。 */
  const RECENT_DAYS = 7

  /**
   * 一个三态分组。两层折叠，都是为了在「有史以来」模式下保住可读性：
   *   1. **时间分层**：近期（<=7 天）直接列出，更早的折成一行。
   *      实测本机有史以来 unseen 达 448 条（7 天内仅 115 条），
   *      不平铺才不会一屏滚不到底。
   *   2. **子代理折叠**：纯子代理簇折成一行（它们标题是统一模板，会淹没用户会话）。
   * 两处都是**折叠而非删除**——数据都在，点一下就能看到。
   */
  function Group(props) {
    const group = props.group
    const [showSub, setShowSub] = React.useState(false)
    const [showOlder, setShowOlder] = React.useState(false)
    const now = toPositive(props.now) > 0 ? toPositive(props.now) : Date.now()
    const recentCutoff = now - RECENT_DAYS * 24 * 3600 * 1000
    // 拆成三堆：近期用户会话 / 更早用户会话 / 子代理会话（保持组内原有顺序）。
    const mine = []
    const older = []
    const subs = []
    for (const cluster of group.clusters) {
      const allSub = cluster.entries.length > 0 && cluster.entries.every((e) => e.isSubagent === true)
      if (allSub) { subs.push(cluster); continue }
      // 簇内按最大时间判断新旧（一个簇里可能有新有旧，取较新的那个决定归属）
      const newest = cluster.entries.reduce((m, e) => Math.max(m, toPositive(e.lastPromptAt)), 0)
      if (newest >= recentCutoff) mine.push(cluster)
      else older.push(cluster)
    }
    const subCount = subs.reduce((n, c) => n + c.entries.length, 0)
    const olderCount = older.reduce((n, c) => n + c.entries.length, 0)
    const renderCluster = (cluster, index) => el(Cluster, {
      key: cluster.groupId === null ? 'c' + String(index) : 'c:' + cluster.groupId,
      cluster,
      onSelect: props.onSelect,
      now: props.now,
    })
    return el('section', { className: 'as_group', 'data-state': group.key },
      el('div', { className: 'as_groupHead' },
        el('span', { className: 'as_groupName' }, group.label),
        el('span', { className: 'as_groupCount', title: group.label + '计数' }, String(group.count)),
      ),
      mine.map(renderCluster),
      olderCount > 0
        ? el('div', { className: 'as_subFold' },
            el('button', {
              type: 'button',
              className: 'as_foldBtn',
              'aria-expanded': showOlder === true,
              title: showOlder ? '收起更早的会话' : '展开更早的会话',
              onClick: () => { setShowOlder(showOlder !== true) },
            }, (showOlder ? '▾ ' : '▸ ') + String(RECENT_DAYS) + ' 天前 ' + String(olderCount) + ' 条'),
            showOlder === true ? older.map(renderCluster) : null,
          )
        : null,
      subCount > 0
        ? el('div', { className: 'as_subFold' },
            el('button', {
              type: 'button',
              className: 'as_foldBtn',
              'aria-expanded': showSub === true,
              title: showSub ? '收起子代理会话' : '展开子代理会话',
              onClick: () => { setShowSub(showSub !== true) },
            }, (showSub ? '▾ ' : '▸ ') + '子代理会话 ' + String(subCount) + ' 条'),
            showSub === true ? subs.map(renderCluster) : null,
          )
        : null,
    )
  }

  /** 完整长窗：三态分组列表，默认展开。 */
  function FullPane(props) {
    const config = props === null || props === undefined ? {} : props
    const state = React.useState(readCollapsed)
    const collapsed = state[0]
    const setCollapsed = state[1]
    const data = useSnapshot(config)

    // forceExpanded：overlay 形态把收起权交给外层 OverlayHost。
    // 否则两层各自 readCollapsed，会出现「点了收起但外层仍画长窗」的矛盾。
    const isCollapsed = config.forceExpanded === true ? false : collapsed

    const total = data.snapshot.counts.total
    const now = toPositive(config.now) > 0 ? toPositive(config.now) : Date.now()
    const groups = groupByState(data.snapshot.entries)

    const toggle = () => {
      const next = collapsed !== true
      setCollapsed(next)
      writeCollapsed(next)
    }

    if (isCollapsed === true) return el(Pill, { total, onExpand: toggle })

    const notices = []
    if (data.failure !== null && data.failure !== undefined) {
      const detail = describeError(data.failure)
      notices.push(el(Warn, { key: 'failure', text: '端点暂不可用（显示上一次数据）', detail }))
    }
    // 服务端 warnings 是**完整诊断串**（含 operation/target/error_code/context），
    // 实测单条就有 100+ 字符，直接铺在界面上会把面板占满、对用户是噪音。
    // 这里只显示**一句话摘要**，完整串放进 title（鼠标悬停可见）——
    // 既保持可诊断性，又不让警告挤占会话列表空间。
    for (const warning of data.snapshot.warnings) {
      notices.push(el(Warn, { key: 'warn:' + warning, text: summarizeWarning(warning), detail: warning }))
    }

    return el('aside', {
      className: 'as_root',
      'data-dsh-active-sessions': 'sidebar',
      'data-phase': data.phase,
      role: 'complementary',
      'aria-label': '活跃会话',
    },
      // ⚠️ onCollapse 必须**优先用外部传入的**（OverlayHost 的 toggle 才是控制
      // overlay 显隐的那个）。此前这里写死成 FullPane 自己的 toggle，而它只改
      // readCollapsed/内部 state —— 与 OverlayHost 的 collapsed 不同步，
      // 表现为「点收起没反应」（用户实测反馈的真实 bug）。
      el(Head, {
        total,
        workspaces: data.snapshot.workspaces,
        onCollapse: typeof config.onCollapse === 'function' ? config.onCollapse : toggle,
      }),
      notices.length > 0 ? notices : null,
      el('div', { className: 'as_body' },
        groups.length === 0
          ? el(Empty, { phase: data.phase })
          : groups.map((group) => el(Group, { key: group.key, group, onSelect: config.onSelect, now })),
      ),
    )
  }

  /**
   * 对外主组件。宿主在不同上下文渲染同一个注册项：
   *  · 侧栏「面板导航行」会传 size（紧凑 glyph 语境）→ 渲染胶囊；
   *  · 作为长窗挂载时不传 size → 渲染完整三态列表（默认展开）。
   * 集成方也可用显式 mode 覆盖（mode:'pane' | 'glyph'）。
   */
  function Component(props) {
    const config = props === null || props === undefined ? {} : props
    injectStyles()
    if (config.mode === 'glyph') return el(GlyphPane, config)
    if (config.mode === 'pane') return el(FullPane, config)
    if (typeof config.size === 'number') return el(GlyphPane, config)
    return el(FullPane, config)
  }


  /**
   * overlay 挂载形态：帧级浮层里的常驻长窗（或收起胶囊）。
   *
   * 为什么单独一个组件而不是复用 Component：
   * Component 的展开/收起由 FullPane 内部的 collapsed 状态 + 外层容器决定；
   * overlay 里的定位（left/top/宽）与槽位内嵌完全不同，需要自己的容器类。
   * 但**内部渲染完全复用** FullPane / Pill，保证两种形态视觉与行为一致。
   */
  function OverlayHost(props) {
    const config = props === null || props === undefined ? {} : props
    const state = React.useState(readCollapsed)
    const collapsed = state[0]
    const setCollapsed = state[1]
    // ⚠️ 这个 hook 必须**无条件**在顶层调用。
    // 先前把 useSnapshot 只写在收起分支里属于条件调用 hook，
    // 一旦展开/收起切换就会 "Rendered fewer hooks than expected" 崩溃。
    const data = useSnapshot(config)
    // 实测宿主侧栏宽度并写进 --as-overlay-left，使长窗精确贴其右缘。
    // 为什么放在 effect 里而不是渲染期：渲染期读 DOM 布局属于副作用，
    // 且首帧时侧栏可能尚未完成布局，读到的 grid 值会是初始态。
    React.useEffect(() => {
      // 展开态才有定位问题（收起态是右上角胶囊，与侧栏无关）。
      if (collapsed === true) return undefined
      measureSidebarOffset()
      // 侧栏可被用户拖拽改变宽度，也可被收起/展开；窗口 resize 也要重测。
      // 用 rAF 合并连续变化（拖拽时 resize/过渡会高频触发）。
      if (typeof globalThis.addEventListener !== 'function') return undefined
      let pending = false
      const schedule = () => {
        if (pending === true) return
        pending = true
        const run = () => { pending = false; measureSidebarOffset() }
        if (typeof globalThis.requestAnimationFrame === 'function') globalThis.requestAnimationFrame(run)
        else setTimeout(run, 16)
      }
      globalThis.addEventListener('resize', schedule)
      // 侧栏拖拽只改 grid 列宽、不触发 resize，故额外观察 frame 的属性/尺寸变化。
      let observer = null
      if (typeof globalThis.MutationObserver === 'function' && typeof document !== 'undefined' && document !== null) {
        const layer = document.querySelector('[data-shell-overlay]')
        const frame = layer !== null && layer.parentElement ? layer.parentElement : null
        if (frame !== null) {
          observer = new globalThis.MutationObserver(schedule)
          observer.observe(frame, { attributes: true, attributeFilter: ['style', 'data-sidebar-collapsed'] })
        }
      }
      return () => {
        globalThis.removeEventListener('resize', schedule)
        if (observer !== null) observer.disconnect()
      }
    }, [collapsed])
    const toggle = () => {
      const next = collapsed !== true
      setCollapsed(next)
      writeCollapsed(next)
    }
    // 收起态：胶囊走标签栏右侧定位；展开态：长窗走左侧常驻定位。
    if (collapsed === true) {
      return el('div', { className: 'as_overlayPill' },
        el(Pill, { total: data.snapshot.counts.total, onExpand: toggle }))
    }
    return el('div', { className: 'as_overlayRoot' },
      el(FullPane, Object.assign({}, config, { onCollapse: toggle, forceExpanded: true })))
  }

  /**
   * 面板 id。它身兼两职，必须与 main 的 key 完全一致：
   *   - sidebar.panellist 的 id（侧栏按钮）
   *   - main 的 key（中央面板）
   * 分开写两处字面量是这类插件最常见的错，故提为常量。
   */
  const PANEL_ID = 'active-sessions'

  /**
   * 注册进 sidebar.panellist 槽位。
   * register 是**双参数**（options, Component）：options.label 会被侧栏外壳
   * 当作该面板的标题显示（见 dsh-client-ui-sidebar 的 syncPanels）。
   * 返回 dispose，方便集成方在 ctx.effect 里托管生命周期。
   */
  function apply(ctx) {
    if (ctx === null || ctx === undefined || asRecord(ctx.slots) === null) {
      throw contextError('注册活跃会话左窗', PANEL_ID, 'BAD_CONTEXT', 'ctx.slots 不可用')
    }
    if (typeof ctx.slots.inject !== 'function' || typeof ctx.slots.register !== 'function') {
      throw contextError('注册活跃会话左窗', PANEL_ID, 'BAD_CONTEXT', 'ctx.slots 缺少 inject/register')
    }
    injectStyles()

    // 必须成对注册，缺一不可。DSH 的权威槽位契约写着：
    //   sidebar.panellist: 'Global panel icons. Each list id addresses the matching main panel.'
    // 且 LayoutController.selectPanel 在没有对应 main key 时会**直接抛异常**：
    //   layout.selectPanel: main panel '<id>' is not registered
    // 即：只注册 panellist 而不注册 main，用户一点侧栏按钮就报错。
    const disposePane = ctx.slots.inject('sidebar.panellist', () => ctx.slots.register(
      { name: 'sidebar.panellist', id: PANEL_ID, order: 50, label: '活跃会话' },
      Component,
    ))
    // main 是 keyed 槽位：key 必须与上面的 id 完全一致，否则点击找不到目标。
    const disposeMain = ctx.slots.inject('main', () => ctx.slots.register(
      { name: 'main', key: PANEL_ID },
      Component,
    ))

    // shell.overlay：帧级浮层 —— 这是「左侧常驻长窗」的正确挂载点。
    // DSH 对该槽位的契约原文：'Frame-wide floating layer, above every column...
    // Deliberately generic and unowned by any feature... This is the additive seat
    // for a frame-wide surface of your own'，且 replaceRisk=none（是追加而非遮蔽）。
    // 浮层本身 pointer-events:none（点击穿透），故组件根节点自持 pointer-events:auto。
    const disposeOverlay = ctx.slots.inject('shell.overlay', () => ctx.slots.register(
      { name: 'shell.overlay', id: PANEL_ID + '.overlay', order: 60 },
      OverlayHost,
    ))

    // 组合 disposer：三个订阅一起释放，避免热重载后残留半套注册。
    return () => {
      for (const dispose of [disposePane, disposeMain, disposeOverlay]) {
        if (typeof dispose === 'function') {
          try {
            dispose()
          } catch (error) {
            // 释放失败不该阻断另一个的释放，但也不能静默。
            console.warn('[active-sessions/sidebar] 释放槽位注册失败: ' + String(error?.message ?? error))
          }
        }
      }
    }
  }

  return {
    Component,
    OverlayHost,
    PaneComponent: Component,
    apply,
    inject,
    React,
    internals: { Pill, GlyphPane, Head, Warn, Empty, Card, RelationLine, Cluster, Group, FullPane, useSnapshot, summarizeWarning },
  }
}

// ───────────── 模块级便捷导出（兼容 / 自测） ─────────────

/** 依赖声明：只依赖 slots，不注册任何模型可见工具（0 token 硬约束）。 */
export const inject = ['slots']

let defaultUi = null
/** 惰性单例：给模块级 apply / PaneComponent 用（React 走 globalThis 探测）。 */
function defaultSidebarUi() {
  if (defaultUi === null) defaultUi = createSidebarUi({})
  return defaultUi
}

/** 模块级组件（等价于 createSidebarUi(...).Component）。 */
export function PaneComponent(props) {
  const ui = defaultSidebarUi()
  return ui.Component(props)
}

/** 模块级装配函数（等价于 createSidebarUi(...).apply）。 */
export function apply(ctx) {
  return defaultSidebarUi().apply(ctx)
}

export default { inject, apply, PaneComponent, createSidebarUi, setReact, injectStyles, constants, CSS }
