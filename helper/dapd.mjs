#!/usr/bin/env node
// clawd-debug helper.
// Talks DAP (Debug Adapter Protocol) to a language's debug adapter, takes
// commands as HTTP on a Unix socket, and prints every state change to stdout
// as one JSON line. The mod starts it and reads those lines.
//
//   node dapd.mjs --socket /path/to.sock [--cache ~/.cache/clawd-debug]
//
//   GET  /state              -> the current state
//   POST /cmd {cmd, ...}     -> runs a command, answers {ok, state, ...}
//
// Commands: start, next, stepIn, stepOut, continue, pause, stop, restart,
// setBreakpoints, evaluate, expand. Step commands take `wait: true` to answer
// only once the program has stopped again or ended.

import { execFile, spawn } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'

const argv = parseArgs(process.argv.slice(2))
const SOCKET = argv.socket ?? path.join(os.tmpdir(), `clawd-debug-${process.pid}.sock`)
const CACHE = argv.cache ?? path.join(os.homedir(), '.cache', 'clawd-debug')
const MAX_OUTPUT = 300
const MAX_OUTPUT_CHARS = 40_000
// How often the state goes to the mod at most: each one is a write and a redraw.
const EMIT_MS = 100
const MAX_VARS = 80

// ---------------------------------------------------------------- state

const state = {
  status: 'idle', // idle | starting | running | paused | ended | error
  lang: null,
  program: null,
  cwd: null,
  args: [],
  breakpoints: {}, // file -> [{ line, verified, condition? }]: a condition makes it stop only when true
  stop: null, // { reason, file, line, frame }
  frames: [], // [{ name, file, line }]
  scopes: [], // [{ name, vars: [{ name, value, type, ref }] }]
  lineValues: {}, // file -> line -> { name: value }, what each line changed
  // Expressions evaluated at every stop: [{ expr, name, value, type, ref, error?, children? }].
  // Kept across runs.
  watches: [],
  // Open rows of the variable tree and the watches, by path (JSON of the
  // names from the scope or "Watch" down): their children are read at every stop.
  expanded: [],
  // Test cases the program reported (`@@clawd-case {json}` lines on stdout):
  // [{ name, ok, expected?, actual?, error? }], in order.
  cases: [],
  // The case a rerun runs alone (CLAWD_CASE), '' for all.
  caseFilter: '',
  // Goes up by one with each run, so the pane knows a new run's cases.
  runId: 0,
  output: [], // [{ category, text }]
  exitCode: null,
  error: null,
  steps: 0,
}

let session = null // the running Debug, if any
const waiters = new Set()

// Sends the state at most every EMIT_MS: a chatty program printing thousands
// of lines would otherwise send it thousands of times. The last change always
// goes out, at the latest EMIT_MS after it.
let emitTimer = null
let isDirty = false

function emit() {
  if (emitTimer) { isDirty = true; return }
  send()
  emitTimer = setTimeout(() => {
    emitTimer = null
    if (isDirty) emit()
  }, EMIT_MS)
}

function send() {
  isDirty = false
  process.stdout.write(JSON.stringify({ type: 'state', state }) + '\n')
}

function settle() {
  for (const resolve of waiters) resolve()
  waiters.clear()
}

function waitForSettle(ms) {
  return new Promise(resolve => {
    const done = () => { clearTimeout(timer); resolve() }
    const timer = setTimeout(() => { waiters.delete(done); resolve() }, ms)
    waiters.add(done)
  })
}

// A harness reports each test case as one stdout line:
//   @@clawd-case {"name": "...", "ok": true, "expected": ..., "actual": ...}
// Those lines become state.cases and stay out of the output.
const CASE_MARK = '@@clawd-case '
let caseBuffer = ''

function takeCases(text) {
  const pieces = (caseBuffer + text).split(/(?<=\n)/)
  caseBuffer = ''
  let rest = ''
  for (const piece of pieces) {
    const line = piece.replace(/\r?\n$/, '')
    const isWhole = piece.endsWith('\n')
    if (!isWhole && (CASE_MARK.startsWith(piece) || piece.startsWith(CASE_MARK))) { caseBuffer = piece; continue }
    if (isWhole && line.startsWith(CASE_MARK)) {
      try {
        const one = JSON.parse(line.slice(CASE_MARK.length))
        // A rerun of one case updates its row in the full run's list.
        const at = state.cases.findIndex(c => c.name === String(one.name))
        const row = {
          name: String(one.name ?? `case ${state.cases.length + 1}`),
          ok: one.ok === true,
          ...(one.expected !== undefined ? { expected: clip(show(one.expected)) } : {}),
          ...(one.actual !== undefined ? { actual: clip(show(one.actual)) } : {}),
          ...(one.error ? { error: clip(String(one.error)) } : {}),
        }
        if (at >= 0) state.cases[at] = row
        else state.cases.push(row)
      } catch {
        rest += piece
      }
      continue
    }
    rest += piece
  }
  return rest
}

function show(value) {
  return typeof value === 'string' ? JSON.stringify(value) : JSON.stringify(value) ?? String(value)
}

function addOutput(category, text) {
  if (category === 'stdout' || category === 'console') text = takeCases(text)
  if (!text) return
  state.output.push({ category, text: text.length > MAX_OUTPUT_CHARS ? `…${text.slice(-MAX_OUTPUT_CHARS)}` : text })
  if (state.output.length > MAX_OUTPUT) state.output.splice(0, state.output.length - MAX_OUTPUT)
  // Keep the newest MAX_OUTPUT_CHARS characters in all.
  let total = state.output.reduce((n, o) => n + o.text.length, 0)
  while (total > MAX_OUTPUT_CHARS && state.output.length > 1) total -= state.output.shift().text.length
}

// ---------------------------------------------------------------- DAP wire

class Dap {
  constructor(readable, writable, label) {
    this.label = label
    this.writable = writable
    this.seq = 1
    this.pending = new Map()
    this.buffer = Buffer.alloc(0)
    this.onEvent = () => {}
    this.onRequest = () => {}
    this.closed = false
    readable.on('data', chunk => this.read(chunk))
    readable.on('close', () => this.close('connection closed'))
  }

