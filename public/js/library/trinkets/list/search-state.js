// Library list "See all" search state (#344): entering a search switches to all
// folders and relevance order; leaving restores what the user had. Plain
// functions so vitest can test them; also window.librarySearchState.
(function(root) {
  var DEFAULT_SORT = '-lastView.viewedOn';
  // Narrowing filters a See-all search clears, so the list shows every match
  // the dropdown counted; leave() puts them back.
  var CLEARED = { name: '', updatedWithin: 'all', updatedAfter: '', updatedBefore: '' };

  // Saves the pre-search state once, but clears the narrowing filters on every
  // entry: a filter applied during one search must not hide matches from the next.
  function enter(state, term) {
    if (!state.saved) {
      state.saved = { sortBy: state.sortBy, scope: state.filters.scope, filters: {} };
      Object.keys(CLEARED).forEach(function(k) {
        state.saved.filters[k] = state.filters[k];
      });
    }
    Object.keys(CLEARED).forEach(function(k) {
      state.filters[k] = CLEARED[k];
    });
    state.filters.q     = term;
    state.filters.scope = 'all';
    state.sortBy        = 'relevance';
    return state;
  }

  function leave(state) {
    var saved = state.saved || {};
    delete state.filters.q;
    if (state.sortBy === 'relevance') {
      state.sortBy = saved.sortBy || DEFAULT_SORT;
    }
    state.filters.scope = saved.scope || 'root';
    Object.keys(CLEARED).forEach(function(k) {
      if (saved.filters && saved.filters[k] !== undefined) state.filters[k] = saved.filters[k];
    });
    state.saved = null;
    return state;
  }

  function persistableSort(sortBy, saved) {
    if (sortBy !== 'relevance') return sortBy;
    return (saved && saved.sortBy) || DEFAULT_SORT;
  }

  // Deep copy that keeps Dates as Dates: the date filters bind to type="date"
  // inputs, which reject strings (ngModel:datefmt).
  function copy(v) {
    if (v instanceof Date) return new Date(v.getTime());
    if (Array.isArray(v)) return v.map(copy);
    if (v && typeof v === 'object') {
      var out = {};
      Object.keys(v).forEach(function(k) { out[k] = copy(v[k]); });
      return out;
    }
    return v;
  }

  // A copy of the list's search state to keep in libraryState while the user
  // visits a trinket, so Back returns to the same search (chip included), in
  // the sort its kept items and paging cursor were loaded with.
  function carry(filters, saved, sortBy) {
    return {
      filters : copy(filters || {}),
      saved   : saved ? copy(saved) : null,
      sortBy  : sortBy
    };
  }

  // The sort to resume a carried search in.
  function resumeSort(carried) {
    return (carried && carried.sortBy) || 'relevance';
  }

  var api = { enter: enter, leave: leave, persistableSort: persistableSort, carry: carry, resumeSort: resumeSort };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.librarySearchState = api;
})(typeof window !== 'undefined' ? window : null);
