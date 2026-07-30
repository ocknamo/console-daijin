# console-daijin

Adds a browser console viewer with just one line of code.
It captures `console.log`, `console.info`, `console.warn`, `console.error` and uncaught errors, and displays them directly on the page.
Useful for debugging when DevTools are not easily accessible, such as in embedded environments.
It can also forward everything it captures to a local collector, so another terminal — or a coding agent — can read the logs directly.
Works without any framework and requires no setup. Simple and lightweight, making it easy for both humans and AI tools to use.

---

## Install

```bash
npm install console-daijin
```

---

## Usage

```ts
import { createConsoleViewer } from "console-daijin"

createConsoleViewer()
```

That's it. A fixed panel appears at the bottom of the page showing all console output.

---

## Options

```ts
createConsoleViewer({
  show: "always",  // "auto" | "iframe" | "always"  (default: "always")
  height: 200,     // panel height in px             (default: 200)
  forward: false,  // send logs to a local collector (default: false)
})
```

### `show`

| Value | Behavior |
|-------|----------|
| `"always"` (default) | Always shows, even outside an iframe |
| `"auto"` | Shows only when inside an iframe |
| `"iframe"` | Same as `"auto"` (reserved for future extension) |

### `height`

Height of the viewer panel in pixels. Default: `200`.

### `forward`

Forwards captured logs to a local collector. See
[Sending logs to a local server](#sending-logs-to-a-local-server). Default: `false`.

---

## Log levels

| Level | Color |
|-------|-------|
| `console.log` | White |
| `console.info` | Blue |
| `console.warn` | Yellow |
| `console.error` | Red |
| `uncaught` | Magenta |

`uncaught` covers uncaught exceptions (`window.onerror`), unhandled promise rejections, and failed resource loads.

Original console output is always preserved — DevTools continue to work normally.
`Error` objects keep their message and stack trace instead of being flattened to `{}`, and circular structures are rendered as `[Circular]` rather than throwing.

---

## Sending logs to a local server

The panel solves "I can't see the logs". This solves "something else needs to read the logs" — a second terminal, a test run, or a coding agent that cannot open DevTools.

Start the collector in one terminal:

```bash
npx console-daijin-server
```

and turn on forwarding in the page:

```ts
createConsoleViewer({ forward: true })
```

Logs now stream to stdout and are appended to `.console-daijin/logs.jsonl` as one JSON object per line:

```json
{"t":1730000000000,"level":"error","session":"3f2a…","url":"http://localhost:5173/","args":["query failed:","Error: database unreachable\n    at …"],"stack":"Error: database unreachable\n    at …"}
```

Add `.console-daijin/` to your `.gitignore`.

If you want forwarding without the on-page panel:

```ts
import { forwardConsoleLogs } from "console-daijin"

const stop = forwardConsoleLogs()
```

### CLI options

| Flag | Default | Description |
|------|---------|-------------|
| `-p, --port <n>` | `5959` | Port to listen on (env: `CONSOLE_DAIJIN_PORT`) |
| `--host <addr>` | `127.0.0.1` | Address to bind |
| `-o, --out <path>` | `.console-daijin/logs.jsonl` | JSONL output file |
| `--append` | off | Append instead of truncating on start |
| `--no-file` | off | Do not write an output file |
| `-q, --quiet` | off | Do not print to stdout |
| `--allow-origin <o>` | — | Accept an extra origin (repeatable) |

The file is truncated on each start so a run only contains logs from that run. Pass `--append` to keep history.

If the port is already in use the server exits with an error rather than quietly moving to another port — a collector listening somewhere the client isn't posting is much harder to debug than a failed start.

### Forwarding options

```ts
createConsoleViewer({
  forward: {
    endpoint: undefined,     // full URL; overrides `port`. May be relative.
    port: 5959,              // collector port
    batchMs: 250,            // buffer window in ms
    batchSize: 50,           // flush once this many entries are buffered
    maxFailures: 3,          // consecutive failures before giving up
    allowNonLocal: false,    // forward from non-loopback pages
  },
})
```

Logs are batched rather than sent one request per line, and flushed with `navigator.sendBeacon` on `pagehide` and when the tab is hidden — so the last log before a crash or a reload is not lost.

If the collector is not running, forwarding stops itself after `maxFailures` attempts and reports it once. The panel keeps working.

### Using a dev server proxy

Pointing the client at a relative path and proxying it from your existing dev server keeps everything same-origin, which removes CORS from the picture entirely:

```ts
createConsoleViewer({ forward: { endpoint: "/__daijin/logs" } })
```

```ts
// vite.config.ts
export default {
  server: {
    proxy: { "/__daijin": "http://localhost:5959" },
  },
}
```

The equivalent in Next.js is a `rewrites()` entry. No plugin is needed in either case.

### Security

This is a development tool. It is built to be safe on a developer's machine, not to be exposed:

- The server binds to `127.0.0.1`, so it is not reachable from other machines. `--host` overrides this and prints a warning.
- Requests carrying an `Origin` that is not loopback are rejected with `403`. Any site you visit can reach `localhost`, and the collected logs are meant to be read by tools and agents, so this check is what keeps an unrelated tab from writing into them. Use `--allow-origin` to extend the list deliberately.
- `Access-Control-Allow-Origin` is never `*`; only an accepted origin is echoed back.
- Request bodies are capped at 1 MB.
- The client refuses to forward when the page is not served from a loopback host, so a build that accidentally ships with `forward` enabled will not send your users' console output to whatever is listening on their machines. `allowNonLocal: true` overrides this.

### Protocol

The receiver is deliberately replaceable — the contract is plain HTTP, so a different implementation can be dropped in without touching the client.

`POST /__daijin/logs`

```jsonc
{
  "v": 1,
  "session": "per-page-load id",
  "entries": [
    {
      "t": 1730000000000,
      "level": "log" | "info" | "warn" | "error" | "uncaught",
      "args": ["already-serialized", "strings"],
      "stack": "optional",
      "url": "http://localhost:5173/"
    }
  ]
}
```

Responses: `204` on success, `400` malformed, `403` origin rejected, `413` too large.
`GET /__daijin/health` returns `{"ok":true,"v":1}`.

The server is also importable for programmatic use:

```ts
import { startLogServer } from "console-daijin/server"

const handle = await startLogServer({ port: 5959 })
await handle.close()
```

---

## Use cases

- StackBlitz / CodeSandbox embedded previews
- Documentation playgrounds
- Tutorial demos
- Any iframe-embedded app
- Environments where DevTools are not accessible
- Feeding browser logs to a coding agent or a second terminal

---

## Features

- Zero runtime dependencies
- Framework agnostic — the collector is a plain CLI, not a bundler plugin
- ESM + CJS dual package
- ~12KB minified (~5KB gzipped)
- Inline styles only (no CSS file needed)

---

## Development

```bash
npm run build      # build browser bundle, server, and CLI
npm test           # build, then run the test suite
npm run typecheck  # type-check browser and Node sources
```

`examples/index.html` is a manual test page. Serve the repository root (`npx serve .`), open `/examples/`, and run `node dist/cli.js` in another terminal.

---

## License

MIT