  read(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk])
    for (;;) {
      const end = this.buffer.indexOf('\r\n\r\n')
      if (end < 0) return
      const header = this.buffer.subarray(0, end).toString('utf8')
      const match = /Content-Length:\s*(\d+)/i.exec(header)
      if (!match) { this.buffer = this.buffer.subarray(end + 4); continue }
      const length = Number(match[1])
      if (this.buffer.length < end + 4 + length) return
      const body = this.buffer.subarray(end + 4, end + 4 + length).toString('utf8')
      this.buffer = this.buffer.subarray(end + 4 + length)
      let message
      try { message = JSON.parse(body) } catch { continue }
      this.dispatch(message)
    }
  }

  dispatch(message) {
    if (message.type === 'response') {
      const waiting = this.pending.get(message.request_seq)
      if (!waiting) return
      this.pending.delete(message.request_seq)
      clearTimeout(waiting.timer)
      if (message.success) waiting.resolve(message.body ?? {})
      else waiting.reject(new Error(message.message || `${waiting.command} failed`))
    } else if (message.type === 'event') {
      this.onEvent(message)
    } else if (message.type === 'request') {
      this.onRequest(message)
    }
  }

  send(message) {
    if (this.closed) return
    const body = JSON.stringify({ seq: this.seq++, ...message })
    this.writable.write(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`)
  }

  request(command, args = {}, timeoutMs = 20000) {
    if (this.closed) return Promise.reject(new Error('debugger is not running'))
    const seq = this.seq
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(seq)
        reject(new Error(`${command} timed out`))
      }, timeoutMs)
      this.pending.set(seq, { resolve, reject, timer, command })
      this.send({ type: 'request', command, arguments: args })
    })
  }

  respond(request, body = {}, success = true) {
    this.send({ type: 'response', request_seq: request.seq, command: request.command, success, body })
  }

  waitEvent(name, timeoutMs = 20000) {
    return new Promise((resolve, reject) => {
      const before = this.onEvent
      const timer = setTimeout(() => { this.onEvent = before; reject(new Error(`no ${name} event`)) }, timeoutMs)
      this.onEvent = message => {
        before(message)
        if (message.event === name) { clearTimeout(timer); this.onEvent = before; resolve(message.body ?? {}) }
      }
    })
  }

  close(reason) {
    if (this.closed) return
    this.closed = true
    for (const waiting of this.pending.values()) {
      clearTimeout(waiting.timer)
      waiting.reject(new Error(reason))
    }
    this.pending.clear()
  }
}

// ---------------------------------------------------------------- languages

const LANGS = {
  python: {
    ext: ['.py'],
    async adapter() {
      const lib = path.join(CACHE, 'python')
      if (!fs.existsSync(path.join(lib, 'debugpy'))) {
        throw new Error(`debugpy is not installed. Run: python3 -m pip install --target ${lib} debugpy`)
      }
      const python = argv.python ?? 'python3'
      const env = { ...process.env, PYTHONPATH: [lib, process.env.PYTHONPATH].filter(Boolean).join(path.delimiter) }
      // detached: a session of its own, with no terminal. debugpy makes the
      // program the terminal's foreground group (tcsetpgrp on /dev/tty), which
      // takes the terminal away from Claude Code and closes it. With no
      // controlling terminal that call fails, and debugpy carries on.
      const child = spawn(python, ['-m', 'debugpy.adapter'], { env, stdio: ['pipe', 'pipe', 'pipe'], detached: true })
      child.stderr.on('data', d => addOutput('adapter', d.toString()))
      return { child, dap: new Dap(child.stdout, child.stdin, 'debugpy') }
    },
    launch: config => ({
      type: 'python',
      request: 'launch',
      name: 'clawd-debug',
      program: config.program,
      args: config.args,
      cwd: config.cwd,
      env: config.env,
      console: 'internalConsole',
      redirectOutput: true,
      justMyCode: true,
      showReturnValue: true,
      stopOnEntry: false,
      python: argv.python ? [argv.python] : undefined,
    }),
  },
  // Node speaks its own inspector protocol (CDP), built in: no adapter to install.
  node: {
    ext: ['.js', '.mjs', '.cjs'],
    backend: 'cdp',
  },
  // PHP through Xdebug's own protocol (DBGp), in the Docker container that
  // serves the file when there is one (WordPress loaded through WP-CLI).
  php: {
    ext: ['.php'],
    backend: 'dbgp',
  },
}

function langFor(program, lang) {
  if (lang) {
    if (!LANGS[lang]) throw new Error(`unknown language "${lang}" (known: ${Object.keys(LANGS).join(', ')})`)
    return lang
  }
  const ext = path.extname(program).toLowerCase()
  for (const [name, def] of Object.entries(LANGS)) if (def.ext.includes(ext)) return name
  throw new Error(`no debugger for "${ext}" files yet (known: ${Object.keys(LANGS).join(', ')})`)
}

// ---------------------------------------------------------------- shared by every backend

class Base {
  constructor(lang) {
    this.lang = lang
    this.prev = null // the last stop's frame and locals, to see what a line changed
    // What the paused line will set, worked out before it runs ({ line, name, value }):
    // for a value the language drops before the next stop (Node at a return).
    this.predicted = null
    this.ended = false
  }

  // error: the uncaught error it stopped on ("KeyError: 'missing'"), if any.
  async publish(frames, scopes, reason, error) {
    const top = frames[0]
    this.recordLineValues(frames, scopes)
    await this.decorate(scopes).catch(error => addOutput('clawd-debug', `${error.message}\n`))
    state.status = 'paused'
    state.steps += 1
    state.stop = top ? { reason, file: top.file, line: top.line, frame: top.name } : { reason }
    if (error) state.stop.error = clip(error)
    state.frames = frames.map(({ name, file, line }) => ({ name, file, line }))
    state.scopes = scopes
    emit()
    settle()
  }

  // What the line we just left changed: locals that are new or different now,
  // and a function's return value, pinned to that line.
  recordLineValues(frames, scopes) {
    const top = frames[0]
    if (!top) return
    const locals = new Map((scopes.find(s => /local/i.test(s.name)) ?? scopes[0] ?? { vars: [] }).vars.map(v => [v.name, v.value]))
    const key = `${top.file}#${top.name}#${frames.length}`
    const prev = this.prev
    if (prev && prev.key === key) {
      // Only names the line itself spells: a value that shows up for another
      // reason (a loop's new block, a callee's side effect) is not this line's.
      const text = sourceLine(prev.file, prev.line)
      const changed = {}
      for (const [name, value] of locals) {
        if (isReturn(name)) continue
        if (prev.locals.get(name) !== value && mentions(text, name)) changed[name] = value
      }
      // A name the line set that is gone now: use the value worked out before it ran.
      const guess = this.predicted
      if (guess && guess.line === prev.line && !locals.has(guess.name) && !(guess.name in changed)) changed[guess.name] = guess.value
      if (Object.keys(changed).length) pin(prev.file, prev.line, changed)
    }
    for (const [name, value] of locals) {
      if (isReturn(name)) pin(top.file, top.line, { [`↩ ${name.replace(/^\(return\)\s*|^Return value\s*/i, '') || 'return'}`]: value })
    }
    // First stop in a frame: show the arguments it was called with.
    if (!prev || prev.key !== key) {
      const args = {}
      for (const [name, value] of locals) if (!isReturn(name)) args[name] = value
      if (Object.keys(args).length && (!prev || frames.length >= prev.depth)) pin(top.file, top.line, args, true)
    }
    this.prev = { key, file: top.file, line: top.line, depth: frames.length, locals }
  }

  // Reads the children of every open row, and evaluates the watches, at a stop.
  async decorate(scopes) {
    const open = new Set(state.expanded)
    const fill = async (vars, prefix, depth) => {
      for (const v of vars) {
        const at = [...prefix, v.name]
        if (v.ref && open.has(pathKey(at)) && depth < 6) {
          v.children = (await this.expand(v.ref).catch(() => [])).slice(0, MAX_VARS)
          await fill(v.children, at, depth + 1)
        } else {
          delete v.children
        }
      }
    }
    for (const scope of scopes) await fill(scope.vars, [scope.name], 0)
    const watches = []
    for (const { expr } of state.watches) {
      try {
        const answer = await this.evaluate(expr, 'watch')
        watches.push({ expr, name: expr, value: answer.result, type: answer.type ?? '', ref: answer.ref ?? 0 })
      } catch (error) {
        watches.push({ expr, name: expr, value: '', type: '', ref: 0, error: clip(String(error.message).split('\n')[0]) })
      }
    }
    await fill(watches, ['Watch'], 0)
    state.watches = watches
  }

  end() {
    if (this.ended) return
    this.ended = true
    this.kill()
    if (session === this) session = null
    if (state.status !== 'error') state.status = 'ended'
    state.stop = null
    // No stack once the program is gone; the last values stay to read.
    state.frames = []
    emit()
    settle()
  }
}

const MAX_VALUE = 400

function clip(text) {
  const value = String(text ?? '')
  return value.length > MAX_VALUE ? `${value.slice(0, MAX_VALUE - 1)}…` : value
}

function pathKey(names) {
  return JSON.stringify(names)
}

function isReturn(name) {
  return /^\(return\)|^Return value/i.test(name)
}

const sources = new Map() // file -> its lines, read once per run

function sourceLine(file, line) {
  if (!sources.has(file)) {
    try { sources.set(file, fs.readFileSync(file, 'utf8').split('\n')) } catch { sources.set(file, []) }
  }
  return sources.get(file)[line - 1] ?? ''
}

function mentions(text, name) {
  // No source to read (a generated file): keep the value rather than lose it.
  if (!text) return true
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`(^|[^\\w$])${escaped}($|[^\\w$])`).test(text)
}

// ---------------------------------------------------------------- a DAP run (Python, ...)

const INIT_ARGS = {
  clientID: 'clawd-debug',
  clientName: 'clawd-debug',
  linesStartAt1: true,
  columnsStartAt1: true,
  pathFormat: 'path',
  supportsVariableType: true,
  supportsRunInTerminalRequest: false,
  supportsStartDebuggingRequest: true,
}

class Debug extends Base {
  constructor(lang) {
    super(lang)
    this.adapter = null
    this.root = null // the first DAP connection
    this.active = null // the connection whose program stopped last
    this.children = []
    this.threadId = null
    this.topFrameId = null
  }

  async start(config) {
    const def = LANGS[this.lang]
    this.adapter = await def.adapter()
    this.adapter.child.on('exit', () => this.end())
    this.root = this.adapter.dap
    this.active = this.root
    await this.boot(this.root, def.launch(config))
  }

  // initialize -> launch (answered late) -> initialized -> breakpoints -> configurationDone
  async boot(dap, launchArgs) {
    this.wire(dap)
    await dap.request('initialize', { ...INIT_ARGS, adapterID: this.lang })
    const initialized = dap.waitEvent('initialized')
    const launched = dap.request('launch', launchArgs, 60000)
    launched.catch(error => fail(error))
    await initialized
    await this.sendBreakpoints(dap)
    // Stop on an uncaught error, with its variables, instead of ending the run.
    await dap.request('setExceptionBreakpoints', { filters: ['uncaught'] }).catch(() => {})
    await dap.request('configurationDone').catch(() => {})
    return launched
  }

