# console-daijin

Adds a browser console viewer with just one line of code.
It captures `console.log`, `console.info`, `console.warn`, and `console.error` and displays them directly on the page.
Useful for debugging when DevTools are not easily accessible, such as in embedded environments.
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
  show: "auto",   // "auto" | "iframe" | "always"  (default: "auto")
  height: 200,    // panel height in px             (default: 200)
})
```

### `show`

| Value | Behavior |
|-------|----------|
| `"auto"` (default) | Shows only when inside an iframe |
| `"iframe"` | Same as `"auto"` (reserved for future extension) |
| `"always"` | Always shows, even outside an iframe |

### `height`

Height of the viewer panel in pixels. Default: `200`.

---

## Log levels

| Level | Color |
|-------|-------|
| `console.log` | White |
| `console.info` | Blue |
| `console.warn` | Yellow |
| `console.error` | Red |

Original console output is always preserved — DevTools continue to work normally.

---

## Use cases

- StackBlitz / CodeSandbox embedded previews
- Documentation playgrounds
- Tutorial demos
- Any iframe-embedded app
- Environments where DevTools are not accessible

---

## Features

- Zero dependencies
- Framework agnostic
- ESM + CJS dual package
- < 2KB minified
- Inline styles only (no CSS file needed)

---

## License

MIT
