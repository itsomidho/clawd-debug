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

// The last command a key or button sent, past the ones a starting helper is
// given by itself (the breakpoints and watches the pane remembers).
function lastAct(sent: Record<string, unknown>[]) {
  return sent.filter(one => one.cmd !== 'setBreakpoints' && one.cmd !== 'restore').at(-1)
}

// Stands for the engine and the helper: a helper that says it is ready and
// paused, and a socket that records each command.
const toasts: string[] = []

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
  on('clock.every', () => ({ value: undefined }))
  // The wait for a starting helper: long enough for the fake one to say it is ready.
  on('clock.sleep', async () => { await new Promise(resolve => setTimeout(resolve, 3000)); return { value: undefined } })
  on('ui.toast', (_: unknown, e: unknown) => { toasts.push(String((e as { text?: string }).text ?? e)); return { value: undefined } })
  on('process.spawn', async function* () {
    yield { stream: 'stdout', text: `${JSON.stringify({ type: 'ready', socket: '/run/test.sock' })}\n` }
    // A list of states: one stop after another.
    for (const one of Array.isArray(state) ? state : [state]) yield { stream: 'stdout', text: `${JSON.stringify({ type: 'state', state: one })}\n` }
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
  // The header card: the status chip and where it stopped.
  const chip = await ui.find({ type: 'Text', text: ' PAUSED ' })
  expect(chip?.props.backgroundColor).toBe('#e5c07b')
  expect(await ui.find({ type: 'Text', text: 'calc.py:4 · calc_total · step 3' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /subtotal = 0/, in: 'view' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /item = 1/, in: 'view' })).toBeDefined()

  // The code is coloured: a keyword, a call, a number.
  expect((await ui.find({ type: 'Text', text: /^def$/, in: 'view' }))?.props.color).toBe('#c678dd')
  expect((await ui.find({ type: 'Text', text: /^calc_total$/, in: 'view' }))?.props.color).toBe('#61afef')
  expect((await ui.find({ type: 'Text', text: /^0$/, in: 'view' }))?.props.color).toBe('#d19a66')

  // A step key in the view becomes a command to the helper.
  await ui.key({ key: 'n', in: 'view' })
  expect(lastAct(sent)).toMatchObject({ cmd: 'next' })

  // b sets a breakpoint where the cursor is: the paused line.
  await ui.key({ key: 'b', in: 'view' })
  expect(lastAct(sent)).toMatchObject({ cmd: 'toggleBreakpoint', file: FILE, line: 4 })
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
  on('process.run', () => ({ value: { exitCode: 0, stdout: '/work\n', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }))
  on('prompt.submit', (_: unknown, e: { text: string }) => { prompts.push(e.text); return { text: e.text } })
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
  expect(await ui.find({ type: 'Text', text: /^LINE 4$/, in: 'view' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /END'$/, in: 'view' })).toBeDefined()
  await ui.unmount()
})

test('every key hint shows, wrapped to the width, and ? hides them', async ($, on) => {
  engine(on, [])
  await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true })

  const ui = await $.ui.mount(PANE)
  // Out of the way until asked for: ? shows every key, grouped by where it works.
  expect(await ui.find({ type: 'Text', text: 'breakpoint on the cursor line', in: 'view' })).toBeUndefined()
  await ui.key({ key: '?', in: 'view' })
  for (const text of ['STEP BAR (works as soon as the pane has the keys)', 'CODE (click it first)', 'breakpoint on the cursor line', 'breakpoint with a condition', 'move the keys into the list (and back)']) {
    expect(await ui.find({ type: 'Text', text, in: 'view' })).toBeDefined()
  }
  await ui.key({ key: '?', in: 'view' })
  expect(await ui.find({ type: 'Text', text: 'breakpoint on the cursor line', in: 'view' })).toBeUndefined()
  await ui.unmount()
})

test('stopped on an error: the headline and the details show it, and Claude reads it', async ($, on) => {
  const error = "KeyError: 'missing'"
  engine(on, [], { ...PAUSED, stop: { ...PAUSED.stop, reason: 'exception', error } })
  await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true })

  const ui = await $.ui.mount(PANE)
  expect((await ui.find({ type: 'Text', text: ' ERROR ' }))?.props.backgroundColor).toBe('#e06c75')
  expect(await ui.find({ type: 'Text', text: "calc.py:4 · KeyError: 'missing'" })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^ERROR$/, in: 'view' })).toBeDefined()
  const errorRows = await ui.findAll({ type: 'Text', text: "KeyError: 'missing'", in: 'view' })
  expect(errorRows.some(one => one.props.color === '#e06c75')).toBe(true)
  await ui.unmount()

  const out = await $.tool.call({ tool: 'mcp__clawd-debug__debug_state' } as any)
  expect(String((out as { result?: unknown }).result)).toContain(`Stopped on an uncaught error: ${error}`)
})

