// clawd-debug: a step debugger in a pane beside the conversation.
//
// A helper process (helper/dapd.mjs) does the debugging: it talks to each
// language's debugger, prints its state as JSON lines, and takes commands as
// HTTP on a Unix socket. This module starts it, keeps its state in `dbg`,
// draws the pane, and gives Claude and the person ways to drive it.
import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { DebugState, ViewMessage, ViewProps } from '../types'

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

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const started = await next(e)
    await $.command.register({ name: 'dbg', description: 'Step debugger: /dbg <file>[:line] [args], /dbg next|in|out|continue|stop, /dbg setup' })
    for (const tool of TOOLS) await $.tool.register(tool)

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
                const kept = (await read($, dbg)).breakpoints
                for (const [file, list] of Object.entries(kept)) {
                  if (list.length) await send($, { cmd: 'setBreakpoints', file, lines: list.map(b => b.line) })
                }
              }
              else if (message.type === 'state' && message.state) {
                const st = message.state
                if (st.status === 'starting') sources.clear()
                await update($, dbg, () => st)
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
    const { Client } = $.ui.resolve(e)
    const view = await viewProps($)
    const rows = e.props.scroll?.bodyRows ?? 30
    return <Client key="view" module="./view.tsx" props={view} width="100%" height={rows} />
  })

  on('ui.message', async ($, e, next) => {
    if (e.component !== 'Pane' || e.requestId !== PANE) return next(e)
    const data = e.data as ViewMessage
    if (!data || typeof data !== 'object' || typeof data.cmd !== 'string') return {}
    const st = await read($, dbg)
    if (data.cmd === 'toggleBreakpoint') {
      const file = st.stop?.file ?? ((await read($, shown)) || st.program || '')
      if (file && Number.isInteger(data.line)) await send($, { cmd: 'toggleBreakpoint', file, line: data.line })
      return {}
    }
    if (data.cmd === 'testData') {
      const file = st.stop?.file ?? ((await read($, shown)) || st.program || '')
      if (!file) return {}
      const lines = (st.breakpoints[file] ?? []).map(b => b.line)
      const sent = await $.prompt.submit({ text: await testDataPrompt($, file, lines, Number(data.line) || 1) }).then(() => true).catch(() => false)
      $.ui.toast(sent ? 'Asked Claude to write test data and start the debugger.' : 'Could not ask Claude: try again when the current turn ends.')
      return {}
    }
    if (data.cmd === 'run') {
      if (st.program) await send($, { cmd: 'restart' })
      else {
        const file = await read($, shown)
        if (file) await send($, { cmd: 'start', program: file })
      }
      return {}
    }
    const answer = await send($, { cmd: data.cmd })
    if (!answer.ok && answer.error) $.ui.toast(answer.error)
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
    const input = e as unknown as { program?: string; breakpoints?: { file: string; line: number }[]; args?: string[]; cwd?: string; lang?: string }
    if (!input.program) return { result: 'debug_start needs "program".' }
    const cwd = input.cwd ?? (await $.session.cwd())
    const program = input.program.startsWith('/') ? input.program : `${cwd}/${input.program}`
    const breakpoints = (input.breakpoints ?? []).map(b => ({ file: b.file.startsWith('/') ? b.file : `${cwd}/${b.file}`, line: Number(b.line) }))
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

  on('tool.call', { tool: /^mcp__clawd-debug__debug_breakpoints$/ }, async ($, e) => {
    const input = e as unknown as { file?: string; lines?: number[] }
    if (!input.file) return { result: 'debug_breakpoints needs "file".' }
    const cwd = await $.session.cwd()
    const file = input.file.startsWith('/') ? input.file : `${cwd}/${input.file}`
    const answer = await send($, { cmd: 'setBreakpoints', file, lines: input.lines ?? [] })
    const set = answer.state?.breakpoints[file] ?? []
    return { result: answer.ok ? `Breakpoints in ${input.file}: ${set.map(b => b.line + (b.verified ? '' : ' (pending)')).join(', ') || 'none'}` : `Not set: ${answer.error}` }
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

// What the t key asks Claude: test data for the function under the breakpoints.
async function testDataPrompt($: EngineInterface, file: string, lines: number[], cursor: number): Promise<string> {
  const dir = file.slice(0, file.lastIndexOf('/'))
  const top = await $.process.run(['git', 'rev-parse', '--show-toplevel'], { cwd: dir, timeoutMs: 5000 }).catch(() => undefined)
  const root = top?.exitCode === 0 ? top.stdout.trim() : dir
  const where = lines.length ? `with breakpoints at line${lines.length > 1 ? 's' : ''} ${lines.join(', ')}` : `at the function around line ${cursor} (set a breakpoint on its first line)`
  return [
    `Debug ${file} ${where} with clawd-debug, using realistic test data.`,
    `Write a small harness in ${root}/.clawd-debug/ that calls that function with test data (typical values and an edge case), make sure .clawd-debug/ is listed in ${root}/.git/info/exclude so it is never committed, then call debug_start with the harness as "program", cwd ${root}, and the breakpoints in ${file}.`,
    `Keep the harness free of side effects: no database writes, no network calls, no emails, unless I ask.`,
    `When it stops, tell me in two or three lines where it stopped and what the key values are; I will step in the pane.`,
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
  const output = st.output.filter(o => o.category !== 'adapter' && o.category !== 'clawd-debug').map(o => o.text).join('').split('\n')
  if (output[output.length - 1] === '') output.pop()
  return {
    status: st.status,
    file,
    lines: lines.map(l => (l.length > 400 ? `${l.slice(0, 399)}…` : l)),
    firstLine,
    current,
    breakpoints: (st.breakpoints[file] ?? []).map(b => b.line),
    values: st.lineValues[file] ?? {},
    reason: st.stop?.reason ?? '',
    frame: st.stop?.frame ?? '',
    steps: st.steps,
    scopes: st.scopes.map(s => ({ name: s.name, vars: s.vars.slice(0, 60).map(v => ({ name: v.name, value: v.value })) })),
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
    const lines = await loadSource($, st.stop.file)
    const at = st.stop.line ?? 1
    for (let n = Math.max(1, at - context); n <= Math.min(lines.length, at + context); n++) {
      out.push(`${n === at ? '>' : ' '} ${String(n).padStart(4)} | ${lines[n - 1]}`)
    }
    for (const scope of st.scopes) {
      if (!scope.vars.length) continue
      out.push(`${scope.name}:`)
      for (const v of scope.vars.slice(0, 40)) out.push(`  ${v.name} = ${v.value}${v.ref ? `  [expand: ${v.ref}]` : ''}`)
    }
    if (st.frames.length > 1) out.push(`Call stack: ${st.frames.map(f => `${f.name} (${name(f.file)}:${f.line})`).join(' < ')}`)
  } else if (st.status === 'ended') {
    out.push(`The program ended${st.exitCode != null ? ` with exit code ${st.exitCode}` : ''}.`)
  } else if (st.status === 'error') {
    out.push(`Error: ${st.error}`)
  } else {
    out.push(`Status: ${st.status}.`)
  }
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
      'Then use debug_step to go line by line; the person can also step in the pane with n/s/o/c.',
    ].join(' '),
    inputSchema: {
      type: 'object',
      properties: {
        program: { type: 'string', description: 'The file to run (absolute, or relative to the session folder).' },
        breakpoints: { type: 'array', items: { type: 'object', properties: { file: { type: 'string' }, line: { type: 'number' } }, required: ['file', 'line'] }, description: 'Where to stop: file and 1-based line.' },
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
    name: 'debug_breakpoints',
    description: 'Replace the breakpoints of one file in the clawd-debug run (an empty list clears them). Works before or during a run.',
    inputSchema: {
      type: 'object',
      properties: {
        file: { type: 'string' },
        lines: { type: 'array', items: { type: 'number' } },
      },
      required: ['file', 'lines'],
    },
  },
]
