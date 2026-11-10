/**
 * dsh-claude-plugin-loader — Claude-style plugin loader for dsh.
 *
 * Channels implemented by this single-file plugin (node builtins only):
 *  - discovery: plugins = directories containing `.claude-plugin/plugin.json`
 *    under configured roots (priority + version aware);
 *  - skills: every plugin's `skills/` directory is exposed through a dsh skill
 *    provider (with an optional `enabledSkills` filter);
 *  - commands: `commands/*.md` become dsh slash commands (hot reload);
 *  - hooks (v0.2): both a DSH-native channel (`hooks/dsh.json`, the plugin
 *    declares real dsh event names and receives the dsh payload verbatim) and a
 *    Claude-compatible channel (`hooks/hooks.json`, the loader translates dsh
 *    events into Claude hook invocations, including a synthesized Claude-style
 *    `transcript_path`). A plugin with a usable `hooks/dsh.json` uses ONLY that
 *    channel; its `hooks/hooks.json` is not executed (channel priority).
 *  - read-only diagnostics: `claude_plugin_status`, `claude_plugin_commands`,
 *    `claude_plugin_hooks`, `claude_plugin_hook_selftest`.
 *
 * Real dsh event names used for the bridge (not the Claude lookalikes):
 *  - `agent/session-start` emit `{agent, source}` where source is one of
 *    `startup | resume | clear | compact` (this is the event carrying the
 *    SessionStart vocabulary; `agent/created` only carries `{agent}`);
 *  - `agent/inbox/inserted` emit `{agent, message}` (UserPromptSubmit);
 *  - `tools/pre-execute` waterfall `(exec, next)` -> allow | deny | ask;
 *  - `tools/post-execute` waterfall `(exec, result, next)` -> accept | block;
 *  - `agent/turn-stopping` serial `{agent, turn, signal}` — object by
 *    `agent.steer(message)` and the loop re-reads its inbox (Stop gate);
 *  - `agent/disposed` emit `{agent}` (SessionEnd).
 * `agent/created` is also accepted for DSH-native manifests (it only carries
 * `{agent}`), so a manifest that declares it keeps working.
 *
 * When installed as an npm/dsh plugin the bundle patch in cordis.patch.yml
 * references this package by name; pluginRoots defaults to the user's Claude
 * plugin cache (~/.claude/plugins/cache). A manual profile insert can still
 * point at the file directly:
 *
 *   - insert:
 *       - id: claude-plugin-loader
 *         name: ./dsh-claude-plugin-loader.mjs
 *         config:
 *           pluginRoots:
 *             - "C:/path/to/shared/plugins"
 *             - "C:/Users/<you>/.claude/plugins/cache"
 *           hooksEnabled: true
 *           claudeHooks: true
 *           dshHooks: true
 */

