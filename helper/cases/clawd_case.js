// clawd-debug test cases: copy next to your harness and require it.
//
//   const { clawdCase } = require('./clawd_case.js')
//   clawdCase('empty list', () => calcTotal([]), 0)
//
// Runs one case, compares its result with what is expected (deep equality),
// and prints one line the debugger reads. With CLAWD_CASE set (a rerun of one
// case) only that case runs, and an error is not caught, so the debugger stops on it.
const { isDeepStrictEqual } = require('node:util')

function clawdCase(name, run, expected) {
  const only = process.env.CLAWD_CASE || ''
  if (only && only !== name) return
  const out = { name, expected }
  if (only) {
    out.actual = run()
  } else {
    try {
      out.actual = run()
    } catch (error) {
      out.error = `${error?.name ?? 'Error'}: ${error?.message ?? error}`
    }
  }
  out.ok = !('error' in out) && isDeepStrictEqual(out.actual, expected)
  console.log('@@clawd-case ' + JSON.stringify(out))
}

module.exports = { clawdCase }
