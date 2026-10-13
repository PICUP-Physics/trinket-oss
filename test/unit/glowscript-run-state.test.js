'use strict';

// Page-side decisions for the GlowScript Stop button: every row of the spec's
// transition table, driven with an injected clock and timer queue.
// Spec: docs/superpowers/specs/2026-10-09-glowscript-stop-button-design.md

const { create, STOP_TIMEOUT_MS, STOP_GRACE_MS } = require('../../public/js/embed/glowscript-run-state');

function harness(overrides) {
  const effects = { states: [], requestStop: 0, teardown: 0 };
  const timers = new Map();
  let nextTimer = 1;
  let clock = 0;
  const ctl = create(Object.assign({
    onState: (s) => effects.states.push(s),
    requestStop: () => { effects.requestStop += 1; },
    teardown: () => { effects.teardown += 1; },
    setTimer: (fn, ms) => { const id = nextTimer++; timers.set(id, { fn, ms }); return id; },
    clearTimer: (id) => { timers.delete(id); },
    now: () => clock,
  }, overrides));
  return {
    ctl, effects, timers,
    advance: (ms) => { clock += ms; },
    fireTimers: () => { const due = [...timers.values()]; timers.clear(); due.forEach((t) => t.fn()); },
  };
}

// A run past the double-click guard whose runner has reported in.
function readyRun() {
  const h = harness();
  h.ctl.launched();
  h.ctl.ready();
  h.advance(STOP_GRACE_MS);
  return h;
}

describe('a run', () => {
  it('starts idle at generation 0', () => {
    const { ctl } = harness();
    expect(ctl.state()).toBe('idle');
    expect(ctl.generation()).toBe(0);
  });

  it('turns the button into Stop when launched, with a new generation', () => {
    const h = harness();
    h.ctl.launched();
    expect(h.ctl.state()).toBe('running');
    expect(h.effects.states).toEqual(['running']);
    expect(h.ctl.generation()).toBe(1);
  });

  it('a relaunch while running keeps Stop without redrawing it, and takes a new generation', () => {
    const h = harness();
    h.ctl.launched();
    h.ctl.launched();
    expect(h.effects.states).toEqual(['running']);
    expect(h.ctl.generation()).toBe(2);
  });

  it('returns to Run when the program finishes or fails', () => {
    const h = readyRun();
    h.ctl.finished();
    expect(h.ctl.state()).toBe('idle');
    expect(h.effects.states).toEqual(['running', 'idle']);
  });

  it('returns to Run when the runtime cannot be loaded', () => {
    const h = harness();
    h.ctl.launched();
    h.ctl.loadFailed();
    expect(h.ctl.state()).toBe('idle');
  });

  it('ignores end-of-run events while idle', () => {
    const h = harness();
    h.ctl.finished();
    h.ctl.stopped();
    h.ctl.loadFailed();
    h.ctl.ready();
    expect(h.effects.states).toEqual([]);
  });
});

