import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  syncPluginCommands,
  commandKey,
  commandRegistrations,
} from './dsh-claude-plugin-loader.mjs'

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

    // Overwrite the command body, then sync again: the old handler must be
    // disposed and a new one registered that sends the new template.
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
