// dsh-active-sessions / src/approval.js
//
// 职责：扫描 ~/.dsh/sessions/**/session*.jsonl.zstd，判定哪些会话正卡在"待审批"。
// 只读：本模块不写任何文件、不碰 DSH 配置。
//
// ── 为什么不能直接 zlib.zstdDecompressSync(整个文件) ─────────────────────────
// DSH 的 JSONL 持久化后端把**每一个写入批次**各自压成一个独立 zstd 帧，再首尾拼
// 接成同一个 .jsonl.zstd（见 dsh-session-persistence-jsonl/lib/types/zstd.js 的
// scanZstdFrames / compressZstdFrame）。Node 的 zstdDecompressSync 是"一次性单帧"
// API：真机实测一个 10MB 的日志只解出 196 字节的 session header 行，approval 事件
// 一条都读不到（单帧解码全库 asked=0，多帧解码全库 asked=478）。
// 所以必须先做帧结构扫描切出每个完整帧的字节范围，再逐帧解压。
//
// 另一个必须处理的现实：会话正在写入时最后一个帧可能只落了一半字节。
// 对"半帧"用 ZSTD_e_flush 尽力解出已可见内容，避免漏掉正在等待审批的活跃会话。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'

/** zstd 帧魔数 0xFD2FB528（小端存放，故 readUInt32LE 得到 4247762216）。 */
const ZSTD_MAGIC = 0xfd2fb528
/** skippable frame 魔数区间：0x184D2A50..0x184D2A5F（小端读写后落在 [0x50,0x5F]）。 */
const SKIPPABLE_MAGIC_BASE = 0x184d2a50
const SKIPPABLE_MAGIC_MASK = 0xfffffff0

/**
 * 默认只扫最近 60 个"改动过"的日志（按 mtime 降序）。
 * 为什么：全库 461 个文件、最大单文件 10MB，全扫约 10s，而左窗面板要秒级刷新；
 * 待审批只可能出现在活跃会话上，而活跃会话的日志必然在最近改动之列。
 */
const DEFAULT_LIMIT = 60

/** 递归深度上限：真实结构固定为 <workspace>/<session>/<file>，4 层足够。 */
const MAX_DEPTH = 4

/** 日志文件名白名单：session.jsonl.zstd / session.v3.jsonl.zstd 都命中。 */
const LOG_FILE_RE = /^session.*\.jsonl\.zstd$/

/** warnings 上限：一次刷新的诊断信息要有界，不能把响应体撑爆。 */
const MAX_WARNINGS = 50

/**
 * 行级预筛标记。
 * 为什么：日志里 99.9% 的行是 reasoning/chunk 这类与审批无关的事件，
 * 对每行做 JSON.parse 是纯粹的白烧 CPU。先用字节级 includes 找候选，
 * 只对真正含 "approval/" 的行做 JSON 解析。这是"全帧解码 + 廉价预筛"，
 * 语义上等价于逐行解析，只是快得多（实测 60 文件从 ~460ms 降到 ~90ms）。
 */
const APPROVAL_MARKER = Buffer.from('approval/', 'utf8')

/**
 * 组装带上下文的诊断串。
 * 为什么返回字符串：契约规定 warnings 是 string[]，要能直接塞进 JSON 响应。
 * 为什么字段固定：operation/target/error_code 是"哪一步、哪个目标、什么错"的最小集。
 */
export function describeIssue(operation, target, errorCode, context) {
  const parts = ['operation=' + operation, 'target=' + target, 'error_code=' + errorCode]
  if (context !== undefined) parts.push('context=' + safeJson(context))
  return '[active-sessions/approval] ' + parts.join(' | ')
}

/** JSON.stringify 遇到循环引用会抛，诊断信息本身绝不能成为新的故障源。 */
function safeJson(value) {
  try {
    const text = JSON.stringify(value)
    return text === undefined ? '"<undefined>"' : String(text).slice(0, 500)
  } catch {
    return '"<unserializable>"'
  }
}

