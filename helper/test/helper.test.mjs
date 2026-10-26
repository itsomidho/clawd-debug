// Tests for the helper (dapd.mjs): each one starts the real helper and drives
// real debuggers through it, as the mod does.
//
//   node --test 'helper/test/*.test.mjs'
//
// Node tests always run. Python tests run when debugpy is installed
// (`/dbg setup`). PHP tests run when CLAWD_DEBUG_PHP_DIR names a folder that a
// running Docker container with Xdebug serves (a WordPress site adds the
// WordPress tests); they copy their files into `<dir>/.clawd-debug/` and
// remove them after.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { after, before, describe, test } from 'node:test'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const HELPER = path.join(HERE, '..', 'dapd.mjs')
const FIX = fs.realpathSync(path.join(HERE, 'fixtures'))
const CACHE = path.join(os.homedir(), '.cache', 'clawd-debug')
const HAS_DEBUGPY = fs.existsSync(path.join(CACHE, 'python', 'debugpy'))
const PHP_DIR = process.env.CLAWD_DEBUG_PHP_DIR ? fs.realpathSync(process.env.CLAWD_DEBUG_PHP_DIR) : ''

// One helper process, its socket, and every line it printed.
class Helper {
  static async start() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clawd-debug-test-'))
    const helper = new Helper(dir)
    await helper.ready
    return helper
  }

  constructor(dir) {
    this.dir = dir
    this.socket = path.join(dir, 'helper.sock')
    this.lines = []
    this.child = spawn(process.execPath, [HELPER, '--socket', this.socket], { stdio: ['ignore', 'pipe', 'pipe'] })
    let buffer = ''
    this.ready = new Promise((resolve, reject) => {
      this.child.on('exit', code => reject(new Error(`helper exited (${code})`)))
      this.child.stdout.on('data', chunk => {
        buffer += chunk
        let cut
        while ((cut = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, cut)
          buffer = buffer.slice(cut + 1)
          this.lines.push(line)
          if (line.includes('"type":"ready"')) resolve()
        }
      })
    })
  }

  request(method, route, body) {
    return new Promise((resolve, reject) => {
      const req = http.request({ socketPath: this.socket, method, path: route, headers: { 'content-type': 'application/json' } }, res => {
        let text = ''
        res.on('data', d => { text += d })
        res.on('end', () => resolve(JSON.parse(text)))
      })
      req.on('error', reject)
      req.end(body ? JSON.stringify(body) : undefined)
    })
  }

  // Runs a command; steps and starts wait for the next stop or the end.
  async cmd(body) {
    const answer = await this.request('POST', '/cmd', { wait: true, timeoutMs: 60_000, ...body })
    assert.ok(answer.ok, `${body.cmd} failed: ${answer.error}`)
    return answer
  }

  async state() {
    return (await this.request('GET', '/state')).state
  }

  async stop() {
    await this.request('POST', '/cmd', { cmd: 'stop' }).catch(() => {})
    this.child.kill()
    fs.rmSync(this.dir, { recursive: true, force: true })
  }
}

// What `line` of `file` set, by name.
function valuesAt(state, file, line) {
  return state.lineValues[file]?.[String(line)] ?? {}
}

// Steps until the program stops at `line` of `file` (or gives up).
async function stepTo(helper, file, line, max = 20) {
  let state = await helper.state()
  for (let i = 0; i < max && !(state.stop?.file === file && state.stop?.line === line); i++) {
    state = (await helper.cmd({ cmd: 'next' })).state
    if (state.status !== 'paused') break
  }
  return state
}

// ---------------------------------------------------------------- Node

