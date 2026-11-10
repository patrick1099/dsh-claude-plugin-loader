# dsh-claude-plugin-loader

让 DeepSeek Harness (dsh) 直接发现并加载 Claude Code 风格的组合体插件（目录含 `.claude-plugin/plugin.json`），
把其中的 **skills / commands / hooks** 接入 dsh。

单文件实现（`dsh-claude-plugin-loader.mjs`），**只依赖 node 内置模块**：把文件复制进 profile 目录、
在 `cordis.patch.yml` 插入一行即可使用，不需要 `pnpm install`。

> 完整使用说明见 [GUIDE.md](GUIDE.md)：安装、扫描目录、hooks 契约、配置、验证、常见问题。

## 已实现（0.2.0）

- **插件发现**：默认扫 `~/.claude/plugins/cache`，可用 `pluginRoots` 追加目录；按插件名去重，活源优先，
  同一根目录内保留最高版本。
- **skills 通道**：把每个插件的 `skills/` 注册成 dsh skill provider（`skill` / `skill_search` 按名发现加载）；
  `enabledSkills` 可按 `插件名:技能名` 过滤。
- **commands 通道**：`commands/*.md` → dsh 斜杠命令；`reloadIntervalMs` 热更新，插件删除/禁用后自动注销。
- **hooks 桥（0.2.0 新增，两条通道）**
  - **DSH 原生通道** `hooks/dsh.json`：插件声明真实 dsh 事件名，hook 收到 dsh 原生 payload。
  - **Claude 兼容通道** `hooks/hooks.json`：loader 把 dsh 事件翻译成 Claude hook 调用（Claude 工具名、
    Claude 结构 stdin、**合成的 Claude `transcript_path`**），因此 vibe-flow `doc_gate.py` 这类
    解析 Claude 会话 JSONL 的 Stop 闸可以原样复用。
  - **通道优先级**：插件有可用的 `hooks/dsh.json` 时**只走原生通道**，其 `hooks/hooks.json` 不执行
    （避免同一插件两种清单互相矛盾、原始小写工具名静默放行）。
  - 事件映射（dsh 真实事件，非同名类比）：
    | Claude | dsh 事件 | 用途 |
    |---|---|---|
    | SessionStart | `agent/session-start`（`agent/created` 也支持） | 注入会话开始上下文 |
    | UserPromptSubmit | `agent/inbox/inserted` | 用户 prompt 文本 |
    | PreToolUse | `tools/pre-execute` | 真拦截：deny / ask |
    | PostToolUse | `tools/post-execute` | 结果接受/替换/补充/阻断 |
    | Stop | `agent/turn-stopping` | `agent.steer(reason)` 阻止收工，每轮只拦一次 |
    | SessionEnd | `agent/disposed` | 会话结束 |
  - **输出协议**（两条通道共用）：exit 0 放行；exit 2 阻断（stderr/stdout 作理由）；其它非阻断错误记日志。
    stdout 支持 `{"decision":"block","reason"}`、`{"hookSpecificOutput":{"permissionDecision":"deny"|"ask"|"allow"}}`、
    `{"hookSpecificOutput":{"additionalContext":"…"}}`、`{"systemMessage":"…"}`、`{"continue":false}`，以及纯文本
    （SessionStart/UserPromptSubmit 当上下文）。
  - **超时/失败策略**：按条目 `timeout`（秒），默认 `hookTimeoutMs`；PreToolUse 超时默认放行并写警告，
    `failClosed: true` 时改为拒绝；Stop / SessionStart 超时放行。
- **可外部核验的 hook 执行日志**（默认开启，`hookLog: false` 关闭）：每次 hook 执行追加一行 JSON 到
  `<DSH_HOME>/state/claude-plugin-loader/hooks[-<profile>].jsonl`（可用 `hookLogPath` 覆盖），
  按 `hookLogMaxBytes`（默认 256KB）轮转成 `.1`，含 ts / session / event / plugin / decision / exit / 耗时 /
  脱敏后的 stdout 摘要。desktop 会话里不调用工具也能从文件确认 Stop、PreToolUse 是否真的触发。
- **诊断工具**：`claude_plugin_status`（含 hooks 通道摘要）、`claude_plugin_commands`、
  `claude_plugin_run_command`、`claude_plugin_hooks`（每个插件生效条目 + 清单 mtime + 最近执行 + hook 日志尾部）、
  `claude_plugin_hook_selftest`（合成 payload 跑一条 hook，证明解析/执行/判定链；**不等于宿主真实触发**）。

## 尚未实现

- MCP 配置生成（`mcpServers` → `@deepseek-ai/dsh-mcp-client` 配置行）。
- agents 通道（`agents/*.md` → dsh subagent 预设）。
- `PreCompact` / `SubagentStart` / `SubagentStop` / `Notification` 等其它 Claude hook 事件（会记为 skipped）。
- 非 `command` 类型 hook（`http` 等）：安全策略上不执行，只在状态工具里显示 skipped。
- UserPromptSubmit 的**硬阻断**：dsh 的 `agent/inbox/inserted` 是只读通知，无法否决入箱；
  `decision:"block"` 目前转成上下文注入 + 警告（见限制）。
