// Known-answer tests for the IoT Bench model (site/assets/iotnodes.js). Run from the project root:  node site/tools/test-iot.mjs
// The sensor numbers come from the datasheet worked examples that the Device Lab models already reproduce (INA219/INA226: 20 mV across
// 2 mOhm, 12 V bus, 1 mA/bit). Energy figures are worked out by hand in the comments.
import * as fs from 'node:fs';
import * as vm from 'node:vm';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

const ctx = { window: {} };
vm.createContext(ctx);
vm.runInContext(fs.readFileSync('site/assets/devices-data.js', 'utf8'), ctx);
const core = require('../assets/devicecore.js').core(ctx.window.DEVICES);
const S = require('../assets/simcore.js');
const I = require('../assets/iotnodes.js');

let failed = 0;
const check = (label, ok, extra = '') => {
  if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${ok ? '' : ' :: ' + extra}`);
};
const near = (a, b, tol) => Math.abs(a - b) <= tol;
const clone = (o) => JSON.parse(JSON.stringify(o));
const dash = (fleet) => {
  const got = [];
  fleet.broker
    .connect('dash', { link: { latencyMs: 0 } })
    .subscribe('#', 1, (m) => got.push({ ...m, json: m.payload.startsWith('{') ? JSON.parse(m.payload) : null }));
  return got;
};
const sensorNode = (over = {}) => ({
  id: 'n',
  site: 's',
  periodS: 60,
  qos: 1,
  keepAliveS: 120,
  world: { kind: 'weather', base: 25, amp: 0, startHour: 9 },
  sensors: [{ part: 'tmp117', addr: 0x48, key: 'air', map: { temp: 'temp' } }],
  energy: { sleepUa: 10, activeMa: 5, txMa: 100, txMs: 50 },
  battery: I.BATTERIES.li18650,
  link: { latencyMs: 10, loss: 0 },
  ...over,
});

// ---- drivers read the real register models and decode them the way the datasheet says -------------------------------------------------
{
  const bus = I.createBus(core);
  bus.attach('ina219', 0x40, { vbus: 11.98, iload: 10, rshunt: 0.002 });
  I.DRIVERS.ina219.init(bus, 0x40, { rshunt: 0.002, currentLsb: 0.001 });
  const r = I.DRIVERS.ina219.read(bus, 0x40, { rshunt: 0.002, currentLsb: 0.001 }, {});
  const cal = bus.events.find((e) => e.dir === 'W' && e.bytes.length === 3);
  check(
    'INA219 driver: calibration written is 20480 (datasheet example, 1 mA/bit, 2 mOhm)',
    cal && ((cal.bytes[1] << 8) | cal.bytes[2]) === 20480,
    JSON.stringify(cal),
  );
  check(
    'INA219 driver: 20 mV across 2 mOhm reads 10 A, bus 11.98 V, power 119.8 W (power register 5990)',
    r.ok && near(r.fields.current_a.v, 10, 1e-9) && near(r.fields.bus_v.v, 11.98, 1e-9) && near(r.fields.power_w.v, 119.8, 1e-6),
    JSON.stringify(r),
  );
}
{
  const bus = I.createBus(core);
  bus.attach('ina226', 0x40, { vbus: 11.98, iload: 10, rshunt: 0.002 });
  I.DRIVERS.ina226.init(bus, 0x40, { rshunt: 0.002, currentLsb: 0.001 });
  const cal = bus.events.find((e) => e.dir === 'W' && e.bytes.length === 3);
  const r = I.DRIVERS.ina226.read(bus, 0x40, { rshunt: 0.002, currentLsb: 0.001 }, {});
  check('INA226 driver: calibration written is 2560 (datasheet example)', cal && ((cal.bytes[1] << 8) | cal.bytes[2]) === 2560);
  check(
    'INA226 driver: reads 10 A, 11.98 V (register 9584) and 119.8 W (register 4792)',
    r.ok && near(r.fields.current_a.v, 10, 1e-9) && near(r.fields.bus_v.v, 11.98, 1e-9) && near(r.fields.power_w.v, 119.8, 1e-6),
    JSON.stringify(r),
  );
}
{
  const bus = I.createBus(core);
  bus.attach('tmp117', 0x48, { temp: 25 });
  bus.delay(200);
  const r = I.DRIVERS.tmp117.read(bus, 0x48, {}, { waitReady: true, validate: true });
  check('TMP117 driver: 25 C is register 0x0C80 and decodes to exactly 25 C', r.ok && r.fields.temperature_c.v === 25, JSON.stringify(r));
  bus.attach('tmp117', 0x49, { temp: -25 });
  bus.delay(200);
  const r2 = I.DRIVERS.tmp117.read(bus, 0x49, {}, { waitReady: false, validate: true });
  check('TMP117 driver: -25 C is 0xF380 (datasheet table) and decodes to -25 C', r2.ok && r2.fields.temperature_c.v === -25, JSON.stringify(r2));
  const r3 = I.DRIVERS.tmp117.read(bus, 0x4a, {}, {});
  check('TMP117 driver: a missing part gives a NACK error, not a value', r3.ok === false && /no ACK from 0x4A/.test(r3.error), JSON.stringify(r3));
}
{
  const bus = I.createBus(core);
  bus.attach('ads1115', 0x48, { ain0: 1.65, ain1: 0, ain2: 0, ain3: 0 });
  const r = I.DRIVERS.ads1115.read(bus, 0x48, { channels: [0], pga: 1 }, {});
  check(
    'ADS1115 driver: 1.65 V on AIN0 at +-4.096 V (125 uV/count) reads 13200 counts = 1.65 V',
    r.ok && near(r.fields.ain0_v.v, 1.65, 1e-9),
    JSON.stringify(r),
  );
  const waits = bus.events.filter((e) => e.dir === 'R').length;
  check(
    'ADS1115 driver: it polled the OS bit until the 128 SPS conversion (7.8 ms) finished',
    waits >= 2 && bus.t >= 7.8 && bus.t <= 12,
    `${waits} reads, ${bus.t} ms`,
  );
  check(
    'bus log: every event has the Device Lab shape (t, dir, addr, bytes, ack, note)',
    bus.events.every((e) => 't' in e && 'dir' in e && 'addr' in e && Array.isArray(e.bytes) && 'ack' in e),
  );
}

// ---- a node end to end -----------------------------------------------------------------------------------------------------------------
{
  const f = I.createFleet({ core, seed: 1 }),
    got = dash(f);
  f.addNode(sensorNode());
  f.startAll();
  f.run(5 * 60000);
  const air = got.filter((m) => m.topic === 's/n/air');
  check(
    'node: publishes online status (retained), one reading per period and a diag message each cycle',
    got.some((m) => m.topic === 's/n/status' && m.payload === 'online') && air.length === 5 && got.filter((m) => m.topic === 's/n/diag').length === 5,
    `${air.length}`,
  );
  check(
    'node: a 25 C world is published as 25 C (TMP117 register round trip)',
    air.every((m) => m.json.temperature_c === 25),
    JSON.stringify(air[0]),
  );
  check(
    'node: readings are 60 s apart (after the longer first wake) and sequence numbers count up',
    air[2].json.t - air[1].json.t === 60000 && air[4].json.t - air[3].json.t === 60000 && air.map((m) => m.json.seq).join() === '1,2,3,4,5',
  );
  check('node: retained status is online at the broker', f.broker.retained.get('s/n/status')?.payload === 'online');
}

// ---- energy: hand-computed known answer -------------------------------------------------------------------------------------------------
{
  // INA219 node (no waiting on the bus): awake = 4 ms MCU. Messages per cycle: 1 reading + 1 diag = 2, each costing 50 ms at 100 mA.
  //   busy = 4 + 2 x 50 = 104 ms; sleep = 60000 - 104 = 59896 ms
  //   charge per cycle = 10 uA x 59896 + 5000 uA x 4 + 100000 uA x 100 = 598 960 + 20 000 + 10 000 000 = 10 618 960 nC (uA.ms)
  const cfg = sensorNode({
    sensors: [{ part: 'ina219', addr: 0x40, key: 'p', rshunt: 0.1, currentLsb: 0.0001, map: { vbus: 'vbus', iload: 'iload' }, fixed: { rshunt: 0.1 } }],
    world: { kind: 'battery' },
    qos: 0,
  });
  const f = I.createFleet({ core, seed: 1 });
  const n = f.addNode(cfg);
  f.startAll();
  f.run(25 + 60000 * 2 + 1); // just after the third wake started
  const a = n.totalNc;
  f.run(25 + 60000 * 12 + 1);
  const b = n.totalNc;
  check('energy: ten cycles cost 106 189 600 nC (10 618 960 per cycle, worked out by hand)', near(b - a, 106189600, 1), String(b - a));
  const p = S.powerBudget({ sleepUa: 10, activeMa: 5, activeMs: 4, txMa: 100, txMs: 100, periodS: 60, capacityMah: 2000 });
  check(
    'energy: simulated average current equals the closed-form power budget (176.98 uA)',
    near((b - a) / (60000 * 10), p.avgUa, 0.01) && near(p.avgUa, 176.9827, 1e-3),
    `${(b - a) / 600000} vs ${p.avgUa}`,
  );
  check('energy: battery voltage falls along the linear curve (used charge / capacity)', near(n.voltage, 4.2 - 1.2 * (n.usedMah / 2000), 1e-9));
}
{
  const cfg = (loss, qos) =>
    sensorNode({
      qos,
      link: { latencyMs: 10, loss },
      retryMs: 2000,
      maxRetries: 3,
      sensors: [{ part: 'ina219', addr: 0x40, key: 'p', rshunt: 0.1, map: { vbus: 'vbus', iload: 'iload' }, fixed: { rshunt: 0.1 } }],
      world: { kind: 'battery' },
    });
  const run = (loss) => {
    const f = I.createFleet({ core, seed: 1 });
    const n = f.addNode(cfg(loss, 1));
    f.startAll();
    f.run(60000 * 30 + 1);
    return n;
  };
  const clean = run(0),
    lossy = run(0.5);
  check(
    'energy: with 50 % loss, QoS 1 retries make the node spend more charge (every retry powers the radio again)',
    lossy.totalNc > clean.totalNc * 1.2,
    `${lossy.totalNc} vs ${clean.totalNc}`,
  );
}

// ---- faults ----------------------------------------------------------------------------------------------------------------------------
{
  const f = I.createFleet({ core, seed: 1 }),
    got = dash(f);
  const n = f.addNode(sensorNode());
  f.startAll();
  f.run(60000);
  n.inject({ kind: 'drift', perHour: 2 });
  f.run(60000 + 3 * 3600000);
  const air = got.filter((m) => m.topic === 's/n/air'),
    last = air[air.length - 1].json.temperature_c;
  const lastT = air[air.length - 1].json.t - 4; // wake time = publish time minus the 4 ms the MCU was awake
  check(
    'fault drift: +2 C/hour from t = 60 s shows up in the reading as 25 + 2 x hours elapsed, while the truth stays 25 C',
    near(last, 25 + (2 * (lastT - 60000)) / 3600000, 0.01),
    `${last} vs ${25 + (2 * (lastT - 60000)) / 3600000}`,
  );
  check('fault drift: the node keeps the real truth separately for comparison', near(n.state.truth[n.state.truth.length - 1].temp, 25, 1e-9));
}
{
  const f = I.createFleet({ core, seed: 1 }),
    got = dash(f);
  const n = f.addNode(sensorNode());
  f.startAll();
  f.run(2 * 60000);
  const before = got.filter((m) => m.topic === 's/n/air').length;
  n.inject({ kind: 'unplug', addr: 0x48 });
  f.run(4 * 60000);
  const diag = got.filter((m) => m.topic === 's/n/diag').pop().json;
  check(
    'fault unplug: no more readings, and the diag message names the NACK',
    got.filter((m) => m.topic === 's/n/air').length === before && /no ACK from 0x48/.test(JSON.stringify(diag.errors)),
    JSON.stringify(diag),
  );
  check(
    'fault unplug: the NACK is visible in the node bus capture',
    n.bus.events.some((e) => !e.ack && e.addr === 0x48),
  );
  n.inject({ kind: 'replug', addr: 0x48 });
  f.run(6 * 60000);
  check('fault unplug: readings resume when the part is plugged back in', got.filter((m) => m.topic === 's/n/air').length > before);
}
{
  const ina = (fwExtra) =>
    sensorNode({
      firmware: fwExtra,
      sensors: [{ part: 'ina219', addr: 0x40, key: 'p', rshunt: 0.1, currentLsb: 0.0001, map: { vbus: 'vbus', iload: 'iload' }, fixed: { rshunt: 0.1 } }],
      world: { kind: 'pump' },
    });
  const run = (fwx) => {
    const f = I.createFleet({ core, seed: 1 }),
      got = dash(f);
    const n = f.addNode(ina(fwx));
    f.startAll();
    f.run(90000);
    n.inject({ kind: 'sensorReset', addr: 0x40 });
    f.run(90000 + 120000);
    return got.filter((m) => m.topic === 's/n/p').pop().json;
  };
  const naive = run({}),
    robust = run({ reinitEveryWake: true });
  check(
    'fault sensor reset (INA219): the calibration is lost, current reads 0 A while bus voltage still reads',
    naive.current_a === 0 && naive.bus_v > 11,
    JSON.stringify(naive),
  );
  check('fault sensor reset (INA219): firmware that re-writes calibration every wake recovers', robust.current_a > 0.3, JSON.stringify(robust));
}
{
  const run = (fwx) => {
    const f = I.createFleet({ core, seed: 1 }),
      got = dash(f);
    const n = f.addNode(sensorNode({ firmware: fwx }));
    f.startAll();
    f.run(70000);
    n.inject({ kind: 'sensorReset', addr: 0x48 });
    f.run(70000 + 125000);
    return got.filter((m) => m.topic === 's/n/air' && m.json.t > 70000);
  };
  const naive = run({ waitReady: false, validate: false }),
    careful = run({});
  check(
    'fault sensor reset (TMP117): firmware that does not wait or validate publishes -256 C (0x8000) right after the reset',
    naive[0].json.temperature_c === -256,
    JSON.stringify(naive.map((m) => m.json)),
  );
  check(
    'fault sensor reset (TMP117): firmware that waits for Data_Ready publishes the real 25 C, never -256',
    careful.length >= 1 && careful.every((m) => m.json.temperature_c === 25),
    JSON.stringify(careful.map((m) => m.json)),
  );
}
{
  const f = I.createFleet({ core, seed: 1 }),
    got = dash(f);
  const n = f.addNode(sensorNode());
  f.startAll();
  f.run(70000);
  n.inject({ kind: 'brownout', ms: 3000 });
  f.run(70000 + 3000 + 1000);
  const st = got.filter((m) => m.topic === 's/n/status').map((m) => m.payload);
  check(
    'fault brown-out: the node reboots, the broker publishes its will on takeover, and the node announces online again',
    n.state.brownouts === 1 && n.state.boots === 2 && st.join() === 'online,offline,online',
    st.join(),
  );
  check('fault brown-out: it resumes its readings after rebooting', n.state.status === 'running' && f.broker.retained.get('s/n/status').payload === 'online');
}
{
  const f = I.createFleet({ core, seed: 1 }),
    got = dash(f);
  const n = f.addNode(
    sensorNode({ battery: { ...I.BATTERIES.li18650, capacityMah: 1 }, energy: { sleepUa: 10, activeMa: 5, txMa: 100, txMs: 50, energyScale: 1 } }),
  );
  f.startAll();
  f.run(24 * 3600000);
  check(
    'battery: a 1 mAh cell runs flat, the node dies and the broker later publishes its last-will (offline)',
    n.state.status === 'dead' && f.broker.retained.get('s/n/status').payload === 'offline' && got.some((m) => m.payload === 'offline'),
    `${n.state.status} ${f.broker.retained.get('s/n/status')?.payload}`,
  );
  check('battery: the cutoff is reached at about the capacity drawn (within one cycle)', near(n.usedMah, 1, 0.01), String(n.usedMah));
}
{
  const f = I.createFleet({ core, seed: 1 }),
    got = dash(f);
  const n = f.addNode(sensorNode({ battery: I.BATTERIES.cr2032, energy: { sleepUa: 8, activeMa: 6, ...I.RADIOS.wifi } }));
  f.startAll();
  f.run(10 * 60000);
  check(
    'brown-out by sag: a Wi-Fi-class burst (120 mA) on a CR2032-class cell (20 ohm) sags the supply below the MCU limit, so it never gets a message out',
    n.state.brownouts >= 2 && !got.some((m) => m.topic === 's/n/air'),
    `${n.state.brownouts} brownouts, ${got.length} messages`,
  );
  const f2 = I.createFleet({ core, seed: 1 }),
    got2 = dash(f2);
  const n2 = f2.addNode(sensorNode({ battery: I.BATTERIES.cr2032, energy: { sleepUa: 8, activeMa: 6, ...I.RADIOS.ble } }));
  f2.startAll();
  f2.run(10 * 60000);
  check(
    'brown-out by sag: a BLE-class burst (15 mA) on the same cell works',
    n2.state.brownouts === 0 && got2.some((m) => m.topic === 's/n/air'),
    `${n2.state.brownouts}`,
  );
}

// ---- network ---------------------------------------------------------------------------------------------------------------------------
{
  const run = (qos, loss, seed) => {
    const f = I.createFleet({ core, seed }),
      got = dash(f);
    f.addNode(sensorNode({ qos, link: { latencyMs: 10, loss }, retryMs: 1000, maxRetries: 5 }));
    f.startAll();
    f.run(60000 * 200);
    return { got, stats: f.broker.stats, log: f.broker.log };
  };
  const q0 = run(0, 0.3, 1),
    q1 = run(1, 0.3, 1);
  const n0 = new Set(q0.got.filter((m) => m.topic === 's/n/air').map((m) => m.json.seq)).size,
    n1 = new Set(q1.got.filter((m) => m.topic === 's/n/air').map((m) => m.json.seq)).size;
  check('network: at 30 % loss QoS 0 loses roughly 30 % of 200 readings', n0 > 110 && n0 < 170, String(n0));
  check('network: QoS 1 delivers (nearly) all 200 readings at the same loss', n1 >= 196, String(n1));
  const a = run(0, 0.3, 7),
    b = run(0, 0.3, 7),
    c = run(0, 0.3, 8);
  const sig = (r) => JSON.stringify(r.log.map((l) => [l.t, l.kind, l.topic]));
  check('network: the same seed replays the identical message log; another seed does not', sig(a) === sig(b) && sig(a) !== sig(c));
}
{
  const f = I.createFleet({ core, seed: 1 }),
    got = dash(f);
  f.addNode(sensorNode({ qos: 0 }));
  f.startAll();
  f.run(60000);
  f.broker.setUp(false);
  f.run(60000 * 4);
  const during = got.filter((m) => m.topic === 's/n/air').length;
  f.broker.setUp(true);
  f.run(60000 * 7);
  check(
    'broker outage: readings sent while the broker is down are lost (QoS 0), and delivery resumes after',
    during === 1 && got.filter((m) => m.topic === 's/n/air').length >= 3,
    `${during}`,
  );
  check('broker outage: the node is not declared dead just because the broker was away', !got.some((m) => m.payload === 'offline'));
}

if (failed) {
  console.log(`\n${failed} check(s) FAILED`);
  process.exit(1);
}
console.log('\nall IoT bench checks passed');
