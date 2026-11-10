# Changelog

## 0.2.1

### fix: SKILL.md frontmatter 块标量

- `parseFrontmatter` 之前只按行取 `key: value`，真实插件用 `description: >` / `|` 这类
  YAML 块标量写描述，读出来的 description 是 `>` 或空，导致**整个插件的 skill 被静默丢弃**
  （真机症状：一个插件的 11 个 skill 只进来 1 个，另几个插件全部 0）。
- 现在支持折叠（`>`/`>-`/`>+`）与字面（`|`/`|-`/`|+`）块标量、顶格 key 边界、引号标量与
  行内 JSON；仍不引入 YAML 依赖（只用 node 内置）。
- 新增 5 项单测覆盖块标量、chomping、行内 JSON、块边界与无 frontmatter 的输入。
- 导出 `parseFrontmatter` 供测试。

## 0.2.0

### hooks 桥（两条通道，真机验证）

- **DSH 原生通道** `hooks/dsh.json`：插件声明真实 dsh 事件名（`agent/created`、`agent/session-start`、
  `agent/inbox/inserted`、`tools/pre-execute`、`tools/post-execute`、`agent/turn-stopping`、`agent/disposed`），
  hook 收到 dsh 原生 payload（含 `dsh.session_log` / `turn` / `step`）。
- **Claude 兼容通道** `hooks/hooks.json`：dsh 事件 → Claude hook 调用（Claude 工具名、Claude 结构 stdin、
  合成的 Claude 会话 `transcript_path`）；vibe-flow `doc_gate.py` 这类 Stop 文档闸已实机复用成功。
- **通道优先级**：插件有可用 `hooks/dsh.json` 时只走原生通道，`hooks/hooks.json` 显式不执行。
- **事件映射**：SessionStart→`agent/session-start`（`agent/created` 也支持，无 source 时推断）、
  UserPromptSubmit→`agent/inbox/inserted`、PreToolUse→`tools/pre-execute`（deny/ask 真拦截）、
  PostToolUse→`tools/post-execute`（accept/block/附加上下文）、Stop→`agent/turn-stopping`
  （`agent.steer` + `stop_hook_active` 等价物，每 turn 默认只拦一次）、SessionEnd→`agent/disposed`。
- 共用输出协议：exit 2 阻断；`decision:block`、`permissionDecision` deny/ask/allow、`additionalContext`、
  `systemMessage`、`continue:false`、纯文本；超时/启动失败策略与 `failClosed`。
- **Claude transcript 合成**：从 `session/event` 累积合成为 Claude JSONL；`agent.session.events` 不可用时
  回退读取 `<sessionRoot>/**/session.jsonl.zstd`（Node 内置 zstd，支持多 frame）。
- **启动事件去重**：`agent/created` 最多等 `startupGraceMs` 取 `agent/session-start` 的 source；
  两组条目一次会话开始只各跑一遍，迟到事件不重跑。
- **可外部核验的 hook 执行日志**：`<DSH_HOME>/state/claude-plugin-loader/hooks[-profile].jsonl`，
  默认开启、256KB 轮转、输出脱敏；`hookLog: false` 关闭。
- **Windows 命令构造**：普通命令直接 argv 启动（绕开 cmd.exe 对引号的二次转义）、含 shell 元字符走
  PowerShell、`shell:"bash"` 走 Git Bash（跳过 WSL）。`commandWindows` 生效。
- **诊断工具**：新增 `claude_plugin_hooks`（生效条目/清单 mtime/最近执行/日志尾部）与
  `claude_plugin_hook_selftest`（合成 payload 跑一条 hook，明确不等于宿主真实触发）；
  `claude_plugin_status` 增加 hooks 通道摘要。
- **配置**：`hooksEnabled`、`claudeHooks`、`dshHooks`、`sessionStartHooks`（旧开关保留，仅关 SessionStart）、
  `hookTimeoutMs`、`failClosed`、`maxStopBlocksPerTurn`、`startupGraceMs`、`transcript`、`sessionRoot`、
  `hookLog`/`hookLogPath`/`hookLogMaxBytes`、`bashPath`、`powerShellPath`、`claudeToolNames`。
- **测试**：`node --test test.mjs` 41 项全绿；真实抓取的 dsh 会话日志做脱敏 fixture；脚本化子进程 seam
  覆盖桥接接线；单测覆盖清单解析/通道优先级/matcher/stdin/输出协议/超时/Stop 每轮一次/启动去重/Windows 命令/
  transcript 合成/hook 日志轮转与脱敏。
- **文档**：README/GUIDE 增加 hooks 契约、payload、输出协议、配置、验证与限制说明。

## 0.1.0

- Initial release.
- Loads Claude-style plugins into dsh web/tui/headless profiles.
- Default scan root: `~/.claude/plugins/cache`.
- Skills channel via dsh skill registry.
- Commands channel with hot reload and uninstall cleanup.
- Optional SessionStart hook bridge.
- Tools: `claude_plugin_status`, `claude_plugin_commands`, `claude_plugin_run_command`.
- Unit tests and user guide included.
