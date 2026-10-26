// The debugger view, drawn inside the pane. It owns the keys while the person
// has clicked into it: stepping keys go to the hooks module as posts, moving
// keys (cursor, scroll, tabs) stay here.
import type { ClientModule, RenderElement } from 'claude-code'

import type { ViewMessage, ViewProps } from '../types'

type Tab = 'vars' | 'stack' | 'output'
// cursor/top: the code window; left: how far long lines slid sideways;
// lowerTop: the details' scroll; split: the details' share of the rows.
type Local = { cursor: number; top: number; tab: Tab; followed: string; left: number; lowerTop: number; split: number; isHelpHidden?: boolean }

const TABS: Tab[] = ['vars', 'stack', 'output']
const TAB_NAMES: Record<Tab, string> = { vars: 'Variables', stack: 'Stack', output: 'Output' }

const STEP_KEYS: Record<string, ViewMessage['cmd']> = {
  n: 'next',
  s: 'stepIn',
  o: 'stepOut',
  c: 'continue',
  p: 'pause',
  r: 'run',
  q: 'stop',
}

const View: ClientModule<ViewProps, Local> = (props, surface) => {
  const { Box, Text } = surface.elements
  const columns = Math.max(20, surface.columns || 80)
  const rows = Math.max(8, surface.rows || 30)
  const last = props.firstLine + props.lines.length - 1

  // Follow the program: when it stops somewhere new, the cursor goes there.
  const spot = `${props.file}:${props.current ?? ''}:${props.steps}`
  let local: Local = { cursor: props.current ?? props.firstLine, top: props.firstLine, tab: 'vars', followed: '', left: 0, lowerTop: 0, split: 0.4, ...surface.state }
  // The keys, wrapped onto as many rows as the width needs (? hides them).
  const help = props.note ? [] : local.isHelpHidden ? [[{ key: '?', label: 'keys' }]] : packKeys(KEYS, columns)
  const helpRows = props.note ? 1 : help.length
  const lowerRows = Math.max(4, Math.min(rows - 4 - helpRows, Math.floor(rows * local.split)))
  const codeRows = Math.max(3, rows - 2 - helpRows - lowerRows)
  if (local.followed !== spot && props.current != null) {
    local = { ...local, cursor: props.current, top: around(props.current, codeRows, props.firstLine, last), followed: spot, lowerTop: 0 }
  }
  local = { ...local, top: keepVisible(local.cursor, local.top, codeRows, props.firstLine, last) }
  if (!surface.state || surface.state.followed !== local.followed) surface.setState(local)

  surface.onKey(event => {
    const at: Local = { ...local, ...surface.state }
    const step = STEP_KEYS[event.key]
    if (step && !event.ctrl && !event.meta) return surface.post({ cmd: step })
    if (event.key === 'b' || event.key === 'return') return surface.post({ cmd: 'toggleBreakpoint', line: at.cursor })
    if (event.key === 't') return surface.post({ cmd: 'testData', line: at.cursor })
    if (event.key === '?') return surface.setState({ ...at, isHelpHidden: !at.isHelpHidden })
    if (event.key === 'tab') return surface.setState({ ...at, tab: TABS[(TABS.indexOf(at.tab) + 1) % TABS.length] ?? 'vars', lowerTop: 0 })
    // The details below the code: J/K (or shift+↓/↑) scroll them, + and - resize them.
    const scroll = event.key === 'J' || (event.shift && event.key === 'down') ? 1 : event.key === 'K' || (event.shift && event.key === 'up') ? -1 : 0
    if (scroll) return surface.setState({ ...at, lowerTop: Math.max(0, at.lowerTop + scroll * 3) })
    if (event.key === '+' || event.key === '=') return surface.setState({ ...at, split: Math.min(0.75, at.split + 0.1) })
    if (event.key === '-' || event.key === '_') return surface.setState({ ...at, split: Math.max(0.2, at.split - 0.1) })
    // Long code lines slide sideways.
    const side = { left: -8, h: -8, right: 8, l: 8 }[event.key]
    if (side) return surface.setState({ ...at, left: Math.max(0, at.left + side) })
    if (event.key === 'home' || event.key === '0') return surface.setState({ ...at, left: 0 })
    const move = { up: -1, down: 1, k: -1, j: 1, pageup: -codeRows, pagedown: codeRows }[event.key]
    if (move) {
      const cursor = clamp(at.cursor + move, props.firstLine, last)
      return surface.setState({ ...at, cursor, top: keepVisible(cursor, at.top, codeRows, props.firstLine, last), lowerTop: 0 })
    }
    if (event.key === 'g' && props.current != null) {
      return surface.setState({ ...at, cursor: props.current, top: around(props.current, codeRows, props.firstLine, last) })
    }
  })

  const numberWidth = String(last).length
  const lang = langOf(props.file)
  // Comments and strings can span lines: carry the state from the file's
  // first line to the window's, so a line inside a docblock is coloured as one.
  const carry: Carry = { block: '' }
  for (let n = props.firstLine; n < local.top; n++) highlight(props.lines[n - props.firstLine] ?? '', lang, carry)
  const codeLines: RenderElement[] = []
  for (let n = local.top; n < local.top + codeRows; n++) {
    if (n > last) { codeLines.push(<Text key={`l${n}`}> </Text>); continue }
    const text = (props.lines[n - props.firstLine] ?? '').replace(/\t/g, '    ')
    const isCurrent = n === props.current
    const isBreak = props.breakpoints.includes(n)
    const isCursor = n === local.cursor
    const marker = isCurrent ? '▶' : isBreak ? '●' : ' '
    const values = props.values[String(n)]
    const shown = values ? `  ${Object.entries(values).map(([k, v]) => `${k} = ${v}`).join(', ')}` : ''
    codeLines.push(
      <Box key={`l${n}`} flexDirection="row" width={columns} overflow="hidden" backgroundColor={isCurrent ? CURRENT_LINE : undefined}>
        <Text color={isBreak ? 'red' : 'yellow'} bold>{marker}</Text>
        <Text dimColor={!isCursor} inverse={isCursor}>{String(n).padStart(numberWidth)} </Text>
        <Text wrap="truncate-end" bold={isCurrent}>
          {slide(highlight(text, lang, carry), local.left).map(seg => <Text color={seg.color} italic={seg.isComment}>{seg.text}</Text>)}
          <Text color={VALUES} dimColor={!isCurrent}>{local.left > text.length ? shown.slice(Math.min(shown.length, local.left - text.length)) : shown}</Text>
        </Text>
      </Box>,
    )
  }

  const tabBar = TABS.map(tab => (tab === local.tab ? `[${TAB_NAMES[tab]}]` : ` ${TAB_NAMES[tab]} `)).join(' ')
  const all = lowerPanel(props, local.tab, local.cursor, columns - 1)
  const room = lowerRows - 1
  // Output follows its end; the rest start at the top and scroll with J/K.
  const lowerTop = local.tab === 'output' && local.lowerTop === 0 ? Math.max(0, all.length - room) : Math.min(local.lowerTop, Math.max(0, all.length - room))
  const lower = all.slice(lowerTop, lowerTop + room)
  const more = all.length > room ? ` ${lowerTop + 1}-${Math.min(all.length, lowerTop + room)}/${all.length} J/K ` : ''

  return (
    <Box flexDirection="column" width={columns} height={rows}>
      <Text wrap="truncate-end" bold color={props.error ? 'red' : STATUS_COLOR[props.status]}>
        {headline(props)}
      </Text>
      {props.note
        ? <Text wrap="truncate-end" dimColor>{props.note}</Text>
        : help.map((row, i) => (
          <Box key={`k${i}`} flexDirection="row" height={1} overflow="hidden">
            {row.map(item => (
              <Text>
                <Text color={KEY_COLOR} bold>{item.key}</Text>
                <Text dimColor>{` ${item.label}   `}</Text>
              </Text>
            ))}
          </Box>
        ))}
      <Box flexDirection="column" height={codeRows} overflow="hidden">
        {props.lines.length ? codeLines : <Text dimColor>{'Nothing to show yet. Ask Claude to debug a function, or run /dbg <file>:<line>.'}</Text>}
      </Box>
      <Text dimColor wrap="truncate-end">{`${'─'.repeat(2)} ${tabBar} ${'─'.repeat(Math.max(0, columns - tabBar.length - more.length - 4))}${more}`}</Text>
      <Box flexDirection="column" height={lowerRows - 1} overflow="hidden">
        {lower.map((line, i) => (
          <Text key={`d${i}`} wrap="truncate-end" color={line.color} dimColor={line.dim} bold={line.bold}>{line.text || ' '}</Text>
        ))}
      </Box>
    </Box>
  )
}

