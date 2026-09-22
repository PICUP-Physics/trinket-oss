'use strict';
// #108: the client's lifecycle logic — correlation ids, stop, and the promise
// contract. A fake Worker constructor is injected so this stays a node test;
// real execution is covered by the browser spec.
const { createWorkerClient } = require('../../public/js/embed/worker-client.js');

function fakeWorkerFactory() {
  const made = [];
  function FakeWorker() {
    this.posted = [];
    this.terminated = false;
    this.postMessage = (m) => { this.posted.push(m); };
    this.terminate = () => { this.terminated = true; };
    made.push(this);
  }
  return { FakeWorker, made };
}

const tick = () => new Promise(r => setTimeout(r, 0));

// The worker answers `run` with "Python is not ready yet" until Pyodide has
// booted, so the client holds runs until `ready`. Tests that exercise runs must
// therefore boot the fake worker first — that is the real sequence.
async function bootedClient(extra) {
  const h = newClient(extra);
  h.made[0].onmessage({ data: { type: 'ready', v: 1 } });
  await tick();
  return h;
}

function newClient(extra) {
  const { FakeWorker, made } = fakeWorkerFactory();
  const events = { stdout: [], stderr: [], errors: [], figures: [], rich: [] };
  const client = createWorkerClient(Object.assign({
    workerUrl: '/js/embed/pyodide-worker.js',
    pyodideUrl: 'https://cdn/pyodide.js',
    WorkerCtor: FakeWorker,
    onStdout: (t) => events.stdout.push(t),
    onStderr: (t) => events.stderr.push(t),
    onError:  (t) => events.errors.push(t),
    onFigure: (m) => events.figures.push(m),
    onRich:   (j) => events.rich.push(j)
  }, extra || {}));
  return { client, made, events };
}

