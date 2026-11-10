import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync, mkdirSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  syncPluginCommands,
  commandKey,
  commandRegistrations,
  installHooks,
  normalizeHookConfig,
  normalizeDshManifest,
  normalizeClaudeManifest,
  parseFrontmatter,
  loadPluginHooks,
  matchHookMatcher,
  claudeToolNameFor,
  buildHookCommand,
  buildHookArgv,
  splitHookCommand,
  buildDshStdin,
  buildClaudeStdin,
  parseHookOutput,
  aggregatePreToolOutcomes,
  aggregatePostToolOutcomes,
  makeSyntheticCanonicalEvent,
  inferSourceAtCreation,
  StopGate,
  projectKey,
  encodeSegment,
  sessionLogCandidates,
  decodeSessionLog,
  parseSessionLogLines,
  readSessionLogEvents,
  eventsToClaudeRows,
  TranscriptCache,
  HookLog,
  defaultHookLogPath,
  redactHookText,
} from './dsh-claude-plugin-loader.mjs'

// ---------------------------------------------------------------------------
// fixtures
// ---------------------------------------------------------------------------

const FIXTURE_LOG = new URL('./test/fixtures/session.jsonl.zstd', import.meta.url)

function makePlugin(name, commandFiles) {
  const dir = mkdtempSync(join(tmpdir(), `dsh-loader-${name}-`))
  const commandsRoot = join(dir, 'commands')
  mkdirSync(commandsRoot, { recursive: true })
  for (const [fileName, body] of Object.entries(commandFiles)) {
    writeFileSync(join(commandsRoot, fileName), body, 'utf8')
  }
  return { name, commandsRoot, dir }
}

function makeCtx() {
  const registered = new Map()
  const disposals = []
  return {
    registered,
    disposals,
    logger: { warn() {} },
    commands: {
      register(definition) {
        registered.set(definition.name, definition)
        return () => {
          disposals.push(definition.name)
          registered.delete(definition.name)
        }
      },
    },
  }
}

function makeHookPlugin(name, { dsh, claude } = {}) {
  const dir = mkdtempSync(join(tmpdir(), `dsh-loader-hooks-${name}-`))
  mkdirSync(join(dir, '.claude-plugin'), { recursive: true })
  writeFileSync(join(dir, '.claude-plugin', 'plugin.json'), JSON.stringify({ name, version: '1.0.0' }), 'utf8')
  mkdirSync(join(dir, 'hooks'), { recursive: true })
  if (dsh !== undefined) {
    writeFileSync(join(dir, 'hooks', 'dsh.json'), JSON.stringify(dsh), 'utf8')
  }
  if (claude !== undefined) {
    writeFileSync(join(dir, 'hooks', 'hooks.json'), JSON.stringify(claude), 'utf8')
  }
  return { dir, name, version: '1.0.0' }
}

function fakeHandle(result) {
  const reader = (text) => ({
    readFrom: () => ({ text, nextOffset: text.length, lossy: false }),
  })
  return {
    pid: 4242,
    stdin: undefined,
    stdout: undefined,
    stderr: undefined,
    collected: {
      stdout: reader(result.stdout ?? ''),
      stderr: reader(result.stderr ?? ''),
    },
    done: Promise.resolve({ exitCode: result.exitCode ?? 0, signal: null }),
    terminate() {},
    async waitForExit() {
      return true
    },
  }
}

/**
 * Fake dsh context with an event-listener registry, a tool registry and a
 * scripted subprocess seam. Records every spawned stdin payload.
 */
function makeBridgeCtx(handler) {
  const listeners = new Map()
  const tools = new Map()
  const spawns = []
  const ctx = {
    logger: { warn() {}, info() {} },
    listeners,
    tools,
    spawns,
    subprocess: {
      spawn(spec) {
        const stdin = spec.stdio?.stdin?.data ?? ''
        spawns.push({ spec, stdin })
        return fakeHandle(handler({ spec, stdin, argv: spec.argv }))
      },
    },
    on(name, fn) {
      const list = listeners.get(name) ?? []
      list.push(fn)
      listeners.set(name, list)
      return () => {
        const current = listeners.get(name) ?? []
        listeners.set(name, current.filter((item) => item !== fn))
      }
    },
    toolsRegister(definition) {
      tools.set(definition.name, definition)
    },
  }
  ctx.tools = {
    register(definition) {
      tools.set(definition.name, definition)
    },
  }
  return ctx
}

function makeFakeAgent({ id = 'session-fake-1', cwd = 'C:\\work\\repo', events = [] } = {}) {
  const injected = []
  const steered = []
  const session = {
    id,
    header: { cwd },
    events,
  }
  return {
    id,
    session,
    injected,
    steered,
    inject(message) {
      injected.push(message)
    },
    steer(message) {
      steered.push(message)
    },
  }
}

async function flush(times = 8) {
  for (let i = 0; i < times; i++) await new Promise((resolve) => setImmediate(resolve))
}

/** Poll a synchronous predicate; hook dispatch does real fs I/O (transcripts). */
async function waitFor(predicate, timeoutMs = 5000) {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    if (predicate()) return true
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  return predicate()
}

function emit(ctx, name, payload) {
  for (const listener of ctx.listeners.get(name) ?? []) {
    const result = listener(payload)
    if (result && typeof result.then === 'function') result.catch(() => {})
  }
}

// ---------------------------------------------------------------------------
// commands channel (v0.1 regression)
// ---------------------------------------------------------------------------

test.beforeEach(() => {
  commandRegistrations.clear()
})

test('sync registers plugin commands and unregisters them on plugin removal', async () => {
  const ctx = makeCtx()
  const plugin = makePlugin('p1', {
    'hello.md': '---\nname: hello\ndescription: say hello\n---\nHello $ARGUMENTS\n',
  })
  try {
    await syncPluginCommands(ctx, [plugin])
    assert.equal(ctx.registered.has('hello'), true)
    assert.equal(ctx.registered.get('hello').handler !== undefined, true)

    await syncPluginCommands(ctx, [])
    assert.equal(ctx.registered.has('hello'), false)
    assert.deepEqual(ctx.disposals, ['hello'])
  } finally {
    rmSync(plugin.dir, { recursive: true, force: true })
  }
})

test('sync replaces a command when its template changes', async () => {
  const ctx = makeCtx()
  const plugin = makePlugin('p2', {
    'hi.md': '---\nname: hi\ndescription: greeting\n---\nold template',
  })
  try {
    await syncPluginCommands(ctx, [plugin])
    const messages = []
    const agent = {
      followup(message) {
        messages.push(message)
      },
    }
    const first = ctx.registered.get('hi')
    await first.handler({ rawInput: 'x', agent })
    assert.equal(messages[0].content[0].text, 'old template')

    const commandPath = join(plugin.commandsRoot, 'hi.md')
    writeFileSync(commandPath, '---\nname: hi\ndescription: greeting\n---\nnew template', 'utf8')
    await syncPluginCommands(ctx, [plugin])

    assert.equal(ctx.registered.has('hi'), true)
    assert.deepEqual(ctx.disposals, ['hi'])
    const second = ctx.registered.get('hi')
    await second.handler({ rawInput: 'x', agent })
    assert.equal(messages[1].content[0].text, 'new template')
  } finally {
    rmSync(plugin.dir, { recursive: true, force: true })
  }
})

test('commandKey namespaces commands by plugin', () => {
  assert.equal(commandKey('a', 'build'), 'a\0build')
})

// ---------------------------------------------------------------------------
// manifest parsing and channel priority
// ---------------------------------------------------------------------------

