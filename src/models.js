// dsh-active-sessions / src/models.js
//
// 职责：把"DSH 既有的模型来源"暴露给工作总览页的模型下拉（用户要求：模型从 dsh 模型来源中选择）。
//
// 为什么要走 ctx.llm 而不是自己读 settings.yaml：
//   settings.yaml 只描述了 provider 的**配置**，但"当前实际可用哪些模型"由各 llm 适配器在运行时声明
//   （listModels 是适配器实现的，可能来自远端发现缓存）。自己解析 YAML 只能猜，
//   而 ctx.llm.listProviders/listModels 是 DSH 自己的权威答案。
//
// 为什么惰性 ctx.get("llm") 而不是 inject: ["llm"]：
//   本插件的主体功能（三态/聚类/笔记扫描）完全不依赖 llm，
//   若把 llm 写进顶层 inject，llm 服务缺席的组合会让整个插件 pending，
//   连 0 token 的面板都起不来。这里按需取，取不到就返回空列表并降级为"跟随会话默认模型"。

/**
 * 读取可用模型目录。
 * @param {object} ctx Cordis 插件上下文
 * @returns {Promise<{models: Array<{id:string,name:string,provider:string}>, warnings: string[]}>}
 */
export async function listAvailableModels(ctx) {
  const warnings = []
  let llm
  try {
    llm = ctx.get("llm")
  } catch (error) {
    warnings.push(issue("获取 llm 服务", "ctx.get(\"llm\")", error))
    return { models: [], warnings, llmAvailable: false }
  }
  if (llm === undefined || llm === null) {
    // ⚠️ 文案与 error_code 都要跟前端的状态机对齐：
    //   ui/overview.js 的 modelsLoaded=true + models.length===0 → 显示「模型服务不可用」并禁用生成按钮。
    //   此前这里说「将退化为跟随会话默认模型」——**那条路根本不存在**
    //   （dsh-llm 的 LlmCallConfig.provider/model 都是必填 string），
    //   正是这个假承诺把用户带进了「点了没内容」的坑。
    warnings.push(
      issue('获取 llm 服务', 'ctx.get("llm")', new Error('llm 服务未注册，无法列举模型'), 'LLM_SERVICE_UNAVAILABLE'),
    )
    return { models: [], warnings, llmAvailable: false }
  }

  let providers = []
  try {
    providers = typeof llm.listProviders === "function" ? llm.listProviders() : []
  } catch (error) {
    warnings.push(issue("列举 provider", "llm.listProviders()", error))
  }
  if (!Array.isArray(providers)) providers = []

  const models = []
  const seen = new Set()
  // 并发有界（<=5）：某些适配器的 listModels 会走网络发现，不能一次性打满。
  const queue = providers.slice()
  const workers = Array.from({ length: Math.min(5, queue.length || 1) }, async () => {
    for (;;) {
      const provider = queue.shift()
      if (provider === undefined) return
      const providerId = typeof provider?.id === "string" ? provider.id : undefined
      if (providerId === undefined || providerId.length === 0) continue
      try {
        const listed = typeof llm.listModels === "function" ? await llm.listModels(providerId) : []
        if (!Array.isArray(listed)) continue
        for (const item of listed) {
          if (item === null || typeof item !== "object") continue
          const id = typeof item.id === "string" ? item.id : undefined
          if (id === undefined || id.length === 0) continue
          // 用 provider/id 做去重键：不同 provider 可能有同名 model
          const key = providerId + "\u0000" + id
          if (seen.has(key)) continue
          seen.add(key)
          models.push({
            id: item.id,
            name: typeof item.name === "string" && item.name.length > 0 ? item.name : item.id,
            provider: providerId,
          })
        }
      } catch (error) {
        warnings.push(issue("列举模型", providerId, error))
      }
    }
  })
  await Promise.all(workers)

  // 排序保证下拉顺序稳定（不依赖 provider 注册顺序）
  models.sort((a, b) => (a.provider === b.provider ? a.id.localeCompare(b.id) : a.provider.localeCompare(b.provider)))
  // ⚠️ llmAvailable 与 models.length 是**两件事**，必须分开报：
  //   · llmAvailable=false → 真的没有模型服务，任何生成都不可能成功 → 调用方必须 fail-fast；
  //   · llmAvailable=true 但 models=[] → 服务在，只是该适配器**不通过 listModels 声明目录**
  //     （自建 / 本地适配器常见）。此时 'provider/model' 自描述形式仍可能调得通，
  //     所以不能因为「目录为空」就一票否决 —— 2026-10-07 端到端自测实测到这条边界：
  //     一次过严的短路会把 tests/temp-e2e-overview-persist.mjs（mock llm 无 listModels）打红。
  return { models, warnings, llmAvailable: true }
}

