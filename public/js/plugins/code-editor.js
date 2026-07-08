/**
 * MODIFIED VERSION of the jQuery Lined Textarea Plugin
 *   https://github.com/aw20/JQueryLinedText
 *
 * Copyright (c) 2010 Alan Williamson
 *
 * Version:
 *    $Id: jquery-linedtextarea.js 464 2010-01-08 10:36:33Z alan $
 *
 * Released under the MIT License:
 *    http://www.opensource.org/licenses/mit-license.php
 *
 * Usage:
 *   Displays a line number count column to the left of the textarea
 *
 *   Class up your textarea with a given class, or target it directly
 *   with JQuery Selectors
 *
 *   $(".lined").linedtextarea({
 *    selectedLine: 10,
 *    selectedClass: 'lineselect'
 *   });
 *
 * History:
 *   - 2010.01.08: Fixed a Google Chrome layout problem
 *   - 2010.01.07: Refactored code for speed/readability; Fixed horizontal sizing
 *   - 2010.01.06: Initial Release
 *
 */
(function($, TrinketIO, ace) {
  var template = TrinketIO.import('utils.template');
  var INFO_CACHE        = {};

  // by id
  var WIDGET_CACHE      = {};
  var COMMENT_COLLAPSED = {};

  // by file and position
  var FILE_WIDGETS      = [];

  // default tabSize
  var DEFAULT_TAB_SIZE  = 2;

  /*
   * Helper function to make sure the line numbers are always
   * kept up to the current system
   */
  function fillOutLines(codeLines, h, lineNo, selectedLine){
    var max = 100;
    while ( --max > 0 && (codeLines.height() - h ) <= 0 ){
      if ( lineNo == selectedLine )
        codeLines.append("<div class='lineno lineselect _lineno_" + lineNo + "_' role='presentation'>" + lineNo + "</div>");
      else
        codeLines.append("<div class='lineno _lineno_" + lineNo + "_' role='presentation'>" + lineNo + "</div>");

      lineNo++;
    }
    return lineNo;
  };

  var mobileCommands    = {};
  var mobileCommandsMap = {
    'Enter' : {
      keyCodes : [10,13]
    },
    'Ctrl'  : 'ctrlKey',
    'Shift' : 'shiftKey'
  };

  function createMobileAPI(el, opts) {
    var lineNo   = 1;
    var wrapper  = $(el);
    var textarea = $('<textarea class="lined" autocorrect="off" autocapitalize="off" spellcheck="false" tabindex="0" role="textbox" aria-multiline="true" aria-label="Code Editor"></textarea>');

    textarea.on('focus', function() {
      textarea[0].setSelectionRange(0, 0);
    });

    wrapper.append(textarea);

    /* Turn off the wrapping of as we don't want to screw up the line numbers */
    textarea.attr("wrap", "off");
    textarea.css({resize:'none'});

    /* Wrap the text area in the elements we need */
    textarea.wrap("<div class='linedtextarea' role='tabpanel'></div>");
    var linedTextAreaDiv  = textarea.parent().wrap("<div class='linedwrap'></div>");
    var linedWrapDiv      = linedTextAreaDiv.parent();

    linedWrapDiv.prepend("<div class='lines' aria-hidden='true'></div>");

    var linesDiv  = linedWrapDiv.find(".lines");

    /* Draw the number bar; filling it out where necessary */
    linesDiv.append( "<div class='codelines' data-filename='" + opts.name + "' role='presentation'></div>" );
    var codeLinesDiv  = linesDiv.find(".codelines");
    lineNo = fillOutLines( codeLinesDiv, linesDiv.height(), 1, opts.selectedLine );

    /* Move the textarea to the selected line */
    if ( opts.selectedLine != -1 && !isNaN(opts.selectedLine) ){
      var fontSize = parseInt( textarea.height() / (lineNo-2) );
      var position = parseInt( fontSize * opts.selectedLine ) - (textarea.height()/2);
      textarea[0].scrollTop = position;
    }

    var redraw = _.throttle(function(tn){
      var domTextArea   = textarea[0];
      var scrollTop     = domTextArea.scrollTop;
      var clientHeight  = domTextArea.clientHeight;
      codeLinesDiv.css( {'margin-top': (-1*scrollTop) + "px"} );
      lineNo = fillOutLines( codeLinesDiv, scrollTop + clientHeight, lineNo, opts.selectedLine );
    }, 50);

    /* React to the scroll event */
    textarea.scroll(redraw);

    if (opts.onFocus) {
      textarea.on("focus", opts.onFocus);
    }

    if (opts.value) {
      textarea.val(opts.value, -1);
    }

    /* Should the textarea get resized outside of our control */
    $(window).on('resize', redraw);

    return {
      registerPlugin : function(plugin, codeEditor) {
      },
      destroy : function() {
        linedWrapDiv.remove();
        textarea.remove();
        wrapper.empty();
        $(window).off('resize', redraw);
      },
      addCommand : function(name, key, fn) {
        if (typeof mobileCommands[name] === 'undefined') {
          mobileCommands[name] = {
              key : key
            , fn  : fn
          };
        }

        var keyParts = key.win.split('-');

        if (keyParts.length === 2 || keyParts.length === 3) {
          textarea.keydown(function(e) {
            var callFn = false;
            if (keyParts.length === 2) {
              if (mobileCommandsMap[ keyParts[1] ].keyCodes.indexOf( e.keyCode ) >= 0
              &&  e[ mobileCommandsMap[ keyParts[0] ] ]) {
                callFn = true;
              }
            }
            else if (keyParts.length === 3) {
              if (mobileCommandsMap[ keyParts[2] ].keyCodes.indexOf( e.keyCode ) >= 0
              &&  e[ mobileCommandsMap[ keyParts[0] ] ]
              &&  e[ mobileCommandsMap[ keyParts[1] ] ]) {
                callFn = true;
              }
            }

            if (callFn) {
              fn.call();
            }
          });
        }

        return;
      },
      change : function(cb) {
        return textarea.on('input propertychange', cb);
      },
      setValue : function(value) {
        textarea.val(value, -1);
      },
      getValue : function() {
        return textarea.val();
      },
      focus : function(position) {
        if (position !== 'undefined') {
          textarea.focus();
          return textarea[0].setSelectionRange(position, 0);
        }
        else {
          return textarea.focus();
        }
      },
      blur : function() {
        return textarea.blur();
      },
      isFocused : function() {
        return textarea.is(":focus");
      },
      setModeFromName : function(name) {},
      resize: function() {},
      highlight: function(line_num) {
        $('.codelines[data-filename="' + opts.name + '"]').find('._lineno_' + line_num + '_').addClass('lineselect');
        $('textarea.lined').addClass('attention-error');
      },
      addQueueMarkers : function() {}
    };
  }

  /**

   Mostly the same as the ace version with some specific UI elements and internal data synchronization.

   TODO / BUGS:

   -- a comment is removed by nature of a line being removed, need some method to undo

   */
  function updateOnChange(onCommentChange, onCommentRemove, fileIndex, delta) {
    var lineWidgets = this.getSession().lineWidgets
      , startRow    = delta.start.row
      , len         = delta.end.row - startRow
      , startLine, startLineLen;

    if (len === 0) return;

    startLine    = this.getSession().getLine(delta.start.row);
    startLineLen = startLine.length;

    if (lineWidgets) {
      if (delta.action == 'remove') {
        if (!delta.start.column && FILE_WIDGETS[fileIndex][delta.start.row + 1]) {
          startRow--;
        }

        var removedVisible = lineWidgets.splice(startRow + 1, len);
        var removedAll     = FILE_WIDGETS[fileIndex].splice(startRow + 1, len);

        removedVisible.forEach(function(w) {
          if (w) {
            this.removeLineWidget(w);
          }
        }, this.getSession().widgetManager);

        removedAll.forEach(function(w) {
          if (w) {
            delete WIDGET_CACHE[ w._commentId ];
            onCommentRemove({
                _id   : w._commentId
              , index : w._file
            });
            this.removeGutterDecoration(w.row, "trinket-comment");
            this.removeGutterDecoration(w.row, "data-" + w._file + "-" + w._commentId);
            if (COMMENT_COLLAPSED[w._commentId]) {
              this.removeGutterDecoration(w.row, "collapsed");
            }
            else {
              this.removeGutterDecoration(w.row, "open");
            }
          }
        }, this.getSession());
      }
      else {
        // if starting line has content and cursor is at the end of the line,
        // increment startRow so that the comment on this line doesn't move down
        if (startLineLen && startLineLen === delta.start.column) {
          startRow++;
        }

        var args = new Array(len);
        args.unshift(startRow, 0);
        lineWidgets.splice.apply(lineWidgets, args);
        FILE_WIDGETS[fileIndex].splice.apply(FILE_WIDGETS[fileIndex], args);
      }

      var noWidgets = true;
      FILE_WIDGETS[fileIndex].forEach(function(w, i) {
        if (w) {
          noWidgets = false;
          if (w.row !== i) {
            // onCommentChange changes the internal w.row
            onCommentChange(w._file, w._commentId, i, true);
          }
        }
      });
      if (noWidgets) {
        this.getSession().lineWidgets = null;
      }
    } // end if line widgets
    else {
      if (delta.action == 'remove') {
        if (!delta.start.column && FILE_WIDGETS[fileIndex][delta.start.row + 1]) {
          startRow--;
        }

        var removed = FILE_WIDGETS[fileIndex].splice(startRow + 1, len);
        removed.forEach(function(w) {
          if (w) {
            delete WIDGET_CACHE[ w._commentId ];
            onCommentRemove({
                _id   : w._commentId
              , index : w._file
            });
            this.removeGutterDecoration(w.row, "trinket-comment");
            this.removeGutterDecoration(w.row, "data-" + w._file + "-" + w._commentId);
            if (COMMENT_COLLAPSED[w._commentId]) {
              this.removeGutterDecoration(w.row, "collapsed");
            }
            else {
              this.removeGutterDecoration(w.row, "open");
            }
          }
        }, this.getSession());
      }
      else {
        if (startLineLen && startLineLen === delta.start.column) {
          startRow++;
        }

        var args = new Array(len);
        args.unshift(startRow, 0);
        FILE_WIDGETS[fileIndex].splice.apply(FILE_WIDGETS[fileIndex], args);
      }

      FILE_WIDGETS[fileIndex].forEach(function(w, i) {
        if (w && w.row !== i) {
          onCommentChange(w._file, w._commentId, i, true);
        }
      });
    }
  }

  function createDesktopAPI(el, opts) {
    var modes          = ace.require('ace/ext/modelist')
        , mode         = modes.getModeForPath('foo.' + opts.ext)
        , Range        = ace.require('ace/range').Range
        , LineWidgets  = ace.require('ace/line_widgets').LineWidgets
        , dom          = ace.require("ace/lib/dom")
        , e            = ace.edit(el)
        , queueMarkers = []
        , errorMarkers = []
        , userInfo     = {};

    e.$blockScrolling = Infinity;
    e.setTheme("ace/theme/xcode");
    e.getSession().setMode(mode ? mode.mode : "ace/mode/text");
    e.getSession().setUseSoftTabs(true);

    // fail safe
    if (opts.editorOpts) {
      e.getSession().setTabSize(opts.editorOpts.tabSize);
      e.getSession().setUseWrapMode(opts.editorOpts.lineWrapping);
    } else {
      e.getSession().setTabSize(DEFAULT_TAB_SIZE);
    }

    e.setShowPrintMargin(false);
    e.setFontSize('inherit');
    e._fileName = opts.name;
    e._addErrorBorder = false;

    var deleteCommand     = e.commands.byName.del;
    var backspaceCommand  = e.commands.byName.backspace;
    var removelineCommand = e.commands.byName.removeline;

    function showCommentWarning(message) {
      // make sure any existing alert is closed
      $('.comment-warning').find('.close').click();
      $(el).append(COMMENT_WARNING_TEMPLATE({
        message : message
      }));
      $(document).foundation('alert', 'reflow');
    }

    function keydownHandler(event) {
      // don't show message if keycode between 16 and 20
      // these are various keys such as ctrl, alt, shift, caps lock, etc.
      if (event.which >= 16 && event.which <= 20) {
        return;
      }

      showCommentWarning('Since one or more selected lines has a comment, first remove any comments or move them to other lines.');
    }

    e.commands.addCommand({
        name    : backspaceCommand.name
      , bindKey : backspaceCommand.bindKey
      , exec    : function(editor) {
          var cursor = editor.getSession().selection.getCursor();

          // if comment on this row and previous row or previous row has content, disable backspace
          if (cursor.column === 0 && cursor.row > 0
          && FILE_WIDGETS[opts.index] && FILE_WIDGETS[opts.index][cursor.row]
          && (FILE_WIDGETS[opts.index][cursor.row - 1] || editor.getSession().getLine(cursor.row - 1).length)) {
            showCommentWarning('Since this line has a comment, first remove the comment or move it to another line.');
          }
          else {
            $('.comment-warning').find('.close').click();
            backspaceCommand.exec.call(this, editor);
          }
        }
    });

    e.commands.addCommand({
        name    : deleteCommand.name
      , bindKey : deleteCommand.bindKey
      , exec    : function(editor) {
          var cursor     = editor.getSession().selection.getCursor()
            , lineLength = editor.getSession().getLine(cursor.row).length;

          // if cursor at end of line and comment on this or next line
          if (cursor.column === lineLength && FILE_WIDGETS[opts.index]) {
            if (FILE_WIDGETS[opts.index][cursor.row]) {
              showCommentWarning('Since this line has a comment, first remove the comment or move it to another line.');
            }
            else if (FILE_WIDGETS[opts.index][cursor.row + 1]) {
              showCommentWarning('Since the next line has a comment, first remove the comment or move it to another line.');
            }
          }
          else {
            $('.comment-warning').find('.close').click();
            deleteCommand.exec.call(this, editor);
          }
        }
    });

    e.commands.addCommand({
        name    : removelineCommand.name
      , bindKey : removelineCommand.bindKey
      , exec    : function(editor) {
          var cursor = editor.getSession().selection.getCursor();

          // if comment on this line, disable removeline command (Ctrl-D)
          if (FILE_WIDGETS[opts.index] && FILE_WIDGETS[opts.index][cursor.row]) {
            showCommentWarning('To remove lines with comments, first remove the comment or move it to another line.');
          }
          else {
            $('.comment-warning').find('.close').click();
            removelineCommand.exec.call(this, editor);
          }
        }
    });

    // remove any notifications when the cursor moves
    e.getSession().selection.on("changeCursor", function() {
      $('.comment-warning').find('.close').click();
    });

    // check for comments when lines are selected
    e.getSession().selection.on("changeSelection", function(event) {
      if (FILE_WIDGETS[opts.index] && !e.getSession().selection.isEmpty() && e.getSession().selection.isMultiLine()) {
        var range  = e.getSession().selection.getRange()
          , set_ro = false
          , row;

        for (row = range.start.row; row <= range.end.row; row++) {
          if (FILE_WIDGETS[opts.index][row]) {
            set_ro = true;
          }
        }

        e.setReadOnly(set_ro);

        if (set_ro) {
          // if read only and keydown handler not bound...
          if (!$(e.textInput.getElement()).data('keydown-handler')) {
            $(e.textInput.getElement()).on('keydown.trinket-comment', keydownHandler);
            $(e.textInput.getElement()).data('keydown-handler', true);
          }
        }
        else {
          // else unbind keydown handler if bound
          if ($(e.textInput.getElement()).data('keydown-handler')) {
            $(e.textInput.getElement()).off('keydown.trinket-comment', keydownHandler);
            $(e.textInput.getElement()).removeData('keydown-handler');
          }
          $('.comment-warning').find('.close').click();
        }
      }
      else {
        e.setReadOnly(false);
        if ($(e.textInput.getElement()).data('keydown-handler')) {
          $(e.textInput.getElement()).off('keydown.trinket-comment', keydownHandler);
          $(e.textInput.getElement()).removeData('keydown-handler');
        }
        $('.comment-warning').find('.close').click();
      }
    });

    if (opts.value) {
      e.getSession().setValue(opts.value);
    }

    if (opts.onFocus) {
      e.on("focus", opts.onFocus);
    }

    // apply and render existing comments
    if (opts.comments && opts.comments.length) {
      var getUserInfo = function(userId) {
        if (userInfo[userId]) {
          return $.Deferred().resolve(userInfo[userId]).promise();
        }
        else {
          return $.get("/api/users/" + userId + "/info");
        }
      }

      var session = e.session;
      if (!session.widgetManager) {
        session.widgetManager = new LineWidgets(session, {
          updateOnChange : updateOnChange.bind(e, opts.onCommentChange, opts.onCommentRemove, opts.index)
        });
        session.widgetManager.attach(e);
      }

      var docLength = session.getDocument().getLength();

      function renderComment(comment) {
        var commentText    = comment.text
          , commentHtml    = commentText.replace(/(?:\r\n|\r|\n)/g, '<br />')
          , commentedOn    = moment(comment.commentedOn).fromNow()
          , row            = comment.row
          , commentId      = comment._id
          , index          = comment.index
          , edited         = comment.edited ? "(edited)" : ""
          , collapsed      = COMMENT_COLLAPSED[commentId] = comment.collapsed || false
          , commentActions, commentActionsTemplate, commentSeed;

        if (opts.editorOpts.canAddInlineComments && opts.editorOpts.userId === comment.userId) {
          commentActionsTemplate = "inlineCommentActions";
        }
        else if (!opts.editorOpts.assignmentViewOnly) {
          commentActionsTemplate = "inlineCommentDismiss";
        }

        commentActions = template(commentActionsTemplate, {
            commentId    : commentId
          , index        : index
        });

        return $.when(getUserInfo(comment.userId)).done(function(_user) {
          // TODO: figure out caching - this doesn't work
          userInfo[comment.userId] = _user;

          var commentTmpl = template('inlineCommentTemplate', {
              comment        : commentHtml
            , avatar         : _user.avatar
            , commentedOn    : commentedOn
            , username       : _user.username
            , commentId      : commentId
            , edited         : edited
            , commentText    : commentText
            , commentActions : commentActions
          });

          var _el = dom.createElement("div");
          _el.innerHTML = commentTmpl;

          var w = {
              row        : row
            , fixedWidth : true
            , el         : _el
            , _file      : index
            , _commentId : commentId
            , _text      : commentText
          };

          w.destroy = function() {
            session.widgetManager.removeLineWidget(w);
            FILE_WIDGETS[index][row] = undefined;
          }

          if (!collapsed) {
            w = e.session.widgetManager.addLineWidget(w);
          }

          WIDGET_CACHE[commentId] = w;
          if (!FILE_WIDGETS[index]) {
            FILE_WIDGETS[index] = [];
          }
          FILE_WIDGETS[index][row] = w;

          // add comment style
          e.session.addGutterDecoration(row, "trinket-comment");

          if (collapsed) {
            e.session.addGutterDecoration(row, "collapsed");
          }
          else {
            e.session.addGutterDecoration(row, "open");
          }

          // adds data for expanding/collapsing
          e.session.addGutterDecoration(row, "data-" + index + "-" + commentId);

          $(w.el).find('.confirm-remove-comment').on('click', function(event) {
            w.destroy();
          });
        });
      } // renderComment

      var promises = [];
      for (var i = 0; i < opts.comments.length; i++) {
        promises.push(renderComment(opts.comments[i]));
      }

      // update move arrows
      $.when.apply($, promises).then(function() {
        updateCommentArrows(session, opts.index);
      });

    } // end if comments

    return {
      actuallySetWrap: function(wrap) {
        e.getSession().setUseWrapMode(wrap)
      },
      actuallySetIndent: function(indent) {
        e.getSession().setTabSize(indent)
      },
      registerPlugin : function(plugin, codeEditor) {
        plugin.initialize(e, codeEditor);
      },
      destroy : function() {
        e.destroy();
        $(el).empty();
      },
      addCommand : function(name, key, fn) {
        e.commands.addCommand({
          name: name,
          bindKey: key,
          exec: fn
        });
      },
      change : function(cb) {
        var self = this;
        return e.getSession().on('change', function() {
          self.removeMarkers();
          cb();
        });
      },
      setValue : function(value) {
        e.setValue(value, -1);
      },
      getValue : function() {
        return e.getValue();
      },
      focus : function(position) {
        if (position === 0) {
          e.navigateFileStart()
        }
        else if (position === -1) {
          e.navigateFileEnd();
        }

        return e.focus();
      },
      blur : function() {
        e.blur();
      },
      isFocused : function() {
        return e.isFocused();
      },
      setModeFromName : function(name) {
        var mode = modes.getModeForPath(name);
        var old  = e._fileName;
        e._fileName = name;
        e._emit("file.rename", {oldName:old, newName:name});
        e.getSession().setMode(mode ? mode.mode : "ace/mode/text");
      },
      resize: function(force) {
        e.resize(force);
      },
      highlight: function(line_num, queue) {
        var line  = e.getSession().getLine(line_num - 1);
        if (queue) {
          queueMarkers.push(line_num);
          e._addErrorBorder = true;
        }
        else {
          var range = new Range(line_num - 1, 0, line_num - 1, line.length);
          errorMarkers.push(e.getSession().addMarker(range, 'highlight-line-error', 'fullLine'));
          $('.ace_content').addClass('attention-error');
        }
      },
      addQueueMarkers : function() {
        for (var i = 0; i < queueMarkers.length; i++) {
          this.highlight(queueMarkers[i]);
        }
        queueMarkers = [];
        if (e._addErrorBorder) {
          $('.ace_content').addClass('attention-error');
          e._addErrorBorder = false;
        }
      },
      removeMarkers : function() {
        for (var i = 0; i < errorMarkers.length; i++) {
          e.getSession().removeMarker(errorMarkers[i]);
        }
        errorMarkers = [];
        queueMarkers = [];
      },
      getSession : function() {
        return e.getSession();
      },
      setReadOnly: function(readOnly) {
        e.setReadOnly(readOnly);
      },
      scrollToLine : function(line, center, animate, callback) {
        e.scrollToLine(line, center, animate, callback);
      },
      aceInstance: e,
      renderer: e.renderer,
      keyBinding : e.keyBinding,
      addCommentWidget : function() {
        var userId    = this.options.userId
          , avatarSrc = '/api/users/' + userId + '/avatar'
          , username  = $('#whoami').val()
          , userInfo  = '/api/users/' + userId + '/info'
          , index     = opts.index
          , curPos, curWidget, session, _el, w, $textarea;

        curPos    = e.getCursorPosition();
        curWidget = _.findKey(WIDGET_CACHE, function(widget) {
          return widget.row === curPos.row && widget._file === index;
        });

        if (curWidget) {
          // trigger edit of current comment
          if (COMMENT_COLLAPSED[curWidget]) {
            // trigger open first if collapsed
            $("div.ace_gutter-cell.trinket-comment.data-" + index + "-" + curWidget).trigger("click");
          }
          $("a.edit-inline-comment[data-comment-id='" + curWidget + "']").trigger("click");
          return;
        }

        // add new comment
        session = e.session;
        if (!session.widgetManager) {
          session.widgetManager = new LineWidgets(session, {
            updateOnChange : updateOnChange.bind(e, opts.onCommentChange, opts.onCommentRemove, index)
          });
          session.widgetManager.attach(e);
        }

        e.scrollToLine(curPos.row, true, true);

        _el = dom.createElement("div");
        _el.innerHTML = template('addInlineCommentTemplate', {
            avatar    : avatarSrc
          , username  : username
          , commentId : index + "_" + curPos.row
          , index     : index
        });

        w = {
            row        : curPos.row
          , fixedWidth : true
          , el         : _el
          , _file      : index
          , _commentId : index + "_" + curPos.row
        };

        w.destroy = function() {
          session.widgetManager.removeLineWidget(w);
          delete WIDGET_CACHE[w._commentId];
          updateCommentArrows(session, w._file);
        }

        w = session.widgetManager.addLineWidget(w);
        WIDGET_CACHE[w._commentId] = w;

        updateCommentArrows(session, index);

        $textarea = $(w.el).find('textarea.inline-comment-text');
        $textarea.focus();

        $(w.el).find('.cancel-inline-comment').on('click', function(event) {
          // TODO: confirm if some text entered?
          w.destroy();
        });

        $(w.el).find('.save-inline-comment').on('click', function(event) {
          var commentText  = $textarea.val();
          var commentHtml  = commentText.replace(/(?:\r\n|\r|\n)/g, '<br />');
          var commentedOn  = moment().subtract(2, 'seconds');
          var commentSeed  = e._fileName + w.row + commentedOn;
          var commentId    = CryptoJS.MD5(commentSeed).toString(CryptoJS.enc.Hex).substring(0, 16)

          var commentActions = template('inlineCommentActions', {
              commentId    : commentId
            , index        : index
          });

          var commentTmpl = template('inlineCommentTemplate', {
              comment        : commentHtml
            , avatar         : avatarSrc
            , username       : username
            , commentedOn    : commentedOn.fromNow()
            , commentText    : commentText
            , commentActions : commentActions
            , commentId      : commentId
          });

          var _el = dom.createElement("div");
          _el.innerHTML = commentTmpl;

          $(document).foundation('dropdown', 'reflow');

          var cw = {
              row        : w.row
            , fixedWidth : true
            , el         : _el
            , _file      : index
            , _commentId : commentId
            , _text      : commentText
          };

          cw.destroy = function() {
            session.widgetManager.removeLineWidget(cw);
            FILE_WIDGETS[index][cw.row] = undefined;
          }

          w.destroy();

          cw = e.session.widgetManager.addLineWidget(cw);

          e.session.addGutterDecoration(cw.row, "trinket-comment");
          e.session.addGutterDecoration(cw.row, "open");
          e.session.addGutterDecoration(cw.row, "data-" + index + "-" + commentId);

          WIDGET_CACHE[commentId]      = cw;
          COMMENT_COLLAPSED[commentId] = false;
          if (!FILE_WIDGETS[index]) {
            FILE_WIDGETS[index] = [];
          }
          FILE_WIDGETS[index][cw.row] = cw;

          updateCommentArrows(session, index);

          $(el).trigger("comment.added", {
              row         : cw.row
            , text        : commentText
            , commentedOn : commentedOn
            , _id         : commentId
            , fileName    : e._fileName
            , index       : opts.index
            , userId      : userId
            , edited      : false
            , collapsed   : false
          });

          $(el).find('.confirm-remove-comment').on('click', function(event) {
            cw.destroy();
          });
        });
      }
    };
  }

  function createGhostAPI(el, opts) {
    var api = {
      value : opts.value
    };
    return {
      registerPlugin : function(plugin, codeEditor) {
      },
      destroy : function() {
        return;
      },
      addCommand : function(name, key, fn) {
        return;
      },
      change : function(cb) {
        cb();
      },
      setValue : function(value) {
        api.value = value;
        return value;
      },
      getValue : function() {
        return api.value;
      },
      focus : function() {
        return;
      },
      blur : function() {
        return;
      },
      isFocused : function() {
        return false;
      },
      setModeFromName : function(name) {},
      resize : function() {},
      highlight: function(line_num) {},
      addQueueMarkers : function() {}
    };
  }

  function createImageAPI(el, opts) {
    var $img;

    var api = {
      value : opts.value
    };

    // add img tag with opts.value as src to el
    $img = $('<img />', {
      src : opts.value
    });

    $(el).html($img);

    return {
      registerPlugin : function(plugin, codeEditor) {
      },
      destroy : function() {
        return;
      },
      addCommand : function(name, key, fn) {
        return;
      },
      change : function(cb) {
        cb();
      },
      setValue : function(value) {
        api.value = value;
        return value;
      },
      getValue : function() {
        return api.value;
      },
      focus : function() {
        return;
      },
      blur : function() {
        return;
      },
      isFocused : function() {
        return false;
      },
      setModeFromName : function(name) {},
      resize : function() {},
      highlight: function(line_num) {},
      addQueueMarkers : function() {}
    };
  }

  var $PLUGIN_TEMPLATE         = $("<div class=\"code-editor\" data-interface=\"code-editor\"><div class=\"tab-nav\"><dl class=\"left-options\"><dd class=\"tab-button\"><a class=\"tab-scroll-link left-arrow\" data-direction=\"-1\"><i class=\"fa fa-chevron-left\"></i></a></dd><dd class=\"tab-button\"><a class=\"tab-scroll-link right-arrow\" data-direction=\"1\"><i class=\"fa fa-chevron-right\"></i></a></dd></dl><dl class=\"scrollable-content\" role=\"tablist\" aria-label=\"File tabs\"></dl><dl class=\"right-options\"></dl><div class=\"clearfix\"></div></div><div class=\"file-content-container\"></div><div class=\"info-area collapsed\"><div class=\"info-quick\"></div><div class=\"scroll-wrap\"><div class=\"info-full\"></div></div><a class=\"expander fa\"></a></div></div>");

  var $CONTENT_TEMPLATE        = $("<div class=\"file-content\"></div>");
  var $BINARY_FILE_TEMPLATE    = $("<div class=\"binary-file\"><div><p>This is a binary file created by your program. It is not viewable and will not be saved with your trinket.</p></div></div>");
  var $TAB_OPTIONS_TEMPLATE    = $("<div class=\"tab-options\" role=\"button\"><ul><li><a class=\"file-remove-link menu-button\" data-action=\"file.remove\"><i class=\"fa fa-trash\"></i></a></li><li><a class=\"file-rename-link menu-button\" data-action=\"file.rename\"><i class=\"fa fa-pencil\"></i></a></li></ul></div>");

  var TAB_TEMPLATE             = template.compile("<dd class=\"tab\"><a class=\"file-tab-link\" aria-label=\"{{name}} tab\" role=\"tab\"><span class=\"file-name\">{{name}}</span><span class=\"tab-options-link menu-button\" data-action=\"file.options\" role=\"button\" tabindex=\"0\"></span></a></dd>");
  var EDITABLE_TAB_TEMPLATE    = template.compile("<input type=\"text\" class=\"file-name-input\" value=\"{{name}}\" placeholder=\"file name\" aria-label=\"Edit {{name}} filename\">");
  var FILE_NAME_ERROR_TEMPLATE = template.compile("<div data-alert class=\"file-name-error alert-box alert\">{{message}}<a class=\"close\">&times;</a></div>");
  var UNDO_REMOVE_TEMPLATE     = template.compile("<div data-alert class=\"file-remove-info alert-box info\" data-interface=\"code-editor\">The file \"{{name}}\" has been deleted. <a class=\"file-restore-link menu-button\" data-action=\"file.restore\">Undo</a><a class=\"close menu-button\" data-action=\"file-undo.close\">&times;</a></div>");

  var COMMENT_WARNING_TEMPLATE = template.compile("<div data-alert class=\"comment-warning alert-box info\">{{message}}<a class=\"close\"><i class=\"fa fa-times-circle\"></i></a></div>");

  var TAB_CLICK_EVENT         = "click.trinket-code-editor.tab-select";
  var TAB_SCROLL_START_EVENT  = "mousedown.trinket-code-editor.scroll-tabs-start touchstart.trinket-code-editor.scroll-tabs-start";
  var TAB_SCROLL_STOP_EVENT   = "mouseup.trinket-code-editor.scroll-tabs-stop touchend.trinket-code-editor.scroll-tabs-stop";
  var ADD_FILE_EVENT          = "click.trinket-code-editor.add-file";
  var UPLOAD_FILE_EVENT       = "click.trinket-code-editor.upload-file";
  var VIEW_ASSETS_EVENT       = "click.trinket-code-editor.view-assets";
  var TAB_OPTIONS_OPEN_EVENT  = "click.trinket-code-editor.tab-options-open";
  var TAB_OPTIONS_CLOSE_EVENT = "mousedown.trinket-code-editor.tab-options-close";
  var EDIT_FILE_NAME_EVENT    = "click.trinket-code-editor.edit-file-name";
  var REMOVE_FILE_EVENT       = "click.trinket-code-editor.remove-file";
  var HIDE_FILE_EVENT         = "click.trinket-code-editor.hide-file";

  var CODE_ERROR_TAB_MARKER   = '.fa.fa-exclamation-circle.warning';
  var CODE_ERROR_TAB_CLASS    = 'fa fa-exclamation-circle warning';

  var add_file_title           = $('body').data('create-text-file-title') || 'Create text file';
  var $ADD_FILE_TEMPLATE       = $("<dd class=\"tab-button\" title='" + add_file_title + "'><a class=\"add-file-link menu-button\" data-action=\"file.add\" aria-label=\"Add new file\" role=\"button\"><i class=\"fa fa-plus\"></i></a></dd>");

  var $ADD_COMMENT_TEMPLATE    = $("<dd class=\"tab-button\" title='Add comment to current line'><a class=\"add-inline-comment menu-button\" data-action=\"inline-comment.add\"><i class=\"fa fa-comment\"></i></a></dd>");
  var ADD_INLINE_COMMENT_EVENT = "click.trinket-code-editor.add-inline-comment";

  var upload_file_title        = $('body').data('upload-text-file-title') || 'Upload text file';
  var $UPLOAD_FILE_TEMPLATE    = $("<dd class=\"tab-button\" title='" + upload_file_title + "'><a class=\"upload-file-link menu-button\" data-action=\"file.upload\" aria-label=\"Upload text file\" role=\"button\"><i class=\"fa fa-upload\"></i></a></dd>");
  var $UPLOAD_FILE_INPUT       = $("<form id='file-upload-form'><input type='file' name='file-upload' id='file-upload' class='hidden' tabindex='-1'></form>");

  /**
   * Move comment to another line
   */
  function moveCommentTo(fileIndex, commentId, moveTo, skipWidget) {
    var w            = WIDGET_CACHE[commentId]
      , currentRow   = w.row
      , session      = this._files[fileIndex].editor.getSession();

    // remove gutter
    session.removeGutterDecoration(currentRow, "trinket-comment");
    session.removeGutterDecoration(currentRow, "data-" + fileIndex + "-" + commentId);

    session.addGutterDecoration(moveTo, "trinket-comment");
    session.addGutterDecoration(moveTo, "data-" + fileIndex + "-" + commentId);

    if (COMMENT_COLLAPSED[commentId]) {
      session.removeGutterDecoration(currentRow, "collapsed");
      session.addGutterDecoration(moveTo, "collapsed");
    }
    else {
      session.removeGutterDecoration(currentRow, "open");
      session.addGutterDecoration(moveTo, "open");
    }

    // skipWidget is true if lines are being added or removed from the editor
    // otherwise the user is using the arrows and we manage the moving of the widget
    if (!skipWidget) {
      session.widgetManager.removeLineWidget(w);
      w.row = moveTo;
      session.widgetManager.addLineWidget(w);

      if (!FILE_WIDGETS[fileIndex]) {
        FILE_WIDGETS[fileIndex] = [];
      }
      FILE_WIDGETS[fileIndex][currentRow] = undefined;
      FILE_WIDGETS[fileIndex][moveTo] = w;
    }
    else {
      w.row = moveTo;
    }

    updateCommentArrows(session, fileIndex);

    this._updateComment({
        _id    : commentId
      , index  : fileIndex
      , data   : {
          row : moveTo
        }
    });
  }

  /**
   * Is there a comment (line widget) on the given line
   */
  function commentOnLine(fileIndex, row) {
    return _.findKey(WIDGET_CACHE, function(widget) {
      return widget._file === fileIndex && widget.row === row;
    });
  }

  /**
   * Update all arrows after some change
   */
  function updateCommentArrows(session, index) {
    var docLength = session.getDocument().getLength();

    _.each(WIDGET_CACHE, function(val, key) {
      if (val._file === index) {
        // up
        if (!val.row || commentOnLine(val._file, val.row - 1)) {
          $(val.el).find('.move-comment-up').addClass("disabled");
        }
        else {
          $(val.el).find('.move-comment-up').removeClass("disabled");
        }

        // down
        if ( (docLength - 1) === val.row || commentOnLine(val._file, val.row + 1) ) {
          $(val.el).find('.move-comment-down').addClass("disabled");
        }
        else {
          $(val.el).find('.move-comment-down').removeClass("disabled");
        }
      }
    });
  }

  var widget = {
    options : {
      selectedLine: -1,
      selectedClass: 'lineselect',
      noEditor: false,
      state: "",
      defaultFileExt : 'txt',
      mainFileName: "main.py",
      mainEditable: false,
      mainSuffix: null,
      showTabs: false,
      addFiles: true, // sub-option to showTabs
      showInfo: false,
      assets: false,
      assetsHowTo : '',
      acceptedFiles : '',
      onFocus: function() {},
      lang: '',
      owner: false,
      canHideTabs: false,
      canAddInlineComments: false,
      userId: null,
      disableAceEditor: false,
      tabSize: DEFAULT_TAB_SIZE,
      lineWrapping: true,
      assignmentViewOnly: false
    },

    _create : function() {
      var self = this
        , state, classSettings, i
        , LineWidgets = ace ? ace.require('ace/line_widgets').LineWidgets : function() {};

      this._editor;
      this._commands = [];
      this._plugins  = [];
      this._files    = [];

      this.element.empty();
      this.element.append($PLUGIN_TEMPLATE.clone());

      // add add file option
      if (this.options.addFiles) {
        this.element.find('dl.right-options').append($ADD_FILE_TEMPLATE);

        // add upload file option if filereader supported
        if (!!window.FileReader) {
          this.element.find('dl.right-options').append($UPLOAD_FILE_TEMPLATE);
          this.element.append($UPLOAD_FILE_INPUT);
          $('#file-upload').change(function() {
            var file = $('#file-upload')[0].files[0];

            // some files seem to have an empty type, e.g. csv
            if (!file.type || file.type.match(/text.*/) || file.type.match(/json/)) {
              var reader = new FileReader();

              reader.onload = function() {
                self.addFile({
                    name    : file.name
                  , content : reader.result
                }, {
                    override : true // override ok? or prompt instead?
                });
                if (self._onChange) {
                  self._onChange();
                }
                self._selectTab(self._files.length - 1);

                // reset file upload form
                $('#file-upload-form').get(0).reset();
              }
              reader.onerror = function() {
                self.element.find('.tab-nav').after(FILE_NAME_ERROR_TEMPLATE({
                  message : "There was a problem reading your file. Please try again."
                }));
                $(document).foundation('alert', 'reflow');

                // reset file upload form
                $('#file-upload-form').get(0).reset();
              }

              reader.readAsText(file);
            }
            else {
              self.element.find('.tab-nav').after(FILE_NAME_ERROR_TEMPLATE({
                message : "Only text files are currently supported."
              }));
              $(document).foundation('alert', 'reflow');
            }
          });
        }
      }

      // add inline comment option
      if (this.options.canAddInlineComments) {
        this.element.find('dl.right-options').append($ADD_COMMENT_TEMPLATE);
      }
      else {
        // TODO: add this for everyone but change it to a modal ad if user does not have permission
      }

      this.$tabOptions = $TAB_OPTIONS_TEMPLATE.clone();

      if (this.options.canHideTabs) {
        this.$tabOptions.find('ul').append("<li><a class=\"file-hide-link menu-button\" data-action=\"file.hide\" title=\"toggle tab visibility\"><i class=\"fa fa-eye\"></i></a></li>");
      }

      $('body').append(this.$tabOptions);

      this.$tabBar = this.element.find(".scrollable-content");
      this.$tabBar.on(TAB_CLICK_EVENT, ".tab", function(e) {
        if ($(this).hasClass('active')) {
          return;
        }
        var tabIndex = $(this).index();
        self._files[tabIndex].editor.addQueueMarkers();
        return self._selectTab(tabIndex);
      });

      this.$contentWrapper = this.element.find(".file-content-container");

      this.element.find('.tab-scroll-link').on(TAB_SCROLL_START_EVENT, function() {
        self._scrollTabBar($(this).data('direction'));
      });

      this.element.find('.add-file-link').parent().on(ADD_FILE_EVENT, function() {
        self.addFile("");
        self._selectTab(self.$tabBar.children().length - 1, true);
        self._editFileName();
      });

      this.element.find('.upload-file-link').parent().on(UPLOAD_FILE_EVENT, function() {
        // trigger input file click
        $('#file-upload').trigger('click');
      });

      this.element.find('.add-inline-comment').parent().on(ADD_INLINE_COMMENT_EVENT, function() {
        self._addCommentWidget();
      });

      this.element.on(TAB_OPTIONS_OPEN_EVENT, '.tab-options-link', function(e) {
        if (self.$tabOptions.hasClass('open')) {
          self._closeOptionsMenu();
        }
        else {
          var thisTab = $(this).closest('.tab');
          if ($(thisTab).hasClass('main-editable')) {
            // main file isn't removeable
            self.$tabOptions.find('.file-remove-link').hide();
            if (self.options.canHideTabs) {
              self.$tabOptions.find('.file-hide-link').hide();
            }
          }
          else if ($(thisTab).data('binary')) {
            // hide rename link
            self.$tabOptions.find('.file-rename-link').hide();
            if (self.options.canHideTabs) {
              self.$tabOptions.find('.file-hide-link').hide();
            }
          }
          else {
            self.$tabOptions.find('.file-remove-link').show();
            if (self.options.canHideTabs) {
              self.$tabOptions.find('.file-hide-link').show();
            }
          }

          var pos = $(this).offset();
          self.$tabOptions.css('left', (pos.left - 10) + 'px');
          self.$tabOptions.css('top', (pos.top + $(this).height() + 10) + 'px');
          self.$tabOptions.addClass('open');
          self.element.on(TAB_OPTIONS_CLOSE_EVENT, function(e) {
            if (!$(e.target).hasClass('tab-options-link')) {
              self._closeOptionsMenu();
            }
          });
        }
      });

      this.$tabOptions.find('.file-rename-link').on(EDIT_FILE_NAME_EVENT, function() {
        self._closeOptionsMenu();

        if (!$('.file-name-input').length) {
          self._editFileName();
        }
      });

      this.$tabOptions.find('.file-remove-link').on(REMOVE_FILE_EVENT, function() {
        self._closeOptionsMenu();

        self._removeFile({ undo : true });
      });

      this.$tabOptions.find('.file-hide-link').on(HIDE_FILE_EVENT, function() {
        self._closeOptionsMenu();
        self._toggleFile();
      });

      if (this.options.assets) {
        var libraryUrlType = ["image"];
        if (this.options.lang === "pygame") {
          libraryUrlType.push("audio", ".ttf");
        }
        else if (this.options.lang === "python3") {
          libraryUrlType.push("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
          libraryUrlType.push("application/vnd.sqlite3");
          libraryUrlType.push("application/x-sqlite3", ".db");
          libraryUrlType.push(".csv", ".tsv", ".txt");
        }

        this.$assetBrowser = $("<div class=\"file-content fixed-right\"></div>").assetBrowser({
            modalParent  : ".trinket-content-wrapper"
          , libraryUrl   : "/api/users/assets?type=" + libraryUrlType.join(",")
          , assets       : this.options.assets
          , openClass    : "active"
          , assetsHowTo  : this.options.assetsHowTo
          , guest        : this.options.guest
          , lang         : this.options.lang
          , acceptedFiles : this.options.acceptedFiles
        });
        this.element.find('.right-options').append("<dd class=\"tab\" title='Manage images'><a class=\"file-tab-link add-asset-link\" data-action=\"assets.view\" title=\"View and Add Images\"><i class=\"fa fa-file-image-o\"></i></a></dd>");
        this.assetBrowser = this.$assetBrowser.data('trinket-assetBrowser');
        this.assetBrowser.hide();
        this.element.find('.tab-nav').addClass('allow-assets');
        this.$contentWrapper.append(this.$assetBrowser);
        this.element.find('.add-asset-link').parent().on(VIEW_ASSETS_EVENT, function() {
          var $tab = $(this);
          if ($tab.hasClass('active')) {
            return;
          }

          self._selectTab(-1, true);
          $tab.addClass('active');

          self.assetBrowser.show();
        });
      }

      if (!this.options.showTabs) {
        self.element.addClass('tabless');
      }

      if (this.options.showInfo) {
        self.element.addClass('with-info');
      }

      if (this.options.state) {
        this._loadState(this.options.state);
      }

      $(document).on('SkfileWrite', function(e) {
        var i, eventData, filename, filecontent, oldValue, newValue;
        var $content;

        // first element is file name, second is content
        eventData   = e.originalEvent.data.split(':');
        filename    = eventData[0];
        filecontent = eventData.slice(1).join(':');

        for (i = 0; i < self._files.length; i++) {
          if (self._files[i].name === filename) {
            oldValue = self._files[i].editor.getValue();
            newValue = oldValue.length ? oldValue + filecontent : filecontent;
            $('textarea[name="' + self._files[i].name + '"]').val(newValue);
            if (self.$contentWrapper.children().eq(i).hasClass('active')) {
              self._files[i].editor.setValue(newValue);
            } else {
              self._files[i].editor.destroy();
              $content = $CONTENT_TEMPLATE.clone();
              self._files[i].editor = createDesktopAPI($content[0], {
                onFocus : function() {}
                , ext   : self._files[i].name.split(".").pop() || self.options.defaultFileExt
                , index : i
                , editorOpts : self.options
              });
              self._files[i].editor.setValue(newValue);
              self.$contentWrapper.children().eq(i).replaceWith($content);
            }
          }
        }
      });

      $(document).on('SkfileOpen', function(e) {
        var i, $textarea, $content;
        var eventData = e.originalEvent.data.split(':');
        var mode      = eventData[0];
        var filename  = eventData.slice(1).join(':');
        var filemap   = {};

        self._files.map(function(file, index) {
          filemap[file.name] = index;
        });

        if (typeof filemap[filename] === "undefined") {
          self.addFile({ name : filename });
          if (mode === "w") {
            $textarea = $("<textarea>", { id : filename, name : filename });
            $textarea.val('\n');
            $('body').append($textarea);
          }
        }
        else if (mode === "w") {
          i = filemap[filename];

          $('textarea[name="' + self._files[i].name + '"]').val('\n');
          if (self.$contentWrapper.children().eq(i).hasClass('active')) {
            self._files[i].editor.setValue("");
          } else {
            self._files[i].editor.destroy();
            $content = $CONTENT_TEMPLATE.clone();
            self._files[i].editor = createDesktopAPI($content[0], {
              onFocus : function() {}
              , ext   : self._files[i].name.split(".").pop() || self.options.defaultFileExt
              , index : i
              , editorOpts : self.options
            });
            self.$contentWrapper.children().eq(i).replaceWith($content);
          }
        }
      });

      $(document).on('comment.added', '.file-content', function(event, data) {
        self._addComment(data);
      });

      // events
      $(document).on('click', '.edit-inline-comment', function(event) {
        var _commentId  = $(this).data('comment-id')
          , commentText = WIDGET_CACHE[_commentId]._text;

        // hide rendered view, show textarea, set value of textarea
        $('#comment-container-' + _commentId).addClass('hide');
        $('#edit-comment-container-' + _commentId).removeClass('hide');

        $('textarea#edit-inline-comment-' + _commentId).val(commentText);

        // hide dropdown, show buttons
        $("a[data-dropdown='comment-actions-" + _commentId + "']").addClass("hide");
        $("#update-comment-container-" + _commentId).removeClass("hide");
      });

      $(document).on('click', '.cancel-update-comment', function(event) {
        var _commentId = $(this).data('comment-id');

        $("a[data-dropdown='comment-actions-" + _commentId + "']").removeClass("hide");
        $("#update-comment-container-" + _commentId).addClass("hide");

        $('#comment-container-' + _commentId).removeClass('hide');
        $('#edit-comment-container-' + _commentId).addClass('hide');
      });

      $(document).on('click', '.update-comment', function(event) {
        var _commentId = $(this).data('comment-id')
          , _fileIndex = $(this).data('file-index');

        var updatedComment     = $('textarea#edit-inline-comment-' + _commentId).val();
        var updatedCommentHtml = updatedComment.replace(/(?:\r\n|\r|\n)/g, '<br />')

        WIDGET_CACHE[_commentId]._text = updatedComment;
        $('#comment-container-' + _commentId).html(updatedCommentHtml);

        $("a[data-dropdown='comment-actions-" + _commentId + "']").removeClass("hide");
        $("#update-comment-container-" + _commentId).addClass("hide");

        $('#comment-container-' + _commentId).removeClass('hide');
        $('#edit-comment-container-' + _commentId).addClass('hide');

        self._updateComment({
            _id    : _commentId
          , index  : _fileIndex
          , data   : {
                text   : updatedComment
              , edited : true
            }
        });
      });

      $(document).on('click', '.confirm-remove-inline-comment', function(event) {
        var _commentId = $(this).data('comment-id');

        $("a[data-dropdown='comment-actions-" + _commentId + "']").addClass("hide");
        $("#confirm-remove-comment-container-" + _commentId).removeClass("hide");
      });

      $(document).on('click', '.cancel-remove-comment', function(event) {
        var _commentId = $(this).data('comment-id');

        $("a[data-dropdown='comment-actions-" + _commentId + "']").removeClass("hide");
        $("#confirm-remove-comment-container-" + _commentId).addClass("hide");
      });

      $(document).on('click', '.confirm-remove-comment', function(event) {
        var _commentId = $(this).data('comment-id')
          , _fileIndex = $(this).data('file-index')
          , w          = WIDGET_CACHE[_commentId];

        self._files[_fileIndex].editor.getSession().removeGutterDecoration(w.row, "trinket-comment");
        self._files[_fileIndex].editor.getSession().removeGutterDecoration(w.row, "data-" + _fileIndex + "-" + _commentId);

        if (COMMENT_COLLAPSED[_commentId]) {
          self._files[_fileIndex].editor.getSession().removeGutterDecoration(w.row, "collapsed");
        }
        else {
          self._files[_fileIndex].editor.getSession().removeGutterDecoration(w.row, "open");
        }

        WIDGET_CACHE[_commentId].destroy();
        delete WIDGET_CACHE[_commentId];

        FILE_WIDGETS[_fileIndex][w.row] = undefined;

        updateCommentArrows(self._files[_fileIndex].editor.getSession(), _fileIndex);

        self._removeComment({
            _id   : _commentId
          , index : _fileIndex
        });
      });

      $(document).on('click', '.ace_gutter-cell.trinket-comment', function(event) {
        var classes = $(event.target).attr("class").split(" ")
          , commentClass, commentData, fileIndex, commentId, w;

        commentClass = _.find(classes, function(c) { return /^data/.test(c); });
        commentData  = commentClass.split("-");
        fileIndex    = commentData[1];
        commentId    = commentData[2];
        w            = WIDGET_CACHE[commentId];

        // this causes a flicker as the line is highlighted by ace and then quickly unhighlighted
        // instead change ace behavior?
        // self._files[fileIndex].editor.getSession().selection.clearSelection();

        var session = self._files[fileIndex].editor.getSession();

        if (COMMENT_COLLAPSED[commentId]) {
          session.widgetManager.addLineWidget( WIDGET_CACHE[commentId] );
          COMMENT_COLLAPSED[commentId] = false;

          session.removeGutterDecoration(w.row, "collapsed");
          session.addGutterDecoration(w.row, "open");
        }
        else {
          session.widgetManager.removeLineWidget( WIDGET_CACHE[commentId] );
          COMMENT_COLLAPSED[commentId] = true;

          session.removeGutterDecoration(w.row, "open");
          session.addGutterDecoration(w.row, "collapsed");
        }

        self._updateComment({
            _id    : commentId
          , index  : fileIndex
          , data   : {
              collapsed : COMMENT_COLLAPSED[commentId]
            }
        });
      });

      $(document).on('click', '.comment-actions.comment-dismiss', function(event) {
        var _commentId = $(this).data('comment-id')
          , _fileIndex = $(this).data('file-index')
          , w          = WIDGET_CACHE[_commentId];

        self._files[_fileIndex].editor.getSession().removeGutterDecoration(w.row, "trinket-comment");
        self._files[_fileIndex].editor.getSession().removeGutterDecoration(w.row, "data-" + _fileIndex + "-" + _commentId);

        if (COMMENT_COLLAPSED[_commentId]) {
          self._files[_fileIndex].editor.getSession().removeGutterDecoration(w.row, "collapsed");
        }
        else {
          self._files[_fileIndex].editor.getSession().removeGutterDecoration(w.row, "open");
        }

        WIDGET_CACHE[_commentId].destroy();
        delete WIDGET_CACHE[_commentId];

        self._removeComment({
            _id   : _commentId
          , index : _fileIndex
        });
      });

      $(document).on('click', '.move-comment-up', function(event) {
        if ($(this).hasClass('disabled')) {
          return;
        }

        var _commentId = $(this).data('comment-id')
          , _fileIndex = $(this).data('file-index')
          , w          = WIDGET_CACHE[_commentId]
          , currentRow = w.row
          , moveTo     = w.row - 1;

        moveCommentTo.call(self, _fileIndex, _commentId, moveTo);
      });

      $(document).on('click', '.move-comment-down', function(event) {
        if ($(this).hasClass('disabled')) {
          return;
        }

        var _commentId = $(this).data('comment-id')
          , _fileIndex = $(this).data('file-index')
          , w          = WIDGET_CACHE[_commentId]
          , currentRow = w.row
          , moveTo     = w.row + 1;

        moveCommentTo.call(self, _fileIndex, _commentId, moveTo);
      });

      // keyboard shortcut (Shift+Tab) to switch focus to editor
      $('#outputContainer').keyup(function(e) {
        if (e.shiftKey && e.keyCode === 9) {
          e.preventDefault();
          self.focus();
        }
      });
    },

    _closeOptionsMenu : function() {
      this.element.off(TAB_OPTIONS_CLOSE_EVENT);
      this.$tabOptions.removeClass('open');
    },

    _loadState : function(state) {
      var i;

      try {
        state = JSON.parse(state);
        if (!Array.isArray(state)) {
          // throw generic error to fall into catch below
          throw new Error();
        }
      }
      catch(e) {
        state = [{
          name      : this.options.mainFileName
          , content : state || ""
        }];
      }

      for (i = 0; i < state.length; i++) {
        this.addFile(state[i]);
      }

      this._selectTab(0, true);
    },

    /**
     * Returns the current visible tab from the tab-bar.
     */
    _getCurrentVisibleTab: function() {
      var $activeTab     = this.$tabBar.find('.tab.active').first();
      var $activeContent = this.$contentWrapper.find('.file-content.active').first();
      var tabIndex       = $activeTab.index();
      var fileName       = $activeTab.find('.file-name').text();

      return {
        tabIndex: tabIndex,
        fileName: fileName
      }
    },

    _selectTab : function(tabIndex, noFocus) {
      this.element.find('.tab.active, .file-content.active').removeClass('active');
      if (this._editor) {
        this._editor.blur();
      }
      if (tabIndex !== undefined && this._files[tabIndex]) {
        this.$tabBar.children().eq(tabIndex).addClass('active');
        this.$contentWrapper.children().eq(tabIndex).addClass('active');
        this._editor = this._files[tabIndex].editor;
        if (!noFocus) {
          this._editor.focus();
        }

        // emit file selected event
        this.element.trigger({type: 'codeeditor.tabChanged', tabIndex: tabIndex});

        if (this._files[tabIndex].binary) {
          this.element.find('.add-inline-comment').addClass('disabled');
        }
        else {
          this.element.find('.add-inline-comment').removeClass('disabled');
        }
      }
      else {
        this.element.find('.add-inline-comment').addClass('disabled');
      }
    },

    _editFileName : function() {
      var self      = this
          , $tab    = self.$tabBar.find('.tab.active')
          , $name   = $tab.find('.file-name')
          , name    = $name.text()
          , nameLen = name.length
          , $input  = $(EDITABLE_TAB_TEMPLATE({ name : name }))
          , width   = $name.outerWidth();

      if ($tab.hasClass('main-editable')) {
        if (!self.options.mainEditable) {
          return;
        }
        if (self.options.mainSuffix) {
          nameLen -= self.options.mainSuffix.length;
        }
      }

      $name.hide();
      $input.css('width', width + 'px');
      $name.after($input);
      $input.focus();
      $input[0].setSelectionRange(0, nameLen);

      $input.on('blur', function(e) {
        var newName = $input.val().replace(/^\s|\s$/g, "")
            , errorMessage;

        $('.file-name-error').remove();
        if (!newName.length) {
          self._removeFile({ undo : false });
          return;
        }
        else if (newName.length > 50) {
          errorMessage = "File names must be less than 50 characters, please choose a shorter name.";
        }
        else if ( (self.options.lang === "python" || self.options.lang === "python3") && newName.match(/\.py$/) && !newName.match(/^[\w][\w0-9]*(\.[a-z]+)?$/)) {
          errorMessage = "Python file names must start with a letter or underscore followed by zero or more letters, digits and underscores.";
        }
        else if (!newName.match(/^\w[\w\.\-]*$/)) {
          errorMessage = "File names must start with a letter, number, or underscore followed by zero or more letters, numbers, underscores, hyphens, and periods.";
        }
        else if ($('#' + newName).length) {
          errorMessage = "The name '" + newName + "' is reserved, please choose a different name.";
        }
        else if (newName.toLowerCase() !== name.toLowerCase()) {
          self.$tabBar.find(".file-name").each(function() {
            if ($(this).text().toLowerCase() === newName.toLowerCase()) {
              errorMessage = "There is already a file named \"" + newName + "\", please choose a different name.";
              return false;
            }
          });
        }

        if (errorMessage) {
          self.element.find('.tab-nav').after(FILE_NAME_ERROR_TEMPLATE({message:errorMessage}));
          $(document).foundation('alert', 'reflow');
          $(this).focus();
          this.setSelectionRange(0, newName.length);
        }
        else {
          $name.text(newName);
          $name.show();
          $(this).remove();
          self._files[$tab.index()].name = newName;
          if (self._onChange) {
            self._onChange();
          }
          self._files[$tab.index()].editor.setModeFromName(newName);
          // emit file renamed event
          self.element.trigger({type: 'codeeditor.fileRenamed', oldFileName: name, newFileName: newName, newFile: self._files[$tab.index()]});
        }
      });

      $input.on('keydown', function(e) {
        // kill focus on ENTER/RETURN
        if(e.keyCode === 10 || e.keyCode === 13) {
          $(this).blur();
        }
        // restore original value on ESCAPE
        else if (e.keyCode === 27) {
          $input.val(name);
          $(this).blur();
        }
      });
    },

    _removeFile : function(options) {
      var self                    = this
          , $activeTab            = this.$tabBar.find('.tab.active').first()
          , $activeContent        = this.$contentWrapper.find('.file-content.active').first()
          , newIndex = origIndex  = $activeTab.index()
          , fileName              = $activeTab.find('.file-name').text()
          , $restore              = $(UNDO_REMOVE_TEMPLATE({name : fileName}))
          , fileToRestore         = this._files.splice(origIndex, 1)[0]
          , isLastTab             = origIndex === this._files.length
          , closeUndoAlertTimeout = setTimeout(function() {
              $restore.find('.close').click();
            }, 15000)
          , closeUndoMessage      = function() {
              clearTimeout(closeUndoAlertTimeout);
              fileToRestore = undefined;
              $activeTab = undefined;
              $activeContent = undefined;
              if ($restore) {
                $restore.remove();
                $restore = undefined;
              }
            };

      $activeTab.detach();
      $activeContent.detach();

      if (isLastTab) {
        newIndex -= 1;
      }

      this._selectTab(newIndex);
      if (this._onChange && !fileToRestore.binary) {
        this._onChange();
      }

      if (options.undo || fileToRestore.editor.getValue().length) {
        // attach undo message
        this.element.find('.tab-nav').after($restore);

        // destroy restore file editor when message is discarded
        $restore.find('.close').on('click', function() {
          fileToRestore.editor.destroy();
          // emit event when editor is finally destroyed
          self.element.trigger({type: 'codeeditor.fileRemoved', fileName: fileName});
        });

        // restore the deleted file
        $('.file-restore-link').on('click', function() {
          self._files.splice(origIndex, 0, fileToRestore);
          if (isLastTab) {
            self.$tabBar.append($activeTab);
            self.$contentWrapper.children().eq(newIndex).after($activeContent);
          }
          else {
            self.$tabBar.children().eq(newIndex).before($activeTab);
            self.$contentWrapper.children().eq(newIndex).before($activeContent);
          }
          self._selectTab(origIndex);
          closeUndoMessage();
          if (self._onChange && !fileToRestore.binary) {
            self._onChange();
          }
        });
        $(document).one('close.fndtn.alert-box', function(event) {
          closeUndoMessage();
        });

        if ($('.file-name-error').length) {
          $('.file-name-error').remove();
        }
        $(document).foundation('alert', 'reflow');
      }
    },

    _toggleFile : function() {
      var self     = this
          , $tab   = self.$tabBar.find('.tab.active');

      if (typeof self._files[$tab.index()].hidden === 'undefined') {
        self._files[$tab.index()].hidden = true;
      }
      else {
        self._files[$tab.index()].hidden = !self._files[$tab.index()].hidden;
      }

      if (self._files[$tab.index()].hidden) {
        $tab.find('.file-name').addClass('hidden-file-indicator');
        $('<i class="fa fa-eye-slash file-icon"></i>').insertBefore( $tab.find('.file-name') );
      } else {
        $tab.find('.file-name').removeClass('hidden-file-indicator');
        $tab.find('.file-name').prev('i').remove();
      }

      if (self._onChange) {
        self._onChange();
      }
    },

    _scrollTabBar : function(direction) {
      var self             = this
          , scrollDelay    = 300
          , delayIncrement = 50
          , easing         = "swing"
          , stopScrolling  = false
          , $tabs          = self.$tabBar.children()
          , nextTabTimeout, scrollTabs;

      if (direction < 0) {
        $tabs = $($tabs.get().reverse());
      }

      $(document).one(TAB_SCROLL_STOP_EVENT, function() {
          stopScrolling = true;
          clearTimeout(nextTabTimeout);
      });

      scrollTabs = function() {
        var searching = true;

        $tabs.each(function() {
          var pos = $(this).position().left;

          if (direction > 0) {
            pos += $(this).outerWidth();
          }

          if ((direction > 0 && pos > 10) || (direction < 0 && pos < -10)) {
            self.$tabBar.animate(
              {scrollLeft: "+=" + pos}, 200, easing
              , function() {
                if (stopScrolling) return;

                scrollDelay = Math.max(0, scrollDelay - delayIncrement);
                if (!scrollDelay) {
                  easing = "linear";
                }
                nextTabTimeout = setTimeout(scrollTabs, scrollDelay);
              }
            );
            searching = false;
          }

          return searching;
        });
      };

      scrollTabs();
    },

    _addCommentWidget : function() {
      var active = this._getCurrentVisibleTab();
      if (active.tabIndex >= 0) {
        this._files[active.tabIndex].editor.addCommentWidget.call(this);
      }
    },

    _addComment : function(data) {
      this._files[ data.index ].comments.push(data);

      if (this._onChange) {
        this._onChange();
      }
    },
    _removeComment : function(data) {
      this._files[ data.index ].comments = _.filter(this._files[ data.index ].comments, function(comment) {
        return comment._id !== data._id;
      });

      if (this._onChange) {
        this._onChange();
      }
    },
    _updateComment : function(data) {
      _.find(this._files[ data.index ].comments, function(comment) {
        if (comment._id === data._id) {
          comment = _.extend(comment, data.data);
        }
      });

      if (this._onChange) {
        this._onChange();
      }
    },
    _createEditor : function(file, index, canUseAce) {
      var editor;

      var name = file.name;
      var type = file.type || name.split(".").pop();
      var content = file.content || "";
      var comments = file.comments || [];
      var binary = file.binary || false;
      var $content = $CONTENT_TEMPLATE.clone();

      if (this.options.noEditor) {
        editor = createGhostAPI($content[0], {
          value : content
        });
      }
      else if (file.image) {
        editor = createImageAPI($content[0], {
            name  : name
          , value : content
        });
      }
      else if (file.binary) {
        editor = createGhostAPI($content[0], {
          value : content
        });

        $content.html($BINARY_FILE_TEMPLATE);
      }
      else if (!this.options.disableAceEditor && canUseAce && ace) {
        editor = createDesktopAPI($content[0], {
            onFocus         : this.options.onFocus
          , ext             : type || this.options.defaultFileExt
          , name            : name
          , value           : content
          , index           : index
          , comments        : comments
          , editorOpts      : this.options
          , onCommentChange : moveCommentTo.bind(this)
          , onCommentRemove : this._removeComment.bind(this)
        });
      }
      else {
        editor = createMobileAPI($content[0], {
            onFocus      : this.options.onFocus
          , selectedLine : this.options.selectedLine
          , value        : content
          , name         : name
        });

        // add editor commands, if any
        for (var commandKey in mobileCommands) {
          editor.addCommand(
            commandKey,
            mobileCommands[commandKey].key,
            mobileCommands[commandKey].fn
          );
        }
      }

      for (i = 0; i < this._commands.length; i++) {
        editor.addCommand.apply(editor, this._commands[i]);
      }

      for (i = 0; i < this._plugins.length; i++) {
        editor.registerPlugin(this._plugins[i], this);
      }

      if (this._onChange && !binary) {
        editor.change(this._onChange);
      }

      return {
        editor: editor,
        $content: $content
      };
    },

    resize : function(force) {
      for(var i = 0; i < this._files.length; i++) {
        this._files[i].editor.resize(force);
      }
    },

    assets : function(value) {
      return this.options.assets ? this.assetBrowser.assets(value) : [];
    },

    addFile : function(file, options) {
      var self = this
        , content = ""
        , type  = ""
        , index = this._files.length
        , canUseAce = true
        , override = options && options.override ? options.override : false
        , name, $tab, i, $last, hidden, filedata, fileexists
        , comments, binary, tabData;

      // for HTML / IE9
      if (typeof(jQueryXDomainRequest) !== 'undefined' && jQueryXDomainRequest) {
        canUseAce = false;
      }

      if (typeof file === "string") {
        file = {name : file};
      }

      name     = file.name;
      type     = file.type || name.split(".").pop();
      content  = file.content || "";
      hidden   = file.hidden;
      comments = file.comments || [];
      binary   = file.binary || false;

      $tab     = $(TAB_TEMPLATE({name:name}));

      self.$tabBar.find(".file-name").each(function(thisIndex) {
        if ($(this).text().toLowerCase() === name.toLowerCase()) {
          fileexists = true;
          index = thisIndex;
        }
      });

      if (fileexists && override) {
        var $content = $CONTENT_TEMPLATE.clone();
        $('textarea[name="' + self._files[index].name + '"]').val(content);

        if (self.$contentWrapper.children().eq(index).hasClass('active')) {
          self._files[index].editor.setValue(content);
        }
        else if (file.binary) {
          self._files[index].editor = createGhostAPI($content[0], {
            value : content
          });

          $content.html($BINARY_FILE_TEMPLATE);
          self.$contentWrapper.children().eq(index).replaceWith($content);
        }
        else {
          self._files[index].editor.destroy();

          self._files[index].editor = createDesktopAPI($content[0], {
              onFocus : function() {}
            , ext     : self._files[index].name.split(".").pop() || self.options.defaultFileExt
            , name    : name
            , value   : content
            , index   : index
            , editorOpts : self.options
          });

          self._files[index].editor.setValue(content);
          self.$contentWrapper.children().eq(index).replaceWith($content);
        }

        return this._files[index];
      }

      if (hidden) {
        if (self.options.owner && self.options.canHideTabs) {
          $tab.find('.file-name').addClass('hidden-file-indicator');
          $('<i class="fa fa-eye-slash file-icon"></i>').insertBefore( $tab.find('.file-name') );
        }
        else {
          $tab.hide();
        }
      }

      var editor = this._createEditor(file, index, canUseAce);

      tabData = {
        index : index
      };
      if (binary) {
        tabData.binary = true;
      }

      $tab.data(tabData);

      this.$tabBar.append($tab);

      var $last = this.$contentWrapper.find('.fixed-right').first();
      if ($last.length) {
        $last.before(editor.$content);
      }
      else {
        this.$contentWrapper.append(editor.$content);
      }

      if (index === 0) {
        if (this.options.mainEditable) {
          $tab.addClass('main-editable');
        }
        else {
          $tab.addClass('permanent');
        }
      }

      $('.info-area .expander').click(function() {
        if ($('.info-area').hasClass('expanded')) {
          $('.info-area').removeClass('expanded').addClass('collapsed');
        }
        else {
          $('.info-area').removeClass('collapsed').addClass('expanded');
        }
      });

      filedata = {
          name     : name
        , type     : type
        , $tab     : $tab
        , $content : editor.$content
        , editor   : editor.editor
        , comments : comments
        , binary   : binary
      };

      if (typeof hidden !== 'undefined') {
        filedata.hidden = hidden;
      }

      this._files.push(filedata);

      // emit event
      this.element.trigger({type: 'codeeditor.fileAdded', fileName: name, newFile: this._files[this._files.length - 1]});

      return this._files[this._files.length - 1];
    },

    hasFile : function(fileName) {
      var i;

      for (i = 0; i < this._files.length; i++) {
        if (this._files[i].name === fileName) {
          return true;
        }
      }

      return false;
    },

    getFile : function(fileName) {
      var i;

      for (i = 0; i < this._files.length; i++) {
        if (this._files[i].name === fileName) {
          return this._files[i].editor.getValue();
        }
      }

      return "";
    },

    selectFile : function(fileName, noFocus) {
      var $tab, i;

      for (i = 0; i < this._files.length; i++) {
        if (this._files[i].name === fileName) {
          $tab = this._files[i].$tab;
          break;
        }
      }

      if (!$tab) {
        $tab = this.addFile(fileName).$tab;
        i    = this._files.length - 1;
      }

      // noFocus: switch the visible tab without moving keyboard focus into the
      // editor (e.g. the step-debugger following execution across files must
      // not steal focus from its own controls).
      this._selectTab(i, noFocus);
    },

    serialize : function(opts) {
      var data = []
        , opts = _.extend(opts || { removeComments : false })
        , file, i, filedata;

      for (i = 0; i < this._files.length; i++) {
        if (this._files[i].binary) {
          continue;
        }

        file = this._files[i];
        filedata = {
            name    : file.name
          , content : file.editor.getValue()
        };

        if (typeof file.hidden !== 'undefined') {
          filedata.hidden = file.hidden;
        }

        if (!opts.removeComments && file.comments.length) {
          filedata.comments = file.comments;
        }

        data.push(filedata);
      }

      return JSON.stringify(data);
    },

    getAllFiles : function(options) {
      var files = {}
        , filter, values;

      if (!options || typeof options !== 'object') {
        filter = false;
        values = true;
      }
      else {
        filter = options.filter || false;
        values = options.values === undefined ? true : options.values;
      }

      if (filter && typeof filter !== "regexp") {
        filter = new RegExp(filter);
      }

      for(var i = 0; i < this._files.length; i++) {
        if (!filter || filter.test(this._files[i].name)) {
          if (this._files[i].binary) {
            continue;
          }

          files[this._files[i].name] = values
                                         ? this._files[i].editor.getValue()
                                         : 1;
        }
      }

      return files;
    },

    getAllVisibleFiles : function() {
      var files = {}
        , i;

      for (i = 0; i < this._files.length; i++) {
        if (!this._files[i].hidden && !this._files[i].binary) {
          files[this._files[i].name] = this._files[i].editor.getValue();
        }
      }

      return files;
    },

    addCommand : function(name, key, fn) {
      this._commands.push([name, key, fn]);
      for(var i = 0; i < this._files.length; i++) {
        this._files[i].editor.addCommand(name, key, fn);
      }
    },

    updateInfo : function(data) {
      if (!this.options.showInfo) return;

      this._currentInfo = data;

      $('.info-area .expander').hide();

      if (data) {
        $('.info-area').removeClass('empty').find('.info-quick').html(this._currentInfo.title);
        this.loadFullInfo(this._currentInfo);
      }
      else {
        $('.info-area').removeClass('expanded').addClass('collapsed empty');
      }
    },

    loadFullInfo : function(info) {
      var cached;

      if (!info || !info.url) return;

      cached = INFO_CACHE[info.url];

      if (cached !== undefined) {
        if (typeof cached === "string") {
          if (cached.length) {
            $('.info-area .info-full').html(INFO_CACHE[info.url]);
            $('.info-area .expander').show();
          }
        }
        else {
          cached._cancelled = false;
        }

        return;
      }

      if (this.lastInfoRequest) {
        this.lastInfoRequest._cancelled = true;
      }

      this.lastInfoRequest = INFO_CACHE[info.url] = (function() {
        var req = $.get(info.url, '', 'html');
        req.done(function(data) {
          INFO_CACHE[info.url] = data || "";
          if (data && !req._cancelled) {
            $('.info-area .info-full').html(data);
            $('.info-area .expander').show();
          }
        });
        return req;
      })();
    },

    registerPlugin : function(plugin) {
      var self = this;
      if (plugin.on) {
        plugin.on('info.token', function(e, data) {
          self.updateInfo(data);
        });
      }
      this._plugins.push(plugin);
      for(var i = 0; i < this._files.length; i++) {
        this._files[i].editor.registerPlugin(plugin, this);
      }
    },

    change : function(cb) {
      this._onChange = cb;
      for(var i = 0; i < this._files.length; i++) {
        this._files[i].editor.change(cb);
      }
    },

    reset : function(state) {
      var file;

      while(file = this._files.pop()) {
        file.editor.destroy();
        file.$content.remove();
        file.$tab.remove();
      }

      this._loadState(state);
    },

    refresh : function() {
      for (var i = 0; i < this._files.length; i++) {
        var content = this._files[i].editor.getValue();
        this._files[i].editor.destroy();

        var file = {
          name: this._files[i].name,
          type: this._files[i].type || this._files[i].name.split(".").pop(),
          content: content,
          binary: this._files[i].binary,
          image: this._files[i].image,
          comments: this._files[i].comments
        };

        var editor = this._createEditor(file, i, true);

        this._files[i].editor = editor.editor;
        this._files[i].editor.setValue(content);
        this.$contentWrapper.children().eq(i).replaceWith(editor.$content);
      }
      this._selectTab(0, true);
    },

    highlight: function(file_name, line_num) {
      // find index for this file
      var file_index = -1;
      for (var i = 0; i < this._files.length; i++) {
        if (this._files[i].name === file_name) {
          file_index = i;
          break;
        }
      }

      if (file_index >= 0) {
        var queue = this._files[file_index].$tab.hasClass("active") ? false : true;
        this._files[file_index].editor.highlight(line_num, queue);

        // add error icon to tab
        if (!this._files[file_index].$tab.has(CODE_ERROR_TAB_MARKER).length) {
          this._files[file_index].$tab.append(" <i class='" + CODE_ERROR_TAB_CLASS + "'></i>");
        }
      }
    },

    clearTabMarkers: function() {
      for (var i = 0; i < this._files.length; i++) {
        if (this._files[i].$tab.has(CODE_ERROR_TAB_MARKER).length) {
          this._files[i].$tab.find(CODE_ERROR_TAB_MARKER).remove();
        }
      }

      $('.ace_content').removeClass('attention-error');
      $('textarea.lined').removeClass('attention-error');
      $('.lineno').removeClass('lineselect');
    },

    gotoLine: function(line_num) {
      if (this._editor && this._editor.aceInstance) {
        this._editor.aceInstance.gotoLine(line_num);
      }
    },

    removeComments: function() {
      var i, j, commentId, w;

      for (i = 0; i < this._files.length; i++) {
        if (this._files[i].comments) {
          for (j = 0; j < this._files[i].comments.length; j++) {
            commentId = this._files[i].comments[j]._id;
            w = WIDGET_CACHE[commentId];

            this._files[i].editor.getSession().removeGutterDecoration(w.row, "trinket-comment");
            this._files[i].editor.getSession().removeGutterDecoration(w.row, "data-" + i + "-" + commentId);

            if (COMMENT_COLLAPSED[commentId]) {
              this._files[i].editor.getSession().removeGutterDecoration(w.row, "collapsed");
            }
            else {
              this._files[i].editor.getSession().removeGutterDecoration(w.row, "open");
            }

            WIDGET_CACHE[commentId].destroy();
            delete WIDGET_CACHE[commentId];
          }
        }
      }
    },

    activeTab: function() {
      return this._getCurrentVisibleTab();
    },
    setWrap: function(wrap) {
      for (var i = 0; i < this._files.length; i++) {
        this._files[i].editor.actuallySetWrap(wrap);
      };
    },
    setIndent: function(current){
      for (var i = 0; i < this._files.length; i++) {
        this._files[i].editor.actuallySetIndent(current);
      };
    }
  };

  (function(proto) {
    var apiMethods = "setValue getValue focus isFocused".split(" ");
    var wrapAPIMethod = function(methodName) {
      proto[methodName] = function() {
        var args = Array.prototype.slice.call(arguments);
        return this._editor[methodName].apply(this._editor, args);
      }
    };

    for(var i = 0; i < apiMethods.length; i++) {
      wrapAPIMethod(apiMethods[i]);
    }
  })(widget);

  $.widget('trinket.codeEditor', widget);
})(window.jQuery, window.TrinketIO, window.ace);
