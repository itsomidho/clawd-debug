# clawd-debug

A step debugger for [Claude Code](https://claude.com/claude-code), in a pane beside the conversation. Set a breakpoint, let Claude run your code with test data, and step through it line by line while every variable, and what each line set, shows next to the code. No editor needed.

Works with **Python**, **JavaScript (Node)** and **PHP**, including PHP inside a Docker container with Xdebug, such as a local WordPress site.

## How you use it

1. Open a file: `/dbg path/to/file.php` (or `/dbg file.py:12` to run it and stop at line 12).
2. Click the pane, move to a line and press `b` for a breakpoint.
3. Press `t`: Claude writes a small script that calls the code with realistic test data, then starts the run. Or press `r` to run the file as it is.
4. Step with the keys below and watch the values.

Open rows stay open while you step, and watch expressions are worked out again at every stop (and kept for the next run), so you can follow a value or a condition through the code.

When the code throws an error nobody catches, the run stops on the failing line with its variables, and the error shows in red. A line run more than once (a loop) shows each value it set: `price = 20 → 5.5 (×2)`.

You can also just ask Claude: "debug `calc_total` with test data", "run `register()` with an empty option".

With [clawd-git](https://github.com/itsomidho/clawd-git) 0.4.4 or later, a ▷ on a file's row (and **Debug** on its diff) opens the file here.

## Test cases

Press `t` (or ask Claude) and Claude writes the test data as named cases, each with the result it *should* give, worked out from what the code is meant to do. The run shows a ✓/✗ table in the Cases tab: a failing case shows what was expected and what came back, or its error. `↵` (or `f`) reruns a failing case alone, stopping at your breakpoints on its way, with its data in the variables; the list keeps the other cases.

A harness reports its cases through a small helper in `helper/cases/` (`clawd_case.php`, `clawd_case.py`, `clawd_case.js`), copied next to it: each case prints one `@@clawd-case {json}` line, which the debugger reads and keeps out of the output.

## Keys

When the program stops, or a run ends with test cases, the pane takes the keys by itself, so the step bar's keys work without a click: `n` next, `s` into, `o` out, `c` continue, `x` ask Claude to explain this stop, `r` run, `t` test data, `q` stop, `f` rerun the next failing case. `↵` does the next thing (next at a stop, the failing case after a run). The keys below are the code view's: click the code first (Escape gives the keys back).

Or use the mouse: click a line's number to set or clear its breakpoint, a line to move the cursor there, a tab to open it, a value to open or fold it, a test case to rerun it alone, `✕` to remove a watch and `+ Add watch` to add one.


| | |
|---|---|
| `n` `s` `o` `c` `x` | next line, step into, step out, continue, explain |
| `r` `q` | run (again), stop |
| `b` `t` | breakpoint on the cursor's line, test data from Claude |
| `↵` on a case | rerun it alone (Cases tab) |
| `B` | a breakpoint that stops only when a condition is true (`$price > 100`, `i == 41`), drawn `◆`; `B` again edits it, an empty condition makes it plain |
| `↑` `↓` | move the cursor; the details show that line whole and what it set |
| `←` `→` | slide long lines sideways |
| `J` `K`, `+` `-` | scroll the details, make them bigger or smaller |
| `e` | explore the values: `↑` `↓` select, `↵` or `→` expand an object or array, `←` fold it, `e` back to the code |
| `w` | add a watch expression (typed in the pane, `↵` adds it); `d` on a selected watch removes it |
| `tab`, `?` | Variables / Watch / Stack / Output, hide the key hints |

`/dbg next`, `/dbg in`, `/dbg out`, `/dbg continue`, `/dbg stop` do the same from the prompt. `/dbg break file.php:42` sets a breakpoint and shows the file without running anything ([clawd-logs](https://github.com/itsomidho/clawd-logs)' **Debug** button uses it).

## What each language needs

| | |
|---|---|
| Python | [debugpy](https://github.com/microsoft/debugpy): run `/dbg setup` once (it installs into `~/.cache/clawd-debug/python`) |
| Node | nothing: Node's built-in inspector |
| PHP | Xdebug 3 with `xdebug.mode=debug`. A file inside a running Docker container's bind mount runs there (the container is found by its mounts); inside a WordPress install it runs with `wp eval-file`, so WordPress is loaded. A plugin or theme file is not run itself: `r` loads WordPress, so its breakpoints in code that runs on load stop. Stepping into WordPress core or `vendor/` steps back out (what it returned shows on your line). Otherwise the local `php` with Xdebug. |

Claude's test scripts go in `.clawd-debug/` in your project; Claude adds that folder to `.git/info/exclude` so it is never committed.

## Settings

`icons` (in `/plugin`, clawd-debug's options): `auto` uses VS Code's Codicons when a Nerd Font is installed, else symbols every font has; `line`, `nerd`, `outline`, `simple` or `off` force one, the same choices as clawd-git.

## How it works

A small helper process (`helper/dapd.mjs`) talks to each language's debugger: DAP for Python, the V8 inspector for Node, DBGp for Xdebug. It runs debuggers without a terminal, so they cannot take your terminal from Claude Code. It starts the first time you use the debugger in a session and stops after 10 minutes idle, so sessions that never debug run no helper. The mod draws the pane and gives Claude five tools: `debug_start`, `debug_step`, `debug_state`, `debug_watch` and `debug_breakpoints`.

## Development

```
node --test 'helper/test/*.test.mjs'
claude plugin test .
```

The first runs the helper against real debuggers: Node always, Python when debugpy is installed (`/dbg setup`). Set `CLAWD_DEBUG_PHP_DIR` to a folder a running Docker container with Xdebug serves (a WordPress site adds the WordPress tests) to run the PHP ones too; they copy their files into `<folder>/.clawd-debug/` and remove them after. The second tests the pane and Claude's tools.

## Install

At the prompt of a terminal session:

```
/plugin install clawd-debug --marketplace itsomidho/clawd-debug
```

Answer `y` to add the marketplace, then pick a scope. From a shell:

```
claude plugin install clawd-debug --marketplace itsomidho/clawd-debug
```

In the desktop app, where `/plugin` does not run: click + next to the prompt box, then Plugins, Add marketplace with `itsomidho/clawd-debug`, then Add plugin.

## License

MIT
