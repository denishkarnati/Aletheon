// Known-answer tests for the guided labs (site/assets/labcore.js) and for the real data they link to. Run from the project root:
//   node site/tools/test-labs.mjs
// Each lab must be solvable and must also be unsolvable the "obvious wrong way", so a lab cannot quietly turn into one that always passes.
import * as fs from 'node:fs';
import * as vm from 'node:vm';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

const ctx = { window: {} };
vm.createContext(ctx);
for (const f of ['devices-data', 'atlas-data']) vm.runInContext(fs.readFileSync(`site/assets/${f}.js`, 'utf8'), ctx);
const DEVICES = ctx.window.DEVICES,
  ATLAS = ctx.window.ATLAS;
const core = require('../assets/devicecore.js').core(DEVICES);
const S = require('../assets/simcore.js');
const I = require('../assets/iotnodes.js');
const L = require('../assets/logiccore.js');
const labs = require('../assets/labcore.js').createLabs({ core, IOT: I, S, L, devices: DEVICES.devices });

let failed = 0;
const check = (label, ok, extra = '') => {
  if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${ok ? '' : ' :: ' + extra}`);
};

// ---- lab 1: weather node ---------------------------------------------------------------------------------------------------------------
{
  const base = { sleepUa: 8, periodS: 60, radio: 'wifi', battery: 'aa2' };
  const wifi = labs.weatherPlan(base);
  check(
    'weather lab: the measured awake time comes from the real models (TMP117 settling plus ADS1115 conversion, about 12 ms, 3 messages)',
    wifi.awakeMs > 5 && wifi.awakeMs < 30 && wifi.messages === 3,
    JSON.stringify([wifi.awakeMs, wifi.messages]),
  );
  check(
    'weather lab: Wi-Fi class every minute on 2 x AA does NOT meet the 2-year goal (the radio dominates)',
    !wifi.pass && wifi.budget.dominant === 'tx' && wifi.budget.lifeDays < 730,
    JSON.stringify([wifi.budget.lifeDays, wifi.why]),
  );
  const ble = labs.weatherPlan({ ...base, radio: 'ble' });
  check('weather lab: BLE class every minute on 2 x AA meets the goal', ble.pass && ble.budget.lifeDays >= 730, ble.why);
  const slow = labs.weatherPlan({ ...base, periodS: 600 });
  check(
    'weather lab: Wi-Fi every 10 minutes lasts long enough but breaks the "at least once a minute" goal',
    !slow.pass && slow.budget.lifeDays > 730 && /once a minute/.test(slow.why),
    slow.why,
  );
  const leaky = labs.weatherPlan({ ...base, radio: 'ble', sleepUa: 400 });
  check(
    'weather lab: a 400 uA "sleep" current (typical of a dev board with LEDs and a USB chip) fails the goal even on BLE',
    !leaky.pass && leaky.budget.dominant === 'sleep',
    leaky.why,
  );
  const coin = labs.weatherPlan({ ...base, radio: 'wifi', battery: 'cr2032', periodS: 600 });
  check(
    'weather lab: Wi-Fi on a coin cell fails because the supply sags below the MCU limit, not because of capacity',
    !coin.pass && /sags/.test(coin.why),
    coin.why,
  );
  let threw = false;
  try {
    labs.weatherPlan({ ...base, radio: 'nope' });
  } catch {
    threw = true;
  }
  check('weather lab: unknown radio or battery is rejected', threw);
}

// ---- lab 2: debug a NACK ---------------------------------------------------------------------------------------------------------------
{
  const wrong = labs.nackTry(0x49),
    right = labs.nackTry(0x48);
  check('NACK lab: the datasheet strap "ADD0 to GND" means the part answers at 0x48', right.answer === 0x48 && /GND/.test(right.strap));
  check('NACK lab: talking to 0x49 gets no ACK and no data (the classic wrong-address NACK)', wrong.ack === false && wrong.id === null && !wrong.pass);
  check('NACK lab: the decoder sees the NACK on the waveform for 0x49', wrong.dec.transactions[0].addr === 0x49 && wrong.dec.transactions[0].addrAck === false);
  check('NACK lab: 0x48 is acknowledged and Device_ID reads 0x0117', right.pass && right.id === 0x0117);
  check('NACK lab: the other two strapped addresses (0x4A, 0x4B) are also NACKed on this board', !labs.nackTry(0x4a).ack && !labs.nackTry(0x4b).ack);
}

// ---- lab 3: -256 C ---------------------------------------------------------------------------------------------------------------------
{
  const naive = labs.glitchRun({ waitReady: false, validate: false }),
    reject = labs.glitchRun({ waitReady: false, validate: true }),
    proper = labs.glitchRun({ waitReady: true, validate: true });
  check(
    '-256 C lab: firmware that neither waits nor checks publishes -256 C after the glitch',
    naive.bad.length >= 1 && naive.bad[0].temperature_c === -256 && !naive.pass,
  );
  check(
    "-256 C lab: only rejecting 0x8000 hides the bad value but loses that cycle's reading (an error is reported instead)",
    reject.bad.length === 0 && reject.rejected.length >= 1 && !reject.pass,
    JSON.stringify([reject.bad.length, reject.rejected.length, reject.firstCycle]),
  );
  check(
    '-256 C lab: waiting for Data_Ready publishes the true 25 C right after the glitch and never -256',
    proper.pass && proper.bad.length === 0,
    JSON.stringify(proper.firstCycle),
  );
}

// ---- lab 4: coin cell ---------------------------------------------------------------------------------------------------------------------
{
  const wifi = labs.coinRun('wifi'),
    ble = labs.coinRun('ble'),
    lora = labs.coinRun('lora');
  check(
    'coin-cell lab: a Wi-Fi class burst (120 mA through 20 ohm) sags the supply to 0.6 V, the node resets over and over and publishes nothing',
    !wifi.pass && wifi.brownouts >= 2 && wifi.published === 0 && Math.abs(wifi.sagV - 0.6) < 1e-9,
    JSON.stringify([wifi.brownouts, wifi.published, wifi.sagV]),
  );
  check(
    'coin-cell lab: a BLE class burst (15 mA) works and publishes every minute for 2 hours',
    ble.pass && ble.brownouts === 0,
    JSON.stringify([ble.published, ble.brownouts]),
  );
  check(
    'coin-cell lab: a LoRa class burst (45 mA) just fits (sags to 2.1 V, above the 1.8 V limit) but drinks the cell faster than BLE',
    lora.brownouts === 0 && lora.published >= 100 && lora.avgUa > ble.avgUa * 3,
    JSON.stringify([lora.avgUa, ble.avgUa]),
  );
}

// ---- lab 5: baud rate --------------------------------------------------------------------------------------------------------------------------
{
  const ok = labs.baudTry(9600),
    bad = labs.baudTry(115200),
    near = labs.baudTry(9600 * 1.03),
    mid = labs.baudTry(19200);
  check('baud lab: 9600 decodes "Temp=21.5C" exactly', ok.pass && ok.text === 'Temp=21.5C');
  check(
    'baud lab: 115200 and 19200 produce garbage or framing errors',
    !bad.pass && !mid.pass && bad.text !== ok.text && mid.text !== ok.text,
    JSON.stringify([bad.text, mid.text]),
  );
  check('baud lab: 3 % off still reads fine (the receiver tolerance the page explains)', near.pass);
}

// ---- the real data the labs link to -----------------------------------------------------------------------------------------------------------
{
  const cols = ATLAS.cols,
    id = (k) => cols.indexOf(k);
  const FEATURED = ['espressif32/adafruit_qtpy_esp32c3', 'nordicnrf52/adafruit_feather_nrf52840', 'raspberrypi/pico'];
  const rows = FEATURED.map((b) => ATLAS.rows.find((r) => r[0] === b));
  check('Atlas: the three boards the weather lab features exist in the real Atlas data', rows.every(Boolean), FEATURED.filter((_, i) => !rows[i]).join(','));
  const conn = (r) => r[id('conn')].join('+');
  check(
    "Atlas: the featured boards really differ in radio (Wi-Fi, Bluetooth, none), so the lab's advice is not made up",
    conn(rows[0]) === 'wifi' && conn(rows[1]) === 'bluetooth' && conn(rows[2]) === '',
    rows.map(conn).join(' | '),
  );
  const PARTS = ctx.window.PARTS || (vm.runInContext(fs.readFileSync('site/assets/parts-data.js', 'utf8'), ctx), ctx.window.PARTS);
  for (const q of ['TMP117', 'ADS1115', 'INA226', 'INA219'])
    check(
      `Parts catalog: a search for ${q} finds at least one real part`,
      PARTS.rows.some((r) => r[0].toUpperCase().includes(q)),
    );
}

if (failed) {
  console.log(`\n${failed} check(s) FAILED`);
  process.exit(1);
}
console.log('\nall lab checks passed');
