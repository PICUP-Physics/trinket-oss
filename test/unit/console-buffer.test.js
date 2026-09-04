'use strict';
// #142: `help(numpy)` froze the page. The console received 70,605 separate
// writes (Pyodide's batched stdout flushes per newline), each one forcing a
// layout through jqconsole's _ScrollToEnd. This buffer is the accounting half
// of the fix — queue so the caller can write once per frame, and cap so a big
// enough program cannot build a DOM the browser gives up on.
const { createOutputBuffer } = require('../../public/js/embed/console-buffer.js');

describe('createOutputBuffer — coalescing', () => {
  it('joins many pushes into a single drained string', () => {
    const buf = createOutputBuffer();
    for (let i = 0; i < 100; i++) buf.pushStream('line ' + i + '\n');
    const out = buf.drainText();
    expect(out.split('\n')).toHaveLength(101);  // 100 lines + trailing ''
    expect(out.startsWith('line 0\n')).toBe(true);
    expect(out.endsWith('line 99\n')).toBe(true);
  });

  it('drain empties the queue, so a second flush writes nothing', () => {
    const buf = createOutputBuffer();
    buf.pushStream('x\n');
    expect(buf.hasPending()).toBe(true);
    expect(buf.drainText()).toBe('x\n');
    expect(buf.hasPending()).toBe(false);
    expect(buf.drainText()).toBe('');
  });

  it('preserves order between program output and system messages', () => {
    const buf = createOutputBuffer();
    buf.pushStream('output\n');
    buf.pushSystem('[stopped]\n');
    buf.pushStream('more\n');
    expect(buf.drainText()).toBe('output\n[stopped]\nmore\n');
  });
});

describe('createOutputBuffer — the cap', () => {
  it('passes everything through below the limit', () => {
    const buf = createOutputBuffer({ maxLines: 10 });
    buf.pushStream('a\nb\nc\n');
    expect(buf.isCapped()).toBe(false);
    expect(buf.drainText()).toBe('a\nb\nc\n');
  });

  it('accepts a chunk that lands exactly on the limit', () => {
    const buf = createOutputBuffer({ maxLines: 3 });
    buf.pushStream('a\nb\nc\n');
    expect(buf.isCapped()).toBe(false);
    expect(buf.drainText()).toBe('a\nb\nc\n');
  });

  it('keeps exactly maxLines and cuts on a line boundary, never mid-line', () => {
    const buf = createOutputBuffer({ maxLines: 3 });
    buf.pushStream('a\nb\nc\nd\ne\n');
    const out = buf.drainText();
    expect(out.startsWith('a\nb\nc\n')).toBe(true);
    // 'd' would be line 4: it must not appear even partially.
    expect(out).not.toMatch(/^d/m);
    expect(buf.isCapped()).toBe(true);
  });

  it('counts lines across separate pushes, not just within one', () => {
    const buf = createOutputBuffer({ maxLines: 3 });
    buf.pushStream('a\n');
    buf.pushStream('b\n');
    expect(buf.isCapped()).toBe(false);
    buf.pushStream('c\nd\n');
    expect(buf.isCapped()).toBe(true);
    expect(buf.drainText()).toMatch(/^a\nb\nc\n/);
  });

  it('explains itself once, and says the program is still running', () => {
    const buf = createOutputBuffer({ maxLines: 2 });
    buf.pushStream('a\nb\nc\n');
    const out = buf.drainText();
    expect(out).toMatch(/output stopped after 2 lines/);
    expect(out).toMatch(/still running/);
  });

  it('drops further program output once capped, and reports it', () => {
    const buf = createOutputBuffer({ maxLines: 2 });
    buf.pushStream('a\nb\nc\n');
    buf.drainText();
    expect(buf.pushStream('ignored\n')).toBe(false);
    expect(buf.drainText()).toBe('');
  });

  it('still delivers system messages after the cap is hit', () => {
    // The whole point of exempting these: a truncated run must still be able
    // to say '[stopped]' or report an error.
    const buf = createOutputBuffer({ maxLines: 1 });
    buf.pushStream('a\nb\n');
    buf.drainText();
    buf.pushSystem('\n[stopped]\n');
    expect(buf.drainText()).toBe('\n[stopped]\n');
  });

  it('handles the help(numpy) shape: one huge write, capped, page survives', () => {
    const buf = createOutputBuffer({ maxLines: 5000 });
    // pydoc's plain_pager hands the whole thing over in a single write.
    buf.pushStream('doc line\n'.repeat(70605));
    const out = buf.drainText();
    expect(buf.isCapped()).toBe(true);
    expect(buf.lineCount()).toBe(5000);
    expect(out.match(/doc line/g)).toHaveLength(5000);
  });
});

