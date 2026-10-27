// clawd-debug: a step debugger in a pane beside the conversation.
//
// A helper process (helper/dapd.mjs) does the debugging: it talks to each
// language's debugger, prints its state as JSON lines, and takes commands as
// HTTP on a Unix socket. This module starts it, keeps its state in `dbg`,
// draws the pane, and gives Claude and the person ways to drive it.
import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Case, DebugState, Var, ViewMessage, ViewOutput, ViewProps, ViewVar, Watch } from '../types'

const PLUGIN = 'clawd-debug'
const PANE = 'debug'

const EMPTY: DebugState = {
  status: 'idle', lang: null, program: null, cwd: null, args: [], breakpoints: {}, stop: null,
  frames: [], scopes: [], lineValues: {}, output: [], exitCode: null, error: null, steps: 0,
}

const dbg = atom({ plugin: 'clawd-debug', key: 'dbg' } as const, EMPTY, { shape: 'dbg-1' })
const shown = atom({ plugin: 'clawd-debug', key: 'shown' } as const, '')

// The helper's socket, once it said it is ready. A reload starts a new one.
let socket = ''
let whenReady: Promise<string> = new Promise(() => {})
const sources = new Map<string, string[]>()

type Answer = { ok: boolean; error?: string; state?: DebugState; result?: string; type?: string; vars?: { name: string; value: string }[] }