test('normalizeDshManifest keeps command hooks and skips unknown events/types', () => {
  const parsed = normalizeDshManifest({
    description: 'x',
    hooks: {
      'tools/pre-execute': [
        {
          matcher: '^(write|edit)$',
          hooks: [
            { type: 'command', command: 'py -3 "${PLUGIN_ROOT}/hook-pre.py"', commandWindows: 'py -3 "${PLUGIN_ROOT}/hook-pre.py"', timeout: 30 },
            { type: 'http', url: 'http://example.invalid' },
          ],
        },
      ],
      'agent/created': [{ hooks: [{ type: 'command', command: 'echo hi' }] }],
      'not/an/event': [{ hooks: [{ type: 'command', command: 'echo no' }] }],
    },
  }, 'C:/plugins/p/hooks/dsh.json')

  assert.equal(parsed.channel, 'dsh')
  assert.equal(parsed.valid, true)
  assert.deepEqual(parsed.events.sort(), ['agent/created', 'tools/pre-execute'])
  assert.equal(parsed.entries.length, 2)
  const pre = parsed.entries.find((entry) => entry.event === 'tools/pre-execute')
  assert.equal(pre.claudeEvent, 'PreToolUse')
  assert.equal(pre.matcher, '^(write|edit)$')
  assert.equal(pre.timeoutMs, 30000)
  assert.equal(pre.commandWindows, 'py -3 "${PLUGIN_ROOT}/hook-pre.py"')
  assert.ok(parsed.skipped.some((item) => item.event === 'not/an/event'))
  assert.ok(parsed.skipped.some((item) => /unsupported hook type/.test(item.reason)))
})

test('normalizeClaudeManifest maps Claude events onto real dsh events', () => {
  const parsed = normalizeClaudeManifest({
    hooks: {
      SessionStart: [{ matcher: '^(startup|resume|clear|compact)$', hooks: [{ type: 'command', command: 'echo start' }] }],
      Stop: [{ hooks: [{ type: 'command', command: 'py -3 "${CLAUDE_PLUGIN_ROOT}/hooks/doc_gate.py"', timeout: 20 }] }],
      PreCompact: [{ hooks: [{ type: 'command', command: 'echo compact' }] }],
    },
  }, 'C:/plugins/p/hooks/hooks.json')

  assert.equal(parsed.valid, true)
  assert.deepEqual(parsed.events.sort(), ['agent/session-start', 'agent/turn-stopping'])
  const stop = parsed.entries.find((entry) => entry.claudeEvent === 'Stop')
  assert.equal(stop.event, 'agent/turn-stopping')
  assert.equal(stop.timeoutMs, 20000)
  assert.ok(parsed.skipped.some((item) => item.event === 'PreCompact'))
})

test('a usable hooks/dsh.json wins and hooks.json is not executed (channel priority)', async () => {
  const plugin = makeHookPlugin('both', {
    dsh: { hooks: { 'tools/pre-execute': [{ hooks: [{ type: 'command', command: 'py -3 pre.py --host dsh' }] }] } },
    claude: { hooks: { PreToolUse: [{ matcher: 'Write', hooks: [{ type: 'command', command: 'py -3 pre.py' }] }] } },
  })
  const config = normalizeHookConfig({})
  try {
    const manifest = await loadPluginHooks(plugin, config)
    assert.equal(manifest.channel, 'dsh')
    assert.equal(manifest.entries.length, 1)
    assert.match(manifest.entries[0].command, /--host dsh/)
    assert.equal(manifest.claudeFileIgnored, true)
    assert.match(manifest.claudeFile, /hooks[\\/]hooks\.json$/)
  } finally {
    rmSync(plugin.dir, { recursive: true, force: true })
  }
})

test('invalid hooks/dsh.json falls back to the Claude-compatible manifest', async () => {
  const plugin = makeHookPlugin('fallback', {
    dsh: { hooks: { 'tools/pre-execute': [{ hooks: [{ type: 'http', url: 'x' }] }] } },
    claude: { hooks: { PreToolUse: [{ matcher: 'Write', hooks: [{ type: 'command', command: 'echo fallback' }] }] } },
  })
  const config = normalizeHookConfig({})
  try {
    const manifest = await loadPluginHooks(plugin, config)
    assert.equal(manifest.channel, 'claude')
    assert.equal(manifest.entries.length, 1)
    assert.ok(manifest.warnings.some((warning) => warning.includes('回退 Claude 兼容通道')))
  } finally {
    rmSync(plugin.dir, { recursive: true, force: true })
  }
})

