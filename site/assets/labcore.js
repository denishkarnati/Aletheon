/* Aletheon scenario labs: the logic behind each guided lab, kept separate from the page so every lab has a known-answer test.
 * Each lab runs the SAME models the rest of the platform uses: the datasheet-checked register models (devicecore.js), the node and battery
 * model (iotnodes.js), the broker (simcore.js) and the decoders (logiccore.js). What each lab teaches is a general embedded-systems lesson;
 * the numbers you choose are assumptions, not measurements of any product. */
(function (root) {
  'use strict';

  function createLabs(deps) {
    const { core, IOT, S, L, devices } = deps;

    // ---- Lab 1: a battery-powered weather node ---------------------------------------------------------------------------------------
    // Goal: at least 2 years from the chosen cell, reporting at least once a minute. The budget uses the awake time MEASURED from the real
    // TMP117 + ADS1115 models (settling and conversion waits), not a guess.
    const WEATHER_GOAL = { minDays: 730, maxPeriodS: 60 };
    function measureAwake() {
      const f = IOT.createFleet({ core, seed: 1 });
      const n = f.addNode({ ...JSON.parse(JSON.stringify(IOT.PRESETS.greenhouse)), id: 'probe' });
      n.start(); f.run(3 * 60000);
      return { awakeMs: n.state.lastAwakeMs, messages: n.state.msgsPerCycle };
    }
    let awakeCache = null;
    function weatherPlan(o) {
      awakeCache = awakeCache || measureAwake();
      const radio = IOT.RADIOS[o.radio], bat = IOT.BATTERIES[o.battery];
      if (!radio || !bat) throw new Error('unknown radio or battery');
      const budget = S.powerBudget({
        sleepUa: o.sleepUa, activeMa: o.activeMa === undefined ? 6 : o.activeMa, activeMs: awakeCache.awakeMs + 4, txMa: radio.txMa, txMs: radio.txMs * awakeCache.messages,
        periodS: o.periodS, capacityMah: bat.capacityMah, usableFraction: 0.85, selfDischargePctYear: o.battery === 'li18650' ? 3 : 1,
      });
      const sagV = bat.vFull - (radio.txMa / 1000) * bat.internalOhm;
      const browns = sagV < bat.brownoutV;
      const pass = !browns && budget.lifeDays >= WEATHER_GOAL.minDays && o.periodS <= WEATHER_GOAL.maxPeriodS;
      let why;
      if (browns) why = `the supply sags to ${sagV.toFixed(2)} V during a radio burst, below the ${bat.brownoutV} V the MCU needs, so the node resets`;
      else if (o.periodS > WEATHER_GOAL.maxPeriodS) why = `it reports every ${o.periodS} s; the goal is at least once a minute`;
      else if (budget.lifeDays < WEATHER_GOAL.minDays) why = `${Math.round(budget.lifeDays)} days is short of ${WEATHER_GOAL.minDays}; ${budget.dominant === 'tx' ? 'the radio' : budget.dominant === 'sleep' ? 'sleep current' : budget.dominant} takes most of the charge`;
      else why = `${Math.round(budget.lifeDays)} days at a ${o.periodS} s period`;
      return { budget, pass, why, sagV, awakeMs: awakeCache.awakeMs, messages: awakeCache.messages, goal: WEATHER_GOAL };
    }

    // ---- Lab 2: debug a NACK ------------------------------------------------------------------------------------------------------------
    // The TMP117's address pin is tied to GND on "your board", so the part answers at the address the datasheet lists for that strap.
    function nackTry(addr) {
      const m = devices.find((d) => d.id === 'tmp117');
      const answer = parseInt(m.addresses[0].addr, 16); // ADD0 to GND
      const bus = IOT.createBus(core);
      bus.attach('tmp117', answer, { temp: 25 });
      bus.delay(200);
      const w = bus.write(addr, [0x0f]);
      let id = null;
      if (w.ack) { const r = bus.read(addr, 2); id = r.ack ? (r.bytes[0] << 8) | r.bytes[1] : null; }
      const enc = L.i2cEncode(bus.events), dec = L.i2cDecode(enc.scl, enc.sda);
      return { ack: w.ack, id, events: bus.events, enc, dec, answer, strap: m.addresses[0].strap, pass: w.ack && id === 0x0117 };
    }

    // ---- Lab 3: why does the sensor read -256 C? ---------------------------------------------------------------------------------------------
    // A supply glitch resets the TMP117 just before a read. A TMP117 that has just been reset reads 0x8000 (-256 C) until its first conversion ends.
    function glitchRun(fw) {
      const f = IOT.createFleet({ core, seed: 1 }), got = [];
      f.broker.connect('lab', { keepAliveS: 0, link: { latencyMs: 0 } }).subscribe('farm/glitch/#', 0, (m) => { if (m.payload[0] === '{') got.push({ topic: m.topic, ...JSON.parse(m.payload) }); });
      const n = f.addNode({ ...JSON.parse(JSON.stringify(IOT.PRESETS.greenhouse)), id: 'glitch', sensors: [IOT.PRESETS.greenhouse.sensors[0]], firmware: { waitReady: !!fw.waitReady, validate: !!fw.validate }, world: { kind: 'weather', base: 25, amp: 0, startHour: 9 } });
      n.start(); f.run(70000);
      n.inject({ kind: 'sensorReset', addr: 0x48 }); f.run(70000 + 130000);
      const after = got.filter((m) => m.topic === 'farm/glitch/air' && m.t > 70000), diag = got.filter((m) => m.topic === 'farm/glitch/diag' && m.t > 70000);
      const bad = after.filter((m) => m.temperature_c < -100), good = after.filter((m) => m.temperature_c > 0);
      const rejected = diag.filter((m) => m.errors && m.errors.length);
      const firstCycle = after[0] || null;
      // The glitch lands on the wake at t = 120 s: a good fix publishes the true 25 C for THAT cycle, with no bad value and no lost reading.
      return { readings: after, bad, good, rejected, pass: bad.length === 0 && rejected.length === 0 && !!firstCycle && firstCycle.t < 125000 && firstCycle.temperature_c === 25, firstCycle };
    }

    // ---- Lab 4: a coin cell that cannot power a radio -----------------------------------------------------------------------------------------
    function coinRun(radioId) {
      const radio = IOT.RADIOS[radioId], bat = IOT.BATTERIES.cr2032;
      if (!radio) throw new Error('unknown radio');
      const f = IOT.createFleet({ core, seed: 1 }), got = [];
      f.broker.connect('lab', { keepAliveS: 0, link: { latencyMs: 0 } }).subscribe('farm/coin/air', 0, (m) => got.push(m));
      const n = f.addNode({ ...JSON.parse(JSON.stringify(IOT.PRESETS.greenhouse)), id: 'coin', sensors: [IOT.PRESETS.greenhouse.sensors[0]], battery: bat, energy: { sleepUa: 8, activeMa: 6, txMa: radio.txMa, txMs: radio.txMs }, qos: 0 });
      n.start(); f.run(2 * 3600000);
      const sag = bat.vFull - (radio.txMa / 1000) * bat.internalOhm;
      return { published: got.length, brownouts: n.state.brownouts, sagV: sag, brownoutV: bat.brownoutV, avgUa: n.avgUa, pass: got.length >= 100 && n.state.brownouts === 0, radio, bat };
    }

    // ---- Lab 5: UART garbage -------------------------------------------------------------------------------------------------------------------
    const BAUD_TEXT = 'Temp=21.5C';
    function baudTry(rxBaud) {
      const bytes = Array.from(BAUD_TEXT, (c) => c.charCodeAt(0));
      const enc = L.uartEncode(bytes, { baud: 9600 }), dec = L.uartDecode(enc.ch, { baud: rxBaud });
      const text = dec.frames.map((f) => (f.value >= 32 && f.value < 127 ? String.fromCharCode(f.value) : '·')).join('');
      return { text, errors: dec.errors.length, pass: text === BAUD_TEXT && dec.errors.length === 0, enc, dec, sent: BAUD_TEXT };
    }

    return { weatherPlan, WEATHER_GOAL, nackTry, glitchRun, coinRun, baudTry, BAUD_TEXT };
  }

  const api = { createLabs };
  root.AletheonLabs = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
