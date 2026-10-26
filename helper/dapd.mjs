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
const MAX_VARS = 80

// ---------------------------------------------------------------- state

const state = {
  status: 'idle', // idle | starting | running | paused | ended | error
  lang: null,
  program: null,
  cwd: null,
  args: [],
  breakpoints: {}, // file -> [{ line, verified }]
  stop: null, // { reason, file, line, frame }
  frames: [], // [{ name, file, line }]
  scopes: [], // [{ name, vars: [{ name, value, type, ref }] }]
  lineValues: {}, // file -> line -> { name: value }, what each line changed
  output: [], // [{ category, text }]
  exitCode: null,
  error: null,
  steps: 0,
}

let session = null // the running Debug, if any
const waiters = new Set()

function emit() {
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

function addOutput(category, text) {
  if (!text) return
  state.output.push({ category, text })
  if (state.output.length > MAX_OUTPUT) state.output.splice(0, state.output.length - MAX_OUTPUT)
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
    this.ended = false
  }

  publish(frames, scopes, reason) {
    const top = frames[0]
    this.recordLineValues(frames, scopes)
    state.status = 'paused'
    state.steps += 1
    state.stop = top ? { reason, file: top.file, line: top.line, frame: top.name } : { reason }
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

  end() {
    if (this.ended) return
    this.ended = true
    this.kill()
    if (session === this) session = null
    if (state.status !== 'error') state.status = 'ended'
    state.stop = null
    emit()
    settle()
  }
}

const MAX_VALUE = 400

function clip(text) {
  const value = String(text ?? '')
  return value.length > MAX_VALUE ? `${value.slice(0, MAX_VALUE - 1)}…` : value
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
    this.publish(frames, scopes, body.reason ?? 'pause')
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
        breakpoints: list.map(b => ({ line: b.line })),
        lines: list.map(b => b.line),
      }).catch(() => null)
      if (answer?.breakpoints) {
        state.breakpoints[file] = list.map((b, i) => ({
          line: answer.breakpoints[i]?.line ?? b.line,
          verified: answer.breakpoints[i]?.verified ?? false,
        }))
      }
    }
  }

  async updateBreakpoints() {
    for (const dap of [this.root, ...this.children]) if (!dap.closed) await this.sendBreakpoints(dap)
  }

  async evaluate(expression) {
    const dap = this.active
    const answer = await dap.request('evaluate', { expression, frameId: this.topFrameId ?? undefined, context: 'repl' })
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
const NODE_NOISE = /^(Debugger listening on|For help, see|Debugger attached|Waiting for the debugger to disconnect)/

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
      cwd: config.cwd, stdio: ['ignore', 'pipe', 'pipe'], detached: true,
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
    const reason = params.reason === 'other' ? (params.hitBreakpoints?.length ? 'breakpoint' : 'step') : params.reason
    this.publish(frames, scopes, reason)
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
        const answer = await this.call('Debugger.setBreakpointByUrl', { lineNumber: b.line - 1, urlRegex }).catch(() => null)
        if (answer?.breakpointId) this.bpIds.push(answer.breakpointId)
        const at = answer?.locations?.[0]
        state.breakpoints[file].push({ line: at ? at.lineNumber + 1 : b.line, verified: Boolean(at) })
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

function pin(file, line, values, isArgs = false) {
  if (!file || !line) return
  const forFile = (state.lineValues[file] ??= {})
  const at = (forFile[line] ??= {})
  for (const [name, value] of Object.entries(values)) {
    if (isArgs && name in at) continue
    at[name] = value
  }
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
    const env = ['-e', 'XDEBUG_TRIGGER=1', '-e', `XDEBUG_CONFIG=idekey=clawd-debug`]
    let argv
    if (target.container) {
      const cwd = this.toRemote(config.cwd && config.cwd.startsWith(target.hostRoot) ? config.cwd : path.dirname(config.program))
      argv = target.wpRoot
        ? ['docker', 'exec', ...env, '-w', cwd, target.container, 'wp', '--allow-root', `--path=${target.wpRoot}`, 'eval-file', remote, ...config.args]
        : ['docker', 'exec', ...env, '-w', cwd, target.container, 'php', remote, ...config.args]
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
    this.child = spawn(argv[0], argv.slice(1), { stdio: ['ignore', 'pipe', 'pipe'], detached: true })
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
    this.go('run')
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
    const stack = await this.cmd('stack_get')
    const frames = children(stack, 'stack').map(f => ({
      name: f.attrs.where === '{main}' ? '(top level)' : f.attrs.where,
      file: this.toHost(f.attrs.filename),
      line: Number(f.attrs.lineno),
      level: Number(f.attrs.level),
    })).filter(f => !f.file.startsWith('dbgp:'))
    // Frames in files this machine does not have (WP-CLI's phar and launcher,
    // the container's own PHP) say nothing about the code: keep the top one only.
    const own = frames.filter((f, i) => i === 0 || fs.existsSync(f.file))
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
    for (const f of frames) if (/eval_file|WP_CLI|wp-cli/i.test(f.name) && f.file === state.program) f.name = '(top level)'
    this.publish(frames, [{ name: 'Locals', vars: locals }], doc.attrs.reason === 'ok' ? (this.lastStep ?? 'breakpoint') : doc.attrs.reason)
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
        const doc = await this.cmd(`breakpoint_set -t line -f ${uri} -n ${b.line}`).catch(() => null)
        if (doc?.attrs.id) this.bpIds.push(doc.attrs.id)
        const resolved = find(doc ?? { children: [] }, 'breakpoint')
        state.breakpoints[file].push({ line: resolved ? Number(resolved.attrs.lineno) || b.line : b.line, verified: Boolean(doc?.attrs.id) })
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
    let file = uri.startsWith('file://') ? decodeURIComponent(uri.slice(7)) : uri
    const t = this.target
    if (t?.container && file.startsWith(t.remoteRoot)) file = t.hostRoot + file.slice(t.remoteRoot.length)
    return file
  }
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
    const program = path.resolve(input.cwd ?? process.cwd(), input.program)
    if (!fs.existsSync(program)) throw new Error(`no such file: ${program}`)
    const lang = langFor(program, input.lang)
    const config = { program, args: input.args ?? [], cwd: input.cwd ?? path.dirname(program), lang }
    lastConfig = config
    if (input.breakpoints) {
      state.breakpoints = {}
      for (const bp of input.breakpoints) {
        const file = path.resolve(config.cwd, bp.file)
        ;(state.breakpoints[file] ??= []).push({ line: Number(bp.line), verified: false })
      }
    }
    sources.clear()
    Object.assign(state, {
      status: 'starting', lang, program, cwd: config.cwd, args: config.args,
      stop: null, frames: [], scopes: [], lineValues: {}, output: [], exitCode: null, error: null, steps: 0,
    })
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
  async stop() { if (session) await session.stop() },
  next: () => need().step('next'),
  stepIn: () => need().step('stepIn'),
  stepOut: () => need().step('stepOut'),
  continue: () => need().step('continue'),
  pause: () => need().pause(),
  async setBreakpoints(input) {
    const file = path.resolve(state.cwd ?? process.cwd(), input.file)
    const lines = [...new Set((input.lines ?? []).map(Number))].sort((a, b) => a - b)
    if (lines.length) state.breakpoints[file] = lines.map(line => ({ line, verified: false }))
    else delete state.breakpoints[file]
    if (session) await session.updateBreakpoints()
    emit()
  },
  async toggleBreakpoint(input) {
    const file = path.resolve(state.cwd ?? process.cwd(), input.file)
    const now = (state.breakpoints[file] ?? []).map(b => b.line)
    const line = Number(input.line)
    const lines = now.includes(line) ? now.filter(l => l !== line) : [...now, line]
    await commands.setBreakpoints({ file, lines })
  },
  async evaluate(input) { return need().evaluate(String(input.expression ?? input.expr ?? '')) },
  async expand(input) { return { vars: await need().expand(Number(input.ref)) } },
}

function need() {
  if (!session) throw new Error('no debug session: start one first')
  return session
}

const STEPS = new Set(['start', 'restart', 'next', 'stepIn', 'stepOut', 'continue'])

async function run(input) {
  const name = input?.cmd
  if (!commands[name]) throw new Error(`unknown command "${name}"`)
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