test('hook manifests hot-reload when the file changes (mtime+size cache)', async () => {
  const plugin = makeHookPlugin('reload', {
    dsh: { hooks: { 'tools/pre-execute': [{ hooks: [{ type: 'command', command: 'echo v1' }] }] } },
  })
  const config = normalizeHookConfig({})
  try {
    const first = await loadPluginHooks(plugin, config)
    assert.match(first.entries[0].command, /v1/)
    writeFileSync(
      join(plugin.dir, 'hooks', 'dsh.json'),
      JSON.stringify({ hooks: { 'tools/post-execute': [{ hooks: [{ type: 'command', command: 'echo version-two' }] }] } }),
      'utf8',
    )
    const second = await loadPluginHooks(plugin, config)
    assert.equal(second.entries[0].event, 'tools/post-execute')
    assert.match(second.entries[0].command, /version-two/)
  } finally {
    rmSync(plugin.dir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// matching, names and stdin payloads
// ---------------------------------------------------------------------------

test('matchHookMatcher uses a regex over the channel-specific subject', () => {
  assert.equal(matchHookMatcher(undefined, 'anything'), true)
  assert.equal(matchHookMatcher('', 'anything'), true)
  assert.equal(matchHookMatcher('*', 'anything'), true)
  assert.equal(matchHookMatcher('^(write|edit)$', 'write'), true)
  assert.equal(matchHookMatcher('^(write|edit)$', 'pwsh'), false)
  assert.equal(matchHookMatcher('Write|Edit', 'Write'), true)
  assert.equal(matchHookMatcher('([unclosed', 'Write'), false)
})

test('claudeToolNameFor maps dsh tool names and honors overrides', () => {
  assert.equal(claudeToolNameFor('write'), 'Write')
  assert.equal(claudeToolNameFor('edit'), 'Edit')
  assert.equal(claudeToolNameFor('read'), 'Read')
  assert.equal(claudeToolNameFor('pwsh'), 'PowerShell')
  assert.equal(claudeToolNameFor('bash'), 'Bash')
  assert.equal(claudeToolNameFor('subagent'), 'Task')
  assert.equal(claudeToolNameFor('some_new_tool'), 'some_new_tool')
  assert.equal(claudeToolNameFor('pwsh', { pwsh: 'Bash' }), 'Bash')
})

test('buildHookCommand expands every plugin-root placeholder form', () => {
  const command = 'echo "${PLUGIN_ROOT}" "$CLAUDE_PLUGIN_ROOT" ${CLAUDE_PLUGIN_ROOT} $PLUGIN_ROOT'
  const expanded = buildHookCommand({ command }, 'C:/vault/plugins/x', 'linux')
  assert.equal(expanded, 'echo "C:/vault/plugins/x" "C:/vault/plugins/x" C:/vault/plugins/x C:/vault/plugins/x')
})

test('buildHookCommand prefers commandWindows on win32 only', () => {
  const entry = { command: 'echo posix', commandWindows: 'echo win' }
  assert.equal(buildHookCommand(entry, 'C:/p', 'win32'), 'echo win')
  assert.equal(buildHookCommand(entry, 'C:/p', 'linux'), 'echo posix')
  assert.equal(buildHookCommand({ command: 'echo posix' }, 'C:/p', 'win32'), 'echo posix')
})

test('DSH-native stdin uses real dsh tool names and the dsh payload shape', () => {
  const canonical = makeSyntheticCanonicalEvent('tools/pre-execute', {
    pluginName: 'project-state',
    pluginDir: 'C:/vault/plugins/project-state',
    toolName: 'write',
    toolInput: { file_path: 'C:/work/a.txt', content: 'x' },
    toolUseId: 'call-1',
    cwd: 'C:/work',
  })
  canonical.sessionId = 'session-abc'
  canonical.dsh = { session_log: 'C:/sessions/x/session.jsonl.zstd', turn: 2, step: 3 }
  const stdin = buildDshStdin(canonical, { dir: 'C:/vault/plugins/project-state' })
  assert.deepEqual(Object.keys(stdin).sort(), [
    'cwd', 'dsh', 'hook_event_name', 'plugin_root', 'prompt', 'reason',
    'session_id', 'source', 'stop_hook_active', 'tool_input', 'tool_name',
    'tool_response', 'tool_use_id',
  ])
  assert.equal(stdin.hook_event_name, 'tools/pre-execute')
  assert.equal(stdin.tool_name, 'write')
  assert.deepEqual(stdin.tool_input, { file_path: 'C:/work/a.txt', content: 'x' })
  assert.equal(stdin.plugin_root, 'C:/vault/plugins/project-state')
  assert.deepEqual(stdin.dsh, { session_log: 'C:/sessions/x/session.jsonl.zstd', turn: 2, step: 3 })
  assert.equal(stdin.tool_response.is_error, false)
})

test('Claude-compatible stdin carries Claude tool names and transcript_path', () => {
  const canonical = makeSyntheticCanonicalEvent('tools/pre-execute', {
    toolName: 'pwsh',
    toolInput: { command: 'Get-ChildItem' },
    transcriptPath: 'C:/tmp/transcript.jsonl',
  })
  canonical.sessionId = 'session-abc'
  const config = normalizeHookConfig({})
  const stdin = buildClaudeStdin(canonical, { claudeEvent: 'PreToolUse' }, config)
  assert.equal(stdin.hook_event_name, 'PreToolUse')
  assert.equal(stdin.tool_name, 'PowerShell')
  assert.deepEqual(stdin.tool_input, { command: 'Get-ChildItem' })
  assert.equal(stdin.transcript_path, 'C:/tmp/transcript.jsonl')
  assert.equal(stdin.cwd, process.cwd())
})

// ---------------------------------------------------------------------------
// output protocol
// ---------------------------------------------------------------------------

test('parseHookOutput handles exit codes, decisions and contexts', () => {
  const exit2 = parseHookOutput({ stdout: 'ignored', stderr: 'blocked by exit 2', exitCode: 2, eventName: 'PreToolUse' })
  assert.equal(exit2.block, true)
  assert.equal(exit2.reason, 'blocked by exit 2')

  const other = parseHookOutput({ stdout: '', stderr: 'boom', exitCode: 1, eventName: 'PreToolUse' })
  assert.equal(other.error, true)
  assert.equal(other.block, false)

  const deny = parseHookOutput({
    stdout: JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: 'no writes today' } }),
    stderr: '',
    exitCode: 0,
    eventName: 'PreToolUse',
  })
  assert.equal(deny.block, true)
  assert.equal(deny.reason, 'no writes today')

  const ask = parseHookOutput({
    stdout: JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'ask' } }),
    stderr: '',
    exitCode: 0,
    eventName: 'PreToolUse',
  })
  assert.equal(ask.ask, true)

  const stop = parseHookOutput({
    stdout: JSON.stringify({ decision: 'block', reason: 'docs missing' }),
    stderr: '',
    exitCode: 0,
    eventName: 'Stop',
  })
  assert.equal(stop.block, true)
  assert.equal(stop.reason, 'docs missing')

  const ctxOut = parseHookOutput({
    stdout: JSON.stringify({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: 'remember the blueprint' } }),
    stderr: '',
    exitCode: 0,
    eventName: 'SessionStart',
  })
  assert.deepEqual(ctxOut.contexts, ['remember the blueprint'])

  const text = parseHookOutput({ stdout: 'plain session context', stderr: '', exitCode: 0, eventName: 'SessionStart' })
  assert.deepEqual(text.contexts, ['plain session context'])

  const postText = parseHookOutput({ stdout: 'plain post text', stderr: '', exitCode: 0, eventName: 'PostToolUse' })
  assert.deepEqual(postText.contexts, [])

  const cont = parseHookOutput({ stdout: JSON.stringify({ continue: false }), stderr: '', exitCode: 0, eventName: 'PreToolUse' })
  assert.equal(cont.continueFalse, true)
})

test('aggregatePreToolOutcomes: deny beats ask, continue:false denies, otherwise allow', () => {
  const allowOutcome = { parsed: { block: false, ask: false, continueFalse: false, contexts: [] } }
  const denyOutcome = { parsed: { block: true, ask: false, continueFalse: false, reason: 'nope', contexts: [] }, command: 'x' }
  const askOutcome = { parsed: { block: false, ask: true, continueFalse: false, reason: 'sure?', contexts: [] } }
  assert.deepEqual(aggregatePreToolOutcomes([allowOutcome]), { kind: 'allow' })
  assert.deepEqual(aggregatePreToolOutcomes([allowOutcome, denyOutcome, askOutcome]), { kind: 'deny', reason: 'nope' })
  assert.deepEqual(aggregatePreToolOutcomes([allowOutcome, askOutcome]), { kind: 'ask', reason: 'sure?' })
  assert.equal(aggregatePreToolOutcomes([{ parsed: { block: false, continueFalse: true, reason: 'stop' } }]).kind, 'deny')
})

test('aggregatePostToolOutcomes: block becomes feedback, contexts survive', () => {
  const blocked = aggregatePostToolOutcomes([{ parsed: { block: true, reason: 'bad result' } }])
  assert.deepEqual(blocked, { kind: 'block', feedback: [{ type: 'text', text: 'bad result' }] })
  const contexts = aggregatePostToolOutcomes([{ parsed: { block: false, contexts: ['note a'] } }, { parsed: { block: false, contexts: ['note b'] } }])
  assert.deepEqual(contexts, { kind: 'contexts', contexts: ['note a', 'note b'] })
  assert.equal(aggregatePostToolOutcomes([{ parsed: { block: false, contexts: [] } }]), null)
})

// ---------------------------------------------------------------------------
// Stop gate (stop_hook_active equivalent)
// ---------------------------------------------------------------------------

test('StopGate blocks once per turn and then reports stop_hook_active', () => {
  const gate = new StopGate(1)
  assert.deepEqual(gate.inspect('a', 1), { stopHookActive: false, blocks: 0 })
  gate.recordBlock('a', 1)
  assert.deepEqual(gate.inspect('a', 1), { stopHookActive: true, blocks: 1 })
  assert.deepEqual(gate.inspect('a', 2), { stopHookActive: false, blocks: 0 })
  gate.prune('a')
  assert.deepEqual(gate.inspect('a', 1), { stopHookActive: false, blocks: 0 })
})

// ---------------------------------------------------------------------------
// durable session-log decoding and Claude transcript synthesis
// ---------------------------------------------------------------------------

