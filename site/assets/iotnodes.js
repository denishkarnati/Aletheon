/* Aletheon IoT Bench model: virtual sensor nodes that read REAL register-level part models (devicecore.js: TMP117, INA219, INA226, ADS1115)
 * over a virtual I2C bus, spend energy from a battery, and publish to the MQTT-style broker in simcore.js.
 *
 * Honest scope. The sensor parts are the datasheet-checked models from the Device Lab. Everything around them is a behavioral model you can
 * change: the node's current draw, the battery curve, the radio link and the physical "world" signals are ASSUMPTIONS, not measurements of any
 * product. Timing on the bus is by conversion time, not by SCL clock edges (the Analyzer lays out the waveform). No noise or analog error. */
(function (root) {
  'use strict';
  const S = typeof module !== 'undefined' && module.exports && typeof require === 'function' ? require('./simcore.js') : root.AletheonSim;
  const HOUR = 3600000, DAY = 86400000;
  const toInt16 = (v) => (v & 0x8000 ? (v & 0xffff) - 0x10000 : v & 0xffff);
  const hex = (n, w) => '0x' + (n >>> 0).toString(16).toUpperCase().padStart(w || 2, '0');

  // ---- the I2C bus ---------------------------------------------------------------------------------------------------------------
  // Holds the modeled parts, forwards transactions to them, logs every transaction in the same shape the Device Lab uses, and lets a fault
  // unplug a part (NACK) or reset it (registers back to power-on values).
  function createBus(core, logMax) {
    const slots = new Map();
    const events = [];
    const bus = {
      t: 0, events,
      attach(part, addr, inputs) {
        slots.set(addr, { part, inputs: { ...inputs }, dev: core.makeDevice(part, addr, inputs), connected: true });
        return slots.get(addr).dev;
      },
      slot: (addr) => slots.get(addr),
      setInputs(addr, inputs) { const s = slots.get(addr); if (s) for (const k of Object.keys(inputs)) if (k in s.dev.inputs) s.dev.inputs[k] = inputs[k]; },
      setConnected(addr, v) { const s = slots.get(addr); if (s) s.connected = !!v; },
      resetPart(addr) { const s = slots.get(addr); if (s) { const keep = { ...s.dev.inputs }; s.dev = core.makeDevice(s.part, addr, keep); s.dev.advance(0); } },
      powerCycle() { for (const [a, s] of slots) { const keep = { ...s.dev.inputs }; s.dev = core.makeDevice(s.part, a, keep); } },
      // Parts keep converting while the MCU sleeps; this brings every part's own clock up to the bus time.
      syncTo(t) { const dt = t - bus.t; if (dt > 0) for (const s of slots.values()) s.dev.advance(dt); bus.t = Math.max(bus.t, t); },
      delay(ms) { for (const s of slots.values()) s.dev.advance(ms); bus.t += ms; },
      log(e) { events.push({ t: Math.round(bus.t * 1000) / 1000, ...e }); if (events.length > (logMax || 3000)) events.shift(); },
      write(addr, bytes) {
        const s = slots.get(addr);
        if (!s || !s.connected) { bus.log({ dir: 'W', addr, bytes, ack: false, note: 'no device answered' }); return { ack: false }; }
        const r = s.dev.write(bytes);
        bus.log({ dir: 'W', addr, bytes, ack: true, note: r.notes.join('; '), warn: r.warns });
        return { ack: true };
      },
      read(addr, n) {
        const s = slots.get(addr);
        if (!s || !s.connected) { bus.log({ dir: 'R', addr, bytes: [], ack: false, note: 'no device answered' }); return { ack: false, bytes: [] }; }
        const r = s.dev.read(n);
        bus.log({ dir: 'R', addr, bytes: r.bytes, ack: true, note: r.notes.join('; '), warn: r.warns });
        return { ack: true, bytes: r.bytes };
      },
      readReg16(addr, reg) {
        const w = bus.write(addr, [reg]);
        if (!w.ack) return { ack: false, v: 0 };
        const r = bus.read(addr, 2);
        return r.ack ? { ack: true, v: (r.bytes[0] << 8) | r.bytes[1] } : { ack: false, v: 0 };
      },
      writeReg16(addr, reg, v) { return bus.write(addr, [reg, (v >> 8) & 0xff, v & 0xff]); },
    };
    return bus;
  }

  // ---- sensor drivers (what the node's firmware does with each part) ------------------------------------------------------------------
  // Every conversion below is the same arithmetic the datasheet gives and the Device Lab samples use. A driver returns
  // { ok, fields: {name: {v, unit}} } or { ok: false, error }.
  const nack = (part, addr) => ({ ok: false, error: `${part}: no ACK from ${hex(addr)}` });
  const DRIVERS = {
    tmp117: {
      init() {},
      read(bus, a, cfg, fw) {
        if (fw.waitReady) { // poll Data_Ready (Configuration bit 13) up to 500 ms
          let ready = false;
          for (let i = 0; i < 50 && !ready; i++) {
            const c = bus.readReg16(a, 0x01);
            if (!c.ack) return nack('TMP117', a);
            if (c.v & 0x2000) ready = true; else bus.delay(10);
          }
        }
        const r = bus.readReg16(a, 0x00);
        if (!r.ack) return nack('TMP117', a);
        if (fw.validate && r.v === 0x8000) return { ok: false, error: 'TMP117: result 0x8000 (-256 C): no conversion has finished since reset' };
        return { ok: true, fields: { temperature_c: { v: toInt16(r.v) * 0.0078125, unit: 'C' } } };
      },
    },
    ina219: {
      init(bus, a, cfg) { const lsb = cfg.currentLsb || 0.0001; return bus.writeReg16(a, 0x05, Math.trunc(0.04096 / (lsb * cfg.rshunt))); },
      read(bus, a, cfg) {
        const lsb = cfg.currentLsb || 0.0001;
        const sh = bus.readReg16(a, 0x01), bv = bus.readReg16(a, 0x02), cu = bus.readReg16(a, 0x04), pw = bus.readReg16(a, 0x03);
        if (!(sh.ack && bv.ack && cu.ack && pw.ack)) return nack('INA219', a);
        return { ok: true, fields: { bus_v: { v: (bv.v >> 3) * 0.004, unit: 'V' }, current_a: { v: toInt16(cu.v) * lsb, unit: 'A' }, power_w: { v: pw.v * 20 * lsb, unit: 'W' } } };
      },
    },
    ina226: {
      init(bus, a, cfg) { const lsb = cfg.currentLsb || 0.001; return bus.writeReg16(a, 0x05, Math.trunc(0.00512 / (lsb * cfg.rshunt))); },
      read(bus, a, cfg) {
        const lsb = cfg.currentLsb || 0.001;
        const bv = bus.readReg16(a, 0x02), cu = bus.readReg16(a, 0x04), pw = bus.readReg16(a, 0x03);
        if (!(bv.ack && cu.ack && pw.ack)) return nack('INA226', a);
        return { ok: true, fields: { bus_v: { v: bv.v * 1.25e-3, unit: 'V' }, current_a: { v: toInt16(cu.v) * lsb, unit: 'A' }, power_w: { v: pw.v * 25 * lsb, unit: 'W' } } };
      },
    },
    ads1115: {
      init() {},
      read(bus, a, cfg) {
        const pga = cfg.pga === undefined ? 1 : cfg.pga, lsbV = [187.5, 125, 62.5, 31.25, 15.625, 7.8125][pga] * 1e-6, fields = {};
        for (const ch of cfg.channels || [0]) { // one single-shot conversion per channel, 128 SPS
          const word = (1 << 15) | ((4 + ch) << 12) | (pga << 9) | (1 << 8) | (4 << 5) | 3;
          if (!bus.writeReg16(a, 0x01, word).ack) return nack('ADS1115', a);
          let done = false;
          for (let i = 0; i < 20 && !done; i++) { bus.delay(2); const c = bus.readReg16(a, 0x01); if (!c.ack) return nack('ADS1115', a); done = !!(c.v & 0x8000); }
          const r = bus.readReg16(a, 0x00);
          if (!r.ack) return nack('ADS1115', a);
          fields[`ain${ch}_v`] = { v: toInt16(r.v) * lsbV, unit: 'V' };
        }
        return { ok: true, fields };
      },
    },
  };

  // ---- the world: physical signals the sensors see --------------------------------------------------------------------------------------
  // Plain functions of simulated time, so a run is repeatable. A "start hour" lets a run begin at any time of day.
  const WORLDS = {
    weather: (t, p) => {
      const hour = (p.startHour + t / HOUR) % 24;
      return { temp: p.base + p.amp * Math.sin((2 * Math.PI * (hour - 9)) / 24), soil: 2.4 - 1.2 * ((t % (2 * DAY)) / (2 * DAY)) };
    },
    pump: (t) => { // a 12 V pump: 1 minute at 2.5 A every 15 minutes, 0.4 A otherwise
      const on = t % (15 * 60000) < 60000, i = on ? 2.5 : 0.4;
      return { vbus: 12 - 0.1 * i, iload: i };
    },
    battery: (t) => ({ vbus: 3.7, iload: 0.05 + 0.02 * Math.sin(t / 60000) }),
  };

  // ---- one node ------------------------------------------------------------------------------------------------------------------------
  function createNode(env, cfg) {
    const { clock, broker, core } = env;
    const id = cfg.id, site = cfg.site || 'site';
    const fw = { waitReady: true, validate: true, reinitEveryWake: false, mcuMs: 4, bootMs: 25, ...(cfg.firmware || {}) };
    const en = { sleepUa: 8, activeMa: 6, txMa: 110, txMs: 60, energyScale: 1, ...(cfg.energy || {}) };
    const bat = { capacityMah: 2000, vFull: 4.2, vEmpty: 3.0, cutoffV: 3.0, brownoutV: 2.7, internalOhm: 0.5, ...(cfg.battery || {}) };
    const bus = createBus(core);
    const state = {
      id, status: 'boot', cycles: 0, published: 0, errors: 0, brownouts: 0, boots: 0, usedNc: 0, lastAwakeMs: 0, msgsPerCycle: 0,
      lastErrors: [], truth: [], faults: { drift: null }, pendingReset: new Set(), bornAt: clock.now, lastSettle: clock.now, busySince: 0,
    };
    let mqtt = null, timer = null, gen = 0; // gen invalidates events scheduled before a reboot or death
    const topic = (leaf) => `${site}/${id}/${leaf}`;
    const sensors = cfg.sensors.map((s) => ({ ...s, key: s.key || s.part }));
    for (const s of sensors) bus.attach(s.part, s.addr, s.fixed || {});

    // -- battery and energy --
    // Charge is kept in uA*ms = nanocoulombs. 1 mAh = 3.6 C = 3.6e9 nC.
    const remainingFraction = () => Math.max(0, 1 - state.usedNc / (bat.capacityMah * 3.6e9));
    const voc = () => bat.vEmpty + (bat.vFull - bat.vEmpty) * remainingFraction(); // linear curve: a simplification
    const consume = (ua, ms) => { state.usedNc += ua * ms * en.energyScale; };
    const settleSleep = () => { // charge the sleep current for the time not already billed as awake or transmitting
      const dt = clock.now - state.lastSettle - state.busySince;
      if (dt > 0) consume(en.sleepUa, dt);
      state.lastSettle = clock.now; state.busySince = 0;
    };
    const busy = (ua, ms) => { consume(ua, ms); state.busySince += ms; };

    const publish = (leaf, obj, o) => {
      const sag = voc() - (en.txMa / 1000) * bat.internalOhm; // the cell's own resistance drops its voltage while the radio draws current
      if (sag < bat.brownoutV) { brownout(`supply sagged to ${sag.toFixed(2)} V while transmitting`); return false; }
      return mqtt.publish(topic(leaf), typeof obj === 'string' ? obj : JSON.stringify(obj), o);
    };

    function die(why) {
      gen++; clock.cancel(timer);
      if (mqtt) mqtt.kill();
      state.status = 'dead'; state.reason = why;
    }
    function brownout(why, downMs) {
      if (state.status === 'dead') return;
      state.brownouts++; gen++; clock.cancel(timer);
      if (mqtt) mqtt.kill();
      state.status = 'down'; state.reason = 'brown-out: ' + why;
      bus.powerCycle();
      clock.after(downMs === undefined ? 5000 : downMs, () => { if (state.status === 'down') boot(); });
    }

    function applyWorld(t) {
      const w = WORLDS[cfg.world.kind](t, cfg.world);
      const sig = { ...w };
      const d = state.faults.drift;
      if (d) sig[d.signal || 'temp'] = (sig[d.signal || 'temp'] || 0) + d.perHour * ((t - d.start) / HOUR);
      return { truth: w, seen: sig };
    }

    function initSensors() { // power-on: write each part's calibration (the INA parts read 0 A until this is done)
      const t0 = bus.t, errors = [];
      for (const s of sensors) { const ini = DRIVERS[s.part].init(bus, s.addr, s); if (ini && !ini.ack) errors.push(`${s.part}: no ACK from ${hex(s.addr)}`); }
      return { errors, busMs: bus.t - t0 };
    }
    function runSensors() {
      const t0 = bus.t, results = [], errors = [];
      for (const s of sensors) {
        if (fw.reinitEveryWake) { const ini = DRIVERS[s.part].init(bus, s.addr, s); if (ini && !ini.ack) { errors.push(`${s.part}: no ACK from ${hex(s.addr)}`); results.push({ s, res: { ok: false } }); continue; } }
        const res = DRIVERS[s.part].read(bus, s.addr, s, fw);
        if (!res.ok) errors.push(res.error);
        results.push({ s, res });
      }
      return { results, errors, busMs: bus.t - t0 };
    }

    // While the MCU sleeps the parts keep converting, so the physical world must keep moving under them (in steps of about a second).
    function setSensorInputs(t) {
      const { seen } = applyWorld(t);
      for (const s of sensors) { const inp = {}; for (const [dev, sig] of Object.entries(s.map || {})) if (sig in seen) inp[dev] = seen[sig]; bus.setInputs(s.addr, inp); }
    }
    function syncWorld(t) {
      const dt = t - bus.t;
      if (dt <= 0) return;
      const step = Math.max(1000, dt / 2000);
      while (bus.t < t - 1e-9) { const next = Math.min(t, bus.t + step); setSensorInputs(next); bus.syncTo(next); }
    }

    function wake() {
      if (state.status !== 'running') return;
      const myGen = gen, t0 = clock.now;
      settleSleep();
      if (voc() <= bat.cutoffV) return die('battery empty');
      syncWorld(t0);
      for (const a of state.pendingReset) bus.resetPart(a); // a supply glitch hit the part just before this read
      state.pendingReset.clear();
      const { truth } = applyWorld(t0);
      setSensorInputs(t0);
      const { results, errors, busMs } = runSensors();
      const awake = fw.mcuMs + busMs;
      state.lastAwakeMs = awake; state.lastErrors = errors;
      state.truth.push({ t: t0, ...truth }); if (state.truth.length > 600) state.truth.shift();
      clock.after(awake, () => { // the radio goes on once the readings are in hand
        if (myGen !== gen) return;
        busy(en.activeMa * 1000, awake);
        state.cycles++;
        let msgs = 0;
        for (const { s, res } of results) {
          if (!res.ok) { state.errors++; continue; }
          const body = { t: Math.round(clock.now), seq: state.cycles };
          for (const [k, f] of Object.entries(res.fields)) body[k] = Math.round(f.v * 1e6) / 1e6;
          if (publish(s.key, body, { qos: cfg.qos === 1 ? 1 : 0 }) === false) return;
          msgs++; state.published++;
        }
        if (publish('diag', { t: Math.round(clock.now), seq: state.cycles, battery_v: Math.round(voc() * 1000) / 1000, awake_ms: Math.round(awake * 10) / 10, errors: errors.length ? errors : undefined, brownouts: state.brownouts }, { qos: 0 }) === false) return;
        msgs++; state.msgsPerCycle = msgs;
      });
      timer = clock.at(t0 + cfg.periodS * 1000, wake);
    }

    function boot() {
      const myGen = ++gen;
      state.status = 'boot'; state.boots++; state.reason = null;
      state.lastSettle = clock.now; state.busySince = 0; // while the node was off it drew nothing
      mqtt = broker.connect(id, {
        keepAliveS: cfg.keepAliveS === undefined ? 120 : cfg.keepAliveS, link: { ...(cfg.link || {}) }, retryMs: cfg.retryMs, maxRetries: cfg.maxRetries,
        will: { topic: topic('status'), payload: 'offline', qos: 1, retain: true },
        onTx: () => { busy(en.txMa * 1000, en.txMs); },
      });
      bus.powerCycle(); bus.t = clock.now;
      const { errors, busMs } = initSensors();
      state.lastErrors = errors;
      const bootMs = fw.bootMs + busMs;
      busy(en.activeMa * 1000, bootMs);
      clock.after(bootMs, () => {
        if (myGen !== gen) return;
        state.status = 'running';
        publish('status', 'online', { qos: 1, retain: true });
        wake();
      });
    }

    const node = {
      id, cfg, state, bus, params: { fw, en, bat }, // the live objects: editing them changes the running node
      get running() { return state.status === 'running'; },
      get voltage() { return voc(); },
      get remainingFraction() { return remainingFraction(); },
      get usedMah() { return state.usedNc / 3.6e9; },
      get avgUa() { const dt = clock.now - state.bornAt; return dt > 0 ? state.usedNc / dt : 0; }, // nC / ms = uA
      get totalNc() { return state.usedNc; },
      start() { boot(); },
      inject(f) {
        const now = clock.now;
        if (f.kind === 'drift') state.faults.drift = { perHour: f.perHour, signal: f.signal || 'temp', start: now };
        else if (f.kind === 'clearDrift') state.faults.drift = null;
        else if (f.kind === 'unplug') bus.setConnected(f.addr, false);
        else if (f.kind === 'replug') bus.setConnected(f.addr, true);
        else if (f.kind === 'sensorReset') state.pendingReset.add(f.addr); // takes effect right before the next read
        else if (f.kind === 'brownout') brownout('injected supply dip', f.ms);
        else if (f.kind === 'link') mqtt && mqtt.setLink(f.patch);
        else throw new Error(`unknown fault "${f.kind}"`);
      },
      get mqtt() { return mqtt; },
    };
    return node;
  }

  // ---- a fleet: nodes + broker on one clock ----------------------------------------------------------------------------------------------
  function createFleet(o) {
    const clock = S.createClock(), rand = S.rng(o.seed === undefined ? 1 : o.seed);
    const broker = S.createBroker({ clock, rng: rand, logMax: o.logMax });
    const env = { clock, broker, core: o.core, rand };
    const nodes = new Map();
    return {
      clock, broker, nodes,
      addNode(cfg) {
        if (nodes.has(cfg.id)) throw new Error(`node "${cfg.id}" exists`);
        const n = createNode(env, JSON.parse(JSON.stringify(cfg)));
        nodes.set(cfg.id, n);
        return n;
      },
      startAll() { for (const n of nodes.values()) if (n.state.status === 'boot' && !n.mqtt) n.start(); },
      run(untilMs) { clock.run(untilMs); },
      step(dtMs) { clock.run(clock.now + dtMs); },
    };
  }

  // ---- presets ---------------------------------------------------------------------------------------------------------------------
  // Every number below is an illustrative assumption you can edit. None is a measurement of a real module or cell.
  const BATTERIES = {
    aa2: { label: '2 x AA alkaline (typical)', capacityMah: 2500, vFull: 3.0, vEmpty: 2.0, cutoffV: 2.0, brownoutV: 1.8, internalOhm: 0.3 },
    li18650: { label: 'Li-ion 18650 (typical)', capacityMah: 2000, vFull: 4.2, vEmpty: 3.0, cutoffV: 3.0, brownoutV: 2.7, internalOhm: 0.1 },
    cr2032: { label: 'CR2032 coin cell (typical)', capacityMah: 225, vFull: 3.0, vEmpty: 2.0, cutoffV: 2.0, brownoutV: 1.8, internalOhm: 20 },
  };
  const RADIOS = {
    wifi: { label: 'Wi-Fi class: short, strong bursts', txMa: 120, txMs: 60 },
    ble: { label: 'BLE class: short, gentle bursts', txMa: 15, txMs: 20 },
    lora: { label: 'LoRa class: long, medium bursts', txMa: 45, txMs: 400 },
  };
  const PRESETS = {
    greenhouse: {
      id: 'greenhouse', site: 'farm', periodS: 60, qos: 1, keepAliveS: 120,
      sensors: [
        { part: 'tmp117', addr: 0x48, key: 'air', map: { temp: 'temp' } },
        { part: 'ads1115', addr: 0x49, key: 'soil', channels: [0], pga: 1, map: { ain0: 'soil' } },
      ],
      world: { kind: 'weather', base: 22, amp: 6, startHour: 6 },
      energy: { sleepUa: 8, activeMa: 6, ...RADIOS.wifi }, battery: BATTERIES.li18650, link: { latencyMs: 40, loss: 0 },
    },
    pump: {
      id: 'pump', site: 'farm', periodS: 30, qos: 1, keepAliveS: 120,
      sensors: [{ part: 'ina226', addr: 0x40, key: 'power', rshunt: 0.01, currentLsb: 0.001, map: { vbus: 'vbus', iload: 'iload' }, fixed: { rshunt: 0.01 } }],
      world: { kind: 'pump' },
      energy: { sleepUa: 8, activeMa: 6, ...RADIOS.wifi }, battery: BATTERIES.li18650, link: { latencyMs: 40, loss: 0 },
    },
    cell: {
      id: 'cell', site: 'farm', periodS: 120, qos: 0, keepAliveS: 300,
      sensors: [{ part: 'ina219', addr: 0x40, key: 'battery', rshunt: 0.1, currentLsb: 0.0001, map: { vbus: 'vbus', iload: 'iload' }, fixed: { rshunt: 0.1 } }],
      world: { kind: 'battery' },
      energy: { sleepUa: 6, activeMa: 5, ...RADIOS.ble }, battery: BATTERIES.aa2, link: { latencyMs: 30, loss: 0 },
    },
  };

  const api = { createBus, createFleet, createNode, DRIVERS, WORLDS, PRESETS, BATTERIES, RADIOS };
  root.AletheonIot = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