  wire(dap) {
    dap.onEvent = message => this.event(dap, message).catch(error => addOutput('clawd-debug', `${error.message}\n`))
    dap.onRequest = request => this.reverse(dap, request).catch(error => addOutput('clawd-debug', `${error.message}\n`))
  }

  // No reverse request (runInTerminal, startDebugging) is supported yet.
  async reverse(dap, request) {
    dap.respond(request, {}, false)
  }

  async event(dap, message) {
    const body = message.body ?? {}
    switch (message.event) {
      case 'output':
        if (body.category === 'telemetry') return
        addOutput(body.category ?? 'console', body.output)
        emit()
        return
      case 'stopped':
        this.active = dap
        await this.paused(dap, body)
        return
      case 'continued':
        if (state.status === 'paused') { state.status = 'running'; emit() }
        return
      case 'breakpoint':
        return
      case 'exited':
        state.exitCode = body.exitCode ?? null
        emit()
        return
      case 'terminated':
        if (dap === this.root || this.children.length === 0 || dap === this.active) this.end()
        return
    }
  }

  async paused(dap, body) {
    let threadId = body.threadId
    if (threadId == null) {
      const { threads = [] } = await dap.request('threads')
      threadId = threads[0]?.id
    }
    this.threadId = threadId
    const { stackFrames = [] } = await dap.request('stackTrace', { threadId, startFrame: 0, levels: 30 })
    const frames = stackFrames
      .filter(f => f.source?.path || f.source?.name)
      .map(f => ({ id: f.id, name: f.name, file: f.source?.path ?? f.source?.name, line: f.line }))
    const top = frames[0]
    this.topFrameId = top?.id ?? null
    const scopes = top ? await this.readScopes(dap, top.id) : []
    let error
    if (body.reason === 'exception') {
      const info = await dap.request('exceptionInfo', { threadId }).catch(() => null)
      error = info ? [info.exceptionId, info.description].filter(Boolean).join(': ') : body.text || body.description || 'exception'
    }
    await this.publish(frames, scopes, body.reason ?? 'pause', error)
  }

  async readScopes(dap, frameId) {
    const { scopes = [] } = await dap.request('scopes', { frameId })
    const out = []
    for (const scope of scopes) {
      const isGlobal = /^global/i.test(scope.name)
      if (scope.expensive && !/local/i.test(scope.name)) { out.push({ name: scope.name, vars: [], ref: scope.variablesReference }); continue }
      const vars = await this.readVars(dap, scope.variablesReference)
      out.push({ name: scope.name, ref: scope.variablesReference, vars: isGlobal ? vars.filter(isUserGlobal) : vars })
      if (out.length >= 3) break
    }
    return out
  }

  async readVars(dap, ref) {
    if (!ref) return []
    const { variables = [] } = await dap.request('variables', { variablesReference: ref }).catch(() => ({}))
    return variables
      .filter(v => !/^(special|function|class|protected) variables$/.test(v.name))
      .slice(0, MAX_VARS)
      .map(v => ({ name: v.name, value: clip(v.value), type: v.type ?? '', ref: v.variablesReference ?? 0 }))
  }

  async step(command) {
    if (state.status !== 'paused') throw new Error(`the program is ${state.status}, not paused`)
    state.status = 'running'
    emit()
    await this.active.request(command, { threadId: this.threadId })
  }

  async pause() {
    if (state.status !== 'running') throw new Error(`the program is ${state.status}, not running`)
    await this.active.request('pause', { threadId: this.threadId ?? 0 })
  }

  async sendBreakpoints(dap) {
    for (const [file, list] of Object.entries(state.breakpoints)) {
      const answer = await dap.request('setBreakpoints', {
        source: { path: file, name: path.basename(file) },
        breakpoints: list.map(b => ({ line: b.line, ...(b.condition ? { condition: b.condition } : {}) })),
        lines: list.map(b => b.line),
      }).catch(() => null)
      if (answer?.breakpoints) {
        state.breakpoints[file] = list.map((b, i) => ({
          line: answer.breakpoints[i]?.line ?? b.line,
          verified: answer.breakpoints[i]?.verified ?? false,
          ...(b.condition ? { condition: b.condition } : {}),
        }))
      }
    }
  }

  async updateBreakpoints() {
    for (const dap of [this.root, ...this.children]) if (!dap.closed) await this.sendBreakpoints(dap)
  }

  async evaluate(expression, context = 'repl') {
    const dap = this.active
    const answer = await dap.request('evaluate', { expression, frameId: this.topFrameId ?? undefined, context })
    return { result: answer.result, type: answer.type ?? '', ref: answer.variablesReference ?? 0 }
  }

  expand(ref) {
    return this.readVars(this.active, ref)
  }

  async stop() {
    for (const dap of [...this.children, this.root]) {
      if (dap && !dap.closed) await dap.request('disconnect', { terminateDebuggee: true }, 5000).catch(() => {})
    }
    this.kill()
    this.end()
  }

  kill() {
    for (const dap of [...this.children, this.root]) dap?.close('stopped')
    try { this.adapter?.child.kill() } catch {}
  }
}

// ---------------------------------------------------------------- a Node run (V8 inspector)

const CDP_STEPS = { next: 'Debugger.stepOver', stepIn: 'Debugger.stepInto', stepOut: 'Debugger.stepOut', continue: 'Debugger.resume' }
// The names Node's module wrapper adds to every file's top level.
const NODE_WRAPPER = /^(require|module|exports|__filename|__dirname)$/
const NODE_NOISE = /^(Debugger listening on|For help, see|Debugger attached|Debugger ending on|Waiting for the debugger to disconnect)/

class NodeDebug extends Base {
  constructor(lang) {
    super(lang)
    this.child = null
    this.ws = null
    this.seq = 1
    this.pending = new Map()
    this.scripts = new Map() // scriptId -> url
    this.bpIds = [] // breakpoint ids the inspector gave us
    this.refs = new Map() // our variable ref -> objectId
    this.nextRef = 1
    this.callFrameId = null
    this.started = false
    this.stepping = null // 'next' or 'stepIn' while a line-by-line step runs
    this.repeats = 0
    this.lastSpot = null
  }