test('projectKey/encodeSegment/sessionLogCandidates mirror the jsonl backend layout', () => {
  assert.equal(projectKey('D:\\sandbox\\tester\\treasury'), '--D-sandbox-tester-treasury--')
  assert.equal(projectKey('D:\\sandbox\\tester\\Obsidian Vault'), '--D-sandbox-tester-Obsidian~0020Vault--')
  assert.equal(encodeSegment('session-d00c6464'), 'session-d00c6464')
  assert.equal(encodeSegment('..'), '~002E~002E')
  assert.deepEqual(sessionLogCandidates('C:/sessions', 'C:\\work', 's1'), [
    join('C:/sessions', '--C-work--', 's1', 'session.jsonl.zstd'),
    join('C:/sessions', '--C-work--', 's1', 'session.jsonl'),
  ])
})

test('real captured dsh session log decodes and synthesizes a Claude transcript', async () => {
  const buffer = readFileSync(FIXTURE_LOG)
  const text = decodeSessionLog(buffer)
  const { header, events } = parseSessionLogLines(text)
  assert.equal(header.type, 'session')
  assert.equal(typeof header.id, 'string')
  assert.equal(header.cwd, 'C:\\work\\fixture-repo')
  assert.ok(events.length > 10)
  assert.ok(events.every((event) => typeof event.seq === 'number' || typeof event.seq0 === 'number'))
  assert.ok(events.some((event) => event.type === 'assistant/message'))
  assert.ok(events.some((event) => event.type === 'tool/result'))

  const rows = eventsToClaudeRows(events, { cwd: header.cwd, sessionId: header.id })
  assert.ok(rows.length > 4)

  // Human prompt detection (vibe-flow locate.is_human_prompt equivalent).
  const human = rows.find((row) => row.type === 'user' && !row.isMeta && typeof row.message.content === 'string')
  assert.ok(human)
  assert.equal(human.origin.kind, 'human')
  assert.ok(!human.message.content.startsWith('<'))

  // Injected dsh context must stay a meta row (never a human prompt).
  const meta = rows.find((row) => row.type === 'user' && row.isMeta === true)
  assert.ok(meta)

  // Tool calls carry a Claude-style block with parsed input.
  const toolUse = rows
    .filter((row) => row.type === 'assistant')
    .flatMap((row) => row.message.content)
    .find((block) => block.type === 'tool_use')
  assert.ok(toolUse)
  assert.equal(typeof toolUse.name, 'string')
  assert.ok(toolUse.name.length > 0)
  assert.equal(typeof toolUse.input, 'object')
  assert.equal(typeof toolUse.id, 'string')
  // The captured e2e session used read/edit/pwsh; names must be Claude names.
  const toolNames = new Set(
    rows.filter((row) => row.type === 'assistant').flatMap((row) => row.message.content)
      .filter((block) => block.type === 'tool_use').map((block) => block.name),
  )
  assert.ok(toolNames.has('Edit') || toolNames.has('Read') || toolNames.has('PowerShell'), `tool names: ${[...toolNames]}`)

  // Tool results pair with the call id and carry is_error when dsh said so.
  const results = rows
    .filter((row) => row.type === 'user' && Array.isArray(row.message.content))
    .flatMap((row) => row.message.content)
    .filter((block) => block.type === 'tool_result')
  assert.ok(results.length > 0)
  assert.ok(results.every((block) => typeof block.tool_use_id === 'string' && typeof block.content === 'string'))

  // Every row has a parseable timestamp and the session id.
  for (const row of rows) {
    assert.equal(row.sessionId, header.id)
    assert.equal(row.cwd, header.cwd)
    assert.ok(!Number.isNaN(Date.parse(row.timestamp)))
  }
})

