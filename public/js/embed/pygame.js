(function(window, TrinketIO) {
var api;
var codeRuns = {};
var editor, editorSettings;
var HintPlugin;
var start, selectedTab;
var autoRun  = undefined;
var jqconsole;
var trinketFiles = {};
var trinketAssets = [];
var mainFile = "main.py";
var GUID     = TrinketIO.import('utils.guid');
var template = TrinketIO.import('utils.template');
var ActivityLog = TrinketIO.import('embed.analytics.activity');

var Server = TrinketIO.import('embed.server');
var audiostream = TrinketIO.import('audiostream.api');
var serverTimer;
var stillThereTimeout, stillThereTimer;
var initInterval;
var runningInterval;
var settingUpInterval;

var pygameRunning = false;

var disableAceEditor = window.userSettings && window.userSettings.disableAceEditor || false;

var isGraphicOpen = false
  , isConsoleOpen = false;

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

function initGraphicsOutput() {
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

  if (!jqconsole) {
    jqconsole = $('#pygame-console-output').jqconsole();
  }

  jqconsole.Write("\x1b[0m");
  jqconsole.Reset();

  consoleHeader();
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
  }
}

function adjustGraphicDimensions() {
  $('#graphic').css({
      height : $('#graphic-wrap').height()
    , width  : $('#graphic-wrap').width()
  });
}

function initConsole(msg, mode) {
  clearAllIntervals();

  $('#console-wrap').removeClass('hide');
  $('#console-wrap').css('height', '100%');

  if (!jqconsole) {
    jqconsole = $('#pygame-console-output').jqconsole();
  }

  // Reset and show header once
  resetOutput();

  // Start status indicator (updates in place, doesn't reload header)
  initInterval = startStatusIndicator(msg);

  return function() {
    window.clearInterval(initInterval);
    clearStatus();
  }
}

function settingUp() {
  clearAllIntervals();

  settingUpInterval = startStatusIndicator('Setting Up');

  return function() {
    window.clearInterval(settingUpInterval);
    clearStatus();
  }
}

function running() {
  clearAllIntervals();

  runningInterval = startStatusIndicator('Running');

  return function(resetOnce, done) {
    window.clearInterval(runningInterval);
    clearStatus();
    // Don't reset output here - just clear status
    done();

    window.readyForSnapshot = true;

    return true;
  }
}

// Status indicator that updates in place without reloading the header/logo
function startStatusIndicator(msg) {
  var chars = ['/', '-', '|', '\\', '-', '|'];
  var charIndex = 0;

  // Add status element if not present
  if ($('#console-status').length === 0) {
    jqconsole.Append('<span id="console-status" class="jqconsole-header" aria-hidden="true"></span>\n');
  }

  // Update immediately, then on interval
  $('#console-status').text(msg + ' ' + chars[charIndex]);

  var interval = window.setInterval(function() {
    charIndex = (charIndex + 1) % chars.length;
    $('#console-status').text(msg + ' ' + chars[charIndex]);
  }, 150);

  return interval;
}

function clearStatus() {
  $('#console-status').remove();
}

function clearAllIntervals() {
  if (initInterval) {
    window.clearInterval(initInterval);
  }
  if (runningInterval) {
    window.clearInterval(runningInterval);
  }
  if (settingUpInterval) {
    window.clearInterval(settingUpInterval);
  }
}

function resetOutput() {
  if (jqconsole) {
    // reset any ANSI escape code graphics
    jqconsole.Write("\x1b[0m");
    jqconsole.Reset();
    consoleHeader();
  }
}

var serverTimeout = function() {
  var state = jqconsole.GetState();
  if (state === "input" || state === "prompt") {
    jqconsole.AbortPrompt();
  }
  jqconsole.Write("Connection to server timed out. Run trinket again to reconnect.\n");

  api.pygame.disconnect();

  pygameRunning = false;
  api.changeRunOption('run');
  $('#stillThere').hide();
  stopTimer();

  disconnectServices();
}

function stillTherePrompt() {
  $('#stillThere').show();
  startTimer();
}
function startTimer() {
  var start = Date.now()
    , duration_ms = api.getTimeoutDelay() / 2
    , duration = duration_ms / 1000
    , diff, minutes, seconds;

  function timer() {
    // get the number of seconds that have elapsed since
    // startTimer() was called

    // to count up...
    // diff = (((Date.now() - start) / 1000) | 0);

    diff = duration - (((Date.now() - start) / 1000) | 0);

    // does the same job as parseInt truncates the float
    minutes = (diff / 60) | 0;
    seconds = (diff % 60) | 0;

    minutes = minutes < 10 ? "0" + minutes : minutes;
    seconds = seconds < 10 ? "0" + seconds : seconds;

    $('#disconnect-timer').text(minutes + ":" + seconds);

    // if we're counting down
    if (diff <= 0) {
      stopTimer();

      // add one second so that the count down starts at the full duration
      // example 05:00 not 04:59
      // start = Date.now() + 1000;
    }
  }

  // we don't want to wait a full second before the timer starts
  timer();
  stillThereTimer = setInterval(timer, 1000);
}
function stopTimer() {
  if (stillThereTimer) {
    clearInterval(stillThereTimer);
  }
}

function stopServerTimer() {
  [serverTimer, stillThereTimeout].forEach(function(timer) {
    if (timer) {
      clearTimeout(timer);
    }
  });
}
function resetServerTimer() {
  stopServerTimer();
  serverTimer = setTimeout(serverTimeout, api.getTimeoutDelay());
  stillThereTimeout = setTimeout(stillTherePrompt, api.getTimeoutDelay() / 2);
}

function consoleHeader() {
  if (jqconsole) {
    jqconsole.Append('<span id="powered-by" class="jqconsole-header" aria-hidden="true">Powered by <img id="powered-by-trinket" src="' + trinketConfig.logo() + '"></span>');
  }
}

function preRun() {
  $('.reveal-modal').foundation('reveal', 'close');

  var files = editor.getAllFiles()
      , prog, key;

  for (key in trinketFiles) {
    delete trinketFiles[key];
  }

  for (key in files) {
    if (key === mainFile) {
      prog = files[key];
    }
    else {
      trinketFiles[key] = files[key];
    }
  }

  trinketAssets.length = 0;
  trinketAssets.push.apply(trinketAssets, editor.assets());

  if ($('#statusMessages').children().length) {
    $('#statusMessages').trigger('close.fndtn.alert').remove();
  }

  if (typeof api.beforeRun === 'function') {
    prog = api.beforeRun(prog);
  }

  return prog;
}

function startInput() {
  if (jqconsole.GetState() !== "input") {
    jqconsole.Input(function(input) {
      api.pygame.write(input + '\n');
      startInput();
    });
  }
}

function runCode() {
  if (pygameRunning) {
    stopCode();
    return;
  }

  var t1 = performance.now();
  api.logClientMetric({
      event_type : api._timing.runCount === 0 ? "trinket_1st_run" : "trinket_nth_run"
    , duration   : Math.floor(t1 - api._timing.run_t0)
    , session    : api._sessionId
  });
  api._timing.run_t0 = t1;
  api._timing.runCount++;

  var prog = preRun()
    , code = [{
          name    : mainFile
        , content : prog
      }]
    , key, serializedCode;

  for (key in trinketFiles) {
    code.push({
        name    : key
      , content : trinketFiles[key]
    });
  }

  code.push({
      name    : 'assets'
    , content : trinketAssets.slice()
  });

  serializedCode = JSON.stringify(code);

  var active = document.activeElement;

  $('#reset-output').show();
  $("#errorConnecting").hide();

  var done = initConsole("Connecting to server", "run");

  var conn_options = {
      socket_options : {
          reconnection : false
        , query        : $.param(api.metadata())
      }
    , handlers : {
        'instance ready' : function(instanceData) {
          var api = this;

          done();

          api.pygame.connected(true);
          api.pygame.running(true);
          api.pygame.reconnect(false);

          var resetOnce = false;
          var settingUpDone = settingUp();

          initGraphicsOutput();
          initConsoleOutput();
          adjustGraphicDimensions();

          api.rfbAttempts = 0;
          api.rfbMaxAttempts = 25;

          function rfb_connect(e) {
            // try connecting to audiostream...
            try {
              audiostream.connect(instanceData.audioUrl, audioCallback);
            } catch(e) {
              // message somewhere that sound is not going to work
              audioCallback(true);
            }
          }

          function audioCallback(audioDisabled) {
            settingUpDone();

            var doneRunning = running();

            // will likely need this to be smarter, e.g. if input has been called...
            var $canvas = $('#graphic').find('canvas');
            $canvas.focus();

            var resetTimerEvent = _.throttle(function() {
              resetServerTimer();
            }, 2000);

            var resetTimerOptions = {
              passive : true,
              capture : false
            };

            // canvas is destroyed on stop so don't think
            // we need to remove these event listeners between runs
            ['mousemove', 'touchmove', 'keydown', 'click', 'touchstart'].forEach(function(e) {
              $canvas[0].addEventListener(e, resetTimerEvent, resetTimerOptions);
            });

            // now run code
            api.pygame.run(
                serializedCode
              , {
                  child_ready : function() {
                    resetOnce = doneRunning(resetOnce, function() {
                      $('#powered-by').append(' <span class="jqconsole-header" aria-hidden="true">Connected...\n</span>');
                      var $canvas = $('#graphic').find('canvas');
                      $canvas.focus();

                      if (audioDisabled) {
                        jqconsole.Append('<span class="jqconsole-header" aria-hidden="true">Audio is disabled.\n</span>');
                      }
                    });

                    pygameRunning = true;
                    api.changeRunOption('stop');

                    resetServerTimer();
                  },
                  stdout : function(out) {
                    resetOnce = doneRunning(resetOnce, function() {
                      jqconsole.Write(out);
                      $('#pygame-console-output').addClass('console-active');
                      startInput();

                      resetServerTimer();
                    });
                  },
                  clear : function() {
                    resetOnce = doneRunning(resetOnce, function() {
                      jqconsole.Clear();
                      consoleHeader();
                    });
                  },
                  script_error : function(data) {
                    initConsoleOutput();
                    resetOnce = doneRunning(resetOnce, function() {
                      jqconsole.Write(data.error, 'jqconsole-error');
                    });
                    disconnectServices();
                  },
                  exit : function() {
                    resetOnce = doneRunning(resetOnce, function() {
                      if (jqconsole.GetState() === "input") {
                        jqconsole.AbortPrompt();
                      }
                    });

                    $('#pygame-console-output').removeClass('console-active');
                    api.pygame.running(false);
                    api.pygame.disconnect();

                    pygameRunning = false;
                    api.changeRunOption('run');

                    disconnectServices();
                  },
                  file_added : function(data) {
                    var file = {
                      name : data.name
                    };

                    if (data.image) {
                      file.content = data.url;
                      resetOnce = doneRunning(resetOnce, function() {
                        var img = '<img src="' + file.content + '" title="' + file.name + '" />\
                          <br /><div class="jqconsole-popout-link"><a href="' + file.content + '" title="Open image in new window" \
                          target="_blank">' + file.name + '</a></div>';

                        jqconsole.Write(img, null, false);
                      });
                    }
                    else if (data.binary) {
                      file.binary = true;
                      editor.addFile(file, { override : true });
                    }
                    else if (data.html) {
                      file.content = data.url;
                      resetOnce = doneRunning(resetOnce, function() {
                        var iframe = '<iframe src="' + file.content + '" width="100%" height="600" frameborder="0" marginwidth="0" marginheight="0" allowfullscreen></iframe>\
                          <br /><div class="jqconsole-popout-link"><a href="' + file.content + '" title="Open page in new window" \
                          target="_blank">' + file.name + '</a></div>';

                        jqconsole.Write(iframe, null, false);
                      });
                    }
                    else {
                      file.content = data.content;
                      editor.addFile(file, { override : true });
                    }

                    resetServerTimer();
                  },
                  shell_connect_error : function() {
                    initConsoleOutput();
                    resetOnce = doneRunning(resetOnce, function() {
                      jqconsole.Write("Connection to server failed. Run trinket to try again.\n");
                    });
                  }
                }
            ); // end api.pygame.run
          } // end audioCallback

          function rfb_disconnect(e) {
            if (api.rfbAttempts < api.rfbMaxAttempts && e.detail.clean === false) {
              getRFB();
            }
            else {
              // report problem if not clean disconnect?
              if (active && !disableAceEditor) {
                // restore focus to the previously focused element
                $(active).focus();
              }
            }
          }

          function getRFB() {
            if (api.rfbAttempts > 0) {
              api.rfb.removeEventListener('connect',    rfb_connect);
              api.rfb.removeEventListener('disconnect', rfb_disconnect);
            }

            api.rfbAttempts++;
            api.rfb = new api.RFB(document.getElementById('graphic'), instanceData.rfbUrl, {
              isMobile: $('body').data('is-mobile'),
            });

            api.rfb.scaleViewport = true;

            api.rfb.addEventListener('connect',    rfb_connect);
            api.rfb.addEventListener('disconnect', rfb_disconnect);
          }

          api.loadRFB().then(getRFB);

        }.bind(api),
        'unavailable' : function() {
          done();
          jqconsole.Append('<span class="jqconsole-header" aria-hidden="true">\nAll pygame servers are currently busy. Please try again.\n</span>');
        },
        'disconnect' : function() { // if the socket.io connection is disconnected
          $('#pygame-console-output').removeClass('console-active');
          api.pygame.running(false);
          api.pygame.disconnect();

          pygameRunning = false;
          api.changeRunOption('run');

          disconnectServices();
          jqconsole.Append('<span class="jqconsole-header" aria-hidden="true">\nDisconnected\n</span>');
        }
      }
  };

  api.pygame.getConnection(conn_options).then(function() {
  }, function(err) {
    done();
    jqconsole.Write("Connection to server failed. Run trinket to try again.\n");
  });

  // if this is not an autorun and the dom focus has not changed
  // during the script execution then re-focus the editor
  if (!autoRun && active === document.activeElement) {
    if ($('#editor').css('display') != 'none') {
      api.focus();
    }
    // Don't refocus if Ace is disabled in settings (for accessibility)
    else if (!disableAceEditor) {
      $('#honeypot').focus();
    }
  }

  api.updateMetric('runs', serializedCode);
  if (!codeRuns[serializedCode] && api.isModified()) {
    api.sendAnalytics('Interaction', {
      action   : 'Modify',
      label    : 'Code'
    });
  }

  api.markCodeAsRun(serializedCode);
}

function stopCode(options) {
  api.pygame.stop();
  disconnectServices();
}

function disconnectServices() {
  try {
    if (api.rfb) {
      api.rfb.disconnect();
      api.rfb = null;
    }
  } catch(e) { }

  try {
    audiostream.disconnect();
  } catch(e) { }
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

window.addEventListener('resize', function() {
  adjustGraphicDimensions();
});

window.TrinketAPI = {
  initialize : function(trinket) {
    api         = this;
    start       = $('#start-value').val();
    autoRun     = (start === 'result') && !$('body').hasClass('has-status-bar');

    var uiType  = api.getUIType();

    editorSettings = {
        showTabs     : !this._queryString.outputOnly
      , noEditor     : !!this._queryString.outputOnly
      , tabSize      : window.userSettings && window.userSettings.pythonTab || 2
      , lineWrapping : window.userSettings && window.userSettings.lineWrapping || false
      , mainFileName : mainFile
      , showInfo     : false
      , assets       : (window.trinket && window.trinket.config && window.trinket.config.assetsEnabled) ? (trinket.assets ? trinket.assets.slice() : []) : false
      , guest        : uiType === 'guest' ? true : false
      , owner        : uiType === 'owner' ? true : false
      , canHideTabs  : api.hasPermission('hide-trinket-files')

        // TODO: must also be owner of this trinket - eventually convert to actual permissions based check on trinket
      , canAddInlineComments : api.hasPermission('add-trinket-inline-comments') && (uiType === 'owner' || api.assignmentFeedback)
      , assignmentViewOnly   : api.assignmentViewOnly
      , userId               : api.getUserId()
      , lang                 : 'pygame'
      , acceptedFiles        : 'image/jpeg,image/png,image/gif,image/jpg,audio/*,.ttf'
      , disableAceEditor     : disableAceEditor
    };
    editor = $('#editor').codeEditor(editorSettings).data('trinket-codeEditor');

    api.pygame = new Server('pygame', api);

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

    $('#pygame-console-output').click(function() {
      if (jqconsole && (jqconsole.GetState() === 'input' || jqconsole.GetState() === 'prompt')) {
        jqconsole.Focus();
      }
    });

    $('#reset-output').click(function() {
      resetOutput(true);
    });

    $(document).on('assets.change', function() {
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
    $(document).on('trinket.timer.reset',  $.proxy(this.stillThereReset, this));

    $(document).on('trinket.output.view',       $.proxy(api.showOutput, api));
    $(document).on('trinket.instructions.view', $.proxy(api.showInstructions, api));

    $('#editorToggleWrapper').keydown($.proxy(this.editorToggleFieldset, this));
    $('#toolbarEditorToggle').change($.proxy(this.toolbarEditorToggle, this));

    this.viewer = '#codeOutput';
    this.outputView = 'result';

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

    $('#modalRun').click(function() {
      sendInterfaceAnalytics(this);
      $('#runFirstModal').foundation('reveal', 'close');
      runCode();
    });

    api.reset(trinket);

    editor.change(function() {
      api.triggerChange();
    });

    api.draggable(function() {
      window.dispatchEvent(new Event('resize'));
    });

    $('#output-dragbar').mousedown(function(e) {
      e.preventDefault();

      var outputTabsHeight = $('#outputTabs').height();
      var containerHeight  = $('.trinket-content-wrapper').height() - outputTabsHeight;
      var containerTop     = $('.trinket-content-wrapper').offset().top + outputTabsHeight;
      var dragbarHeight    = $('#output-dragbar').height();
      $(document).on('mousemove.output-dragbar', function(e) {
        var topHeight    = e.pageY - containerTop - dragbarHeight/2;
        var bottomHeight = containerHeight - topHeight - dragbarHeight/2;
        if (topHeight >= 20 && bottomHeight >= 20) {
          $('#graphic-wrap').css('height', topHeight);
          $('#console-wrap').css('height', bottomHeight);

          // will work for IE?
          window.dispatchEvent(new Event('resize'));
        }
      });

      $(document).on('mouseup.output-dragbar', function(e) {
        $(document).off('mousemove.output-dragbar mouseup.output-dragbar');
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

    if (api._queryString && api._trinket.description && api._queryString.showInstructions && api._trinket.description.length) {
      $(document).trigger('trinket.instructions.view');
    }

    // logmetric that trinket loaded
    var t1 = performance.now();
    api.logClientMetric({
        event_type : "trinket_loaded"
      , duration   : Math.floor(t1 - api._timing.t0)
      , session    : api._sessionId
    });
    api._timing.run_t0 = t1;
    api._timing.runCount = 0;
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
    return 'pygame';
  },
  getLabel : function() {
    return 'Pygame';
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

    return false;
  },
  getAnalyticsCategory : function() {
    return 'Pygame';
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
  },
  showResult : function(event) {
    if (!$('#loadingContent').hasClass('hide')) {
      $('#loadingContent').addClass('hide');
    }

    if (event && $(event.target).data('button') === 'run') {
      api.changeRunOption('run');
    }

    $('#codeOutput').removeClass('hide');
    $('#editor').addClass('hide');
    api.closeOverlay('#modules');

    $('#instructionsContainer').addClass('hide');
    $('#outputContainer').removeClass('hide');

    $('#codeOutputTab').addClass('active');
    $('#instructionsTab').removeClass('active');

    runCode();
    if (event) {
      api.sendAnalytics('Interaction', {
        action   : 'Click',
        label    : 'Run'
      });
    }
  },
  stopExecution : function(event) {
    stopCode();
    pygameRunning = false;
    api.changeRunOption('run');
  },
  stillThereReset : function() {
    $('#stillThere').hide();
    stopTimer();
    resetServerTimer();
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
  },
  reset : function(trinket) {
    editor.reset(trinket.code);
    editor.assets(trinket.assets ? trinket.assets.slice() : []);
    if (trinket.code && (start === 'result') && autoRun !== false) {
      this.showResult();
    }
    else {
      this.showCode();
      resetOutput();
    }
  },
  focus : function() {
    if (!$('body').data('is-mobile') && $('body').data('autofocus')) {
      editor.focus();
    }
  },
  goToStart : function() {
    editor.focus(0);
  },
  markCodeAsRun : function(code) {
    codeRuns[code] = true;
  },
  downloadable : function() {
    var owner = this.getUIType() === 'owner'
      , remix;

    if (this._trinket && this._trinket._origin_id) {
      remix = this._trinket._origin_id;
    }

    return {
      files  : owner && !remix ? editor.getAllFiles() : editor.getAllVisibleFiles(),
      assets : editor.assets()
    };
  },
  changeRunOption : function(option) {
    var icon_classes = {
        run     : 'fa fa-play'
      , stop    : 'fa fa-stop'
    };
    var titles = {
        run     : 'View the result.'
      , stop    : 'Stop program.'
    };
    var labels = {
        run     : 'Run'
      , stop    : 'Stop'
    };

    $('.run-it').data('action', 'code.' + option);
    $('.run-it').attr('title', titles[option]);
    $('.run-it').find('label').text(labels[option]);
    $('.run-it').find('i').removeClass().addClass( icon_classes[option] );

    stopServerTimer();
  },
  loadRFB : function() {
    var deferred = $.Deferred()
      , self     = this;

    if (self.RFB) {
      return deferred.resolve();
    }

    SystemJS.import( $('body').data('systemjs-import') ).then(function(rfb) {
      self.RFB = rfb.default;
      return deferred.resolve();
    });

    return deferred;
  },

  setWrap: function(wrap) {
    editor.setWrap(wrap)
    this.setAPILineWrap(wrap)
  },

  setIndent: function(indent) {
    editor.setIndent(indent);
    this.setAPIIndent(indent, undefined, undefined, undefined);
  },

  saveClientSnapshot : function() {
    return true;
  },
  replaceMain : function(trinket, initial) {
    editor.setValue(trinket.code);
    editor.assets(trinket.assets ? trinket.assets.slice() : []);

    if (!initial) {
      updateImageAssets();
    }
  },
  captureAndSaveSnapshot : function(done) {
    var $canvas = $('#graphic canvas')
      , snapshot;

    if ($canvas.length) {
      snapshot = $canvas.get(0).toDataURL("image/png");
    }

    done(snapshot);
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
  onKeyboardToggle : function() {
    var inputElement = document.getElementById('noVNC_keyboardinput');
    inputElement.style.visibility = 'visible'; // unhide the input
    inputElement.focus(); // focus on it so keyboard pops
    //inputElement.style.visibility = 'hidden'; // hide it again
  }
};

})(window, window.TrinketIO);