describe('Node', () => {
  let helper
  before(async () => { helper = await Helper.start() })
  after(() => helper.stop())

  const calc = path.join(FIX, 'calc.js')

  test('stops at a breakpoint and shows each loop pass on its line', async () => {
    const { state } = await helper.cmd({ cmd: 'start', program: calc, breakpoints: [{ file: calc, line: 2 }] })
    assert.equal(state.status, 'paused')
    assert.equal(state.stop.line, 2)
    assert.equal(state.stop.frame, 'calcTotal')
    const end = await stepTo(helper, calc, 9)
    assert.equal(end.stop.line, 9)
    assert.equal(valuesAt(end, calc, 4).price, '20 → 5.5 (×2)')
    assert.equal(valuesAt(end, calc, 5).subtotal, '20 → 25.5 (×2)')
  })

  test('the line before a return shows what it set, and the return its value', async () => {
    const state = await helper.state()
    assert.equal(valuesAt(state, calc, 8).total, '27.8')
    assert.equal(valuesAt(state, calc, 9)['↩ return'], '27.8')
  })

  test('evaluates an expression in the paused frame', async () => {
    await helper.cmd({ cmd: 'start', program: calc, breakpoints: [{ file: calc, line: 7 }] })
    const answer = await helper.request('POST', '/cmd', { cmd: 'evaluate', expression: 'subtotal * 2' })
    assert.equal(answer.result, '51')
  })

  test('working a line out ahead never runs its side effects twice', async () => {
    const side = path.join(FIX, 'side.js')
    await helper.cmd({ cmd: 'start', program: side, breakpoints: [{ file: side, line: 4 }] })
    const state = await stepTo(helper, side, 6)
    assert.equal(valuesAt(state, side, 5).last, '11')
    const end = (await helper.cmd({ cmd: 'continue' })).state
    assert.match(end.output.map(o => o.text).join(''), /result 11 calls 1/)
  })

  test('an uncaught error stops on its line, with the error and the variables', async () => {
    const boom = path.join(FIX, 'boom.js')
    const { state } = await helper.cmd({ cmd: 'start', program: boom })
    assert.equal(state.status, 'paused')
    assert.equal(state.stop.reason, 'exception')
    assert.equal(state.stop.line, 2)
    assert.match(state.stop.error, /^TypeError: Cannot read properties of undefined/)
    assert.deepEqual(state.scopes[0].vars.map(v => v.name), ['x'])
  })

  test('a chatty program sends a handful of updates, and all its output', async () => {
    const before = helper.lines.length
    const { state } = await helper.cmd({ cmd: 'start', program: path.join(FIX, 'chatty.js') })
    assert.equal(state.status, 'ended')
    await new Promise(r => setTimeout(r, 300))
    const updates = helper.lines.slice(before).filter(l => l.includes('"type":"state"')).length
    assert.ok(updates < 40, `${updates} updates`)
    const output = state.output.map(o => o.text).join('')
    assert.ok(output.endsWith('line 2999\n'), `output ends with ${JSON.stringify(output.slice(-80))}`)
  })

  test('a file reached through a symlink is named by its real path', async () => {
    const link = path.join(helper.dir, 'linked')
    fs.symlinkSync(FIX, link)
    const viaLink = path.join(link, 'calc.js')
    const { state } = await helper.cmd({ cmd: 'start', program: viaLink, breakpoints: [{ file: viaLink, line: 4 }] })
    assert.equal(state.stop.file, calc)
    assert.deepEqual(Object.keys(state.breakpoints), [calc])
    const toggled = await helper.request('POST', '/cmd', { cmd: 'toggleBreakpoint', file: viaLink, line: 5 })
    assert.deepEqual(toggled.state.breakpoints[calc].map(b => b.line), [4, 5])
  })

  test('watches are worked out at every stop, errors included, and outlive the run', async () => {
    await helper.cmd({ cmd: 'start', program: calc, breakpoints: [{ file: calc, line: 5 }] })
    await helper.request('POST', '/cmd', { cmd: 'addWatch', expr: 'subtotal + price' })
    const added = await helper.request('POST', '/cmd', { cmd: 'addWatch', expr: 'nope.x' })
    assert.deepEqual(added.state.watches.map(w => [w.expr, w.value, w.error ?? '']), [
      ['subtotal + price', '20', ''],
      ['nope.x', '', 'ReferenceError: nope is not defined'],
    ])
    const { state } = await helper.cmd({ cmd: 'continue' })
    assert.equal(state.stop.line, 5)
    assert.equal(state.watches[0].value, '25.5')
    const again = await helper.cmd({ cmd: 'start', program: calc, breakpoints: [{ file: calc, line: 5 }] })
    assert.deepEqual(again.state.watches.map(w => w.expr), ['subtotal + price', 'nope.x'])
    await helper.request('POST', '/cmd', { cmd: 'removeWatch', expr: 'nope.x' })
    assert.deepEqual((await helper.state()).watches.map(w => w.expr), ['subtotal + price'])
  })

  test('an open row shows its children, and stays open while stepping', async () => {
    await helper.cmd({ cmd: 'start', program: calc, breakpoints: [{ file: calc, line: 4 }] })
    await helper.request('POST', '/cmd', { cmd: 'toggleExpand', path: ['Locals', 'items'] })
    const opened = await helper.request('POST', '/cmd', { cmd: 'toggleExpand', path: ['Locals', 'items', '1'] })
    const items = opened.state.scopes[0].vars.find(v => v.name === 'items')
    assert.deepEqual(items.children.map(c => c.name), ['0', '1', 'length'])
    assert.deepEqual(items.children[1].children.map(c => `${c.name}=${c.value}`), ['price=5.5', 'qty=1'])
    const { state } = await helper.cmd({ cmd: 'next' })
    assert.ok(state.scopes[0].vars.find(v => v.name === 'items').children, 'still open after a step')
    // Closing a row closes what is open under it.
    await helper.request('POST', '/cmd', { cmd: 'toggleExpand', path: ['Locals', 'items'] })
    assert.deepEqual((await helper.state()).expanded, [])
  })

  test('a conditional breakpoint stops only when its condition is true', async () => {
    const { state } = await helper.cmd({ cmd: 'start', program: calc, breakpoints: [{ file: calc, line: 5, condition: 'price < 10' }] })
    assert.equal(state.stop.line, 5)
    assert.equal(state.scopes[0].vars.find(v => v.name === 'price')?.value, '5.5')
    assert.equal(state.breakpoints[calc][0].condition, 'price < 10')
    // An empty condition keeps a plain breakpoint on the line.
    const plain = await helper.request('POST', '/cmd', { cmd: 'setCondition', file: calc, line: 5, condition: '' })
    assert.deepEqual(plain.state.breakpoints[calc].map(b => [b.line, b.condition ?? '']), [[5, '']])
  })

  test('a new run started while one is paused answers for the new run', async () => {
    await helper.cmd({ cmd: 'start', program: calc, breakpoints: [{ file: calc, line: 2 }] })
    const { state } = await helper.cmd({ cmd: 'start', program: calc, breakpoints: [{ file: calc, line: 2 }] })
    assert.equal(state.status, 'paused')
    assert.equal(state.steps, 1)
  })
})

