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
    return { models: [], warnings }
  }
  if (llm === undefined || llm === null) {
    warnings.push("llm 服务不可用：模型下拉将退化为跟随会话默认模型")
    return { models: [], warnings }
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
  return { models, warnings }
}

/**
 * 把用户选择的模型 id 解析成 { provider, model } 路由。
 *
 * 支持两种输入：
 *   1. "provider/model" 形式（下拉里 provider 已知时用这个最稳）；
 *   2. 裸 model id：在所有可用模型里反查唯一的 provider。
 * 反查不唯一或找不到时返回 null，由调用方回落到会话默认模型。
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

/** 组装带上下文的错误串（禁止静默吞错）。 */
function issue(operation, target, error) {
  const code = error?.code ?? error?.name ?? "UNKNOWN"
  const message = String(error?.message ?? error).slice(0, 200)
  return "[active-sessions/models] operation=" + operation + " | target=" + String(target) + " | error_code=" + String(code) + " | context=" + JSON.stringify({ message })
}
