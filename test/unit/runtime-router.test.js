'use strict';
// #108: chooseRuntime decides, per program, whether to run in the Web Worker or
// on the main thread. It is pure so the rules can be tested without a browser.
const { chooseRuntime, hasUnawaitableCall, runtimeNotice, commentOutVersionHeader } = require('../../public/js/embed/runtime-router.js');

const OPTS = { usesVPython: false, workerEnabled: true, queryRuntime: undefined };

describe('chooseRuntime', () => {
  it('sends an ordinary program to the worker', () => {
    const r = chooseRuntime('print("hi")', OPTS);
    expect(r.runtime).toBe('worker');
  });

  it('keeps VPython on the main thread', () => {
    const r = chooseRuntime('from vpython import *\nsphere()', { ...OPTS, usesVPython: true });
    expect(r.runtime).toBe('main');
    expect(r.reason).toMatch(/vpython/i);
  });

  it('keeps a program on the main thread when the worker is disabled', () => {
    const r = chooseRuntime('print("hi")', { ...OPTS, workerEnabled: false });
    expect(r.runtime).toBe('main');
    expect(r.reason).toMatch(/disabled/i);
  });

  it('honours ?runtime=main as an escape hatch', () => {
    const r = chooseRuntime('print("hi")', { ...OPTS, queryRuntime: 'main' });
    expect(r.runtime).toBe('main');
    expect(r.reason).toMatch(/query/i);
  });

  it('honours ?runtime=worker even when the config flag is off', () => {
    const r = chooseRuntime('print("hi")', { ...OPTS, workerEnabled: false, queryRuntime: 'worker' });
    expect(r.runtime).toBe('worker');
  });

  it('VPython beats ?runtime=worker — the bridge cannot run off-thread', () => {
    const r = chooseRuntime('sphere()', { ...OPTS, usesVPython: true, queryRuntime: 'worker' });
    expect(r.runtime).toBe('main');
  });

  it('always returns a reason string', () => {
    expect(typeof chooseRuntime('print(1)', OPTS).reason).toBe('string');
    expect(chooseRuntime('print(1)', OPTS).reason.length).toBeGreaterThan(0);
  });
});

describe('workerVPython (opt-in worker path for VPython)', () => {
  it('routes VPython to the worker when the flag is on', () => {
    const r = chooseRuntime('from vpython import *\nsphere()', { ...OPTS, usesVPython: true, workerVPython: true });
    expect(r.runtime).toBe('worker');
    expect(r.reason).toMatch(/vpython.*worker|workerVPython/i);
  });
  it('flag off → VPython stays on main (D2 unchanged)', () => {
    const r = chooseRuntime('sphere()', { ...OPTS, usesVPython: true, workerVPython: false });
    expect(r.runtime).toBe('main');
  });
  it('?runtime=main beats the flag (escape hatch)', () => {
    const r = chooseRuntime('sphere()', { ...OPTS, usesVPython: true, workerVPython: true, queryRuntime: 'main' });
    expect(r.runtime).toBe('main');
  });
  it('a stored runtime=main beats the flag too — #141 stored setting is an author decision', () => {
    const r = chooseRuntime('sphere()', { ...OPTS, usesVPython: true, workerVPython: true, storedRuntime: 'main' });
    expect(r.runtime).toBe('main');
  });
  it('?runtime=worker does NOT enable the vpython path by URL', () => {
    const r = chooseRuntime('sphere()', { ...OPTS, usesVPython: true, workerVPython: false, queryRuntime: 'worker' });
    expect(r.runtime).toBe('main');
  });
  it('marks the decision so the kernel can install the wheel', () => {
    const r = chooseRuntime('sphere()', { ...OPTS, usesVPython: true, workerVPython: true });
    expect(r.vpython).toBe(true);
  });
  // The two flags are independent: workerVPython is not "workerRuntime, plus
  // VPython". A deploy may run python3 on the main thread and still opt VPython
  // into the worker. This is the direction that matters — it fails if the rule
  // is ever moved BELOW the `workerEnabled` check.
  it('does not require workerRuntime — the vpython flag stands alone', () => {
    const r = chooseRuntime('sphere()', { ...OPTS, usesVPython: true, workerVPython: true, workerEnabled: false });
    expect(r.runtime).toBe('worker');
    expect(r.vpython).toBe(true);
  });
  it('a non-vpython program is not marked', () => {
    expect(chooseRuntime('print(1)', OPTS).vpython).toBeFalsy();
  });

  // The lambda/comprehension guard applies HERE TOO, and the consequence of
  // skipping it is worse than on the python3 path. In a vpython worker run
  // `rate`/`sleep` are coroutine factories, so a call the transform could not
  // put `await` in front of constructs a coroutine and throws it away: no
  // flush, no pacing, no yield — a hot spin drawing nothing. The same program
  // on the main thread works, because there `rate` is synchronous. So the flag
  // must not take it off the main thread.
  const COMPREHENSION_VPYTHON =
    'from vpython import *\nballs = [sphere(pos=vec(i,0,0)) for i in range(3)]\n' +
    'while True:\n    [rate(30) for b in balls]\n';
  const LAMBDA_VPYTHON =
    'from vpython import *\nb = sphere()\nstep = lambda: rate(30)\n' +
    'while True:\n    step()\n';

  it('a comprehension calling rate() stays on main even with the flag on', () => {
    const r = chooseRuntime(COMPREHENSION_VPYTHON, { ...OPTS, usesVPython: true, workerVPython: true });
    expect(r.runtime).toBe('main');
    expect(r.vpython).toBeFalsy();
  });
  it('a lambda calling rate() stays on main even with the flag on', () => {
    const r = chooseRuntime(LAMBDA_VPYTHON, { ...OPTS, usesVPython: true, workerVPython: true });
    expect(r.runtime).toBe('main');
    expect(r.vpython).toBeFalsy();
  });
  it('the guard is about the CALL SITE, not the word: rate() in a loop still routes', () => {
    const r = chooseRuntime('from vpython import *\nb = sphere()\nwhile True:\n    rate(30)\n',
                            { ...OPTS, usesVPython: true, workerVPython: true });
    expect(r.runtime).toBe('worker');
    expect(r.vpython).toBe(true);
  });
});