// ---------------------------------------------------------------- Python

describe('Python', { skip: !HAS_DEBUGPY && 'debugpy is not installed (/dbg setup)' }, () => {
  let helper
  before(async () => { helper = await Helper.start() })
  after(() => helper.stop())

  const calc = path.join(FIX, 'calc.py')

  test('stops at a breakpoint, keeps loop passes, and pins the return value on the call', async () => {
    const { state } = await helper.cmd({ cmd: 'start', program: calc, breakpoints: [{ file: calc, line: 2 }] })
    assert.equal(state.stop.line, 2)
    assert.equal(valuesAt(state, calc, 2).tax, '0.09')
    const end = await stepTo(helper, calc, 13, 25)
    assert.equal(valuesAt(end, calc, 4).price, '20 → 5.5 (×2)')
    assert.equal(valuesAt(end, calc, 7).total, '27.79')
    assert.equal(valuesAt(end, calc, 13)['↩ calc_total'], '27.79')
  })

  test('watches and open rows work in Python too', async () => {
    await helper.cmd({ cmd: 'start', program: calc, breakpoints: [{ file: calc, line: 5 }] })
    await helper.request('POST', '/cmd', { cmd: 'addWatch', expr: 'subtotal + price' })
    const { state } = await helper.request('POST', '/cmd', { cmd: 'toggleExpand', path: ['Locals', 'item'] })
    assert.equal(state.watches[0].value, '20')
    assert.deepEqual(state.scopes[0].vars.find(v => v.name === 'item').children.map(c => `${c.name}=${c.value}`).slice(0, 2), ["'price'=10", "'qty'=2"])
  })

  test('a conditional breakpoint stops only when its condition is true', async () => {
    await helper.cmd({ cmd: 'start', program: calc, breakpoints: [{ file: calc, line: 5 }] })
    await helper.request('POST', '/cmd', { cmd: 'setCondition', file: calc, line: 5, condition: 'price < 10' })
    const { state } = await helper.cmd({ cmd: 'continue' })
    assert.equal(state.stop.line, 5)
    assert.equal(state.scopes[0].vars.find(v => v.name === 'price')?.value, '5.5')
  })

  test('an uncaught error stops on its line, with the error and the variables', async () => {
    const boom = path.join(FIX, 'boom.py')
    const { state } = await helper.cmd({ cmd: 'start', program: boom })
    assert.equal(state.status, 'paused')
    assert.equal(state.stop.line, 2)
    assert.match(state.stop.error, /KeyError/)
    assert.equal(state.scopes[0].vars.find(v => v.name === 'x')?.value, "{'a': 1}")
  })
})

// ---------------------------------------------------------------- PHP

const IS_WP = Boolean(PHP_DIR) && fs.existsSync(path.join(PHP_DIR, 'wp-load.php'))

