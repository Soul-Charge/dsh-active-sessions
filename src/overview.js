/**
 * dsh-active-sessions — 工作总览扫描器（服务端 / 只读 / 0 token）
 *
 * 为什么单独成文件，而不是并进 states.js：
 *   三态扫描只读 ~/.dsh 下已经算好的结构化投影，一次 readdir 就能覆盖；
 *   工作总览要爬用户自己的工作区目录树（很可能是 /mnt/* 上的 9P 挂载，stat 极慢）。
 *   两者的性能特征、失败模式与风险面完全不同，拆开之后集成方可以只对总览做
 *   限流 / 超时 / 降级，而不会连带拖慢左窗的三态刷新。
 *
 * 硬约束（契约 §6）：只读、不写盘、不注册模型可见工具。
 *   本文件不 import 任何模型 SDK，也不发起任何网络请求 —— 这是 0 token 的物理保证。
 *   options.generate 默认 false：此时只回文件清单与统计，绝不组装 prompt。
 *
 * 外部输入一律不可信：workspace.json、会话投影、目录项、文件大小都可能坏掉或缺失，
 *   全部在边界处校验并降级成 warnings/diagnostics，绝不让解析失败穿透成异常。
 *
 * 本文件的注释里刻意不写反引号与模板插值，保持源码在纯文本工具下可安全嵌入。
 */

import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

// ---------------------------------------------------------------------------
// 阈值与扫描源（导出以便测试与集成方引用，避免魔法数字散落）
// ---------------------------------------------------------------------------

/** 单文件丢弃阈值：超过它的笔记被视为「大文件 / 附件」，读了只会吃满上下文预算。 */
export const MAX_FILE_BYTES = 200 * 1024;
/** 每个工作区最多纳入的文件数。 */
export const MAX_FILES_PER_WORKSPACE = 40;
/** 每个工作区的摘录总字节上限，超出即截断（并记 warning）。 */
export const MAX_TOTAL_BYTES_PER_WORKSPACE = 2 * 1024 * 1024;
/** 目录递归深度上限：防止被深目录树拖死。 */
export const MAX_DEPTH = 6;
/** 每个扫描源的 readdir 条目预算：防止在超大目录上无限走。 */
export const MAX_ENTRIES_PER_ROOT = 4000;
/** 单文件写入 prompt 的摘录字符数（2026-10-06 由 3000 下调到 1500）。 */
export const DEFAULT_EXCERPT_CHARS = 1500;

/**
 * 单工作区写入 prompt 的**摘录总预算**（字符）。
 *
 * 2026-10-06 由「无预算，只在最后整段截断」改成显式预算，理由是实测数据：
 *   - 旧实现：40 个文件 × 3000 字符 = 120000 字符摘录，AiHarness 实测 **110101** 字符；
 *   - 组装后的 prompt 被 MAX_PROMPT_CHARS(60000) 从**中间某个文件内部**硬切一刀，
 *     结尾是一句被腰斩的话加「…（提示词超长，已在此截断）」；
 *   - 于是 4 个工作区的 prompt 顶到 60016 字符，其中 5 万字符被模型看到、5 万字符被丢掉，
 *     而模型为这 5 万字符付了完整的上下文成本 —— 换一个「600 字 / 8 条要点」的输出。
 *
 * 24k 字符的依据：输出上限是 8 条要点 / 600 字（summarize.js 的 SYSTEM_PROMPT），
 * 24k 字符证据是它的约 40 倍，足够判断「这个工作区做过什么」；
 * 同时对 32k 上下文的小模型也留得下输出余量（24k 中英混排 ≈ 12~20k token + 4096 输出）。
 * 超出预算的文件**仍会列出路径**，只是不再附带摘录（路径本身就是「我做过什么」的证据），
 * 并显式标注「摘录预算已用尽」——比腰斩在句子中间友好得多。
 */
export const MAX_EXCERPT_CHARS_PER_WORKSPACE = 24000;

/**
 * 单次组装出的 prompt 字符上限（硬背压，2026-10-06 由 60000 下调到 32000）。
 *
 * 有了 MAX_EXCERPT_CHARS_PER_WORKSPACE 之后，正常情况下永远碰不到这个上限
 * （24k 摘录 + 最多 40 个文件头 ≈ 27k）。保留它是为了「配置被人调到极端值」时不至于炸掉模型。
 */
export const MAX_PROMPT_CHARS = 32000;

/**
 * 目录剪枝集合（小写比较）。
 * 为什么把 temp 也算进去：契约把 temp 列为丢弃目录，而本工作区的 temp/ 只放
 * 临时调试产物，纳入总结只会引入噪音。
 */
const PRUNE_DIRS = new Set(['node_modules', '.git', 'trash', 'temp']);

/**
 * 扫描源清单。用「相对目录 + 是否递归」描述契约里的 glob：
 *   tasks 下递归 md · .agents/notes 下递归 md · README.md · dsh/plugins 一级 md · AGENTS.md
 * 为什么自己走目录而不用 glob 包：本插件要求零外部依赖（安装期不拉包），
 *   而且自走可以顺手做剪枝与条目预算。
 */
