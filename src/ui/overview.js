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
export const OVERVIEW_SLOT = 'conversation.view';
export const OVERVIEW_VIEW_ID = 'work-overview';
/** 排在工具统计之后。 */
export const OVERVIEW_VIEW_ORDER = 40;

/** 本插件自己的取数端点；契约 §4.2 的「localhost HTTP 端点」降级通道。 */
export const OVERVIEW_ENDPOINT = '/api/active-sessions/overview';

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
export const OVERVIEW_GENERATE_ENDPOINT = OVERVIEW_ENDPOINT + '/generate';

/**
 * 隐藏名单切换端点（2026-10-07）。与服务端 rpc.js 的 ROUTES.overviewHidden 对应。
 *
 * ⚠️ 语义边界：这是**本插件总览页的显示控制**，不是 DSH 的工作区删除。
 *   界面上的一切文案都必须守住这条线 —— 按钮写「隐藏」而不是「删除」，
 *   确认框必须写明「DSH 的工作区与文件都不受影响」。
 *   一旦用户以为删了 DSH 的工作区，他的侧栏/会话就会"莫名其妙少一个"，
 *   而真相是本插件把它从这一页藏起来了 —— 那比不做功能更糟。
 */
export const OVERVIEW_HIDDEN_ENDPOINT = OVERVIEW_ENDPOINT + '/hidden';

/**
 * 隐藏/恢复的二次确认文案（纯函数，导出到 internals 供单测直接断言）。
 *
 * 为什么必须把这句话写死并单独可测：它是本功能唯一的「语义说明书」。
 * 按钮叫「隐藏」，用户第一反应仍可能是「删掉？」，
 * 所以确认框里必须明确三件事：只影响本页 / DSH 数据不受影响 / 可以恢复。
 */
export function hiddenConfirmText(cwd, hide) {
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
export function createOverviewUi(deps) {
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

export default { createOverviewUi: createOverviewUi };