describe('PHP (Xdebug in Docker)', { skip: !PHP_DIR && 'set CLAWD_DEBUG_PHP_DIR to a folder a container with Xdebug serves' }, () => {
  let helper
  let dir
  before(async () => {
    dir = path.join(PHP_DIR, '.clawd-debug', `helper-tests-${process.pid}`)
    fs.mkdirSync(dir, { recursive: true })
    for (const name of fs.readdirSync(path.join(FIX, 'php'))) fs.copyFileSync(path.join(FIX, 'php', name), path.join(dir, name))
    helper = await Helper.start()
  })
  after(async () => {
    await helper.stop()
    fs.rmSync(dir, { recursive: true, force: true })
  })

  const at = name => path.join(dir, name)

  test('stops in the included code at a breakpoint and keeps loop passes', async () => {
    const lib = at('lib.php')
    const { state } = await helper.cmd({ cmd: 'start', program: at('check_total.php'), cwd: PHP_DIR, breakpoints: [{ file: lib, line: 5 }], timeoutMs: 120_000 })
    assert.equal(state.status, 'paused')
    assert.equal(state.stop.file, lib)
    assert.equal(state.stop.line, 5)
    const end = await stepTo(helper, lib, 10, 20)
    assert.equal(valuesAt(end, lib, 7).$price, '20 → 5.5 (×2)')
    assert.equal(valuesAt(end, lib, 8).$sum, '20 → 25.5 (×2)')
  })

  test('watches and open rows work in PHP too', async () => {
    const lib = at('lib.php')
    await helper.cmd({ cmd: 'start', program: at('check_total.php'), cwd: PHP_DIR, breakpoints: [{ file: lib, line: 7 }], timeoutMs: 120_000 })
    await helper.request('POST', '/cmd', { cmd: 'addWatch', expr: 'count($items)' })
    const { state } = await helper.request('POST', '/cmd', { cmd: 'toggleExpand', path: ['Locals', '$item'] })
    assert.equal(state.watches[0].value, '2')
    assert.deepEqual(state.scopes[0].vars.find(v => v.name === '$item').children.map(c => `${c.name}=${c.value}`), ['price=10', 'qty=2'])
    await helper.request('POST', '/cmd', { cmd: 'removeWatch', expr: 'count($items)' })
  })

  test('a conditional breakpoint stops only when its condition is true', async () => {
    const lib = at('lib.php')
    const { state } = await helper.cmd({ cmd: 'start', program: at('check_total.php'), cwd: PHP_DIR, breakpoints: [{ file: lib, line: 8, condition: '$price < 10' }], timeoutMs: 120_000 })
    assert.equal(state.stop.line, 8)
    assert.equal(state.scopes[0].vars.find(v => v.name === '$price')?.value, '5.5')
  })

  test('a breakpoint in the harness itself stops', async () => {
    const harness = at('check_total.php')
    const { state } = await helper.cmd({ cmd: 'start', program: harness, cwd: PHP_DIR, breakpoints: [{ file: harness, line: 5 }], timeoutMs: 120_000 })
    assert.equal(state.stop?.file, harness)
    assert.equal(state.stop?.line, 5)
    assert.equal(state.scopes[0].vars.find(v => v.name === '$total')?.value, '25.5')
  })

  test('an uncaught exception stops on the throw, with its caller on the right line', async () => {
    const lib = at('lib.php')
    const { state } = await helper.cmd({ cmd: 'start', program: at('check_throw.php'), cwd: PHP_DIR, breakpoints: [], timeoutMs: 120_000 })
    assert.equal(state.status, 'paused')
    assert.equal(state.stop.file, lib)
    assert.equal(state.stop.line, 16)
    assert.equal(state.stop.error, 'InvalidArgumentException: price is missing')
    assert.equal(state.frames[1]?.file, at('check_throw.php'))
    assert.equal(state.frames[1]?.line, 3)
    assert.equal(state.scopes[0].vars.find(v => v.name === '$row')?.value, "['qty' => 2]")
  })

  test('stepping into WordPress core steps back out, with what it returned', { skip: !IS_WP && 'not a WordPress site' }, async () => {
    const lib = at('lib.php')
    await helper.cmd({ cmd: 'start', program: at('check_wp.php'), cwd: PHP_DIR, breakpoints: [{ file: lib, line: 22 }], timeoutMs: 120_000 })
    const { state } = await helper.cmd({ cmd: 'stepIn' })
    assert.equal(state.stop.file, lib)
    assert.equal(state.stop.line, 23)
    assert.match(Object.keys(valuesAt(state, lib, 22)).join(), /↩ get_option/)
  })
})