/** 默认会话根目录。用函数而非常量，便于测试注入 rootDir 且不受 HOME 改动影响。 */
export function defaultSessionsRoot() {
  return path.join(os.homedir(), '.dsh', 'sessions')
}

/**
 * 从会话目录名提取会话 id。
 * 两种真实命名都要处理：'session-<uuid>'（Web/本项目会话）与裸 '<uuid>'（较早的会话）。
 * 统一返回**裸 uuid**：~/.dsh/storages/session_projcache/sessions/<uuid>.json
 * 就是以此命名的，调用方要用它和 projcache 条目对齐。
 */
export function extractSessionId(dirName) {
  if (typeof dirName !== 'string') return ''
  const trimmed = dirName.trim()
  if (trimmed === '') return ''
  return trimmed.startsWith('session-') ? trimmed.slice('session-'.length) : trimmed
}

/**
 * 按 zstd 帧的字节布局切出每个完整帧的范围（不解压）。
 *
 * 为什么不用"搜索魔数"：压缩数据内部也会出现 0xFD2FB528 字面量，朴素搜索会切出
 * 垃圾边界并让后续解压整体失败。这里严格按 RFC 8878 的帧头 + 块头游走。
 * 与上游 dsh-session-persistence-jsonl 的 scanZstdFrames 是同一套算法，差别是
 * 上游遇损坏直接 throw，本模块要"单文件容错"，所以把损坏降级为 corrupt 标记，
 * 已扫到的完整帧照常返回。
 *
 * @param {Buffer} buffer 整个 .jsonl.zstd 的字节
 * @returns {{frames: Array<{start:number,end:number}>, tornStart: number|undefined, corrupt: string|undefined, truncated: boolean}}
 */
export function scanZstdFrames(buffer) {
  const frames = []
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
    return { frames, tornStart: undefined, corrupt: undefined, truncated: false }
  }
  let offset = 0
  while (offset < buffer.length) {
    const start = offset
    if (buffer.length - offset < 4) {
      return { frames, tornStart: start, corrupt: undefined, truncated: false }
    }
    const magic = buffer.readUInt32LE(offset)
    // skippable frame：合法但无内容，跳过其声明的长度即可（本仓库未出现，防御性处理）。
    if ((magic & SKIPPABLE_MAGIC_MASK) === SKIPPABLE_MAGIC_BASE) {
      if (buffer.length - offset < 8) {
        return { frames, tornStart: start, corrupt: undefined, truncated: false }
      }
      const size = buffer.readUInt32LE(offset + 4)
      const end = offset + 8 + size
      if (end > buffer.length) {
        return { frames, tornStart: start, corrupt: undefined, truncated: false }
      }
      offset = end
      continue
    }
    if (magic !== ZSTD_MAGIC) {
      return { frames, tornStart: start, corrupt: 'invalid frame magic at byte ' + offset, truncated: false }
    }
    offset += 4
    if (offset === buffer.length) {
      return { frames, tornStart: start, corrupt: undefined, truncated: false }
    }
    const descriptor = buffer.readUInt8(offset)
    offset += 1
    // bit3(0x18) 是保留位，置位即非法帧头
    if ((descriptor & 24) !== 0) {
      return { frames, tornStart: start, corrupt: 'reserved frame-header bit at byte ' + (offset - 1), truncated: false }
    }
    const contentSizeFlag = descriptor >>> 6
    const singleSegment = (descriptor & 32) !== 0
    const checksum = (descriptor & 4) !== 0
    const dictionaryFlag = descriptor & 3
    const dictionaryBytes = dictionaryFlag === 3 ? 4 : dictionaryFlag
    const contentSizeBytes = contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : (1 << contentSizeFlag)
    const remainingHeaderBytes = (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes
    if (buffer.length - offset < remainingHeaderBytes) {
      return { frames, tornStart: start, corrupt: undefined, truncated: false }
    }
    offset += remainingHeaderBytes
    for (;;) {
      if (buffer.length - offset < 3) {
        return { frames, tornStart: start, corrupt: undefined, truncated: false }
      }
      const blockHeader = buffer.readUIntLE(offset, 3)
      offset += 3
      const lastBlock = (blockHeader & 1) !== 0
      const blockType = (blockHeader >>> 1) & 3
      const blockSize = blockHeader >>> 3
      if (blockType === 3) {
        return { frames, tornStart: start, corrupt: 'reserved block type at byte ' + (offset - 3), truncated: false }
      }
      // block_type==1 是 RLE，payload 恒为 1 字节
      const payloadBytes = blockType === 1 ? 1 : blockSize
      if (buffer.length - offset < payloadBytes) {
        return { frames, tornStart: start, corrupt: undefined, truncated: false }
      }
      offset += payloadBytes
      if (lastBlock) break
    }
    if (checksum) {
      if (buffer.length - offset < 4) {
        return { frames, tornStart: start, corrupt: undefined, truncated: false }
      }
      offset += 4
    }
    frames.push({ start, end: offset })
  }
  return { frames, tornStart: undefined, corrupt: undefined, truncated: false }
}