  async start(config) {
    this.child = spawn(process.execPath, ['--inspect-brk=127.0.0.1:0', config.program, ...config.args], {
      // No terminal for the program either (see the Python adapter above).
      cwd: config.cwd, stdio: ['ignore', 'pipe', 'pipe'], detached: true, env: { ...process.env, ...config.env },
    })
    this.child.on('exit', code => { state.exitCode = code; this.end() })
    this.child.stdout.on('data', d => { addOutput('stdout', d.toString()); emit() })
    const url = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('node did not open its inspector')), 10000)
      let found = false
      this.child.stderr.on('data', d => {
        for (const line of d.toString().split(/(?<=\n)/)) {
          const match = /Debugger listening on (ws:\/\/\S+)/.exec(line)
          if (match && !found) { found = true; clearTimeout(timer); resolve(match[1]) }
          if (/Waiting for the debugger to disconnect/.test(line)) this.ws?.close()
          if (!NODE_NOISE.test(line.trim())) { addOutput('stderr', line); emit() }
        }
      })
    })
    this.ws = new WebSocket(url)
    await new Promise((resolve, reject) => {
      this.ws.addEventListener('open', resolve, { once: true })
      this.ws.addEventListener('error', () => reject(new Error('could not reach the node inspector')), { once: true })
    })
    this.ws.addEventListener('message', ev => this.read(JSON.parse(String(ev.data))))
    this.ws.addEventListener('close', () => this.close('inspector closed'))
    await this.call('Runtime.enable')
    await this.call('Debugger.enable')
    await this.call('Debugger.setBlackboxPatterns', { patterns: ['^node:', 'node:internal', '/node_modules/'] }).catch(() => {})
    // Stop on an uncaught error, with its variables, instead of ending the run.
    await this.call('Debugger.setPauseOnExceptions', { state: 'uncaught' }).catch(() => {})
    await this.updateBreakpoints()
    await this.call('Runtime.runIfWaitingForDebugger')
  }

  call(method, params = {}, timeoutMs = 20000) {
    if (!this.ws || this.ws.readyState !== 1) return Promise.reject(new Error('debugger is not running'))
    const id = this.seq++
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`${method} timed out`)) }, timeoutMs)
      this.pending.set(id, { resolve, reject, timer })
      this.ws.send(JSON.stringify({ id, method, params }))
    })
  }

  close(reason) {
    for (const waiting of this.pending.values()) { clearTimeout(waiting.timer); waiting.reject(new Error(reason)) }
    this.pending.clear()
  }

  read(message) {
    if (message.id) {
      const waiting = this.pending.get(message.id)
      if (!waiting) return
      this.pending.delete(message.id)
      clearTimeout(waiting.timer)
      if (message.error) waiting.reject(new Error(message.error.message))
      else waiting.resolve(message.result ?? {})
      return
    }
    if (message.method === 'Debugger.scriptParsed') this.scripts.set(message.params.scriptId, message.params.url)
    else if (message.method === 'Debugger.paused') this.paused(message.params).catch(error => addOutput('clawd-debug', `${error.message}\n`))
    else if (message.method === 'Debugger.resumed' && state.status === 'paused') { state.status = 'running'; emit() }
  }

  async paused(params) {
    // --inspect-brk stops before the first line; go on to the breakpoints.
    if (!this.started) {
      this.started = true
      if (params.reason === 'Break on start' || !(params.hitBreakpoints?.length)) {
        await this.call('Debugger.resume')
        return
      }
    }
    // V8 pauses at several spots of one line (a `for`, a chained call); a
    // line-by-line step goes on until the line or the frame changes.
    const first = params.callFrames[0]
    const here = first && `${first.location.scriptId}:${first.location.lineNumber}:${params.callFrames.length}`
    if (this.stepping && here === this.lastSpot && this.repeats < 25) {
      this.repeats += 1
      await this.call(CDP_STEPS[this.stepping])
      return
    }
    this.stepping = null
    this.repeats = 0
    this.lastSpot = here
    this.refs.clear()
    const frames = params.callFrames.map(f => ({
      id: f.callFrameId,
      name: f.functionName || '(top level)',
      file: toPath(f.url || this.scripts.get(f.location.scriptId) || ''),
      line: f.location.lineNumber + 1,
    })).filter(f => f.file && !f.file.startsWith('node:'))
    const top = params.callFrames[0]
    this.callFrameId = top?.callFrameId ?? null
    const scopes = top ? await this.readScopes(top) : []
    const isError = params.reason === 'exception' || params.reason === 'promiseRejection'
    const reason = params.reason === 'other' ? (params.hitBreakpoints?.length ? 'breakpoint' : 'step') : isError ? 'exception' : params.reason
    const error = isError ? (params.data?.description ?? params.data?.value ?? 'exception').toString().split('\n')[0] : undefined
    // Node leaves a function's block scope before its return stop, so the
    // line before a return would show nothing: work out what it will set now,
    // before the pause is announced and a step can resume the program.
    const guess = top && frames[0] ? await this.predict(top.callFrameId, frames[0].file, frames[0].line).catch(() => null) : null
    await this.publish(frames, scopes, reason, error)
    this.predicted = guess
  }

  // For a line `[const|let|var] name = expr;` (or `+=` and the like), the
  // value it will set, evaluated where it is paused with V8's side-effect
  // check on: anything that could change state is refused, so nothing runs twice.
  async predict(callFrameId, file, line) {
    const text = sourceLine(file, line)
    const m = /^\s*(?:(?:const|let|var)\s+)?([A-Za-z_$][\w$]*)\s*([-+*/%]|\*\*|\?\?|\|\||&&)?=(?!=)\s*(.+?)\s*;?\s*$/.exec(text)
    if (!m || !balanced(m[3])) return null
    const [, name, op, rhs] = m
    const expression = op ? `${name} ${op} (${rhs})` : `(${rhs})`
    const answer = await this.call('Debugger.evaluateOnCallFrame', { callFrameId, expression, generatePreview: true, throwOnSideEffect: true, silent: true })
    if (answer.exceptionDetails || !answer.result) return null
    return { line, name, value: clip(formatRemote(answer.result)) }
  }

  // Block scopes and the function's own scope read as one "Locals", the way
  // the code reads; closures and the module scope come after.
  async readScopes(frame) {
    const locals = []
    const seen = new Set()
    const out = []
    if (frame.returnValue) locals.push(this.toVar('Return value', frame.returnValue))
    for (const scope of frame.scopeChain) {
      if (scope.type === 'global') continue
      const vars = await this.readObject(scope.object.objectId)
      if (scope.type === 'block' || scope.type === 'local' || scope.type === 'catch') {
        for (const v of vars) if (!seen.has(v.name) && !NODE_WRAPPER.test(v.name)) { seen.add(v.name); locals.push(v) }
      } else if (out.length < 2) {
        out.push({ name: scope.type === 'closure' ? 'Closure' : 'Module', vars: vars.filter(v => !NODE_WRAPPER.test(v.name)) })
      }
    }
    return [{ name: 'Locals', vars: locals }, ...out]
  }

  async readObject(objectId, depth = 0) {
    const { result = [] } = await this.call('Runtime.getProperties', { objectId, ownProperties: true, generatePreview: true }).catch(() => ({}))
    const vars = []
    for (const p of result.filter(p => p.value && !p.name.startsWith('__')).slice(0, MAX_VARS)) {
      const v = this.toVar(p.name, p.value)
      // V8's preview stops one level down ("[Object, Object]"); read one more.
      if (depth === 0 && p.value.objectId && /\bObject\b|\bArray\(/.test(v.value) && p.value.preview?.properties?.length <= 20) {
        const inner = await this.readObject(p.value.objectId, 1)
        const isArray = p.value.subtype === 'array'
        const parts = inner.filter(x => !(isArray && x.name === 'length')).map(x => (isArray ? x.value : `${x.name}: ${x.value}`))
        v.value = clip(isArray ? `[${parts.join(', ')}]` : `{${parts.join(', ')}}`)
      }
      vars.push(v)
    }
    return vars
  }

  toVar(name, object) {
    let ref = 0
    if (object.objectId && object.type === 'object') { ref = this.nextRef++; this.refs.set(ref, object.objectId) }
    return { name, value: clip(formatRemote(object)), type: object.subtype ?? object.className ?? object.type, ref }
  }

  async step(command) {
    if (state.status !== 'paused') throw new Error(`the program is ${state.status}, not paused`)
    state.status = 'running'
    emit()
    this.stepping = command === 'next' || command === 'stepIn' ? command : null
    this.repeats = 0
    await this.call(CDP_STEPS[command])
  }

  async pause() {
    if (state.status !== 'running') throw new Error(`the program is ${state.status}, not running`)
    await this.call('Debugger.pause')
  }

  async updateBreakpoints() {
    for (const id of this.bpIds) await this.call('Debugger.removeBreakpoint', { breakpointId: id }).catch(() => {})
    this.bpIds = []
    for (const [file, list] of Object.entries(state.breakpoints)) {
      const urlRegex = `^(${escapeRe(file)}|${escapeRe(pathToUrl(file))})$`
      state.breakpoints[file] = []
      for (const b of list) {
        const answer = await this.call('Debugger.setBreakpointByUrl', { lineNumber: b.line - 1, urlRegex, condition: b.condition ?? '' }).catch(() => null)
        if (answer?.breakpointId) this.bpIds.push(answer.breakpointId)
        const at = answer?.locations?.[0]
        state.breakpoints[file].push({ line: at ? at.lineNumber + 1 : b.line, verified: Boolean(at), ...(b.condition ? { condition: b.condition } : {}) })
      }
    }
  }

  async evaluate(expression) {
    const answer = this.callFrameId
      ? await this.call('Debugger.evaluateOnCallFrame', { callFrameId: this.callFrameId, expression, generatePreview: true })
      : await this.call('Runtime.evaluate', { expression, generatePreview: true })
    if (answer.exceptionDetails) throw new Error(answer.exceptionDetails.exception?.description ?? answer.exceptionDetails.text)
    const v = this.toVar(expression, answer.result)
    return { result: v.value, type: v.type, ref: v.ref }
  }

  async expand(ref) {
    const objectId = this.refs.get(ref)
    if (!objectId) throw new Error('that value is gone: the program moved on')
    return this.readObject(objectId)
  }

  async stop() {
    this.kill()
    this.end()
  }

  kill() {
    try { this.ws?.close() } catch {}
    try { this.child?.kill() } catch {}
    this.close('stopped')
  }
}

// Brackets and quotes close on the line: a statement that goes on to the next
// line is not worked out ahead.
function balanced(text) {
  let depth = 0
  let quote = ''
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (quote) { if (ch === '\\') i++; else if (ch === quote) quote = ''; continue }
    if (ch === '"' || ch === "'" || ch === '`') quote = ch
    else if ('([{'.includes(ch)) depth++
    else if (')]}'.includes(ch)) depth--
    if (depth < 0) return false
  }
  return depth === 0 && !quote
}

function formatRemote(o) {
  if (!o) return 'undefined'
  switch (o.type) {
    case 'undefined': return 'undefined'
    case 'string': return JSON.stringify(o.value)
    case 'number': case 'boolean': return o.unserializableValue ?? String(o.value)
    case 'bigint': return o.unserializableValue ?? o.description
    case 'symbol': return o.description
    case 'function': return `ƒ ${(o.description ?? '').split('\n')[0].replace(/\{.*$/, '').trim().slice(0, 60)}`
    case 'object':
      if (o.subtype === 'null') return 'null'
      if (o.preview) return formatPreview(o.preview)
      return o.description ?? 'Object'
  }
  return o.description ?? String(o.value)
}