test('readSessionLogEvents resolves the durable log path and decodes it', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-loader-log-'))
  try {
    const root = join(dir, 'sessions')
    const cwd = 'C:\\work\\fixture-repo'
    const id = 'session-fixture'
    const target = sessionLogCandidates(root, cwd, id)[0]
    mkdirSync(join(target, '..'), { recursive: true })
    writeFileSync(target, readFileSync(FIXTURE_LOG))
    const { findSessionLog } = await import('./dsh-claude-plugin-loader.mjs')
    assert.equal(await findSessionLog(root, cwd, id), target)
    const { header, events } = await readSessionLogEvents(target)
    assert.equal(header.id, 'session-fixture-0001')
    assert.ok(events.length > 0)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('TranscriptCache mirrors events exactly once and materializes a file', async () => {
  const config = normalizeHookConfig({ transcript: 'auto' })
  const cache = new TranscriptCache(config)
  const agent = makeFakeAgent({ id: 'session-cache', events: [] })
  const entry = cache.ensure(agent)
  assert.ok(entry)
  const event = {
    type: 'user/message',
    seq: 7,
    time: Date.now(),
    data: { id: 'm1', role: 'user', content: [{ type: 'text', text: 'hello' }], source: { kind: 'user' } },
  }
  cache.appendEvent(agent.session, event)
  const path = await cache.materialize(agent)
  assert.ok(existsSync(path))
  const lines = readFileSync(path, 'utf8').trim().split('\n')
  assert.equal(lines.length, 1)
  assert.equal(JSON.parse(lines[0]).message.content, 'hello')

  // A duplicate seq (session/event and seeding overlap) is ignored.
  cache.appendEvent(agent.session, event)
  await cache.materialize(agent)
  assert.equal(readFileSync(path, 'utf8').trim().split('\n').length, 1)

  // transcript: 'off' disables synthesis entirely.
  const offCache = new TranscriptCache(normalizeHookConfig({ transcript: 'off' }))
  assert.equal(offCache.ensure(makeFakeAgent({ id: 'x' })), null)
  assert.equal(await offCache.materialize(makeFakeAgent({ id: 'x' })), null)
})

// ---------------------------------------------------------------------------
// end-to-end bridge wiring with a scripted subprocess seam
// ---------------------------------------------------------------------------

const PRE_DENY_DOC = {
  hooks: {
    'tools/pre-execute': [
      {
        matcher: '^(write|edit)$',
        hooks: [{ type: 'command', command: 'py -3 "${PLUGIN_ROOT}/hook-pre.py"', timeout: 30 }],
      },
    ],
    'tools/post-execute': [
      { hooks: [{ type: 'command', command: 'py -3 "${PLUGIN_ROOT}/hook-post.py"' }] },
    ],
    'agent/session-start': [
      { matcher: '^(startup|resume|clear|compact)$', hooks: [{ type: 'command', command: 'py -3 "${PLUGIN_ROOT}/hook-start.py"' }] },
    ],
    'agent/inbox/inserted': [
      { hooks: [{ type: 'command', command: 'py -3 "${PLUGIN_ROOT}/hook-prompt.py"' }] },
    ],
    'agent/turn-stopping': [
      { hooks: [{ type: 'command', command: 'py -3 "${PLUGIN_ROOT}/hook-stop.py"' }] },
    ],
    'agent/disposed': [
      { hooks: [{ type: 'command', command: 'py -3 "${PLUGIN_ROOT}/hook-end.py"' }] },
    ],
  },
}

function installBridge(ctx, plugins, config = {}) {
  const normalized = normalizeHookConfig({
    sessionRoot: join(tmpdir(), 'dsh-loader-no-sessions'),
    hookLog: false,
    ...config,
  })
  const state = installHooks(ctx, normalized, async () => plugins)
  return { state, config: normalized }
}

test('bridge: SessionStart / UserPromptSubmit inject context, PreToolUse denies, PostToolUse blocks, Stop steers once', async () => {
  const plugin = makeHookPlugin('e2e', { dsh: PRE_DENY_DOC })
  const ctx = makeBridgeCtx(({ stdin, argv }) => {
    const payload = JSON.parse(stdin)
    const command = argv.join(' ')
    if (command.includes('hook-start.py')) {
      return { stdout: JSON.stringify({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: 'start-context' } }) }
    }
    if (command.includes('hook-prompt.py')) {
      return { stdout: 'prompt-context' }
    }
    if (command.includes('hook-pre.py')) {
      if (payload.tool_name === 'write') {
        return { stdout: JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: 'no writes' } }) }
      }
      return { stdout: '' }
    }
    if (command.includes('hook-post.py')) {
      return { stdout: JSON.stringify({ decision: 'block', reason: 'post says no' }) }
    }
    if (command.includes('hook-stop.py')) {
      if (payload.stop_hook_active) return { stdout: '' }
      return { stdout: JSON.stringify({ decision: 'block', reason: 'docs stale' }) }
    }
    if (command.includes('hook-end.py')) return { stdout: '' }
    return { stdout: '' }
  })
  const agent = makeFakeAgent({ id: 'session-bridge', cwd: 'C:\\work\\repo' })
  try {
    installBridge(ctx, [plugin])

    // 1) SessionStart
    emit(ctx, 'agent/session-start', { agent, source: 'startup' })
    assert.ok(await waitFor(() => agent.injected.some((message) => message.content[0].text.includes('start-context'))))
    const startSpawn = ctx.spawns.find((spawn) => spawn.spec.argv.join(' ').includes('hook-start.py'))
    assert.ok(startSpawn)
    const startPayload = JSON.parse(startSpawn.stdin)
    assert.equal(startPayload.hook_event_name, 'agent/session-start')
    assert.equal(startPayload.source, 'startup')
    assert.equal(startPayload.plugin_root, plugin.dir)
    // The plugin's own directory is exported, nothing else is added to env.
    assert.equal(startSpawn.spec.env.PLUGIN_ROOT, plugin.dir)
    assert.equal(startSpawn.spec.env.CLAUDE_PLUGIN_ROOT, plugin.dir)
    assert.equal(startSpawn.spec.env.DSH_HOST, 'dsh')

    // 2) UserPromptSubmit: only human prompts, never our injected context.
    emit(ctx, 'agent/inbox/inserted', {
      agent,
      message: { id: 'm1', source: { kind: 'user' }, content: [{ type: 'text', text: 'do the thing' }] },
    })
    assert.ok(await waitFor(() => agent.injected.some((message) => message.content[0].text.includes('prompt-context'))))
    const promptSpawn = ctx.spawns.find((spawn) => spawn.spec.argv.join(' ').includes('hook-prompt.py'))
    assert.ok(promptSpawn)
    assert.equal(JSON.parse(promptSpawn.stdin).prompt, 'do the thing')
    const spawnCount = ctx.spawns.length
    emit(ctx, 'agent/inbox/inserted', {
      agent,
      message: { id: 'm2', source: { kind: 'plugin', plugin: 'x' }, content: [{ type: 'text', text: 'injected' }] },
    })
    await flush()
    assert.equal(ctx.spawns.length, spawnCount)

    // 3) PreToolUse: matcher regex is applied against the dsh-native name and
    //    a deny decision becomes a real PreToolDecision.
    const preContext = []
    const exec = { name: 'write', arguments: { file_path: 'C:\\work\\repo\\a.txt', content: 'x' }, callId: 'call-1', agent, signal: new AbortController().signal }
    const deny = await ctx.listeners.get('tools/pre-execute')[0](exec, async () => {
      preContext.push('next')
      return { kind: 'allow' }
    })
    assert.deepEqual(deny, { kind: 'deny', reason: 'no writes' })
    assert.deepEqual(preContext, [])
    const prePayload = JSON.parse(ctx.spawns.find((spawn) => spawn.spec.argv.join(' ').includes('hook-pre.py')).stdin)
    assert.equal(prePayload.hook_event_name, 'tools/pre-execute')
    assert.equal(prePayload.tool_name, 'write')
    assert.equal(prePayload.tool_use_id, 'call-1')
    assert.deepEqual(prePayload.tool_input, { file_path: 'C:\\work\\repo\\a.txt', content: 'x' })

    // A non-matching tool name goes through next().
    const readDecision = await ctx.listeners.get('tools/pre-execute')[0]({ ...exec, name: 'read', callId: 'call-2' }, async () => ({ kind: 'allow' }))
    assert.deepEqual(readDecision, { kind: 'allow' })

    // 4) PostToolUse: block turns into corrective feedback.
    const postDecision = await ctx.listeners.get('tools/post-execute')[0](
      { ...exec, name: 'bash' },
      { isError: false, content: [{ type: 'text', text: 'ok' }], value: { ok: true } },
      async () => ({ kind: 'accept' }),
    )
    assert.deepEqual(postDecision, { kind: 'block', feedback: [{ type: 'text', text: 'post says no' }] })
    const postPayload = JSON.parse(ctx.spawns.find((spawn) => spawn.spec.argv.join(' ').includes('hook-post.py')).stdin)
    assert.equal(postPayload.hook_event_name, 'tools/post-execute')
    assert.equal(postPayload.tool_response.is_error, false)

    // 5) Stop: first pass steers, and the same turn never steers twice.
    await ctx.listeners.get('agent/turn-stopping')[0]({ agent, turn: 4, signal: new AbortController().signal })
    assert.equal(agent.steered.length, 1)
    assert.match(agent.steered[0].content[0].text, /docs stale/)
    const secondSpawnFrom = ctx.spawns.length
    await ctx.listeners.get('agent/turn-stopping')[0]({ agent, turn: 4, signal: new AbortController().signal })
    assert.equal(agent.steered.length, 1)
    const secondStopSpawn = ctx.spawns[secondSpawnFrom].stdin
    assert.equal(JSON.parse(secondStopSpawn).stop_hook_active, true)

    // A new turn is a fresh gate.
    await ctx.listeners.get('agent/turn-stopping')[0]({ agent, turn: 5, signal: new AbortController().signal })
    assert.equal(agent.steered.length, 2)

    // 6) SessionEnd fires the disposed hook.
    const beforeDispose = ctx.spawns.length
    emit(ctx, 'agent/disposed', { agent })
    assert.ok(await waitFor(() => ctx.spawns.length > beforeDispose))
    assert.ok(ctx.spawns.some((spawn) => spawn.spec.argv.join(' ').includes('hook-end.py')))
  } finally {
    rmSync(plugin.dir, { recursive: true, force: true })
  }
})