export const register: Register = (on, options) => {
  on('session.start', async ($, e, next) => {
    const started = await next(e)
    iconSet = await pickIcons($, String(options?.icons ?? 'auto'))
    // Registered without holding the session's start: awaiting them cost every
    // session about 0.6 s to open, and they are in place before the first prompt.
    // A tool's {cases} is where the test-case helpers are, in this install.
    void Promise.all([
      $.command.register({ name: 'dbg', description: 'Step debugger: /dbg <file>[:line] [args], /dbg next|in|out|continue|stop, /dbg setup' }),
      ...TOOLS.map(tool => $.tool.register({ ...tool, description: tool.description.replaceAll('{cases}', `${$.plugin.root}/helper/cases`) })),
    ]).catch(error => $.ui.log(`registering /dbg and the tools failed: ${String(error)}`, { to: 'debug' }))

    // The helper lives as long as the module: leaving the loop kills it.
    const runtime = (await $.env.get('XDG_RUNTIME_DIR')) || '/tmp'
    const id = (await $.session.id()).replace(/[^a-zA-Z0-9]/g, '').slice(0, 12)
    // A resumed session keeps its id: a random tail keeps each start's socket its own.
    const path = `${runtime}/clawd-debug-${id}-${crypto.randomUUID().slice(0, 8)}.sock`
    let resolveReady: (s: string) => void = () => {}
    whenReady = new Promise(resolve => { resolveReady = resolve })
    void (async () => {
      for (let attempt = 0; attempt < 5; attempt++) {
        let buffer = ''
        try {
          const child = $.process.spawn({ argv: ['node', `${$.plugin.root}/helper/dapd.mjs`, '--socket', path] })
          for await (const { stream, text } of child) {
            if (stream === 'stderr') { $.ui.log(text.trimEnd(), { to: 'debug' }); continue }
            buffer += text
            let cut = buffer.indexOf('\n')
            while (cut >= 0) {
              const line = buffer.slice(0, cut)
              buffer = buffer.slice(cut + 1)
              cut = buffer.indexOf('\n')
              let message: { type?: string; socket?: string; state?: DebugState }
              try { message = JSON.parse(line) } catch { continue }
              if (message.type === 'ready' && message.socket) {
                socket = message.socket
                resolveReady(socket)
                // A reload starts a fresh helper: give it the breakpoints the pane still shows.
                const kept = await read($, dbg)
                for (const [file, list] of Object.entries(kept.breakpoints)) {
                  if (list.length) await send($, { cmd: 'setBreakpoints', file, breakpoints: list.map(b => ({ line: b.line, condition: b.condition ?? '' })) })
                }
                // ...and its watches and open rows.
                const watches = (kept.watches ?? []).map(w => w.expr)
                if (watches.length || kept.expanded?.length) await send($, { cmd: 'restore', watches, expanded: kept.expanded ?? [] })
              }
              else if (message.type === 'state' && message.state) {
                const st = message.state
                if (st.status === 'starting') sources.clear()
                // Every stop is remembered as it comes, so the next one can mark what changed.
                trackChanges(st)
                await update($, dbg, () => st)
                // A new stop, or a run that ended with test cases: the pane takes
                // the keys (when the prompt is idle and empty), so n/s/o/c and the
                // bar's keys work without a click first.
                const mark = st.status === 'paused' ? `p:${st.runId}:${st.steps}` : st.status === 'ended' && st.cases?.length ? `e:${st.runId}` : ''
                if (mark && mark !== lastFocus) {
                  lastFocus = mark
                  // ...and its focus moves where Enter does the next thing: the
                  // failing cases' rerun after a run, next at a stop.
                  const target = st.status === 'ended' && st.cases?.some(c => !c.ok) ? 'bar:f' : st.status === 'paused' ? 'bar:n' : ''
                  void $.ui.open({ id: PANE, title: 'Debug', columns: 96, focus: true })
                    .then(() => (target ? $.ui.focus({ requestId: PANE, key: target }) : undefined))
                    .catch(() => {})
                }
              }
            }
          }
        } catch (error) {
          $.ui.log(`helper failed: ${String(error)}`, { to: 'debug' })
        }
        socket = ''
      }
    })()
    return started
  })

  // ---------------------------------------------------------------- the pane

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    if (e.surface !== 'terminal') {
      const { Text } = $.ui.resolve(e)
      return <Text>The debugger draws in the terminal for now.</Text>
    }
    const { Box, Button, Client, Text } = $.ui.resolve(e)
    const st = await read($, dbg)
    const view = await viewProps($)
    const rows = e.props.scroll?.bodyRows ?? 30
    const g = glyphs(iconSet)
    const chip = statusChip(st)
    // Where the keys start when the pane takes them: Enter reruns a failing
    // case after a run with cases, and steps at a stop.
    const hasFailing = st.status === 'ended' && (st.cases ?? []).some(c => !c.ok)
    const start = hasFailing ? 'f' : st.status === 'paused' ? 'n' : ''
    const button = (one: (typeof BAR)[number]) => (
      <Box key={`barbox:${one.key}`}>
        <Button key={`bar:${one.key}`} hotkey={one.key} plain hover={HOVER} autoFocus={one.key === start ? true : undefined} onPress={() => { void act($, one.data) }}>
          <Text dimColor={!one.when(st)}>{`${g[one.icon] ? `${g[one.icon]} ` : ''}${one.label}`}</Text>
        </Button>
        <Text>  </Text>
      </Box>
    )
    // The header card: what it is, where it stands, and the step bar (the
    // stepping keys on one row, the running ones on the next).
    return (
      <Box flexDirection="column">
        <Box borderStyle="round" borderColor={BORDER} paddingX={1} flexDirection="column">
          <Box flexDirection="row" height={1} overflow="hidden">
            <Text color={ACCENT} bold>{`${g.debug ? `${g.debug} ` : ''}Debug`}</Text>
            <Text>  </Text>
            <Text backgroundColor={chip.color} color={CHIP_TEXT} bold>{` ${chip.text} `}</Text>
            <Text>  </Text>
            <Text dimColor wrap="truncate-end">{whereText(st)}</Text>
          </Box>
          <Box flexDirection="row" height={1} overflow="hidden">{BAR.filter(one => one.row === 1).map(button)}</Box>
          <Box flexDirection="row" height={1} overflow="hidden">{BAR.filter(one => one.row === 2).map(button)}</Box>
        </Box>
        <Client key="view" module="./view.tsx" props={{ ...view, glyphs: g }} width="100%" height={Math.max(6, rows - 5)} />
      </Box>
    )
  })

  on('ui.message', async ($, e, next) => {
    if (e.component !== 'Pane' || e.requestId !== PANE) return next(e)
    const data = e.data as ViewMessage
    if (!data || typeof data !== 'object' || typeof data.cmd !== 'string') return {}
    await act($, data)
    return {}
  })

  // ---------------------------------------------------------------- /debug

  on('command.run', { command: 'dbg' }, async ($, e) => {
    const args = (e.args ?? '').trim()
    const word = args.split(/\s+/)[0] ?? ''
    const steps: Record<string, string> = { next: 'next', n: 'next', in: 'stepIn', out: 'stepOut', continue: 'continue', c: 'continue', stop: 'stop', restart: 'restart', pause: 'pause' }
    if (!args) {
      await openPane($)
      return { text: 'Debug pane opened. Click it, then: b breakpoint · t test data · r run · n next · s into · o out · c continue · q stop.' }
    }
    if (word === 'setup') return { text: await setup($) }
    if (steps[word]) {
      const answer = await send($, { cmd: steps[word], wait: true, timeoutMs: 10000 })
      return { text: answer.ok ? await summary($, answer.state ?? EMPTY, 6) : `Not done: ${answer.error}` }
    }
    // /dbg <file>[:line[,line]] [program args...]
    const [target = '', ...rest] = args.split(/\s+/)
    const match = /^(.+?)(?::([\d,]+))?$/.exec(target)
    const given = match?.[1]
    if (!given) return { text: 'Usage: /dbg <file>[:line] [args]' }
    const cwd = await $.session.cwd()
    const file = given.startsWith('/') ? given : `${cwd}/${given}`
    if (!(await $.fs.exists(file))) return { text: `No such file: ${file}` }
    const real = await realPath($, file)
    await update($, shown, () => real)
    await openPane($)
    const lines = (match?.[2] ?? '').split(',').filter(Boolean).map(Number)
    if (!lines.length) return { text: `Showing ${given}. Click the pane, move to a line, press b for a breakpoint, then t (Claude writes test data and runs it) or r (run the file as it is).` }
    const answer = await send($, { cmd: 'start', program: file, cwd, args: rest, breakpoints: lines.map(line => ({ file, line })), wait: true, timeoutMs: 30000 })
    return { text: answer.ok ? await summary($, answer.state ?? EMPTY, 6) : `Could not start: ${answer.error}` }
  })

  // ---------------------------------------------------------------- Claude's tools

  on('tool.call', { tool: /^mcp__clawd-debug__debug_start$/ }, async ($, e) => {
    const input = e as unknown as { program?: string; breakpoints?: { file: string; line: number; condition?: string }[]; args?: string[]; cwd?: string; lang?: string }
    if (!input.program) return { result: 'debug_start needs "program".' }
    const cwd = input.cwd ?? (await $.session.cwd())
    const program = input.program.startsWith('/') ? input.program : `${cwd}/${input.program}`
    const breakpoints = (input.breakpoints ?? []).map(b => ({ file: b.file.startsWith('/') ? b.file : `${cwd}/${b.file}`, line: Number(b.line), ...(b.condition ? { condition: b.condition } : {}) }))
    const real = await realPath($, breakpoints[0]?.file ?? program)
    await update($, shown, () => real)
    await openPane($)
    const answer = await send($, { cmd: 'start', program, cwd, args: input.args ?? [], lang: input.lang, breakpoints, wait: true, timeoutMs: 30000 })
    return { result: answer.ok ? await summary($, answer.state ?? EMPTY) : `Could not start: ${answer.error}` }
  }).catch(() => ({ result: 'The debugger could not start.' }))

  on('tool.call', { tool: /^mcp__clawd-debug__debug_step$/ }, async ($, e) => {
    const input = e as unknown as { action?: string; count?: number }
    const map: Record<string, string> = { next: 'next', in: 'stepIn', stepIn: 'stepIn', out: 'stepOut', stepOut: 'stepOut', continue: 'continue', stop: 'stop', restart: 'restart' }
    const cmd = map[input.action ?? 'next']
    if (!cmd) return { result: `Unknown action "${input.action}". Use next, in, out, continue, restart or stop.` }
    const count = Math.min(Math.max(1, Number(input.count ?? 1)), 50)
    let answer: Answer = { ok: true }
    for (let i = 0; i < count; i++) {
      answer = await send($, { cmd, wait: true, timeoutMs: 30000 })
      if (!answer.ok || answer.state?.status !== 'paused') break
    }
    return { result: answer.ok ? await summary($, answer.state ?? EMPTY) : `Not done: ${answer.error}` }
  }).catch(() => ({ result: 'The step failed.' }))

  on('tool.call', { tool: /^mcp__clawd-debug__debug_state$/ }, async ($, e) => {
    const input = e as unknown as { expression?: string; expand?: number }
    if (input.expression) {
      const answer = await send($, { cmd: 'evaluate', expression: input.expression })
      return { result: answer.ok ? `${input.expression} = ${answer.result}${answer.type ? ` (${answer.type})` : ''}` : `Could not evaluate: ${answer.error}` }
    }
    if (input.expand) {
      const answer = await send($, { cmd: 'expand', ref: input.expand })
      return { result: answer.ok ? (answer.vars ?? []).map(v => `${v.name} = ${v.value}`).join('\n') || '(empty)' : `Could not expand: ${answer.error}` }
    }
    return { result: await summary($, await read($, dbg)) }
  }).catch(() => ({ result: 'The state could not be read.' }))

  on('tool.call', { tool: /^mcp__clawd-debug__debug_watch$/ }, async ($, e) => {
    const input = e as unknown as { add?: string[]; remove?: string[] }
    // The helper's own answer has the list as changed; the mod's copy of the
    // state catches up a moment later.
    let answer: Answer = { ok: true }
    for (const expr of input.remove ?? []) answer = await send($, { cmd: 'removeWatch', expr })
    for (const expr of input.add ?? []) answer = await send($, { cmd: 'addWatch', expr })
    if (!answer.ok) return { result: `Not changed: ${answer.error}` }
    const st = answer.state ?? (await read($, dbg))
    const list = (st.watches ?? []).map(w => (w.error ? `  ${w.expr}: ${w.error}` : `  ${w.expr} = ${w.value || '(evaluated at the next stop)'}`))
    return { result: list.length ? `Watch:\n${list.join('\n')}` : 'No watch expressions.' }
  }).catch(() => ({ result: 'The watch expressions could not be changed.' }))

  on('tool.call', { tool: /^mcp__clawd-debug__debug_breakpoints$/ }, async ($, e) => {
    const input = e as unknown as { file?: string; lines?: number[]; conditions?: Record<string, string> }
    if (!input.file) return { result: 'debug_breakpoints needs "file".' }
    const cwd = await $.session.cwd()
    const file = await realPath($, input.file.startsWith('/') ? input.file : `${cwd}/${input.file}`)
    const conditions = input.conditions ?? {}
    const answer = await send($, { cmd: 'setBreakpoints', file, breakpoints: (input.lines ?? []).map(line => ({ line, condition: conditions[String(line)] ?? '' })) })
    const set = answer.state?.breakpoints[file] ?? []
    const shown = set.map(b => `${b.line}${b.condition ? ` (when ${b.condition})` : ''}${b.verified ? '' : ' (pending)'}`)
    return { result: answer.ok ? `Breakpoints in ${input.file}: ${shown.join(', ') || 'none'}` : `Not set: ${answer.error}` }
  }).catch(() => ({ result: 'The breakpoints could not be set.' }))
}

