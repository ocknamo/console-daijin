/**
 * Capture core.
 *
 * Hooks `console.*` and uncaught errors once, serializes each record once, and
 * fans the result out to subscribers. The on-page panel and the network
 * transport are both just subscribers, so either can be used without the other.
 */

import type { LogLevel } from "./protocol";
import { firstErrorStack, serializeArgs } from "./serialize";

export interface CapturedEntry {
  /** Epoch milliseconds. */
  t: number;
  level: LogLevel;
  /** Original arguments, for subscribers that want the live objects. */
  args: readonly unknown[];
  /** Serialized arguments. Computed once and shared by every subscriber. */
  text: string[];
  /** Stack of the first `Error` among the arguments, when there is one. */
  stack?: string;
}

export type CaptureSubscriber = (entry: CapturedEntry) => void;

type ConsoleLevel = "log" | "info" | "warn" | "error";

const CONSOLE_LEVELS: readonly ConsoleLevel[] = ["log", "info", "warn", "error"];

/**
 * Snapshotted at module load, before anything else has a chance to patch the
 * console. Everything internal logs through these so our own output can never
 * feed back into the capture pipeline.
 */
export const originalConsole: Record<ConsoleLevel, (...args: unknown[]) => void> = {
  log: console.log.bind(console),
  info: console.info.bind(console),
  warn: console.warn.bind(console),
  error: console.error.bind(console),
};

const subscribers = new Set<CaptureSubscriber>();

let consoleHooked = false;
let uncaughtHooked = false;

/**
 * Guards against the classic failure mode: a subscriber logs (directly, or
 * indirectly through a patched `fetch`), that log is captured, the subscriber
 * runs again, and the page locks up. Nested emits are dropped instead.
 */
let inPipeline = false;

export function subscribe(subscriber: CaptureSubscriber): () => void {
  subscribers.add(subscriber);
  return () => {
    subscribers.delete(subscriber);
  };
}

function emit(level: LogLevel, args: readonly unknown[]): void {
  if (inPipeline) return;
  if (subscribers.size === 0) return;

  inPipeline = true;
  try {
    const stack = firstErrorStack(args);
    const entry: CapturedEntry = {
      t: Date.now(),
      level,
      args,
      text: serializeArgs(args),
      ...(stack !== undefined ? { stack } : {}),
    };
    for (const subscriber of subscribers) {
      try {
        subscriber(entry);
      } catch {
        // One broken subscriber must not stop the others, and must not stop
        // the page from logging.
      }
    }
  } finally {
    inPipeline = false;
  }
}

/** Installs the `console.*` hooks. Idempotent. Original output is preserved. */
export function ensureConsoleHooks(): void {
  if (consoleHooked) return;
  consoleHooked = true;

  for (const level of CONSOLE_LEVELS) {
    console[level] = (...args: unknown[]) => {
      originalConsole[level](...args);
      emit(level, args);
    };
  }
}

function resourceUrl(el: Element): string | undefined {
  const candidate =
    (el as Partial<HTMLImageElement>).src ??
    (el as Partial<HTMLLinkElement>).href ??
    undefined;
  return typeof candidate === "string" && candidate !== "" ? candidate : undefined;
}

/**
 * Installs `error` and `unhandledrejection` listeners, reported as the
 * `uncaught` level. Idempotent, and a no-op outside a browser.
 */
export function ensureUncaughtHooks(): void {
  if (uncaughtHooked) return;
  if (typeof window === "undefined") return;
  uncaughtHooked = true;

  window.addEventListener(
    "error",
    (event: ErrorEvent) => {
      const target = event.target;
      // Resource load failures (img, script, link) also arrive here, with the
      // failing element as the target rather than an Error.
      if (target !== null && target !== window && target instanceof Element) {
        const url = resourceUrl(target);
        emit("uncaught", ["Failed to load resource:", url ?? target]);
        return;
      }
      emit("uncaught", [event.error ?? event.message ?? "Unknown error"]);
    },
    // Resource errors do not bubble, so they are only visible in capture phase.
    true,
  );

  window.addEventListener("unhandledrejection", (event: PromiseRejectionEvent) => {
    emit("uncaught", ["Unhandled promise rejection:", event.reason]);
  });
}