/**
 * 逐帧解压并按行产出（生成器）。
 *
 * 为什么用生成器而不是"先拼成一个大字符串"：单文件解压后可达数十 MB，
 * 一次性拼串会让峰值内存翻倍；逐帧产出可以边解边丢。
 *
 * 为什么在**字节层**保留跨帧的半行：多字节 UTF-8 字符若正好被帧边界切开，
 * 先转字符串再拼接会产生替换字符（U+FFFD），所以 carry 用 Buffer 保存，
 * 拼好之后再按 0x0A 切。
 *
 * 非行事件（半帧、坏帧、结构损坏）写进 issues，由调用方决定如何有限度地上报——
 * 生成器本身无副作用，便于单测。
 *
 * @param {Buffer} buffer
 * @param {Array<{kind:string,target:string,error_code:string,context?:object}>} [issues] 出参
 * @returns {Generator<Buffer>} 每一行的字节（不含行尾 0x0A）
 */
export function* iterateLogLines(buffer, issues) {
  const sink = Array.isArray(issues) ? issues : []
  const scan = scanZstdFrames(buffer)
  if (scan.corrupt !== undefined) {
    sink.push({ kind: 'structure-error', target: 'scan', error_code: 'CORRUPT_ZSTD_STRUCTURE', context: { reason: scan.corrupt } })
  }
  let carry = Buffer.alloc(0)
  const emit = function* (chunk) {
    const joined = carry.length === 0 ? chunk : Buffer.concat([carry, chunk])
    let start = 0
    for (;;) {
      const nl = joined.indexOf(0x0a, start)
      if (nl === -1) break
      yield joined.subarray(start, nl)
      start = nl + 1
    }
    carry = start === 0 ? Buffer.from(joined) : Buffer.from(joined.subarray(start))
  }
  for (const frame of scan.frames) {
    let decoded
    try {
      decoded = zlib.zstdDecompressSync(buffer.subarray(frame.start, frame.end))
    } catch (error) {
      // 单个帧坏掉不该让整个会话文件作废：记下来，继续解后面的帧。
      sink.push({
        kind: 'frame-error',
        target: 'byte' + frame.start,
        error_code: error?.code ?? error?.name ?? 'ZSTD_FRAME_ERROR',
        context: { message: String(error?.message ?? error).slice(0, 200) },
      })
      continue
    }
    yield* emit(decoded)
  }
  if (scan.tornStart !== undefined) {
    sink.push({ kind: 'torn-frame', target: 'byte' + scan.tornStart, error_code: 'ZSTD_INCOMPLETE_FRAME', context: { bytes: buffer.length - scan.tornStart } })
    try {
      // ZSTD_e_flush：告诉解码器"输入到此为止但帧尚未结束"，尽力吐出已可见明文。
      const partial = zlib.zstdDecompressSync(buffer.subarray(scan.tornStart), {
        finishFlush: zlib.constants.ZSTD_e_flush,
      })
      yield* emit(partial)
    } catch (error) {
      sink.push({
        kind: 'torn-frame-error',
        target: 'byte' + scan.tornStart,
        error_code: error?.code ?? error?.name ?? 'ZSTD_TORN_DECODE_ERROR',
        context: { message: String(error?.message ?? error).slice(0, 200) },
      })
    }
  }
  if (carry.length > 0) yield carry
}

