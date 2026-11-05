// Known-answer tests for the logic-analyzer core (site/assets/logiccore.js). Run from the project root:  node site/tools/test-logic.mjs
// The encoders and the decoders are written separately, so "encode then decode gives the original bytes" checks both against each other, and
// the property checks (START is an SDA fall while SCL is high, UART data goes LSB first, the SPI mode table) come from the protocol specs.
import * as fs from 'node:fs';
import * as vm from 'node:vm';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const L = require('../assets/logiccore.js');
const S = require('../assets/simcore.js');
const I = require('../assets/iotnodes.js');

let failed = 0;
const check = (label, ok, extra = '') => {
  if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${ok ? '' : ' :: ' + extra}`);
};
const near = (a, b, tol) => Math.abs(a - b) <= tol;
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// ---- I2C -------------------------------------------------------------------------------------------------------------------------------
{
  const enc = L.i2cEncode([{ dir: 'W', addr: 0x48, bytes: [0x00], ack: true }]);
  const dec = L.i2cDecode(enc.scl, enc.sda);
  const tx = dec.transactions[0];
  check(
    'I2C: a write to 0x48 puts 0x90 on the wire (7-bit address 0x48 shifted left, R/W = 0)',
    tx && tx.addrAck && tx.addr === 0x48 && tx.dir === 'W' && dec.transactions.length === 1,
  );
  const rd = L.i2cDecode(...Object.values(L.i2cEncode([{ dir: 'R', addr: 0x48, bytes: [0x01, 0x17], ack: true }])).slice(0, 2));
  check(
    'I2C: a read of 2 bytes from 0x48 decodes as address byte 0x91, bytes 0x01 0x17',
    rd.transactions[0].dir === 'R' &&
      same(
        rd.transactions[0].bytes.map((b) => b.v),
        [1, 0x17],
      ),
  );
  check(
    'I2C: the master ACKs every read byte except the last (NACK ends the read)',
    same(
      rd.transactions[0].bytes.map((b) => b.ack),
      [true, false],
    ),
  );
  check(
    'I2C: START is the first SDA edge and happens while SCL is high',
    L.levelAt(enc.scl, enc.sda.edges[0]) === 1 && L.levelAt(enc.sda, enc.sda.edges[0]) === 0,
  );
  check(
    'I2C: STOP is the last SDA edge, SDA rises while SCL is high',
    L.levelAt(enc.scl, enc.sda.edges.at(-1)) === 1 && L.levelAt(enc.sda, enc.sda.edges.at(-1)) === 1,
  );
  const sdaWhileHigh = enc.sda.edges.filter((t) => L.levelAt(enc.scl, t) === 1).length;
  check('I2C: SDA only changes while SCL is high at the START and the STOP (data is stable when SCL is high)', sdaWhileHigh === 2, String(sdaWhileHigh));
  check(
    'I2C: a write of 1 data byte clocks 18 SCL pulses (9 bits for the address byte, 9 for the data byte) plus the one that frames the STOP',
    enc.scl.edges.filter((t) => L.levelAt(enc.scl, t) === 1).length === 19,
  );
}
{
  const nack = L.i2cEncode([{ dir: 'W', addr: 0x49, bytes: [0x00], ack: false }]);
  const d = L.i2cDecode(nack.scl, nack.sda).transactions[0];
  check(
    'I2C: an address nobody answers is a NACK (SDA high on the 9th clock) and the master stops',
    d.addr === 0x49 && d.addrAck === false && d.bytes.length === 0,
  );
}
{
  // random transactions, three clock speeds, with and without repeated START
  const r = S.rng(11);
  const randEvents = () =>
    Array.from({ length: 1 + Math.floor(r() * 6) }, () => {
      const dir = r() < 0.5 ? 'W' : 'R',
        ack = r() < 0.9,
        n = 1 + Math.floor(r() * 4);
      return { dir, addr: Math.floor(r() * 128), bytes: ack ? Array.from({ length: n }, () => Math.floor(r() * 256)) : [], ack };
    });
  let ok = true,
    bad = '';
  for (const hz of [100000, 400000, 1000000])
    for (const rs of [false, true])
      for (let k = 0; k < 40; k++) {
        const ev = randEvents(),
          enc = L.i2cEncode(ev, { sclHz: hz, repeatedStart: rs }),
          dec = L.i2cDecode(enc.scl, enc.sda);
        if (!same(L.i2cToEvents(dec), ev) || dec.errors.length) {
          ok = false;
          bad = JSON.stringify({ hz, rs, ev, got: L.i2cToEvents(dec), errors: dec.errors });
          break;
        }
      }
  check('I2C: 240 random transaction sets round-trip through encode and decode at 100 kHz, 400 kHz and 1 MHz, with and without repeated START', ok, bad);
  const enc = L.i2cEncode(
    [
      { dir: 'W', addr: 0x48, bytes: [0x00], ack: true },
      { dir: 'R', addr: 0x48, bytes: [1, 2], ack: true },
    ],
    { repeatedStart: true },
  );
  const dec = L.i2cDecode(enc.scl, enc.sda);
  check(
    'I2C: with repeated START the read follows the write without a STOP in between',
    dec.transactions.length === 2 && dec.transactions[1].repeated === true && dec.transactions[0].t1 === dec.transactions[1].t0,
  );
  for (const hz of [100000, 400000, 1000000]) {
    const e = L.i2cEncode([{ dir: 'W', addr: 0x10, bytes: [1, 2, 3, 4], ack: true }], { sclHz: hz }),
      m = L.i2cDecode(e.scl, e.sda);
    check(`I2C: the decoder measures the ${hz / 1000} kHz clock to within 0.5 %`, near(m.sclHz / hz, 1, 0.005), String(m.sclHz));
  }
}
{
  const b = L.builder('SCL', 1),
    s = L.builder('SDA', 1);
  s.set(10, 0);
  b.set(12, 0); // START
  [1, 0, 0].forEach((bit, i) => {
    s.set(20 + i * 10, bit);
    b.set(22 + i * 10, 1);
    b.set(27 + i * 10, 0);
  }); // 3 clocks of data (1 0 0), then...
  b.set(60, 1);
  s.set(62, 1); // ...a STOP in the middle of the byte
  const d = L.i2cDecode(b, s);
  check(
    'I2C decoder: a STOP in the middle of a byte is reported as an error',
    d.errors.some((e) => /middle of a byte/.test(e.text)),
    JSON.stringify(d.errors),
  );
  const enc = L.i2cEncode([{ dir: 'W', addr: 0x48, bytes: [1], ack: true }]);
  const cut = { ...enc.sda, edges: enc.sda.edges.slice(0, -1) };
  check(
    'I2C decoder: a capture that ends before the STOP is reported',
    L.i2cDecode(enc.scl, cut).errors.some((e) => /ends inside a transaction/.test(e.text)),
  );
}
{
  // end to end: a register model answers, the bytes become a waveform, the decoder recovers the value
  const ctx = { window: {} };
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync('site/assets/devices-data.js', 'utf8'), ctx);
  const core = require('../assets/devicecore.js').core(ctx.window.DEVICES);
  const bus = I.createBus(core);
  bus.attach('tmp117', 0x48, { temp: 25 });
  bus.readReg16(0x48, 0x0f); // Device_ID
  bus.write(0x49, [0]); // nobody there
  const enc = L.i2cEncode(bus.events),
    dec = L.i2cDecode(enc.scl, enc.sda),
    ev = L.i2cToEvents(dec);
  check('end to end: the TMP117 model read of Device_ID shows up on the waveform as 0x0117', same(ev[1].bytes, [0x01, 0x17]) && ev[1].dir === 'R');
  check(
    'end to end: the pointer write 0x0F and the NACK from 0x49 are both on the waveform',
    same(ev[0].bytes, [0x0f]) && ev[2].ack === false && ev[2].addr === 0x49,
  );
}

// ---- UART ------------------------------------------------------------------------------------------------------------------------------
{
  const bt = 1e6 / 9600;
  const e = L.uartEncode([0x41], { baud: 9600, startUs: 0 });
  // 'A' = 0x41 = 0b01000001. Bits on the wire: start 0, then LSB first 1 0 0 0 0 0 1 0, then stop 1.
  // Line: starts high; falls at 0 (start); rises at 1 bit (data bit 0 = 1); falls at 2 (bit 1 = 0); rises at 7 (bit 6 = 1); falls at 8 (bit 7 = 0); rises at 9 (stop).
  check(
    'UART: "A" at 9600 8N1 has edges at 0, 1, 2, 7, 8 and 9 bit times (start 0, LSB first, stop 1)',
    e.ch.edges.length === 6 && e.ch.edges.every((t, i) => near(t, [0, 1, 2, 7, 8, 9][i] * bt, 1e-6)),
    JSON.stringify(e.ch.edges),
  );
  check('UART: a bit time at 9600 baud is 104.1667 us', near(bt, 104.1667, 1e-3));
  check(
    'UART parity: 0x41 has two 1 bits so even parity is 0 and odd parity is 1; 0x43 has three so even is 1',
    L.uartBits(0x41, { data: 8, parity: 'even', stop: 1 })[9] === 0 &&
      L.uartBits(0x41, { data: 8, parity: 'odd', stop: 1 })[9] === 1 &&
      L.uartBits(0x43, { data: 8, parity: 'even', stop: 1 })[9] === 1,
  );
  let ok = true,
    bad = '';
  for (const parity of ['none', 'even', 'odd'])
    for (const [data, stop] of [
      [8, 1],
      [7, 1],
      [8, 2],
    ]) {
      const bytes = Array.from({ length: 64 }, (_, i) => (i * 37 + 5) & ((1 << data) - 1)),
        o = { baud: 115200, data, parity, stop };
      const enc = L.uartEncode(bytes, { ...o, idleBits: 1 }),
        dec = L.uartDecode(enc.ch, o);
      if (
        !same(
          dec.frames.map((f) => f.value),
          bytes,
        ) ||
        dec.errors.length
      ) {
        ok = false;
        bad = JSON.stringify({ o, errs: dec.errors.slice(0, 2), n: dec.frames.length });
      }
    }
  check('UART: 64 bytes round-trip with no errors for none/even/odd parity and 7 or 8 data bits and 1 or 2 stop bits', ok, bad);
  const msg = Array.from('Hello, UART!', (c) => c.charCodeAt(0)),
    enc = L.uartEncode(msg, { baud: 9600 });
  check(
    'UART: ASCII text back-to-back (no idle bits between bytes) decodes to the same text',
    String.fromCharCode(...L.uartDecode(enc.ch, { baud: 9600 }).frames.map((f) => f.value)) === 'Hello, UART!',
  );
  const tol = (rx) => L.uartDecode(L.uartEncode(msg, { baud: 9600 }).ch, { baud: rx });
  check(
    'UART: a receiver clock 3 % fast or slow still decodes an 8N1 stream',
    same(
      tol(9600 * 1.03).frames.map((f) => f.value),
      msg,
    ) &&
      same(
        tol(9600 / 1.03).frames.map((f) => f.value),
        msg,
      ),
  );
  const wrong = tol(19200);
  check(
    'UART: a receiver set to the wrong baud rate (19200 for 9600) produces wrong bytes or framing errors',
    !same(
      wrong.frames.map((f) => f.value),
      msg,
    ) || wrong.errors.length > 0,
  );
  const brk = L.builder('RX', 1);
  brk.set(100, 0);
  brk.set(5000, 1);
  const bd = L.uartDecode(brk, { baud: 9600 });
  check('UART: a line held low (a break) decodes as 0x00 with a framing error', bd.frames[0].value === 0 && bd.frames[0].error === 'framing');
  const flip = L.uartEncode([0x41], { baud: 9600, parity: 'even', startUs: 0 }).ch;
  const pe = L.uartDecode(flip, { baud: 9600, parity: 'odd' });
  check('UART: a parity mismatch between sender (even) and receiver (odd) is reported', pe.frames[0].error === 'parity');
}

// ---- SPI -------------------------------------------------------------------------------------------------------------------------------
{
  const r = S.rng(5);
  let ok = true,
    bad = '';
  for (let mode = 0; mode < 4; mode++)
    for (let k = 0; k < 30; k++) {
      const n = 1 + Math.floor(r() * 6),
        mo = Array.from({ length: n }, () => Math.floor(r() * 256)),
        mi = Array.from({ length: n }, () => Math.floor(r() * 256));
      const enc = L.spiEncode(mo, mi, { mode, hz: 2000000 }),
        dec = L.spiDecode(enc, { mode });
      if (!same(dec.transfers[0].mosi, mo) || !same(dec.transfers[0].miso, mi) || dec.errors.length) {
        ok = false;
        bad = JSON.stringify({ mode, mo, mi, got: dec.transfers[0] });
      }
    }
  check('SPI: random MOSI and MISO bytes round-trip in all four modes (120 transfers)', ok, bad);
  check(
    'SPI: the clock idles low in modes 0 and 1 and high in modes 2 and 3 (CPOL)',
    [0, 1, 2, 3].every((m) => L.spiEncode([0x55], [0], { mode: m }).sck.init === m >> 1),
  );
  const wire = L.spiEncode([0xa5], [0], { mode: 0 });
  const wrong = L.spiDecode(wire, { mode: 1 });
  check(
    'SPI: decoding a mode 0 waveform as mode 1 (the wrong clock edge) gives the wrong byte',
    wrong.transfers[0].mosi[0] !== 0xa5,
    String(wrong.transfers[0].mosi[0]),
  );
  check('SPI: modes 0 and 3 both sample on the rising edge, so they decode the same data', same(L.spiDecode(wire, { mode: 3 }).transfers[0].mosi, [0xa5]));
  const two = L.spiEncode([0xde, 0xad], [0, 0], { mode: 0 });
  check('SPI: 16 clock pulses between CS low and CS high decode as two bytes in one transfer', L.spiDecode(two, { mode: 0 }).transfers[0].bits === 16);
  check(
    'SPI: CS is active low (it falls before the first clock and rises after the last)',
    two.cs.init === 1 && two.cs.edges[0] < two.sck.edges[0] && two.cs.edges[1] > two.sck.edges.at(-1),
  );
}
{
  const dev = L.genericSpiDevice();
  const wr = [0x02, 0x10, 0x5a],
    rd = [0x03, 0x10, 0x00];
  const w = L.spiDecode(L.spiEncode(wr, dev.transfer(wr), { mode: 0 }), { mode: 0 });
  const r = L.spiDecode(L.spiEncode(rd, dev.transfer(rd), { mode: 0 }), { mode: 0 });
  check(
    'generic SPI device (a teaching device, not a real part): write 0x5A to register 0x10, read it back on MISO',
    same(w.transfers[0].mosi, wr) && r.transfers[0].miso[2] === 0x5a,
    JSON.stringify(r.transfers[0].miso),
  );
}

// ---- PWM and GPIO ----------------------------------------------------------------------------------------------------------------------
{
  const p = L.pwmMeasure(L.pwmGenerate({ hz: 1000, duty: 0.25, periods: 20 }).ch);
  check(
    'PWM: 1 kHz at 25 % duty measures 1000 Hz and 25 % (1000 us period, 250 us high)',
    near(p.freqHz, 1000, 1e-6) && near(p.dutyPct, 25, 1e-6) && near(p.highUs, 250, 1e-6),
    JSON.stringify(p),
  );
  const q = L.pwmMeasure(L.pwmGenerate({ hz: 20000, duty: 0.8, periods: 50 }).ch);
  check('PWM: 20 kHz at 80 % measures back to 20000 Hz and 80 %', near(q.freqHz, 20000, 1e-4) && near(q.dutyPct, 80, 1e-6));
  check(
    'PWM: 0 % and 100 % duty have no edges, so no frequency can be measured (the line is steady)',
    L.pwmGenerate({ hz: 1000, duty: 0, periods: 5 }).ch.edges.length === 0 && L.pwmGenerate({ hz: 1000, duty: 1, periods: 5 }).ch.edges.length === 1,
  );
  const servo = (us) => L.servoAngle(L.pwmMeasure(L.pwmGenerate({ hz: 50, duty: us / 20000, periods: 5 }).ch).highUs);
  check(
    'servo convention: 1000 us = 0 degrees, 1500 us = 90, 2000 us = 180; out-of-range pulses clamp',
    near(servo(1000), 0, 1e-6) && near(servo(1500), 90, 1e-6) && near(servo(2000), 180, 1e-6) && L.servoAngle(2600) === 180 && L.servoAngle(300) === 0,
  );
  const a = L.buttonBounce({ pressUs: 1000, bounces: 4 }, S.rng(3)),
    b = L.buttonBounce({ pressUs: 1000, bounces: 4 }, S.rng(3)),
    c = L.buttonBounce({ pressUs: 1000, bounces: 4 }, S.rng(4));
  check(
    'GPIO: a button press with 4 bounces makes 1 + 2 x 4 = 9 edges, ends pressed (low) and is repeatable for a seed',
    a.ch.edges.length === 9 && L.levelAt(a.ch, 1e9) === 0 && same(a.ch.edges, b.ch.edges) && !same(a.ch.edges, c.ch.edges),
  );
}

// ---- builder and importer --------------------------------------------------------------------------------------------------------------------
{
  const ch = L.builder('X', 0);
  ch.set(10, 1).set(10, 1).set(20, 0);
  check(
    'channels: setting the level it already has adds no edge, and levelAt counts an edge at that exact instant',
    ch.edges.length === 2 && L.levelAt(ch, 9.99) === 0 && L.levelAt(ch, 10) === 1 && L.levelAt(ch, 20) === 0,
  );
  let threw = false;
  try {
    ch.set(5, 1);
  } catch {
    threw = true;
  }
  check('channels: an edge earlier than the previous one is rejected', threw);
}
{
  const enc = L.i2cEncode(
    [
      { dir: 'W', addr: 0x48, bytes: [0x12, 0x34], ack: true },
      { dir: 'R', addr: 0x48, bytes: [0xab], ack: true },
    ],
    { sclHz: 400000 },
  );
  const times = [...new Set([...enc.scl.edges, ...enc.sda.edges])].sort((x, y) => x - y);
  const rows = [
    'Time [s],SCL,SDA',
    `0,${enc.scl.init},${enc.sda.init}`,
    ...times.map((t) => `${(t / 1e6).toFixed(9)},${L.levelAt(enc.scl, t)},${L.levelAt(enc.sda, t)}`),
  ];
  const [scl, sda] = L.parseCsv(rows.join('\n'));
  const dec = L.i2cDecode(scl, sda);
  check(
    'CSV import: a logic-analyzer style export (time in seconds, one 0/1 column per channel) decodes back to the same transactions',
    same(L.i2cToEvents(dec), [
      { dir: 'W', addr: 0x48, bytes: [0x12, 0x34], ack: true },
      { dir: 'R', addr: 0x48, bytes: [0xab], ack: true },
    ]),
    JSON.stringify(L.i2cToEvents(dec)),
  );
  check('CSV import: the imported clock is measured as 400 kHz', near(dec.sclHz / 400000, 1, 0.01), String(dec.sclHz));
  const bad = (txt) => {
    try {
      L.parseCsv(txt);
      return false;
    } catch (e) {
      return String(e.message);
    }
  };
  check(
    'CSV import: rejects a missing channel, a non-numeric time, values other than 0/1, and time going backwards',
    bad('t\n0') && bad('t,a\nx,1\n') && bad('t,a\n0,2\n') && bad('t,a\n1,1\n0.5,0\n') && bad('only a header'),
  );
  check(
    'CSV import: enforces a row limit',
    /too many rows/.test(bad('t,a\n' + Array.from({ length: 30 }, (_, i) => `${i},${i % 2}`).join('\n')) || 'x') ||
      (() => {
        try {
          L.parseCsv('t,a\n0,1\n1,0\n2,1\n', 2);
          return false;
        } catch (e) {
          return /too many/.test(e.message);
        }
      })(),
  );
}

if (failed) {
  console.log(`\n${failed} check(s) FAILED`);
  process.exit(1);
}
console.log('\nall logic analyzer checks passed');
