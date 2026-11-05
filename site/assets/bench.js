/* IoT Bench UI. Runs the fleet model (iotnodes.js) on the page: no network, no eval, no Worker. All DOM output goes through textContent. */
(function () {
  'use strict';
  const UI = window.AletheonUI, S = window.AletheonSim, IOT = window.AletheonIot;
  const { el, clear, $, fmtNum, fmtDuration, fmtLife } = UI;
  if (!window.DEVICES || !window.__aletheonDevCore || !S || !IOT) { $('benchError').textContent = 'The simulation scripts failed to load.'; return; }
  const core = window.__aletheonDevCore(window.DEVICES);

  const SPEEDS = [[1, '1×  (real time)'], [10, '10×'], [60, '60×  (1 min / s)'], [600, '600×  (10 min / s)'], [3600, '3600×  (1 h / s)']];
  const HAS_ANALYZER = true;
  const MAX_POINTS = 4000;
  const TRUTH_KEY = { temperature_c: 'temp', ain0_v: 'soil', bus_v: 'vbus', current_a: 'iload' };
  const PRESET_LABEL = { greenhouse: 'Greenhouse node (TMP117 + ADS1115)', pump: 'Pump monitor (INA226)', cell: 'Battery monitor (INA219)' };

  let fleet, dash, you, running = true, speed = 60, seed = 1, selected = null, selField = null, windowMs = 6 * 3600000, debt = 0;
  let series = {}, topics = new Map(), cards = new Map(), counter = {}, logFilter = '', logKind = 'important';
  const calc = { sleepUa: 8, activeMa: 6, activeMs: 12, txMa: 110, txMs: 180, periodS: 60, capacityMah: 2000, usableFraction: 0.85, selfDischargePctYear: 2 };

  // ---- building and resetting the world ------------------------------------------------------------------------------------------------
  function build() {
    fleet = IOT.createFleet({ core, seed });
    series = {}; topics = new Map(); cards.forEach((c) => c.root.remove()); cards = new Map(); counter = {}; selected = null; selField = null; debt = 0;
    dash = fleet.broker.connect('dashboard', { keepAliveS: 0, link: { latencyMs: 0 } });
    dash.subscribe('#', 1, onMessage);
    you = fleet.broker.connect('you', { keepAliveS: 0, link: { latencyMs: 0 } });
    $('outage').classList.remove('on'); $('outage').textContent = 'Broker outage: off';
    addNode('greenhouse');
  }

  function onMessage(m) {
    const t = topics.get(m.topic) || { count: 0, last: '', t: 0 };
    t.count++; t.last = m.payload; t.t = m.t; t.dup = (t.dup || 0) + (m.dup ? 1 : 0); topics.set(m.topic, t);
    if (m.payload.charAt(0) !== '{') return;
    let o; try { o = JSON.parse(m.payload); } catch (e) { return; }
    for (const k of Object.keys(o)) {
      if (k === 't' || k === 'seq' || typeof o[k] !== 'number') continue;
      const key = m.topic + '#' + k, s = series[key] || (series[key] = { x: [], y: [] });
      s.x.push(m.t); s.y.push(o[k]);
      if (s.x.length > MAX_POINTS) { s.x.shift(); s.y.shift(); }
    }
  }

  function addNode(kind) {
    const base = JSON.parse(JSON.stringify(IOT.PRESETS[kind]));
    counter[kind] = (counter[kind] || 0) + 1;
    base.id = kind + (counter[kind] > 1 ? counter[kind] : '');
    const node = fleet.addNode(base);
    node.start();
    cards.set(node.id, makeCard(node, kind));
    if (!selected) select(node.id);
    refreshFieldList();
  }

  // ---- node cards -------------------------------------------------------------------------------------------------------------------------
  function makeCard(node, kind) {
    const root = el('article', 'node'), refs = {}, st = node.state, p = node.params;
    const head = el('header'), h = el('h3', '', PRESET_LABEL[kind].split(' (')[0] + (node.id.match(/\d+$/) ? ' ' + node.id.match(/\d+$/)[0] : ''));
    refs.chip = el('span', 'chip'); head.appendChild(h); head.appendChild(refs.chip); root.appendChild(head);
    root.appendChild(el('p', 'hint', node.cfg.sensors.map((s) => s.part.toUpperCase() + ' @ 0x' + s.addr.toString(16).toUpperCase()).join(' · ') + ' · topics ' + node.cfg.site + '/' + node.id + '/…'));
    const kv = el('div', 'kv');
    const rows = [['battery', 'bat'], ['charge left', 'left'], ['average current', 'avg'], ['last awake time', 'awake'], ['cycles / messages', 'cyc'], ['brown-outs / reboots', 'bo']];
    rows.forEach(([label, key]) => { kv.appendChild(el('span', '', label)); refs[key] = el('b', '', '—'); kv.appendChild(refs[key]); });
    root.appendChild(kv);
    const g = el('div', 'gauge'), gi = el('i'); g.appendChild(gi); refs.gauge = g; refs.gi = gi; root.appendChild(g);
    refs.reason = el('p', 'note'); root.appendChild(refs.reason);

    const faults = el('div', 'faults');
    const toggle = (label, onOn, onOff) => { const b = el('button', '', label); b.type = 'button'; let on = false; b.addEventListener('click', () => { on = !on; b.classList.toggle('on', on); (on ? onOn : onOff || onOn)(); }); faults.appendChild(b); return b; };
    const one = (label, fn) => { const b = el('button', '', label); b.type = 'button'; b.addEventListener('click', fn); faults.appendChild(b); };
    node.cfg.sensors.forEach((s) => {
      const name = s.part.toUpperCase();
      if (s.part === 'tmp117') toggle('Drift +2 °C/h', () => node.inject({ kind: 'drift', perHour: 2 }), () => node.inject({ kind: 'clearDrift' }));
      toggle('Unplug ' + name, () => node.inject({ kind: 'unplug', addr: s.addr }), () => node.inject({ kind: 'replug', addr: s.addr }));
      one('Glitch ' + name, () => node.inject({ kind: 'sensorReset', addr: s.addr }));
    });
    one('Brown-out 10 s', () => node.inject({ kind: 'brownout', ms: 10000 }));
    toggle('Link 50 % loss', () => node.inject({ kind: 'link', patch: { loss: 0.5 } }), () => node.inject({ kind: 'link', patch: { loss: node.cfg.link.loss || 0 } }));
    if (HAS_ANALYZER) one('I²C capture → Analyzer', () => {
      try { sessionStorage.setItem('aletheon.capture', JSON.stringify({ source: 'IoT Bench node "' + node.id + '"', t: fleet.clock.now, events: node.bus.events.slice(-240) })); } catch (e) { /* storage blocked */ }
      window.location.href = 'analyzer.html#capture';
    });
    root.appendChild(el('p', 'hint', 'Faults: click to inject. A button that stays red is on; click again to clear.'));
    root.appendChild(faults);

    const det = el('details', 'api'); det.appendChild(el('summary', '', 'Configure this node (all values are your assumptions)'));
    const body = el('div');
    body.appendChild(UI.numberField('Period (s)', node.cfg.periodS, (v) => { if (v >= 1) node.cfg.periodS = v; }, { min: 1 }));
    body.appendChild(UI.selectField('MQTT QoS', [{ value: 0, label: '0 (at most once)' }, { value: 1, label: '1 (at least once)' }], node.cfg.qos, (v) => { node.cfg.qos = Number(v); }));
    body.appendChild(UI.selectField('Radio class', Object.keys(IOT.RADIOS).map((k) => ({ value: k, label: IOT.RADIOS[k].label })), 'wifi', (v) => { Object.assign(p.en, { txMa: IOT.RADIOS[v].txMa, txMs: IOT.RADIOS[v].txMs }); }));
    body.appendChild(UI.selectField('Battery', Object.keys(IOT.BATTERIES).map((k) => ({ value: k, label: IOT.BATTERIES[k].label })), Object.keys(IOT.BATTERIES).find((k) => IOT.BATTERIES[k].capacityMah === p.bat.capacityMah) || 'li18650', (v) => { Object.assign(p.bat, IOT.BATTERIES[v]); st.usedNc = 0; }));
    body.appendChild(UI.numberField('Sleep current (µA)', p.en.sleepUa, (v) => { p.en.sleepUa = v; }, { min: 0 }));
    body.appendChild(UI.numberField('Awake current (mA)', p.en.activeMa, (v) => { p.en.activeMa = v; }, { min: 0 }));
    body.appendChild(UI.numberField('Radio current (mA)', p.en.txMa, (v) => { p.en.txMa = v; }, { min: 0 }));
    body.appendChild(UI.numberField('Radio-on per publish (ms)', p.en.txMs, (v) => { p.en.txMs = v; }, { min: 0 }));
    body.appendChild(UI.numberField('Link delay (ms)', node.cfg.link.latencyMs, (v) => { node.cfg.link.latencyMs = v; if (node.mqtt) node.mqtt.setLink({ latencyMs: v }); }, { min: 0 }));
    body.appendChild(UI.numberField('Link loss (0–1)', node.cfg.link.loss || 0, (v) => { if (v >= 0 && v <= 1) { node.cfg.link.loss = v; if (node.mqtt) node.mqtt.setLink({ loss: v }); } }, { min: 0, max: 1, step: 0.05 }));
    body.appendChild(UI.numberField('Battery accelerator (×)', p.en.energyScale, (v) => { if (v >= 1) p.en.energyScale = v; }, { min: 1 }));
    body.appendChild(el('p', 'hint', 'The accelerator multiplies every current so a flat battery or a brown-out shows up in minutes instead of months. It is a teaching aid, not physics.'));
    body.appendChild(UI.checkField('Wait for Data_Ready before reading the TMP117', p.fw.waitReady, (v) => { p.fw.waitReady = v; }));
    body.appendChild(UI.checkField('Reject a 0x8000 (−256 °C) result', p.fw.validate, (v) => { p.fw.validate = v; }));
    body.appendChild(UI.checkField('Re-write the INA calibration on every wake', p.fw.reinitEveryWake, (v) => { p.fw.reinitEveryWake = v; }));
    det.appendChild(body); root.appendChild(det);
    root.addEventListener('click', (e) => { if (!e.target.closest('button,input,select,summary,label')) select(node.id); });
    $('nodes').appendChild(root);
    return { root, refs, node };
  }

  function select(id) {
    selected = id;
    cards.forEach((c, k) => c.root.classList.toggle('sel', k === id));
    refreshFieldList(); fillCalcFromNode();
  }

  function updateCards() {
    cards.forEach((c) => {
      const n = c.node, st = n.state, r = c.refs, left = n.remainingFraction;
      r.chip.textContent = st.status; r.chip.className = 'chip ' + (st.status === 'running' ? 'ok' : st.status === 'dead' ? 'bad' : 'warn');
      r.bat.textContent = fmtNum(n.voltage, 2) + ' V'; r.left.textContent = fmtNum(left * 100, 1) + ' %';
      r.avg.textContent = fmtNum(n.avgUa, 1) + ' µA'; r.awake.textContent = fmtNum(st.lastAwakeMs, 1) + ' ms';
      r.cyc.textContent = st.cycles + ' / ' + st.published; r.bo.textContent = st.brownouts + ' / ' + (st.boots - 1);
      r.gi.style.width = (left * 100).toFixed(1) + '%'; r.gauge.className = 'gauge' + (left < 0.1 ? ' crit' : left < 0.3 ? ' low' : '');
      r.reason.textContent = (st.reason ? st.reason + '. ' : '') + (st.lastErrors.length ? 'Last cycle: ' + st.lastErrors.join('; ') : '');
    });
  }

  // ---- chart ------------------------------------------------------------------------------------------------------------------------------
  function refreshFieldList() {
    const sel = $('field'), keys = Object.keys(series).filter((k) => !selected || k.indexOf('/' + selected + '/') >= 0).sort();
    const sig = keys.join('|') + '@' + selected;
    if (sel.dataset.sig === sig) return;
    sel.dataset.sig = sig; clear(sel);
    keys.forEach((k) => { const o = el('option', '', k.replace('#', ' · ')); o.value = k; if (k === selField) o.selected = true; sel.appendChild(o); });
    if (!keys.includes(selField)) selField = keys[0] || null;
    if (selField) sel.value = selField;
  }
  function drawChart() {
    const box = $('chart'); clear(box);
    const s = selField && series[selField];
    if (!s || !s.x.length) { box.appendChild(UI.lineChart({ series: [], empty: 'Waiting for the first message…' })); return; }
    const t1 = s.x[s.x.length - 1], t0 = Math.max(0, t1 - windowMs);
    const xs = [], ys = [];
    s.x.forEach((x, i) => { if (x >= t0) { xs.push(x); ys.push(s.y[i]); } });
    const list = [{ x: xs, y: ys, cls: 'ser', dots: xs.length < 60 }];
    const field = selField.split('#')[1], tk = TRUTH_KEY[field], node = selected && cards.get(selected) && cards.get(selected).node;
    let hasTruth = false;
    if (tk && node) {
      const tr = node.state.truth.filter((p) => p.t >= t0 && p[tk] !== undefined);
      if (tr.length) { hasTruth = true; list.push({ x: tr.map((p) => p.t), y: tr.map((p) => p[tk]), cls: 'truth' }); }
    }
    box.appendChild(UI.lineChart({ series: list, label: 'Received values of ' + selField, width: 720, height: 240 }));
    $('legend').textContent = '';
    const a = el('span'); a.appendChild(el('i')); a.appendChild(document.createTextNode('what the dashboard received'));
    $('legend').appendChild(a);
    if (hasTruth) { const b = el('span'); b.appendChild(el('i', 't')); b.appendChild(document.createTextNode('the true value in the simulated world')); $('legend').appendChild(b); }
  }

  // ---- broker panels ----------------------------------------------------------------------------------------------------------------------
  function drawBroker() {
    const st = fleet.broker.stats, box = $('bstats'); clear(box);
    [['published', st.published], ['delivered', st.delivered], ['dropped', st.dropped], ['retries', st.retransmits], ['gave up', st.gaveUp], ['wills', st.wills]].forEach(([k, v]) => { const d = el('div'); d.appendChild(el('b', '', String(v))); d.appendChild(el('span', '', k)); box.appendChild(d); });
    const tb = $('topics').tBodies[0]; clear(tb);
    const ret = fleet.broker.retained;
    [...topics.keys()].sort().forEach((k) => {
      const t = topics.get(k), tr = el('tr');
      tr.appendChild(el('td', 'm', k)); tr.appendChild(el('td', 'm', String(t.count) + (t.dup ? ' (' + t.dup + ' dup)' : '')));
      tr.appendChild(el('td', 'pl', t.last.length > 90 ? t.last.slice(0, 90) + '…' : t.last));
      tr.appendChild(el('td', '', ret.has(k) ? 'retained' : ''));
      tb.appendChild(tr);
    });
    const LB = fleet.broker.log, rows = [], important = ['publish', 'will', 'timeout', 'lost', 'giveup', 'connect', 'broker-up', 'broker-down', 'disconnect'];
    const filterOk = !logFilter || S.validFilter(logFilter);
    $('filterMsg').textContent = filterOk ? '' : 'not a valid MQTT topic filter (# only at the end; + and # only as whole levels)';
    for (let i = LB.length - 1; i >= 0 && rows.length < 120; i--) {
      const e = LB[i];
      if (logKind === 'important' && !important.includes(e.kind)) continue;
      if (logKind === 'deliver' && e.kind !== 'deliver') continue;
      if (logFilter && filterOk && !(e.topic && S.topicMatches(logFilter, e.topic))) continue;
      rows.push(e);
    }
    const lb = $('log').tBodies[0]; clear(lb);
    rows.forEach((e) => {
      const tr = el('tr'); tr.appendChild(el('td', 'm', fmtDuration(e.t)));
      const k = el('td'); k.appendChild(el('span', 'kind ' + e.kind, e.kind)); tr.appendChild(k);
      tr.appendChild(el('td', 'm', e.client || '')); tr.appendChild(el('td', 'm', e.topic || ''));
      tr.appendChild(el('td', 'pl', (e.payload || '') + (e.dup ? '  [DUP]' : '') + (e.retain ? '  [retain]' : '') + (e.qos ? '  [QoS ' + e.qos + ']' : '')));
      lb.appendChild(tr);
    });
  }

  // ---- power budget -------------------------------------------------------------------------------------------------------------------------
  function fillCalcFromNode() {
    const c = selected && cards.get(selected); if (!c) return;
    const p = c.node.params, st = c.node.state;
    Object.assign(calc, { sleepUa: p.en.sleepUa, activeMa: p.en.activeMa, activeMs: Math.round((st.lastAwakeMs || 12) * 10) / 10, txMa: p.en.txMa, txMs: p.en.txMs * (st.msgsPerCycle || c.node.cfg.sensors.length + 1), periodS: c.node.cfg.periodS, capacityMah: p.bat.capacityMah });
    buildCalcInputs(); drawCalc();
  }
  function buildCalcInputs() {
    const box = $('calcIn'); clear(box);
    const defs = [['sleepUa', 'Sleep current (µA)'], ['activeMa', 'Awake current (mA)'], ['activeMs', 'Awake time per cycle (ms)'], ['txMa', 'Radio current (mA)'], ['txMs', 'Radio-on time per cycle (ms)'], ['periodS', 'Period (s)'], ['capacityMah', 'Battery capacity (mAh)'], ['usableFraction', 'Usable fraction (0–1)'], ['selfDischargePctYear', 'Self-discharge (% per year)']];
    defs.forEach(([k, label]) => box.appendChild(UI.numberField(label, calc[k], (v) => { calc[k] = v; drawCalc(); }, { min: 0 })));
  }
  function drawCalc() {
    const out = $('calcOut'); clear(out); const err = $('calcErr'); err.textContent = '';
    let r;
    try { r = S.powerBudget(calc); } catch (e) { err.textContent = String(e.message); return; }
    const stat = (k, v) => { const d = el('div'); d.appendChild(el('b', '', v)); d.appendChild(el('span', '', k)); out.appendChild(d); };
    stat('average current', fmtNum(r.avgUa, 1) + ' µA'); stat('battery life', fmtLife(r.lifeDays)); stat('duty cycle', fmtNum(r.dutyPct, 3) + ' %'); stat('charge per cycle', fmtNum(r.perCycleUc / 1000, 2) + ' mC');
    const sh = $('share'); clear(sh);
    [['s1', r.shares.sleep], ['s2', r.shares.active], ['s3', r.shares.tx], ['s4', r.shares.selfDischarge]].forEach(([c, v]) => { const i = el('i', c); i.style.width = (v * 100).toFixed(2) + '%'; sh.appendChild(i); });
    const names = { sleep: 'sleeping', active: 'the MCU being awake', tx: 'the radio', selfDischarge: "the cell's self-discharge" };
    const half = (patch) => { try { return S.powerBudget({ ...calc, ...patch }).lifeDays; } catch (e) { return NaN; } };
    $('advice').textContent = 'Most of the charge (' + fmtNum(r.shares[r.dominant] * 100, 0) + ' %) goes to ' + names[r.dominant] + '. What if: halve the radio time → ' + fmtLife(half({ txMs: calc.txMs / 2 })) + '; send half as often → ' + fmtLife(half({ periodS: calc.periodS * 2, txMs: calc.txMs, activeMs: calc.activeMs })) + '*; halve the sleep current → ' + fmtLife(half({ sleepUa: calc.sleepUa / 2 })) + '.  (*per-cycle times kept the same.)';
    const c = selected && cards.get(selected);
    $('measured').textContent = c ? 'In the running simulation, node "' + c.node.id + '" is averaging ' + fmtNum(c.node.avgUa, 1) + ' µA including boot, retries and any battery accelerator.' : '';
    // sweep: life against period, log scale
    const xs = [], ys = [];
    for (let e = 0; e <= 4.9; e += 0.1) { const per = Math.pow(10, e); try { xs.push(e); ys.push(S.powerBudget({ ...calc, periodS: per }).lifeDays); } catch (err) { /* period shorter than the awake time */ } }
    const box = $('sweep'); clear(box);
    box.appendChild(UI.lineChart({ series: [{ x: xs, y: ys }], label: 'Battery life in days against the reporting period', width: 640, height: 200, xfmt: (v) => fmtNum(Math.pow(10, v), 0) + ' s', empty: 'The awake time is longer than every period' }));
  }

  // ---- controls ---------------------------------------------------------------------------------------------------------------------------
  function init() {
    const sp = $('speed'); SPEEDS.forEach(([v, l]) => { const o = el('option', '', l); o.value = v; if (v === speed) o.selected = true; sp.appendChild(o); });
    sp.addEventListener('change', () => { speed = Number(sp.value); });
    $('run').addEventListener('click', () => { running = !running; $('run').textContent = running ? 'Pause' : 'Run'; });
    $('step').addEventListener('click', () => { fleet.step(60000); renderAll(); });
    $('reset').addEventListener('click', () => { seed = Math.max(0, Math.floor(Number($('seed').value) || 1)); build(); renderAll(); });
    $('seed').value = seed;
    $('outage').addEventListener('click', () => { const on = fleet.broker.up; fleet.broker.setUp(!on); $('outage').classList.toggle('on', on); $('outage').textContent = 'Broker outage: ' + (on ? 'ON' : 'off'); });
    const add = $('addNode'); Object.keys(PRESET_LABEL).forEach((k) => { const b = el('button', 'btn ghost sm', '+ ' + PRESET_LABEL[k]); b.type = 'button'; b.addEventListener('click', () => { addNode(k); renderAll(); }); add.appendChild(b); });
    $('field').addEventListener('change', () => { selField = $('field').value; drawChart(); });
    const w = $('win'); [[3600000, 'last hour'], [6 * 3600000, 'last 6 hours'], [24 * 3600000, 'last 24 hours'], [1e12, 'everything']].forEach(([v, l]) => { const o = el('option', '', l); o.value = v; if (v === windowMs) o.selected = true; w.appendChild(o); });
    w.addEventListener('change', () => { windowMs = Number(w.value); drawChart(); });
    $('filter').addEventListener('input', () => { logFilter = $('filter').value.trim(); drawBroker(); });
    $('kind').addEventListener('change', () => { logKind = $('kind').value; drawBroker(); });
    $('pub').addEventListener('click', () => {
      const t = $('pubTopic').value.trim(); $('pubMsg').textContent = '';
      try { you.publish(t, $('pubPayload').value, { qos: Number($('pubQos').value), retain: $('pubRetain').checked }); $('pubMsg').textContent = 'sent'; } catch (e) { $('pubMsg').textContent = String(e.message); }
    });
    $('useNode').addEventListener('click', fillCalcFromNode);
    buildCalcInputs();
  }

  function renderAll() { refreshFieldList(); updateCards(); drawChart(); drawBroker(); drawCalc(); $('clock').textContent = 'simulated time ' + fmtDuration(fleet.clock.now); }

  let last = performance.now(), lastRender = 0;
  function frame(now) {
    const dt = Math.min(now - last, 100); last = now;
    if (running) {
      debt += dt * speed;
      const start = performance.now();
      while (debt > 0 && performance.now() - start < 12) { const step = Math.min(debt, 60000); fleet.step(step); debt -= step; }
      if (debt > speed * 400) debt = speed * 400; // never fall further behind than 0.4 s of wanted progress
    }
    if (now - lastRender > 250) { lastRender = now; renderAll(); }
    window.requestAnimationFrame(frame);
  }

  init(); build(); renderAll();
  window.requestAnimationFrame(frame);
})();