test('bridge: Claude-compatible channel receives Claude tool names, transcript_path and CLAUDE_PLUGIN_ROOT', async () => {
  const plugin = makeHookPlugin('claude-channel', {
    claude: {
      hooks: {
        PreToolUse: [
          { matcher: '^Write$', hooks: [{ type: 'command', command: 'py -3 "${CLAUDE_PLUGIN_ROOT}/claude-pre.py"' }] },
        ],
      },
    },
  })
  const ctx = makeBridgeCtx(() => ({ stdout: '' }))
  const agent = makeFakeAgent({ id: 'session-claude', cwd: 'C:\\work\\repo' })
  try {
    installBridge(ctx, [plugin])
    const decision = await ctx.listeners.get('tools/pre-execute')[0](
      { name: 'write', arguments: { file_path: 'C:\\work\\repo\\a.txt', content: 'x' }, callId: 'call-9', agent, signal: new AbortController().signal },
      async () => ({ kind: 'allow' }),
    )
    assert.deepEqual(decision, { kind: 'allow' })
    assert.equal(ctx.spawns.length, 1)
    const payload = JSON.parse(ctx.spawns[0].stdin)
    assert.equal(payload.hook_event_name, 'PreToolUse')
    assert.equal(payload.tool_name, 'Write')
    assert.equal(payload.session_id, 'session-claude')
    assert.equal(payload.cwd, 'C:\\work\\repo')
    assert.ok(typeof payload.transcript_path === 'string' && payload.transcript_path.endsWith('transcript.jsonl'))
    assert.ok(existsSync(payload.transcript_path))
    assert.equal(ctx.spawns[0].spec.env.CLAUDE_PLUGIN_ROOT, plugin.dir)
    // The Claude name also drives the matcher: `write` is not `Write`.
    assert.equal(ctx.spawns.length, 1)
    await ctx.listeners.get('tools/pre-execute')[0](
      { name: 'read', arguments: { file_path: 'C:\\work\\repo\\a.txt' }, callId: 'call-10', agent, signal: new AbortController().signal },
      async () => ({ kind: 'allow' }),
    )
    assert.equal(ctx.spawns.length, 1)
  } finally {
    rmSync(plugin.dir, { recursive: true, force: true })
  }
})

test('bridge: hook timeout allows the call by default and denies with failClosed', async () => {
  const plugin = makeHookPlugin('timeout', {
    dsh: { hooks: { 'tools/pre-execute': [{ hooks: [{ type: 'command', command: 'slow-hook', timeout: 1 }] }] } },
  })
  const slowCtx = makeBridgeCtx(() => ({ stdout: '' }))
  // A handle whose done never settles before the timeout.
  const hangingHandle = {
    pid: 1,
    stdin: undefined,
    stdout: undefined,
    stderr: undefined,
    collected: { stdout: { readFrom: () => ({ text: '', nextOffset: 0, lossy: false }) }, stderr: { readFrom: () => ({ text: '', nextOffset: 0, lossy: false }) } },
    done: new Promise(() => {}),
    terminate() {},
    async waitForExit() {
      return false
    },
  }
  slowCtx.subprocess.spawn = () => hangingHandle
  const agent = makeFakeAgent({ id: 'session-timeout' })
  try {
    installBridge(slowCtx, [plugin], { hookTimeoutMs: 30 })
    const decision = await slowCtx.listeners.get('tools/pre-execute')[0](
      { name: 'write', arguments: {}, callId: 'c', agent, signal: new AbortController().signal },
      async () => ({ kind: 'allow' }),
    )
    assert.deepEqual(decision, { kind: 'allow' })

    const closedCtx = makeBridgeCtx(() => ({ stdout: '' }))
    closedCtx.subprocess.spawn = () => hangingHandle
    installBridge(closedCtx, [plugin], { hookTimeoutMs: 30, failClosed: true })
    const closed = await closedCtx.listeners.get('tools/pre-execute')[0](
      { name: 'write', arguments: {}, callId: 'c', agent, signal: new AbortController().signal },
      async () => ({ kind: 'allow' }),
    )
    assert.equal(closed.kind, 'deny')
    assert.match(closed.reason, /failClosed/)
  } finally {
    rmSync(plugin.dir, { recursive: true, force: true })
  }
})

test('bridge: hooksEnabled=false disables the bridge; sessionStartHooks=false only disables SessionStart', async () => {
  const plugin = makeHookPlugin('flags', { dsh: PRE_DENY_DOC })
  const ctx = makeBridgeCtx(() => ({ stdout: '' }))
  const agent = makeFakeAgent({ id: 'session-flags' })
  try {
    installBridge(ctx, [plugin], { hooksEnabled: false })
    emit(ctx, 'agent/session-start', { agent, source: 'startup' })
    await flush(20)
    await ctx.listeners.get('tools/pre-execute')[0]({ name: 'write', arguments: {}, callId: 'c', agent, signal: new AbortController().signal }, async () => ({ kind: 'allow' }))
    assert.equal(ctx.spawns.length, 0)

    const scoped = makeBridgeCtx(() => ({ stdout: '' }))
    const agent2 = makeFakeAgent({ id: 'session-flags-2' })
    installBridge(scoped, [plugin], { sessionStartHooks: false })
    emit(scoped, 'agent/session-start', { agent: agent2, source: 'startup' })
    await flush(20)
    assert.equal(scoped.spawns.length, 0)
    await scoped.listeners.get('tools/pre-execute')[0]({ name: 'write', arguments: {}, callId: 'c', agent: agent2, signal: new AbortController().signal }, async () => ({ kind: 'allow' }))
    assert.equal(scoped.spawns.length, 1)
  } finally {
    rmSync(plugin.dir, { recursive: true, force: true })
  }
})

test('bridge: a plugin with hooks/dsh.json never runs its hooks/hooks.json', async () => {
  const plugin = makeHookPlugin('priority-bridge', {
    dsh: { hooks: { 'tools/pre-execute': [{ hooks: [{ type: 'command', command: 'py -3 dsh-pre.py' }] }] } },
    claude: { hooks: { PreToolUse: [{ hooks: [{ type: 'command', command: 'py -3 claude-pre.py' }] }] } },
  })
  const ctx = makeBridgeCtx(() => ({ stdout: '' }))
  const agent = makeFakeAgent({ id: 'session-priority' })
  try {
    installBridge(ctx, [plugin])
    await ctx.listeners.get('tools/pre-execute')[0]({ name: 'write', arguments: {}, callId: 'c', agent, signal: new AbortController().signal }, async () => ({ kind: 'allow' }))
    assert.equal(ctx.spawns.length, 1)
    assert.match(ctx.spawns[0].spec.argv.join(' '), /dsh-pre\.py/)
    assert.doesNotMatch(ctx.spawns[0].spec.argv.join(' '), /claude-pre\.py/)
  } finally {
    rmSync(plugin.dir, { recursive: true, force: true })
  }
})

test('normalizeHookConfig applies defaults and overrides', () => {
  const defaults = normalizeHookConfig({})
  assert.equal(defaults.hooksEnabled, true)
  assert.equal(defaults.claudeHooks, true)
  assert.equal(defaults.dshHooks, true)
  assert.equal(defaults.sessionStartHooks, true)
  assert.equal(defaults.transcript, 'auto')
  assert.equal(defaults.defaultTimeoutMs, 60000)
  assert.equal(defaults.failClosed, false)
  assert.equal(defaults.maxStopBlocksPerTurn, 1)

  const custom = normalizeHookConfig({
    hooksEnabled: false,
    claudeHooks: false,
    dshHooks: false,
    sessionStartHooks: false,
    transcript: 'off',
    hookTimeoutMs: 1234,
    failClosed: true,
    maxStopBlocksPerTurn: 3,
    sessionRoot: 'C:/tmp/sessions',
    claudeToolNames: { pwsh: 'Bash' },
  })
  assert.equal(custom.hooksEnabled, false)
  assert.equal(custom.claudeHooks, false)
  assert.equal(custom.dshHooks, false)
  assert.equal(custom.sessionStartHooks, false)
  assert.equal(custom.transcript, 'off')
  assert.equal(custom.defaultTimeoutMs, 1234)
  assert.equal(custom.failClosed, true)
  assert.equal(custom.maxStopBlocksPerTurn, 3)
  assert.equal(custom.sessionRoot, 'C:\\tmp\\sessions')
  assert.deepEqual(custom.claudeToolNames, { pwsh: 'Bash' })
})

