/* Browser port of src/core/audit.ts (claim auditing). Same rules, no dependencies.
 * A hardware value (hex address, quantity with a unit, GPIO/port pin) must be cited with an [E#] whose excerpt contains it.
 * Parity with the TypeScript implementation is checked by site/tools/test-audit-port.mjs. */
(function (root) {
  'use strict';
  var UNITS = 'mA|µA|uA|V|MHz|kHz|GHz|ns|µs|us|ms|baud|kB|MB|ksps';
  var TRUST_RANK = { measured: 5, 'vendor-official': 4, derived: 3, 'user-supplied': 2, 'community-mirror': 1, unknown: 0 };

  function hexNorm(h) { return h.replace(/^0+(?=.)/, '').toLowerCase(); }

  function extractValues(text) {
    var out = [], seen = {}, m;
    function add(v) { if (!seen[v]) { seen[v] = 1; out.push(v); } }
    var reHex = /\b0x([0-9a-f]{2,})(?:u|ul|ull|l)?\b/gi;
    var reQty = new RegExp('(\\d+(?:\\.\\d+)?)\\s?(' + UNITS + ')\\b', 'gi');
    var reGpio = /\bGPIO\s?(\d+)\b/gi;
    var rePort = /\bP([A-K])(\d{1,2})\b/g;
    while ((m = reHex.exec(text))) add('hex:' + hexNorm(m[1]));
    while ((m = reQty.exec(text))) add('qty:' + parseFloat(m[1]) + m[2].toLowerCase().replace('µ', 'u'));
    while ((m = reGpio.exec(text))) add('pin:gpio' + (+m[1]));
    while ((m = rePort.exec(text))) add('pin:p' + m[1].toLowerCase() + (+m[2]));
    return out;
  }

  var CITE = /\[(E\d+(?:\s*,\s*E\d+)*)\]/g;

  function byId(ledger) { var o = {}; ledger.forEach(function (e) { o[e.id] = e; }); return o; }

  // Returns the same report as auditClaims, plus `segments` (text pieces in order, each tagged with its claim result or null)
  function audit(answer, ledger) {
    var ids = byId(ledger);
    var prose = answer.replace(/```[\s\S]*?```/g, '');
    var parts = prose.split(/((?<=[.!?])\s+|\n+)/);
    var claims = [], segments = [];
    parts.forEach(function (raw, i) {
      if (i % 2 === 1) { segments.push({ text: raw, claim: null }); return; }
      var sentence = raw.trim();
      var seg = { text: raw, claim: null };
      segments.push(seg);
      if (!sentence) return;
      var cleaned = sentence.replace(CITE, ' ');
      var values = extractValues(cleaned);
      if (!values.length) return;
      var cited = [], mm, re = new RegExp(CITE.source, 'g');
      while ((mm = re.exec(sentence))) mm[1].split(',').forEach(function (s) { cited.push(s.trim()); });
      var c = { sentence: sentence, values: values, cited: cited, status: '' };
      if (/UNVERIFIED/i.test(sentence)) c.status = 'declared-unverified';
      else if (!cited.length) c.status = 'uncited';
      else if (cited.some(function (id) { return !ids[id]; })) c.status = 'unknown-citation';
      else {
        var ev = cited.map(function (id) { return ids[id]; });
        var found = {};
        ev.forEach(function (e) { extractValues(e.excerpt).forEach(function (v) { found[v] = 1; }); });
        var missing = values.filter(function (v) { return !found[v]; });
        var supporters = ev.filter(function (e) { return extractValues(e.excerpt).some(function (v) { return values.indexOf(v) >= 0; }); });
        var weak = !missing.length && supporters.length > 0 &&
          Math.max.apply(null, supporters.map(function (e) { return TRUST_RANK[e.trust || 'unknown']; })) <= TRUST_RANK['community-mirror'];
        c.status = missing.length ? 'unsupported' : 'supported';
        if (missing.length) c.missing = missing;
        if (weak) c.weakSource = true;
      }
      claims.push(c);
      seg.claim = c;
    });
    var counts = { supported: 0, unsupported: 0, uncited: 0, 'unknown-citation': 0, 'declared-unverified': 0 };
    claims.forEach(function (c) { counts[c.status]++; });
    return {
      claims: claims, segments: segments, counts: counts,
      weak: claims.filter(function (c) { return c.weakSource; }).length,
      ok: !counts.unsupported && !counts.uncited && !counts['unknown-citation']
    };
  }

  var api = { extractValues: extractValues, audit: audit };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.AletheonAudit = api;
})(typeof window !== 'undefined' ? window : this);
