'use strict';

// Page-side view of the GlowScript Stop button, against the real markup of both
// toolbars that carry a .run-it: the editor toolbar (glowscript.html) as
// Foundation leaves it after building its tooltip (wording moved into a
// span.tooltip keyed by the control's data-selector, title blanked), and the
// output-only toolbar (default-toolbar.html), which has no tooltip. It covers the
// ↻ Run look a running control takes while the editor holds something else (edited()).
// Spec: docs/superpowers/specs/2026-10-09-glowscript-stop-button-design.md

const { JSDOM } = require('jsdom');
const { create } = require('../../public/js/embed/run-stop-button');

const EDITOR_RUN = '<a class="run-it menu-button item allow-original" data-action="code.run" data-tooltip aria-haspopup="true" title="" data-options="disable_for_touch:true" data-selector="tip1" aria-describedby="tip1"><i class="fa fa-play"></i><label class="show-for-large-up">Run</label></a>';
const EDITOR_TIP = '<span data-selector="tip1" id="tip1" class="tooltip" role="tooltip">View the result.<span class="nub"></span></span>';
const OTHER_TIP = '<span data-selector="other" id="other" class="tooltip" role="tooltip">Other<span class="nub"></span></span>';
const OUTPUT_RUN = '<button id="outputRun" class="run-it menu-button item button allow-original" data-action="code.run" title="View the result." aria-label="Run Code" role="button" tabindex="0"><i class="fa fa-play"></i><label>Run</label></button>';

// editorStyle: an inline style attribute on the editor's control, as markup may carry.
function page({ editorStyle = '' } = {}) {
  const editorRun = editorStyle
    ? EDITOR_RUN.replace('<a class="run-it', '<a style="' + editorStyle + '" class="run-it')
    : EDITOR_RUN;
  const dom = new JSDOM('<!doctype html><body><div class="icon-bar">' + editorRun + OUTPUT_RUN + '</div>'
    + EDITOR_TIP + OTHER_TIP + '</body>');
  const doc = dom.window.document;
  const dataCalls = [];
  const key = (el) => el.id || el.getAttribute('data-selector');
  const $ = (el) => ({ data: (name, value) => dataCalls.push([key(el), name, value]) });
  const view = create(doc.querySelectorAll('.run-it'), $);
  return {
    doc, view, dataCalls,
    win: dom.window,
    editor: doc.querySelector('.run-it[data-selector="tip1"]'),
    output: doc.getElementById('outputRun'),
    tip: doc.getElementById('tip1'),
  };
}

const text = (el, sel) => el.querySelector(sel).textContent;
const iconClass = (el) => el.querySelector('i').getAttribute('class');
const tipText = (tip) => tip.firstChild.textContent;
const lastAction = (dataCalls, id) => dataCalls.filter((c) => c[0] === id).pop()[2];

// jsdom does no layout, so a test says what a browser would measure. A control is
// as wide as its inline width when it has one, else as wide as its label's natural
// width: what its icon, label and padding come to, per control because the two
// toolbars' controls need not be equally wide. Its padding is the stylesheet's
// unless its own inline style sets it. As in a browser, the computed style is
// live: it reads the inline style as it is when asked.
const SHEET = { boxSizing: 'border-box', borderLeftWidth: '0px', borderRightWidth: '0px', padding: '16px' };
const RUN_STOP = { Run: 76.4, Stop: 80.4 };   // Stop 4 px wider, near enough what a 1280 px viewport gives

function layOut(p, natural = {}, sheet = SHEET) {
  const widths = { editor: RUN_STOP, output: RUN_STOP, ...natural };
  for (const name of ['editor', 'output']) {
    const el = p[name];
    el.getBoundingClientRect = vi.fn(() => {
      const locked = parseFloat(el.style.width);
      return { width: Number.isNaN(locked) ? widths[name][text(el, 'label')] : locked };
    });
  }
  p.win.getComputedStyle = (el) => ({
    boxSizing: sheet.boxSizing,
    borderLeftWidth: sheet.borderLeftWidth,
    borderRightWidth: sheet.borderRightWidth,
    get paddingLeft() { return el.style.paddingLeft || sheet.padding; },
    get paddingRight() { return el.style.paddingRight || sheet.padding; },
  });
}

const inline = (el) => ({
  width: el.style.width, minWidth: el.style.minWidth,
  paddingLeft: el.style.paddingLeft, paddingRight: el.style.paddingRight,
  whiteSpace: el.style.whiteSpace,
});
const NO_INLINE = { width: '', minWidth: '', paddingLeft: '', paddingRight: '', whiteSpace: '' };
const px = (value) => parseFloat(value);

