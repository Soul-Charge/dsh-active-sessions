// dsh-active-sessions - 客户端装配层（浏览器）
// 【单文件原因】一包一入口，且 factory(require) 不能解析同包子路径。
// 【内联注意】只剔除 export default；模块级 inject 必须保留。
// 【挂载点】shell.overlay / sidebar.panellist + main / conversation.view。
window.__ModuleLoader__.load({
  id: 'dsh-active-sessions',
  factory: (require) => {
    const React = require("react")
    const createSidebarUi = (() => {
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
    const GEOMETRY_KEY = 'dsh-active-sessions.geometry'
    const LOCKED_KEY = 'dsh-active-sessions.locked'
    /**
     * 「已完成未查看」时间筛选的持久化键（问题二）。
     * 取值 'recent'（默认，最近 7 天）| 'all'（有史以来）。沿用既有 dsh-active-sessions.* 命名。
     */
    const UNSEEN_FILTER_KEY = 'dsh-active-sessions.unseenFilter'
    /** 「全部标记已读」按钮文案里用的天数，必须与默认筛选窗口一致。 */
    const UNSEEN_RECENT_DAYS = 7
    /** 宽度范围：下界保证标题栏三个按钮不挤爆，上界避免吃掉主内容。 */
    const OVERLAY_MIN_WIDTH = 180
    const OVERLAY_MAX_WIDTH = 420
    /**
     * 窄窗阈值（px）：宽度 <= 此值时给 .as_overlayRoot 加 as_narrow，隐藏 .as_headMeta。
     * 推导写在 CSS 注释里：头部固定件约 155px，留给 meta 少于约 41px 时省略号已无信息量。
     */
    const OVERLAY_NARROW_WIDTH = 220
    /** 高度下界：低于它标题栏 + 一张卡片都放不下。 */
    const OVERLAY_MIN_HEIGHT = 240
    /** 默认宽度：保持改造前观感，用户第一次打开不觉得变样了。 */
    const OVERLAY_DEFAULT_WIDTH = 240
    /** 默认高度 = min(70vh, 本值)。 */
    const OVERLAY_MAX_DEFAULT_HEIGHT = 640
    const OVERLAY_DEFAULT_VH = 0.7
    /** 下缘与视口底部的最小间距。 */
    const OVERLAY_GAP = 12
    /**
     * top 的**兜底常量** = 宿主会话头部实测高 76 + 间距 12 = 88。
     * 真实值一律由 measureOverlayTop() 运行时实测写入 --as-overlay-top，
     * 因为该头部只在「打开会话」时存在（新会话首页没有），写死常量必错。
     */
    const OVERLAY_TOP_FALLBACK = 88
    /**
     * 按几何特征识别宿主会话头部的合理区间。
     * 宿主类名带 hash 写不了选择器，但形状稳定：贴顶、高 40..120、宽 > 600。
     */
    const HOST_HEADER_MIN_H = 40
    const HOST_HEADER_MAX_H = 120
    const HOST_HEADER_MIN_W = 600
    /** 插件 id，用于 <style> 标签归属与错误上下文。 */
    const PLUGIN_ID = 'dsh-active-sessions'
    /** 跨插件选中会话的解耦事件名（不写死到别人的导航接口里）。 */
    const SELECT_EVENT = 'dsh-active-sessions:select'
    /**
     * 跳转失败事件（2026-10-07 新增）。
     *
     * 为什么需要：selectEntry 的返回值**没有任何调用方消费**，导致「点击卡片但没跳转」
     * 在界面上完全不可见 —— 真机验收时点卡片毫无反应、控制台也没有任何告警，
     * 用户只能认为插件坏了却无法反馈。失败必须显式派发成事件，由 UI 层渲染成提示条。
     */
    const NAVIGATION_EVENT = 'dsh-active-sessions:navigation-failed'
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
    const constants = {
      MODULE_ID,
      PLUGIN_ID,
      STATE_ENDPOINT,
      POLL_INTERVAL_MS,
      POLL_MIN_MS,
      STORAGE_KEY,
      GEOMETRY_KEY,
      LOCKED_KEY,
      OVERLAY_MIN_WIDTH,
      OVERLAY_MAX_WIDTH,
      OVERLAY_MIN_HEIGHT,
      OVERLAY_DEFAULT_WIDTH,
      OVERLAY_NARROW_WIDTH,
      OVERLAY_MAX_DEFAULT_HEIGHT,
      OVERLAY_GAP,
      OVERLAY_TOP_FALLBACK,
      SELECT_EVENT,
      NAVIGATION_EVENT,
      CSS_TAG,
    }

    // ──────────────────── 错误上下文（禁止静默吞错） ────────────────────

    /**
     * 构造带 operation / target / error_code 上下文的错误。
     * 项目规范要求任何失败都能定位「在做什么、对谁做、为什么失败」，
     * 所以错误对象上同时挂结构化字段，便于上层按 error_code 分支。
     */
    function contextError(operation, target, errorCode, detail) {
      const suffix = detail === undefined || detail === null || detail === '' ? '' : ' detail=' + String(detail)
      const error = new Error('[' + operation + '] target=' + target + ' error_code=' + errorCode + suffix)
      error.operation = operation
      error.target = target
      error.error_code = errorCode
      if (detail !== undefined && detail !== null && detail !== '') error.detail = String(detail)
      return error
    }

    /** 把任意异常压成一行可读文本；异常本身也可能是不可信对象。 */
    function describeError(error) {
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
    function asRecord(value) {
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
    function workspaceOf(cwd) {
      if (typeof cwd !== 'string' || cwd === '') return ''
      const normalized = cwd.split(BACKSLASH).join('/')
      const parts = normalized.split('/').filter((part) => part !== '')
      return parts.length > 0 ? parts[parts.length - 1] : ''
    }

    /** 相对时间显示。时间戳为 0（未知）返回空串，让调用方决定是否省略这一段。 */
    function formatRelative(timestamp, now) {
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
    function emptySnapshot() {
      return { generatedAt: 0, counts: { running: 0, approval: 0, unseen: 0, total: 0 }, workspaces: 0, entries: [], warnings: [] }
    }

    /** 单条会话的窄化：缺 id 视为不可用条目，整条丢弃而不是伪造一个。 */
    function normalizeEntry(raw) {
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
    function normalizeSnapshot(raw) {
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
    function sortEntries(entries) {
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
    function clusterByGroup(entries) {
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
    function relationEvidence(entries, limit) {
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
    function groupByState(entries) {
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
    async function fetchState(options) {
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
    function readCollapsed() {
      try {
        if (typeof localStorage === 'undefined' || localStorage === null) return false
        return localStorage.getItem(STORAGE_KEY) === '1'
      } catch (cause) {
        warnOnce('readCollapsed', 'localStorage 不可读，按默认展开处理：' + describeError(cause))
        return false
      }
    }

    /**
     * 收起状态的跨组件订阅表（模块级）。
     *
     * 为什么需要它（2026-10-05 补修）：胶囊被删掉之后，浮层里**没有任何 UI 能把它叫回来** ——
     * writeCollapsed 原本只有 FullPane/OverlayHost 两个调用点，都在各自的 toggle 里，
     * 而这两个 toggle 只在浮层**可见时**才可能被点到。持久化又让状态跨刷新存活，
     * 于是「收起」成了一道单向门。
     *
     * 唤回入口选在 Component（侧栏图标 / main 面板）挂载时，理由：
     *   · 用户点侧栏「活跃会话」图标的语义就是「我想看活跃会话」，唤回浮层符合预期；
     *   · 不把 GlyphPane 本身做成可点元素 —— 它被宿主渲染在宿主自己的按钮内部，
     *     再塞可点元素会产生嵌套交互与无障碍问题；
     *   · Component 与 OverlayHost 同处 createSidebarUi 闭包，共享模块作用域，无需任何全局事件。
     *
     * 刻意做成**发布订阅**而不是让 Component 直接改 OverlayHost 的 state：
     * 这样两个组件之间没有反向依赖，将来多一个入口（比如快捷键）只要再订阅一个即可。
     */
    const collapseSubscribers = new Set()

    /**
     * 订阅收起状态变化。返回退订函数（务必在 effect 的 cleanup 里调用，否则泄漏）。
     * 传入非函数直接忽略并返回空退订函数 —— 订阅表是模块级的，脏数据会一直留在这里。
     *
     * @param {(collapsed:boolean)=>void} listener
     * @returns {()=>void} 退订函数
     */
    function subscribeCollapsed(listener) {
      if (typeof listener !== 'function') {
        warnOnce('subscribeCollapsed', '订阅者不是函数，已忽略（否则会一直留在模块级订阅表里）')
        return () => {}
      }
      collapseSubscribers.add(listener)
      let active = true
      return () => {
        // 幂等：cleanup 被重复调用（StrictMode 双调用）时不能误删别人的订阅。
        if (active !== true) return
        active = false
        collapseSubscribers.delete(listener)
      }
    }

    /** 当前订阅者数量。仅供自测断言「退订后真的退干净了」，生产路径不读它。 */
    function collapseSubscriberCount() {
      return collapseSubscribers.size
    }

    /**
     * 写收起状态。写失败只降级为「不持久化」，不影响本次交互。
     *
     * **持久化与通知是两条独立的链**：先写 localStorage（返回是否成功），
     * 再无条件通知订阅者。这样即使某个订阅者抛错，也只毁掉那一个订阅者，
     * 不会连累持久化、也不会连累其它订阅者（每个回调各自 try/catch）。
     */
    function writeCollapsed(collapsed) {
      const next = collapsed === true
      let persisted = false
      try {
        if (typeof localStorage !== 'undefined' && localStorage !== null) {
          localStorage.setItem(STORAGE_KEY, next ? '1' : '0')
          persisted = true
        }
      } catch (cause) {
        warnOnce('writeCollapsed', 'localStorage 不可写，本次收起状态不持久化：' + describeError(cause))
      }
      // 快照后再遍历：回调里退订/再订阅会改 Set 本身，直接遍历会漏人或重复。
      for (const listener of Array.from(collapseSubscribers)) {
        try {
          listener(next)
        } catch (cause) {
          warnOnce('writeCollapsed:notify', '收起状态订阅者抛错（已隔离，不影响其它订阅者与持久化）：' + describeError(cause))
        }
      }
      return persisted
    }
    /**
     * 左窗几何与尺寸锁定的读写、钳制。
     *
     * 容错风格与 readCollapsed/writeCollapsed 完全一致：localStorage 缺失、
     * 内容损坏、不可访问一律降级为默认值并 warnOnce，**绝不抛错** ——
     * 侧栏是常驻 UI，一条几何相关的异常会整窗白掉，代价远大于丢一次尺寸偏好。
     */

    /** 视口高度；没有 window 时按 900 兜底（只影响默认值，不抛错）。 */
    function viewportHeight() {
      try {
        if (typeof window === 'undefined' || window === null) return 900
        const height = toPositive(window.innerHeight)
        return height > 0 ? height : 900
      } catch (cause) {
        warnOnce('viewportHeight', '读取视口高度失败（按 900 兜底）：' + describeError(cause))
        return 900
      }
    }

    /**
     * 高度上界 = 视口 - 顶部偏移 - 下间距。
     * 不低于 OVERLAY_MIN_HEIGHT：视口太矮时宁可让左窗略微超出，也别压成一条缝。
     */
    function maxOverlayHeight(viewHeight, top) {
      const base = toPositive(viewHeight) > 0 ? toPositive(viewHeight) : viewportHeight()
      const offset = toPositive(top) > 0 ? toPositive(top) : OVERLAY_TOP_FALLBACK
      return Math.max(OVERLAY_MIN_HEIGHT, Math.floor(base - offset - OVERLAY_GAP))
    }

    /** 高度默认值：min(70vh, 640)，并被视口上界二次收敛。 */
    function defaultOverlayHeight(viewHeight, top) {
      const base = toPositive(viewHeight) > 0 ? toPositive(viewHeight) : viewportHeight()
      const wanted = Math.round(base * OVERLAY_DEFAULT_VH)
      const capped = wanted > 0 && wanted < OVERLAY_MAX_DEFAULT_HEIGHT ? wanted : OVERLAY_MAX_DEFAULT_HEIGHT
      return Math.min(capped, maxOverlayHeight(base, top))
    }

    /** 宽度钳制到 180..420；非有限数给默认宽。纯函数，可单测。 */
    function clampOverlayWidth(value) {
      const parsed = typeof value === 'number' ? value : Number(value)
      if (!Number.isFinite(parsed)) return OVERLAY_DEFAULT_WIDTH
      return Math.min(OVERLAY_MAX_WIDTH, Math.max(OVERLAY_MIN_WIDTH, Math.round(parsed)))
    }

    /**
     * 高度钳制：下界 240，上界 = 视口可用高度。纯函数，可单测。
     * 两个边界都必须钳：下界防压扁，上界防拖出视口后够不着。
     */
    function clampOverlayHeight(value, viewHeight, top) {
      const ceiling = maxOverlayHeight(viewHeight, top)
      const parsed = typeof value === 'number' ? value : Number(value)
      if (!Number.isFinite(parsed)) return Math.min(defaultOverlayHeight(viewHeight, top), ceiling)
      return Math.min(ceiling, Math.max(OVERLAY_MIN_HEIGHT, Math.round(parsed)))
    }

    /** 读左窗几何（宽/高）。无记录/损坏/不可读一律给默认值。 */
    function readOverlayGeometry(viewHeight, top) {
      const fallback = { w: OVERLAY_DEFAULT_WIDTH, h: defaultOverlayHeight(viewHeight, top) }
      try {
        if (typeof localStorage === 'undefined' || localStorage === null) return fallback
        const raw = localStorage.getItem(GEOMETRY_KEY)
        if (raw === null || raw === undefined || raw === '') return fallback
        const record = asRecord(JSON.parse(String(raw)))
        if (record === null) return fallback
        return {
          w: clampOverlayWidth(record.w),
          h: clampOverlayHeight(record.h, viewHeight, top),
        }
      } catch (cause) {
        warnOnce('readOverlayGeometry', '左窗尺寸读取失败（按默认值处理）：' + describeError(cause))
        return fallback
      }
    }

    /**
     * 写左窗几何。这里只做「是不是正数」的最小校验并原样存，
     * 范围钳制统一放在读取侧做 —— 避免同一份数据出现两套钳制口径。
     */
    function writeOverlayGeometry(width, height) {
      try {
        if (typeof localStorage === 'undefined' || localStorage === null) return false
        const w = toPositive(width)
        const h = toPositive(height)
        if (w === 0 || h === 0) return false
        localStorage.setItem(GEOMETRY_KEY, JSON.stringify({ w: Math.round(w), h: Math.round(h) }))
        return true
      } catch (cause) {
        warnOnce('writeOverlayGeometry', '左窗尺寸写入失败（本次不持久化）：' + describeError(cause))
        return false
      }
    }

    /** 读锁定状态。默认 false = 未锁定（可拖拽）。 */
    function readLocked() {
      try {
        if (typeof localStorage === 'undefined' || localStorage === null) return false
        return localStorage.getItem(LOCKED_KEY) === '1'
      } catch (cause) {
        warnOnce('readLocked', '锁定状态读取失败（按未锁定处理）：' + describeError(cause))
        return false
      }
    }

    /** 写锁定状态。写失败只降级为「本次不持久化」。 */
    function writeLocked(locked) {
      try {
        if (typeof localStorage === 'undefined' || localStorage === null) return false
        localStorage.setItem(LOCKED_KEY, locked === true ? '1' : '0')
        return true
      } catch (cause) {
        warnOnce('writeLocked', '锁定状态写入失败（本次不持久化）：' + describeError(cause))
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
    function reportSeen(sessionId, options) {
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

    /* ──────────────────── unseen 时间筛选（问题二） ──────────────────── */

    /**
     * 读「已完成未查看」的时间筛选。默认 **'recent' = 最近 7 天**（用户 2026-10-06 决策）。
     *
     * 为什么默认收窄：实测本机服务端「有史以来」口径下 unseen 有 484 条
     * （0-7 天 115 / 7-30 天 236 / 30-180 天 125 / 180 天以上 8），一屏根本看不过来，
     * 而用户真正关心的是「刚做完没看的那几件事」。
     *
     * 为什么筛选放在**客户端**而不是服务端：
     *   1) 服务端仍返回全量 unseen，「切到全部」才不需要重扫（506 个投影文件约 1 秒）；
     *   2) counts 是全量口径的统计值，若在服务端过滤，counts.unseen 会与列表长度对不上，
     *      反而制造新的不一致（验收第 2 条要求计数可对账）；
     *   3) 筛选是**这一屏的阅读偏好**，不是数据事实 —— 放 localStorage 刷新后还在，换机器不跟随。
     */
    function readUnseenFilter() {
      try {
        if (typeof localStorage === 'undefined' || localStorage === null) return 'recent'
        const raw = localStorage.getItem(UNSEEN_FILTER_KEY)
        return raw === 'all' ? 'all' : 'recent'
      } catch (cause) {
        warnOnce('readUnseenFilter', 'localStorage 不可读，按默认「最近 7 天」处理：' + describeError(cause))
        return 'recent'
      }
    }

    /** 写 unseen 筛选。任何非 'all' 的值都归一成 'recent'（默认档）。 */
    function writeUnseenFilter(filter) {
      const next = filter === 'all' ? 'all' : 'recent'
      try {
        if (typeof localStorage !== 'undefined' && localStorage !== null) {
          localStorage.setItem(UNSEEN_FILTER_KEY, next)
        }
      } catch (cause) {
        warnOnce('writeUnseenFilter', 'localStorage 不可写，本次筛选不持久化：' + describeError(cause))
      }
      return next
    }

    /**
     * 按筛选把 unseen 条目切成「显示 / 隐藏」。
     *
     * 时间基准是 **lastPromptAt**（用户最后一次提问的时刻），不是 generatedAt、也不是投影 createdAt：
     * unseen 的语义是「已完成但你没看」，用户关心的是「我什么时候做的」，
     * lastPromptAt 正是那一刻。边界用严格大于（> cutoff）：恰好 7 天整的点算「更早」。
     *
     * @param {Array} entries 全部 unseen 条目
     * @param {'recent'|'all'} filter
     * @param {number} now 注入的时间源（单测可冻结）
     * @returns {{visible: Array, hidden: number, cutoff: number}}
     */
    function partitionUnseen(entries, filter, now) {
      const list = Array.isArray(entries) ? entries : []
      const at = num(now)
      if (filter === 'all') return { visible: list.slice(), hidden: 0, cutoff: 0 }
      const cutoff = at - UNSEEN_RECENT_DAYS * 24 * 3600 * 1000
      const visible = []
      let hidden = 0
      for (const entry of list) {
        const at2 = asRecord(entry) === null ? 0 : num(entry.lastPromptAt)
        if (at2 > cutoff) visible.push(entry)
        else hidden += 1
      }
      return { visible: visible, hidden: hidden, cutoff: cutoff }
    }

    /**
     * 批量「全部标记已读」。
     *
     * 为什么走**一条** POST（{sessionIds:[...]}）而不是逐条：
     * 实测过滤后仍有 115~484 条，逐条意味着一次点击打出上百个请求，中途断连就留下半清不清的列表。
     * 服务端复用同一条 /seen 路由（rpc.js 的批量分支），既不新增路由（冻结契约只有 4 条），
     * 水位语义也与单条完全一致（取 max、只前进不后退）。
     *
     * @param {string[]} ids 当前筛选范围内的会话 id
     * @param {{endpoint?:string, fetch?:Function}} [options] 测试注入
     * @returns {Promise<{ok:boolean, applied:number, errorCode?:string}>}
     */
    function markAllSeen(ids, options) {
      const list = Array.isArray(ids) ? ids.filter((x) => typeof x === 'string' && x !== '') : []
      if (list.length === 0) return Promise.resolve({ ok: true, applied: 0 })
      const config = asRecord(options) === null ? {} : options
      const endpoint = str(config.endpoint) !== '' ? str(config.endpoint) : SEEN_ENDPOINT
      const doFetch = config.fetch === undefined ? (typeof fetch === 'function' ? fetch : null) : config.fetch
      if (typeof doFetch !== 'function') {
        warnOnce('markAllSeen:noFetch', '没有可用的 fetch，批量标记已读未发出')
        return Promise.resolve({ ok: false, applied: 0, errorCode: 'NO_FETCH' })
      }
      let body
      try {
        body = JSON.stringify({ sessionIds: list, at: Date.now() })
      } catch (cause) {
        warnOnce('markAllSeen:body', '构造批量请求体失败（跳过本次标记）：' + describeError(cause))
        return Promise.resolve({ ok: false, applied: 0, errorCode: 'BODY_SERIALIZE_FAILED' })
      }
      // 一次性打上百个 id 可能超出 body 上限；超限时明确报错而不是静默截断。
      if (body.length > 60000) {
        warnOnce('markAllSeen:tooLarge', '批量标记已读超出请求体上限（' + String(body.length) + ' 字符），请改用更小的筛选范围')
        return Promise.resolve({ ok: false, applied: 0, errorCode: 'PAYLOAD_TOO_LARGE' })
      }
      let promise
      try {
        promise = doFetch(endpoint, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: body,
          keepalive: true,
        })
      } catch (cause) {
        warnOnce('markAllSeen:call', '批量标记已读调用失败：' + describeError(cause))
        return Promise.resolve({ ok: false, applied: 0, errorCode: 'FETCH_THREW' })
      }
      return Promise.resolve(promise).then(
        (res) => {
          if (res === null || res === undefined || res.ok === false) {
            warnOnce('markAllSeen:http', '批量标记已读返回非 2xx')
            return { ok: false, applied: 0, errorCode: 'HTTP_FAILED' }
          }
          return res.json().then(
            (payload) => {
              const outer = asRecord(payload)
              const data = asRecord(outer === null ? null : outer.data)
              return { ok: true, applied: num(data === null ? 0 : data.applied) }
            },
            (cause) => {
              warnOnce('markAllSeen:json', '批量标记已读响应不是 JSON：' + describeError(cause))
              return { ok: true, applied: 0 }
            },
          )
        },
        (cause) => {
          warnOnce('markAllSeen:reject', '批量标记已读未完成（下轮轮询会重算）：' + describeError(cause))
          return { ok: false, applied: 0, errorCode: 'REJECTED' }
        },
      )
    }

    /* ──────────────────── 宿主会话跳转面（问题三） ──────────────────── */

    /**
     * uiWorkspace 服务（宿主跨插件动作面）。
     *
     * 2026-10-06 实测根因：selectEntry 只 dispatchEvent('dsh-active-sessions:select')，
     * 而**全仓库没有任何监听者** → 点击卡片毫无反应。
     *
     * 宿主的正确入口（官方侧栏就是这么用的，见
     * @deepseek-ai/dsh-client-ui-sidebar/lib/client.js:329-339）：
     *   inject 里含 'uiWorkspace'，apply 里 const workspaceNavigation = ctx.get('uiWorkspace')
     *   然后 workspaceNavigation.openSession(sessionId)
     * openSession 内部 = sessions.open(id) + ctx.layout.selectPanel(null)。
     *
     * 为什么**不**把 'uiWorkspace' 加进本包的 inject（结论：可选获取 + 缺失降级）：
     *   cordis 的 ctx.get(name) 在服务缺席时返回 **undefined**（cordis/lib/index.js:762-764
     *   get(name, strict) { return getTraceable(this.ctx, this._getImpl(name, strict)?.value) }），
     *   所以「可选获取 + 缺失降级」是**安全**的；
     *   而 inject 是硬依赖：服务没被 provide 时整个 fiber 停在 pending，四个挂载点全部注册不上，
     *   面板直接消失。本包是独立 sideload 的客户端包，宿主换版本/换 platform（web vs 非 web）时
     *   ui-workspace bundle 未必在，白拿一个「整包不加载」的风险不值得。
     *   与 models.js 用 ctx.get('llm') 同理（官方有 11 处先例，均不进 inject）。
     */
    let workspaceFace = null

    /**
     * 惰性解析器：apply 时只记住 ctx，**每次点击时**再向宿主要 uiWorkspace。
     *
     * ⚠️ 2026-10-07 实测根因（浏览器真机验收发现的真 bug）：
     *   原实现在 apply() 里一次性 `ctx.get('uiWorkspace')` 并缓存。但 cordis 的
     *   `get(name, strict = true)` 在**提供者 fiber 尚未激活**时返回 undefined：
     *       _getImpl(name, strict) { if (strict && impl.fiber.state !== 2) return; ... }
     *   本包是 sideload 客户端包，inject 只有 ['slots','layout']，**不含 uiWorkspace**
     *   （刻意不加：inject 是硬依赖，缺了会让整包 pending、四个挂载点全注册不上）。
     *   于是 apply() 跑得比 ui-workspace 的 fiber 激活更早 → 拿到 undefined 并永久缓存，
     *   点击时走 "UIWORKSPACE_MISSING" 分支 —— 而 selectEntry 的返回值**无人消费**，
     *   失败完全静默：用户点卡片毫无反应，控制台也没有任何告警。
     *
     * 修法：把「取服务」推迟到点击那一刻（那时所有 fiber 早已激活），
     * 并且只在成功时缓存；未取到时下次点击重试，不会把一次过早的 undefined 永久固化。
     */
    let workspaceResolver = null

    /**
     * 记下解析器（apply 时传入一个返回 uiWorkspace 或 null 的闭包）。
     * 兼容旧签名：传一个非函数对象视为「直接绑定该 face」。
     */
    function bindWorkspaceFace(faceOrResolver) {
      if (typeof faceOrResolver === 'function') {
        workspaceResolver = faceOrResolver
        return
      }
      workspaceResolver = null
      workspaceFace = asRecord(faceOrResolver) === null ? null : faceOrResolver
    }

    /**
     * 取当前可用的 uiWorkspace。
     * 优先用惰性解析器（点击时实名求值），成功即缓存；失败不缓存，下次再试。
     * @returns {object|null}
     */
    function resolveWorkspaceFace() {
      if (workspaceFace !== null) return workspaceFace
      if (workspaceResolver === null) return null
      let face = null
      try {
        face = workspaceResolver()
      } catch (cause) {
        // 解析器抛错不该影响点击：降级为「无跳转面」，但必须留痕可诊断。
        if (typeof console !== 'undefined' && console !== null && typeof console.warn === 'function') {
          console.warn('[active-sessions/sidebar] 解析 uiWorkspace 失败: ' + describeError(cause))
        }
        return null
      }
      const normalized = asRecord(face) === null ? null : face
      if (normalized !== null) workspaceFace = normalized
      return normalized
    }

    /** 清空缓存（供自测在两次场景间复位）。 */
    function resetWorkspaceFace() {
      workspaceFace = null
      workspaceResolver = null
    }

    /** 当前是否已绑定可用的跳转面（供自测断言降级路径）。 */
    function hasWorkspaceFace() {
      return workspaceFace !== null
    }

    /**
     * 会话 id 形态归一：宿主 sessions.select() 只认它自己目录里的写法，
     * 写错会直接抛 "sessions.select: unknown session &lt;id&gt;"。
     *
     * 实测本机两种写法都真实存在：
     *   - workspace.json 的 sessionIds：379 条里 372 条带 'session-' 前缀，7 条是裸 uuid；
     *   - 投影文件名：老会话裸 uuid，新会话带前缀（506 个文件两种都有）。
     * 所以先按调用方给的原样试一次，失败再试另一种形态。
     */
    function sessionIdForms(id) {
      const text = str(id)
      if (text === '') return []
      const bare = text.indexOf('session-') === 0 ? text.slice('session-'.length) : text
      const forms = [text]
      if (bare !== '' && bare !== text) forms.push(bare)
      if (text.indexOf('session-') !== 0) forms.push('session-' + text)
      return forms
    }

    /**
     * 真正跳转到宿主会话。
     *
     * @returns {{opened:boolean, reason?:string, errorCode?:string}}
     *   opened=false 时 reason 是可诊断的一行文案（界面会把它显示成一条提示条）。
     *
     * 覆盖子代理会话：宿主的 sessions.select() 支持 catalog-addressed child
     * （dsh-api-session-controller/lib/client.js:2257-2261 会先 navigationAddress() 再按目录选），
     * 所以子代理会话也是一等可打开对象，我们不预先拦它；但它可能不在当前已发现的目录里，
     * 此时 select() 会抛 —— 已由下面的 try/catch 降级，绝不崩。
     */
    function openSessionInHost(id) {
      // 点击那一刻才向宿主要服务 —— 见 resolveWorkspaceFace 上方的实测根因说明。
      const face = resolveWorkspaceFace()
      if (face === null) {
        return { opened: false, reason: '宿主未提供 uiWorkspace 服务（跳转到会话不可用）', errorCode: 'UIWORKSPACE_MISSING' }
      }
      if (typeof face.openSession !== 'function') {
        return { opened: false, reason: 'uiWorkspace 缺少 openSession 方法', errorCode: 'UIWORKSPACE_NO_OPEN' }
      }
      const forms = sessionIdForms(id)
      if (forms.length === 0) return { opened: false, reason: '会话 id 为空', errorCode: 'EMPTY_SESSION_ID' }
      let lastError = null
      for (let i = 0; i < forms.length; i += 1) {
        try {
          face.openSession(forms[i])
          return { opened: true }
        } catch (cause) {
          lastError = cause
        }
      }
      return {
        opened: false,
        reason: '打开会话失败：' + describeError(lastError),
        errorCode: 'OPEN_SESSION_FAILED',
      }
    }

    /**
     * 选中某个会话时上报。
     * 不写死任何导航接口：优先调用集成方传入的 onSelect；否则派发自定义事件，
     * 让「谁负责切会话」自己去监听，客户端包之间保持解耦。
     *
     * 同时上报已读水位（见 reportSeen 的说明）—— 这是 unseen 状态能清掉的唯一途径。
     *
     * 2026-10-06（问题三）：在上述两条之外**新增** uiWorkspace.openSession 跳转。
     * 顺序刻意是「先跳转、后派发」：导航是用户点击的主要期望，派发只是向后兼容的旁路。
     * 跳转失败不阻断派发（向后兼容优先），但会返回 reason 让界面能给出可诊断提示。
     */
    function selectEntry(entry, onSelect) {
      if (entry !== null && entry !== undefined) {
        // 尽力而为，不 await：导航不应等网络。
        const seenOptions = typeof onSelect === 'object' && onSelect !== null ? onSelect : undefined
        void reportSeen(entry.id, seenOptions).catch(() => false)
      }
      let nav = { opened: false, reason: '由外部 onSelect 接管导航', errorCode: 'ONSELECT_TAKEOVER' }
      // onSelect 是集成方自己的导航通道（老契约："不写死任何导航接口"）。
      // 它在场时**不**再去抢宿主跳转 —— 否则一次点击会触发两套导航，互相打架。
      if (typeof onSelect !== 'function' && entry !== null && entry !== undefined) {
        nav = openSessionInHost(entry.id)
      }
      // ⚠️ 2026-10-07：原实现把 nav 只当返回值——而**没有任何调用方消费它**，
      // 于是「跳转失败」在界面上完全不可见（真机验收时点卡片毫无反应、控制台也无告警）。
      // 跳转失败必须显式暴露，否则用户只会以为插件坏了却无从反馈。
      // 注意：成功时**不**派发任何提示（避免每次点击都闪一条）。
      if (nav.opened !== true && typeof window !== 'undefined' && window !== null &&
          typeof window.dispatchEvent === 'function' && typeof CustomEvent === 'function') {
        window.dispatchEvent(new CustomEvent(NAVIGATION_EVENT, {
          detail: { id: entry === null || entry === undefined ? '' : entry.id, opened: false, reason: nav.reason, errorCode: nav.errorCode },
        }))
      }
      if (typeof onSelect === 'function') {
        onSelect(entry.id, entry)
        return nav
      }
      if (typeof window === 'undefined' || window === null) return nav
      if (typeof window.dispatchEvent !== 'function' || typeof CustomEvent !== 'function') return nav
      window.dispatchEvent(new CustomEvent(SELECT_EVENT, { detail: { id: entry.id, cwd: entry.cwd, workspace: entry.workspace } }))
      return nav
    }

    // ───────────────────────── 样式 ─────────────────────────

    /**
     * 配色严格取自契约 §5（初音青空），只引用皮肤 token，不硬编码主色。
     * 列容器（.as_root / .as_body）刻意不含任何背景模糊声明 —— 见文件头硬约束。
     */
    const CSS = [
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
    // ── 问题二：unseen 时间筛选条 ─────────────────────────────────────────
    // 同样刻意只用半透明实色（as-card），不加任何背景模糊（列容器硬约束，见文件头）。
    // ⚠️ 本文件对该 CSS 属性名的 grep 必须是 0 命中，**注释里也不要写它**，否则验收脚本会误判。
    '.as_filterBar{display:flex;align-items:center;gap:4px;flex-wrap:wrap;padding:4px 6px;',
    'border-top:1px solid var(--as-line);border-bottom:1px solid var(--as-line);background:var(--as-card)}',
    '.as_filterLabel{font-size:11.5px;color:var(--as-tertiary);white-space:nowrap}',
    '.as_filterBtn{font:inherit;font-size:11px;line-height:1.4;padding:3px 7px;border-radius:7px;cursor:pointer;',
    'border:1px solid var(--as-line);background:transparent;color:var(--as-text2);white-space:nowrap}',
    '.as_filterBtn:hover{background:var(--as-accent-bg);color:var(--as-text)}',
    '.as_filterBtn_on{background:var(--as-accent-bg);border-color:var(--as-accent-line);color:var(--as-accent);font-weight:600}',
    '.as_filterBtn_action{border-color:var(--as-accent-line);color:var(--as-accent)}',
    '.as_filterBtn_action[disabled]{opacity:.55;cursor:progress}',
    '.as_filterHint{padding:3px 8px;font-size:11px;color:var(--as-tertiary)}',
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
      //
      // 三级策略（后者兜底前者）：
      //   1) JS 实测侧栏宽度 -> 精确贴右缘（最优）
      //   2) CSS :has([data-sidebar-collapsed]) -> 收起时贴最左
      //   3) 默认值 288px（估位兜底）
      //
      // === top 为什么不能写死常量（2026-10-05 用户实测根因）==============
      // 宿主会话头部是 <header class="wSkVaW_header">，实测 rect = x280 y0 w1632 h76。
      // 旧代码写死 top:56px，**正好压进头部 20px** —— 这就是「左窗遮住导航栏」的根因，
      // 旧注释里的「预留 56px 头部」是过时假设。
      // 更麻烦的是该 header **只在打开会话时存在**（新会话首页顶部没有它），
      // 所以写死任何常量都必然在一端出错：写 76 则首页留 20px 空白，写 0 则会话页压头。
      // 解法同 measureSidebarOffset：运行时实测，见 measureOverlayTop()。
      //
      // === 高度为什么不写 bottom ==============
      // bottom 与 height 同时存在会触发 over-constrained 绝对定位规则，
      // 浏览器会把其中一个改写成另一个，用户拖出来的尺寸随即被吃掉。
      // 所以改由 --as-overlay-height 单独控制高度，bottom 一律不写。
      '.as_overlayRoot{position:absolute;z-index:1;top:var(--as-overlay-top,88px);left:var(--as-overlay-left,288px);',
      'right:auto;width:var(--as-overlay-width,240px);height:var(--as-overlay-height,640px);',
      'max-height:calc(100vh - var(--as-overlay-top,88px) - 12px);',
      'pointer-events:auto;display:flex;flex-direction:column}',
      // 侧栏收起（frame 带该属性）时直接贴最左 —— 纯 CSS 即可判，无需测量。
      'body:has([data-sidebar-collapsed]) .as_overlayRoot{--as-overlay-left:12px}',
      // 窄屏自适应：逐步收窄，最后隐藏（避免挤出主内容）。
      // === 窄屏复核（2026-10-05）===
      // 宽高改由 CSS 变量驱动后，这三档若继续直接写 width:224px，
      // 会**盖掉用户拖出来的宽度**（窄屏下改不动 = 功能失效）。
      // 正确写法：只改 var() 的**兜底值**，变量本身不动 ——
      //   · JS 已写入变量（用户拖过）-> 用户尺寸在窄屏同样生效；
      //   · JS 未写入（首帧/注入失败）-> 窄屏仍拿到更窄的默认值。
      // 900px 档直接 display:none，此时尺寸无意义，保持原样。
      '@media (max-width:1280px){.as_overlayRoot{width:var(--as-overlay-width,224px)}}',
      '@media (max-width:1024px){.as_overlayRoot{width:var(--as-overlay-width,210px)}}',
      '@media (max-width:900px){.as_overlayRoot{display:none}}',
      // 拖拽手柄：用户要「一个框调整」，故给出看得见的边。
      // 右缘调宽、下缘调高，pointer 事件 + setPointerCapture + rAF 节流，
      // 与宿主侧栏调宽同一套做法（见 OverlayHost 的 beginResize）。
      '.as_resizeX{position:absolute;top:0;right:-4px;width:9px;height:100%;z-index:3;',
      'cursor:col-resize;touch-action:none;background:transparent;transition:background .12s ease}',
      '.as_resizeX:hover{background:var(--as-accent-line)}',
      '.as_resizeY{position:absolute;left:0;right:0;bottom:-4px;height:9px;z-index:3;',
      'cursor:row-resize;touch-action:none;background:transparent;transition:background .12s ease}',
      '.as_resizeY:hover{background:var(--as-accent-line)}',
      '.as_head{display:flex;align-items:center;gap:8px;padding:10px 12px;border-bottom:1px solid var(--as-line);flex:none}',
      // === 头部收缩优先级（2026-10-05 真实浏览器实测回归后定稿）===
      // 实测：加了锁按钮（20px + gap 8）后，240px 宽的左窗里 gap:8 的 flex 行放不下，
      // as_headTitle 又没有 nowrap，文字直接折成两行，.as_head 从 h41 涨到 h60。
      // 定稿优先级（从高到低）：
      //   1. 计数徽标 as_headCount  —— flex:none，永不收缩
      //   2. 两个图标按钮 as_iconBtn —— flex:none，永不收缩
      //   3. 标题 as_headTitle      —— flex:none + nowrap，绝不允许换行或被压
      //   4. 工作区说明 as_headMeta —— flex:0 1 auto + min-width:0，唯一允许被压的
      //
      // min-width:0 不是冗余：flex 项的自动最小尺寸默认是 min-content，
      // 不写这行，overflow:hidden + text-overflow:ellipsis 根本不会生效，
      // 元素会顶住自然宽度把兄弟挤出去（flex 的经典陷阱）。
      '.as_headTitle{font-weight:600;font-size:13px;color:var(--as-text);letter-spacing:.02em;',
      'white-space:nowrap;flex:none}',
      '.as_headMeta{font-size:11px;color:var(--as-tertiary);white-space:nowrap;overflow:hidden;',
      'text-overflow:ellipsis;min-width:0;flex:0 1 auto}',
      // 窄窗（用户可拖到 180px）时 meta 只剩几个像素，省号毫无信息量，整块隐藏，
      // 把空间还给标题与计数。由 OverlayHost 按几何宽度打 as_narrow 类。
      // 刻意**不用容器查询**：container-type 会给 .as_overlayRoot 加 containment，
      // 使它成为 fixed 后代的包含块 —— 与契约 §5 记录的毛玻璃事故同源，不冒这个险。
      '.as_narrow .as_headMeta{display:none}',
      '.as_headCount{margin-left:auto;font-size:11px;color:var(--as-accent);background:var(--as-accent-bg);',
      'border:1px solid var(--as-accent-line);border-radius:999px;padding:0 7px;line-height:16px;flex:none}',
      '.as_iconBtn{flex:none;border:1px solid var(--as-line);background:transparent;color:var(--as-tertiary);',
      'border-radius:7px;width:20px;height:20px;line-height:1;cursor:pointer;padding:0;font-size:12px}',
      '.as_iconBtn:hover{color:var(--as-accent);border-color:var(--as-accent-line);background:var(--as-accent-bg)}',
      // 锁按钮：与收起按钮并排（同 .as_iconBtn 规格），锁定态用高亮态样式区分，
      // 避免用户以为按钮坏了。可访问性标注在组件里给 aria-pressed / title。
      '.as_iconBtn_lock{font-size:11px;line-height:1}',
      '.as_iconBtn_on{color:var(--as-accent);border-color:var(--as-accent-line);background:var(--as-accent-bg)}',
      '.as_warn{padding:6px 12px;font-size:11px;color:var(--as-appr);background:var(--as-appr-bg);',
      'border-bottom:1px solid var(--as-line)}',
      // 说明性提示的折叠块（2026-10-07）：默认收起 → 只占一行，不再常驻刷屏。
      '.as_warnNotes{padding:6px 12px;font-size:11px;color:var(--as-tertiary);',
      'border-bottom:1px dashed var(--as-line);cursor:pointer}',
      '.as_warnNotes_summary{outline:none;user-select:none}',
      '.as_warnNotes_summary:hover{color:var(--as-text2)}',
      '.as_warnNotes_list{margin:6px 0 2px;padding-left:16px;display:flex;flex-direction:column;gap:3px}',
      '.as_warnNotes_item{line-height:16px;word-break:break-word}',
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
    function injectStyles() {
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
    function measureSidebarOffset() {
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

    /**
     * 判断一个元素像不像宿主的**会话头部**，像就返回它的高度，否则返回 0。
     *
     * 为什么不用选择器：宿主类名带 hash（wSkVaW_header），随构建变化，写死必失效。
     * 为什么不用 tagName：document.querySelector('header') 在别的插件里也会命中。
     * 所以用几何特征：贴顶（top≈0）、高 40..120、宽 > 600 ——
     * 实测宿主头部 rect = x280 y0 w1632 h76，三条全部满足。
     * getBoundingClientRect 本身也可能抛（脱离文档的节点、异常 DOM），一律当 0。
     */
    function looksLikeHostHeader(node) {
      if (node === null || node === undefined) return 0
      if (typeof node.getBoundingClientRect !== 'function') return 0
      let rect = null
      try {
        rect = node.getBoundingClientRect()
      } catch (cause) {
        return 0
      }
      const box = asRecord(rect)
      if (box === null) return 0
      const offset = Number(box.top)
      const height = toPositive(box.height)
      const width = toPositive(box.width)
      if (!Number.isFinite(offset) || Math.abs(offset) > 1) return 0
      if (height < HOST_HEADER_MIN_H || height > HOST_HEADER_MAX_H) return 0
      if (width < HOST_HEADER_MIN_W) return 0
      return Math.round(height)
    }

    /**
     * 实测宿主会话头部高度，写进 CSS 变量 --as-overlay-top，让左窗不再压住导航栏。
     *
     * 探测顺序（都失败就用 OVERLAY_TOP_FALLBACK = 88 = 76 + 12 间距）：
     *   1) document.querySelector('header') —— 宿主头部就是 <header>，命中即验几何；
     *   2) 按几何特征在 header/div/section/nav 里扫一遍（宿主改标签时仍能兜住）。
     *
     * 全程判空 + try/catch，异常走 warnOnce，**绝不抛错**：
     * 这条链跑在 effect 里，抛错会连带炸掉整个 overlay 槽位。
     *
     * @returns {number} 实际生效的 top 值（像素，含下间距）；测不到返回 88。
     */
    function measureOverlayTop() {
      let detected = 0
      try {
        if (typeof document === 'undefined' || document === null) return OVERLAY_TOP_FALLBACK
        if (typeof document.querySelector !== 'function') return OVERLAY_TOP_FALLBACK
        detected = looksLikeHostHeader(document.querySelector('header'))
        if (detected === 0 && typeof document.querySelectorAll === 'function') {
          const nodes = document.querySelectorAll('header,div,section,nav')
          const total = typeof nodes.length === 'number' ? nodes.length : 0
          for (let index = 0; index < total && detected === 0; index += 1) {
            detected = looksLikeHostHeader(nodes[index])
          }
        }
      } catch (cause) {
        warnOnce('measureOverlayTop', '测量宿主会话头部失败（按兜底值处理）：' + describeError(cause))
        return OVERLAY_TOP_FALLBACK
      }
      const value = detected > 0 ? detected + OVERLAY_GAP : OVERLAY_TOP_FALLBACK
      try {
        const root = document.documentElement
        if (root !== null && root !== undefined && root.style !== null && root.style !== undefined) {
          root.style.setProperty('--as-overlay-top', String(value) + 'px')
        }
      } catch (cause) {
        warnOnce('measureOverlayTop:set', '写入 --as-overlay-top 失败（CSS 兜底值仍生效）：' + describeError(cause))
      }
      return value
    }

    // ─────────────────── React 解析（注入优先） ───────────────────

    /** 模块级缓存的 React 实例（由工厂注入写入，供模块级便捷导出复用）。 */
    let cachedReact = null

    /** 显式注入 React 实例；传 null 可重置。自测与集成方都可用。 */
    function setReact(instance) {
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
    function resolveReact() {
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
    function createSidebarUi(options) {
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

      /**
       * 顶部条：标题 + 工作区数 + 总数 + 锁定按钮 + 收起按钮。
       *
       * 锁定按钮与收起按钮并排、同 .as_iconBtn 规格（用户要「加一个框调整，和锁定功能」）。
       * onToggleLock 为空时不渲染该按钮 —— 槽位内嵌形态没有可拖的框，
       * 给一个点了没反应的按钮比不给更糟。
       * 可访问性：aria-pressed 表达开关态，title/aria-label 随状态改写，
       * 屏幕阅读器能读出「已锁定 / 未锁定」，不必靠 emoji 猜。
       */
      function Head(props) {
        const isLocked = props.locked === true
        return el('div', { className: 'as_head' },
          el('span', { className: 'as_headTitle' }, '活跃会话'),
          el('span', { className: 'as_headMeta' }, props.workspaces > 0 ? '全工作区 · ' + String(props.workspaces) : '全工作区'),
          el('span', { className: 'as_headCount', title: '三态总数' }, String(props.total)),
          typeof props.onToggleLock === 'function'
            ? el('button', {
              type: 'button',
              className: 'as_iconBtn as_iconBtn_lock' + (isLocked ? ' as_iconBtn_on' : ''),
              'aria-pressed': isLocked,
              'data-as-lock': isLocked ? 'on' : 'off',
              title: isLocked ? '已锁定：拖拽手柄已停用' : '锁定：停用拖拽手柄，防止误拖',
              'aria-label': isLocked ? '解除左窗尺寸锁定' : '锁定左窗尺寸',
              onClick: props.onToggleLock,
            }, isLocked ? '🔒' : '🔓')
            : null,
          el('button', {
            type: 'button',
            className: 'as_iconBtn',
            title: '收起左窗（点侧栏「活跃会话」图标可再次打开）',
            'aria-label': '收起活跃会话窗',
            onClick: props.onCollapse,
          }, '‹'),
        )
      }

      // -------------------------------------------------------------------------
      // 警告的「预期 vs 故障」判定（2026-10-07，用户实测「左窗底部两条噪音」）
      // -------------------------------------------------------------------------
      // ⚠️ 左窗此前之所以逐条刷屏（用户截图里那两条），是因为服务端 states.js 产出的是
      //   `[states] operation=… error_code=Error` 的 key=value 串，与总览页 warnLine 的
      //   ' -> CODE:' 形态对不上 → 归类全部落空 → 一条条 push。
      //   **根本修法在服务端**：states.js 的 describeError 现在产出同一形态，
      //   并且带**真实** error_code（SESSION_LOG_MISSING / CWD_NOT_ABSOLUTE …），
      //   前端据此区分「预期降级」与「真故障」，不再做字符串猜测。
      //
      // ⚠️ 本段与 ui/overview.js 的同名实现**逐字一致**。两个 UI 是分别内联进 client.js 的
      //   独立工厂（DSH 客户端 require 不了同包子路径），所以只能各写一份；
      //   tests/temp-e2e-warning-groups.mjs 对两份实现跑同一组夹具并断言输出一致，
      //   防止「改了一边忘了另一边」。
      // -------------------------------------------------------------------------

      /**
       * 解析服务端诊断串的**规范格式**：
       *     [operation] target -> ERROR_CODE: message {contextJson}
       *
       * 为什么不用一条正则：message 里可能含花括号，惰性分组会把 message 截断、
       * 并把 message 的一段误当成 context。改成**从右往左**找可 JSON.parse 的尾段 ——
       * context 永远是最后一段且必然是合法 JSON，判定无歧义且确定。
       * 解析不出返回 null，调用方按「无法证明是预期行为」处理（fail-safe：宁可多显示）。
       */
      function parseWarningLine(raw) {
        const text = str(raw)
        if (text === '') return null
        const head = text.match(/^\[([^\]]*)\]\s*([\s\S]*)$/)
        if (head === null || head === undefined) return null
        const operation = str(head[1])
        const rest = str(head[2])

        // target 与 CODE 之间用 ' -> ' 分隔；取**最后一个**，避免路径里的箭头串位。
        const arrow = rest.lastIndexOf(' -> ')
        if (arrow <= 0) return null
        const target = rest.slice(0, arrow).trim()
        const tail = rest.slice(arrow + 4).trim()

        const codeMatch = tail.match(/^([A-Za-z0-9_]+)\s*([\s\S]*)$/)
        if (codeMatch === null || codeMatch === undefined) return null
        const code = str(codeMatch[1])
        let body = str(codeMatch[2]).trim()
        if (body.startsWith(':')) body = body.slice(1).trim()

        let context = ''
        let message = body
        for (let i = body.lastIndexOf('{'); i >= 0; i = body.lastIndexOf('{', i - 1)) {
          if (i <= 0) break
          try {
            const parsed = JSON.parse(body.slice(i))
            if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
              context = body.slice(i)
              message = body.slice(0, i).trim()
              break
            }
          } catch {
            /* 不是合法 JSON 尾段，继续往左找 */
          }
        }
        return { operation, target, code, message, context, raw: text }
      }

      /**
       * 把服务端诊断串压缩成一句话摘要（完整串留给 title）。
       * 规范格式下直接取 message 段表达「发生了什么」；
       * 解析不出（历史 key=value 串 / 非本插件产出）时回落到旧的 key=value 抽取。
       */
      function summarizeWarning(raw) {
        const text = str(raw)
        if (text === '') return '有一条非致命提示（悬停查看详情）'
        const parsed = parseWarningLine(text)
        if (parsed !== null && parsed.message !== '') {
          return parsed.message.length > 60 ? parsed.message.slice(0, 60) + '…' : parsed.message
        }
        // 兜底一：规范格式但没有 message 段 → 用 CODE + target 表达
        if (parsed !== null) {
          const fb = (parsed.code === '' ? '' : parsed.code) + (parsed.target === '' ? '' : ' ' + parsed.target)
          if (fb !== '') return fb.length > 60 ? fb.slice(0, 60) + '…' : fb
        }
        // 兜底二：历史 key=value 形态（保留仅为向后兼容，**不作为预期/故障判定依据**）
        const pick = (key) => {
          const m = text.match(new RegExp(key + '=([^]*?)(?=\\s+[a-z_]+=|$)'))
          return m !== null && m !== undefined ? str(m[1]).trim() : ''
        }
        const msg = pick('message') || pick('input_summary')
        if (msg !== '') return msg.length > 60 ? msg.slice(0, 60) + '…' : msg
        // 兜底三：整串截断。
        return text.length > 60 ? text.slice(0, 60) + '…' : text
      }

    /**
     * 预期行为（非故障）的 error_code → 合并文案。
     *
     * ⚠️ 这张表覆盖了服务端**全部**设计内降级码（states.js + overview.js 两个产出方），
     * 逐条列全是有意的：漏一个码，那类降级就会以「真故障」的姿态常驻刷屏 ——
     * 这正是本次用户投诉的现象（2026-10-07 真机 e2e 就抓到漏网的
     * EXCERPT_BUDGET_EXHAUSTED）。新增降级码时必须同步登记到这张表。
     *
     * 判定口径只有一条：**这是插件为了保护宿主/自己主动做的让步吗？**
     *   是 → 预期（折叠，不常驻打扰）
     *   否 → 故障（常驻可见）—— 包括读不到、解析失败、llm 不可用、生成失败。
     *
     * 顺序即展示顺序，是这张表的数组顺序（不是对象枚举顺序）—— 保证确定性。
     */
    const EXPECTED_WARNING_GROUPS = [
      // ── 总览页（src/overview.js）：扫描/摘录的上限保护 ──
      { code: 'WORKSPACE_TRUNCATED', label: (n) => n + ' 个工作区的笔记已截断（文件数/体积超限）' },
      { code: 'FILE_TOO_LARGE', label: (n) => n + ' 个超大文件已被跳过（单文件超过体积上限）' },
      { code: 'ENTRY_BUDGET_EXCEEDED', label: (n) => n + ' 处目录扫描触达条目上限，子目录未继续深入' },
      { code: 'EXCERPT_BUDGET_EXHAUSTED', label: (n) => n + ' 处笔记摘录预算用尽（超出的文件只列路径）' },
      { code: 'SESSION_SCAN_CAPPED', label: (n) => n + ' 处会话扫描达到文件数上限（更早的会话未纳入）' },
      // ── cwd 归一化（overview.js 与 states.js 共用同一码，因此两边合并成一条）──
      { code: 'CWD_NOT_ABSOLUTE', label: (n) => n + ' 个会话/目录的 cwd 不是绝对路径，已降级' },
      { code: 'CWD_NOT_ABSOLUTE_MANY', label: (n) => n + ' 条非绝对路径已全部丢弃' },
      // ── 三态扫描（src/states.js）──
      { code: 'SESSION_LOG_MISSING', label: (n) => n + ' 个会话没有可读的会话日志，已按「不判活」处理' },
      { code: 'DUPLICATE_SESSION_ID', label: (n) => n + ' 条重复的会话投影已去重' },
      // ── 生成路径（src/index.js）：省 token 的设计内复用 ──
      { code: 'NOTE_CACHE_REUSED', label: (n) => n + ' 处复用了上次生成结果（笔记未变化，未调用模型）' },
      { code: 'NOTE_PERSISTED_REUSED', label: (n) => n + ' 处复用了已落盘的总结（笔记指纹一致，未调用模型）' },
      // ── 生成路径（src/index.js）：没有笔记就没有可总结的内容 ──
      // ⚠️ 2026-10-07 新增。跳过空工作区是**主动省钱**的设计内让步（实测 21 个工作区里
      //    8 个是 0 文件，旧实现照样发起模型调用、只能回「摘录不足以判断」），
      //    不是故障。漏登记这一条，它就会以「真故障」的姿态常驻刷屏 —— 上一轮刚踩过这个坑。
      { code: 'EMPTY_WORKSPACE_SKIPPED', label: (n) => n + ' 个工作区没有笔记类文件，已跳过生成（未调用模型）' },
    ];

      /**
       * 把服务端 warnings 折成「故障（常驻）」与「说明（折叠）」两堆。
       *
       * 预期项 → 折叠成一行「N 项说明性提示」，默认收起、不常驻；
       * 真故障 → 与之前一致地常驻可见，绝不折叠、绝不丢弃。
       * 顺序：先按判定表序输出合并项，再按原始数组下标序输出未合并单条 → 同输入必同输出。
       */
      function classifyWarnings(warnings) {
        const list = (Array.isArray(warnings) ? warnings : []).map(str).filter((text) => text !== '')
        const info = list.map(parseWarningLine)
        const expectedCodes = EXPECTED_WARNING_GROUPS.map((g) => g.code)
        const used = []
        for (let i = 0; i < list.length; i += 1) used.push(false)
        const faults = []
        const notes = []

        for (const group of EXPECTED_WARNING_GROUPS) {
          const members = []
          for (let i = 0; i < info.length; i += 1) {
            if (used[i] === true) continue
            if (info[i] !== null && info[i].code === group.code) {
              members.push(i)
              used[i] = true
            }
          }
          if (members.length === 0) continue
          notes.push({
            key: 'we:' + group.code,
            text: group.label(members.length),
            detail: members.map((i) => list[i]).join('\n'),
            count: members.length,
            grouped: true,
          })
        }

        for (let i = 0; i < list.length; i += 1) {
          if (used[i] === true) continue
          const parsed = info[i]
          const isExpected = parsed !== null && expectedCodes.indexOf(parsed.code) !== -1
          const item = {
            key: 'w:' + i,
            text: summarizeWarning(list[i]),
            detail: list[i],
            count: 1,
            grouped: false,
          }
          if (isExpected) notes.push(item)
          else faults.push(item)
        }
        return { faults, notes }
      }

      /** 非致命提示条（端点未就绪、服务端 faults 等）。 */
      /**
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

      /**
       * 说明性提示的**折叠块**（2026-10-07）。默认收起 → 界面上只常驻一行标题；
       * 展开后逐条显示、悬停还能看到完整原串。「不常驻打扰」与「不丢信息」同时满足。
       * 与 ui/overview.js 的 NoticeNotes 语义逐字一致（两个工厂各有一份实现）。
       */
      function WarnNotes(props) {
        const items = Array.isArray(props.items) ? props.items : []
        const count = items.reduce((sum, item) => sum + (typeof item.count === 'number' ? item.count : 1), 0)
        const detail = items
          .map((item) => (item.grouped === true ? item.text + '\n' + item.detail : item.detail))
          .join('\n')
        return el('details', { className: 'as_warnNotes', title: detail },
          el('summary', { className: 'as_warnNotes_summary' }, '说明性提示（' + String(count) + ' 项，点击展开查看）'),
          el('ul', { className: 'as_warnNotes_list' },
            items.map((item) => el('li', { className: 'as_warnNotes_item', key: item.key, title: item.detail }, item.text)),
          ),
        )
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

        // 问题二：「已完成未查看」的时间筛选（默认最近 7 天，可切全部）。
        // 只影响 unseen 这一组；running / approval 永远全量显示（它们本来就是「当下」的事）。
        const filterState = React.useState(readUnseenFilter)
        const unseenFilter = filterState[0]
        const setUnseenFilter = filterState[1]
        // 批量标记已读的结果提示（成功/失败都要有一行可诊断文案，不能静默）。
        const [markNotice, setMarkNotice] = React.useState(null)
        const [marking, setMarking] = React.useState(false)
        // 跳转失败提示（2026-10-07）：selectEntry 的返回值无人消费，失败必须显式冒泡到这里，
        // 否则用户点卡片没反应却看不到任何原因（真机验收实测的静默失效）。
        const [navNotice, setNavNotice] = React.useState(null)
        React.useEffect(() => {
          function onNavFailed(event) {
            const detail = event !== null && event !== undefined ? event.detail : null
            if (detail === null || detail === undefined) return
            setNavNotice({
              errorCode: detail.errorCode !== undefined ? detail.errorCode : 'NAVIGATION_FAILED',
              text: '跳转到该会话失败（' + String(detail.errorCode !== undefined ? detail.errorCode : 'NAVIGATION_FAILED') + '）：' + String(detail.reason !== undefined ? detail.reason : '未知原因'),
            })
          }
          if (typeof window === 'undefined' || window === null || typeof window.addEventListener !== 'function') return undefined
          window.addEventListener(NAVIGATION_EVENT, onNavFailed)
          return () => { window.removeEventListener(NAVIGATION_EVENT, onNavFailed) }
        }, [])
        const total = data.snapshot.counts.total
        const now = toPositive(config.now) > 0 ? toPositive(config.now) : Date.now()
        // ⚠️ 必须**只把 unseen 交给 partitionUnseen**：它是纯时间筛选器，不认 state。
        // 若把全量 entries（含 running/approval）喂进去，hidden 会把「运行中/待审批」
        // 也算成「被时间筛掉的已完成会话」，提示语就会说谎（首版接线正是这么错的）。
        // 切完再交给 groupByState：counts 是服务端全量口径，列表被筛过是正常的，
        // 差异由下面那行「另有 N 条…」显式说明，而不是让用户以为数据丢了。
        const allEntries = data.snapshot.entries
        const unseenEntries = []
        const entriesForList = []
        for (const entry of allEntries) {
          if (asRecord(entry) !== null && entry.state === 'unseen') unseenEntries.push(entry)
          else entriesForList.push(entry)
        }
        const split = partitionUnseen(unseenEntries, unseenFilter, now)
        const unseenVisible = split.visible
        for (let i = 0; i < split.visible.length; i += 1) entriesForList.push(split.visible[i])
        const groups = groupByState(entriesForList)

        const toggle = () => {
          const next = collapsed !== true
          setCollapsed(next)
          writeCollapsed(next)
        }

        // 切换筛选：写 localStorage + 立刻重渲染（不用等下一轮轮询）。
        const switchFilter = (next) => {
          const applied = writeUnseenFilter(next)
          setUnseenFilter(applied)
          setMarkNotice(null)
        }

        // 「全部标记已读」的作用范围必须与**当前筛选一致**：只看 7 天就只清 7 天。
        // 按钮文案显式写出范围，避免用户以为清掉了全部。
        const markAllVisibleSeen = () => {
          if (marking === true) return
          setMarking(true)
          const ids = unseenVisible.map((entry) => str(entry.id)).filter((id) => id !== '')
          markAllSeen(ids, { endpoint: str(config.seenEndpoint) !== '' ? config.seenEndpoint : undefined, fetch: config.fetch })
            .then((result) => {
              setMarking(false)
              if (result.ok === true) {
                setMarkNotice({ ok: true, text: '已标记 ' + String(result.applied) + ' 条为已读（范围：' + (unseenFilter === 'all' ? '全部' : '最近 ' + String(UNSEEN_RECENT_DAYS) + ' 天') + '）' })
                if (typeof config.onRefresh === 'function') config.onRefresh()
              } else {
                setMarkNotice({ ok: false, text: '标记已读失败（error_code=' + String(result.errorCode) + '），可稍后重试' })
              }
            })
        }

        if (isCollapsed === true) return el(Pill, { total, onExpand: toggle })

        const notices = []
        if (data.failure !== null && data.failure !== undefined) {
          const detail = describeError(data.failure)
          notices.push(el(Warn, { key: 'failure', text: '端点暂不可用（显示上一次数据）', detail }))
        }
        // 服务端 warnings 是**完整诊断串**（含 operation/target/error_code/context），
        // 实测单条就有 100+ 字符，直接铺在界面上会把面板占满、对用户是噪音。
        //
        // 2026-10-07：此前这里是**无条件逐条 push**，用户截图里的两条
        //（「这些会话没有可读的 session*.jsonl.zstd…」「非绝对 cwd 已降级…」）
        // 就是这么来的 —— 它们是**预期降级**，不是故障。
        // 现在按 classifyWarnings 分流：
        //   · 预期项 → 收进默认收起的 <details>，界面上只常驻一行标题；
        //   · 真故障 → 保持逐条常驻（摘要 + 完整串进 title），行为与之前一致。
        // 与工作总览页（ui/overview.js）行为**完全一致**。
        const classified = classifyWarnings(data.snapshot.warnings)
        for (const fault of classified.faults) {
          notices.push(el(Warn, { key: fault.key, text: fault.text, detail: fault.detail }))
        }
        if (classified.notes.length > 0) {
          notices.push(el(WarnNotes, { key: 'as-notes', items: classified.notes }))
        }
        // 跳转失败提示（2026-10-07）：必须是**可见**的一条，不能只放进 console。
        // 真机验收实测：点卡片毫无反应、控制台也无告警 —— 因为 selectEntry 的返回值没人消费。
        // 现在由 NAVIGATION_EVENT 冒泡上来，这里渲染成与其它警告同款的提示条。
        if (navNotice !== null) {
          notices.push(el(Warn, {
            key: 'nav-failed',
            text: '跳转失败：' + String(navNotice.errorCode),
            detail: 'operation=openSession target=uiWorkspace.openSession error_code=' + String(navNotice.errorCode) + ' | ' + String(navNotice.text),
          }))
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
            // 锁定态与切换回调由 OverlayHost 持有（它才是真正拥有 geometry 的人）；
            // 槽位内嵌形态不传，Head 便不渲染锁按钮。
            locked: config.locked === true,
            onToggleLock: typeof config.onToggleLock === 'function' ? config.onToggleLock : null,
          }),
          notices.length > 0 ? notices : null,
          // 问题二：unseen 时间筛选 + 「全部标记已读」。
          // 放在标题栏与列表之间（而不是塞进 unseen 分组标题）有两个原因：
          //   1) 分组标题宽度只有 ~120px（「已完成未查看」6 个字已经占满），塞不下两个控件；
          //   2) 控件是**跨分组**的设置（决定 unseen 这一组显示多少），放进分组标题里
          //      会让人误以为它只作用于那个分组。
          el('div', { className: 'as_filterBar' },
            el('span', { className: 'as_filterLabel' }, '已完成未查看'),
            el('button', {
              type: 'button',
              className: 'as_filterBtn' + (unseenFilter === 'recent' ? ' as_filterBtn_on' : ''),
              'aria-pressed': unseenFilter === 'recent',
              'data-as-unseen-filter': 'recent',
              title: '只看最近 ' + String(UNSEEN_RECENT_DAYS) + ' 天做的会话',
              onClick: () => { switchFilter('recent') },
            }, '近 ' + String(UNSEEN_RECENT_DAYS) + ' 天'),
            el('button', {
              type: 'button',
              className: 'as_filterBtn' + (unseenFilter === 'all' ? ' as_filterBtn_on' : ''),
              'aria-pressed': unseenFilter === 'all',
              'data-as-unseen-filter': 'all',
              title: '显示有史以来全部已完成未查看的会话',
              onClick: () => { switchFilter('all') },
            }, '全部'),
            unseenVisible.length > 0
              ? el('button', {
                  type: 'button',
                  className: 'as_filterBtn as_filterBtn_action',
                  'data-as-mark-all-seen': unseenFilter,
                  disabled: marking === true,
                  // 文案写清作用范围：只看 7 天就只清 7 天，不让用户以为清了全部。
                  title: '把当前范围内 ' + String(unseenVisible.length) + ' 条已完成未查看的会话标记为已读（范围：' + (unseenFilter === 'all' ? '全部' : '最近 ' + String(UNSEEN_RECENT_DAYS) + ' 天') + '）',
                  onClick: markAllVisibleSeen,
                }, marking === true ? '标记中…' : '全部标记已读（' + String(unseenVisible.length) + '）')
              : null,
          ),
          split.hidden > 0 && unseenFilter !== 'all'
            ? el('div', { className: 'as_filterHint' }, '另有 ' + String(split.hidden) + ' 条超过 ' + String(UNSEEN_RECENT_DAYS) + ' 天的已完成会话，已折叠（切到「全部」可查看）')
            : null,
          markNotice !== null
            ? el('div', {
                className: 'as_warn',
                role: 'status',
                title: 'operation=markAllSeen target=' + str(config.seenEndpoint !== undefined ? config.seenEndpoint : SEEN_ENDPOINT) + ' error_code=' + (markNotice.ok === true ? 'NONE' : 'MARK_ALL_FAILED'),
              }, markNotice.text)
            : null,
          el('div', { className: 'as_body' },
            groups.length === 0
              ? el(Empty, { phase: data.phase })
              : groups.map((group) => el(Group, { key: group.key, group, onSelect: config.onSelect, now })),
          ),
        )
      }

      // ── Bug 3（2026-10-06，用户实测「点侧栏图标会抢走中间工作区」）────────────
      // 背景（宿主契约，已读源码确认，**不要试图绕过**）：
      //   1. dsh-client-ui-sidebar/lib/client.js 的 PanelRow，onClick **硬编码**
      //      `selectPanel(id)`，插件没有任何拦截机会；
      //   2. dsh-client-ui-layout 的 LayoutController.selectPanel：
      //      `if (panelId !== null && !this.hasMainPanel(panelId)) throw` ——
      //      所以 main 槽位**必须**保留注册，删掉就一点击就抛异常（旧代码注释写的正是这条）。
      //
      // 那 main 槽位该渲染什么？读 MainPanel 的实现可知：
      //   renderSlot("main", {}, { entryKey: activePanelId ?? "conversation" })
      // keyed 槽位**只渲染命中的那一个 entry**（dsh-client-ui-renderer L827-829）。
      // 也就是说：只要 activePanelId 被设成 'active-sessions'，对话内容就一定被替换 ——
      // 哪怕我们渲染 null，中间也只会剩下一个**空白**的中央列，用户仍然会觉得「被抢走了」。
      //
      // 所以修法是两件事一起做：
      //   ① main 槽位注册一个**不渲染任何可见内容**的组件（不再画 .as_root 全屏列表）；
      //   ② 它挂载时立刻 `layout.selectPanel(null)` 把 main 槽位**还给 conversation** ——
      //      这才是真正做到「中间工作区保持原样」。
      // 效果：点侧栏图标 → 浮层唤回 + 中间对话原封不动。
      // ctx.layout 缺失时（极老宿主 / 单测桩）退化为「只唤回浮层、中间留空」，不会崩。
      let layoutFace = null;

      /** 记下宿主的跨插件动作面（apply 时从 ctx.layout 取）。 */
      function bindLayoutFace(face) {
        layoutFace = asRecord(face) === null ? null : face;
      }

      /**
       * 把 main 槽位交还给 conversation（activePanelId -> null）。
       * @returns {boolean} 是否真的交还了（false = 没有 layout 面 / 宿主抛错）
       */
      function handBackToConversation() {
        const face = layoutFace;
        if (face === null || face === undefined || typeof face.selectPanel !== 'function') {
          return false;
        }
        try {
          // selectPanel(null) 是宿主自己的「回到对话」语义（dsh-client-ui-workspace 也在用）。
          face.selectPanel(null);
          return true;
        } catch (error) {
          warnOnce('main:handBack', '交还 main 槽位失败（中间列可能留空）：' + describeError(error));
          return false;
        }
      }

      /**
       * `main` 槽位的挂载体：**不渲染任何可见内容**，只负责「唤回浮层 + 交还中央列」。
       *
       * 为什么不是直接 `return null` 就完事：见上面 handBackToConversation 的注释 ——
       * 渲染 null 只是把「全屏列表」换成「空白中央列」，对话一样回不来。
       *
       * 为什么不用 Component：Component 是给 sidebar.panellist 渲染紧凑 glyph 的，
       * 且默认分支是 FullPane（.as_root 全屏）。复用它会重新引入 Bug 3，
       * 也会破坏 panellist 的 glyph 渲染 —— 所以这里是一个**独立**组件。
       */
      function MainSlotHost() {
        // ⚠️ hook 必须在任何 return 之前（与 Component 同一条纪律，见那里的注释）。
        React.useEffect(() => {
          // 唤回浮层：用户点侧栏「活跃会话」图标 = 「我想看活跃会话」。
          // 这条机制原封不动地保留 —— 用户要的正是它。
          writeCollapsed(false);
          // 再把中央列还给对话，避免「点一下图标就把工作区内容弄没了」。
          handBackToConversation();
        }, []);
        injectStyles();
        return null;
      }

      /**
       * 对外主组件。宿主在不同上下文渲染同一个注册项：
       *  · 侧栏「面板导航行」会传 size（紧凑 glyph 语境）→ 渲染胶囊；
       *  · 作为长窗挂载时不传 size → 渲染完整三态列表（默认展开）。
       * 集成方也可用显式 mode 覆盖（mode:'pane' | 'glyph'）。
       */
      function Component(props) {
        const config = props === null || props === undefined ? {} : props
        // ⚠️ hook 必须**无条件**在顶层调用，且位于下面三个提前 return 之前。
        // 历史上 FullPane/OverlayHost 都因为条件 hook 炸过
        // （"Rendered fewer hooks than expected"），这里不能再犯。
        // 写渲染分支之前先调 hook，是这里唯一安全的写法。
        //
        // 依赖数组为空 = 只在挂载时跑一次。这既是性能考虑，也是**防回环的关键**：
        // 若改成依赖 collapsed，每次浮层状态变化都会再写一次，再触发 Component 重渲染，
        // 就成了活锁。空依赖把「唤回」钉死在「进入面板」这一个事件上。
        React.useEffect(() => {
          // 唤回浮层：用户点侧栏「活跃会话」图标 = 「我想看活跃会话」，
          // 于是把收起态清掉。没有这一步，胶囊删除后收起就是单向门。
          writeCollapsed(false)
        }, [])
        injectStyles()
        if (config.mode === 'glyph') return el(GlyphPane, config)
        if (config.mode === 'pane') return el(FullPane, config)
        if (typeof config.size === 'number') return el(GlyphPane, config)
        return el(FullPane, config)
      }


      /**
       * overlay 挂载形态：帧级浮层里的常驻长窗。**收起 = 完全不渲染**。
       *
       * 为什么单独一个组件而不是复用 Component：
       * Component 的展开/收起由 FullPane 内部的 collapsed 状态 + 外层容器决定；
       * overlay 里的定位（left/top/宽高）与槽位内嵌完全不同，需要自己的容器类。
       * 但**内部渲染完全复用** FullPane，保证两种形态视觉与行为一致。
       *
       * 三个状态各自独立持久化，互不牵连：
       *   collapsed —— 收起/隐藏；locked —— 锁定，停用拖拽手柄；
       *   geometry —— 拖出来的宽高。
       */
      function OverlayHost(props) {
        const config = props === null || props === undefined ? {} : props
        // 以下每一个 hook 都必须**无条件**在顶层调用，且全部位于任何 return 之前。
        // 历史事故：把 useSnapshot 只写在展开分支里，切到收起就抛
        // "Rendered fewer hooks than expected"。现在收起分支更早（直接 return null），
        // 这条约束只会更紧，不会更松。
        const collapsedState = React.useState(readCollapsed)
        const lockedState = React.useState(readLocked)
        const geometryState = React.useState(() => readOverlayGeometry())
        const topState = React.useState(OVERLAY_TOP_FALLBACK)
        const data = useSnapshot(config)

        const collapsed = collapsedState[0] === true
        const setCollapsed = collapsedState[1]

        // 订阅外部的收起状态变更（见模块级 collapseSubscribers 的说明）。
        // Component（侧栏图标 / main 面板）挂载时会 writeCollapsed(false) 唤回浮层，
        // 这条订阅就是浮层接收那次唤回的唯一通道。
        // 退订放在 cleanup 里 —— 不退订就是内存泄漏 + 幽灵 setState。
        // 注意：这里只同步 setState，**不碰 localStorage**。
        // 持久化只有一个写入口（writeCollapsed），避免「渲染时写盘」这种副作用。
        React.useEffect(() => subscribeCollapsed((next) => { setCollapsed(next) }), []);
        const locked = lockedState[0] === true
        const setLocked = lockedState[1]
        const geometry = geometryState[0]
        const setGeometry = geometryState[1]
        // top 是实测值，钳高度时要用；effect 跑完前先用兜底常量。
        const setTopPx = topState[1]
        const topPx = toPositive(topState[0]) > 0 ? toPositive(topState[0]) : OVERLAY_TOP_FALLBACK

        const toggle = () => {
          const next = collapsed !== true
          setCollapsed(next)
          writeCollapsed(next)
        }
        const toggleLock = () => {
          const next = locked !== true
          setLocked(next)
          writeLocked(next)
        }
        /** 套用几何。persist=true 才落盘（拖动过程中不写，松手才写一次）。 */
        const applyGeometry = (next, persist) => {
          setGeometry(next)
          if (persist === true) writeOverlayGeometry(next.w, next.h)
        }

        // 实测宿主侧栏宽度（--as-overlay-left）与会话头部高度（--as-overlay-top），
        // 使长窗既贴对侧栏右缘、又不压住导航栏。
        // 为什么放在 effect 里而不是渲染期：渲染期读 DOM 布局属于副作用，
        // 且首帧时侧栏可能尚未完成布局，读到的 grid 值会是初始态。
        React.useEffect(() => {
          // 收起态整窗不渲染，没有任何定位问题，也就不必测。
          if (collapsed === true) return undefined
          const apply = () => {
            measureSidebarOffset()
            setTopPx(measureOverlayTop())
          }
          apply()
          // 侧栏可被用户拖拽改变宽度，也可被收起/展开；窗口 resize 也要重测。
          // 用 rAF 合并连续变化（拖拽时 resize/过渡会高频触发）。
          if (typeof globalThis.addEventListener !== 'function') return undefined
          let pending = false
          const schedule = () => {
            if (pending === true) return
            pending = true
            const run = () => { pending = false; apply() }
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

        /**
         * 拖拽调尺寸。**完全照抄宿主侧栏调宽的写法**（用户明确要求对齐）：
         *   pointerdown 时 setPointerCapture(pointerId) + 记录原点；
         *   pointermove 用 requestAnimationFrame 节流算 dx/dy；
         *   pointerup / pointercancel / lostpointercapture 结束并 release。
         * CSS 侧配 cursor:col-resize / row-resize 与 touch-action:none。
         *
         * 锁定时直接不启动：手柄虽然已不渲染，这里再挡一道，
         * 防止将来有人把 onPointerDown 挂到别的元素上绕过锁定。
         *
         * @param {string} axis 'x' 调宽，'y' 调高
         * @param {object} startEvent 原生 pointerdown 事件（不可信，逐项判空）
         */
        function beginResize(axis, startEvent) {
          if (locked === true) return
          const host = asRecord(globalThis) === null ? {} : globalThis
          if (typeof host.addEventListener !== 'function' || typeof host.removeEventListener !== 'function') {
            warnOnce('beginResize', '当前环境没有全局事件对象，拖拽调尺寸不可用');
            return
          }
          const event = asRecord(startEvent) === null ? {} : startEvent
          const target = asRecord(event.currentTarget) !== null ? event.currentTarget : null
          const pointerId = toPositive(event.pointerId)
          const originX = Number(event.clientX) || 0
          const originY = Number(event.clientY) || 0
          const startWidth = geometry.w
          const startHeight = geometry.h
          if (target !== null && typeof target.setPointerCapture === 'function' && pointerId > 0) {
            try {
              target.setPointerCapture(pointerId)
            } catch (cause) {
              warnOnce('beginResize:capture', 'setPointerCapture 失败（改用全局监听继续拖拽）：' + describeError(cause));
            }
          }
          let pending = false
          let finished = false
          let latest = { w: startWidth, h: startHeight }
          const onMove = (moveEvent) => {
            if (finished === true) return
            const move = asRecord(moveEvent) === null ? {} : moveEvent
            const dx = (Number(move.clientX) || 0) - originX
            const dy = (Number(move.clientY) || 0) - originY
            latest = axis === 'x'
              ? { w: clampOverlayWidth(startWidth + dx), h: startHeight }
              : { w: startWidth, h: clampOverlayHeight(startHeight + dy, viewportHeight(), topPx) }
            if (pending === true) return
            pending = true
            const flush = () => {
              pending = false
              if (finished === true) return
              applyGeometry(latest, false)
            }
            if (typeof host.requestAnimationFrame === 'function') host.requestAnimationFrame(flush)
            else setTimeout(flush, 16)
          }
          const finish = () => {
            if (finished === true) return
            finished = true
            host.removeEventListener('pointermove', onMove)
            host.removeEventListener('pointerup', finish)
            host.removeEventListener('pointercancel', finish)
            host.removeEventListener('lostpointercapture', finish)
            if (target !== null && typeof target.releasePointerCapture === 'function' && pointerId > 0) {
              try {
                target.releasePointerCapture(pointerId)
              } catch (cause) {
                warnOnce('beginResize:release', 'releasePointerCapture 失败（忽略）：' + describeError(cause));
              }
            }
            // 落盘最后一次算出的几何：用户松手前那一帧可能还没等到 rAF。
            applyGeometry(latest, true)
          }
          host.addEventListener('pointermove', onMove)
          host.addEventListener('pointerup', finish)
          host.addEventListener('pointercancel', finish)
          host.addEventListener('lostpointercapture', finish)
        }

        // 收起 = **完全隐藏**（2026-10-05 用户确认，TODO-1/TODO-3 随之消解）。
        // 胶囊是冗余的第二入口：左侧栏「活跃会话」图标（GlyphPane，带圆点 + 计数 +
        // title）已经是唯一入口，且它比胶囊更显眼。返回 null 而不是空 div，
        // 这样浮层里连一个透明盒子都不留，pointer 事件彻底让位给主内容。
        if (collapsed === true) return null

        // 宽高走**内联自定义属性**而不是直接写 width/height：
        // 变量声明不会盖掉媒体查询里的 width 规则，窄屏兜底值因此仍然有效
        // （若直接内联 width，max-width:1280px 那两档就永远轮不到，窄屏即失效）。
        // 窄窗阈值：.as_head 里除 meta 外全是 flex:none 的固定件，
        // 加上 padding 24 + 4 个 gap 32，实测固定件合计约 155px。
        // 低于 220 时留给 meta 的不足 41px（不到其自然宽度 59px 的一半），
        // 省略号已经没信息量，不如整块隐藏，把空间还给标题与计数。
        const narrow = geometry.w <= OVERLAY_NARROW_WIDTH
        return el('div', {
          className: narrow === true ? 'as_overlayRoot as_narrow' : 'as_overlayRoot',
          'data-dsh-active-sessions': 'overlay',
          'data-narrow': narrow === true ? '1' : '0',
          'data-locked': locked === true ? '1' : '0',
          style: {
            '--as-overlay-width': String(geometry.w) + 'px',
            '--as-overlay-height': String(geometry.h) + 'px',
          },
        },
          el(FullPane, Object.assign({}, config, {
            onCollapse: toggle,
            forceExpanded: true,
            locked,
            onToggleLock: toggleLock,
          })),
          // 锁定时手柄**整块不渲染**：光改 pointer-events 的话它还会占 9px 命中区，
          // 点下去毫无反应，比看不见更容易让人反复点。
          locked === true
            ? null
            : el('div', {
              className: 'as_resizeX',
              'data-as-handle': 'width',
              title: '拖拽调整左窗宽度（180 到 420）',
              onPointerDown: (event) => { beginResize('x', event) },
            }),
          locked === true
            ? null
            : el('div', {
              className: 'as_resizeY',
              'data-as-handle': 'height',
              title: '拖拽调整左窗高度',
              onPointerDown: (event) => { beginResize('y', event) },
            }),
        )
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
        // ⚠️ 注册的是 MainSlotHost 而不是 Component（Bug 3）：它不渲染任何可见内容，
        // 挂载时唤回浮层并把中央列交还给对话。**绝不能删掉这条注册** ——
        // 删掉后 LayoutController.selectPanel 会直接抛
        // `main panel "active-sessions" is not registered`，一点击就崩。
        bindLayoutFace(ctx.layout)
      // 问题三：绑定宿主会话跳转面 —— **惰性**。
      // 为什么用 ctx.get 而不是 inject：见 bindWorkspaceFace 上方的结论 ——
      // ctx.get 服务缺席返回 undefined，天然可选；inject 缺席会让整个包停在 pending。
      //
      // ⚠️ 2026-10-07 真机验收实测：apply 时**不能**一次性取值并缓存。
      //   cordis 的 get(name, strict=true) 在提供者 fiber.state !== 2（未激活）时返回 undefined，
      //   而本包 apply 早于 ui-workspace 的 fiber 激活 → 永久缓存了 undefined → 点击静默失效。
      //   改为把 ctx 交给解析器，点击那一刻再实名求值（届时所有 fiber 早已激活）。
      bindWorkspaceFace(() => {
        if (typeof ctx.get !== 'function') return null
        // strict 显式传 false：拿「已注册但 fiber 正在切换」的实现也比拿不到强，
        // 且我们已在点击路径上 try/catch，不会因服务瞬时不可用而崩。
        return ctx.get('uiWorkspace', false) ?? null
      });
        const disposeMain = ctx.slots.inject('main', () => ctx.slots.register(
          { name: 'main', key: PANEL_ID },
          MainSlotHost,
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
        MainSlotHost,
        OverlayHost,
        PaneComponent: Component,
        apply,
        inject,
        React,
        // Pill 仍在列表里：槽位内嵌形态（Component / main 面板）的收起态继续用它，
        // 只有 overlay 形态不再渲染它。几何相关的纯函数一并导出，供自测直接单测。
        internals: {
          Pill, GlyphPane, Head, Warn, WarnNotes, Empty, Card, RelationLine, Cluster, Group, FullPane, useSnapshot, summarizeWarning,
          // 2026-10-07：警告的「预期 vs 故障」判定面（供单测与总览页对照）
          parseWarningLine, classifyWarnings, EXPECTED_WARNING_GROUPS,
          MainSlotHost, bindLayoutFace, handBackToConversation,
          // 问题二 / 问题三 的可测面
          readUnseenFilter, writeUnseenFilter, partitionUnseen, markAllSeen,
          bindWorkspaceFace, hasWorkspaceFace, resolveWorkspaceFace, resetWorkspaceFace, openSessionInHost, selectEntry,
          NAVIGATION_EVENT,
          measureOverlayTop, viewportHeight, maxOverlayHeight, defaultOverlayHeight,
          clampOverlayWidth, clampOverlayHeight, readOverlayGeometry, writeOverlayGeometry, readLocked, writeLocked,
          subscribeCollapsed, collapseSubscriberCount,
        },
      }
    }

    // ───────────── 模块级便捷导出（兼容 / 自测） ─────────────

    /**
     * 依赖声明：只依赖 slots + layout，**不注册任何模型可见工具**（0 token 硬约束）。
     *
     * ⚠️ 2026-10-06 新增 'layout'：Bug 3 的修法需要 `ctx.layout.selectPanel(null)`
     * 把 main 槽位交还给对话。layout 是 dsh-client-ui-layout 通过 ctx.reflect.provide
     * 暴露的跨插件动作面，官方侧栏自己也是 `inject = ["slots","layout",...]`。
     * 缺了它 main 槽位只能渲染空白中央列（不崩，但用户仍会以为内容被抢走）。
     */
    const inject = ['slots', 'layout']

    let defaultUi = null
    /** 惰性单例：给模块级 apply / PaneComponent 用（React 走 globalThis 探测）。 */
    function defaultSidebarUi() {
      if (defaultUi === null) defaultUi = createSidebarUi({})
      return defaultUi
    }

    /** 模块级组件（等价于 createSidebarUi(...).Component）。 */
    function PaneComponent(props) {
      const ui = defaultSidebarUi()
      return ui.Component(props)
    }

    /** 模块级装配函数（等价于 createSidebarUi(...).apply）。 */
    function apply(ctx) {
      return defaultSidebarUi().apply(ctx)
    }
      return createSidebarUi
    })()
    const createOverviewUi = (() => {
    /**
     * dsh-active-sessions —— 「工作总览」标签页（客户端 / 浏览器）
     *
     * 交付形态：导出工厂 createOverviewUi({ React })，由主代理在 src/client.js 的
     * __ModuleLoader__ factory 里内联调用，形如：
     *     const overview = createOverviewUi({ React })
     *     overview.apply(ctx)
     *
     * 为什么是工厂而不是独立 client bundle：
     *   DSH 客户端模块系统的 require(specifier) 只能解析 package.json 里
     *   dsh.client.external 声明过的外部包（如 react），**不能解析同包子路径**
     *   （dsh-client-modules/lib/index.js:389-407 已核实）。所以两个 UI 必须在唯一的
     *   src/client.js 里内联合并；本文件因此不写 __ModuleLoader__.load，也不 require 任何东西，
     *   React 走参数注入。这样既零构建步骤，又能被 node 直接 import 做语法自测。
     *
     * 硬约束（契约 §5/§6）：
     *   - 列表/列容器一律不用 backdrop-filter（它会成为 fixed 后代的包含块，
     *     把设置弹窗困在列里）；通透感用半透明实色 rgba 模拟。模糊只留给叶子节点。
     *   - 配色只引用契约第 5 节的 --as-* token，主色不硬编码。
     *   - 打开本页**不产生任何模型 token**：取数只打本插件自己的 localhost 端点。
     */

    /** 挂载槽位与标签定义（与 dsh-client-ui-trajectory 的注册方式同构）。 */
    const OVERVIEW_SLOT = 'conversation.view';
    const OVERVIEW_VIEW_ID = 'work-overview';
    /** 排在工具统计之后。 */
    const OVERVIEW_VIEW_ORDER = 40;

    /** 本插件自己的取数端点；契约 §4.2 的「localhost HTTP 端点」降级通道。 */
    const OVERVIEW_ENDPOINT = '/api/active-sessions/overview';

    /**
     * 「立即生成」的 POST 端点。
     *
     * ⚠️ 2026-10-06 修 Bug 1（用户实测 404）：客户端原先把 POST 也打到 OVERVIEW_ENDPOINT，
     * 而服务端对那条路径只放行 GET/HEAD（rpc.js 的 METHODS 表），且路由表是**逐字节匹配**、
     * 不做前缀/模糊匹配 → 稳定 404。用户看到的报错原文是
     *   生成失败（operation=generateOverview target=/api/active-sessions/overview error_code=HTTP_404）。
     * 这里刻意用**拼接**而不是另写一个字面量：拼接能保证它永远等于
     * 「GET 端点 + /generate」，而 tests/temp-e2e-overview-404.mjs 负责断言
     * 「客户端常量 === 服务端 rpc.js 的 ROUTES.overviewGenerate」，两侧再漂移就红。
     */
    const OVERVIEW_GENERATE_ENDPOINT = OVERVIEW_ENDPOINT + '/generate';

    /**
     * 隐藏名单切换端点（2026-10-07）。与服务端 rpc.js 的 ROUTES.overviewHidden 对应。
     *
     * ⚠️ 语义边界：这是**本插件总览页的显示控制**，不是 DSH 的工作区删除。
     *   界面上的一切文案都必须守住这条线 —— 按钮写「隐藏」而不是「删除」，
     *   确认框必须写明「DSH 的工作区与文件都不受影响」。
     *   一旦用户以为删了 DSH 的工作区，他的侧栏/会话就会"莫名其妙少一个"，
     *   而真相是本插件把它从这一页藏起来了 —— 那比不做功能更糟。
     */
    const OVERVIEW_HIDDEN_ENDPOINT = OVERVIEW_ENDPOINT + '/hidden';

    /**
     * 隐藏/恢复的二次确认文案（纯函数，导出到 internals 供单测直接断言）。
     *
     * 为什么必须把这句话写死并单独可测：它是本功能唯一的「语义说明书」。
     * 按钮叫「隐藏」，用户第一反应仍可能是「删掉？」，
     * 所以确认框里必须明确三件事：只影响本页 / DSH 数据不受影响 / 可以恢复。
     */
    function hiddenConfirmText(cwd, hide) {
      return hide === true
        ? '隐藏这个工作区？\n\n'
          + '只从「工作总览」这一页隐藏它。DSH 的工作区、侧栏、会话记录与文件都不受影响，'
          + '随时可以用工具栏的「已隐藏」入口恢复。\n\n'
          + cwd
        : '恢复这个工作区？它会重新出现在「工作总览」这一页。\n\n' + cwd;
    }

    /** localStorage 键：自动开关 / 模型选择 / 上次生成的文件签名快照。 */
    const LS_AUTO = 'dsh-active-sessions.overview.auto';
    const LS_MODEL = 'dsh-active-sessions.overview.model';
    const LS_SIGNATURE = 'dsh-active-sessions.overview.signature';

    // ---------------------------------------------------------------------------
    // 模型下拉的数据源与「不可解析」防线（2026-10-07，用户实测 Bug：立即生成点了没内容）
    // ---------------------------------------------------------------------------
    //
    // ⚠️ **这里曾有一份 PLACEHOLDER_MODELS 占位表，第一项是 'session-default'。**
    //   它被当作 state.model 的初值，于是用户点「立即生成」时 POST 的 body 是
    //     {"generate":true,"model":"session-default"}
    //   而服务端 resolveModelRoute('session-default', catalog) 目录里查不到、串里也没有 '/'，
    //   返回 null → 后端一个模型都没调 → 返回空 summaries（用户看到的「点了没内容」）。
    //
    // ⚠️ **「跟随会话默认模型」这条路根本不存在**（已核对 @deepseek-ai/dsh-llm 的
    //   call-config.d.ts：`LlmCallConfig.provider` 与 `model` 都是必填 string，
    //   GenerateOptions 里没有「不给 route 就用会话默认」的语义）。
    //   所以占位表不是降级方案，是**死路**：删掉，改成「目录未就绪 = 没有可选项 =
    //   按钮禁用 + 明确文案」，并让目录一到就自动纠正默认值。
    //
    // 目录来源不变：GET /api/active-sessions/overview 返回的 models 字段（rpc.js 里由
    // models.js 经 ctx.get('llm') 取）。取不到就如实显示「模型服务不可用」，不编假模型。

    /** 下拉的选项值：<provider>/<model>。裸 id 在跨 provider 同名时无法消歧。 */
    function modelOptionValue(model) {
      if (!isRecord(model)) return '';
      const id = typeof model.id === 'string' ? model.id : '';
      if (id === '') return '';
      const provider = typeof model.provider === 'string' ? model.provider : '';
      return provider === '' ? id : provider + '/' + id;
    }

    /**
     * 前端版的 resolveModelRoute：**与 src/models.js 的同名函数同规则**，用于 POST 前预校验。
     *
     * 规则（逐条对齐 models.js:92-108）：
     *   1. 目录内按**裸 id**唯一命中 → 可解析（多 provider 同名 → 不猜，返回不可解析）；
     *   2. 退化：形如 `provider/model` 的自描述形式（'/' 不在首尾）→ 可解析。
     * 判不出来就返回 null，调用方**不得发 POST**（发了注定返回 NO_SUMMARIES）。
     */
    function canResolveRoute(selected, models) {
      const text = typeof selected === 'string' ? selected : '';
      if (text === '') return null;
      const list = Array.isArray(models) ? models : [];
      const hits = list.filter(
        (m) => isRecord(m) && m.id === text && typeof m.provider === 'string' && m.provider !== '',
      );
      if (hits.length === 1) return { provider: hits[0].provider, model: String(hits[0].id) };
      if (hits.length > 1) return null;
      const slash = text.indexOf('/');
      if (slash > 0 && slash < text.length - 1) {
        const provider = text.slice(0, slash);
        // ⚠️ 这里比后端**更严**，且是有意的：
        //   后端 models.js 对自描述形式的退化分支不做目录校验（目录查不到也照样解析），
        //   那是给「目录服务临时不可用」的兜底。但前端只应发出**确信会成功**的请求 ——
        //   目录已就绪却找不到这个 provider，说明选中值已过期，发过去只会换一个错误码。
        //   目录为空（未就绪）同样一律拒绝：此刻没有任何值能被证实。
        if (list.length === 0) return null;
        if (list.some((m) => isRecord(m) && m.provider === provider)) {
          return { provider, model: text.slice(slash + 1) };
        }
        return null;
      }
      return null;
    }

    /**
     * 把「当前选中值 / localStorage 旧值」纠正成一个**能被路由解析**的选项值。
     *
     * 为什么要纠正而不是让用户自己再选一次：用户是在页面刚冷启动、目录还在路上的时候点的
     * 「立即生成」（这不是他选错了，是时序）。把选择权还给他等于让 bug 重现一次。
     * 目录一到就自动落到目录里的第一项，并写回 localStorage —— 这样他**下一次点必然成功**。
     *
     * @returns {string} 能解析的选项值；目录为空时返回 ''（调用方据此禁用按钮）。
     */
    function resolveSelectedModel(raw, models) {
      const list = Array.isArray(models) ? models : [];
      // 目录为空是唯一的「无解」：此时没有可纠正的目标，只能让调用方禁用按钮。
      if (list.length === 0) return '';
      const text = typeof raw === 'string' ? raw : '';
      if (text !== '') {
        // 1) 已经是某个选项的原值 → 原样保留（不打断用户刚做的选择）。
        for (const model of list) {
          if (modelOptionValue(model) === text) return text;
        }
        // 2) localStorage 里可能是**裸 id**（旧版本存过），按唯一命中还原成 <provider>/<id>。
        const byId = list.filter((m) => isRecord(m) && m.id === text);
        if (byId.length === 1) return modelOptionValue(byId[0]);
        // 3) 自描述形式 'provider/model'：只有 provider **仍在目录里**才认。
        //    provider 已消失说明这是过期值，留着会让服务端把请求打到一个不存在的适配器上
        //    （resolveModelRoute 对自描述形式**不做目录校验**，照样解析得出来 —— 这正是
        //    「点得下去、一定失败」的另一条暗路，必须在前端挡掉）。
        const slash = text.indexOf('/');
        if (slash > 0 && slash < text.length - 1 && list.some((m) => isRecord(m) && m.provider === text.slice(0, slash))) {
          return text;
        }
      }
      // 4) 兜底：无有效选择 / 选择已过期 → 纠正为目录第一项。
      //    list 的顺序由 models.js 排序（provider,id）保证稳定，同输入必同输出。
      //    ⚠️ 这里**不能**返回 ''：那正是本次 Bug 的形态（点了没反应）。
      return modelOptionValue(list[0]);
    }

    /** 自动模式的轮询周期：5 分钟。够用且不会给只读扫描加压。 */
    const AUTO_INTERVAL_MS = 5 * 60 * 1000;

    /** 单次取数的超时：本机端点不该更慢，卡住要有明确失败而不是无限转圈。 */
    const FETCH_TIMEOUT_MS = 15000;

    /**
     * 样式。整段用半透明实色，不用 backdrop-filter —— 见文件头硬约束说明。
     * 变量全部带契约 §5 给的回退值，皮肤未定义时也能看。
     */
    const CSS_TEXT = [
      '.asov_root{--as-accent:var(--dsw-alias-brand-text,#0f9d90);',
      '--as-accent-bg:rgba(18,167,155,.14);--as-accent-line:rgba(18,167,155,.42);',
      '--as-text:var(--dsw-alias-label-primary,#12324f);--as-text2:var(--dsw-alias-label-secondary,#3a5a7c);',
      '--as-tertiary:var(--dsw-alias-label-tertiary,#5a7699);--as-panel:var(--dsw-alias-bg-layer-1,#f5fbfbee);',
      '--as-card:var(--dsw-alias-bg-layer-2,#e9f6f6ee);--as-line:var(--dsw-alias-border-l1,#12324f1f);',
      '--as-run:#0f9d90;--as-run-bg:rgba(18,167,155,.16);--as-appr:#b7791f;--as-appr-bg:rgba(214,158,46,.18);',
      '--as-done:#5a7699;--as-done-bg:rgba(18,50,79,.10);',
      'display:flex;flex-direction:column;height:100%;min-height:0;overflow:hidden;',
      'color:var(--as-text);font-size:var(--dsh-content-font-size,14px)}',
      // 工具栏：半透明实色，禁止 backdrop-filter
      '.asov_toolbar{display:flex;align-items:center;gap:12px;flex-wrap:wrap;',
      'padding:14px 20px;border-bottom:1px solid var(--as-line);background:var(--as-panel);flex:0 0 auto}',
      '.asov_title{font-weight:600;font-size:15px;color:var(--as-text);margin-right:auto}',
      '.asov_title small{font-weight:400;color:var(--as-tertiary);margin-left:8px;font-size:12px}',
      '.asov_controls{display:flex;align-items:center;gap:10px;flex-wrap:wrap}',
      '.asov_field{display:flex;align-items:center;gap:6px;font-size:12px;color:var(--as-text2)}',
      '.asov_select,.asov_button{height:30px;border-radius:8px;font-size:12px;padding:0 10px;cursor:pointer;',
      'border:1px solid var(--as-line);background:var(--as-card);color:var(--as-text)}',
      '.asov_select{border-color:var(--as-accent-line)}',
      '.asov_button:disabled{opacity:.5;cursor:default}',
      '.asov_button_primary{background:var(--as-accent);border-color:transparent;color:#fff;font-weight:500}',
      '.asov_switch{display:inline-flex;align-items:center;gap:6px;cursor:pointer;user-select:none}',
      // 滚动区：列表容器，同样禁止 backdrop-filter
      '.asov_body{flex:1 1 auto;min-height:0;overflow:auto;padding:16px 20px 40px;background:transparent}',
      '.asov_empty{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:10px;',
      'padding:64px 20px;text-align:center;color:var(--as-tertiary)}',
      '.asov_empty_main{font-size:14px;color:var(--as-text2)}',
      '.asov_notice{border:1px solid var(--as-line);border-radius:10px;padding:10px 12px;margin-bottom:14px;',
      'font-size:12px;line-height:18px;background:var(--as-card);color:var(--as-text2)}',
      '.asov_notice_warn{border-color:var(--as-appr);background:var(--as-appr-bg);color:var(--as-appr)}',
      // 说明性提示的折叠块（2026-10-07）：默认收起，界面上只占一行，展开才逐条。
      '.asov_notes{border:1px dashed var(--as-line);border-radius:10px;padding:8px 12px;margin-bottom:14px;',
      'font-size:12px;line-height:18px;color:var(--as-tertiary);background:transparent}',
      '.asov_notes_summary{cursor:pointer;outline:none;user-select:none}',
      '.asov_notes_summary:hover{color:var(--as-text2)}',
      '.asov_notes_list{margin:8px 0 0;padding:0 0 0 18px;display:flex;flex-direction:column;gap:4px}',
      '.asov_notes_item{font-size:12px;line-height:18px;color:var(--as-tertiary);word-break:break-word}',
      // Bug 2 的顶部错误提示条：与 .asov_error 同一套 token，只是**不占满**正文区。
      '.asov_notice_error{border-color:var(--as-appr);background:var(--as-appr-bg);color:var(--as-appr);',
      'white-space:pre-wrap;word-break:break-word}',
      '.asov_notice_errorTitle{font-weight:600;margin-bottom:4px}',
      '.asov_notice_errorBody{font-size:12px;line-height:18px}',
      '.asov_ws{border:1px solid var(--as-line);border-radius:12px;margin-bottom:14px;background:var(--as-card);overflow:hidden}',
      '.asov_ws_head{display:flex;align-items:baseline;gap:10px;flex-wrap:wrap;padding:12px 14px;border-bottom:1px solid var(--as-line)}',
      '.asov_ws_name{font-weight:600;font-size:14px;color:var(--as-text)}',
      '.asov_ws_path{font-size:11px;color:var(--as-tertiary);font-family:var(--ds-font-family-code,monospace);word-break:break-all}',
      '.asov_ws_meta{margin-left:auto;font-size:11px;color:var(--as-tertiary);white-space:nowrap}',
      // 2026-10-07 隐藏工作区：卡片头尾的「隐藏」按钮 + 工具栏的「已隐藏（N）」入口。
      // 用 --as-* 既有 token，不引入新依赖；沿用 asov_button 的形态避免两套按钮样式。
      '.asov_hideBtn{height:24px;border-radius:6px;font-size:11px;padding:0 8px;cursor:pointer;',
      'border:1px solid var(--as-line);background:transparent;color:var(--as-tertiary);white-space:nowrap}',
      '.asov_hideBtn:hover:not(:disabled){color:var(--as-appr);border-color:var(--as-appr)}',
      '.asov_hideBtn:disabled{opacity:.5;cursor:default}',
      '.asov_hidden{border:1px dashed var(--as-line);border-radius:10px;padding:6px 10px;font-size:12px;color:var(--as-tertiary)}',
      '.asov_hidden_summary{cursor:pointer;outline:none;user-select:none}',
      '.asov_hidden_summary:hover{color:var(--as-text2)}',
      '.asov_hidden_list{margin:8px 0 0;padding:0;list-style:none;display:flex;flex-direction:column;gap:4px}',
      '.asov_hidden_item{display:flex;align-items:center;gap:8px;font-size:11px;font-family:var(--ds-font-family-code,monospace);word-break:break-all}',
      '.asov_restoreBtn{flex:0 0 auto;height:22px;border-radius:6px;font-size:11px;padding:0 8px;cursor:pointer;',
      'border:1px solid var(--as-accent-line);background:var(--as-accent-bg);color:var(--as-accent);font-family:inherit}',
      '.asov_badge{display:inline-block;padding:1px 7px;border-radius:999px;font-size:11px;line-height:16px}',
      '.asov_badge_new{background:var(--as-accent-bg);color:var(--as-accent);border:1px solid var(--as-accent-line)}',
      '.asov_ws_body{padding:12px 14px}',
      '.asov_points{font-size:13px;line-height:22px;color:var(--as-text2);white-space:pre-wrap;word-break:break-word}',
      '.asov_points_empty{font-size:12px;color:var(--as-tertiary);font-style:normal}',
      '.asov_files{margin-top:12px;border-top:1px dashed var(--as-line);padding-top:10px}',
      '.asov_files summary{cursor:pointer;font-size:12px;color:var(--as-tertiary);outline:none}',
      '.asov_filelist{margin:8px 0 0;padding:0;list-style:none;display:flex;flex-direction:column;gap:4px}',
      '.asov_file{display:flex;gap:8px;font-size:11px;color:var(--as-tertiary);',
      'font-family:var(--ds-font-family-code,monospace);word-break:break-all}',
      '.asov_file_kind{flex:0 0 auto;opacity:.75}',
      '.asov_file_size{flex:0 0 auto;margin-left:auto;white-space:nowrap}',
      '.asov_error{border:1px solid var(--as-appr);background:var(--as-appr-bg);color:var(--as-appr);',
      'border-radius:10px;padding:12px 14px;font-size:12px;line-height:18px;white-space:pre-wrap;word-break:break-word}',
    ].join('');

    /**
     * 注入 <style>。用 data-plugin 去重，避免 HMR / 重复 apply 时叠加多份。
     * 必须在函数内做 DOM 访问：本文件要被 node 直接 import 做语法自测，顶层不能碰 document。
     */
    function ensureStyle() {
      if (typeof document === 'undefined') return;
      const existing = document.querySelector('style[data-plugin="dsh-active-sessions-overview"]');
      if (existing !== null) return;
      const tag = document.createElement('style');
      tag.dataset.plugin = 'dsh-active-sessions-overview';
      tag.textContent = CSS_TEXT;
      document.head.appendChild(tag);
    }

    /** 外部输入（localStorage / 端点响应）一律不可信：只在形状正确时才取值。 */
    function isRecord(value) {
      return typeof value === 'object' && value !== null && !Array.isArray(value);
    }

    /**
     * 浏览器侧的有界 fetch：超时 + 非 2xx + JSON 解析失败都要有明确分支。
     *
     * ⚠️ credentials 必须显式设为 same-origin：
     *   DSH 的 /api 路由有浏览器 cookie 鉴权（未带凭据会 401）。
     *   虽然 fetch 的**默认值本就是 same-origin**，但显式声明有两个好处：
     *   1. 与左侧栏的 fetchState 保持一致（那里也显式设了）；
     *   2. 未来若有调用方传入自己的 init（例如改成 cors 模式），不会静默丢掉凭据。
     */
    async function jsonFetch(url, init) {
      const controller = typeof AbortController === 'function' ? new AbortController() : null;
      const timer = controller === null ? null : setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
      const base = { credentials: 'same-origin', ...init };
      try {
        const response = await fetch(url, controller === null ? base : { ...base, signal: controller.signal });
        const status = response.status;
        if (!response.ok) {
          return { ok: false, code: 'HTTP_' + String(status), message: 'HTTP ' + String(status) + ' ' + response.statusText };
        }
        const text = await response.text();
        if (text.trim() === '') return { ok: false, code: 'EMPTY_BODY', message: '端点返回空响应体' };
        let data;
        try {
          data = JSON.parse(text);
        } catch (error) {
          return { ok: false, code: 'JSON_PARSE_FAILED', message: '响应不是合法 JSON: ' + String(text.slice(0, 200)) };
        }
        return { ok: true, status: status, data: data };
      } catch (error) {
        const aborted = isRecord(error) && error.name === 'AbortError';
        return {
          ok: false,
          code: aborted ? 'TIMEOUT' : 'NETWORK_ERROR',
          message: aborted ? '请求超时（' + String(FETCH_TIMEOUT_MS) + 'ms）' : String(isRecord(error) ? error.message : error),
        };
      } finally {
        if (timer !== null) clearTimeout(timer);
      }
    }

    /** 安全读 localStorage：隐私模式下会抛，不能让它带走整个组件。 */
    function readLocal(key) {
      try {
        return typeof localStorage === 'undefined' ? null : localStorage.getItem(key);
      } catch {
        return null;
      }
    }
    function writeLocal(key, value) {
      try {
        if (typeof localStorage !== 'undefined') localStorage.setItem(key, value);
      } catch {
        /* 隐私模式不可写：静默降级为「本次会话有效」，属于预期行为而非错误 */
      }
    }

    /** 从 OverviewResult 里取一个 cwd 的签名，用来判断「文件清单是否有变化」。 */
    function signatureOf(result) {
      if (!isRecord(result) || !Array.isArray(result.workspaces)) return '';
      const parts = [];
      for (const ws of result.workspaces) {
        if (!isRecord(ws) || typeof ws.cwd !== 'string') continue;
        const files = Array.isArray(ws.files) ? ws.files : [];
        let maxMtime = 0;
        for (const file of files) {
          if (isRecord(file) && typeof file.mtimeMs === 'number' && file.mtimeMs > maxMtime) maxMtime = file.mtimeMs;
        }
        parts.push(ws.cwd + ':' + String(files.length) + ':' + String(maxMtime));
      }
      parts.sort();
      return parts.join('|');
    }

    /** 文件名大小的可读化，只用于展示。 */
    function humanBytes(bytes) {
      if (typeof bytes !== 'number' || !Number.isFinite(bytes) || bytes < 0) return '';
      if (bytes < 1024) return String(bytes) + ' B';
      if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
      return (bytes / (1024 * 1024)).toFixed(2) + ' MB';
    }

    // ---------------------------------------------------------------------------
    // 警告串摘要化（TODO-4）
    //
    // 服务端 warnings 里每一条都是 warnLine 拼出来的**完整诊断串**：
    //     [operation] target -> ERROR_CODE: message {contextJson}
    // 实测单条 100~200 字符，5 条就能把工作总览页首屏占满。左窗已用
    // 「一句话摘要 + 完整串进 title」解决过同一问题（src/ui/sidebar.js），
    // 这里照抄同一套语义。
    //
    // ⚠️ 为什么是**复制**而不是抽公共模块：
    //   DSH 客户端 __ModuleLoader__ 的 require(specifier) 只能解析
    //   dsh.client.external 声明过的外部包（如 react），**不能解析同包子路径**。
    //   所以 ui/sidebar.js 与 ui/overview.js 必须是两个各自闭合的 IIFE 式工厂。
    //   这是架构约束导致的必要重复，不是没做 DRY。
    // ---------------------------------------------------------------------------

    /** 取字符串；非字符串一律给空串（与 ui/sidebar.js 的同名工具语义一致）。 */
    function str(value) {
      return typeof value === 'string' ? value : '';
    }

    /**
     * 把服务端诊断串压缩成一句话摘要（完整串留给 title）。
     *
     * 与 ui/sidebar.js 的同名函数**逐字一致**（包括 60 字阈值与三级兜底）：
     * 规范格式下直接取 message 段；解析不出（历史 key=value 串 / 非本插件产出）时
     * 回落到旧的 key=value 抽取，再不行整串截断。
     * 行为必须一致，否则**同一串在左窗和总览页会显示成两句话** ——
     * tests/temp-e2e-warning-groups.mjs 专门对两份实现跑同一组夹具断言一致。
     * （2026-10-07 实测踩过：只改了左窗的摘要、总览页还在按 key=value 抽，
     *   同一条 PROJECTION_INVALID_JSON 在两页显示成两句话。）
     */
    function summarizeWarning(raw) {
      const text = str(raw);
      if (text === '') return '有一条非致命提示（悬停查看详情）';
      const parsed = parseWarningLine(text);
      if (parsed !== null && parsed.message !== '') {
        return parsed.message.length > 60 ? parsed.message.slice(0, 60) + '…' : parsed.message;
      }
      // 兜底一：规范格式但没有 message 段 → 用 CODE + target 表达
      if (parsed !== null) {
        const fallback = (parsed.code === '' ? '' : parsed.code) + (parsed.target === '' ? '' : ' ' + parsed.target);
        if (fallback !== '') return fallback.length > 60 ? fallback.slice(0, 60) + '…' : fallback;
      }
      // 兜底二：历史 key=value 形态（保留仅为向后兼容，**不作为预期/故障判定依据**）
      const pick = (key) => {
        const m = text.match(new RegExp(key + '=([^]*?)(?=\\s+[a-z_]+=|$)'));
        return m !== null && m !== undefined ? str(m[1]).trim() : '';
      };
      const msg = pick('message') || pick('input_summary');
      if (msg !== '') return msg.length > 60 ? msg.slice(0, 60) + '…' : msg;
      // 兜底三：整串截断。
      return text.length > 60 ? text.slice(0, 60) + '…' : text;
    }

    /**
     * 解析服务端诊断串的**规范格式**（2026-10-07 统一）：
     *
     *     [operation] target -> ERROR_CODE: message {contextJson}
     *
     * 这个格式由服务端 src/overview.js 的 warnLine 定义，**src/states.js 的 describeError
     * 现在也产出同一形态**（此前它产出的是 `[states] operation=… error_code=Error` 的
     * key=value 串，正则匹配不上 → 左窗那两条提示全部落进「未分组」逐条刷屏）。
     *
     * 为什么不用一条正则搞定：`message` 里可能含花括号，一��正则的惰性分组会把
     * message 截断、并把 message 的一段当成 context。改成**从右往左**找可 JSON.parse 的
     * 尾段 —— context 永远是最后一段且必然是合法 JSON，所以这个判定是无歧义且确定的。
     *
     * 解析不出就返回 null，由调用方按「无法归类的单条」降级处理 —— 宁可不合并，也不能吞内容。
     */
    function parseWarningLine(raw) {
      const text = str(raw);
      if (text === '') return null;
      // 1) 方括号里是 operation
      const head = text.match(/^\[([^\]]*)\]\s*([\s\S]*)$/);
      if (head === null || head === undefined) return null;
      const operation = str(head[1]);
      const rest = str(head[2]);

      // 2) target 与 CODE 之间用 ' -> ' 分隔。取**最后一个** ' -> '：
      //    target 是路径，正则惰性匹配只取第一个，中途出现 ' -> ' 就会把后半截当成 CODE。
      const arrow = rest.lastIndexOf(' -> ');
      if (arrow <= 0) return null;
      const target = rest.slice(0, arrow).trim();
      const tail = rest.slice(arrow + 4).trim();

      // 3) CODE 必须是 [A-Za-z0-9_]+
      const codeMatch = tail.match(/^([A-Za-z0-9_]+)\s*([\s\S]*)$/);
      if (codeMatch === null || codeMatch === undefined) return null;
      const code = str(codeMatch[1]);
      let body = str(codeMatch[2]).trim();
      if (body.startsWith(':')) body = body.slice(1).trim();

      // 4) 尾段若能 JSON.parse 成对象，就是 context（从右往左试）
      let context = '';
      let message = body;
      for (let i = body.lastIndexOf('{'); i >= 0; i = body.lastIndexOf('{', i - 1)) {
        if (i <= 0) break;
        try {
          const parsed = JSON.parse(body.slice(i));
          if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
            context = body.slice(i);
            message = body.slice(0, i).trim();
            break;
          }
        } catch {
          /* 不是合法 JSON 尾段，继续往左找 */
        }
      }
      return { operation, target, code, message, context, raw: text };
    }

    // ---------------------------------------------------------------------------
    // 警告的「预期 vs 故障」判定表（2026-10-07）
    //
    // 用户原话：「这一块别留着……要么解决要么别提示」。两条路：真去消除（做不到 ——
    // 截断/降级是插件保护宿主的必要行为，笔记多了必然触发），或**做到不常驻打扰**。
    // 本表就是后者的落点：
    //
    //   ⚠️ 预期项（EXPECTED）→ 折叠成一行「N 项说明性提示，点击展开」，默认不展开，
    //      且**不进首屏噪音区**；完整原串全部保留在 title 与展开区里，可诊断性不丢。
    //   ❌ 真故障（其余全部）→ 常驻可见，行为与之前一致，绝不折叠、绝不丢弃。
    //
    // ⚠️ 归类依据是 **error_code**，不是字符串猜测。而 error_code 能可靠存在的前提是
    //    服务端每条告警都产出规范格式 + 真实 code（states.js 已改造）——
    //    解析不出来的串一律按**故障**处理（宁可多显示一条，也不藏真实问题）。
    //
    // ⚠️ 本表与 ui/sidebar.js 的同名表**逐字一致**：两个 UI 是分别内联进 client.js 的
    //    独立工厂，DSH 客户端 require 不了同包子路径，跨文件 import 会被 loader 拒绝。
    //    tests/temp-e2e-warning-groups.mjs 对两份实现跑同一组夹具并断言输出相同，
    //    防止「改了一边忘了另一边」。
    // ---------------------------------------------------------------------------

    /**
     * 预期行为（非故障）的 error_code → 合并文案。
     *
     * ⚠️ 这张表覆盖了服务端**全部**设计内降级码（states.js + overview.js 两个产出方），
     * 逐条列全是有意的：漏一个码，那类降级就会以「真故障」的姿态常驻刷屏 ——
     * 这正是本次用户投诉的现象（2026-10-07 真机 e2e 就抓到漏网的
     * EXCERPT_BUDGET_EXHAUSTED）。新增降级码时必须同步登记到这张表。
     *
     * 判定口径只有一条：**这是插件为了保护宿主/自己主动做的让步吗？**
     *   是 → 预期（折叠，不常驻打扰）
     *   否 → 故障（常驻可见）—— 包括读不到、解析失败、llm 不可用、生成失败。
     *
     * 顺序即展示顺序，是这张表的数组顺序（不是对象枚举顺序）—— 保证确定性。
     */
    const EXPECTED_WARNING_GROUPS = [
      // ── 总览页（src/overview.js）：扫描/摘录的上限保护 ──
      { code: 'WORKSPACE_TRUNCATED', label: (n) => n + ' 个工作区的笔记已截断（文件数/体积超限）' },
      { code: 'FILE_TOO_LARGE', label: (n) => n + ' 个超大文件已被跳过（单文件超过体积上限）' },
      { code: 'ENTRY_BUDGET_EXCEEDED', label: (n) => n + ' 处目录扫描触达条目上限，子目录未继续深入' },
      { code: 'EXCERPT_BUDGET_EXHAUSTED', label: (n) => n + ' 处笔记摘录预算用尽（超出的文件只列路径）' },
      { code: 'SESSION_SCAN_CAPPED', label: (n) => n + ' 处会话扫描达到文件数上限（更早的会话未纳入）' },
      // ── cwd 归一化（overview.js 与 states.js 共用同一码，因此两边合并成一条）──
      { code: 'CWD_NOT_ABSOLUTE', label: (n) => n + ' 个会话/目录的 cwd 不是绝对路径，已降级' },
      { code: 'CWD_NOT_ABSOLUTE_MANY', label: (n) => n + ' 条非绝对路径已全部丢弃' },
      // ── 三态扫描（src/states.js）──
      { code: 'SESSION_LOG_MISSING', label: (n) => n + ' 个会话没有可读的会话日志，已按「不判活」处理' },
      { code: 'DUPLICATE_SESSION_ID', label: (n) => n + ' 条重复的会话投影已去重' },
      // ── 生成路径（src/index.js）：省 token 的设计内复用 ──
      { code: 'NOTE_CACHE_REUSED', label: (n) => n + ' 处复用了上次生成结果（笔记未变化，未调用模型）' },
      { code: 'NOTE_PERSISTED_REUSED', label: (n) => n + ' 处复用了已落盘的总结（笔记指纹一致，未调用模型）' },
      // ── 生成路径（src/index.js）：没有笔记就没有可总结的内容 ──
      // ⚠️ 2026-10-07 新增。跳过空工作区是**主动省钱**的设计内让步（实测 21 个工作区里
      //    8 个是 0 文件，旧实现照样发起模型调用、只能回「摘录不足以判断」），
      //    不是故障。漏登记这一条，它就会以「真故障」的姿态常驻刷屏 —— 上一轮刚踩过这个坑。
      { code: 'EMPTY_WORKSPACE_SKIPPED', label: (n) => n + ' 个工作区没有笔记类文件，已跳过生成（未调用模型）' },
    ];

    /**
     * 把服务端 warnings 折成「故障（常驻）」与「说明（折叠）」两堆。
     *
     * 顺序：每堆内部先按 EXPECTED_WARNING_GROUPS 的固定表序输出合并项，
     * 再按**原始数组下标序**输出未合并的单条。全程只依赖下标与表序 →
     * 同输入必同输出（契约 §3.5 确定性要求）。
     *
     * @param {unknown} warnings 服务端 warnings 数组（不可信输入）
     * @returns {{faults: Array<{key,text,detail,count,grouped}>,
     *            notes:  Array<{key,text,detail,count,grouped}>}}
     */
    function classifyWarnings(warnings) {
      const list = (Array.isArray(warnings) ? warnings : []).map(str).filter((text) => text !== '');
      const info = list.map(parseWarningLine);
      const expectedCodes = new Set(EXPECTED_WARNING_GROUPS.map((g) => g.code));
      const used = [];
      for (let i = 0; i < list.length; i += 1) used.push(false);
      const faults = [];
      const notes = [];

      for (const group of EXPECTED_WARNING_GROUPS) {
        const members = [];
        for (let i = 0; i < info.length; i += 1) {
          if (used[i] === true) continue;
          if (info[i] !== null && info[i].code === group.code) {
            members.push(i);
            used[i] = true;
          }
        }
        if (members.length === 0) continue;
        notes.push({
          key: 'we:' + group.code,
          text: group.label(members.length),
          // 完整原串一条都不丢，按原下标序用换行拼接（title 悬停 + 展开区都可见）。
          detail: members.map((i) => list[i]).join('\n'),
          count: members.length,
          grouped: true,
        });
      }

      for (let i = 0; i < list.length; i += 1) {
        if (used[i] === true) continue;
        const parsed = info[i];
        // 解析不出来的串 = 无法证明它是预期行为 → 按故障常驻显示（fail-safe）。
        const isExpected = parsed !== null && parsed !== undefined && expectedCodes.has(parsed.code);
        // key 用下标而不是原串：原串可能重复，用串做 key 会撞 React key。
        const item = {
          key: 'w:' + i,
          text: summarizeWarning(list[i]),
          detail: list[i],
          count: 1,
          grouped: false,
        };
        if (isExpected) notes.push(item);
        else faults.push(item);
      }
      return { faults, notes };
    }


    /**
     * 工厂：接收 React（由 src/client.js 注入），返回视图组件与注册函数。
     * @param {{React: any}} deps
     */
    function createOverviewUi(deps) {
      const input = isRecord(deps) ? deps : {};
      const React = input.React;
      if (isRecord(React) === false && typeof React !== 'function') {
        throw new Error('createOverviewUi: 需要传入 React（dsh-active-sessions/ui/overview）');
      }
      const h = React.createElement;

      /**
       * 非致命提示条。照抄左窗 ui/sidebar.js 的 Warn 组件：
       *   text   —— 给人看的一句话摘要（≤60 字量级）
       *   detail —— 完整原始诊断串，只放进 title，悬停可见，排查能力不丢。
       */
      function NoticeWarn(props) {
        return h(
          'div',
          {
            className: 'asov_notice asov_notice_warn',
            role: 'status',
            title: typeof props.detail === 'string' && props.detail.length > 0 ? props.detail : undefined,
          },
          props.text,
        );
      }

      /**
       * 说明性提示的**折叠块**（2026-10-07）。默认收起，界面上只常驻一行标题；
       * 展开后每条一行、悬停还能看到完整原串 —— 「不常驻打扰」与「不丢信息」同时满足。
       *
       * ⚠️ 用原生 <details>/<summary>：不需要额外 state、不需要事件处理，
       *    也不会与两个 UI 各自的渲染路径打架（两个工厂各有一份同名实现，语义逐字一致）。
       */
      function NoticeNotes(props) {
        const items = Array.isArray(props.items) ? props.items : [];
        const count = items.reduce((sum, item) => sum + (typeof item.count === 'number' ? item.count : 1), 0);
        const detail = items
          .map((item) => (item.grouped === true ? item.text + '\n' + item.detail : item.detail))
          .join('\n');
        return h(
          'details',
          { className: 'asov_notes', title: detail },
          h('summary', { className: 'asov_notes_summary' }, '说明性提示（' + String(count) + ' 项，点击展开查看）'),
          h(
            'ul',
            { className: 'asov_notes_list' },
            items.map((item) => h('li', { className: 'asov_notes_item', key: item.key, title: item.detail }, item.text)),
          ),
        );
      }

      /**
       * 工作总览主视图。作为 conversation.view 的条目组件渲染，
       * 因此它占满中间主界面，而不是浮层。
       */
      function WorkOverviewView() {
        const [state, setState] = React.useState({
          status: 'idle',
          result: null,
          error: null,
          generating: false,
          // ⚠️ 初始**空目录**而不是占位表：冷启动时模型目录还没回来，
          // 此时任何默认值都必然解析不出路由（见上面 canResolveRoute 的说明）。
          // 空目录 + 按钮禁用 + 「正在读取模型列表…」文案，是唯一不会骗人的初态。
          models: [],
          modelsLoaded: false,
          auto: readLocal(LS_AUTO) === '1',
          // 只持久化**真实选过的**模型；不写默认值，避免把占位串存进 localStorage 变成长期脏值。
          model: readLocal(LS_MODEL) || '',
          changed: false,
          lastGeneratedAt: 0,
          summaries: {},
          // 已隐藏工作区的 cwd 列表（2026-10-07）。由服务端 hiddenList 驱动，
          // 不在 localStorage 里存：单一真相在服务端文件里，客户端只做镜像。
          hidden: [],
          // 正在提交切换的 cwd（非空时该卡片与恢复按钮禁用，防重复提交）。
          pendingCwd: '',
        });
        const aliveRef = React.useRef(true);
        React.useEffect(() => {
          aliveRef.current = true;
          return () => {
            aliveRef.current = false;
          };
        }, []);

        const patch = React.useCallback((partial) => {
          if (!aliveRef.current) return;
          setState((prev) => ({ ...prev, ...partial }));
        }, []);

        /** 拉文件清单（0 token 路径）。 */
        const refresh = React.useCallback(
          async (mode) => {
            if (mode !== 'silent') patch({ status: 'loading', error: null });
            const response = await jsonFetch(OVERVIEW_ENDPOINT, { method: 'GET', headers: { accept: 'application/json' } });
            if (!response.ok) {
              patch({
                status: 'error',
                error: '读取工作总览数据失败（operation=fetchOverview target=' + OVERVIEW_ENDPOINT + ' error_code=' + response.code + '）：' + response.message,
              });
              return;
            }
            // ⚠️ 服务端用信封 {ok:true, data:...}（见 src/rpc.js 的 sendOk）。
            // jsonFetch 已经把响应体解析成对象，所以这里拿到的是**整个信封**，
            // 必须再剥一层 .data 才是真正的 OverviewResult。
            // 此前直接读 response.data.workspaces → 永远是 undefined，
            // 界面报 "keys(ok,data)"（用户实测反馈的真实 bug）。
            const envelope = response.data;
            const data = isRecord(envelope) && isRecord(envelope.data) ? envelope.data : envelope;
            if (!isRecord(data) || !Array.isArray(data.workspaces)) {
              patch({
                status: 'error',
                error: '端点返回结构不符（operation=parseOverview target=' + OVERVIEW_ENDPOINT + ' error_code=SHAPE_UNEXPECTED input_summary=keys(' + Object.keys(isRecord(data) ? data : {}).join(',') + ')）',
              });
              return;
            }
            const signature = signatureOf(data);
            const previous = readLocal(LS_SIGNATURE);
            const changed = previous !== null && previous !== '' && previous !== signature;
            const models = Array.isArray(data.models)
              ? data.models.filter((item) => isRecord(item) && typeof item.id === 'string' && modelOptionValue(item) !== '')
              : [];
            // ── 目录到达 → 自动纠正选中值（2026-10-07 用户实测 Bug 的正解）────────
            // 用户是在**目录还在路上**的时候点的「立即生成」，所以责任不在他。
            // 这里把「占位串 / 空值 / 目录里已不存在的旧值」统一纠正成目录首项，
            // 并写回 localStorage —— 他随后再点一次就必然命中真实模型。
            const wanted = resolveSelectedModel(state.model, models);
            if (wanted !== '' && wanted !== state.model) writeLocal(LS_MODEL, wanted);
            patch({
              status: 'ready',
              result: data,
              error: null,
              changed: changed,
              models: models,
              modelsLoaded: true,
              model: wanted,
              summaries: isRecord(data.summaries) ? data.summaries : state.summaries,
              // hiddenList 是**全量**隐藏名单（含已不是工作区根的那些），
              // 工具栏「已隐藏（N）」与恢复入口按它渲染，绝不按本页少了几张卡片来猜。
              hidden: Array.isArray(data.hiddenList)
                ? data.hiddenList.filter((item) => typeof item === 'string' && item !== '')
                : [],
            });
          },
          [patch, state.summaries, state.model],
        );

        React.useEffect(() => {
          refresh('initial');
          return undefined;
        }, []);

        /**
         * 自动模式相关的 ref。
         * 为什么用 ref：定时器回调若闭包捕获 state，会拿到创建时的过期快照；
         * 而把这些写进 effect 依赖又会让定时器每次渲染都重建、间隔失效。
         */
        const changedRef = React.useRef(false)
        const generatingRef = React.useRef(false)
        // 隐藏切换的在途标记。用 ref 而不是直接读 state.pendingCwd：
        // 连续两次点击之间 state 还没提交，用 state 会漏掉"上一次还在飞"这一段。
        const pendingCwdRef = React.useRef('')
        React.useEffect(() => {
          changedRef.current = state.changed === true
        }, [state.changed])
        React.useEffect(() => {
          generatingRef.current = state.generating === true
        }, [state.generating])

        const onToggleAuto = React.useCallback(
          (event) => {
            const auto = event.target.checked === true;
            writeLocal(LS_AUTO, auto ? '1' : '0');
            patch({ auto: auto });
          },
          [patch],
        );

        const onSelectModel = React.useCallback(
          (event) => {
            const model = String(event.target.value);
            writeLocal(LS_MODEL, model);
            patch({ model: model });
          },
          [patch],
        );

        /**
         * 隐藏 / 恢复某个工作区（2026-10-07）。
         *
         * 失败必须**可见**：沿用既有的 state.error 提示条通路（下面 notices 里那条红色横幅），
         * 不新造一套 toast —— 两个 UI 已经有 classifyWarnings/state.error 这套机制，
         * 再加一条并行通道只会让「哪里会出错」变得不可预测。
         *
         * 成功后的两件事：
         *   1) 立即把 hidden 列表换成服务端回的权威值（而不是本地推算，避免与服务端漂移）；
         *   2) 立刻把卡片从列表里拿掉 —— 不等下一轮轮询，否则用户会以为没生效又点一次。
         */
        const onToggleHidden = React.useCallback(
          async (rawCwd, hide) => {
            const cwd = String(rawCwd ?? '');
            if (cwd === '' || pendingCwdRef.current !== '') return;
            // 二次确认：隐藏是破坏性的**可见性**变更，总览页一屏 20+ 张卡片很容易误点。
            // confirm 在非浏览器环境（node 单测）不存在，此时按「已确认」放行 ——
            // 否则本函数在测试里会永远走不到发请求那一步。
            const confirmFn = typeof globalThis !== 'undefined' ? globalThis.confirm : undefined;
            if (typeof confirmFn === 'function') {
              if (confirmFn(hiddenConfirmText(cwd, hide)) !== true) return;
            }
            pendingCwdRef.current = cwd;
            patch({ pendingCwd: cwd, error: null });
            const response = await jsonFetch(OVERVIEW_HIDDEN_ENDPOINT, {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ cwd: cwd, hidden: hide === true }),
            });
            pendingCwdRef.current = '';
            if (!response.ok) {
              const envelope = response.data;
              const detail = isRecord(envelope) && typeof envelope.error === 'string' ? envelope.error : response.message;
              patch({
                pendingCwd: '',
                error: (hide === true ? '隐藏失败' : '恢复失败') + '（operation=toggleWorkspaceHidden target='
                  + OVERVIEW_HIDDEN_ENDPOINT + ' error_code=' + response.code + '）：' + detail,
              });
              return;
            }
            const envelope = response.data;
            const data = isRecord(envelope) && isRecord(envelope.data) ? envelope.data : (isRecord(envelope) ? envelope : {});
            const nextHidden = Array.isArray(data.hiddenList)
              ? data.hiddenList.filter((item) => typeof item === 'string' && item !== '')
              : state.hidden;
            // 立即移除卡片：不等轮询。用户点完还要等 5 分钟才看到变化 =「点了没反应」。
            // 只在**隐藏**方向做本地移除；恢复方向目标卡片根本不在列表里，本地无从加回，
            // 必须重新取一次 0 token 的 GET（见下）。
            const prevResult = state.result;
            const prevWorkspaces = isRecord(prevResult) && Array.isArray(prevResult.workspaces) ? prevResult.workspaces : [];
            patch({
              pendingCwd: '',
              hidden: nextHidden,
              result: hide === true
                ? { ...(isRecord(prevResult) ? prevResult : {}), workspaces: prevWorkspaces.filter((ws) => String(ws?.cwd ?? '') !== cwd) }
                : prevResult,
            });
            if (hide !== true) await refresh('silent');
          },
          [patch, state.hidden, state.result, refresh],
        );

        /**
         * 「立即生成」。开火的是本插件的端点；真正的模型调用属于集成方职责
         * （契约 §3 已写明：本模块只负责组装 prompt）。
         * 端点若回 summaries（集成方已代跑模型），就直接展示；否则把 prompt 交给调用方处理。
         */
        const onGenerate = React.useCallback(async () => {
          // ── POST 前预校验（2026-10-07）────────────────────────────────────
          // 规则与服务端 models.js 的 resolveModelRoute **逐条一致**，由 resolveSelectedModel
          // 在目录刷新时已把 state.model 纠正成可解析值；这里再兜一层：
          //   1) 目录还没回来 → 不发请求（原来发出去就是注定失败的 POST）；
          //   2) 目录为空（llm 不可用）→ 明确说「模型服务不可用」，而不是让用户以为是自己操作错；
          //   3) 选中值解析不出路由 → 明确说「请在下拉里选择具体模型」，同样不发请求。
          // 三种情况都给出可读原因，不允许再出现「点了没反应 / 报错但看不出为什么」。
          if (generatingRef.current === true) return;
          if (state.models.length === 0) {
            patch({
              error: state.modelsLoaded === true
                ? '模型服务不可用，无法生成（operation=generateOverview target=' + OVERVIEW_GENERATE_ENDPOINT +
                  ' error_code=MODEL_CATALOG_EMPTY）。请检查 dsh-llm 服务是否正常；下方工作区列表不受影响。'
                : '正在读取模型列表，请稍候再点「立即生成」（operation=generateOverview target=' +
                  OVERVIEW_GENERATE_ENDPOINT + ' error_code=MODEL_CATALOG_NOT_READY）。',
            });
            return;
          }
          if (canResolveRoute(state.model, state.models) === null) {
            patch({
              error: '请先在下拉里选择一个具体模型（当前选中：' + JSON.stringify(state.model) + '，它无法解析成模型路由；' +
                'operation=generateOverview target=' + OVERVIEW_GENERATE_ENDPOINT + ' error_code=MODEL_ROUTE_UNRESOLVED）。',
            });
            return;
          }
          patch({ generating: true, error: null });
          // ⚠️ 必须打 /overview/generate，不是 /overview —— 见 OVERVIEW_GENERATE_ENDPOINT 的说明。
          const response = await jsonFetch(OVERVIEW_GENERATE_ENDPOINT, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ generate: true, model: state.model }),
          });
          if (!response.ok) {
            patch({
              generating: false,
              error: '生成失败（operation=generateOverview target=' + OVERVIEW_GENERATE_ENDPOINT + ' error_code=' + response.code + '）：' + response.message,
            });
            return;
          }
          // 同样要剥信封（与 GET 分支一致，见那里的说明）。
          const envelope = response.data;
          const data = isRecord(envelope) && isRecord(envelope.data) ? envelope.data : (isRecord(envelope) ? envelope : {});
          const summaries = isRecord(data.summaries) ? data.summaries : {};
          const generated = Object.keys(summaries).length > 0;
          writeLocal(LS_SIGNATURE, signatureOf(data));
          // ⚠️ 后端的诊断必须落到界面上（要求 4）。此前这里只给一句笼统的 NO_SUMMARIES，
          // 服务端真正的原因（路由未解析 / 某个工作区超时 / llm 报错）被丢在 data.warnings 里没人看。
          // 现在把新增的 warnings 原样附在错误正文后面：一条都不丢，且用户能看懂。
          const backendWarnings = (Array.isArray(data.warnings) ? data.warnings : [])
            .map(str)
            .filter((text) => text !== '')
            .slice(0, 5);
          patch({
            generating: false,
            result: Array.isArray(data.workspaces) ? data : state.result,
            summaries: generated ? summaries : state.summaries,
            changed: false,
            lastGeneratedAt: Date.now(),
            error: generated
              ? null
              : '模型未返回任何总结（operation=generateOverview target=' + OVERVIEW_GENERATE_ENDPOINT + ' error_code=NO_SUMMARIES）。'
                + '服务端诊断：\n' + (backendWarnings.length > 0 ? backendWarnings.join('\n') : '（服务端未附 warnings）'),
          });
        }, [patch, state.model, state.result, state.summaries, state.models]);

        // 把最新的 onGenerate 同步到 ref，供自动模式定时器调用。
        // 顺序上必须在 onGenerate 声明之后，否则是 TDZ 引用。
        const generateRef = React.useRef(null)
        React.useEffect(() => {
          generateRef.current = onGenerate
        }, [onGenerate])

        /**
         * 自动模式：周期性重取文件清单（0 token），**检测到笔记变更时真正触发一次生成**。
         *
         * 两道防重复烧 token 的闸门：
         *   1. 正在生成中（generatingRef）就跳过本轮；
         *   2. 只有 changed 为真才触发（文件指纹与上次生成时不同）。
         * 这也是"自动"默认关闭的原因 —— 它会产生模型调用。
         */
        React.useEffect(() => {
          if (!state.auto) return undefined
          const timer = setInterval(async () => {
            await refresh('silent')
            if (changedRef.current && !generatingRef.current) {
              await generateRef.current?.()
            }
          }, AUTO_INTERVAL_MS)
          return () => clearInterval(timer)
        }, [state.auto, refresh])

        const result = state.result;
        const workspaces = isRecord(result) && Array.isArray(result.workspaces) ? result.workspaces : [];
        const counts = isRecord(result) && isRecord(result.counts) ? result.counts : {};
        const warnings = isRecord(result) && Array.isArray(result.warnings) ? result.warnings : [];
        // 已隐藏工作区（服务端 hiddenList 的镜像）。渲染时一律按它算「已隐藏（N）」，
        // 不按「列表少了几张」倒推 —— 那两者本来就不一定相等（被隐藏的 cwd 可能已不是工作区根）。
        const hiddenList = Array.isArray(state.hidden) ? state.hidden : [];
        const pendingCwd = String(state.pendingCwd ?? '');

        const header = h(
          'div',
          { className: 'asov_toolbar' },
          h(
            'div',
            { className: 'asov_title' },
            '工作总览',
            h(
              'small',
              null,
              workspaces.length + ' 个工作区 · ' + String(counts.files === undefined ? 0 : counts.files) + ' 个文件'
                + (hiddenList.length > 0 ? ' · 已隐藏 ' + String(hiddenList.length) + ' 个' : ''),
            ),
          ),
          h(
            'div',
            { className: 'asov_controls' },
            // ── 「已隐藏（N）」入口（2026-10-07）────────────────────────────────
            // **没有隐藏项时整个不渲染**：一个永远显示「已隐藏（0）」的按钮
            // 会让用户以为有东西被藏了却找不到，徒增疑虑。
            // 用原生 <details> 而非受控 state：与既有 NoticeNotes 同一形态，
            // 不需要额外 state、不会与两个 UI 各自的渲染路径打架。
            hiddenList.length === 0
              ? null
              : h(
                  'details',
                  { className: 'asov_hidden', title: '已从本页隐藏的工作区。DSH 的工作区、侧栏与会话记录不受影响。' },
                  h('summary', { className: 'asov_hidden_summary' }, '已隐藏（' + String(hiddenList.length) + '）'),
                  h(
                    'ul',
                    { className: 'asov_hidden_list' },
                    hiddenList.map((cwd) =>
                      h(
                        'li',
                        { className: 'asov_hidden_item', key: String(cwd) },
                        h('span', null, String(cwd)),
                        h(
                          'button',
                          {
                            type: 'button',
                            className: 'asov_restoreBtn',
                            disabled: pendingCwd !== '',
                            title: '让它重新出现在「工作总览」这一页（不影响任何 DSH 数据）',
                            onClick: () => onToggleHidden(cwd, false),
                          },
                          state.pendingCwd === String(cwd) ? '恢复中…' : '恢复',
                        ),
                      ),
                    ),
                  ),
                ),
            h(
              'label',
              {
                className: 'asov_switch',
                // 如实描述：自动模式**会**在检测到笔记变更时调用模型（产生 token）。
                // 这是默认关闭的原因，用户必须知情才能打开。
                title: '自动：每 5 分钟检查笔记是否有改动，有改动就自动生成总结（会调用模型、产生 token）',
              },
              h('input', { type: 'checkbox', checked: state.auto, onChange: onToggleAuto }),
              '自动',
            ),
            h(
              'label',
              { className: 'asov_field' },
              '模型',
              h(
                'select',
                {
                  className: 'asov_select',
                  value: state.model,
                  onChange: onSelectModel,
                  disabled: state.models.length === 0,
                  title: state.models.length === 0
                    ? '没有可用的模型（dsh-llm 目录为空），无法生成总结'
                    : '选择用于生成工作区总结的模型',
                },
                // ⚠️ 目录未就绪时**不放任何假选项**：旧版的 'session-default' 占位项
                // 会让用户点出一个注定失败的 POST（见文件头说明）。宁可下拉是空的。
                state.models.length === 0
                  ? h('option', { key: 'none', value: '' }, state.modelsLoaded === true ? '（无可用模型）' : '正在读取模型列表…')
                  : state.models.map((model) => {
                      const value = modelOptionValue(model);
                      return h('option', { key: value, value }, String(model.name || model.id))
                    }),
              ),
            ),
            h(
              'button',
              {
                type: 'button',
                className: 'asov_button asov_button_primary',
                // 目录未就绪 / 目录为空 / 选中值解析不出路由 → 一律禁用。
                // 这是「不点了没反应」的正解：按钮的可用状态直接反映「现在能不能生成」。
                disabled: state.generating || canResolveRoute(state.model, state.models) === null,
                title: canResolveRoute(state.model, state.models) === null
                  ? (state.models.length === 0
                    ? '模型目录未就绪或为空，暂时无法生成（不会发出注定失败的请求）'
                    : '当前选中的模型无法解析成路由，请先在下拉里选择一个具体模型')
                  : '用所选模型为每个工作区生成总结（会调用模型、产生 token）',
                onClick: onGenerate,
              },
              state.generating
                ? '生成中…'
                : (canResolveRoute(state.model, state.models) === null
                  ? (state.models.length === 0
                    ? (state.modelsLoaded === true ? '模型服务不可用' : '正在读取模型列表…')
                    : '请选择具体模型')
                  : '立即生成'),
            ),
          ),
        );

        const notices = [];
        if (state.modelsLoaded === true && state.models.length === 0) {
          // 这是**真故障**（llm 服务不可用 → 没有模型目录 → 生成不了），必须常驻可见。
          // 旧的「模型列表为占位」文案是误导：占位表已删除（它是死路），现在是真的没有模型。
          notices.push(
            h(
              'div',
              { className: 'asov_notice asov_notice_error', key: 'models', role: 'alert' },
              h('div', { className: 'asov_notice_errorTitle' }, '模型服务不可用'),
              h(
                'div',
                { className: 'asov_notice_errorBody' },
                '端点未返回任何可用模型（operation=listModels error_code=MODEL_CATALOG_EMPTY），' +
                  '「立即生成」已禁用。请检查 dsh-llm 服务；下方工作区列表不受影响。',
              ),
            ),
          );
        }
        if (state.changed) {
          notices.push(
            h(
              'div',
              { className: 'asov_notice', key: 'changed' },
              state.auto
                ? '检测到笔记文件有新增或改动；自动模式将在下一轮自动生成总结。'
                : '检测到笔记文件有新增或改动，点击「立即生成」更新总结。',
            ),
          );
        }
        // 服务端 warnings 是**完整诊断串**（[operation] target -> CODE: message {context}），
        // 实测单条 100~200 字符；且其中大部分是「按上限截断」「丢弃非绝对 cwd」
        // 「会话无日志」这类**预期行为**（用户原话：「要么解决要么别提示」）。
        // 分流规则见 classifyWarnings：
        //   · 预期项 → 全部收进**默认收起的 <details>**，界面上只常驻一行标题；
        //   · 真故障 → 与之前一致地常驻可见，绝不折叠、绝不丢弃。
        const classified = classifyWarnings(warnings);
        for (const notice of classified.faults) {
          notices.push(h(NoticeWarn, { key: notice.key, text: notice.text, detail: notice.detail }));
        }
        if (classified.notes.length > 0) {
          notices.push(h(NoticeNotes, { key: 'notes', items: classified.notes }));
        }

        // ── Bug 2（2026-10-06，用户实测）：出错后整个工作区列表消失 ──
        // 此前只要 state.error 非空就整页替换 body，把列表顶掉；
        // 「立即生成」一次 404 就让用户以为插件整体坏了（其实 GET 的数据一直都在）。
        //
        // ⚠️ 这里必须**区分两类错误**，不能一刀切都改成提示条：
        //   status === 'error'          → GET 没拿到数据（读取/网络/解析失败），
        //                                   此时根本没有列表可显示，仍应整页错误；
        //   status === 'ready' 且有 error → 只有 POST「立即生成」失败，
        //                                   GET 早已把列表取回来了 → **必须保留列表**，
        //                                   错误降级为顶部提示条。
        const readFailed = state.status === 'error';
        if (readFailed === false && typeof state.error === 'string' && state.error !== '') {
          notices.unshift(
            h(
              'div',
              { className: 'asov_notice asov_notice_error', key: 'error', role: 'alert' },
              h('div', { className: 'asov_notice_errorTitle' }, '操作失败（下方列表不受影响）'),
              h('div', { className: 'asov_notice_errorBody' }, state.error),
            ),
          );
        }

        let body;
        if (readFailed) {
          body = h('div', { className: 'asov_error' }, String(state.error));
        } else if (state.status === 'loading' && workspaces.length === 0) {
          body = h('div', { className: 'asov_empty' }, h('div', { className: 'asov_empty_main' }, '正在读取工作区…'));
        } else if (workspaces.length === 0) {
          // 「全被隐藏」与「真的没有工作区」是两件事，**必须**给不同文案。
          // 混为一谈会让用户以为工作区丢了（他刚刚才亲手点的隐藏）。
          body = hiddenList.length > 0
            ? h(
                'div',
                { className: 'asov_empty' },
                h('div', { className: 'asov_empty_main' }, '所有工作区都已从本页隐藏（' + String(hiddenList.length) + ' 个）'),
                h('div', null, '用上方工具栏的「已隐藏（' + String(hiddenList.length) + '）」展开即可逐个恢复。'),
                h('div', null, 'DSH 的工作区、侧栏与会话记录全程未受影响。'),
              )
            : h(
                'div',
                { className: 'asov_empty' },
                h('div', { className: 'asov_empty_main' }, '没有扫描到任何工作区笔记'),
                h('div', null, '确认工作区里存在 tasks/ 或 .agents/notes/ 目录后重试。'),
              );
        } else {
          body = workspaces.map((workspace) => {
            const files = Array.isArray(workspace.files) ? workspace.files : [];
            const summary = state.summaries[workspace.cwd];
            const points =
              typeof summary === 'string' && summary.trim() !== ''
                ? h('div', { className: 'asov_points' }, summary)
                : h(
                    'div',
                    { className: 'asov_points asov_points_empty' },
                    files.length === 0 ? '此工作区没有笔记类文件。' : '尚未生成总结 —— 点击右上角「立即生成」。',
                  );
            return h(
              'section',
              { className: 'asov_ws', key: String(workspace.cwd) },
              h(
                'div',
                { className: 'asov_ws_head' },
                h('span', { className: 'asov_ws_name' }, String(workspace.name || workspace.cwd)),
                h('span', { className: 'asov_ws_path' }, String(workspace.cwd)),
                workspace.truncated === true
                  ? h('span', { className: 'asov_badge asov_badge_new' }, '已截断')
                  : null,
                h(
                  'span',
                  { className: 'asov_ws_meta' },
                  files.length + ' 文件 · ' + humanBytes(workspace.totalBytes),
                ),
                // ── 隐藏按钮（2026-10-07）──────────────────────────────────────
                // 文案必须是「隐藏」而不是「删除」：删掉的是本页的显示，
                // 不是 DSH 的工作区。title 里把边界写死，防止用户误读。
                h(
                  'button',
                  {
                    type: 'button',
                    className: 'asov_hideBtn',
                    disabled: pendingCwd !== '',
                    title: '只从「工作总览」这一页隐藏这个工作区；DSH 的工作区、侧栏、会话记录与文件都不受影响，可随时恢复',
                    onClick: () => onToggleHidden(String(workspace.cwd), true),
                  },
                  pendingCwd === String(workspace.cwd) ? '隐藏中…' : '隐藏',
                ),
              ),
              h(
                'div',
                { className: 'asov_ws_body' },
                points,
                files.length === 0
                  ? null
                  : h(
                      'details',
                      { className: 'asov_files' },
                      h('summary', null, '文件清单（' + String(files.length) + '）'),
                      h(
                        'ul',
                        { className: 'asov_filelist' },
                        files.map((file) =>
                          h(
                            'li',
                            { className: 'asov_file', key: String(file.relPath || file.path) },
                            h('span', { className: 'asov_file_kind' }, '[' + String(file.kind) + ']'),
                            h('span', null, String(file.relPath || file.path)),
                            h('span', { className: 'asov_file_size' }, humanBytes(file.bytes)),
                          ),
                        ),
                      ),
                    ),
              ),
            );
          });
        }

        return h(
          'div',
          { className: 'asov_root' },
          header,
          h('div', { className: 'asov_body' }, notices, body),
        );
      }

      /**
       * 注册进 conversation.view 槽位。
       * register 是双参数：(options, Component)；label 必须是函数（照抄轨迹页的注册签名）。
       */
      function apply(ctx) {
        if (!isRecord(ctx) || !isRecord(ctx.slots) || typeof ctx.slots.inject !== 'function') {
          throw new Error('createOverviewUi.apply: ctx.slots.inject 不可用（dsh-active-sessions/ui/overview）');
        }
        ensureStyle();
        ctx.slots.inject(OVERVIEW_SLOT, () =>
          ctx.slots.register(
            {
              name: OVERVIEW_SLOT,
              id: OVERVIEW_VIEW_ID,
              order: OVERVIEW_VIEW_ORDER,
              label: () => '工作总览',
            },
            WorkOverviewView,
          ),
        );
      }

      return {
        Component: WorkOverviewView,
        apply: apply,
        internals: {
          summarizeWarning, parseWarningLine, classifyWarnings, EXPECTED_WARNING_GROUPS,
          NoticeWarn, NoticeNotes,
          // 问题 A 的模型防线（供单测直接单测，不依赖 React 渲染）
          modelOptionValue, canResolveRoute, resolveSelectedModel,
          // 隐藏工作区（2026-10-07）：确认框文案是本功能唯一的语义说明书，必须可测。
          hiddenConfirmText,
        },
      };
    }
      return createOverviewUi
    })()
    const sidebarUi = createSidebarUi({ React })
    const overviewUi = createOverviewUi({ React })
    // ⚠️ 这一行才是**真正导出给 DI 的 inject**（见下方 return）。
    // ui/sidebar.js 里那个 export const inject 内联后落在 IIFE 作用域内，对 DI 完全不起作用。
    // 2026-10-06：加 'layout' —— Bug 3 修法需要在 main 面板挂载时调 ctx.layout.selectPanel(null)
    // 把中央列交还给对话（只返回 null 不够，见 ui/sidebar.js 的 MainSlotHost 说明）。
    const inject = ['slots', 'layout']
    function apply(ctx) {
      sidebarUi.apply(ctx)
      overviewUi.apply(ctx)
    }
    return { apply, inject, SidebarPanel: sidebarUi.Component, OverlayHost: sidebarUi.OverlayHost, OverviewView: overviewUi.Component }
  },
})