// ---------------------------------------------------------------- helpers

async function send($: EngineInterface, body: Record<string, unknown>): Promise<Answer> {
  const path = socket || (await Promise.race([whenReady, new Promise<string>(resolve => setTimeoutish($, resolve))]))
  if (!path) return { ok: false, error: 'the debug helper is not running (is node on PATH?)' }
  try {
    const res = await $.http.fetch('http://clawd-debug/cmd', { method: 'POST', body: JSON.stringify(body), socketPath: path, headers: { 'content-type': 'application/json' } })
    return JSON.parse(res.text) as Answer
  } catch (error) {
    return { ok: false, error: String(error) }
  }
}

// Wait at most five seconds for the helper to say it is ready.
function setTimeoutish($: EngineInterface, resolve: (s: string) => void) {
  void $.clock.sleep(5000).then(() => resolve(''), () => resolve(''))
}

// A key in the view, or a button of the step bar: what it asks of the helper.
async function act($: EngineInterface, data: ViewMessage): Promise<void> {
  // The bar's hotkey and the view's key can both see one press: once is enough.
  const stamp = `${data.cmd}:${'line' in data ? data.line : ''}:${'name' in data ? data.name : ''}`
  const now = Date.now()
  if (stamp === lastAct.stamp && now - lastAct.at < 120) return
  lastAct = { stamp, at: now }
  const st = await read($, dbg)
  // A step key while the program is not paused (a button stays drawn): nothing to do.
  if (['next', 'stepIn', 'stepOut', 'continue', 'explain'].includes(data.cmd) && st.status !== 'paused') return
  if (data.cmd === 'rerunFailing') {
    // The next failing case after the one rerun last, round the list.
    const failing = (st.cases ?? []).filter(c => !c.ok).map(c => c.name)
    if (!failing.length) return
    const after = failing.indexOf(st.caseFilter ?? '')
    const name = st.caseFilter && after >= 0 ? failing[(after + 1) % failing.length] : failing[0]
    if (name) await act($, { cmd: 'rerunCase', name })
    return
  }
  if (data.cmd === 'setCondition') {
    const file = st.stop?.file ?? ((await read($, shown)) || st.program || '')
    if (file && Number.isInteger(data.line)) await send($, { cmd: 'setCondition', file, line: data.line, condition: String(data.condition ?? '') })
    return
  }
  if (data.cmd === 'toggleBreakpoint') {
    const file = st.stop?.file ?? ((await read($, shown)) || st.program || '')
    if (file && Number.isInteger(data.line)) await send($, { cmd: 'toggleBreakpoint', file, line: data.line })
    return
  }
  if (data.cmd === 'addWatch' || data.cmd === 'removeWatch') {
    if (typeof data.expr === 'string' && data.expr.trim()) await send($, { cmd: data.cmd, expr: data.expr })
    return
  }
  if (data.cmd === 'toggleExpand') {
    if (Array.isArray(data.path) && data.path.every(p => typeof p === 'string')) await send($, { cmd: 'toggleExpand', path: data.path })
    return
  }
  if (data.cmd === 'testData') {
    const file = st.stop?.file ?? ((await read($, shown)) || st.program || '')
    if (!file) return
    const lines = (st.breakpoints[file] ?? []).map(b => b.line)
    const sent = await $.prompt.submit({ text: await testDataPrompt($, file, lines, Number(data.line) || 1) }).then(() => true).catch(() => false)
    $.ui.toast(sent ? 'Asked Claude to write test data and start the debugger.' : 'Could not ask Claude: try again when the current turn ends.')
    return
  }
  if (data.cmd === 'run') {
    if (st.program) await send($, { cmd: 'restart' })
    else {
      const file = await read($, shown)
      if (file) await send($, { cmd: 'start', program: file })
    }
    return
  }
  if (data.cmd === 'rerunCase') {
    if (typeof data.name === 'string' && data.name) {
      const answer = await send($, { cmd: 'rerunCase', name: data.name })
      if (!answer.ok && answer.error) $.ui.toast(answer.error)
    }
    return
  }
  if (data.cmd === 'explain') {
    const sent = await $.prompt.submit({ text: EXPLAIN_PROMPT }).then(() => true).catch(() => false)
    $.ui.toast(sent ? 'Asked Claude to explain this stop.' : 'Could not ask Claude: try again when the current turn ends.')
    return
  }
  const answer = await send($, { cmd: data.cmd })
  if (!answer.ok && answer.error) $.ui.toast(answer.error)
}