describe('hasUnawaitableCall', () => {
  it('flags input() inside a list comprehension', () => {
    expect(hasUnawaitableCall('xs = [input() for _ in range(3)]')).toBe(true);
  });

  it('flags input() inside a lambda', () => {
    expect(hasUnawaitableCall('f = lambda: input()')).toBe(true);
  });

  it('flags sleep() inside a comprehension', () => {
    expect(hasUnawaitableCall('[sleep(1) for _ in range(3)]')).toBe(true);
  });

  it('does NOT flag an ordinary input() call', () => {
    expect(hasUnawaitableCall('name = input("who? ")')).toBe(false);
  });

  it('does NOT flag input() inside a def (the transform handles that)', () => {
    expect(hasUnawaitableCall('def ask():\n    return input()')).toBe(false);
  });

  it('does NOT flag the word input in a string or comment', () => {
    expect(hasUnawaitableCall('print("[input() for x in y]")')).toBe(false);
    expect(hasUnawaitableCall('# [input() for x in y]')).toBe(false);
  });

  it('routes an unawaitable program to the main thread', () => {
    const r = chooseRuntime('xs = [input() for _ in range(3)]', OPTS);
    expect(r.runtime).toBe('main');
    expect(r.reason).toMatch(/comprehension|lambda/i);
  });

  // --- deliberate conservatism, recorded so it is not "fixed" the wrong way ---
  // The scan asks whether one bracketed span holds BOTH a `for` and an awaitable
  // call. That over-matches when a call and an unrelated comprehension are
  // arguments to the same expression. The error is in the SAFE direction: the
  // program runs on the main thread, exactly as it does today, and merely loses
  // freeze protection. A false NEGATIVE would be the harmful one — it would send
  // a program to the worker where `await` cannot be inserted, and it would hang.
  it('over-matches a call beside an unrelated comprehension (safe direction)', () => {
    expect(hasUnawaitableCall('print(input(), [x for x in y])')).toBe(true);
    expect(chooseRuntime('print(input(), [x for x in y])', OPTS).runtime).toBe('main');
  });

  it('does not over-match across separate statements', () => {
    expect(hasUnawaitableCall('name = input()\nys = [x for x in y]')).toBe(false);
  });
});

