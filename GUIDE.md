# dsh-claude-plugin-loader 使用说明（0.2.0）

这个插件让 dsh 直接发现、加载 Claude Code 风格的插件（目录里带 `.claude-plugin/plugin.json`），
把其中的 **skills / commands / hooks** 接入 dsh。单文件、只依赖 node 内置模块。

---

## 1. 安装

npm 包：

```bash
dsh plugin --profile <profile> add dsh-claude-plugin-loader
```

单文件（hub / 手动）：

1. 把 `dsh-claude-plugin-loader.mjs` 复制进 profile 目录，如 `~/.dsh/profiles/desktop/`；
2. 在该 profile 的 `cordis.patch.yml` 插入：

```yaml
- insert:
    - id: claude-plugin-loader
      name: ./dsh-claude-plugin-loader.mjs
      config:
        pluginRoots:
          - "C:/Users/<you>/treasury-vault/shared/plugins"
          - "C:/Users/<you>/.claude/plugins/cache"
        reloadIntervalMs: 1500
```

cordis 会热加载这个单文件；改 loader 文件本身通常也会被 HMR 拾取，改插件清单则**无需重启**（见热更新）。

---

## 2. 插件去哪找

默认扫描 `~/.claude/plugins/cache`。`pluginRoots` 可追加/覆盖，多个目录按顺序扫描，
高优先级目录覆盖同名插件。只加载部分插件用 `enabledPlugins`；只要部分技能用 `enabledSkills`
（格式 `插件名:技能名`）。

---

## 3. 通道与 hooks 契约

### 3.1 通道优先级（重要）

同一插件**有可用的 `hooks/dsh.json` 时只走 DSH 原生通道**，其 `hooks/hooks.json` 不执行。
状态工具会显示 `channel=dsh|claude|none` 与「hooks/dsh.json 生效，hooks.json 未执行（通道优先级）」。

### 3.2 DSH 原生清单 `hooks/dsh.json`

```json
{
  "description": "…",
  "hooks": {
    "tools/pre-execute": [
      {
        "matcher": "^(write|edit|pwsh|bash)$",
        "hooks": [
          {
            "type": "command",
            "command": "python3 \"${PLUGIN_ROOT}/scripts/hook_pre.py\"",
            "commandWindows": "py -3 \"${PLUGIN_ROOT}/scripts/hook_pre.py\"",
            "timeout": 30
          }
        ]
      }
    ]
  }
}
```

支持的事件名（**真实 dsh 事件名**）：

| 事件 | 模式 | payload | 说明 |
|---|---|---|---|
| `agent/created` | emit | `{agent}` | 注册时；**无 source**（loader 会推断 startup/resume） |
| `agent/session-start` | emit | `{agent, source}` | source = `startup｜resume｜clear｜compact`（权威来源） |
| `agent/inbox/inserted` | emit | `{agent, message}` | 用户新消息入箱 |
| `tools/pre-execute` | waterfall | `(exec, next)` | 返回 `{kind:'deny',reason}` / `{kind:'ask'}` / `next()` |
| `tools/post-execute` | waterfall | `(exec, result, next)` | 返回 `{kind:'accept'…}` / `{kind:'block', feedback}` / `next()` |
| `agent/turn-stopping` | serial | `{agent, turn, signal}` | 要拦收工必须 `agent.steer(message)` |
| `agent/disposed` | emit | `{agent}` | 会话/agent 销毁（SessionEnd） |

hook 进程 stdin（UTF-8 JSON，稳定键）：

```json
{
  "hook_event_name": "tools/pre-execute",
  "session_id": "session-…",
  "cwd": "C:\\work\\repo",
  "plugin_root": "C:\\plugins\\x",
  "tool_name": "write",
  "tool_input": {"file_path": "…", "content": "…"},
  "tool_use_id": "call_…",
  "tool_response": {"is_error": false, "content": "…", "value": {}},
  "prompt": "",
  "source": "",
  "stop_hook_active": false,
  "reason": "",
  "dsh": {"session_log": "C:\\…\\session.jsonl.zstd", "turn": 1, "step": 2}
}
```

