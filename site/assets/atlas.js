/* Chip Atlas UI. Data: assets/atlas-data.js (generated from public manifests by site/tools/make-atlas-data.mjs). No network. */
(function () {
  'use strict';
  const A = window.ATLAS;
  if (!A) { document.getElementById('empty').hidden = false; return; }
  const $ = (s, r) => (r || document).querySelector(s), $$ = (s, r) => Array.from((r || document).querySelectorAll(s));
  const RM = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const ci = {}; A.cols.forEach((c, i) => { ci[c] = i; });
  const R = A.rows, g = (r, k) => r[ci[k]];
  const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  // Upstream data is untrusted: only ever link to http(s) (never javascript: or data:).
  const safeUrl = (u) => (/^https?:\/\/[^\s"'<>]+$/i.test(String(u)) ? String(u) : '');
  const H = R.map((r) => [g(r, 'name'), g(r, 'vendor'), g(r, 'si'), g(r, 'mcu'), g(r, 'arch'), g(r, 'platform')].join(' ').toLowerCase());

  const fmtMhz = (v) => (v >= 1000 ? v / 1000 + ' GHz' : (Math.round(v * 10) / 10) + ' MHz');
  const fmtKB = (v) => (v >= 1024 ? (Math.round((v / 1024) * 10) / 10) + ' MB' : (Math.round(v * 10) / 10) + ' KB');
  const STEP = { mhz: [0, 8, 16, 32, 48, 64, 80, 100, 120, 160, 200, 240, 400], fl: [0, 8, 32, 64, 128, 256, 512, 1024, 2048, 4096, 8192, 16384], ram: [0, 2, 8, 32, 64, 128, 256, 512, 1024, 2048] };
  const COLOR = (a) => (/^cortex/.test(a) ? '#F4F5F7' : /^xtensa/.test(a) ? '#9DB9FF' : a === 'avr' ? '#E9B866' : a === 'riscv' ? '#7BE0AE' : a === 'mips' ? '#FF7B7B' : '#8A909A');
  const FAMILY = (a) => (/^cortex/.test(a) ? 'Arm Cortex-M' : /^xtensa/.test(a) ? 'Xtensa' : a === 'avr' ? 'AVR' : a === 'riscv' ? 'RISC-V' : a === 'mips' ? 'MIPS' : 'Other');

  /* ---------- state ---------- */
  const S = { q: '', si: new Set(), arch: new Set(), conn: new Set(), dbg: new Set(), fw: new Set(), svd: false, tested: false, mhz: 0, fl: 0, ram: 0, sort: 'name', dir: 1, shown: 50, sel: [] };

  /* ---------- facets ---------- */
  const countBy = (k, arr) => { const m = {}; R.forEach((r) => { (arr ? g(r, k) : [g(r, k)]).forEach((x) => { if (x) m[x] = (m[x] || 0) + 1; }); }); return Object.entries(m).sort((a, b) => b[1] - a[1]); };
  const FSI = countBy('si').filter((x) => x[0] !== 'Other'), FARCH = countBy('arch').filter((x) => x[0] !== 'other'), FCONN = countBy('conn', true).slice(0, 10), FDBG = countBy('dbg', true), FFW = countBy('fw', true).slice(0, 10);
  const chip = (set, key, label, n) => '<button class="ch' + (S[set] instanceof Set ? (S[set].has(key) ? ' on' : '') : (S[set] ? ' on' : '')) + '" data-set="' + set + '" data-key="' + esc(key) + '">' + esc(label) + (n != null ? '<i>' + n + '</i>' : '') + '</button>';
  function renderFacets() {
    $('#fsvd').innerHTML = chip('svd', '1', 'Has register map') + chip('tested', '1', 'Aletheon-tested chip');
    $('#fsi').innerHTML = FSI.map((x) => chip('si', x[0], x[0], x[1])).join('');
    $('#farch').innerHTML = FARCH.map((x) => chip('arch', x[0], x[0], x[1])).join('');
    $('#fconn').innerHTML = FCONN.map((x) => chip('conn', x[0], x[0], x[1])).join('');
    $('#fdbg').innerHTML = FDBG.map((x) => chip('dbg', x[0], x[0], x[1])).join('');
    $('#ffw').innerHTML = FFW.map((x) => chip('fw', x[0], x[0], x[1])).join('');
  }
  document.addEventListener('click', (e) => {
    const b = e.target.closest('.ch'); if (!b) return;
    const set = b.getAttribute('data-set'), key = b.getAttribute('data-key');
    if (S[set] instanceof Set) { S[set].has(key) ? S[set].delete(key) : S[set].add(key); } else { S[set] = !S[set]; }
    S.shown = 50; renderFacets(); update();
  });

  /* ---------- filtering ---------- */
  function filtered() {
    const toks = S.q.toLowerCase().split(/\s+/).filter(Boolean);
    const mhz = STEP.mhz[S.mhz], fl = STEP.fl[S.fl], ram = STEP.ram[S.ram];
    const out = [];
    for (let i = 0; i < R.length; i++) {
      const r = R[i];
      if (toks.length && !toks.every((t) => H[i].indexOf(t) >= 0)) continue;
      if (S.si.size && !S.si.has(g(r, 'si'))) continue;
      if (S.arch.size && !S.arch.has(g(r, 'arch'))) continue;
      if (S.conn.size && !g(r, 'conn').some((x) => S.conn.has(x))) continue;
      if (S.dbg.size && !g(r, 'dbg').some((x) => S.dbg.has(x))) continue;
      if (S.fw.size && !g(r, 'fw').some((x) => S.fw.has(x))) continue;
      if (S.svd && !g(r, 'svd')) continue;
      if (S.tested && g(r, 'ale') !== 2) continue;
      if (g(r, 'mhz') < mhz || g(r, 'flashKB') < fl || g(r, 'ramKB') < ram) continue;
      out.push(i);
    }
    const k = S.sort, d = S.dir;
    const key = (i) => { const v = g(R[i], k); return Array.isArray(v) ? v.length : typeof v === 'string' ? v.toLowerCase() : v; };
    out.sort((a, b) => { const x = key(a), y = key(b); return (x < y ? -1 : x > y ? 1 : 0) * d || (g(R[a], 'name') < g(R[b], 'name') ? -1 : 1); });
    return out;
  }

  /* ---------- table ---------- */
  const COLS = [['name', 'Board'], ['mcu', 'MCU'], ['arch', 'Core'], ['mhz', 'Clock', 1], ['flashKB', 'Flash', 1], ['ramKB', 'RAM', 1], ['conn', 'Connectivity'], ['svd', 'Register map'], ['', '']];
  $('#thr').innerHTML = COLS.map((c) => '<th data-k="' + c[0] + '"' + (c[2] ? ' style="text-align:right"' : '') + '>' + c[1] + '</th>').join('');
  $('#thr').addEventListener('click', (e) => {
    const th = e.target.closest('th'); const k = th && th.getAttribute('data-k'); if (!k) return;
    if (S.sort === k) S.dir *= -1; else { S.sort = k; S.dir = (k === 'mhz' || k === 'flashKB' || k === 'ramKB') ? -1 : 1; }
    update();
  });
  function badge(r) {
    const ale = g(r, 'ale'), svd = g(r, 'svd');
    let h = svd ? '<span class="tr comm" title="CMSIS-SVD in the community mirror; basis: ' + (g(r, 'svdHow') === 'hint' ? 'manifest' : 'name') + '">community-mirror</span>' : '<span class="tr user">none found</span>';
    if (ale === 2) h += ' <span class="tr vendor">tested</span>'; else if (ale === 1) h += ' <span class="tr deriv">in registry</span>';
    return h;
  }
  function rowHtml(i) {
    const r = R[i], on = S.sel.indexOf(i) >= 0;
    return '<tr class="r' + (on ? ' sel' : '') + '" data-i="' + i + '"><td class="n"><b>' + esc(g(r, 'name')) + '</b><small>' + esc(g(r, 'vendor')) + ' · ' + esc(g(r, 'platform')) + '</small></td>' +
      '<td class="m">' + esc(g(r, 'mcu').toUpperCase()) + '<br><small style="color:var(--tx3);font-family:var(--sans)">' + esc(g(r, 'si')) + '</small></td><td style="white-space:nowrap">' + esc(g(r, 'arch')) + '</td>' +
      '<td class="num">' + fmtMhz(g(r, 'mhz')) + '</td><td class="num">' + fmtKB(g(r, 'flashKB')) + '</td><td class="num">' + fmtKB(g(r, 'ramKB')) + '</td>' +
      '<td>' + (g(r, 'conn').map((c) => '<span class="tag">' + esc(c) + '</span>').join('') || '<span style="color:var(--tx3)">·</span>') + '</td><td>' + badge(r) + '</td>' +
      '<td><span class="cmpb' + (on ? ' on' : '') + '" data-c="' + i + '" title="Compare">✓</span></td></tr>';
  }
  $('#tb').addEventListener('click', (e) => {
    const c = e.target.closest('.cmpb'); if (c) { toggleSel(+c.getAttribute('data-c')); e.stopPropagation(); return; }
    const tr = e.target.closest('tr.r'); if (tr) openDrawer(+tr.getAttribute('data-i'));
  });
  function toggleSel(i) {
    const k = S.sel.indexOf(i);
    if (k >= 0) S.sel.splice(k, 1); else { if (S.sel.length >= 3) S.sel.shift(); S.sel.push(i); }
    $$('#tb tr.r').forEach((tr) => { const on = S.sel.indexOf(+tr.getAttribute('data-i')) >= 0; tr.classList.toggle('sel', on); $('.cmpb', tr).classList.toggle('on', on); });
    const t = $('#tray'); t.classList.toggle('on', S.sel.length > 0);
    $('#traytxt').textContent = S.sel.length + ' selected: ' + S.sel.map((j) => g(R[j], 'name')).join('  ·  ');
    $('#cmpgo').disabled = S.sel.length < 2; $('#cmpgo').style.opacity = S.sel.length < 2 ? .4 : 1;
  }

  /* ---------- charts ---------- */
  const svgEl = $('#scat');
  const XB = [Math.log10(1), Math.log10(40000)], YB = [Math.log10(0.5), Math.log10(4096)];
  // Real outliers (an 8 GB RISC-V board) are pinned to the plot edge instead of drawing off-canvas; the tooltip still shows the true value.
  const px = (v) => 44 + ((Math.log10(Math.min(Math.max(v, 1), 40000)) - XB[0]) / (XB[1] - XB[0])) * 500, py = (v) => 222 - ((Math.log10(Math.min(Math.max(v, .5), 4096)) - YB[0]) / (YB[1] - YB[0])) * 200;
  function drawScatter(idx) {
    let s = '';
    [8, 64, 512, 4096, 32768].forEach((v) => { s += '<line class="axis" x1="' + px(v) + '" y1="22" x2="' + px(v) + '" y2="222"/><text class="axt" x="' + px(v) + '" y="240" text-anchor="middle">' + fmtKB(v) + '</text>'; });
    [1, 8, 64, 512, 2048].forEach((v) => { s += '<line class="axis" x1="44" y1="' + py(v) + '" x2="544" y2="' + py(v) + '"/><text class="axt" x="38" y="' + (py(v) + 3) + '" text-anchor="end">' + fmtKB(v) + '</text>'; });
    s += '<text class="axt" x="544" y="14" text-anchor="end">flash →  ·  ↑ RAM</text>';
    const fam = {};
    idx.forEach((i) => {
      const r = R[i], fl = g(r, 'flashKB'), ra = g(r, 'ramKB'); if (!(fl > 0 && ra > 0)) return;
      fam[FAMILY(g(r, 'arch'))] = COLOR(g(r, 'arch'));
      s += '<circle data-i="' + i + '" cx="' + px(fl) + '" cy="' + py(ra) + '" r="3.6" fill="' + COLOR(g(r, 'arch')) + '" fill-opacity=".72"><title>' + esc(g(r, 'name') + ' · ' + g(r, 'mcu').toUpperCase() + ' · ' + fmtMhz(g(r, 'mhz')) + ' · ' + fmtKB(fl) + ' flash · ' + fmtKB(ra) + ' RAM') + '</title></circle>';
    });
    svgEl.innerHTML = s;
    $('#scl').innerHTML = Object.keys(fam).map((k) => '<span><i style="background:' + fam[k] + '"></i>' + k + '</span>').join('');
    $('#scn').textContent = idx.length + ' boards';
  }
  svgEl.addEventListener('click', (e) => { const c = e.target.closest('circle'); if (c) openDrawer(+c.getAttribute('data-i')); });
  function bars(el, items, max, onclick) {
    el.innerHTML = items.map((x) => '<div class="bar" data-k="' + esc(x[0]) + '"><span>' + esc(x[0]) + '</span><div class="tk"><i style="width:' + (max ? (x[1] / max) * 100 : 0) + '%"></i></div><b>' + x[1] + '</b></div>').join('');
    if (onclick) $$('.bar', el).forEach((b) => b.addEventListener('click', () => onclick(b.getAttribute('data-k'))));
  }
  function drawBars(idx) {
    const si = {}; idx.forEach((i) => { const k = g(R[i], 'si'); si[k] = (si[k] || 0) + 1; });
    const sl = Object.entries(si).sort((a, b) => b[1] - a[1]).slice(0, 8);
    bars($('#bsi'), sl, sl.length ? sl[0][1] : 0, (k) => { if (k === 'Other') return; S.si.has(k) ? S.si.delete(k) : S.si.add(k); S.shown = 50; renderFacets(); update(); });
    const B = [['< 16 MHz', 0, 16], ['16–48', 16, 48], ['48–100', 48, 100], ['100–200', 100, 200], ['200–400', 200, 400], ['≥ 400', 400, 1e9]];
    const hb = B.map((b) => [b[0], idx.filter((i) => g(R[i], 'mhz') >= b[1] && g(R[i], 'mhz') < b[2]).length]);
    bars($('#bmhz'), hb, Math.max.apply(null, hb.map((x) => x[1]).concat([1])));
  }

  /* ---------- drawer / compare ---------- */
  const veil = $('#veil'), drawer = $('#drawer'), modal = $('#modal');
  function closeAll() { veil.classList.remove('on'); drawer.classList.remove('on'); modal.classList.remove('on'); drawer.setAttribute('aria-hidden', 'true'); modal.setAttribute('aria-hidden', 'true'); }
  veil.addEventListener('click', closeAll);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeAll(); });
  function entrySnippet(r) {
    const id = g(r, 'id').replace('/', '-'), svd = g(r, 'svd');
    return '{\n  id: ' + JSON.stringify(id) + ', name: ' + JSON.stringify(g(r, 'name')) + ', vendor: ' + JSON.stringify(g(r, 'vendor')) + ', mcu: ' + JSON.stringify(g(r, 'mcu').toUpperCase()) + ', arch: ' + JSON.stringify(g(r, 'arch')) + ',\n  toolchains: [\'platformio\'], pioBoard: ' + JSON.stringify(g(r, 'id').split('/')[1]) + ', baud: 115200,\n' +
      (svd ? '  svd: \'https://raw.githubusercontent.com/cmsis-svd/cmsis-svd-data/main/data/' + svd + '\', // community mirror\n' : '') +
      '  docs: [{ title: ' + JSON.stringify(g(r, 'mcu').toUpperCase() + ' datasheet') + ', url: \'\' /* add the vendor URL */ }],\n},';
  }
  function openDrawer(i) {
    const r = R[i], svd = g(r, 'svd'), ale = g(r, 'ale'), pl = g(r, 'platform'), file = g(r, 'id').split('/')[1];
    const kv = (k, v) => '<dt>' + k + '</dt><dd>' + v + '</dd>';
    const tags = (a) => (a.length ? a.map((x) => '<span class="tag">' + esc(x) + '</span>').join('') : '<span style="color:var(--tx3)">none listed</span>');
    drawer.innerHTML = '<button class="x" id="dx" aria-label="Close">×</button><div class="mono" style="font-size:11px;color:var(--tx3);letter-spacing:.1em;text-transform:uppercase">' + esc(pl) + ' · ' + esc(g(r, 'vendor')) + '</div><h2>' + esc(g(r, 'name')) + '</h2><div class="mono" style="color:var(--tx2)">' + esc(g(r, 'mcu').toUpperCase()) + ' · ' + esc(g(r, 'si')) + '</div>' +
      '<dl class="kv">' + kv('CPU core', esc(g(r, 'arch')) + (g(r, 'cpu') ? '' : ' <span class="tr deriv">derived</span>')) + kv('Clock', fmtMhz(g(r, 'mhz'))) + kv('Flash', fmtKB(g(r, 'flashKB'))) + kv('RAM', fmtKB(g(r, 'ramKB'))) + kv('Frameworks', tags(g(r, 'fw'))) + kv('Connectivity', tags(g(r, 'conn'))) + kv('Debug / sim', tags(g(r, 'dbg'))) +
      kv('Register map', svd ? '<a style="text-decoration:underline" href="https://github.com/cmsis-svd/cmsis-svd-data/blob/main/data/' + esc(svd) + '">' + esc(svd) + '</a> <span class="tr comm">community-mirror</span>' : 'none found in the community mirror') +
      kv('Source', '<a style="text-decoration:underline" href="https://github.com/platformio/platform-' + esc(pl) + '/blob/develop/boards/' + esc(file) + '.json">PlatformIO manifest</a>' + (safeUrl(g(r, 'url')) ? ' · <a style="text-decoration:underline" rel="noopener noreferrer" href="' + esc(safeUrl(g(r, 'url'))) + '">board page</a>' : '')) + '</dl>' +
      '<h4>In Aletheon</h4><p style="color:var(--tx2);font-size:13.5px">' + (ale === 2 ? 'This chip\'s register map is parsed and tested in Aletheon. See the worked examples.' : svd ? 'A register map exists upstream, so Aletheon can ground answers for this chip once it is added to the registry. Entry to start from:' : 'No register map was found. Aletheon can still search its datasheet once you index it; address claims stay UNVERIFIED without a map.') + '</p>' +
      (ale !== 2 ? '<div class="code" style="margin-top:10px"><button class="cp" id="cps">Copy</button>' + esc(entrySnippet(r)) + '</div><p class="note">Add the vendor datasheet URL, then verify the register map against it before trusting addresses.</p>' : '') +
      '<div style="display:flex;gap:10px;margin-top:22px"><button class="btn primary sm" id="dcmp">' + (S.sel.indexOf(i) >= 0 ? 'Remove from compare' : 'Add to compare') + '</button></div>';
    drawer.classList.add('on'); veil.classList.add('on'); drawer.setAttribute('aria-hidden', 'false');
    $('#dx').addEventListener('click', closeAll);
    $('#dcmp').addEventListener('click', () => { toggleSel(i); $('#dcmp').textContent = S.sel.indexOf(i) >= 0 ? 'Remove from compare' : 'Add to compare'; });
    const cps = $('#cps'); if (cps) cps.addEventListener('click', () => { if (navigator.clipboard) navigator.clipboard.writeText(entrySnippet(r)).then(() => { cps.textContent = 'Copied'; setTimeout(() => { cps.textContent = 'Copy'; }, 1500); }); });
  }
  $('#cmpgo').addEventListener('click', () => {
    if (S.sel.length < 2) return;
    const rows = S.sel.map((i) => R[i]);
    const best = (k) => { const v = rows.map((r) => g(r, k)); const m = Math.max.apply(null, v); return v.every((x) => x === m) ? -1 : v.indexOf(m); };
    const line = (label, fn, num) => { const b = num ? best(num) : -1; return '<tr><th style="cursor:default">' + label + '</th>' + rows.map((r, j) => '<td' + (b === j ? ' class="best"' : '') + '>' + fn(r) + '</td>').join('') + '</tr>'; };
    modal.innerHTML = '<h2 style="font-size:22px;letter-spacing:-.03em;margin-bottom:14px">Compare</h2><div class="tw"><table><thead><tr><th style="cursor:default"></th>' + rows.map((r) => '<th style="cursor:default;color:var(--tx)">' + esc(g(r, 'name')) + '</th>').join('') + '</tr></thead><tbody>' +
      line('MCU', (r) => esc(g(r, 'mcu').toUpperCase())) + line('Silicon', (r) => esc(g(r, 'si'))) + line('Core', (r) => esc(g(r, 'arch'))) + line('Clock', (r) => fmtMhz(g(r, 'mhz')), 'mhz') + line('Flash', (r) => fmtKB(g(r, 'flashKB')), 'flashKB') + line('RAM', (r) => fmtKB(g(r, 'ramKB')), 'ramKB') +
      line('Connectivity', (r) => esc(g(r, 'conn').join(', ') || '·')) + line('Frameworks', (r) => esc(g(r, 'fw').join(', '))) + line('Debug / sim', (r) => esc(g(r, 'dbg').join(', ') || '·')) + line('Register map', (r) => (g(r, 'svd') ? esc(g(r, 'svd')) : 'none found')) + '</tbody></table></div><p class="note">Green marks the highest value in a row. Values are as published in PlatformIO board manifests.</p>';
    modal.classList.add('on'); veil.classList.add('on'); modal.setAttribute('aria-hidden', 'false');
  });
  $('#cmpclr').addEventListener('click', () => { S.sel = []; toggleSelRefresh(); });
  function toggleSelRefresh() { $$('#tb tr.r').forEach((tr) => { tr.classList.remove('sel'); $('.cmpb', tr).classList.remove('on'); }); $('#tray').classList.remove('on'); }

  /* ---------- sliders, search, reset, csv ---------- */
  const lab = (kind, v) => (v === 0 ? 'any' : kind === 'mhz' ? '≥ ' + fmtMhz(v) : '≥ ' + fmtKB(v));
  [['smhz', 'mhz', 'vmhz'], ['sfl', 'fl', 'vfl'], ['sram', 'ram', 'vram']].forEach((t) => {
    $('#' + t[0]).addEventListener('input', (e) => { S[t[1]] = +e.target.value; $('#' + t[2]).textContent = lab(t[1] === 'mhz' ? 'mhz' : 'kb', STEP[t[1]][S[t[1]]]); S.shown = 50; update(); });
  });
  let qt; $('#q').addEventListener('input', (e) => { clearTimeout(qt); qt = setTimeout(() => { S.q = e.target.value.trim(); S.shown = 50; update(); }, 120); });
  $('#reset').addEventListener('click', () => { Object.assign(S, { q: '', svd: false, tested: false, mhz: 0, fl: 0, ram: 0, shown: 50 }); ['si', 'arch', 'conn', 'dbg', 'fw'].forEach((k) => S[k].clear()); $('#q').value = ''; ['smhz', 'sfl', 'sram'].forEach((id) => { $('#' + id).value = 0; }); ['vmhz', 'vfl', 'vram'].forEach((id) => { $('#' + id).textContent = 'any'; }); renderFacets(); update(); });
  $('#loadm').addEventListener('click', () => { S.shown += 100; update(true); });
  $('#csv').addEventListener('click', () => {
    const idx = filtered(), head = ['id', 'name', 'board_vendor', 'silicon_vendor', 'platform', 'mcu', 'cpu', 'arch', 'mhz', 'flash_kb', 'ram_kb', 'frameworks', 'connectivity', 'debug', 'svd_file', 'svd_basis', 'url'];
    // A cell that starts with = + - @ would run as a formula in Excel or Sheets; a leading apostrophe keeps it text.
    const q = (v) => '"' + (/^[=+\-@\t\r]/.test(String(v)) ? "'" : '') + String(v).replace(/"/g, '""') + '"';
    const lines = [head.join(',')].concat(idx.map((i) => { const r = R[i]; return [g(r, 'id'), g(r, 'name'), g(r, 'vendor'), g(r, 'si'), g(r, 'platform'), g(r, 'mcu'), g(r, 'cpu'), g(r, 'arch'), g(r, 'mhz'), g(r, 'flashKB'), g(r, 'ramKB'), g(r, 'fw').join(' '), g(r, 'conn').join(' '), g(r, 'dbg').join(' '), g(r, 'svd'), g(r, 'svdHow'), g(r, 'url')].map(q).join(','); }));
    const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([lines.join('\n')], { type: 'text/csv' })); a.download = 'chip-atlas-' + A.meta.generated + '.csv'; document.body.appendChild(a); a.click(); a.remove();
  });

  /* ---------- hash state ---------- */
  function writeHash() {
    const p = [];
    if (S.q) p.push('q=' + encodeURIComponent(S.q));
    ['si', 'arch', 'conn', 'dbg', 'fw'].forEach((k) => { if (S[k].size) p.push(k + '=' + Array.from(S[k]).map(encodeURIComponent).join(',')); });
    if (S.svd) p.push('svd=1'); if (S.tested) p.push('tested=1');
    ['mhz', 'fl', 'ram'].forEach((k) => { if (S[k]) p.push(k + '=' + S[k]); });
    if (S.sort !== 'name' || S.dir !== 1) p.push('sort=' + S.sort + ':' + S.dir);
    try { history.replaceState(null, '', p.length ? '#' + p.join('&') : location.pathname + location.search); } catch (e) { /* file:// */ }
  }
  function readHash() {
    (location.hash || '').replace(/^#/, '').split('&').forEach((kv) => {
      const [k, v] = kv.split('='); if (!k || v === undefined) return;
      if (k === 'q') S.q = decodeURIComponent(v);
      else if (['si', 'arch', 'conn', 'dbg', 'fw'].indexOf(k) >= 0) v.split(',').forEach((x) => S[k].add(decodeURIComponent(x)));
      else if (k === 'svd') S.svd = v === '1'; else if (k === 'tested') S.tested = v === '1';
      else if (['mhz', 'fl', 'ram'].indexOf(k) >= 0) S[k] = Math.max(0, Math.min(STEP[k].length - 1, +v || 0));
      else if (k === 'sort') { const p = v.split(':'); S.sort = p[0]; S.dir = +p[1] || 1; }
    });
    $('#q').value = S.q; $('#smhz').value = S.mhz; $('#sfl').value = S.fl; $('#sram').value = S.ram;
    $('#vmhz').textContent = lab('mhz', STEP.mhz[S.mhz]); $('#vfl').textContent = lab('kb', STEP.fl[S.fl]); $('#vram').textContent = lab('kb', STEP.ram[S.ram]);
  }

  /* ---------- update ---------- */
  function update(keepScroll) {
    const idx = filtered();
    $('#cnt').textContent = idx.length.toLocaleString() + ' of ' + R.length.toLocaleString() + ' boards';
    const mcus = new Set(idx.map((i) => g(R[i], 'mcu'))).size, withSvd = idx.filter((i) => g(R[i], 'svd')).length;
    $('#cnt2').textContent = '· ' + mcus + ' chips · ' + withSvd + ' with a register map';
    $('#tb').innerHTML = idx.slice(0, S.shown).map(rowHtml).join('');
    $('#empty').hidden = idx.length > 0; $('#loadm').parentElement.style.display = idx.length > S.shown ? 'flex' : 'none';
    $$('#thr th').forEach((th) => { const on = th.getAttribute('data-k') === S.sort; th.classList.toggle('s', on); th.setAttribute('data-d', S.dir === 1 ? '↑' : '↓'); });
    drawScatter(idx); drawBars(idx); writeHash();
  }

  /* ---------- kpis + sources ---------- */
  const C = A.meta.counts;
  const KP = [['boards', 'real boards'], ['mcus', 'microcontrollers'], ['silicon', 'silicon vendors'], ['withSvd', 'boards with a register map'], ['wifi', 'Wi-Fi boards'], ['bluetooth', 'Bluetooth boards'], ['can', 'CAN-bus boards'], ['simulatable', 'simulator-ready boards']];
  const KV = { boards: C.boards, mcus: C.mcus, silicon: A.meta.siliconCounts.filter((x) => x[0] !== 'Other').length, withSvd: C.withSvd, wifi: C.wifi, bluetooth: C.bluetooth, can: C.can, simulatable: C.simulatable };
  $('#kpis').innerHTML = KP.map((k) => '<div class="kpi"><b data-n="' + KV[k[0]] + '">' + (RM ? KV[k[0]].toLocaleString() : 0) + '</b><span>' + k[1] + '</span></div>').join('');
  if (!RM) {
    const io = new IntersectionObserver((es) => es.forEach((e) => { if (!e.isIntersecting) return; io.unobserve(e.target); const n = +e.target.getAttribute('data-n'), t0 = performance.now(); (function f(t) { const k = Math.min(1, (t - t0) / 1400); e.target.textContent = Math.round(n * (1 - Math.pow(1 - k, 3))).toLocaleString(); if (k < 1) requestAnimationFrame(f); })(t0); }), { threshold: .5 });
    $$('[data-n]').forEach((el) => io.observe(el));
  }
  $('#srcg').innerHTML = A.meta.sources.map((s) => '<span>' + esc(s.repo.replace('platformio/', '')) + ' @ ' + esc(s.commit) + ' · ' + s.boards + '</span>').join('');
  $('#gen').textContent = 'Generated ' + A.meta.generated + ' · register-map file list: ' + A.meta.svd.repo + ' @ ' + String(A.meta.svd.tree).slice(0, 7) + ' (' + A.meta.svd.files + ' files).';

  readHash(); renderFacets(); update();
})();
