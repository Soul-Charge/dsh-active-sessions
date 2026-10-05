// dsh-active-sessions / src/summarize.js
//
// 职责：把工作区笔记的 prompt 真正送进模型，拿回 markdown 总结。
//
// 为什么单独一个模块：这是本插件**唯一**会消耗 token 的代码路径，
// 必须与其他"0 token"的部分物理隔离，便于审计与关闭。
//
// 关键约束（来自 dsh-llm 的 GenerateOptions 契约，实测确认）：
//   - purpose 只接受 "compaction" | "session-title"，传自定义值会被校验拒绝，故不传；
//   - messages 走 createUserMessage，source.kind="plugin"（与 dsh-session-title-llm 同构）；
//   - 输出用 BlockAssembler 聚合，避免自己解析 chunk。
import { BlockAssembler, createUserMessage } from "@deepseek-ai/dsh-llm"

/** 单次生成的超时。工作总览是交互式操作，超过这个时间应让用户重试而不是干等。 */
export const DEFAULT_TIMEOUT_MS = 120_000

/**
 * 调用模型生成一个工作区的总结。
 * @param {object} ctx Cordis 上下文（取 ctx.llm）
 * @param {object} input
 * @param {string} input.prompt 由 overview.buildSummaryPrompt 组装好的 prompt
 * @param {string} input.workspace 工作区显示名（仅用于错误上下文）
 * @param {{provider:string,model:string}} input.route 解析后的模型路由
 * @param {number} [input.timeoutMs]
 * @param {AbortSignal} [input.signal]
 * @returns {Promise<{text:string, usage?:object}>}
 */
export async function summarizeWorkspace(ctx, input) {
  const { prompt, workspace, route } = input
  if (route === null || typeof route !== "object" || typeof route.provider !== "string" || typeof route.model !== "string") {
    throw buildError("解析模型路由", workspace, "INVALID_ROUTE", { route: JSON.stringify(route) })
  }
  const llm = safeGetLlm(ctx)
  if (llm === undefined) throw buildError("获取 llm 服务", workspace, "LLM_UNAVAILABLE", {})

  // 超时用 AbortController 自己管：不依赖 llm 实现是否支持 timeout 选项。
  const timeoutMs = Number.isFinite(input.timeoutMs) ? Number(input.timeoutMs) : DEFAULT_TIMEOUT_MS
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  // 外部 signal 也要能取消（用户切走页面时）
  if (input.signal !== undefined && typeof input.signal.addEventListener === "function") {
    if (input.signal.aborted) controller.abort()
    else input.signal.addEventListener("abort", () => controller.abort(), { once: true })
  }

  try {
    const options = {
      provider: route.provider,
      model: route.model,
      messages: [createUserMessage({
        content: [{ type: "text", text: prompt }],
        source: { kind: "plugin", plugin: "dsh-active-sessions" },
      })],
      system: SYSTEM_PROMPT,
      maxTokens: 4096,
      signal: controller.signal,
    }
    const assembler = new BlockAssembler()
    for await (const chunk of llm.stream(options)) {
      assembler.push(chunk)
    }
    const blocks = assembler.blocks()
    const text = blocks
      .filter((b) => b !== null && typeof b === "object" && b.type === "text" && typeof b.text === "string")
      .map((b) => b.text)
      .join("\n")
      .trim()
    if (text.length === 0) throw buildError("生成总结", workspace, "EMPTY_OUTPUT", { blocks: blocks.length })
    return { text }
  } catch (error) {
    if (controller.signal.aborted) {
      throw buildError("生成总结", workspace, "TIMEOUT", { timeoutMs })
    }
    throw buildError("生成总结", workspace, error?.code ?? error?.name ?? "LLM_ERROR", {
      message: String(error?.message ?? error).slice(0, 300),
      provider: route.provider,
      model: route.model,
    })
  } finally {
    clearTimeout(timer)
  }
}

/** 工作总览的系统提示词。约束输出形态，避免模型自由发挥导致前端渲染混乱。 */
const SYSTEM_PROMPT = [
  "你是开发工作记录整理助手。用户会给你某个工作区里的一批笔记/任务文档摘录。",
  "请输出该工作区「用户做过什么」的中文总结，要求：",
  "1. 用 markdown 无序列表，每条形如「- 做了什么（关键产物路径）」，最多 8 条；",
  "2. 只依据给定内容，不要编造未出现的工作；信息不足就少写而不是猜；",
  "3. 按时间或重要性排序，突出已完成的具体成果；",
  "4. 不要输出标题、不要复述本指令、不要客套话。",
  "只输出列表本身。",
].join("\n")

/** 安全取 llm：ctx.get 可能抛（服务未注册时），不可让它冒泡打断整个请求。 */
function safeGetLlm(ctx) {
  try {
    const llm = ctx.get("llm")
    return llm === null ? undefined : llm
  } catch {
    return undefined
  }
}

/** 组装带 operation/target/error_code/context 的错误（禁止静默吞错）。 */
function buildError(operation, target, code, context) {
  const error = new Error("[active-sessions/summarize] operation=" + operation + " | target=" + String(target) + " | error_code=" + String(code) + " | context=" + JSON.stringify(context ?? {}))
  error.errorCode = code
  return error
}