const DIR_SOURCES = [
  { kind: 'tasks', relDir: 'tasks', recursive: true, maxDepth: 6 },
  { kind: 'notes', relDir: '.agents/notes', recursive: true, maxDepth: 4 },
  { kind: 'plugins', relDir: 'dsh/plugins', recursive: false, maxDepth: 1 },
];
const ROOT_FILE_SOURCES = [
  { kind: 'readme', fileName: 'README.md' },
  { kind: 'agents', fileName: 'AGENTS.md' },
];

/**
 * 纳入顺序。为什么需要它：文件数上限是「每工作区 40」，如果按相对路径纯字典序截断，
 * 排序靠前的源会吃光配额。实测 AiHarness 工作区 67 个候选里，
 * .agents/notes(19) + dsh/plugins(14) + AGENTS.md(1) 就占掉 34 个名额，
 * tasks/ 的 33 个任务文档只剩 6 个能进来 —— 而 tasks/ 恰恰是「我做过什么」的主证据。
 * 改成按 kind 轮流取，每个源都能分到配额。
 */
const KIND_ORDER = ['tasks', 'notes', 'plugins', 'readme', 'agents'];

// ---------------------------------------------------------------------------
// 结构化错误上下文
// ---------------------------------------------------------------------------

/** 非数组对象判定。外部 JSON 只在这个形状下才允许继续取值。 */
function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * 构造一条带 operation/target/error_code 的诊断记录。
 * 为什么不用 Error 对象：warnings 要跨 RPC 变成 JSON，Error 序列化后会丢字段。
 */
function diag(input) {
  const error = input.error;
  const code =
    input.errorCode !== undefined
      ? input.errorCode
      : isRecord(error) && typeof error.code === 'string'
        ? error.code
        : error instanceof Error && typeof error.name === 'string'
          ? error.name
          : 'UNKNOWN';
  return {
    operation: String(input.operation),
    target: String(input.target === undefined || input.target === null ? '' : input.target),
    error_code: String(code),
    input_summary: String(input.inputSummary === undefined ? '' : input.inputSummary),
    message: error instanceof Error ? error.message : error === undefined ? '' : String(error),
    context: isRecord(input.context) ? input.context : {},
  };
}

/** 把诊断压成一行人类可读文本；界面直接展示它，不额外做格式化。 */
function warnLine(entry) {
  const ctx = Object.keys(entry.context).length > 0 ? ' ' + JSON.stringify(entry.context) : '';
  const msg = entry.message === '' ? '' : ': ' + entry.message;
  return '[' + entry.operation + '] ' + entry.target + ' -> ' + entry.error_code + msg + ctx;
}

/** 统一收口：一条诊断同时进 warnings（给人看）与 diagnostics（给程序看）。 */
function report(bag, entry) {
  bag.diagnostics.push(entry);
  bag.warnings.push(warnLine(entry));
}

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------

/** 相对路径一律转 POSIX 分隔符：摘要与 prompt 里混用反斜杠与正斜杠会让人读错层级。 */
function toPosix(value) {
  return value.split(path.sep).join('/');
}

/**
 * 有界并发映射。用 allSettled 语义保证单个失败不会带走整批；
 * 并发上限固定为注入值，避免在 /mnt/* 上打开过多 fd。
 */
async function mapLimited(items, limit, worker) {
  const results = new Array(items.length);
  let cursor = 0;
  const width = Math.max(1, Math.min(limit, items.length));
  const runners = new Array(width).fill(null).map(async () => {
    for (;;) {
      const index = cursor;
      cursor += 1;
      if (index >= items.length) return;
      try {
        results[index] = { ok: true, value: await worker(items[index], index) };
      } catch (error) {
        results[index] = { ok: false, error: error };
      }
    }
  });
  await Promise.all(runners);
  return results;
}

/** 读文件并截断到 chars；返回值带 truncated 标志，调用方必须处理失败分支。 */
async function readExcerpt(abs, chars) {
  const text = await fsp.readFile(abs, 'utf8');
  if (text.length <= chars) return { text: text, truncated: false };
  return { text: text.slice(0, chars), truncated: true };
}

// ---------------------------------------------------------------------------
// 选项归一化
// ---------------------------------------------------------------------------

/** 显式指定工作区：支持 ['/abs/path'] 或 [{cwd,name}]，以及单值 options.cwd。 */
function normalizeExplicitRoots(doc) {
  const out = [];
  const push = (value) => {
    if (typeof value === 'string' && value.trim() !== '') out.push(value.trim());
    else if (isRecord(value) && typeof value.cwd === 'string' && value.cwd.trim() !== '') out.push(value.cwd.trim());
  };
  if (Array.isArray(doc.workspaces)) for (const item of doc.workspaces) push(item);
  if (Array.isArray(doc.roots)) for (const item of doc.roots) push(item);
  push(doc.cwd);
  return out;
}

/** 正数阈值读取：非法值一律回落到默认，绝不让 NaN 传进比较运算。 */
function positiveNumber(value, fallback) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback;
}

