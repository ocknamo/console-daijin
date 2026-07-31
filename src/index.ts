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

  // Visibility gate
  const isInsideIframe = window.self !== window.top;
  if (show === "auto" || show === "iframe") {
    if (!isInsideIframe) return noop;
  }

  const HEADER_H = 26;
  const activeFilters = new Set<LogLevel>(LOG_LEVELS);

  // Outer wrapper
  const wrapper = document.createElement("div");
  wrapper.style.cssText = [
    "position:fixed",
    "bottom:0",
    "left:0",
    "right:0",
    `height:${height}px`,
    "z-index:2147483647",
    "box-sizing:border-box",
    "font-family:monospace",
    "font-size:12px",
  ].join(";");
  document.body.appendChild(wrapper);
  const previousPaddingBottom = document.body.style.paddingBottom;
  document.body.style.paddingBottom = `${height}px`;

  // ---- Header ----
  const header = document.createElement("div");
  header.style.cssText = [
    `height:${HEADER_H}px`,
    "display:flex",
    "align-items:center",
    "background:#2d2d2d",
    "border-top:1px solid #555",
    "padding:0 4px",
    "gap:6px",
    "box-sizing:border-box",
  ].join(";");
  wrapper.appendChild(header);

  // SVG icon button helper
  function makeIconButton(svgPath: string, title: string, onClick: () => void): HTMLButtonElement {
    const btn = document.createElement("button");
    btn.title = title;
    btn.style.cssText = [
      "background:transparent",
      "border:none",
      "color:#aaa",
      "cursor:pointer",
      "padding:0 12px",
      "display:flex",
      "align-items:center",
      "line-height:1",
    ].join(";");
    btn.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="currentColor">${svgPath}</svg>`;
    btn.addEventListener("mouseenter", () => { btn.style.color = "#fff"; });
    btn.addEventListener("mouseleave", () => { btn.style.color = "#aaa"; });
    btn.addEventListener("click", onClick);
    return btn;
  }

  // Clear button (Material: clear_all)
  const clearBtn = makeIconButton(
    '<path d="M5 13h14v-2H5v2zm-2 4h14v-2H3v2zM7 7v2h14V7H7z"/>',
    "Clear",
    () => { logArea.innerHTML = ""; }
  );
  header.appendChild(clearBtn);

  // Filter checkboxes
  LOG_LEVELS.forEach((level) => {
    const label = document.createElement("label");
    label.style.cssText = [
      `color:${LEVEL_COLORS[level]}`,
      "display:flex",
      "align-items:center",
      "gap:2px",
      "cursor:pointer",
      "user-select:none",
      "padding:0 4px",
    ].join(";");

    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.checked = true;
    cb.style.cssText = "margin:0;cursor:pointer;width:10px;height:10px;";
    cb.addEventListener("change", () => {
      if (cb.checked) {
        activeFilters.add(level);
      } else {
        activeFilters.delete(level);
      }
      // Update visibility of existing entries
      logArea.querySelectorAll<HTMLElement>(`[data-level="${level}"]`).forEach((el) => {
        el.style.display = cb.checked ? "" : "none";
      });
    });

    const span = document.createElement("span");
    span.textContent = level;
    span.style.fontSize = "10px";

    label.appendChild(cb);
    label.appendChild(span);
    header.appendChild(label);
  });

  // Spacer to push copy button to the right (also holds copy toast)
  const spacer = document.createElement("div");
  spacer.style.cssText = "flex:1;display:flex;align-items:center;justify-content:flex-end;padding-right:4px";

  const copyToast = document.createElement("span");
  copyToast.textContent = "コピーしました";
  copyToast.style.cssText = [
    "color:#aaa",
    "font-size:10px",
    "opacity:0",
    "transition:opacity 0.3s",
    "pointer-events:none",
  ].join(";");
  spacer.appendChild(copyToast);
  let copyToastTimer: ReturnType<typeof setTimeout>;

  header.appendChild(spacer);

  function showCopyFallbackDialog(text: string): void {
    const overlay = document.createElement("div");
    overlay.style.cssText = [
      "position:fixed",
      "inset:0",
      "background:rgba(0,0,0,0.6)",
      "z-index:2147483647",
      "display:flex",
      "align-items:center",
      "justify-content:center",
    ].join(";");

    const dialog = document.createElement("div");
    dialog.style.cssText = [
      "background:#2d2d2d",
      "color:#d4d4d4",
      "border:1px solid #555",
      "border-radius:6px",
      "padding:16px",
      "width:80vw",
      "max-width:640px",
      "font-family:monospace",
      "font-size:12px",
      "display:flex",
      "flex-direction:column",
      "gap:8px",
    ].join(";");

    const titleRow = document.createElement("div");
    titleRow.style.cssText = "display:flex;justify-content:space-between;align-items:center";
    const title = document.createElement("span");
    title.textContent = "テキストを選択してコピーしてください";
    title.style.fontSize = "11px";
    const closeBtn = document.createElement("button");
    closeBtn.textContent = "✕";
    closeBtn.style.cssText = "background:transparent;border:none;color:#aaa;cursor:pointer;font-size:14px;padding:0";
    closeBtn.addEventListener("click", () => overlay.remove());
    titleRow.appendChild(title);
    titleRow.appendChild(closeBtn);

    const ta = document.createElement("textarea");
    ta.value = text;
    ta.readOnly = true;
    ta.style.cssText = [
      "width:100%",
      "height:200px",
      "background:#1e1e1e",
      "color:#d4d4d4",
      "border:1px solid #555",
      "border-radius:4px",
      "padding:8px",
      "resize:vertical",
      "font-family:monospace",
      "font-size:12px",
      "box-sizing:border-box",
    ].join(";");

    dialog.appendChild(titleRow);
    dialog.appendChild(ta);
    overlay.appendChild(dialog);
    overlay.addEventListener("click", (e) => { if (e.target === overlay) overlay.remove(); });
    document.body.appendChild(overlay);
    ta.focus();
    ta.select();
  }

  // Copy button (Material: content_copy)
  const copyBtn = makeIconButton(
    '<path d="M16 1H4c-1.1 0-2 .9-2 2v14h2V3h12V1zm3 4H8c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h11c1.1 0 2-.9 2-2V7c0-1.1-.9-2-2-2zm0 16H8V7h11v14z"/>',
    "Copy",
    async () => {
      const lines: string[] = [];
      logArea.querySelectorAll<HTMLElement>("[data-level]").forEach((el) => {
        if (el.style.display !== "none" && el.textContent) {
          lines.push(el.textContent);
        }
      });
      const text = lines.join("\n");
      let success = false;

      try {
        await navigator.clipboard.writeText(text);
        success = true;
      } catch (_e) {
        // 失敗時はダイアログへ
      }

      if (success) {
        copyToast.style.opacity = "1";
        clearTimeout(copyToastTimer);
        copyToastTimer = setTimeout(() => { copyToast.style.opacity = "0"; }, 1500);
      } else {
        showCopyFallbackDialog(text);
      }
    }
  );
  header.appendChild(copyBtn);

  // ---- Log area ----
  const logArea = document.createElement("div");
  logArea.style.cssText = [
    `height:${height - HEADER_H}px`,
    "overflow-y:auto",
    "overflow-x:hidden",
    "background:#1e1e1e",
    "color:#d4d4d4",
    "line-height:1.5",
    "box-sizing:border-box",
    "padding:4px 8px",
  ].join(";");
  wrapper.appendChild(logArea);

  function appendEntry(entry: CapturedEntry): void {
    const line = document.createElement("div");
    line.dataset.level = entry.level;
    line.style.color = LEVEL_COLORS[entry.level];
    // Stack traces are multi-line; keep them readable inside the panel.
    line.style.whiteSpace = "pre-wrap";
    line.style.wordBreak = "break-word";

    line.textContent = `[${entry.level}] ${entry.text.join(" ")}`;

    if (!activeFilters.has(entry.level)) {
      line.style.display = "none";
    }

    logArea.appendChild(line);

    // Auto-scroll only when already near bottom
    if (logArea.scrollHeight - logArea.scrollTop - logArea.clientHeight < 40) {
      logArea.scrollTop = logArea.scrollHeight;
    }
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
    wrapper.remove();
    document.body.style.paddingBottom = previousPaddingBottom;
  };
}
