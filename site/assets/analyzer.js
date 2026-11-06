/* Logic Analyzer page: builds waveforms from I2C / SPI / UART / PWM / GPIO sources, decodes them with logiccore.js and shows both.
 * No network, no eval. All output is built with textContent. */
(function () {
  'use strict';
  const UI = window.AletheonUI, L = window.AletheonLogic, IOT = window.AletheonIot, S = window.AletheonSim, WV = window.AletheonWave;
  const { el, clear, $, fmtNum } = UI;
  if (!window.DEVICES || !window.__aletheonDevCore || !L || !IOT || !WV) { $('anaError').textContent = 'The analyzer scripts failed to load.'; return; }
  const core = window.__aletheonDevCore(window.DEVICES);
  const hex2 = UI.hex2;
  const hexList = (a) => a.map(hex2).join(' ');
  const parseBytes = (text) => {
    const t = text.trim();
    if (!t) return [];
    return t.split(/[\s,]+/).map((x) => {
      if (!/^(0x)?[0-9a-fA-F]{1,2}$/.test(x)) throw new Error('"' + x + '" is not a byte (use hex like 03 1F 0xA5)');
      return parseInt(x.replace(/^0x/i, ''), 16);
    });
  };
  const num = (id, lo, hi, dflt) => { const v = Number($(id).value); return isFinite(v) && v >= lo && v <= hi ? v : dflt; };
  const fillSelect = (id, opts, sel) => { const s = $(id); clear(s); opts.forEach(([v, l]) => { const o = el('option', '', l); o.value = v; if (String(v) === String(sel)) o.selected = true; s.appendChild(o); }); };
  const rows = (tbl, list) => { const tb = $(tbl).tBodies[0]; clear(tb); list.forEach((r) => { const tr = el('tr'); r.forEach((c) => { const td = el('td', c.cls || '', c.text !== undefined ? c.text : c); tr.appendChild(td); }); tb.appendChild(tr); }); };

  // ---- I2C: sources -------------------------------------------------------------------------------------------------------------------
  const SCENARIOS = {
    'tmp-read': ['TMP117: read the ID and a temperature', () => {
      const b = IOT.createBus(core); b.attach('tmp117', 0x48, { temp: 25 }); b.readReg16(0x48, 0x0f); b.delay(200); b.readReg16(0x48, 0x01); b.readReg16(0x48, 0x00); return b.events;
    }],
    'tmp-nack': ['Debug a NACK: the code talks to the wrong address', () => {
      const b = IOT.createBus(core); b.attach('tmp117', 0x48, { temp: 25 });
      b.readReg16(0x49, 0x00); // the strap pin is wired to GND, so the part answers at 0x48, not 0x49
      b.readReg16(0x48, 0x0f); return b.events;
    }],
    'ina226-cal': ['INA226: write the calibration, read the current', () => {
      const b = IOT.createBus(core); b.attach('ina226', 0x40, { vbus: 11.98, iload: 10, rshunt: 0.002 });
      IOT.DRIVERS.ina226.init(b, 0x40, { rshunt: 0.002, currentLsb: 0.001 }); IOT.DRIVERS.ina226.read(b, 0x40, { rshunt: 0.002, currentLsb: 0.001 }, {}); return b.events;
    }],
    'ads-single': ['ADS1115: one single-shot conversion (watch it poll)', () => {
      const b = IOT.createBus(core); b.attach('ads1115', 0x48, { ain0: 1.65, ain1: 0, ain2: 0, ain3: 0 }); IOT.DRIVERS.ads1115.read(b, 0x48, { channels: [0], pga: 1 }, {}); return b.events;
    }],
  };
  const MAX_CAPTURE_BYTES = 20000, MAX_UI_TX = 2000; // keeps a crafted capture or CSV from freezing the page
  let i2cSource = 'tmp-read', csvChans = null, capture = null;

  function loadCapture() {
    try {
      const raw = sessionStorage.getItem('aletheon.capture');
      if (!raw) return null;
      const c = JSON.parse(raw);
      if (!c || !Array.isArray(c.events) || c.events.length > 5000) return null;
      let budget = MAX_CAPTURE_BYTES; // total data bytes across the capture
      c.events = c.events.filter((e) => { if (!e || !Array.isArray(e.bytes)) return false; budget -= e.bytes.length; return budget >= 0; });
      const ev = c.events.filter((e) => e && (e.dir === 'W' || e.dir === 'R' || e.dir === 'I' || e.dir === 'S') && Array.isArray(e.bytes) && e.bytes.every((b) => Number.isInteger(b) && b >= 0 && b < 256) && Number.isInteger(e.addr) && e.addr >= 0 && e.addr < 128).map((e) => ({ dir: e.dir, addr: e.addr, bytes: e.bytes, ack: !!e.ack, note: typeof e.note === 'string' ? e.note.slice(0, 300) : '', warn: Array.isArray(e.warn) ? e.warn.filter((x) => typeof x === 'string').map((x) => x.slice(0, 200)) : [], t: typeof e.t === 'number' ? e.t : 0 }));
      return { source: typeof c.source === 'string' ? c.source.slice(0, 80) : 'another page', events: ev };
    } catch (e) { return null; }
  }

  const wave = {};
  function show(name, d) { wave[name].set(d); }

  function annotateI2c(dec, lanesName) {
    const annos = [];
    dec.transactions.forEach((x) => {
      if (x.addrDone) annos.push({ lane: 0, t0: x.addrT0, t1: x.addrT1, text: '0x' + x.addr.toString(16).toUpperCase().padStart(2, '0') + ' ' + x.dir + (x.addrAck ? '' : ' NAK'), cls: x.addrAck ? 'addr' : 'nak', title: 'Address byte: 7-bit address ' + hex2(x.addr) + ', ' + (x.dir === 'W' ? 'write' : 'read') + (x.addrAck ? ', ACKed' : ', NOT acknowledged (nobody answered)') });
      x.bytes.forEach((b) => annos.push({ lane: 0, t0: b.t0, t1: b.t1, text: hex2(b.v) + (b.ack ? '' : ' NAK'), cls: b.ack ? '' : 'nak', title: (x.dir === 'W' ? 'Byte written: ' : 'Byte read: ') + hex2(b.v) + (b.ack ? ' (ACK)' : x.dir === 'R' ? ' (master NACK: last byte)' : ' (NAK)') }));
      if (x.t1 !== null) annos.push({ lane: 1, t0: x.t0, t1: x.t1, text: (x.repeated ? 'Sr ' : 'S ') + x.dir + ' ' + (x.addrDone ? hex2(x.addr) : '?') + ' · ' + x.bytes.length + ' B', cls: 'tx', title: 'START … STOP' });
    });
    return annos;
  }

  function runI2c() {
    $('i2cMsg').textContent = '';
    let events = null, note = '', chans = null;
    if (i2cSource === 'csv') {
      if (!csvChans) { $('i2cMsg').textContent = 'Paste or load a CSV capture, choose the SCL and SDA columns, then press Decode.'; rows('i2cTbl', []); wave.i2c.set({ channels: [], lanes: [] }); $('i2cSummary').textContent = ''; return; }
      const si = Number($('colScl').value), di = Number($('colSda').value);
      if (si === di) { $('i2cMsg').textContent = 'SCL and SDA must be different columns.'; return; }
      chans = { scl: { ...csvChans[si], name: 'SCL' }, sda: { ...csvChans[di], name: 'SDA' } };
      note = 'imported capture';
    } else {
      if (i2cSource === 'capture') { events = capture ? capture.events : []; note = capture ? 'capture from ' + capture.source : ''; } else { events = SCENARIOS[i2cSource][1](); note = SCENARIOS[i2cSource][0]; }
      const enc = L.i2cEncode(events, { sclHz: Number($('sclHz').value), repeatedStart: $('rstart').checked });
      chans = { scl: enc.scl, sda: enc.sda, endUs: enc.endUs };
    }
    const dec = L.i2cDecode(chans.scl, chans.sda);
    const decShown = { ...dec, transactions: dec.transactions.slice(0, MAX_UI_TX) }, annos = annotateI2c(decShown);
    wave.i2c.set({ channels: [{ name: 'SCL', ch: chans.scl }, { name: 'SDA', ch: chans.sda }], lanes: ['bytes', 'frames'], annos, endUs: chans.endUs || L.endOf(chans.scl, chans.sda) + 20 });
    const bus = events ? events.filter((e) => e.dir === 'W' || e.dir === 'R') : null;
    const list = decShown.transactions.map((x, i) => {
      const ev = bus && bus[i];
      return [{ text: String(i + 1), cls: 'm' }, { text: UI.fmtNum(x.t0, 1), cls: 'm' }, { text: x.dir, cls: 'm' }, { text: x.addrDone ? hex2(x.addr) : '?', cls: 'm' }, { text: hexList(x.bytes.map((b) => b.v)) || '—', cls: 'm' }, { text: x.addrDone ? (x.addrAck ? 'ACK' : 'NACK: nobody answered') : 'incomplete', cls: x.addrAck ? '' : 'nack' }, { text: ev && ev.note ? ev.note : '' }];
    });
    rows('i2cTbl', list);
    const parts = [dec.transactions.length + ' transactions decoded' + (dec.transactions.length > MAX_UI_TX ? ' (the first ' + MAX_UI_TX + ' are drawn and listed)' : ''), 'clock measured ' + fmtNum(dec.sclHz / 1000, 1) + ' kHz', note];
    if (bus) { const ok = JSON.stringify(L.i2cToEvents(dec)) === JSON.stringify(bus.map((e) => ({ dir: e.dir, addr: e.addr, bytes: e.ack ? e.bytes : [], ack: e.ack }))); parts.push(ok ? 'the decoder agrees with the bus log (every address, direction, byte and ACK matches)' : 'DECODER DISAGREES with the bus log'); }
    if (dec.errors.length) parts.push(dec.errors.length + ' decode warning(s): ' + dec.errors.map((e) => e.text).slice(0, 3).join('; '));
    $('i2cSummary').textContent = parts.filter(Boolean).join(' · ');
    $('i2cWarn').textContent = (bus || []).flatMap((e) => e.warn || []).slice(0, 3).join(' · ');
  }

  function initI2c() {
    capture = loadCapture();
    const opts = Object.keys(SCENARIOS).map((k) => [k, SCENARIOS[k][0]]);
    if (capture) opts.unshift(['capture', 'Capture from ' + capture.source + ' (' + capture.events.length + ' events)']);
    opts.push(['csv', 'Import a CSV capture (from a real logic analyzer)']);
    if (capture && location.hash === '#capture') i2cSource = 'capture';
    fillSelect('i2cSrc', opts, i2cSource);
    fillSelect('sclHz', [[100000, '100 kHz (standard mode)'], [400000, '400 kHz (fast mode)'], [1000000, '1 MHz (fast-mode plus)']], 100000);
    $('i2cSrc').addEventListener('change', () => { i2cSource = $('i2cSrc').value; $('csvBox').style.display = i2cSource === 'csv' ? '' : 'none'; $('genOpts').style.display = i2cSource === 'csv' ? 'none' : ''; runI2c(); });
    ['sclHz', 'rstart'].forEach((id) => $(id).addEventListener('change', runI2c));
    $('csvFile').addEventListener('change', () => {
      const f = $('csvFile').files[0]; if (!f) return;
      if (f.size > 4e6) { $('i2cMsg').textContent = 'That file is over 4 MB; trim it to the part you want.'; return; }
      const r = new FileReader(); r.onload = () => { $('csvText').value = String(r.result); }; r.readAsText(f);
    });
    $('csvGo').addEventListener('click', () => {
      try {
        if ($('csvText').value.length > 4e6) throw new Error('That is over 4 MB of text; trim it to the part you want.');
        csvChans = L.parseCsv($('csvText').value);
        fillSelect('colScl', csvChans.map((c, i) => [i, c.name]), 0); fillSelect('colSda', csvChans.map((c, i) => [i, c.name]), Math.min(1, csvChans.length - 1));
        $('cols').style.display = ''; runI2c();
      } catch (e) { csvChans = null; $('i2cMsg').textContent = String(e.message); }
    });
    ['colScl', 'colSda'].forEach((id) => $(id).addEventListener('change', runI2c));
    $('csvText').value = 'Time [s],SCL,SDA\n0,1,1\n0.0001,1,0\n0.000102,0,0\n';
    $('csvBox').style.display = 'none';
    $('cols').style.display = 'none';
  }

  // ---- SPI --------------------------------------------------------------------------------------------------------------------------------
  function runSpi() {
    $('spiMsg').textContent = '';
    let mo, mi;
    try { mo = parseBytes($('spiMosi').value); mi = $('spiDev').value === 'generic' ? null : parseBytes($('spiMiso').value); } catch (e) { $('spiMsg').textContent = String(e.message); return; }
    if (mo.length === 0 || mo.length > 32) { $('spiMsg').textContent = 'Enter between 1 and 32 MOSI bytes.'; return; }
    if (mi === null) { mi = $('spiDev').value === 'generic' ? devSpi.transfer(mo) : []; }
    while (mi.length < mo.length) mi.push(0);
    const mode = Number($('spiMode').value), dmode = Number($('spiDmode').value);
    const enc = L.spiEncode(mo, mi, { mode, hz: Number($('spiHz').value) }), dec = L.spiDecode(enc, { mode: dmode });
    const annos = [];
    dec.transfers.forEach((t) => t.sampleTimes.forEach((st, i) => { if (i % 8 === 7) { const k = (i - 7) / 8; annos.push({ lane: 0, t0: t.sampleTimes[i - 7] - 0.4 * (1e6 / Number($('spiHz').value)), t1: st + 0.4 * (1e6 / Number($('spiHz').value)), text: hex2(t.mosi[k]), title: 'MOSI byte ' + hex2(t.mosi[k]) }); annos.push({ lane: 1, t0: t.sampleTimes[i - 7] - 0.4 * (1e6 / Number($('spiHz').value)), t1: st + 0.4 * (1e6 / Number($('spiHz').value)), text: hex2(t.miso[k]), title: 'MISO byte ' + hex2(t.miso[k]) }); } }));
    wave.spi.set({ channels: [{ name: 'CS', ch: enc.cs }, { name: 'SCK', ch: enc.sck }, { name: 'MOSI', ch: enc.mosi }, { name: 'MISO', ch: enc.miso }], lanes: ['MOSI bytes', 'MISO bytes'], annos, endUs: enc.endUs });
    const t = dec.transfers[0];
    const same = t && JSON.stringify(t.mosi) === JSON.stringify(mo) && JSON.stringify(t.miso) === JSON.stringify(mi);
    $('spiSummary').textContent = (t ? 'decoded MOSI ' + hexList(t.mosi) + ' · MISO ' + hexList(t.miso) : 'no transfer found') + ' · ' + (same ? 'matches what was sent' : 'DOES NOT match what was sent' + (mode !== dmode ? ' (the decoder is set to mode ' + dmode + ' but the bus runs in mode ' + mode + ')' : '')) + (dec.errors.length ? ' · ' + dec.errors[0].text : '');
    rows('spiTbl', t ? t.mosi.map((v, i) => [{ text: String(i), cls: 'm' }, { text: hex2(mo[i]), cls: 'm' }, { text: hex2(v), cls: 'm' + (v === mo[i] ? '' : ' nack') }, { text: hex2(mi[i] === undefined ? 0 : mi[i]), cls: 'm' }, { text: hex2(t.miso[i] === undefined ? 0 : t.miso[i]), cls: 'm' + (t.miso[i] === mi[i] ? '' : ' nack') }]) : []);
  }
  const devSpi = L.genericSpiDevice();

  // ---- UART -------------------------------------------------------------------------------------------------------------------------------
  function runUart() {
    $('uartMsg').textContent = '';
    const text = $('uartText').value;
    if (text.length === 0 || text.length > 16) { $('uartMsg').textContent = 'Enter 1 to 16 characters.'; return; }
    const bytes = Array.from(text, (c) => c.charCodeAt(0) & 0xff);
    const o = { baud: Number($('uartBaud').value), data: Number($('uartData').value), parity: $('uartPar').value, stop: Number($('uartStop').value), idleBits: 1 };
    const rx = { ...o, baud: Number($('uartRx').value) };
    const enc = L.uartEncode(bytes, o), dec = L.uartDecode(enc.ch, rx);
    const annos = dec.frames.map((f) => ({ lane: 0, t0: f.t0, t1: f.t1, text: (f.value >= 32 && f.value < 127 ? "'" + String.fromCharCode(f.value) + "' " : '') + hex2(f.value), cls: f.error ? 'nak' : '', title: f.error ? f.error + ' error' : 'frame ' + hex2(f.value) }));
    wave.uart.set({ channels: [{ name: 'TX', ch: enc.ch }], lanes: ['frames'], annos, endUs: enc.endUs });
    const got = dec.frames.map((f) => (f.value >= 32 && f.value < 127 ? String.fromCharCode(f.value) : '·')).join('');
    $('uartSummary').textContent = 'bit time ' + fmtNum(1e6 / o.baud, 2) + ' µs · frame ' + (1 + o.data + (o.parity === 'none' ? 0 : 1) + o.stop) + ' bits · the receiver read "' + got + '"' + (o.baud === rx.baud ? '' : ' (receiver is set to ' + rx.baud + ' baud, sender sends ' + o.baud + ')') + (dec.errors.length ? ' · ' + dec.errors.length + ' error(s): ' + dec.errors[0].text : ' · no errors');
    rows('uartTbl', dec.frames.map((f, i) => [{ text: String(i + 1), cls: 'm' }, { text: hex2(f.value), cls: 'm' }, { text: f.value >= 32 && f.value < 127 ? String.fromCharCode(f.value) : '—', cls: 'm' }, { text: f.error || 'ok', cls: f.error ? 'nack' : '' }]));
  }

  // ---- PWM and GPIO -----------------------------------------------------------------------------------------------------------------------
  function runPwm() {
    const hz = num('pwmHz', 1, 1e6, 1000), duty = num('pwmDuty', 0, 100, 25) / 100;
    const g = L.pwmGenerate({ hz, duty, periods: 8 }), m = L.pwmMeasure(g.ch);
    wave.pwm.set({ channels: [{ name: 'PWM', ch: g.ch }], lanes: [], annos: [], endUs: g.endUs });
    $('pwmSummary').textContent = m.periods ? 'measured ' + fmtNum(m.freqHz, 4) + ' Hz, duty ' + fmtNum(m.dutyPct, 3) + ' %, high ' + fmtNum(m.highUs, 2) + ' µs per ' + fmtNum(m.periodUs, 2) + ' µs period' + (Math.abs(hz - 50) < 0.5 ? ' · as a hobby-servo signal: ' + fmtNum(L.servoAngle(m.highUs), 1) + '° (1 ms = 0°, 2 ms = 180°; real servos differ)' : '') : (duty === 0 ? 'steady low: 0 % duty has no edges' : duty === 1 ? 'steady high: 100 % duty has no edges' : 'not enough edges');
  }
  function runBounce() {
    const n = num('bounceN', 0, 12, 4), seed = num('bounceSeed', 0, 99999, 3);
    const b = L.buttonBounce({ pressUs: 1000, bounces: n }, S.rng(seed));
    wave.gpio.set({ channels: [{ name: 'BTN', ch: b.ch }], lanes: [], annos: [], endUs: b.settledUs + 2000 });
    $('bounceSummary').textContent = 'one press produced ' + L.countEdges(b.ch) + ' edges over ' + fmtNum((b.settledUs - 1000) / 1000, 2) + ' ms before the line settled low. Code that counts edges sees ' + Math.ceil(L.countEdges(b.ch) / 2) + ' presses; a debounce wait must outlast the bounce (10 to 20 ms is the usual rule of thumb for small switches, and a real switch can bounce longer).';
  }

  // ---- wiring -------------------------------------------------------------------------------------------------------------------------------
  function tab(name) {
    ['i2c', 'spi', 'uart', 'pwm'].forEach((t) => { $(t).style.display = t === name ? '' : 'none'; $('tab-' + t).classList.toggle('on', t === name); });
    try { history.replaceState(null, '', '#' + name); } catch (e) { /* ignore */ }
    ({ i2c: runI2c, spi: runSpi, uart: runUart, pwm: () => { runPwm(); runBounce(); } })[name]();
  }
  function init() {
    ['i2c', 'spi', 'uart', 'pwm', 'gpio'].forEach((k) => { wave[k] = WV.createWaveView($('wave-' + k)); });
    initI2c();
    fillSelect('spiMode', [[0, 'mode 0 (CPOL 0, CPHA 0)'], [1, 'mode 1 (CPOL 0, CPHA 1)'], [2, 'mode 2 (CPOL 1, CPHA 0)'], [3, 'mode 3 (CPOL 1, CPHA 1)']], 0);
    fillSelect('spiDmode', [[0, 'decode as mode 0'], [1, 'decode as mode 1'], [2, 'decode as mode 2'], [3, 'decode as mode 3']], 0);
    fillSelect('spiHz', [[100000, '100 kHz'], [1000000, '1 MHz'], [4000000, '4 MHz'], [10000000, '10 MHz']], 1000000);
    fillSelect('spiDev', [['generic', 'Generic register device (a teaching device, not a real part)'], ['typed', 'Type the MISO bytes yourself']], 'generic');
    $('spiMosi').value = '02 10 5A'; $('spiMiso').value = '00 00 00';
    $('spiPreset1').addEventListener('click', () => { $('spiMosi').value = '02 10 5A'; runSpi(); });
    $('spiPreset2').addEventListener('click', () => { $('spiMosi').value = '03 10 00'; runSpi(); });
    $('spiPreset3').addEventListener('click', () => { $('spiMosi').value = '03 00 00 00'; runSpi(); });
    ['spiMosi', 'spiMiso', 'spiMode', 'spiDmode', 'spiHz', 'spiDev'].forEach((id) => ['input', 'change'].forEach((ev) => $(id).addEventListener(ev, runSpi)));
    const bauds = [[1200, '1200'], [9600, '9600'], [19200, '19200'], [38400, '38400'], [57600, '57600'], [115200, '115200'], [921600, '921600']];
    fillSelect('uartBaud', bauds, 9600); fillSelect('uartRx', bauds, 9600);
    fillSelect('uartData', [[8, '8 data bits'], [7, '7 data bits']], 8); fillSelect('uartPar', [['none', 'no parity'], ['even', 'even parity'], ['odd', 'odd parity']], 'none'); fillSelect('uartStop', [[1, '1 stop bit'], [2, '2 stop bits']], 1);
    $('uartText').value = 'Hi!';
    ['uartText', 'uartBaud', 'uartRx', 'uartData', 'uartPar', 'uartStop'].forEach((id) => ['input', 'change'].forEach((ev) => $(id).addEventListener(ev, runUart)));
    ['pwmHz', 'pwmDuty'].forEach((id) => $(id).addEventListener('input', runPwm));
    ['bounceN', 'bounceSeed'].forEach((id) => $(id).addEventListener('input', runBounce));
    [['pwmLed', 1000, 25], ['pwmServo', 50, 7.5], ['pwmMotor', 20000, 80]].forEach(([id, hz, d]) => $(id).addEventListener('click', () => { $('pwmHz').value = hz; $('pwmDuty').value = d; runPwm(); }));
    ['i2c', 'spi', 'uart', 'pwm'].forEach((t) => $('tab-' + t).addEventListener('click', () => tab(t)));
    const h = (location.hash || '').slice(1);
    tab(['i2c', 'spi', 'uart', 'pwm'].includes(h) ? h : 'i2c');
  }
  init();
})();
