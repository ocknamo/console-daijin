import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";

// The capture core snapshots the console when the module is first evaluated, so
// the spy has to be installed before the import. Everything the library reports
// internally goes through that snapshot.
const warnings = [];
const realWarn = console.warn;
console.warn = (...args) => {
  warnings.push(args.join(" "));
};
const { forwardConsoleLogs } = await import("../dist/index.js");
console.warn = realWarn;

const MAX_BODY_BYTES = 1024 * 1024;

function define(name, value) {
  Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
}

/** Minimal stand-ins for the browser globals the transport touches. */
function setupBrowser({ hostname = "localhost", sendBeacon, fetchImpl } = {}) {
  const listeners = new Map();
  const addEventListener = (type, fn) => {
    if (!listeners.has(type)) listeners.set(type, []);
    listeners.get(type).push(fn);
  };
  const removeEventListener = (type, fn) => {
    const list = listeners.get(type) ?? [];
    const i = list.indexOf(fn);
    if (i !== -1) list.splice(i, 1);
  };

  define("window", {
    location: { hostname, href: `http://${hostname}:5173/page` },
    addEventListener,
    removeEventListener,
  });
  define("document", { visibilityState: "visible", addEventListener, removeEventListener });
  define("navigator", { sendBeacon });
  define("fetch", fetchImpl);

  return {
    fire: (type) => {
      for (const fn of listeners.get(type) ?? []) fn();
    },
  };
}

function recordingFetch(respond = () => ({ ok: true, status: 204 })) {
  const calls = [];
  const impl = (url, init) => {
    calls.push({ url, init, body: init.body });
    const res = respond(calls.length);
    return res instanceof Promise ? res : Promise.resolve(res);
  };
  return { calls, impl };
}

let stop = () => {};

beforeEach(() => {
  warnings.length = 0;
});

afterEach(() => {
  stop();
  stop = () => {};
});

describe("batching", () => {
  test("splits by bytes so a batch never exceeds the server's body limit", async () => {
    const { calls, impl } = recordingFetch();
    setupBrowser({ fetchImpl: impl });
    // 120 entries x ~10 KB is well past one batch but far below MAX_BUFFER.
    stop = forwardConsoleLogs({ batchMs: 5, batchSize: 1000 });

    for (let i = 0; i < 120; i++) console.log("x".repeat(10_000));
    await sleep(300);

    assert.ok(calls.length >= 2, `expected several batches, got ${calls.length}`);
    for (const call of calls) {
      const bytes = Buffer.byteLength(call.body, "utf8");
      assert.ok(bytes < MAX_BODY_BYTES, `batch of ${bytes} bytes exceeds the 1 MB limit`);
    }

    const sent = calls.flatMap((c) => JSON.parse(c.body).entries);
    assert.equal(sent.length, 120, "every entry should reach the collector");
  });

  test("a single oversized entry is shrunk rather than wedging the queue", async () => {
    const { calls, impl } = recordingFetch();
    setupBrowser({ fetchImpl: impl });
    stop = forwardConsoleLogs({ batchMs: 5, batchSize: 1000 });

    // 200 arguments of 10 KB each lands in one entry far bigger than a batch.
    console.log(...Array.from({ length: 200 }, () => "y".repeat(10_000)));
    await sleep(200);

    assert.ok(calls.length >= 1, "the entry should still be sent");
    for (const call of calls) {
      assert.ok(Buffer.byteLength(call.body, "utf8") < MAX_BODY_BYTES);
    }
  });

  test("shrinking holds even for a huge spread, by dropping arguments", async () => {
    // Truncating each argument is not enough on its own: a per-argument floor
    // times 20,000 arguments is still over the limit. `console.log(...arr)`
    // with a big array is an ordinary accident.
    const { calls, impl } = recordingFetch();
    setupBrowser({ fetchImpl: impl });
    stop = forwardConsoleLogs({ batchMs: 5, batchSize: 1000 });

    console.log(...Array.from({ length: 20_000 }, () => "q".repeat(500)));
    await sleep(400);

    assert.ok(calls.length >= 1, "the entry should still be sent");
    for (const call of calls) {
      const bytes = Buffer.byteLength(call.body, "utf8");
      assert.ok(bytes < MAX_BODY_BYTES, `body of ${bytes} bytes exceeds the 1 MB limit`);
    }
    const args = calls.flatMap((c) => JSON.parse(c.body).entries).flatMap((e) => e.args);
    assert.ok(
      args.some((a) => /more arguments dropped/.test(a)),
      "dropping arguments should be visible in the output",
    );
  });

  test("entries are batched rather than sent one request per line", async () => {
    const { calls, impl } = recordingFetch();
    setupBrowser({ fetchImpl: impl });
    stop = forwardConsoleLogs({ batchMs: 50, batchSize: 1000 });

    for (let i = 0; i < 30; i++) console.log("small", i);
    await sleep(200);

    assert.equal(calls.length, 1, `expected one batch, got ${calls.length}`);
    assert.equal(JSON.parse(calls[0].body).entries.length, 30);
  });
});