describe('stop', () => {
  it('asks the runner to park and waits up to the stop window', () => {
    const h = readyRun();
    h.ctl.stop();
    expect(h.ctl.state()).toBe('stopping');
    expect(h.effects.requestStop).toBe(1);
    expect([...h.timers.values()].map((t) => t.ms)).toEqual([STOP_TIMEOUT_MS]);
  });

  it('a confirmation returns to Run and leaves the frozen runner in place', () => {
    const h = readyRun();
    h.ctl.stop();
    h.ctl.stopped();
    expect(h.ctl.state()).toBe('idle');
    expect(h.effects.states).toEqual(['running', 'stopping', 'idle']);
    expect(h.effects.teardown).toBe(0);
    expect(h.timers.size).toBe(0);
  });

  it('no confirmation within the window tears the runner down', () => {
    const h = readyRun();
    const before = h.ctl.generation();
    h.ctl.stop();
    h.fireTimers();
    expect(h.effects.teardown).toBe(1);
    expect(h.ctl.state()).toBe('idle');
    expect(h.effects.states).toEqual(['running', 'stopping', 'idle']);
    expect(h.ctl.generation()).toBe(before + 1);
  });

  it('a program that finishes or fails while stopping just returns to Run', () => {
    const h = readyRun();
    h.ctl.stop();
    h.ctl.finished();
    expect(h.ctl.state()).toBe('idle');
    expect(h.effects.teardown).toBe(0);
    expect(h.timers.size).toBe(0);
  });

  it('a load failure while stopping returns to Run and cancels the window', () => {
    const h = readyRun();
    h.ctl.stop();
    h.ctl.loadFailed();
    expect(h.ctl.state()).toBe('idle');
    expect(h.timers.size).toBe(0);
  });

  it('before the runner is ready, tears down at once with a new generation', () => {
    const h = harness();
    h.ctl.launched();
    h.advance(STOP_GRACE_MS);
    h.ctl.stop();
    expect(h.effects.teardown).toBe(1);
    expect(h.effects.requestStop).toBe(0);
    expect(h.ctl.state()).toBe('idle');
    expect(h.ctl.generation()).toBe(2);
  });

  it('the second click of a double-click on Run does not stop the new program', () => {
    const h = harness();
    h.ctl.launched();
    h.ctl.ready();
    h.advance(STOP_GRACE_MS - 1);
    h.ctl.stop();
    expect(h.ctl.state()).toBe('running');
    expect(h.effects.requestStop).toBe(0);
    expect(h.effects.teardown).toBe(0);
  });

  it('the second click of a double-click lands before the runner reports in and still does not stop it', () => {
    const h = harness();
    h.ctl.launched();
    h.advance(STOP_GRACE_MS - 1);
    h.ctl.stop();
    expect(h.ctl.state()).toBe('running');
    expect(h.effects.teardown).toBe(0);
    expect(h.effects.requestStop).toBe(0);
  });

  it('is ignored while stopping and while idle', () => {
    const h = readyRun();
    h.ctl.stop();
    h.ctl.stop();
    expect(h.effects.requestStop).toBe(1);
    h.ctl.stopped();
    h.ctl.stop();
    expect(h.effects.requestStop).toBe(1);
    expect(h.ctl.state()).toBe('idle');
  });

  it('Run pressed while stopping starts the new run and cancels the old teardown', () => {
    const h = readyRun();
    h.ctl.stop();
    h.ctl.launched();
    expect(h.ctl.state()).toBe('running');
    expect(h.timers.size).toBe(0);
    h.fireTimers();
    expect(h.effects.teardown).toBe(0);
    // The new runner has not reported in, so a Stop past the guard tears down.
    h.advance(STOP_GRACE_MS);
    h.ctl.stop();
    expect(h.effects.teardown).toBe(1);
  });
});

describe('receive', () => {
  it("routes the current runner's messages", () => {
    const h = harness();
    h.ctl.launched();
    h.ctl.receive({ 'glowscript.ready': true }, true);
    h.advance(STOP_GRACE_MS);
    h.ctl.stop();
    expect(h.effects.requestStop).toBe(1);
    h.ctl.receive({ 'glowscript.stopped': true }, true);
    expect(h.ctl.state()).toBe('idle');
  });

  it('treats done and error alike as the end of the run', () => {
    for (const data of [{ 'glowscript.done': true }, { 'glowscript.error': 'boom', type: 'runtime' }]) {
      const h = readyRun();
      h.ctl.receive(data, true);
      expect(h.ctl.state()).toBe('idle');
    }
  });

  it('ends the run on any runner error, even one with an empty or missing message', () => {
    for (const data of [{ 'glowscript.error': '', type: 'runtime' }, { type: 'runtime' }, { type: 'compile' }]) {
      const h = readyRun();
      h.ctl.receive(data, true);
      expect(h.ctl.state()).toBe('idle');
    }
  });

  it('ends the run on an error report with no type and a falsy message: the key alone counts', () => {
    for (const data of [{ 'glowscript.error': '' }, { 'glowscript.error': null }, { 'glowscript.error': 0 }, { 'glowscript.error': false }]) {
      const h = readyRun();
      h.ctl.receive(data, true);
      expect(h.ctl.state()).toBe('idle');
    }
  });

  it('ignores a JSON primitive a program posts, instead of throwing', () => {
    const h = readyRun();
    for (const data of ['boom', 42, true]) {
      expect(() => h.ctl.receive(data, true)).not.toThrow();
    }
    expect(h.ctl.state()).toBe('running');
  });

  it('ignores messages from any other runner, and non-runner messages', () => {
    const h = readyRun();
    h.ctl.receive({ 'glowscript.done': true }, false);
    h.ctl.receive(undefined, true);
    h.ctl.receive({ snapshot: 'data:' }, true);
    expect(h.ctl.state()).toBe('running');
  });
});