describe('createWorkerClient', () => {
  it('sends init on construction', () => {
    const { made } = newClient();
    expect(made[0].posted[0].type).toBe('init');
  });

  it('is not running before a run starts', () => {
    const { client } = newClient();
    expect(client.isRunning()).toBe(false);
  });

  it('posts a run message with a correlation id, and reports running', async () => {
    const { client, made } = await bootedClient();
    client.run('print(1)');
    await tick();
    const runMsg = made[0].posted.find(m => m.type === 'run');
    expect(runMsg.source).toBe('print(1)');
    expect(typeof runMsg.id).toBe('string');
    expect(client.isRunning()).toBe(true);
  });

  it('forwards stdout to the callback', async () => {
    const { client, made, events } = await bootedClient();
    client.run('print(1)');
    await tick();
    made[0].onmessage({ data: { type: 'stdout', text: 'hello\n' } });
    expect(events.stdout).toEqual(['hello\n']);
  });

  it('resolves the run promise on done', async () => {
    const { client, made } = await bootedClient();
    const p = client.run('print(1)');
    await tick();
    const id = made[0].posted.find(m => m.type === 'run').id;
    made[0].onmessage({ data: { type: 'done', id } });
    await expect(p).resolves.toBeUndefined();
    expect(client.isRunning()).toBe(false);
  });

  it('reports an error and still settles the run', async () => {
    const { client, made, events } = await bootedClient();
    const p = client.run('boom');
    await tick();
    const id = made[0].posted.find(m => m.type === 'run').id;
    made[0].onmessage({ data: { type: 'error', id, traceback: 'ValueError: x' } });
    await p;
    expect(events.errors).toEqual(['ValueError: x']);
    expect(client.isRunning()).toBe(false);
  });

  it('ignores replies whose id does not match the current run (a stale worker)', async () => {
    const { client, made, events } = await bootedClient();
    client.run('print(1)');
    await tick();
    made[0].onmessage({ data: { type: 'error', id: 'not-the-current-id', traceback: 'stale' } });
    expect(events.errors).toEqual([]);
    expect(client.isRunning()).toBe(true);
  });

  it('stop() terminates the worker and settles the in-flight run', async () => {
    const { client, made } = await bootedClient();
    const p = client.run('while True: pass');
    await tick();
    client.stop();
    expect(made[0].terminated).toBe(true);
    await expect(p).resolves.toBeUndefined();
    expect(client.isRunning()).toBe(false);
  });

  it('spawns a replacement worker after stop, so the next run works', async () => {
    const { client, made } = await bootedClient();
    client.run('while True: pass');
    await tick();
    client.stop();
    client.run('print(2)');
    await tick();
    expect(made.length).toBe(2);
    expect(made[1].posted[0].type).toBe('init');
  });

  it('stop() with nothing running is harmless', () => {
    const { client } = newClient();
    expect(() => client.stop()).not.toThrow();
  });

  // discardWorker() is the VPython re-run contract (Task 11): the page throws the
  // interpreter away between runs so the Python namespace, the vpython scene and
  // the page's object registry reset together. It is stop()'s mechanism used with
  // a different intent, and what a caller depends on is that the NEXT run gets a
  // brand new interpreter — not a recycled one carrying `scene = canvas()` from
  // the run before.
  it('discardWorker() terminates the worker and the next run boots a fresh one', async () => {
    const { client, made } = await bootedClient();
    client.run('from vpython import *');
    await tick();
    made[0].onmessage({ data: { type: 'done', id: made[0].posted.find(m => m.type === 'run').id } });
    await tick();

    client.discardWorker();
    expect(made[0].terminated).toBe(true);

    client.run('from vpython import *');
    await tick();
    expect(made.length).toBe(2);
    expect(made[1].posted[0].type).toBe('init');       // a cold boot, not a reuse
    made[1].onmessage({ data: { type: 'ready', v: 1 } });
    await tick();
    expect(made[1].posted.find(m => m.type === 'run')).toBeTruthy();
  });

  it('discardWorker() with nothing running is harmless', () => {
    const { client } = newClient();
    expect(() => client.discardWorker()).not.toThrow();
  });

  it('discardWorker() reports whether there WAS an interpreter to discard', async () => {
    // The page uses this to decide whether to tell a student their console
    // session just went with it. Saying so when nothing was lost is as wrong as
    // staying silent when something was.
    const { client } = await bootedClient();
    expect(client.discardWorker(), 'a live worker was discarded').toBe(true);
    expect(client.discardWorker(), 'there was nothing left to discard').toBe(false);
  });

  it('does NOT post a run before the worker reports ready', async () => {
    // Booting Pyodide takes seconds; a run posted first is answered
    // "Python is not ready yet". Found by the browser spec, not by unit tests.
    const { client, made } = newClient();
    client.run('print(1)');
    await tick();
    expect(made[0].posted.find(m => m.type === 'run')).toBeUndefined();

    made[0].onmessage({ data: { type: 'ready', v: 1 } });
    await tick();
    expect(made[0].posted.find(m => m.type === 'run')).toBeTruthy();
  });

  it('surfaces a boot failure, which carries no run id', async () => {
    // The worker posts {type:'error', id:null} if Pyodide fails to load. The
    // id check would drop it and the page would wait forever on `ready`.
    const { client, made, events } = newClient();
    const p = client.run('print(1)');
    made[0].onmessage({ data: { type: 'error', id: null, traceback: 'Failed to start Python: boom' } });
    await expect(p).resolves.toBeUndefined();
    expect(events.errors).toEqual(['Failed to start Python: boom']);
    expect(client.isRunning()).toBe(false);
  });

  it('a reply from a REPLACED worker cannot settle the new run', async () => {
    // The dangerous case: stop() then run() again, and the dead worker's last
    // message arrives late. Ids are unique per run, so it must be ignored.
    const { client, made } = await bootedClient();
    client.run('first');
    await tick();
    const firstId = made[0].posted.find(m => m.type === 'run').id;
    client.stop();
    client.run('second');
    await tick();

    made[0].onmessage({ data: { type: 'done', id: firstId } });
    expect(client.isRunning()).toBe(true);
  });
});

