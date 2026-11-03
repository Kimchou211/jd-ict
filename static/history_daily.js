/* Signal History: live Result column (auto TP1/TP2/SL) + daily win-rate panel. */
(function () {
  const hm = (iso) => { try { return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false }); } catch (e) { return ''; } };
  const sym = (r) => (r.symbol && r.symbol !== 'XAUUSD' ? ` <span class="tiny">${escapeHtml(r.symbol)}</span>` : '');

  window.resultCell = function (r) {
    const a = r.analysis || {}, o = a.outcome, t = a.ict_track || a.track || {};
    if (o && o.result) {
      const win = o.result === 'TP1' || o.result === 'TP2', rr = typeof o.r === 'number' && o.result !== 'SKIP' ? ` <span class="tiny">${o.r > 0 ? '+' : ''}${o.r}R</span>` : '';
      const when = o.at ? ` <span class="tiny">${hm(o.at)}${o.auto ? ' · auto' : ''}</span>` : '';
      return `<span class="badge ${win ? 'good' : o.result === 'SL' ? 'warn' : ''}">${win ? '✔ ' : o.result === 'SL' ? '✖ ' : ''}${o.result === 'SKIP' ? 'not taken' : o.result + (win ? ' HIT' : ' HIT')}</span>${rr}${when}${sym(r)}`;
    }
    if (r.direction !== 'BUY' && r.direction !== 'SELL') return '<span class="tiny">—</span>';
    if (r.stop_loss == null) return '<span class="tiny">no levels</span>';
    if (t.state === 'FILLED') return `<span class="badge">● RUNNING</span> <span class="tiny">since ${hm(t.filled_ms)}</span>${sym(r)}`;
    return `<span class="badge">◌ WAITING</span> <span class="tiny">auto-tracking</span>${sym(r)}`;
  };

  const pct = (v) => (v == null ? '—' : v + '%');
  async function loadDaily() {
    const box = document.getElementById('dailyBody'); if (!box) return;
    try {
      const d = await request('/api/stats/daily?days=14&tz_offset_min=' + (-new Date().getTimezoneOffset()));
      const t = d.today || {};
      document.getElementById('dailyToday').innerHTML = `<div class="metric"><label>Today win rate</label><strong style="font-size:26px;color:${t.win_rate == null ? 'inherit' : t.win_rate >= 50 ? 'var(--green)' : 'var(--red)'}">${pct(t.win_rate)}</strong><small>${t.wins || 0} win · ${t.sl || 0} loss · ${t.resolved || 0} closed</small></div>
        <div class="metric"><label>Today results</label><strong>${t.tp1 || 0} TP1 · ${t.tp2 || 0} TP2 · ${t.sl || 0} SL</strong><small>${t.open || 0} open · ${t.not_taken || 0} not taken</small></div>
        <div class="metric"><label>Today total R</label><strong style="color:${(t.total_r || 0) >= 0 ? 'var(--green)' : 'var(--red)'}">${(t.total_r || 0) > 0 ? '+' : ''}${t.total_r || 0}R</strong><small>${t.signals || 0} signals today</small></div>`;
      box.innerHTML = d.days.length ? d.days.map((x) => `<tr><td>${x.date}</td><td>${x.signals}</td><td>${x.tp1}</td><td>${x.tp2}</td><td>${x.sl}</td><td>${x.open}</td><td><strong style="color:${x.win_rate == null ? 'inherit' : x.win_rate >= 50 ? 'var(--green)' : 'var(--red)'}">${pct(x.win_rate)}</strong></td><td>${x.total_r > 0 ? '+' : ''}${x.total_r}R</td></tr>`).join('') : '<tr><td colspan="8" class="empty">No signals yet.</td></tr>';
    } catch (e) { box.innerHTML = `<tr><td colspan="8" class="empty">Could not load daily stats: ${escapeHtml(e.message)}</td></tr>`; }
  }
  const base = window.loadHistory;
  window.loadHistory = async function () { await base(); loadDaily(); };
  setInterval(() => { if (document.getElementById('page-history')?.classList.contains('active') && !document.hidden) window.loadHistory(); }, 45000);
})();