import { readFile, readdir, stat, writeFile, mkdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import os from 'node:os'
import { join, basename, resolve, dirname } from 'node:path'
import { randomUUID } from 'node:crypto'
import zlib from 'node:zlib'

export const name = 'dsh-claude-plugin-loader'

/** The agent, tools, skills, subprocess, and commands services must exist before registration. */
export const inject = ['skills', 'tools', 'subprocess', 'commands']

const MAX_SCAN_DEPTH = 8
const SKIP_DIRS = new Set(['node_modules', '.git', '.trash', '__pycache__', '.pytest_cache'])

/**
 * Parse a SKILL.md/command frontmatter block with only the YAML subset plugins
 * actually use: top-level `key: value` scalars, quoted scalars, inline JSON
 * scalars, and folded (`>`, `>-`, `>+`) / literal (`|`, `|-`, `|+`) block
 * scalars. A plain line parser is not enough: most real plugin SKILL.md files
 * describe themselves with a folded block, and dropping them silently loses
 * every skill of that plugin.
 */
function parseFrontmatter(raw) {
  if (typeof raw !== 'string') return null
  const text = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw
  if (!text.startsWith('---')) return null
  const end = text.indexOf('\n---', 3)
  if (end === -1) return null
  const block = text.slice(3, end)
  const lines = block.split(/\r?\n/)
  const data = {}
  for (let i = 0; i < lines.length; i += 1) {
    const m = lines[i].match(/^([A-Za-z_][\w-]*):[ \t]*([\s\S]*)$/)
    if (!m) continue
    const key = m[1]
    const rawValue = m[2].trim()
    const blockMatch = rawValue.match(/^([>|])([+-]?)[ \t]*(?:#.*)?$/)
    if (!blockMatch) {
      data[key] = rawValue.replace(/^["']|["']$/g, '').trim()
      continue
    }
    const style = blockMatch[1]
    const chomp = blockMatch[2]
    const body = []
    let j = i + 1
    for (; j < lines.length; j += 1) {
      const line = lines[j]
      if (line.trim() === '') {
        body.push('')
        continue
      }
      if (!/^[ \t]/.test(line)) break
      body.push(line)
    }
    while (body.length > 0 && body[0].trim() === '') body.shift()
    while (body.length > 0 && body[body.length - 1].trim() === '') body.pop()
    const indents = body.filter((line) => line.trim() !== '').map((line) => line.match(/^[ \t]*/)[0].length)
    const common = indents.length > 0 ? Math.min(...indents) : 0
    const stripped = body.map((line) => (line.trim() === '' ? '' : line.slice(common)))
    let joined
    if (style === '|') {
      joined = stripped.join('\n')
    } else {
      const out = []
      for (const line of stripped) {
        if (line === '') {
          out.push('\n')
          continue
        }
        if (out.length > 0 && !out[out.length - 1].endsWith('\n')) out.push(' ')
        out.push(line)
      }
      joined = out.join('')
    }
    if (chomp !== '+') joined = joined.replace(/\n+$/, '')
    data[key] = joined.trim()
    i = j - 1
  }
  return data
}

function isSkillName(name) {
  return typeof name === 'string' && /^[a-z0-9][a-z0-9_-]*$/i.test(name)
}

function parseInvocation(data) {
  const invocation = { modelInvocable: true, userInvocable: true }
  if (String(data['disable-model-invocation']).toLowerCase() === 'true') {
    invocation.modelInvocable = false
  }
  if (String(data['user-invocable']).toLowerCase() === 'false') {
    invocation.userInvocable = false
  }
  return invocation
}

async function isDir(path) {
  try {
    return (await stat(path)).isDirectory()
  } catch {
    return false
  }
}

async function isFile(path) {
  try {
    return (await stat(path)).isFile()
  } catch {
    return false
  }
}

async function findClaudePlugins(root, depth = 0) {
  if (depth > MAX_SCAN_DEPTH) return []
  const manifest = join(root, '.claude-plugin', 'plugin.json')
  if (await isFile(manifest)) {
    return [{ dir: resolve(root), name: basename(root) }]
  }
  if (!(await isDir(root))) return []
  const out = []
  let entries = []
  try {
    entries = await readdir(root, { withFileTypes: true })
  } catch {
    return out
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    if (SKIP_DIRS.has(entry.name)) continue
    out.push(...await findClaudePlugins(join(root, entry.name), depth + 1))
  }
  return out
}

async function readJsonIfExists(path) {
  if (!(await isFile(path))) return null
  try {
    return JSON.parse(await readFile(path, 'utf8'))
  } catch {
    return null
  }
}

async function scanPluginComponents(pluginDir, priority) {
  const manifest = await readJsonIfExists(join(pluginDir, '.claude-plugin', 'plugin.json'))
  const name = manifest?.name || basename(pluginDir)
  const skillsRoot = await isDir(join(pluginDir, 'skills')) ? join(pluginDir, 'skills') : null
  const hooksFile = await isFile(join(pluginDir, 'hooks', 'hooks.json'))
    ? join(pluginDir, 'hooks', 'hooks.json')
    : await isFile(join(pluginDir, '.claude-plugin', 'hooks.json'))
      ? join(pluginDir, '.claude-plugin', 'hooks.json')
      : null
  const commandsRoot = await isDir(join(pluginDir, 'commands'))
      ? join(pluginDir, 'commands')
      : await isDir(join(pluginDir, '.claude', 'commands'))
        ? join(pluginDir, '.claude', 'commands')
        : null
  const agentsRoot = await isDir(join(pluginDir, 'agents')) ? join(pluginDir, 'agents') : null
  const mcp = manifest?.mcpServers || manifest?.mcp || null
  return {
    dir: resolve(pluginDir),
    name,
    version: manifest?.version || null,
    description: manifest?.description || null,
    skillsRoot,
    hooksFile,
    commandsRoot,
    agentsRoot,
    mcp,
    manifest,
    priority,
  }
}

function versionNumber(version) {
  if (typeof version !== 'string') return -1
  const parts = version.split('.').map((s) => parseInt(s, 10) || 0)
  return parts[0] * 1000000 + (parts[1] || 0) * 1000 + (parts[2] || 0)
}

async function scanPlugins(roots, allowed = null) {
  const byName = new Map()
  for (let priority = 0; priority < roots.length; priority++) {
    const root = roots[priority]
    const found = await findClaudePlugins(root)
    for (const plugin of found) {
      const scanned = await scanPluginComponents(plugin.dir, priority)
      const key = scanned.name.toLowerCase()
      if (allowed !== null && !allowed.has(key)) continue
      const existing = byName.get(key)
      if (!existing) {
        byName.set(key, scanned)
        continue
      }
      // Prefer a higher-priority root (shared/plugins should beat cache).
      if (existing.priority < scanned.priority) continue
      if (existing.priority > scanned.priority) {
        byName.set(key, scanned)
        continue
      }
      // Same root: keep the higher version.
      if (versionNumber(scanned.version) > versionNumber(existing.version)) {
        byName.set(key, scanned)
      }
    }
  }
  return [...byName.values()]
}

async function listSkillsFromPlugin(plugin) {
  if (!plugin.skillsRoot) return []
  const entries = await readdir(plugin.skillsRoot, { withFileTypes: true })
  const candidates = []
  for (const entry of entries) {
    let skillPath = null
    let directory = null
    if (entry.isDirectory()) {
      const candidatePath = join(plugin.skillsRoot, entry.name, 'SKILL.md')
      if (await isFile(candidatePath)) {
        skillPath = candidatePath
        directory = join(plugin.skillsRoot, entry.name)
      }
    } else if (entry.isFile() && entry.name.endsWith('.md')) {
      skillPath = join(plugin.skillsRoot, entry.name)
      directory = plugin.skillsRoot
    }
    if (!skillPath) continue
    const raw = await readFile(skillPath, 'utf8')
    const meta = parseFrontmatter(raw)
    if (!meta || !isSkillName(meta.name) || !meta.description) continue
    candidates.push({
      name: meta.name,
      description: meta.description,
      ...(meta['when-to-use'] !== undefined ? { whenToUse: meta['when-to-use'] } : {}),
      invocation: parseInvocation(meta),
      provider: 'claude-plugin-loader',
      source: `plugin:${plugin.name}`,
      rank: 300,
      locator: { path: skillPath, directory },
      resourceBase: { kind: 'directory', path: directory },
      path: skillPath,
      metadata: { plugin: plugin.name, pluginVersion: plugin.version, pluginRoot: plugin.dir },
    })
  }
  return candidates
}

async function listCommandsFromPlugin(plugin) {
  if (!plugin.commandsRoot) return []
  const entries = await readdir(plugin.commandsRoot, { withFileTypes: true })
  const out = []
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.md')) continue
    const raw = await readFile(join(plugin.commandsRoot, entry.name), 'utf8')
    const meta = parseFrontmatter(raw)
    const name = (meta?.name || entry.name.replace(/\.md$/, '')).toLowerCase()
    if (!isSkillName(name) || !meta?.description) continue
    out.push({
      name,
      description: meta.description,
      hint: meta['argument-hint'] || undefined,
      template: expandClaudePluginRoot(raw.replace(/^---[\s\S]*?---\s*/, '').trim(), plugin.dir),
      plugin: plugin.name,
    })
  }
  return out
}

const commandRegistrations = new Map()

function commandKey(pluginName, commandName) {
  return `${pluginName}\0${commandName}`
}

function sameCommand(left, right) {
  return left.name === right.name
    && left.description === right.description
    && left.hint === right.hint
    && left.template === right.template
    && left.plugin === right.plugin
}

function buildCommandDefinition(command) {
  return {
    name: command.name,
    description: command.description,
    ...(command.hint ? { input: { hint: command.hint } } : {}),
    handler: async (invocation) => {
      const prompt = command.template
        .replace(/\$ARGUMENTS/g, invocation.rawInput.trim())
        .replace(/\$1/g, invocation.rawInput.trim())
      const message = {
        id: `claude-command-${command.name}-${Date.now()}`,
        role: 'user',
        content: [{ type: 'text', text: prompt }],
        source: { kind: 'plugin', plugin: command.plugin, form: 'command' },
      }
      if (typeof invocation.agent?.followup === 'function') {
        invocation.agent.followup(message)
      } else if (typeof invocation.agent?.inject === 'function') {
        invocation.agent.inject(message)
      } else {
        return { kind: 'error', text: `无法在当前 dsh 环境调度 /${command.name}` }
      }
      return { kind: 'success', text: `已执行 /${command.name}` }
    },
  }
}

function disposeCommand(registration) {
  if (!registration?.disposer) return
  try {
    registration.disposer()
  } catch (error) {
    // A failed disposer should never break the reload loop; the stale entry is
    // dropped from our map either way so we do not retry it forever.
  }
}

/** Reconcile plugin slash commands against the current plugin inventory. */
async function syncPluginCommands(ctx, plugins) {
  if (!ctx.commands?.register) return

  const desired = new Map()
  for (const plugin of plugins) {
    const commands = await listCommandsFromPlugin(plugin)
    for (const command of commands) {
      desired.set(commandKey(plugin.name, command.name), command)
    }
  }

  // Uninstall cleanup: drop commands whose plugin is no longer discovered or
  // no longer enabled.
  for (const [key, registration] of commandRegistrations) {
    if (!desired.has(key)) {
      disposeCommand(registration)
      commandRegistrations.delete(key)
    }
  }

  // Hot reload: add new commands and replace edited ones.
  for (const [key, command] of desired) {
    const existing = commandRegistrations.get(key)
    if (!existing) {
      try {
        const disposer = ctx.commands.register(buildCommandDefinition(command))
        commandRegistrations.set(key, { disposer, command })
      } catch (error) {
        ctx.logger?.warn?.(`${name}: 注册 /${command.name} 失败: ${String(error)}`)
      }
    } else if (!sameCommand(existing.command, command)) {
      disposeCommand(existing)
      try {
        const disposer = ctx.commands.register(buildCommandDefinition(command))
        commandRegistrations.set(key, { disposer, command })
      } catch (error) {
        ctx.logger?.warn?.(`${name}: 重载 /${command.name} 失败: ${String(error)}`)
        commandRegistrations.delete(key)
      }
    }
  }
}

// Small shim kept for callers/tests that used the old one-shot name.
async function registerPluginCommands(ctx, plugins) {
  await syncPluginCommands(ctx, plugins)
}

function startCommandReload(ctx, pluginRoots, enabledPlugins, config = {}) {
  const interval = Number.isFinite(config.reloadIntervalMs) ? config.reloadIntervalMs : 1500
  if (!(interval > 0) || typeof setInterval !== 'function') return
  const timer = setInterval(async () => {
    try {
      const plugins = await scanPlugins(pluginRoots, enabledPlugins)
      await syncPluginCommands(ctx, plugins)
    } catch (error) {
      ctx.logger?.warn?.(`${name}: 热更新扫描失败: ${String((error && error.message) || error)}`)
    }
  }, interval)
  if (typeof timer.unref === 'function') timer.unref()
}

function extractSkillBody(skill) {
  const content = skill?.content ?? skill?.instructions ?? skill?.body
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content.map((part) => typeof part === 'string' ? part : JSON.stringify(part)).join('\n')
  }
  return ''
}

function expandClaudePluginRoot(text, pluginRoot) {
  if (typeof text !== 'string' || typeof pluginRoot !== 'string' || pluginRoot.length === 0) {
    return text
  }
  return text
    .replace(/\$\{CLAUDE_PLUGIN_ROOT\}/g, pluginRoot)
    .replace(/\$CLAUDE_PLUGIN_ROOT/g, pluginRoot)
}

// ===========================================================================
// hooks bridge (v0.2)
// ===========================================================================

/** Claude hook event -> real dsh event. */
export const CLAUDE_TO_DSH_EVENT = {
  SessionStart: 'agent/session-start',
  UserPromptSubmit: 'agent/inbox/inserted',
  PreToolUse: 'tools/pre-execute',
  PostToolUse: 'tools/post-execute',
  Stop: 'agent/turn-stopping',
  SessionEnd: 'agent/disposed',
}

const DSH_TO_CLAUDE_EVENT = Object.fromEntries(
  Object.entries(CLAUDE_TO_DSH_EVENT).map(([claudeEvent, dshEvent]) => [dshEvent, claudeEvent]),
)

/**
 * DSH-native event names accepted in `hooks/dsh.json`. `agent/created` is
 * accepted for compatibility, but it carries only `{agent}`; a manifest that
 * needs the SessionStart `source` vocabulary must declare
 * `agent/session-start`.
 */
export const DSH_HOOK_EVENTS = new Set([
  'agent/created',
  'agent/session-start',
  'agent/inbox/inserted',
  'tools/pre-execute',
  'tools/post-execute',
  'agent/turn-stopping',
  'agent/disposed',
])

/** Tool-argument/tool-name vocabulary dsh already shares with Claude Code. */
export const DSH_TO_CLAUDE_TOOL = {
  read: 'Read',
  read_image: 'Read',
  write: 'Write',
  edit: 'Edit',
  multi_edit: 'MultiEdit',
  str_replace_editor: 'Edit',
  glob: 'Glob',
  grep: 'Grep',
  ls: 'LS',
  bash: 'Bash',
  pwsh: 'PowerShell',
  powershell: 'PowerShell',
  subagent: 'Task',
  subagent_fork: 'Task',
  todo_write: 'TodoWrite',
  web_search: 'WebSearch',
  web_fetch: 'WebFetch',
  ask_user_question: 'AskUserQuestion',
}

const SHELL_TOOLS = new Set(['bash', 'pwsh', 'powershell'])

/** Default per-hook timeout. Claude's own default is 60s; config overrides it. */
const DEFAULT_HOOK_TIMEOUT_MS = 60000
const MAX_HOOK_TIMEOUT_MS = 600000
/** Output kept per stream from one hook process. */
const HOOK_OUTPUT_MAX_BYTES = 65536
/** Ring-buffer size for the diagnostics tools. */
const LAST_RUN_LIMIT = 40
/** TTL for the plugin inventory while hooks fire on every tool call. */
const DEFAULT_PLUGIN_CACHE_TTL_MS = 1500

/**
 * Normalize the loader's hook configuration once at apply() time.
 * @param {object} config loader config from cordis.patch.yml
 */
export function normalizeHookConfig(config = {}) {
  const timeout = Number.isFinite(config.hookTimeoutMs) && config.hookTimeoutMs > 0
    ? Math.min(Math.max(1, Math.floor(config.hookTimeoutMs)), MAX_HOOK_TIMEOUT_MS)
    : DEFAULT_HOOK_TIMEOUT_MS
  return {
    hooksEnabled: config.hooksEnabled !== false,
    claudeHooks: config.claudeHooks !== false,
    dshHooks: config.dshHooks !== false,
    sessionStartHooks: config.sessionStartHooks !== false,
    failClosed: config.failClosed === true,
    stopOnFirstBlock: config.stopOnFirstBlock !== false,
    maxStopBlocksPerTurn: Number.isFinite(config.maxStopBlocksPerTurn) && config.maxStopBlocksPerTurn >= 1
      ? Math.floor(config.maxStopBlocksPerTurn)
      : 1,
    defaultTimeoutMs: timeout,
    transcript: config.transcript === 'off' ? 'off' : 'auto',
    sessionRoot: typeof config.sessionRoot === 'string' && config.sessionRoot.length > 0
      ? resolve(String(config.sessionRoot))
      : join(dshHome(), 'sessions'),
    claudeToolNames: config.claudeToolNames && typeof config.claudeToolNames === 'object'
      ? { ...config.claudeToolNames }
      : {},
    bashPath: typeof config.bashPath === 'string' && config.bashPath.length > 0 ? String(config.bashPath) : null,
    powerShellPath: typeof config.powerShellPath === 'string' && config.powerShellPath.length > 0 ? String(config.powerShellPath) : null,
    startupGraceMs: Number.isFinite(config.startupGraceMs) && config.startupGraceMs >= 0
      ? Math.min(Math.max(0, Math.floor(config.startupGraceMs)), 10000)
      : 300,
    hookLog: config.hookLog !== false,
    hookLogPath: typeof config.hookLogPath === 'string' && config.hookLogPath.length > 0
      ? resolve(String(config.hookLogPath))
      : null,
    hookLogMaxBytes: Number.isFinite(config.hookLogMaxBytes) && config.hookLogMaxBytes >= 4096
      ? Math.floor(config.hookLogMaxBytes)
      : 262144,
  }
}

function dshHome() {
  const raw = process.env.DSH_HOME
  if (typeof raw === 'string' && raw.length > 0) return resolve(raw)
  return join(os.homedir(), '.dsh')
}

function containsValue(haystack, needles) {
  const text = String(haystack ?? '')
  return needles.some((needle) => text.includes(needle))
}

/**
 * Expand the plugin-root placeholders Claude plugins use inside hook commands.
 * Only the plugin's own directory is ever substituted; no other path is
 * injected into the command or the child environment.
 */
export function buildHookCommand(entry, pluginDir, platform = process.platform) {
  const raw = platform === 'win32' && entry?.commandWindows ? entry.commandWindows : entry?.command
  const command = String(raw ?? '')
  const env = { PLUGIN_ROOT: pluginDir, CLAUDE_PLUGIN_ROOT: pluginDir }
  let out = command
  for (const [key, value] of Object.entries(env)) {
    out = out.split(`\${${key}}`).join(value)
    out = out.split(`$${key}`).join(value)
    out = out.split(`%${key}%`).join(value)
  }
  return out
}

/** Shell metacharacters that force a real shell instead of a direct argv spawn. */
const SHELL_META = /[|&;<>()$`*?[\]{}~#\r\n]/

/**
 * Minimal POSIX-ish word splitter for the common `interp "path" arg` hook
 * command. Quoted segments stay one word; Windows paths keep their backslashes.
 */
export function splitHookCommand(command) {
  const words = []
  let current = ''
  let started = false
  let single = false
  let double = false
  const text = String(command ?? '')
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (single) {
      if (ch === "'") single = false
      else current += ch
      continue
    }
    if (double) {
      if (ch === '\\' && (text[i + 1] === '"' || text[i + 1] === '\\')) {
        current += text[i + 1]
        i += 1
        continue
      }
      if (ch === '"') double = false
      else current += ch
      continue
    }
    if (ch === "'") {
      single = true
      started = true
      continue
    }
    if (ch === '"') {
      double = true
      started = true
      continue
    }
    if (/\s/.test(ch)) {
      if (started) {
        words.push(current)
        current = ''
        started = false
      }
      continue
    }
    current += ch
    started = true
  }
  if (started) words.push(current)
  return words
}

/** Locate a real Bash. Skips WSL's System32 bash.exe, which cannot see Windows tools. */
export function resolveBashPath(config = {}) {
  if (typeof config.bashPath === 'string' && existsSync(config.bashPath)) return config.bashPath
  const candidates = [
    'D:/Software/Git/bin/bash.exe',
    'C:/Program Files/Git/bin/bash.exe',
    'C:/Program Files/Git/usr/bin/bash.exe',
    'C:/Program Files (x86)/Git/bin/bash.exe',
  ]
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate
  }
  const pathValue = String(process.env.PATH ?? '')
  for (const dir of pathValue.split(';')) {
    if (!dir) continue
    if (/[\\/]System32/i.test(dir)) continue
    const candidate = join(dir, 'bash.exe')
    try {
      if (existsSync(candidate)) return candidate
    } catch {
      // Keep scanning.
    }
  }
  return null
}

/**
 * Build the intercepting process for one hook command.
 *
 * Windows cmd.exe mangles a quoted command handed to it as a single argv
 * element (Node quotes/escapes it again), so a plain `interp "path" args`
 * command is spawned directly. Shell syntax (`|`, `;`, `$()`, `if`, ...) goes
 * through PowerShell, and `shell: "bash"` hooks go through a real Git Bash.
 */
export function buildHookArgv(entry, command, config = {}, platform = process.platform) {
  if (platform !== 'win32') {
    if (entry?.shell === 'bash') return { argv: ['/bin/bash', '-c', command], error: null }
    return { argv: ['/bin/sh', '-c', command], error: null }
  }
  if (entry?.shell === 'bash') {
    const bash = resolveBashPath(config)
    if (!bash) return { argv: null, error: 'hook 声明 shell:"bash" 但未找到 Git Bash（可用 config.bashPath 指定）' }
    return { argv: [bash, '-c', command], error: null }
  }
  if (SHELL_META.test(command)) {
    const powershell = typeof config.powerShellPath === 'string' && config.powerShellPath.length > 0
      ? config.powerShellPath
      : 'powershell.exe'
    return { argv: [powershell, '-NoProfile', '-NonInteractive', '-Command', command], error: null }
  }
  const words = splitHookCommand(command)
  if (words.length === 0) return { argv: null, error: 'hook command 为空' }
  return { argv: words, error: null }
}

/** Claude-compatible tool name for one dsh tool name. */
export function claudeToolNameFor(dshName, overrides = {}) {
  const raw = String(dshName ?? '')
  if (Object.prototype.hasOwnProperty.call(overrides, raw)) return String(overrides[raw])
  return DSH_TO_CLAUDE_TOOL[raw] ?? raw
}

/**
 * Match a Claude/Dsh hook matcher (a regular expression) against a subject.
 * An absent or empty matcher matches everything; an invalid regex matches
 * nothing and is reported so the caller can warn.
 */
export function matchHookMatcher(matcher, subject) {
  if (matcher === undefined || matcher === null || matcher === '') return true
  if (matcher === '*') return true
  try {
    return new RegExp(String(matcher)).test(String(subject ?? ''))
  } catch {
    return false
  }
}

function matcherIsValid(matcher) {
  if (matcher === undefined || matcher === null || matcher === '' || matcher === '*') return true
  try {
    new RegExp(String(matcher))
    return true
  } catch {
    return false
  }
}

function hookEntryFromRaw(raw, base) {
  if (!raw || typeof raw !== 'object') return null
  if (raw.type !== 'command') return null
  const command = typeof raw.command === 'string' ? raw.command.trim() : ''
  if (command.length === 0) return null
  return {
    ...base,
    command,
    commandWindows: typeof raw.commandWindows === 'string' && raw.commandWindows.trim().length > 0
      ? raw.commandWindows.trim()
      : null,
    timeoutMs: Number.isFinite(Number(raw.timeout)) && Number(raw.timeout) > 0
      ? Math.min(Math.max(1, Math.floor(Number(raw.timeout) * 1000)), MAX_HOOK_TIMEOUT_MS)
      : (Number.isFinite(Number(raw.timeoutMs)) && Number(raw.timeoutMs) > 0
        ? Math.min(Math.max(1, Math.floor(Number(raw.timeoutMs))), MAX_HOOK_TIMEOUT_MS)
        : null),
    shell: typeof raw.shell === 'string' && raw.shell.toLowerCase() === 'bash' ? 'bash' : null,
  }
}

/**
 * Parse the DSH-native manifest (`hooks/dsh.json`):
 * `{description?, hooks: {<dsh event name>: [{matcher?, hooks: [{type:'command',...}]}]}}`.
 * Only `command` hooks are kept; everything else is reported as skipped.
 */
export function normalizeDshManifest(doc, file) {
  const out = { channel: 'dsh', file, valid: false, events: [], entries: [], skipped: [], errors: [] }
  const hooks = doc && typeof doc === 'object' ? doc.hooks : null
  if (!hooks || typeof hooks !== 'object' || Array.isArray(hooks)) {
    out.errors.push('hooks/dsh.json 缺少 hooks 对象')
    return out
  }
  for (const [eventName, groups] of Object.entries(hooks)) {
    if (!DSH_HOOK_EVENTS.has(eventName)) {
      out.skipped.push({ event: eventName, reason: `unknown dsh event "${eventName}"` })
      continue
    }
    if (!Array.isArray(groups)) {
      out.skipped.push({ event: eventName, reason: 'group list is not an array' })
      continue
    }
    let eventCount = 0
    for (const group of groups) {
      if (!group || typeof group !== 'object') continue
      const matcher = typeof group.matcher === 'string' ? group.matcher : undefined
      if (!matcherIsValid(matcher)) {
        out.skipped.push({ event: eventName, reason: `invalid matcher regex ${JSON.stringify(matcher)}` })
        continue
      }
      const list = Array.isArray(group.hooks) ? group.hooks : []
      for (const raw of list) {
        const entry = hookEntryFromRaw(raw, {
          channel: 'dsh',
          file,
          event: eventName,
          claudeEvent: DSH_TO_CLAUDE_EVENT[eventName] ?? null,
          matcher,
        })
        if (!entry) {
          out.skipped.push({ event: eventName, reason: `unsupported hook type ${JSON.stringify(raw?.type)}` })
          continue
        }
        out.entries.push(entry)
        eventCount += 1
      }
    }
    if (eventCount > 0) out.events.push(eventName)
  }
  out.valid = out.entries.length > 0
  return out
}

/**
 * Parse the Claude-compatible manifest (`hooks/hooks.json`):
 * `{hooks: {ClaudeEventName: [{matcher?, hooks: [{type:'command',...}]}]}}`.
 */
export function normalizeClaudeManifest(doc, file) {
  const out = { channel: 'claude', file, valid: false, events: [], entries: [], skipped: [], errors: [] }
  const hooks = doc && typeof doc === 'object' ? doc.hooks : null
  if (!hooks || typeof hooks !== 'object' || Array.isArray(hooks)) {
    out.errors.push('hooks/hooks.json 缺少 hooks 对象')
    return out
  }
  for (const [claudeEvent, groups] of Object.entries(hooks)) {
    const dshEvent = CLAUDE_TO_DSH_EVENT[claudeEvent]
    if (!dshEvent) {
      out.skipped.push({ event: claudeEvent, reason: `unsupported Claude hook event "${claudeEvent}"` })
      continue
    }
    if (!Array.isArray(groups)) {
      out.skipped.push({ event: claudeEvent, reason: 'group list is not an array' })
      continue
    }
    let eventCount = 0
    for (const group of groups) {
      if (!group || typeof group !== 'object') continue
      const matcher = typeof group.matcher === 'string' ? group.matcher : undefined
      if (!matcherIsValid(matcher)) {
        out.skipped.push({ event: claudeEvent, reason: `invalid matcher regex ${JSON.stringify(matcher)}` })
        continue
      }
      const list = Array.isArray(group.hooks) ? group.hooks : []
      for (const raw of list) {
        const entry = hookEntryFromRaw(raw, {
          channel: 'claude',
          file,
          event: dshEvent,
          claudeEvent,
          matcher,
        })
        if (!entry) {
          out.skipped.push({ event: claudeEvent, reason: `unsupported hook type ${JSON.stringify(raw?.type)}` })
          continue
        }
        out.entries.push(entry)
        eventCount += 1
      }
    }
    if (eventCount > 0) out.events.push(dshEvent)
  }
  out.valid = out.entries.length > 0
  return out
}

/** In-memory manifest cache keyed by file path: mtime+size means hot reload. */
const hookManifestCache = new Map()

async function readManifestDoc(path) {
  let info
  try {
    info = await stat(path)
  } catch {
    hookManifestCache.delete(path)
    return null
  }
  if (!info.isFile()) return null
  const cached = hookManifestCache.get(path)
  if (cached && cached.mtimeMs === info.mtimeMs && cached.size === info.size) {
    return { doc: cached.doc, mtimeMs: cached.mtimeMs, error: cached.error }
  }
  let doc = null
  let error = null
  try {
    doc = JSON.parse(await readFile(path, 'utf8'))
  } catch (err) {
    error = String((err && err.message) || err)
  }
  hookManifestCache.set(path, { mtimeMs: info.mtimeMs, size: info.size, doc, error })
  return { doc, mtimeMs: info.mtimeMs, error }
}

/**
 * Load the effective hook manifest for one plugin and pick its channel.
 * Priority (contract): a usable `hooks/dsh.json` means DSH-native only; the
 * plugin's `hooks/hooks.json` is then NOT executed.
 */
export async function loadPluginHooks(plugin, config) {
  const dshFile = join(plugin.dir, 'hooks', 'dsh.json')
  const claudeCandidates = [
    join(plugin.dir, 'hooks', 'hooks.json'),
    join(plugin.dir, '.claude-plugin', 'hooks.json'),
  ]
  const result = {
    channel: null,
    file: null,
    mtimeMs: null,
    entries: [],
    skipped: [],
    warnings: [],
    claudeFile: null,
    claudeFileIgnored: false,
  }

  if (config.dshHooks) {
    const dsh = await readManifestDoc(dshFile)
    if (dsh) {
      if (dsh.error) {
        result.warnings.push(`hooks/dsh.json 解析失败: ${dsh.error}`)
      } else {
        const parsed = normalizeDshManifest(dsh.doc, dshFile)
        result.skipped.push(...parsed.skipped)
        if (parsed.valid) {
          result.channel = 'dsh'
          result.file = dshFile
          result.mtimeMs = dsh.mtimeMs
          result.entries = parsed.entries
          // Channel priority: the Claude manifest stays recorded but inert.
          for (const candidate of claudeCandidates) {
            const info = await readManifestDoc(candidate)
            if (info) {
              result.claudeFile = candidate
              result.claudeFileIgnored = true
              break
            }
          }
          return result
        }
        result.warnings.push('hooks/dsh.json 存在但没有可执行的 command 条目，回退 Claude 兼容通道')
      }
    }
  }

  if (config.claudeHooks) {
    for (const candidate of claudeCandidates) {
      const claude = await readManifestDoc(candidate)
      if (!claude) continue
      result.claudeFile = candidate
      if (claude.error) {
        result.warnings.push(`${basename(candidate)} 解析失败: ${claude.error}`)
        continue
      }
      const parsed = normalizeClaudeManifest(claude.doc, candidate)
      result.skipped.push(...parsed.skipped)
      if (parsed.valid) {
        result.channel = 'claude'
        result.file = candidate
        result.mtimeMs = claude.mtimeMs
        result.entries = parsed.entries
      } else {
        result.warnings.push(`${basename(candidate)} 没有可执行的 command 条目`)
      }
      break
    }
  }

  return result
}

/** One hook process result. */
function hookOutcomeId() {
  return `hook-${randomUUID().slice(0, 8)}`
}

/**
 * Parse the shared hook output protocol.
 *  - exit code 2 -> block (stderr/stdout becomes the reason);
 *  - exit code non-zero otherwise -> non-blocking error;
 *  - stdout JSON: Claude's `{"decision":"block"...}`,
 *    `{"hookSpecificOutput":{...}}`, `{"systemMessage"}`, `{"continue":false}`;
 *  - plain text stdout counts as context for SessionStart/UserPromptSubmit.
 */
export function parseHookOutput({ stdout, stderr, exitCode, eventName, channel }) {
  const out = String(stdout ?? '')
  const err = String(stderr ?? '')
  const result = {
    exitCode: Number.isInteger(exitCode) ? exitCode : null,
    mode: 'none',
    block: false,
    allow: false,
    ask: false,
    continueFalse: false,
    reason: '',
    contexts: [],
    systemMessage: '',
    raw: out.slice(0, 4000),
    stderr: err.slice(0, 4000),
    error: false,
  }
  if (result.exitCode === 2) {
    result.block = true
    result.mode = 'exit2'
    result.reason = (err.trim() || out.trim())
    return result
  }
  if (result.exitCode !== 0) {
    result.mode = 'error'
    result.error = true
    return result
  }
  const trimmed = out.trim()
  if (trimmed.length === 0) return result

  let doc = null
  try {
    doc = JSON.parse(trimmed)
  } catch {
    doc = null
  }

  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) {
    if (eventName === 'SessionStart' || eventName === 'UserPromptSubmit') {
      result.contexts.push(trimmed)
    }
    result.mode = 'text'
    return result
  }

  if (doc.continue === false) result.continueFalse = true
  if (typeof doc.systemMessage === 'string' && doc.systemMessage.trim().length > 0) {
    result.systemMessage = doc.systemMessage.trim()
  }
  const specific = doc.hookSpecificOutput
  if (specific && typeof specific === 'object') {
    if (typeof specific.additionalContext === 'string' && specific.additionalContext.trim().length > 0) {
      result.contexts.push(specific.additionalContext.trim())
    }
    if (eventName === 'PreToolUse' && typeof specific.permissionDecision === 'string') {
      const decision = specific.permissionDecision
      if (decision === 'deny') {
        result.block = true
        result.mode = 'permission-deny'
        result.reason = String(specific.permissionDecisionReason ?? '')
      } else if (decision === 'ask') {
        result.ask = true
        result.mode = 'permission-ask'
        result.reason = String(specific.permissionDecisionReason ?? '')
      } else if (decision === 'allow') {
        result.allow = true
        result.mode = 'permission-allow'
      }
    }
  }
  if (doc.decision === 'block') {
    result.block = true
    result.mode = result.mode === 'none' ? 'decision-block' : result.mode
    result.reason = String(doc.reason ?? result.reason ?? '')
  } else if (doc.decision === 'approve' || doc.decision === 'allow') {
    result.allow = true
    result.mode = result.mode === 'none' ? 'decision-approve' : result.mode
  }
  if (result.reason.length === 0 && typeof doc.reason === 'string') result.reason = doc.reason
  return result
}

/** Aggregate several PreToolUse hook outcomes into one dsh PreToolDecision. */
export function aggregatePreToolOutcomes(outcomes) {
  const denied = outcomes.find((outcome) => outcome.parsed?.block)
  if (denied) {
    const reason = denied.parsed.reason || `hook ${basename(denied.command ?? '')} 拒绝了该调用`
    return { kind: 'deny', reason }
  }
  const stopRequested = outcomes.find((outcome) => outcome.parsed?.continueFalse)
  if (stopRequested) {
    return { kind: 'deny', reason: stopRequested.parsed.reason || 'host hook 请求停止（continue:false）' }
  }
  const asked = outcomes.find((outcome) => outcome.parsed?.ask)
  if (asked) {
    return { kind: 'ask', reason: asked.parsed.reason || undefined }
  }
  return { kind: 'allow' }
}

/** Aggregate PostToolUse hook outcomes into a PostToolDecision or null (= next()). */
export function aggregatePostToolOutcomes(outcomes) {
  const blocked = outcomes.find((outcome) => outcome.parsed?.block)
  if (blocked) {
    const reason = blocked.parsed.reason || 'host hook 阻断了该结果'
    return { kind: 'block', feedback: [{ type: 'text', text: reason }] }
  }
  const contexts = outcomes.flatMap((outcome) => outcome.parsed?.contexts ?? [])
  if (contexts.length > 0) return { kind: 'contexts', contexts }
  return null
}

/** Synthetic canonical event used by the selftest tool. */
export function makeSyntheticCanonicalEvent(eventName, overrides = {}) {
  const claudeEvent = DSH_TO_CLAUDE_EVENT[eventName] ?? eventName
  return {
    event: eventName,
    claudeEvent,
    agent: null,
    sessionId: `selftest-${randomUUID()}`,
    cwd: overrides.cwd ?? process.cwd(),
    pluginName: overrides.pluginName ?? 'selftest',
    pluginDir: overrides.pluginDir ?? process.cwd(),
    prompt: overrides.prompt ?? 'claude loader hook selftest',
    source: overrides.source ?? 'startup',
    stopHookActive: overrides.stopHookActive === true,
    toolName: overrides.toolName ?? 'write',
    toolInput: overrides.toolInput ?? {
      file_path: join(os.tmpdir(), 'dsh-claude-plugin-loader-selftest.txt'),
      content: 'selftest\n',
    },
    toolUseId: overrides.toolUseId ?? `toolu_selftest_${randomUUID().slice(0, 8)}`,
    toolResponse: overrides.toolResponse ?? { is_error: false, content: [{ type: 'text', text: 'selftest result' }], value: { ok: true } },
    reason: overrides.reason ?? 'other',
    dsh: overrides.dsh ?? { session_log: null, turn: null, step: null },
    transcriptPath: overrides.transcriptPath ?? null,
  }
}

function toolResponseJson(toolResponse) {
  if (!toolResponse) return null
  const content = Array.isArray(toolResponse.content) ? toolResponse.content : []
  const text = content
    .map((block) => (block && block.type === 'text' && typeof block.text === 'string' ? block.text : ''))
    .filter((part) => part.length > 0)
    .join('\n')
  const value = toolResponse.value === undefined ? null : toolResponse.value
  return {
    is_error: toolResponse.is_error === true,
    content: text,
    value,
  }
}

/**
 * Build the stdin payload for a DSH-native hook: the plugin's declared dsh event
 * receives a dsh-shaped payload (real dsh tool names, `dsh` runtime facts).
 */
export function buildDshStdin(canonical, plugin) {
  return {
    hook_event_name: canonical.event,
    session_id: canonical.sessionId,
    cwd: canonical.cwd,
    plugin_root: plugin?.dir ?? canonical.pluginDir,
    tool_name: canonical.toolName ?? '',
    tool_input: canonical.toolInput ?? {},
    tool_use_id: canonical.toolUseId ?? '',
    tool_response: toolResponseJson(canonical.toolResponse),
    prompt: canonical.prompt ?? '',
    source: canonical.source ?? '',
    stop_hook_active: canonical.stopHookActive === true,
    reason: canonical.reason ?? '',
    dsh: {
      session_log: canonical.dsh?.session_log ?? null,
      turn: canonical.dsh?.turn ?? null,
      step: canonical.dsh?.step ?? null,
    },
  }
}

/**
 * Build the stdin payload for a Claude-compatible hook: Claude vocabulary
 * (`tool_name` is a Claude name, `transcript_path` is a synthesized Claude
 * transcript), plus `DSH_*`/`PLUGIN_ROOT` identifiers in the environment.
 */
export function buildClaudeStdin(canonical, entry, config) {
  const claudeTool = claudeToolNameFor(canonical.toolName, config?.claudeToolNames ?? {})
  return {
    session_id: canonical.sessionId,
    transcript_path: canonical.transcriptPath ?? '',
    cwd: canonical.cwd,
    hook_event_name: entry?.claudeEvent ?? canonical.claudeEvent,
    tool_name: canonical.toolName ? claudeTool : '',
    tool_input: canonical.toolInput ?? {},
    tool_use_id: canonical.toolUseId ?? '',
    tool_response: toolResponseJson(canonical.toolResponse),
    prompt: canonical.prompt ?? '',
    source: canonical.source ?? '',
    stop_hook_active: canonical.stopHookActive === true,
    ...(canonical.event === 'agent/disposed' ? { reason: canonical.reason ?? 'other' } : {}),
    ...(canonical.event === 'agent/turn-stopping' && typeof canonical.stopReason === 'string'
      ? { stop_reason: canonical.stopReason }
      : {}),
  }
}

function claudeToolInput(canonical, entry, config) {
  if (!canonical.toolName) return canonical.toolInput ?? {}
  const claudeTool = claudeToolNameFor(canonical.toolName, config?.claudeToolNames ?? {})
  const input = canonical.toolInput && typeof canonical.toolInput === 'object' ? { ...canonical.toolInput } : {}
  if (SHELL_TOOLS.has(canonical.toolName) && input.command === undefined && typeof input.cmd === 'string') {
    input.command = input.cmd
  }
  // Claude's transcript rows carry no cwd on tool input; a shell command's
  // working directory is the session cwd, which the hook payload already has.
  void claudeTool
  return input
}

function canonicalForEntry(canonical, entry) {
  if (entry.channel === 'dsh') return canonical
  return {
    ...canonical,
    toolInput: claudeToolInput(canonical, entry, entry.config),
  }
}

/**
 * Environment for one hook process: the plugin's own root plus the harness's
 * managed `DSH_*` facts. No path outside the plugin directory is injected, and
 * ambient credential-shaped variables are left to the subprocess seam's scrub.
 */
export function buildHookEnv(pluginDir, sessionId) {
  const env = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (!key.startsWith('DSH_')) continue
    if (typeof value !== 'string') continue
    env[key] = value
  }
  env.DSH_HOST = 'dsh'
  env.PLUGIN_ROOT = pluginDir
  env.CLAUDE_PLUGIN_ROOT = pluginDir
  if (sessionId) env.DSH_SESSION_ID = sessionId
  return env
}

/**
 * Run one hook command process with UTF-8 JSON stdin, bounded collected output
 * and a per-entry timeout. Never throws: failures are classified in the result.
 */
async function runHookProcess(ctx, { entry, canonical, plugin, config, cwd, transcriptPath }) {
  const started = Date.now()
  const command = buildHookCommand(entry, plugin.dir)
  const dshEvent = entry.event
  const claudeEvent = entry.claudeEvent
  const stdinObject = entry.channel === 'dsh'
    ? buildDshStdin(canonicalForEntry(canonical, entry), plugin)
    : buildClaudeStdin(canonicalForEntry(canonical, entry), entry, config)
  const stdinText = `${JSON.stringify(stdinObject)}\n`
  const timeoutMs = entry.timeoutMs ?? config.defaultTimeoutMs
  const built = buildHookArgv(entry, command, config, process.platform)
  const env = buildHookEnv(plugin.dir, canonical.sessionId)

  const result = {
    id: hookOutcomeId(),
    plugin: plugin.name,
    pluginDir: plugin.dir,
    channel: entry.channel,
    event: dshEvent,
    claudeEvent,
    matcher: entry.matcher ?? null,
    command,
    argv: built.argv,
    timeoutMs,
    exitCode: null,
    timedOut: false,
    spawnError: null,
    durationMs: 0,
    stdout: '',
    stderr: '',
    parsed: null,
    at: Date.now(),
  }

  if (!built.argv) {
    result.spawnError = built.error ?? 'hook command 无法构造 argv'
    result.durationMs = Date.now() - started
    result.parsed = parseHookOutput({
      stdout: '', stderr: result.spawnError, exitCode: null, eventName: claudeEvent, channel: entry.channel,
    })
    result.parsed.mode = 'spawn-error'
    result.parsed.error = true
    result.failed = true
    return result
  }

  const controller = new AbortController()
  let handle = null
  let timer = null
  try {
    handle = ctx.subprocess.spawn({
      argv: built.argv,
      cwd,
      env,
      stdio: {
        stdin: { data: stdinText },
        stdout: { maxBytes: HOOK_OUTPUT_MAX_BYTES },
        stderr: { maxBytes: HOOK_OUTPUT_MAX_BYTES },
      },
      graceMs: 2000,
      signal: controller.signal,
    })
    const timedOut = new Promise((resolveTimeout) => {
      timer = setTimeout(() => resolveTimeout('timeout'), timeoutMs)
      if (typeof timer.unref === 'function') timer.unref()
    })
    const raced = await Promise.race([
      handle.done.then((outcome) => ({ kind: 'done', outcome })),
      timedOut,
    ])
    if (raced === 'timeout') {
      result.timedOut = true
      controller.abort()
      handle.terminate()
      try {
        await Promise.race([handle.done, new Promise((resolveWait) => setTimeout(resolveWait, 2000))])
      } catch {
        // The outcome is already classified as a timeout.
      }
    } else {
      result.exitCode = raced.outcome.exitCode
    }
  } catch (error) {
    result.spawnError = String((error && error.message) || error)
  } finally {
    if (timer) clearTimeout(timer)
  }

  try {
    if (handle?.collected?.stdout) result.stdout = handle.collected.stdout.readFrom(0).text
  } catch {
    // Collected stream may be unavailable; the hook still ran.
  }
  try {
    if (handle?.collected?.stderr) result.stderr = handle.collected.stderr.readFrom(0).text
  } catch {
    // Same as stdout.
  }

  result.durationMs = Date.now() - started
  const exitCode = result.timedOut ? null : result.exitCode
  result.parsed = parseHookOutput({
    stdout: result.stdout,
    stderr: result.stderr,
    exitCode: result.spawnError ? null : exitCode,
    eventName: claudeEvent,
    channel: entry.channel,
  })
  if (result.spawnError) {
    result.parsed.mode = 'spawn-error'
    result.parsed.error = true
  }
  result.failed = result.timedOut || result.spawnError !== null
  return result
}

/** Per-plugin latest hook executions, exposed by `claude_plugin_hooks`. */
function recordLastRun(state, outcome) {
  state.lastRuns.unshift({
    at: outcome.at,
    plugin: outcome.plugin,
    channel: outcome.channel,
    event: outcome.event,
    claudeEvent: outcome.claudeEvent,
    command: outcome.command,
    exitCode: outcome.exitCode,
    timedOut: outcome.timedOut,
    spawnError: outcome.spawnError,
    durationMs: outcome.durationMs,
    mode: outcome.parsed?.mode ?? 'none',
    block: outcome.parsed?.block === true,
    failed: outcome.failed === true,
  })
  if (state.lastRuns.length > LAST_RUN_LIMIT) state.lastRuns.length = LAST_RUN_LIMIT
}

function truncate(text, max = 2000) {
  const value = String(text ?? '')
  return value.length > max ? `${value.slice(0, max)}…[truncated]` : value
}

function warnHookFailure(ctx, outcome) {
  if (!outcome.failed && outcome.parsed?.mode !== 'error') return
  if (outcome.parsed?.mode === 'error') {
    ctx.logger?.warn?.(`${name}: hook ${outcome.plugin}/${outcome.event} 非阻断错误 exit=${outcome.exitCode}: ${truncate(outcome.stderr || outcome.stdout, 300)}`)
    return
  }
  ctx.logger?.warn?.(`${name}: hook ${outcome.plugin}/${outcome.event} ${outcome.timedOut ? `超时 ${outcome.timeoutMs}ms` : `启动失败 ${outcome.spawnError}`}，按策略放行`)
}

/**
 * Run every hook entry that applies to one dsh event (or to a startup batch of
 * events, see `agent/created` + `agent/session-start`).
 * @param {string|string[]} eventNameOrNames event name, or the events whose
 *   entries belong to one dispatch (the per-entry event still drives stdin).
 * @returns {Promise<{outcomes: object[], entries: number}>}
 */
async function dispatchHooks(state, ctx, eventNameOrNames, canonical) {
  const config = state.config
  const names = new Set(Array.isArray(eventNameOrNames) ? eventNameOrNames : [eventNameOrNames])
  if (!config.hooksEnabled) return { outcomes: [], entries: 0 }
  // The legacy switch only gates the SessionStart event, not the whole batch.
  if (!config.sessionStartHooks) names.delete('agent/session-start')
  if (names.size === 0) return { outcomes: [], entries: 0 }
  canonical.event = Array.isArray(eventNameOrNames) ? (canonical.event ?? 'agent/session-start') : eventNameOrNames
  canonical.claudeEvent = DSH_TO_CLAUDE_EVENT[canonical.event] ?? canonical.event

  // Resolve the durable session-log path on demand (the backend materializes it
  // lazily, so it is usually absent at SessionStart and present afterwards).
  if (canonical.agent && !canonical.dsh.session_log) {
    const log = await sessionLogPathFor(state, canonical.agent)
    if (log) canonical.dsh.session_log = log
  }

  const plugins = await state.getPlugins()
  const outcomes = []
  let entriesSeen = 0
  for (const plugin of plugins) {
    let manifest
    try {
      manifest = await loadPluginHooks(plugin, config)
    } catch (error) {
      ctx.logger?.warn?.(`${name}: 读取 ${plugin.name} 的 hooks 清单失败: ${truncate(error?.message ?? error, 200)}`)
      continue
    }
    if (!manifest.channel) continue
    for (const entry of manifest.entries) {
      if (!names.has(entry.event)) continue
      entriesSeen += 1
      const subject = hookSubject(entry.event, canonical, entry, config)
      if (!matchHookMatcher(entry.matcher, subject)) continue
      const perEntry = {
        ...canonical,
        event: entry.event,
        claudeEvent: entry.claudeEvent ?? (DSH_TO_CLAUDE_EVENT[entry.event] ?? entry.event),
      }
      const outcome = await runHookProcess(ctx, {
        entry,
        canonical: perEntry,
        plugin,
        config,
        cwd: perEntry.cwd,
        transcriptPath: perEntry.transcriptPath,
      })
      outcome.parsed.channel = entry.channel
      recordLastRun(state, outcome)
      warnHookFailure(ctx, outcome)
      logHookOutcome(state, outcome, {
        sessionId: perEntry.sessionId,
        source: perEntry.source,
        turn: perEntry.dsh?.turn ?? null,
        step: perEntry.dsh?.step ?? null,
      })
      outcomes.push(outcome)
      if (outcome.parsed?.block && config.stopOnFirstBlock) break
    }
  }
  return { outcomes, entries: entriesSeen }
}

/** The string a hook matcher is tested against for one event. */
function hookSubject(eventName, canonical, entry, config) {
  switch (eventName) {
    case 'tools/pre-execute':
    case 'tools/post-execute':
      return entry.channel === 'dsh'
        ? String(canonical.toolName ?? '')
        : claudeToolNameFor(canonical.toolName, config.claudeToolNames)
    case 'agent/session-start':
    case 'agent/created':
      return String(canonical.source ?? '')
    case 'agent/disposed':
      return String(canonical.reason ?? 'other')
    default:
      return ''
  }
}

/**
 * Recover a SessionStart-style source at `agent/created` time. The real
 * `agent/created` payload carries only `{agent}`, so a manifest that declares
 * its startup hook there can only be matched against a source the loader
 * infers: a session constructed from a durable seed is a resume, an empty one
 * is a fresh startup. `clear`/`compact` are only available on
 * `agent/session-start`, which is the authoritative event.
 */
export function inferSourceAtCreation(agent) {
  const session = agent?.session
  if (!session) return 'startup'
  const events = Array.isArray(session.events) ? session.events.length : 0
  const seed = Number(session.firstLiveSeq ?? 0)
  const headerSeed = Number(session.header?.seedLength ?? 0)
  return events > 0 || seed > 0 || headerSeed > 0 ? 'resume' : 'startup'
}

/** Model-facing plugin context message. */
export function makeHookContextMessage(text, summary) {
  return {
    id: `claude-plugin-loader-${randomUUID()}`,
    role: 'user',
    content: [{ type: 'text', text: String(text) }],
    source: {
      kind: 'plugin',
      plugin: name,
      form: 'notice',
      summary: truncate(summary ?? 'claude plugin hook context', 120),
    },
  }
}

function injectHookContext(ctx, agent, text, summary) {
  const body = String(text ?? '').trim()
  if (body.length === 0) return
  if (!agent || typeof agent.inject !== 'function') {
    ctx.logger?.warn?.(`${name}: agent.inject 不可用，hook 上下文已丢弃`)
    return
  }
  try {
    agent.inject(makeHookContextMessage(body, summary))
  } catch (error) {
    ctx.logger?.warn?.(`${name}: 注入 hook 上下文失败: ${truncate(error?.message ?? error, 200)}`)
  }
}

function collectContexts(outcomes) {
  const parts = []
  for (const outcome of outcomes) {
    for (const context of outcome.parsed?.contexts ?? []) parts.push(context)
    if (outcome.parsed?.systemMessage) parts.push(outcome.parsed.systemMessage)
  }
  return parts
}

/** Per-turn "block once" bookkeeping for the Stop gate (stop_hook_active). */
export class StopGate {
  constructor(maxBlocksPerTurn = 1) {
    this.maxBlocksPerTurn = Math.max(1, Math.floor(maxBlocksPerTurn))
    this.turns = new Map()
  }

  /** @returns {{stopHookActive: boolean, blocks: number}} */
  inspect(agentId, turn) {
    const entry = this.turns.get(agentId)
    if (!entry || entry.turn !== turn) return { stopHookActive: false, blocks: 0 }
    return { stopHookActive: entry.blocks >= this.maxBlocksPerTurn, blocks: entry.blocks }
  }

  recordBlock(agentId, turn) {
    const entry = this.turns.get(agentId)
    if (!entry || entry.turn !== turn) {
      this.turns.set(agentId, { turn, blocks: 1 })
      return
    }
    entry.blocks += 1
  }

  prune(agentId) {
    this.turns.delete(agentId)
  }
}

// --- Claude transcript synthesis -------------------------------------------

/** Filesystem-safe project directory key, mirrored from the jsonl backend. */
export function projectKey(cwd) {
  if (typeof cwd !== 'string' || cwd.length === 0) throw new Error('cannot encode an empty project path')
  let readable = ''
  let separatorRun = false
  for (let i = 0; i < cwd.length; i++) {
    const code = cwd.charCodeAt(i)
    const ch = String.fromCharCode(code)
    if (ch === '/' || ch === '\\' || ch === ':') {
      if (!separatorRun) readable += '-'
      separatorRun = true
    } else if (ch !== '~' && /^[A-Za-z0-9._-]$/.test(ch)) {
      readable += ch
      separatorRun = false
    } else {
      readable += `~${code.toString(16).toUpperCase().padStart(4, '0')}`
      separatorRun = false
    }
  }
  return `--${(readable.replace(/^-+/, '') || 'root').slice(0, 251)}--`
}

/** Injective single-path-segment encoder, mirrored from the jsonl backend. */
export function encodeSegment(raw) {
  if (typeof raw !== 'string' || raw.length === 0) throw new Error('cannot encode an empty path segment')
  if (raw === '.') return '~002E'
  if (raw === '..') return '~002E~002E'
  let out = ''
  for (let i = 0; i < raw.length; i++) {
    const code = raw.charCodeAt(i)
    const ch = String.fromCharCode(code)
    if (ch !== '~' && /^[A-Za-z0-9._-]$/.test(ch)) out += ch
    else out += `~${code.toString(16).toUpperCase().padStart(4, '0')}`
  }
  return out
}

/** Directory that holds one session's durable artifacts. */
export function sessionDir(root, cwd, id) {
  const projectDir = cwd === undefined ? '_no-cwd' : projectKey(cwd)
  return join(root, projectDir, encodeSegment(id))
}

/** Candidate durable session-log paths, newest encoding first. */
export function sessionLogCandidates(root, cwd, id) {
  const dir = sessionDir(root, cwd, id)
  return [join(dir, 'session.jsonl.zstd'), join(dir, 'session.jsonl')]
}

/** Locate the durable session log, or null when it has not been materialized. */
export async function findSessionLog(root, cwd, id) {
  for (const candidate of sessionLogCandidates(root, cwd, id)) {
    try {
      const info = await stat(candidate)
      if (info.isFile()) return candidate
    } catch {
      // Try the next encoding.
    }
  }
  return null
}

/**
 * Decode the concatenated-zstd session log into its logical JSONL text. Node's
 * zstd decompressor accepts the concatenated frames the jsonl backend writes.
 */
export function decodeSessionLog(buffer) {
  return zlib.zstdDecompressSync(buffer).toString('utf8')
}

/** Parse logical session-log lines: `{type:'session'|...}` records, header first. */
export function parseSessionLogLines(text) {
  const events = []
  let header = null
  for (const line of String(text ?? '').split(/\r?\n/)) {
    const trimmed = line.trim()
    if (trimmed.length === 0) continue
    let record
    try {
      record = JSON.parse(trimmed)
    } catch {
      continue
    }
    if (!record || typeof record !== 'object') continue
    if (record.type === 'session') {
      header = record
      continue
    }
    events.push(record)
  }
  return { header, events }
}

/** Read and decode one durable session log file. */
export async function readSessionLogEvents(path) {
  const buffer = await readFile(path)
  return parseSessionLogLines(decodeSessionLog(buffer))
}

function isoTime(time) {
  if (!Number.isFinite(time)) return null
  try {
    return new Date(time).toISOString()
  } catch {
    return null
  }
}

function textFromContent(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map((block) => (block && block.type === 'text' && typeof block.text === 'string' ? block.text : ''))
    .filter((part) => part.length > 0)
    .join('\n')
}

function claudeRow(envelope, type, message, extra = {}) {
  return {
    type,
    message,
    uuid: randomUUID(),
    parentUuid: envelope.parentUuid ?? null,
    sessionId: envelope.sessionId,
    cwd: envelope.cwd,
    timestamp: envelope.timestamp ?? null,
    ...extra,
  }
}

/**
 * Convert durable dsh session events into Claude-transcript JSONL rows.
 * The shape matches what Claude hooks parse (`type`, `message.content[].type`
 * in `tool_use`/`tool_result`, `timestamp`, `isMeta`, `origin`).
 *
 * @param {object[]} events session events (`user/message`, `assistant/message`,
 *   `tool/result`); assistant/chunk and boundary events are ignored.
 * @param {{cwd?: string, sessionId?: string, toolNames?: object}} options
 */
export function eventsToClaudeRows(events, options = {}) {
  const cwd = options.cwd ?? ''
  const sessionId = options.sessionId ?? ''
  const toolNames = options.toolNames ?? {}
  const rows = []
  let parentUuid = null
  for (const event of events) {
    const type = event?.type
    const data = event?.data ?? {}
    const envelope = {
      sessionId,
      cwd,
      timestamp: isoTime(event?.time),
      parentUuid,
    }
    if (type === 'user/message') {
      const message = data
      const human = message?.source?.kind === 'user'
      const text = textFromContent(message?.content)
      const row = human
        ? claudeRow(envelope, 'user', { role: 'user', content: text }, {
          origin: { kind: 'human' },
          isMeta: false,
        })
        : claudeRow(envelope, 'user', { role: 'user', content: [{ type: 'text', text }] }, { isMeta: true })
      rows.push(row)
      parentUuid = row.uuid
      continue
    }
    if (type === 'assistant/message') {
      const content = []
      for (const block of Array.isArray(data?.message?.content) ? data.message.content : []) {
        if (!block || typeof block !== 'object') continue
        if (block.type === 'text' && typeof block.text === 'string') {
          content.push({ type: 'text', text: block.text })
        } else if (block.type === 'tool-call') {
          let input = {}
          try {
            input = JSON.parse(block.arguments ?? '{}')
          } catch {
            input = { _raw_arguments: String(block.arguments ?? '') }
          }
          content.push({
            type: 'tool_use',
            id: block.id,
            name: claudeToolNameFor(block.name, toolNames),
            input,
          })
        }
      }
      if (content.length === 0) continue
      const row = claudeRow(envelope, 'assistant', { role: 'assistant', content })
      rows.push(row)
      parentUuid = row.uuid
      continue
    }
    if (type === 'tool/result') {
      const blocks = Array.isArray(data?.message?.content) ? data.message.content : []
      const content = []
      for (const block of blocks) {
        if (!block || block.type !== 'tool-result') continue
        const text = textFromContent(block.content)
        content.push({
          type: 'tool_result',
          tool_use_id: block.toolCallId,
          content: text,
          ...(block.isError === true ? { is_error: true } : {}),
        })
      }
      if (content.length === 0) continue
      const row = claudeRow(envelope, 'user', { role: 'user', content })
      rows.push(row)
      parentUuid = row.uuid
    }
  }
  return rows
}

/** Row buffer per session, mirrored from `session/event` and seeded on demand. */
export class TranscriptCache {
  constructor(config) {
    this.config = config
    this.sessions = new Map()
  }

  enabled() {
    return this.config.transcript !== 'off'
  }

  /** Seed the row buffer for one agent from its in-memory session events. */
  ensure(agent) {
    if (!this.enabled()) return null
    const session = agent?.session
    if (!session || typeof session.id !== 'string') return null
    const existing = this.sessions.get(session.id)
    if (existing) return existing
    const events = Array.isArray(session.events) ? session.events : []
    const cwd = session.header?.cwd ?? agentSessionCwd(agent)
    const entry = {
      sessionId: session.id,
      cwd,
      rows: eventsToClaudeRows(events, {
        cwd,
        sessionId: session.id,
        toolNames: this.config.claudeToolNames,
      }),
      lastSeq: events.length > 0 ? Number(events[events.length - 1]?.seq ?? -1) : -1,
      path: null,
      mtimeMs: 0,
      dirty: true,
    }
    this.sessions.set(session.id, entry)
    return entry
  }

  /** Append one published session event to its row buffer. */
  appendEvent(session, event) {
    if (!this.enabled()) return
    if (!session || typeof session.id !== 'string' || !event) return
    const entry = this.sessions.get(session.id)
    if (!entry) {
      // A session the loader only learns about through the firehose still gets
      // a buffer; seeding happens from the live agent on first hook.
      return
    }
    const seq = Number(event.seq)
    if (Number.isFinite(seq) && seq <= entry.lastSeq) return
    const rows = eventsToClaudeRows([event], {
      cwd: entry.cwd,
      sessionId: entry.sessionId,
      toolNames: this.config.claudeToolNames,
    })
    if (rows.length > 0) {
      entry.rows.push(...rows)
      entry.dirty = true
    }
    if (Number.isFinite(seq)) entry.lastSeq = seq
  }

  /** Write the Claude transcript file and return its path (or null). */
  async materialize(agent) {
    if (!this.enabled()) return null
    const entry = this.ensure(agent)
    if (!entry) return null
    const dir = join(os.tmpdir(), 'dsh-claude-plugin-loader', encodeSegment(entry.sessionId))
    const path = join(dir, 'transcript.jsonl')
    try {
      if (entry.path === path && entry.dirty === false && existsSync(path)) return path
      await mkdir(dir, { recursive: true })
      const body = entry.rows.map((row) => JSON.stringify(row)).join('\n')
      await writeFile(path, body.length > 0 ? `${body}\n` : '', 'utf8')
      entry.path = path
      entry.dirty = false
      return path
    } catch (error) {
      return null
    }
  }

  /** Drop a session's buffer (agent disposal). */
  drop(agent) {
    const id = agent?.id
    if (typeof id === 'string') this.sessions.delete(id)
  }
}

function agentSessionCwd(agent) {
  try {
    const header = agent?.session?.header
    if (header && typeof header.cwd === 'string') return header.cwd
  } catch {
    // Fall through.
  }
  return process.cwd()
}

/**
 * Read a durable session log directly (fallback used when a live session's
 * in-memory events are unavailable, and by the selftest diagnostics).
 */
export async function readSessionLogRows(config, sessionId, cwd) {
  const path = await findSessionLog(config.sessionRoot, cwd, sessionId)
  if (!path) return { path: null, rows: [], events: 0 }
  const { events } = await readSessionLogEvents(path)
  return {
    path,
    events: events.length,
    rows: eventsToClaudeRows(events, {
      cwd,
      sessionId,
      toolNames: config.claudeToolNames,
    }),
  }
}

/** Runtime state shared by every hook listener and the diagnostics tools. */
function createHookState(ctx, config, getPlugins) {
  return {
    config,
    ctx,
    getPlugins,
    lastRuns: [],
    stopGate: new StopGate(config.maxStopBlocksPerTurn),
    transcripts: new TranscriptCache(config),
    sessionFacts: new Map(),
    hookLog: new HookLog(config),
  }
}

function sessionFacts(state, sessionId) {
  let facts = state.sessionFacts.get(sessionId)
  if (!facts) {
    facts = { turn: null, step: null, log: null, logCheckedAt: 0 }
    state.sessionFacts.set(sessionId, facts)
  }
  return facts
}

async function sessionLogPathFor(state, agent) {
  const session = agent?.session
  if (!session || typeof session.id !== 'string') return null
  const facts = sessionFacts(state, session.id)
  if (facts.log !== null) return facts.log
  // The log is materialized lazily by the jsonl backend, so a negative lookup
  // is retried at a bounded rate instead of being cached forever.
  if (facts.logCheckedAt !== 0 && Date.now() - facts.logCheckedAt < 2000) return null
  const cwd = session.header?.cwd ?? process.cwd()
  facts.logCheckedAt = Date.now()
  try {
    facts.log = await findSessionLog(state.config.sessionRoot, cwd, session.id)
  } catch {
    facts.log = null
  }
  return facts.log
}

function makeCanonical(state, agent, extra = {}) {
  const session = agent?.session
  const sessionId = agent?.id ?? session?.id ?? ''
  const facts = sessionId ? sessionFacts(state, sessionId) : { turn: null, step: null, log: null }
  return {
    event: extra.event ?? '',
    claudeEvent: '',
    agent,
    sessionId,
    cwd: extra.cwd ?? session?.header?.cwd ?? process.cwd(),
    pluginName: '',
    pluginDir: '',
    prompt: extra.prompt ?? '',
    source: extra.source ?? '',
    stopHookActive: extra.stopHookActive === true,
    stopReason: extra.stopReason ?? '',
    toolName: extra.toolName ?? '',
    toolInput: extra.toolInput ?? {},
    toolUseId: extra.toolUseId ?? '',
    toolResponse: extra.toolResponse ?? null,
    reason: extra.reason ?? 'other',
    transcriptPath: extra.transcriptPath ?? null,
    dsh: {
      session_log: extra.sessionLog === undefined ? facts.log : extra.sessionLog,
      turn: extra.turn === undefined ? facts.turn : extra.turn,
      step: extra.step === undefined ? facts.step : extra.step,
    },
  }
}

async function ensureTranscript(state, agent) {
  if (!state.transcripts.enabled()) return null
  try {
    return await state.transcripts.materialize(agent)
  } catch {
    return null
  }
}

function toolResponseFromResult(result) {
  if (!result || typeof result !== 'object') return null
  const content = Array.isArray(result.content) ? result.content : []
  return {
    is_error: result.isError === true,
    content,
    value: result.value === undefined ? null : result.value,
  }
}

/**
 * Wire every hook channel into the live dsh context. Called from apply(); all
 * listeners ride the plugin fiber, so disposal removes them.
 */
function installHooks(ctx, config, getPlugins) {
  const state = createHookState(ctx, config, getPlugins)

  // Session lifecycle framing + durable transcript mirroring.
  ctx.on('session/event', (session, event) => {
    if (!session || !event) return
    const facts = sessionFacts(state, session.id)
    switch (event.type) {
      case 'turn/start':
        facts.turn = event.data?.turn ?? facts.turn
        facts.step = null
        break
      case 'step/start':
        facts.turn = event.data?.turn ?? facts.turn
        facts.step = event.data?.step ?? facts.step
        break
      case 'turn/end':
        facts.turn = event.data?.turn ?? facts.turn
        break
      default:
        break
    }
    state.transcripts.appendEvent(session, event)
  })

  // --- session-start dual-event resolution ---------------------------------
  // Hosts differ: some emit `agent/created` only (real payload `{agent}`, no
  // source), some also emit `agent/session-start` (`{agent, source}`). One
  // session start must run SessionStart hooks exactly ONCE across the two
  // event groups, with the best source available:
  //  - session-start arrives within startupGraceMs  -> use its source;
  //  - only agent/created                       -> infer source (seed -> resume).
  // Dedupe key is the agent plus the resolved source, so a late second event
  // cannot run pstate's start hook again.
  const startupGates = new Map()
  state.startupGates = startupGates

  function scheduleStartupGate(agent) {
    const id = String(agent.id ?? '')
    const gate = { agent, id, timer: null, flushed: false, source: null, via: null }
    if (typeof setTimeout === 'function') {
      gate.timer = setTimeout(() => {
        void flushStartupGate(gate, inferSourceAtCreation(agent), 'agent/created')
      }, config.startupGraceMs)
      if (typeof gate.timer.unref === 'function') gate.timer.unref()
    }
    startupGates.set(id, gate)
    return gate
  }

  async function flushStartupGate(gate, source, via) {
    if (gate.flushed) return
    gate.flushed = true
    gate.source = source
    gate.via = via
    if (gate.timer) clearTimeout(gate.timer)
    const agent = gate.agent
    try {
      const transcriptPath = await ensureTranscript(state, agent)
      const canonical = makeCanonical(state, agent, { source, transcriptPath })
      const { outcomes } = await dispatchHooks(
        state,
        ctx,
        ['agent/created', 'agent/session-start'],
        canonical,
      )
      const contexts = collectContexts(outcomes)
      if (contexts.length > 0) {
        injectHookContext(ctx, agent, contexts.join('\n\n'), `SessionStart hook context (${source}, via ${via})`)
      }
    } catch (error) {
      ctx.logger?.warn?.(`${name}: SessionStart hooks 失败: ${truncate(error?.message ?? error, 300)}`)
    } finally {
      // Keep the resolved gate briefly so a late duplicate event is deduped.
      if (typeof setTimeout === 'function') {
        const drop = setTimeout(() => {
          if (startupGates.get(gate.id) === gate) startupGates.delete(gate.id)
        }, 5000)
        if (typeof drop.unref === 'function') drop.unref()
      }
    }
  }

  ctx.on('agent/created', (payload) => {
    const { agent } = payload ?? {}
    if (!agent) return
    state.transcripts.ensure(agent)
    const id = String(agent.id ?? '')
    const existing = startupGates.get(id)
    if (existing && !existing.flushed) return // a second created for the same agent
    scheduleStartupGate(agent)
  })

  ctx.on('agent/session-start', (payload) => {
    const { agent, source } = payload ?? {}
    if (!agent) return
    state.transcripts.ensure(agent)
    const id = String(agent.id ?? '')
    const gate = startupGates.get(id)
    const resolved = typeof source === 'string' && source.length > 0 ? source : 'startup'
    if (gate && !gate.flushed) {
      void flushStartupGate(gate, resolved, 'agent/session-start')
      return
    }
    if (gate && gate.flushed) {
      if (gate.source !== resolved) {
        ctx.logger?.warn?.(`${name}: agent/session-start 迟到（已按 ${gate.source} 通过 ${gate.via} 派发），忽略 source=${resolved} 的重复 SessionStart`)
      }
      return
    }
    // session-start without an observable agent/created (listener attached late).
    const orphan = { agent, id, timer: null, flushed: false, source: null, via: null }
    startupGates.set(id, orphan)
    void flushStartupGate(orphan, resolved, 'agent/session-start-only')
  })

  // UserPromptSubmit: only real human prompts, never plugin-injected context
  // (otherwise our own injections would re-trigger the hook forever).
  ctx.on('agent/inbox/inserted', (payload) => {
    const { agent, message } = payload ?? {}
    if (!agent || !message) return
    if (message.source?.kind !== 'user') return
    const prompt = textFromContent(message.content)
    if (!config.hooksEnabled) return
    void (async () => {
      try {
        const transcriptPath = await ensureTranscript(state, agent)
        const canonical = makeCanonical(state, agent, { prompt, transcriptPath })
        const { outcomes } = await dispatchHooks(state, ctx, 'agent/inbox/inserted', canonical)
        const contexts = collectContexts(outcomes)
        if (contexts.length > 0) {
          injectHookContext(ctx, agent, contexts.join('\n\n'), 'UserPromptSubmit hook context')
        }
      } catch (error) {
        ctx.logger?.warn?.(`${name}: UserPromptSubmit hooks 失败: ${truncate(error?.message ?? error, 300)}`)
      }
    })()
  })

  // PreToolUse: a real veto point.
  ctx.on('tools/pre-execute', async (exec, next) => {
    if (!config.hooksEnabled) return next()
    let transcriptPath = null
    try {
      transcriptPath = await ensureTranscript(state, exec.agent)
    } catch {
      transcriptPath = null
    }
    const canonical = makeCanonical(state, exec.agent, {
      toolName: exec.name,
      toolInput: exec.arguments,
      toolUseId: String(exec.callId ?? ''),
      transcriptPath,
    })
    let outcomes
    try {
      ;({ outcomes } = await dispatchHooks(state, ctx, 'tools/pre-execute', canonical))
    } catch (error) {
      ctx.logger?.warn?.(`${name}: PreToolUse hooks 内部错误: ${truncate(error?.message ?? error, 300)}`)
      return next()
    }
    const failed = outcomes.find((outcome) => outcome.failed)
    const contexts = collectContexts(outcomes)
    if (contexts.length > 0) {
      injectHookContext(ctx, exec.agent, contexts.join('\n\n'), `PreToolUse hook context (${exec.name})`)
    }
    const decision = aggregatePreToolOutcomes(outcomes)
    if (decision.kind === 'deny') return decision
    if (decision.kind === 'ask') {
      return { kind: 'ask', ...(decision.reason ? { reason: decision.reason } : {}) }
    }
    if (failed && config.failClosed) {
      return {
        kind: 'deny',
        reason: `hook ${failed.plugin}/${failed.event} ${failed.timedOut ? '超时' : '启动失败'}（failClosed=true，已拒绝）`,
      }
    }
    return next()
  })

  // PostToolUse: accept / replace / enrich / block.
  ctx.on('tools/post-execute', async (exec, result, next) => {
    if (!config.hooksEnabled) return next()
    let transcriptPath = null
    try {
      transcriptPath = await ensureTranscript(state, exec.agent)
    } catch {
      transcriptPath = null
    }
    const canonical = makeCanonical(state, exec.agent, {
      toolName: exec.name,
      toolInput: exec.arguments,
      toolUseId: String(exec.callId ?? ''),
      toolResponse: toolResponseFromResult(result),
      transcriptPath,
    })
    let outcomes
    try {
      ;({ outcomes } = await dispatchHooks(state, ctx, 'tools/post-execute', canonical))
    } catch (error) {
      ctx.logger?.warn?.(`${name}: PostToolUse hooks 内部错误: ${truncate(error?.message ?? error, 300)}`)
      return next()
    }
    const decision = aggregatePostToolOutcomes(outcomes)
    if (!decision) return next()
    if (decision.kind === 'block') return { kind: 'block', feedback: decision.feedback }
    const additionalContexts = decision.contexts.map((text) => makeHookContextMessage(text, 'PostToolUse hook context'))
    return { kind: 'accept', additionalContexts }
  })

  // Stop gate: object by steering a message; the host re-reads its inbox.
  ctx.on('agent/turn-stopping', async (payload) => {
    const { agent, turn } = payload ?? {}
    if (!config.hooksEnabled || !agent) return
    const agentId = String(agent.id ?? '')
    const gate = state.stopGate.inspect(agentId, turn)
    let transcriptPath = null
    try {
      transcriptPath = await ensureTranscript(state, agent)
    } catch {
      transcriptPath = null
    }
    const canonical = makeCanonical(state, agent, {
      stopHookActive: gate.stopHookActive,
      transcriptPath,
      turn,
    })
    let outcomes
    try {
      ;({ outcomes } = await dispatchHooks(state, ctx, 'agent/turn-stopping', canonical))
    } catch (error) {
      ctx.logger?.warn?.(`${name}: Stop hooks 内部错误: ${truncate(error?.message ?? error, 300)}`)
      return
    }
    const contexts = collectContexts(outcomes)
    if (contexts.length > 0) {
      injectHookContext(ctx, agent, contexts.join('\n\n'), 'Stop hook context')
    }
    const blocked = outcomes.find((outcome) => outcome.parsed?.block && !outcome.parsed?.continueFalse)
    if (!blocked || gate.stopHookActive) return
    const reason = String(blocked.parsed.reason ?? '').trim()
    if (reason.length === 0) {
      ctx.logger?.warn?.(`${name}: Stop hook ${blocked.plugin} 要求阻断但没有给出 reason，已放行`)
      return
    }
    try {
      agent.steer(makeHookContextMessage(reason, `Stop hook block (${blocked.plugin})`))
      state.stopGate.recordBlock(agentId, turn)
      ctx.logger?.info?.(`${name}: Stop hook ${blocked.plugin} 拦截本轮收工（turn=${turn}）`)
    } catch (error) {
      ctx.logger?.warn?.(`${name}: agent.steer 失败: ${truncate(error?.message ?? error, 300)}`)
    }
  })

  // SessionEnd.
  ctx.on('agent/disposed', (payload) => {
    const { agent } = payload ?? {}
    if (!agent) return
    const id = String(agent.id ?? '')
    state.stopGate.prune(id)
    state.sessionFacts.delete(id)
    startupGates.delete(id)
    if (!config.hooksEnabled) {
      state.transcripts.drop(agent)
      return
    }
    void (async () => {
      try {
        const canonical = makeCanonical(state, agent, {})
        await dispatchHooks(state, ctx, 'agent/disposed', canonical)
      } catch (error) {
        ctx.logger?.warn?.(`${name}: SessionEnd hooks 失败: ${truncate(error?.message ?? error, 300)}`)
      } finally {
        state.transcripts.drop(agent)
      }
    })()
  })

  return state
}

// --- durable hook execution log (externally verifiable evidence) -----------

/** Replace credential-shaped fragments before anything reaches the log file. */
export function redactHookText(text, max = 200) {
  let value = String(text ?? '')
  value = value.replace(/sk-[A-Za-z0-9_-]{6,}/g, 'sk-<redacted>')
  value = value.replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{6,}/gi, '$1 <redacted>')
  value = value.replace(
    /((?:api[_-]?key|access[_-]?token|refresh[_-]?token|token|secret|password|passwd|authorization)\s*["']?\s*[:=]\s*["']?)([^\s"',;]+)/gi,
    '$1<redacted>',
  )
  value = value.replace(/\b[A-Za-z0-9_-]{32,}\b/g, '<redacted-token>')
  value = value.replace(/\s+/g, ' ').trim()
  return value.length > max ? `${value.slice(0, max)}…` : value
}

/** Default hook-log path: `<DSH_HOME>/state/claude-plugin-loader/hooks[-<profile>].jsonl`. */
export function defaultHookLogPath(profile = process.env.DSH_PROFILE) {
  const suffix = typeof profile === 'string' && profile.length > 0 ? `-${profile}` : ''
  return join(dshHome(), 'state', 'claude-plugin-loader', `hooks${suffix}.jsonl`)
}

/**
 * Bounded JSONL log of every executed hook. One line per hook process with the
 * event, plugin, decision, exit code, timing and a redacted output summary.
 * Rotates to `<path>.1` when the file would exceed `hookLogMaxBytes`, so it can
 * never grow without bound; `hookLog: false` turns it off.
 */
export class HookLog {
  constructor(config, { profile } = {}) {
    this.enabled = config.hookLog !== false
    this.maxBytes = config.hookLogMaxBytes
    this.path = config.hookLogPath ?? defaultHookLogPath(profile)
    this.chain = Promise.resolve()
    this.failures = 0
  }

  /** Append one record; serialized so concurrent hooks cannot interleave. */
  record(entry) {
    if (!this.enabled) return Promise.resolve()
    const line = `${JSON.stringify(entry)}\n`
    const bytes = Buffer.byteLength(line, 'utf8')
    this.chain = this.chain
      .then(async () => {
        await mkdir(dirname(this.path), { recursive: true })
        let size = 0
        try {
          size = (await stat(this.path)).size
        } catch {
          size = 0
        }
        if (size > 0 && size + bytes > this.maxBytes) {
          try {
            await writeFile(`${this.path}.1`, await readFile(this.path))
          } catch {
            // Rotation is best-effort: an unreadable old file still yields a new one.
          }
          await writeFile(this.path, '', 'utf8')
        }
        await writeFile(this.path, line, { encoding: 'utf8', flag: 'a' })
      })
      .catch(() => {
        this.failures += 1
      })
    return this.chain
  }

  /** Wait until every queued record is on disk. */
  async flush() {
    await this.chain
  }
}

function decisionOf(parsed, eventName) {
  if (!parsed) return 'none'
  if (parsed.mode === 'spawn-error') return 'error'
  if (parsed.mode === 'timeout') return 'timeout'
  if (parsed.block) return eventName === 'tools/pre-execute' ? 'deny' : 'block'
  if (parsed.ask) return 'ask'
  if (parsed.contexts?.length > 0 || parsed.systemMessage) return 'context'
  if (parsed.error) return 'error'
  return 'none'
}

function logHookOutcome(state, outcome, extra = {}) {
  const log = state?.hookLog
  if (!log?.enabled) return
  if (!state.config.hookLog) return
  const record = {
    ts: new Date(outcome.at ?? Date.now()).toISOString(),
    kind: extra.kind ?? 'hook',
    session_id: extra.sessionId ?? null,
    turn: extra.turn ?? null,
    step: extra.step ?? null,
    plugin: outcome.plugin,
    channel: outcome.channel,
    event: outcome.event,
    source: extra.source ?? null,
    matcher: outcome.matcher ?? null,
    command: redactHookText(outcome.command, 200),
    exit_code: outcome.exitCode,
    decision: decisionOf(outcome.parsed, outcome.event),
    timed_out: outcome.timedOut === true,
    spawn_error: outcome.spawnError ? redactHookText(outcome.spawnError, 200) : null,
    duration_ms: outcome.durationMs,
    stdout: redactHookText(outcome.stdout, 200),
    stderr: redactHookText(outcome.stderr, 200),
    ...extra.extra,
  }
  void log.record(record)
}

/** Human-readable hook channel summary used by `claude_plugin_status`. */async function formatHookSummary(plugins, state) {
  if (!state) return []
  const lines = []
  const flags = state.config
  lines.push(`hooks bridge: ${flags.hooksEnabled ? 'on' : 'off'} (dsh=${flags.dshHooks ? 'on' : 'off'}, claude=${flags.claudeHooks ? 'on' : 'off'}, SessionStart=${flags.sessionStartHooks ? 'on' : 'off'}, transcript=${flags.transcript})`)
  let active = 0
  for (const plugin of plugins) {
    let manifest
    try {
      manifest = await loadPluginHooks(plugin, state.config)
    } catch {
      continue
    }
    if (!manifest.channel) continue
    active += 1
    const perEvent = new Map()
    for (const entry of manifest.entries) {
      perEvent.set(entry.event, (perEvent.get(entry.event) ?? 0) + 1)
    }
    const events = [...perEvent.entries()].map(([event, count]) => `${event}×${count}`).join(', ')
    const mtime = manifest.mtimeMs ? new Date(manifest.mtimeMs).toISOString() : 'unknown'
    lines.push(`    hooks: channel=${manifest.channel} (${basename(manifest.file)} @ ${mtime}) ${events}`)
    if (manifest.claudeFileIgnored) {
      lines.push(`      note: hooks/dsh.json 生效，${basename(manifest.claudeFile)} 未执行（通道优先级）`)
    }
    if (manifest.skipped.length > 0) {
      lines.push(`      skipped: ${manifest.skipped.map((item) => `${item.event}(${item.reason})`).join('; ')}`)
    }
    if (manifest.warnings.length > 0) {
      lines.push(`      warnings: ${manifest.warnings.join('; ')}`)
    }
  }
  if (active === 0) lines.push('    hooks: no plugin declared an executable command hook')
  return lines
}

async function formatHooksDetail(plugins, state) {
  const lines = ['Claude plugin hooks (effective channels):', '']
  const flags = state.config
  lines.push(`config: hooksEnabled=${flags.hooksEnabled} claudeHooks=${flags.claudeHooks} dshHooks=${flags.dshHooks} sessionStartHooks=${flags.sessionStartHooks}`)
  lines.push(`timeouts: defaultTimeoutMs=${flags.defaultTimeoutMs} failClosed=${flags.failClosed} maxStopBlocksPerTurn=${flags.maxStopBlocksPerTurn}`)
  lines.push(`transcript: ${flags.transcript} (claude 兼容通道使用合成 Claude transcript)`)
  lines.push('')
  if (plugins.length === 0) {
    lines.push('No Claude-style plugins found under configured roots.')
  }
  for (const plugin of plugins) {
    let manifest
    try {
      manifest = await loadPluginHooks(plugin, state.config)
    } catch (error) {
      lines.push(`- ${plugin.name}: hooks 清单读取失败 (${error?.message ?? error})`)
      continue
    }
    if (!manifest.channel) {
      lines.push(`- ${plugin.name}: none`)
      continue
    }
    const mtime = manifest.mtimeMs ? new Date(manifest.mtimeMs).toISOString() : 'unknown'
    lines.push(`- ${plugin.name}: channel=${manifest.channel} file=${manifest.file} mtime=${mtime}`)
    if (manifest.claudeFileIgnored) {
      lines.push(`    ignored: ${manifest.claudeFile} (hooks/dsh.json 优先，通道优先级生效)`)
    }
    for (const entry of manifest.entries) {
      const args = [
        `event=${entry.event}`,
        entry.channel === 'claude' ? `claude=${entry.claudeEvent}` : null,
        entry.matcher ? `matcher=${entry.matcher}` : 'matcher=(all)',
        `${entry.timeoutMs ?? 'default'}ms`,
        entry.shell ? `shell=${entry.shell}` : null,
      ].filter(Boolean).join(' ')
      lines.push(`    - ${args}`)
      lines.push(`      command: ${truncate(entry.command, 160)}`)
    }
    for (const item of manifest.skipped) {
      lines.push(`    - skipped ${item.event}: ${item.reason}`)
    }
    for (const warning of manifest.warnings) lines.push(`    - warning: ${warning}`)
  }
  lines.push('')
  lines.push('recent executions (newest first):')
  if (state.lastRuns.length === 0) {
    lines.push('  (none yet — hooks run when a real dsh event reaches the loader)')
  } else {
    for (const run of state.lastRuns.slice(0, 15)) {
      const when = new Date(run.at).toISOString()
      const verdict = run.block
        ? 'BLOCK'
        : run.failed
          ? (run.timedOut ? 'TIMEOUT' : 'SPAWN-FAIL')
          : `exit=${run.exitCode ?? '?'}`
      lines.push(`  ${when} ${run.plugin} ${run.channel}/${run.event} → ${verdict} (${run.durationMs}ms, mode=${run.mode})`)
    }
  }
  const hookLog = state.hookLog
  lines.push('')
  if (!hookLog?.enabled || !flags.hookLog) {
    lines.push('hook log: disabled (config hookLog: false)')
  } else {
    lines.push(`hook log: ${hookLog.path} (rotate at ${flags.hookLogMaxBytes} bytes)`)
    try {
      const text = await readFile(hookLog.path, 'utf8')
      const tail = text.trim().split(/\r?\n/).filter(Boolean).slice(-5)
      lines.push(tail.length > 0 ? '  last lines:' : '  (empty)')
      for (const line of tail) lines.push(`  ${truncate(line, 400)}`)
    } catch {
      lines.push('  (not written yet)')
    }
  }
  return lines.join('\n')
}

async function runHookSelftest(state, ctx, args) {
  const plugins = await state.getPlugins()
  const pluginName = typeof args?.plugin === 'string' && args.plugin.length > 0 ? args.plugin : null
  const plugin = pluginName
    ? plugins.find((candidate) => candidate.name.toLowerCase() === pluginName.toLowerCase())
    : null
  if (pluginName && !plugin) {
    return { ok: false, text: `插件 ${pluginName} 未被发现（roots 中的已加载插件：${plugins.map((p) => p.name).join(', ') || 'none'}）` }
  }
  const candidates = plugin ? [plugin] : plugins
  const wanted = typeof args?.event === 'string' && args.event.length > 0 ? args.event : null
  const dshEvent = wanted ? (CLAUDE_TO_DSH_EVENT[wanted] ?? wanted) : 'tools/pre-execute'
  for (const candidate of candidates) {
    let manifest
    try {
      manifest = await loadPluginHooks(candidate, state.config)
    } catch {
      continue
    }
    if (!manifest.channel) continue
    const entry = manifest.entries.find((item) => item.event === dshEvent)
    if (!entry) continue
    const canonical = makeSyntheticCanonicalEvent(dshEvent, {
      cwd: process.cwd(),
      pluginName: candidate.name,
      pluginDir: candidate.dir,
      toolName: typeof args?.tool_name === 'string' && args.tool_name.length > 0 ? args.tool_name : 'write',
      source: typeof args?.source === 'string' && args.source.length > 0 ? args.source : 'startup',
    })
    const transcriptDir = join(os.tmpdir(), 'dsh-claude-plugin-loader', 'selftest')
    await mkdir(transcriptDir, { recursive: true })
    const transcriptPath = join(transcriptDir, 'transcript.jsonl')
    if (entry.channel === 'claude') {
      await writeFile(transcriptPath, '', 'utf8')
      canonical.transcriptPath = transcriptPath
    }
    const outcome = await runHookProcess(ctx, {
      entry,
      canonical,
      plugin: candidate,
      config: state.config,
      cwd: canonical.cwd,
      transcriptPath: canonical.transcriptPath,
    })
    recordLastRun(state, outcome)
    logHookOutcome(state, outcome, {
      kind: 'selftest',
      sessionId: canonical.sessionId,
      source: canonical.source,
      extra: { synthetic: true },
    })
    const report = {
      synthetic: true,
      note: '合成 payload 直接调用 hook 命令：证明清单解析/匹配/执行/判定链，不等于宿主真实触发（真实触发请用真机会话验证）。',
      plugin: candidate.name,
      plugin_dir: candidate.dir,
      channel: manifest.channel,
      manifest: manifest.file,
      event: entry.event,
      claude_event: entry.claudeEvent,
      command: outcome.command,
      exit_code: outcome.exitCode,
      timed_out: outcome.timedOut,
      spawn_error: outcome.spawnError,
      duration_ms: outcome.durationMs,
      decision_mode: outcome.parsed?.mode ?? 'none',
      block: outcome.parsed?.block === true,
      ask: outcome.parsed?.ask === true,
      reason: truncate(outcome.parsed?.reason ?? '', 800),
      stdout: truncate(outcome.stdout, 1200),
      stderr: truncate(outcome.stderr, 1200),
      transcript_path: canonical.transcriptPath,
      stdin_shape: entry.channel === 'dsh' ? 'dsh-native' : 'claude-compatible',
    }
    return { ok: !outcome.failed, report }
  }
  return {
    ok: false,
    text: `没有找到可自测的 hook 条目（event=${dshEvent}${pluginName ? `, plugin=${pluginName}` : ''}）`,
  }
}

async function formatStatus(plugins, hookState = null) {
  const lines = ['Claude plugin loader status:', '']
  if (plugins.length === 0) {
    lines.push('No Claude-style plugins found under configured roots.')
    const emptyHookLines = await formatHookSummary(plugins, hookState)
    if (emptyHookLines.length > 0) lines.push(...emptyHookLines)
    return lines.join('\n')
  }
  for (const p of plugins) {
    const channels = []
    if (p.skillsRoot) channels.push('skills')
    if (p.hooksFile) channels.push('hooks')
    if (p.commandsRoot) channels.push('commands')
    if (p.agentsRoot) channels.push('agents')
    if (p.mcp) channels.push('mcp')
    lines.push(`- ${p.name}${p.version ? ` v${p.version}` : ''}: ${channels.length ? channels.join(', ') : 'no recognized channels'}`)
    if (p.skillsRoot) {
      const count = (await listSkillsFromPlugin(p)).length
      lines.push(`    skills: ${count}`)
    }
    if (p.hooksFile) lines.push(`    hooks: ${basename(p.hooksFile)}`)
    if (p.commandsRoot) {
        const cmds = await listCommandsFromPlugin(p)
        lines.push(`    commands: ${cmds.length ? cmds.map((c) => c.name).join(', ') : 'none'}`)
      }
    if (p.agentsRoot) lines.push(`    agents: ${basename(p.agentsRoot)}`)
    if (p.mcp) lines.push(`    mcp: ${Object.keys(p.mcp).join(', ')}`)
  }
  const hookLines = await formatHookSummary(plugins, hookState)
  if (hookLines.length > 0) {
    lines.push('')
    lines.push(...hookLines)
  }
  return lines.join('\n')
}

/** Default roots to scan when the profile does not set pluginRoots. */
function defaultPluginRoots() {
  const claudeHome = process.env.CLAUDE_CONFIG_DIR
    ? resolve(String(process.env.CLAUDE_CONFIG_DIR))
    : join(os.homedir(), '.claude')
  return [join(claudeHome, 'plugins', 'cache')]
}

export async function apply(ctx, config = {}) {
  const rawRoots = Array.isArray(config?.pluginRoots)
    ? config.pluginRoots
    : defaultPluginRoots()
  const pluginRoots = rawRoots
    .map((p) => resolve(String(p)))
    .filter((root) => root.length > 0)
  const enabledPlugins = Array.isArray(config.enabledPlugins) && config.enabledPlugins.length > 0
    ? new Set(config.enabledPlugins.map((s) => String(s).toLowerCase()))
    : null
  const enabledSkills = Array.isArray(config.enabledSkills)
    ? new Set(config.enabledSkills.map((s) => String(s)))
    : null
  const hookConfig = normalizeHookConfig(config)

  // Hook dispatch fires on every tool call, so the plugin inventory is cached
  // for a short TTL instead of walking the roots each time.
  const inventoryTtl = Number.isFinite(config?.reloadIntervalMs) && config.reloadIntervalMs > 0
    ? Math.max(250, Math.min(30000, config.reloadIntervalMs))
    : DEFAULT_PLUGIN_CACHE_TTL_MS
  let inventoryAt = 0
  let inventory = []
  const getPlugins = async () => {
    if (inventoryAt !== 0 && Date.now() - inventoryAt < inventoryTtl) return inventory
    inventory = await scanPlugins(pluginRoots, enabledPlugins)
    inventoryAt = Date.now()
    return inventory
  }

  // Hooks bridge: subscribes to the six real dsh events plus the session event
  // firehose (transcript mirroring, turn/step tracking).
  const hookState = installHooks(ctx, hookConfig, getPlugins)

  // Skill provider: expose every plugin's skills through ctx.skills.
  const providerName = 'claude-plugin-loader'
  ctx.skills.registerProvider((control) => ({
    name: providerName,
    async list() {
      const plugins = await scanPlugins(pluginRoots, enabledPlugins)
      const out = []
      for (const plugin of plugins) {
        out.push(...await listSkillsFromPlugin(plugin))
      }
      return enabledSkills === null
        ? out
        : out.filter((s) => enabledSkills.has(`${s.metadata?.plugin}:${s.name}`))
    },
    async get(candidate) {
      const raw = await readFile(candidate.locator.path, 'utf8')
      const meta = parseFrontmatter(raw)
      if (!meta || !isSkillName(meta.name) || !meta.description) return undefined
      if (enabledSkills !== null) {
        const key = `${candidate.metadata?.plugin}:${meta.name}`
        if (!enabledSkills.has(key)) return undefined
      }
      return {
        name: meta.name,
        description: meta.description,
        ...(meta['when-to-use'] !== undefined ? { whenToUse: meta['when-to-use'] } : {}),
        invocation: parseInvocation(meta),
        source: candidate.source,
        provider: providerName,
        resourceBase: { kind: 'directory', path: candidate.locator.directory },
        path: candidate.locator.path,
        content: extractSkillBody({ content: expandClaudePluginRoot(raw, candidate.metadata?.pluginRoot) }),
        metadata: candidate.metadata,
      }
    },
  }))

  // Read-only status tool: verify which plugins / channels the loader found.
  ctx.tools.register({
    name: 'claude_plugin_status',
    description: 'List Claude-style plugins discovered by dsh-claude-plugin-loader and their component channels (skills/hooks/mcp/commands/agents), including the effective hooks bridge channel per plugin. Use this to verify platform normalization state.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { text: { type: 'string' } }, required: ['text'] },
      render: (_args, value) => [{ type: 'text', text: value.text }],
    },
    async execute() {
      const plugins = await getPlugins()
      return { text: await formatStatus(plugins, hookState) }
    },
  })

  // Read-only hooks inventory: effective channel, manifest mtime, entries and
  // the most recent executions observed in this process.
  ctx.tools.register({
    name: 'claude_plugin_hooks',
    description: 'List every effective Claude/dsh hook entry per plugin: channel (dsh-native or claude-compatible), source manifest + mtime, matcher/command/timeout, entries skipped for safety, and recent executions. Read-only diagnostics.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { text: { type: 'string' } }, required: ['text'] },
      render: (_args, value) => [{ type: 'text', text: value.text }],
    },
    async execute() {
      const plugins = await getPlugins()
      return { text: await formatHooksDetail(plugins, hookState) }
    },
  })

  // Synthetic hook selftest: proves manifest parsing / matching / execution /
  // decision parsing for one entry. It is NOT a host trigger.
  ctx.tools.register({
    name: 'claude_plugin_hook_selftest',
    description: 'Run ONE plugin hook entry with a synthetic payload and report exit code, parsed decision and timing. Proves the manifest-parsing/matching/execution/decision chain; it does NOT prove a real dsh event trigger (verify that with a real session).',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        plugin: { type: 'string', description: 'plugin name to test; default = first plugin with hooks' },
        event: { type: 'string', description: 'dsh event name or Claude hook event name; default tools/pre-execute' },
        tool_name: { type: 'string', description: 'synthetic dsh tool name for tool events; default write' },
        source: { type: 'string', description: 'synthetic SessionStart source; default startup' },
      },
    },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { text: { type: 'string' } }, required: ['text'] },
      render: (_args, value) => [{ type: 'text', text: value.text }],
    },
    async execute(args) {
      const result = await runHookSelftest(hookState, ctx, args ?? {})
      if (!result.ok && result.text) return { text: result.text }
      return { text: JSON.stringify(result.report, null, 2) }
    },
  })

  // Read-only command registry tool: verify which slash commands were actually
  // registered for the current dsh agent.
  ctx.tools.register({
    name: 'claude_plugin_commands',
    description: 'List slash commands actually registered by Claude plugins for the current dsh agent. Use this to verify the commands channel, not just plugin discovery.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { text: { type: 'string' } }, required: ['text'] },
      render: (_args, value) => [{ type: 'text', text: value.text }],
    },
    async execute(_args, exec) {
      const agent = exec?.agent
      if (!agent || !ctx.commands?.list) {
        return { text: 'commands service or agent context unavailable in this profile.' }
      }
      const commands = ctx.commands.list(agent)
      if (commands.length === 0) {
        return { text: 'No slash commands registered for this agent.' }
      }
      return { text: commands.map((c) => `/${c.name}: ${c.description}`).join('\n') }
    },
  })

  // DEBUG tool: execute a registered slash command programmatically to verify
  // the command handler actually runs (headless has no slash-command UI).
  ctx.tools.register({
    name: 'claude_plugin_run_command',
    description: 'DEBUG: execute a registered Claude plugin slash command programmatically and report the CommandResult. Use this to verify the commands channel end-to-end in headless.',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'command name without leading slash, e.g. hello' },
        input: { type: 'string', description: 'optional raw input after the command name' },
      },
      required: ['name'],
      additionalProperties: false,
    },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { text: { type: 'string' } }, required: ['text'] },
      render: (_args, value) => [{ type: 'text', text: value.text }],
    },
    async execute(args, exec) {
      const agent = exec?.agent
      if (!agent || !ctx.commands?.execute) {
        return { text: 'commands service or agent context unavailable in this profile.' }
      }
      const line = `/${args.name}${args.input ? ` ${args.input}` : ''}`
      const signal = exec?.signal ?? new AbortController().signal
      try {
        const execution = await ctx.commands.execute(agent, line, [], signal)
        if (!execution) {
          return { text: `Command ${line} was not found or invalid syntax.` }
        }
        const result = execution.result
        return { text: `kind=${result.kind}${result.text ? `\n${result.text}` : ''}` }
      } catch (error) {
        return { text: `execution error: ${String((error && error.message) || error)}` }
      }
    },
  })

  // Commands channel: register Claude plugin commands as dsh slash commands,
  // then keep them in sync when plugins are added/removed/edited.
  await syncPluginCommands(ctx, await getPlugins())
  startCommandReload(ctx, pluginRoots, enabledPlugins, config)

  // The hooks bridge itself was installed above (installHooks): SessionStart
  // (agent/session-start), UserPromptSubmit (agent/inbox/inserted), PreToolUse
  // (tools/pre-execute), PostToolUse (tools/post-execute), Stop
  // (agent/turn-stopping) and SessionEnd (agent/disposed). The legacy
  // `sessionStartHooks` switch is retained as the SessionStart-only gate.
}

export {
  syncPluginCommands,
  commandKey,
  commandRegistrations,
  disposeCommand,
  startCommandReload,
  installHooks,
  formatHooksDetail,
  runHookSelftest,
  parseFrontmatter,
}