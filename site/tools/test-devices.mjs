// Known-answer tests for the Device Lab simulator. Run from the project root:  node site/tools/test-devices.mjs
// Expected values come from worked examples and tables printed in the vendor datasheets (page numbers in site/tools/devices/*.json),
// so a modeling mistake (wrong LSB, shift, formula) cannot pass silently.
import * as fs from 'node:fs';
import * as vm from 'node:vm';

const ctx = { window: {} };
vm.createContext(ctx);
vm.runInContext(fs.readFileSync('site/assets/devices-data.js', 'utf8'), ctx);
vm.runInContext(fs.readFileSync('site/assets/devicecore.js', 'utf8') + '\nglobalThis.__core = __aletheonDevCore;', ctx);
const DATA = ctx.window.DEVICES;
const core = ctx.__core(DATA);

let failed = 0;
const check = (label, ok, extra = '') => {
  if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${ok ? '' : ' :: ' + extra}`);
};
const hexs = (n) => '0x' + n.toString(16).toUpperCase().padStart(4, '0');
// Runs a program and returns the logged values (as the strings the program logged).
const go = (device, code, extra = {}) => core.run({ device, code, ...extra });
const val = (r, i = 0) => r.logs[i]?.text;

// ---- every model: shape, reset values, sample program ----------------------------------------------------------------------
for (const m of DATA.devices) {
  check(
    `${m.part}: model has registers, addresses and a sample`,
    m.registers.length >= 4 && m.addresses.length >= 1 && m.sample.length > 50 && m.notModeled.length >= 2,
  );
  const zero = Object.fromEntries(m.inputs.map((i) => [i.id, i.id === 'rshunt' ? i.default : 0]));
  const r = go(m.id, '', { inputs: zero });
  const bad = m.registers.filter((reg) => {
    const got = r.regs.find((x) => x.addr === reg.addr)?.value;
    return got !== hexs(parseInt(reg.reset, 16)) && !(m.id === 'tmp117' && reg.addr === '0x00' && got === '0x8000');
  });
  check(`${m.part}: every register reads its documented reset value with zero inputs`, bad.length === 0, JSON.stringify(bad.map((b) => [b.addr, b.reset])));
  const s = go(m.id, m.sample);
  check(
    `${m.part}: its sample program runs without error or warning`,
    s.ok && s.logs.length >= 2 && s.bus.every((b) => !b.warn || b.warn.length === 0),
    s.error + JSON.stringify(s.bus.filter((b) => b.warn?.length)),
  );
}

// ---- TMP117 ----------------------------------------------------------------------------------------------------------------
{
  const T = (t, ms, extra = '') =>
    go('tmp117', `i2c.writeReg16(0x48,0x01,0x0220); delay(${ms}); ${extra} log(hex(i2c.readReg16(0x48,0x00)));`, { inputs: { temp: t } });
  check('TMP117: Device_ID reads 0x0117', val(go('tmp117', 'log(hex(i2c.readReg16(0x48,0x0F)))')) === '0x0117');
  check('TMP117: result register reads 0x8000 (-256 C) before the first conversion', val(go('tmp117', 'log(hex(i2c.readReg16(0x48,0x00)))')) === '0x8000');
  check('TMP117: 25 C -> 0x0C80 (3200 x 7.8125 mC)', val(T(25, 200)) === '0x0C80');
  check('TMP117: -25 C -> 0xF380 (datasheet Table 7-1)', val(T(-25, 200)) === '0xF380');
  check('TMP117: -0.125 C -> 0xFFF0 and +0.125 C -> 0x0010 (Table 7-1)', val(T(-0.125, 200)) === '0xFFF0' && val(T(0.125, 200)) === '0x0010');
  check('TMP117: 0 C -> 0x0000 and -0.0078125 C -> 0xFFFF', val(T(0, 200)) === '0x0000' && val(T(-0.0078125, 200)) === '0xFFFF');
  const dr = go('tmp117', 'delay(200); const a=i2c.readReg16(0x48,0x01); const b=i2c.readReg16(0x48,0x01); log(hex(a), hex(b));');
  check('TMP117: Data_Ready (bit 13) is set after a conversion and cleared by reading Configuration', val(dr) === '0x2220 0x0220', val(dr));
  const early = go('tmp117', 'delay(50); log(hex(i2c.readReg16(0x48,0x01)));');
  check('TMP117: not ready at 50 ms with the default 8-average setting (124 ms)', val(early) === '0x0220', val(early));
  const al = go(
    'tmp117',
    'i2c.writeReg16(0x48,0x02,0x0A00); i2c.writeReg16(0x48,0x03,0x0000); delay(200); const a=i2c.readReg16(0x48,0x01); const b=i2c.readReg16(0x48,0x01); log(hex(a), hex(b));',
    { inputs: { temp: 25 } },
  );
  check('TMP117: 25 C above a 20 C high limit sets HIGH_Alert (bit 15); reading Configuration clears it', val(al) === '0xA220 0x0220', val(al));
  const lo = go('tmp117', 'i2c.writeReg16(0x48,0x03,0x0A00); delay(200); log(hex(i2c.readReg16(0x48,0x01)));', { inputs: { temp: 10 } });
  check('TMP117: 10 C below a 20 C low limit sets LOW_Alert (bit 14)', (parseInt(val(lo), 16) & 0x4000) !== 0, val(lo));
  const ro = go('tmp117', 'i2c.writeReg16(0x48,0x0F,0x1234);');
  check(
    'TMP117: writing the read-only Device_ID is ignored with a warning',
    ro.ok && ro.bus[0].warn.length === 1 && ro.regs.find((r) => r.addr === '0x0F').value === '0x0117',
  );
  const sr = go('tmp117', 'i2c.writeReg16(0x48,0x01,0x0000); i2c.writeReg16(0x48,0x01,0x0002); log(hex(i2c.readReg16(0x48,0x01)));');
  check('TMP117: Soft_Reset restores the default Configuration', val(sr) === '0x0220', val(sr));
  const fast = go('tmp117', 'i2c.writeReg16(0x48,0x01,0x0000); delay(20); log(hex(i2c.readReg16(0x48,0x01)));');
  check('TMP117: CONV=000 AVG=00 completes a conversion within 15.5 ms (ready at 20 ms)', (parseInt(val(fast), 16) & 0x2000) !== 0, val(fast));
  const t2 = go('tmp117', 'delay(200); sim.set("temp", 80); delay(1100); log(hex(i2c.readReg16(0x48,0x00)));', { inputs: { temp: 25 } });
  check('TMP117: changing the physical temperature mid-run shows up on the next cycle (80 C -> 0x2800)', val(t2) === '0x2800', val(t2));
}

// ---- INA219 (worked example, datasheet p26: 20 mV across 2 mOhm, 12 V bus, 1 mA/bit) ------------------------------------------
{
  const cal = Math.trunc(0.04096 / (0.001 * 0.002));
  check(`INA219: Cal = trunc(0.04096 / (Current_LSB x Rshunt)) gives 20480 for the datasheet example (got ${cal})`, cal === 20480);
  const run = (extra) => go('ina219', `i2c.writeReg16(0x40,0x05,20480); ${extra}`, { inputs: { vbus: 11.98, iload: 10, rshunt: 0.002 } });
  const r = run(
    'log(i2c.readReg16(0x40,0x01), i2c.readReg16(0x40,0x02)>>3, i2c.readReg16(0x40,0x04), i2c.readReg16(0x40,0x03), hex(i2c.readReg16(0x40,0x03)));',
  );
  check('INA219: shunt 2000 (10 uV/bit), bus 2995 (BB3h), current 10000 (2710h), power 5990 (1766h)', val(r) === '2000 2995 10000 5990 0x1766', val(r));
  const bus = run('log(hex(i2c.readReg16(0x40,0x02)));');
  check('INA219: bus register holds the value shifted left by 3 (2995 << 3 = 0x5D98)', val(bus) === '0x5D98', val(bus));
  const nocal = go('ina219', 'log(i2c.readReg16(0x40,0x04), i2c.readReg16(0x40,0x03));', { inputs: { vbus: 12, iload: 1, rshunt: 0.1 } });
  check('INA219: current and power read 0 until the Calibration register is programmed', val(nocal) === '0 0', val(nocal));
  const rst = go('ina219', 'i2c.writeReg16(0x40,0x05,1234); i2c.writeReg16(0x40,0x00,0x8000); log(hex(i2c.readReg16(0x40,0x00)), i2c.readReg16(0x40,0x05));');
  check('INA219: writing 1 to Configuration bit 15 restores 0x399F and clears Calibration', val(rst) === '0x399F 0', val(rst));
  const neg = go('ina219', 'log(toInt16(i2c.readReg16(0x40,0x01)));', { inputs: { vbus: 5, iload: -1, rshunt: 0.1 } });
  check("INA219: -100 mV across the shunt reads -10000 (two's complement)", val(neg) === '-10000', val(neg));
  const clip = go('ina219', 'log(toInt16(i2c.readReg16(0x40,0x01)));', { inputs: { vbus: 5, iload: 3.2, rshunt: 0.2 } });
  check('INA219: 640 mV across the shunt clips at the default +-320 mV range (32000)', val(clip) === '32000', val(clip));
  const pga = go('ina219', 'i2c.writeReg16(0x40,0x00,0x399F & ~0x1800); log(toInt16(i2c.readReg16(0x40,0x01)));', {
    inputs: { vbus: 5, iload: 1, rshunt: 0.1 },
  });
  check('INA219: PG=/1 (+-40 mV) clips 100 mV at 4000', val(pga) === '4000', val(pga));
}

// ---- INA226 (worked example, datasheet p16) --------------------------------------------------------------------------------------
{
  const cal = Math.trunc(0.00512 / (0.001 * 0.002));
  check(`INA226: Cal = 0.00512 / (Current_LSB x Rshunt) gives 2560 for the datasheet example (got ${cal})`, cal === 2560);
  const r = go(
    'ina226',
    'i2c.writeReg16(0x40,0x05,2560); log(i2c.readReg16(0x40,0x01), i2c.readReg16(0x40,0x02), i2c.readReg16(0x40,0x04), i2c.readReg16(0x40,0x03), hex(i2c.readReg16(0x40,0x03)));',
    { inputs: { vbus: 11.98, iload: 10, rshunt: 0.002 } },
  );
  check('INA226: shunt 8000, bus 9584, current 10000, power 4792 (12B8h) as in Table 6-1', val(r) === '8000 9584 10000 4792 0x12B8', val(r));
  const id = go('ina226', 'log(hex(i2c.readReg16(0x40,0xFE)), hex(i2c.readReg16(0x40,0xFF)), hex(i2c.readReg16(0x40,0x00)));');
  check('INA226: Manufacturer ID 0x5449, Die ID 0x2260, Configuration 0x4127', val(id) === '0x5449 0x2260 0x4127', val(id));
  const nocal = go('ina226', 'log(i2c.readReg16(0x40,0x04), i2c.readReg16(0x40,0x03));', { inputs: { vbus: 12, iload: 1, rshunt: 0.01 } });
  check('INA226: current and power read 0 until calibrated', val(nocal) === '0 0', val(nocal));
}

// ---- ADS1115 ---------------------------------------------------------------------------------------------------------------------
{
  const cfg = (os, mux, pga, mode, dr) => (os << 15) | (mux << 12) | (pga << 9) | (mode << 8) | (dr << 5) | 3;
  const one = (mux, pga, ins) =>
    go('ads1115', `i2c.writeReg16(0x48,0x01,${cfg(1, mux, pga, 1, 4)}); delay(10); log(toInt16(i2c.readReg16(0x48,0x00)));`, { inputs: ins });
  const cd = go('ads1115', 'log(hex(i2c.readReg16(0x48,0x01)));');
  check('ADS1115: Config reads 0x8583 at reset', val(cd) === '0x8583', val(cd));
  check('ADS1115: AIN0 vs GND, +-4.096 V (125 uV/count): 1.65 V -> 13200', val(one(4, 1, { ain0: 1.65 })) === '13200', val(one(4, 1, { ain0: 1.65 })));
  check('ADS1115: AIN0 vs GND, +-2.048 V (62.5 uV/count): 1.65 V -> 26400', val(one(4, 2, { ain0: 1.65 })) === '26400');
  check(
    'ADS1115: +-6.144 V -> 187.5 uV/count (3.0 V = 16000), +-0.256 V -> 7.8125 uV/count (0.1 V = 12800)',
    val(one(4, 0, { ain0: 3 })) === '16000' && val(one(4, 5, { ain0: 0.1 })) === '12800',
  );
  check('ADS1115: differential AIN0-AIN1 (mux 000): 1.65 V - 0.5 V at +-2.048 V -> 18400', val(one(0, 2, { ain0: 1.65, ain1: 0.5 })) === '18400');
  check(
    'ADS1115: mux 011 is AIN2 - AIN3, mux 111 is AIN3 vs GND',
    val(one(3, 2, { ain2: 1, ain3: 0.5 })) === '8000' && val(one(7, 2, { ain3: 1 })) === '16000',
  );
  check(
    'ADS1115: +full scale clips at 0x7FFF (32767) and -full scale at 0x8000 (-32768)',
    val(one(4, 2, { ain0: 3.3 })) === '32767' && val(one(0, 2, { ain0: 0, ain1: 3.3 })) === '-32768',
  );
  const os = go(
    'ads1115',
    `i2c.writeReg16(0x48,0x01,${cfg(1, 4, 2, 1, 4)}); const early=i2c.readReg16(0x48,0x01); delay(10); const late=i2c.readReg16(0x48,0x01); log(early>>15, late>>15);`,
  );
  check('ADS1115: OS reads 0 while a single conversion runs and 1 when done', val(os) === '0 1', val(os));
  const cont = go(
    'ads1115',
    `i2c.writeReg16(0x48,0x01,${cfg(0, 4, 2, 0, 7)}); delay(5); const a=toInt16(i2c.readReg16(0x48,0x00)); sim.set('ain0', 0.5); delay(5); log(a, toInt16(i2c.readReg16(0x48,0x00)));`,
    { inputs: { ain0: 1 } },
  );
  check('ADS1115: continuous mode at 860 SPS keeps updating (1.0 V -> 16000, then 0.5 V -> 8000)', val(cont) === '16000 8000', val(cont));
  const addrs = DATA.devices
    .find((d) => d.id === 'ads1115')
    .addresses.map((a) => a.addr)
    .join();
  check('ADS1115: the four ADDR straps give 0x48, 0x49, 0x4A, 0x4B', addrs === '0x48,0x49,0x4A,0x4B', addrs);
}

// ---- bus behavior and sandbox limits ---------------------------------------------------------------------------------------------
{
  const n = go('tmp117', 'i2c.read(0x50, 2);');
  check(
    'bus: reading an address nobody answers throws a NACK that names the real address',
    !n.ok && /NACK/.test(n.error) && /0x48/.test(n.error) && n.bus[0].ack === false,
    n.error,
  );
  const spin = go('tmp117', 'for(;;){ i2c.readReg16(0x48,0x00); }');
  check('limits: an endless bus loop is stopped, with a message', !spin.ok && /stopped/.test(spin.error), spin.error);
  const lng = go('tmp117', 'for(;;){ delay(60000); }');
  check('limits: simulated time is capped', !lng.ok && /simulated time/.test(lng.error), lng.error);
  const bad = go('tmp117', 'sim.set("bogus", 1)');
  check('sim: setting an unknown physical input is an error that lists the real ones', !bad.ok && /temp/.test(bad.error), bad.error);
  const un = go('tmp117', 'i2c.write(0x48,[0x04]); log(hex(i2c.read(0x48,2)[0]))');
  check(
    'bus: a register the model leaves out warns instead of inventing a value',
    un.ok && un.bus[0].warn.length === 0 && un.bus[1].warn.length === 1 && /not a register in this model/.test(un.bus[1].warn[0]),
    JSON.stringify(un.bus),
  );
  check(
    'bus: every transaction is logged with direction, address, bytes and an explanation',
    (() => {
      const r = go('tmp117', 'i2c.readReg16(0x48,0x0F)');
      return r.bus.length === 2 && r.bus[0].dir === 'W' && r.bus[1].dir === 'R' && r.bus[1].note.includes('Device_ID');
    })(),
  );
}

console.log(failed ? `\n${failed} FAILED` : '\nALL PASS');
process.exit(failed ? 1 : 0);
