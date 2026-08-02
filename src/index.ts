import {
  ensureConsoleHooks,
  ensureUncaughtHooks,
  subscribe,
  type CapturedEntry,
} from "./capture";
import { LOG_LEVELS, type LogLevel } from "./protocol";
import { startForwarding, type ForwardOptions } from "./transport";

export type { CapturedEntry, ForwardOptions, LogLevel };
export { serializeArg, serializeArgs, type SerializeOptions } from "./serialize";

export interface ConsoleViewerOptions {
  show?: "auto" | "always" | "iframe";
  height?: number;
  /**
   * Forward captured logs to a local collector (`npx console-daijin-server`).
   * Off by default. `true` uses the default endpoint on localhost.
   */
  forward?: boolean | ForwardOptions;
}

const LEVEL_COLORS: Record<LogLevel, string> = {
  log: "#d4d4d4",
  info: "#9cdcfe",
  warn: "#dcdcaa",
  error: "#f44747",
  uncaught: "#c586c0",
};

/** Material icons: clear_all, content_copy. */
const ICONS = {
  clear: '<path d="M5 13h14v-2H5v2zm-2 4h14v-2H3v2zM7 7v2h14V7H7z"/>',
  copy: '<path d="M16 1H4c-1.1 0-2 .9-2 2v14h2V3h12V1zm3 4H8c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h11c1.1 0 2-.9 2-2V7c0-1.1-.9-2-2-2zm0 16H8V7h11v14z"/>',
};

const icon = (path: string): string =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="currentColor">${path}</svg>`;

/**
 * Level colours and the filter rules are generated from one table, so a new
 * level cannot be styled in one place and forgotten in the other. Hiding a
 * level is a single attribute on the log container rather than a walk over
 * every entry already rendered.
 */
const LEVEL_CSS = LOG_LEVELS.map(
  (level) => `
[data-level="${level}"]{color:${LEVEL_COLORS[level]}}
.log[data-hide-${level}] .entry[data-level="${level}"]{display:none}`,
).join("");

const CSS = `
:host{position:fixed;bottom:0;left:0;right:0;z-index:2147483647;display:flex;
  flex-direction:column;font-family:monospace;font-size:12px;box-sizing:border-box}
