// One variable as the helper reports it: the value is already text.
// children: read when its row is open (expanded) in the pane.
export type Var = { name: string; value: string; type: string; ref: number; children?: Var[] }

// A watch expression and what it came to at the last stop (error when it failed).
export type Watch = Var & { expr: string; error?: string }

export type Scope = { name: string; vars: Var[]; ref?: number }

export type Frame = { name: string; file: string; line: number }

// condition: stop only when this expression is true.
export type Breakpoint = { line: number; verified: boolean; condition?: string }

export type Status = 'idle' | 'starting' | 'running' | 'paused' | 'ended' | 'error'

// The helper's whole state, as it prints it on every change.
export type DebugState = {
  status: Status
  lang: string | null
  program: string | null
  cwd: string | null
  args: string[]
  breakpoints: Record<string, Breakpoint[]>
  // error: the uncaught error it stopped on, when reason is 'exception'.
  stop: { reason: string; file?: string; line?: number; frame?: string; error?: string } | null
  frames: Frame[]
  scopes: Scope[]
  // file -> line -> what that line set ({ name: value })
  lineValues: Record<string, Record<string, Record<string, string>>>
  output: { category: string; text: string }[]
  exitCode: number | null
  error: string | null
  steps: number
  // Optional: a value stored by 0.2.1 or earlier has neither.
  watches?: Watch[]
  // Open rows by path: JSON of the names from the scope (or "Watch") down.
  expanded?: string[]
}

// A row of the variable tree or the watches, as the view draws it.
export type ViewVar = {
  name: string
  value: string
  // The names from the scope (or "Watch") down to this row.
  path: string[]
  canExpand: boolean
  isOpen: boolean
  children: ViewVar[]
  error?: string
}

// What the hooks module hands the view (the Client) to draw.
export type ViewProps = {
  status: Status
  file: string
  lines: string[]
  // The line number of lines[0].
  firstLine: number
  current: number | null
  breakpoints: number[]
  // line -> the condition of its breakpoint, for a conditional one.
  conditions: Record<string, string>
  values: Record<string, Record<string, string>>
  reason: string
  frame: string
  steps: number
  scopes: { name: string; vars: ViewVar[] }[]
  watches: ViewVar[]
  frames: Frame[]
  output: string[]
  note: string
  // The uncaught error the program stopped on, '' for none.
  error: string
}

// What the view posts back: a key the person pressed, as a command.
export type ViewMessage =
  | { cmd: 'next' | 'stepIn' | 'stepOut' | 'continue' | 'pause' | 'stop' | 'run' }
  | { cmd: 'toggleBreakpoint'; line: number }
  // t: ask Claude to write test data for the breakpoints (or the cursor's function) and start.
  | { cmd: 'testData'; line: number }
  | { cmd: 'addWatch' | 'removeWatch'; expr: string }
  // B: stop at this line only when the condition is true ('' for always).
  | { cmd: 'setCondition'; line: number; condition: string }
  | { cmd: 'toggleExpand'; path: string[] }

declare module 'claude-code' {
  interface PluginState {
    'clawd-debug': {
      dbg: Shaped<DebugState>
      // The file the pane shows while no program is paused.
      shown: string
    }
  }
}
