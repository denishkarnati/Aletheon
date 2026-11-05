/* Tiny DOM helpers shared by the Bench, Analyzer and Labs pages. Everything is built with createElement and textContent, never innerHTML,
 * so nothing a simulation prints (a payload, a log line) can inject markup. */
(function (root) {
  'use strict';
  var SVGNS = 'http://www.w3.org/2000/svg';

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined && text !== null) n.textContent = text;
    return n;
  }
  function svg(tag, attrs) {
    var n = document.createElementNS(SVGNS, tag);
    if (attrs) for (var k in attrs) if (Object.prototype.hasOwnProperty.call(attrs, k)) n.setAttribute(k, attrs[k]);
    return n;
  }
  function clear(n) { while (n.firstChild) n.removeChild(n.firstChild); return n; }
  function $(id) { return document.getElementById(id); }

  function fmtNum(x, digits) {
    if (x === Infinity) return '∞';
    if (!isFinite(x)) return '—';
    var a = Math.abs(x);
    if (a !== 0 && (a >= 1e6 || a < 1e-3)) return x.toExponential(2);
    if (digits === undefined) digits = a >= 100 ? 1 : a >= 10 ? 2 : 3;
    return x.toFixed(digits).replace(/\.?0+$/, function (m) { return m.indexOf('.') >= 0 ? '' : m; });
  }
  function fmtDuration(ms) {
    var s = Math.floor(ms / 1000), d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
    var p = function (n) { return (n < 10 ? '0' : '') + n; };
    return (d ? d + 'd ' : '') + p(h) + ':' + p(m) + ':' + p(sec);
  }
  function fmtLife(days) {
    if (days === Infinity) return 'forever';
    if (days >= 730) return fmtNum(days / 365.25, 1) + ' years';
    if (days >= 60) return fmtNum(days / 30.44, 1) + ' months';
    if (days >= 2) return fmtNum(days, 1) + ' days';
    return fmtNum(days * 24, 1) + ' hours';
  }
  function hex2(n) { return '0x' + (n & 0xff).toString(16).toUpperCase().padStart(2, '0'); }

  // A number field wired to a setter. Rejects non-numbers instead of passing NaN to a simulation.
  function numberField(label, value, set, opts) {
    opts = opts || {};
    var row = el('label', 'fld');
    row.appendChild(el('span', '', label));
    var inp = el('input'); inp.type = 'number'; inp.value = value; inp.step = opts.step || 'any';
    if (opts.min !== undefined) inp.min = opts.min;
    if (opts.max !== undefined) inp.max = opts.max;
    inp.setAttribute('aria-label', label);
    inp.addEventListener('input', function () { var v = Number(inp.value); if (inp.value !== '' && isFinite(v)) set(v); });
    row.appendChild(inp);
    return row;
  }
  function selectField(label, options, value, set) {
    var row = el('label', 'fld');
    row.appendChild(el('span', '', label));
    var s = el('select'); s.setAttribute('aria-label', label);
    options.forEach(function (o) { var op = el('option', '', o.label); op.value = o.value; if (String(o.value) === String(value)) op.selected = true; s.appendChild(op); });
    s.addEventListener('change', function () { set(s.value); });
    row.appendChild(s);
    return row;
  }
  function checkField(label, value, set) {
    var row = el('label', 'chk');
    var c = el('input'); c.type = 'checkbox'; c.checked = !!value;
    c.addEventListener('change', function () { set(c.checked); });
    row.appendChild(c); row.appendChild(el('span', '', label));
    return row;
  }

  // Line chart: series is [{x:[], y:[], cls}]. Returns the <svg>. Axes are labelled with the first and last x and the y extent.
  function lineChart(opts) {
    var W = opts.width || 640, H = opts.height || 220, L = 52, R = 10, T = 10, B = 24;
    var s = svg('svg', { viewBox: '0 0 ' + W + ' ' + H, class: 'chart', role: 'img', 'aria-label': opts.label || 'chart' });
    var xs = [], ys = [];
    opts.series.forEach(function (se) { se.x.forEach(function (v) { xs.push(v); }); se.y.forEach(function (v) { ys.push(v); }); });
    if (!xs.length) { var t0 = svg('text', { x: W / 2, y: H / 2, 'text-anchor': 'middle' }); t0.textContent = opts.empty || 'no data yet'; s.appendChild(t0); return s; }
    var x0 = Math.min.apply(null, xs), x1 = Math.max.apply(null, xs), y0 = Math.min.apply(null, ys), y1 = Math.max.apply(null, ys);
    if (x1 === x0) x1 = x0 + 1;
    if (y1 === y0) { y0 -= 1; y1 += 1; }
    var pad = (y1 - y0) * 0.08; y0 -= pad; y1 += pad;
    var X = function (v) { return L + ((v - x0) / (x1 - x0)) * (W - L - R); }, Y = function (v) { return T + (1 - (v - y0) / (y1 - y0)) * (H - T - B); };
    for (var i = 0; i <= 4; i++) {
      var yy = T + (i / 4) * (H - T - B), val = y1 - (i / 4) * (y1 - y0);
      s.appendChild(svg('line', { x1: L, x2: W - R, y1: yy, y2: yy, class: 'grid' }));
      var lab = svg('text', { x: L - 6, y: yy + 3, 'text-anchor': 'end' }); lab.textContent = fmtNum(val, 2); s.appendChild(lab);
    }
    var xl = svg('text', { x: L, y: H - 6 }); xl.textContent = (opts.xfmt || fmtDuration)(x0); s.appendChild(xl);
    var xr = svg('text', { x: W - R, y: H - 6, 'text-anchor': 'end' }); xr.textContent = (opts.xfmt || fmtDuration)(x1); s.appendChild(xr);
    opts.series.forEach(function (se) {
      if (!se.x.length) return;
      var pts = se.x.map(function (v, k) { return X(v).toFixed(1) + ',' + Y(se.y[k]).toFixed(1); }).join(' ');
      s.appendChild(svg('polyline', { points: pts, class: se.cls || 'ser', 'vector-effect': 'non-scaling-stroke' }));
      if (se.dots) se.x.forEach(function (v, k) { s.appendChild(svg('circle', { cx: X(v).toFixed(1), cy: Y(se.y[k]).toFixed(1), r: 2, class: 'dot' })); });
    });
    return s;
  }

  root.AletheonUI = { el: el, svg: svg, clear: clear, $: $, fmtNum: fmtNum, fmtDuration: fmtDuration, fmtLife: fmtLife, hex2: hex2, numberField: numberField, selectField: selectField, checkField: checkField, lineChart: lineChart };
})(window);
