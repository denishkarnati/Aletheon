// Known-answer tests for the shared simulation core (site/assets/simcore.js). Run from the project root:  node site/tools/test-simcore.mjs
// Topic-matching expectations are the worked examples in the MQTT 3.1.1 specification (OASIS, section 4.7). The power-budget numbers are
// worked out by hand in the comments, so a mistake in the formula cannot pass silently.
import { createRequire } from 'node:module';
const S = createRequire(import.meta.url)('../assets/simcore.js');

let failed = 0;
const check = (label, ok, extra = '') => {
  if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${ok ? '' : ' :: ' + extra}`);
};
const near = (a, b, tol) => Math.abs(a - b) <= tol;

// ---- topic filters ----------------------------------------------------------------------------------------------------------
{
  const m = S.topicMatches;
  check(
    'spec 4.7.1.2: "sport/tennis/player1/#" matches the parent and its children',
    m('sport/tennis/player1/#', 'sport/tennis/player1') &&
      m('sport/tennis/player1/#', 'sport/tennis/player1/ranking') &&
      m('sport/tennis/player1/#', 'sport/tennis/player1/score/wimbledon'),
  );
  check('spec: "sport/#" also matches "sport"', m('sport/#', 'sport'));
  check('spec: "#" matches everything that does not start with $', m('#', 'a/b/c') && m('#', '/finance') && !m('#', '$SYS/broker/load'));
  check(
    'spec 4.7.1.3: "sport/tennis/+" matches player1 and player2 but not a deeper topic',
    m('sport/tennis/+', 'sport/tennis/player1') && m('sport/tennis/+', 'sport/tennis/player2') && !m('sport/tennis/+', 'sport/tennis/player1/ranking'),
  );
  check('spec: "sport/+" does not match "sport" but matches "sport/"', !m('sport/+', 'sport') && m('sport/+', 'sport/'));
  check('spec: "+/+" and "/+" match "/finance"; "+" does not', m('+/+', '/finance') && m('/+', '/finance') && !m('+', '/finance'));
  check(
    'spec 4.7.2: "+/monitor/Clients" and "#" do not match $SYS topics, "$SYS/#" does',
    !m('+/monitor/Clients', '$SYS/monitor/Clients') && m('$SYS/#', '$SYS/broker/load') && m('$SYS/monitor/+', '$SYS/monitor/Clients'),
  );
  check(
    'filters: "#" only as the last whole level, wildcards only as whole levels',
    S.validFilter('a/#') && !S.validFilter('a/#/b') && !S.validFilter('a#') && !S.validFilter('a+/b') && S.validFilter('+/+/c') && !S.validFilter(''),
  );
  check('topic names: no wildcards, not empty', S.validTopic('a/b') && !S.validTopic('a/+') && !S.validTopic('a/#') && !S.validTopic(''));
  check('matching is case-sensitive and level-exact', !m('Sport/tennis', 'sport/tennis') && !m('a/b', 'a/bc') && m('a/b', 'a/b'));
}

// ---- random numbers -----------------------------------------------------------------------------------------------------------
{
  const a = S.rng(42),
    b = S.rng(42),
    c = S.rng(43);
  const xs = Array.from({ length: 5 }, () => a()),
    ys = Array.from({ length: 5 }, () => b()),
    zs = Array.from({ length: 5 }, () => c());
  check(
    'rng: the same seed gives the same sequence, another seed differs',
    JSON.stringify(xs) === JSON.stringify(ys) && JSON.stringify(xs) !== JSON.stringify(zs),
  );
  const r = S.rng(7);
  let sum = 0,
    lo = 1,
    hi = 0;
  for (let i = 0; i < 20000; i++) {
    const v = r();
    sum += v;
    lo = Math.min(lo, v);
    hi = Math.max(hi, v);
  }
  check('rng: values in [0,1) with mean near 0.5 over 20000 draws', lo >= 0 && hi < 1 && near(sum / 20000, 0.5, 0.01), String(sum / 20000));
  const g = S.rng(9);
  let gs = 0,
    gq = 0;
  for (let i = 0; i < 20000; i++) {
    const v = S.gauss(g);
    gs += v;
    gq += v * v;
  }
  check('gauss: mean near 0 and variance near 1', near(gs / 20000, 0, 0.03) && near(gq / 20000, 1, 0.05), `${gs / 20000} ${gq / 20000}`);
}

// ---- clock ----------------------------------------------------------------------------------------------------------------------
{
  const clk = S.createClock(),
    order = [];
  clk.at(30, () => order.push('c'));
  clk.at(10, () => order.push('a'));
  clk.at(10, () => order.push('b'));
  const dead = clk.at(20, () => order.push('x'));
  clk.cancel(dead);
  clk.after(5, () => clk.after(20, () => order.push('d'))); // 5 + 20 = 25
  clk.run(100);
  check('clock: runs by time then by scheduling order, skips cancelled events, and events can schedule more', order.join('') === 'abdc', order.join(''));
  check('clock: now is the run horizon afterwards', clk.now === 100);
}

// ---- broker ---------------------------------------------------------------------------------------------------------------------
const world = (seed = 1) => {
  const clock = S.createClock();
  return { clock, broker: S.createBroker({ clock, rng: S.rng(seed) }) };
};
{
  const { clock, broker } = world();
  const got = [];
  const sub = broker.connect('dash', { link: { latencyMs: 10 } });
  sub.subscribe('farm/+/temp', 0, (m) => got.push(m));
  const node = broker.connect('n1', { link: { latencyMs: 40 } });
  node.publish('farm/n1/temp', '21.5');
  node.publish('farm/n1/humidity', '55');
  clock.run(1000);
  check(
    'broker: a matching subscriber gets the message, a non-matching topic is not delivered',
    got.length === 1 && got[0].topic === 'farm/n1/temp' && got[0].payload === '21.5',
  );
  check('broker: delivery time is uplink latency plus downlink latency (40 + 10 ms)', got[0].t === 50, String(got[0].t));
}
{
  const { clock, broker } = world();
  const a = broker.connect('a', { link: { latencyMs: 0 } }),
    got = [];
  a.publish('cfg/rate', '10', { retain: true });
  clock.run(100);
  const b = broker.connect('b', { link: { latencyMs: 0 } });
  b.subscribe('cfg/#', 0, (m) => got.push(m));
  clock.run(200);
  check('broker: a retained message reaches a late subscriber with the retain flag set', got.length === 1 && got[0].retain === true && got[0].payload === '10');
  a.publish('cfg/rate', '', { retain: true });
  clock.run(300);
  const c = broker.connect('c', { link: { latencyMs: 0 } }),
    got2 = [];
  c.subscribe('cfg/#', 0, (m) => got2.push(m));
  clock.run(400);
  check('broker: an empty retained payload clears the retained message', got2.length === 0 && broker.retained.size === 0);
}
{
  const { clock, broker } = world();
  const got = [];
  const watcher = broker.connect('w', { link: { latencyMs: 0 } });
  watcher.subscribe('status/#', 0, (m) => got.push(m));
  const n = broker.connect('n', { keepAliveS: 10, link: { latencyMs: 0 }, will: { topic: 'status/n', payload: 'offline', qos: 0, retain: false } });
  n.publish('status/n', 'online');
  clock.run(1000);
  n.kill();
  clock.run(14999);
  check(
    'broker: no last-will before 1.5 x keep-alive has passed since the last packet (spec 3.1.2.10)',
    !got.some((m) => m.payload === 'offline'),
    JSON.stringify(got.map((g) => g.payload)),
  );
  clock.run(60000);
  const w = got.find((m) => m.payload === 'offline');
  check('broker: the last-will message is published once the keep-alive window runs out', !!w && broker.stats.wills === 1);
  check('broker: the will fires 15 s after the last packet heard (10 s keep-alive x 1.5; last packet at t = 0)', !!w && w.t === 15000, String(w && w.t));
}
{
  const { clock, broker } = world();
  const got = [];
  broker.connect('w', { link: { latencyMs: 0 } }).subscribe('status/#', 0, (m) => got.push(m));
  const n = broker.connect('n', { keepAliveS: 10, link: { latencyMs: 0 }, will: { topic: 'status/n', payload: 'offline', qos: 0, retain: false } });
  clock.run(5000);
  n.disconnect();
  clock.run(100000);
  check('broker: a clean disconnect does not publish the last-will', got.length === 0 && broker.stats.wills === 0);
  const { clock: c2, broker: b2 } = world();
  const alive = b2.connect('idle', { keepAliveS: 10, link: { latencyMs: 5 } });
  c2.run(300000);
  check('broker: a healthy idle client sends keep-alive pings and is never timed out', alive.connected && !b2.log.some((l) => l.kind === 'timeout'));
}
{
  const { clock, broker } = world();
  const a = broker.connect('a', { link: { latencyMs: 0, loss: 1 } }),
    got = [];
  broker.connect('b', { link: { latencyMs: 0 } }).subscribe('#', 0, (m) => got.push(m));
  for (let i = 0; i < 20; i++) a.publish('t/' + i, 'x');
  clock.run(1000);
  check(
    'broker QoS 0: with 100% loss nothing arrives and every message is counted as dropped',
    got.length === 0 && broker.stats.dropped === 20,
    JSON.stringify(broker.stats),
  );
}
{
  const { clock, broker } = world(5);
  const a = broker.connect('a', { link: { latencyMs: 20, loss: 0.5 }, retryMs: 500, maxRetries: 8 }),
    got = [];
  broker.connect('b', { link: { latencyMs: 0 } }).subscribe('#', 1, (m) => got.push(m));
  for (let i = 0; i < 100; i++) a.publish('t/' + i, String(i), { qos: 1 });
  clock.run(60000);
  const uniq = new Set(got.map((g) => g.topic));
  check('broker QoS 1: with 50% loss and retries, (almost) every message gets through at least once', uniq.size >= 99, String(uniq.size));
  check(
    'broker QoS 1: retransmissions happened, and at-least-once delivery means duplicates can appear',
    broker.stats.retransmits > 20 && got.length >= uniq.size,
    JSON.stringify(broker.stats),
  );
  check(
    'broker QoS 1: a retransmitted publish is logged with the DUP flag (the flag is per hop, so subscribers see it as a new message)',
    broker.log.some((l) => l.kind === 'publish' && l.dup),
  );
}
{
  const { clock, broker } = world();
  const a = broker.connect('a', { link: { latencyMs: 0, loss: 1 }, retryMs: 100, maxRetries: 3 });
  a.publish('x', '1', { qos: 1 });
  clock.run(10000);
  check(
    'broker QoS 1: with a dead link it gives up after 1 + 3 attempts and records it',
    broker.stats.gaveUp === 1 && broker.stats.dropped === 4 && broker.stats.retransmits === 3,
    JSON.stringify(broker.stats),
  );
}
{
  const { clock, broker } = world();
  const got = [];
  broker.connect('s', { link: { latencyMs: 0 } }).subscribe('#', 0, (m) => got.push(m));
  const p = broker.connect('p', { link: { latencyMs: 0 } });
  p.publish('a', '1', { qos: 1 });
  clock.run(100);
  check('broker: the delivered QoS is the lower of publish QoS and subscription QoS', got.length === 1 && got[0].qos === 0);
  broker.setUp(false);
  p.publish('a', '2', { qos: 0 });
  clock.run(200);
  check('broker outage: nothing is delivered while the broker is down', got.length === 1);
  broker.setUp(true);
  p.publish('a', '3');
  clock.run(300);
  check('broker outage: delivery resumes when the broker is back', got.length === 2 && got[1].payload === '3');
}
{
  const { clock, broker } = world();
  let threw = false;
  const p = broker.connect('p');
  try {
    p.publish('bad/+', 'x');
  } catch {
    threw = true;
  }
  let threw2 = false;
  try {
    p.subscribe('bad/#/x', 0, () => {});
  } catch {
    threw2 = true;
  }
  let threw3 = false;
  try {
    broker.connect('p');
  } catch {
    threw3 = true;
  }
  clock.run(1);
  check('broker: wildcard in a publish topic, a bad filter and a duplicate client id are rejected', threw && threw2 && threw3);
}

// ---- power budget -----------------------------------------------------------------------------------------------------------------
{
  // Sleep 5 uA, awake 10 mA for 100 ms, transmit 80 mA for 50 ms, every 60 s, 2000 mAh cell.
  //   sleep time = 60000 - 150 = 59850 ms -> 5 x 59850        =   299 250 uA.ms
  //   awake                       -> 10 000 uA x 100 ms       = 1 000 000 uA.ms
  //   transmit                    -> 80 000 uA x 50 ms        = 4 000 000 uA.ms
  //   total 5 299 250 / 60 000 ms = 88.3208 uA; life = 2 000 000 uAh / 88.3208 uA = 22 644.8 h = 943.5 days
  const p = S.powerBudget({ sleepUa: 5, activeMa: 10, activeMs: 100, txMa: 80, txMs: 50, periodS: 60, capacityMah: 2000 });
  check('power budget: average current 88.3208 uA (hand calculation)', near(p.avgUa, 88.320833, 1e-4), String(p.avgUa));
  check(
    'power budget: life 22 644.8 h / 943.5 days with a 2000 mAh cell',
    near(p.lifeHours, 22644.8, 0.5) && near(p.lifeDays, 943.5, 0.1),
    `${p.lifeHours} ${p.lifeDays}`,
  );
  check(
    'power budget: transmitting dominates and the shares sum to 1',
    p.dominant === 'tx' && near(p.shares.sleep + p.shares.active + p.shares.tx + p.shares.selfDischarge, 1, 1e-9),
    p.dominant,
  );
  check('power budget: duty cycle is 0.25 % (150 ms in 60 s)', near(p.dutyPct, 0.25, 1e-9));
  const sd = S.powerBudget({ sleepUa: 5, activeMa: 10, activeMs: 100, txMa: 80, txMs: 50, periodS: 60, capacityMah: 2000, selfDischargePctYear: 2 });
  check(
    'power budget: 2 %/year self-discharge on 2000 mAh adds 4.5 uA (2000 x 1000 x 0.02 / 8766 h)',
    near(sd.avgUa - p.avgUa, 4.5631, 1e-3),
    String(sd.avgUa - p.avgUa),
  );
  const half = S.powerBudget({ sleepUa: 5, activeMa: 10, activeMs: 100, txMa: 80, txMs: 50, periodS: 60, capacityMah: 2000, usableFraction: 0.5 });
  check('power budget: usable fraction 0.5 halves the life', near(half.lifeHours * 2, p.lifeHours, 1e-6));
  const never = S.powerBudget({ sleepUa: 0, activeMa: 0, activeMs: 0, txMa: 0, txMs: 0, periodS: 1, capacityMah: 100 });
  check('power budget: a node that draws nothing lives forever', never.lifeHours === Infinity);
  const bad = (o) => {
    try {
      S.powerBudget({ sleepUa: 1, activeMa: 1, activeMs: 1, txMa: 1, txMs: 1, periodS: 1, capacityMah: 1, ...o });
      return false;
    } catch {
      return true;
    }
  };
  check(
    'power budget: rejects awake time longer than the period, negative and non-numeric input',
    bad({ activeMs: 999, txMs: 2 }) && bad({ sleepUa: -1 }) && bad({ periodS: 0 }) && bad({ capacityMah: 'x' }) && bad({ usableFraction: 0 }),
  );
}

if (failed) {
  console.log(`\n${failed} check(s) FAILED`);
  process.exit(1);
}
console.log('\nall simcore checks passed');