/**
 * 列出会话日志文件，按 mtime 降序（最新改动的在前）。
 * 排序做了确定性处理：mtime 相同时按路径升序打破平局，保证同一份数据两次扫描
 * 得到完全相同的文件序——否则 limit 截断会随机漂移，测试也就不可重现。
 *
 * @returns {Array<{path:string,sessionId:string,mtimeMs:number,size:number}>}
 */
export function listSessionLogs(rootDir, warnings = []) {
  const found = []
  const walk = (dir, depth) => {
    let entries
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch (error) {
      // 会话目录可能正被 DSH 重建，读不到只是"少看几个文件"，不该中断整体扫描。
      warnings.push(describeIssue('列出目录', dir, error?.code ?? error?.name ?? 'EUNKNOWN', { message: String(error?.message ?? error).slice(0, 200), depth }))
      return
    }
    // 显式排序：目录枚举顺序在不同文件系统上不保证一致，而它会经"路径打破平局"影响结果。
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    for (const entry of entries) {
      const full = path.join(dir, entry.name)
      let isDirectory = entry.isDirectory()
      let isFile = entry.isFile()
      if (!isDirectory && !isFile && entry.isSymbolicLink()) {
        try {
          const stat = fs.statSync(full)
          isDirectory = stat.isDirectory()
          isFile = stat.isFile()
        } catch (error) {
          warnings.push(describeIssue('解析符号链接', full, error?.code ?? error?.name ?? 'EUNKNOWN', { message: String(error?.message ?? error).slice(0, 200) }))
          continue
        }
      }
      if (isDirectory) {
        if (depth < MAX_DEPTH) walk(full, depth + 1)
        continue
      }
      if (!isFile || !LOG_FILE_RE.test(entry.name)) continue
      let stat
      try {
        stat = fs.statSync(full)
      } catch (error) {
        warnings.push(describeIssue('读取文件元数据', full, error?.code ?? error?.name ?? 'EUNKNOWN', { message: String(error?.message ?? error).slice(0, 200) }))
        continue
      }
      found.push({
        path: full,
        sessionId: extractSessionId(path.basename(dir)),
        mtimeMs: stat.mtimeMs,
        size: stat.size,
      })
    }
  }
  walk(rootDir, 0)
  found.sort((a, b) => (b.mtimeMs - a.mtimeMs) || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
  return found
}

/**
 * 解析 limit 选项。
 * 为什么这样定：非有限值（Infinity/NaN）或 <=0 一律解释成"不截断"。
 * 因为 0 更可能被调用方用来表达"全部"而不是"一个都不扫"；截断本身只是性能优化，
 * 而误读成"不扫任何文件"会让待审批面板静默变空——那是最坏的失败模式。
 */
function resolveLimit(value) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return Number.POSITIVE_INFINITY
  return Math.floor(value)
}

/** 安全取字段：外部日志是不可信输入，任何一层都可能是 null 或非对象。 */
function pick(container, key) {
  if (container === null || typeof container !== 'object') return undefined
  return container[key]
}

/** @returns {object|null} 解析失败或非对象一律 null（调用方只计数，不当作致命错误）。 */
function parseEventLine(lineBuffer) {
  const text = lineBuffer.toString('utf8').trim()
  if (text === '') return null
  try {
    const parsed = JSON.parse(text)
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null
    return parsed
  } catch {
    return null
  }
}

