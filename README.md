# clawd-debug

A step debugger for [Claude Code](https://claude.com/claude-code), in a pane beside the conversation. Set a breakpoint, let Claude run your code with test data, and step through it line by line while every variable, and what each line set, shows next to the code. No editor needed.

Works with **Python**, **JavaScript (Node)** and **PHP**, including PHP inside a Docker container with Xdebug, such as a local WordPress site.

## How you use it

1. Open a file: `/dbg path/to/file.php` (or `/dbg file.py:12` to run it and stop at line 12).
2. Click the pane, move to a line and press `b` for a breakpoint.
3. Press `t`: Claude writes a small script that calls the code with realistic test data, then starts the run. Or press `r` to run the file as it is.
4. Step with the keys below and watch the values.

When the code throws an error nobody catches, the run stops on the failing line with its variables, and the error shows in red. A line run more than once (a loop) shows each value it set: `price = 20 → 5.5 (×2)`.

You can also just ask Claude: "debug `calc_total` with test data", "run `register()` with an empty option".

With [clawd-git](https://github.com/itsomidho/clawd-git) 0.4.4 or later, a ▷ on a file's row (and **Debug** on its diff) opens the file here.

## Keys (click the pane first; Escape gives the keys back)

| | |
|---|---|
| `n` `s` `o` `c` | next line, step into, step out, continue |
| `r` `q` | run (again), stop |
| `b` `t` | breakpoint on the cursor's line, test data from Claude |
| `↑` `↓` | move the cursor; the details show that line whole and what it set |
| `←` `→` | slide long lines sideways |
| `J` `K`, `+` `-` | scroll the details, make them bigger or smaller |
| `tab`, `?` | Variables / Stack / Output, hide the key hints |

`/dbg next`, `/dbg in`, `/dbg out`, `/dbg continue`, `/dbg stop` do the same from the prompt.

## What each language needs

| | |
|---|---|
| Python | [debugpy](https://github.com/microsoft/debugpy): run `/dbg setup` once (it installs into `~/.cache/clawd-debug/python`) |
| Node | nothing: Node's built-in inspector |
| PHP | Xdebug 3 with `xdebug.mode=debug`. A file inside a running Docker container's bind mount runs there (the container is found by its mounts); inside a WordPress install it runs with `wp eval-file`, so WordPress is loaded. A plugin or theme file is not run itself: `r` loads WordPress, so its breakpoints in code that runs on load stop. Stepping into WordPress core or `vendor/` steps back out (what it returned shows on your line). Otherwise the local `php` with Xdebug. |

Claude's test scripts go in `.clawd-debug/` in your project; Claude adds that folder to `.git/info/exclude` so it is never committed.

## How it works

A small helper process (`helper/dapd.mjs`) talks to each language's debugger: DAP for Python, the V8 inspector for Node, DBGp for Xdebug. It runs debuggers without a terminal, so they cannot take your terminal from Claude Code. The mod draws the pane and gives Claude four tools: `debug_start`, `debug_step`, `debug_state` and `debug_breakpoints`.

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