const WATCHED = {
  ...PAUSED,
  scopes: [{ name: 'Locals', vars: [
    { name: 'items', value: '[1, 2]', type: 'list', ref: 7, children: [
      { name: '0', value: '1', type: 'int', ref: 0 },
      { name: '1', value: '2', type: 'int', ref: 0 },
    ] },
    { name: 'subtotal', value: '0', type: 'int', ref: 0 },
  ] }],
  watches: [
    { expr: 'subtotal * 2', name: 'subtotal * 2', value: '0', type: 'int', ref: 0 },
    { expr: 'nope', name: 'nope', value: '', type: '', ref: 0, error: "NameError: name 'nope' is not defined" },
  ],
  expanded: ['["Locals","items"]'],
}

test('w types a watch expression and Enter adds it', async ($, on) => {
  const sent: Record<string, unknown>[] = []
  engine(on, sent)
  await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true })
  const ui = await $.ui.mount(PANE)
  for (const key of ['w', 'n', '+', '1']) await ui.key({ key, in: 'view' })
  expect(await ui.find({ type: 'Text', text: 'n+1', in: 'view' })).toBeDefined()
  // While typing, n is a letter, not a step.
  expect(sent.some(one => one.cmd === 'next')).toBe(false)
  await ui.key({ key: 'return', in: 'view' })
  expect(lastAct(sent)).toMatchObject({ cmd: 'addWatch', expr: 'n+1' })
  await ui.unmount()
})

test('the Watch tab shows each watch, its value or its error', async ($, on) => {
  engine(on, [], WATCHED)
  await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true })
  const ui = await $.ui.mount(PANE)
  await ui.key({ key: 'tab', in: 'view' })
  expect(await ui.find({ type: 'Text', text: /^ {2}subtotal \* 2 {2}0$/, in: 'view' })).toBeDefined()
  const errors = await ui.findAll({ type: 'Text', text: "NameError: name 'nope' is not defined", in: 'view' })
  expect(errors.some(one => one.props.color === '#e06c75')).toBe(true)
  await ui.unmount()
})

test('e moves the keys into the details: an open row shows its children, Enter folds it', async ($, on) => {
  const sent: Record<string, unknown>[] = []
  engine(on, sent, WATCHED)
  await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true })
  const ui = await $.ui.mount(PANE)
  expect(await ui.find({ type: 'Text', text: /^▾ items +\[1, 2\]$/, in: 'view' })).toBeDefined()
  // A child sits one level in, under a │ for its parent.
  expect(await ui.find({ type: 'Text', text: /^│ {3}0 +1$/, in: 'view' })).toBeDefined()
  await ui.key({ key: 'e', in: 'view' })
  // The first selectable row is items (the Line section above is not selectable).
  await ui.key({ key: 'return', in: 'view' })
  expect(lastAct(sent)).toMatchObject({ cmd: 'toggleExpand', path: ['Locals', 'items'] })
  // In the details, ↓ moves the selection, not the code cursor; b still sets a breakpoint.
  await ui.key({ key: 'down', in: 'view' })
  await ui.key({ key: 'down', in: 'view' })
  await ui.key({ key: 'down', in: 'view' })
  await ui.key({ key: 'b', in: 'view' })
  expect(lastAct(sent)).toMatchObject({ cmd: 'toggleBreakpoint', line: 4 })
  await ui.unmount()
})