export default View

const STATUS_COLOR: Record<string, string> = {
  idle: 'gray',
  starting: 'yellow',
  running: 'green',
  paused: 'yellow',
  ended: 'gray',
  error: 'red',
}

function headline(props: ViewProps): string {
  const name = props.file.split('/').pop() ?? ''
  switch (props.status) {
    case 'paused': return props.error
      ? `✖ ${name}:${props.current} · ${props.error}`
      : `⏸ ${name}:${props.current} in ${props.frame} (${props.reason}) · step ${props.steps}`
    case 'running': return `▶ running ${name}…`
    case 'starting': return `… starting ${name}`
    case 'ended': return `■ ended ${name}${props.note ? '' : ''} · r to run again`
    case 'error': return `✖ ${props.note || 'error'}`
    default: return name ? `○ ${name} · not running · b sets a breakpoint, t runs it with test data` : '○ clawd-debug'
  }
}

// The keys, in the order they are reached for: stepping first.
type KeyHelp = { key: string; label: string }
const KEYS: KeyHelp[] = [
  { key: 'n', label: 'next' },
  { key: 's', label: 'into' },
  { key: 'o', label: 'out' },
  { key: 'c', label: 'continue' },
  { key: 'r', label: 'run' },
  { key: 'q', label: 'stop' },
  { key: 'b', label: 'breakpoint' },
  { key: 't', label: 'test data' },
  { key: '↑↓', label: 'line' },
  { key: '←→', label: 'slide' },
  { key: 'J/K', label: 'scroll details' },
  { key: '+/-', label: 'size' },
  { key: 'tab', label: 'panel' },
  { key: '?', label: 'hide keys' },
]
const KEY_COLOR = '#e5c07b'