describe('figure frames are scoped to the WORKER, not to the run', () => {
  // The property this replaced: frames used to be dropped unless they matched
  // the in-flight run, and settle() nulls that when the program ends. But a
  // matplotlib figure OUTLIVES its run -- pan, zoom, home and resize all act on
  // a finished plot, Python answers with a frame, and the page threw it away.
  //
  // `e.target` is what carries the distinction, so every call below passes one.
  // A real Worker sets it; the fake one did not, which is precisely why the old
  // source-text assertions could not have caught a regression here.

  const frame = (w, extra) => Object.assign(
    { data: { type: 'figure', kind: 'frame', id: 'run-1', figureId: 'fig1' } }, { target: w }, extra || {});

  it('forwards a frame from the LIVE worker after its program has ended', async () => {
    const { client, made, events } = await bootedClient();
    client.run('plot');
    await tick();
    const id = made[0].posted.find(m => m.type === 'run').id;
    made[0].onmessage({ data: { type: 'done', id: id }, target: made[0] });
    await tick();
    expect(client.isRunning()).toBe(false);   // settle() has nulled the run

    made[0].onmessage(frame(made[0]));
    expect(events.figures.length).toBe(1);    // dropped before this change
  });

  it('drops a frame from a REPLACED worker, which is the property worth keeping', async () => {
    // The reason scoping exists at all: a dead worker must not paint over the
    // new run's output. Losing this would be a real regression, not a nit.
    const { client, made, events } = await bootedClient();
    client.run('first');
    await tick();
    client.stop();
    client.run('second');
    await tick();
    expect(made.length).toBeGreaterThan(1);

    made[0].onmessage(frame(made[0]));        // the dead one
    expect(events.figures.length).toBe(0);

    made[1].onmessage(frame(made[1]));        // the live one
    expect(events.figures.length).toBe(1);
  });

  it('no longer matches on the run id, which is what made a finished figure inert', async () => {
    const { client, made, events } = await bootedClient();
    client.run('plot');
    await tick();
    made[0].onmessage(frame(made[0], { data: { type: 'figure', kind: 'frame', id: 'a-stale-run-id' } }));
    expect(events.figures.length).toBe(1);
  });

  it('needs no save exemption any more -- worker scoping subsumes it', async () => {
    // #252 fixed the save button with a `kind === 'save'` special case. That
    // was the narrow version of this fix: a save reply is late for exactly the
    // same reason an interactive frame is late. The exemption is deleted, so
    // this test is what keeps the button working.
    const { client, made, events } = await bootedClient();
    client.run('plot');
    await tick();
    const id = made[0].posted.find(m => m.type === 'run').id;
    made[0].onmessage({ data: { type: 'done', id: id }, target: made[0] });
    await tick();

    made[0].onmessage({ data: { type: 'figure', kind: 'save', b64: 'x' }, target: made[0] });
    expect(events.figures.length).toBe(1);
    expect(events.figures[0].kind).toBe('save');
  });

  it('drops a save reply from a replaced worker too', async () => {
    const { client, made, events } = await bootedClient();
    client.run('first');
    await tick();
    client.stop();
    client.run('second');
    await tick();
    made[0].onmessage({ data: { type: 'figure', kind: 'save', b64: 'x' }, target: made[0] });
    expect(events.figures.length).toBe(0);
  });
});

describe('worker VPython run extras', () => {
  // The kernel installs the vpython wheel only for runs that ask for it, and
  // tags scene-ops with the generation it was told. Both ride on the run
  // message, so the client has to forward them — python3 runs must stay clean.
  it('forwards vpython/wheelUrl/sceneGeneration onto the run message', async () => {
    const { client, made } = await bootedClient();
    client.run('from vpython import *', null, {
      vpython: true,
      wheelUrl: '/components/vpython-worker/vpython-7.6.5-py3-none-any.whl',
      sceneGeneration: 3
    });
    await tick();
    const runMsg = made[0].posted.find(m => m.type === 'run');
    expect(runMsg.vpython).toBe(true);
    expect(runMsg.wheelUrl).toBe('/components/vpython-worker/vpython-7.6.5-py3-none-any.whl');
    expect(runMsg.sceneGeneration).toBe(3);
  });

  it('omits the vpython extras entirely on an ordinary run', async () => {
    const { client, made } = await bootedClient();
    client.run('print(1)', null, { graphicWidth: 400 });
    await tick();
    const runMsg = made[0].posted.find(m => m.type === 'run');
    expect('vpython' in runMsg).toBe(false);
    expect('wheelUrl' in runMsg).toBe(false);
    expect('sceneGeneration' in runMsg).toBe(false);
    expect(runMsg.graphicWidth).toBe(400);   // existing options still work
  });

  it('omits them when vpython is present but false (the router said main/python3)', async () => {
    const { client, made } = await bootedClient();
    client.run('print(1)', null, { vpython: false, wheelUrl: '/w.whl' });
    await tick();
    const runMsg = made[0].posted.find(m => m.type === 'run');
    expect('vpython' in runMsg).toBe(false);
    expect('wheelUrl' in runMsg).toBe(false);
  });

  it('defaults sceneGeneration to 0 when the page does not pass one', async () => {
    const { client, made } = await bootedClient();
    client.run('from vpython import *', null, { vpython: true, wheelUrl: '/w.whl' });
    await tick();
    const runMsg = made[0].posted.find(m => m.type === 'run');
    expect(runMsg.sceneGeneration).toBe(0);
  });

  it('routes scene-ops to onSceneOps even after the run has settled', async () => {
    // A vpython scene outlives its run, so ops arrive with no `current`.
    const seen = [];
    const { client, made } = await bootedClient({ onSceneOps: (m) => seen.push(m) });
    const p = client.run('from vpython import *', null, { vpython: true, wheelUrl: '/w.whl' });
    await tick();
    const id = made[0].posted.find(m => m.type === 'run').id;
    made[0].onmessage({ data: { type: 'done', id } });
    await p;
    made[0].onmessage({ data: { type: 'scene-ops', id, generation: 1, ops: '{"cmds":[]}' } });
    expect(seen.length).toBe(1);
    expect(seen[0].generation).toBe(1);
  });
});