test('d on a selected watch removes it', async ($, on) => {
  const sent: Record<string, unknown>[] = []
  engine(on, sent, WATCHED)
  await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true })
  const ui = await $.ui.mount(PANE)
  await ui.key({ key: 'tab', in: 'view' })
  await ui.key({ key: 'e', in: 'view' })
  await ui.key({ key: 'down', in: 'view' })
  await ui.key({ key: 'd', in: 'view' })
  expect(lastAct(sent)).toMatchObject({ cmd: 'removeWatch', expr: 'nope' })
  await ui.unmount()
})

test('B sets a condition on the line; a conditional breakpoint is drawn ◆ with its condition', async ($, on) => {
  const sent: Record<string, unknown>[] = []
  engine(on, sent, { ...PAUSED, breakpoints: { [FILE]: [{ line: 2, verified: true }, { line: 4, verified: true, condition: 'item > 1' }] } })
  await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true })
  const ui = await $.ui.mount(PANE)
  // The cursor sits on the paused line, 4: its breakpoint is conditional.
  expect(await ui.find({ type: 'Text', text: '◆', in: 'view' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /◆ stops only when item > 1$/, in: 'view' })).toBeDefined()
  // B opens the field with the current condition; edit it and set it.
  await ui.key({ key: 'B', in: 'view' })
  expect(await ui.find({ type: 'Text', text: ' BREAK AT 4 WHEN ', in: 'view' })).toBeDefined()
  for (const key of ['backspace', '2']) await ui.key({ key, in: 'view' })
  await ui.key({ key: 'return', in: 'view' })
  expect(lastAct(sent)).toMatchObject({ cmd: 'setCondition', line: 4, condition: 'item > 2' })
  await ui.unmount()
})

const CASES = {
  ...PAUSED,
  status: 'ended', stop: null, frames: [], scopes: [], runId: 3, caseFilter: '',
  cases: [
    { name: 'plain', ok: true, expected: '1', actual: '1' },
    { name: 'nbsp', ok: false, expected: '{"btc":1}', actual: '[]' },
    { name: 'throws', ok: false, expected: '0', error: 'TypeError: boom' },
  ],
}

test('a run with test cases opens them on the first failing case; ↵ reruns it alone', async ($, on) => {
  const sent: Record<string, unknown>[] = []
  engine(on, sent, CASES)
  await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true })
  const ui = await $.ui.mount(PANE)
  expect((await ui.find({ type: 'Text', text: ' 2 FAILED ' }))?.props.backgroundColor).toBe('#e06c75')
  expect(await ui.find({ type: 'Text', text: /✓ 1 {2}✗ 2$/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^✗ nbsp$/, in: 'view' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^ {4}got +\[\]$/, in: 'view' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^ {4}error +TypeError: boom$/, in: 'view' })).toBeDefined()
  await ui.key({ key: 'return', in: 'view' })
  expect(lastAct(sent)).toMatchObject({ cmd: 'rerunCase', name: 'nbsp' })
  await ui.key({ key: 'down', in: 'view' })
  await ui.key({ key: 'return', in: 'view' })
  expect(lastAct(sent)).toMatchObject({ cmd: 'rerunCase', name: 'throws' })
  await ui.unmount()
})

