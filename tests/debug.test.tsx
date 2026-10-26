import { expect, test } from 'claude-code/testing'

const FILE = '/work/calc.py'
const SOURCE = ['def calc_total(items):', '    subtotal = 0', '    for item in items:', '        subtotal += item', '    return subtotal'].join('\n')

const PAUSED = {
  status: 'paused', lang: 'python', program: FILE, cwd: '/work', args: [],
  breakpoints: { [FILE]: [{ line: 2, verified: true }] },
  stop: { reason: 'breakpoint', file: FILE, line: 4, frame: 'calc_total' },
  frames: [{ name: 'calc_total', file: FILE, line: 4 }],
  scopes: [{ name: 'Locals', vars: [{ name: 'items', value: '[1, 2]', type: 'list', ref: 0 }, { name: 'subtotal', value: '0', type: 'int', ref: 0 }] }],
  lineValues: { [FILE]: { '2': { subtotal: '0' }, '3': { item: '1' } } },
  output: [], exitCode: null, error: null, steps: 3,
}

const PANE = {
  plugin: 'clawd-debug',
  component: 'Pane',
  requestId: 'debug',
  surface: 'terminal',
  props: { title: 'Debug', isFocused: true, bodyColumns: 90, placement: 'dock', scroll: { offset: 0, bodyRows: 24 }, view: {} },
} as const

// Stands for the engine and the helper: a helper that says it is ready and
// paused, and a socket that records each command.
function engine(on: any, sent: Record<string, unknown>[], state: unknown = PAUSED) {
  on('command.register', () => ({ value: { command: 'dbg' } }))
  on('tool.register', (_: unknown, e: { name: string }) => ({ value: { tool: `mcp__clawd-debug__${e.name}` } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.start', (_: unknown, e: { cwd: string }) => ({ cwd: e.cwd }))
  on('fs.read', () => ({ value: SOURCE }))
  on('env.get', () => ({ value: '/run/test' }))
  on('session.id', () => ({ value: 'test-session' }))
  on('session.cwd', () => ({ value: '/work' }))
  on('ui.log', () => ({ value: undefined }))
  on('process.spawn', async function* () {
    yield { stream: 'stdout', text: `${JSON.stringify({ type: 'ready', socket: '/run/test.sock' })}\n` }
    yield { stream: 'stdout', text: `${JSON.stringify({ type: 'state', state })}\n` }
    return { value: { code: 0 } }
  })
  on('http.fetch', (_: unknown, e: any) => {
    const body = JSON.parse(e.body ?? e.init?.body ?? '{}')
    sent.push(body)
    return { value: { status: 200, ok: true, headers: {}, text: JSON.stringify({ ok: true, state: PAUSED }) } }
  })
}

test('the pane shows the paused line, its breakpoint and what each line set', async ($, on) => {
  const sent: Record<string, unknown>[] = []
  engine(on, sent)
  await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true })

  const ui = await $.ui.mount(PANE)
  expect(await ui.find({ type: 'Text', text: /calc\.py:4 in calc_total/, in: 'view' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /subtotal = 0/, in: 'view' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /item = 1/, in: 'view' })).toBeDefined()

  // The code is coloured: a keyword, a call, a number.
  expect((await ui.find({ type: 'Text', text: /^def$/, in: 'view' }))?.props.color).toBe('#c678dd')
  expect((await ui.find({ type: 'Text', text: /^calc_total$/, in: 'view' }))?.props.color).toBe('#61afef')
  expect((await ui.find({ type: 'Text', text: /^0$/, in: 'view' }))?.props.color).toBe('#d19a66')

  // A step key in the view becomes a command to the helper.
  await ui.key({ key: 'n', in: 'view' })
  expect(sent.at(-1)).toMatchObject({ cmd: 'next' })

  // b sets a breakpoint where the cursor is: the paused line.
  await ui.key({ key: 'b', in: 'view' })
  expect(sent.at(-1)).toMatchObject({ cmd: 'toggleBreakpoint', file: FILE, line: 4 })
  await ui.unmount()
})

test('debug_state tells Claude where it stopped and the values', async ($, on) => {
  const sent: Record<string, unknown>[] = []
  engine(on, sent)
  await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true })
  // Let the helper's lines land.
  const ui = await $.ui.mount(PANE)
  await ui.unmount()

  const out = await $.tool.call({ tool: 'mcp__clawd-debug__debug_state' } as any)
  const text = String((out as { result?: unknown }).result)
  expect(text).toContain('Paused at calc.py:4 in calc_total')
  expect(text).toContain('>    4 |         subtotal += item')
  expect(text).toContain('calc.py:3  item = 1')
})

test('t asks Claude for test data at the breakpoints', async ($, on) => {
  const sent: Record<string, unknown>[] = []
  const prompts: string[] = []
  engine(on, sent)
  on('process.run', () => ({ value: { exitCode: 0, stdout: '/work\n', stderr: '' } }))
  on('prompt.submit', (_: unknown, e: { text: string }) => { prompts.push(e.text); return { text: e.text } })
  on('ui.toast', () => ({ value: undefined }))
  await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true })

  const ui = await $.ui.mount(PANE)
  await ui.key({ key: 't', in: 'view' })
  expect(prompts).toHaveLength(1)
  expect(prompts[0]).toContain(`Debug ${FILE} with breakpoints at line 2`)
  expect(prompts[0]).toContain('/work/.clawd-debug/')
  expect(prompts[0]).toContain('debug_start')
  await ui.unmount()
})

test('a long value is shown whole in the details, wrapped, not cut', async ($, on) => {
  const sent: Record<string, unknown>[] = []
  const long = `'${'x'.repeat(150)}END'`
  engine(on, sent, { ...PAUSED, lineValues: { [FILE]: { '4': { subtotal: long } } } })
  await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true })

  const ui = await $.ui.mount(PANE)
  // The cursor sits on the paused line, 4: its section holds the whole value.
  expect(await ui.find({ type: 'Text', text: /^Line 4$/, in: 'view' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /END'$/, in: 'view' })).toBeDefined()
  await ui.unmount()
})

test('every key hint shows, wrapped to the width, and ? hides them', async ($, on) => {
  engine(on, [])
  await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true })

  const ui = await $.ui.mount(PANE)
  for (const label of [' next   ', ' test data   ', ' scroll details   ', ' hide keys   ']) {
    expect(await ui.find({ type: 'Text', text: label, in: 'view' })).toBeDefined()
  }
  await ui.key({ key: '?', in: 'view' })
  expect(await ui.find({ type: 'Text', text: ' next   ', in: 'view' })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: ' keys   ', in: 'view' })).toBeDefined()
  await ui.unmount()
})
