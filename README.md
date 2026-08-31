# dsh-claude-plugin-loader

dsh 运行时装载器的**最小原型**：让 dsh 直接发现并加载 Claude 式组合体插件（目录含 `.claude-plugin/plugin.json`）。

> 完整使用说明见 [GUIDE.md](GUIDE.md)：安装、扫描目录、配置、验证、常见问题。

当前已实现：

- 扫描插件源：默认扫 `~/.claude/plugins/cache`（Claude 插件缓存），可用 `pluginRoots` 配置额外根目录。
- 按插件名去重，活源优先，缓存内保留最高版本。
- 支持 `enabledPlugins` 配置：只暴露本机 `[plugins.dsh].enabled` 且 manifest 声明 `dsh` 的插件 skill。
- **skills 通道**：把每个插件的 `skills/` 注册成 dsh skill provider，模型可以用 dsh 原生 `skill` / `skill_search` 按名发现和加载插件里的 SKILL.md。
- 状态工具 `claude_plugin_status`：只读列出已发现插件及通道（skills/hooks/mcp/commands/agents）。
- **SessionStart hook 桥（最小，默认关闭）**：解析 `hooks.json` 里的 `SessionStart` command hook，在 `agent/session-start` 时执行并把 stdout 注入会话上下文。需要在配置里显式开 `sessionStartHooks: true`，避免自动执行有副作用的 hook。
- **commands 通道（注册 + 程序化执行已验证）**：把 Claude plugin `commands/*.md` 注册成 dsh 斜杠命令（`ctx.commands.register`），执行时把命令模板注入 agent。已通过 `claude_plugin_commands` 确认命令进入 `ctx.commands`，并用 `claude_plugin_run_command` 程序化执行 `/hello Alice` 成功。**Web 侧已验证**：loader 已装进 `web` profile，命令列表 `commands/list` 能看到 `hello`，`commands/execute /hello Alice` 返回 `kind=success`。**交互式 TUI 斜杠命令**：loader 已装进 `cc-tui` profile，本机 cache 里有 `tmp-loader-test` 测试插件；自动化 PTY 输入尚未稳定复现，请人工在 `dsh --profile cc-tui` 敲 `/hello Alice` 做最终确认。
- **commands 热更新 + 卸载清理**：loader 定时重扫插件根目录（默认 1500ms，可用 `reloadIntervalMs` 调），插件命令被新增/修改/移除时自动注册/更新/注销；插件从磁盘删除或从 `enabledPlugins` 消失后，对应斜杠命令也会被清理。

尚未实现（下一迭代）：

- PreToolUse 拒绝 / tool-rewrite 等其它 hook 意图，以及外部脚本协议桥的完整形态。
- MCP 配置生成（`mcpServers` → `@deepseek-ai/dsh-mcp-client` 配置行）。
- agents 通道。
- 第三方插件兼容边界记录。

## 测试

```bash
node --test dsh-claude-plugin-loader/test.mjs
```

覆盖：插件命令注册、插件移除后命令注销、命令模板变更后热更新。

## 安装（推荐：npm / dsh plugin）

```bash
# 装进 web 界面
dsh plugin --profile web add dsh-claude-plugin-loader

# 或装进 CLI/TUI profile
dsh plugin --profile cc-tui add dsh-claude-plugin-loader

# 或装进一次性 headless profile
dsh plugin --profile headless add dsh-claude-plugin-loader
```

重启对应 dsh 后生效。也可在 dshmarket 的 **Settings → Plugin Market** 里搜索安装（需要先收录到 awesome-dsh-plugin 仓库）。

默认扫描：

```text
~/.claude/plugins/cache
```

也就是 Claude Code 自己的插件缓存。没有配置 `pluginRoots` 时自动使用它；要额外扫别的目录，在 profile 的 `cordis.patch.yml` 里加配置即可：

```yaml
- id: claude-plugin-loader
  name: dsh-claude-plugin-loader
  config:
    pluginRoots:
      - "C:/path/to/shared/plugins"
      - "C:/Users/<you>/.claude/plugins/cache"
    # enabledPlugins:
    #   - "cjt"
    #   - "note-workflow"
    # reloadIntervalMs: 1500   # optional; 0 disables the background reload loop
```

## 手动安装（开发调试用）

把 `dsh-claude-plugin-loader.mjs` 放进目标 profile 目录（例如 `~/.dsh/profiles/headless/`），
然后在 `cordis.patch.yml` 插入：

```yaml
- insert:
    - id: claude-plugin-loader
      name: ./dsh-claude-plugin-loader.mjs
      config:
        pluginRoots:
          - "C:/path/to/shared/plugins"
          - "C:/Users/<you>/.claude/plugins/cache"
        enabledPlugins:
          - "cjt"
          - "note-workflow"
          - "repo-keeper"
          - "superpowers-manual"
          - "vibe-flow"
          - "projx-csb-skills"
          - "xu-skills"
        # reloadIntervalMs: 1500   # optional; 0 disables the background reload loop
```

验证：

```bash
dsh --profile headless --dump-config
dsh --profile headless "Call claude_plugin_status and repeat its output."
dsh --profile headless "Load the cjt skill."
```