// What the x key asks Claude: read the stop, judge it, say what is wrong.
const EXPLAIN_PROMPT = [
  'Look at the paused clawd-debug run (call debug_state, and expand values with it if you need them).',
  'In a few lines: what the code is doing at this stop, whether the values look right for the test data, and, if something is wrong, what and why, pointing at the line.',
  "Don't change any files; I'll keep stepping in the pane.",
].join(' ')

let lastAct = { stamp: '', at: 0 }
let lastFocus = ''

// The step bar above the view: a button per key, pressed by its key whenever
// the pane has the keyboard (no click into the view needed), or by a click.
// Every button is always drawn (dim when it does not apply): a button that
// went away would take the pane's keyboard focus with it, back to the prompt.
type Bar = { key: string; label: string; icon: GlyphName; row: 1 | 2; data: ViewMessage; when: (st: DebugState) => boolean }
const isIdle = (st: DebugState) => st.status !== 'running' && st.status !== 'starting'
const BAR: Bar[] = [
  { key: 'n', label: 'next', icon: 'next', row: 1, data: { cmd: 'next' }, when: st => st.status === 'paused' },
  { key: 's', label: 'into', icon: 'into', row: 1, data: { cmd: 'stepIn' }, when: st => st.status === 'paused' },
  { key: 'o', label: 'out', icon: 'out', row: 1, data: { cmd: 'stepOut' }, when: st => st.status === 'paused' },
  { key: 'c', label: 'continue', icon: 'continue', row: 1, data: { cmd: 'continue' }, when: st => st.status === 'paused' },
  { key: 'q', label: 'stop', icon: 'stop', row: 1, data: { cmd: 'stop' }, when: st => st.status === 'paused' || st.status === 'running' },
  { key: 'r', label: 'run', icon: 'run', row: 2, data: { cmd: 'run' }, when: isIdle },
  { key: 't', label: 'test data', icon: 'test', row: 2, data: { cmd: 'testData', line: 1 }, when: isIdle },
  { key: 'f', label: 'rerun failing', icon: 'rerun', row: 2, data: { cmd: 'rerunFailing' }, when: st => isIdle(st) && (st.cases ?? []).some(c => !c.ok) },
  { key: 'x', label: 'explain', icon: 'explain', row: 2, data: { cmd: 'explain' }, when: st => st.status === 'paused' },
]