/**
 * 对一个会话日志的字节做审批事件扫描，把结果写进聚合器。
 * 拆出来是为了让"单文件失败容错"有一个明确的边界：调用方 catch 一次就能降级。
 *
 * @returns {{asked:number, decided:number, unparsed:number}}
 */
function scanOneLog(buffer, sessionId, aggregate, issues) {
  let asked = 0
  let decided = 0
  let unparsed = 0
  for (const line of iterateLogLines(buffer, issues)) {
    // 廉价预筛：日志里绝大多数行与审批无关，先做字节级判断，
    // 避免对几十万行做无谓的 JSON.parse（语义与逐行解析等价）。
    if (line.indexOf(APPROVAL_MARKER) === -1) continue
    const event = parseEventLine(line)
    if (event === null) {
      unparsed += 1
      continue
    }
    const type = event.type
    if (type !== 'approval/asked' && type !== 'approval/decided') continue
    const approvalId = pick(pick(event, 'data'), 'id')
    if (typeof approvalId !== 'string' || approvalId === '') {
      unparsed += 1
      continue
    }
    if (type === 'approval/asked') {
      asked += 1
      const previous = aggregate.askedByApprovalId.get(approvalId)
      if (previous !== undefined && previous !== sessionId && aggregate.conflicts.size < 5) {
        aggregate.conflicts.add(approvalId)
      }
      // 后写覆盖：同一 id 被重复 asked 时以最后声明者为准（重放/重试场景下幂等）。
      aggregate.askedByApprovalId.set(approvalId, sessionId)
    } else {
      decided += 1
      aggregate.decidedApprovalIds.add(approvalId)
    }
  }
  return { asked, decided, unparsed }
}

/**
 * 扫描会话日志，找出"已问待批"（approval/asked 无同 id approval/decided）的会话。
 *
 * 语义：pending 是**会话 id**（裸 uuid）集合，可直接与 projcache 条目 / states 模块对齐。
 * 注意"待审批"是跨重启成立的：日志是持久化的，decided 一旦落盘就不会再变，
 * 所以本函数不依赖任何进程内状态。
 *
 * @param {object} [options]
 * @param {number} [options.limit=60] 只扫最近 N 个改动过的日志；非有限值或 <=0 表示全部
 * @param {string} [options.rootDir] 会话根目录，默认 ~/.dsh/sessions（测试注入用）
 * @param {object} [options.stats] 出参：扫描统计写进该对象（不改变返回类型）
 * @returns {Promise<{pending: Set<string>, warnings: string[]}>}
 */