// Where a test needs the content re-centered, it also says how wide the content inside a
// control is: what its icon, its label and the gap between them come to, for the look the
// control shows (its icon class and its label text say which). A label with no width is
// hidden, as below the large breakpoint. `reads` collects the inline width the control was
// held at each time its content was measured.
const CONTENT = {
  icon: { 'fa fa-play': 12.6, 'fa fa-stop': 13.7, 'fa fa-repeat': 13.7 },
  label: { Run: 27.0, Stop: 29.9 },
  gap: 4.8,
};   // Run 44.4, Stop 48.4 (the 4 px more that RUN_STOP says), ↻ Run 45.5
const BOTH = { editor: CONTENT, output: CONTENT };

function layOutContent(p, content = BOTH, reads = []) {
  for (const name of ['editor', 'output']) {
    const el = p[name];
    const { icon: iconWidths, label: labelWidths, gap, labelHidden = false } = content[name];
    const icon = el.querySelector('i');
    const label = el.querySelector('label');
    const iconWidth = () => iconWidths[icon.getAttribute('class')];
    // Where the icon sits is the control's business (its padding): only differences count.
    const iconLeft = () => (iconWidth() > 0 ? 20 : 0);
    icon.getBoundingClientRect = vi.fn(() => {
      reads.push(el.style.width);
      return { left: iconLeft(), right: iconLeft() + iconWidth(), width: iconWidth() };
    });
    label.getBoundingClientRect = vi.fn(() => {
      reads.push(el.style.width);
      // A hidden label (display: none) has no box at all, wherever it would have been.
      if (labelHidden || iconWidth() === 0) { return { left: 0, right: 0, width: 0 }; }
      const width = labelWidths[label.textContent];
      const left = iconLeft() + iconWidth() + gap;
      return { left, right: left + width, width };
    });
  }
}

// Everything the view shows for the page, to compare one state with another. The inline
// style is compared by value, not by the attribute's text, which orders its properties by
// when each was first set.
const withoutStyle = (el) => {
  const copy = el.cloneNode(true);
  copy.removeAttribute('style');
  return copy.outerHTML;
};
const cachedAction = (dataCalls, id) => {
  const call = dataCalls.filter((c) => c[0] === id).pop();
  return call && call[2];
};
const looks = (p) => ({
  html: [p.editor, p.output].map(withoutStyle),
  inline: [p.editor, p.output].map(inline),
  tip: tipText(p.tip),
  actions: [cachedAction(p.dataCalls, 'tip1'), cachedAction(p.dataCalls, 'outputRun')],
});
const laidOut = (opts, ...args) => {
  const p = page(opts);
  layOut(p, ...args);
  layOutContent(p);
  return p;
};

describe('running', () => {
  it('turns every Run control into Stop', () => {
    const { view, editor, output } = page();
    view.set('running');
    for (const el of [editor, output]) {
      expect(el.getAttribute('data-action')).toBe('code.stop');
      expect(el.getAttribute('aria-label')).toBe('Stop program');
      expect(iconClass(el)).toBe('fa fa-stop');
      expect(text(el, 'label')).toBe('Stop');
      expect(el.classList.contains('run-state-running')).toBe(true);
      expect(el.hasAttribute('aria-disabled')).toBe(false);
    }
    expect(output.getAttribute('title')).toBe('Stop the program.');
  });

  it("rewrites a Foundation tooltip's text in place and leaves the title Foundation blanked", () => {
    const { doc, view, editor, tip } = page();
    view.set('running');
    expect(tipText(tip)).toBe('Stop the program.');
    expect(tip.querySelector('.nub')).not.toBeNull();
    expect(editor.getAttribute('title')).toBe('');
    expect(doc.getElementById('other').firstChild.textContent).toBe('Other');
  });

  it('follows a tooltip Foundation builds after the view was created', () => {
    const dom = new JSDOM('<!doctype html><body><a class="run-it" data-action="code.run" title="View the result."><i class="fa fa-play"></i><label>Run</label></a></body>');
    const doc = dom.window.document;
    const el = doc.querySelector('.run-it');
    const view = create(doc.querySelectorAll('.run-it'));
    // What Foundation's tooltip init does: move the title into a tip, then blank the title.
    el.setAttribute('data-selector', 'late');
    el.setAttribute('title', '');
    doc.body.insertAdjacentHTML('beforeend', '<span data-selector="late" id="late" class="tooltip" role="tooltip">View the result.<span class="nub"></span></span>');
    const tip = doc.getElementById('late');
    view.set('running');
    expect(tipText(tip)).toBe('Stop the program.');
    expect(el.getAttribute('title')).toBe('');
    view.set('idle');
    expect(tipText(tip)).toBe('View the result.');
  });

  it('updates the action jQuery has cached, which is what embed.js dispatches on, both ways', () => {
    const { view, dataCalls } = page();
    view.set('running');
    expect(lastAction(dataCalls, 'tip1')).toBe('code.stop');
    expect(lastAction(dataCalls, 'outputRun')).toBe('code.stop');
    view.set('idle');
    expect(lastAction(dataCalls, 'tip1')).toBe('code.run');
    expect(lastAction(dataCalls, 'outputRun')).toBe('code.run');
  });

  it('injects one decorative strip per control, however often it runs', () => {
    const { view, editor } = page();
    view.set('running');
    view.set('idle');
    view.set('running');
    const traces = editor.querySelectorAll('svg.run-stop-trace');
    expect(traces).toHaveLength(1);
    expect(traces[0].getAttribute('aria-hidden')).toBe('true');
    const rect = traces[0].querySelector('rect');
    expect(rect.getAttribute('pathLength')).toBe('100');
    expect(rect.getAttribute('width')).toBe('100%');
    expect(rect.getAttribute('height')).toBe('100%');
    expect(rect.getAttribute('rx')).toBe('3');
  });

  it('keeps keyboard focus on the same control', () => {
    const { doc, view, output } = page();
    output.focus();
    view.set('running');
    expect(doc.activeElement).toBe(output);
    view.set('idle');
    expect(doc.activeElement).toBe(output);
  });
});

