/* Device Lab UI: picks a modeled part, runs the user's code against it in a Worker (time-limited, no network), and renders the result.
 * Everything is written with textContent / DOM nodes, never innerHTML, so user code output cannot inject markup. */
(function () {
  'use strict';
  var DATA = window.DEVICES, core = window.__aletheonDevCore;
  var $ = function (id) { return document.getElementById(id); };
  var el = function (tag, cls, text) { var n = document.createElement(tag); if (cls) n.className = cls; if (text !== undefined) n.textContent = text; return n; };
  if (!DATA || !core) { $('out').textContent = 'The device data failed to load.'; return; }

  var cur = null, inputs = {}, running = false, drafts = {}, lastBus = null;
  var hex2 = function (n) { return '0x' + n.toString(16).toUpperCase().padStart(2, '0'); };
  var RUN_LIMIT_MS = 2500;

  // ---- worker plumbing -----------------------------------------------------------------------------------------------------
  var workerSrc = null;
  function runInWorker(req) {
    return new Promise(function (resolve) {
      var w, url, done = false, timer;
      var finish = function (out) { if (done) return; done = true; clearTimeout(timer); try { w.terminate(); } catch (e) {} if (url) URL.revokeObjectURL(url); resolve(out); };
      try {
        if (!workerSrc) {
          workerSrc = 'const DATA=' + JSON.stringify({ devices: DATA.devices }) + ';const core=(' + core.toString() + ')(DATA);' +
            "['fetch','XMLHttpRequest','WebSocket','EventSource','importScripts','indexedDB','caches','Worker','SharedWorker','BroadcastChannel','WebTransport'].forEach(function(k){for(var p=self;p;p=Object.getPrototypeOf(p)){try{Object.defineProperty(p,k,{value:undefined,writable:false,configurable:false})}catch(e){try{delete p[k]}catch(e2){}}}});" +
            'self.onmessage=function(e){var o;try{o=core.run(e.data)}catch(err){o={ok:false,error:String(err&&err.message||err),logs:[],bus:[],regs:[]}}self.postMessage(o)};';
        }
        url = URL.createObjectURL(new Blob([workerSrc], { type: 'text/javascript' }));
        w = new Worker(url);
        w.onmessage = function (e) { finish(e.data); };
        w.onerror = function () { finish(refused('The sandbox worker failed to start, so your code was not run.')); };
        timer = setTimeout(function () { finish({ ok: false, error: 'Stopped after ' + RUN_LIMIT_MS / 1000 + ' s of real time. Is there a loop that never calls delay() or the bus?', logs: [], bus: [], regs: [], timedOut: true }); }, RUN_LIMIT_MS);
        w.postMessage(req);
      } catch (e) {
        finish(refused('This browser cannot start a Web Worker sandbox, so your code was not run.'));
      }
    });
  }
  // Never fall back to running pasted code on the page itself: the page thread can see this origin's storage, a worker cannot.
  function refused(msg) { return { ok: false, error: msg, logs: [], bus: [], regs: [] }; }

  // ---- rendering -----------------------------------------------------------------------------------------------------------
  function renderPicker() {
    var p = $('picker');
    DATA.devices.forEach(function (d) {
      var n = 0; d.facts.forEach(function (f) { n += (f.cite.all ? f.cite.all.length : 1); });
      var b = el('button', 'dev'); b.type = 'button'; b.setAttribute('role', 'tab'); b.dataset.id = d.id;
      b.appendChild(el('b', '', d.part)); b.appendChild(el('span', '', d.kind));
      b.appendChild(el('small', '', d.vendor + ' · ' + d.source.doc + ' · ' + d.registers.length + ' registers'));
      b.addEventListener('click', function () { select(d.id); });
      p.appendChild(b);
    });
  }

  function renderSliders() {
    var box = $('sliders'); box.textContent = '';
    cur.inputs.forEach(function (i) {
      var row = el('label', 'sl'); row.appendChild(el('span', '', i.label));
      var r = el('input'); r.type = 'range'; r.min = i.min; r.max = i.max; r.step = i.step; r.value = inputs[i.id];
      var v = el('b', '', ''); var show = function () { var x = Number(r.value); v.textContent = (Math.abs(x) < 10 ? x.toFixed(3).replace(/\.?0+$/, '') || '0' : x.toFixed(2)) + ' ' + i.unit; };
      r.addEventListener('input', function () { inputs[i.id] = Number(r.value); show(); });
      show(); row.appendChild(r); row.appendChild(v); box.appendChild(row);
    });
  }

  function renderFacts() {
    var box = $('facts'); box.textContent = '';
    var q = 0; cur.facts.forEach(function (f) { q += f.cite.all ? f.cite.all.length : 1; });
    $('factsIntro').textContent = cur.registers.length + ' registers, ' + cur.addresses.length + ' addresses and ' + cur.facts.length + ' behaviors, with ' + (q + cur.registers.length + 1) + ' short quotes that a script checks against the PDF. Each card says what the model does, in our words, and shows the datasheet text it rests on.';
    var addCard = function (text, cite, derived) {
      var c = el('div', 'fact'); c.appendChild(el('p', '', text));
      (cite.all || [cite.q]).forEach(function (s) { c.appendChild(el('q', '', '“' + s + '”')); });
      var pg = el('div', 'pg'); pg.appendChild(el('span', '', 'datasheet p. ' + cite.p));
      pg.appendChild(el('span', 'tr ' + (derived ? 'deriv' : 'vendor'), derived ? 'derived' : 'datasheet'));
      c.appendChild(pg); box.appendChild(c);
    };
    addCard('I2C addresses: ' + cur.addresses.map(function (a) { return a.addr + ' (' + a.strap + ')'; }).join('; ') + '.', cur.addressCite);
    cur.registers.forEach(function (r) { addCard(r.name + ' at ' + r.addr + ', ' + r.access + ', resets to ' + r.reset + '.', r.cite); });
    cur.facts.forEach(function (f) { addCard(f.text, f.cite, f.derived); });
    var nm = $('nm'); nm.textContent = ''; cur.notModeled.forEach(function (t) { nm.appendChild(el('li', '', t)); });
    var s = $('srcbox'); s.textContent = '';
    var line = function (k, v, href) { var d = el('div'); d.appendChild(el('b', '', k + ': ')); if (href) { var a = el('a', '', v); a.href = href; a.target = '_blank'; a.rel = 'noopener noreferrer'; a.style.textDecoration = 'underline'; d.appendChild(a); } else d.appendChild(document.createTextNode(v)); s.appendChild(d); };
    line('Source', cur.vendor + ' ' + cur.part + ' datasheet ' + cur.source.doc + ', ' + cur.source.rev);
    line('Official copy', cur.source.url, cur.source.url);
    line('SHA-256 of the checked PDF', cur.source.sha256);
    line('Size / pages', cur.source.bytes.toLocaleString() + ' bytes, ' + cur.source.pages + ' pages');
  }

  function renderResult(out) {
    var o = $('out'); o.textContent = '';
    if (out.note) { var n = el('div', 'm', out.note); o.appendChild(n); }
    (out.logs || []).forEach(function (l) { var d = el('div'); d.appendChild(el('span', 't', l.t.toFixed(1) + ' ms')); d.appendChild(document.createTextNode(l.text)); o.appendChild(d); });
    if (out.error) { var e = el('div', 'e', '✖ ' + out.error); o.appendChild(e); }
    else if (!(out.logs || []).length) o.appendChild(el('div', 'm', 'The program finished without logging anything. Use log(...) to print values.'));
    else o.appendChild(el('div', 'ok', '✔ finished'));
    $('runMeta').textContent = out.simMs !== undefined ? out.simMs.toFixed(1) + ' ms simulated · ' + out.transactions + ' transactions' : '';

    var tb = $('bus').tBodies[0]; tb.textContent = '';
    (out.bus || []).forEach(function (b) {
      var tr = el('tr'); tr.appendChild(el('td', 'm', b.t.toFixed(2)));
      var d = el('td'); d.appendChild(el('span', 'dir ' + b.dir, b.dir)); tr.appendChild(d);
      tr.appendChild(el('td', 'm' + (b.ack ? '' : ' nack'), b.dir === 'I' || b.dir === 'S' ? '—' : hex2(b.addr)));
      tr.appendChild(el('td', 'm', b.bytes.map(hex2).join(' ')));
      var w = el('td', b.ack ? '' : 'nack', b.note || (b.ack ? 'ACK' : 'NACK'));
      (b.warn || []).forEach(function (x) { w.appendChild(el('span', 'w', '⚠ ' + x)); });
      tr.appendChild(w); tb.appendChild(tr);
    });
    $('busMeta').textContent = (out.bus || []).length + ' events';
    lastBus = out.bus && out.bus.length ? out.bus : null; $('toAna').disabled = !lastBus;

    var rb = $('regs').tBodies[0]; rb.textContent = '';
    (out.regs || []).forEach(function (r) {
      var tr = el('tr'); tr.appendChild(el('td', 'm', r.addr)); tr.appendChild(el('td', '', r.name)); tr.appendChild(el('td', 'm', r.access)); tr.appendChild(el('td', 'm', r.value)); rb.appendChild(tr);
    });
  }

  // ---- actions -------------------------------------------------------------------------------------------------------------
  function select(id, keepDraft) {
    if (cur) drafts[cur.id] = $('code').value;
    cur = DATA.devices.filter(function (d) { return d.id === id; })[0] || DATA.devices[0];
    Array.prototype.forEach.call(document.querySelectorAll('.dev'), function (b) { var on = b.dataset.id === cur.id; b.classList.toggle('on', on); b.setAttribute('aria-selected', on); });
    inputs = {}; cur.inputs.forEach(function (i) { inputs[i.id] = i.default; });
    var s = $('strap'); s.textContent = '';
    cur.addresses.forEach(function (a, idx) { var o = el('option', '', a.addr + '  ' + a.strap); o.value = parseInt(a.addr, 16); if (idx === 0) o.selected = true; s.appendChild(o); });
    $('code').value = (!keepDraft && drafts[cur.id]) || cur.sample;
    renderSliders(); renderFacts();
    $('out').textContent = ''; $('out').appendChild(el('span', 'm', 'Press Run to execute the code.'));
    $('bus').tBodies[0].textContent = ''; $('regs').tBodies[0].textContent = ''; $('runMeta').textContent = ''; $('busMeta').textContent = ''; lastBus = null; $('toAna').disabled = true;
    try { history.replaceState(null, '', '#' + cur.id); } catch (e) {}
  }

  function run() {
    if (running) return; running = true;
    var btn = $('run'); btn.textContent = 'Running…';
    var req = { device: cur.id, addr: parseInt($('strap').value, 10), inputs: inputs, code: $('code').value };
    runInWorker(req).then(function (out) { renderResult(out); }).then(function () { running = false; btn.textContent = 'Run ▸'; });
  }

  renderPicker();
  $('toAna').addEventListener('click', function () {
    if (!lastBus) return;
    try { sessionStorage.setItem('aletheon.capture', JSON.stringify({ source: 'Device Lab (' + cur.part + ')', t: 0, events: lastBus.slice(0, 2000) })); } catch (e) { /* storage blocked: the Analyzer then opens without it */ }
    window.location.href = 'analyzer.html#capture';
  });
  $('run').addEventListener('click', run);
  $('reset').addEventListener('click', function () { drafts[cur.id] = ''; select(cur.id, true); });
  $('strap').addEventListener('change', function () { /* applied on the next run */ });
  $('code').addEventListener('keydown', function (e) {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); run(); }
    else if (e.key === 'Tab' && !e.shiftKey) { e.preventDefault(); var t = e.target, s = t.selectionStart; t.value = t.value.slice(0, s) + '  ' + t.value.slice(t.selectionEnd); t.selectionStart = t.selectionEnd = s + 2; }
  });
  select((location.hash || '').slice(1) || 'tmp117');
  window.addEventListener('hashchange', function () { var id = (location.hash || '').slice(1); if (id && (!cur || id !== cur.id)) select(id); });
})();