环境变量：`PLUGIN_ROOT`、`CLAUDE_PLUGIN_ROOT`（=插件目录）、`DSH_HOST=dsh`、`DSH_SESSION_ID`，
以及宿主注入的 `DSH_*`（`DSH_HOME`/`DSH_PROFILE`/`DSH_PROFILE_DIR` 等）。不会把插件目录以外的路径写进 env。
`${PLUGIN_ROOT}`、`${CLAUDE_PLUGIN_ROOT}`、`$PLUGIN_ROOT`、`$CLAUDE_PLUGIN_ROOT`、`%PLUGIN_ROOT%`
在 command / commandWindows 里都会展开。

### 3.3 Claude 兼容清单 `hooks/hooks.json`

原有 Claude 插件清单可直接用：

```json
{
  "hooks": {
    "SessionStart": [{"matcher": "^(startup|resume|clear|compact)$", "hooks": [{"type": "command", "command": "py -3 \"${CLAUDE_PLUGIN_ROOT}/hooks/start.py\""}]}],
    "Stop": [{"hooks": [{"type": "command", "command": "py -3 \"${CLAUDE_PLUGIN_ROOT}/hooks/doc_gate.py\"", "timeout": 20}]}]
  }
}
```

loader 会：

- 把 dsh 事件翻译成 Claude 事件，stdin 用 Claude 结构（`hook_event_name`、`session_id`、`cwd`、
  `transcript_path`、Claude 工具名 `Write/Edit/Read/Bash/PowerShell/…`、`tool_input`、`tool_use_id`、
  `tool_response`、`prompt`、`source`、`stop_hook_active`、SessionEnd 的 `reason`）；
- 合成 **Claude 会话转录** 临时文件并传 `transcript_path`：从 `session/event` 事件流累积
  （`user/message` → user 行，注入上下文标 `isMeta`，人类 prompt 带 `origin.kind="human"`；
  `assistant/message` 的 text/tool-call → assistant 的 text/tool_use；`tool/result` → user 的 tool_result），
  行结构与 Claude JSONL 对齐（`type/message.content[].type/timestamp/isMeta/origin`）。
  `agent.session.events` 不可用时回退读取持久日志 `<sessionRoot>/…/session.jsonl.zstd`
  （Node 内置 zstd 解压，支持多 frame）；
- env 额外提供 `CLAUDE_PLUGIN_ROOT`、`PLUGIN_ROOT`、`DSH_HOST`、`DSH_SESSION_ID`。

`Stop` 的 Claude 协议 `{"decision":"block","reason":…}` 会转成 `agent.steer(reason)`；
同一 turn 第二次派发时传 `stop_hook_active: true`（等价物），默认每 turn 最多拦一次。

### 3.4 输出协议（两通道共用）

| hook 输出 | 效果 |
|---|---|
| exit 0 | 放行 |
| exit 2 | 阻断；stderr（或 stdout）作为理由 |
| 其它退出码 | 非阻断错误，写日志 |
| `{"decision":"block","reason":"…"}` | PreToolUse=拒绝 / PostToolUse=阻断结果 / Stop=steer |
| `{"hookSpecificOutput":{"permissionDecision":"deny"\|"ask"\|"allow", …}}` | PreToolUse 判定（无审批支持时 `ask` 变拒绝） |
| `{"hookSpecificOutput":{"additionalContext":"…"}}` | 注入模型上下文（SessionStart/UserPromptSubmit/Pre/PostToolUse） |
| `{"systemMessage":"…"}` | 作为通知注入 |
| `{"continue":false}` | PreToolUse 拒绝；Stop 不拦（允许收工） |
| 纯文本 stdout | SessionStart/UserPromptSubmit 当上下文；其它事件只记录 |

### 3.5 超时与失败策略

按条目 `timeout`（秒），缺省 `hookTimeoutMs`（默认 60s）。PreToolUse 超时/启动失败**默认放行**并写警告，
`failClosed: true` 时改为拒绝；Stop、SessionStart 超时放行。启动失败（如找不到 Git Bash）同样按此策略。

### 3.6 启动事件的去重（desktop 兼容）