describe('input() over the channel', () => {
  it('asks the page for input and posts the reply back', async () => {
    const { FakeWorker, made } = fakeWorkerFactory();
    let asked = null;
    const client = createWorkerClient({
      workerUrl: '/w.js', pyodideUrl: '/p.js', WorkerCtor: FakeWorker,
      onInputRequest: (prompt) => { asked = prompt; return Promise.resolve('Ada'); }
    });
    made[0].onmessage({ data: { type: 'ready', v: 1 } });
    await tick();
    client.run('name = input("who? ")');
    await tick();
    const id = made[0].posted.find(m => m.type === 'run').id;

    made[0].onmessage({ data: { type: 'input-request', id, prompt: 'who? ' } });
    await tick();
    await tick();

    expect(asked).toBe('who? ');
    const reply = made[0].posted.find(m => m.type === 'stdin-reply');
    expect(reply).toEqual({ type: 'stdin-reply', id, value: 'Ada' });
  });

  it('does not answer an input request from a stale run', async () => {
    const { FakeWorker, made } = fakeWorkerFactory();
    const client = createWorkerClient({
      workerUrl: '/w.js', pyodideUrl: '/p.js', WorkerCtor: FakeWorker,
      onInputRequest: () => Promise.resolve('x')
    });
    made[0].onmessage({ data: { type: 'ready', v: 1 } });
    await tick();
    client.run('input()');
    await tick();

    made[0].onmessage({ data: { type: 'input-request', id: 'stale', prompt: '?' } });
    await tick();
    await tick();
    expect(made[0].posted.find(m => m.type === 'stdin-reply')).toBeUndefined();
  });

  it('answers with an empty string when the page has no input handler', async () => {
    // Better than hanging the program forever on a prompt nobody can answer.
    const { FakeWorker, made } = fakeWorkerFactory();
    const client = createWorkerClient({ workerUrl: '/w.js', pyodideUrl: '/p.js', WorkerCtor: FakeWorker });
    made[0].onmessage({ data: { type: 'ready', v: 1 } });
    await tick();
    client.run('input()');
    await tick();
    const id = made[0].posted.find(m => m.type === 'run').id;

    made[0].onmessage({ data: { type: 'input-request', id, prompt: '?' } });
    await tick();
    await tick();
    expect(made[0].posted.find(m => m.type === 'stdin-reply').value).toBe('');
  });
});

describe('variable snapshot over the channel', () => {
  it('requests a snapshot and resolves with the parsed array', async () => {
    const { FakeWorker, made } = fakeWorkerFactory();
    const client = createWorkerClient({ workerUrl: '/w.js', pyodideUrl: '/p.js', WorkerCtor: FakeWorker });
    made[0].onmessage({ data: { type: 'ready', v: 1 } });
    await tick();

    const p = client.snapshot();
    await tick();
    const req = made[0].posted.find(m => m.type === 'snapshot');
    expect(req).toBeTruthy();

    made[0].onmessage({ data: { type: 'snapshot-result', id: req.id, json: '[{"name":"x","value":"42"}]' } });
    await expect(p).resolves.toEqual([{ name: 'x', value: '42' }]);
  });

  it('resolves to an empty array when the worker reports a failure', async () => {
    const { FakeWorker, made } = fakeWorkerFactory();
    const client = createWorkerClient({ workerUrl: '/w.js', pyodideUrl: '/p.js', WorkerCtor: FakeWorker });
    made[0].onmessage({ data: { type: 'ready', v: 1 } });
    await tick();
    const p = client.snapshot();
    await tick();
    const req = made[0].posted.find(m => m.type === 'snapshot');
    made[0].onmessage({ data: { type: 'snapshot-result', id: req.id, json: null } });
    await expect(p).resolves.toEqual([]);
  });

  it('resolves to an empty array if the worker is gone (stopped)', async () => {
    // Terminating discards the namespace, so a snapshot request after a stop can
    // never be answered. It must not hang the caller.
    const { FakeWorker, made } = fakeWorkerFactory();
    const client = createWorkerClient({ workerUrl: '/w.js', pyodideUrl: '/p.js', WorkerCtor: FakeWorker });
    made[0].onmessage({ data: { type: 'ready', v: 1 } });
    await tick();
    client.stop();
    await expect(client.snapshot()).resolves.toEqual([]);
  });
});

