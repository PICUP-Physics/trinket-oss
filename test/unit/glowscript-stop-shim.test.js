'use strict';

// Runner-side half of the GlowScript Stop button. The shim runs INSIDE the
// program's sandboxed runner page; these tests drive it with a fake window.
// Spec: docs/superpowers/specs/2026-10-09-glowscript-stop-button-design.md

const { install, source } = require('../../public/js/embed/glowscript-stop-shim');

function fakeWindow(extra) {
  const listeners = [];
  const posted = [];
  const win = Object.assign({
    parent: { postMessage: (message) => posted.push(JSON.parse(message)) },
    addEventListener: (type, fn) => { if (type === 'message') { listeners.push(fn); } },
  }, extra);
  win.posted = posted;
  // A message event as the page sends it: from the runner's parent, unless the
  // test names another source (null is no source at all).
  win.send = (data, source = win.parent) => listeners.forEach((fn) => fn({ data, source }));
  return win;
}

function deferred() {
  let resolve, reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
const stoppedCount = (win) => win.posted.filter((m) => m['glowscript.stopped']).length;

describe('install', () => {
  it('announces itself to the page once', () => {
    const win = fakeWindow();
    install(win);
    expect(win.posted).toEqual([{ 'glowscript.ready': true }]);
  });

  it('is idempotent: a second install neither re-wraps nor re-announces', () => {
    const win = fakeWindow({ rate: () => Promise.resolve() });
    install(win);
    const wrapped = win.rate;
    install(win);
    expect(win.rate).toBe(wrapped);
    expect(win.posted).toHaveLength(1);
  });

  it('skips wait functions the runtime does not define', () => {
    const win = fakeWindow({ rate: () => Promise.resolve() });
    install(win);
    expect(win.sleep).toBeUndefined();
    expect(win.rate.__trinketStoppable).toBe(true);
  });

  it('returns the stop state it publishes on the window, and the same one on a second install', () => {
    const win = fakeWindow();
    const state = install(win);
    expect(state).toBe(win.__trinketStop);
    expect(state).toEqual({ requested: false, pending: 0, confirmed: false, exempt: 0, allowWaits: expect.any(Function) });
    expect(install(win)).toBe(state);
  });
});

describe('promise-style waits (GlowScript 2.9 and later)', () => {
  it('pass values and errors through while no stop is requested', async () => {
    const win = fakeWindow({ rate: (n) => Promise.resolve(n * 2), sleep: () => Promise.reject(new Error('nope')) });
    install(win);
    await expect(win.rate(21)).resolves.toBe(42);
    await expect(win.sleep(1)).rejects.toThrow('nope');
  });

  it('a stop while a wait is pending confirms at once and never resumes the program', async () => {
    const pending = deferred();
    const win = fakeWindow({ rate: () => pending.promise });
    install(win);
    let resumed = false;
    win.rate(30).then(() => { resumed = true; });

    win.send('glowscript.stop');
    expect(stoppedCount(win)).toBe(1);

    pending.resolve();
    await tick();
    expect(resumed).toBe(false);
  });

  it('returns a non-promise result untouched, and does not count it as a wait in progress', () => {
    const win = fakeWindow({ rate: () => 7 });
    install(win);
    expect(win.rate(1)).toBe(7);
    win.send('glowscript.stop');
    expect(stoppedCount(win)).toBe(0);
  });

  it('a stop after a completed wait confirms at the next wait, not at once', async () => {
    const win = fakeWindow({ rate: () => Promise.resolve() });
    install(win);
    await win.rate(30);
    win.send('glowscript.stop');
    expect(stoppedCount(win)).toBe(0);
    win.rate(30);
    expect(stoppedCount(win)).toBe(1);
  });

  it('a stop after a failed wait confirms at the next wait, not at once', async () => {
    const failing = deferred();
    const win = fakeWindow({ sleep: () => failing.promise });
    install(win);
    win.sleep(1).catch(() => {});
    failing.reject(new Error('nope'));
    await tick();
    win.send('glowscript.stop');
    expect(stoppedCount(win)).toBe(0);
    win.sleep(1);
    expect(stoppedCount(win)).toBe(1);
  });

  it('a stop while the program computes confirms at its next wait, which never returns', async () => {
    const win = fakeWindow({ rate: () => Promise.resolve() });
    install(win);
    win.send('glowscript.stop');
    expect(stoppedCount(win)).toBe(0);

    let resumed = false;
    win.rate(30).then(() => { resumed = true; });
    await tick();
    expect(stoppedCount(win)).toBe(1);
    expect(resumed).toBe(false);
  });

  it('a rejection after a stop does not reach the program either', async () => {
    const pending = deferred();
    const win = fakeWindow({ sleep: () => pending.promise });
    install(win);
    let settled = false;
    win.sleep(1).then(() => { settled = true; }, () => { settled = true; });
    win.send('glowscript.stop');
    pending.reject(new Error('late'));
    await tick();
    expect(settled).toBe(false);
  });

  it('confirms only once however many waits are parked', async () => {
    const win = fakeWindow({ rate: () => deferred().promise, sleep: () => deferred().promise });
    install(win);
    win.rate(30);
    win.sleep(1);
    win.send('glowscript.stop');
    win.send('glowscript.stop');
    win.rate(30);
    await tick();
    expect(stoppedCount(win)).toBe(1);
  });

  it('wraps canvas waits and keeps their receiver', async () => {
    function canvas() {}
    let receiver = null;
    canvas.prototype.waitfor = function () { receiver = this; return Promise.resolve('click'); };
    const win = fakeWindow({ canvas });
    install(win);
    const scene = new canvas();
    await expect(scene.waitfor('click')).resolves.toBe('click');
    expect(receiver).toBe(scene);
    expect(canvas.prototype.waitfor.__trinketStoppable).toBe(true);
  });
});

describe('callback-style waits (GlowScript 1.1 to 2.7)', () => {
  it('resume the program normally while no stop is requested', () => {
    let pendingCallback = null;
    const win = fakeWindow({ rate: (n, cb) => { pendingCallback = cb; } });
    install(win);
    let resumed = false;
    win.rate(30, () => { resumed = true; });
    pendingCallback();
    expect(resumed).toBe(true);
  });

  it('a stop after a completed wait confirms at the next wait, not at once', () => {
    let pendingCallback = null;
    const win = fakeWindow({ rate: (n, cb) => { pendingCallback = cb; } });
    install(win);
    win.rate(30, () => {});
    pendingCallback();
    win.send('glowscript.stop');
    expect(stoppedCount(win)).toBe(0);
    win.rate(30, () => {});
    expect(stoppedCount(win)).toBe(1);
  });

  it('a stop while parked confirms at once and swallows the continuation', () => {
    let pendingCallback = null;
    const win = fakeWindow({ rate: (n, cb) => { pendingCallback = cb; } });
    install(win);
    let resumed = false;
    win.rate(30, () => { resumed = true; });
    win.send('glowscript.stop');
    expect(stoppedCount(win)).toBe(1);
    pendingCallback();
    expect(resumed).toBe(false);
  });

  // A wait settles once. Were a repeated call to count again, pending would drop
  // below the waits really in flight and the program would resume twice.
  it('a continuation the runtime calls twice settles the wait once and resumes the program once', () => {
    const continuations = [];
    const win = fakeWindow({ rate: (n, cb) => { continuations.push(cb); } });
    install(win);
    let resumed = 0;
    win.rate(30, () => { resumed += 1; });
    expect(win.__trinketStop.pending).toBe(1);

    continuations[0]();
    continuations[0]();
    expect(win.__trinketStop.pending).toBe(0);
    expect(resumed).toBe(1);
  });

  it('a second call of one continuation does not hide another wait in flight from a stop', () => {
    const continuations = [];
    const win = fakeWindow({ rate: (n, cb) => { continuations.push(cb); } });
    install(win);
    win.rate(30, () => {});
    win.rate(30, () => {});
    continuations[0]();
    continuations[0]();

    // The program is parked in the second wait, so the stop confirms at once.
    win.send('glowscript.stop');
    expect(stoppedCount(win)).toBe(1);
  });
});

// The page opens allowWaits() around a snapshot request: after Stop the
// program is parked, and the runtime's screenshot goes through the same waits.
describe('allowWaits: a snapshot after a confirmed stop', () => {
  // rate() as the runtime provides it: each call is a wait the test settles,
  // and reaching it at all shows the call was not parked by the shim.
  function controlledRate() {
    const calls = [];
    return { calls, rate: () => { const wait = deferred(); calls.push(wait); return wait.promise; } };
  }

  // A program parked in its rate() wait by a confirmed stop.
  function parkedProgram(extra) {
    const runtime = controlledRate();
    const win = fakeWindow(Object.assign({ rate: runtime.rate, setTimeout: () => 0 }, extra));
    install(win);
    let resumed = false;
    win.rate(30).then(() => { resumed = true; });
    win.send('glowscript.stop');
    expect(stoppedCount(win)).toBe(1);
    return { win, calls: runtime.calls, resumed: () => resumed };
  }

  it('lets a wait made while the window is open through, and it resolves', async () => {
    const { win, calls } = parkedProgram();
    win.__trinketStop.allowWaits();
    const snapshotWait = win.rate(60);
    expect(calls).toHaveLength(2);
    calls[1].resolve('drawn');
    await expect(snapshotWait).resolves.toBe('drawn');
    expect(stoppedCount(win)).toBe(1);
  });

  it('keeps a wait made before the window parked when it resolves inside it', async () => {
    const { win, calls, resumed } = parkedProgram();
    win.__trinketStop.allowWaits();
    calls[0].resolve();
    await tick();
    expect(resumed()).toBe(false);
  });

  it('closes on release(), and a second release() closes nothing more', () => {
    const { win, calls } = parkedProgram();
    const release = win.__trinketStop.allowWaits();
    release();
    win.rate(60);
    expect(calls).toHaveLength(1);
    release();
    win.__trinketStop.allowWaits();
    win.rate(60);
    expect(calls).toHaveLength(2);
  });

  it('closes on its own after 5 s, so a snapshot that never finishes cannot hold it open', () => {
    const timers = [];
    const { win, calls } = parkedProgram({ setTimeout: (fn, ms) => { timers.push({ fn, ms }); } });
    const release = win.__trinketStop.allowWaits();
    expect(timers.map((t) => t.ms)).toEqual([5000]);
    win.rate(60);
    expect(calls).toHaveLength(2);
    timers[0].fn();
    win.rate(60);
    expect(calls).toHaveLength(2);
    // The snapshot finishing late does not close a window opened after it.
    release();
    win.__trinketStop.allowWaits();
    win.rate(60);
    expect(calls).toHaveLength(3);
  });

  it('lets a callback-style wait and its continuation through too (GlowScript 1.1 to 2.7)', () => {
    const continuations = [];
    const win = fakeWindow({ rate: (n, cb) => { continuations.push(cb); }, setTimeout: () => 0 });
    install(win);
    let resumed = false;
    win.rate(30, () => { resumed = true; });
    win.send('glowscript.stop');
    win.__trinketStop.allowWaits();
    let drawn = false;
    win.rate(60, () => { drawn = true; });
    expect(continuations).toHaveLength(2);
    continuations[1]();
    expect(drawn).toBe(true);
    continuations[0]();
    expect(resumed).toBe(false);
    expect(stoppedCount(win)).toBe(1);
  });

  it('gives nothing while a stop is requested but not yet confirmed: the wait confirms and parks', async () => {
    const runtime = controlledRate();
    const win = fakeWindow({ rate: runtime.rate, setTimeout: () => 0 });
    install(win);
    win.send('glowscript.stop');
    expect(stoppedCount(win)).toBe(0);
    win.__trinketStop.allowWaits();
    let resumed = false;
    win.rate(60).then(() => { resumed = true; });
    expect(runtime.calls).toHaveLength(0);
    expect(stoppedCount(win)).toBe(1);
    await tick();
    expect(resumed).toBe(false);
  });

  it('never exempts a wait through a window opened before the stop was confirmed, even once it is', () => {
    const runtime = controlledRate();
    const timers = [];
    const win = fakeWindow({ rate: runtime.rate, setTimeout: (fn, ms) => { timers.push(ms); } });
    install(win);
    win.send('glowscript.stop');
    const early = win.__trinketStop.allowWaits();
    win.rate(60);
    expect(stoppedCount(win)).toBe(1);
    // The stop is confirmed now, and that window was never released.
    win.rate(30);
    expect(runtime.calls).toHaveLength(0);
    expect(timers).toEqual([]);
    // Its release() does nothing, so a window opened now still works.
    early();
    win.__trinketStop.allowWaits();
    win.rate(60);
    expect(runtime.calls).toHaveLength(1);
  });
});

describe('messages', () => {
  it('ignores anything but the stop request', () => {
    const win = fakeWindow({ rate: () => deferred().promise });
    install(win);
    win.rate(30);
    win.send('glowscript.snapshot');
    win.send(JSON.stringify({ 'glowscript.stop': true }));
    expect(stoppedCount(win)).toBe(0);
  });

  // The page is the runner's parent in both sandbox modes. Any other window that
  // can reach the runner (a sibling frame, a popup) must not be able to stop it.
  it('ignores a stop that does not come from the runner\'s parent', () => {
    const win = fakeWindow({ rate: () => deferred().promise });
    install(win);
    // A wait in flight: a stop that counted would confirm at once.
    win.rate(30);
    win.send('glowscript.stop', { postMessage: () => {} });
    win.send('glowscript.stop', win);
    win.send('glowscript.stop', null);
    expect(win.__trinketStop.requested).toBe(false);
    expect(win.posted).toEqual([{ 'glowscript.ready': true }]);

    win.send('glowscript.stop');
    expect(win.__trinketStop.requested).toBe(true);
    expect(stoppedCount(win)).toBe(1);
  });
});

describe('source', () => {
  it('is a self-contained statement that installs the shim on `window`', () => {
    const win = fakeWindow({ rate: () => Promise.resolve() });
    new Function('window', source())(win);
    expect(win.posted).toEqual([{ 'glowscript.ready': true }]);
    expect(win.rate.__trinketStoppable).toBe(true);
  });
});