// The console line that says which runtime a program got. Both paths print an
// identical "Loading Python (Pyodide)…", so without this a program routed AWAY
// from the worker it asked for was indistinguishable from one that got it.
describe('runtimeNotice', () => {
  // q must reach BOTH calls: the router routes on it, and the notice compares
  // against it. Passing it to only one fabricates an ignored request.
  const notice = (src, opts, q) =>
    runtimeNotice(chooseRuntime(src, { ...opts, queryRuntime: q }), q);

  it('says nothing for the ordinary main-thread run', () => {
    // A deploy with the flag off must not gain a new line on every single run.
    expect(notice('print(1)', { ...OPTS, workerEnabled: false })).toBe('');
  });

  it('announces the worker, and why it matters', () => {
    const out = notice('print(1)', OPTS);
    expect(out).toMatch(/off the main thread/);
    expect(out).toMatch(/Stop always works/);
  });

  it('THE CASE THAT PROMPTED IT: ?runtime=worker overridden by VPython', () => {
    const out = notice('import vpython as vp', { ...OPTS, usesVPython: true }, 'worker');
    expect(out).toMatch(/on the main thread/);
    expect(out).toMatch(/Web VPython draws on the page/);
    expect(out).toMatch(/\?runtime=worker could not be honoured/);
  });

  it('explains a program the transform cannot rewrite', () => {
    const out = notice('print([input() for _ in range(2)])', OPTS);
    expect(out).toMatch(/on the main thread/);
    expect(out).toMatch(/lambda or comprehension/);
  });

  it('stays quiet when ?runtime=main is honoured, since nothing was ignored', () => {
    expect(notice('print(1)', OPTS, 'main')).toBe('');
  });

  it('reports an ignored ?runtime=main', () => {
    // Not reachable through chooseRuntime today; asserted so the ignored-request
    // branch cannot rot if a future rule forces the worker.
    const out = runtimeNotice({ runtime: 'worker', reason: 'default' }, 'main');
    expect(out).toMatch(/\?runtime=main could not be honoured/);
  });

  it('tolerates a missing decision', () => {
    expect(runtimeNotice(null, 'worker')).toBe('');
  });

  it('ends with a newline whenever it speaks', () => {
    expect(notice('print(1)', OPTS).endsWith('\n')).toBe(true);
  });
});

// #128: a runtime stored on the trinket. Ordering matters more than any single
// rule here — see spec §3. The table below is the spec's worked-cases table.
describe('chooseRuntime with a stored trinket setting', () => {
  const LAMBDA = 'f = lambda: input()\nprint(f())';

  it('stored worker opts one trinket in on a flag-off deploy', () => {
    const r = chooseRuntime('print(1)', { ...OPTS, workerEnabled: false, storedRuntime: 'worker' });
    expect(r.runtime).toBe('worker');
    expect(r.reason).toMatch(/trinket setting/);
  });

  it('stored main opts one trinket out on a flag-on deploy', () => {
    const r = chooseRuntime('print(1)', { ...OPTS, workerEnabled: true, storedRuntime: 'main' });
    expect(r.runtime).toBe('main');
    expect(r.reason).toMatch(/trinket setting/);
  });

  it('the URL beats the stored value in both directions', () => {
    expect(chooseRuntime('print(1)', { ...OPTS, storedRuntime: 'worker', queryRuntime: 'main' }).runtime).toBe('main');
    expect(chooseRuntime('print(1)', { ...OPTS, workerEnabled: false, storedRuntime: 'main', queryRuntime: 'worker' }).runtime).toBe('worker');
  });

  it('VPython still beats a stored worker — the bridge cannot run off-thread', () => {
    const r = chooseRuntime('import vpython as vp', { ...OPTS, usesVPython: true, storedRuntime: 'worker' });
    expect(r.runtime).toBe('main');
    expect(r.reason).toMatch(/vpython/i);
  });

  it('THE D3 RULE: a stored worker does NOT override the unawaitable guard', () => {
    // A saved setting affects every student who opens the trinket, so it must
    // not be able to select a runtime that cannot run the program.
    const r = chooseRuntime(LAMBDA, { ...OPTS, storedRuntime: 'worker' });
    expect(r.runtime).toBe('main');
    expect(r.reason).toMatch(/lambda or comprehension/);
  });

  it('THE D3 RULE: a URL still may override the guard, for a false positive', () => {
    // The detector over-matches on purpose, so authors need this escape.
    expect(chooseRuntime(LAMBDA, { ...OPTS, queryRuntime: 'worker' }).runtime).toBe('worker');
  });

  it('an empty or unknown stored value is simply no preference', () => {
    expect(chooseRuntime('print(1)', { ...OPTS, workerEnabled: false, storedRuntime: '' }).runtime).toBe('main');
    expect(chooseRuntime('print(1)', { ...OPTS, workerEnabled: false, storedRuntime: 'nonsense' }).runtime).toBe('main');
  });

  it('VPython wins over a stored value and a query parameter asking for the worker, together', () => {
    // Neither a saved preference nor a deliberate URL override can put the
    // bridge off-thread; VPython must win even when both are pulling the
    // other way at once.
    const r = chooseRuntime('import vpython as vp', {
      ...OPTS, usesVPython: true, storedRuntime: 'worker', queryRuntime: 'worker'
    });
    expect(r.runtime).toBe('main');
    expect(r.reason).toMatch(/vpython/i);
  });

  // The guard (hasUnawaitableCall) must only preempt the flag when the worker
  // was actually on the table for this program — otherwise a deploy with the
  // worker off surfaces a worker-only limitation to students it cannot affect.
  // These two pin the asymmetry in both directions.
  it('a guard-tripping program on a flag-off deploy with no stored value stays silent — the flag is the honest reason, not the guard', () => {
    const r = chooseRuntime(LAMBDA, { ...OPTS, workerEnabled: false });
    expect(r.runtime).toBe('main');
    expect(r.reason).toMatch(/config/);
    expect(r.reason).not.toMatch(/lambda or comprehension/);
    expect(runtimeNotice(r, undefined)).toBe('');
  });

  it('a guard-tripping program with a stored worker on a flag-off deploy explains the guard — the author asked for the worker and is owed why they did not get it', () => {
    const r = chooseRuntime(LAMBDA, { ...OPTS, workerEnabled: false, storedRuntime: 'worker' });
    expect(r.runtime).toBe('main');
    expect(r.reason).toMatch(/lambda or comprehension/);
    expect(runtimeNotice(r, undefined)).not.toBe('');
  });

  // Same asymmetry, the OTHER direction: a stored 'main' must not borrow the
  // deploy flag to decide workerPossible. Before this test's fix, `stored ===
  // 'worker' || !!opts.workerEnabled` still evaluated true here (via the flag
  // half, since the flag is on), so the guard fired first and a program that
  // was never going to the worker got told about a worker-only limitation —
  // right runtime (main either way, via rule 4), wrong reason.
  it('a guard-tripping program with a stored main on a flag-on deploy gives the stored reason, not the guard\'s — nothing was ever going to the worker', () => {
    const r = chooseRuntime(LAMBDA, { ...OPTS, workerEnabled: true, storedRuntime: 'main' });
    expect(r.runtime).toBe('main');
    expect(r.reason).toBe('trinket setting: runtime=main');
    expect(r.reason).not.toMatch(/lambda or comprehension/);
  });
});

