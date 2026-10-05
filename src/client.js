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

    /**
     * 选中某个会话时上报。
     * 不写死任何导航接口：优先调用集成方传入的 onSelect；否则派发自定义事件，
     * 让「谁负责切会话」自己去监听，客户端包之间保持解耦。
     *
     * 同时上报已读水位（见 reportSeen 的说明）—— 这是 unseen 状态能清掉的唯一途径。
     */
    function selectEntry(entry, onSelect) {
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
            // 锁定态与切换回调由 OverlayHost 持有（它才是真正拥有 geometry 的人）；
            // 槽位内嵌形态不传，Head 便不渲染锁按钮。
            locked: config.locked === true,
            onToggleLock: typeof config.onToggleLock === 'function' ? config.onToggleLock : null,
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
        // Pill 仍在列表里：槽位内嵌形态（Component / main 面板）的收起态继续用它，
        // 只有 overlay 形态不再渲染它。几何相关的纯函数一并导出，供自测直接单测。
        internals: {
          Pill, GlyphPane, Head, Warn, Empty, Card, RelationLine, Cluster, Group, FullPane, useSnapshot, summarizeWarning,
          measureOverlayTop, viewportHeight, maxOverlayHeight, defaultOverlayHeight,
          clampOverlayWidth, clampOverlayHeight, readOverlayGeometry, writeOverlayGeometry, readLocked, writeLocked,
          subscribeCollapsed, collapseSubscriberCount,
        },
      }
    }

    // ───────────── 模块级便捷导出（兼容 / 自测） ─────────────

    /** 依赖声明：只依赖 slots，不注册任何模型可见工具（0 token 硬约束）。 */
    const inject = ['slots']

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

    /** localStorage 键：自动开关 / 模型选择 / 上次生成的文件签名快照。 */
    const LS_AUTO = 'dsh-active-sessions.overview.auto';
    const LS_MODEL = 'dsh-active-sessions.overview.model';
    const LS_SIGNATURE = 'dsh-active-sessions.overview.signature';

    /**
     * 模型下拉的兜底列表。
     *
     * 选型说明（必读，已在交付报告中同步）：优先走服务端端点的 models 字段
     * （GET /api/active-sessions/overview?models=1），因为那才是「DSH 既有模型来源」的
     * 正确接法（服务端可读 settings.yaml / modelCatalog）。当端点未实现或不可达时，
     * 退化为下面这份占位列表，并在界面上明确标注「占位」，避免用户以为它反映了真实配置。
     * 之所以不直接调 ctx.remote.session.modelCatalog()：那需要注入 remote 服务，
     * 而槽位注册契约里我们只声明了 slots；真正的目录接口应由主代理在集成层接。
     */
    const PLACEHOLDER_MODELS = [
      { id: 'session-default', name: '跟随会话默认模型（占位）', provider: '' },
      { id: 'moonshotai-cn/kimi-k2', name: 'moonshotai-cn / kimi-k2（占位）', provider: 'moonshotai-cn' },
      { id: 'cool-cofee-gpt/gpt-5', name: 'cool-cofee-gpt / gpt-5（占位）', provider: 'cool-cofee-gpt' },
    ];

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
      '.asov_ws{border:1px solid var(--as-line);border-radius:12px;margin-bottom:14px;background:var(--as-card);overflow:hidden}',
      '.asov_ws_head{display:flex;align-items:baseline;gap:10px;flex-wrap:wrap;padding:12px 14px;border-bottom:1px solid var(--as-line)}',
      '.asov_ws_name{font-weight:600;font-size:14px;color:var(--as-text)}',
      '.asov_ws_path{font-size:11px;color:var(--as-tertiary);font-family:var(--ds-font-family-code,monospace);word-break:break-all}',
      '.asov_ws_meta{margin-left:auto;font-size:11px;color:var(--as-tertiary);white-space:nowrap}',
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
     * 与 ui/sidebar.js 的同名函数**逐字一致**（包括 60 字截断阈值）：
     * 优先取 message=（最贴近人话），其次 input_summary=，都取不到就整串截断。
     * 行为必须一致，否则同一串在左窗和总览页会显示成两句话。
     */
    function summarizeWarning(raw) {
      const text = str(raw);
      if (text === '') return '有一条非致命提示（悬停查看详情）';
      // 优先取 message=（最贴近人话），其次 input_summary=。
      const pick = (key) => {
        const m = text.match(new RegExp(key + '=([^]*?)(?=\\s+[a-z_]+=|$)'));
        return m !== null && m !== undefined ? str(m[1]).trim() : '';
      };
      const msg = pick('message') || pick('input_summary');
      if (msg !== '') return msg.length > 60 ? msg.slice(0, 60) + '…' : msg;
      // 兜底：整串截断。
      return text.length > 60 ? text.slice(0, 60) + '…' : text;
    }

    /**
     * 解析 warnLine 的行格式：[operation] target -> ERROR_CODE: message {contextJson}
     *
     * 为什么不用 JSON.parse：warnings 是**拼出来的字符串**（服务端 src/overview.js
     * 的 warnLine），不是 JSON。这里只做尽力而为的前缀解析，解析不出就返回 null，
     * 由调用方按「无法归类的单条」降级处理 —— 宁可不合并，也不能吞掉内容。
     */
    function parseWarningLine(raw) {
      const text = str(raw);
      if (text === '') return null;
      const m = text.match(/^\[([^\]]*)\]\s*([\s\S]*?)\s*->\s*([A-Za-z0-9_]+)\s*(?::\s*([\s\S]*?))?(?:\s+(\{[\s\S]*\}))?\s*$/);
      if (m === null || m === undefined) return null;
      return {
        operation: str(m[1]),
        target: str(m[2]),
        code: str(m[3]),
        message: str(m[4]),
        context: str(m[5]),
        raw: text,
      };
    }

    /**
     * 同类说明性提示的合并规则表。
     *
     * ⚠️ 这些提示是**预期行为、不是错误**：扫描按上限截断文件清单、丢弃非绝对
     * cwd，都是插件在保护宿主。逐条铺开除了占满面板，还会让用户误以为插件坏了，
     * 所以合并成一条计数说明。**文案不得写成「错误/失败」**。
     *
     * 顺序即展示顺序，是这张表的数组顺序（不是对象枚举顺序）—— 保证确定性。
     */
    const WARNING_GROUPS = [
      { code: 'WORKSPACE_TRUNCATED', label: (n) => n + ' 个工作区的笔记已截断（文件数/体积超限）' },
      { code: 'CWD_NOT_ABSOLUTE', label: (n) => n + ' 个会话的 cwd 不是绝对路径，已降级' },
      { code: 'CWD_NOT_ABSOLUTE_MANY', label: (n) => n + ' 条非绝对 cwd 已全部丢弃' },
    ];

    /**
     * 把服务端 warnings 折成若干条「展示项」。
     *
     * 顺序：先按 WARNING_GROUPS 的固定表序输出合并项，再按**原始数组下标序**输出
     * 未合并的单条。全程只依赖下标与表序，不依赖对象枚举顺序 → 同输入必同输出。
     *
     * @param {unknown} warnings 服务端 warnings 数组（不可信输入）
     * @returns {Array<{key:string, text:string, detail:string, count:number, grouped:boolean}>}
     */
    function buildWarningNotices(warnings) {
      const list = (Array.isArray(warnings) ? warnings : []).map(str).filter((text) => text !== '');
      const info = list.map(parseWarningLine);
      const used = [];
      for (let i = 0; i < list.length; i += 1) used.push(false);
      const out = [];

      for (const group of WARNING_GROUPS) {
        const members = [];
        for (let i = 0; i < info.length; i += 1) {
          if (used[i] === true) continue;
          if (info[i] !== null && info[i].code === group.code) {
            members.push(i);
            used[i] = true;
          }
        }
        if (members.length === 0) continue;
        out.push({
          key: 'wg:' + group.code,
          text: group.label(members.length),
          // 完整原串一条都不丢，按原下标序用换行拼接进 title（悬停可见）。
          detail: members.map((i) => list[i]).join('\n'),
          count: members.length,
          grouped: true,
        });
      }

      for (let i = 0; i < list.length; i += 1) {
        if (used[i] === true) continue;
        out.push({
          // key 用下标而不是原串：原串可能重复，用串做 key 会撞 React key。
          key: 'w:' + i,
          text: summarizeWarning(list[i]),
          detail: list[i],
          count: 1,
          grouped: false,
        });
      }
      return out;
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
       * 工作总览主视图。作为 conversation.view 的条目组件渲染，
       * 因此它占满中间主界面，而不是浮层。
       */
      function WorkOverviewView() {
        const [state, setState] = React.useState({
          status: 'idle',
          result: null,
          error: null,
          generating: false,
          models: PLACEHOLDER_MODELS,
          modelsPlaceholder: true,
          auto: readLocal(LS_AUTO) === '1',
          model: readLocal(LS_MODEL) || PLACEHOLDER_MODELS[0].id,
          changed: false,
          lastGeneratedAt: 0,
          summaries: {},
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
              ? data.models.filter((item) => isRecord(item) && typeof item.id === 'string')
              : [];
            patch({
              status: 'ready',
              result: data,
              error: null,
              changed: changed,
              models: models.length > 0 ? models : PLACEHOLDER_MODELS,
              modelsPlaceholder: models.length === 0,
              summaries: isRecord(data.summaries) ? data.summaries : state.summaries,
            });
          },
          [patch, state.summaries],
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
         * 「立即生成」。开火的是本插件的端点；真正的模型调用属于集成方职责
         * （契约 §3 已写明：本模块只负责组装 prompt）。
         * 端点若回 summaries（集成方已代跑模型），就直接展示；否则把 prompt 交给调用方处理。
         */
        const onGenerate = React.useCallback(async () => {
          patch({ generating: true, error: null });
          const response = await jsonFetch(OVERVIEW_ENDPOINT, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ generate: true, model: state.model }),
          });
          if (!response.ok) {
            patch({
              generating: false,
              error: '生成失败（operation=generateOverview target=' + OVERVIEW_ENDPOINT + ' error_code=' + response.code + '）：' + response.message,
            });
            return;
          }
          // 同样要剥信封（与 GET 分支一致，见那里的说明）。
          const envelope = response.data;
          const data = isRecord(envelope) && isRecord(envelope.data) ? envelope.data : (isRecord(envelope) ? envelope : {});
          const summaries = isRecord(data.summaries) ? data.summaries : {};
          const generated = Object.keys(summaries).length > 0;
          writeLocal(LS_SIGNATURE, signatureOf(data));
          patch({
            generating: false,
            result: Array.isArray(data.workspaces) ? data : state.result,
            summaries: generated ? summaries : state.summaries,
            changed: false,
            lastGeneratedAt: Date.now(),
            error: generated
              ? null
              : '模型未返回任何总结（operation=generateOverview target=' + OVERVIEW_ENDPOINT + ' error_code=NO_SUMMARIES）。'
                + '常见原因：所选模型路由未解析（请在下拉里选择具体模型），或该工作区没有可读笔记。',
          });
        }, [patch, state.model, state.result, state.summaries]);

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
              workspaces.length + ' 个工作区 · ' + String(counts.files === undefined ? 0 : counts.files) + ' 个文件',
            ),
          ),
          h(
            'div',
            { className: 'asov_controls' },
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
                { className: 'asov_select', value: state.model, onChange: onSelectModel },
                // value 用 "provider/id" 而不是裸 id：不同 provider 可能有同名 model，
                // 裸 id 会让服务端无法消歧（resolveModelRoute 在歧义时返回 null）。
                // 服务端 resolveModelRoute 明确支持这种自描述形式。
                state.models.map((model) => {
                  const value = typeof model.provider === 'string' && model.provider.length > 0
                    ? model.provider + '/' + String(model.id)
                    : String(model.id)
                  return h('option', { key: value, value }, String(model.name || model.id))
                }),
              ),
            ),
            h(
              'button',
              {
                type: 'button',
                className: 'asov_button asov_button_primary',
                disabled: state.generating,
                onClick: onGenerate,
              },
              state.generating ? '生成中…' : '立即生成',
            ),
          ),
        );

        const notices = [];
        if (state.modelsPlaceholder) {
          notices.push(
            h(
              'div',
              { className: 'asov_notice', key: 'models' },
              '模型列表为占位：端点未返回 models 字段。实际接入应由集成层复用 DSH 既有模型目录（modelCatalog）。',
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
        // 实测单条 100~200 字符，5 条就能占满首屏；且其中大部分是「按上限截断」
        // 「丢弃非绝对 cwd」这类**预期行为**，逐条铺开会让人误以为插件出错。
        // 这里：先按 error_code 合并同类说明性提示，剩余单条只显示摘要，
        // 完整原串统一进 title（悬停可见），详见 buildWarningNotices。
        for (const notice of buildWarningNotices(warnings)) {
          notices.push(h(NoticeWarn, { key: notice.key, text: notice.text, detail: notice.detail }));
        }

        let body;
        if (state.status === 'error') {
          body = h('div', { className: 'asov_error' }, String(state.error));
        } else if (state.status === 'loading' && workspaces.length === 0) {
          body = h('div', { className: 'asov_empty' }, h('div', { className: 'asov_empty_main' }, '正在读取工作区…'));
        } else if (state.error !== null && state.error !== undefined && state.error !== '') {
          body = h('div', { className: 'asov_error' }, String(state.error));
        } else if (workspaces.length === 0) {
          body = h(
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

      return { Component: WorkOverviewView, apply: apply, internals: { summarizeWarning, parseWarningLine, buildWarningNotices, NoticeWarn } };
    }
      return createOverviewUi
    })()
    const sidebarUi = createSidebarUi({ React })
    const overviewUi = createOverviewUi({ React })
    const inject = ['slots']
    function apply(ctx) {
      sidebarUi.apply(ctx)
      overviewUi.apply(ctx)
    }
    return { apply, inject, SidebarPanel: sidebarUi.Component, OverlayHost: sidebarUi.OverlayHost, OverviewView: overviewUi.Component }
  },
})