// ---------------------------------------------------------------- look
// The clawd family's look (shared with clawd-git): cards, chips, accent.

const ACCENT = '#d97757'
const BORDER = '#5c6370'
const CHIP_TEXT = '#1e2127'
const HOVER = { color: 'cyan', underline: true } as const

// The status chip of the header card.
function statusChip(st: DebugState): { text: string; color: string } {
  const cases = st.cases ?? []
  const failed = cases.filter(c => !c.ok).length
  if (st.status === 'paused') return st.stop?.error ? { text: 'ERROR', color: '#e06c75' } : { text: 'PAUSED', color: '#e5c07b' }
  if (st.status === 'running') return { text: 'RUNNING', color: '#98c379' }
  if (st.status === 'starting') return { text: 'STARTING', color: '#61afef' }
  if (st.status === 'error') return { text: 'ERROR', color: '#e06c75' }
  if (st.status === 'ended' && cases.length) return failed ? { text: `${failed} FAILED`, color: '#e06c75' } : { text: 'PASSED', color: '#98c379' }
  if (st.status === 'ended') return { text: 'ENDED', color: '#abb2bf' }
  return { text: 'READY', color: '#abb2bf' }
}

// The header's line after the chip: where it is, or how the run went.
function whereText(st: DebugState): string {
  const name = (f?: string | null) => (f ?? '').split('/').pop() ?? ''
  const cases = st.cases ?? []
  if (st.status === 'paused' && st.stop?.file) {
    return st.stop.error
      ? `${name(st.stop.file)}:${st.stop.line} · ${st.stop.error}`
      : `${name(st.stop.file)}:${st.stop.line} · ${st.stop.frame} · step ${st.steps}`
  }
  if (st.status === 'ended' && cases.length) {
    const passed = cases.filter(c => c.ok).length
    return `${name(st.program)} · ✓ ${passed}  ✗ ${cases.length - passed}${st.caseFilter ? ` · ran "${st.caseFilter}" alone` : ''}`
  }
  if (st.status === 'ended') return `${name(st.program)}${st.exitCode != null ? ` · exit ${st.exitCode}` : ''}`
  if (st.status === 'error') return st.error ?? ''
  if (st.status === 'running' || st.status === 'starting') return name(st.program)
  return 'b on a line sets a breakpoint, t runs it with test data'
}

// ---------------------------------------------------------------- icons

// Codicons (VS Code's icons, in every Nerd Font) for line and nerd; symbols
// every font has for outline and simple; none for off.
type GlyphName = 'debug' | 'next' | 'into' | 'out' | 'continue' | 'stop' | 'run' | 'test' | 'rerun' | 'explain' | 'file' | 'vars' | 'watch' | 'cases' | 'stack' | 'output' | 'pass' | 'fail'
const CODICONS: Record<GlyphName, string> = {
  debug: '\ueb91', next: '\uead6', into: '\uead4', out: '\uead5', continue: '\ueacf', stop: '\uead7',
  run: '\ueb2c', test: '\uea79', rerun: '\uebc0', explain: '\uec10', file: '\uea7b', vars: '\uea88',
  watch: '\uea70', cases: '\uea79', stack: '\ueb8b', output: '\ueb9d', pass: '\ueba4', fail: '\uea87',
}
const SYMBOLS: Record<GlyphName, string> = {
  debug: '◆', next: '↷', into: '↓', out: '↑', continue: '▷', stop: '■',
  run: '▶', test: '◇', rerun: '↻', explain: '✦', file: '', vars: '', watch: '', cases: '', stack: '', output: '', pass: '✓', fail: '✗',
}
type IconSet = 'line' | 'symbols' | 'off'
let iconSet: IconSet = 'symbols'

function glyphs(set: IconSet): Record<GlyphName, string> {
  if (set === 'line') return CODICONS
  if (set === 'off') return Object.fromEntries(Object.keys(SYMBOLS).map(k => [k, k === 'pass' ? '✓' : k === 'fail' ? '✗' : ''])) as Record<GlyphName, string>
  return SYMBOLS
}

