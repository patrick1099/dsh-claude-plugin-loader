/**
 * dsh-claude-plugin-loader — minimal Claude-style plugin loader for dsh.
 *
 * This is the first vertical slice of "platform normalization":
 *  - discovers Claude-style plugins (directories containing
 *    `.claude-plugin/plugin.json`) under configured roots;
 *  - registers their `skills/` directories as a dsh skill provider, so the
 *    model can discover and load plugin skills by name (skill_search /
 *    skill_load work unchanged);
 *  - exposes `claude_plugin_status` so a session can verify which plugins /
 *    component channels were found;
 *  - parses hooks / mcpServers / commands / agents and reports them as
 *    read-only inventory. Runtime hook bridging and MCP config generation are
 *    intentionally deferred to the next iteration.
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
 */

import { readFile, readdir, stat } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import os from 'node:os'
import { join, basename, resolve } from 'node:path'

export const name = 'dsh-claude-plugin-loader'

/** The agent, tools, skills, subprocess, and commands services must exist before registration. */
export const inject = ['skills', 'tools', 'subprocess', 'commands']

const MAX_SCAN_DEPTH = 8
const SKIP_DIRS = new Set(['node_modules', '.git', '.trash', '__pycache__', '.pytest_cache'])

function parseFrontmatter(raw) {
  if (!raw.startsWith('---')) return null
  const end = raw.indexOf('\n---', 3)
  if (end === -1) return null
  const block = raw.slice(3, end)
  const data = {}
  for (const line of block.split(/\r?\n/)) {
    const m = line.match(/^([A-Za-z_][\w-]*):\s*(.*)$/)
    if (!m) continue
    data[m[1]] = m[2].replace(/^["']|["']$/g, '').trim()
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

async function runHookCommand(command, pluginDir, ctx) {
  const expanded = String(command)
    .replace(/\$\{CLAUDE_PLUGIN_ROOT\}/g, pluginDir)
    .replace(/\$CLAUDE_PLUGIN_ROOT/g, pluginDir)
  const win = process.platform === 'win32'
  const shell = win ? (process.env.ComSpec || 'cmd.exe') : '/bin/sh'
  const argv = win ? ['/d', '/s', '/c', expanded] : ['-c', expanded]
  try {
    const handle = ctx.subprocess.spawn({
      argv: [shell, ...argv],
      cwd: pluginDir,
      stdio: {
        stdin: 'ignore',
        stdout: { maxBytes: 16000 },
        stderr: { maxBytes: 16000 },
      },
      graceMs: 3000,
    })
    const outcome = await handle.done
    let text = ''
    try {
      text = handle.collected.stdout.readFrom(0).text
    } catch {
      // Collected reader may be unavailable; tolerate.
    }
    if (outcome.exitCode !== 0) {
      return `[hook failed exit=${outcome.exitCode}] ${text}`.trim()
    }
    return text.trim()
  } catch (error) {
    return `[hook error] ${String((error && error.message) || error)}`
  }
}

function expandClaudePluginRoot(text, pluginRoot) {
  if (typeof text !== 'string' || typeof pluginRoot !== 'string' || pluginRoot.length === 0) {
    return text
  }
  return text
    .replace(/\$\{CLAUDE_PLUGIN_ROOT\}/g, pluginRoot)
    .replace(/\$CLAUDE_PLUGIN_ROOT/g, pluginRoot)
}

async function formatStatus(plugins) {
  const lines = ['Claude plugin loader status:', '']
  if (plugins.length === 0) {
    lines.push('No Claude-style plugins found under configured roots.')
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
      return out
    },
    async get(candidate) {
      const raw = await readFile(candidate.locator.path, 'utf8')
      const meta = parseFrontmatter(raw)
      if (!meta || !isSkillName(meta.name) || !meta.description) return undefined
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
    description: 'List Claude-style plugins discovered by dsh-claude-plugin-loader and their component channels (skills/hooks/mcp/commands/agents). Use this to verify platform normalization state.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { text: { type: 'string' } }, required: ['text'] },
      render: (_args, value) => [{ type: 'text', text: value.text }],
    },
    async execute() {
      const plugins = await scanPlugins(pluginRoots, enabledPlugins)
      return { text: await formatStatus(plugins) }
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
  await syncPluginCommands(ctx, await scanPlugins(pluginRoots, enabledPlugins))
  startCommandReload(ctx, pluginRoots, enabledPlugins, config)

  // SessionStart hook bridge (minimal, opt-in): run Claude plugin command hooks
  // on `agent/session-start` and inject their stdout as context. Default off
  // because hook commands may have side effects or fail on dsh; enable with
  // `config.sessionStartHooks: true`. PreToolUse / tool-rewrite and the
  // protocol bridge for arbitrary external scripts remain for the next iteration.
  if (config.sessionStartHooks !== true) return
  ctx.on('agent/session-start', async ({ agent }) => {
    const plugins = await scanPlugins(pluginRoots, enabledPlugins)
    const notices = []
    for (const plugin of plugins) {
      if (!plugin.hooksFile) continue
      const hooks = await readJsonIfExists(plugin.hooksFile)
      const sessionStart = hooks?.hooks?.SessionStart ?? []
      for (const group of sessionStart) {
        for (const hook of group?.hooks ?? []) {
          if (hook?.type !== 'command') continue
          const text = await runHookCommand(hook.command, plugin.dir, ctx)
          if (text && text.length > 0) notices.push(`[${plugin.name} SessionStart hook]\n${text}`)
        }
      }
    }
    if (notices.length === 0) return
    agent.inject({
      id: `claude-plugin-session-start-${Date.now()}`,
      role: 'user',
      content: [{ type: 'text', text: notices.join('\n\n') }],
      source: { kind: 'plugin', plugin: name, form: 'notice' },
    })
  })
}

export { syncPluginCommands, commandKey, commandRegistrations, disposeCommand, startCommandReload }