test('the step bar steps with its buttons, and x asks Claude to explain the stop', async ($, on) => {
  const sent: Record<string, unknown>[] = []
  const prompts: string[] = []
  engine(on, sent)
  on('prompt.submit', (_: unknown, e: { text: string }) => { prompts.push(e.text); return { text: e.text } })
  await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true })
  const ui = await $.ui.mount(PANE)
  for (const key of ['bar:n', 'bar:s', 'bar:o', 'bar:c', 'bar:x', 'bar:q']) expect(await ui.find({ key })).toBeDefined()
  await ui.press({ key: 'bar:n' })
  expect(lastAct(sent)).toMatchObject({ cmd: 'next' })
  await ui.press({ key: 'bar:x' })
  expect(prompts.at(-1)).toContain('debug_state')
  await ui.unmount()
})

test('f reruns the failing cases in turn, and the bar starts on it after a run with failures', async ($, on) => {
  const sent: Record<string, unknown>[] = []
  engine(on, sent, CASES)
  await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true })
  const ui = await $.ui.mount(PANE)
  expect((await ui.find({ key: 'bar:f' }))?.props.autoFocus).toBe(true)
  await ui.press({ key: 'bar:f' })
  expect(lastAct(sent)).toMatchObject({ cmd: 'rerunCase', name: 'nbsp' })
  // A step button while nothing is paused does nothing.
  const before = sent.length
  await ui.press({ key: 'bar:n' })
  expect(sent.length).toBe(before)
  await ui.unmount()
})

test('a value the step changed is marked •, and its scope counts the changes', async ($, on) => {
  const next = {
    ...PAUSED, steps: 4,
    scopes: [{ name: 'Locals', vars: [{ name: 'items', value: '[1, 2]', type: 'list', ref: 0 }, { name: 'subtotal', value: '1', type: 'int', ref: 0 }, { name: 'item', value: '1', type: 'int', ref: 0 }] }],
  }
  engine(on, [], [PAUSED, next])
  await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true })
  const ui = await $.ui.mount(PANE)
  // subtotal went 0 → 1 and item is new; items stayed the same.
  expect(await ui.find({ type: 'Text', text: /^• subtotal +1$/, in: 'view' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^• item +1$/, in: 'view' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^ {2}items +\[1, 2\]$/, in: 'view' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: ' 3 · 2 changed', in: 'view' })).toBeDefined()
  await ui.unmount()
})

test('the Output tab numbers each line and shows stderr in red', async ($, on) => {
  const ran = {
    ...PAUSED,
    output: [
      { category: 'stdout', text: '== plain ==\nbtc: 1\n' },
      { category: 'stderr', text: 'PHP Warning:  Undefined index\n' },
      { category: 'clawd-debug', text: '$ docker exec …\n' },
    ],
  }
  engine(on, [], ran)
  await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true })
  const ui = await $.ui.mount(PANE)
  for (let i = 0; i < 4; i++) await ui.key({ key: 'tab', in: 'view' })
  expect(await ui.find({ type: 'Text', text: ' 3 lines · 1 on stderr', in: 'view' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^1 │ == plain ==$/, in: 'view' })).toBeDefined()
  const warning = await ui.findAll({ type: 'Text', text: 'PHP Warning:  Undefined index', in: 'view' })
  expect(warning.some(one => one.props.color === '#e06c75')).toBe(true)
  // The debugger's own lines stay out of the program's output.
  expect(await ui.find({ type: 'Text', text: /docker exec/, in: 'view' })).toBeUndefined()
  await ui.unmount()
})

test('the Stack tab lines up each frame: number, function, file:line, folder', async ($, on) => {
  const deep = {
    ...PAUSED,
    frames: [
      { name: 'calc_total', file: '/work/calc.py', line: 4 },
      { name: '<module>', file: '/work/run.py', line: 12 },
    ],
  }
  engine(on, [], deep)
  await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true })
  const ui = await $.ui.mount(PANE)
  for (let i = 0; i < 3; i++) await ui.key({ key: 'tab', in: 'view' })
  expect(await ui.find({ type: 'Text', text: /^▶ 0  calc_total {2}calc\.py:4  \/work$/, in: 'view' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^ {2}1  <module> {4}run\.py:12  \/work$/, in: 'view' })).toBeDefined()
  await ui.unmount()
})

