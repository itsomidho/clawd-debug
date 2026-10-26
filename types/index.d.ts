// One variable as the helper reports it: the value is already text.
export type Var = { name: string; value: string; type: string; ref: number }

export type Scope = { name: string; vars: Var[]; ref?: number }

export type Frame = { name: string; file: string; line: number }

export type Breakpoint = { line: number; verified: boolean }

export type Status = 'idle' | 'starting' | 'running' | 'paused' | 'ended' | 'error'

// The helper's whole state, as it prints it on every change.
export type DebugState = {
  status: Status
  lang: string | null
  program: string | null
  cwd: string | null
  args: string[]
  breakpoints: Record<string, Breakpoint[]>
  stop: { reason: string; file?: string; line?: number; frame?: string } | null
  frames: Frame[]
  scopes: Scope[]
  // file -> line -> what that line set ({ name: value })
  lineValues: Record<string, Record<string, Record<string, string>>>
  output: { category: string; text: string }[]
  exitCode: number | null
  error: string | null
  steps: number
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
  values: Record<string, Record<string, string>>
  reason: string
  frame: string
  steps: number
  scopes: { name: string; vars: { name: string; value: string }[] }[]
  frames: Frame[]
  output: string[]
  note: string
}

// What the view posts back: a key the person pressed, as a command.
export type ViewMessage =
  | { cmd: 'next' | 'stepIn' | 'stepOut' | 'continue' | 'pause' | 'stop' | 'run' }
  | { cmd: 'toggleBreakpoint'; line: number }
  // t: ask Claude to write test data for the breakpoints (or the cursor's function) and start.
  | { cmd: 'testData'; line: number }

declare module 'claude-code' {
  interface PluginState {
    'clawd-debug': {
      dbg: Shaped<DebugState>
      // The file the pane shows while no program is paused.
      shown: string
    }
  }
}