// ---------------------------------------------------------------------------
// Windows command construction (cmd.exe mangles singly-quoted argv)
// ---------------------------------------------------------------------------

test('splitHookCommand keeps quoted words whole and Windows paths intact', () => {
  assert.deepEqual(splitHookCommand('py -3 "C:\\a b\\x.py" --event e'), ['py', '-3', 'C:\\a b\\x.py', '--event', 'e'])
  assert.deepEqual(splitHookCommand("python3 '/opt/x y/z.py'"), ['python3', '/opt/x y/z.py'])
  assert.deepEqual(splitHookCommand('   '), [])
  assert.deepEqual(splitHookCommand('py -3 "C:\\p\\q.py"'), ['py', '-3', 'C:\\p\\q.py'])
})

test('buildHookArgv spawns plain commands directly, shells metacharacters, and honors shell:bash', () => {
  const direct = buildHookArgv({ shell: null }, 'py -3 "C:\\vault\\plugins\\x\\hook.py" --event tools/pre-execute', {}, 'win32')
  assert.deepEqual(direct.argv, ['py', '-3', 'C:\\vault\\plugins\\x\\hook.py', '--event', 'tools/pre-execute'])
  assert.equal(direct.error, null)

  const piped = buildHookArgv({ shell: null }, 'Get-Content a.txt | Select-Object -First 1', {}, 'win32')
  assert.deepEqual(piped.argv.slice(0, 4), ['powershell.exe', '-NoProfile', '-NonInteractive', '-Command'])

  const bash = buildHookArgv(
    { shell: 'bash' },
    'if command -v py >/dev/null 2>&1; then py -3 "${PLUGIN_ROOT}/hooks/x.py"; fi',
    {},
    'win32',
  )
  assert.ok(bash.argv, bash.error)
  assert.match(bash.argv[0].toLowerCase(), /bash\.exe$/)
  assert.equal(bash.argv[1], '-c')

  const posix = buildHookArgv({ shell: null }, 'echo hi', {}, 'linux')
  assert.deepEqual(posix.argv, ['/bin/sh', '-c', 'echo hi'])
})

test('window hooks.json shell:bash commands resolve through a real Bash (not WSL)', () => {
  const vibeFlow = 'if command -v py >/dev/null 2>&1; then py -3 "${CLAUDE_PLUGIN_ROOT}/hooks/doc_gate.py"; else python3 "${CLAUDE_PLUGIN_ROOT}/hooks/doc_gate.py"; fi'
  const built = buildHookArgv({ shell: 'bash' }, buildHookCommand({ command: vibeFlow }, 'C:/plugins/vibe-flow', 'win32'), {}, 'win32')
  assert.ok(built.argv)
  assert.doesNotMatch(built.argv[0], /System32/i)
})

test('inferSourceAtCreation infers resume from a seeded session and startup from an empty one', () => {
  assert.equal(inferSourceAtCreation({ session: { events: [], firstLiveSeq: 0, header: {} } }), 'startup')
  assert.equal(inferSourceAtCreation({ session: { events: [{ seq: 0 }], firstLiveSeq: 3, header: { seedLength: 3 } } }), 'resume')
  assert.equal(inferSourceAtCreation({ session: { events: [], firstLiveSeq: 0, header: { seedLength: 2 } } }), 'resume')
  assert.equal(inferSourceAtCreation(null), 'startup')
})

// ---------------------------------------------------------------------------
// session-start dual-event gate (agent/created + agent/session-start)
// ---------------------------------------------------------------------------

const STARTUP_DOC = {
  hooks: {
    'agent/created': [
      { matcher: '^(startup|resume|clear|compact)$', hooks: [{ type: 'command', command: 'py -3 created-start.py' }] },
    ],
    'agent/session-start': [
      { matcher: '^(startup|resume|clear|compact)$', hooks: [{ type: 'command', command: 'py -3 session-start.py' }] },
    ],
  },
}

function startupPayloads(ctx) {
  return ctx.spawns
    .filter((spawn) => /created-start\.py|session-start\.py/.test(spawn.spec.argv.join(' ')))
    .map((spawn) => JSON.parse(spawn.stdin))
}

test('startup gate: agent/created only dispatches both groups once after the grace window', async () => {
  const plugin = makeHookPlugin('gate-created-only', { dsh: STARTUP_DOC })
  const ctx = makeBridgeCtx(() => ({ stdout: '' }))
  const agent = makeFakeAgent({ id: 'session-gate-1' })
  try {
    installBridge(ctx, [plugin], { startupGraceMs: 30 })
    emit(ctx, 'agent/created', { agent })
    assert.ok(await waitFor(() => startupPayloads(ctx).length >= 2, 3000))
    await new Promise((resolve) => setTimeout(resolve, 80))
    const payloads = startupPayloads(ctx)
    assert.equal(payloads.length, 2)
    assert.deepEqual(payloads.map((payload) => payload.hook_event_name).sort(), ['agent/created', 'agent/session-start'])
    for (const payload of payloads) assert.equal(payload.source, 'startup')
  } finally {
    rmSync(plugin.dir, { recursive: true, force: true })
  }
})

test('startup gate: agent/session-start wins the source and still runs the created group exactly once', async () => {
  const plugin = makeHookPlugin('gate-both', { dsh: STARTUP_DOC })
  const ctx = makeBridgeCtx(() => ({ stdout: '' }))
  const agent = makeFakeAgent({ id: 'session-gate-2' })
  try {
    installBridge(ctx, [plugin], { startupGraceMs: 60 })
    emit(ctx, 'agent/created', { agent })
    emit(ctx, 'agent/session-start', { agent, source: 'compact' })
    assert.ok(await waitFor(() => startupPayloads(ctx).length >= 2, 3000))
    await new Promise((resolve) => setTimeout(resolve, 120))
    const payloads = startupPayloads(ctx)
    assert.equal(payloads.length, 2)
    for (const payload of payloads) assert.equal(payload.source, 'compact')
  } finally {
    rmSync(plugin.dir, { recursive: true, force: true })
  }
})

test('startup gate: session-start alone dispatches immediately with its own source', async () => {
  const plugin = makeHookPlugin('gate-session-only', { dsh: STARTUP_DOC })
  const ctx = makeBridgeCtx(() => ({ stdout: '' }))
  const agent = makeFakeAgent({ id: 'session-gate-3' })
  try {
    installBridge(ctx, [plugin], { startupGraceMs: 5000 })
    emit(ctx, 'agent/session-start', { agent, source: 'resume' })
    assert.ok(await waitFor(() => startupPayloads(ctx).length >= 2, 3000))
    for (const payload of startupPayloads(ctx)) assert.equal(payload.source, 'resume')
  } finally {
    rmSync(plugin.dir, { recursive: true, force: true })
  }
})

test('startup gate: a late duplicate session-start never re-runs the startup hooks', async () => {
  const plugin = makeHookPlugin('gate-dedupe', { dsh: STARTUP_DOC })
  const ctx = makeBridgeCtx(() => ({ stdout: '' }))
  const agent = makeFakeAgent({ id: 'session-gate-4' })
  try {
    const { state } = installBridge(ctx, [plugin], { startupGraceMs: 20 })
    emit(ctx, 'agent/created', { agent })
    assert.ok(await waitFor(() => startupPayloads(ctx).length >= 2, 3000))
    assert.equal(JSON.parse(ctx.spawns.find((spawn) => /created-start\.py/.test(spawn.spec.argv.join(' '))).stdin).source, 'startup')
    emit(ctx, 'agent/session-start', { agent, source: 'resume' })
    await new Promise((resolve) => setTimeout(resolve, 80))
    assert.equal(startupPayloads(ctx).length, 2)
    assert.equal(state.startupGates.get('session-gate-4').source, 'startup')
  } finally {
    rmSync(plugin.dir, { recursive: true, force: true })
  }
})