describe('stopping', () => {
  it('still shows Stop, but says Stopping to assistive tech and in the tooltip, routes to code.stop, and is marked disabled', () => {
    const { view, editor, output, tip } = page();
    view.set('running');
    view.set('stopping');
    expect(text(editor, 'label')).toBe('Stop');
    expect(text(output, 'label')).toBe('Stop');
    expect(iconClass(editor)).toBe('fa fa-stop');
    expect(editor.getAttribute('aria-label')).toBe('Stopping program');
    expect(tipText(tip)).toBe('Stopping the program.');
    expect(output.getAttribute('title')).toBe('Stopping the program.');
    expect(editor.getAttribute('data-action')).toBe('code.stop');
    expect(editor.getAttribute('aria-disabled')).toBe('true');
    expect(editor.classList.contains('run-state-stopping')).toBe(true);
    expect(editor.classList.contains('run-state-running')).toBe(false);
  });

  it('a new run while stopping is Stop again and no longer disabled', () => {
    const { view, editor } = page();
    view.set('running');
    view.set('stopping');
    view.set('running');
    expect(text(editor, 'label')).toBe('Stop');
    expect(editor.hasAttribute('aria-disabled')).toBe(false);
    expect(editor.classList.contains('run-state-running')).toBe(true);
    expect(editor.classList.contains('run-state-stopping')).toBe(false);
  });
});

describe('idle', () => {
  it("restores each toolbar's own original wording exactly", () => {
    const { view, editor, output, tip } = page();
    view.set('running');
    view.set('stopping');
    view.set('idle');

    expect(editor.getAttribute('data-action')).toBe('code.run');
    expect(editor.getAttribute('title')).toBe('');
    expect(tipText(tip)).toBe('View the result.');
    expect(editor.hasAttribute('aria-label')).toBe(false);
    expect(text(editor, 'label')).toBe('Run');

    expect(output.getAttribute('title')).toBe('View the result.');
    expect(output.getAttribute('aria-label')).toBe('Run Code');
    expect(text(output, 'label')).toBe('Run');

    for (const el of [editor, output]) {
      expect(iconClass(el)).toBe('fa fa-play');
      expect(el.hasAttribute('aria-disabled')).toBe(false);
      expect(el.classList.contains('run-state-running')).toBe(false);
      expect(el.classList.contains('run-state-stopping')).toBe(false);
    }
  });
});

