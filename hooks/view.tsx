// The debugger view, drawn inside the pane. It owns the keys while the person
// has clicked into it: stepping keys go to the hooks module as posts, moving
// keys (cursor, scroll, tabs) stay here.
import type { ClientModule, RenderElement } from 'claude-code'

import type { ViewMessage, ViewProps, ViewVar } from '../types'

type Tab = 'vars' | 'watch' | 'cases' | 'stack' | 'output'
// cursor/top: the code window; left: how far long lines slid sideways;
// lowerTop: the details' scroll; split: the details' share of the rows.
// isDetails: the keys move a selection in the details (e); sel: which row;
// typing: a watch expression being typed (w), null when none.
type Local = {
  cursor: number; top: number; tab: Tab; followed: string; left: number; lowerTop: number; split: number
  isHelpHidden?: boolean; isDetails?: boolean; sel?: number; typing?: string | null
  // What the field is for: a watch (w), or the condition of a line's breakpoint (B).
  typingFor?: 'watch' | 'condition'; typingLine?: number
  // The run whose test cases were last shown: a new run's cases open the tab once.
  casesRun?: number
}

const TABS: Tab[] = ['vars', 'watch', 'cases', 'stack', 'output']
const TAB_NAMES: Record<Tab, string> = { vars: 'Variables', watch: 'Watch', cases: 'Cases', stack: 'Stack', output: 'Output' }

const STEP_KEYS: Record<string, ViewMessage['cmd']> = {
  n: 'next',
  s: 'stepIn',
  o: 'stepOut',
  c: 'continue',
  p: 'pause',
  r: 'run',
  q: 'stop',
  x: 'explain',
}