// --- typeset math output (#288) ---------------------------------------------
// The worker's half of features.mathOutput. The page owns the asset URL and the
// renderer; the client's whole job is to carry the URL in and the payload back.
describe('createWorkerClient and the `rich` message', () => {
  it('carries the display helper URL on init, so the worker never decides the flag', () => {
    const { made } = newClient({ displayUrl: '/cache-prefix-1/js/embed/_trinket_display.py' });
    expect(made[0].posted[0].displayUrl).toBe('/cache-prefix-1/js/embed/_trinket_display.py');
  });

  it('sends an EMPTY displayUrl when the page does not supply one', () => {
    // features.mathOutput off. An empty string is what stops the worker
    // fetching anything at all, so this is the off switch, not a default.
    const { made } = newClient();
    expect(made[0].posted[0].displayUrl).toBe('');
  });

  // `rich` is scoped to the LIVE WORKER, exactly like `figure`, so every call
  // below passes `target` — a real Worker sets it and the scoping is the only
  // thing that reads it.

  it('forwards a rich payload to onRich as the RAW json string', async () => {
    // Raw, not parsed: the page hands it straight to window.__trinket_rich,
    // which is the same entry point the main thread's Python calls. Parsing
    // here would mean two parsers and two ways to fail.
    const { made, events } = await bootedClient();
    made[0].onmessage({ data: { type: 'rich', id: 'run-1', json: '{"kind":"math","latex":"x"}' },
                        target: made[0] });
    expect(events.rich).toEqual(['{"kind":"math","latex":"x"}']);
  });

  it('delivers a rich payload with NO run in flight — a card outlives its run', async () => {
    // NOT run-scoped. The page queues cards and program text in ONE buffer, so
    // program order survives only if both are delivered in the order the worker
    // posted them; a run-scoped check would drop a card the moment settle()
    // nulled `current`, which is the bug the figure path already had and fixed.
    const { client, made, events } = await bootedClient();
    client.run('x');
    await tick();
    made[0].onmessage({ data: { type: 'done', id: made[0].posted.find(m => m.type === 'run').id },
                        target: made[0] });
    await tick();
    expect(client.isRunning()).toBe(false);   // vacuity guard: the run really ended
    made[0].onmessage({ data: { type: 'rich', id: 'run-stale', json: '{"kind":"math"}' },
                        target: made[0] });
    expect(events.rich).toEqual(['{"kind":"math"}']);
  });

  it('DROPS a card from a worker that has already been replaced', async () => {
    // The symptom this exists to prevent, stated first: a card posted in the
    // instant before Stop must not appear in the NEXT run's console. Stop
    // terminates the worker and the client builds a new one, so the dead
    // worker's last message arrives with a stale `target`.
    const { client, made, events } = await bootedClient();
    client.run('first');
    await tick();
    client.stop();
    client.run('second');
    await tick();
    expect(made.length).toBe(2);              // vacuity guard: a NEW worker exists
    const dead = made[0];
    dead.onmessage({ data: { type: 'rich', id: 'run-1', json: '{"kind":"math","latex":"stale"}' },
                     target: dead });
    expect(events.rich).toEqual([]);
  });

  it('still delivers a card from the LIVE worker after a replacement', async () => {
    // The other direction: worker scoping must not become "drop everything
    // late". Without this, a test suite would pass with `rich` deleted outright.
    const { client, made, events } = await bootedClient();
    client.run('first');
    await tick();
    client.stop();
    client.run('second');
    await tick();
    const live = made[1];
    live.onmessage({ data: { type: 'ready', v: 1 } });
    await tick();
    live.onmessage({ data: { type: 'rich', id: 'run-2', json: '{"kind":"math","latex":"fresh"}' },
                     target: live });
    expect(events.rich).toEqual(['{"kind":"math","latex":"fresh"}']);
  });

  it('does not require an onRich callback (an older page simply ignores it)', async () => {
    const { FakeWorker, made } = fakeWorkerFactory();
    createWorkerClient({ workerUrl: '/w.js', pyodideUrl: '/p.js', WorkerCtor: FakeWorker });
    made[0].onmessage({ data: { type: 'ready', v: 1 } });
    await tick();
    // A real Worker DISPATCHES to onmessage, so a handler's exception is
    // reported to the global rather than rethrown. The fake calls onmessage
    // directly, so an exception lands HERE and fails the test -- which is the
    // assertion. Verified by mutation: dropping the `if (opts.onRich)` guard
    // fails this test with "opts.onRich is not a function", raised at the call
    // below. A process/window error listener would observe nothing, because
    // nothing on this path is ever async.
    expect(() =>
      made[0].onmessage({ data: { type: 'rich', json: '{}' }, target: made[0] })
    ).not.toThrow();
    await tick();
  });
});

