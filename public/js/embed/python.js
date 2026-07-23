(function(window, TrinketIO) {
var api;
var codeRuns = {};
var editor;
var HintPlugin;
var $skulptFocusLayer;
var usingTurtle = false;
var start, selectedTab, runOption;
var Skulpt = TrinketIO.import('Skulpt');
var autoRun  = undefined;
var isConsoleOpen = false;
var isGraphicOpen = false;
var jqconsole;
var trinketFiles = {};
var trinketAssets = [];
var mainFile = "main.py";
var testFile = "tests.py";
var GUID     = TrinketIO.import('utils.guid');
var template = TrinketIO.import('utils.template');
var ActivityLog = TrinketIO.import('embed.analytics.activity');
var Sk_running = false;
var Sk_signal  = TrinketIO.import('sendSignalToSkulpt');
var runMenuOption;
var waitingOnInput;
var disableAceEditor = window.userSettings && window.userSettings.disableAceEditor || false;

// these modules are currently only loaded on certain pages
var skulpt_ast;
try {
  skulpt_ast = TrinketIO.import('skulpt.ast');
} catch(e) {}

// common functions for Skulpt config
var skulpt_write = function(text) {
  initConsoleOutput();
  text = text.replace(/\0(33)\[/g, "\x1b[");
  jqconsole.Write(text);
}
var skulpt_inputfun = function(prompt) {
  initConsoleOutput();

  window.readyForSnapshot = true;

  return new Promise(function(resolve, reject) {
    waitingOnInput = reject;
    // capture the element that currently has focus
    var active = document.activeElement;
    jqconsole.Append('<span aria-hidden="true" role="presentation">' + prompt + '</span>');
    $('#console-output').addClass('console-active');
    jqconsole.Input(function(input) {
      $('#console-output').removeClass('console-active');
      if (api.activityLog) {
        api.activityLog.logEvent("Text Input");
      }
      resolve(input);
      if (active && !disableAceEditor) {
        // restore focus to the previously focused element
        $(active).focus();
      }
    });
    if (!autoRun) {
      jqconsole.Focus();
    }
  });
}
var skulpt_onGraphicsInit = function() {
  if (isGraphicOpen) return;

  isGraphicOpen = true;
  $('#graphic-wrap').removeClass('hide');
  if (isConsoleOpen) {
    showSplitOutput();
  }
  else {
    $('#graphic-wrap').css('height', '100%');
  }
}

var SkulptEvaluateConfig = {
    evalMode            : 'main'
  , onAfterImport       : onAfterImport
  , userFiles           : trinketFiles
  , userAssets          : trinketAssets
  , includeFileInErrors : true
  , write               : skulpt_write
  , inputfun            : skulpt_inputfun
  , onGraphicsInit      : skulpt_onGraphicsInit
};

var SkulptConsoleConfig = {
    evalMode            : 'repl'
  , onAfterImport       : onAfterImport
  , userFiles           : trinketFiles
  , userAssets          : trinketAssets
  , includeFileInErrors : false
  , write               : skulpt_write
  , inputfun            : skulpt_inputfun
  , onGraphicsInit      : skulpt_onGraphicsInit
  , error               : function(message, e) { }
};

var SkulptCheckConfig = {
    evalMode            : 'tests'
  , userFiles           : trinketFiles
  , userAssets          : trinketAssets
  , includeFileInErrors : true
  , write               : function(text) {
      initTestResultOutput();
    }
  , inputfun            : function(prompt) {
      initTestResultOutput();
      return new Promise(function(resolve, reject) {
        resolve();
      });
    }
};

var evaluate, consoleEvaluate, check;

function getErrorData(error) {
  var match = error.toString().match(/^(.*?)[:;]\s*(.*?)(?:on\sline\s(\d+).*)?$/i);

  // error must at least have type and message
  if (!match || !match[1] || !match[2]) {
    return false;
  }

  return {
    error     : match[0]
    , type    : match[1]
    , message : match[2]
    , line    : match[3] ? parseInt(match[3]) : -1
  };
}

function initConsoleOutput() {
  if (isConsoleOpen) return;

  isConsoleOpen = true;
  $('#console-wrap').removeClass('hide');
  if (isGraphicOpen) {
    showSplitOutput();
  }
  else {
    $('#console-wrap').css('height', '100%');
  }

  jqconsole = $('#console-output').jqconsole();

  jqconsole.Write("\x1b[0m");
  jqconsole.Reset();

  jqconsole.Append('<span class="jqconsole-header" aria-hidden="true" role="presentation">Powered by <img id="powered-by-trinket" src="' + trinketConfig.logo() + '">\n</span>');
}

function showSplitOutput() {
  if ($('#output-dragbar').hasClass('hide')) {
    $('#output-dragbar').removeClass('hide');
    var outputTabsHeight = $('#outputTabs').height();
    var containerHeight  = $('.trinket-content-wrapper').height() - outputTabsHeight;
    var dragbarHeight    = $('#output-dragbar').height();
    var topHeight    = (containerHeight*.8) - dragbarHeight/2;
    var bottomHeight = containerHeight - topHeight - dragbarHeight/2;
    $('#graphic-wrap').css('height', topHeight);
    $('#console-wrap').css('height', bottomHeight);

    // for any graphics setups that need to resize
    $('#graphic-wrap').trigger('split-output');
  }
}

function initTestResultOutput() {
  $('#unittest-wrap').removeClass('hide').css('height', '100%');
}

function onAfterImport(library) {
  switch(library) {
    case 'turtle':
      if (api._queryString.snapshot) {
        if (!Sk.TurtleGraphics) {
          Sk.TurtleGraphics = {};
        }
        Sk.TurtleGraphics.animate = false;
        Sk.TurtleGraphics.allowUndo = false;
        Sk.TurtleGraphics.width = 320;
        Sk.TurtleGraphics.height = 320;
      }
      else {
        usingTurtle = true;
        if (runOption === 'run') {
          turtleFocus(true);
        }
      }
      break;
    case 'urllib.request':
      if ($('#proxy').val()) {
        var urllibResponses = {};
        var mod = Sk.sysmodules.mp$subscript(library);
        mod.$d.urlopen.func_code = function(url, data, timeout) {
          if (urllibResponses[url.v] === undefined) {
            // wrap url with proxyied address
            var proxy = $('#proxy').val() + '?url=' + encodeURIComponent(url.v);

            var xmlhttp = new XMLHttpRequest();
            xmlhttp.open("GET", proxy, false);
            xmlhttp.send(null);

            // cache responseText
            urllibResponses[url.v] = xmlhttp.responseText;

            if (urllibResponses[url.v].length) {
              // but remove it after a while
              setTimeout(function() {
                urllibResponses[url.v] = undefined;
              }, 10 * urllibResponses[url.v].length);
            }
          }

          return Sk.misceval.callsim(mod.$d.Response, { responseText : urllibResponses[url.v] })
        }
      }
      break;
    case 'pygal':
      if (api._queryString.snapshot) {
        Highcharts.setOptions({
          plotOptions: {
            series: {
              animation: false
            }
          }
        });
      }
  }
  if (typeof api.afterImport === 'function') {
    api.afterImport(library);
  }
}

function getSkulptFocusLayer() {
  if (!$skulptFocusLayer) {
    $skulptFocusLayer = $('<div class="turtle-overlay hide" data-action="graphic.focus" data-interface="output"></div>');
    $skulptFocusLayer.insertAfter('#graphic');
    $skulptFocusLayer.on('click', function() {
      turtleFocus(true);
    });
  }
  return $skulptFocusLayer;
}

function turtleFocus(value) {
  if (!usingTurtle) return;

  if (value !== undefined) {
    value = !!value;
    if (value) {
      getSkulptFocusLayer().addClass('hide');
      $('#graphic').focus();
      // prevent default behaviour of key events when
      // turtle has focus
      $(document).on('keydown.turtle-focus', function(evt) {
        evt.preventDefault();
      });
      api.sendInterfaceAnalytics(getSkulptFocusLayer());
      $(document).on('mousedown.turtle-focus', function(e) {
        if (!$('#graphic-wrap').is(':hover')) {
          turtleFocus(false);
        }
      });
    }
    else {
      $(document).off('keydown.turtle-focus');
      $(document).off('mousedown.turtle-focus');
      getSkulptFocusLayer().removeClass('hide');
    }
  }

  return Sk.TurtleGraphics.focus(value);
}

function resetOutput(consoleOnly) {
  editor.clearTabMarkers();

  if (jqconsole) {
    // reset any ANSI escape code graphics
    jqconsole.Write("\x1b[0m");
    jqconsole.Reset();
    jqconsole.Append('<span class="jqconsole-header" aria-hidden="true" role="presentation">Powered by <img id="powered-by-trinket" src="' + trinketConfig.logo() + '">\n</span>');
  }

  if (!consoleOnly) {
    $('#graphic').empty();
    $('#graphic').removeData("graphicMode");
  }
}

// for skulpt image module
var loadingAssets = false;
var assetsToLoad  = 0;
var assetsLoaded  = 0;

function updateImageAssets() {
  // var a = document.createElement('a');
  // a.href = trinketConfig.get("apphostname");
  // var hostDomain = a.hostname.split('.').slice(-2).join('.');

  var assets = editor.assets();
  $('#imageAssets').empty();

  assetsToLoad = assets.length;
  assetsLoaded = 0;

  if (assetsToLoad) {
    loadingAssets = true;
  }

  assets.forEach(function(asset) {
    // only use proxy if domain different than host
    // note: CORS headers are also set to be forwarded from S3 origin
    // a.href = asset.url;
    // var assetDomain = a.hostname.split('.').slice(-2).join('.');
    // var src = hostDomain === assetDomain ? asset.url : $('#proxy').val() + '/' + asset.url;
    // ... except that CORS on CloudFront doesn't seem reliable ...

    var src = /^data:image/.test(asset.url)
      ? asset.url : addProxy(asset.url);

    var img = new Image();

    img.id = asset.name;
    img.className = 'hide';

    img.onload = function() {
      $('#imageAssets').append(img);
      assetsLoaded++;
      if (assetsLoaded >= assetsToLoad) {
        loadingAssets = false;
      }
    }

    img.src = src;
  });
}

/*
 * Prevents proxy from being added multiple times and removes any duplicate instances.
 */
function addProxy(url) {
  var proxy = $('#proxy').val();

  var regex = new RegExp(proxy + '/', 'g');
  url = url.replace(regex, '');
  url = proxy + '/' + url;

  /*
  ^ original regex
  _ might be needed for html 2 image + cors
  var regex = new RegExp(proxy, 'g');

  if (!regex.test(url)) {
    url = url.replace(regex, '');
    url = proxy + '?url=' + url;
  }
  */

  return url;
}
function initFilesForSkulpt(files, main) {
  var prog, key, $hiddenFile;

  for (key in trinketFiles) {
    delete trinketFiles[key];
  }

  $('.hidden-file').remove();

  for (key in files) {
    if (key === main) {
      prog = files[key];
    }
    else {
      // add python files to our list of importable modules
      if (key.match(/\.py$/)) {
        // add a terminal newline to keep skulpt happy
        trinketFiles['./' + key] = files[key] + "\n";
      }
      // create a hidden textarea to allow open('filename', 'r') calls
      if (!$('#' + key).length) {
        $hiddenFile = $('<textarea>', {
            id     : key
          , text   : files[key] + "\n" // add a terminal newline to ensure that entire contents will be read by skulpt
          , name   : key
          , class :"hide hidden-file"
        });
        $('body').append($hiddenFile);
      }
    }
  }

  trinketAssets.length = 0;
  trinketAssets.push.apply(trinketAssets, editor.assets());

  // add proxy to assets so as to not taint the canvas
  if ($('#proxy').val()) {
    trinketAssets.forEach(function(asset) {
      if (!/^data:image/.test(asset.url)) {
        asset.url = addProxy(asset.url);
      }
    });
  }

  return prog;
}

function runTests() {
  $('.reveal-modal').foundation('reveal', 'close');

  if (check == null) {
    check = Skulpt(SkulptCheckConfig);
  }

  var $graphic = $('#graphic')
      , serializedCode = api.getValue()
      , prog;

  prog = initFilesForSkulpt(editor.getAllFiles(), testFile);

  if ($('#statusMessages').children().length) {
    $('#statusMessages').trigger('close.fndtn.alert').remove();
  }

  if (typeof api.beforeRun === 'function') {
    prog = api.beforeRun(prog);
  }

  usingTurtle = false;
  getSkulptFocusLayer().addClass('hide');

  var active = document.activeElement;

  check(prog, function() {
    autoRun = undefined;
    if (typeof api.afterRun === 'function') {
      api.afterRun(prog);
    }
    api.collectErrorData(serializedCode);
    doneRunning();
  }, function(err) {
    autoRun = undefined;
    if (typeof api.afterRun === 'function') {
      api.afterRun(prog);
    }
    api.collectErrorData(serializedCode, err);

    var line_re = /on line (\d+) in (.+)$/;
    var line_num_match = err.match(line_re);
    if (line_num_match) {
      api.highlightLine(line_num_match[2], line_num_match[1]);
    }
  }, function() {
    // execution halted!
    doneRunning();
  });

  if (usingTurtle || $('#graphic').data('graphicMode') === 'processing') {
    $('#graphic').focus();
  }
  // if this is not an autorun and the dom focus has not changed
  // during the script execution then re-focus the editor
  else if (!autoRun && active === document.activeElement) {
    if ($('#editor').css('display') != 'none') {
      api.focus();
    }
    else if (!editor.options.noEditor) {
      $('#honeypot').focus();
    }
  }

  api.updateMetric('runs', serializedCode);
  if (!codeRuns[serializedCode] && api.isModified()) {
    api.callAnalytics('Interaction', 'Modify', 'Code');
  }

  api.markCodeAsRun(serializedCode);
}

function runCode() {
  $('.reveal-modal').foundation('reveal', 'close');

  runMenuOption = 'run';

  if (Sk_running) {
    stopCode();
    setTimeout( runCode, 250 );
  }
  else if (loadingAssets) {
    setTimeout( runCode, 500 );
  }
  else {
    if (window.parent) {
      window.parent.postMessage("started", "*");
    }

    if (evaluate == null) {
      if (api._queryString.snapshot) {
        SkulptEvaluateConfig.snapshot = true;
      }
      evaluate = Skulpt(SkulptEvaluateConfig);
    }

    window.Sk_interrupt = false;

    var serializedCode = api.getValue()
      , prog;

    prog = initFilesForSkulpt(editor.getAllFiles(), mainFile);

    resetOutput();

    $('#console-output').removeClass('console-mode');

    if ($('#statusMessages').children().length) {
      $('#statusMessages').trigger('close.fndtn.alert').remove();
    }

    if (typeof api.beforeRun === 'function') {
      prog = api.beforeRun(prog);
    }

    usingTurtle = false;
    getSkulptFocusLayer().addClass('hide');

    TrinketIO.runtime('downloadExtra', undefined);

    var active = document.activeElement;

    Sk_running = true;

    var stopTimer = setTimeout(function() {
      if (Sk_running) {
        api.changeRunOption('stop');
      }
    }, 500);

    evaluate(prog, function() {
      autoRun = undefined;
      if (typeof api.afterRun === 'function') {
        api.afterRun(prog);
      }
      api.collectErrorData(serializedCode);

      doneRunning(stopTimer);
    }, function(err) {
      autoRun = undefined;
      if (typeof api.afterRun === 'function') {
        api.afterRun(prog);
      }

      if (!/(?:interrupt|systemexit)/i.test(err)) {
        api.collectErrorData(serializedCode, err);

        var line_re = /on line (\d+) in (\S+)/;
        var line_num_match = err.match(line_re);
        if (line_num_match) {
          // filename may contain trailing period
          var filename = line_num_match[2].replace(/\.$/, '');
          api.highlightLine(filename, line_num_match[1]);
        }
      }

      doneRunning(stopTimer);
    }, function() {
      // execution halted!
      doneRunning(stopTimer);
    });

    if (usingTurtle || $('#graphic').data('graphicMode') === 'processing') {
      $('#graphic').focus();
    }
    // if this is not an autorun and the dom focus has not changed
    // during the script execution then re-focus the editor
    else if (!autoRun && active === document.activeElement && !disableAceEditor) {
      if ($('#editor').css('display') != 'none') {
        api.focus();
      }
      // if ace is disabled in settings, don't refocus (for accessibility)
      else if (!editor.options.noEditor && !disableAceEditor) {
        $('#honeypot').focus();
      }
    }

    api.updateMetric('runs', serializedCode);
    if (!codeRuns[serializedCode] && api.isModified()) {
      api.callAnalytics('Interaction', 'Modify', 'Code');
    }

    api.markCodeAsRun(serializedCode);
  }
}

function stopCode() {
  window.Sk_interrupt = true;
  Sk_signal(0);

  if (waitingOnInput) {
    waitingOnInput(new Sk.builtin.SystemExit('execution halted'));
    waitingOnInput = null;
  }

  if (typeof Processing === "function" && Processing.instances && Processing.instances.length) {
     Processing.instances[0].exit();
  }
}

function doneRunning(timer) {
  if (timer) {
    clearTimeout(timer);
  }

  Sk_running = false;

  if (runMenuOption) {
    api.changeRunOption(runMenuOption);
  }

  window.readyForSnapshot = true;

  if (window.parent) {
    window.parent.postMessage("complete", "*")
  }
}

function runConsole() {
  $('.reveal-modal').foundation('reveal', 'close');

  runMenuOption = 'console';

  if (Sk_running) {
    stopCode();
    setTimeout( runConsole, 250 );
  }
  else if (loadingAssets) {
    setTimeout( runConsole, 500 );
  }
  else {
    if (Sk.globals) {
      Sk.globals = {
        '__name__' : Sk.globals['__name__']
      };
    }

    initConsoleOutput();

    $('#console-output').addClass('console-mode');

    if (consoleEvaluate == null) {
      consoleEvaluate = Skulpt(SkulptConsoleConfig);
    }

    var $graphic = $('#graphic')
        , serializedCode = api.getValue()
        , history = []
        , prog;

    prog = initFilesForSkulpt(editor.getAllFiles(), mainFile);

    resetOutput();

    if ($('#statusMessages').children().length) {
      $('#statusMessages').trigger('close.fndtn.alert').remove();
    }

    if (typeof api.beforeRun === 'function') {
      prog = api.beforeRun(prog);
    }

    if (prog) {
      history = prog.split('\n');
    }

    usingTurtle = false;
    getSkulptFocusLayer().addClass('hide');

    startPrompt({
      history : history
    });
  }
}

function startPrompt(options) {
  var inMultilineString = false;
  jqconsole.Prompt(true, function(input) {
    if (/^\s*$/.test(input)) {
      jqconsole._pauseHistory = false;
      startPrompt(options);
    }
    else {
      window.Sk_interrupt = false;
      Sk_running = true;
      var stopTimer = setTimeout(function() {
        if (Sk_running) {
          api.changeRunOption('stop');
        }
      }, 500);

      consoleEvaluate(input, function() {
        jqconsole._pauseHistory = false;
        startPrompt(options);
        doneRunning(stopTimer);
      }, function(err, e) {
        jqconsole.Write(escapeHtml(e.toString()), 'jqconsole-error', false);
        jqconsole._pauseHistory = false;
        startPrompt(options);
        doneRunning(stopTimer);
      }, function() {
        // execution halted!
        doneRunning(stopTimer);
      });

      api.callAnalytics('Interaction', 'Modify', 'Code');
    }
  }, function(input) {
    var multilineReturn = false
      , indent, last_line, lines;

    lines = input.split('\n');
    if (lines.length === 0) {
      return 0;
    }
    else {
      last_line = lines[lines.length - 1];
      indent = last_line.match(/^\s*/)[0];
      last_line = lines[lines.length - 1].replace(/\s+$/, '');

      if (/"""/.test(last_line) && !/""".*"""/.test(last_line)) {
        inMultilineString = !inMultilineString;
      }

      if (inMultilineString) {
        multilineReturn = 0;
      }
      else if (!/^\s*#/.test(last_line) && last_line[last_line.length - 1] === ':') {
        multilineReturn = 1;
      }
      else if (indent.length && last_line && last_line[last_line.length - 1].length !== 0) {
        multilineReturn = 0;
      }
      else if (/^\s*#/.test(last_line)) {
        multilineReturn = 0;
      }

      if (jqconsole._enteringHistory) {
        if (indent.length) {
          multilineReturn = -(indent.length / 2);
        }
        else if (multilineReturn !== false) {
          multilineReturn = 0;
        }

        if (multilineReturn === false) {
          jqconsole._pauseHistory = true;
        }
      }

      return multilineReturn;
    }
  });
  jqconsole.Focus();

  enterHistory(options.history);
}

function enterHistory(history) {
  var command, chrs, i, jqEvent;

  if (history.length) {
    jqconsole._enteringHistory = true;

    command = history.shift();
    chrs    = command.split('');

    for (i = 0; i < chrs.length; i++) {
      jqEvent = $.Event('keypress');
      jqEvent.which = chrs[i].charCodeAt(0);
      jqconsole.$input_source.trigger(jqEvent);
    }

    if (!history.length) {
      jqconsole._enteringHistory = false;
    }

    jqEvent = $.Event('keydown');
    jqEvent.which = '\r'.charCodeAt(0);
    jqconsole.$input_source.trigger(jqEvent)

    if (history.length && !jqconsole._pauseHistory) {
      enterHistory(history);
    }
  }
}

function escapeHtml(text) {
  var map = {
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#039;'
  };

  return text.replace(/[&<>"']/g, function(m) { return map[m]; });
}

(function() {
  // prevent backspace from going back in browser history
  var inputTypes = /^(input|text|password|file|email|search|date)$/i;
  $(document).bind('keydown', function (event) {
    var doPrevent = true
        , d;
    if (event.keyCode === 8) {
      d = event.srcElement || event.target;
      if (d.tagName.toLowerCase() === 'textarea' || (d.tagName.toLowerCase() === 'input' && d.type.match(inputTypes))) {
        doPrevent = d.readOnly || d.disabled;
      }

      if (doPrevent) {
        event.preventDefault();
      }
    }
  });
})();

window.TrinketAPI = {
  initialize : function(trinket) {
    api   = this;
    start = $('#start-value').val();
    runOption   = $('#runOption-value').val();
    api.runMode = $('#runMode-value').val();
    autoRun = (start === 'result') && !$('body').hasClass('has-status-bar');

    var assetsEnabled = window.trinket && window.trinket.config && window.trinket.config.assetsEnabled;
    var assets   = assetsEnabled ? (trinket.assets ? trinket.assets.slice() : []) : false
      , addFiles = true
      , uiType   = api.getUIType();

    editor = $('#editor').codeEditor({
        showTabs             : !this._queryString.outputOnly
      , noEditor             : !!this._queryString.outputOnly
      , disableAceEditor     : disableAceEditor
      , tabSize              : window.userSettings && window.userSettings.pythonTab || 2
      , lineWrapping         : window.userSettings && window.userSettings.lineWrapping || false
      , mainFileName         : mainFile
      , showInfo             : true
      , assets               : assets
      , addFiles             : addFiles
      , guest                : uiType === 'guest' ? true : false
      , owner                : uiType === 'owner' ? true : false
      , canHideTabs          : api.hasPermission('hide-trinket-files')
        // TODO: must also be owner of this trinket - eventually convert to actual permissions based check on trinket
      , canAddInlineComments : api.hasPermission('add-trinket-inline-comments') && (uiType === 'owner' || api.assignmentFeedback)
      , assignmentViewOnly   : api.assignmentViewOnly
      , userId               : api.getUserId()
      , lang                 : 'python'
      , onFocus              : function() {
        turtleFocus(false);
      }
      , assetsHowTo : '#assets-howto-message'
    }).data('trinket-codeEditor');

    updateImageAssets();

    /*
     * add a post save hook so that we can
     * update the Skulpt assets list
     */
    var originalSave = api.save;
    api.save = function(trinket, done) {
      originalSave.call(api, trinket, function(err, result) {
        if (typeof done === 'function') {
          done(err, result);
        }
      });
    };

    $('#console-output').click(function() {
      if (jqconsole && (jqconsole.GetState() === 'input' || jqconsole.GetState() === 'prompt')) {
        jqconsole.Focus();
      }
    });

    $(document).on('sk.system.clear', function() {
      resetOutput(true);
    });
    $('#reset-output').click(function() {
      resetOutput(true);
    });

    $(document).on('assets.change', function() {
      updateImageAssets();
      api.triggerChange();
    });

    $(document).on('open.fndtn.alert', function() {
      editor.resize();
    });
    $(document).on('close.fndtn.alert', function() {
      editor.resize();
    });

    editor.addCommand(
      'run',
      {win: "Ctrl-Enter", mac: "Command-Enter"},
      function(editor) {
        $('#editor').trigger('trinket.code.run', {
          action : 'code.run'
        });
      }
    );

    editor.addCommand(
      'test',
      {win: "Shift-Ctrl-Enter", mac: "Shift-Command-Enter"},
      function(editor) {
        $('#editor').trigger('trinket.code.check', {
          action : 'code.check'
        });
      }
    );

    try {
      HintPlugin = TrinketIO.import('python.editor.hints');
      editor.registerPlugin(HintPlugin);
    } catch(e) {}

    this._errorGroup    = 0;
    this._sessionId     = GUID();
    this._previousError = undefined;

    $(document).on('trinket.code.edit',    $.proxy(this.showCode, this));
    $(document).on('trinket.code.run',     $.proxy(this.showResult, this));
    $(document).on('trinket.code.stop',    $.proxy(this.stopExecution, this));
    $(document).on('trinket.code.check',   $.proxy(this.showTestResult, this));
    $(document).on('trinket.code.console', $.proxy(this.consoleResult, this));

    $(document).on('trinket.output.view',       $.proxy(api.showOutput, api));
    $(document).on('trinket.instructions.view', $.proxy(api.showInstructions, api));

    $('#editorToggleWrapper').keydown($.proxy(this.editorToggleFieldset, this));
    $('#toolbarEditorToggle').change($.proxy(this.toolbarEditorToggle, this));

    this.viewer = '#codeOutput';
    $(document).on('trinket.code.modules', $.proxy(this.toggleModules, this));

    $('#honeypot').on('keydown', $.proxy(this.showCode, this));

    $('#menu').on(
      'trinket.sharing.share trinket.sharing.embed trinket.sharing.email',
      function(evt) {
        if (api.isModified() && !codeRuns[api.getValue()]) {
          $('#runFirstModal').foundation('reveal', 'open');
          evt.preventDefault();
        }
      }
    );

    $('.menu-toolbar .menu-button[data-action="code.run"]').on('mousedown', function(event) {
      if (editor && editor.isFocused()) {
        event.preventDefault();
      }
    });

    $('.menu-toolbar .menu-button[data-action="code.check"]').on('mousedown', function(event) {
      if (editor && editor.isFocused()) {
        event.preventDefault();
      }
    });

    $('#modalRun').click(function() {
      sendInterfaceAnalytics(this);
      $('#runFirstModal').foundation('reveal', 'close');
      runCode();
    });

    // happens when duplicating a trinket
    if (trinket.settings && trinket.settings.testsEnabled && $('.check-it').hasClass('hide')) {
      $('.check-it').removeClass('hide');
    }

    api.reset(trinket, true);

    editor.change(function() {
      api.triggerChange();
    });

    api.draggable(_.debounce(function resize() {
    }, 500));

    $('#output-dragbar').css('touch-action', 'none'); // iPad: pointer drag, not scroll
    $('#output-dragbar').on('pointerdown', function(e) {
      e.preventDefault();

      var outputTabsHeight = $('#outputTabs').height();
      var containerHeight  = $('.trinket-content-wrapper').height() - outputTabsHeight;
      var containerTop     = $('.trinket-content-wrapper').offset().top + outputTabsHeight;
      var dragbarHeight    = $('#output-dragbar').height();
      $(document).on('pointermove.output-dragbar', function(e) {
        var topHeight    = e.pageY - containerTop - dragbarHeight/2;
        var bottomHeight = containerHeight - topHeight - dragbarHeight/2;
        if (topHeight >= 20 && bottomHeight >= 20) {
          $('#graphic-wrap').css('height', topHeight);
          $('#console-wrap').css('height', bottomHeight);
        }
      });

      $(document).on('pointerup.output-dragbar', function(e) {
        $(document).off('pointermove.output-dragbar pointerup.output-dragbar');
      });

      api.sendInterfaceAnalytics(this);
    });

    api.activityLog = new ActivityLog(function(type, count) {
      var action = type.replace(
        /[a-zA-Z0-9](?:[^\s\-\._]*)/g
        , function(txt){return txt.charAt(0).toUpperCase() + txt.substr(1);}
      );
      api.sendAnalytics("Output", {
        action  : action
        , label : api.getTrinketIdentifier()
        , value : count
      });
    });

    // turtle keypress activity logging
    $(document).keydown(function(e){
      var mode = $("#graphic").data("graphicMode");
      if (/turtle/i.test(mode) && $(".turtle-overlay").hasClass("hide")) {
        api.activityLog.logEvent(mode + " Key");
      }
    });

    // turtle canvas mousedown activity logging
    $(document).on("mousedown", "#graphic-wrap", function(event) {
      var mode = $("#graphic").data("graphicMode");
      if (mode) {
        api.activityLog.logEvent(mode + " Click");
      }
      else {
        api.activityLog.logEvent("Output Click");
      }
    });

    if (window.parent) {
      window.parent.postMessage("initialised", "*");
    }

    if (api._queryString && api._trinket.description && api._queryString.showInstructions && api._trinket.description.length) {
      $(document).trigger('trinket.instructions.view');
    }
  },

  collectErrorData : function(code, err) {
    var current  = err && getErrorData(err)
      , previous = this._previousError
      , eventData, patch;

    if (previous) {
      previous.attempt += 1;

      patch = window.JsDiff.createPatch(
        "attempt" + previous.attempt
        , previous.code
        , code
      );

      eventData = {
        session        : this._sessionId
        , error        : previous.error
        , group        : previous.group
        , type         : previous.type
        , message      : previous.message
        , line         : previous.line
        , code         : previous.code
        , elapsed      : Date.now() - previous.time
        , totalElapsed : Date.now() - previous.firstTime
        // don't include the header info in the patch, since it isn't useful here
        , delta        : patch.substr(patch.indexOf('@'))
        , attempt      : previous.attempt
      };

      if (current) {
        eventData.introduced = current.error;
      }

      if (current && previous.message === current.message) {
        eventData.state = "repeated";
        this.logError(eventData);
        previous.time = Date.now();
        current = undefined;
      }
      else {
        eventData.state = "resolved";
        this.logError(eventData);
        if (!current) {
          this._previousError = undefined;
        }
      }
    }

    if (current) {
      current.group   = ++this._errorGroup;
      current.code    = code;
      current.time    = current.firstTime = Date.now();
      current.attempt = 0;

      this.logError({
        state       : "encountered"
        , session   : this._sessionId
        , group     : current.group
        , error     : current.error
        , type      : current.type
        , message   : current.message
        , line      : current.line
        , attempt   : current.attempt
        , code      : code
      });

      this._previousError = current;
    }
  },

  highlightLine : function(file_name, line_num) {
    editor.highlight(file_name, line_num);
  },

  getTour : function() {
    var ui   = this.getUIType(),
        tour = [];

    if (ui !== 'owner') {
      // check if this is a small screen
      if ($('.mode-toolbar .show-for-small-only').css('display') !== 'none') {
        // check if starting in code view
        if (!$('#editor').hasClass('hide')) {
          tour.push({el:'.run-it', event:'code.run'});
        }
        tour.push(
          {el:'.edit-it', event:'code.edit'},
          {el:'.ace_content', event:'code.change'},
          {el:'.run-it', event:'code.run'}
        );
      }
      else if ($('#start-value').val() === "result" || !this._trinket.code) {
        tour.push(
          {el:'.ace_content', event:'code.change'},
          {el:'.run-it', event:'code.run'}
        );
      }
      else {
        tour.push([
          {el:'.run-it', event:'code.run'},
          {el:'.ace_content', event:'code.change'}
        ]);
      }

      tour.push(
        {el:'.left-menu-toggle', event:'menu.options'},
        {el:'.share-it', event:'sharing.share'}
      );

      if (ui === 'guest') {
        tour.push({el:'.right-menu-toggle', event:'menu.user'});
      }

      tour.push({el:'.save-it', event:'library.add'});
    }

    return tour;
  },
  getEditor : function() {
    return editor;
  },
  getType : function() {
    return 'python';
  },
  getValue : function(opts) {
    return editor.serialize(opts);
  },
  getMainFile : function() {
    return mainFile;
  },
  isDirty : function() {
    if (!this._trinket) return false;

    if (this.getValue() !== (this._original.code || '')) {
      return true;
    }

    var editorAssets = editor.assets();
    if (editorAssets.length !== (this._original.assets || []).length) {
      return true;
    }

    if (JSON.stringify(editorAssets) !== JSON.stringify(this._original.assets)) {
      return true;
    }

    if (JSON.stringify(this._trinket.settings) !== JSON.stringify(this._original.settings)) {
      return true;
    }

    return false;
  },
  getAnalyticsCategory : function() {
    return 'Python';
  },
  serialize : function(opts) {
    var serialized = {
      code     : this.getValue(opts),
      assets   : editor.assets().slice(),
      settings : this._trinket.settings
    };

    if (opts && opts.removeComments) {
      editor.removeComments();
    }

    return serialized;
  },
  showMessage : function(type, message) {
    var html = template('statusMessageTemplate', {
      type    : type,
      message : message
    });
    var $msg = $(html);
    $('body').addClass('has-status-bar').append($msg);
    $msg.parent().foundation().trigger('open.fndtn.alert');
  },
  showCode : function(event) {
    $('#codeOutput').addClass('hide');
    $('#editor').removeClass('hide');
    api.closeOverlay('#modules');
    api.focus();
    turtleFocus(false);
  },
  showResult : function(event) {
    if (runOption !== 'run' && event && $(event.target).data('button') === 'run') {
      api.changeRunOption('run');
    }
    api.runMode = '';
    api.triggerRunModeChange();
    api.hasRun = true;

    $('#codeOutput').removeClass('hide');
    $('#editor').addClass('hide');
    $('#unittest-wrap').addClass('hide');

    api.closeOverlay('#modules');

    $('#instructionsContainer').addClass('hide');
    $('#outputContainer').removeClass('hide');

    $('#codeOutputTab').addClass('active');
    $('#instructionsTab').removeClass('active');

    runCode();

    if (event) {
      api.callAnalytics('Interaction', 'Click', 'Run');
    }
  },
  stopExecution : function(event) {
    stopCode();
  },
  showTestResult : function(event) {
    $('#codeOutput').removeClass('hide');
    $('#editor').addClass('hide');

    $('#console-wrap').addClass('hide');
    isConsoleOpen = false;

    $('#graphic-wrap').addClass('hide');
    isGraphicOpen = false;

    $('#unittest-wrap').removeClass('hide');

    $('#output-dragbar').addClass('hide');
    $('#instructionsContainer').addClass('hide');
    $('#outputContainer').removeClass('hide');

    api.closeOverlay('#modules');

    runTests();

    if (event) {
      api.callAnalytics('Interaction', 'Click', 'Check');
    }
  },
  consoleResult : function(event) {
    if (runOption !== 'console' && event && $(event.target).data('button') === 'console') {
      api.changeRunOption('console');
    }
    api.runMode = 'console';
    api.triggerRunModeChange();

    $('#codeOutput').removeClass('hide');
    $('#editor').addClass('hide');
    $('#unittest-wrap').addClass('hide');

    api.closeOverlay('#modules');

    $('#instructionsContainer').addClass('hide');
    $('#outputContainer').removeClass('hide');

    $('#codeOutputTab').addClass('active');
    $('#instructionsTab').removeClass('active');

    runConsole();

    if (event) {
      api.callAnalytics('Interaction', 'Click', 'Console');
    }
  },
  toggleModules : function() {},
  hideAll : function() {},
  onOpenOverlay : function() {
    $('#codeOutput').addClass('hide');
    $('#editor').addClass('hide');
  },
  onCloseOverlay : function() {
    $('#codeOutput').removeClass('hide');
    $('#editor').removeClass('hide');
    api.focus();
    turtleFocus(false);
  },
  reset : function(trinket, initial) {
    editor.reset(trinket.code);
    editor.assets(trinket.assets ? trinket.assets.slice() : []);

    if (!initial) {
      updateImageAssets();
    }

    if (runOption === 'console' || api.runMode === 'console') {
      this.consoleResult();
    }
    else if (trinket.code && (start === 'result') && autoRun !== false) {
      this.showResult();
    }
    else {
      this.showCode();
      resetOutput();
    }
  },
  replaceMain : function(trinket, initial) {
    editor.setValue(trinket.code);
    editor.assets(trinket.assets ? trinket.assets.slice() : []);

    if (!initial) {
      updateImageAssets();
    }
  },
  onChangeChecks : function(checks) {
    var self = this
      , runChecks
      , results, i;

    runChecks = function() {
      results = [];

      var code     = JSON.parse(self.getValue())
        , fileName = "main.py"
        , main     = _.find(code, { name : fileName }).content
        , table;

      if (skulpt_ast) {
        table = skulpt_ast.parseCode(editor);
      }

      for (i = 0; i < checks.length; i++) {
        results.push({
            result : checks[i].fn.call(self, table)
          , name   : checks[i].name
        });
      }

      window.parent.postMessage(JSON.stringify({
          action  : "check-results"
        , results : results
      }), "*");
    }

    $(this).on('trinket.code.change', _.debounce(runChecks, 1000));
    $(document).on('trinket.resetted', runChecks);

    runChecks();
  },
  focus : function() {
    if (!$('body').data('is-mobile') && $('body').data('autofocus')) {
      editor.focus();
    }
    turtleFocus(false);
  },
  markCodeAsRun : function(code) {
    codeRuns[code] = true;
  },
  downloadable : function() {
    var owner = this.getUIType() === 'owner'
      , remix, files, assets;

    if (this._trinket && this._trinket._origin_id) {
      remix = this._trinket._origin_id;
    }

    files  = owner && !remix ? editor.getAllFiles() : editor.getAllVisibleFiles();
    assets = editor.assets();

    return {
        files  : files
      , assets : assets
    };
  },
  toggleCheckButton : function() {
    if ($('.check-it').hasClass('hide')) {
      $('.check-it').removeClass('hide');
    }
    else {
      $('.check-it').addClass('hide');
    }
  },
  toolbarEditorToggle : function(event) {
    if ($(event.target).is(':checked')) {
      editor.option('disableAceEditor', true);
    }
    else {
      editor.option('disableAceEditor', false);
    }
    editor.refresh();
  },
  editorToggleFieldset : function(event) {
    var keycode = (event.keyCode ? event.keyCode : event.which);
    if (event.target.id === 'editorToggleFieldset' && keycode === 32) {
      $('#toolbarEditorToggle').prop('checked', !$('#toolbarEditorToggle').is(':checked'));
      if ($('#toolbarEditorToggle').is(':checked')) {
        editor.option('disableAceEditor', true);
      }
      else {
        editor.option('disableAceEditor', false);
      }
      editor.refresh();
    }
  },
  changeRunOption : function(option) {
    var icon_classes = {
        run     : 'fa fa-play'
      , console : 'fa fa-terminal'
      , stop    : 'fa fa-stop'
    };
    var titles = {
        run     : 'View the result.'
      , console : 'Run code interactively.'
      , stop    : 'Stop program.'
    };
    var labels = {
        run     : 'Run'
      , console : 'Console'
      , stop    : 'Stop'
    };
    $('.run-it').data('action', 'code.' + option);
    $('.run-it').attr('title', titles[option]);
    $('.run-it').find('label').text(labels[option]);
    $('.run-it').find('i').removeClass().addClass( icon_classes[option] );
    runOption = option;
  },
  discardDraftSettings : function() {
    if (this._trinket.settings.testsEnabled !== this._predraft.settings.testsEnabled) {
      var resetEvent = new MouseEvent('click', {
        'bubbles' : true
      });

      try {
        $('#testsEnabled').data('skip-trigger', true);
        $('#testsEnabled')[0].dispatchEvent(resetEvent);
      } catch(e) {
        console.log("testsEnabled click err:", e);
      }
    }
  },
  saveClientSnapshot : function() {
    return this.getUIType() === 'owner' && this.hasRun;
  },

  setWrap: function(wrap) {
    editor.setWrap(wrap)
    this.setAPILineWrap(wrap)
  },

  setIndent: function(indent) {
    editor.setIndent(indent);
    this.setAPIIndent(indent, undefined, undefined, undefined);
  },

  captureAndSaveSnapshot : function(done) {
    try {
      var node = document.querySelector("#outputContainer");
      htmlToImage.toPng(node)
        .then(function (dataUrl) {
          done(dataUrl);
        })
        .catch(function (error) {
          console.error('snapshot error:', error);
          done();
        });
    } catch(e) {
      done();
    }
  }
};

})(window, window.TrinketIO);
