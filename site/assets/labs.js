/* Scenario Labs page. The logic lives in labcore.js (and is tested); this file only draws it. No network, no eval, textContent only. */
(function () {
  'use strict';
  const UI = window.AletheonUI, IOT = window.AletheonIot, S = window.AletheonSim, L = window.AletheonLogic, WV = window.AletheonWave;
  const { el, clear, $, fmtNum, fmtLife } = UI;
  if (!window.DEVICES || !window.ATLAS || !window.__aletheonDevCore || !window.AletheonLabs) { $('labError').textContent = 'The lab scripts failed to load.'; return; }
  const core = window.__aletheonDevCore(window.DEVICES);
  const labs = window.AletheonLabs.createLabs({ core, IOT, S, L, devices: window.DEVICES.devices });
  const hex2 = UI.hex2;

  // ---- progress (a per-viewer convenience kept in this browser only) -------------------------------------------------------------------------
  const KEY = 'aletheon.labs.done';
  const loadDone = () => { try { const v = JSON.parse(localStorage.getItem(KEY) || '[]'); return Array.isArray(v) ? v.filter((x) => typeof x === 'string') : []; } catch (e) { return []; } };
  let done = loadDone();
  const mark = (id) => { if (!done.includes(id)) { done = done.concat(id); try { localStorage.setItem(KEY, JSON.stringify(done)); } catch (e) { /* storage blocked */ } } paintDone(); };
  const LABS = [
    ['weather', 'Build a battery weather node', 'Budget the power of a sensor node and pick a board, a radio and a cell.'],
    ['nack', 'Debug a NACK', 'Read the address table, fix the address, and see the failure on the wire.'],
    ['minus256', 'Why does the sensor read −256 °C?', 'A supply glitch resets a sensor. Make the firmware survive it.'],
    ['coincell', 'A coin cell that cannot power a radio', 'Find out why the node resets, and which radio works.'],
    ['baud', 'Fix the UART garbage', 'Measure a bit time and choose the right baud rate.'],
  ];
  function paintDone() {
    LABS.forEach(([id]) => { const c = $('done-' + id); if (c) { c.textContent = done.includes(id) ? 'done ✓' : ''; c.className = 'chip' + (done.includes(id) ? ' ok' : ''); c.style.display = done.includes(id) ? '' : 'none'; } });
    $('labCards').querySelectorAll('.chip').forEach((c) => { c.style.display = done.includes(c.dataset.id) ? '' : 'none'; });
  }
  const cards = $('labCards');
  LABS.forEach(([id, title, blurb], i) => {
    const a = el('a', 'card'); a.href = '#' + id;
    const h = el('h3', '', (i + 1) + ' · ' + title); const chip = el('span', 'chip ok', ' done ✓'); chip.dataset.id = id; chip.style.marginLeft = '8px'; h.appendChild(chip);
    a.appendChild(h); a.appendChild(el('p', '', blurb)); cards.appendChild(a);
  });

  const verdict = (box, ok, text) => { clear(box); const c = el('span', 'chip ' + (ok ? 'ok' : 'bad'), ok ? 'goal met' : 'goal not met'); box.appendChild(c); box.appendChild(document.createTextNode('  ' + text)); };

  // ---- 1 · weather ---------------------------------------------------------------------------------------------------------------------------
  const wx = { board: null, radio: 'wifi', battery: 'aa2', periodS: 60, sleepUa: 8 };
  (function weather() {
    const cols = window.ATLAS.cols, ci = (k) => cols.indexOf(k);
    const FEATURED = ['espressif32/adafruit_qtpy_esp32c3', 'nordicnrf52/adafruit_feather_nrf52840', 'raspberrypi/pico'];
    const box = $('boards');
    FEATURED.forEach((id) => {
      const r = window.ATLAS.rows.find((x) => x[0] === id); if (!r) return;
      const conn = r[ci('conn')].join(' + '), b = el('button', 'dev'); b.type = 'button'; b.style.marginBottom = '10px'; b.style.width = '100%';
      b.appendChild(el('b', '', r[ci('name')])); b.appendChild(el('span', '', r[ci('mcu')] + ' · ' + r[ci('mhz')] + ' MHz · ' + r[ci('flashKB')] + ' KB flash · ' + r[ci('ramKB')] + ' KB RAM · ' + (conn || 'no radio on the board')));
      const small = el('small'); const a = el('a', '', 'find similar boards in the Atlas'); a.href = 'atlas.html#q=' + encodeURIComponent(r[ci('mcu')]); a.style.textDecoration = 'underline'; small.appendChild(a); b.appendChild(small);
      b.addEventListener('click', (e) => {
        if (e.target.closest('a')) return;
        wx.board = id; wx.radio = conn.includes('wifi') ? 'wifi' : conn.includes('bluetooth') ? 'ble' : 'lora';
        box.querySelectorAll('.dev').forEach((x) => x.classList.toggle('on', x === b)); build(); calc();
      });
      box.appendChild(b);
    });
    function build() {
      const inp = $('wxIn'); clear(inp);
      inp.appendChild(UI.selectField('Radio class', Object.keys(IOT.RADIOS).map((k) => ({ value: k, label: IOT.RADIOS[k].label })), wx.radio, (v) => { wx.radio = v; calc(); }));
      inp.appendChild(UI.selectField('Battery', Object.keys(IOT.BATTERIES).map((k) => ({ value: k, label: IOT.BATTERIES[k].label })), wx.battery, (v) => { wx.battery = v; calc(); }));
      inp.appendChild(UI.selectField('Report every', [[10, '10 s'], [30, '30 s'], [60, '1 minute'], [300, '5 minutes'], [600, '10 minutes'], [3600, '1 hour']].map(([v, l]) => ({ value: v, label: l })), wx.periodS, (v) => { wx.periodS = Number(v); calc(); }));
      inp.appendChild(UI.numberField('Sleep current (µA)', wx.sleepUa, (v) => { wx.sleepUa = v; calc(); }, { min: 0, max: 5000 }));
    }
    function calc() {
      const out = $('wxOut'); clear(out);
      let p; try { p = labs.weatherPlan(wx); } catch (e) { out.textContent = String(e.message); return; }
      const v = el('p', 'note'); v.style.marginTop = '0'; verdict(v, p.pass, p.why); out.appendChild(v);
      const stat = el('div', 'stat'); [['average current', fmtNum(p.budget.avgUa, 1) + ' µA'], ['battery life', fmtLife(p.budget.lifeDays)], ['awake per cycle', fmtNum(p.awakeMs + 4, 1) + ' ms'], ['messages / cycle', String(p.messages)]].forEach(([k, val]) => { const d = el('div'); d.appendChild(el('b', '', val)); d.appendChild(el('span', '', k)); stat.appendChild(d); });
      out.appendChild(stat);
      const sh = el('div', 'share'); [['s1', p.budget.shares.sleep], ['s2', p.budget.shares.active], ['s3', p.budget.shares.tx], ['s4', p.budget.shares.selfDischarge]].forEach(([c, x]) => { const i = el('i', c); i.style.width = (x * 100).toFixed(2) + '%'; sh.appendChild(i); }); out.appendChild(sh);
      const key = el('div', 'sharekey'); [['#6f8cff', 'sleeping'], ['var(--warn)', 'MCU awake'], ['var(--bad)', 'radio'], ['var(--tx3)', 'self-discharge']].forEach(([c, t]) => { const s = el('span'); const i = el('i'); i.style.background = c; s.appendChild(i); s.appendChild(document.createTextNode(t)); key.appendChild(s); }); out.appendChild(key);
      $('wxBench').href = 'bench.html#preset=greenhouse&period=' + wx.periodS + '&radio=' + wx.radio + '&battery=' + wx.battery + '&sleep=' + wx.sleepUa;
      if (p.pass) mark('weather');
    }
    build(); calc();
  })();

  // ---- 2 · NACK ------------------------------------------------------------------------------------------------------------------------------
  (function nack() {
    const m = window.DEVICES.devices.find((d) => d.id === 'tmp117');
    $('nackCite').textContent = 'datasheet p. ' + m.addressCite.p;
    const tb = $('nackTable'), sel = $('nackAddr');
    m.addresses.forEach((a) => { const tr = el('tr'); tr.appendChild(el('td', '', a.strap.replace('ADD0 to ', 'ADD0 → '))); tr.appendChild(el('td', 'm', a.addr)); tb.appendChild(tr); const o = el('option', '', a.addr); o.value = parseInt(a.addr, 16); sel.appendChild(o); });
    sel.value = 0x49;
    const wv = WV.createWaveView($('nackWave'));
    $('nackGo').addEventListener('click', () => {
      const addr = Number(sel.value), r = labs.nackTry(addr);
      const out = $('nackOut'); clear(out);
      verdict(out, r.pass, r.ack ? 'address ' + hex2(addr) + ' answered and Device_ID read ' + (r.id === null ? '?' : '0x' + r.id.toString(16).toUpperCase().padStart(4, '0')) + (r.pass ? ': that is the TMP117 (0x0117).' : '.') : 'address ' + hex2(addr) + ' got a NACK: nothing on the bus owns it. The part is strapped "' + r.strap + '", which the table maps to another address.');
      const annos = [];
      r.dec.transactions.forEach((x) => { annos.push({ lane: 0, t0: x.addrT0, t1: x.addrT1, text: hex2(x.addr) + ' ' + x.dir + (x.addrAck ? '' : ' NAK'), cls: x.addrAck ? 'addr' : 'nak' }); x.bytes.forEach((b) => annos.push({ lane: 0, t0: b.t0, t1: b.t1, text: hex2(b.v), cls: b.ack ? '' : 'nak' })); });
      wv.set({ channels: [{ name: 'SCL', ch: r.enc.scl }, { name: 'SDA', ch: r.enc.sda }], lanes: ['bytes'], annos, endUs: r.enc.endUs });
      const code = 'const ADDR = ' + hex2(addr) + ";\nlog('Device ID =', hex(i2c.readReg16(ADDR, 0x0F)));";
      $('nackLab').href = 'lab.html#tmp117&code=' + encodeURIComponent(code);
      if (r.pass) mark('nack');
    });
    $('nackGo').click();
  })();

  // ---- 3 · -256 C ----------------------------------------------------------------------------------------------------------------------------
  (function glitch() {
    $('gGo').addEventListener('click', () => {
      const r = labs.glitchRun({ waitReady: $('gWait').checked, validate: $('gVal').checked });
      const out = $('gOut'); clear(out);
      const why = r.bad.length ? 'the dashboard received ' + fmtNum(r.bad[0].temperature_c, 0) + ' °C. Nothing told the firmware that this was not a measurement.' : r.rejected.length ? 'no bad value, but the reading for that cycle was thrown away (the diag message reports an error) because the part had no result yet.' : 'the true temperature arrived in the cycle right after the glitch.';
      verdict(out, r.pass, why);
      const tb = $('gRows'); clear(tb);
      r.readings.slice(0, 6).forEach((x) => { const tr = el('tr'); tr.appendChild(el('td', 'm', fmtNum(x.t / 1000, 1))); tr.appendChild(el('td', 'm' + (x.temperature_c < -100 ? ' nack' : ''), fmtNum(x.temperature_c, 4))); tb.appendChild(tr); });
      if (r.pass) mark('minus256');
    });
  })();

  // ---- 4 · coin cell -----------------------------------------------------------------------------------------------------------------------------
  (function coin() {
    const inp = $('coinIn'); let radio = 'wifi';
    inp.appendChild(UI.selectField('Radio class', Object.keys(IOT.RADIOS).map((k) => ({ value: k, label: IOT.RADIOS[k].label + ' (' + IOT.RADIOS[k].txMa + ' mA)' })), radio, (v) => { radio = v; }));
    inp.appendChild(el('p', 'hint', 'Cell: CR2032-class, 225 mAh, 3.0 V full, 20 Ω internal resistance (illustrative). The MCU resets below 1.8 V.'));
    $('coinGo').addEventListener('click', () => {
      const r = labs.coinRun(radio), out = $('coinOut'); clear(out);
      verdict(out, r.pass, r.brownouts > 0
        ? 'the node reset ' + r.brownouts + ' times and published ' + r.published + ' readings. At the burst the supply is ' + fmtNum(r.bat.vFull, 1) + ' V − ' + r.radio.txMa + ' mA × ' + r.bat.internalOhm + ' Ω = ' + fmtNum(r.sagV, 2) + ' V, below the ' + r.brownoutV + ' V limit.'
        : 'it published ' + r.published + ' readings with no reset (burst sag ' + fmtNum(r.sagV, 2) + ' V, above ' + r.brownoutV + ' V). Average current ' + fmtNum(r.avgUa, 0) + ' µA.');
      if (r.pass) mark('coincell');
    });
  })();

  // ---- 5 · baud ---------------------------------------------------------------------------------------------------------------------------------
  (function baud() {
    const sel = $('baudRx'); [1200, 2400, 4800, 9600, 19200, 38400, 57600, 115200].forEach((b) => { const o = el('option', '', String(b)); o.value = b; if (b === 115200) o.selected = true; sel.appendChild(o); });
    const wv = WV.createWaveView($('baudWave'));
    const run = () => {
      const r = labs.baudTry(Number(sel.value)), out = $('baudOut'); clear(out);
      verdict(out, r.pass, 'the terminal shows "' + r.text + '"' + (r.errors ? ' with ' + r.errors + ' framing error(s)' : '') + (r.pass ? '. That is exactly what was sent.' : '.'));
      wv.set({ channels: [{ name: 'TX', ch: r.enc.ch }], lanes: ['frames'], annos: r.dec.frames.map((f) => ({ lane: 0, t0: f.t0, t1: f.t1, text: (f.value >= 32 && f.value < 127 ? "'" + String.fromCharCode(f.value) + "'" : hex2(f.value)), cls: f.error ? 'nak' : '' })), endUs: r.enc.endUs });
      if (r.pass) mark('baud');
    };
    $('baudGo').addEventListener('click', run); run();
  })();

  paintDone();
})();
