/* Waveform viewer for the Analyzer: digital traces (from logiccore channels), decode lanes, a time ruler, zoom, pan and two measurement cursors.
 * Everything is drawn as SVG built with createElementNS and setAttribute / textContent, never innerHTML. */
(function (root) {
  'use strict';
  const UI = root.AletheonUI, L = root.AletheonLogic;

  // One unit for a whole ruler: chosen from the tick step (or from the value itself when there is no step).
  function fmtTime(us, step) {
    const ref = step || Math.abs(us), unit = ref >= 1e6 ? 1e6 : ref >= 1000 ? 1000 : 1, name = unit === 1e6 ? ' s' : unit === 1000 ? ' ms' : ' µs';
    const stepU = (step || Math.abs(us) / 100 || 1) / unit, dec = Math.min(6, Math.max(0, Math.ceil(-Math.log10(stepU) - 1e-9)));
    return (us / unit).toFixed(dec) + name;
  }
  function niceStep(span, target) {
    const raw = span / target, p = Math.pow(10, Math.floor(Math.log10(raw))), m = raw / p;
    return (m < 1.5 ? 1 : m < 3.5 ? 2 : m < 7.5 ? 5 : 10) * p;
  }

  function createWaveView(host) {
    const el = UI.el, svg = UI.svg;
    let data = { channels: [], lanes: [], annos: [], endUs: 1000 }, view = { t0: 0, t1: 1000 }, cursors = [], W = 600;
    const ctrl = el('div', 'tabs'), box = el('div'), readout = el('p', 'hint', 'Click the waveform to place cursor A, again for B (shows the time between them and its frequency), a third time to clear.');
    ctrl.style.marginTop = '0'; ctrl.style.marginBottom = '10px';
    const mk = (label, fn, aria) => { const b = el('button', '', label); b.type = 'button'; b.setAttribute('aria-label', aria || label); b.addEventListener('click', fn); ctrl.appendChild(b); return b; };
    const span = () => view.t1 - view.t0, full = () => Math.max(1, data.endUs);
    const clampView = () => {
      const f = full(), s = Math.min(Math.max(span(), 2), f * 1.2);
      view.t0 = Math.max(-0.05 * f, Math.min(view.t0, f * 1.05 - s)); view.t1 = view.t0 + s;
    };
    const zoom = (k) => { const mid = (view.t0 + view.t1) / 2, s = span() * k; view.t0 = mid - s / 2; view.t1 = mid + s / 2; clampView(); draw(); };
    const pan = (k) => { const d = span() * k; view.t0 += d; view.t1 += d; clampView(); draw(); };
    const fit = () => { view = { t0: -0.02 * full(), t1: full() * 1.02 }; draw(); };
    mk('Zoom in', () => zoom(0.5)); mk('Zoom out', () => zoom(2)); mk('Fit', fit); mk('◀', () => pan(-0.3), 'Pan left'); mk('▶', () => pan(0.3), 'Pan right');
    host.appendChild(ctrl); host.appendChild(box); host.appendChild(readout);

    function draw() {
      UI.clear(box);
      W = Math.max(300, box.clientWidth || host.clientWidth || 600);
      const LEFT = 64, RIGHT = 8, RULER = 24, LANE = 46, ALANE = 26, nCh = data.channels.length, nA = data.lanes.length;
      const H = RULER + nCh * LANE + nA * ALANE + 8, w = W - LEFT - RIGHT;
      const X = (t) => LEFT + ((t - view.t0) / span()) * w;
      const s = svg('svg', { viewBox: '0 0 ' + W + ' ' + H, class: 'wave', role: 'img', 'aria-label': 'Digital waveform: ' + data.channels.map((c) => c.name).join(', ') });
      s.setAttribute('width', W); s.setAttribute('height', H);
      // ruler
      const step = niceStep(span(), Math.max(3, Math.floor(w / 110)));
      for (let t = Math.ceil(view.t0 / step) * step, n = 0; t <= view.t1 && n < 200 && t + step > t; t += step, n++) { // capped: a huge time with a tiny step must not hang the page
        const x = X(t);
        s.appendChild(svg('line', { x1: x, x2: x, y1: RULER - 4, y2: H - 4, class: 'gr' }));
        const tx = svg('text', { x: x + 3, y: 12, class: 'tk' }); tx.textContent = fmtTime(t, step); s.appendChild(tx);
      }
      // traces
      data.channels.forEach((c, i) => {
        const top = RULER + i * LANE, yH = top + 8, yL = top + LANE - 10, ch = c.ch;
        const lab = svg('text', { x: 6, y: top + LANE / 2 + 4, class: 'lb' }); lab.textContent = c.name; s.appendChild(lab);
        let lvl = L.levelAt(ch, view.t0), d = 'M' + LEFT + ' ' + (lvl ? yH : yL);
        let lo = 0, hi = ch.edges.length;
        while (lo < hi) { const m = (lo + hi) >> 1; if (ch.edges[m] <= view.t0) lo = m + 1; else hi = m; }
        for (let k = lo; k < ch.edges.length && ch.edges[k] <= view.t1; k++) { lvl ^= 1; d += 'H' + X(ch.edges[k]).toFixed(1) + 'V' + (lvl ? yH : yL); }
        d += 'H' + (LEFT + w);
        s.appendChild(svg('path', { d, class: 'tr' }));
      });
      // decode lanes
      data.lanes.forEach((name, i) => {
        const top = RULER + nCh * LANE + i * ALANE;
        const lab = svg('text', { x: 6, y: top + 17, class: 'lb' }); lab.textContent = name; s.appendChild(lab);
        data.annos.filter((a) => a.lane === i && a.t1 >= view.t0 && a.t0 <= view.t1).forEach((a) => {
          const x0 = Math.max(LEFT, X(a.t0)), x1 = Math.min(LEFT + w, X(a.t1)), wd = Math.max(1, x1 - x0);
          const g = svg('g'); const t = svg('title'); t.textContent = a.title || a.text; g.appendChild(t);
          g.appendChild(svg('rect', { x: x0, y: top + 3, width: wd, height: ALANE - 7, rx: 4, class: 'an ' + (a.cls || '') }));
          if (wd > a.text.length * 6.5 + 6) { const tx = svg('text', { x: x0 + wd / 2, y: top + 17, 'text-anchor': 'middle', class: 'at' }); tx.textContent = a.text; g.appendChild(tx); }
          s.appendChild(g);
        });
      });
      // cursors
      cursors.forEach((t, i) => {
        if (t < view.t0 || t > view.t1) return;
        const x = X(t);
        s.appendChild(svg('line', { x1: x, x2: x, y1: RULER - 4, y2: H - 4, class: 'cur' }));
        const tx = svg('text', { x: x + 3, y: H - 8, class: 'cl' }); tx.textContent = i ? 'B' : 'A'; s.appendChild(tx);
      });
      const hit = svg('rect', { x: LEFT, y: 0, width: w, height: H, fill: 'transparent' });
      hit.addEventListener('click', (e) => {
        const r = s.getBoundingClientRect(), t = view.t0 + (((e.clientX - r.left) * (W / r.width) - LEFT) / w) * span();
        if (cursors.length >= 2) cursors = []; cursors.push(t); draw();
      });
      s.appendChild(hit);
      box.appendChild(s);
      readout.textContent = cursors.length === 2 ? 'A → B: ' + fmtTime(Math.abs(cursors[1] - cursors[0]), Math.abs(cursors[1] - cursors[0]) / 100) + '  (' + (Math.abs(cursors[1] - cursors[0]) > 0 ? UI.fmtNum(1e6 / Math.abs(cursors[1] - cursors[0]), 4) + ' Hz if this is one period' : '—') + ')' : cursors.length === 1 ? 'Cursor A at ' + fmtTime(cursors[0], span() / 100) + '. Click again to place B.' : 'Click the waveform to place cursor A, again for B (shows the time between them and its frequency), a third time to clear.';
    }

    let rs = null;
    if (typeof root.ResizeObserver === 'function') { rs = new root.ResizeObserver(() => { if (box.clientWidth && Math.abs(box.clientWidth - W) > 4) draw(); }); rs.observe(box); }
    return {
      set(d) { data = { channels: d.channels, lanes: d.lanes || [], annos: d.annos || [], endUs: d.endUs || 1000 }; cursors = []; fit(); },
      zoomToWindow(t0, t1) { view = { t0, t1 }; clampView(); draw(); },
    };
  }
  root.AletheonWave = { createWaveView, fmtTime };
})(window);