/** 把任意 options 收敛成一份内部配置；任何字段坏了都只影响该字段。 */
function normalizeOptions(options) {
  const doc = isRecord(options) ? options : {};
  const dshHome =
    typeof doc.dshHome === 'string' && doc.dshHome.trim() !== ''
      ? doc.dshHome.trim()
      // 2026-10-06：补上 DSH_HOME 环境变量这一层。此前本模块**只**认 os.homedir()，
      // 而 states.js / approval.js / index.js 全都优先认 DSH_HOME ——
      // 于是「DSH_HOME 指向别处」的部署下，states 读的是 A 家的投影，overview 读的是 B 家的
      // workspace.json，两边对不上却没有任何告警。现在与其余模块保持一致。
      : (typeof process !== 'undefined' &&
          process !== null &&
          typeof process.env === 'object' &&
          process.env !== null &&
          typeof process.env.DSH_HOME === 'string' &&
          process.env.DSH_HOME.trim() !== ''
        ? process.env.DSH_HOME.trim()
        : path.join(os.homedir(), '.dsh'));
  return {
    generate: doc.generate === true,
    now: typeof doc.now === 'number' && Number.isFinite(doc.now) ? doc.now : Date.now(),
    dshHome: dshHome,
    workspaceFile:
      typeof doc.workspaceFile === 'string' && doc.workspaceFile.trim() !== ''
        ? doc.workspaceFile.trim()
        : path.join(dshHome, 'storages', 'workspace.json'),
    sessionDir:
      typeof doc.sessionDir === 'string' && doc.sessionDir.trim() !== ''
        ? doc.sessionDir.trim()
        : path.join(dshHome, 'storages', 'session_projcache', 'sessions'),
    includeSessionCwds: doc.includeSessionCwds !== false,
    maxSessionFiles: positiveNumber(doc.maxSessionFiles, 2000),
    maxFilesPerWorkspace: positiveNumber(doc.maxFilesPerWorkspace, MAX_FILES_PER_WORKSPACE),
    maxTotalBytesPerWorkspace: positiveNumber(doc.maxTotalBytesPerWorkspace, MAX_TOTAL_BYTES_PER_WORKSPACE),
    maxFileBytes: positiveNumber(doc.maxFileBytes, MAX_FILE_BYTES),
    maxDepth: positiveNumber(doc.maxDepth, MAX_DEPTH),
    maxEntriesPerRoot: positiveNumber(doc.maxEntriesPerRoot, MAX_ENTRIES_PER_ROOT),
    excerptChars: positiveNumber(doc.excerptChars, DEFAULT_EXCERPT_CHARS),
    maxExcerptCharsPerWorkspace: positiveNumber(
      doc.maxExcerptCharsPerWorkspace,
      MAX_EXCERPT_CHARS_PER_WORKSPACE,
    ),
    explicitRoots: normalizeExplicitRoots(doc),
    hiddenCwds: normalizeHiddenCwds(doc.hiddenCwds),
  };
}

/**
 * 归一化「已隐藏工作区」集合（2026-10-07）。
 *
 * 输入既可能是 Set（服务端内存名单），也可能是落盘 JSON 的数组。
 * 这里是**第二道**窄化：第一道是 rpc.js 的 normalizeWorkspaceCwd
 * （端点入口处收紧外部输入），本函数负责「无论从哪来，非字符串一律不认」。
 * 之所以还要一道：scanOverview 是导出的公开函数，集成方可以任意传 options，
 * 不能假设调用方已经窄化过。
 *
 * 刻意**不**在这里做 path.resolve：键必须与 discoverWorkspaceRoots 用的是同一形态，
 * 而那边已经是 resolve 之后的绝对路径；在本模块重复 resolve 只会增加漂移面。
 */
function normalizeHiddenCwds(value) {
  const out = new Set();
  if (value === null || typeof value !== 'object') return out;
  // ⚠️ 必须显式处理 **Map**：服务端传进来的就是 Map（cwd -> 时间戳），
  // 而 Map **不是** Set 的实例。首版只判了 Set/Array，结果 index.js 传 Map 时
  // 这里恒返回空 Set —— 表现为「接口回 ok=true、文件也写了，但列表里一个都没少」，
  // 且没有任何告警。烟测当场抓到的。
  const items = value instanceof Map ? value.keys()
    : Array.isArray(value) ? value
      : (typeof value[Symbol.iterator] === 'function' ? value : null);
  if (items === null) return out;
  for (const item of items) {
    // 形状 + 语义双检：除了「必须是字符串」，还必须是 POSIX 绝对路径。
    // 只查 typeof 是不够的 —— 首版正因如此把 'rel/path' 当成了合法隐藏键，
    // 单测 temp-e2e-hidden-workspaces 的第 10 组当场抓到（hidden=2 而不是 1）。
    // 相对路径永远匹配不上任何 root.cwd，留着它只会让 hiddenWorkspaces 计数虚高。
    if (typeof item !== 'string' || item === '' || item.length > 4096) continue;
    if (!item.startsWith('/') || item.includes('\\')) continue;
    // eslint-disable-next-line no-control-regex -- 控制字符检测正是这里的意图
    if (/[\u0000-\u001f\u007f]/.test(item)) continue;
    out.add(item);
  }
  return out;
}

// ---------------------------------------------------------------------------
// 工作区根目录发现
// ---------------------------------------------------------------------------