// auto: Codicons when a font has them (a Nerd Font), else symbols; as clawd-git does.
async function pickIcons($: EngineInterface, choice: string): Promise<IconSet> {
  if (choice === 'line' || choice === 'nerd') return 'line'
  if (choice === 'outline' || choice === 'simple') return 'symbols'
  if (choice === 'off') return 'off'
  const out = await $.process.run(['fc-list', ':charset=ead6', 'family'], { timeoutMs: 5000 }).catch(() => undefined)
  if (out?.exitCode === 0 && out.stdout.trim()) return 'line'
  const home = (await $.env.get('HOME').catch(() => undefined)) ?? ''
  for (const dir of ['/Library/Fonts', `${home}/Library/Fonts`]) {
    const names = await $.fs.list(dir).catch(() => [])
    if (names.some(one => /nerd|NFM?[-.]/i.test(one.name))) return 'line'
  }
  return 'symbols'
}

// What the t key asks Claude: test data for the function under the breakpoints.
async function testDataPrompt($: EngineInterface, file: string, lines: number[], cursor: number): Promise<string> {
  const dir = file.slice(0, file.lastIndexOf('/'))
  const top = await $.process.run(['git', 'rev-parse', '--show-toplevel'], { cwd: dir, timeoutMs: 5000 }).catch(() => undefined)
  const root = top?.exitCode === 0 ? top.stdout.trim() : dir
  const where = lines.length ? `with breakpoints at line${lines.length > 1 ? 's' : ''} ${lines.join(', ')}` : `at the function around line ${cursor} (set a breakpoint on its first line)`
  return [
    `Debug ${file} ${where} with clawd-debug, using test cases.`,
    `Write a harness in ${root}/.clawd-debug/ as named test cases (typical values, edge cases, and inputs likely to break it), each with the result it SHOULD give, worked out from what the code is meant to do, not from running it.`,
    `Use the case helper: copy the one for the language from ${$.plugin.root}/helper/cases/ next to the harness and call it per case (see debug_start).`,
    `Make sure .clawd-debug/ is listed in ${root}/.git/info/exclude so it is never committed, then call debug_start with the harness as "program", cwd ${root}, and the breakpoints in ${file}.`,
    `Keep the harness free of side effects: no database writes, no network calls, no emails, unless I ask.`,
    `Then tell me in a few lines which cases failed and what that points to; I will rerun a failing case in the pane to step through it.`,
  ].join(' ')
}

// Where a path really lands (symlinks resolved), as the helper and the
// debuggers name files; the path itself when it cannot be resolved.
async function realPath($: EngineInterface, file: string): Promise<string> {
  const stat = await $.fs.stat(file, { resolve: true }).catch(() => undefined)
  return stat?.realPath ?? file
}

async function openPane($: EngineInterface) {
  await $.ui.open({ id: PANE, title: 'Debug', columns: 96 }).catch(() => {})
}

async function setup($: EngineInterface): Promise<string> {
  const home = (await $.env.get('HOME')) ?? ''
  const target = `${home}/.cache/clawd-debug/python`
  const out = await $.process.run(['python3', '-m', 'pip', 'install', '--quiet', '--upgrade', '--target', target, 'debugpy'], { timeoutMs: 180_000 })
    .catch((error: unknown) => ({ exitCode: 1, stderr: String(error), stdout: '' }))
  const python = out.exitCode === 0 ? `Python: debugpy installed in ${target}.` : `Python: could not install debugpy: ${String(out.stderr).slice(-300)}`
  return `${python}\nNode: built in, nothing to install.`
}

async function viewProps($: EngineInterface): Promise<ViewProps> {
  const st = await read($, dbg)
  const file = st.stop?.file ?? ((await read($, shown)) || st.program || '')
  let lines = file ? await loadSource($, file) : []
  // A Client takes 100,000 characters of props: send a window of a big file.
  let firstLine = 1
  const current = st.status === 'paused' && st.stop?.file === file ? st.stop.line ?? null : null
  if (lines.join('\n').length > 60_000) {
    firstLine = Math.max(1, (current ?? 1) - 150)
    lines = lines.slice(firstLine - 1, firstLine - 1 + 300)
  }
  const output = outputLines(st.output.filter(o => o.category !== 'adapter' && o.category !== 'clawd-debug'))
  const isChanged = trackChanges(st)
  return {
    status: st.status,
    file,
    lines: lines.map(l => (l.length > 400 ? `${l.slice(0, 399)}…` : l)),
    firstLine,
    current,
    breakpoints: (st.breakpoints[file] ?? []).map(b => b.line),
    conditions: Object.fromEntries((st.breakpoints[file] ?? []).filter(b => b.condition).map(b => [String(b.line), b.condition ?? ''])),
    values: st.lineValues[file] ?? {},
    reason: st.stop?.reason ?? '',
    error: st.status === 'paused' ? st.stop?.error ?? '' : '',
    frame: st.stop?.frame ?? '',
    steps: st.steps,
    scopes: st.scopes.map(s => ({ name: s.name, vars: s.vars.slice(0, 60).map(v => viewVar(v, [s.name], st.expanded ?? [], isChanged)) })),
    watches: (st.watches ?? []).map(w => viewVar(w, ['Watch'], st.expanded ?? [], isChanged)),
    cases: (st.cases ?? []).slice(0, 200),
    caseFilter: st.caseFilter ?? '',
    runId: st.runId ?? 0,
    frames: st.frames.slice(0, 30),
    output: output.slice(-200),
    note: st.status === 'error' ? st.error ?? '' : st.status === 'ended' && st.exitCode != null ? `exited with code ${st.exitCode} · r to run again` : '',
  }
}

