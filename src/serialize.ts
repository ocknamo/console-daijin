/**
 * Safe value-to-string conversion for log arguments.
 *
 * `JSON.stringify` is not usable here: it turns `Error` into `{}` because
 * `message` and `stack` are non-enumerable, and it throws on circular
 * references and `BigInt`. Losing the stack trace is the whole point of a log
 * line for an error, so errors get first-class handling below.
 *
 * This module must stay usable outside a browser (the test suite runs it under
 * Node), so every DOM reference is guarded with `typeof`.
 */

const DEFAULT_MAX_DEPTH = 4;
const DEFAULT_MAX_LENGTH = 10_000;

/** Per-collection cap, so one huge array cannot build a giant string. */
const MAX_ENTRIES = 100;

export interface SerializeOptions {
  /** Nesting levels to walk before collapsing to `[Object]`. Default 4. */
  maxDepth?: number;
  /** Character cap per argument. Default 10000. */
  maxLength?: number;
}

export function serializeArgs(
  args: readonly unknown[],
  options: SerializeOptions = {},
): string[] {
  return args.map((arg) => serializeArg(arg, options));
}

export function serializeArg(value: unknown, options: SerializeOptions = {}): string {
  const maxDepth = options.maxDepth ?? DEFAULT_MAX_DEPTH;
  const maxLength = options.maxLength ?? DEFAULT_MAX_LENGTH;

  let out: string;
  try {
    out = format(value, 0, new Set<object>(), maxDepth);
  } catch {
    // A throwing getter or exotic proxy should never take down the caller.
    try {
      out = String(value);
    } catch {
      out = "[unserializable]";
    }
  }
  return truncate(out, maxLength);
}

/** Stack of the first `Error` among the arguments, for `LogEntry.stack`. */
export function firstErrorStack(args: readonly unknown[]): string | undefined {
  for (const arg of args) {
    if (arg instanceof Error && typeof arg.stack === "string" && arg.stack !== "") {
      return arg.stack;
    }
  }
  return undefined;
}

function truncate(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  return `${text.slice(0, maxLength)}…(truncated ${text.length - maxLength} chars)`;
}

function isElement(value: unknown): value is Element {
  return typeof Element !== "undefined" && value instanceof Element;
}

function isDomNode(value: unknown): value is Node {
  return typeof Node !== "undefined" && value instanceof Node;
}

function describeElement(el: Element): string {
  let out = el.tagName.toLowerCase();
  if (el.id) out += `#${el.id}`;
  const className = el.getAttribute("class");
  if (className && className.trim() !== "") {
    out += className
      .trim()
      .split(/\s+/)
      .map((c) => `.${c}`)
      .join("");
  }
  return `<${out}>`;
}

function format(
  value: unknown,
  depth: number,
  seen: Set<object>,
  maxDepth: number,
): string {
  if (value === null) return "null";
  if (value === undefined) return "undefined";

  switch (typeof value) {
    case "string":
      // Top-level strings print raw, like the console does; nested ones quoted.
      return depth === 0 ? value : JSON.stringify(value);
    case "number":
      return Object.is(value, -0) ? "-0" : String(value);
    case "boolean":
      return String(value);
    case "bigint":
      return `${value}n`;
    case "symbol":
      return String(value);
    case "function": {
      const name = (value as (...args: unknown[]) => unknown).name;
      return name ? `[Function: ${name}]` : "[Function (anonymous)]";
    }
  }

  const obj = value as object;

  // Only the current path is tracked, so a value referenced twice in a tree is
  // printed twice rather than being mislabelled as circular.
  if (seen.has(obj)) return "[Circular]";

  if (value instanceof Error) return formatError(value, depth, seen, maxDepth);
  if (isElement(value)) return describeElement(value);
  if (isDomNode(value)) return `[${value.nodeName}]`;
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? "Invalid Date" : value.toISOString();
  }
  if (value instanceof RegExp) return String(value);

  if (depth >= maxDepth) {
    return Array.isArray(value) ? "[Array]" : `[${constructorName(obj) ?? "Object"}]`;
  }

  seen.add(obj);
  try {
    if (Array.isArray(value)) {
      const items = value
        .slice(0, MAX_ENTRIES)
        .map((item) => format(item, depth + 1, seen, maxDepth));
      return `[${withOverflow(items, value.length).join(", ")}]`;
    }

    if (typeof Map !== "undefined" && value instanceof Map) {
      const items: string[] = [];
      for (const [k, v] of value) {
        if (items.length >= MAX_ENTRIES) break;
        items.push(
          `${format(k, depth + 1, seen, maxDepth)} => ${format(v, depth + 1, seen, maxDepth)}`,
        );
      }
      return `Map(${value.size}) {${items.length ? ` ${withOverflow(items, value.size).join(", ")} ` : ""}}`;
    }

    if (typeof Set !== "undefined" && value instanceof Set) {
      const items: string[] = [];
      for (const v of value) {
        if (items.length >= MAX_ENTRIES) break;
        items.push(format(v, depth + 1, seen, maxDepth));
      }
      return `Set(${value.size}) {${items.length ? ` ${withOverflow(items, value.size).join(", ")} ` : ""}}`;
    }

    return formatPlainObject(obj, depth, seen, maxDepth);
  } finally {
    seen.delete(obj);
  }
}

