/* Live register explorer + claim auditor for the website. Runs entirely in the browser on the REAL RP2040 register slice
 * (assets/rp2040-data.js, generated from the vendor CMSIS-SVD) and the browser port of the audit rules (assets/audit.js). No network. */
(function () {
  'use strict';
  var D = window.RP2040, A = window.AletheonAudit;
  var root = document.getElementById('lab');
  if (!D || !A || !root) return;
  var $ = function (s, r) { return (r || document).querySelector(s); };
  var $$ = function (s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); };
  var RM = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  function hex(n, w) { var s = Math.floor(n).toString(16).toUpperCase(); while (s.length < (w || 1)) s = '0' + s; return '0x' + s; }
  function esc(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
  function ident(s) { return String(s).toUpperCase().replace(/[^A-Z0-9_]/g, '_'); }
  function findP(n) { for (var i = 0; i < D.peripherals.length; i++) if (D.peripherals[i].n === n) return D.peripherals[i]; }
  function findR(p, n) { for (var i = 0; i < p.regs.length; i++) if (p.regs[i].n === n) return p.regs[i]; }

  /* ---------------- tabs ---------------- */
  $$('[data-lab]', root).forEach(function (b) {
    b.addEventListener('click', function () {
      $$('[data-lab]', root).forEach(function (x) { x.classList.toggle('on', x === b); x.setAttribute('aria-selected', x === b); });
      $$('.labp', root).forEach(function (p) { p.classList.toggle('on', p.id === 'lab-' + b.getAttribute('data-lab')); });
    });
  });

  /* ---------------- register explorer ---------------- */
  var sel = { p: 'UART0', r: 'UARTFR' }, query = '';
  var elP = $('#xp'), elR = $('#xr'), elD = $('#xd'), elQ = $('#xq');

  function renderPeriphs() {
    elP.innerHTML = D.peripherals.map(function (p) {
      return '<button class="pi' + (p.n === sel.p && !query ? ' on' : '') + '" data-p="' + p.n + '"><b>' + p.n + '</b><i>' + hex(p.base, 8) + '</i></button>';
    }).join('');
  }
  function renderRegs() {
    var rows = [];
    if (query) {
      var q = query.toLowerCase();
      D.peripherals.forEach(function (p) {
        p.regs.forEach(function (r) {
          var hit = (p.n + '.' + r.n).toLowerCase().indexOf(q) >= 0 || r.f.some(function (f) { return f[0].toLowerCase().indexOf(q) >= 0; });
          if (hit) rows.push({ p: p, r: r });
        });
      });
    } else {
      var P = findP(sel.p);
      P.regs.forEach(function (r) { rows.push({ p: P, r: r }); });
    }
    if (!rows.length) { elR.innerHTML = '<div class="empty">No register or field matches “' + esc(query) + '” in this slice of the map.</div>'; return; }
    elR.innerHTML = rows.slice(0, 60).map(function (x) {
      var on = x.p.n === sel.p && x.r.n === sel.r;
      return '<button class="ri' + (on ? ' on' : '') + '" data-p="' + x.p.n + '" data-r="' + x.r.n + '"><b>' + (query ? x.p.n + '.' : '') + x.r.n + '</b><i>' + hex(x.r.o, 3) + '</i></button>';
    }).join('') + (rows.length > 60 ? '<div class="empty">' + (rows.length - 60) + ' more. Refine the search.</div>' : '');
    var cur = $('.ri.on', elR); if (cur && cur.scrollIntoView) { var box = elR; var t = cur.offsetTop - box.clientHeight / 2 + 20; box.scrollTop = Math.max(0, t); }
  }

  function headerText(p, r) {
    var P = ident(p.n), R = P + '_' + ident(r.n), w = r.sz <= 8 ? 8 : r.sz <= 16 ? 16 : r.sz <= 32 ? 32 : 64, L = [];
    L.push('#define ' + P + '_BASE ' + hex(p.base, 8) + 'u', '');
    L.push('/* ' + r.n + ' (' + (r.a || 'n/a') + ', ' + r.sz + '-bit) */');
    L.push('#define ' + R + '_OFFSET ' + hex(r.o, 3) + 'u');
    L.push('#define ' + R + '_ADDR (' + P + '_BASE + ' + R + '_OFFSET)');
    L.push('#define ' + R + '_REG (*(volatile uint' + w + '_t *)' + R + '_ADDR)');
    if (r.rs !== null && r.rs !== undefined) L.push('#define ' + R + '_RESET ' + hex(r.rs, r.sz / 4) + 'u');
    r.f.forEach(function (f) {
      var F = R + '_' + ident(f[0]), wd = f[2] - f[1] + 1, mask = (Math.pow(2, wd) - 1) * Math.pow(2, f[1]);
      L.push('#define ' + F + '_Pos ' + f[1] + 'u', '#define ' + F + '_Msk ' + hex(mask, 8) + 'u');
    });
    return L.join('\n');
  }
  function paint(text) {
    return esc(text).replace(/\/\*.*?\*\//g, '<span class="c">$&</span>').replace(/#define/g, '<span class="k">#define</span>')
      .replace(/\b(0x[0-9A-F]+u)/g, '<span class="m">$1</span>').replace(/\bvolatile\b/g, '<span class="k">volatile</span>');
  }

  function showReg() {
    var p = findP(sel.p), r = findR(p, sel.r);
    if (!p || !r) return;
    var addr = p.base + r.o;
    var fieldAt = {}; r.f.forEach(function (f, i) { for (var b = f[1]; b <= f[2]; b++) fieldAt[b] = i; });
    var bits = '';
    for (var b = r.sz - 1; b >= 0; b--) {
      var fi = fieldAt[b], one = r.rs ? (Math.floor(r.rs / Math.pow(2, b)) % 2) : 0;
      bits += '<div class="bt' + (fi !== undefined ? ' f p' + (fi % 2) : '') + (one ? ' one' : '') + '" data-b="' + b + '"' + (fi !== undefined ? ' data-f="' + fi + '" tabindex="0"' : '') + '><span>' + one + '</span><u>' + b + '</u></div>';
    }
    var rows = r.f.slice().sort(function (a, c) { return c[1] - a[1]; }).map(function (f) {
      var i = r.f.indexOf(f);
      return '<tr data-f="' + i + '"><td><b>' + esc(f[0]) + '</b></td><td class="mono">' + (f[2] === f[1] ? '[' + f[1] + ']' : '[' + f[2] + ':' + f[1] + ']') + '</td><td>' + esc(f[3] || '') + '</td></tr>';
    }).join('');
    elD.innerHTML =
      '<div class="dh"><div><span class="mono dp">' + p.n + '</span><h4>' + r.n + '</h4></div><div class="addr mono">' + hex(addr, 8) + '</div></div>' +
      '<div class="chips2"><span class="tr vendor">vendor-official</span><span class="tr user">offset ' + hex(r.o, 3) + '</span><span class="tr user">reset ' + (r.rs === null ? 'n/a' : hex(r.rs, r.sz / 4)) + '</span><span class="tr user">' + (r.a || 'n/a') + '</span></div>' +
      (r.d ? '<p class="rd">' + esc(r.d) + '</p>' : '') +
      '<div class="bmap" style="--cols:' + Math.min(16, r.sz) + '">' + bits + '</div><div class="btip mono" id="btip">Hover a bit or a field. Filled bits are 1 at reset.</div>' +
      (r.f.length ? '<div class="ftab"><table><tbody>' + rows + '</tbody></table></div>' : '<p class="rd">This register has no named fields.</p>') +
      '<div class="hd"><div class="hdt mono"><span>Generated header · excerpt</span><button class="cp" id="cph">Copy</button></div><pre class="mono" id="hdr">' + paint(headerText(p, r)) + '</pre></div>';
    var tip = $('#btip', elD);
    function hl(fi) {
      $$('.bt', elD).forEach(function (c) { c.classList.toggle('hl', fi !== null && c.getAttribute('data-f') === String(fi)); });
      $$('.ftab tr', elD).forEach(function (t) { t.classList.toggle('hl', fi !== null && t.getAttribute('data-f') === String(fi)); });
      if (fi !== null) { var f = r.f[fi]; tip.innerHTML = '<b>' + esc(f[0]) + '</b> ' + (f[2] === f[1] ? '[' + f[1] + ']' : '[' + f[2] + ':' + f[1] + ']') + ' · ' + esc(f[3] || ''); }
    }
    $$('.bt.f', elD).forEach(function (c) {
      var fi = +c.getAttribute('data-f');
      c.addEventListener('pointerenter', function () { hl(fi); }); c.addEventListener('focus', function () { hl(fi); });
      c.addEventListener('pointerleave', function () { hl(null); });
    });
    $$('.ftab tr', elD).forEach(function (t) { var fi = +t.getAttribute('data-f'); t.addEventListener('pointerenter', function () { hl(fi); }); t.addEventListener('pointerleave', function () { hl(null); }); });
    $('#cph', elD).addEventListener('click', function () {
      var btn = this; var text = headerText(p, r);
      if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(function () { btn.textContent = 'Copied'; setTimeout(function () { btn.textContent = 'Copy'; }, 1500); }, function () { });
    });
    if (!RM) { elD.classList.remove('swap'); void elD.offsetWidth; elD.classList.add('swap'); }
  }

  function selectReg(p, r) { sel.p = p; sel.r = r; renderPeriphs(); renderRegs(); showReg(); }
  elP.addEventListener('click', function (e) {
    var b = e.target.closest('.pi'); if (!b) return;
    query = ''; elQ.value = ''; sel.p = b.getAttribute('data-p'); sel.r = findP(sel.p).regs[0].n; renderPeriphs(); renderRegs(); showReg();
  });
  elR.addEventListener('click', function (e) { var b = e.target.closest('.ri'); if (b) selectReg(b.getAttribute('data-p'), b.getAttribute('data-r')); });
  var qt; elQ.addEventListener('input', function () { clearTimeout(qt); qt = setTimeout(function () { query = elQ.value.trim(); renderPeriphs(); renderRegs(); }, 90); });
  $('#xmeta').innerHTML = D.device + ' · ' + D.peripherals.length + ' peripherals, ' + D.peripherals.reduce(function (n, p) { return n + p.regs.length; }, 0) + ' registers · SVD sha256 ' + String(D.sha256).slice(0, 8) + '…';
  renderPeriphs(); renderRegs(); showReg();

  /* ---------------- claim auditor ---------------- */
  function entryText(pn, rn) {
    var p = findP(pn), r = findR(p, rn);
    return D.device + ' ' + pn + '.' + rn + ': address ' + hex(p.base + r.o, 8) + ' (base ' + hex(p.base, 8) + ' + offset ' + hex(r.o, 3) + '), ' + r.sz + ' bit, reset ' + (r.rs === null ? 'n/a' : hex(r.rs, r.sz / 4)) + ', access ' + (r.a || 'n/a');
  }
  var LED = [['E1', 'UART0', 'UARTFR'], ['E2', 'UART0', 'UARTDR'], ['E3', 'SPI0', 'SSPCR0'], ['E4', 'TIMER', 'TIMELR'], ['E5', 'WATCHDOG', 'LOAD']].map(function (x) {
    return { id: x[0], kind: 'svd', trust: 'vendor-official', excerpt: entryText(x[1], x[2]) };
  });
  LED.push({ id: 'E6', kind: 'build', trust: 'measured', excerpt: 'compile + layout check: exit 0 (clean)' });
  var addr = function (pn, rn) { var p = findP(pn); return hex(p.base + findR(p, rn).o, 8); };

  $('#aled').innerHTML = LED.map(function (e) {
    var cls = e.trust === 'measured' ? 'meas' : 'vendor';
    return '<div class="le"><div class="lt"><b>[' + e.id + ']</b> ' + e.kind + ' <span class="tr ' + cls + '">' + e.trust + '</span></div><p class="mono">' + esc(e.excerpt) + '</p></div>';
  }).join('');

  var EX = {
    'Grounded': 'UART0’s UARTFR is at ' + addr('UART0', 'UARTFR') + ' [E1], and its reset value is ' + hex(findR(findP('UART0'), 'UARTFR').rs, 8) + ' [E1]. UARTDR is at ' + addr('UART0', 'UARTDR') + ' [E2].',
    'Invented values': 'The UART data register is at 0x40034004. The core runs at 266 MHz and the UART resets to 0x00000000.',
    'Citation laundering': 'UARTFR is at ' + addr('UART0', 'UARTFR') + ' [E6]. SPI0 SSPCR0 is at ' + addr('SPI0', 'SSPCR0') + ' [E6].',
    'Fake evidence id': 'TIMER TIMELR is at ' + addr('TIMER', 'TIMELR') + ' [E9]. The watchdog LOAD register is at ' + addr('WATCHDOG', 'LOAD') + ' [E5].',
    'Honest UNVERIFIED': 'I have no register map for SPI1 in the ledger, so its base address is UNVERIFIED. UART0’s UARTFR is at ' + addr('UART0', 'UARTFR') + ' [E1].'
  };
  var ta = $('#atext'), out = $('#aout'), sum = $('#asum');
  $('#aex').innerHTML = Object.keys(EX).map(function (k) { return '<button class="ex" data-ex="' + k + '">' + k + '</button>'; }).join('');

  function nice(v) { return v.replace(/^hex:(.*)$/, function (_, h) { return '0x' + h.toUpperCase(); }).replace(/^qty:/, '').replace(/^pin:/, ''); }
  function chips(s) { return s.replace(/\[(E\d+(?:\s*,\s*E\d+)*)\]/g, '<span class="chip">$1</span>'); }
  var LABEL = { supported: 'supported', unsupported: 'not in evidence', uncited: 'no citation', 'unknown-citation': 'unknown id', 'declared-unverified': 'declared UNVERIFIED' };
  function run() {
    var r = A.audit(ta.value, LED), html = '', issues = '';
    r.segments.forEach(function (s) {
      if (!s.claim) { html += chips(esc(s.text)); return; }
      var cls = s.claim.status === 'supported' ? 'good' : s.claim.status === 'declared-unverified' ? 'warn' : 'bad';
      html += '<mark class="m-' + cls + '" title="' + LABEL[s.claim.status] + '">' + chips(esc(s.text)) + '</mark>';
    });
    out.innerHTML = html || '<span class="muted">Type or pick an example above.</span>';
    r.claims.forEach(function (c) {
      var why = c.status === 'supported' ? 'every value appears in ' + c.cited.join(', ') + (c.weakSource ? ' (but only community-grade sources)' : '')
        : c.status === 'unsupported' ? 'cites ' + c.cited.join(', ') + ', but that evidence does not contain ' + c.missing.map(nice).join(', ')
        : c.status === 'uncited' ? 'states ' + c.values.map(nice).join(', ') + ' with no evidence cited'
        : c.status === 'unknown-citation' ? 'cites ' + c.cited.join(', ') + ', which is not in the ledger'
        : 'declared UNVERIFIED, which is allowed';
      var tone = c.status === 'supported' ? 'good' : c.status === 'declared-unverified' ? 'warn' : 'bad';
      issues += '<li class="' + tone + '"><i></i><span><b>' + LABEL[c.status] + '</b> · “' + esc(c.sentence.length > 70 ? c.sentence.slice(0, 68) + '…' : c.sentence) + '” ' + why + '</span></li>';
    });
    var n = r.claims.length;
    sum.className = 'asum ' + (!n ? '' : r.ok ? 'pass' : 'fail');
    sum.innerHTML = !n ? '<b>No hardware values to audit yet.</b>' :
      '<b>' + (r.ok ? '✓ Audit passed' : '✗ Audit failed') + '</b><span>' + n + ' claim' + (n > 1 ? 's' : '') + ' with hardware values · ' + r.counts.supported + ' supported · ' + (r.counts.unsupported + r.counts.uncited + r.counts['unknown-citation']) + ' flagged' + (r.counts['declared-unverified'] ? ' · ' + r.counts['declared-unverified'] + ' declared UNVERIFIED' : '') + '</span>';
    $('#aiss').innerHTML = issues;
    if (!RM) { sum.classList.remove('pop'); void sum.offsetWidth; sum.classList.add('pop'); }
  }
  var rt; ta.addEventListener('input', function () { clearTimeout(rt); rt = setTimeout(run, 70); });
  $('#aex').addEventListener('click', function (e) {
    var b = e.target.closest('.ex'); if (!b) return;
    $$('.ex', root).forEach(function (x) { x.classList.toggle('on', x === b); });
    ta.value = EX[b.getAttribute('data-ex')]; run();
  });
  ta.value = EX['Invented values']; $$('.ex', root)[1].classList.add('on'); run();
})();
