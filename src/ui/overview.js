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

export default { createOverviewUi: createOverviewUi };