- 宿主可能只发 `agent/created`，也可能两者都发。收到 `agent/created` 后最多等 `startupGraceMs`（默认 300ms）
  看同一 agent 是否来 `agent/session-start`：来了用它的 source，没来则推断（会话有 seed → `resume`，否则 `startup`）；
- `agent/created` 与 `agent/session-start` 两组条目在**一次会话开始只各跑一遍**（按 agent + 解析后 source 去重），
  迟到/重复事件不会再跑；
- `clear`/`compact` 只有 `agent/session-start` 能提供；拿不到时按 `startup` 匹配并记一条限制日志。

---

## 4. 可外部核验的 hook 执行日志

默认开启（`hookLog: false` 关闭）。路径：

```text
<DSH_HOME>/state/claude-plugin-loader/hooks[-<profile>].jsonl
```

每行一次 hook 执行：`ts / session_id / turn / step / plugin / channel / event / source / matcher / command /
exit_code / decision / timed_out / spawn_error / duration_ms / stdout(≤200 脱敏) / stderr(≤200 脱敏)`。
超过 `hookLogMaxBytes`（默认 256KB）轮转成 `.1`，不会无界增长。

desktop 会话里不调用任何工具也能确认 hook 是否真的触发，例如：

```bash
tail -n 20 ~/.dsh/state/claude-plugin-loader/hooks-desktop.jsonl
```

`claude_plugin_hooks` 工具也会显示该路径和最后几行。

---

## 5. 验证

### 诊断工具

```text
调用 claude_plugin_status 并原样输出。
调用 claude_plugin_hooks 并原样输出。
调用 claude_plugin_hook_selftest，参数 {"plugin":"vibe-flow","event":"Stop"}。
```

`claude_plugin_hook_selftest` 用**合成 payload** 直接跑一条 hook，证明清单解析/匹配/执行/判定链；
它**不等于宿主真实触发**——真实触发看第 4 节的 hook 日志或真机会话。

### headless（独立 profile，别用 desktop profile）

```bash
dsh --profile <test-profile> --dump-config
dsh --profile <test-profile> "用 read 工具读一下 README.md，再回答 OK。"
```

### 拦截三态检查

- 放行：正常工具调用后 `hooks.jsonl` 里出现 `decision=none`；
- 拒绝：PreToolUse hook 输出 deny 后，工具结果里出现你的 `reason`，`decision=deny`；
- 解除后恢复：去掉拒绝条件再调用同一工具，`decision=none` 且工具正常执行。

### 斜杠命令

```text
/hello Alice
```

---

## 6. 一个最小插件

```text
my-plugin/
├── .claude-plugin/plugin.json
├── skills/hello/SKILL.md
├── commands/hello.md
└── hooks/dsh.json            # 或 hooks/hooks.json（二选一优先原生）
```

把目录放到 `pluginRoots` 下即可，不需要重启（清单按 mtime 热重载，命令按 `reloadIntervalMs`）。

---

## 7. 常见问题

**hook 没跑？**

1. `claude_plugin_hooks` 看该插件是否 `channel=none`、条目是否被 skipped；
2. 看 hook 日志文件是否有对应 `event` 行；
3. dsh 原生通道的 matcher 匹配的是**dsh 工具名**（`write`/`edit`/`pwsh`），Claude 通道匹配的是
   **Claude 工具名**（`Write`/`Edit`/`Bash`/`PowerShell`）；
4. SessionStart 类钩子若声明在 `agent/created` 上，只能拿到推断的 source（startup/resume）；
   需要 clear/compact 请声明 `agent/session-start`。

**`shell:"bash"` 的 hook 在 Windows 上失败？**

loader 会找 Git Bash（跳过 WSL 的 `System32\bash.exe`）。找不到时设 `bashPath`。

**Stop hook 只拦一次？**

设计如此（`maxStopBlocksPerTurn`，默认 1）：第一次拦下并 steer，同一 turn 再触发时 `stop_hook_active=true`。
需要多次可调大。

**为什么 desktop 只有 `agent/created`？**

不同宿主/版本发射的事件不同；loader 双事件都支持，见 3.6。

**怎样关闭热更新扫描 / hooks？**

```yaml
config:
  reloadIntervalMs: 0
  hooksEnabled: false      # 或只关一条通道：claudeHooks: false / dshHooks: false
```
