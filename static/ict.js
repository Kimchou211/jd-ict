/* JD ANALYSIS · ICT Terminal — candlestick canvas with zoom/pan and engine-drawn ICT layers. */
(function () {
  const COLORS = { bull: '#5dd6a0', bear: '#ff6f79', liq: '#e8b85a', liq2: '#e8b85a', muted: '#7b8aa0', info: '#6baaff', text: '#cfd9e6', grid: '#16202e', bg: '#080d15' };
  const S = {
    symbol: 'XAUUSD', tf: 'M5', bars: [], analysis: null, drawings: [], busy: false, hidden: false,
    layers: { liquidity: true, range: true, structure: true, zones: true, plan: true },
    vis: 90, end: null, yShift: 0, future: 34, pointers: new Map(), drag: null, loaded: false,
  };
  const $$ = (id) => document.getElementById(id);
  const esc = (s) => escapeHtml(s);
  const px = (v, d = 2) => (typeof v === 'number' && isFinite(v) ? v.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d }) : '—');
  const tfMs = () => ({ M1: 60, M5: 300, M15: 900 }[S.tf] || 300) * 1000;

  /* ---------- geometry ---------- */
  function tsToIdx(ts) {
    const b = S.bars; if (!b.length) return 0;
    const first = b[0].timestamp_ms, last = b[b.length - 1].timestamp_ms;
    if (ts >= last) return b.length - 1 + (ts - last) / tfMs();
    if (ts <= first) return (ts - first) / tfMs();
    let lo = 0, hi = b.length - 1;
    while (hi - lo > 1) { const m = (lo + hi) >> 1; if (b[m].timestamp_ms <= ts) lo = m; else hi = m; }
    return lo + (ts - b[lo].timestamp_ms) / (b[hi].timestamp_ms - b[lo].timestamp_ms);
  }
  function view(w, h) {
    const L = 8, R = 70, T = 12, B = 24, pw = w - L - R, ph = h - T - B;
    const end = S.end == null ? S.bars.length - 1 + S.future : S.end, left = end - S.vis;
    let lo = Infinity, hi = -Infinity;
    for (let i = Math.max(0, Math.floor(left)); i <= Math.min(S.bars.length - 1, Math.ceil(end)); i++) { lo = Math.min(lo, S.bars[i].low); hi = Math.max(hi, S.bars[i].high); }
    const plan = S.layers.plan && !S.hidden && S.drawings.find((d) => d.type === 'plan');
    if (plan) { lo = Math.min(lo, plan.tp1, plan.stop); hi = Math.max(hi, plan.tp1, plan.stop); }
    if (!isFinite(lo)) { lo = 0; hi = 1; }
    const pad = (hi - lo) * 0.08 || 1; lo -= pad; hi += pad;
    const shift = S.yShift; lo += shift; hi += shift;
    return { L, R, T, B, pw, ph, w, h, left, end, lo, hi, x: (i) => L + ((i - left) / S.vis) * pw, y: (p) => T + ((hi - p) / (hi - lo)) * ph };
  }

  /* ---------- drawing ---------- */
  function chip(ctx, text, x, y, fg, bg, align = 'left', border = null) {
    ctx.font = '600 11px Inter, Segoe UI, Arial'; const w = ctx.measureText(text).width + 10, h = 17;
    const x0 = align === 'right' ? x - w : align === 'center' ? x - w / 2 : x;
    ctx.fillStyle = bg; ctx.beginPath(); ctx.roundRect(x0, y - h / 2, w, h, 4); ctx.fill();
    if (border) { ctx.strokeStyle = border; ctx.lineWidth = 1.2; ctx.stroke(); }
    ctx.fillStyle = fg; ctx.textBaseline = 'middle'; ctx.fillText(text, x0 + 5, y + 0.5);
  }
  function hline(ctx, v, p, x1, x2, color, style, width = 1) {
    const y = v.y(p); if (y < v.T - 2 || y > v.h - v.B + 2) return;
    ctx.save(); ctx.strokeStyle = color; ctx.lineWidth = width; ctx.setLineDash(style === 'dashed' ? [6, 4] : style === 'dotted' ? [2, 4] : []);
    ctx.beginPath(); ctx.moveTo(Math.max(v.L, x1), y); ctx.lineTo(Math.min(v.w - v.R, x2), y); ctx.stroke(); ctx.restore(); return y;
  }
  function niceStep(range, n) { const raw = range / n, p = Math.pow(10, Math.floor(Math.log10(raw))), f = raw / p; return (f < 1.5 ? 1 : f < 3.5 ? 2 : f < 7.5 ? 5 : 10) * p; }

  function draw() {
    const cv = $$('ictCanvas'); if (!cv) return;
    const wrap = cv.parentElement, dpr = window.devicePixelRatio || 1, w = wrap.clientWidth, h = wrap.clientHeight;
    if (!w || !h) return;
    if (cv.width !== w * dpr || cv.height !== h * dpr) { cv.width = w * dpr; cv.height = h * dpr; }
    const ctx = cv.getContext('2d'); ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.fillStyle = COLORS.bg; ctx.fillRect(0, 0, w, h);
    if (!S.bars.length) { ctx.fillStyle = '#7b8aa0'; ctx.font = '13px Inter, Arial'; ctx.fillText('Loading candles…', 20, 30); return; }
    const v = view(w, h), tms = tfMs();
    // grid + price axis
    ctx.font = '11px Inter, Segoe UI, Arial'; ctx.textBaseline = 'middle';
    const step = niceStep(v.hi - v.lo, 8);
    for (let p = Math.ceil(v.lo / step) * step; p < v.hi; p += step) {
      const y = v.y(p); ctx.strokeStyle = COLORS.grid; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(v.L, y); ctx.lineTo(w - v.R, y); ctx.stroke();
      ctx.fillStyle = '#8496ad'; ctx.fillText(px(p, step < 1 ? 2 : 0), w - v.R + 8, y);
    }
    const tickEvery = Math.max(1, Math.round(S.vis / 7));
    for (let i = Math.ceil(v.left / tickEvery) * tickEvery; i < v.end; i += tickEvery) {
      if (i < 0 || i >= S.bars.length) continue; const x = v.x(i), d = new Date(S.bars[Math.round(i)].timestamp_ms);
      ctx.strokeStyle = COLORS.grid; ctx.beginPath(); ctx.moveTo(x, v.T); ctx.lineTo(x, v.h - v.B); ctx.stroke();
      ctx.fillStyle = '#8496ad'; ctx.textAlign = 'center'; ctx.fillText(d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false }), x, v.h - 10); ctx.textAlign = 'left';
    }
    ctx.save(); ctx.beginPath(); ctx.rect(v.L, v.T, v.pw, v.ph); ctx.clip();
    const on = (layer) => !S.hidden && S.layers[layer];
    const rightEdge = v.w - v.R;
    // zones (behind candles)
    if (on('zones')) for (const d of S.drawings.filter((d) => d.type === 'box')) {
      const x1 = v.x(tsToIdx(d.ts1)), x2 = d.ts2 ? v.x(tsToIdx(d.ts2)) : rightEdge, y1 = v.y(d.p1), y2 = v.y(d.p2), c = d.tone === 'bull' ? COLORS.bull : COLORS.bear;
      ctx.fillStyle = c + '26'; ctx.fillRect(x1, y1, x2 - x1, y2 - y1); ctx.strokeStyle = c + '88'; ctx.lineWidth = 1; ctx.strokeRect(x1, y1, x2 - x1, y2 - y1);
      chip(ctx, d.label, Math.max(v.L + 2, x1 + 2), y1 + 10, '#0b121d', c + 'dd');
    }
    // candles
    const cw = Math.max(1, (v.pw / S.vis) * 0.7);
    for (let i = Math.max(0, Math.floor(v.left) - 1); i < S.bars.length && i <= v.end + 1; i++) {
      const b = S.bars[i], x = v.x(i), up = b.close >= b.open, c = up ? COLORS.bull : COLORS.bear;
      ctx.strokeStyle = c; ctx.fillStyle = c; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(x, v.y(b.high)); ctx.lineTo(x, v.y(b.low)); ctx.stroke();
      const yo = v.y(b.open), yc = v.y(b.close); ctx.fillRect(x - cw / 2, Math.min(yo, yc), cw, Math.max(1, Math.abs(yc - yo)));
    }
    // range + liquidity lines
    for (const d of S.drawings.filter((d) => d.type === 'hline' && (d.layer === 'liquidity' || d.layer === 'range'))) {
      if (!on(d.layer)) continue; const x1 = v.x(tsToIdx(d.ts1)), x2 = d.ts2 ? v.x(tsToIdx(d.ts2)) : rightEdge, c = COLORS[d.tone] || COLORS.muted;
      const y = hline(ctx, v, d.p1, x1, x2, c, d.style, d.layer === 'range' && d.tone === 'muted' ? 1 : 1.3);
      if (y != null && d.label) { ctx.fillStyle = c; ctx.font = '10.5px Inter, Segoe UI, Arial'; ctx.textAlign = 'left'; ctx.fillText(d.label, Math.max(v.L + 4, Math.min(x1, rightEdge - 150)) + 2, y - 7); }
    }
    // structure
    if (on('structure')) {
      for (const d of S.drawings.filter((d) => d.type === 'swing')) {
        const x = v.x(tsToIdx(d.ts)), y = v.y(d.p1) + (d.side === 'high' ? -9 : 9); ctx.fillStyle = '#b9bff866'; ctx.strokeStyle = '#b9bffaaa'; ctx.lineWidth = 1; ctx.fillRect(x - 4, y - 4, 8, 8); ctx.strokeRect(x - 4, y - 4, 8, 8);
      }
      for (const d of S.drawings.filter((d) => d.type === 'hline' && d.layer === 'structure')) {
        const x1 = v.x(tsToIdx(d.ts1)), x2 = v.x(tsToIdx(d.ts2)), c = d.tone === 'bull' ? COLORS.bull : COLORS.bear, y = hline(ctx, v, d.p1, x1, x2, c, 'solid', 1.4);
        if (y != null) chip(ctx, d.label, (x1 + x2) / 2, y + (d.tone === 'bull' ? 10 : 10), '#fff', c + 'dd', 'center');
      }
    }
    // sweeps
    if (on('liquidity')) for (const d of S.drawings.filter((d) => d.type === 'tag')) {
      const x = v.x(tsToIdx(d.ts)), y = v.y(d.p1) + (d.pos === 'above' ? -14 : 14); chip(ctx, d.label, x, y, '#1b1405', COLORS.liq, 'center');
    }
    // plan
    const plan = on('plan') && S.drawings.find((d) => d.type === 'plan');
    if (plan) drawPlan(ctx, v, plan);
    ctx.restore();
    // last price chip
    const last = S.bars[S.bars.length - 1], up = last.close >= last.open;
    hline(ctx, v, last.close, v.L, rightEdge, up ? COLORS.bull : COLORS.bear, 'dotted', 1);
    chip(ctx, px(last.close), w - v.R + 2, v.y(last.close), '#fff', up ? '#1f8a62' : '#d6454f');
    ctx.fillStyle = '#92a1b5'; ctx.font = '11px Inter, Arial'; ctx.fillText(`${S.symbol} · ${S.tf}`, v.L + 8, v.T + 8);
  }

  function drawPlan(ctx, v, p) {
    const x0 = v.x(tsToIdx(p.ts_start)), x1 = x0 + (v.pw / S.vis) * p.bars_ahead, xm = (x0 + x1) / 2, bear = p.direction === 'bear';
    const yE = v.y(p.entry), yS = v.y(p.stop), y1 = v.y(p.tp1), y2 = v.y(p.tp2);
    ctx.fillStyle = 'rgba(255,111,121,.28)'; ctx.fillRect(x0, Math.min(yE, yS), x1 - x0, Math.abs(yS - yE));
    ctx.fillStyle = 'rgba(93,214,160,.26)'; ctx.fillRect(x0, Math.min(yE, y1), x1 - x0, Math.abs(y1 - yE));
    ctx.fillStyle = 'rgba(93,214,160,.12)'; ctx.fillRect(x0, Math.min(y1, y2), x1 - x0, Math.abs(y2 - y1));
    ctx.fillStyle = 'rgba(232,184,90,.28)'; const zy1 = v.y(p.entry_high), zy2 = v.y(p.entry_low); ctx.fillRect(x0, zy1, x1 - x0, Math.max(2, zy2 - zy1));
    ctx.save(); ctx.strokeStyle = '#ffffffcc'; ctx.setLineDash([6, 5]); ctx.lineWidth = 1.2; ctx.beginPath(); ctx.moveTo(xm, yE); ctx.lineTo(x0, y1); ctx.moveTo(xm, yE); ctx.lineTo(x1, y1); ctx.stroke(); ctx.restore();
    const rows = [[p.stop, 'Stop', COLORS.bear, 'solid'], [p.entry, 'Entry', '#6baaff', 'solid'], [p.tp1, 'TP1', COLORS.bull, 'dashed'], [p.tp2, 'TP2', COLORS.bull, 'dotted']];
    for (const [price, name, c, st] of rows) { hline(ctx, v, price, x0, x1, c, st, 1.4); chip(ctx, `${name} ${px(price)}`, x1 + 2, v.y(price), c, '#0b121df0', 'left', c); }
    chip(ctx, `R:R ${p.rr1}`, xm, yE, '#cfe8ff', '#0b1a2b', 'center', '#6baaff');
    chip(ctx, `${bear ? 'SELL' : 'BUY'} · ${(p.status || '').replace(/_/g, ' ')}`, x0 + 4, (bear ? Math.min(yE, yS) : Math.max(yE, yS)) + (bear ? -10 : 10), '#fff', bear ? '#d6454fcc' : '#1f8a62cc');
  }

  /* ---------- interaction ---------- */
  function bind() {
    const cv = $$('ictCanvas'); if (!cv || cv.dataset.bound) return; cv.dataset.bound = '1';
    cv.style.touchAction = 'none';
    cv.addEventListener('wheel', (e) => {
      e.preventDefault(); const r = cv.getBoundingClientRect(), v = view(r.width, r.height), mx = e.clientX - r.left;
      const idx = v.left + ((mx - v.L) / v.pw) * S.vis, nv = Math.max(20, Math.min(400, S.vis * (1 + Math.sign(e.deltaY) * 0.12)));
      S.end = idx - ((mx - v.L) / v.pw) * nv + nv; S.vis = nv; draw();
    }, { passive: false });
    cv.addEventListener('pointerdown', (e) => { cv.setPointerCapture(e.pointerId); S.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY }); S.drag = { x: e.clientX, y: e.clientY, pinch: null }; });
    cv.addEventListener('pointermove', (e) => {
      if (!S.pointers.has(e.pointerId)) return; const r = cv.getBoundingClientRect(), v = view(r.width, r.height);
      S.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (S.pointers.size === 2) {
        const [a, b] = [...S.pointers.values()], d = Math.hypot(a.x - b.x, a.y - b.y);
        if (S.drag.pinch) { S.vis = Math.max(20, Math.min(400, S.vis * (S.drag.pinch / d))); draw(); } S.drag.pinch = d; return;
      }
      const dx = e.clientX - S.drag.x, dy = e.clientY - S.drag.y; S.drag.x = e.clientX; S.drag.y = e.clientY;
      S.end = (S.end == null ? S.bars.length - 1 + S.future : S.end) - (dx / v.pw) * S.vis;
      S.end = Math.max(S.vis * 0.4, Math.min(S.bars.length + S.future + 60, S.end)); S.yShift += (dy / v.ph) * (v.hi - v.lo); draw();
    });
    const up = (e) => { S.pointers.delete(e.pointerId); if (S.drag) S.drag.pinch = null; };
    cv.addEventListener('pointerup', up); cv.addEventListener('pointercancel', up);
    cv.addEventListener('dblclick', () => { S.end = null; S.yShift = 0; S.vis = 90; draw(); });
    window.addEventListener('resize', draw);
  }

  /* ---------- data ---------- */
  async function loadCandles(quiet) {
    try {
      const data = await request('/api/ict/candles?tf=' + S.tf + '&symbol=' + S.symbol); S.bars = data.bars; updateFeed(data.feed); draw();
    } catch (e) { if (!quiet) toast(e.message); $$('ictFeedBadge').textContent = 'FEED ERROR'; $$('ictFeedBadge').className = 'badge warn'; }
  }
  function updateFeed(f) {
    if (!f) return; const b = $$('ictFeedBadge');
    b.textContent = f.market_closed ? 'MARKET CLOSED · last session' : f.is_stale ? `STALE · ${Math.round(f.age_seconds / 60)} min old` : 'LIVE FEED';
    b.className = 'badge ' + (f.market_closed || f.is_stale ? 'warn' : 'good');
    $$('ictSource').textContent = `${f.source} · last candle ${new Date(f.last_bar_time).toLocaleString()}` + (f.fallback_reason ? ` · fallback: ${f.fallback_reason}` : '');
  }

  async function analyze() {
    if (S.busy) return; S.busy = true; const btn = $$('ictAnalyzeBtn'); btn.disabled = true; $$('ictProgress').classList.add('show');
    try {
      const data = await request('/api/ict/scan?tf=' + S.tf + '&symbol=' + S.symbol + '&ai=' + ($$('ictAi').checked ? 'true' : 'false'), { method: 'POST' });
      show(data.analysis, data); await loadCandles(true);
      toast(data.history_saved === false ? 'Scan complete, but history could not be saved.' : 'ICT scan complete.');
    } catch (e) { toast(e.message); } finally { S.busy = false; btn.disabled = false; $$('ictProgress').classList.remove('show'); }
  }

  /* ---------- panels ---------- */
  function show(a, rec) {
    if (a.symbol && a.symbol !== S.symbol) { S.symbol = a.symbol; $$('ictSymbol').value = a.symbol; } S.analysis = a; S.drawings = a.drawings || []; if (a.bars && (!S.bars.length || S.tf !== a.ltf)) { S.tf = a.ltf; S.bars = a.bars; $$('ictTf').value = a.ltf; }
    updateFeed(a.feed); $$('ictPills').querySelector('[data-ai]').firstElementChild.textContent = `AI · ${S.drawings.length} drawings`;
    const dir = a.final_direction || a.direction || 'WAIT', cls = dir === 'BUY' ? 'BUY' : dir === 'SELL' ? 'SELL' : 'WAIT';
    $$('ictDirection').textContent = dir; $$('ictDirection').className = 'live-direction ' + cls;
    $$('ictAction').textContent = a.plan && dir !== 'WAIT' ? `${(a.plan_status || '').replace(/_/g, ' ')} · limit entry inside the zone, never chase` : (a.verdict_notes || []).concat(a.reasons || []).slice(0, 1).join(' ') || 'No valid setup.';
    $$('ictConf').textContent = a.final_confidence ?? a.confluence_score ?? '—'; $$('ictConfMeter').style.width = (a.final_confidence ?? 0) + '%';
    $$('ictStatusBadge').textContent = (a.verdict_status || 'ENGINE').replace(/_/g, ' '); $$('ictStatusBadge').className = 'badge ' + (dir === 'WAIT' ? 'warn' : 'good');
    const p = a.plan, ok = p && dir !== 'WAIT';
    const set = (id, v, d = 2) => ($$(id).textContent = ok ? px(v, d) : '—');
    if (p) { set('ictEntryLo', p.entry_low); set('ictEntryHi', p.entry_high); set('ictSL', p.stop); set('ictTP1', p.tp1); set('ictTP2', p.tp2); $$('ictRR').textContent = ok ? `${p.rr1} / ${p.rr2}` : '—'; $$('ictRisk').textContent = ok ? `${px(p.risk)} pts` : '—'; $$('ictTpBasis').textContent = ok ? `TP1: ${p.tp1_basis} · TP2: ${p.tp2_basis}` : ''; }
    else ['ictEntryLo', 'ictEntryHi', 'ictSL', 'ictTP1', 'ictTP2', 'ictRR', 'ictRisk'].forEach((id) => ($$(id).textContent = '—'));
    const st = a.structure || {}, tr = (t) => (t ? (t === 'bull' ? '▲ bullish' : '▼ bearish') : '— none');
    $$('ictBias').innerHTML = [
      ['HTF bias', `<b class="${a.bias?.label === 'BULLISH' ? 'g' : a.bias?.label === 'BEARISH' ? 'r' : ''}">${esc(a.bias?.label || '—')}</b>`], ['H1 structure', tr(st.H1?.trend)], ['M15 structure', tr(st.M15?.trend)],
      [`${a.ltf} structure`, tr(st[a.ltf]?.trend)], ['Dealing range', `${esc(a.pd?.zone || '—')} (${a.pd?.pct ?? '—'}%)`], ['CRT (H1)', esc((a.crt?.state || '—').replace(/_/g, ' '))],
      ['Session', `${esc((a.session?.name || '').replace(/_/g, ' '))}${a.session?.in_killzone ? ' · kill zone' : ''}`], ['ATR 14', px(a.atr, 3)]].map(([k, v]) => `<div class="kv"><span>${k}</span><span>${v}</span></div>`).join('');
    $$('ictReasons').innerHTML = (a.reasons || []).map((r) => `<li>${esc(r)}</li>`).join('') || '<li>No reasons.</li>';
    $$('ictSetups').innerHTML = (a.setups || []).map((s) => `<div class="metric"><label>${esc(s.id)} · ${esc(s.action)} · ${esc(s.status.replace(/_/g, ' '))}</label><strong>${s.score}/100</strong><small>${esc(s.arrays.join(' + '))} · RR ${s.plan.rr1} · sweep ${esc(s.sweep.kind)}</small></div>`).join('') || '<div class="tiny">No sweep → MSS sequence found in the lookback window.</div>';
    const r = a.ai_review, vv = a.ai_validation;
    let html;
    if (!r) html = '<div class="tiny">AI mentor was switched off for this scan.</div>';
    else if (!r.ok) html = `<div class="tiny">${esc(r.message || 'AI unavailable.')}</div>`;
    else html = `<div class="tag-row" style="margin:0 0 8px"><span class="badge ${r.verdict === 'APPROVE' ? 'good' : 'warn'}">${esc(r.verdict)} · ${esc(r.direction)} · ${r.confidence}%</span><span class="badge">${esc(r.selected_setup || 'NONE')}</span>${vv && !vv.accepted ? '<span class="badge warn">DISCARDED BY VALIDATOR</span>' : '<span class="badge good">VALIDATED</span>'}</div>
      <div class="bodycopy">${esc(r.narrative)}</div><div class="live-risk-note"><b>Confirm:</b> ${esc(r.confirmation)}<br><b>Invalidation:</b> ${esc(r.invalidation)}<br><b>Risk:</b> ${esc(r.risk_note)}${vv && vv.issues.length ? '<br><b style="color:var(--red)">Validator:</b> ' + esc(vv.issues.join('; ')) : ''}</div>`;
    if ((a.verdict_notes || []).length) html += `<div class="live-risk-note">${a.verdict_notes.map(esc).join('<br>')}</div>`;
    $$('ictAI').innerHTML = html;
    $$('ictSaved').textContent = rec && rec.id ? `Saved to Signal History · ID #${rec.id}. Auto-tracking will mark TP/SL for this plan.` : 'Not saved to history.';
    draw();
  }

  /* ---------- wiring ---------- */
  function wire() {
    $$('ictSymbol').addEventListener('change', async (e) => { S.symbol = e.target.value; $$('ictSymLabel').textContent = e.target.selectedOptions[0].dataset.label; S.bars = []; S.analysis = null; S.drawings = []; S.end = null; draw(); await loadCandles(); });
    $$('ictTf').addEventListener('change', async (e) => { S.tf = e.target.value; S.bars = []; S.analysis = null; S.drawings = []; S.end = null; draw(); await loadCandles(); });
    $$('ictRefreshBtn').addEventListener('click', () => loadCandles());
    $$('ictAnalyzeBtn').addEventListener('click', analyze);
    $$('ictPills').querySelectorAll('[data-layer]').forEach((b) => b.addEventListener('click', () => { const l = b.dataset.layer; S.layers[l] = !S.layers[l]; b.classList.toggle('on', S.layers[l]); draw(); }));
    $$('ictPills').querySelector('[data-ai]').addEventListener('click', (e) => {
      if (e.target.dataset.clear != null) { S.drawings = []; $$('ictPills').querySelector('[data-ai]').firstElementChild.textContent = 'AI · 0 drawings'; draw(); return; }
      S.hidden = !S.hidden; e.currentTarget.classList.toggle('on', !S.hidden); draw();
    });
    $$('ictResetView').addEventListener('click', () => { S.end = null; S.yShift = 0; S.vis = 90; draw(); });
  }
  window.ictOpen = function () { bind(); if (!S.loaded) { S.loaded = true; wire(); } loadCandles(); setTimeout(draw, 50); };
  window.ictShow = function (a) { bind(); if (!S.loaded) { S.loaded = true; wire(); } S.symbol = a.symbol || 'XAUUSD'; $$('ictSymbol').value = S.symbol; S.tf = a.ltf || 'M5'; $$('ictTf').value = S.tf; S.bars = a.bars || []; show(a, null); setTimeout(draw, 50); };
  setInterval(() => { if ($$('page-ict')?.classList.contains('active') && !document.hidden) loadCandles(true); }, 20000);
})();
