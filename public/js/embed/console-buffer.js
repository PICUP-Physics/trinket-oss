(function(root) {
  'use strict';

  // #142: the accounting behind console output buffering.
  //
  // pydoc's plain_pager hands `help(numpy)` to stdout as ONE 2.45 MB write, and
  // Pyodide's batched stdout flushes on every newline — so the console took
  // 70,605 separate writes. Each jqconsole.Write appends a span and then calls
  // _ScrollToEnd, which READS scrollHeight and .position() before writing back:
  // a forced layout per line, against a container growing to 70k children. The
  // cost is superlinear and entirely synchronous on the main thread, so the page
  // stops painting and Stop can never fire.
  //
  // Two guards live here, both general — the trigger is output VOLUME, not
  // help(). Any program printing tens of thousands of lines hits the same wall:
  //
  //   1. Queue, so the caller can append once per frame instead of once per
  //      line. Coalescing is what turns N reflows into one.
  //   2. Cap, because coalescing alone still lets a big enough program build a
  //      DOM the browser cannot lay out. Past maxLines, stream text is dropped
  //      and a notice is queued once. The PROGRAM keeps running; only the
  //      rendering stops.
  //
  // The queue also carries RICH segments (typeset math cards, features.mathOutput)
  // interleaved with text. They go through here rather than being written
  // directly for the two reasons this module exists: a card must land in
  // program order relative to print() output, and it must be bounded.
  //
  // Rich output has its OWN, much smaller budget (maxRich), and past it results
  // are written as plain text instead of typeset cards. The two budgets are
  // separate because the costs differ by orders of magnitude.
  //
  // Measured end-to-end on a real stack (Apple Silicon, Pyodide 0.28.1, SymPy
  // 1.13.3, KaTeX 0.18.5), 400 iterations of `display(e)` on a WARM
  // interpreter — warm matters, an earlier attempt at this measurement was
  // wrong because a cold sympy.integrate() dominated it:
  //
  //   budget      typeset cards   worst freeze   total blocking
  //   unbounded             400        2093 ms          6697 ms
  //   maxRich 30             30        1253 ms          1528 ms
  //
  // The marginal cost of one extra typeset card is therefore ~14 ms (KaTeX,
  // 174 DOM nodes, ~6 KB of markup, one jqconsole write), against microseconds
  // for a line of text. The Python side is not the cost: _repr_latex_ is
  // 0.33 ms, str() 0.23 ms, json.dumps 0.008 ms and the JS crossing 0.015 ms,
  // so ~0.6 ms per result all told.
  //
  // Sharing the 5,000-line text budget would therefore allow roughly 70 s of
  // unresponsive page — and while the main thread is blocked the Stop button
  // cannot fire, which is the exact failure #142 and this cap exist to prevent.
  //
  // 30 is a readability limit rather than a performance one: nobody reads more
  // than a few dozen typeset equations, and the only realistic way to exceed it
  // is a display() inside a loop, where the student did not intend to look at
  // every result anyway.
  //
  // Past the budget results are DEGRADED, not dropped: each is written as an
  // ordinary console line carrying str(expr), which costs microseconds. Nothing
  // is lost — every result stays on screen, scrollable and copyable — so the
  // threshold can be set this low without it ever costing a student output.
  //
  // Kept pure — no DOM, no timers — so the rules are testable in node. The
  // caller owns flushing and the actual write.

  // System text (loader notices, '[stopped]') is never capped: those have to
  // survive a truncated run, and they are bounded by construction.
  function createOutputBuffer(options) {
    var opts     = options || {};
    var maxLines = typeof opts.maxLines === 'number' ? opts.maxLines : 5000;
    var maxRich  = typeof opts.maxRich  === 'number' ? opts.maxRich  : 30;

    var queue    = [];
    var lines    = 0;    // stream lines accepted since the last reset
    var capped   = false;
    var rich     = 0;    // typeset results accepted since the last reset
    var degraded = false;

    function notice() {
      return '\n[output stopped after ' + maxLines + ' lines. The program is still running — '
           + 'printing more than this freezes the page, so the console stops here.]\n';
    }

    function richNotice() {
      return '\n[Typesetting stopped after ' + maxRich + ' expressions to keep the page '
           + 'responsive. Further results are shown as plain text. Display fewer '
           + 'expressions, or split this work across several trinkets.]\n';
    }

    // The plain-text form of a result, for once the rich budget is spent. Line
    // number first, matching the card, then str(expr). The source echo is left
    // out on purpose: past this point the results are nearly always one
    // display() inside a loop, so repeating its line would be pure noise.
    function plainLine(item) {
      var text = (item && item.text) || '';
      if (!text) return '';
      var lineno = item && item.lineno;
      return (lineno ? String(lineno) + '  ' : '') + text + '\n';
    }

    function countNewlines(s) {
      var n = 0;
      for (var i = 0; i < s.length; i++) { if (s.charCodeAt(i) === 10) n++; }
      return n;
    }

    // Index just past the nth newline, or -1 if there are fewer than n.
    function endOfLine(s, n) {
      var at = -1;
      while (n-- > 0) {
        var next = s.indexOf('\n', at + 1);
        if (next === -1) return -1;
        at = next;
      }
      return at + 1;
    }

    return {
      // Program stdout/stderr. Subject to the cap.
      pushStream: function(text) {
        if (capped) return false;
        var s = String(text);
        var n = countNewlines(s);

        if (lines + n > maxLines) {
          // Cut on a line boundary, never mid-line: a half-line reads as
          // corrupted output rather than a deliberate stop.
          var cut = endOfLine(s, maxLines - lines);
          if (cut > 0) queue.push(s.slice(0, cut));
          lines  = maxLines;
          capped = true;
          queue.push(notice());
          return true;
        }

        lines += n;
        queue.push(s);
        return true;
      },

      // Loader notices, '[stopped]', input prompts. Queued so it stays ordered
      // with program output, but never capped.
      pushSystem: function(text) {
        queue.push(String(text));
        return true;
      },

      // One displayed result. Counts as a single line against the overall cap,
      // like a line of text, AND against the separate, much smaller rich budget
      // (see the header). Within that budget it is queued as a card; past it,
      // as an ordinary text line, so a runaway display() loop degrades instead
      // of freezing the page. Returns whether anything was queued, like
      // pushStream.
      pushRich: function(item) {
        if (capped) return false;
        if (lines + 1 > maxLines) {
          lines  = maxLines;
          capped = true;
          queue.push(notice());
          return true;
        }
        lines += 1;
        if (rich < maxRich) {
          rich += 1;
          queue.push({ rich: item });
          return true;
        }
        // Degraded: a plain string, so it merges with surrounding text into a
        // single write rather than costing a forced layout of its own.
        if (!degraded) {
          degraded = true;
          queue.push(richNotice());
        }
        var line = plainLine(item);
        if (line) queue.push(line);
        return true;
      },

      // Everything queued, as an ordered array of segments:
      //
      //   { text: string }   run of console text, ready for one Write
      //   { rich: item }     one card the caller renders itself
      //
      // Adjacent text is merged, so a flush still costs one Write per run of
      // text no matter how many pushes produced it — the coalescing this module
      // exists for survives having cards in the middle.
      drain: function() {
        if (!queue.length) return [];
        var out   = [];
        var chunk = [];
        for (var i = 0; i < queue.length; i++) {
          var entry = queue[i];
          if (typeof entry === 'string') {
            chunk.push(entry);
            continue;
          }
          if (chunk.length) { out.push({ text: chunk.join('') }); chunk = []; }
          out.push(entry);
        }
        if (chunk.length) out.push({ text: chunk.join('') });
        queue = [];
        return out;
      },

      // The pre-rich contract: everything queued as one string. Rich segments
      // have no text form and contribute nothing, so this is for callers that
      // only ever deal in text.
      drainText: function() {
        if (!queue.length) return '';
        // Collect and join rather than += in a loop: a flush can hold thousands
        // of stdout writes, and repeated concatenation reallocates. This keeps
        // the linear behaviour the pre-rich queue.join('') had.
        var parts = [];
        for (var i = 0; i < queue.length; i++) {
          if (typeof queue[i] === 'string') parts.push(queue[i]);
        }
        queue = [];
        return parts.join('');
      },

      hasPending: function() { return queue.length > 0; },

      // The console is being rebuilt: queued text belongs to the old one.
      reset: function() {
        queue    = [];
        lines    = 0;
        capped   = false;
        rich     = 0;
        degraded = false;
      },

      // Give the next unit of work a fresh budget without discarding what is
      // already queued. Used per REPL statement, where "one command" is the
      // natural unit — a single help(numpy) must not mute the whole session.
      resetCap: function() {
        lines    = 0;
        capped   = false;
        rich     = 0;
        degraded = false;
      },

      isCapped:    function() { return capped; },
      lineCount:   function() { return lines; },
      isDegraded:  function() { return degraded; },
      richCount:   function() { return rich; }
    };
  }

  var api = { createOutputBuffer: createOutputBuffer };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root && root.TrinketIO && root.TrinketIO.export) root.TrinketIO.export('embed.consoleBuffer', api);
})(typeof window !== 'undefined' ? window : this);