function formatPreview(p) {
  const value = x => x.valuePreview ? formatPreview(x.valuePreview) : x.type === 'string' ? JSON.stringify(x.value) : x.type === 'function' ? 'ƒ' : (x.value ?? x.type)
  if (p.subtype === 'array') return `[${p.properties.map(value).concat(p.overflow ? ['…'] : []).join(', ')}]`
  if (p.subtype === 'map' || p.subtype === 'set') return p.description
  if (p.subtype && p.subtype !== 'object') return p.description
  const body = `{${p.properties.map(x => `${x.name}: ${value(x)}`).concat(p.overflow ? ['…'] : []).join(', ')}}`
  return p.description && p.description !== 'Object' ? `${p.description} ${body}` : body
}

function toPath(url) {
  if (url.startsWith('file://')) { try { return decodeURIComponent(new URL(url).pathname) } catch { return url } }
  return url
}

function pathToUrl(file) {
  return 'file://' + file.split('/').map(encodeURIComponent).join('/')
}

function escapeRe(text) {
  return text.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')
}

// Every value a line set, per name: a loop's line shows them all, not the last.
const history = new Map() // `${file}:${line}:${name}` -> { values: string[], count }
const HISTORY = 4

function pin(file, line, values, isArgs = false) {
  if (!file || !line) return
  const forFile = (state.lineValues[file] ??= {})
  const at = (forFile[line] ??= {})
  for (const [name, value] of Object.entries(values)) {
    const key = `${file}:${line}:${name}`
    const seen = history.get(key) ?? { values: [], count: 0 }
    // The arguments are pinned at each call; the same value again adds nothing.
    if (isArgs && seen.values.at(-1) === value) continue
    seen.count += 1
    seen.values.push(value)
    if (seen.values.length > HISTORY) seen.values.shift()
    history.set(key, seen)
    at[name] = showHistory(seen)
  }
}

// "5.5", or "10 → 20 → 25.5 (×3)", or "… → 70 → 80 (×8)" past HISTORY values.
function showHistory({ values, count }) {
  if (count === 1) return values[0] ?? ''
  const shown = values.join(' → ')
  return clip(`${count > values.length ? '… → ' : ''}${shown} (×${count})`)
}

function isUserGlobal(v) {
  if (v.name.startsWith('__')) return false
  return !/^(module|function|type|builtin_function_or_method|ABCMeta)$/.test(v.type)
}

function fail(error) {
  state.status = 'error'
  state.error = error.message
  emit()
  settle()
}

// ---------------------------------------------------------------- a PHP run (Xdebug, DBGp)

class PhpDebug extends Base {
  constructor(lang) {
    super(lang)
    this.server = null
    this.sock = null
    this.child = null
    this.target = null
    this.tid = 1
    this.pending = new Map()
    this.buffer = Buffer.alloc(0)
    this.bpIds = []
    this.refs = new Map() // our ref -> { fullname, depth }
    this.nextRef = 1
    this.onInit = null
  }