// Lays the keys out in rows no wider than the panel.
function packKeys(keys: KeyHelp[], width: number): KeyHelp[][] {
  const rows: KeyHelp[][] = [[]]
  let used = 0
  for (const item of keys) {
    const size = item.key.length + item.label.length + 4
    if (used + size > width && used > 0) { rows.push([]); used = 0 }
    rows[rows.length - 1]!.push(item)
    used += size
  }
  return rows
}

type Row = { text: string; color?: string; dim?: boolean; bold?: boolean }

// Everything the details can show, each long value wrapped onto as many rows
// as it needs (the panel scrolls them), never cut at the edge.
function lowerPanel(props: ViewProps, tab: Tab, cursor: number, width: number): Row[] {
  const out: Row[] = []
  const add = (text: string, style: Omit<Row, 'text'> = {}, indent = 0) => {
    for (const piece of wrap(text, width, indent)) out.push({ text: piece, ...style })
  }
  if (tab === 'vars') {
    // The line under the cursor, whole, and what it set.
    // The error the program stopped on, whole: the headline cuts it at the edge.
    if (props.error) {
      add('Error', { bold: true, color: 'red' })
      add(`  ${props.error}`, { color: 'red' }, 4)
    }
    const code = (props.lines[cursor - props.firstLine] ?? '').replace(/\t/g, '    ').trim()
    const values = props.values[String(cursor)]
    if (code || values) {
      add(`Line ${cursor}`, { bold: true })
      if (code) add(`  ${code}`, {}, 4)
      for (const [name, value] of Object.entries(values ?? {})) add(`  ${name} = ${value}`, { color: VALUES }, 4)
    }
    if (!props.scopes.length) add(props.status === 'paused' ? 'No variables here.' : 'Variables show while the program is paused.', { dim: true })
    for (const scope of props.scopes) {
      add(scope.name, { bold: true })
      if (!scope.vars.length) add('  (none)', { dim: true })
      for (const v of scope.vars) add(`  ${v.name} = ${v.value}`, { color: v.name.startsWith('↩') || /^\(return\)|^Return value/.test(v.name) ? VALUES : undefined }, 4)
    }
  } else if (tab === 'stack') {
    if (!props.frames.length) add('The call stack shows while the program is paused.', { dim: true })
    props.frames.forEach((f, i) => add(`${i === 0 ? '▶' : ' '} ${f.name}  ${f.file.split('/').pop()}:${f.line}`, { bold: i === 0 }, 4))
  } else {
    if (!props.output.length) add('No output yet.', { dim: true })
    for (const line of props.output) add(line, {}, 2)
  }
  return out
}