describe("failure accounting", () => {
  test("stops after maxFailures when the collector is unreachable", async () => {
    const { calls, impl } = recordingFetch(() => Promise.reject(new Error("ECONNREFUSED")));
    setupBrowser({ fetchImpl: impl });
    stop = forwardConsoleLogs({ batchMs: 5, batchSize: 1, maxFailures: 3 });

    for (let i = 0; i < 20; i++) {
      console.log("attempt", i);
      await sleep(15);
    }
    await sleep(100);

    assert.equal(calls.length, 3, `expected exactly 3 attempts, got ${calls.length}`);
    const giveUps = warnings.filter((w) => w.includes("stopped forwarding logs"));
    assert.equal(giveUps.length, 1, `expected one give-up warning, got ${giveUps.length}`);
  });

  test("a rejected payload does not count as the collector being down", async () => {
    // 413 means "this batch was wrong", not "nothing is listening". Counting it
    // as a reachability failure stopped forwarding on busy pages and blamed a
    // collector that was running.
    const { calls, impl } = recordingFetch(() => ({ ok: false, status: 413 }));
    setupBrowser({ fetchImpl: impl });
    stop = forwardConsoleLogs({ batchMs: 5, batchSize: 1, maxFailures: 3 });

    for (let i = 0; i < 10; i++) {
      console.log("payload", i);
      await sleep(15);
    }
    await sleep(100);

    assert.ok(calls.length >= 8, `forwarding should continue, only got ${calls.length} attempts`);
    assert.equal(
      warnings.filter((w) => w.includes("stopped forwarding logs")).length,
      0,
      "413 must not trip the circuit breaker",
    );
    const payloadWarnings = warnings.filter((w) => w.includes("rejected a batch"));
    assert.equal(payloadWarnings.length, 1, "the payload problem should be reported once");
  });

  test("a malformed-batch rejection stops with the collector's own reason", async () => {
    // A version mismatch between the library and the CLI is permanent, so
    // "that batch was dropped, forwarding continues" would be a lie repeated
    // forever while nothing arrived.
    const { calls, impl } = recordingFetch(() => ({
      ok: false,
      status: 400,
      text: () => Promise.resolve(JSON.stringify({ error: "unsupported protocol version: 2" })),
    }));
    setupBrowser({ fetchImpl: impl });
    stop = forwardConsoleLogs({ batchMs: 5, batchSize: 1, maxFailures: 3 });

    for (let i = 0; i < 10; i++) {
      console.log("skewed", i);
      await sleep(15);
    }
    await sleep(100);

    assert.equal(calls.length, 3, `expected 3 attempts, got ${calls.length}`);
    const stopWarnings = warnings.filter((w) => w.includes("stopped forwarding logs"));
    assert.equal(stopWarnings.length, 1);
    assert.match(stopWarnings[0], /unsupported protocol version: 2/);
    assert.match(stopWarnings[0], /different versions/);
    assert.doesNotMatch(stopWarnings[0], /Forwarding continues/);
  });

  test("a successful batch clears the malformed-batch counter too", async () => {
    // Only an unbroken run of 400s means the two sides disagree. A receiver
    // that is restarting — or a proxy in front of a replaceable endpoint — can
    // return the odd 400, and accumulating those would halt a healthy session
    // and then blame it on a version mismatch.
    const { calls, impl } = recordingFetch((n) =>
      n % 10 === 0
        ? { ok: false, status: 400, text: () => Promise.resolve('{"error":"transient"}') }
        : { ok: true, status: 204 },
    );
    setupBrowser({ fetchImpl: impl });
    stop = forwardConsoleLogs({ batchMs: 5, batchSize: 1, maxFailures: 3 });

    for (let i = 0; i < 30; i++) {
      console.log("mostly fine", i);
      await sleep(12);
    }
    await sleep(150);

    assert.ok(calls.length >= 25, `forwarding should continue, got ${calls.length} attempts`);
    assert.equal(
      warnings.filter((w) => w.includes("stopped forwarding logs")).length,
      0,
      "sporadic 400s must not stop a session that is overwhelmingly succeeding",
    );
  });

  test("400 and 413 are counted separately", async () => {
    // A 413 must not push the protocol counter toward its limit.
    const { calls, impl } = recordingFetch((n) =>
      n % 2 === 0
        ? { ok: false, status: 413 }
        : { ok: false, status: 400, text: () => Promise.resolve("{}") },
    );
    setupBrowser({ fetchImpl: impl });
    stop = forwardConsoleLogs({ batchMs: 5, batchSize: 1, maxFailures: 3 });

    for (let i = 0; i < 12; i++) {
      console.log("mixed", i);
      await sleep(15);
    }
    await sleep(100);

    // Three 400s arrive on calls 1, 3 and 5, so it halts around there rather
    // than after three responses of any kind.
    assert.ok(calls.length >= 5, `expected at least 5 attempts, got ${calls.length}`);
    assert.equal(warnings.filter((w) => w.includes("stopped forwarding logs")).length, 1);
  });

  test("a 5xx does count as a reachability failure", async () => {
    const { calls, impl } = recordingFetch(() => ({ ok: false, status: 500 }));
    setupBrowser({ fetchImpl: impl });
    stop = forwardConsoleLogs({ batchMs: 5, batchSize: 1, maxFailures: 2 });

    for (let i = 0; i < 10; i++) {
      console.log("five hundred", i);
      await sleep(15);
    }
    await sleep(100);

    assert.equal(calls.length, 2);
    assert.match(warnings.join("\n"), /stopped forwarding logs/);
  });
});