// The control never changes size: it keeps the outer width it measured as Run, and
// Stop, a few pixels wider than Run, takes the difference from its side padding.
describe('width', () => {
  it('keeps the width each control has as Run through Stop and Stopping, and hands the padding back on Run', () => {
    const p = page();
    layOut(p, { editor: { Run: 76.4, Stop: 80.4 }, output: { Run: 90.2, Stop: 94.2 } });
    const held = [[p.editor, '76.4px'], [p.output, '90.2px']];

    for (const state of ['running', 'stopping']) {
      p.view.set(state);
      for (const [el, width] of held) {
        expect(el.style.width, state).toBe(width);
        // Stop is 4 px wider than Run, so each side gives up 2 of its 16 px, and
        // the content stays centered.
        expect(px(el.style.paddingLeft), state).toBeCloseTo(14, 6);
        expect(px(el.style.paddingRight), state).toBeCloseTo(14, 6);
        expect(el.style.minWidth, state).toBe('');
        // The fit is exact, so a rounding shortfall must not wrap the label under the icon.
        expect(el.style.whiteSpace, state).toBe('nowrap');
      }
    }

    p.view.set('idle');
    for (const [el] of held) { expect(inline(el)).toEqual(NO_INLINE); }
  });

  it('keeps sub-pixel widths instead of rounding them to whole pixels', () => {
    // With the label hidden, below the large breakpoint, only the icons differ, by about 1 px.
    const p = page();
    layOut(p, { editor: { Run: 45.578125, Stop: 46.71875 } });
    p.view.set('running');
    expect(p.editor.style.width).toBe('45.578125px');
    expect(px(p.editor.style.paddingLeft)).toBeCloseTo(16 - 0.5703125, 6);
    expect(px(p.editor.style.paddingRight)).toBeCloseTo(16 - 0.5703125, 6);
  });

  it.each([['narrower than', 74.0], ['exactly as wide as', 76.4]])(
    'leaves the padding alone when Stop is %s Run',
    (_, stop) => {
      const p = page();
      layOut(p, { editor: { Run: 76.4, Stop: stop } });
      p.view.set('running');
      expect(p.editor.style.width).toBe('76.4px');
      expect(p.editor.style.paddingLeft).toBe('');
      expect(p.editor.style.paddingRight).toBe('');
    },
  );

  it('never takes more padding than a control has', () => {
    const p = page({ editorStyle: 'padding-left: 1px; padding-right: 3px' });
    layOut(p);   // 2 px to give from each side
    p.view.set('running');
    expect(p.editor.style.paddingLeft).toBe('0px');
    expect(px(p.editor.style.paddingRight)).toBeCloseTo(1, 6);
    expect(p.editor.style.width).toBe('76.4px');
  });

  it('leaves a control that is not rendered alone', () => {
    // A hidden toolbar measures 0 wide.
    const hidden = page();
    layOut(hidden, { editor: { Run: 0, Stop: 0 } });
    hidden.view.set('running');
    expect(inline(hidden.editor)).toEqual(NO_INLINE);
    expect(text(hidden.editor, 'label')).toBe('Stop');
    hidden.view.set('stopping');
    expect(inline(hidden.editor)).toEqual(NO_INLINE);
    hidden.view.set('idle');
    expect(inline(hidden.editor)).toEqual(NO_INLINE);

    // So does jsdom with no layout at all: not even a style attribute appears.
    const bare = page();
    bare.view.set('running');
    expect(bare.editor.hasAttribute('style')).toBe(false);
    expect(bare.output.hasAttribute('style')).toBe(false);
    expect(text(bare.editor, 'label')).toBe('Stop');
  });

  it('squeezes from, and restores, the inline padding, min-width and white-space the markup had', () => {
    const p = page({ editorStyle: 'padding-left: 10px; padding-right: 14px; min-width: 50px; white-space: pre' });
    layOut(p);
    p.view.set('running');
    // From the padding it had, not the stylesheet's.
    expect(px(p.editor.style.paddingLeft)).toBeCloseTo(8, 6);
    expect(px(p.editor.style.paddingRight)).toBeCloseTo(12, 6);
    expect(p.editor.style.minWidth).toBe('50px');
    expect(p.editor.style.whiteSpace).toBe('nowrap');
    p.view.set('stopping');
    p.view.set('idle');
    expect(inline(p.editor)).toEqual({
      width: '', minWidth: '50px', paddingLeft: '10px', paddingRight: '14px', whiteSpace: 'pre',
    });
  });

  it('keeps an inline width the markup had, and restores it', () => {
    const p = page({ editorStyle: 'width: 90px' });
    layOut(p);   // the inline width is what the control measures, as Run and as Stop
    p.view.set('running');
    expect(p.editor.style.width).toBe('90px');
    expect(p.editor.style.paddingLeft).toBe('');
    p.view.set('stopping');
    p.view.set('idle');
    expect(inline(p.editor)).toEqual({ ...NO_INLINE, width: '90px' });
  });

  it('does not measure again for a run that starts while stopping', () => {
    const p = page();
    layOut(p);
    p.view.set('running');
    p.view.set('stopping');
    const reads = p.editor.getBoundingClientRect.mock.calls.length;
    expect(reads).toBeGreaterThan(0);   // it did measure, on leaving idle
    p.view.set('running');
    p.view.set('stopping');
    p.view.set('running');
    expect(p.editor.getBoundingClientRect.mock.calls.length).toBe(reads);
    expect(p.editor.style.width).toBe('76.4px');
    expect(text(p.editor, 'label')).toBe('Stop');
  });

  it('measures again at the next run, so a resize between runs is followed', () => {
    const p = page();
    const natural = { editor: { Run: 76.4, Stop: 80.4 } };
    layOut(p, natural);
    p.view.set('running');
    p.view.set('idle');
    // The viewport crossed the large breakpoint, and the label with it, while idle.
    natural.editor.Run = 45.6;
    natural.editor.Stop = 46.8;
    p.view.set('running');
    expect(p.editor.style.width).toBe('45.6px');
    expect(px(p.editor.style.paddingLeft)).toBeCloseTo(15.4, 6);
  });

  it.each([['wider than', 80.4, 14], ['narrower than', 74.0, 16]])(
    'sizes a content-box control by its content width when Stop is %s Run, so its outer width is still the one it had',
    (_, stop, padding) => {
      const p = page();
      layOut(p, { editor: { Run: 76.4, Stop: stop } },
        { ...SHEET, boxSizing: 'content-box', borderLeftWidth: '1px', borderRightWidth: '1px' });
      p.view.set('running');
      // A Stop 4 px wider takes 2 px from each side's 16 px; a Stop that fits takes none.
      const side = (name) => px(p.editor.style[name] || SHEET.padding);
      expect(side('paddingLeft')).toBeCloseTo(padding, 6);
      expect(side('paddingRight')).toBeCloseTo(padding, 6);
      const outer = px(p.editor.style.width) + side('paddingLeft') + side('paddingRight') + 2;   // 2: the 1 px borders
      expect(outer).toBeCloseTo(76.4, 6);
    },
  );
});