  async start(config) {
    const target = await phpTarget(config.program)
    this.target = target
    const remote = this.toRemote(config.program)
    const env = ['-e', 'XDEBUG_TRIGGER=1', '-e', `XDEBUG_CONFIG=idekey=clawd-debug`, ...Object.entries(config.env ?? {}).flatMap(([k, v]) => ['-e', `${k}=${v}`])]
    let argv
    if (target.container) {
      const cwd = this.toRemote(config.cwd && config.cwd.startsWith(target.hostRoot) ? config.cwd : path.dirname(config.program))
      // A plugin or theme file is not a script: running it would declare its
      // classes twice and crash WordPress. Load WordPress instead, so its
      // breakpoints in code that runs on load stop; a function needs a harness (t).
      const isLibrary = target.wpRoot && !/\/\.clawd-debug\//.test(config.program) && /\/wp-content\//.test(config.program)
      if (isLibrary) addOutput('clawd-debug', 'This file is part of WordPress (a plugin or theme), so only WordPress is loaded: breakpoints in code that runs on load stop. To run one of its functions with test data, press t.\n')
      const wp = ['docker', 'exec', ...env, '-w', cwd, target.container, 'wp', '--allow-root', `--path=${target.wpRoot}`]
      argv = !target.wpRoot
        ? ['docker', 'exec', ...env, '-w', cwd, target.container, 'php', remote, ...config.args]
        : isLibrary
          ? [...wp, 'eval', 'echo "WordPress loaded.\\n";']
          : [...wp, 'eval-file', ...(target.canInclude ? ['--use-include'] : []), remote, ...config.args]
      // Older WP-CLI evals the file's text (dbgp://N for Xdebug): map it back.
      if (target.wpRoot && !isLibrary && !target.canInclude) this.useEvalFile(config.program)
    } else {
      argv = ['php', '-d', 'xdebug.mode=debug', '-d', 'xdebug.start_with_request=yes', '-d', `xdebug.client_host=${target.host}`, '-d', `xdebug.client_port=${target.port}`, config.program, ...config.args]
    }

    this.server = net.createServer(sock => this.attach(sock))
    await new Promise((resolve, reject) => {
      this.server.once('error', error => reject(new Error(error.code === 'EADDRINUSE'
        ? `port ${target.port} on ${target.host} is taken (is another debugger, like VS Code, listening?)`
        : `could not listen on ${target.host}:${target.port}: ${error.message}`)))
      this.server.listen(target.port, target.host, resolve)
    })
    const connected = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Xdebug did not connect (is xdebug.mode=debug on?)')), 30000)
      this.onInit = () => { clearTimeout(timer); resolve() }
      this.onEarlyExit = code => { clearTimeout(timer); reject(new Error(`PHP ended before Xdebug connected (exit ${code})`)) }
    })
    addOutput('clawd-debug', `$ ${argv.slice(target.container ? 0 : 0).join(' ')}\n`)
    this.child = spawn(argv[0], argv.slice(1), { stdio: ['ignore', 'pipe', 'pipe'], detached: true, env: { ...process.env, ...config.env } })
    this.child.stdout.on('data', d => { addOutput('stdout', d.toString()); emit() })
    this.child.stderr.on('data', d => { addOutput('stderr', d.toString()); emit() })
    this.child.on('exit', code => {
      state.exitCode = code
      if (!this.sock) this.onEarlyExit?.(code)
      this.end()
    })
    await connected
    for (const [name, value] of [['max_depth', '2'], ['max_children', '40'], ['max_data', '2048'], ['breakpoint_include_return_value', '1']]) {
      await this.cmd(`feature_set -n ${name} -v ${value}`).catch(() => {})
    }
    await this.updateBreakpoints()
    // Stop on an error, with its variables. Xdebug matches exception names
    // exactly (not subclasses), so "*": the PHP warnings and notices it also
    // stops on go on by themselves (see paused).
    await this.cmd('breakpoint_set -t exception -x *').catch(() => {})
    this.go('run')
  }

  // WP-CLI's eval-file runs a file's text through eval(): Xdebug names that
  // code dbgp://N, and its lines may start further down than the file's
  // (versions differ in what they cut). Both are mapped back to the file.
  useEvalFile(file) {
    this.evalFile = file
    this.evalOffsets = new Map() // dbgp://N -> how many lines the eval'd code starts below the file's first
  }

  // Finds where the code Xdebug ran as `uri` starts in the file, by its text.
  async learnOffset(uri) {
    if (!this.evalFile || !uri?.startsWith('dbgp://') || this.evalOffsets.has(uri)) return
    this.evalOffsets.set(uri, 0)
    const doc = await this.cmd(`source -f ${uri}`).catch(() => null)
    const raw = doc ? textOf(doc) : ''
    const code = (doc?.attrs.encoding === 'base64' ? Buffer.from(raw, 'base64').toString('utf8') : raw).split('\n')
    const lines = fs.readFileSync(this.evalFile, 'utf8').split('\n')
    const head = code.slice(0, 3).map(l => l.trim())
    for (let k = 0; k < Math.min(lines.length, 20); k++) {
      if (head.every((l, i) => (lines[k + i] ?? '').trim().endsWith(l))) { this.evalOffsets.set(uri, k); return }
    }
  }

  hostLine(uri, line) {
    return uri?.startsWith('dbgp://') && this.evalFile ? line + (this.evalOffsets.get(uri) ?? 0) : line
  }

  attach(sock) {
    if (this.sock) { sock.destroy(); return } // one PHP process per run
    this.sock = sock
    this.server?.close()
    sock.on('data', chunk => this.read(chunk))
    sock.on('close', () => { this.sock = null; this.fail('Xdebug closed the connection') })
    sock.on('error', () => {})
  }

  read(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk])
    for (;;) {
      const zero = this.buffer.indexOf(0)
      if (zero < 0) return
      const length = Number(this.buffer.subarray(0, zero).toString('latin1'))
      if (this.buffer.length < zero + 1 + length + 1) return
      const xml = this.buffer.subarray(zero + 1, zero + 1 + length).toString('utf8')
      this.buffer = this.buffer.subarray(zero + 1 + length + 1)
      const doc = parseXml(xml)
      if (!doc) continue
      if (doc.name === 'init') { this.onInit?.(); continue }
      if (doc.name === 'response') {
        const waiting = this.pending.get(Number(doc.attrs.transaction_id))
        if (waiting) { this.pending.delete(Number(doc.attrs.transaction_id)); waiting(doc) }
      }
    }
  }

  cmd(command, data) {
    if (!this.sock) return Promise.reject(new Error('debugger is not running'))
    const id = this.tid++
    const [name, ...rest] = command.split(' ')
    const line = `${name} -i ${id}${rest.length ? ` ${rest.join(' ')}` : ''}${data != null ? ` -- ${Buffer.from(data).toString('base64')}` : ''}`
    return new Promise((resolve, reject) => {
      this.pending.set(id, doc => {
        const error = find(doc, 'error')
        if (error) reject(new Error(textOf(find(error, 'message')) || `${name} failed (${error.attrs.code})`))
        else resolve(doc)
      })
      this.sock.write(`${line}\0`)
    })
  }

  // run and the steps answer only once PHP stops again.
  go(command) {
    this.cmd(command).then(doc => this.after(doc), error => this.fail(error.message))
  }

  async after(doc) {
    const status = doc.attrs.status
    if (status === 'break') return this.paused(doc)
    if (status === 'stopping') {
      this.finishing = true
      this.cmd('stop').catch(() => {})
      return
    }
    if (status === 'stopped') { this.finishing = true; this.end() }
  }

  async paused(doc) {
    const message = find(doc, 'xdebug:message')
    // A step's answer may not name the file: the top of the stack does.
    const stack = await this.cmd('stack_get')
    for (const f of children(stack, 'stack')) await this.learnOffset(f.attrs.filename)
    const topFrame = children(stack, 'stack')[0]
    const where = this.toHost(message?.attrs.filename || topFrame?.attrs.filename || '')
    // Where PHP really is: a step out stops at the callee's return, so the
    // stack's top can still be in the callee while the message names the caller.
    const inside = this.toHost(topFrame?.attrs.filename || message?.attrs.filename || '')
    const kind = message?.attrs.exception ?? ''
    // A PHP warning or notice is not an error to stop on: go on. Nor is the
    // "Fatal error" that follows an uncaught exception it already stopped on.
    if (kind && /^(warning|notice|deprecated|strict standards|user (warning|notice|deprecated)|xdebug)$/i.test(kind)) { this.go('run'); return }
    if (/^fatal error$/i.test(kind) && this.stoppedOnError) { this.go('run'); return }
    // Like Python's and Node's "my code only": a step into WordPress core or a
    // vendor library steps back out, and an error raised (and maybe caught)
    // there goes on. A breakpoint set there still stops.
    // Xdebug marks a stop on an exception breakpoint by the message's
    // `exception` attribute (its reason can still read "ok").
    const isError = doc.attrs.reason === 'exception' || Boolean(message?.attrs.exception)
    if (isError && where && isNotOwnCode(where, this.target)) { this.go('run'); return }
    if (this.lastStep === 'step' && inside && isNotOwnCode(inside, this.target) && (this.skips ?? 0) < 30) {
      this.skips = (this.skips ?? 0) + 1
      // At the skipped function's return: keep what it returned on the line
      // that called it, then go on to the caller's next stop.
      const returned = find(doc, 'xdebug:return_value')
      const value = returned && find(returned, 'property')
      if (value && message && !isNotOwnCode(where, this.target)) {
        pin(where, this.hostLine(message.attrs.filename, Number(message.attrs.lineno)), { [`↩ ${topFrame?.attrs.where ?? 'return'}`]: clip(phpValue(value)) })
      }
      this.go(value ? 'step_over' : 'step_out')
      return
    }
    this.skips = 0
    this.stoppedOnError = isError
    const error = isError && message
      ? [message.attrs.exception, textOf(message)].filter(Boolean).join(': ')
      : undefined
    const frames = children(stack, 'stack').map(f => ({
      name: f.attrs.where === '{main}' ? '(top level)' : f.attrs.where,
      file: this.toHost(f.attrs.filename),
      line: this.hostLine(f.attrs.filename, Number(f.attrs.lineno)),
      level: Number(f.attrs.level),
    })).filter(f => !f.file.startsWith('dbgp:'))
    // Frames outside the project (WP-CLI's phar and launcher, the container's
    // own PHP, WordPress core, vendor) say little about the code: keep the top one only.
    const own = frames.filter((f, i) => i === 0 || !isNotOwnCode(f.file, this.target))
    frames.splice(0, frames.length, ...own)
    this.refs.clear()
    const locals = []
    const returned = find(doc, 'xdebug:return_value')
    const retProp = returned && find(returned, 'property')
    if (retProp) locals.push(this.toVar('Return value', retProp, 0))
    const context = await this.cmd('context_get -d 0 -c 0').catch(() => null)
    for (const prop of context ? children(context, 'property') : []) {
      if (locals.length >= MAX_VARS) break
      // Not assigned yet, or Xdebug's "::" entry for the class's static properties.
      if (prop.attrs.type === 'uninitialized' || prop.attrs.name === '::' || prop.attrs.name === '$__RETURN_VALUE') continue
      locals.push(this.toVar(prop.attrs.name, prop, 0))
    }
    // WP-CLI's eval-file runs the file inside its own method: name the frame by the file.
    for (const f of frames) if (/^eval$|eval_file|WP_CLI|wp-cli/i.test(f.name) && f.file === state.program) f.name = '(top level)'
    await this.publish(frames, [{ name: 'Locals', vars: locals }], error ? 'exception' : doc.attrs.reason === 'ok' ? (this.lastStep ?? 'breakpoint') : doc.attrs.reason, error)
  }

  toVar(name, prop, depth) {
    let ref = 0
    if (Number(prop.attrs.children) > 0 && prop.attrs.fullname) {
      ref = this.nextRef++
      this.refs.set(ref, { fullname: prop.attrs.fullname, depth })
    }
    return { name, value: clip(phpValue(prop)), type: prop.attrs.classname ?? prop.attrs.type ?? '', ref }
  }

  async step(command) {
    if (state.status !== 'paused') throw new Error(`the program is ${state.status}, not paused`)
    state.status = 'running'
    emit()
    const map = { next: 'step_over', stepIn: 'step_into', stepOut: 'step_out', continue: 'run' }
    this.lastStep = command === 'continue' ? 'breakpoint' : 'step'
    this.go(map[command])
  }

  async pause() {
    throw new Error('PHP cannot be paused while it runs; set a breakpoint instead')
  }

  async updateBreakpoints() {
    if (!this.sock) return
    for (const id of this.bpIds) await this.cmd(`breakpoint_remove -d ${id}`).catch(() => {})
    this.bpIds = []
    for (const [file, list] of Object.entries(state.breakpoints)) {
      const uri = 'file://' + this.toRemote(file)
      state.breakpoints[file] = []
      for (const b of list) {
        // A condition goes as the command's data: Xdebug stops only when it is true.
        const doc = await (b.condition
          ? this.cmd(`breakpoint_set -t conditional -f ${uri} -n ${b.line}`, b.condition)
          : this.cmd(`breakpoint_set -t line -f ${uri} -n ${b.line}`)).catch(() => null)
        if (doc?.attrs.id) this.bpIds.push(doc.attrs.id)
        const resolved = find(doc ?? { children: [] }, 'breakpoint')
        state.breakpoints[file].push({ line: resolved ? Number(resolved.attrs.lineno) || b.line : b.line, verified: Boolean(doc?.attrs.id), ...(b.condition ? { condition: b.condition } : {}) })
      }
    }
  }

  async evaluate(expression) {
    const doc = await this.cmd('eval', expression)
    const prop = find(doc, 'property')
    if (!prop) return { result: '(nothing)', type: '', ref: 0 }
    const v = this.toVar(expression, prop, 0)
    return { result: v.value, type: v.type, ref: v.ref }
  }

  async expand(ref) {
    const at = this.refs.get(ref)
    if (!at) throw new Error('that value is gone: the program moved on')
    const doc = await this.cmd(`property_get -d ${at.depth} -n ${quoteArg(at.fullname)}`)
    const prop = find(doc, 'property')
    return prop ? children(prop, 'property').map(c => this.toVar(c.attrs.name, c, at.depth)) : []
  }

  async stop() {
    this.finishing = true
    if (this.sock) await Promise.race([this.cmd('stop').catch(() => {}), new Promise(r => setTimeout(r, 2000))])
    this.kill()
    this.end()
  }

  kill() {
    try { this.sock?.destroy() } catch {}
    try { this.server?.close() } catch {}
    try { this.child?.kill() } catch {}
    for (const waiting of this.pending.values()) waiting({ name: 'response', attrs: {}, children: [{ name: 'error', attrs: { code: 'stopped' }, children: [] }] })
    this.pending.clear()
  }

  fail(message) {
    if (this.ended || this.finishing) return
    if (state.status === 'starting' || state.status === 'running') addOutput('clawd-debug', `${message}\n`)
  }

  toRemote(file) {
    const t = this.target
    if (!t?.container) return file
    const real = realpath(file)
    return real.startsWith(t.hostRoot) ? t.remoteRoot + real.slice(t.hostRoot.length) : real
  }

  toHost(uri) {
    if (uri.startsWith('dbgp://') && this.evalFile) return this.evalFile
    let file = uri.startsWith('file://') ? decodeURIComponent(uri.slice(7)) : uri
    const t = this.target
    if (t?.container && file.startsWith(t.remoteRoot)) file = t.hostRoot + file.slice(t.remoteRoot.length)
    return file
  }
}