function withOverflow(items: string[], total: number): string[] {
  if (total <= items.length) return items;
  return [...items, `…${total - items.length} more`];
}

function constructorName(obj: object): string | undefined {
  const name = obj.constructor?.name;
  return name && name !== "Object" ? name : undefined;
}

function formatPlainObject(
  obj: object,
  depth: number,
  seen: Set<object>,
  maxDepth: number,
): string {
  const keys = Object.keys(obj);
  const shown = keys.slice(0, MAX_ENTRIES);
  const parts = shown.map((key) => {
    let rendered: string;
    try {
      rendered = format((obj as Record<string, unknown>)[key], depth + 1, seen, maxDepth);
    } catch {
      // Accessor properties can throw; report rather than abort the whole line.
      rendered = "[getter threw]";
    }
    return `${isIdentifier(key) ? key : JSON.stringify(key)}: ${rendered}`;
  });

  const prefix = constructorName(obj);
  const body = parts.length
    ? `{ ${withOverflow(parts, keys.length).join(", ")} }`
    : "{}";
  return prefix ? `${prefix} ${body}` : body;
}

function isIdentifier(key: string): boolean {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(key);
}

function formatError(
  err: Error,
  depth: number,
  seen: Set<object>,
  maxDepth: number,
): string {
  const name = err.name || "Error";
  const message = typeof err.message === "string" ? err.message : "";
  const head = message ? `${name}: ${message}` : name;

  const stack = typeof err.stack === "string" ? err.stack : "";
  // V8 stacks already start with "Name: message"; Firefox and Safari do not.
  let out = stack === "" ? head : stack.startsWith(name) ? stack : `${head}\n${stack}`;

  // Own enumerable extras such as `err.code` are usually the useful part.
  const extras = Object.keys(err).filter((k) => k !== "stack" && k !== "message");
  if (extras.length > 0 && depth < maxDepth) {
    const parts = extras.map((key) => {
      let rendered: string;
      try {
        rendered = format((err as unknown as Record<string, unknown>)[key], depth + 1, seen, maxDepth);
      } catch {
        rendered = "[getter threw]";
      }
      return `${key}: ${rendered}`;
    });
    out += `\n  { ${parts.join(", ")} }`;
  }

  const cause = (err as { cause?: unknown }).cause;
  if (cause !== undefined && depth < maxDepth) {
    out += `\n  [cause] ${format(cause, depth + 1, seen, maxDepth)}`;
  }

  // Duck-typed rather than `instanceof AggregateError`, which would require a
  // newer `lib` than the browser build targets. `errors` is non-enumerable, so
  // it is not covered by the extras above.
  const aggregated = (err as { errors?: unknown }).errors;
  if (Array.isArray(aggregated) && depth < maxDepth) {
    for (const inner of aggregated.slice(0, MAX_ENTRIES)) {
      out += `\n  [error] ${format(inner, depth + 1, seen, maxDepth)}`;
    }
  }

  return out;
}