// While a program runs and the editor holds something other than what runs, the control
// offers to run the changes: ↻ Run. The page decides when (edited(true) and edited(false));
// the view only draws it, and only for a program that is running.
describe('edited', () => {
  it('turns every control into ↻ Run: the Run wording, a repeat icon, and the action that runs again', () => {
    const { view, editor, output, dataCalls } = page();
    view.set('running');
    view.edited(true);
    for (const el of [editor, output]) {
      expect(el.getAttribute('data-action')).toBe('code.run');
      expect(el.getAttribute('aria-label')).toBe('Run your changes');
      expect(iconClass(el)).toBe('fa fa-repeat');
      expect(text(el, 'label')).toBe('Run');
      expect(el.classList.contains('run-state-edited')).toBe(true);
      expect(el.hasAttribute('aria-disabled')).toBe(false);
    }
    expect(output.getAttribute('title')).toBe('Run your changes (restarts the program).');
    // embed.js dispatches on jQuery's cached action, so that one has to follow.
    expect(lastAction(dataCalls, 'tip1')).toBe('code.run');
    expect(lastAction(dataCalls, 'outputRun')).toBe('code.run');
    expect(view.state()).toBe('running');
  });

  it('is still a running control, which is what the strip and its lap hang on', () => {
    const { view, editor } = page();
    view.set('running');
    view.edited(true);
    expect(editor.classList.contains('run-state-edited')).toBe(true);
    expect(editor.classList.contains('run-state-running')).toBe(true);
    view.edited(false);
    view.edited(true);
    expect(editor.querySelectorAll('svg.run-stop-trace')).toHaveLength(1);
  });

  it("rewrites a Foundation tooltip's text for ↻ Run and back, and leaves the title Foundation blanked", () => {
    const { doc, view, editor, tip } = page();
    view.set('running');
    view.edited(true);
    expect(tipText(tip)).toBe('Run your changes (restarts the program).');
    expect(tip.querySelector('.nub')).not.toBeNull();
    expect(editor.getAttribute('title')).toBe('');
    expect(doc.getElementById('other').firstChild.textContent).toBe('Other');
    view.edited(false);
    expect(tipText(tip)).toBe('Stop the program.');
    expect(editor.getAttribute('title')).toBe('');
  });

  it('goes back to exactly the Stop look when the edit is undone', () => {
    const p = laidOut();
    p.view.set('running');
    const stop = looks(p);
    p.view.edited(true);
    expect(looks(p)).not.toEqual(stop);
    p.view.edited(false);
    expect(looks(p)).toEqual(stop);
    // And again: the same ↻ Run, and the same Stop, however often it flips.
    p.view.edited(true);
    const edited = looks(p);
    p.view.edited(false);
    p.view.edited(true);
    expect(looks(p)).toEqual(edited);
    p.view.edited(false);
    expect(looks(p)).toEqual(stop);
  });

  it.each(['running', 'stopping', 'idle'])('set(%s) clears it, leaving what a program that was never edited shows', (state) => {
    const was = laidOut();
    was.view.set('running');
    was.view.edited(true);
    was.view.set(state);

    const never = laidOut();
    never.view.set('running');
    never.view.set(state);

    expect(looks(was)).toEqual(looks(never));
    expect(was.view.state()).toBe(state);
    for (const el of [was.editor, was.output]) {
      expect(el.classList.contains('run-state-edited')).toBe(false);
    }

    // Nothing is left pending: the next edit of a running program draws it again.
    was.view.set('running');
    was.view.edited(true);
    expect(was.editor.classList.contains('run-state-edited')).toBe(true);
    expect(text(was.editor, 'label')).toBe('Run');
  });

  it.each(['idle', 'stopping'])('does nothing while %s, and leaves nothing pending for the next run', (state) => {
    const p = laidOut();
    if (state === 'stopping') {
      p.view.set('running');
      p.view.set('stopping');
    }
    const before = looks(p);
    p.view.edited(true);
    expect(looks(p)).toEqual(before);
    p.view.edited(false);
    expect(looks(p)).toEqual(before);
    expect(p.view.state()).toBe(state);

    // The next run starts as Stop.
    p.view.set('running');
    const plain = laidOut();
    plain.view.set('running');
    expect(looks(p)).toEqual(looks(plain));
    expect(p.editor.classList.contains('run-state-edited')).toBe(false);
  });

  it('does nothing when the control already shows what it is asked for', () => {
    const reads = [];
    const p = page();
    layOut(p);
    layOutContent(p, BOTH, reads);
    p.view.set('running');

    const quiet = (when) => {
      const before = { looks: looks(p), calls: p.dataCalls.length, measured: reads.length };
      return () => {
        expect(looks(p), when).toEqual(before.looks);
        expect(p.dataCalls, when).toHaveLength(before.calls);
        expect(reads, when).toHaveLength(before.measured);
      };
    };

    let unchanged = quiet('Stop, asked for Stop');
    p.view.edited(false);
    unchanged();

    p.view.edited(true);
    unchanged = quiet('↻ Run, asked for ↻ Run');
    p.view.edited(true);
    unchanged();
  });

  it('keeps keyboard focus on the same control', () => {
    const { doc, view, output } = page();
    output.focus();
    view.set('running');
    view.edited(true);
    expect(text(output, 'label')).toBe('Run');
    expect(doc.activeElement).toBe(output);
    view.edited(false);
    expect(text(output, 'label')).toBe('Stop');
    expect(doc.activeElement).toBe(output);
  });

  it('copes with no jQuery, and with a control that has no icon or label', () => {
    const dom = new JSDOM('<a class="run-it" data-action="code.run">Run</a><a class="run-it" data-action="code.run" title="Run it"><i class="fa fa-play"></i><label>Run</label></a>');
    const [bare, full] = dom.window.document.querySelectorAll('.run-it');
    const view = create([bare, full]);
    expect(() => {
      view.set('running');
      view.edited(true);
      view.edited(false);
      view.edited(true);
      view.set('idle');
    }).not.toThrow();
    expect(bare.getAttribute('data-action')).toBe('code.run');
    expect(full.getAttribute('title')).toBe('Run it');
    view.set('running');
    view.edited(true);
    expect(full.getAttribute('data-action')).toBe('code.run');
    expect(full.getAttribute('title')).toBe('Run your changes (restarts the program).');
  });
});

