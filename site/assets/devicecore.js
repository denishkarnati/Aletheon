/* Aletheon Device Lab core: a behavioral, register-level I2C simulator.
 * It models a handful of real parts from facts that were checked against the vendor datasheets (see site/tools/devices/*.json and
 * site/tools/verify-devices.mjs). It is NOT a circuit or silicon-accurate simulation: timing, noise and analog errors are not modeled,
 * and every model lists what it leaves out. Your code runs against it in a Worker with a time limit and no network access.
 *
 * __aletheonDevCore is one self-contained function so the browser can ship its source into a Worker (Function.prototype.toString);
 * it must not reference anything outside itself. */
function __aletheonDevCore(DATA) {
  'use strict';
  const hex = (n, w) => '0x' + (Number(n) >>> 0).toString(16).toUpperCase().padStart(w === undefined ? 2 : w, '0');
  const hex16 = (n) => hex(n & 0xffff, 4);
  const toInt16 = (v) => (v & 0x8000 ? (v & 0xffff) - 0x10000 : v & 0xffff);
  const u16 = (v) => v & 0xffff;
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
  const parseHex = (s) => parseInt(s, 16);

  // ---- shared pointer-register protocol (all four parts: pointer byte, then big-endian 16-bit data) --------------------------
  function baseDevice(model, addr, inputs) {
    const byAddr = new Map(model.registers.map((r) => [parseHex(r.addr), r]));
    const dev = {
      id: model.id, part: model.part, addr, model, inputs: { ...inputs }, ptr: 0, now: 0, stored: new Map(),
      reg(a) { return byAddr.get(a); },
      resetStored() { dev.stored = new Map(model.registers.map((r) => [parseHex(r.addr), parseHex(r.reset)])); },
      // Subclasses provide: readReg(a) -> number | undefined, writeReg(a, v) -> note | undefined, advance(ms), onReset().
      write(bytes) {
        const notes = [], warns = [];
        if (bytes.length === 0) return { notes, warns };
        dev.ptr = bytes[0] & 0xff;
        const r = byAddr.get(dev.ptr);
        const label = r ? `${r.name} (${hex(dev.ptr)})` : hex(dev.ptr);
        if (bytes.length === 1) {
          notes.push(`pointer -> ${label}`);
        } else if (bytes.length === 3) {
          const v = ((bytes[1] & 0xff) << 8) | (bytes[2] & 0xff);
          if (!r) warns.push(`${hex(dev.ptr)} is not a register in this model; the write was ignored`);
          else if (r.access === 'R') warns.push(`${r.name} (${hex(dev.ptr)}) is read-only; the write was ignored`);
          else {
            const n = dev.writeReg(dev.ptr, v);
            notes.push(`${r.name} = ${hex16(v)}${n ? ' (' + n + ')' : ''}`);
          }
        } else {
          warns.push(`a write is a pointer byte (1 byte) or pointer + 16-bit value (3 bytes); got ${bytes.length}. Not modeled, ignored`);
        }
        return { notes, warns };
      },
      read(n) {
        const notes = [], warns = [];
        const r = byAddr.get(dev.ptr);
        let v = 0;
        if (!r) warns.push(`pointer ${hex(dev.ptr)} is not a register in this model; read 0x0000`);
        else v = u16(dev.readReg(dev.ptr));
        if (n > 2) warns.push(`reading ${n} bytes: behavior past the first 16-bit register is not modeled; the extra bytes read 0x00`);
        const bytes = [];
        for (let i = 0; i < n; i++) bytes.push(i === 0 ? v >> 8 : i === 1 ? v & 0xff : 0);
        if (r) notes.push(`${r.name} (${hex(dev.ptr)}) -> ${hex16(v)}`);
        return { bytes, notes, warns };
      },
      setInput(k, v) { if (!(k in dev.inputs)) throw new Error(`no physical input "${k}" on ${model.part} (inputs: ${Object.keys(dev.inputs).join(', ')})`); dev.inputs[k] = Number(v); },
      snapshot() { return model.registers.map((r) => { const a = parseHex(r.addr); return { addr: r.addr, name: r.name, access: r.access, value: hex16(u16(dev.readReg(a, true))) }; }); },
      advance() {},
    };
    dev.resetStored();
    return dev;
  }

  // ---- TMP117 ----------------------------------------------------------------------------------------------------------------
  function makeTMP117(model, addr, inputs) {
    const dev = baseDevice(model, addr, inputs);
    const AVG_N = [1, 8, 32, 64];
    let result, dataReady, hiAlert, loAlert, convStart, convDone;
    const cfgOf = () => dev.stored.get(1);
    const timing = () => {
      const cfg = cfgOf(), conv = (cfg >> 7) & 7, avg = (cfg >> 5) & 3;
      const cycle = model.cycleTable.ms[conv][avg];
      return { cycle, active: Math.min(cycle, AVG_N[avg] * 15.5) };
    };
    const restart = () => { const t = timing(); convStart = dev.now; convDone = convStart + t.active; };
    dev.onReset = () => {
      dev.resetStored(); result = 0x8000; dataReady = false; hiAlert = false; loAlert = false; restart();
    };
    dev.onReset();
    dev.advance = (ms) => {
      const end = dev.now + ms;
      for (;;) {
        if (convDone > end) break;
        const code = clamp(Math.round(dev.inputs.temp / 0.0078125), -32768, 32767);
        result = u16(code);
        dataReady = true;
        if (code > toInt16(dev.stored.get(2))) hiAlert = true;
        if (code < toInt16(dev.stored.get(3))) loAlert = true;
        const t = timing();
        convStart += t.cycle; convDone = convStart + t.active;
      }
      dev.now = end;
    };
    dev.readReg = (a, peek) => {
      if (a === 0x00) { const v = result; if (!peek) dataReady = false; return v; }
      if (a === 0x01) {
        const v = (hiAlert ? 0x8000 : 0) | (loAlert ? 0x4000 : 0) | (dataReady ? 0x2000 : 0) | (cfgOf() & 0x0ffc);
        if (!peek) { hiAlert = false; loAlert = false; dataReady = false; }
        return v;
      }
      return dev.stored.get(a);
    };
    dev.writeReg = (a, v) => {
      if (a === 0x01) {
        if (v & 0x0002) { dev.onReset(); return 'soft reset'; }
        dev.stored.set(1, v & 0x0ffc);
        restart();
        const t = timing();
        return `CONV=${(v >> 7) & 7} AVG=${(v >> 5) & 3}, cycle ${t.cycle} ms`;
      }
      dev.stored.set(a, v);
      return undefined;
    };
    return dev;
  }

  // ---- INA219 ----------------------------------------------------------------------------------------------------------------
  function makeINA219(model, addr, inputs) {
    const dev = baseDevice(model, addr, inputs);
    const parts = () => {
      const cfg = dev.stored.get(0), cal = dev.stored.get(5);
      const pgaMv = model.pga[(cfg >> 11) & 3];
      const vshunt = dev.inputs.iload * dev.inputs.rshunt;
      const shunt = clamp(Math.round(vshunt / 10e-6), -pgaMv * 100, pgaMv * 100);
      const fsr = (cfg >> 13) & 1 ? 32 : 16;
      const bus = clamp(Math.round(dev.inputs.vbus / 0.004), 0, fsr / 0.004);
      const current = clamp(Math.trunc((shunt * (cal & 0xfffe)) / 4096), -32768, 32767);
      const power = clamp(Math.trunc((current * bus) / 5000), 0, 65535);
      return { shunt, bus, current, power };
    };
    dev.onReset = () => dev.resetStored();
    dev.readReg = (a) => {
      if (a === 1) return u16(parts().shunt);
      if (a === 2) return parts().bus << 3;
      if (a === 3) return parts().power;
      if (a === 4) return u16(parts().current);
      return dev.stored.get(a);
    };
    dev.writeReg = (a, v) => {
      if (a === 0) {
        if (v & 0x8000) { dev.onReset(); return 'reset'; }
        dev.stored.set(0, v & 0x3fff);
        return `BRNG=${(v >> 13) & 1} PG=${(v >> 11) & 3}`;
      }
      dev.stored.set(a, v);
      return undefined;
    };
    return dev;
  }

  // ---- INA226 ----------------------------------------------------------------------------------------------------------------
  function makeINA226(model, addr, inputs) {
    const dev = baseDevice(model, addr, inputs);
    const parts = () => {
      const cal = dev.stored.get(5);
      const vshunt = dev.inputs.iload * dev.inputs.rshunt;
      const shunt = clamp(Math.round(vshunt / 2.5e-6), -32768, 32767);
      const bus = clamp(Math.round(dev.inputs.vbus / 1.25e-3), 0, 32767);
      const current = clamp(Math.trunc((shunt * cal) / 2048), -32768, 32767);
      const power = clamp(Math.trunc((Math.abs(current) * bus) / 20000), 0, 65535);
      return { shunt, bus, current, power };
    };
    dev.onReset = () => dev.resetStored();
    dev.readReg = (a) => {
      if (a === 1) return u16(parts().shunt);
      if (a === 2) return parts().bus;
      if (a === 3) return parts().power;
      if (a === 4) return u16(parts().current);
      return dev.stored.get(a);
    };
    dev.writeReg = (a, v) => { dev.stored.set(a, v); return undefined; };
    return dev;
  }

  // ---- ADS1115 ---------------------------------------------------------------------------------------------------------------
  function makeADS1115(model, addr, inputs) {
    const dev = baseDevice(model, addr, inputs);
    let conv, converting, doneAt, continuous;
    const cfgOf = () => dev.stored.get(1);
    const period = () => 1000 / model.sps[(cfgOf() >> 5) & 7];
    const sample = () => {
      const cfg = cfgOf(), [p, n] = model.mux[(cfg >> 12) & 7], pga = (cfg >> 9) & 7;
      const ain = (i) => dev.inputs['ain' + i];
      const v = ain(p) - (n < 0 ? 0 : ain(n));
      return u16(clamp(Math.round(v / (model.lsbUv[pga] * 1e-6)), -32768, 32767));
    };
    dev.onReset = () => { dev.resetStored(); conv = 0; converting = false; continuous = false; doneAt = Infinity; };
    dev.onReset();
    dev.advance = (ms) => {
      const end = dev.now + ms;
      while (converting && doneAt <= end) {
        conv = sample();
        if (continuous) doneAt += period(); else { converting = false; doneAt = Infinity; }
      }
      dev.now = end;
    };
    dev.readReg = (a) => {
      if (a === 0) return conv;
      if (a === 1) return (cfgOf() & 0x7fff) | (converting && !continuous ? 0 : 0x8000);
      return dev.stored.get(a);
    };
    dev.writeReg = (a, v) => {
      if (a === 1) {
        dev.stored.set(1, v & 0x7fff);
        const single = (v >> 8) & 1;
        if (!single) {
          continuous = true; converting = true; doneAt = dev.now + period();
          return `continuous, ${model.sps[(v >> 5) & 7]} SPS`;
        }
        continuous = false;
        if (v & 0x8000 && !converting) { converting = true; doneAt = dev.now + period(); return `single conversion started, ${model.sps[(v >> 5) & 7]} SPS`; }
        if (!(v & 0x8000)) { converting = false; doneAt = Infinity; }
        return undefined;
      }
      dev.stored.set(a, v);
      return undefined;
    };
    return dev;
  }

  const FACTORY = { tmp117: makeTMP117, ina219: makeINA219, ina226: makeINA226, ads1115: makeADS1115 };
  const defaultInputs = (model) => Object.fromEntries(model.inputs.map((i) => [i.id, i.default]));
  function makeDevice(id, addr, inputs) {
    const model = DATA.devices.find((d) => d.id === id);
    if (!model) throw new Error(`unknown device "${id}"`);
    return FACTORY[id](model, addr, { ...defaultInputs(model), ...(inputs || {}) });
  }

  // ---- the bus and the user-code runner -------------------------------------------------------------------------------------
  const LIMITS = { transactions: 20000, simMs: 600000, logLines: 500 };

  function run(req) {
    const model = DATA.devices.find((d) => d.id === req.device);
    if (!model) return { ok: false, error: `unknown device "${req.device}"`, logs: [], bus: [], regs: [] };
    const addr = req.addr !== undefined ? req.addr : parseHex(model.addresses[0].addr);
    const dev = makeDevice(req.device, addr, req.inputs);
    const state = { now: 0, bus: [], logs: [], tx: 0 };
    const logBus = (e) => { if (state.bus.length < 2000) state.bus.push({ t: Math.round(state.now * 1000) / 1000, ...e }); };
    const tick = () => { if (++state.tx > LIMITS.transactions) throw new Error(`stopped: more than ${LIMITS.transactions} bus transactions (is there an endless loop?)`); };
    const nack = (a) => new Error(`NACK: no device answered at ${hex(a)}. On this bus: ${hex(dev.addr)} (${dev.part})`);

    const i2c = {
      write(a, bytes) {
        tick(); a &= 0x7f; bytes = Array.from(bytes, (b) => b & 0xff);
        if (a !== dev.addr) { logBus({ dir: 'W', addr: a, bytes, ack: false, note: 'no device answered' }); throw nack(a); }
        const r = dev.write(bytes);
        logBus({ dir: 'W', addr: a, bytes, ack: true, note: r.notes.join('; '), warn: r.warns });
        return true;
      },
      read(a, n) {
        tick(); a &= 0x7f; n = n | 0;
        if (a !== dev.addr) { logBus({ dir: 'R', addr: a, bytes: [], ack: false, note: 'no device answered' }); throw nack(a); }
        const r = dev.read(n);
        logBus({ dir: 'R', addr: a, bytes: r.bytes, ack: true, note: r.notes.join('; '), warn: r.warns });
        return r.bytes;
      },
      readReg16(a, reg) { i2c.write(a, [reg]); const b = i2c.read(a, 2); return (b[0] << 8) | b[1]; },
      writeReg16(a, reg, v) { return i2c.write(a, [reg, (v >> 8) & 0xff, v & 0xff]); },
      scan() { logBus({ dir: 'S', addr: 0, bytes: [], ack: true, note: `scan found ${hex(dev.addr)}` }); return [dev.addr]; },
    };
    const delay = (ms) => {
      ms = Number(ms);
      if (!(ms >= 0)) throw new Error('delay(ms) needs a non-negative number');
      if (state.now + ms > LIMITS.simMs) throw new Error(`stopped: simulated time would pass ${LIMITS.simMs / 1000} s`);
      state.now += ms; dev.advance(ms);
    };
    const log = (...a) => {
      if (state.logs.length >= LIMITS.logLines) return;
      state.logs.push({ t: Math.round(state.now * 1000) / 1000, text: a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ') });
    };
    const sim = { set(k, v) { dev.setInput(k, v); logBus({ dir: 'I', addr: 0, bytes: [], ack: true, note: `physical input ${k} = ${v}` }); }, get: (k) => dev.inputs[k] };

    let error = null;
    try {
      // eslint-disable-next-line no-new-func
      const fn = new Function('i2c', 'delay', 'log', 'hex', 'toInt16', 'sim', `"use strict";\n${req.code}`);
      fn(i2c, delay, log, hex16, toInt16, sim);
    } catch (e) {
      error = String(e && e.message ? e.message : e);
    }
    return { ok: !error, error, logs: state.logs, bus: state.bus, regs: dev.snapshot(), simMs: state.now, transactions: state.tx, inputs: dev.inputs, addr: dev.addr };
  }

  return { version: 1, run, makeDevice, hex16, toInt16, defaultInputs };
}

if (typeof module !== 'undefined' && module.exports) module.exports = { core: __aletheonDevCore };