describe('runtimeNotice with a stored setting', () => {
  // A stored 'worker' already speaks via the pre-existing `runtime === 'worker'`
  // branch of worthSaying, so this case alone does not discriminate the new
  // `trinket setting:` clause — it only pins that the NOTES entry itself
  // renders the right words when that path is taken.
  it('renders the NOTES entry for a stored worker as "this trinket\'s setting"', () => {
    const d = chooseRuntime('print(1)', { ...OPTS, workerEnabled: false, storedRuntime: 'worker' });
    expect(runtimeNotice(d, undefined)).toMatch(/this trinket's setting/);
  });

  it('speaks for a stored main, which is otherwise an ordinary quiet main-thread run — this is what actually exercises the new worthSaying clause', () => {
    const d = chooseRuntime('print(1)', { ...OPTS, workerEnabled: true, storedRuntime: 'main' });
    expect(runtimeNotice(d, undefined)).toMatch(/this trinket's setting/);
  });
});

// #321: the classic first-line header ("Web VPython 3.2", "GlowScript 3.2
// VPython") is not Python. The main thread comments it out before running;
// a VPython program sent to the worker must get the same treatment.
describe('commentOutVersionHeader', () => {
  it('comments out a Web VPython header on line 1', () => {
    expect(commentOutVersionHeader('Web VPython 3.2\nsphere()\n'))
      .toBe('#Web VPython 3.2\nsphere()\n');
  });

  it('comments out a GlowScript header on line 1', () => {
    expect(commentOutVersionHeader('GlowScript 3.2 VPython\nbox()'))
      .toBe('#GlowScript 3.2 VPython\nbox()');
  });

  it('matches the header case-insensitively and after leading spaces, as runVpython does', () => {
    expect(commentOutVersionHeader('  web vpython 3.2\nx = 1')).toBe('#  web vpython 3.2\nx = 1');
  });

  it('keeps the line count, so tracebacks point at the right line', () => {
    const src = 'Web VPython 3.2\nfrom vpython import *\n\nsphere()\n';
    expect(commentOutVersionHeader(src).split('\n').length).toBe(src.split('\n').length);
  });

  it('leaves a header that is not on line 1 alone', () => {
    const src = '# a comment\nWeb VPython 3.2\nsphere()';
    expect(commentOutVersionHeader(src)).toBe(src);
  });

  it('leaves a program with no header unchanged', () => {
    const src = 'from vpython import *\nsphere()\n';
    expect(commentOutVersionHeader(src)).toBe(src);
  });

  it('leaves a name that merely starts with the word alone', () => {
    const src = 'GlowScriptish = 1\nprint(GlowScriptish)';
    expect(commentOutVersionHeader(src)).toBe(src);
  });

  it('treats an empty or missing program as empty', () => {
    expect(commentOutVersionHeader('')).toBe('');
    expect(commentOutVersionHeader(undefined)).toBe('');
  });
});