/**
 * 从 workspace.json 取出所有工作区路径。
 * 结构（实测）：{ unit, global:{workspaceIds,archivedSessionIds},
 *                tables:{workspaces:{<id>:{path,title,sessionIds}}} }
 * 只信 tables.workspaces[*].path —— global.workspaceIds 只是键名列表，不含路径。
 */
async function readWorkspaceFile(file, bag) {
  let text;
  try {
    text = await fsp.readFile(file, 'utf8');
  } catch (error) {
    // 文件缺失不算错误（新装的 DSH 可能还没有它），但其它 errno 必须留痕。
    if (!isRecord(error) || error.code !== 'ENOENT') {
      report(
        bag,
        diag({
          operation: '读取工作区元数据',
          target: file,
          error: error,
          inputSummary: 'workspace.json',
          context: { step: 'readFile' },
        }),
      );
    }
    return [];
  }
  let doc;
  try {
    doc = JSON.parse(text);
  } catch (error) {
    report(
      bag,
      diag({
        operation: '解析工作区元数据',
        target: file,
        error: error,
        errorCode: 'JSON_PARSE_FAILED',
        inputSummary: String(text.length) + ' chars',
        context: { step: 'JSON.parse' },
      }),
    );
    return [];
  }
  const tables = isRecord(doc) ? doc.tables : undefined;
  const workspaces = isRecord(tables) ? tables.workspaces : undefined;
  if (!isRecord(workspaces)) {
    report(
      bag,
      diag({
        operation: '解析工作区元数据',
        target: file,
        errorCode: 'SHAPE_UNEXPECTED',
        inputSummary: 'tables.workspaces 缺失或非对象',
        context: { topLevelKeys: isRecord(doc) ? Object.keys(doc).join(',') : typeof doc },
      }),
    );
    return [];
  }
  const paths = [];
  for (const key of Object.keys(workspaces).sort()) {
    const entry = workspaces[key];
    if (!isRecord(entry)) continue;
    if (typeof entry.path === 'string' && entry.path.trim() !== '') paths.push(entry.path.trim());
  }
  return paths;
}

/** 从会话投影里取 identity.cwd（契约 §2 指定的唯一工作区来源之一）。 */
async function readSessionCwds(dir, opts, bag) {
  let names;
  try {
    names = await fsp.readdir(dir);
  } catch (error) {
    if (!isRecord(error) || error.code !== 'ENOENT') {
      report(
        bag,
        diag({
          operation: '列出会话投影目录',
          target: dir,
          error: error,
          inputSummary: 'session_projcache/sessions',
          context: { step: 'readdir' },
        }),
      );
    }
    return [];
  }
  const files = names.filter((name) => name.endsWith('.json')).sort();
  if (files.length > opts.maxSessionFiles) {
    report(bag, {
      operation: '列出会话投影目录',
      target: dir,
      error_code: 'SESSION_SCAN_CAPPED',
      input_summary: String(files.length) + ' files',
      message: '会话投影文件超过上限，仅扫描前 ' + opts.maxSessionFiles + ' 个',
      context: { limit: opts.maxSessionFiles, total: files.length },
    });
  }
  const picked = files.slice(0, opts.maxSessionFiles);
  const settled = await mapLimited(picked, 8, async (name) => {
    const abs = path.join(dir, name);
    const text = await fsp.readFile(abs, 'utf8');
    const doc = JSON.parse(text);
    const record = isRecord(doc) ? doc.record : undefined;
    const identity = isRecord(record) ? record.identity : undefined;
    return isRecord(identity) && typeof identity.cwd === 'string' ? identity.cwd.trim() : '';
  });

  const cwds = [];
  let failed = 0;
  for (let index = 0; index < settled.length; index += 1) {
    const item = settled[index];
    if (item === undefined) continue;
    if (item.ok) {
      if (typeof item.value === 'string' && item.value !== '') cwds.push(item.value);
      continue;
    }
    failed += 1;
    // 单个投影坏掉不影响其余会话；但要留痕，否则「工作区少了」会变成幽灵问题。
    if (failed <= 5) {
      report(
        bag,
        diag({
          operation: '解析会话投影',
          target: path.join(dir, picked[index]),
          error: item.error,
          errorCode: 'PROJECTION_UNREADABLE',
          inputSummary: 'identity.cwd',
          context: { step: 'JSON.parse' },
        }),
      );
    }
  }
  if (failed > 5) {
    report(bag, {
      operation: '解析会话投影',
      target: dir,
      error_code: 'PROJECTION_UNREADABLE_MANY',
      input_summary: String(failed) + ' 个文件解析失败',
      message: '大量会话投影无法解析，工作区列表可能不完整',
      context: { failed: failed, scanned: picked.length },
    });
  }
  return cwds;
}

/**
 * 汇总工作区根目录：options 显式指定 > workspace.json > 会话 identity.cwd。
 * 三条来源用 path.resolve 后的绝对路径去重；同时记录来源，便于排查「这个工作区哪来的」。
 */
