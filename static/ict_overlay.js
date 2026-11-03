/* Screenshot analyzer overlay: ICT-aware drawing + layer filter pills + Entry/Stop/TP box with R:R.
   Replaces the old drawOverlay(). ICT marks come from the vision model (approximate placement);
   the Entry/Stop/TP box is placed from the readable price axis when it is verified. */
(function () {
  const C = { bos: '#e8744a', mss: '#b565ff', sweep: '#e8b85a', fvg: '#6baaff', ob: '#b565ff', liq: '#e8b85a', crt: '#cfe3ff', bull: '#5dd6a0', bear: '#ff6f79', legacy: '#54d8c8' };
  const LAYERS = ['liquidity', 'range', 'structure', 'zones', 'plan'];
  const L = { liquidity: true, range: true, structure: true, zones: true, plan: true };
  const STATE = {};           // canvasId -> {imgId, read, analysis, count}
  let hidden = false;

  function chip(ctx, text, x, y, fg, bg, fs, align) {
    ctx.font = `700 ${fs}px Segoe UI, Arial`; const w = ctx.measureText(text).width + fs * 0.8, h = fs * 1.45, x0 = align === 'center' ? x - w / 2 : align === 'right' ? x - w : x;
    ctx.fillStyle = bg; ctx.beginPath(); ctx.roundRect(x0, y - h / 2, w, h, fs * 0.28); ctx.fill(); ctx.fillStyle = fg; ctx.textBaseline = 'middle'; ctx.fillText(text, x0 + fs * 0.4, y + 1);
  }
  const layerOf = (a) => a.layer || (a.type === 'price_line' ? 'plan' : 'structure');

  function render(id) {
    const st = STATE[id]; if (!st) return; const img = document.getElementById(st.imgId), canvas = document.getElementById(id); if (!img || !canvas || !img.naturalWidth) return;
    canvas.width = img.naturalWidth; canvas.height = img.naturalHeight;
    const ctx = canvas.getContext('2d'), W = canvas.width, H = canvas.height, fs = Math.max(13, W / 75), lw = Math.max(2, W / 900), read = st.read, scale = read?.price_scale;
    ctx.clearRect(0, 0, W, H); ctx.lineCap = 'round'; ctx.lineJoin = 'round'; ctx.textBaseline = 'alphabetic';
    const px = (v) => Number(v) / 1000 * W, py = (v) => Number(v) / 1000 * H;
    const on = (a) => !hidden && L[layerOf(a)];
    let count = 0; const price = {};
    for (const a of (read?.annotations || [])) {
      if (a.type === 'price_line') { const k = String(a.label || '').toUpperCase().split(' ')[0]; if (scale?.verified && a.price >= scale.bottom && a.price <= scale.top) price[k] = a.price; continue; }
      if (!on(a)) continue; count++; ctx.save();
      const ict = a.ict, label = String(a.label || ict || '').slice(0, 40);
      if (a.type === 'line') {
        const c = ict === 'BOS' ? C.bos : ict === 'MSS' ? C.mss : /^(CRT)/.test(ict || '') ? C.crt : ict ? C.liq : C.legacy;
        ctx.strokeStyle = c; ctx.lineWidth = lw; ctx.setLineDash(ict === 'BOS' || ict === 'MSS' ? [] : [W / 120, W / 160]);
        ctx.beginPath(); ctx.moveTo(px(a.x1), py(a.y1)); ctx.lineTo(px(a.x2), py(a.y2)); ctx.stroke(); ctx.setLineDash([]);
        if (ict === 'BOS' || ict === 'MSS') chip(ctx, ict, (px(a.x1) + px(a.x2)) / 2, (py(a.y1) + py(a.y2)) / 2 + fs * 0.9, '#fff', c, fs, 'center');
        else if (label) { ctx.fillStyle = c; ctx.font = `600 ${fs * 0.9}px Segoe UI, Arial`; ctx.fillText(label, px(a.x1) + 4, Math.max(16, py(a.y1) - 6)); }
      } else if (a.type === 'rect') {
        const c = ict === 'OB' ? C.ob : ict ? C.fvg : C.legacy; ctx.fillStyle = c + '30'; ctx.strokeStyle = c + 'cc'; ctx.lineWidth = lw;
        ctx.fillRect(px(a.x), py(a.y), px(a.w), py(a.h)); ctx.strokeRect(px(a.x), py(a.y), px(a.w), py(a.h)); if (label) chip(ctx, label, px(a.x) + 3, py(a.y) + fs * 0.9, '#0b121d', c + 'ee', fs * 0.85);
      } else if (a.type === 'text') {
        if (ict === 'SWEEP') { chip(ctx, label || 'Sweep', px(a.x), py(a.y), '#1b1405', C.sweep, fs, 'center'); }
        else if (ict === 'SWING') { ctx.fillStyle = '#b9bffa99'; ctx.fillRect(px(a.x) - fs / 3, py(a.y) - fs / 3, fs * 0.66, fs * 0.66); }
        else { ctx.fillStyle = '#f1d58f'; ctx.font = `700 ${fs}px Segoe UI, Arial`; ctx.fillText(label, px(a.x), py(a.y)); }
      }
      ctx.restore();
    }
    // Plan box from verified price axis
    if (!hidden && L.plan && price.ENTRY != null && price.SL != null && price.TP1 != null) {
      const y = (p) => (scale.top - p) / (scale.top - scale.bottom) * H, x0 = W * 0.66, x1 = W * 0.93, xm = (x0 + x1) / 2, e = price.ENTRY, sl = price.SL, t1 = price.TP1, t2 = price.TP2;
      const risk = Math.abs(e - sl), rr = risk ? Math.abs(t1 - e) / risk : 0; count += 4; ctx.save();
      ctx.fillStyle = 'rgba(255,111,121,.30)'; ctx.fillRect(x0, Math.min(y(e), y(sl)), x1 - x0, Math.abs(y(sl) - y(e)));
      ctx.fillStyle = 'rgba(93,214,160,.28)'; ctx.fillRect(x0, Math.min(y(e), y(t1)), x1 - x0, Math.abs(y(t1) - y(e)));
      if (t2 != null) { ctx.fillStyle = 'rgba(93,214,160,.12)'; ctx.fillRect(x0, Math.min(y(t1), y(t2)), x1 - x0, Math.abs(y(t2) - y(t1))); }
      ctx.strokeStyle = '#ffffffcc'; ctx.lineWidth = lw * 0.7; ctx.setLineDash([W / 150, W / 190]); ctx.beginPath(); ctx.moveTo(xm, y(e)); ctx.lineTo(x0, y(t1)); ctx.moveTo(xm, y(e)); ctx.lineTo(x1, y(t1)); ctx.stroke(); ctx.setLineDash([]);
      for (const [name, p, c] of [['Stop', sl, C.bear], ['Entry', e, '#6baaff'], ['TP1', t1, C.bull], ['TP2', t2, C.bull]]) {
        if (p == null) continue; ctx.strokeStyle = c; ctx.lineWidth = lw; ctx.beginPath(); ctx.moveTo(x0, y(p)); ctx.lineTo(x1, y(p)); ctx.stroke();
        chip(ctx, `${name} ${p.toLocaleString('en-US', { maximumFractionDigits: 2 })}`, x1 + 4, y(p), c, '#0b121df0', fs * 0.9);
      }
      chip(ctx, `R:R ${rr.toFixed(1)}`, xm, y(e), '#cfe8ff', '#0b1a2b', fs, 'center'); ctx.restore();
    }
    st.count = count; paintPills();
  }

  function paintPills() {
    document.querySelectorAll('.img-pills').forEach((box) => {
      const st = STATE[box.dataset.canvas]; const ai = box.querySelector('[data-ai] span'); if (ai) ai.textContent = `AI · ${st?.count || 0} drawings`;
      box.querySelectorAll('[data-layer]').forEach((b) => b.classList.toggle('on', L[b.dataset.layer]));
      const eye = box.querySelector('[data-ai]'); if (eye) eye.classList.toggle('on', !hidden);
    });
  }
  const redrawAll = () => Object.keys(STATE).forEach(render);

  document.querySelectorAll('.img-pills').forEach((box) => {
    box.innerHTML = LAYERS.map((l) => `<button class="ict-pill on" data-layer="${l}">${l[0].toUpperCase() + l.slice(1)}</button>`).join('') + '<button class="ict-pill on" data-ai="1"><span>AI · 0 drawings</span> 👁 <span class="x" data-clear>✕</span></button>';
    box.querySelectorAll('[data-layer]').forEach((b) => b.addEventListener('click', () => { L[b.dataset.layer] = !L[b.dataset.layer]; redrawAll(); }));
    box.querySelector('[data-ai]').addEventListener('click', (e) => {
      if (e.target.dataset.clear != null) { Object.values(STATE).forEach((s) => { if (s.read) s.read = { ...s.read, annotations: [] }; }); redrawAll(); return; }
      hidden = !hidden; redrawAll();
    });
  });

  window.drawOverlay = function (imgId, canvasId, read, analysis) {
    STATE[canvasId] = { imgId, read, analysis, count: 0 }; const img = document.getElementById(imgId);
    if (img.complete && img.naturalWidth) render(canvasId); else img.addEventListener('load', () => render(canvasId), { once: true });
    const foot = document.querySelector(`.img-pills[data-canvas="${canvasId}"]`)?.nextElementSibling;
    if (foot && !foot.dataset.note) { foot.dataset.note = '1'; foot.insertAdjacentHTML('afterend', '<div class="tiny" style="padding:0 14px 12px">ICT marks are placed by the AI vision model and are approximate. The Entry / Stop / TP box is placed from the readable price axis when it is verified. Use the live ICT Terminal for exact candle-based levels.</div>'); }
  };
  window.addEventListener('resize', () => redrawAll(), { passive: true });
})();
