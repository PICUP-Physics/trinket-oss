(function(window, TrinketIO) {
var api;
var codeRuns = {};
var editor;
var start, selectedTab;
var isConsoleOpen = false;
var isGraphicOpen = false;
var jqconsole;
var GUID     = TrinketIO.import('utils.guid');
var template = TrinketIO.import('utils.template');
var ActivityLog = TrinketIO.import('embed.analytics.activity');
var blocksShared = TrinketIO.import('blocks.shared');

var defaultCode;
var defaultVersion; // initialized in initialize call below
var defaultLanguage = "VPython";
var autoRun         = undefined;

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

function initConsoleOutput($output) {
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
  jqconsole.Write('Powered by <img src="' + trinketConfig.logo() + '">\n', 'jqconsole-header', false);
}

function showSplitOutput() {
  if ($('#output-dragbar').hasClass('hide')) {
    $('#output-dragbar').removeClass('hide');
    var containerHeight = $('.trinket-content-wrapper').height();
    var dragbarHeight   = $('#output-dragbar').height();
    var topHeight    = (containerHeight*.8) - dragbarHeight/2;
    var bottomHeight = containerHeight - topHeight - dragbarHeight/2;
    $('#graphic-wrap').css('height', topHeight);
    $('#console-wrap').css('height', bottomHeight);
  }
}

function resetOutput() {
  if (jqconsole) {
    // reset any ANSI escape code graphics
    jqconsole.Write("\x1b[0m");
    jqconsole.Reset();
    jqconsole.Write('Powered by <img src="' + trinketConfig.logo() + '">\n', 'jqconsole-header', false);
  }
}

/**
 * Run code using local sandboxed iframe (srcdoc)
 */
function runCodeLocal(html) {
  var sandboxAttr = trinketSandboxConfig.localPermissions || 'allow-scripts allow-forms allow-modals allow-popups';
  $('#glowscriptOutput').attr('sandbox', sandboxAttr);
  $('#glowscriptOutput').attr('srcdoc', html);

  $('#glowscriptOutput').one('load', function() {
    $('#loadingContent').hide();
    $('#glowscriptOutput').focus();
  });
}

/**
 * Run code using external sandbox server
 */
function runCodeExternal(html) {
  var sandboxUrl = trinketSandboxConfig.protocol + '://' + trinketSandboxConfig.subdomain + trinketSandboxConfig.domain + '/';
  var files = { 'index.html': html };

  $.post(sandboxUrl, {files: files})
    .done(function(data, status) {
      if (status === "success") {
        $('#glowscriptOutput').attr('src', sandboxUrl + data.token + "/index.html")
        $('#glowscriptOutput').one('load', function() {
          $('#loadingContent').hide();
          $('#glowscriptOutput').focus();
        });
      }
    });
}

function runCode() {
  $('.reveal-modal').foundation('reveal', 'close');

  var xml      = Blockly.Xml.workspaceToDom(Blockly.mainWorkspace),
      xml_text = Blockly.Xml.domToText(xml),
      prog     = Blockly.Python.workspaceToCode(Blockly.mainWorkspace);

  // need to add first line for glowscript?

  var $graphic = $('#graphic');

  resetOutput();

  if ($('#statusMessages').children().length) {
    $('#statusMessages').trigger('close.fndtn.alert').remove();
  }

  if (typeof api.beforeRun === 'function') {
    prog = api.beforeRun(prog);
  }

  var active = document.activeElement;

  // pull version from first line or use default from config
  var version  = defaultVersion;

  // default language
  var language = defaultLanguage;

  var progLines = prog.split(/\n/);

  // GlowScript [major.minor] [lang]
  if (/^GlowScript/.test(progLines[0])) {
    var match = progLines[0].match(/^GlowScript (\d\.\d) (\w+)/);
    if (match) {
      // verify these are valid
      version  = match[1];
      language = match[2];

      prog = progLines.slice(1).join("\n");
    }
  }

  if (!trinketAppConfig.versionMap[version]) {
    api.showMessage('alert', 'Invalid version of GlowScript.');
    return;
  }

  language = language.toLowerCase();

  var prefix         = trinketAppConfig.prefix;
  var trinketVersion = trinketAppConfig.versionMap[version].trinket;
  var jquerySrcs     = _.map(trinketAppConfig.versionMap[version].jquerySrcs, function(src) {
    return "<script src='" + src + "'></script>";
  });

  var glowscriptHtml = template('glowscriptTemplate', {
    prog       : prog,
    url        : trinketAppConfig.url,
    domain     : trinketAppConfig.domain,
    prefix     : prefix,
    lang       : language,
    version    : trinketVersion,
    jqueryList : jquerySrcs.join("\n")
  });

  $("#loadingContent").show();

  // Choose rendering mode based on configuration
  if (trinketSandboxConfig.mode === 'local') {
    runCodeLocal(glowscriptHtml);
  } else {
    runCodeExternal(glowscriptHtml);
  }

  api.updateMetric('runs', xml_text);
  if (!codeRuns[xml_text] && api.isModified()) {
    api.sendAnalytics('Interaction', {
      action   : 'Modify',
      label    : 'Code'
    });
  }

  api.markCodeAsRun(xml_text);
};

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
    autoRun = (start === 'result');

    this._errorGroup    = 0;
    this._sessionId     = GUID();
    this._previousError = undefined;

    $(document).on('trinket.code.edit',   $.proxy(this.showCode, this));
    $(document).on('trinket.code.run',    $.proxy(this.showResult, this));
    $(document).on('trinket.code.view',   $.proxy(this.toggleCodeView, this));
    $(document).on('trinket.output.view', $.proxy(this.toggleOutputView, this));

    $(document).on('trinket.instructions.view', $.proxy(api.showInstructions, api));

    api.$uploadModal      = $('#uploadModal');
    api.upload_xml        = "";
    api.upload_modal_open = false;

    blocksShared(api);

    defaultVersion = trinketAppConfig.version;
    defaultCode    = "GlowScript " + defaultVersion + " VPython\n";

    $(document).on('trinket.code.replace-blocks', $.proxy(this.replaceBlocks, this));
    $(document).on('trinket.code.add-blocks',     $.proxy(this.addBlocks, this));

    this.viewer = '#codeOutput';
    this.outputView = 'result';

    $(document).on('trinket.code.help', $.proxy(this.toggleHelp, this));

    $('#reset-output').click(function() {
      resetOutput();
    });

    $('#menu').on(
      'trinket.sharing.share trinket.sharing.embed trinket.sharing.email',
      function(evt) {
        if (api.isModified() && !codeRuns[api.getValue()]) {
          $('#runFirstModal').foundation('reveal', 'open');
          evt.preventDefault();
        }
      }
    );

    $('#modalRun').click(function() {
      sendInterfaceAnalytics(this);
      $('#runFirstModal').foundation('reveal', 'close');
      runCode();
    });

    window.blocklyLoaded = function(blockly) {
      window.Blockly = blockly;
      api.reset(trinket.code ? trinket : api._trinket);

      Blockly.mainWorkspace.addChangeListener(function(event) {
        var xml      = Blockly.Xml.workspaceToDom(Blockly.mainWorkspace);
        var xml_text = Blockly.Xml.domToText(xml);

        // compare before triggering change
        if (xml_text !== api._original.code) {
          api.triggerChange();
        }

        if (api.outputView === 'code') {
          api.updateCodeView();
        }
      });
      Blockly.mainWorkspace.getCanvas().addEventListener("blocklySelectChange", function() {
        if (api.outputView === 'code') {
          api.updateCodeView();
        }
      });
    };

    api.draggable();

    $('#output-dragbar').mousedown(function(e) {
      e.preventDefault();

      var containerHeight = $('.trinket-content-wrapper').height();
      var containerTop    = $('.trinket-content-wrapper').offset().top;
      var dragbarHeight   = $('#output-dragbar').height();
      $(document).on('mousemove.output-dragbar', function(e) {
        var topHeight    = e.pageY - containerTop - dragbarHeight/2;
        var bottomHeight = containerHeight - topHeight - dragbarHeight/2;
        if (topHeight >= 20 && bottomHeight >= 20) {
          $('#graphic-wrap').css('height', topHeight);
          $('#console-wrap').css('height', bottomHeight);
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

    window.addEventListener('message', function(e) {
      var data;

      try {
        data = JSON.parse(e.data);
      } catch(e) {}

      if (data && data["glowscript.error"]) {
        api.showMessage('alert', data["glowscript.error"]);

        var errorData = {
            state   : "encountered" // encountered, repeated, resolved
          , session : api._sessionId
          , group   : 0
          , error   : data["glowscript.error"]
          , type    : data.type
          , message : data["glowscript.error"]
          , code    : api.getValue()
          , attempt : 0
        };

        api.logError(errorData);
      }
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
  getType : function() {
    return 'glowscript-blocks';
  },
  getValue : function(opts) {
    var xml, xml_text;

    try {
      // Blockly may not be loaded on certain pages, e.g. in-app detail view
      xml      = Blockly.Xml.workspaceToDom(Blockly.mainWorkspace);
      xml_text = opts && opts.pretty ? Blockly.Xml.domToPrettyText(xml) : Blockly.Xml.domToText(xml);
    } catch(e) {
      xml_text = this._original.code;
    }

    return xml_text;
  },
  getAnalyticsCategory : function() {
    return 'GlowScriptBlocks';
  },
  serialize : function(opts) {
    var serialized = {
      code : this.getValue(opts)
    };

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
    api.closeOverlay('#help');
    api.focus();
  },
  showResult : function(event) {
    $('#codeOutput').removeClass('hide');
    $('#editor').addClass('hide');
    api.closeOverlay('#help');

    $('#blocklyCodeContainer').addClass('hide');
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
  toggleCodeView : function() {
    this.outputView = 'code';

    $('#codeViewTab').addClass('active');
    $('#codeOutputTab').removeClass('active');
    $('#instructionsTab').removeClass('active');

    this.updateCodeView();

    $('#outputContainer').addClass('hide');
    $('#instructionsContainer').addClass('hide');
    $('#blocklyCodeContainer').removeClass('hide');

    api.sendAnalytics('Interaction', {
      action : 'Click',
      label  : 'Source'
    });
  },
  toggleOutputView : function(event) {
    this.outputView = 'result';

    $('#codeOutputTab').addClass('active');
    $('#codeViewTab').removeClass('active');
    $('#instructionsTab').removeClass('active');

    $('#outputContainer').removeClass('hide');
    $('#blocklyCodeContainer').addClass('hide');
    $('#instructionsContainer').addClass('hide');

    runCode();

    if (event) {
      api.sendAnalytics('Interaction', {
        action   : 'Click',
        label    : 'Run'
      });
    }
  },
  toggleHelp : function() {
    if ($('#glowscriptExample').hasClass("hide")) {
      var highlighted = hljs.highlight('python', $('#glowscriptExample').text()).value;
      $('#glowscriptExample').replaceWith("<code class='hljs'>" + highlighted + "</code>");
    }
    api.toggleOverlay('#help');
  },
  saveClientSnapshot : function() {
    return true;
  },
  captureAndSaveSnapshot : function(done) {
    var doneCalled = false;

    var snapshotHandler = function(event) {
      var data;

      try {
        data = JSON.parse(event.data);
      } catch(e) {}

      // make sure event listener only called once
      window.removeEventListener('message', snapshotHandler);

      if (data && data.snapshot) {
        done(data.snapshot);
      }
      else {
        done();
      }

      doneCalled = true;
    }

    // setup event listener
    window.addEventListener('message', snapshotHandler);

    // post message to iframe to take snapshot
    $('#glowscriptOutput')[0].contentWindow.postMessage('glowscript.snapshot', '*');

    // ensure done is called
    setTimeout(function() {
      if (!doneCalled) {
        done();
      }
    }, 2000);
  },
  hideAll : function() {
    this.toggleHelp();
  },
  updateCodeView : function() {
    Blockly.Python.disableInitVariables_ = true;

    Blockly.Python.mapBlocks_ = true;
    var highlighted = Blockly.Python.workspaceToCode(Blockly.mainWorkspace);
    Blockly.Python.mapBlocks_ = false;

    function stripSourceMap(str) {
      return str
        .replace(/\/\*\* \S+ \*\*\//g, '')
        .replace(/\/\*\* end \S+ \*\*\//g, '');
    }

    if (Blockly.selected) {
      highlighted = highlighted
        .replace(/&/gm, '&amp;').replace(/</gm, '&lt;').replace(/>/gm, '&gt;')
        .replace('/** ' + Blockly.selected.id + ' **/', '<span class="block-selected">')
        .replace('/** end ' + Blockly.selected.id + ' **/', '</span>');

      highlighted = stripSourceMap(highlighted);
    } else {
      highlighted = stripSourceMap(highlighted);
      highlighted = hljs.highlight('python', highlighted).value;
    }

    // explicitly add GlowScript version string
    highlighted = defaultCode + "\n" + highlighted;

    $('#blocklyCodeContainer').html('<pre><code class="hljs">' + highlighted + '</code></pre>');
  },
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
    if (!window.Blockly) return;

    Blockly.mainWorkspace.clear();
    if (trinket.code) {
      var xml = Blockly.Xml.textToDom(trinket.code);
      Blockly.Xml.domToWorkspace(xml, Blockly.mainWorkspace);
    }

    if (trinket.code && (start === 'result')) {
      this.showResult();
    }
    else {
      this.showCode();
      resetOutput();
    }
  },
  markCodeAsRun : function(code) {
    codeRuns[code] = true;
  },
  downloadable : function() {
    return {
      files  : {
        "trinket_glowscript_blocks.xml" : this.getValue({ "pretty" : true })
      },
      assets : []
    };
  },
  onUploadClick : function() {
    api.resetUpload();
    this.$uploadModal.foundation('reveal', 'open');
    this.upload_modal_open = true;
  },
  replaceBlocks : function() {
    Blockly.mainWorkspace.clear();
    Blockly.Xml.domToWorkspace(this.upload_xml, Blockly.mainWorkspace);
    $('#uploadModal').foundation('reveal', 'close');
    this.upload_modal_open = false;
    this.showMessage('success', 'Your blocks have been added.');
  },
  addBlocks : function() {
    Blockly.Xml.domToWorkspace(this.upload_xml, Blockly.mainWorkspace);
    $('#uploadModal').foundation('reveal', 'close');
    this.upload_modal_open = false;
    this.showMessage('success', 'Your blocks have been added on top of any existing blocks.');
  },
  resetUpload : function() {
    this.upload_xml = "";

    $('#blocks-upload-filename').text('[No file selected]');
    $('.blocks-button').addClass('disabled');

    $('#uploadMessage').empty();
    $('#uploadMessage').addClass('hide');
  }
};

})(window, window.TrinketIO);