async function discoverWorkspaceRoots(opts, bag) {
  const map = new Map();
  let rejected = 0;
  const add = (cwd, source) => {
    if (typeof cwd !== 'string' || cwd.trim() === '') return;
    const raw = cwd.trim();
    // 拒绝非绝对路径。为什么要挡：会话投影里的 cwd 实测存在
    // "E:\MyData\...\temp" 这类 Windows 原始路径，path.resolve 会把它当成
    // 相对路径拼到进程 cwd 下，凭空造出 "…/E:\MyData\..." 这种假工作区。
    if (!path.isAbsolute(raw)) {
      rejected += 1;
      if (rejected <= 5) {
        report(
          bag,
          diag({
            operation: '归一化工作区路径',
            target: raw,
            errorCode: 'CWD_NOT_ABSOLUTE',
            inputSummary: source,
            message: '会话 cwd 不是绝对路径，已丢弃',
            context: { source: source, origin: cwd },
          }),
        );
      }
      return;
    }
    const abs = path.resolve(raw);
    const existing = map.get(abs);
    if (existing === undefined) {
      map.set(abs, { cwd: abs, name: path.basename(abs) || abs, sources: [source] });
      return;
    }
    if (!existing.sources.includes(source)) existing.sources.push(source);
  };

  for (const root of opts.explicitRoots) add(root, 'options');
  for (const cwd of await readWorkspaceFile(opts.workspaceFile, bag)) add(cwd, 'workspace.json');
  if (opts.includeSessionCwds) {
    for (const cwd of await readSessionCwds(opts.sessionDir, opts, bag)) add(cwd, 'session.cwd');
  }

  if (rejected > 5) {
    report(bag, {
      operation: '归一化工作区路径',
      target: opts.sessionDir,
      error_code: 'CWD_NOT_ABSOLUTE_MANY',
      input_summary: String(rejected) + ' 条非绝对路径',
      message: '多条会话 cwd 不是绝对路径，已全部丢弃',
      context: { rejected: rejected },
    });
  }

  return [...map.values()];
}

// ---------------------------------------------------------------------------
// 单工作区扫描
// ---------------------------------------------------------------------------

/**
 * 递归收集一个源目录下的 .md 候选文件。
 * 为什么不 stat 每个条目：/mnt/* 上 stat 很贵，先用 dirent 类型判断，
 * 只对真正要纳入的文件做 stat。
 */
async function walkMarkdown(rootAbs, source, opts, bag, state) {
  const start = path.join(rootAbs, source.relDir);
  let stat;
  try {
    stat = await fsp.stat(start);
  } catch (error) {
    // 目录不存在说明该源在此工作区未使用，属正常态，不产生噪音。
    if (!isRecord(error) || error.code !== 'ENOENT') {
      report(
        bag,
        diag({
          operation: '探测扫描源目录',
          target: start,
          error: error,
          inputSummary: source.relDir,
          context: { kind: source.kind, step: 'stat' },
        }),
      );
    }
    return;
  }
  if (!stat.isDirectory()) return;

  const found = [];
  const stack = [{ abs: start, depth: 0 }];
  let visited = 0;
  let exhausted = false;

  while (stack.length > 0) {
    const current = stack.pop();
    if (current.depth > source.maxDepth || current.depth > opts.maxDepth) continue;
    let entries;
    try {
      entries = await fsp.readdir(current.abs, { withFileTypes: true });
    } catch (error) {
      report(
        bag,
        diag({
          operation: '列出目录',
          target: current.abs,
          error: error,
          inputSummary: source.kind,
          context: { depth: current.depth, step: 'readdir' },
        }),
      );
      continue;
    }
    // 显式排序：枚举顺序不该影响最终纳入哪些文件（确定性要求）。
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (let index = entries.length - 1; index >= 0; index -= 1) {
      const entry = entries[index];
      visited += 1;
      if (visited > opts.maxEntriesPerRoot) {
        exhausted = true;
        break;
      }
      // 符号链接一律跳过：只读扫描没有理由跟进链接（可能成环，也可能跳出工作区）。
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        if (!source.recursive) continue;
        if (PRUNE_DIRS.has(entry.name.toLowerCase())) continue;
        stack.push({ abs: path.join(current.abs, entry.name), depth: current.depth + 1 });
        continue;
      }
      if (!entry.isFile()) continue;
      if (!/\.md$/i.test(entry.name)) continue;
      found.push(path.join(current.abs, entry.name));
    }
    if (exhausted) break;
  }

  if (exhausted) {
    state.exhausted = true;
    report(bag, {
      operation: '扫描目录',
      target: start,
      error_code: 'ENTRY_BUDGET_EXCEEDED',
      input_summary: source.kind,
      message: '目录条目超过预算 ' + opts.maxEntriesPerRoot + '，该源可能未扫全',
      context: { kind: source.kind, visited: visited },
    });
  }

  for (const abs of found) state.candidates.push({ abs: abs, kind: source.kind });
}

/** 工作区根部的单文件源（README.md / AGENTS.md）。 */
async function probeRootFile(rootAbs, source, bag, state) {
  const abs = path.join(rootAbs, source.fileName);
  try {
    const stat = await fsp.stat(abs);
    if (!stat.isFile()) return;
    state.candidates.push({ abs: abs, kind: source.kind, stat: stat });
  } catch (error) {
    if (isRecord(error) && error.code === 'ENOENT') return;
    report(
      bag,
      diag({
        operation: '探测工作区根文件',
        target: abs,
        error: error,
        inputSummary: source.kind,
        context: { step: 'stat' },
      }),
    );
  }
}