// WordPress core, a vendor library, WP-CLI's phar or a file this machine
// does not have: code the person did not write, which a step skips.
function isNotOwnCode(file, target) {
  if (!file || file.startsWith('phar:') || !fs.existsSync(file)) return true
  if (/\/vendor\//.test(file)) return true
  // In a container, only files under its bind mount are the project's.
  if (target?.container && !file.startsWith(target.hostRoot + '/')) return true
  if (target?.wpRoot && target.container) {
    const root = target.hostRoot + target.wpRoot.slice(target.remoteRoot.length)
    if (file.startsWith(root + '/wp-includes/') || file.startsWith(root + '/wp-admin/')) return true
    if (path.dirname(file) === root) return true // wp-load.php, wp-settings.php and the like
  }
  return false
}

// Which PHP runs this file: a running container whose bind mount holds it
// (with Xdebug), else this machine's php (with Xdebug).
async function phpTarget(program) {
  const real = realpath(program)
  const probe = 'echo json_encode(["x"=>extension_loaded("xdebug"),"mode"=>ini_get("xdebug.mode"),"host"=>gethostbyname(ini_get("xdebug.client_host") ?: "localhost"),"port"=>(int)(ini_get("xdebug.client_port") ?: 9003)]);'
  const names = (await host('docker', ['ps', '--format', '{{.Names}}']).catch(() => '')).split('\n').filter(Boolean)
  let best = null
  for (const name of names) {
    const mounts = JSON.parse((await host('docker', ['inspect', '-f', '{{json .Mounts}}', name]).catch(() => '[]')) || '[]')
    for (const m of mounts) {
      const source = realpath(m.Source)
      if (!real.startsWith(source + '/')) continue
      if (best && best.hostRoot.length >= source.length) continue
      best = { container: name, hostRoot: source, remoteRoot: m.Destination }
    }
  }
  if (best) {
    const info = JSON.parse(await host('docker', ['exec', best.container, 'php', '-r', probe]).catch(() => '{}') || '{}')
    if (!info.x) throw new Error(`the container ${best.container} serves this file, but its PHP has no Xdebug`)
    if (!/debug/.test(info.mode)) throw new Error(`Xdebug in ${best.container} runs without debug mode (xdebug.mode=${info.mode})`)
    // WordPress: the nearest folder up from the file (inside the mount) with wp-load.php.
    let dir = path.dirname(real)
    while (dir.startsWith(best.hostRoot)) {
      if (fs.existsSync(path.join(dir, 'wp-load.php'))) { best.wpRoot = best.remoteRoot + dir.slice(best.hostRoot.length); break }
      const up = path.dirname(dir)
      if (up === dir) break
      dir = up
    }
    // A WP-CLI that can include the file (not eval its text) keeps its real
    // name and lines, so breakpoints in a harness stop too.
    if (best.wpRoot) {
      const help = await host('docker', ['exec', '-e', 'PAGER=cat', best.container, 'wp', '--allow-root', `--path=${best.wpRoot}`, 'help', 'eval-file']).catch(() => '')
      best.canInclude = help.includes('--use-include')
    }
    return { ...best, host: info.host, port: info.port }
  }
  const info = JSON.parse(await host('php', ['-r', probe]).catch(() => '{}') || '{}')
  if (!info.x) throw new Error('no PHP with Xdebug runs this file: no container mounts it, and this machine\'s php has no Xdebug')
  return { container: null, host: '127.0.0.1', port: info.port || 9003 }
}

function host(cmd, args) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: 15000, maxBuffer: 4 << 20 }, (error, stdout) => (error ? reject(error) : resolve(String(stdout).trim())))
  })
}

function realpath(file) {
  try { return fs.realpathSync(file) } catch { return file }
}