/**
 * 把用户选择的模型 id 解析成 { provider, model } 路由。
 *
 * 支持两种输入：
 *   1. "provider/model" 形式（下拉里 provider 已知时用这个最稳）；
 *   2. 裸 model id：在所有可用模型里反查唯一的 provider。
 * 反查不唯一或找不到时返回 null，由调用方给出可读的失败原因（**没有会话默认模型可回落**）。
 * @param {string} selected 用户选择的模型 id
 * @param {Array<{id:string,provider:string}>} models 可用模型目录
 * @returns {{provider:string, model:string}|null}
 */
export function resolveModelRoute(selected, models) {
  if (typeof selected !== "string" || selected.length === 0) return null
  if (Array.isArray(models)) {
    // 必须按 id 收集**全部**候选再判唯一：不同 provider 可能有同名 model，
    // 直接 find() 会静默选中先出现的那个，把"歧义"错当成"已解析"。
    const hits = models.filter((m) => m !== null && typeof m === "object" && m.id === selected && typeof m.provider === "string")
    if (hits.length === 1) return { provider: hits[0].provider, model: hits[0].id }
    // 多个 provider 同名 → 不猜，返回 null 让调用方要求用户写明 provider
    if (hits.length > 1) return null
  }
  // 退化：允许 "provider/model" 自描述形式
  const slash = selected.indexOf("/")
  if (slash > 0 && slash < selected.length - 1) {
    return { provider: selected.slice(0, slash), model: selected.slice(slash + 1) }
  }
  return null
}

/**
 * 组装带上下文的错误串（禁止静默吞错）。
 *
 * ⚠️ 格式必须与 src/overview.js 的 warnLine、src/states.js 的 describeError **完全一致**：
 *     [operation] target -> ERROR_CODE: message {contextJson}
 *   三个产出方曾经各写各的（key=value、竖线分隔），前端 parseWarningLine 只认这一种，
 *   于是匹配不上的全部落进「未分组」逐条刷屏（用户实测噪音的根因）。
 *   归一之后，前端只需要认一种形状。
 *
 * @param {string} operation 人类可读动作名
 * @param {string} target 被操作对象
 * @param {any} error 原始错误（用于取 message）
 * @param {string} [errorCode] 真实错误码；缺省才回落到 error.code/error.name
 */
function issue(operation, target, error, errorCode) {
  const raw = errorCode !== undefined && errorCode !== null && String(errorCode) !== ''
    ? String(errorCode)
    : (error?.code ?? error?.name ?? "UNKNOWN")
  const code = String(raw).replace(/[^A-Za-z0-9_]/g, "_") || "UNKNOWN"
  const message = String(error?.message ?? error)
    .slice(0, 200)
    .replace(/[\r\n\t]+/g, " ")
    .replace(/\{/g, "(")
    .replace(/\}/g, ")")
  const op = String(operation).replace(/\[/g, "(").replace(/\]/g, ")")
  const tgt = String(target).replace(/ -> /g, " → ")
  return "[" + op + "] " + tgt + " -> " + code + ": " + message + " " + JSON.stringify({ plugin: "dsh-active-sessions/models" })
}
