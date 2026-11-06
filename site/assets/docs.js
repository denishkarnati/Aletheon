/* Fills the generated parts of the Docs and About pages from the real data files, so the numbers cannot drift from the models.
 * textContent only. */
(function () {
  'use strict';
  const UI = window.AletheonUI, el = UI.el;
  const D = window.DEVICES, ST = window.SITE_STATS;

  const body = document.getElementById('modelRows');
  if (body && D) {
    D.devices.forEach((d) => {
      const tr = el('tr');
      tr.appendChild(el('td', 'm', d.part));
      tr.appendChild(el('td', '', d.kind + ' · ' + d.vendor));
      const td = el('td'); const a = el('a', '', d.source.doc + ', ' + d.source.rev); a.href = d.source.url; a.rel = 'noopener noreferrer'; a.style.textDecoration = 'underline'; td.appendChild(a); tr.appendChild(td);
      tr.appendChild(el('td', 'm', String(d.registers.length)));
      tr.appendChild(el('td', 'm', String(d.facts.length)));
      body.appendChild(tr);
    });
    const note = document.getElementById('modelNote');
    if (note && ST) note.textContent = ST.models + ' models, ' + ST.registersModeled + ' registers modeled and ' + ST.quotesChecked + ' short quotes checked against the vendor PDFs (' + ST.generated + '). Open any of them in the Device Lab to see every fact next to its quote.';
  }

  const facts = document.getElementById('statFacts');
  if (facts && ST) {
    [[ST.boards, 'boards in the Atlas'], [ST.mcus, 'microcontrollers'], [ST.parts, 'catalog parts'], [ST.models, 'datasheet-checked models'], [ST.quotesChecked, 'page-cited quotes checked']].forEach(([n, l]) => {
      const d = el('div'); d.appendChild(el('b', '', Number(n).toLocaleString('en-US'))); d.appendChild(el('span', '', l)); facts.appendChild(d);
    });
  }
})();
