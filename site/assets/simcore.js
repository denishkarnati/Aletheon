/* Aletheon simulation core: a deterministic virtual clock, a seeded random source, an MQTT-style broker and a power-budget calculator.
 *
 * What this is: behavioral models of MQTT's topic matching, QoS 0 and 1, retained messages and last-will messages, written from the public
 * MQTT 3.1.1 specification (OASIS, section 4.7 for topics, 3.1.2.10 for the keep-alive rule). It is NOT a protocol implementation: there are no
 * packets on a wire, no TCP, no TLS and no QoS 2 or persistent sessions. A "link" delays or drops whole messages, which is how an unreliable
 * radio looks to the application. Everything here is plain, dependency-free JavaScript so the same file runs in the page and in the tests. */
(function (root) {
  'use strict';

  // ---- seeded random numbers ------------------------------------------------------------------------------------------------
  // mulberry32: a small, well-known 32-bit generator. The same seed always gives the same run, so a fault scenario can be replayed.
  function rng(seed) {
    let a = seed >>> 0;
    return function next() {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  function gauss(next) {
    const u = Math.max(next(), 1e-12);
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * next());
  }

  // ---- MQTT topic rules (MQTT 3.1.1, section 4.7) -----------------------------------------------------------------------------
  function validTopic(topic) {
    return typeof topic === 'string' && topic.length > 0 && topic.length <= 65535 && !/[#+\0]/.test(topic);
  }
  function validFilter(filter) {
    if (typeof filter !== 'string' || filter.length === 0 || filter.length > 65535 || filter.includes('\0')) return false;
    const levels = filter.split('/');
    return levels.every((l, i) => {
      if (l === '#') return i === levels.length - 1;
      if (l === '+') return true;
      return !/[#+]/.test(l);
    });
  }
  function topicMatches(filter, topic) {
    if (!validFilter(filter) || !validTopic(topic)) return false;
    const f = filter.split('/'), t = topic.split('/');
    if (t[0].startsWith('$') && (f[0] === '#' || f[0] === '+')) return false; // wildcards at the first level never match $-topics
    for (let i = 0; i < f.length; i++) {
      if (f[i] === '#') return true; // '#' also matches the parent level: "sport/#" matches "sport"
      if (i >= t.length) return false;
      if (f[i] === '+') continue;
      if (f[i] !== t[i]) return false;
    }
    return f.length === t.length;
  }

  // ---- virtual clock ------------------------------------------------------------------------------------------------------------
  // Events run in time order; two events at the same time run in the order they were scheduled.
  function createClock() {
    let now = 0, seq = 0;
    const q = [];
    const clock = {
      get now() { return now; },
      at(t, fn) {
        const e = { t: Math.max(t, now), s: seq++, fn };
        let lo = 0, hi = q.length;
        while (lo < hi) { const m = (lo + hi) >> 1; if (q[m].t < e.t || (q[m].t === e.t && q[m].s < e.s)) lo = m + 1; else hi = m; }
        q.splice(lo, 0, e);
        return e;
      },
      after(d, fn) { return clock.at(now + d, fn); },
      cancel(e) { if (e) e.fn = null; },
      run(until) {
        let guard = 0;
        while (q.length && q[0].t <= until) {
          const e = q.shift();
          now = e.t;
          if (e.fn) e.fn();
          if (++guard > 5e6) throw new Error('simulation stopped: more than 5 million events in one step');
        }
        if (until > now) now = until;
      },
      get pending() { return q.length; },
    };
    return clock;
  }

  // ---- the broker ---------------------------------------------------------------------------------------------------------------
  const DEFAULT_LINK = { latencyMs: 30, jitterMs: 0, loss: 0, up: true };

  function createBroker(opts) {
    const clock = opts.clock, rand = opts.rng || rng(1), logMax = opts.logMax || 4000;
    const clients = new Map();
    const retained = new Map();
    const log = [];
    const stats = { published: 0, delivered: 0, dropped: 0, ackDropped: 0, retransmits: 0, gaveUp: 0, wills: 0, duplicates: 0 };
    let up = true;
    const note = (kind, extra) => { log.push({ t: clock.now, kind, ...extra }); if (log.length > logMax) log.shift(); };

    // One attempt over a link: the message is delayed or dropped. Returns false when it was dropped.
    function transmit(link, endpointAlive, onArrive, dropKey) {
      if (!up || !link.up || !endpointAlive() || rand() < link.loss) { stats[dropKey]++; return false; }
      const delay = Math.max(0, link.latencyMs + (link.jitterMs ? (rand() * 2 - 1) * link.jitterMs : 0));
      clock.after(delay, () => { if (up && endpointAlive()) onArrive(); else stats[dropKey]++; });
      return true;
    }

    // QoS 1: the sender repeats the message until it sees a PUBACK or runs out of retries (at least once, so duplicates can happen).
    function sendReliable(owner, link, msg, arrive, aliveSender, aliveReceiver) {
      let tries = 0, acked = false, timer = null;
      const entry = { cancel() { acked = true; clock.cancel(timer); } };
      owner.inflight.add(entry);
      const attempt = () => {
        tries++;
        if (tries > 1) stats.retransmits++;
        if (owner.onTx) owner.onTx(tries);
        const copy = { ...msg, dup: tries > 1 };
        transmit(link, aliveReceiver, () => {
          arrive(copy);
          transmit(link, aliveSender, () => { if (!acked) { acked = true; clock.cancel(timer); owner.inflight.delete(entry); } }, 'ackDropped');
        }, 'dropped');
        timer = clock.after(owner.retryMs, () => {
          if (acked) return;
          if (tries > owner.maxRetries) { stats.gaveUp++; owner.inflight.delete(entry); note('giveup', { client: owner.id, topic: msg.topic, payload: msg.payload }); return; }
          attempt();
        });
      };
      attempt();
    }

    function route(msg, fromId) {
      if (msg.retain) { if (msg.payload === '') retained.delete(msg.topic); else retained.set(msg.topic, { ...msg, dup: false }); }
      for (const c of clients.values()) {
        if (!c.alive) continue;
        let best = -1;
        for (const s of c.subs) if (topicMatches(s.filter, msg.topic)) best = Math.max(best, s.qos);
        if (best < 0) continue;
        deliver(c, { topic: msg.topic, payload: msg.payload, qos: Math.min(msg.qos, best), retain: false, from: fromId });
      }
    }
    function deliver(c, m) {
      const arrive = (x) => {
        stats.delivered++;
        note('deliver', { client: c.id, topic: x.topic, payload: x.payload, qos: x.qos, dup: !!x.dup, from: x.from });
        for (const s of c.subs) if (topicMatches(s.filter, x.topic) && s.handler) s.handler({ ...x, t: clock.now });
      };
      const alive = () => c.alive;
      if (m.qos === 0) transmit(c.link, alive, () => arrive(m), 'dropped');
      else sendReliable(c.brokerSide, c.link, m, arrive, () => up, alive);
    }

    function armWatchdog(c) {
      clock.cancel(c.watchdog);
      c.watchdog = null;
      if (!c.keepAliveS || !up || !c.registered) return;
      c.watchdog = clock.after(c.keepAliveS * 1500, () => { // MQTT 3.1.1, 3.1.2.10: one and a half times the keep-alive
        c.watchdog = null;
        if (c.registered) { note('timeout', { client: c.id }); drop(c, true); }
      });
    }
    function drop(c, publishWill) {
      c.registered = false;
      clock.cancel(c.watchdog);
      if (publishWill && c.will) { stats.wills++; note('will', { client: c.id, topic: c.will.topic, payload: c.will.payload }); stats.published++; route({ ...c.will, qos: c.will.qos || 0 }, c.id); }
    }

    function connect(id, o) {
      o = o || {};
      const prev = clients.get(id);
      if (prev && prev.alive) throw new Error(`client "${id}" is already connected`);
      if (prev && prev.registered) drop(prev, true); // a device that died and came back: the broker closes the stale session and publishes its will
      const c = {
        id, alive: true, registered: true, subs: [], will: o.will || null, keepAliveS: o.keepAliveS === undefined ? 60 : o.keepAliveS,
        link: { ...DEFAULT_LINK, ...(o.link || {}) }, retryMs: o.retryMs || 3000, maxRetries: o.maxRetries === undefined ? 3 : o.maxRetries,
        inflight: new Set(), watchdog: null, lastSent: clock.now, onTx: o.onTx || null,
      };
      c.brokerSide = { id: 'broker->' + id, inflight: new Set(), retryMs: c.retryMs, maxRetries: c.maxRetries };
      clients.set(id, c);
      note('connect', { client: id });
      armWatchdog(c);
      const heard = () => armWatchdog(c); // the broker received something from this client
      let pingTimer = null;
      const schedulePing = () => { // a PINGREQ is due one keep-alive after the last thing this client SENT
        if (!c.keepAliveS) return;
        pingTimer = clock.after(Math.max(0, c.lastSent + c.keepAliveS * 1000 - clock.now), () => {
          if (!c.alive) return;
          if (clock.now - c.lastSent >= c.keepAliveS * 1000) { c.lastSent = clock.now; transmit(c.link, () => c.alive, heard, 'dropped'); }
          schedulePing();
        });
      };
      schedulePing();
      const api = {
        id,
        get connected() { return c.alive && c.registered; },
        get link() { return c.link; },
        setLink(patch) { Object.assign(c.link, patch); },
        publish(topic, payload, po) {
          po = po || {};
          if (!c.alive) return false;
          if (!validTopic(topic)) throw new Error(`invalid topic "${topic}" (no wildcards, not empty)`);
          const qos = po.qos === 1 ? 1 : 0;
          const msg = { topic, payload: String(payload), qos, retain: !!po.retain, from: id };
          c.lastSent = clock.now;
          const arrive = (m) => {
            heard();
            stats.published++;
            note('publish', { client: id, topic: m.topic, payload: m.payload, qos: m.qos, retain: m.retain, dup: !!m.dup });
            route(m, id);
          };
          if (qos === 0) { if (c.onTx) c.onTx(1); transmit(c.link, () => true, () => arrive(msg), 'dropped'); }
          else sendReliable(c, c.link, msg, arrive, () => c.alive, () => true);
          return true;
        },
        subscribe(filter, qos, handler) {
          if (!validFilter(filter)) throw new Error(`invalid topic filter "${filter}"`);
          const q = qos === 1 ? 1 : 0;
          c.subs.push({ filter, qos: q, handler });
          for (const m of retained.values()) if (topicMatches(filter, m.topic)) deliver(c, { topic: m.topic, payload: m.payload, qos: Math.min(m.qos, q), retain: true, from: m.from });
        },
        disconnect() { // a clean disconnect: no last-will message
          if (!c.alive) return;
          c.alive = false; clock.cancel(pingTimer); c.inflight.forEach((e) => e.cancel());
          note('disconnect', { client: id }); drop(c, false);
        },
        kill() { // the device dies (power loss): the broker only finds out when the keep-alive runs out
          if (!c.alive) return;
          c.alive = false; clock.cancel(pingTimer); c.inflight.forEach((e) => e.cancel());
          note('lost', { client: id });
        },
      };
      return api;
    }

    return {
      connect, stats, log,
      get retained() { return new Map(retained); },
      get up() { return up; },
      setUp(v) { // a broker outage: nothing is delivered and no timers run; when it returns, clients get a fresh keep-alive window
        if (v === up) return;
        up = v; note(v ? 'broker-up' : 'broker-down', {});
        for (const c of clients.values()) { if (!v) { clock.cancel(c.watchdog); c.watchdog = null; } else if (c.alive) armWatchdog(c); }
      },
      clientIds() { return [...clients.keys()]; },
    };
  }

  // ---- power budget -----------------------------------------------------------------------------------------------------------
  // A duty-cycled node spends most of its time asleep. Average current is the time-weighted mean of three states (sleep, awake, transmitting);
  // battery life is usable capacity divided by that average, plus the cell's own self-discharge. Every input is YOUR assumption.
  function powerBudget(p) {
    const need = (k) => { if (!(typeof p[k] === 'number' && isFinite(p[k]) && p[k] >= 0)) throw new Error(`${k} must be a number of at least 0`); return p[k]; };
    const sleepUa = need('sleepUa'), activeMa = need('activeMa'), activeMs = need('activeMs'), txMa = need('txMa'), txMs = need('txMs');
    const periodS = need('periodS'), capacityMah = need('capacityMah');
    const usable = p.usableFraction === undefined ? 1 : p.usableFraction, selfPct = p.selfDischargePctYear || 0;
    if (!(periodS > 0)) throw new Error('periodS must be greater than 0');
    if (!(usable > 0 && usable <= 1)) throw new Error('usableFraction must be above 0 and at most 1');
    const periodMs = periodS * 1000, busyMs = activeMs + txMs;
    if (busyMs > periodMs) throw new Error(`awake time (${busyMs} ms) is longer than the period (${periodMs} ms)`);
    const sleepMs = periodMs - busyMs;
    const sleepPart = sleepUa * sleepMs / periodMs, activePart = activeMa * 1000 * activeMs / periodMs, txPart = txMa * 1000 * txMs / periodMs;
    const selfUa = capacityMah * 1000 * (selfPct / 100) / 8766; // 8766 h = 365.25 days
    const avgUa = sleepPart + activePart + txPart + selfUa;
    const lifeHours = avgUa > 0 ? capacityMah * usable * 1000 / avgUa : Infinity;
    const sum = sleepPart + activePart + txPart + selfUa || 1;
    return {
      avgUa, avgMa: avgUa / 1000, dutyPct: busyMs / periodMs * 100, lifeHours, lifeDays: lifeHours / 24, lifeYears: lifeHours / 8766,
      perCycleUc: avgUa * periodS, // microcoulombs per cycle
      shares: { sleep: sleepPart / sum, active: activePart / sum, tx: txPart / sum, selfDischarge: selfUa / sum },
      dominant: Object.entries({ sleep: sleepPart, active: activePart, tx: txPart, selfDischarge: selfUa }).reduce((a, b) => (b[1] > a[1] ? b : a))[0],
    };
  }

  const api = { rng, gauss, validTopic, validFilter, topicMatches, createClock, createBroker, powerBudget, DEFAULT_LINK };
  root.AletheonSim = Object.assign(root.AletheonSim || {}, api);
  if (typeof module !== 'undefined' && module.exports) module.exports = root.AletheonSim;
})(typeof window !== 'undefined' ? window : globalThis);
