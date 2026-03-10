export interface ConsoleViewerOptions {
  show?: "auto" | "always" | "iframe";
  height?: number;
}

export function createConsoleViewer(options: ConsoleViewerOptions = {}): void {
  const { show = "always", height = 200 } = options;

  // Visibility gate
  const isInsideIframe = window.self !== window.top;
  if (show === "auto" || show === "iframe") {
    if (!isInsideIframe) return;
  }

  type Level = "log" | "info" | "warn" | "error";

  const HEADER_H = 20;
  const activeFilters = new Set<Level>(["log", "info", "warn", "error"]);

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
      "padding:0 2px",
      "display:flex",
      "align-items:center",
      "line-height:1",
    ].join(";");
    btn.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="currentColor">${svgPath}</svg>`;
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
  const LEVEL_COLORS: Record<Level, string> = {
    log:   "#d4d4d4",
    info:  "#9cdcfe",
    warn:  "#dcdcaa",
    error: "#f44747",
  };

  (["log", "info", "warn", "error"] as Level[]).forEach((level) => {
    const label = document.createElement("label");
    label.style.cssText = [
      `color:${LEVEL_COLORS[level]}`,
      "display:flex",
      "align-items:center",
      "gap:2px",
      "cursor:pointer",
      "user-select:none",
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

  // Spacer to push copy button to the right
  const spacer = document.createElement("div");
  spacer.style.cssText = "flex:1";
  header.appendChild(spacer);

  // Copy button (Material: content_copy)
  const copyBtn = makeIconButton(
    '<path d="M16 1H4c-1.1 0-2 .9-2 2v14h2V3h12V1zm3 4H8c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h11c1.1 0 2-.9 2-2V7c0-1.1-.9-2-2-2zm0 16H8V7h11v14z"/>',
    "Copy",
    () => {
      const lines: string[] = [];
      logArea.querySelectorAll<HTMLElement>("[data-level]").forEach((el) => {
        if (el.style.display !== "none" && el.textContent) {
          lines.push(el.textContent);
        }
      });
      navigator.clipboard?.writeText(lines.join("\n"));
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

  function appendEntry(level: Level, args: unknown[]): void {
    const line = document.createElement("div");
    line.dataset.level = level;
    line.style.color = LEVEL_COLORS[level];

    const text = args
      .map((a) => {
        if (typeof a === "object" && a !== null) {
          try {
            return JSON.stringify(a);
          } catch {
            return String(a);
          }
        }
        return String(a);
      })
      .join(" ");

    line.textContent = `[${level}] ${text}`;

    if (!activeFilters.has(level)) {
      line.style.display = "none";
    }

    logArea.appendChild(line);

    // Auto-scroll only when already near bottom
    if (logArea.scrollHeight - logArea.scrollTop - logArea.clientHeight < 40) {
      logArea.scrollTop = logArea.scrollHeight;
    }
  }

  // Hook console methods (preserve original behavior)
  const origLog = console.log;
  const origInfo = console.info;
  const origWarn = console.warn;
  const origError = console.error;

  console.log = (...args: unknown[]) => {
    origLog.apply(console, args);
    appendEntry("log", args);
  };
  console.info = (...args: unknown[]) => {
    origInfo.apply(console, args);
    appendEntry("info", args);
  };
  console.warn = (...args: unknown[]) => {
    origWarn.apply(console, args);
    appendEntry("warn", args);
  };
  console.error = (...args: unknown[]) => {
    origError.apply(console, args);
    appendEntry("error", args);
  };
}