test('startup gate: pstate-style agent/created with a source matcher still matches', async () => {
  const plugin = makeHookPlugin('gate-pstate', {
    dsh: {
      hooks: {
        'agent/created': [
          { matcher: '^(startup|resume|clear|compact)$', hooks: [{ type: 'command', command: 'py -3 pstate-start.py' }] },
        ],
      },
    },
  })
  const ctx = makeBridgeCtx(() => ({ stdout: '' }))
  const agent = makeFakeAgent({ id: 'session-gate-5' })
  try {
    installBridge(ctx, [plugin], { startupGraceMs: 20 })
    emit(ctx, 'agent/created', { agent })
    assert.ok(await waitFor(() => ctx.spawns.length > 0, 3000))
    const payload = JSON.parse(ctx.spawns[0].stdin)
    assert.equal(payload.hook_event_name, 'agent/created')
    assert.equal(payload.source, 'startup')
  } finally {
    rmSync(plugin.dir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// bounded, externally verifiable hook execution log
// ---------------------------------------------------------------------------

test('redactHookText removes credential-shaped fragments', () => {
  const text = redactHookText('key sk-abcdef123456 and DEEPSEEK_API_KEY=supersecret Bearer abcdefghijklmnop token: zzzz')
  assert.doesNotMatch(text, /sk-abcdef123456/)
  assert.doesNotMatch(text, /supersecret/)
  assert.doesNotMatch(text, /abcdefghijklmnop/)
  assert.match(text, /<redacted/)
})

test('defaultHookLogPath is under the harness state directory and per-profile', () => {
  const path = defaultHookLogPath('desktop')
  assert.match(path, /claude-plugin-loader/)
  assert.match(path, /hooks-desktop\.jsonl$/)
  assert.match(defaultHookLogPath(undefined), /hooks\.jsonl$|[\\/]hooks[^\\/]*\.jsonl$/)
})

test('HookLog appends JSONL records and rotates at the size bound', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-loader-log-'))
  try {
    const path = join(dir, 'hooks.jsonl')
    const log = new HookLog({ hookLog: true, hookLogPath: path, hookLogMaxBytes: 4096 })
    for (let i = 0; i < 40; i++) {
      await log.record({ i, stdout: 'x'.repeat(120) })
    }
    await log.flush()
    assert.equal(existsSync(path), true)
    assert.equal(existsSync(`${path}.1`), true)
    const current = readFileSync(path, 'utf8').trim().split('\n').filter(Boolean)
    assert.ok(current.length > 0 && current.length < 40)
    for (const line of current) JSON.parse(line)

    const offLog = new HookLog({ hookLog: false, hookLogPath: join(dir, 'off.jsonl'), hookLogMaxBytes: 4096 })
    await offLog.record({ nope: true })
    await offLog.flush()
    assert.equal(existsSync(join(dir, 'off.jsonl')), false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('bridge writes one redacted hook-log line per executed hook', async () => {
  const plugin = makeHookPlugin('logged', {
    dsh: { hooks: { 'tools/pre-execute': [{ hooks: [{ type: 'command', command: 'py -3 logged.py' }] }] } },
  })
  const dir = mkdtempSync(join(tmpdir(), 'dsh-loader-logb-'))
  try {
    const logPath = join(dir, 'hooks.jsonl')
    const ctx = makeBridgeCtx(() => ({
      stdout: JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: 'blocked sk-abcdef123456' } }),
    }))
    const agent = makeFakeAgent({ id: 'session-log' })
    const { state } = installBridge(ctx, [plugin], { hookLog: true, hookLogPath: logPath })
    await ctx.listeners.get('tools/pre-execute')[0](
      { name: 'write', arguments: { file_path: 'x' }, callId: 'c1', agent, signal: new AbortController().signal },
      async () => ({ kind: 'allow' }),
    )
    await state.hookLog.flush()
    const lines = readFileSync(logPath, 'utf8').trim().split('\n')
    assert.equal(lines.length, 1)
    const record = JSON.parse(lines[0])
    assert.equal(record.kind, 'hook')
    assert.equal(record.event, 'tools/pre-execute')
    assert.equal(record.plugin, 'logged')
    assert.equal(record.channel, 'dsh')
    assert.equal(record.decision, 'deny')
    assert.equal(record.exit_code, 0)
    assert.equal(record.session_id, 'session-log')
    assert.equal(typeof record.duration_ms, 'number')
    assert.doesNotMatch(lines[0], /sk-abcdef123456/)
    assert.match(record.stdout, /blocked sk-<redacted>/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
    rmSync(plugin.dir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------- frontmatter
// 真实插件大量用折叠/字面块标量写 description；v0.2.0 的单行解析会把它们整条丢掉。

test('frontmatter folded block scalar keeps a multi-line description', () => {
  const raw = [
    '---',
    'name: clarify-needs',
    'description: >',
    '  把目标/方案/偏好/约束分开。',
    '  手段说太死就松开，目标说太空就钉实。',
    '',
    '  第二段保留换行。',
    'disable-model-invocation: false',
    'when-to-use: 用户要澄清需求时',
    '---',
    '# body',
  ].join('\n')
  const meta = parseFrontmatter(raw)
  assert.equal(meta.name, 'clarify-needs')
  assert.equal(meta.description,
    '把目标/方案/偏好/约束分开。 手段说太死就松开，目标说太空就钉实。\n第二段保留换行。')
  assert.equal(meta['when-to-use'], '用户要澄清需求时')
  assert.equal(meta['disable-model-invocation'], 'false')
})

test('frontmatter literal block scalar keeps newlines and chomping', () => {
  const raw = '---\nname: x\ndescription: |-\n  line one\n  line two\n---\n'
  const meta = parseFrontmatter(raw)
  assert.equal(meta.description, 'line one\nline two')
})

test('frontmatter plain, quoted and inline-JSON scalars still parse', () => {
  const raw = '---\nname: "quoted-name"\ndescription: single line\n'
    + 'metadata: {"openclaw":{"emoji":"x"}}\n---\n'
  const meta = parseFrontmatter(raw)
  assert.equal(meta.name, 'quoted-name')
  assert.equal(meta.description, 'single line')
  assert.equal(meta.metadata, '{"openclaw":{"emoji":"x"}}')
})

test('frontmatter block scalar ends at the next top-level key', () => {
  const raw = '---\nname: x\ndescription: >\n  folded\nname-extra: y\n---\n'
  const meta = parseFrontmatter(raw)
  assert.equal(meta.description, 'folded')
  assert.equal(meta['name-extra'], 'y')
})

test('frontmatter rejects a document without a frontmatter block', () => {
  assert.equal(parseFrontmatter('# no frontmatter'), null)
  assert.equal(parseFrontmatter('---\nname: x\n'), null)
})

test('frontmatter parses CRLF files and long single-line descriptions', () => {
  const long = 'x'.repeat(500)
  const raw = `---\r\nname: crlf\r\ndescription: ${long}\r\n---\r\n# body\r\n`
  const meta = parseFrontmatter(raw)
  assert.equal(meta.name, 'crlf')
  assert.equal(meta.description, long)
})