/**
 * 按 kind 轮转合并候选文件，每个 kind 内部按相对路径排序。
 * 确定性：同一组输入永远产出同一顺序（不依赖 readdir 的枚举顺序）。
 */
function interleaveByKind(candidates, relOf) {
  const buckets = new Map();
  for (const candidate of candidates) {
    const list = buckets.get(candidate.kind);
    if (list === undefined) buckets.set(candidate.kind, [candidate]);
    else list.push(candidate);
  }
  const order = KIND_ORDER.filter((kind) => buckets.has(kind));
  for (const kind of [...buckets.keys()].sort()) if (!order.includes(kind)) order.push(kind);
  const lists = order.map((kind) =>
    buckets.get(kind).sort((a, b) => {
      const ra = relOf(a.abs);
      const rb = relOf(b.abs);
      return ra < rb ? -1 : ra > rb ? 1 : 0;
    }),
  );
  const out = [];
  for (let round = 0; ; round += 1) {
    let pushed = false;
    for (const list of lists) {
      if (round < list.length) {
        out.push(list[round]);
        pushed = true;
      }
    }
    if (!pushed) break;
  }
  return out;
}

/** 扫描单个工作区并产出契约里的 OverviewWorkspace。 */
async function scanWorkspace(root, opts, bag) {
  const state = { candidates: [], exhausted: false };

  let exists = false;
  try {
    const rootStat = await fsp.stat(root.cwd);
    exists = rootStat.isDirectory();
  } catch (error) {
    if (!isRecord(error) || error.code !== 'ENOENT') {
      report(
        bag,
        diag({
          operation: '探测工作区根目录',
          target: root.cwd,
          error: error,
          inputSummary: root.name,
          context: { step: 'stat' },
        }),
      );
    }
  }

  if (exists) {
    for (const source of DIR_SOURCES) await walkMarkdown(root.cwd, source, opts, bag, state);
    for (const source of ROOT_FILE_SOURCES) await probeRootFile(root.cwd, source, bag, state);
  }

  // 去重：同一文件可能同时命中多个源。
  const byAbs = new Map();
  for (const candidate of state.candidates) {
    if (!byAbs.has(candidate.abs)) byAbs.set(candidate.abs, candidate);
  }

  const relOf = (abs) => toPosix(path.relative(root.cwd, abs));
  const candidates = interleaveByKind([...byAbs.values()], relOf);

  const files = [];
  let skippedOversize = 0;
  let truncated = state.exhausted;
  let totalBytes = 0;

  for (const candidate of candidates) {
    if (files.length >= opts.maxFilesPerWorkspace) {
      truncated = true;
      break;
    }
    let stat = candidate.stat;
    if (stat === undefined) {
      try {
        stat = await fsp.stat(candidate.abs);
      } catch (error) {
        report(
          bag,
          diag({
            operation: '读取文件元数据',
            target: candidate.abs,
            error: error,
            inputSummary: candidate.kind,
            context: { step: 'stat' },
          }),
        );
        continue;
      }
    }
    if (!stat.isFile()) continue;
    if (stat.size > opts.maxFileBytes) {
      skippedOversize += 1;
      continue;
    }
    if (totalBytes + stat.size > opts.maxTotalBytesPerWorkspace) {
      truncated = true;
      break;
    }
    totalBytes += stat.size;
    files.push({
      path: candidate.abs,
      relPath: relOf(candidate.abs),
      kind: candidate.kind,
      bytes: stat.size,
      mtimeMs: stat.mtimeMs,
    });
  }

  if (truncated) {
    report(bag, {
      operation: '截断工作区文件清单',
      target: root.cwd,
      error_code: 'WORKSPACE_TRUNCATED',
      input_summary: String(files.length) + ' files / ' + String(totalBytes) + ' bytes',
      message: '文件数或总大小超过上限，已截断',
      context: {
        maxFilesPerWorkspace: opts.maxFilesPerWorkspace,
        maxTotalBytesPerWorkspace: opts.maxTotalBytesPerWorkspace,
        kept: files.length,
        keptBytes: totalBytes,
      },
    });
  }
  if (skippedOversize > 0) {
    report(bag, {
      operation: '跳过超大文件',
      target: root.cwd,
      error_code: 'FILE_TOO_LARGE',
      input_summary: String(skippedOversize) + ' 个文件',
      message: '有 ' + skippedOversize + ' 个文件超过 ' + opts.maxFileBytes + ' 字节，已丢弃',
      context: { maxFileBytes: opts.maxFileBytes, skipped: skippedOversize },
    });
  }

  // 只有显式 generate 时才读正文；默认路径纯元数据，物理上不可能产生 token。
  //
  // 摘录预算（2026-10-06）：按文件顺序分配总预算，用完即止。
  // 为什么不是「读完再整段截断」：那会在句子中间腰斩（见 MAX_EXCERPT_CHARS_PER_WORKSPACE 注释），
  // 而且已经付了 I/O 与内存代价。这里超预算的文件只留路径 + 显式标注，模型仍看得见文件清单。
  if (opts.generate) {
    let budget = opts.maxExcerptCharsPerWorkspace;
    let skippedForBudget = 0;
    for (const file of files) {
      if (budget <= 0) {
        // 预算耗尽：不再读盘（省 I/O），只标记。
        file.excerpt = '（摘录预算已用尽，仅列出路径）';
        file.excerptOmitted = true;
        skippedForBudget += 1;
        continue;
      }
      try {
        const allow = Math.max(0, Math.min(opts.excerptChars, budget));
        const excerpt = await readExcerpt(file.path, allow);
        file.excerpt = excerpt.truncated ? excerpt.text + '\n…（摘录已截断）' : excerpt.text;
        file.excerptOmitted = false;
        budget -= excerpt.text.length;
      } catch (error) {
        report(
          bag,
          diag({
            operation: '读取文件摘录',
            target: file.path,
            error: error,
            inputSummary: String(file.bytes) + ' bytes',
            context: { step: 'readFile', excerptChars: opts.excerptChars },
          }),
        );
      }
    }
    if (skippedForBudget > 0) {
      report(bag, {
        operation: '分配摘录预算',
        target: root.cwd,
        error_code: 'EXCERPT_BUDGET_EXHAUSTED',
        input_summary: String(skippedForBudget) + ' 个文件仅列出路径',
        message: '摘录预算已用尽，后续文件只列出路径（模型仍可见完整文件清单）',
        context: {
          maxExcerptCharsPerWorkspace: opts.maxExcerptCharsPerWorkspace,
          excerptCharsPerFile: opts.excerptChars,
          pathOnly: skippedForBudget,
          files: files.length,
        },
      });
    }
  }

  return {
    cwd: root.cwd,
    name: root.name,
    sources: root.sources,
    exists: exists,
    files: files,
    fileCount: files.length,
    totalBytes: totalBytes,
    truncated: truncated,
    prompt: opts.generate ? buildSummaryPrompt(files, { cwd: root.cwd, name: root.name }) : null,
  };
}