describe('background errors', () => {
  // The runner's window.onerror report of an error raised outside the program's
  // main flow (an event handler, a timer) while that flow runs, GlowScript 2.9+.
  const BACKGROUND = {
    'glowscript.error': 'SRCDOC ERROR: Uncaught ReferenceError: boom is not defined at about:srcdoc:1',
    type: 'runtime',
    'glowscript.background': true,
  };

  it('leave the program running, and Stop still stops it', () => {
    const h = readyRun();
    h.ctl.receive(BACKGROUND, true);
    expect(h.ctl.state()).toBe('running');
    h.ctl.stop();
    expect(h.ctl.state()).toBe('stopping');
    expect(h.effects.requestStop).toBe(1);
    h.ctl.receive({ 'glowscript.stopped': true }, true);
    expect(h.ctl.state()).toBe('idle');
  });

  it('an error without the background tag still ends the run', () => {
    for (const data of [
      { 'glowscript.error': BACKGROUND['glowscript.error'], type: 'runtime' },
      Object.assign({}, BACKGROUND, { 'glowscript.background': false }),
    ]) {
      const h = readyRun();
      h.ctl.receive(data, true);
      expect(h.ctl.state()).toBe('idle');
    }
  });
});

describe('defaults', () => {
  it('uses a 2 s stop window and a 500 ms double-click guard', () => {
    expect(STOP_TIMEOUT_MS).toBe(2000);
    expect(STOP_GRACE_MS).toBe(500);
  });
});

describe('a failing effect', () => {
  it('a throwing requestStop still leaves the stop window armed, so the runner is torn down', () => {
    const h = harness({ requestStop: () => { throw new Error('no runner'); } });
    h.ctl.launched();
    h.ctl.ready();
    h.advance(STOP_GRACE_MS);
    expect(() => h.ctl.stop()).toThrow('no runner');
    expect(h.ctl.state()).toBe('stopping');
    expect(h.timers.size).toBe(1);
    h.fireTimers();
    expect(h.effects.teardown).toBe(1);
    expect(h.ctl.state()).toBe('idle');
  });

  it("a throwing onState('stopping') still leaves the stop window armed, so the runner is torn down", () => {
    const h = harness({ onState: (s) => { if (s === 'stopping') { throw new Error('view broke'); } } });
    h.ctl.launched();
    h.ctl.ready();
    h.advance(STOP_GRACE_MS);
    expect(() => h.ctl.stop()).toThrow('view broke');
    expect([...h.timers.values()].map((t) => t.ms)).toEqual([STOP_TIMEOUT_MS]);
    h.fireTimers();
    expect(h.effects.teardown).toBe(1);
    expect(h.ctl.state()).toBe('idle');
  });

  it('a throwing teardown still returns the control to Run', () => {
    const h = harness({ teardown: () => { throw new Error('dom gone'); } });
    h.ctl.launched();
    h.ctl.ready();
    h.advance(STOP_GRACE_MS);
    h.ctl.stop();
    expect(() => h.fireTimers()).toThrow('dom gone');
    expect(h.ctl.state()).toBe('idle');
  });
});
