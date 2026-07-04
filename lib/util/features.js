var config = require('config');

/**
 * Feature flags utility
 * Checks if features are enabled based on config
 */

/**
 * Check if courses feature is enabled
 * @returns {boolean} - True if enabled, false if disabled
 */
function isCoursesEnabled() {
  // Default to true if not specified
  if (!config.features || typeof config.features.courses === 'undefined') {
    return true;
  }
  return config.features.courses === true;
}

// Trinket types that are the same underlying engine and must be enabled/served
// together. python3 and pyodide both run on the client-side Pyodide runtime
// (lib/views/embed/python3.html extends embed/pyodide.html), and a trinket may
// be stored under either lang — UI-created "Python" saves as pyodide, while
// imported/legacy trinkets are often python3. Treating them as equivalent means
// enabling one serves both; otherwise an imported python3 trinket lists fine but
// 404s on open where only pyodide is enabled (see issue #4).
var LANG_ALIASES = {
  python3 : 'pyodide',
  pyodide : 'python3'
};

// A lang is on iff it's explicitly true in the trinket feature flags.
// Unknown/absent types are off (safe default).
function langFlagEnabled(trinketFeatures, lang) {
  return trinketFeatures.hasOwnProperty(lang) && trinketFeatures[lang] === true;
}

/**
 * Check if a trinket type (language) is enabled
 * @param {string} lang - The trinket language/type (e.g., 'python', 'java')
 * @returns {boolean} - True if enabled, false if disabled
 */
function isTrinketTypeEnabled(lang) {
  var trinketFeatures = config.features && config.features.trinkets;

  if (!trinketFeatures) {
    // If no feature config, default to enabled
    return true;
  }

  if (langFlagEnabled(trinketFeatures, lang)) {
    return true;
  }

  // Fall back to an equivalent-engine alias (python3 <-> pyodide) so a trinket
  // saved under either lang is served whenever the shared engine is enabled.
  var alias = LANG_ALIASES[lang];
  if (alias && langFlagEnabled(trinketFeatures, alias)) {
    return true;
  }

  return false;
}

/**
 * Get list of all enabled trinket types
 * @returns {string[]} - Array of enabled trinket type names
 */
function getEnabledTrinketTypes() {
  var trinketFeatures = config.features && config.features.trinkets;

  if (!trinketFeatures) {
    return [];
  }

  return Object.keys(trinketFeatures).filter(function(lang) {
    return trinketFeatures[lang] === true;
  });
}

/**
 * Get list of all disabled trinket types
 * @returns {string[]} - Array of disabled trinket type names
 */
function getDisabledTrinketTypes() {
  var trinketFeatures = config.features && config.features.trinkets;

  if (!trinketFeatures) {
    return [];
  }

  return Object.keys(trinketFeatures).filter(function(lang) {
    return trinketFeatures[lang] === false;
  });
}

/**
 * Check if a string is a known trinket type (regardless of enabled/disabled)
 * @param {string} lang - The potential trinket language/type
 * @returns {boolean} - True if it's a known type, false otherwise
 */
function isKnownTrinketType(lang) {
  var trinketFeatures = config.features && config.features.trinkets;

  if (!trinketFeatures) {
    return false;
  }

  return trinketFeatures.hasOwnProperty(lang);
}

module.exports = {
  isCoursesEnabled: isCoursesEnabled,
  isTrinketTypeEnabled: isTrinketTypeEnabled,
  getEnabledTrinketTypes: getEnabledTrinketTypes,
  getDisabledTrinketTypes: getDisabledTrinketTypes,
  isKnownTrinketType: isKnownTrinketType
};
