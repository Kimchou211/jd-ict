/* JD ANALYSIS · News terminal.
   - /api/news/events  : calendar + server-side rule reading (numbers come from the feed, never from an AI)
   - Blackout is INFORMATION ONLY: it never blocks a signal, it only puts the news first.
   - Typed "Actual" values (Forex Factory has none) are kept in this browser and analysed by /api/news/analyze. */
(function () {
  const $$ = (id) => document.getElementById(id);
  const esc = (s) => escapeHtml(s);
  const LS = 'jd_news_actuals_v1';
  const N = { events: [], meta: {}, offset: 0, win: { before: 30, after: 30 }, manual: {}, manualAn: {}, filter: 'all', loaded: false, busy: false, lastTick: {} };
  try { N.manual = JSON.parse(localStorage.getItem(LS) || '{}') || {}; } catch (e) { N.manual = {}; }
  const saveManual = () => { try { localStorage.setItem(LS, JSON.stringify(N.manual)); } catch (e) { /* storage blocked */ } };
  const now = () => Date.now() + N.offset;
  const p2 = (n) => String(Math.floor(n)).padStart(2, '0');
  const hms = (ms) => { const s = Math.max(0, Math.floor(ms / 1000)); return `${p2(s / 3600)}:${p2((s % 3600) / 60)}:${p2(s % 60)}`; };
  const clock = (ts) => new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
  const dayLbl = (ts) => new Date(ts).toLocaleDateString('en-GB', { weekday: 'short', day: '2-digit', month: 'short' });
  const nm = (f) => (f.title.toLowerCase().includes(String(f.label).toLowerCase()) ? esc(f.title) : `${esc(f.label)} · <span style="font-weight:500;opacity:.8">${esc(f.title)}</span>`);
  const rel = (ms) => { const m = Math.floor(Math.abs(ms) / 60000), h = Math.floor(m / 60), d = Math.floor(h / 24); return m < 60 ? `${m}m` : h < 24 ? `${h}h ${m % 60}m` : `${d}d ${h % 24}h`; };

  const effActual = (e) => (N.manual[e.id] != null && N.manual[e.id] !== '' ? N.manual[e.id] : e.actual);
  const effAnalysis = (e) => (N.manual[e.id] != null && N.manual[e.id] !== '' ? N.manualAn[e.id] || e.analysis : e.analysis);
  const isQual = (e) => ['FED_SPEECH', 'FOMC_STATEMENT', 'FOMC_PRESS', 'FOMC_MINUTES'].includes(e.category);

  /* ---------- status computed locally every second so the countdown never waits on the network ---------- */
  function liveStatus() {
    const t = now(), b = N.win.before * 60000, a = N.win.after * 60000;
    const active = N.events.filter((e) => e.blackout && e.ts_ms - b <= t && t <= e.ts_ms + a);
    const upcoming = N.events.filter((e) => e.ts_ms > t);
    const next = upcoming.find((e) => e.blackout) || upcoming[0] || null;
    const focus = active.sort((x, y) => Math.abs(x.ts_ms - t) - Math.abs(y.ts_ms - t))[0] || next;
    return { t, active, next, focus, blackout: active.length > 0 };
  }
  function stateOf(s) {
    if (s.blackout) return 'blackout';
    if (s.next && s.next.blackout && s.next.ts_ms - s.t <= 2 * 3600000) return 'soon';
    return 'clear';
  }

  /* ---------- global banner + clock + sidebar pip ---------- */
  function paintBanner(s, st) {
    const bar = $$('newsBar'); if (!bar) return;
    bar.className = 'newsbar ' + (st === 'clear' ? '' : st);
    const tag = $$('nbTag'), title = $$('nbTitle'), cd = $$('nbCd');
    const f = s.focus;
    if (!N.loaded) { tag.textContent = 'NEWS'; title.textContent = 'Loading economic calendar…'; cd.textContent = ''; return; }
    if (!f) { tag.textContent = 'NEWS'; title.textContent = N.meta.error ? 'Calendar unavailable — ' + N.meta.error : 'No tracked USD events in the feed'; cd.textContent = ''; bar.style.setProperty('--prog', '0%'); return; }
    const d = f.ts_ms - s.t, win = (N.win.before + N.win.after) * 60000;
    if (st === 'blackout') {
      tag.textContent = 'NEWS BLACKOUT'; title.innerHTML = `${nm(f)} · <span style="opacity:.75;font-weight:500">signals still run</span>`;
      cd.textContent = d >= 0 ? 'T-' + hms(d) : 'T+' + hms(-d);
      bar.style.setProperty('--prog', Math.min(100, Math.max(0, ((s.t - (f.ts_ms - N.win.before * 60000)) / win) * 100)) + '%');
    } else {
      tag.textContent = st === 'soon' ? 'NEWS SOON' : 'NEXT NEWS'; title.innerHTML = nm(f);
      cd.textContent = d > 86400000 ? rel(d) : 'T-' + hms(d);
      bar.style.setProperty('--prog', st === 'soon' ? Math.min(100, Math.max(0, (1 - d / (2 * 3600000)) * 100)) + '%' : '0%');
    }
  }
  function paintClock() {
    const d = new Date(), c = $$('clockTime'); if (!c) return;
    c.textContent = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
    $$('clockUtc').textContent = `UTC ${p2(d.getUTCHours())}:${p2(d.getUTCMinutes())}`;
  }

  /* ---------- hero (countdown) ---------- */
  function setUnit(id, val) { const el = $$(id); if (!el) return; const v = p2(val); if (el.textContent !== v) { el.textContent = v; el.parentElement.classList.remove('tick'); void el.parentElement.offsetWidth; el.parentElement.classList.add('tick'); } }
  function paintHero(s, st) {
    const hero = $$('ntHero'); if (!hero) return;
    hero.className = 'panel nt-hero ' + st;
    const f = s.focus;
    $$('ntState').textContent = st === 'blackout' ? '● NEWS BLACKOUT' : st === 'soon' ? '◐ NEWS SOON' : '○ CLEAR';
    if (!f) { $$('ntName').textContent = N.loaded ? 'No upcoming tracked event' : 'Loading…'; $$('ntMeta').innerHTML = ''; ['D', 'H', 'M', 'S'].forEach((u) => setUnit('ntU' + u, 0)); $$('ntBar').style.width = '0%'; return; }
    const d = Math.abs(f.ts_ms - s.t), secs = Math.floor(d / 1000);
    setUnit('ntUD', secs / 86400); setUnit('ntUH', (secs % 86400) / 3600); setUnit('ntUM', (secs % 3600) / 60); setUnit('ntUS', secs % 60);
    $$('ntSign').textContent = f.ts_ms >= s.t ? 'UNTIL RELEASE' : 'SINCE RELEASE';
    $$('ntName').textContent = f.title;
    const a = effActual(f);
    $$('ntMeta').innerHTML = `<span class="badge ${f.impact === 'high' ? 'bad' : 'warn'}">${esc(f.impact.toUpperCase())} IMPACT</span><span class="mono">${esc(dayLbl(f.ts_ms))} ${esc(clock(f.ts_ms))} local</span><span class="mono">${esc(new Date(f.ts_ms).toISOString().slice(11, 16))} UTC</span>`
      + `<span>Forecast <b class="mono">${esc(f.forecast ?? '—')}</b></span><span>Previous <b class="mono">${esc(f.previous ?? '—')}</b></span>${a ? `<span>Actual <b class="mono" style="color:#fff">${esc(a)}</b></span>` : ''}`;
    const up = $$('ntUp');
    if (up) up.innerHTML = N.events.filter((e) => e.ts_ms > s.t && e.id !== f.id).slice(0, 4).map((e) => `<div class="u ${e.impact === 'high' ? 'hi' : e.impact === 'medium' ? 'me' : ''}"><span class="t">${esc(clock(e.ts_ms))}</span><span class="n" title="${esc(e.title)}">${esc(e.title)}</span><span class="c">${esc(rel(e.ts_ms - s.t))}</span></div>`).join('') || '<div class="tiny">No further events in the feed.</div>';
    const win = (N.win.before + N.win.after) * 60000, total = st === 'blackout' ? win : 2 * 3600000;
    const prog = st === 'blackout' ? (s.t - (f.ts_ms - N.win.before * 60000)) / win : st === 'soon' ? 1 - (f.ts_ms - s.t) / total : 0;
    $$('ntBar').style.width = Math.min(100, Math.max(0, prog * 100)) + '%';
  }

  /* ---------- reading (rule analysis of the latest release) ---------- */
  function clusters() {
    const by = {};
    N.events.forEach((e) => { const an = effAnalysis(e); if (an && an.status === 'READY') (by[e.ts_ms] = by[e.ts_ms] || []).push({ e, an }); });
    return Object.entries(by).filter(([, v]) => v.length > 1).map(([ts, v]) => { const net = v.reduce((x, i) => x + i.an.score, 0); return { ts: +ts, net, items: v, gold: net > 0 ? 'UP' : net < 0 ? 'DOWN' : 'MIXED' }; });
  }
  const pill = (k, v) => `<span class="bias-pill ${v}">${k} ${v === 'UP' ? '▲' : v === 'DOWN' ? '▼' : '●'} ${v}</span>`;
  function paintReading() {
    const box = $$('ntReading'); if (!box) return;
    const t = now();
    const released = N.events.filter((e) => e.ts_ms <= t && t - e.ts_ms <= 12 * 3600000).sort((a, b) => b.ts_ms - a.ts_ms);
    const withRead = released.find((e) => { const an = effAnalysis(e); return an && an.status === 'READY'; });
    const pending = released.find((e) => !effActual(e));
    let html = '';
    if (withRead) {
      const an = effAnalysis(withRead), cl = clusters().find((c) => c.ts === withRead.ts_ms);
      html += `<div class="tag-row" style="margin:0 0 10px">${pill('USD', an.usd_bias)}${pill('GOLD', an.gold_bias)}<span class="badge ${an.magnitude === 'STRONG' ? 'bad' : an.magnitude === 'MILD' ? 'warn' : ''}">${esc(an.magnitude || '')}</span>${an.vs_previous ? `<span class="badge">vs prev ${esc(an.vs_previous)}</span>` : ''}</div>`;
      html += `<div class="eyebrow" style="margin-bottom:6px">${esc(withRead.title)}</div>`;
      html += `<div class="metric-grid" style="margin-bottom:12px"><div class="metric"><label>ACTUAL</label><strong>${esc(effActual(withRead) ?? '—')}</strong></div><div class="metric"><label>FORECAST</label><strong>${esc(withRead.forecast ?? '—')}</strong></div><div class="metric"><label>PREVIOUS</label><strong>${esc(withRead.previous ?? '—')}</strong></div></div>`;
      html += `<div class="nt-notes"><div class="nt-note ${an.gold_bias === 'DOWN' ? 'dn' : an.gold_bias === 'UP' ? 'up' : ''}">${esc(an.note_km)}<em>${esc(an.note_en)}</em></div>`;
      if (cl) html += `<div class="nt-note ${cl.gold === 'DOWN' ? 'dn' : cl.gold === 'UP' ? 'up' : ''}"><b>NET · ${cl.items.map((i) => esc(i.e.label)).join(' + ')}</b><br>មាស ${cl.gold === 'UP' ? 'ទំនោរឡើង' : cl.gold === 'DOWN' ? 'ទំនោរធ្លាក់' : 'ច្របូកច្របល់ (ទិន្នន័យទាស់គ្នា)'}<em>Net score ${cl.net > 0 ? '+' : ''}${cl.net} (gold-positive = +)</em></div>`;
      if (an.caution_km) html += `<div class="nt-note">⚠ ${esc(an.caution_km)}</div>`;
      html += '</div>';
    } else if (pending) {
      html = `<div class="nt-note"><b>${esc(pending.title)}</b> បានចេញរួចហើយ ប៉ុន្តែគ្មាន Actual ក្នុង feed។<br>បញ្ចូលតម្លៃ Actual ក្នុងតារាងខាងក្រោម (ជួរ ACTUAL) ដើម្បីឲ្យ rule វិភាគ។<em>Released, but this feed has no Actual — type it into the ACTUAL column to run the rule.</em></div>`;
    } else {
      html = `<div class="nt-note">មិនទាន់មាន release ថ្មីៗ (១២ ម៉ោងចុងក្រោយ)។ Rule នឹងវិភាគ Actual vs Forecast vs Previous ភ្លាមៗពេល data ចេញ។<em>No release in the last 12h. The rule engine reads Actual vs Forecast vs Previous the moment data lands.</em></div>`;
    }
    box.innerHTML = html;
  }

  /* ---------- terminal table ---------- */
  function visible() {
    const t = now(), d0 = new Date(); d0.setHours(0, 0, 0, 0);
    return N.events.filter((e) => N.filter === 'high' ? e.impact === 'high' || e.blackout : N.filter === 'today' ? e.ts_ms >= d0.getTime() && e.ts_ms < d0.getTime() + 86400000 : true);
  }
  function actCell(e) {
    const feed = e.actual != null && N.manual[e.id] == null, val = effActual(e);
    if (feed) return `<span class="act">${esc(e.actual)}</span>`;
    if (isQual(e)) return `<span class="act"><select data-act="${esc(e.id)}"><option value="">tone…</option>${['hawkish', 'neutral', 'dovish'].map((x) => `<option value="${x}" ${val === x ? 'selected' : ''}>${x}</option>`).join('')}</select></span>`;
    return `<span class="act"><input data-act="${esc(e.id)}" value="${esc(val ?? '')}" placeholder="actual" inputmode="decimal" autocomplete="off" spellcheck="false"></span>`;
  }
  function reactCell(e) {
    const an = effAnalysis(e);
    if (!an || an.status !== 'READY') return `<span class="rd NEUTRAL">${an && an.status === 'QUALITATIVE' ? 'pick tone' : '—'}</span>`;
    return `<span class="rd ${an.gold_bias}">GOLD ${an.gold_bias === 'DOWN' ? '▼' : an.gold_bias === 'UP' ? '▲' : '●'} ${an.gold_bias} · ${an.magnitude}</span>`;
  }
  function paintTable() {
    const body = $$('ntRows'); if (!body) return;
    const ae = document.activeElement; if (ae && body.contains(ae) && ae.matches('input,select')) return; // never rebuild while the user is typing
    const rows = visible(), s = liveStatus();
    if (!rows.length) { body.innerHTML = `<div class="nt-empty">${N.loaded ? (N.meta.error ? 'Calendar unavailable: ' + esc(N.meta.error) : 'No events for this filter.') : 'Loading calendar…'}</div>`; return; }
    const b = N.win.before * 60000, a = N.win.after * 60000;
    body.innerHTML = '<div class="nt-row hd"><span>TIME</span><span>IMPACT</span><span>T-</span><span>EVENT</span><span>FCST</span><span>PREV</span><span>ACTUAL</span><span>RULE · GOLD</span><span>NOTE</span></div>' + rows.map((e) => {
      const d = e.ts_ms - s.t, inWin = e.blackout && e.ts_ms - b <= s.t && s.t <= e.ts_ms + a, past = d < -a, an = effAnalysis(e);
      return `<div class="nt-row ${inWin ? 'now' : past ? 'past' : s.next && s.next.id === e.id ? 'next' : ''}" data-row="${esc(e.id)}"><span class="mono">${esc(clock(e.ts_ms))} <span class="d tiny">${esc(dayLbl(e.ts_ms))}</span></span><span class="imp ${esc(e.impact)}"><i></i><i></i><i></i></span><span class="cdn mono" data-cd="${esc(e.id)}">${d > 0 ? rel(d) : inWin ? 'LIVE' : '✓'}</span><span class="ttl" title="${esc(e.title)}">${esc(e.title)}</span><span class="mono">${esc(e.forecast ?? '—')}</span><span class="mono">${esc(e.previous ?? '—')}</span><span>${actCell(e)}</span><span data-react="${esc(e.id)}">${reactCell(e)}</span><span class="rd" style="color:#6f8f87" title="${esc(an && an.note_en)}">${esc(an && an.status === 'READY' ? an.note_km : '')}</span></div>`;
    }).join('');
    body.querySelectorAll('[data-act]').forEach((el) => {
      const go = () => setActual(el.dataset.act, el.value.trim());
      el.addEventListener('change', go);
      el.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') { ev.preventDefault(); el.blur(); } });
    });
    const head = $$('ntHead');
    if (head) head.textContent = `calendar · ${N.meta.source || '—'}${N.meta.stale ? ' · STALE' : ''} · ${rows.length}/${N.events.length} events`;
  }
  function tickRows() {
    const s = liveStatus();
    document.querySelectorAll('[data-cd]').forEach((el) => { const e = N.events.find((x) => x.id === el.dataset.cd); if (!e) return; const d = e.ts_ms - s.t; el.textContent = d > 0 ? rel(d) : (e.blackout && -d <= N.win.after * 60000 ? 'LIVE' : '✓'); });
  }

  function log(msg) {
    const box = $$('ntLog'); if (!box) return;
    const div = document.createElement('div'); div.textContent = `[${new Date().toLocaleTimeString([], { hour12: false })}] ${msg}`; box.prepend(div);
    while (box.children.length > 40) box.lastChild.remove();
  }

  async function setActual(id, value) {
    const e = N.events.find((x) => x.id === id); if (!e) return;
    if (!value) { delete N.manual[id]; delete N.manualAn[id]; saveManual(); log(`cleared manual actual · ${e.label}`); return refresh(); }
    N.manual[id] = value; saveManual();
    try {
      N.manualAn[id] = await request('/api/news/analyze', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title: e.title, actual: value, forecast: e.forecast, previous: e.previous }) });
      const an = N.manualAn[id]; log(`${e.label}: actual ${value} vs fcst ${e.forecast ?? '—'} → ${an.status === 'READY' ? `gold ${an.gold_bias} (${an.magnitude})` : an.status}`);
    } catch (err) { toast(err.message); log('analyze failed: ' + err.message); }
    refresh();
  }

  function refresh() { const s = liveStatus(), st = stateOf(s); paintBanner(s, st); paintHero(s, st); paintReading(); paintTable(); paintStrip(s, st); paintPip(st); }

  /* ---------- ICT page strip ---------- */
  function paintStrip(s, st) {
    const el = $$('ictNewsStrip'); if (!el) return; el.className = 'ict-newsstrip ' + (st === 'clear' ? '' : st);
    const f = s.focus;
    if (!f) { el.innerHTML = '<span class="badge">NEWS</span><span class="tiny">No tracked USD event in the calendar.</span>'; return; }
    const d = f.ts_ms - s.t, an = effAnalysis(f);
    el.innerHTML = `<span class="badge ${st === 'blackout' ? 'bad' : st === 'soon' ? 'warn' : ''}">${st === 'blackout' ? 'NEWS BLACKOUT' : st === 'soon' ? 'NEWS SOON' : 'NEXT NEWS'}</span><b>${nm(f)}</b>`
      + (an && an.status === 'READY' ? pill('GOLD', an.gold_bias) : '') + `<span class="tiny">${st === 'blackout' ? 'Signals keep running — the news is weighted heavier. Wait for the first M5/M15 close after the release.' : ''}</span><span class="cd">${d >= 0 ? 'T-' + hms(d) : 'T+' + hms(-d)}</span>`;
  }
  function paintPip(st) { const p = $$('newsPip'); if (!p) return; p.classList.toggle('on', st === 'blackout'); p.textContent = 'LIVE'; }

  /* ---------- data ---------- */
  async function load(force) {
    if (N.busy) return; N.busy = true; const btn = $$('ntRefresh'); if (btn) btn.disabled = true;
    try {
      const data = await request('/api/news/events' + (force ? '?refresh=true' : ''));
      N.events = data.events || []; N.meta = { source: data.source, stale: data.stale, error: data.error, hasActual: data.has_actual_feed };
      N.win = data.status.window_min || N.win; N.offset = data.status.now_ms - Date.now(); N.loaded = true;
      if ($$('ntWinBadge')) $$('ntWinBadge').textContent = `−${N.win.before} / +${N.win.after} min window`;
      log(`feed ${data.stale ? 'STALE' : 'ok'} · ${data.source || 'none'} · ${N.events.length} USD events${data.has_actual_feed ? ' · actuals from feed' : ' · no actual in feed → type it in manually'}${data.error ? ' · ' + data.error : ''}`);
      const need = N.events.filter((e) => N.manual[e.id] && !N.manualAn[e.id]);
      await Promise.all(need.map((e) => request('/api/news/analyze', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title: e.title, actual: N.manual[e.id], forecast: e.forecast, previous: e.previous }) }).then((a) => { N.manualAn[e.id] = a; }).catch(() => {})));
      const note = $$('ntSourceNote');
      if (note) note.innerHTML = data.has_actual_feed ? 'Source: <b>Finnhub</b> — Actual values arrive automatically.' : 'Source: <b>Forex Factory</b> (free, unofficial) — it has Forecast/Previous only. Type the Actual in the table, or set <code>FINNHUB_API_KEY</code> for automatic Actuals.';
    } catch (err) {
      N.loaded = true; N.meta = { error: err.message, stale: true }; log('feed error: ' + err.message);
    } finally { N.busy = false; if (btn) btn.disabled = false; refresh(); }
  }

  function wire() {
    $$('ntRefresh')?.addEventListener('click', () => { load(true); toast('Refreshing calendar…'); });
    document.querySelectorAll('#ntFilter button').forEach((b) => b.addEventListener('click', () => { N.filter = b.dataset.f; document.querySelectorAll('#ntFilter button').forEach((x) => x.classList.toggle('on', x === b)); paintTable(); }));
    $$('nbGo')?.addEventListener('click', () => navTo('news'));
  }

  function boot() {
    wire(); paintClock(); refresh();
    load(false);
    setInterval(() => { paintClock(); const s = liveStatus(), st = stateOf(s); paintBanner(s, st); paintHero(s, st); paintStrip(s, st); paintPip(st); tickRows(); }, 1000);
    setInterval(() => { if (!document.hidden) load(false); }, 60000);
    setInterval(paintReading, 15000);
  }
  window.newsOpen = () => { if (N.loaded) refresh(); };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else boot();
})();