export async function scanApprovals(options = {}) {
  const opts = options !== null && typeof options === 'object' ? options : {}
  const warnings = []
  const stats = opts.stats !== null && typeof opts.stats === 'object' ? opts.stats : null
  const startedAt = Date.now()
  const rootDir = typeof opts.rootDir === 'string' && opts.rootDir !== '' ? opts.rootDir : defaultSessionsRoot()
  const limit = resolveLimit(opts.limit)

  // approvalId -> sessionId。用 Map 而非普通对象，避免日志里的 __proto__ / constructor
  // 之类键名污染原型链（日志是不可信输入）。
  const aggregate = {
    askedByApprovalId: new Map(),
    decidedApprovalIds: new Set(),
    conflicts: new Set(),
  }

  let filesFound = 0
  let filesScanned = 0
  let filesFailed = 0
  let linesUnparsed = 0
  let frameErrors = 0
  let tornFrames = 0
  let askedCount = 0
  let decidedCount = 0

  let candidates = []
  try {
    candidates = listSessionLogs(rootDir, warnings)
  } catch (error) {
    warnings.push(describeIssue('枚举会话日志', rootDir, error?.code ?? error?.name ?? 'EUNKNOWN', { message: String(error?.message ?? error).slice(0, 300) }))
  }
  filesFound = candidates.length
  const selected = Number.isFinite(limit) ? candidates.slice(0, limit) : candidates

  for (const file of selected) {
    let buffer
    try {
      buffer = fs.readFileSync(file.path)
    } catch (error) {
      // 单文件失败必须容错：DSH 可能正在轮转/压缩这个文件。
      filesFailed += 1
      warnings.push(describeIssue('读取会话日志', file.path, error?.code ?? error?.name ?? 'EUNKNOWN', { message: String(error?.message ?? error).slice(0, 200), size: file.size }))
      continue
    }
    const issues = []
    try {
      const result = scanOneLog(buffer, file.sessionId, aggregate, issues)
      askedCount += result.asked
      decidedCount += result.decided
      linesUnparsed += result.unparsed
      filesScanned += 1
    } catch (error) {
      filesFailed += 1
      warnings.push(describeIssue('解析会话日志', file.path, error?.code ?? error?.name ?? 'EUNKNOWN', { message: String(error?.message ?? error).slice(0, 200) }))
    } finally {
      // 每个坏帧/结构异常都收进 issues，再统一降级成有限条警告，
      // 避免一个坏文件把 warnings 刷满；截断本身也会显式留痕。
      for (const issue of issues) {
        if (issue.kind === 'frame-error') frameErrors += 1
        if (issue.kind === 'torn-frame' || issue.kind === 'torn-frame-error') tornFrames += 1
        if (warnings.length >= MAX_WARNINGS) break
        warnings.push(describeIssue('解压会话日志', file.path + '#' + issue.target, issue.error_code, issue.context))
      }
      if (warnings.length >= MAX_WARNINGS) {
        const marker = describeIssue('汇总警告', rootDir, 'WARNINGS_TRUNCATED', { max: MAX_WARNINGS })
        if (!warnings.includes(marker)) warnings.push(marker)
      }
      // 显式丢弃大缓冲，让 GC 能在文件间回收（峰值内存 ≈ 单文件解压后大小）
      buffer = null
    }
  }

  // "有裁决但没见过问"的 id 不计错误：approval/asked 可能落在 limit 窗口之外。
  // 但把它计数暴露出来，能区分"真没审批"和"扫描窗口太小"。
  let orphanDecided = 0
  for (const approvalId of aggregate.decidedApprovalIds) {
    if (!aggregate.askedByApprovalId.has(approvalId)) orphanDecided += 1
  }

  const pending = new Set()
  for (const [approvalId, sessionId] of aggregate.askedByApprovalId) {
    if (aggregate.decidedApprovalIds.has(approvalId)) continue
    if (sessionId === '') continue
    pending.add(sessionId)
  }

  for (const approvalId of aggregate.conflicts) {
    if (warnings.length >= MAX_WARNINGS) break
    warnings.push(describeIssue('审批 id 归属', approvalId, 'APPROVAL_ID_CROSS_SESSION', { note: '同一 approval id 出现在多个会话日志中，归属以最后扫描到的会话为准' }))
  }

  if (stats !== null) {
    stats.rootDir = rootDir
    stats.limit = Number.isFinite(limit) ? limit : null
    stats.filesFound = filesFound
    stats.filesSelected = selected.length
    stats.filesScanned = filesScanned
    stats.filesFailed = filesFailed
    stats.frameErrors = frameErrors
    stats.tornFrames = tornFrames
    stats.linesUnparsed = linesUnparsed
    stats.asked = askedCount
    stats.decided = decidedCount
    stats.askedUnique = aggregate.askedByApprovalId.size
    stats.decidedUnique = aggregate.decidedApprovalIds.size
    stats.orphanDecided = orphanDecided
    stats.pendingSessions = pending.size
    stats.elapsedMs = Date.now() - startedAt
  }

  return { pending, warnings }
}

export default scanApprovals
