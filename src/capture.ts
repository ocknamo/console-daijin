/**
 * Capture core.
 *
 * Hooks `console.*` and uncaught errors once, serializes each record once, and
 * fans the result out to subscribers. The on-page panel and the network
 * transport are both just subscribers, so either can be used without the other.
 *
 * State lives on `globalThis` behind `Symbol.for`, not in module scope. Vite's
 * HMR re-evaluates a module without undoing its side effects, so a module-level
 * `consoleHooked` flag would reset to `false` while `console.log` was still
 * patched — and the next install would wrap the wrapper, with `originalConsole`
 * pointing at the previous patch instead of the real console. Output would
 * multiply on every hot update.
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

const STATE_KEY = Symbol.for("console-daijin.capture");

interface CaptureState {
  original: Record<ConsoleLevel, (...args: unknown[]) => void>;
  subscribers: Set<CaptureSubscriber>;
  consoleHooked: boolean;
  uncaughtHooked: boolean;
  /**
   * Guards against the classic failure mode: a subscriber logs (directly, or
   * indirectly through a patched `fetch`), that log is captured, the subscriber
   * runs again, and the page locks up. Nested emits are dropped instead.
   */
  inPipeline: boolean;
}

function getState(): CaptureState {
  const store = globalThis as unknown as Record<symbol, CaptureState | undefined>;
  let state = store[STATE_KEY];
  if (state === undefined) {
    state = {
      // Snapshotted before anything else has a chance to patch the console.
      original: {
        log: console.log.bind(console),
        info: console.info.bind(console),
        warn: console.warn.bind(console),
        error: console.error.bind(console),
      },
      subscribers: new Set<CaptureSubscriber>(),
      consoleHooked: false,
      uncaughtHooked: false,
      inPipeline: false,
    };
    store[STATE_KEY] = state;
  }
  return state;
}

const state = getState();

/**
 * The console as it was before we touched it. Everything internal logs through
 * this so our own output can never feed back into the capture pipeline.
 */
export const originalConsole = state.original;

export function subscribe(subscriber: CaptureSubscriber): () => void {
  state.subscribers.add(subscriber);
  return () => {
    state.subscribers.delete(subscriber);
  };
}

function emit(level: LogLevel, args: readonly unknown[]): void {
  if (state.inPipeline) return;
  if (state.subscribers.size === 0) return;

  state.inPipeline = true;
  try {
    const stack = firstErrorStack(args);
    const entry: CapturedEntry = {
      t: Date.now(),
      level,
      args,
      text: serializeArgs(args),
      ...(stack !== undefined ? { stack } : {}),
    };
    for (const subscriber of [...state.subscribers]) {
      try {
        subscriber(entry);
      } catch {
        // One broken subscriber must not stop the others, and must not stop
        // the page from logging.
      }
    }
  } finally {
    state.inPipeline = false;
  }
}

/** Installs the `console.*` hooks. Idempotent. Original output is preserved. */
export function ensureConsoleHooks(): void {
  if (state.consoleHooked) return;
  state.consoleHooked = true;

  for (const level of CONSOLE_LEVELS) {
    console[level] = (...args: unknown[]) => {
      state.original[level](...args);
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
  if (state.uncaughtHooked) return;
  if (typeof window === "undefined") return;
  state.uncaughtHooked = true;

  window.addEventListener(
    "error",
    (event: ErrorEvent) => {
      const target = event.target;
      // Resource load failures (img, script, link) also arrive here, with the
      // failing element as the target rather than an Error.
      if (
        target !== null &&
        target !== window &&
        typeof Element !== "undefined" &&
        target instanceof Element
      ) {
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