// What Claude reads back: where it stopped, the code around it, the values.
async function summary($: EngineInterface, st: DebugState, context = 3): Promise<string> {
  const out: string[] = []
  const name = (f?: string | null) => (f ?? '').split('/').pop()
  if (st.status === 'paused' && st.stop?.file) {
    out.push(`Paused at ${name(st.stop.file)}:${st.stop.line} in ${st.stop.frame} (${st.stop.reason}), step ${st.steps}.`)
    if (st.stop.error) out.push(`Stopped on an uncaught error: ${st.stop.error}`)
    const lines = await loadSource($, st.stop.file)
    const at = st.stop.line ?? 1
    for (let n = Math.max(1, at - context); n <= Math.min(lines.length, at + context); n++) {
      out.push(`${n === at ? '>' : ' '} ${String(n).padStart(4)} | ${lines[n - 1]}`)
    }
    for (const scope of st.scopes) {
      if (!scope.vars.length) continue
      out.push(`${scope.name}:`)
      for (const v of scope.vars.slice(0, 40)) out.push(...varLines(v, 1))
    }
    if (st.watches?.length) {
      out.push('Watch:')
      for (const w of st.watches) out.push(w.error ? `  ${w.expr}: ${w.error}` : varLines(w, 1).join('\n'))
    }
    if (st.frames.length > 1) out.push(`Call stack: ${st.frames.map(f => `${f.name} (${name(f.file)}:${f.line})`).join(' < ')}`)
  } else if (st.status === 'ended') {
    out.push(`The program ended${st.exitCode != null ? ` with exit code ${st.exitCode}` : ''}.`)
  } else if (st.status === 'error') {
    out.push(`Error: ${st.error}`)
  } else {
    out.push(`Status: ${st.status}.`)
  }
  if (st.cases?.length) out.push(casesText(st.cases, st.caseFilter ?? ''))
  const pinned = Object.entries(st.lineValues)
  if (pinned.length) {
    out.push('Values by line (what each line set, latest run through it):')
    for (const [file, byLine] of pinned) {
      for (const [line, values] of Object.entries(byLine).sort((a, b) => Number(a[0]) - Number(b[0]))) {
        out.push(`  ${name(file)}:${line}  ${Object.entries(values).map(([k, v]) => `${k} = ${v}`).join(', ')}`)
      }
    }
  }
  const output = st.output.filter(o => o.category !== 'adapter').map(o => o.text).join('').trimEnd()
  if (output) out.push(`Output:\n${output.split('\n').slice(-15).map(l => `  ${l}`).join('\n')}`)
  return out.join('\n')
}

// The test cases for Claude: a line each, the failing ones with what differed.
function casesText(cases: Case[], filter: string): string {
  const passed = cases.filter(c => c.ok).length
  const lines = [`Test cases${filter ? ` (only "${filter}")` : ''}: ${passed} passed, ${cases.length - passed} failed.`]
  for (const c of cases) {
    if (c.ok) lines.push(`  ✓ ${c.name}`)
    else if (c.error) lines.push(`  ✗ ${c.name}: ${c.error}${c.expected !== undefined ? ` (expected ${c.expected})` : ''}`)
    else lines.push(`  ✗ ${c.name}: expected ${c.expected ?? '?'}, got ${c.actual ?? '?'}`)
  }
  return lines.join('\n')
}

// A helper variable as a row of the view's tree, with its path and children.
function viewVar(v: Var | Watch, prefix: string[], expanded: string[], isChanged: (path: string[], value: string) => boolean): ViewVar {
  const path = [...prefix, v.name]
  return {
    name: v.name,
    value: v.value,
    path,
    canExpand: v.ref > 0,
    isOpen: expanded.includes(JSON.stringify(path)),
    children: (v.children ?? []).slice(0, 60).map(c => viewVar(c, path, expanded, isChanged)),
    ...('error' in v && v.error ? { error: v.error } : {}),
    ...(isChanged(path, v.value) ? { changed: true } : {}),
  }
}

// The values at this stop and the one before, by function and path: a row is
// changed when its value differs from the stop before in the same function,
// or (at the top level) when it was not there yet. Module state: a reload
// starts over, which only loses one stop's marks.
const seen = { steps: -1, frame: '', now: new Map<string, string>(), before: new Map<string, string>() }

function trackChanges(st: DebugState): (path: string[], value: string) => boolean {
  if (st.status !== 'paused') return () => false
  const frame = `${st.stop?.file ?? ''}#${st.stop?.frame ?? ''}`
  if (st.steps !== seen.steps) {
    seen.before = seen.frame === frame && st.steps > seen.steps ? seen.now : new Map()
    seen.now = new Map()
    seen.steps = st.steps
    seen.frame = frame
  }
  const remember = (v: Var, path: string[]) => {
    const at = [...path, v.name]
    seen.now.set(JSON.stringify(at), v.value)
    for (const c of v.children ?? []) remember(c, at)
  }
  for (const s of st.scopes) for (const v of s.vars) remember(v, [s.name])
  for (const w of st.watches ?? []) remember(w, ['Watch'])
  const before = seen.before
  return (path, value) => {
    if (!before.size) return false
    const old = before.get(JSON.stringify(path))
    return old === undefined ? path.length === 2 : old !== value
  }
}

