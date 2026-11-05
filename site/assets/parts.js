/* Parts catalog UI. Data: window.PARTS (KiCad symbol libraries, CC-BY-SA 4.0) and window.DEVICES (Device Lab models).
 * All text is written with textContent; links are only emitted for http(s) URLs. */
(function () {
  'use strict';
  function main() {
  var P = window.PARTS, D = window.DEVICES;
  var $ = function (id) { return document.getElementById(id); };
  var el = function (tag, cls, text) { var n = document.createElement(tag); if (cls) n.className = cls; if (text !== undefined) n.textContent = text; return n; };
  if (!P) { $('count').textContent = 'The parts data failed to load.'; return; }
  $('kpis').textContent = ''; $('kpis').removeAttribute('aria-hidden'); // replace the loading skeleton
  var ci = {}; P.cols.forEach(function (c, i) { ci[c] = i; });
  var rows = P.rows, PAGE = 80, shown = PAGE, view = rows, state = { q: '', cat: '', vendor: '', iface: '', lab: false };
  var devs = (D && D.devices) || [];
  var profiles = {}; ((P.meta.vendorProfiles || {}).vendors || []).forEach(function (v) { profiles[v.name] = v; });
  var labOf = function (name) { var u = name.toUpperCase(); for (var i = 0; i < devs.length; i++) if (u.indexOf(devs[i].part) === 0) return devs[i]; return null; };
  var safeUrl = function (u) { return /^https?:\/\//i.test(u) ? u : ''; };
  var hostOf = function (u) { try { return new URL(u).hostname.replace(/^www\./, ''); } catch (e) { return ''; } };
  var fmt = function (n) { return n.toLocaleString('en-US'); };

  // ---- header numbers and filter controls -------------------------------------------------------------------------------
  var labCount = rows.filter(function (r) { return labOf(r[ci.name]); }).length;
  [[fmt(P.meta.counts.parts), 'components'], [String(P.meta.cats.length), 'categories'], [String(P.meta.vendors.length), 'manufacturers identified'], [fmt(P.meta.counts.withIface), 'with a known bus interface'], [String(devs.length), 'parts you can simulate']].forEach(function (k) {
    var d = el('div', 'kpi'); d.appendChild(el('b', '', k[0])); d.appendChild(el('span', '', k[1])); $('kpis').appendChild(d);
  });
  $('srcline').textContent = P.meta.source.repo + ' @ ' + P.meta.source.commit + ', ' + P.meta.generated;

  function chip(box, label, count, key, val) {
    var b = el('button', 'ch', label); b.type = 'button'; b.setAttribute('aria-pressed', 'false'); b.dataset.val = val;
    if (count !== undefined) b.appendChild(el('i', '', fmt(count)));
    b.addEventListener('click', function () { state[key] = state[key] === val ? '' : val; shown = PAGE; sync(); apply(); });
    box.appendChild(b);
  }
  P.meta.cats.forEach(function (c) { chip($('cats'), c[0], c[1], 'cat', c[0]); });
  P.meta.ifaces.forEach(function (c) { chip($('ifs'), c[0], c[1], 'iface', c[0]); });
  var vs = $('vendor'); var o0 = el('option', '', 'All manufacturers'); o0.value = ''; vs.appendChild(o0);
  P.meta.vendors.forEach(function (v) { var o = el('option', '', v[0] + '  (' + fmt(v[1]) + ')'); o.value = v[0]; vs.appendChild(o); });
  vs.addEventListener('change', function () { state.vendor = vs.value; shown = PAGE; apply(); });
  $('labOnly').addEventListener('click', function () { state.lab = !state.lab; shown = PAGE; sync(); apply(); });
  var timer; $('q').addEventListener('input', function () { clearTimeout(timer); timer = setTimeout(function () { state.q = $('q').value; shown = PAGE; apply(); }, 120); });
  $('more').addEventListener('click', function () { shown += PAGE * 2; render(); });

  function sync() {
    Array.prototype.forEach.call(document.querySelectorAll('#cats .ch'), function (b) { var on = b.dataset.val === state.cat; b.classList.toggle('on', on); b.setAttribute('aria-pressed', on); });
    Array.prototype.forEach.call(document.querySelectorAll('#ifs .ch'), function (b) { var on = b.dataset.val === state.iface; b.classList.toggle('on', on); b.setAttribute('aria-pressed', on); });
    $('labOnly').classList.toggle('on', state.lab); $('labOnly').setAttribute('aria-pressed', state.lab);
  }

  // ---- filtering and ranking ------------------------------------------------------------------------------------------------
  var hay = rows.map(function (r) { return (r[ci.name] + ' ' + r[ci.desc] + ' ' + r[ci.kw] + ' ' + r[ci.vendor] + ' ' + r[ci.pinNames] + ' ' + r[ci.lib] + ' ' + r[ci.ifaces]).toLowerCase(); });
  function apply() {
    var toks = state.q.toLowerCase().split(/[\s,]+/).filter(Boolean), out = [];
    for (var i = 0; i < rows.length; i++) {
      var r = rows[i];
      if (state.cat && r[ci.cat] !== state.cat) continue;
      if (state.vendor && r[ci.vendor] !== state.vendor) continue;
      if (state.iface && r[ci.ifaces].split(' ').indexOf(state.iface) < 0) continue;
      if (state.lab && !labOf(r[ci.name])) continue;
      var ok = true; for (var t = 0; t < toks.length; t++) if (hay[i].indexOf(toks[t]) < 0) { ok = false; break; }
      if (!ok) continue;
      var s = 0; if (toks.length) { var n = r[ci.name].toLowerCase(); s = n === toks[0] ? 3 : n.indexOf(toks[0]) === 0 ? 2 : n.indexOf(toks[0]) > 0 ? 1 : 0; }
      out.push([s, i]);
    }
    if (toks.length) out.sort(function (a, b) { return b[0] - a[0] || a[1] - b[1]; });
    view = out.map(function (x) { return rows[x[1]]; });
    render();
    try { history.replaceState(null, '', state.q ? '#q=' + encodeURIComponent(state.q) : location.pathname + location.search); } catch (e) {}
  }

  function render() {
    var tb = $('tb'); tb.textContent = '';
    $('count').textContent = fmt(view.length) + ' part' + (view.length === 1 ? '' : 's');
    $('hint').textContent = state.q || state.cat || state.vendor || state.iface || state.lab ? 'filtered from ' + fmt(rows.length) : 'click any row for details';
    if (!view.length) { var tr = el('tr'); var td = el('td', 'empty', 'Nothing matches. Try fewer words, or clear a filter.'); td.colSpan = 5; tr.appendChild(td); tb.appendChild(tr); $('more').style.display = 'none'; return; }
    view.slice(0, shown).forEach(function (r) {
      var tr = el('tr', 'r'); tr.tabIndex = 0;
      var n = el('td', 'n'); n.appendChild(el('b', '', r[ci.name])); n.appendChild(el('small', '', r[ci.desc]));
      tr.appendChild(n); tr.appendChild(el('td', '', r[ci.cat])); tr.appendChild(el('td', '', r[ci.vendor] || '—'));
      var ti = el('td'); r[ci.ifaces].split(' ').filter(Boolean).forEach(function (x) { ti.appendChild(el('span', 'tag', x)); }); if (labOf(r[ci.name])) ti.appendChild(el('span', 'tag lab', 'Lab')); tr.appendChild(ti);
      tr.appendChild(el('td', 'num', r[ci.pins] ? String(r[ci.pins]) : '—'));
      var open = function () { openDrawer(r); }; tr.addEventListener('click', open); tr.addEventListener('keydown', function (e) { if (e.key === 'Enter') open(); });
      tb.appendChild(tr);
    });
    $('more').style.display = view.length > shown ? '' : 'none';
    $('more').textContent = 'Show more (' + fmt(view.length - shown) + ' left)';
  }

  // ---- drawer ----------------------------------------------------------------------------------------------------------------
  var lastFocus = null;
  function link(parent, cls, text, url, small) {
    var a = el('a', cls); a.href = safeUrl(url); a.target = '_blank'; a.rel = 'noopener noreferrer';
    a.appendChild(el('span', '', text)); if (small) a.appendChild(el('small', '', small)); parent.appendChild(a); return a;
  }
  function openDrawer(r) {
    lastFocus = document.activeElement;
    var b = $('dBody'); b.textContent = '';
    var lab = labOf(r[ci.name]), vend = r[ci.vendor], prof = profiles[vend];
    b.appendChild(el('div', 'lbl', r[ci.cat]));
    var h = el('h2', '', r[ci.name]); h.id = 'dTitle'; b.appendChild(h);
    b.appendChild(el('p', 'note', r[ci.desc] || 'No description in the source data.'));

    var kv = el('dl', 'kv');
    var add = function (k, v, extra) { kv.appendChild(el('dt', '', k)); var dd = el('dd', '', v); if (extra) dd.appendChild(extra); kv.appendChild(dd); };
    add('Manufacturer', vend || 'not identified', vend ? el('span', 'tr deriv', 'from datasheet domain') : null);
    add('Pins', r[ci.pins] ? String(r[ci.pins]) : 'not listed');
    add('KiCad footprint', r[ci.fp] || 'none');
    add('KiCad library', r[ci.lib]);
    var ifs = r[ci.ifaces].split(' ').filter(Boolean);
    add('Interfaces', ifs.length ? ifs.join(', ') : 'none detected', ifs.length ? el('span', 'tr deriv', 'derived') : null);
    b.appendChild(kv);

    if (r[ci.pinNames]) {
      b.appendChild(el('h4', '', 'Pin names'));
      var pn = el('div'); r[ci.pinNames].split(' ').forEach(function (x) { pn.appendChild(el('span', 'tag', x)); }); b.appendChild(pn);
      b.appendChild(el('p', 'note', 'As named in the KiCad symbol; the order is the symbol’s, not the pin numbers.'));
    }

    if (lab) {
      b.appendChild(el('h4', '', 'Checked against the datasheet'));
      b.appendChild(el('p', 'note', lab.part + ' is modeled from ' + lab.vendor + ' datasheet ' + lab.source.doc + ' (' + lab.source.rev + '). Every value below was checked against the cited page of the PDF. Variants of the part (' + r[ci.name] + ') can differ, for example in package or accuracy grade.'));
      var wrap = el('div', 'tw mini'); var t = el('table'); t.style.minWidth = '0';
      var hd = el('tr'); ['Addr', 'Register', 'Reset', 'Page'].forEach(function (x) { hd.appendChild(el('th', '', x)); }); var th = el('thead'); th.appendChild(hd); t.appendChild(th);
      var tbd = el('tbody'); lab.registers.forEach(function (g) { var tr = el('tr'); [g.addr, g.name, g.reset, 'p. ' + g.cite.p].forEach(function (x, i) { tr.appendChild(el('td', i === 1 ? '' : 'mono', x)); }); tbd.appendChild(tr); });
      t.appendChild(tbd); wrap.appendChild(t); b.appendChild(wrap);
      b.appendChild(el('p', 'note', 'I2C addresses: ' + lab.addresses.map(function (a) { return a.addr; }).join(', ') + ' (selected by pin strapping).'));
      var cta = el('div', 'cta'); var go = el('a', 'btn primary', 'Simulate ' + lab.part + ' in the Device Lab ▸'); go.href = 'lab.html#' + lab.id; cta.appendChild(go); b.appendChild(cta);
    }

    b.appendChild(el('h4', '', 'Contact the manufacturer'));
    if (prof) {
      var vl = el('div', 'vlinks');
      link(vl, '', prof.name + ' website', prof.website, hostOf(prof.website));
      prof.links.forEach(function (l) { link(vl, '', l.kind + ': ' + l.label, l.url, hostOf(l.url)); });
      b.appendChild(vl);
      b.appendChild(el('p', 'note', 'Official company pages, checked ' + P.meta.vendorProfiles.checked + '. No personal contacts are listed. Opening a link leaves this site.'));
    } else if (vend) {
      b.appendChild(el('p', 'note', 'No contact profile for ' + vend + ' yet. Use the manufacturer’s own site, reachable from the datasheet link below.'));
    } else {
      b.appendChild(el('p', 'note', 'The datasheet link does not point to a manufacturer we recognise, so no company is shown.'));
    }

    b.appendChild(el('h4', '', 'Datasheet'));
    if (r[ci.ds]) {
      var cta2 = el('div', 'cta'); var a = el('a', 'btn ghost', 'Open the datasheet ↗'); a.href = safeUrl(r[ci.ds]); a.target = '_blank'; a.rel = 'noopener noreferrer'; cta2.appendChild(a); b.appendChild(cta2);
      b.appendChild(el('p', 'note', 'Link from the KiCad symbol, opens ' + hostOf(r[ci.ds]) + '. We do not copy or host datasheets; parts with a Lab model carry our own page-cited summary instead.'));
    } else b.appendChild(el('p', 'note', 'The KiCad symbol has no datasheet link.'));

    $('veil').classList.add('on'); $('drawer').classList.add('on'); $('dx').focus();
  }
  function closeDrawer() { $('veil').classList.remove('on'); $('drawer').classList.remove('on'); if (lastFocus && lastFocus.focus) lastFocus.focus(); }
  $('dx').addEventListener('click', closeDrawer); $('veil').addEventListener('click', closeDrawer);
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && $('drawer').classList.contains('on')) closeDrawer(); });

  var m = /[#&]q=([^&]*)/.exec(location.hash || ''); if (m) { state.q = decodeURIComponent(m[1]); $('q').value = state.q; }
  sync(); apply();
  }

  // The 2.8 MB data file is fetched after the page has painted (skeleton rows are in the HTML), so a slow phone sees a page at once
  // instead of a blank screen while the script downloads and parses.
  function ready() { document.body.removeAttribute('aria-busy'); main(); }
  function failed() {
    document.body.removeAttribute('aria-busy');
    var c = document.getElementById('count'); if (c) c.textContent = 'The parts data failed to load. Check your connection and reload.';
    var tb = document.getElementById('tb'); if (tb) tb.textContent = '';
  }
  if (window.PARTS) ready();
  else {
    var s = document.createElement('script'); s.src = 'assets/parts-data.js'; s.async = true; s.onload = ready; s.onerror = failed;
    document.head.appendChild(s);
  }
})();