// Cuts text into rows of at most `width` characters; rows after the first
// start with `indent` spaces.
function wrap(text: string, width: number, indent: number): string[] {
  const room = Math.max(10, width)
  if (text.length <= room) return [text]
  const rows = [text.slice(0, room)]
  const pad = ' '.repeat(Math.min(indent, room - 5))
  for (let i = room; i < text.length; i += room - pad.length) rows.push(pad + text.slice(i, i + room - pad.length))
  return rows
}

// Drops the first `left` characters of a coloured line: the slide sideways.
function slide(segs: Seg[], left: number): Seg[] {
  if (left <= 0) return segs
  const out: Seg[] = []
  let skip = left
  for (const seg of segs) {
    if (skip >= seg.text.length) { skip -= seg.text.length; continue }
    out.push(skip > 0 ? { ...seg, text: seg.text.slice(skip) } : seg)
    skip = 0
  }
  return out
}

function clamp(n: number, low: number, high: number): number {
  return Math.min(Math.max(n, low), Math.max(low, high))
}

function around(line: number, room: number, first: number, last: number): number {
  return clamp(line - Math.floor(room / 3), first, Math.max(first, last - room + 1))
}

function keepVisible(cursor: number, top: number, room: number, first: number, last: number): number {
  if (cursor < top) return clamp(cursor, first, last)
  if (cursor >= top + room) return clamp(cursor - room + 1, first, Math.max(first, last - room + 1))
  return clamp(top, first, Math.max(first, last - room + 1))
}

// ---------------------------------------------------------------- colours

// One Dark-like colours for a dark terminal.
const COLOR = {
  keyword: '#c678dd',
  string: '#98c379',
  comment: '#7f848e',
  number: '#d19a66',
  constant: '#d19a66',
  variable: '#e06c75',
  func: '#61afef',
  type: '#e5c07b',
  decorator: '#56b6c2',
}
const VALUES = '#56b6c2'
const CURRENT_LINE = '#2c313a'

type Lang = 'php' | 'js' | 'py' | 'plain'
type Seg = { text: string; color?: string; isComment?: boolean }
// A block comment or a Python triple-quoted string still open: its closing mark.
type Carry = { block: string }

const words = (list: string) => new Set(list.split(' '))
const KEYWORDS: Record<Lang, Set<string>> = {
  php: words('abstract and array as break callable case catch class clone const continue declare default do echo else elseif empty enddeclare endfor endforeach endif endswitch endwhile enum extends final finally fn for foreach function global goto if implements include include_once instanceof insteadof interface isset list match namespace new or print private protected public readonly require require_once return static switch throw trait try unset use var while xor yield self parent int float string bool void mixed iterable object never'),
  js: words('async await break case catch class const continue debugger default delete do else export extends finally for from function if import in instanceof let new of return static super switch this throw try typeof var void while with yield'),
  py: words('and as assert async await break class continue def del elif else except finally for from global if import in is lambda nonlocal not or pass raise return try while with yield self cls'),
  plain: words(''),
}
const CONSTANTS = /^(true|false|null|undefined|None|True|False|NULL|TRUE|FALSE|NaN|Infinity)$/

