export interface ConsoleViewerOptions {
  show?: "auto" | "always" | "iframe";
  height?: number;
}

export function createConsoleViewer(options: ConsoleViewerOptions = {}): void {
  const { show = "auto", height = 200 } = options;

  // Visibility gate
  const isInsideIframe = window.self !== window.top;
  if (show === "auto" || show === "iframe") {
    if (!isInsideIframe) return;
  }

  // Build panel DOM with inline styles
  const panel = document.createElement("div");
  panel.style.cssText = [
    "position:fixed",
    "bottom:0",
    "left:0",
    "right:0",
    `height:${height}px`,
    "overflow-y:auto",
    "overflow-x:hidden",
    "background:#1e1e1e",
    "color:#d4d4d4",
    "font-family:monospace",
    "font-size:12px",
    "line-height:1.5",
    "z-index:2147483647",
    "box-sizing:border-box",
    "padding:4px 8px",
  ].join(";");
  document.body.appendChild(panel);

  type Level = "log" | "info" | "warn" | "error";

  function appendEntry(level: Level, args: unknown[]): void {
    const line = document.createElement("div");
    if (level === "info") line.style.color = "#9cdcfe";
    else if (level === "warn") line.style.color = "#dcdcaa";
    else if (level === "error") line.style.color = "#f44747";

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
    panel.appendChild(line);

    // Auto-scroll only when already near bottom
    if (panel.scrollHeight - panel.scrollTop - panel.clientHeight < 40) {
      panel.scrollTop = panel.scrollHeight;
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
