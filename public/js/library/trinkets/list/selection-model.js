// Plain, framework-free selection set. Exported for unit tests; also attached to
// the AngularJS global namespace (TrinketIO) for the list controllers to consume.
(function(root) {
  var selection = {
    create   : function() { return { map: {} }; },
    toggle   : function(s, id) { if (s.map[id]) delete s.map[id]; else s.map[id] = true; },
    selectAll: function(s, ids) { ids.forEach(function(id) { s.map[id] = true; }); },
    clear    : function(s) { s.map = {}; },
    ids      : function(s) { return Object.keys(s.map); },
    count    : function(s) { return Object.keys(s.map).length; },
    has      : function(s, id) { return !!s.map[id]; }
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = selection;
  if (root && root.TrinketIO && root.TrinketIO.export) root.TrinketIO.export('library.selection', selection);
})(typeof window !== 'undefined' ? window : this);