describe('createOutputBuffer — resets', () => {
  it('reset() discards queued text and clears the cap', () => {
    const buf = createOutputBuffer({ maxLines: 1 });
    buf.pushStream('a\nb\n');
    buf.reset();
    expect(buf.hasPending()).toBe(false);
    expect(buf.isCapped()).toBe(false);
    expect(buf.drainText()).toBe('');
  });

  it('resetCap() clears the cap but keeps queued text', () => {
    // Per REPL statement: a previous help(numpy) must not mute the session,
    // but output already queued still belongs on screen.
    const buf = createOutputBuffer({ maxLines: 1 });
    buf.pushStream('a\nb\n');
    buf.resetCap();
    expect(buf.isCapped()).toBe(false);
    expect(buf.hasPending()).toBe(true);
    buf.pushStream('after\n');
    expect(buf.drainText()).toMatch(/after\n$/);
  });
});

describe('createOutputBuffer — the rich budget', () => {
  // Rich output has its own, much smaller budget than text. The reasoning and
  // the measurements live in console-buffer.js beside the number itself; the
  // short version is that a typeset card costs far more than a printed line, so
  // sharing the 5,000-line budget would leave the page unresponsive long enough
  // that Stop cannot fire. Past the budget results DEGRADE to
  // plain text rather than being dropped, which is what makes a threshold this
  // low safe: nothing is ever lost.
  const card = (n) => ({ kind: 'math', latex: 'x^{' + n + '}', text: 'x**' + n, lineno: n });

  it('queues cards up to the rich budget', () => {
    const buf = createOutputBuffer({ maxRich: 3 });
    for (let i = 1; i <= 3; i++) expect(buf.pushRich(card(i))).toBe(true);
    expect(buf.richCount()).toBe(3);
    expect(buf.isDegraded()).toBe(false);
    expect(buf.drain().filter(s => s.rich)).toHaveLength(3);
  });

  it('degrades to plain text past the budget instead of dropping results', () => {
    const buf = createOutputBuffer({ maxRich: 2 });
    buf.pushRich(card(1));
    buf.pushRich(card(2));
    buf.pushRich(card(3));
    const out = buf.drain();
    expect(out.filter(s => s.rich)).toHaveLength(2);
    // The third result is still present, as text carrying str(expr).
    const text = out.filter(s => typeof s.text === 'string').map(s => s.text).join('');
    expect(text).toContain('x**3');
    expect(text).toMatch(/^\n\[Typesetting stopped after 2 expressions/);
  });

  it('explains itself exactly once', () => {
    const buf = createOutputBuffer({ maxRich: 1 });
    for (let i = 1; i <= 5; i++) buf.pushRich(card(i));
    const text = buf.drainText();
    expect(text.match(/Typesetting stopped/g)).toHaveLength(1);
    expect(buf.isDegraded()).toBe(true);
  });

  it('keeps every degraded result, in order, with its line number', () => {
    const buf = createOutputBuffer({ maxRich: 0 });
    for (let i = 1; i <= 4; i++) buf.pushRich(card(i));
    const text = buf.drainText();
    for (let i = 1; i <= 4; i++) expect(text).toContain(i + '  x**' + i);
    expect(text.indexOf('x**1')).toBeLessThan(text.indexOf('x**4'));
  });

  it('merges degraded results into the surrounding text, not separate segments', () => {
    // One write per run of text is the whole point of the module: a degraded
    // result must not cost a forced layout of its own.
    const buf = createOutputBuffer({ maxRich: 0 });
    buf.pushStream('before\n');
    buf.pushRich(card(1));
    buf.pushRich(card(2));
    buf.pushStream('after\n');
    const out = buf.drain();
    expect(out.filter(s => s.rich)).toHaveLength(0);
    expect(out).toHaveLength(1);
  });

  it('a degraded result with no text adds nothing but the notice', () => {
    const buf = createOutputBuffer({ maxRich: 0 });
    buf.pushRich({ kind: 'math', latex: 'x', text: '' });
    expect(buf.drainText()).toMatch(/^\n\[Typesetting stopped/);
  });

  it('still counts every result against the overall line cap', () => {
    const buf = createOutputBuffer({ maxLines: 3, maxRich: 1 });
    buf.pushRich(card(1));   // typeset
    buf.pushRich(card(2));   // degraded, still one line
    buf.pushRich(card(3));
    expect(buf.lineCount()).toBe(3);
    expect(buf.pushRich(card(4))).toBe(true);
    expect(buf.isCapped()).toBe(true);
  });

  it('reset() restores the rich budget and discards what was queued', () => {
    const buf = createOutputBuffer({ maxRich: 1 });
    buf.pushRich(card(1));
    buf.pushRich(card(2));
    expect(buf.isDegraded()).toBe(true);
    buf.reset();
    expect(buf.isDegraded()).toBe(false);
    expect(buf.richCount()).toBe(0);
    buf.pushRich(card(3));
    expect(buf.drain().filter(s => s.rich)).toHaveLength(1);
  });

  it('resetCap() restores the rich budget but keeps what was queued', () => {
    // resetCap is the per-REPL-statement reset: "one command" gets a fresh
    // budget without throwing away output already produced. So the card queued
    // before the reset is still there alongside the new one.
    const buf = createOutputBuffer({ maxRich: 1 });
    buf.pushRich(card(1));
    buf.pushRich(card(2));
    expect(buf.isDegraded()).toBe(true);
    buf.resetCap();
    expect(buf.isDegraded()).toBe(false);
    expect(buf.richCount()).toBe(0);
    buf.pushRich(card(3));
    expect(buf.drain().filter(s => s.rich)).toHaveLength(2);
  });

  it('defaults to 30', () => {
    const buf = createOutputBuffer();
    for (let i = 1; i <= 31; i++) buf.pushRich(card(i));
    expect(buf.richCount()).toBe(30);
    expect(buf.isDegraded()).toBe(true);
  });
});

describe('createOutputBuffer — rich segments', () => {
  it('drains a pushRich between two pushStream calls as three ordered segments', () => {
    const buf = createOutputBuffer();
    const card = { html: '<math/>' };
    buf.pushStream('before\n');
    buf.pushRich(card);
    buf.pushStream('after\n');
    const out = buf.drain();
    expect(out).toEqual([
      { text: 'before\n' },
      { rich: card },
      { text: 'after\n' }
    ]);
    // The rich segment must carry the very object pushed, not a copy — the
    // caller renders it directly.
    expect(out[1].rich).toBe(card);
  });

  it('merges adjacent text pushes on either side of a rich segment', () => {
    const buf = createOutputBuffer();
    const card = { html: '<math/>' };
    buf.pushStream('a\n');
    buf.pushStream('b\n');
    buf.pushRich(card);
    buf.pushStream('c\n');
    expect(buf.drain()).toEqual([
      { text: 'a\nb\n' },
      { rich: card },
      { text: 'c\n' }
    ]);
  });

  it('does not merge two consecutive rich segments', () => {
    const buf = createOutputBuffer();
    const first = { html: 'one' };
    const second = { html: 'two' };
    buf.pushRich(first);
    buf.pushRich(second);
    expect(buf.drain()).toEqual([
      { rich: first },
      { rich: second }
    ]);
  });

  it('counts one card as one line against the cap', () => {
    // A derivation loop displaying thousands of expressions builds exactly
    // the DOM the cap exists to prevent, so a card must cost the same as a
    // line of text.
    const buf = createOutputBuffer({ maxLines: 3 });
    expect(buf.pushRich({ n: 1 })).toBe(true);
    expect(buf.pushRich({ n: 2 })).toBe(true);
    expect(buf.pushRich({ n: 3 })).toBe(true);
    expect(buf.isCapped()).toBe(false);
    expect(buf.lineCount()).toBe(3);
    expect(buf.pushRich({ n: 4 })).toBe(true);  // this is the call that trips the cap
    expect(buf.isCapped()).toBe(true);
  });

  it('returns false and queues nothing once already capped', () => {
    const buf = createOutputBuffer({ maxLines: 1 });
    buf.pushRich({ n: 1 });
    expect(buf.isCapped()).toBe(false);
    buf.pushStream('x\n');  // trips the cap
    expect(buf.isCapped()).toBe(true);
    expect(buf.pushRich({ n: 2 })).toBe(false);
    const out = buf.drain();
    // Only the original card plus the cap notice text should appear — the
    // rejected pushRich must not have queued anything at all.
    expect(out).toEqual([
      { rich: { n: 1 } },
      { text: notice(1) }
    ]);
  });

  it('queues the cap notice in place of the card that crosses the cap', () => {
    const buf = createOutputBuffer({ maxLines: 1 });
    buf.pushRich({ n: 1 });
    // This second call is the one that would exceed maxLines: 1.
    expect(buf.pushRich({ n: 2 })).toBe(true);
    expect(buf.isCapped()).toBe(true);
    const out = buf.drain();
    expect(out).toEqual([
      { rich: { n: 1 } },
      { text: notice(1) }
    ]);
    // The second card never appears as a rich segment anywhere in the drain.
    expect(out.some(seg => seg.rich && seg.rich.n === 2)).toBe(false);
  });

  it('shares one line budget between stream text and rich cards', () => {
    const buf = createOutputBuffer({ maxLines: 2 });
    buf.pushStream('a\n');
    expect(buf.pushRich({ n: 1 })).toBe(true);
    expect(buf.isCapped()).toBe(false);
    expect(buf.lineCount()).toBe(2);
    // The budget is already spent, so this push is the one that crosses it —
    // it still returns true (it queues the cap notice), but the buffer ends
    // up capped and none of 'b' is admitted.
    expect(buf.pushStream('b\n')).toBe(true);
    expect(buf.isCapped()).toBe(true);
    expect(buf.drainText()).not.toMatch(/b/);
  });

  it('still delivers system messages after rich segments have capped the buffer', () => {
    const buf = createOutputBuffer({ maxLines: 1 });
    buf.pushRich({ n: 1 });
    buf.pushRich({ n: 2 });  // crosses the cap, queues the notice text
    buf.pushSystem('[stopped]\n');
    const out = buf.drain();
    // The notice and the system message are both plain queued strings, so
    // they land adjacent and merge into one trailing text segment.
    expect(out[out.length - 1]).toEqual({ text: notice(1) + '[stopped]\n' });
  });

  it('resetCap() lets rich segments through again while keeping what is queued', () => {
    const buf = createOutputBuffer({ maxLines: 1 });
    buf.pushRich({ n: 1 });
    buf.pushRich({ n: 2 });  // crosses the cap
    buf.resetCap();
    expect(buf.isCapped()).toBe(false);
    expect(buf.hasPending()).toBe(true);
    expect(buf.pushRich({ n: 3 })).toBe(true);
    const out = buf.drain();
    expect(out[out.length - 1]).toEqual({ rich: { n: 3 } });
  });

  it('reset() discards queued rich segments too', () => {
    const buf = createOutputBuffer();
    buf.pushRich({ n: 1 });
    buf.reset();
    expect(buf.hasPending()).toBe(false);
    expect(buf.drain()).toEqual([]);
  });

  it('drainText() skips rich segments but keeps surrounding text', () => {
    const buf = createOutputBuffer();
    buf.pushStream('before\n');
    buf.pushRich({ html: '<math/>' });
    buf.pushStream('after\n');
    expect(buf.drainText()).toBe('before\nafter\n');
  });

  it('drainText() on a queue holding only a rich segment is empty', () => {
    // Rich segments have no text form, so a queue that is purely a card
    // contributes nothing to drainText().
    const buf = createOutputBuffer();
    buf.pushRich({ html: '<math/>' });
    expect(buf.drainText()).toBe('');
  });

  it('drain() on an empty buffer, and after draining, returns []', () => {
    const buf = createOutputBuffer();
    expect(buf.drain()).toEqual([]);
    buf.pushStream('x\n');
    expect(buf.drain()).toEqual([{ text: 'x\n' }]);
    expect(buf.drain()).toEqual([]);
  });
});

// The cap notice text, matching console-buffer.js's own `notice()`, for
// asserting on the exact string a capping pushRich queues.
function notice(maxLines) {
  return '\n[output stopped after ' + maxLines + ' lines. The program is still running — '
       + 'printing more than this freezes the page, so the console stops here.]\n';
}