// ---------------------------------------------------------------------------
// prompt 组装（纯函数）
// ---------------------------------------------------------------------------

/** 把 workspace 参数（字符串或对象）归一成 {cwd,name}，不读文件系统。 */
function promptWorkspaceMeta(workspace) {
  if (typeof workspace === 'string') {
    return { cwd: workspace, name: path.basename(workspace) || workspace };
  }
  if (isRecord(workspace)) {
    const cwd = typeof workspace.cwd === 'string' ? workspace.cwd : '';
    const name = typeof workspace.name === 'string' && workspace.name !== '' ? workspace.name : path.basename(cwd) || cwd;
    return { cwd: cwd, name: name };
  }
  return { cwd: '', name: '' };
}

/** 取一个文件的展示用相对路径（缺失时回落到绝对路径）。 */
function relPathOf(file) {
  if (typeof file.relPath === 'string' && file.relPath !== '') return file.relPath;
  if (typeof file.path === 'string' && file.path !== '') return file.path;
  return '(unknown)';
}

/**
 * 组装总结 prompt。纯函数：不读文件系统、不取时间、不引入随机，
 * 因此同一 (files, workspace) 必然产出同一字符串，可以放心写进单测。
 *
 * files 取 scanOverview({generate:true}) 返回的 OverviewFile[]（含 excerpt）；
 * 若没有 excerpt（调用方只传元数据），退化成「仅文件清单」的 prompt 而不是抛错 ——
 * 集成方可能想先让模型看目录、再决定读哪些文件。
 */
export function buildSummaryPrompt(files, workspace) {
  const list = Array.isArray(files) ? files.filter((item) => isRecord(item)) : [];
  const meta = promptWorkspaceMeta(workspace);
  // 排序放在纯函数内部：调用方给的顺序不该影响 prompt 内容（幂等 + 可缓存）。
  const sorted = [...list].sort((a, b) => {
    const ra = relPathOf(a);
    const rb = relPathOf(b);
    return ra < rb ? -1 : ra > rb ? 1 : 0;
  });

  const lines = [];
  lines.push('# 工作总览生成任务');
  lines.push('');
  lines.push('工作区：' + meta.name);
  lines.push('路径：' + meta.cwd);
  lines.push('笔记/总结类文件数：' + sorted.length);
  lines.push('');
  lines.push('## 任务');
  lines.push('依据下面的文件摘录，输出这个工作区「我做过什么」的结构化总结。要求：');
  lines.push('1. 只依据摘录中出现的信息，不得臆造未出现的路径、日期、结论或数字；信息不足就写「摘录不足以判断」。');
  lines.push('2. 按主题聚类成要点，每条要点末尾用括号附上证据文件的相对路径。');
  lines.push('3. 输出 Markdown：先一行总体概述，再以 ## 要点 起一段无序列表。');
  lines.push('4. 总长不超过 600 字；不要复述本提示词，也不要输出与摘录无关的通用建议。');
  lines.push('');
  lines.push('## 文件摘录');
  for (const file of sorted) {
    const rel = relPathOf(file);
    const bytes = typeof file.bytes === 'number' && Number.isFinite(file.bytes) ? file.bytes : 0;
    const excerpt = typeof file.excerpt === 'string' ? file.excerpt.trim() : '';
    lines.push('');
    lines.push('### ' + rel + ' (' + bytes + ' bytes)');
    lines.push(excerpt === '' ? '(无可读摘录)' : excerpt);
  }
  lines.push('');

  const prompt = lines.join('\n');
  if (prompt.length <= MAX_PROMPT_CHARS) return prompt;
  return prompt.slice(0, MAX_PROMPT_CHARS) + '\n\n…（提示词超长，已在此截断）';
}

