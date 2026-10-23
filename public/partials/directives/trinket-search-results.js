// Rows for the trinket-search dropdown (#344): the results, then a footer row
// when there are more matches than shown. Framework-free so vitest can load it;
// also exposed as window.trinketSearchResults for the directive.
(function(root) {
  function rows(body, opts) {
    var data  = (body && body.data) || [];
    var total = (body && typeof body.total === 'number') ? body.total : data.length;
    var out = data.map(function(t) {
      if (!t.name) t.name = 'Untitled';
      return t;
    });
    if (total > data.length) {
      out.push({
        __footer   : true,
        text       : 'Showing ' + data.length + ' of ' + total + ', best matches first',
        seeAllText : (opts && opts.seeAll) ? 'See all ' + total + ' results' : null
      });
    }
    return out;
  }

  var api = { rows: rows };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.trinketSearchResults = api;
})(typeof window !== 'undefined' ? window : null);
