function pull(fields, source, target) {
  if (!target) target = {};

  for(var key in fields) {
    if (fields[key] === true || fields[key] === 1) {
      target[key] = source[key];
    }
    else if (typeof fields[key] === 'string') {
      target[key] = source[fields[key]];
    }
    else if (Array.isArray(fields[key])) {
      target[key] = [];
      if (source[key]) {
        for(var i = 0; i < source[key].length; i++) {
          target[key].push({});
          pull(fields[key][0], source[key][i], target[key][i]);
        }
      }
    }
    else if (typeof fields[key] === 'object'){
      target[key] = {};
      if (source[key]) {
        pull(fields[key], source[key], target[key]);
      }
    }
    else {
      throw new Error('unrecognized field value for ' + key + ': ' + source[key]);
    }
  }

  return target;
}

// `seen` tracks the objects on the current recursion path (ancestors) so a
// circular reference doesn't recurse forever -> "Maximum call stack size
// exceeded" (picup #58, which crashed patchContent saves via request.success).
// We add on the way down and delete on the way back up, so a repeated *sibling*
// reference (a DAG, not a cycle) is still fully serialized — only true cycles
// (a node referencing one of its own ancestors) are broken.
function serialize(json, seen) {
  seen = seen || new WeakSet();
  var result;

  if (Array.isArray(json)) {
    if (seen.has(json)) return undefined;   // cycle — break it
    seen.add(json);
    result = [];
    for(var i = 0; i < json.length; i++) {
      result.push(serialize(json[i], seen));
    }
    seen.delete(json);
  }
  else if (json && typeof json === 'object') {
    if (typeof(json.serialize) === 'function') {
      result = json.serialize();
    }
    else {
      if (seen.has(json)) return undefined;   // cycle — break it
      seen.add(json);
      result = {};
      for (var key in json) {
        if (json[key] !== null && typeof(json[key]) !== 'undefined') {
          if (typeof(json[key].serialize) === 'function') {
            result[key] = json[key].serialize();
          } else {
            result[key] = serialize(json[key], seen);
          }
        }
      }
      seen.delete(json);
    }
  }
  else {
    result = json;
  }

  return result;
}

module.exports = {
  pull      : pull,
  serialize : serialize
};