function langOf(file: string): Lang {
  const ext = file.slice(file.lastIndexOf('.') + 1).toLowerCase()
  if (ext === 'php' || ext === 'phtml' || ext === 'inc') return 'php'
  if (['js', 'mjs', 'cjs', 'jsx', 'ts', 'tsx', 'mts', 'cts'].includes(ext)) return 'js'
  if (ext === 'py' || ext === 'pyw') return 'py'
  return 'plain'
}

// Splits one line into coloured pieces. Not a parser: keywords, strings,
// comments, numbers, variables, calls and types, which is what reading needs.
function highlight(line: string, lang: Lang, carry: Carry): Seg[] {
  const out: Seg[] = []
  let plain = ''
  const push = (text: string, color?: string, isComment = false) => {
    if (plain) { out.push({ text: plain }); plain = '' }
    if (text) out.push({ text, color, isComment })
  }
  let i = 0
  if (carry.block) {
    const end = line.indexOf(carry.block)
    const isComment = carry.block === '*/'
    const color = isComment ? COLOR.comment : COLOR.string
    if (end < 0) { push(line, color, isComment); return out }
    push(line.slice(0, end + carry.block.length), color, isComment)
    i = end + carry.block.length
    carry.block = ''
  }
  if (lang === 'plain') { push(line.slice(i)); return out }
  while (i < line.length) {
    const rest = line.slice(i)
    const prev = i > 0 ? line[i - 1] ?? '' : ''
    if (lang !== 'py' && rest.startsWith('/*')) {
      const end = line.indexOf('*/', i + 2)
      if (end < 0) { push(rest, COLOR.comment, true); carry.block = '*/'; break }
      push(line.slice(i, end + 2), COLOR.comment, true)
      i = end + 2
      continue
    }
    if ((lang !== 'py' && rest.startsWith('//')) || (lang !== 'js' && rest.startsWith('#') && !rest.startsWith('#['))) {
      push(rest, COLOR.comment, true)
      break
    }
    if (lang === 'py' && (rest.startsWith('"""') || rest.startsWith("'''"))) {
      const quote = rest.slice(0, 3)
      const end = line.indexOf(quote, i + 3)
      if (end < 0) { push(rest, COLOR.string); carry.block = quote; break }
      push(line.slice(i, end + 3), COLOR.string)
      i = end + 3
      continue
    }
    let m = /^(["'`])(?:\\.|(?!\1)[^\\])*\1?/.exec(rest)
    if (m) { push(m[0], COLOR.string); i += m[0].length; continue }
    m = lang === 'php' ? /^\$[A-Za-z_\x80-￿][\w\x80-￿]*/.exec(rest) : null
    if (m) { push(m[0], COLOR.variable); i += m[0].length; continue }
    m = !/[\w$]/.test(prev) ? /^\d[\d_]*(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(rest) : null
    if (m) { push(m[0], COLOR.number); i += m[0].length; continue }
    m = lang === 'py' ? /^@[\w.]+/.exec(rest) : null
    if (m) { push(m[0], COLOR.decorator); i += m[0].length; continue }
    m = /^[A-Za-z_][\w]*/.exec(rest)
    if (m) {
      const word = m[0]
      const after = line.slice(i + word.length).trimStart()
      const color = KEYWORDS[lang].has(word) || KEYWORDS[lang].has(word.toLowerCase()) && lang === 'php' ? COLOR.keyword
        : CONSTANTS.test(word) ? COLOR.constant
        : after.startsWith('(') ? COLOR.func
        : /^[A-Z]/.test(word) ? COLOR.type
        : undefined
      if (color) push(word, color)
      else plain += word
      i += word.length
      continue
    }
    plain += line[i]
    i += 1
  }
  push('')
  return out
}
