/* Aletheon logic-analyzer core: turns bus transactions into digital waveforms and decodes waveforms back into bytes.
 *
 * A channel is { name, init, edges }: the level at time 0 and the sorted times (microseconds) at which the line toggles. That is compact and
 * exact. The decoders work on any such channel, so they also decode a capture you import. Frame layouts follow the public specifications:
 * I2C (NXP UM10204: START/STOP are SDA edges while SCL is high, MSB first, ACK = SDA low on the 9th clock), UART (start bit low, data LSB
 * first, optional parity, stop bit high) and SPI (the four Motorola CPOL/CPHA modes).
 *
 * Honest scope: ideal edges. Rise and fall times, ringing, glitches, bus capacitance, clock stretching and timing-margin violations are not
 * modeled, and "decoded" here means the logic levels, not that real hardware would meet its electrical specification. */
(function (root) {
  'use strict';

  // ---- channels --------------------------------------------------------------------------------------------------------------------
  function builder(name, init) {
    const edges = [];
    let level = init ? 1 : 0;
    const b = {
      name, init: level, edges,
      get level() { return level; },
      set(t, v) {
        v = v ? 1 : 0;
        if (v === level) return b;
        if (edges.length && t < edges[edges.length - 1] - 1e-9) throw new Error(`edge at ${t} us is earlier than the previous edge on ${name}`);
        edges.push(t); level = v;
        return b;
      },
    };
    return b;
  }
  function levelAt(ch, t) { // edges at exactly t have already happened
    let lo = 0, hi = ch.edges.length;
    while (lo < hi) { const m = (lo + hi) >> 1; if (ch.edges[m] <= t) lo = m + 1; else hi = m; }
    return ch.init ^ (lo & 1);
  }
  const endOf = (...chs) => Math.max(0, ...chs.map((c) => (c.edges.length ? c.edges[c.edges.length - 1] : 0)));

  // ---- I2C -----------------------------------------------------------------------------------------------------------------------------
  // events use the Device Lab shape: { dir: 'W'|'R', addr, bytes, ack }. Other kinds ('I', 'S') carry no bus traffic and are skipped.
  function i2cEncode(events, opt) {
    opt = opt || {};
    const f = opt.sclHz || 100000, T = 1e6 / f, gap = (opt.gapBits === undefined ? 6 : opt.gapBits) * T;
    const scl = builder('SCL', 1), sda = builder('SDA', 1);
    let t = opt.startUs === undefined ? 2 * T : opt.startUs, open = false;
    const cell = (v) => { sda.set(t, v); scl.set(t + T / 4, 1); scl.set(t + (3 * T) / 4, 0); t += T; };
    const start = (repeated) => {
      if (repeated) { sda.set(t, 1); scl.set(t + T / 4, 1); sda.set(t + T / 2, 0); scl.set(t + (3 * T) / 4, 0); t += T; } else { sda.set(t, 0); scl.set(t + T / 4, 0); t += T / 2; }
      open = true;
    };
    const stop = () => { sda.set(t, 0); scl.set(t + T / 4, 1); sda.set(t + T / 2, 1); t += T / 2 + gap; open = false; };
    const byteOut = (val, ackBit) => { for (let i = 7; i >= 0; i--) cell((val >> i) & 1); cell(ackBit); };
    const bus = events.filter((e) => e.dir === 'W' || e.dir === 'R');
    bus.forEach((e, i) => {
      const repeated = open;
      start(repeated);
      byteOut(((e.addr & 0x7f) << 1) | (e.dir === 'R' ? 1 : 0), e.ack ? 0 : 1);
      if (e.ack) {
        const n = e.bytes.length;
        e.bytes.forEach((b, k) => byteOut(b & 0xff, e.dir === 'W' ? 0 : k === n - 1 ? 1 : 0)); // read: the master ACKs every byte but the last
      }
      const next = bus[i + 1];
      if (!(opt.repeatedStart && e.ack && e.dir === 'W' && next && next.dir === 'R' && next.addr === e.addr)) stop();
    });
    if (open) stop();
    return { scl, sda, endUs: t };
  }

  function i2cDecode(scl, sda) {
    const ev = [];
    scl.edges.forEach((t) => ev.push([t, 0]));
    sda.edges.forEach((t) => ev.push([t, 1]));
    ev.sort((a, b) => a[0] - b[0] || a[1] - b[1]); // at the same instant SCL is handled first
    const out = { transactions: [], errors: [], sclHz: 0, bitCells: [] };
    let sc = scl.init, sd = sda.init, tx = null, byte = null, riseTimes = [];
    const closeByte = () => { byte = null; };
    const newByte = () => { byte = { bits: 0, v: 0, t0: 0 }; };
    const finishTx = (t, why) => {
      if (!tx) return;
      if (byte && byte.bits > 0) out.errors.push({ t, text: `${why} in the middle of a byte (${byte.bits} of 9 bits)` });
      tx.t1 = t; out.transactions.push(tx); tx = null; closeByte();
    };
    ev.forEach(([t, which]) => {
      if (which === 0) {
        sc ^= 1;
        if (sc === 1 && tx) { // SCL rising: the bit on SDA is valid now
          if (!byte) newByte();
          if (byte.bits === 0) byte.t0 = t;
          riseTimes.push(t);
          if (byte.bits < 8) { byte.v = (byte.v << 1) | sd; byte.bits++; byte.tAfter = t; } else {
            const b = { v: byte.v, ack: sd === 0, t0: byte.t0, t1: t };
            if (tx.bytes.length === 0 && !tx.addrDone) { tx.addr = b.v >> 1; tx.dir = b.v & 1 ? 'R' : 'W'; tx.addrAck = b.ack; tx.addrDone = true; tx.addrT0 = b.t0; tx.addrT1 = b.t1; } else tx.bytes.push(b);
            closeByte();
          }
        }
      } else {
        sd ^= 1;
        if (sc === 1) { // an SDA edge while SCL is high is a START or a STOP, never data
          // The SCL rise just before it was the clock pulse of the START/STOP itself, not a data bit: take that sample back.
          if (byte && byte.bits > 0 && byte.bits < 9 && riseTimes.length && byte.tAfter === riseTimes[riseTimes.length - 1]) { byte.bits--; byte.v >>= 1; riseTimes.pop(); }
          if (sd === 0) { const rep = !!tx; if (tx) finishTx(t, 'repeated START'); tx = { t0: t, t1: null, bytes: [], addrDone: false, repeated: rep }; newByte(); } else finishTx(t, 'STOP');
        }
      }
    });
    if (tx) { out.errors.push({ t: tx.t0, text: 'the capture ends inside a transaction (no STOP)' }); tx.t1 = null; tx.open = true; out.transactions.push(tx); }
    // estimate the clock from the rising edges inside bytes
    const d = [];
    for (let i = 1; i < riseTimes.length; i++) { const x = riseTimes[i] - riseTimes[i - 1]; if (x > 0) d.push(x); }
    d.sort((a, b) => a - b);
    if (d.length) out.sclHz = 1e6 / d[Math.floor(d.length / 2)];
    out.transactions.forEach((x) => { x.dir = x.dir || 'W'; });
    return out;
  }
  // Back to Device Lab shaped events (for comparing with what was encoded).
  const i2cToEvents = (dec) => dec.transactions.filter((x) => x.addrDone).map((x) => ({ dir: x.dir, addr: x.addr, bytes: x.addrAck ? x.bytes.map((b) => b.v) : [], ack: x.addrAck }));

  // ---- UART ----------------------------------------------------------------------------------------------------------------------------
  function uartBits(val, o) {
    const bits = [0]; // start bit
    let ones = 0;
    for (let i = 0; i < o.data; i++) { const b = (val >> i) & 1; bits.push(b); ones += b; } // LSB first
    if (o.parity === 'even') bits.push(ones & 1);
    else if (o.parity === 'odd') bits.push((ones & 1) ^ 1);
    for (let i = 0; i < o.stop; i++) bits.push(1);
    return bits;
  }
  const uartOpts = (o) => ({ baud: 9600, data: 8, parity: 'none', stop: 1, ...(o || {}) });
  function uartEncode(bytes, opt) {
    const o = uartOpts(opt), bt = 1e6 / o.baud, ch = builder('TX', 1);
    let t = opt && opt.startUs !== undefined ? opt.startUs : 2 * bt;
    bytes.forEach((v) => {
      uartBits(v & ((1 << o.data) - 1), o).forEach((b) => { ch.set(t, b); t += bt; });
      t += (opt && opt.idleBits ? opt.idleBits : 0) * bt;
    });
    return { ch, endUs: t };
  }
  function uartDecode(ch, opt) {
    const o = uartOpts(opt), bt = 1e6 / o.baud, frames = [], errors = [];
    const frameBits = 1 + o.data + (o.parity === 'none' ? 0 : 1) + o.stop;
    let i = 0, t = -Infinity;
    const firstFall = (from) => { for (let k = 0; k < ch.edges.length; k++) if (ch.edges[k] >= from && levelAt(ch, ch.edges[k]) === 0) return ch.edges[k]; return null; };
    for (;;) {
      const ts = firstFall(t === -Infinity ? 0 : t);
      if (ts === null) break;
      const sample = (n) => levelAt(ch, ts + (n + 0.5) * bt); // the middle of bit n
      let v = 0, ones = 0, err = null;
      if (sample(0) !== 0) { t = ts + bt * 0.5; i++; continue; } // a glitch, not a start bit
      for (let b = 0; b < o.data; b++) { const x = sample(1 + b); v |= x << b; ones += x; }
      let pos = 1 + o.data;
      if (o.parity !== 'none') {
        const p = sample(pos++);
        if (p !== (o.parity === 'even' ? ones & 1 : (ones & 1) ^ 1)) err = 'parity';
      }
      for (let s = 0; s < o.stop; s++) if (sample(pos + s) !== 1) err = err || 'framing';
      frames.push({ t0: ts, t1: ts + frameBits * bt, value: v, error: err });
      if (err) errors.push({ t: ts, text: `${err} error on byte ${frames.length}` });
      // resume after the stop bit(s), half a bit early so the next start bit is found even with a small baud error
      t = ts + (frameBits - 0.5) * bt; i++;
      if (i > 100000) break;
    }
    return { frames, errors, bitUs: bt };
  }

  // ---- SPI -----------------------------------------------------------------------------------------------------------------------------
  // Motorola modes: 0 = CPOL 0, CPHA 0; 1 = 0,1; 2 = 1,0; 3 = 1,1. Data is sampled on the clock's leading edge when CPHA = 0 and on the
  // trailing edge when CPHA = 1; the leading edge is a rising edge when CPOL = 0.
  const spiMode = (m) => ({ cpol: (m >> 1) & 1, cpha: m & 1 });
  function spiEncode(mosiBytes, misoBytes, opt) {
    opt = opt || {};
    const { cpol, cpha } = spiMode(opt.mode || 0), T = 1e6 / (opt.hz || 1000000), n = mosiBytes.length;
    const cs = builder('CS', 1), sck = builder('SCK', cpol), mosi = builder('MOSI', 0), miso = builder('MISO', 0);
    const lead = cpol ^ 1, trail = cpol; // levels after the leading and trailing edge
    let t = opt.startUs === undefined ? 4 * T : opt.startUs;
    cs.set(t, 0); t += T;
    for (let k = 0; k < n; k++) {
      for (let i = 7; i >= 0; i--) {
        const mo = (mosiBytes[k] >> i) & 1, mi = ((misoBytes[k] || 0) >> i) & 1;
        if (cpha === 0) { mosi.set(t, mo); miso.set(t, mi); sck.set(t + T / 2, lead); sck.set(t + T, trail); } // data is set up before the leading edge
        else { sck.set(t + T / 2 - T / 4, lead); mosi.set(t + T / 2 - T / 4, mo); miso.set(t + T / 2 - T / 4, mi); sck.set(t + T, trail); } // data changes on the leading edge
        t += T;
      }
    }
    t += T; cs.set(t, 1);
    return { cs, sck, mosi, miso, endUs: t + 2 * T };
  }
  function spiDecode(chs, opt) {
    const { cpol, cpha } = spiMode((opt || {}).mode || 0), lead = cpol ^ 1, sampleLevel = cpha === 0 ? lead : cpol; // sample on this clock level transition
    const { cs, sck, mosi, miso } = chs;
    const sel = []; // [t0, t1] while CS is low
    let open = null;
    cs.edges.forEach((t) => { if (levelAt(cs, t) === 0) open = t; else if (open !== null) { sel.push([open, t]); open = null; } });
    if (open !== null) sel.push([open, Infinity]);
    if (!cs.edges.length && cs.init === 0) sel.push([0, Infinity]);
    const transfers = [], errors = [];
    sel.forEach(([a, b]) => {
      const mo = [], mi = [], times = [];
      sck.edges.forEach((t) => { if (t >= a && t < b && levelAt(sck, t) === sampleLevel) { mo.push(levelAt(mosi, t)); mi.push(levelAt(miso, t)); times.push(t); } });
      const pack = (bits) => { const o = []; for (let i = 0; i + 8 <= bits.length; i += 8) { let v = 0; for (let k = 0; k < 8; k++) v = (v << 1) | bits[i + k]; o.push(v); } return o; };
      if (mo.length % 8) errors.push({ t: a, text: `${mo.length} clock edges sampled in one chip-select: not a whole number of bytes (wrong mode?)` });
      transfers.push({ t0: a, t1: b === Infinity ? endOf(sck) : b, mosi: pack(mo), miso: pack(mi), bits: mo.length, sampleTimes: times });
    });
    return { transfers, errors };
  }

  // A made-up register device for teaching. It is NOT a real part: command 0x03 reads, 0x02 writes, then an address byte, then data.
  function genericSpiDevice() {
    const regs = new Uint8Array(256);
    regs[0x00] = 0xa5; regs[0x01] = 0x3c;
    return {
      regs,
      transfer(mosi) { // returns the bytes the device drives on MISO
        const miso = new Array(mosi.length).fill(0xff);
        if (mosi.length >= 2 && mosi[0] === 0x03) for (let i = 2; i < mosi.length; i++) miso[i] = regs[(mosi[1] + i - 2) & 0xff];
        else if (mosi.length >= 3 && mosi[0] === 0x02) for (let i = 2; i < mosi.length; i++) regs[(mosi[1] + i - 2) & 0xff] = mosi[i];
        return miso;
      },
    };
  }

  // ---- PWM and GPIO -----------------------------------------------------------------------------------------------------------------
  function pwmGenerate(opt) {
    const T = 1e6 / opt.hz, ch = builder(opt.name || 'PWM', 0), high = T * Math.min(1, Math.max(0, opt.duty));
    let t = opt.startUs || 0;
    for (let p = 0; p < opt.periods; p++) { if (high > 0) ch.set(t, 1); if (high < T) ch.set(t + high, 0); t += T; }
    return { ch, endUs: t };
  }
  function pwmMeasure(ch) {
    const rises = [], highs = [];
    let up = null;
    ch.edges.forEach((t) => { if (levelAt(ch, t) === 1) { rises.push(t); up = t; } else if (up !== null) { highs.push(t - up); up = null; } });
    if (rises.length < 2) return { periods: 0, freqHz: 0, dutyPct: 0, highUs: highs[0] || 0 };
    const per = []; for (let i = 1; i < rises.length; i++) per.push(rises[i] - rises[i - 1]);
    const avg = (a) => a.reduce((x, y) => x + y, 0) / a.length, T = avg(per), H = avg(highs.slice(0, per.length));
    return { periods: per.length, freqHz: 1e6 / T, periodUs: T, highUs: H, dutyPct: (H / T) * 100 };
  }
  // Hobby-servo convention: 50 Hz frame, a 1000 us pulse is 0 degrees and 2000 us is 180 degrees. Real servos differ; check the one you use.
  const servoAngle = (highUs) => Math.min(180, Math.max(0, ((highUs - 1000) / 1000) * 180));
  // A mechanical button: after the press the line bounces between levels for a few milliseconds before it settles.
  function buttonBounce(opt, rand) {
    const ch = builder(opt.name || 'BTN', 1);
    let t = opt.pressUs;
    ch.set(t, 0);
    for (let i = 0; i < opt.bounces; i++) { t += 40 + rand() * 600; ch.set(t, 1); t += 40 + rand() * 600; ch.set(t, 0); }
    if (opt.releaseUs) ch.set(opt.releaseUs, 1);
    return { ch, settledUs: t };
  }
  const countEdges = (ch) => ch.edges.length;

  // ---- importing a capture ------------------------------------------------------------------------------------------------------------------
  // CSV as exported by common logic analyzers: a header, then one row per CHANGE: time in seconds, then one 0/1 column per channel.
  function parseCsv(text, maxRows) {
    const rows = String(text).split(/\r?\n/).filter((l) => l.trim() !== '');
    if (rows.length < 2) throw new Error('the file needs a header row and at least one data row');
    if (rows.length > (maxRows || 200000)) throw new Error(`too many rows (${rows.length}); the limit is ${maxRows || 200000}`);
    const head = rows[0].split(',').map((s) => s.trim().replace(/^"|"$/g, ''));
    if (head.length < 2) throw new Error('expected a time column followed by at least one channel column');
    const chans = head.slice(1).map((n, i) => ({ name: n || 'ch' + i, init: 0, edges: [] }));
    let prev = null, lastT = -Infinity;
    for (let r = 1; r < rows.length; r++) {
      const c = rows[r].split(',');
      const t = Number(c[0]) * 1e6;
      if (!isFinite(t)) throw new Error(`row ${r + 1}: "${c[0]}" is not a time in seconds`);
      if (t < lastT) throw new Error(`row ${r + 1}: time goes backwards`);
      lastT = t;
      const lv = chans.map((_, i) => { const x = c[i + 1] === undefined ? NaN : Number(c[i + 1]); if (x !== 0 && x !== 1) throw new Error(`row ${r + 1}: channel values must be 0 or 1`); return x; });
      if (prev === null) lv.forEach((x, i) => { chans[i].init = x; });
      else lv.forEach((x, i) => { if (x !== prev[i]) chans[i].edges.push(t); });
      prev = lv;
    }
    return chans;
  }

  const api = { builder, levelAt, endOf, i2cEncode, i2cDecode, i2cToEvents, uartEncode, uartDecode, uartBits, spiEncode, spiDecode, spiMode, genericSpiDevice, pwmGenerate, pwmMeasure, servoAngle, buttonBounce, countEdges, parseCsv };
  root.AletheonLogic = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