const View: ClientModule<ViewProps, Local> = (props, surface) => {
  const { Box, Text } = surface.elements
  const columns = Math.max(24, surface.columns || 80)
  const rows = Math.max(10, surface.rows || 30)
  const last = props.firstLine + props.lines.length - 1
  const g = props.glyphs ?? {}

  // Follow the program: when it stops somewhere new, the cursor goes there.
  const spot = `${props.file}:${props.current ?? ''}:${props.steps}`
  let local: Local = { cursor: props.current ?? props.firstLine, top: props.firstLine, tab: 'vars', followed: '', left: 0, lowerTop: 0, split: 0.4, isHelpHidden: true, ...surface.state }
  // Rows: the field (while typing), the code card (2 border rows + its title),
  // the tab row, then the details.
  const fieldRows = local.typing != null ? 1 : 0
  // The keys (?) take the whole view; else the details take their share.
  const isHelp = !local.isHelpHidden
  const lowerRows = isHelp ? rows - fieldRows : Math.max(4, Math.min(rows - 7 - fieldRows, Math.floor(rows * local.split)))
  const codeRows = Math.max(3, rows - fieldRows - 3 - 1 - lowerRows)
  if (local.followed !== spot && props.current != null) {
    local = { ...local, cursor: props.current, top: around(props.current, codeRows, props.firstLine, last), followed: spot, lowerTop: 0 }
  }
  local = { ...local, top: keepVisible(local.cursor, local.top, codeRows, props.firstLine, last) }
  // A run that ended with test cases opens them once, the keys in the list and
  // the first failing case selected: ↵ reruns it at its breakpoints.
  const isCasesNew = props.status === 'ended' && props.cases.length > 0 && local.casesRun !== props.runId
  if (isCasesNew) {
    const failing = props.cases.findIndex(c => !c.ok)
    local = { ...local, tab: 'cases', isDetails: true, sel: Math.max(0, failing), lowerTop: 0, casesRun: props.runId }
  }
  if (!surface.state || surface.state.followed !== local.followed || isCasesNew) surface.setState(local)

  // ---- the code card
  const inner = columns - 4 // the card's border and padding
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
    // ◆: a breakpoint that stops only when its condition is true.
    const isConditional = isBreak && Boolean(props.conditions[String(n)])
    const marker = isCurrent ? '▶' : isConditional ? '◆' : isBreak ? '●' : ' '
    const values = props.values[String(n)]
    const shown = values ? `  ${Object.entries(values).map(([k, v]) => `${k} = ${v}`).join(', ')}` : ''
    codeLines.push(
      <Box key={`l${n}`} flexDirection="row" width={inner} overflow="hidden" backgroundColor={isCurrent ? CURRENT_LINE : undefined}>
        <Text color={isCurrent ? COLOR.type : isConditional ? CONDITION_COLOR : ERR} bold>{marker}</Text>
        <Text color={isCursor ? ACCENT : LINE_NUMBER} bold={isCursor}>{` ${String(n).padStart(numberWidth)}  `}</Text>
        <Text wrap="truncate-end" bold={isCurrent}>
          {slide(highlight(text, lang, carry), local.left).map(seg => <Text color={seg.color} italic={seg.isComment}>{seg.text}</Text>)}
          <Text color={VALUES} dimColor={!isCurrent}>{local.left > text.length ? shown.slice(Math.min(shown.length, local.left - text.length)) : shown}</Text>
        </Text>
      </Box>,
    )
  }
  const fileName = props.file.split('/').pop() ?? ''
  const folder = props.file ? props.file.slice(0, props.file.length - fileName.length - 1).replace(/^\/home\/[^/]+/, '~') : ''
  const breaks = props.breakpoints.length

  // ---- the details
  const all = lowerPanel(props, local.isHelpHidden ? local.tab : 'help', local.cursor, columns - 1, local)
  const room = lowerRows - 1
  // The rows that can be selected (a variable, a watch, a case): their first row each.
  const items = all.flatMap((row, i) => (row.item && row.isFirst ? [i] : []))
  const sel = clamp(local.sel ?? 0, 0, Math.max(0, items.length - 1))
  const selRow = local.isDetails ? items[sel] : undefined
  const selItem = selRow != null ? all[selRow]?.item : undefined
  // Output follows its end; the rest start at the top and scroll with J/K;
  // a selected row is kept in sight.
  let lowerTop = local.tab === 'output' && local.lowerTop === 0 ? Math.max(0, all.length - room) : Math.min(local.lowerTop, Math.max(0, all.length - room))
  if (selRow != null) lowerTop = selRow < lowerTop ? selRow : selRow >= lowerTop + room ? selRow - room + 1 : lowerTop

  surface.onKey(event => {
    const at: Local = { ...local, ...surface.state }
    // Typing a watch expression or a condition: every key goes to the field.
    if (at.typing != null) {
      if (event.key === 'return') {
        if (at.typingFor === 'condition') {
          surface.post({ cmd: 'setCondition', line: at.typingLine ?? at.cursor, condition: at.typing.trim() })
          return surface.setState({ ...at, typing: null })
        }
        if (at.typing.trim()) surface.post({ cmd: 'addWatch', expr: at.typing.trim() })
        return surface.setState({ ...at, typing: null, tab: at.typing.trim() ? 'watch' : at.tab })
      }
      if (event.key === 'backspace' || event.key === 'delete') return surface.setState({ ...at, typing: at.typing.slice(0, -1) })
      const ch = event.key === 'space' ? ' ' : event.key
      if (ch.length === 1 && !event.ctrl && !event.meta) return surface.setState({ ...at, typing: at.typing + ch })
      return
    }
    if (event.key === 'w') return surface.setState({ ...at, typing: '', typingFor: 'watch' })
    // B: a breakpoint that stops only when a condition is true (its current one to edit).
    if (event.key === 'B') return surface.setState({ ...at, typing: props.conditions[String(at.cursor)] ?? '', typingFor: 'condition', typingLine: at.cursor })
    if (event.key === 'e') return surface.setState({ ...at, isDetails: !at.isDetails, sel: at.sel ?? 0 })
    if (at.isDetails) {
      const by = { up: -1, k: -1, down: 1, j: 1, pageup: -room, pagedown: room }[event.key]
      if (by) return surface.setState({ ...at, sel: clamp(sel + by, 0, Math.max(0, items.length - 1)) })
      if (selItem && selItem.canExpand && (event.key === 'return' || ((event.key === 'right' || event.key === 'l') && !selItem.isOpen) || ((event.key === 'left' || event.key === 'h') && selItem.isOpen))) {
        return surface.post({ cmd: 'toggleExpand', path: selItem.path })
      }
      if (selItem?.caseName && (event.key === 'return' || event.key === 'right' || event.key === 'l')) {
        return surface.post({ cmd: 'rerunCase', name: selItem.caseName })
      }
      if (selItem?.isWatch && (event.key === 'd' || event.key === 'delete' || event.key === 'backspace')) {
        return surface.post({ cmd: 'removeWatch', expr: selItem.path[1] ?? '' })
      }
      if (['left', 'right', 'h', 'l', 'return'].includes(event.key)) return
    }
    const step = STEP_KEYS[event.key]
    if (step && !event.ctrl && !event.meta) return surface.post({ cmd: step } as ViewMessage)
    if (event.key === 'b' || event.key === 'return') return surface.post({ cmd: 'toggleBreakpoint', line: at.cursor })
    if (event.key === 't') return surface.post({ cmd: 'testData', line: at.cursor })
    if (event.key === '?') return surface.setState({ ...at, isHelpHidden: !at.isHelpHidden, lowerTop: 0 })
    if (event.key === 'tab') return surface.setState({ ...at, tab: TABS[(TABS.indexOf(at.tab) + 1) % TABS.length] ?? 'vars', lowerTop: 0, sel: 0, isHelpHidden: true })
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

  const lower = all.slice(lowerTop, lowerTop + room)
  const more = all.length > room ? `${lowerTop + 1}–${Math.min(all.length, lowerTop + room)} of ${all.length}` : ''
  // Pill tabs, each with its count.
  const failed = props.cases.filter(c => !c.ok).length
  const counts: Record<Tab, string> = {
    vars: '',
    watch: props.watches.length ? String(props.watches.length) : '',
    cases: props.cases.length ? (failed ? `${failed}✗` : `${props.cases.length}✓`) : '',
    stack: props.frames.length ? String(props.frames.length) : '',
    output: '',
  }
  const tabIcon: Record<Tab, string> = { vars: g.vars ?? '', watch: g.watch ?? '', cases: g.cases ?? '', stack: g.stack ?? '', output: g.output ?? '' }

  return (
    <Box flexDirection="column" width={columns} height={rows}>
      {local.typing != null && (
        <Box flexDirection="row" height={1} overflow="hidden">
          <Text backgroundColor={ACCENT} color={CHIP_TEXT} bold>{local.typingFor === 'condition' ? ` BREAK AT ${local.typingLine} WHEN ` : ' WATCH '}</Text>
          <Text> {local.typing}</Text><Text inverse> </Text>
          <Text dimColor>{local.typingFor === 'condition' ? '   ↵ set · empty ↵ always stop' : '   ↵ add · empty ↵ cancel'}</Text>
        </Box>
      )}
      {!isHelp && <Box borderStyle="round" borderColor={BORDER} paddingX={1} flexDirection="column" height={codeRows + 3}>
        <Box flexDirection="row" height={1} overflow="hidden">
          <Text color={ACCENT} bold>{`${g.file ? `${g.file} ` : ''}${fileName || 'no file'}`}</Text>
          <Text dimColor wrap="truncate-end">{`  ${folder}${breaks ? `  ·  ${breaks} breakpoint${breaks > 1 ? 's' : ''}` : ''}`}</Text>
        </Box>
        <Box flexDirection="column" height={codeRows} overflow="hidden">
          {props.lines.length ? codeLines : <Text dimColor>{'Nothing to show yet. Ask Claude to debug a function, or run /dbg <file>:<line>.'}</Text>}
        </Box>
      </Box>}
      <Box flexDirection="row" height={1} overflow="hidden">
        <Text color={local.isDetails ? ACCENT : BORDER} bold>{local.isDetails ? '▸ ' : '  '}</Text>
        {TABS.map(tab => {
          const isOn = tab === local.tab && local.isHelpHidden
          const label = ` ${tabIcon[tab] ? `${tabIcon[tab]} ` : ''}${TAB_NAMES[tab]}${counts[tab] ? ` ${counts[tab]}` : ''} `
          return (
            <Text>
              <Text backgroundColor={isOn ? ACCENT : undefined} color={isOn ? CHIP_TEXT : tab === 'cases' && failed ? ERR : undefined} bold={isOn} dimColor={!isOn && !(tab === 'cases' && failed)}>{label}</Text>
              <Text> </Text>
            </Text>
          )
        })}
        <Text dimColor wrap="truncate-end">{`${more ? `  ${more}` : ''}   ? keys`}</Text>
      </Box>
      <Box flexDirection="column" height={lowerRows - 1} overflow="hidden" paddingRight={1}>
        {lower.map((row, i) => {
          // The selected entry: a bar in the margin on each of its rows, its text bold.
          const isSel = selRow != null && row.owner === all[selRow]?.owner
          return (
            <Box key={`d${i}`} flexDirection="row" height={1} overflow="hidden">
              <Text color={ACCENT} bold>{isSel ? '▌' : ' '}</Text>
              <Text wrap="truncate-end" bold={isSel}>
                {row.parts.map(part => <Text color={part.color} backgroundColor={part.bg} dimColor={part.dim} bold={part.bold} italic={part.italic}>{part.text}</Text>)}
                {row.parts.length ? null : ' '}
              </Text>
            </Box>
          )
        })}
      </Box>
    </Box>
  )
}

export default View

// The keys, by where they work: the step bar's work whenever the pane has the
// keys; these are the code view's, after a click into it.
type KeyHelp = { key: string; label: string }
const HELP: { title: string; keys: KeyHelp[] }[] = [
  { title: 'STEP BAR (works as soon as the pane has the keys)', keys: [
    { key: 'n s o c', label: 'next, into, out, continue' }, { key: 'q', label: 'stop' }, { key: 'r', label: 'run again' },
    { key: 't', label: 'test cases from Claude' }, { key: 'f', label: 'rerun the next failing case' }, { key: 'x', label: 'ask Claude to explain this stop' },
  ] },
  { title: 'CODE (click it first)', keys: [
    { key: '↑ ↓  PgUp PgDn', label: 'move the cursor' }, { key: 'g', label: 'back to the stop' }, { key: '← →  0', label: 'slide long lines' },
    { key: 'b', label: 'breakpoint on the cursor line' }, { key: 'B', label: 'breakpoint with a condition' }, { key: 'w', label: 'add a watch expression' },
  ] },
  { title: 'DETAILS', keys: [
    { key: 'tab', label: 'next tab' }, { key: 'e', label: 'move the keys into the list (and back)' }, { key: '↑ ↓', label: 'select' },
    { key: '↵ →', label: 'open a value, rerun a case' }, { key: '←', label: 'fold a value' }, { key: 'd', label: 'remove the selected watch' },
    { key: 'J K', label: 'scroll' }, { key: '+ -', label: 'bigger, smaller' }, { key: '?', label: 'these keys' },
  ] },
]

// ---------------------------------------------------------------- look
// The clawd family's look (shared with clawd-git). The chrome (rules, dim
// text) uses theme keys so it follows the person's theme; the accents and the
// syntax colours stay fixed.

const ACCENT = '#d97757'
const BORDER = '#5c6370'
const CHIP_TEXT = '#1e2127'
const ERR = '#e06c75'
const OK = '#98c379'
const WARN = '#e5c07b'
const LINE_NUMBER = '#4b5263'
const RULE = 'subtle'
const CONDITION_COLOR = '#d19a66'

// A value's colour by what it looks like: strings, numbers, true/false/null,
// functions; objects and arrays plain.
function valueColor(value: string): string | undefined {
  if (/^['"`]/.test(value)) return COLOR.string
  if (/^-?\d/.test(value)) return COLOR.number
  if (/^(true|false|null|None|True|False|undefined|NULL|nil|uninitialized)$/.test(value)) return COLOR.keyword
  if (/^ƒ|^<function|^function\b/.test(value)) return COLOR.func
  return undefined
}

// item: a row that can be selected (its first row); owner: which entry a
// wrapped row belongs to, so all its rows light up together.
type Item = { path: string[]; canExpand: boolean; isOpen: boolean; isWatch: boolean; caseName?: string }
type Part = { text: string; color?: string; bg?: string; dim?: boolean; bold?: boolean; italic?: boolean }
type Row = { parts: Part[]; item?: Item; isFirst?: boolean; owner?: number }

// Everything the details can show, each long value wrapped onto as many rows
// as it needs (the panel scrolls them), never cut at the edge.
function lowerPanel(props: ViewProps, tab: Tab | 'help', cursor: number, width: number, local: Local): Row[] {
  const out: Row[] = []
  // The row's room: the panel's width less the selection margin and the right padding.
  const room = Math.max(16, width - 2)
  let owner = 0
  const gap = () => { if (out.length && out[out.length - 1]!.parts.length) out.push({ parts: [] }) }
  // A plain line of text, wrapped.
  const add = (text: string, style: Omit<Part, 'text'> = {}, indent = 0, item?: Item) => {
    owner += 1
    wrap(text, room, indent).forEach((piece, i) => out.push({ parts: [{ text: piece, ...style }], owner, ...(item ? { item, isFirst: i === 0 } : {}) }))
  }
  // A heading: its title, a rule to the edge, and what it holds on the right.
  const section = (title: string, info = '') => {
    gap()
    const tail = info ? ` ${info}` : ''
    const fill = Math.max(2, room - cells(title) - cells(tail) - 1)
    out.push({ parts: [{ text: title, bold: true }, { text: ` ${'─'.repeat(fill)}`, color: RULE }, { text: tail, dim: true }] })
  }
  // A name and its value in two columns; a long value wraps under its column.
  // lead: what comes before the name (tree lines, the open/closed marker).
  const pair = (lead: Part[], name: string, nameWidth: number, value: string, opts: { nameColor?: string; valueColor?: string; item?: Item; isChanged?: boolean } = {}) => {
    owner += 1
    const leadWidth = lead.reduce((n, part) => n + cells(part.text), 0)
    const head = leadWidth + nameWidth + 2
    const pieces = wrap(value === '' ? "''" : value, Math.max(8, room - head), 0)
    pieces.forEach((piece, i) => out.push({
      parts: i === 0
        ? [...lead, { text: fit(name, nameWidth), color: opts.nameColor }, { text: '  ' }, { text: piece, color: opts.valueColor, bold: opts.isChanged }]
        : [{ text: ' '.repeat(head) }, { text: piece, color: opts.valueColor, bold: opts.isChanged }],
      owner,
      ...(opts.item ? { item: opts.item, isFirst: i === 0 } : {}),
    }))
  }
  // The name column: as wide as the longest name, at most a third of the row.
  const widthOf = (names: string[], cap = 24) => Math.min(cap, Math.max(4, Math.floor(room / 3)), Math.max(4, ...names.map(cells)))
  // A variable and, when open, its children: ▸ closed, ▾ open, • changed since
  // the last stop; │ marks each level of nesting.
  const tree = (list: ViewVar[], depth: number, isWatch: boolean) => {
    const w = widthOf(list.map(v => v.name))
    for (const v of list) {
      const marker = v.canExpand ? (v.isOpen ? '▾ ' : '▸ ') : v.changed ? '• ' : '  '
      const lead: Part[] = [
        ...(depth ? [{ text: '│ '.repeat(depth), color: RULE }] : []),
        { text: marker, color: v.changed ? WARN : v.canExpand ? ACCENT : undefined },
      ]
      const item = { path: v.path, canExpand: v.canExpand, isOpen: v.isOpen, isWatch: isWatch && depth === 0 }
      const isReturn = v.name.startsWith('↩') || /^\(return\)|^Return value/.test(v.name)
      if (v.error) pair(lead, v.name, w, v.error, { valueColor: ERR, item })
      else pair(lead, v.name, w, v.value, { nameColor: isReturn ? VALUES : v.changed ? WARN : undefined, valueColor: valueColor(v.value), item, isChanged: v.changed })
      if (v.isOpen) tree(v.children, depth + 1, isWatch)
    }
  }
  const changedOf = (list: ViewVar[]) => {
    const n = list.filter(v => v.changed).length
    return n ? ` · ${n} changed` : ''
  }
  if (tab === 'help') {
    for (const group of HELP) {
      section(group.title)
      const w = widthOf(group.keys.map(k => k.key), 16)
      for (const k of group.keys) pair([{ text: '  ' }], k.key, w, k.label, { nameColor: ACCENT })
    }
    return out
  }
  if (tab === 'vars') {
    // The error the program stopped on, whole: the header cuts it at the edge.
    if (props.error) {
      section('ERROR')
      add(props.error, { color: ERR }, 2)
    }
    // The line under the cursor, on one row, and what it set.
    const code = (props.lines[cursor - props.firstLine] ?? '').replace(/\t/g, '    ').trim()
    const values = props.values[String(cursor)]
    if (code || values) {
      section(`LINE ${cursor}`, cursor === props.current ? 'the stop' : '')
      if (code) { owner += 1; out.push({ owner, parts: [{ text: `  ${fit(code, room - 2)}`, dim: true, italic: true }] }) }
      const condition = props.conditions[String(cursor)]
      if (condition) add(`◆ stops only when ${condition}`, { color: CONDITION_COLOR }, 2)
      const entries = Object.entries(values ?? {})
      const w = widthOf(entries.map(([n]) => n))
      for (const [name, value] of entries) pair([{ text: '→ ', color: VALUES }], name, w, value, { nameColor: VALUES, valueColor: valueColor(value) })
    }
    if (!props.scopes.length) { gap(); add(props.status === 'paused' ? 'No variables here.' : 'Variables show while the program is paused.', { dim: true }) }
    for (const scope of props.scopes) {
      const n = scope.vars.length
      section(scope.name.toUpperCase(), `${n}${changedOf(scope.vars)}`)
      if (!n) add('  (none)', { dim: true })
      tree(scope.vars, 0, false)
    }
  } else if (tab === 'cases') {
    if (!props.cases.length) {
      add('No test cases yet. t asks Claude for test data as cases, each with the result it should give; this tab shows which pass.', { dim: true })
    } else {
      const passed = props.cases.filter(c => c.ok).length
      const failing = props.cases.length - passed
      out.push({ parts: [
        { text: ` ✓ ${passed} `, color: CHIP_TEXT, bg: OK, bold: true }, { text: ' ' },
        { text: ` ✗ ${failing} `, color: CHIP_TEXT, bg: failing ? ERR : BORDER, bold: true },
        { text: `  ${props.caseFilter ? `ran "${props.caseFilter}" alone · ` : ''}↵ on a case reruns it, stopping at the breakpoints`, dim: true },
      ] })
      gap()
      for (const c of props.cases) {
        const item = { path: ['Case', c.name], canExpand: false, isOpen: false, isWatch: false, caseName: c.name }
        add(`${c.ok ? '✓' : '✗'} ${c.name}`, { color: c.ok ? OK : ERR, bold: !c.ok }, 2, item)
        if (!c.ok) {
          if (c.error) pair([{ text: '    ' }], 'error', 8, c.error, { valueColor: ERR })
          if (c.expected !== undefined) pair([{ text: '    ' }], 'expected', 8, c.expected, { valueColor: valueColor(c.expected) })
          if (!c.error && c.actual !== undefined) pair([{ text: '    ' }], 'got', 8, c.actual, { valueColor: ERR })
        }
      }
    }
  } else if (tab === 'watch') {
    if (!props.watches.length) add('No watch expressions. Click the code and press w to add one: it is worked out at every stop.', { dim: true })
    else {
      section('WATCH', `${props.watches.length}${changedOf(props.watches)}`)
      if (props.status !== 'paused') add('  Worked out while the program is paused.', { dim: true })
      tree(props.watches, 0, true)
    }
  } else if (tab === 'stack') {
    if (!props.frames.length) add('The call stack shows while the program is paused.', { dim: true })
    else {
      section('CALL STACK', `${props.frames.length} frame${props.frames.length > 1 ? 's' : ''}`)
      const w = widthOf(props.frames.map(f => f.name), 36)
      const number = String(props.frames.length - 1).length
      props.frames.forEach((f, i) => {
        owner += 1
        const base = f.file.split('/').pop() ?? f.file
        const dir = f.file.slice(0, Math.max(0, f.file.length - base.length - 1)).replace(/^\/home\/[^/]+/, '~')
        out.push({ owner, parts: [
          { text: i === 0 ? '▶ ' : '  ', color: ACCENT },
          { text: `${String(i).padStart(number)}  `, color: LINE_NUMBER },
          { text: fit(f.name, w), bold: i === 0 },
          { text: '  ' },
          { text: `${base}:${f.line}`, color: i === 0 ? ACCENT : COLOR.func },
          { text: dir ? `  ${dir}` : '', dim: true },
        ] })
      })
    }
  } else {
    if (!props.output.length) add('No output yet.', { dim: true })
    else {
      const errors = props.output.filter(l => l.isError).length
      section('OUTPUT', `${props.output.length} line${props.output.length > 1 ? 's' : ''}${errors ? ` · ${errors} on stderr` : ''}`)
      // Each line numbered; stderr and PHP/Python errors in red, warnings in yellow.
      const number = String(props.output.length).length
      props.output.forEach((line, i) => {
        owner += 1
        const tone = line.isError || /\b(Fatal error|Parse error|Uncaught|Traceback|Exception)\b|^\w*Error\b/.test(line.text) ? ERR
          : /\b(Warning|Notice|Deprecated)\b/.test(line.text) ? WARN : undefined
        const pieces = wrap(line.text.replace(/\t/g, '    ') || ' ', room - number - 3, 0)
        pieces.forEach((piece, j) => out.push({ owner, parts: [
          { text: j === 0 ? `${String(i + 1).padStart(number)} │ ` : `${' '.repeat(number)} │ `, color: LINE_NUMBER },
          { text: piece, color: tone },
        ] }))
      })
    }
  }
  void local
  return out
}

// ---------------------------------------------------------------- width

// How many terminal cells a string takes: marks that join the letter before
// them (Persian and Arabic vowel signs, accents), zero-width joiners and
// variation selectors take none; East Asian wide letters and emoji take two.
function cells(text: string): number {
  let n = 0
  for (const ch of text) n += cellOf(ch.codePointAt(0) ?? 0)
  return n
}

function cellOf(c: number): number {
  if (c === 0x200b || c === 0x200c || c === 0x200d || c === 0x200e || c === 0x200f || c === 0xfeff) return 0
  if ((c >= 0x300 && c <= 0x36f) || (c >= 0x610 && c <= 0x61a) || (c >= 0x64b && c <= 0x65f) || c === 0x670 || (c >= 0x6d6 && c <= 0x6ed) || (c >= 0xfe00 && c <= 0xfe0f)) return 0
  if ((c >= 0x1100 && c <= 0x115f) || (c >= 0x2e80 && c <= 0xa4cf) || (c >= 0xac00 && c <= 0xd7a3) || (c >= 0xf900 && c <= 0xfaff)
    || (c >= 0xfe30 && c <= 0xfe4f) || (c >= 0xff00 && c <= 0xff60) || (c >= 0xffe0 && c <= 0xffe6) || (c >= 0x1f300 && c <= 0x1faff) || (c >= 0x20000 && c <= 0x3fffd)) return 2
  return 1
}

// The text padded to `width` cells, or cut with … when it is wider.
function fit(text: string, width: number): string {
  const n = cells(text)
  if (n <= width) return text + ' '.repeat(width - n)
  let out = ''
  let used = 0
  for (const ch of text) {
    const c = cellOf(ch.codePointAt(0) ?? 0)
    if (used + c > width - 1) break
    out += ch
    used += c
  }
  return `${out}…${' '.repeat(Math.max(0, width - used - 1))}`
}

// Cuts text into rows of at most `width` cells, at a space or after a comma
// when there is one in the row's last half, else mid-word; rows after the
// first start with `indent` spaces.
function wrap(text: string, width: number, indent: number): string[] {
  const room = Math.max(10, width)
  if (cells(text) <= room) return [text]
  const pad = ' '.repeat(Math.min(indent, room - 5))
  const rows: string[] = []
  const chars = Array.from(text)
  let i = 0
  while (i < chars.length) {
    const lead = rows.length ? pad : ''
    const fits = room - lead.length
    let used = 0
    let j = i
    while (j < chars.length && used + cellOf(chars[j]!.codePointAt(0) ?? 0) <= fits) { used += cellOf(chars[j]!.codePointAt(0) ?? 0); j += 1 }
    if (j < chars.length) {
      // A break in the row's last half: after a space, a comma or a semicolon.
      for (let k = j; k > i + Math.floor((j - i) / 2); k--) {
        if (/[\s,;]/.test(chars[k - 1]!)) { j = k; break }
      }
    }
    rows.push(lead + chars.slice(i, j).join('').replace(/\s+$/, ''))
    i = j
    while (rows.length && i < chars.length && chars[i] === ' ') i += 1
  }
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