*{box-sizing:border-box}
.header{display:flex;align-items:center;gap:6px;padding:0 4px;height:26px;flex:none;
  background:#2d2d2d;border-top:1px solid #555;font:12px monospace}
.btn{background:transparent;border:none;color:#aaa;cursor:pointer;padding:0 12px;
  display:flex;align-items:center;line-height:1}
.btn:hover{color:#fff}
label{display:flex;align-items:center;gap:2px;cursor:pointer;user-select:none;
  padding:0 4px;font-size:10px}
input{margin:0;cursor:pointer;width:10px;height:10px}
.spacer{flex:1;display:flex;align-items:center;justify-content:flex-end;padding-right:4px}
.toast{color:#aaa;font-size:10px;opacity:0;transition:opacity .3s;pointer-events:none}
.toast.show{opacity:1}
/* Font and colour are restated here rather than inherited from :host. A host
   page rule such as div{font-size:99px !important} matches the shadow host and
   inherits through the boundary; an explicit rule inside, which host CSS can
   never target, is what actually stops it. */
.log{flex:1;overflow-y:auto;overflow-x:hidden;background:#1e1e1e;color:#d4d4d4;
  font:12px/1.5 monospace;padding:4px 8px}
.entry{white-space:pre-wrap;word-break:break-word}
dialog{background:#2d2d2d;color:#d4d4d4;border:1px solid #555;border-radius:6px;
  padding:16px;width:80vw;max-width:640px;font-family:monospace;font-size:12px}
dialog::backdrop{background:rgba(0,0,0,.6)}
.row{display:flex;justify-content:space-between;align-items:center;font-size:11px;
  margin-bottom:8px}
.row button{background:transparent;border:none;color:#aaa;cursor:pointer;font-size:14px;padding:0}
textarea{width:100%;height:200px;background:#1e1e1e;color:#d4d4d4;border:1px solid #555;
  border-radius:4px;padding:8px;resize:vertical;font-family:monospace;font-size:12px}
${LEVEL_CSS}`;

const MARKUP = `
<div class="header">
  <button class="btn" data-act="clear" title="Clear">${icon(ICONS.clear)}</button>
  ${LOG_LEVELS.map(
    (level) =>
      `<label data-level="${level}"><input type="checkbox" checked data-level="${level}">${level}</label>`,
  ).join("")}
  <div class="spacer"><span class="toast">コピーしました</span></div>
  <button class="btn" data-act="copy" title="Copy">${icon(ICONS.copy)}</button>
</div>
<div class="log"></div>
<dialog>
  <div class="row"><span>テキストを選択してコピーしてください</span>
    <button data-act="close" title="Close">✕</button></div>
  <textarea readonly></textarea>
</dialog>`;

/**
 * Starts forwarding console output to a local collector without rendering the
 * on-page panel. Returns a function that flushes and stops.
 */
export function forwardConsoleLogs(options: ForwardOptions = {}): () => void {
  ensureConsoleHooks();
  ensureUncaughtHooks();
  return startForwarding(options);
}

/**
 * Renders the panel and starts capturing.
 *
 * Returns a dispose function that removes the panel, stops rendering into it,
 * and stops forwarding. Calling this twice without disposing stacks two panels
 * and two forwarders — React StrictMode and Vite HMR both do exactly that — so
 * the return value is the supported way to keep it to one.
 */
export function createConsoleViewer(options: ConsoleViewerOptions = {}): () => void {
  const noop = (): void => {};
  const { show = "always", height = 200, forward = false } = options;

  if ((show === "auto" || show === "iframe") && window.self === window.top) return noop;

  const host = document.createElement("div");
  // Findable from the outside: the panel's own nodes are inside a shadow root,
  // so this is the only handle a test or a user script has on it.
  host.setAttribute("data-console-daijin", "");
  host.style.height = `${height}px`;
  // A shadow root, so the page being debugged cannot restyle the panel and the
  // panel cannot leak styles into the page. The alternative — inline styles on
  // every node — was most of this file, and still lost to a host `!important`.
  const root = host.attachShadow({ mode: "open" });
  root.innerHTML = `<style>${CSS}</style>${MARKUP}`;

  document.body.appendChild(host);
  const previousPaddingBottom = document.body.style.paddingBottom;
  document.body.style.paddingBottom = `${height}px`;

  const find = <T extends Element>(selector: string): T =>
    root.querySelector(selector) as T;
  const logArea = find<HTMLElement>(".log");
  const toast = find<HTMLElement>(".toast");
  const dialog = find<HTMLDialogElement>("dialog");
  const textarea = find<HTMLTextAreaElement>("textarea");

  const activeFilters = new Set<LogLevel>(LOG_LEVELS);
  let toastTimer: ReturnType<typeof setTimeout>;

  for (const box of root.querySelectorAll<HTMLInputElement>("input[data-level]")) {
    const level = box.dataset.level as LogLevel;
    box.addEventListener("change", () => {
      if (box.checked) activeFilters.add(level);
      else activeFilters.delete(level);
      logArea.toggleAttribute(`data-hide-${level}`, !box.checked);
    });
  }

  find('[data-act="clear"]').addEventListener("click", () => {
    logArea.replaceChildren();
  });

  find('[data-act="close"]').addEventListener("click", () => dialog.close());

  find('[data-act="copy"]').addEventListener("click", () => {
    const text = [...root.querySelectorAll<HTMLElement>(".entry")]
      .filter((el) => activeFilters.has(el.dataset.level as LogLevel))
      .map((el) => el.textContent ?? "")
      .join("\n");

    navigator.clipboard?.writeText(text).then(
      () => {
        toast.classList.add("show");
        clearTimeout(toastTimer);
        toastTimer = setTimeout(() => toast.classList.remove("show"), 1500);
      },
      () => {
        // Clipboard access is denied in plenty of the environments this panel
        // exists for — cross-origin iframes, insecure contexts — so failing
        // here is ordinary rather than exceptional.
        textarea.value = text;
        dialog.showModal();
        textarea.select();
      },
    );
  });

  function appendEntry(entry: CapturedEntry): void {
    // Measured before the append: afterwards the new line is already part of
    // scrollHeight, so a tall entry such as a stack trace would read as "not at
    // the bottom" and silently stop the panel from following.
    const atBottom = logArea.scrollHeight - logArea.scrollTop - logArea.clientHeight < 40;

    const line = document.createElement("div");
    line.className = "entry";
    line.dataset.level = entry.level;
    line.textContent = `[${entry.level}] ${entry.text.join(" ")}`;
    logArea.appendChild(line);

    if (atBottom) logArea.scrollTop = logArea.scrollHeight;
  }

  ensureConsoleHooks();
  ensureUncaughtHooks();
  const unsubscribe = subscribe(appendEntry);
  const stopForwarding =
    forward === false ? noop : startForwarding(forward === true ? {} : forward);

  let disposed = false;
  return () => {
    if (disposed) return;
    disposed = true;
    unsubscribe();
    stopForwarding();
    host.remove();
    document.body.style.paddingBottom = previousPaddingBottom;
  };
}
