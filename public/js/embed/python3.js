(function(window, TrinketIO) {
var api;
var codeRuns = {};
var editor;
var HintPlugin;
var start, selectedTab, runOption;
var autoRun  = undefined;
var jqconsole;
var trinketFiles = {};
var trinketAssets = [];
var mainFile = "main.py";
var GUID     = TrinketIO.import('utils.guid');
var template = TrinketIO.import('utils.template');
var ActivityLog = TrinketIO.import('embed.analytics.activity');

var Server = TrinketIO.import('embed.server');
var serverTimer;
var initInterval;
var runningInterval;

var disableAceEditor = window.userSettings && window.userSettings.disableAceEditor || false;
var poweredByText = $('body').data('powered-by-text') || 'Powered by';

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

function initConsole(msg, mode) {
  if (initInterval) {
    window.clearInterval(initInterval);
  }

  $('#console-wrap').removeClass('hide');
  $('#console-wrap').css('height', '100%');
  if (!jqconsole) {
    jqconsole = $('#python3-console-output').jqconsole();
  }

  if (mode === 'console') {
    $('#python3-console-output').addClass('console-mode');
  } else {
    $('#python3-console-output').removeClass('console-mode');
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

function running() {
  if (runningInterval) {
    window.clearInterval(runningInterval);
  }

  runningInterval = startStatusIndicator('Running');

  return function(resetOnce, done) {
    window.clearInterval(runningInterval);
    clearStatus();
    if (!resetOnce) {
      // Don't reset output here - just clear status
    }
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

function showError(errorMsg) {
  clearStatus();
  if ($('#console-error').length === 0) {
    jqconsole.Append('<span id="console-error" class="jqconsole-error"></span>\n');
  }
  $('#console-error').text(errorMsg);
}

function resetOutput() {
  if (jqconsole) {
    // reset any ANSI escape code graphics
    jqconsole.Write("\x1b[0m");
    jqconsole.Reset();
    consoleHeader();
  }
}

function consoleHeader() {
  if (jqconsole) {
    jqconsole.Append('<span class="jqconsole-header" aria-hidden="true">' + poweredByText + ' <img id="powered-by-trinket" src="' + trinketConfig.logo() + '">\n</span>');
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
      api.python3.write(input + '\n');
      startInput();
    });
  }
}

function runCode() {
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

  api.python3.getConnection().then(function() {
    done();

    api.python3.connected(true);
    api.python3.running(true);
    api.python3.reconnect(false);

    var doneRunning = running();
    var resetOnce   = false;

    api.python3.run(
        serializedCode
      , {
          child_ready : function() {
            resetOnce = doneRunning(resetOnce, function() {
              $('#python3-console-output').addClass('console-active');
              startInput();
            });
          },
          stdout : function(out) {
            resetOnce = doneRunning(resetOnce, function() {
              jqconsole.Write(out);
              $('#python3-console-output').addClass('console-active');
              startInput();
            });
          },
          clear : function() {
            resetOnce = doneRunning(resetOnce, function() {
              jqconsole.Clear();
              consoleHeader();
            });
          },
          script_error : function(data) {
            if (data.type && data.type === 'pygame') {
              resetOnce = doneRunning(resetOnce, function() {
                api.showMessage('info', 'It looks like you\'re using a Python 3 visual module. Would you like to <a href="/pygame" class="text-link" target="_blank">run this code in a Pygame trinket</a>?');
              });
            }
            else {
              resetOnce = doneRunning(resetOnce, function() {
                jqconsole.Write(data.error, 'jqconsole-error');
              });
            }
          },
          exit : function() {
            resetOnce = doneRunning(resetOnce, function() {
              if (jqconsole.GetState() === "input") {
                jqconsole.AbortPrompt();
              }
            });

            $('#python3-console-output').removeClass('console-active');
            api.python3.running(false);
            api.python3.disconnect();
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
          },
          shell_connect_error : function() {
            resetOnce = doneRunning(resetOnce, function() {
              jqconsole.Write("Server connection lost. Click Run to try again.\n", 'jqconsole-error');
            });
          }
        }
    );
  }, function(err) {
    done();
    var errorMsg = err && err.message ? err.message : "Connection to server failed.";
    jqconsole.Write(errorMsg + "\n\nClick Run to try again.\n", 'jqconsole-error');
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

function runConsole() {
  var prog = preRun()
    , serializedCode = api.getValue()
    , history = []
    , input;

  if (prog) {
    history = prog.split('\n');
  }

  $('#reset-output').hide();
  $("#errorConnecting").hide();

  var done = initConsole("Connecting to server", "console");

  var serverTimeout = function() {
    var state = jqconsole.GetState();
    if (state === "input" || state === "prompt") {
      jqconsole.AbortPrompt();
    }
    jqconsole.Write("Connection to server timed out. Run trinket again to reconnect.\n");
    api.python3.disconnect();
  }

  var options_callback = function() {
    api.sendAnalytics('Interaction', {
      action : 'Modify',
      label  : 'Code'
    });

    if (serverTimer) {
      clearTimeout(serverTimer);
    }
    serverTimer = setTimeout(serverTimeout, api.getTimeoutDelay());
  }

  api.python3.getConnection().then(function() {
    done();

    api.python3.connected(true);
    api.python3.running(true);
    api.python3.reconnect(false);

    api.python3.setHistory(history);

    if (serverTimer) {
      clearTimeout(serverTimer);
    }
    serverTimer = setTimeout(serverTimeout, api.getTimeoutDelay());

    api.python3.startPrompt(jqconsole, {
      init : true,
      files : trinketFiles,
      stdout_callback : function(out) {
        if (serverTimer) {
          clearTimeout(serverTimer);
        }
        serverTimer = setTimeout(serverTimeout, api.getTimeoutDelay());

        return {
            output       : out
          , continuation : false
        };
      },
      clear : function() {
        jqconsole.Clear();
        consoleHeader();
      },
      script_error : function(data) {
        jqconsole.Write(data.error, 'jqconsole-error');
      },
      done_error_handler : function(data) {
        if (data.type && data.type === 'pygame') {
          jqconsole.Write('It looks like you\'re using a Python 3 visual module. Would you like to <a href="/pygame" class="text-link" target="_blank">run this code in a Pygame trinket</a>?', 'jqconsole-info', false);
        }
        else {
          data.error = data.error.replace(/</g, '&lt;');
          jqconsole.Write(data.error, 'jqconsole-error', false);
        }
      },
      callback : options_callback,
      file_added : function(data) {
        var file = {
          name : data.name
        };

        if (data.image) {
          file.content = data.url;

          var img = '<img src="' + file.content + '" title="' + file.name + '" />\
            <br /><div class="jqconsole-popout-link"><a href="' + file.content + '" title="Open image in new window" \
            target="_blank">' + file.name + '</a></div>';

          jqconsole.Write(img, null, false);

          if (serverTimer) {
            clearTimeout(serverTimer);
          }
          serverTimer = setTimeout(serverTimeout, api.getTimeoutDelay());
        }
        else if (data.html) {
          file.content = data.url;

          var iframe = '<iframe src="' + file.content + '" width="100%" height="600" frameborder="0" marginwidth="0" marginheight="0" allowfullscreen></iframe>\
            <br /><div class="jqconsole-popout-link"><a href="' + file.content + '" title="Open page in new window" \
            target="_blank">' + file.name + '</a></div>';

          jqconsole.Write(iframe, null, false);

          if (serverTimer) {
            clearTimeout(serverTimer);
          }
          serverTimer = setTimeout(serverTimeout, api.getTimeoutDelay());
        }
        else {
          file.content = data.content;
          editor.addFile(file, { override : true });
        }
      },
      shell_connect_error : function() {
        jqconsole.Write("Server connection lost. Click Run to try again.\n", 'jqconsole-error');
      },
      multiline_callback : function(input, cb) {
        options_callback();

        var multilineReturn = false
          , indent, last_line, lines;

        lines = input.split('\n');
        if (lines.length === 0) {
          cb(0);
        }
        else {
          last_line = lines[lines.length - 1];
          indent = last_line.match(/^\s*/)[0];
          last_line = lines[lines.length - 1].replace(/\s+$/, '');

          if (/"""/.test(last_line) && !/""".*"""/.test(last_line)) {
            this.inMultilineString = !this.inMultilineString;
          }
          else if (/'''/.test(last_line) && !/'''.*'''/.test(last_line)) {
            this.inMultilineString = !this.inMultilineString;
          }

          if (this.inMultilineString) {
            multilineReturn = 0;
          }
          // start of python block, possibly followed by a comment
          else if (!/^\s*#/.test(last_line) && /:(?:\s*#.*)*/.test(last_line)) {
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
          }

          cb(multilineReturn);

          if (multilineReturn !== false && jqconsole._enteringHistory) {
            api.python3.enterHistory(jqconsole);
          }
        }
      },
      async_multiline: true
    });
  }, function(err) {
    done();
    var errorMsg = err && err.message ? err.message : "Connection to server failed.";
    jqconsole.Write(errorMsg + "\n\nClick Run to try again.\n", 'jqconsole-error');
  });
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
    api         = this;
    start       = $('#start-value').val();
    runOption   = $('#runOption-value').val();
    api.runMode = $('#runMode-value').val();
    autoRun     = (start === 'result') && !$('body').hasClass('has-status-bar');

    var uiType  = api.getUIType();

    var assetsEnabled = window.trinket && window.trinket.config && window.trinket.config.assetsEnabled;
    var assetsValue = !assetsEnabled || $('body').data('no-assets') ? false : trinket.assets ? trinket.assets.slice() : [];

    editor = $('#editor').codeEditor({
        showTabs     : !this._queryString.outputOnly
      , noEditor     : !!this._queryString.outputOnly
      , mainFileName : mainFile
      , tabSize      : window.userSettings && window.userSettings.pythonTab || 2
      , lineWrapping : window.userSettings && window.userSettings.lineWrapping || false
      , showInfo     : false
      , assets       : assetsValue
      , guest        : uiType === 'guest' ? true : false
      , owner        : uiType === 'owner' ? true : false
      , canHideTabs  : api.hasPermission('hide-trinket-files')

        // TODO: must also be owner of this trinket - eventually convert to actual permissions based check on trinket
      , canAddInlineComments : api.hasPermission('add-trinket-inline-comments') && (uiType === 'owner' || api.assignmentFeedback)
      , assignmentViewOnly   : api.assignmentViewOnly
      , userId               : api.getUserId()
      , lang                 : 'python3'
      , assetsHowTo          : '#assets-howto-message'
      , acceptedFiles        : 'image/jpeg,image/png,image/gif,image/jpg,.sqlite3,.db,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.sqlite3,application/x-sqlite3,.csv,.tsv,.txt'
      , disableAceEditor     : disableAceEditor
    }).data('trinket-codeEditor');

    api.python3 = new Server('python3', api);

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

    $('#python3-console-output').click(function() {
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
    $(document).on('trinket.code.console', $.proxy(this.consoleResult, this));

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

    api.draggable();

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
    return 'python3';
  },
  getLabel : function() {
    return 'Python 3';
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
    return 'Python3';
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
    if (runOption !== 'run' && event && $(event.target).data('button') === 'run') {
      api.changeRunOption('run');
    }
    api.runMode = '';
    api.triggerRunModeChange();
    api.hasRun = true;

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
  consoleResult : function(event) {
    if (runOption !== 'console' && event && $(event.target).data('button') === 'console') {
      api.changeRunOption('console');
    }
    api.runMode = 'console';
    api.triggerRunModeChange();

    $('#codeOutput').removeClass('hide');
    $('#editor').addClass('hide');
    api.closeOverlay('#modules');

    $('#instructionsContainer').addClass('hide');
    $('#outputContainer').removeClass('hide');

    $('#codeOutputTab').addClass('active');
    $('#instructionsTab').removeClass('active');

    runConsole();
    if (event) {
      api.sendAnalytics('Interaction', {
        action   : 'Click',
        label    : 'Console'
      });
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
  },
  reset : function(trinket) {
    editor.reset(trinket.code);
    editor.assets(trinket.assets ? trinket.assets.slice() : []);
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
      run : 'fa fa-play',
      console : 'fa fa-terminal'
    };
    var titles = {
      run : 'View the result.',
      console : 'Run code interactively.'
    };
    $('.run-it').data('action', 'code.' + option);
    $('.run-it').attr('title', titles[option]);
    $('.run-it').find('i').removeClass().addClass( icon_classes[option] );
    runOption = option;
    if (serverTimer) {
      clearTimeout(serverTimer);
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
      var node = document.querySelector("#python3-console-output");
      htmlToImage.toPng(node, { width: 300, height: 300 })
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
