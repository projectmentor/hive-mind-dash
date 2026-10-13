'use strict';
/* Charts for the dashboard: plain SVG, no library (hdash_overview_v2 §9). Loaded before app.js; every helper builds
   its markup with app.js's `html`, so a label or number is only ever a text node or an attribute. Rules:
   - Each helper returns one whole <svg>...</svg> built in a single template, so the children get the SVG namespace.
   - No style="" text and no <style>: colour comes from classes in app.css (.s1 to .s6), geometry from attributes.
   - preserveAspectRatio="none" only on the nested plotted <svg>; `ring` uses meet. Axis labels and legends are HTML the
     caller puts outside the SVG, so text never stretches.
   - Input is numbers and labels only; anything that is not a finite number draws as 0. */
const VIZ=(()=>{
  const num=x=>{ x=Number(x); return Number.isFinite(x)?x:0; };
  const r2=x=>Math.round(num(x)*100)/100;
  const ser=i=>'s'+(i%6+1);                                     // series colour class, accent first
  const anim=o=>(o&&o.animate===false)?'viz':'viz anim';       // animate:false on a refresh, so it updates in place
  const lab=(o,fb)=>String((o&&o.label)||fb);
  const fmt=n=>num(n).toLocaleString();

  /* A template builder: t() adds author-written markup (never data), v() adds a value, which `html` puts in as an attribute or a
     text node. The whole <svg> goes through one `html` call, so every child is in the SVG namespace. */
  const B=()=>{ const s=[''], v=[], b={ t:x=>{ s[s.length-1]+=x; return b; }, v:x=>{ v.push(x); s.push(''); return b; }, done:()=>html(s,...v) }; return b; };

  /* spark(points, {label, animate}): a small line, no axes. */
  function spark(points,o){
    const p=(points||[]).map(num), mx=Math.max(1,...p), n=p.length;
    const d=p.map((v,i)=>(i?'L':'M')+r2(n>1?i*100/(n-1):50)+' '+r2(28-v/mx*26)).join('');
    const sum=lab(o,'Trend of '+n+' points, latest '+fmt(p[n-1]));
    const b=B().t('<svg class=').v(anim(o)+' spark').t(' viewBox="0 0 100 30" width="100%" height="30" role="img" aria-label=').v(sum).t('><title>').v(sum)
      .t('</title><svg x="0" y="0" width="100" height="30" viewBox="0 0 100 30" preserveAspectRatio="none">');
    if(n) b.t('<path class="line s1" pathLength="1" d=').v(d).t('/>');
    return b.t('</svg></svg>').done();
  }

  /* bars(rows, {stacked, label, animate}): columns. rows = [{label, value, hatch}] or, with stacked,
     [{label, parts:[number...]}] (part i takes series colour i). hatch marks an unknown value (drawn open, not zero). */
  function bars(rows,o){
    rows=rows||[]; const st=!!(o&&o.stacked), n=rows.length||1;
    const tot=r=>st?(r.parts||[]).reduce((a,v)=>a+Math.max(0,num(v)),0):Math.max(0,num(r.value));
    const mx=Math.max(1,...rows.map(tot)), w=100/n, bw=w*.7;
    const sum=lab(o,'Bar chart, '+rows.length+' items');
    const b=B().t('<svg class=').v(anim(o)+' bars').t(' viewBox="0 0 100 100" width="100%" height="120" role="img" aria-label=').v(sum).t('><title>').v(sum)
      .t('</title><svg x="0" y="0" width="100" height="100" viewBox="0 0 100 100" preserveAspectRatio="none"><line class="grid" x1="0" y1="99.5" x2="100" y2="99.5"/>');
    rows.forEach((r,i)=>{
      const x=r2(i*w+(w-bw)/2); let y=100;
      b.t('<g class="col"><title>').v(String(r.label)+': '+fmt(tot(r))+(r.hatch?' (value unknown)':'')).t('</title>');
      (st?(r.parts||[]):[r.value]).forEach((v,j)=>{
        const h=r2(Math.max(0,num(v))/mx*96); y=r2(y-h);
        b.t('<rect class=').v(ser(st?j:i)+(r.hatch?' hatch':'')).t(' x=').v(x).t(' y=').v(y).t(' width=').v(r2(bw)).t(' height=').v(h).t('/>');
      });
      b.t('</g>');
    });
    return b.t('</svg></svg>').done();
  }

  /* line(series, {area, label, animate}): series = [{label, points:[number...]}], one shared vertical scale. */
  function line(series,o){
    series=series||[];
    const mx=Math.max(1,...series.flatMap(s=>(s.points||[]).map(num)));
    const sum=lab(o,'Line chart, '+series.length+' series');
    const b=B().t('<svg class=').v(anim(o)+' lines').t(' viewBox="0 0 100 100" width="100%" height="160" role="img" aria-label=').v(sum).t('><title>').v(sum)
      .t('</title><svg x="0" y="0" width="100" height="100" viewBox="0 0 100 100" preserveAspectRatio="none"><line class="grid" x1="0" y1="25" x2="100" y2="25"/><line class="grid" x1="0" y1="50" x2="100" y2="50"/><line class="grid" x1="0" y1="75" x2="100" y2="75"/><line class="grid" x1="0" y1="99.5" x2="100" y2="99.5"/>');
    series.forEach((s,i)=>{
      const p=(s.points||[]).map(num), n=p.length;
      if(!n) return;
      const d='M'+p.map((v,k)=>r2(n>1?k*100/(n-1):50)+' '+r2(98-v/mx*94)).join('L');
      b.t('<g><title>').v(String(s.label)+': latest '+fmt(p[n-1])).t('</title>');
      if(o&&o.area) b.t('<path class=').v('area '+ser(i)).t(' d=').v(d+'L'+(n>1?100:50)+' 100L'+(n>1?0:50)+' 100Z').t('/>');
      b.t('<path pathLength="1" class=').v('line '+ser(i)).t(' d=').v(d).t('/></g>');
    });
    return b.t('</svg></svg>').done();
  }

  /* ring(parts, {label, animate}): parts = [{label, value, hatch}]; slice i takes series colour i. */
  function ring(parts,o){
    parts=parts||[];
    const tot=parts.reduce((a,p)=>a+Math.max(0,num(p.value)),0);
    const sum=lab(o,'Ring chart, '+parts.map(p=>p.label+' '+fmt(p.value)).join(', '));
    const b=B().t('<svg class=').v(anim(o)+' ring').t(' viewBox="0 0 42 42" width="100%" height="140" preserveAspectRatio="xMidYMid meet" role="img" aria-label=').v(sum).t('><title>').v(sum)
      .t('</title><circle class="track" cx="21" cy="21" r="15.9155"/>');
    let at=0;
    if(tot) parts.forEach((p,i)=>{
      const v=Math.max(0,num(p.value))/tot*100, a=r2(at); at+=v;
      if(v) b.t('<circle cx="21" cy="21" r="15.9155" pathLength="100" transform="rotate(-90 21 21)" class=').v('arc '+ser(i)+(p.hatch?' hatch':''))
        .t(' stroke-dasharray=').v(r2(v)+' '+r2(100-v)).t(' stroke-dashoffset=').v(r2(-a)).t('><title>').v(String(p.label)+': '+fmt(p.value)).t('</title></circle>');
    });
    return b.t('</svg>').done();
  }

  /* limits(used, cap, {label, animate}): one bar, how much of a limit is used. Turns warn at 70% and bad at 90%. */
  function limits(used,cap,o){
    used=Math.max(0,num(used)); cap=Math.max(0,num(cap));
    const f=cap?Math.min(1,used/cap):0, lv=f>=.9?'bad':f>=.7?'warn':'ok';
    const sum=lab(o,fmt(used)+' of '+(cap?fmt(cap):'no limit')+' used');
    return B().t('<svg class=').v(anim(o)+' limits').t(' viewBox="0 0 100 8" width="100%" height="8" role="img" aria-label=').v(sum).t('><title>').v(sum)
      .t('</title><svg x="0" y="0" width="100" height="8" viewBox="0 0 100 8" preserveAspectRatio="none"><rect class="track" x="0" y="0" width="100" height="8" rx="4"/><rect x="0" y="0" height="8" rx="4" class=')
      .v('fill '+lv).t(' width=').v(r2(f*100)).t('/></svg></svg>').done();
  }

  /* skeleton(kind): the shimmering shape a widget has before its data arrives: 'bars', 'ring', 'rows' or 'stat'. */
  function skeleton(kind){
    const k=['bars','ring','rows','stat'].includes(kind)?kind:'rows';
    return html`<div class=${'skel '+k} aria-hidden="true"><i></i><i></i><i></i><i></i><i></i></div>`;
  }

  /* countUp(el, n): the number rises to n once (200ms ease-out); with reduced motion, or when n is not a number, it just sets it. */
  function countUp(el,n,o){
    n=num(n); const fin=()=>{ el.textContent=fmt(n); };
    if(!el||!n||matchMedia('(prefers-reduced-motion: reduce)').matches||(o&&o.animate===false)){ if(el) fin(); return; }
    const t0=performance.now(), dur=200;
    const tick=t=>{ const k=Math.min(1,(t-t0)/dur); el.textContent=fmt(Math.round(n*(1-(1-k)*(1-k)))); if(k<1) requestAnimationFrame(tick); };
    requestAnimationFrame(tick);
  }

  return {spark,bars,line,ring,limits,skeleton,countUp};
})();