// The control keeps the width it has as Run through ↻ Run as through Stop. ↻ Run's content
// is not Stop's, so the side padding is fitted to the content that shows, and it stays
// centered. The content's own width is measured, never the control's: the held width is
// not released to measure.
describe('width, edited', () => {
  // A control's size in a browser's terms: the held width, with its content exactly filling
  // what the padding leaves, and sitting in the middle of it.
  function expectFit(p, { content }, when) {
    for (const el of [p.editor, p.output]) {
      expect(px(el.style.width), when).toBeCloseTo(76.4, 6);
      const left = px(el.style.paddingLeft);
      const right = px(el.style.paddingRight);
      expect(left + content + right, when).toBeCloseTo(76.4, 6);
      expect(left, when).toBeCloseTo(right, 6);
      expect(el.style.whiteSpace, when).toBe('nowrap');
      expect(el.style.minWidth, when).toBe('');
    }
  }

  it('keeps the width it has as Run, with the content centered, through Stop, ↻ Run, Stop again and Run', () => {
    const p = laidOut();
    p.view.set('running');
    expectFit(p, { content: 48.4 }, 'as Stop');
    p.view.edited(true);
    expectFit(p, { content: 45.5 }, 'as ↻ Run');
    p.view.edited(false);
    expectFit(p, { content: 48.4 }, 'as Stop again');
    p.view.edited(true);
    expectFit(p, { content: 45.5 }, 'as ↻ Run again');

    // Stopping is Stop's look, so it is Stop's fit too.
    p.view.set('stopping');
    expectFit(p, { content: 48.4 }, 'as Stopping');
    p.view.set('running');
    p.view.edited(true);
    p.view.set('running');
    expectFit(p, { content: 48.4 }, 'as Stop, set while ↻ Run');

    p.view.edited(true);
    p.view.set('idle');
    for (const el of [p.editor, p.output]) { expect(inline(el)).toEqual(NO_INLINE); }
  });

  it('measures the content while the width is held, never after releasing it', () => {
    const reads = [];
    const p = page();
    layOut(p);
    layOutContent(p, BOTH, reads);
    p.view.set('running');
    reads.length = 0;
    const controlReads = p.editor.getBoundingClientRect.mock.calls.length;   // its own box: as Run, on leaving idle
    p.view.edited(true);
    p.view.edited(false);
    p.view.edited(true);
    expect(reads.length).toBeGreaterThan(0);
    expect(new Set(reads)).toEqual(new Set(['76.4px']));
    expect(p.editor.getBoundingClientRect.mock.calls).toHaveLength(controlReads);
  });

  it('keeps the side padding the control had, uneven or not, as Stop does', () => {
    const p = laidOut({ editorStyle: 'padding-left: 10px; padding-right: 14px' });
    p.view.set('running');
    expect(px(p.editor.style.paddingLeft)).toBeCloseTo(8, 6);
    expect(px(p.editor.style.paddingRight)).toBeCloseTo(12, 6);
    const stop = inline(p.editor);

    p.view.edited(true);
    // 1.45 px each side more than Stop: ↻ Run's content is 2.9 px narrower.
    expect(px(p.editor.style.paddingLeft)).toBeCloseTo(9.45, 6);
    expect(px(p.editor.style.paddingRight)).toBeCloseTo(13.45, 6);
    expect(p.editor.style.width).toBe('76.4px');

    p.view.edited(false);
    expect(inline(p.editor)).toEqual(stop);
    p.view.edited(true);
    p.view.set('idle');
    expect(inline(p.editor)).toEqual({ ...NO_INLINE, paddingLeft: '10px', paddingRight: '14px' });
  });

  it('leaves the padding alone where ↻ Run is as wide as Stop, as with only the icon showing', () => {
    // Below the large breakpoint the label is hidden, and the repeat icon is as wide as the stop icon.
    const iconOnly = { ...CONTENT, labelHidden: true };
    const p = page();
    layOut(p, { editor: { Run: 45.6, Stop: 46.8 }, output: { Run: 45.6, Stop: 46.8 } });
    layOutContent(p, { editor: iconOnly, output: iconOnly });
    p.view.set('running');
    const stop = inline(p.editor);
    expect(stop.width).toBe('45.6px');
    p.view.edited(true);
    expect(iconClass(p.editor)).toBe('fa fa-repeat');
    expect(inline(p.editor)).toEqual(stop);
    p.view.edited(false);
    expect(iconClass(p.editor)).toBe('fa fa-stop');
    expect(inline(p.editor)).toEqual(stop);
  });

  it('takes padding back, or takes more, as ↻ Run asks, never more than the control has', () => {
    const wider = (repeat) => {
      const content = { ...CONTENT, icon: { ...CONTENT.icon, 'fa fa-repeat': repeat } };
      const p = page();
      layOut(p);
      layOutContent(p, { editor: content, output: content });
      p.view.set('running');
      p.view.edited(true);
      return p;
    };
    // A repeat icon 6.3 px wider than the stop icon makes ↻ Run's content 51.8 px, 3.4 px more
    // than Stop's 48.4: each side gives up 1.7 of Stop's 14 px.
    const wide = wider(20);
    expect(px(wide.editor.style.paddingLeft)).toBeCloseTo(12.3, 6);
    expect(px(wide.editor.style.paddingRight)).toBeCloseTo(12.3, 6);
    expect(wide.editor.style.width).toBe('76.4px');

    const huge = wider(100);
    expect(huge.editor.style.paddingLeft).toBe('0px');
    expect(huge.editor.style.paddingRight).toBe('0px');
    expect(huge.editor.style.width).toBe('76.4px');
  });

  it("sizes a content-box control by its content width, so ↻ Run's outer width is the one it had too", () => {
    const p = page();
    layOut(p, {}, { ...SHEET, boxSizing: 'content-box', borderLeftWidth: '1px', borderRightWidth: '1px' });
    layOutContent(p);
    const outer = (el) => px(el.style.width) + px(el.style.paddingLeft) + px(el.style.paddingRight) + 2;   // 2: the 1 px borders
    p.view.set('running');
    expect(outer(p.editor)).toBeCloseTo(76.4, 6);
    p.view.edited(true);
    expect(outer(p.editor)).toBeCloseTo(76.4, 6);
    expect(px(p.editor.style.paddingLeft)).toBeCloseTo(15.45, 6);
    p.view.edited(false);
    expect(outer(p.editor)).toBeCloseTo(76.4, 6);
    expect(px(p.editor.style.paddingLeft)).toBeCloseTo(14, 6);
  });

  it("puts Stop's width and padding back exactly as it first wrote them, not as the style reads them back", () => {
    // Blink reads 76.453125px back as 76.4531px, which lays out a grid step narrower.
    const p = page();
    layOut(p, { editor: { Run: 76.453125, Stop: 80.265625 } });
    layOutContent(p);
    const stored = {};
    for (const name of ['width', 'paddingLeft', 'paddingRight']) {
      Object.defineProperty(p.editor.style, name, {
        configurable: true,
        get: () => (stored[name] ? Number(parseFloat(stored[name]).toPrecision(6)) + 'px' : ''),
        set: (value) => { stored[name] = value; },
      });
    }

    p.view.set('running');
    const stop = { ...stored };
    expect(stop.width).toBe('76.453125px');
    p.view.edited(true);
    expect(stored.paddingLeft).not.toBe(stop.paddingLeft);
    p.view.edited(false);
    expect(stored).toEqual(stop);
    p.view.edited(true);
    p.view.set('stopping');
    expect(stored).toEqual(stop);
  });

  it('forgets what it held when the program ends, so a control hidden for the next run is left alone', () => {
    const natural = { editor: { Run: 76.4, Stop: 80.4 } };
    const p = page();
    layOut(p, natural);
    layOutContent(p);
    p.view.set('running');
    p.view.edited(true);
    p.view.set('idle');

    // The toolbar is hidden when the next program starts: its control measures 0 wide.
    natural.editor.Run = 0;
    natural.editor.Stop = 0;
    p.view.set('running');
    expect(inline(p.editor)).toEqual(NO_INLINE);
    p.view.edited(true);
    expect(inline(p.editor)).toEqual(NO_INLINE);
    p.view.edited(false);
    expect(inline(p.editor)).toEqual(NO_INLINE);
    p.view.set('stopping');
    expect(inline(p.editor)).toEqual(NO_INLINE);
  });

  it('leaves a control that is not rendered alone', () => {
    const none = { icon: { 'fa fa-play': 0, 'fa fa-stop': 0, 'fa fa-repeat': 0 }, label: { Run: 0, Stop: 0 }, gap: 0 };
    const hidden = page();
    layOut(hidden, { editor: { Run: 0, Stop: 0 } });
    layOutContent(hidden, { editor: none, output: CONTENT });
    hidden.view.set('running');
    hidden.view.edited(true);
    expect(text(hidden.editor, 'label')).toBe('Run');
    expect(iconClass(hidden.editor)).toBe('fa fa-repeat');
    expect(inline(hidden.editor)).toEqual(NO_INLINE);
    hidden.view.edited(false);
    expect(text(hidden.editor, 'label')).toBe('Stop');
    expect(inline(hidden.editor)).toEqual(NO_INLINE);

    // So does jsdom with no layout at all: not even a style attribute appears.
    const bare = page();
    bare.view.set('running');
    bare.view.edited(true);
    expect(bare.editor.hasAttribute('style')).toBe(false);
    expect(bare.output.hasAttribute('style')).toBe(false);
    expect(text(bare.editor, 'label')).toBe('Run');
  });
});

describe('robustness', () => {
  it('rejects an unknown state', () => {
    const { view } = page();
    expect(() => view.set('paused')).toThrow(/unknown run state/);
  });

  it('copes with a control that has no icon or label', () => {
    const dom = new JSDOM('<a class="run-it" data-action="code.run">Run</a>');
    const view = create(dom.window.document.querySelectorAll('.run-it'));
    expect(() => { view.set('running'); view.set('idle'); }).not.toThrow();
  });

  it('reports its state', () => {
    const { view } = page();
    expect(view.state()).toBe('idle');
    view.set('running');
    expect(view.state()).toBe('running');
  });
});