- 第三方插件兼容边界清单（逐个插件的 hook 行为断言）。

## 测试

```bash
node --test test.mjs
node --check dsh-claude-plugin-loader.mjs
```

覆盖：清单解析/通道优先级、matcher（Claude 名 vs dsh 名）、stdin 结构、输出协议、超时/failClosed、
Stop 每轮一次、`agent/created` + `agent/session-start` 双事件启动去重、Windows 命令构造（直启/PowerShell/Git Bash）、
Claude transcript 合成（用真实抓取的 dsh 会话日志做 fixture，已脱敏）、hook 执行日志（轮转/脱敏/关闭）、
以及用脚本化的模拟子进程 seam 做的桥接集成测试。

## 安装

### npm / dsh plugin

```bash
dsh plugin --profile <profile> add dsh-claude-plugin-loader
```

### 单文件手动安装（hub 采用这种方式）

把 `dsh-claude-plugin-loader.mjs` 复制进 profile 目录（如 `~/.dsh/profiles/desktop/`），
在 `cordis.patch.yml` 插入：

```yaml
- insert:
    - id: claude-plugin-loader
      name: ./dsh-claude-plugin-loader.mjs
      config:
        pluginRoots:
          - "C:/Users/<you>/treasury-vault/shared/plugins"
          - "C:/Users/<you>/.claude/plugins/cache"
        enabledPlugins:
          - "project-state"
          - "vibe-flow"
          - "xu-skills"
        enabledSkills:          # 可选：按 插件名:技能名 过滤
          - "vibe-flow:vibe-flow"
        hooksEnabled: true
        claudeHooks: true
        dshHooks: true
        transcript: auto
        reloadIntervalMs: 1500
```

## 配置一览

| 键 | 默认 | 说明 |
|---|---|---|
| `pluginRoots` | `~/.claude/plugins/cache` | 扫描根目录，按优先级 |
| `enabledPlugins` | 全部 | 插件名白名单（小写匹配） |
| `enabledSkills` | 全部 | `插件名:技能名` 白名单 |
| `reloadIntervalMs` | 1500 | 命令/清单热更新轮询；`0` 关闭 |
| `hooksEnabled` | true | hooks 桥总开关 |
| `claudeHooks` | true | 是否允许 Claude 兼容通道 |
| `dshHooks` | true | 是否允许 DSH 原生通道 |
| `sessionStartHooks` | true | 旧开关：仅控制 SessionStart 派发 |
| `hookTimeoutMs` | 60000 | hook 默认超时（条目 `timeout` 秒优先） |
| `failClosed` | false | PreToolUse 超时/启动失败时拒绝而非放行 |
| `maxStopBlocksPerTurn` | 1 | 同一 turn 最多拦几次收工 |
| `startupGraceMs` | 300 | `agent/created` 等 `agent/session-start` 的宽限 |
| `transcript` | auto | `off` 关闭 Claude transcript 合成 |
| `sessionRoot` | `<DSH_HOME>/sessions` | 持久会话日志根（transcript 回退/`dsh.session_log`） |
| `hookLog` | true | hook 执行日志 |
| `hookLogPath` | `<DSH_HOME>/state/claude-plugin-loader/hooks[-profile].jsonl` | 日志路径 |
| `hookLogMaxBytes` | 262144 | 轮转阈值 |
| `bashPath` | 自动找 Git Bash | `shell:"bash"` hook 的解释器 |
| `powerShellPath` | `powershell.exe` | 含 shell 元字符的 hook 解释器 |
| `claudeToolNames` | 内置映射 | 覆盖 dsh→Claude 工具名映射 |

## 已知限制

- **SessionEnd 在 one-shot headless 里不会为运行中的主 agent 触发**：`dsh-headless` 完成任务后直接
  `process.exit`，不 dispose agent。长生命周期宿主（desktop/web/tui）正常 dispose 时会触发
  `agent/disposed`；本仓 e2e 用宿主侧一次性 agent `create→dispose` 取得真实回调取证。
- **UserPromptSubmit 无法硬阻断**（dsh inbox 通知只读）。
- **SessionStart 双事件**：desktop 可能只发 `agent/created`（无 source）；loader 会等
  `agent/session-start` 最多 `startupGraceMs`，拿不到时按 `startup` 匹配并记一条限制日志。
  `clear` / `compact` 只有 `agent/session-start` 才能提供。
- **Claude 兼容通道的 `tool_response`** 是归一化形状 `{is_error, content, value}`，不伪造各工具在 Claude
  里的专有响应字段；`tool_input` 对 read/write/edit/grep/glob/pwsh 与 Claude 同名同参。
- **Windows 命令解释**：普通命令直接 argv 启动（避免 `cmd.exe` 引号被 Node 二次转义）；
  含 `| & ; < > $ ()` 等元字符的命令走 PowerShell；`shell:"bash"` 走 Git Bash（显式跳过 WSL 的
  `System32\bash.exe`，因为它看不到 `py` 等 Windows 工具）。
- **非 command hook 不执行**；未知事件记 skipped。
- 共享插件若同时放两份清单，`hooks/hooks.json` 会被显式忽略（见通道优先级）。

## 远端

<https://github.com/patrick1099/dsh-claude-plugin-loader>