test('a Persian value lines up by its width on screen, not its length', async ($, on) => {
  // ZWNJ (U+200C) takes no cell: بیت‌کوین is 7 cells in 8 characters, so it
  // pads to subtotal's 8 with 1 space more than its length says.
  const persian = {
    ...PAUSED,
    scopes: [{ name: 'Locals', vars: [{ name: 'بیت‌کوین', value: "'BTC'", type: 'string', ref: 0 }, { name: 'subtotal', value: '0', type: 'int', ref: 0 }] }],
  }
  engine(on, [], persian)
  await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true })
  const ui = await $.ui.mount(PANE)
  expect(await ui.find({ type: 'Text', text: /^ {2}بیت‌کوین {3}'BTC'$/, in: 'view' })).toBeDefined()
  await ui.unmount()
})

test('clicks: tabs, the gutter, a value row, a watch ✕, + Add watch, a case row', async ($, on) => {
  const sent: Record<string, unknown>[] = []
  engine(on, sent, WATCHED)
  await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true })
  const ui = await $.ui.mount(PANE)
  // The gutter of line 2 sets or clears its breakpoint.
  await ui.press({ key: 'gutter:2' })
  expect(lastAct(sent)).toMatchObject({ cmd: 'toggleBreakpoint', line: 2 })
  // A value with children opens or folds on a click.
  await ui.press({ key: 'row:Locals/items' })
  expect(lastAct(sent)).toMatchObject({ cmd: 'toggleExpand', path: ['Locals', 'items'] })
  // A tab opens on a click; a watch goes with its ✕.
  await ui.press({ key: 'tab:watch' })
  expect(await ui.find({ type: 'Text', text: /^ {2}subtotal \* 2 {2}0$/, in: 'view' })).toBeDefined()
  await ui.press({ key: 'unwatch:nope' })
  expect(lastAct(sent)).toMatchObject({ cmd: 'removeWatch', expr: 'nope' })
  // + Add watch opens the field.
  await ui.press({ key: 'add-watch' })
  expect(await ui.find({ type: 'Text', text: ' WATCH ', in: 'view' })).toBeDefined()
  await ui.unmount()
})

test('a click on a test case reruns it alone', async ($, on) => {
  const sent: Record<string, unknown>[] = []
  engine(on, sent, CASES)
  await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true })
  const ui = await $.ui.mount(PANE)
  await ui.press({ key: 'row:Case/throws' })
  expect(lastAct(sent)).toMatchObject({ cmd: 'rerunCase', name: 'throws' })
  await ui.unmount()
})

test('with nothing running, the header shows b: like the bar keys, not a sentence', async ($, on) => {
  engine(on, [], { ...PAUSED, status: 'idle', stop: null, frames: [], scopes: [] })
  await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true })
  const ui = await $.ui.mount(PANE)
  expect((await ui.findAll({ type: 'Text', text: 'b:' })).some(one => one.props.color === '#d97757')).toBe(true)
  expect(await ui.find({ type: 'Text', text: ' breakpoint on the cursor line' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /t runs it with test data/ })).toBeUndefined()
  await ui.unmount()
})

test('/dbg break sets a breakpoint and shows the file, running nothing', async ($, on) => {
  const sent: Record<string, unknown>[] = []
  engine(on, sent)
  on('fs.exists', () => ({ value: true }))
  on('fs.stat', () => ({ value: { kind: 'file', size: 1, mtimeMs: 1, isLink: false, realPath: '/work/lib.py' } }))
  await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true })
  const out = await $.command.run({ command: 'dbg', args: 'break lib.py:12' })
  expect(String((out as { text?: string }).text)).toContain('Breakpoint at lib.py:12')
  expect(sent.some(one => one.cmd === 'setBreakpoints' && one.file === '/work/lib.py')).toBe(true)
  expect(sent.some(one => one.cmd === 'start')).toBe(false)
})