function quoteArg(text) {
  return `"${String(text).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
}

// A PHP value as one line: 'text', 12, true, null, [1, 2], ['a' => 1], Foo {x: 1}.
function phpValue(prop) {
  const type = prop.attrs.type
  const raw = textOf(prop)
  const text = prop.attrs.encoding === 'base64' ? Buffer.from(raw, 'base64').toString('utf8') : raw
  switch (type) {
    case 'null': return 'null'
    case 'uninitialized': return 'uninitialized'
    case 'bool': return text === '1' ? 'true' : 'false'
    case 'int': case 'float': return text
    case 'string': return `'${text.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'${Number(prop.attrs.size) > Buffer.byteLength(text) ? '…' : ''}`
    case 'array': {
      const items = children(prop, 'property')
      const count = Number(prop.attrs.numchildren ?? items.length)
      if (!count) return '[]'
      const isList = items.every((c, i) => c.attrs.name === String(i))
      const parts = items.map(c => (isList ? phpValue(c) : `${phpKey(c.attrs.name)} => ${phpValue(c)}`))
      if (count > items.length) parts.push(items.length ? '…' : `… ${count} items`)
      return `[${parts.join(', ')}]`
    }
    case 'object': {
      const items = children(prop, 'property')
      const parts = items.map(c => `${c.attrs.name}: ${phpValue(c)}`)
      if (Number(prop.attrs.numchildren ?? 0) > items.length) parts.push('…')
      return `${prop.attrs.classname ?? 'object'} {${parts.join(', ')}}`
    }
    default: return text || type || ''
  }
}

function phpKey(name) {
  return /^\d+$/.test(name) ? name : `'${name}'`
}

// Enough XML for DBGp: elements, attributes, text and CDATA.
function parseXml(xml) {
  const root = { name: '#root', attrs: {}, children: [], text: '' }
  const stack = [root]
  const re = /<!\[CDATA\[([\s\S]*?)\]\]>|<\?[\s\S]*?\?>|<!--[\s\S]*?-->|<\/([\w:.-]+)\s*>|<([\w:.-]+)((?:\s+[\w:.-]+\s*=\s*"[^"]*")*)\s*(\/?)>|([^<]+)/g
  let m
  while ((m = re.exec(xml))) {
    const top = stack[stack.length - 1]
    if (m[1] != null) top.text += m[1]
    else if (m[2]) { if (stack.length > 1) stack.pop() }
    else if (m[3]) {
      const node = { name: m[3], attrs: {}, children: [], text: '' }
      for (const a of m[4].matchAll(/([\w:.-]+)\s*=\s*"([^"]*)"/g)) node.attrs[a[1]] = unescapeXml(a[2])
      top.children.push(node)
      if (!m[5]) stack.push(node)
    } else if (m[6]) top.text += unescapeXml(m[6])
  }
  return root.children[0] ?? null
}

function unescapeXml(text) {
  return text.replace(/&(lt|gt|amp|quot|apos|#\d+|#x[0-9a-f]+);/gi, (_, e) => ({ lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" }[e] ?? String.fromCodePoint(e[1] === 'x' ? parseInt(e.slice(2), 16) : Number(e.slice(1)))))
}

function children(node, name) {
  return node.children.filter(c => c.name === name)
}

function find(node, name) {
  return node.children.find(c => c.name === name)
}

function textOf(node) {
  return node?.text?.trim() ?? ''
}

// ---------------------------------------------------------------- commands

let lastConfig = null

const commands = {
  async start(input) {
    if (session) await session.stop()
    if (!input.program) throw new Error('start needs "program": the file to run')
    // Real paths everywhere: a file reached through a symlink must match what
    // the debugger reports (it reports the real path).
    const program = realpath(path.resolve(input.cwd ?? process.cwd(), input.program))
    if (!fs.existsSync(program)) throw new Error(`no such file: ${program}`)
    const lang = langFor(program, input.lang)
    const env = Object.fromEntries(Object.entries(input.env ?? {}).map(([k, v]) => [String(k), String(v)]))
    const config = { program, args: input.args ?? [], cwd: realpath(input.cwd ?? path.dirname(program)), lang, env }
    // A rerun of one case keeps the last full run to come back to.
    if (!input.isCaseRun) lastConfig = config
    if (input.breakpoints) {
      state.breakpoints = {}
      for (const bp of input.breakpoints) {
        const file = realpath(path.resolve(config.cwd, bp.file))
        const condition = bp.condition ? String(bp.condition).trim() : ''
        ;(state.breakpoints[file] ??= []).push({ line: Number(bp.line), verified: false, ...(condition ? { condition } : {}) })
      }
    }
    sources.clear()
    history.clear()
    Object.assign(state, {
      status: 'starting', lang, program, cwd: config.cwd, args: config.args,
      stop: null, frames: [], scopes: [], lineValues: {}, output: [], exitCode: null, error: null, steps: 0,
      watches: state.watches.map(({ expr }) => ({ expr, name: expr, value: '', type: '', ref: 0 })),
      // A rerun of one case keeps the full run's cases, to update its own row.
      cases: input.isCaseRun ? state.cases : [], caseFilter: env.CLAWD_CASE ?? '', runId: state.runId + 1,
    })
    caseBuffer = ''
    emit()
    const backend = LANGS[lang].backend
    const debug = backend === 'cdp' ? new NodeDebug(lang) : backend === 'dbgp' ? new PhpDebug(lang) : new Debug(lang)
    session = debug
    try {
      await debug.start(config)
      if (state.status === 'starting') { state.status = 'running'; emit() }
    } catch (error) {
      debug.kill()
      if (session === debug) session = null
      throw error
    }
  },
  async restart() {
    if (!lastConfig) throw new Error('nothing to restart yet')
    await commands.start({ ...lastConfig, breakpoints: undefined })
  },
  // Runs the last program again for one test case only (CLAWD_CASE=name),
  // so it stops at the breakpoints on that case's way.
  async rerunCase(input) {
    if (!lastConfig) throw new Error('nothing to rerun yet')
    const name = String(input.name ?? '')
    if (!name) throw new Error('rerunCase needs "name"')
    await commands.start({ ...lastConfig, env: { ...lastConfig.env, CLAWD_CASE: name }, breakpoints: undefined, isCaseRun: true })
  },
  async stop() { if (session) await session.stop() },
  next: () => need().step('next'),
  stepIn: () => need().step('stepIn'),
  stepOut: () => need().step('stepOut'),
  continue: () => need().step('continue'),
  pause: () => need().pause(),
  // `lines` (each keeps the condition it had), or `breakpoints`: [{ line, condition }]
  // where a condition given ('' for none) replaces the old one.
  async setBreakpoints(input) {
    const file = realpath(path.resolve(state.cwd ?? process.cwd(), input.file))
    const had = new Map((state.breakpoints[file] ?? []).map(b => [b.line, b.condition ?? '']))
    const given = input.breakpoints ?? (input.lines ?? []).map(line => ({ line }))
    const byLine = new Map()
    for (const b of given) {
      const line = Number(b.line)
      if (Number.isInteger(line) && line > 0) byLine.set(line, b.condition !== undefined ? String(b.condition).trim() : had.get(line) ?? '')
    }
    const list = [...byLine].sort((a, b) => a[0] - b[0]).map(([line, condition]) => ({ line, verified: false, ...(condition ? { condition } : {}) }))
    if (list.length) state.breakpoints[file] = list
    else delete state.breakpoints[file]
    if (session) await session.updateBreakpoints()
    emit()
  },
  async toggleBreakpoint(input) {
    const file = realpath(path.resolve(state.cwd ?? process.cwd(), input.file))
    const now = (state.breakpoints[file] ?? []).map(b => b.line)
    const line = Number(input.line)
    const lines = now.includes(line) ? now.filter(l => l !== line) : [...now, line]
    await commands.setBreakpoints({ file, lines })
  },
  // Sets the line's breakpoint to stop only when `condition` is true (made
  // if there is none); an empty condition makes it a plain breakpoint.
  async setCondition(input) {
    const file = realpath(path.resolve(state.cwd ?? process.cwd(), input.file))
    const line = Number(input.line)
    const rest = (state.breakpoints[file] ?? []).filter(b => b.line !== line).map(b => ({ line: b.line, condition: b.condition ?? '' }))
    await commands.setBreakpoints({ file, breakpoints: [...rest, { line, condition: String(input.condition ?? '') }] })
  },
  async evaluate(input) { return need().evaluate(String(input.expression ?? input.expr ?? '')) },
  async addWatch(input) {
    const expr = String(input.expr ?? '').trim()
    if (!expr) throw new Error('addWatch needs "expr"')
    if (!state.watches.some(w => w.expr === expr)) state.watches.push({ expr, name: expr, value: '', type: '', ref: 0 })
    await refresh()
  },
  async removeWatch(input) {
    state.watches = state.watches.filter(w => w.expr !== input.expr)
    state.expanded = state.expanded.filter(key => !key.startsWith(pathKey(['Watch', input.expr]).slice(0, -1)))
    emit()
  },
  // path: the names from the scope (or "Watch") down to the row.
  async toggleExpand(input) {
    const key = pathKey(input.path ?? [])
    const isOpen = state.expanded.includes(key)
    // Closing a row closes what was open under it too.
    state.expanded = isOpen ? state.expanded.filter(k => k !== key && !k.startsWith(key.slice(0, -1) + ',')) : [...state.expanded, key]
    await refresh()
  },
  // What a reloaded mod had: its watches and open rows.
  async restore(input) {
    for (const expr of input.watches ?? []) if (!state.watches.some(w => w.expr === expr)) state.watches.push({ expr, name: expr, value: '', type: '', ref: 0 })
    state.expanded = [...new Set([...state.expanded, ...(input.expanded ?? [])])]
    await refresh()
  },
  async expand(input) { return { vars: await need().expand(Number(input.ref)) } },
}

// While paused, reads the open rows and the watches again for the current stop.
async function refresh() {
  if (session && state.status === 'paused') await session.decorate(state.scopes)
  emit()
}

function need() {
  if (!session) throw new Error('no debug session: start one first')
  return session
}

const STEPS = new Set(['start', 'restart', 'rerunCase', 'next', 'stepIn', 'stepOut', 'continue'])

async function run(input) {
  const name = input?.cmd
  if (!commands[name]) throw new Error(`unknown command "${name}"`)
  // A new run first ends the old one: its end must not answer the new wait.
  if ((name === 'start' || name === 'restart' || name === 'rerunCase') && session) await session.stop()
  const settled = input.wait && STEPS.has(name) ? waitForSettle(Number(input.timeoutMs ?? 30000)) : null
  const extra = (await commands[name](input)) ?? {}
  if (settled) await settled
  return { ok: true, ...extra, state }
}

// ---------------------------------------------------------------- server

try { fs.unlinkSync(SOCKET) } catch {}

const server = http.createServer((req, res) => {
  const reply = (code, body) => {
    res.writeHead(code, { 'content-type': 'application/json' })
    res.end(JSON.stringify(body))
  }
  if (req.method === 'GET' && req.url === '/state') return reply(200, { ok: true, state })
  if (req.method !== 'POST' || req.url !== '/cmd') return reply(404, { ok: false, error: 'not found' })
  let body = ''
  req.on('data', d => { body += d })
  req.on('end', async () => {
    let input
    try { input = JSON.parse(body || '{}') } catch { return reply(400, { ok: false, error: 'body is not JSON' }) }
    try {
      reply(200, await run(input))
    } catch (error) {
      if (input.cmd === 'start') fail(error)
      reply(200, { ok: false, error: error.message, state })
    }
  })
})

server.listen(SOCKET, () => {
  fs.chmodSync(SOCKET, 0o600)
  process.stdout.write(JSON.stringify({ type: 'ready', socket: SOCKET, pid: process.pid }) + '\n')
  emit()
})

// Leave with the mod: when the parent goes away, or on a signal.
const parent = process.ppid
const watchdog = setInterval(() => { if (process.ppid !== parent) shutdown() }, 2000)
watchdog.unref()
process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)

function shutdown() {
  try { session?.kill() } catch {}
  try { fs.unlinkSync(SOCKET) } catch {}
  process.exit(0)
}

function parseArgs(list) {
  const out = {}
  for (let i = 0; i < list.length; i++) {
    if (list[i].startsWith('--')) out[list[i].slice(2)] = list[i + 1]?.startsWith('--') ? true : list[++i]
  }
  return out
}
