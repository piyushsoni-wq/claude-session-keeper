'use strict';

// POSIX single-quote escaping: wrap the whole string in single quotes,
// turning each embedded single quote into '\'' (close quote, escaped
// literal quote, reopen quote). Safe against $, `, spaces, and empty
// strings. An earlier version of this function (see the PRD this repo
// was rebuilt from) had a real bug from nested template-literal escaping
// that only surfaced under a real bash round-trip with adversarial
// input — don't change this without re-running that same kind of test
// (see test/shell.test.js).
function shQuote(str) {
  return "'" + String(str).replace(/'/g, "'\\''") + "'";
}

// AppleScript string-literal escaping, for building a `do script "..."`
// payload. AppleScript has its own escaping rules (backslash and double
// quote), independent of shQuote's POSIX single-quote rules — this is a
// second, separate quoting layer, not a reuse of shQuote.
function asQuote(str) {
  return '"' + String(str).replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
}

module.exports = { shQuote, asQuote };