// ---------------------------------------------------------------------------
// 对外主入口
// ---------------------------------------------------------------------------

/**
 * 扫描所有工作区的笔记/总结类文件，按工作区分组返回。
 *
 * 默认 options.generate=false：只回文件清单与统计，不读正文、不组装 prompt，
 * 因此这条路径上不可能产生任何模型 token。
 * generate=true 时组装 prompt 并放在 workspace.prompt；实际模型调用由集成方做。
 *
 * @param {object} [options] 见 normalizeOptions 的字段全集。
 * @returns {Promise<object>} OverviewResult
 */
export async function scanOverview(options = {}) {
  const opts = normalizeOptions(options);
  const bag = { warnings: [], diagnostics: [] };

  const discovered = await discoverWorkspaceRoots(opts, bag);
  if (discovered.length === 0) {
    report(bag, {
      operation: '发现工作区根目录',
      target: opts.workspaceFile,
      error_code: 'NO_WORKSPACE_ROOT',
      input_summary: 'options + workspace.json + session.cwd',
      message: '没有发现任何工作区根目录',
      context: {
        workspaceFile: opts.workspaceFile,
        sessionDir: opts.sessionDir,
        includeSessionCwds: opts.includeSessionCwds,
      },
    });
  }

  // ── 隐藏名单过滤（2026-10-07）────────────────────────────────────────────
  // 语义边界（用户明确要求）：被隐藏的工作区**只是不显示在总览页**。
  // 本插件不写 workspace.json、不调 DSH 的 workspaces 服务，DSH 的侧栏/会话记录一律不受影响。
  //
  // 为什么在**扫描之前**就滤掉（而不是扫完再从结果里删）：
  //   隐藏一个工作区的意图就是「我不想在总览里看它」，那就连它那棵目录树都别读。
  //   实测隐藏一个 /mnt/* 上的大工作区能省掉整棵树的 readdir + stat（本机 /mnt 是 9P，很贵）。
  //
  // ⚠️ NO_WORKSPACE_ROOT 的判定用的是**过滤前**的 discovered.length：
  //   全部工作区都被隐藏 ≠ 「没有发现任何工作区根目录」。
  //   早前版本会在这里误报，改用过滤后长度判断后告警又错了——这是两个不同的事实，必须分开记。
  const roots = discovered.filter((root) => !opts.hiddenCwds.has(root.cwd));
  const hiddenFromScan = discovered.length - roots.length;

  // 顺序扫描：/mnt/* 是 9P 挂载，并发 readdir 反而更容易把 IO 打满并拖慢所有工作区。
  const workspaces = [];
  for (const root of roots) {
    workspaces.push(await scanWorkspace(root, opts, bag));
  }
  workspaces.sort((a, b) => (a.cwd < b.cwd ? -1 : a.cwd > b.cwd ? 1 : 0));

  const counts = { workspaces: workspaces.length, files: 0, bytes: 0, truncatedWorkspaces: 0 };
  for (const workspace of workspaces) {
    counts.files += workspace.fileCount;
    counts.bytes += workspace.totalBytes;
    if (workspace.truncated) counts.truncatedWorkspaces += 1;
  }

  return {
    generatedAt: opts.now,
    generate: opts.generate,
    workspaces: workspaces,
    /**
     * 汇总口径（刻意选择，写在这里以免日后被人「顺手改成全部」）：
     * **counts 统计的是「隐藏之后、实际出现在这一页上的」工作区**，
     * 因此 counts.workspaces === workspaces.length 恒成立，
     * 页头那句「N 个工作区 · M 个文件」与下面看到的卡片永远对得上。
     * 若改成统计「全部」，用户会看到 3 张卡片却顶着「21 个工作区 · 400 个文件」的字样，
     * 那比「少显示了」更让人以为数据坏了。
     * 想看全量请看下面的 hiddenWorkspaces / hiddenFromScan 两个字段。
     */
    counts: counts,
    /**
     * 隐藏名单里的条目总数（= 插件隐藏名单的条数，**不等于**本页被滤掉的个数）。
     * 两者可以不等：被隐藏的 cwd 可能已经不再是任何工作区根（例如它在 workspace.json 里
     * 被删了），此时名单里仍有它，但这一页并没有「少了什么」。
     * 客户端工具栏的「已隐藏（N）」与恢复列表用这个数——它必须与可恢复的条目数一致，
     * 否则用户会看到一个自己没法恢复的计数。
     */
    hiddenWorkspaces: opts.hiddenCwds.size,
    /** 本次扫描里**真正被滤掉**的个数（= discovered.length - roots.length）。 */
    hiddenFromScan: hiddenFromScan,
    warnings: bag.warnings,
    diagnostics: bag.diagnostics,
  };
}

export default { scanOverview: scanOverview, buildSummaryPrompt: buildSummaryPrompt };
