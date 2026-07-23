(function(window, TrinketIO) {
var api;
var codeRuns = {};
var editor;
var $skulptFocusLayer;
var usingTurtle = false;
var start, selectedTab;
var errorState;
var Skulpt = TrinketIO.import('Skulpt');
var isConsoleOpen = false;
var isGraphicOpen = false;
var template = TrinketIO.import('utils.template');
var blocksShared = TrinketIO.import('blocks.shared');
var jqconsole;
var evaluate = Skulpt({
  write : function(text) {
    initConsoleOutput();
    text = text.replace(/\0(33)\[/g, "\x1b[");
    jqconsole.Write(text);
  },
  inputfun : function(prompt) {
    initConsoleOutput();

    window.readyForSnapshot = true;

    return new Promise(function(resolve, reject) {
      // capture the element that currently has focus
      var active = document.activeElement;
      jqconsole.Write(prompt);
      $('#console-output').addClass('console-active');
      jqconsole.Input(function(input) {
        $('#console-output').removeClass('console-active');
        resolve(input);
        if (active) {
          // restore focus to the previously focused element
          $(active).focus();
        }
      });
      if (!autoRun) {
        jqconsole.Focus();
      }
    });
  },
  onGraphicsInit : function() {
    if (isGraphicOpen) return;

    isGraphicOpen = true;
    $('#graphic-wrap').removeClass('hide');
    if (isConsoleOpen) {
      showSplitOutput();
    }
    else {
      $('#graphic-wrap').css('height', '100%');
    }
  },
  onAfterImport : function(library) {
    if (api._queryString.snapshot) {
      if (!Sk.TurtleGraphics) {
        Sk.TurtleGraphics = {};
      }
      Sk.TurtleGraphics.animate = false;
      Sk.TurtleGraphics.allowUndo = false;
      Sk.TurtleGraphics.width = 320;
      Sk.TurtleGraphics.height = 320;
    }
  }
});
var autoRun = undefined;

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
  jqconsole.Write('Powered by <img src="' + trinketConfig.logo() + '">\n', 'jqconsole-header', false);
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
  if (jqconsole) {
    // reset any ANSI escape code graphics
    jqconsole.Write("\x1b[0m");
    jqconsole.Reset();
    jqconsole.Write('Powered by <img src="' + trinketConfig.logo() + '">\n', 'jqconsole-header', false);
  }

  if (!consoleOnly) {
    $('#graphic').empty();
    $('#graphic').removeData("graphicMode");
  }
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

function runCode() {
  $('.reveal-modal').foundation('reveal', 'close');

  Blockly.Python.disableInitVariables_ = true;

  var xml      = Blockly.Xml.workspaceToDom(Blockly.mainWorkspace),
      xml_text = Blockly.Xml.domToText(xml),
      prog     = Blockly.Python.workspaceToCode(Blockly.mainWorkspace),
      $graphic = $('#graphic');

  resetOutput();

  if (errorState) {
    $('#statusMessages').trigger('close.fndtn.alert').remove();
  }

  usingTurtle = false;
  getSkulptFocusLayer().addClass('hide');

  var active = document.activeElement;

  evaluate(prog, function() {
    errorState = false;
    autoRun = undefined;
    window.readyForSnapshot = true;
  }, function(err) {
    errorState = true;
    autoRun = undefined;
    window.readyForSnapshot = true;
  }, function() {
    // execution halted!
    window.readyForSnapshot = true;
  });

  autoRun = false;
  
  if (usingTurtle) {
    $('#graphic').focus();
  }

  api.updateMetric('runs', xml_text);
  if (!codeRuns[xml_text] && api.isModified()) {
    api.sendAnalytics('Interaction', {
      action   : 'Modify',
      label    : 'Code'
    });
  }

  codeRuns[xml_text] = true;
};

window.TrinketAPI = {
  initialize : function(trinket) {
    api   = this;

    start = $('#start-value').val();
    autoRun = (start === 'result');

    $(document).on('trinket.code.edit',   $.proxy(this.showCode, this));
    $(document).on('trinket.code.run',    $.proxy(this.showResult, this));
    $(document).on('trinket.code.view',   $.proxy(this.toggleCodeView, this));
    $(document).on('trinket.output.view', $.proxy(this.toggleOutputView, this));

    $(document).on('trinket.instructions.view', $.proxy(api.showInstructions, api));

    $(document).on('trinket.code.pythonfromblocks', $.proxy(this.createPythonTrinket, this));

    api.$uploadModal      = $('#uploadModal');
    api.upload_xml        = "";
    api.upload_modal_open = false;

    blocksShared(api);

    $(document).on('trinket.code.replace-blocks', $.proxy(this.replaceBlocks, this));
    $(document).on('trinket.code.add-blocks',     $.proxy(this.addBlocks, this));

    this.viewer = '#codeOutput';
    this.outputView = 'result';

    $('#console-output').click(function() {
      if (jqconsole && (jqconsole.GetState() === 'input' || jqconsole.GetState() === 'prompt')) {
        jqconsole.Focus();
      }
    });

    $('#reset-output').click(function() {
      resetOutput(true);
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
      $('#runFirstModal').foundation('reveal', 'close');
      api.toggleOutputView();
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
    });

    if (api._queryString && api._trinket.description && api._queryString.showInstructions && api._trinket.description.length) {
      $(document).trigger('trinket.instructions.view');
    }
  },
  getType : function() {
    return 'blocks';
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
    return 'Blocks';
  },
  serialize : function() {
    return {
      code : this.getValue()
    }
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
    api.focus();
  },
  showResult : function(event) {
    $('#codeOutput').removeClass('hide');
    $('#editor').addClass('hide');

    $('#codeOutputTab').addClass('active');
    $('#codeViewTab').removeClass('active');
    $('#instructionsTab').removeClass('active');

    $('#blocklyCodeContainer').addClass('hide');
    $('#instructionsContainer').addClass('hide');
    $('#outputContainer').removeClass('hide');

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
  updateCodeView : function() {
    try {
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

      $('#blocklyPythonCode').html('<pre><code class="hljs">' + highlighted + '</code></pre>');

      // make create python trinket link visible
      $('#createPythonLink').removeClass('hide');

    } catch(e) {
      $('#blocklyPythonCode').html('<p class="blocks-codeview-message">We had a problem translating your blocks to python. Please check your code and try again.</p>');
      $('#createPythonLink').addClass('hide');
    }
  },
  createPythonTrinket : function() {
    var self = this
      , python, data, shortCode, html, message, $msg;

    try {
      Blockly.Python.disableInitVariables_ = true;
      python = Blockly.Python.workspaceToCode(Blockly.mainWorkspace);
    } catch(e) {
    }

    if (typeof python !== "undefined") {
      data = {
          lang : "python"
        , code : python
      };

      if (this._trinket && this._trinket.name) {
        data.name = this._trinket.name + " (python)";
      }

      $.post('/api/trinkets?library=true', data).done(function(result) {
        shortCode = result.data.shortCode;

        if (self._userId) {
          message = 'A python version of this trinket has been created for you. View or edit <a class="text-link" href="/library/trinkets/' + shortCode + '" target="_blank">your trinket here</a>.';
        }
        else {
          message = 'A python version of this trinket has been created. View or remix <a class="text-link" href="/python/' + shortCode + '" target="_blank">the trinket here</a>.';
        }

        html = template('statusMessageTemplate', {
            type    : 'success'
          , message : message
        });
        $msg = $(html);
        $('body').addClass('has-status-bar').append($msg);
        $msg.parent().foundation().trigger('open.fndtn.alert');
      });
    }
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

    if (trinket.code && (start === 'result') && autoRun !== false) {
      this.showResult();
    }
    else {
      this.showCode();
      $('#console-output').html('');
      $('#graphic').html('');
    }
  },
  downloadable : function() {
    return {
      files  : {
        "trinket_blocks.xml" : this.getValue({ "pretty" : true })
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
