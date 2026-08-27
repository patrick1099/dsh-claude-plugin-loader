# dsh-claude-plugin-loader 使用说明

这个插件让 dsh 直接发现、加载 Claude Code 风格的插件（目录里带 `.claude-plugin/plugin.json`），把其中的 **skills** 和 **commands** 接入 dsh，并支持部分 **SessionStart hooks**。

---

## 1. 安装

推荐装进 web profile：

```bash
dsh plugin --profile web add dsh-claude-plugin-loader
```

也可以装到 CLI / TUI / headless：

```bash
dsh plugin --profile cc-tui add dsh-claude-plugin-loader
dsh plugin --profile headless add dsh-claude-plugin-loader
```

装完重启 dsh 生效。如果不想用 npm 包，可以手动把 `dsh-claude-plugin-loader.mjs` 放进 profile 目录，再在 `cordis.patch.yml` 里插入 loader 行（见 README）。

---

## 2. 它会去哪里找 Claude 插件

默认扫描：

```text
~/.claude/plugins/cache
```

这是 Claude Code 把插件市场插件下载/缓存的地方。只要插件目录里有：

```text
<plugin>/.claude-plugin/plugin.json
```

loader 就能发现它。

### 增加自定义扫描目录

在对应 profile 的 `cordis.patch.yml` 里覆盖：

```yaml
- id: claude-plugin-loader
  name: dsh-claude-plugin-loader
  config:
    pluginRoots:
      - "C:/path/to/shared/plugins"
      - "C:/Users/<you>/.claude/plugins/cache"
```

多个目录会按顺序扫描，前面的高优先级目录会覆盖同名插件。

### 只加载部分插件

不写 `enabledPlugins` 时会加载所有扫到的 Claude 插件。想限定一组时：

```yaml
- id: claude-plugin-loader
  name: dsh-claude-plugin-loader
  config:
    enabledPlugins:
      - "cjt"
      - "note-workflow"
```

---

## 3. 目前能加载什么 / 不能加载什么

### ✅ 已支持

| 通道 | 说明 |
|---|---|
| **skills** | 把插件 `skills/` 下的 `SKILL.md` 注册成 dsh skill，模型可用 skill 搜索/加载 |
| **commands** | 把插件 `commands/*.md` 注册成 dsh 斜杠命令，如 `/hello` |
| **SessionStart hooks** | 默认关闭；开启后执行插件 `hooks.json` 里的 `SessionStart` command hook 并把 stdout 注入上下文 |
| **热更新 / 卸载清理** | 插件命令新增/修改/移除时自动注册/更新/注销，不用重启 dsh |
| **状态工具** | `claude_plugin_status` 查看发现了哪些插件、有哪些通道 |

### ⏳ 尚未支持

- PreToolUse 拒绝 / 工具改写等其它 hook
- MCP 配置自动生成
- agents 通道
- 热更新之外的插件热装载（部分插件仍要重启）

---

## 4. 怎么验证已经加载成功

### Web / TUI

在聊天输入框输入：

```text
/ 
```

若命令来自插件（例如 `hello`），会出现在命令菜单里。

也可以直接让模型调用状态工具：

```text
调用 claude_plugin_status，并原样输出结果。
```

### headless

```bash
dsh --profile headless "调用 claude_plugin_status，并原样输出结果。"
```

### 用插件的斜杠命令

如果有一个测试命令 `hello`：

```text
/hello Alice
```

成功时会执行插件命令并把结果注入会话，而不是把 `/hello Alice` 当成普通文本发给模型。

---

## 5. 一个最小的 Claude 插件长什么样

```text
my-plugin/
├── .claude-plugin/
│   └── plugin.json
├── skills/
│   └── hello/
│       └── SKILL.md
└── commands/
    └── hello.md
```

`plugin.json`：

```json
{
  "name": "my-plugin",
  "version": "0.1.0",
  "description": "example"
}
```

`commands/hello.md`：

```markdown
---
name: hello
description: Say hello
argument-hint: [name]
---

Hello from my-plugin, $ARGUMENTS!
```

把 `my-plugin` 目录放到 `~/.claude/plugins/cache/` 下，重启 dsh 后 `/hello` 就会出现在命令菜单里。

---

## 6. 常见问题

**为什么 web / TUI 里看不到插件命令？**

- 确认插件目录里确实有 `commands/*.md` 且 frontmatter 有 `name`/`description`
- 确认插件在 `~/.claude/plugins/cache` 下，或在 `pluginRoots` 覆盖的目录里
- 如果配置了 `enabledPlugins`，确认插件名在列表里
- 重启 dsh / 刷新页面后再看

**为什么 `pluginRoots` 为空还能跑？**

默认会回退到 `~/.claude/plugins/cache`。如果这个目录不存在，loader 不会报错，只是扫不到插件。

**怎样关闭自动热更新扫描？**

```yaml
config:
  reloadIntervalMs: 0
```

**临时测试插件怎么删？**

```bash
rm -rf ~/.claude/plugins/cache/tmp-loader-test
```