// The program's output as lines, each marked when any of it came on stderr.
function outputLines(chunks: { category: string; text: string }[]): ViewOutput[] {
  const lines: ViewOutput[] = []
  let line: ViewOutput = { text: '' }
  for (const chunk of chunks) {
    const pieces = chunk.text.split('\n')
    pieces.forEach((piece, i) => {
      if (i > 0) { lines.push(line); line = { text: '' } }
      if (!piece) return
      line.text += piece
      if (chunk.category === 'stderr') line.isError = true
    })
  }
  if (line.text) lines.push(line)
  return lines
}

// A variable and its open children, indented, for Claude.
function varLines(v: Var, depth: number): string[] {
  const pad = '  '.repeat(depth)
  return [
    `${pad}${v.name} = ${v.value}${v.ref ? `  [expand: ${v.ref}]` : ''}`,
    ...(v.children ?? []).slice(0, 40).flatMap(c => varLines(c, depth + 1)),
  ]
}

async function loadSource($: EngineInterface, file: string): Promise<string[]> {
  const known = sources.get(file)
  if (known) return known
  const text = await $.fs.read(file).catch(() => '')
  const lines = typeof text === 'string' ? text.split('\n') : []
  if (lines.length && lines[lines.length - 1] === '') lines.pop()
  sources.set(file, lines)
  return lines
}

const TOOLS = [
  {
    name: 'debug_start',
    // Always in the tool list: "run this with test data" should find it without a search.
    isDeferred: false,
    description: [
      'Use when the person asks to debug code, step through it, or run a function or file with test data.',
      'Start a step-debugging run in the clawd-debug pane (Python, Node, PHP). It stops at the first breakpoint hit and returns where it stopped, the code around it and every variable.',
      'To check a function with test data: write a small harness file (for example .clawd-debug/check_<name>.py or .js in the project) that imports or loads the function and calls it with realistic test data, including edge cases; pass the harness as "program" and put the breakpoints in the function\'s own file.',
      'PHP: a file inside a running Docker container with Xdebug (a WordPress site) runs there; inside a WordPress install the harness runs with `wp eval-file`, so WordPress is loaded: call plugin and theme code directly (add `use` lines for namespaces) and set public static state as test data when needed; avoid post ids or anything that writes to the database.',
      'Test cases: write the harness as named cases with their EXPECTED results, worked out from what the code should do (not from running it): copy the case helper for the language from {cases}/ (clawd_case.php, clawd_case.py, clawd_case.js) next to the harness, load it, and call clawd_case(name, fn, expected) / clawdCase(...) per case. The run then reports a ✓/✗ table (in the result and the pane); the person reruns a failing case alone with ↵, stopping at the breakpoints.',
      'Then use debug_step to go line by line; the person can also step in the pane with n/s/o/c.',
    ].join(' '),
    inputSchema: {
      type: 'object',
      properties: {
        program: { type: 'string', description: 'The file to run (absolute, or relative to the session folder).' },
        breakpoints: { type: 'array', items: { type: 'object', properties: { file: { type: 'string' }, line: { type: 'number' }, condition: { type: 'string', description: 'Stop only when this expression (in the program\'s language) is true.' } }, required: ['file', 'line'] }, description: 'Where to stop: file and 1-based line, and optionally a condition.' },
        args: { type: 'array', items: { type: 'string' }, description: 'Command-line arguments for the program.' },
        cwd: { type: 'string', description: 'Working folder; default the session folder.' },
        lang: { type: 'string', enum: ['python', 'node', 'php'], description: 'Default: from the file extension.' },
      },
      required: ['program'],
    },
  },
  {
    name: 'debug_step',
    description: 'Move the paused program in the clawd-debug pane: next (over), in, out, continue, restart or stop; "count" repeats next/in/out. Returns the new stop with its variables and the values each line set.',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['next', 'in', 'out', 'continue', 'restart', 'stop'] },
        count: { type: 'number', description: 'Repeat the step this many times (max 50).' },
      },
      required: ['action'],
    },
  },
  {
    name: 'debug_state',
    description: 'Read the clawd-debug run: where it is paused, variables, the value each line set, output. With "expression", evaluate it in the paused frame; with "expand", list the children of a variable by its [expand: N] ref.',
    inputSchema: {
      type: 'object',
      properties: {
        expression: { type: 'string' },
        expand: { type: 'number' },
      },
    },
  },
  {
    name: 'debug_watch',
    description: 'Add or remove watch expressions in the clawd-debug pane: they are evaluated at every stop and shown in its Watch tab (and in debug_state). Use for a value worth following across steps, like a total or a condition.',
    inputSchema: {
      type: 'object',
      properties: {
        add: { type: 'array', items: { type: 'string' } },
        remove: { type: 'array', items: { type: 'string' } },
      },
    },
  },
  {
    name: 'debug_breakpoints',
    description: 'Replace the breakpoints of one file in the clawd-debug run (an empty list clears them). Works before or during a run. "conditions" makes a line stop only when its expression is true, e.g. { "42": "$price > 100" }.',
    inputSchema: {
      type: 'object',
      properties: {
        file: { type: 'string' },
        lines: { type: 'array', items: { type: 'number' } },
        conditions: { type: 'object', additionalProperties: { type: 'string' }, description: 'line number -> condition, for the lines that should stop only when it is true' },
      },
      required: ['file', 'lines'],
    },
  },
]
