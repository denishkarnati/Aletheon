/* Driver-verified parts: register facts quoted from open-source drivers at pinned commits (window.DRIVER_FACTS, built by site/tools/build-devices.mjs).
 * These are not simulated and not checked against a datasheet; each fact says how many independent sources back it.
 * Everything is written with textContent / DOM nodes, never innerHTML. */
(function () {
  'use strict';
  var DATA = window.DRIVER_FACTS, box = document.getElementById('drv');
  if (!box) return;
  if (!DATA || !DATA.parts) { box.textContent = 'The driver-verified data failed to load.'; return; }
  var el = function (tag, cls, text) { var n = document.createElement(tag); if (cls) n.className = cls; if (text !== undefined) n.textContent = text; return n; };
  var TIER = {
    'cross-checked': { cls: 'xchk', label: 'two sources agree' },
    'single-source': { cls: 'deriv', label: 'one source' },
    conflict: { cls: 'bad', label: 'sources differ' }
  };
  var link = function (src) {
    var a = el('a', '', src.repo + ' @ ' + src.commit.slice(0, 8) + ' · ' + src.license);
    a.href = 'https://github.com/' + src.repo + '/blob/' + src.commit + '/' + src.path;
    a.target = '_blank'; a.rel = 'noopener noreferrer'; a.style.textDecoration = 'underline';
    return a;
  };

  DATA.parts.forEach(function (p) {
    var tally = { 'cross-checked': 0, 'single-source': 0, conflict: 0 };
    p.facts.forEach(function (f) { tally[f.tier]++; });
    var d = el('details', 'drvpart');
    var s = el('summary'); s.appendChild(el('b', '', p.part));
    s.appendChild(el('span', '', ' ' + p.kind + ' · ' + p.vendor + ' · ' + tally['cross-checked'] + ' agreed, ' + tally['single-source'] + ' single-source, ' + tally.conflict + ' conflicting'));
    d.appendChild(s);

    var srcs = el('div', 'srcbox'); srcs.appendChild(el('b', '', 'Sources (public driver files, facts only): '));
    p.sources.forEach(function (x, i) { if (i) srcs.appendChild(document.createTextNode('  |  ')); srcs.appendChild(link(x)); });
    d.appendChild(srcs);

    var grid = el('div', 'facts');
    var label = {}; p.sources.forEach(function (x) { label[x.id] = x.id === 'no-os' ? 'ADI no-OS' : x.id === 'zephyr' ? 'Zephyr' : x.id; });
    p.facts.forEach(function (f) {
      var t = TIER[f.tier] || TIER['single-source'], c = el('div', 'fact');
      c.appendChild(el('p', '', f.conflict ? f.what + '.' : f.what + ': ' + f.value + '.'));
      f.cites.forEach(function (q) { c.appendChild(el('q', '', label[q.src] + ': ' + q.q)); });
      var pg = el('div', 'pg'); pg.appendChild(el('span', 'tr ' + t.cls, t.label)); c.appendChild(pg);
      grid.appendChild(c);
    });
    d.appendChild(grid);

    var gh = el('p', 'hint', 'Not established from these sources (needs the datasheet):'); d.appendChild(gh);
    var ul = el('ul', 'nm'); p.gaps.forEach(function (g) { ul.appendChild(el('li', '', g)); }); d.appendChild(ul);
    box.appendChild(d);
  });
})();