describe("unload", () => {
  test("pagehide drains the whole buffer, not just the first batch", async () => {
    const beacons = [];
    const { impl } = recordingFetch();
    const browser = setupBrowser({
      fetchImpl: impl,
      sendBeacon: (url, blob) => {
        beacons.push(blob);
        return true;
      },
    });
    // Never flush on a timer, so everything is still buffered at unload.
    stop = forwardConsoleLogs({ batchMs: 100_000, batchSize: 100_000 });

    for (let i = 0; i < 400; i++) console.log("y".repeat(1_000));
    browser.fire("pagehide");
    await sleep(50);

    assert.ok(beacons.length > 1, `expected several beacons, got ${beacons.length}`);
    const bodies = await Promise.all(beacons.map((b) => b.text()));
    const sent = bodies.flatMap((b) => JSON.parse(b).entries);
    assert.equal(sent.length, 400, `expected all 400 entries, got ${sent.length}`);
    for (const blob of beacons) {
      assert.ok(blob.size <= 64 * 1024, `beacon of ${blob.size} bytes exceeds the 64 KiB queue`);
    }
  });

  test("a refused beacon falls back to keepalive fetch instead of vanishing", async () => {
    const { calls, impl } = recordingFetch();
    const browser = setupBrowser({ fetchImpl: impl, sendBeacon: () => false });
    stop = forwardConsoleLogs({ batchMs: 100_000, batchSize: 100_000 });

    console.log("last words before unload");
    browser.fire("pagehide");
    await sleep(50);

    assert.equal(calls.length, 1, "the refused beacon should be retried over fetch");
    assert.equal(calls[0].init.keepalive, true, "unload fetches must set keepalive");
    assert.match(calls[0].body, /last words before unload/);
  });

  test("hiding the tab flushes too", async () => {
    const beacons = [];
    const { impl } = recordingFetch();
    const browser = setupBrowser({
      fetchImpl: impl,
      sendBeacon: (url, blob) => {
        beacons.push(blob);
        return true;
      },
    });
    stop = forwardConsoleLogs({ batchMs: 100_000, batchSize: 100_000 });

    console.log("before hide");
    globalThis.document.visibilityState = "hidden";
    browser.fire("visibilitychange");
    await sleep(50);

    assert.equal(beacons.length, 1);
    assert.match(await beacons[0].text(), /before hide/);
  });
});

describe("safety", () => {
  test("a transport that logs cannot drive itself in a loop", async () => {
    let depth = 0;
    let maxDepth = 0;
    const { calls, impl } = recordingFetch(() => {
      depth++;
      maxDepth = Math.max(maxDepth, depth);
      // A patched fetch that logs is exactly how this deadlocks in the wild.
      console.log("fetch internals logging");
      depth--;
      return { ok: true, status: 204 };
    });
    setupBrowser({ fetchImpl: impl });
    stop = forwardConsoleLogs({ batchMs: 5, batchSize: 1 });

    console.log("kick it off");
    await sleep(200);

    assert.ok(calls.length < 20, `runaway forwarding: ${calls.length} requests`);
    assert.equal(maxDepth, 1);
  });

  test("a non-loopback page is refused and says why once", async () => {
    const { calls, impl } = recordingFetch();
    setupBrowser({ hostname: "app.example.com", fetchImpl: impl });
    stop = forwardConsoleLogs({ batchMs: 5, batchSize: 1 });

    console.log("must not leave the page");
    await sleep(100);

    assert.equal(calls.length, 0);
    assert.equal(warnings.filter((w) => w.includes("forwarding is disabled")).length, 1);
  });

  test("allowNonLocal overrides the production guard", async () => {
    const { calls, impl } = recordingFetch();
    setupBrowser({ hostname: "app.example.com", fetchImpl: impl });
    stop = forwardConsoleLogs({ batchMs: 5, batchSize: 1, allowNonLocal: true });

    console.log("deliberately remote");
    await sleep(100);

    assert.equal(calls.length, 1);
  });

  test("the original console output is preserved", async () => {
    const { impl } = recordingFetch();
    setupBrowser({ fetchImpl: impl });
    stop = forwardConsoleLogs({ batchMs: 5, batchSize: 1 });

    warnings.length = 0;
    console.warn("this must still reach the real console");
    await sleep(50);

    assert.ok(warnings.some((w) => w.includes("this must still reach the real console")));
  });
});