// The plot-style panel's Save PNG asks this side whether the request was taken
// and tells the student "Saved" on the strength of the answer -- so a dropped
// frame has to be reported, not swallowed. Before this, sendMplEvent returned
// nothing whether or not a worker existed: click Stop, click Save, get "Saved"
// and no file.
describe('sendMplEvent reports whether the frame went anywhere', () => {
  // No "before the first worker exists" case: createWorkerClient constructs one
  // eagerly (measured -- `made.length` is 1 straight away), so the reachable
  // no-worker state is the one after a Stop, below.

  // A figure from the worker is what makes it the one frames go to.
  function showFigure(w) {
    w.onmessage({ data: { type: 'figure', kind: 'new', id: 'fig1' }, target: w });
  }

  it('returns true once the live worker has sent a figure, and actually posts', async () => {
    const h = await bootedClient();
    const w = h.made[0];
    showFigure(w);
    const before = w.posted.length;
    expect(h.client.sendMplEvent('fig1', '{"type":"save"}')).toBe(true);
    expect(w.posted.length).toBe(before + 1);
    expect(w.posted[w.posted.length - 1].type).toBe('mpl-event');
  });

  // The case that made this a bug rather than a nicety: after a Stop the
  // figure is still on the page and the panel is still mounted, so the student
  // can absolutely press Save -- and nothing throws to tell anyone.
  it('returns false after stop(), without throwing', async () => {
    const h = await bootedClient();
    const w = h.made[0];
    showFigure(w);
    const before = w.posted.length;
    h.client.stop();
    let threw = null;
    let result;
    try { result = h.client.sendMplEvent('fig1', '{"type":"save"}'); }
    catch (e) { threw = e; }
    expect(threw).toBeNull();
    expect(result).toBe(false);
    expect(w.posted.length).toBe(before);
  });
  it('returns false before the worker has sent any figure', async () => {
    const h = await bootedClient();
    expect(h.client.sendMplEvent('fig1', '{"type":"save"}')).toBe(false);
  });

  // Stop, then one console statement: the REPL boots a fresh worker while the
  // old figure is still on the page. That worker owns no figure manager and
  // would never answer, so a Save must not be reported as taken.
  it('returns false after a Stop replaced the worker via the console', async () => {
    const h = await bootedClient();
    showFigure(h.made[0]);
    h.client.stop();
    h.client.pushRepl('x = 1');
    expect(h.made.length).toBe(2);
    const w2 = h.made[1];
    const before = w2.posted.length;
    expect(h.client.sendMplEvent('fig1', '{"type":"save"}')).toBe(false);
    expect(w2.posted.length).toBe(before);
    // ...and once the new worker draws its own figure, frames go to it.
    showFigure(w2);
    expect(h.client.sendMplEvent('fig1', '{"type":"save"}')).toBe(true);
  });

  // A late figure from a replaced worker must not take the page's figures
  // away from the live one.
  it('ignores a late figure from a replaced worker', async () => {
    const h = await bootedClient();
    const old = h.made[0];
    h.client.stop();
    h.client.pushRepl('x = 1');
    showFigure(h.made[1]);
    showFigure(old);
    expect(h.client.sendMplEvent('fig1', '{"type":"save"}')).toBe(true);
  });
});
