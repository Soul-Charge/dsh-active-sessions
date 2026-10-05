# dsh-active-sessions

DSH Web GUI 插件：**左侧活跃会话长窗** + **工作总览标签页**。

## 做什么

- **活跃会话长窗**（左侧面板，默认展开，可收起为导航栏胶囊）
  按三态列出所有工作区的会话：
  - **运行中** — `sessionStats.openStep` 非空或 `pendingCalls` 非空
  - **待审批** — 会话日志中 `approval/asked` 无对应 `approval/decided`（可跨重启）
  - **已完成未查看** — 有新的 `lastPromptAt` 且超过本会话已读水位
  同工作区的相关会话按标题关键词聚类（IDF 过滤），缩进 + 连线展示关系证据。

- **工作总览**（导航栏标签页，点击切换中间主界面）
  扫描各工作区的笔记/总结类文件（`tasks/**`、`.agents/notes/**`、`README.md` 等），
  按工作区生成"我做过什么"总结。支持手动触发与自动开关，总结模型从 DSH 既有模型来源选择。

## 设计原则

- **只读**：不写、不改任何 DSH 会话或配置数据。
- **0 token**：不注册任何模型可见工具；面板数据全部来自本地结构化投影与日志。
  只有"工作总览"在显式触发时才调用模型。
- **降级安全**：任一会话文件解析失败只记 warning，不中断整体渲染。

## 数据来源

| 用途 | 路径 |
|---|---|
| 会话投影（三态） | `~/.dsh/storages/session_projcache/sessions/session-*.json` |
| 工作区元数据 | `~/.dsh/storages/workspace.json` |
| 审批事件 | `~/.dsh/sessions/**/session.v3.jsonl.zstd` |

> ⚠️ **不要**读 `session_projcache.json`（那是过期快照，实测与实时数据差 3 倍）。

## 已知约束

- 一个插件包只能有一个客户端入口，所以两个 UI 内联在 `src/client.js`。
- **不在列容器上用 `backdrop-filter`**：会成为 fixed 后代的包含块，
  把设置弹窗困在侧栏里（上游皮肤作者已实测）。改用半透明实色模拟通透。

## 结构

```
src/
  index.js      服务端装配（Cordis 入口）
  client.js     客户端装配（内联两个 UI）
  states.js     三态扫描 + 相关会话聚类
  approval.js   审批事件扫描（多帧 zstd）
  overview.js   笔记扫描 + 总结 prompt 构建
  rpc.js        HTTP 端点注册
  ui/
    sidebar.js  左侧长窗
    overview.js 工作总览页
```
