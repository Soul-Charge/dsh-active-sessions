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
import { scanApprovals } from './approval.js'
import { scanOverview, buildSummaryPrompt } from './overview.js'
import { registerRoutes } from './rpc.js'
import { listAvailableModels, resolveModelRoute } from './models.js'
import { summarizeWorkspace } from './summarize.js'

export const name = 'active-sessions'

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
    })

    // 指纹缓存：笔记没变就复用上次结果，不重复调用模型。
    const fingerprint = fingerprintOf(scanned)
    const cacheKey = route.provider + '/' + route.model + '\u0000' + fingerprint
    const cached = generateCache.get(cacheKey)
    if (cached !== undefined) {
      return {
        summaries: cached.summaries,
        warnings: [...(scanned.warnings ?? []), '笔记未变化，复用上次生成的总结（未重复调用模型）'],
        model: route,
        cached: true,
      }
    }

    const summaries = {}
    const warnings = [...(catalog.warnings ?? []), ...(scanned.warnings ?? [])]
    for (const ws of scanned.workspaces ?? []) {
      const prompt = typeof ws.prompt === 'string' ? ws.prompt : null
      if (prompt === null || prompt.length === 0) continue
      try {
        const out = await summarizeWorkspace(ctx, {
          prompt,
          workspace: ws.name ?? ws.cwd ?? '(unknown)',
          route,
          timeoutMs: resolved.summarizeTimeoutMs,
        })
        summaries[ws.cwd] = out.text
      } catch (error) {
        // 单工作区失败只记 warning：部分成功比整体失败对用户更有用
        warnings.push(String(error?.message ?? error).slice(0, 300))
      }
    }
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
      return await scanStates({
        approvalIds: result.pending,
        seen: Object.fromEntries(seen),
      })
    },
    async scanOverview(options = {}) {
      return await scanOverview({
        generate: options.generate === true,
        maxBytes: resolved.noteMaxBytes,
        cached: overviewCache.data,
      })
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
      const route = resolveModelRoute(selectedModel, catalog.models)
      if (route === null) {
        return {
          summaries: {},
          warnings: [
            '未解析出模型路由（selected=' + JSON.stringify(selectedModel) + '）：' +
            '已抓取模型目录 ' + catalog.models.length + ' 条；请在页面上选择一个具体模型后重试',
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
