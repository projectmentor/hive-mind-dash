'use strict';
const $=(s,r=document)=>r.querySelector(s);

// DOM construction. The dashboard never assigns markup built from data: `html` takes the static template
// text (author-written, no data in it) and puts every `${value}` in by DOM API only: a value in a child
// position becomes a text node (or the node/fragment/array of nodes it already is), a value in an
// attribute position (`name=${v}`, written unquoted) goes through setAttribute, and `onclick=${fn}` /
// `style=${{prop:value}}` use addEventListener / CSSOM. So a tag, fact text, or any peer-supplied string
// is only ever text. Under the daemon's `Content-Security-Policy: default-src 'self'` nothing else can run.
function toNodes(v){
  if(v==null||v===false||v===true) return [];
  if(Array.isArray(v)) return v.flatMap(toNodes);
  if(v instanceof Node) return [v];
  return [document.createTextNode(String(v))];
}
function html(strings,...vals){
  let s=strings[0];
  vals.forEach((_,i)=>{ s+=(/[\w:-]=$/.test(s)?`"@@${i}@@"`:`<!--h:${i}-->`)+strings[i+1]; });
  const t=document.createElement('template'); t.innerHTML=s;
  const root=t.content, comments=[], elems=[];
  const w=document.createTreeWalker(root,NodeFilter.SHOW_COMMENT|NodeFilter.SHOW_ELEMENT);
  for(let n=w.nextNode();n;n=w.nextNode()) (n.nodeType===8?comments:elems).push(n);
  for(const el of elems) for(const a of Array.from(el.attributes)){
    const m=/^@@(\d+)@@$/.exec(a.value); if(!m) continue;
    const v=vals[+m[1]]; el.removeAttribute(a.name);
    if(v==null||v===false) continue;
    if(a.name.startsWith('on')&&typeof v==='function') el.addEventListener(a.name.slice(2),v);
    else if(a.name==='style'&&typeof v==='object') for(const k in v) el.style.setProperty(k,v[k]);
    else el.setAttribute(a.name,v===true?'':String(v));
  }
  for(const c of comments){
    const m=/^h:(\d+)$/.exec(c.data); if(!m) continue;
    c.replaceWith(...toNodes(vals[+m[1]]));
  }
  return root;
}
const put=(el,...nodes)=>{ if(el) el.replaceChildren(...nodes.flatMap(toNodes)); };
const safeUrl=(u,fb)=>/^https?:\/\//i.test(String(u||''))?String(u):fb;

/* Theme: the page follows the system setting until the viewer picks one; the pick is a per-viewer convenience kept in localStorage. */
const THEME_KEY='hdash-theme';
const themeNow=()=>document.documentElement.dataset.theme||(matchMedia('(prefers-color-scheme: light)').matches?'light':'dark');
function themeShow(){ const b=document.getElementById('hTheme'); if(!b) return; const t=themeNow(); b.textContent=t==='light'?'☾':'☀'; b.title='Switch to the '+(t==='light'?'dark':'light')+' theme'; b.setAttribute('aria-label',b.title); }
try{ const t=localStorage.getItem(THEME_KEY); if(t==='light'||t==='dark') document.documentElement.dataset.theme=t; }catch(e){}
function themeToggle(){ const t=themeNow()==='light'?'dark':'light'; document.documentElement.dataset.theme=t; try{ localStorage.setItem(THEME_KEY,t); }catch(e){} themeShow(); }

const confColor=c=>c>=.6?'var(--ok)':c>=.3?'var(--accent)':'var(--warn)';
/* Viewer mode: a tailnet viewer loads this page over HTTPS from the MagicDNS name, the operator from 127.0.0.1. The page then
   skips the calls the viewer listener refuses, never sends ?node= and asks for peers with probe=0. This only removes calls: the
   viewer listener is the gate, and a refusal it sends is shown, not swallowed. */
const VIEWER=!['127.0.0.1','localhost','[::1]','::1'].includes(location.hostname);
const VIEWER_NO=['/api/status','/api/telemetry','/api/entities','/api/modules','/api/module','/api/settings','/api/workspace','/api/csrf'];
function viewerUrl(u){
  const x=new URL(u,location.origin);
  if(VIEWER_NO.includes(x.pathname)) throw new Error('not available to viewers: '+x.pathname);
  x.searchParams.delete('node');
  if(x.pathname==='/api/peers') x.searchParams.set('probe','0');
  return x.pathname+x.search;
}
function viewerRefused(u,body){
  const n=document.getElementById('vnote'); if(!n) return;
  n.hidden=false; n.textContent='The viewer listener refused '+u.split('?')[0]+(body&&body.error?': '+body.error:'')+'.';
}
/* Request queue (hdash_overview_v2 §3). The server answers 503 "server busy" when its slots are taken, and behind Tailscale Serve
   (HTTP/2) the browser no longer limits itself to 6 connections, so a page that starts a dozen reads would fail at random. At most
   4 requests are in flight for a viewer and 6 for the operator; the rest wait here. A busy 503 is retried once after 300 to 800 ms. */
const QMAX=VIEWER?4:6, QWAIT=[]; let QBUSY=0;
const qRun=fn=>new Promise((ok,no)=>{
  const go=()=>{ QBUSY++; (async()=>fn())().then(ok,no).finally(()=>{ QBUSY--; const n=QWAIT.shift(); if(n) n(); }); };
  if(QBUSY<QMAX) go(); else QWAIT.push(go);
});
const isBusy=(r,b)=>r.status===503&&!!b&&(b.error==='server busy'||b.error==='busy');
const RATE_TEXT='rate limited, try again in a moment';
/* The words for a failed read: a rate limit and a busy server are not "service down". */
const failText=(e,down)=>e&&e.status===429?RATE_TEXT:e&&e.busy?'the service is busy, try again in a moment':down;
const getJSON=async u=>{
  if(VIEWER) u=viewerUrl(u);
  for(let tries=0;;tries++){
    const {r,b,pe}=await qRun(async()=>{ const r=await fetch(u); let b=null,pe=null; try{ b=await r.json(); }catch(e){ pe=e; } return {r,b,pe}; });
    if(r.ok){ if(pe) throw pe; return b; }
    const busy=isBusy(r,b);
    if(busy&&tries===0){ await new Promise(f=>setTimeout(f,300+Math.random()*500)); continue; }
    if(VIEWER&&!busy&&r.status!==429&&b&&b.listener==='viewer') viewerRefused(u,b);
    const e=new Error(r.status); e.status=r.status; e.busy=busy; throw e;
  }
};
const spin=t=>html`<div class="loading"><span class="spin"></span> ${t||'loading…'}</div>`;
const empty=t=>html`<div class="empty">${t}</div>`;
const fmtDur=s=>{s=Math.round(s||0);const h=(s/3600)|0,m=((s%3600)/60)|0;return h?`${h}h${String(m).padStart(2,'0')}m`:`${m}m`;};
const fmtNum=n=>(n||0).toLocaleString();
const fmtCost=c=>c==null?'unpriced':'~$'+Number(c).toFixed(2);
const PER=25;
let META={}, state={view:'overview',node:null,nodeTab:'overview',detail:null}, PEERS=[];
let LAST={facts:[],decisions:[],sessions:[]};   // current rows, for detail lookups
const setNav=v=>document.querySelectorAll('nav button').forEach(x=>x.classList.toggle('active',x.dataset.v===v));

(async function boot(){
  $('#hTheme').onclick=themeToggle; themeShow();
  try{ META=await getJSON('/api/overview'); }catch(e){ put($('#app'),empty(failText(e,'could not reach this device\'s HiveMind service — is it running? Check it with:')),cmdBlock('hv doctor')); return; }
  $('#hRole').textContent=META.role; $('#hRole').className='badge link '+(META.role==='OWNER'?'owner':'');
  $('#hAuth').textContent='checking…'; $('#hNode').textContent=META.node; $('#hMerkle').textContent=META.merkle;
  if(!VIEWER) $('#hRole').onclick=()=>goView('status');
  $('#hAuth').onclick=openOfficialModal;
  $('#hHelp').onclick=()=>openModal('Help',html`<p>A built-in AI assistant for the dashboard is on the way. For now, use the <code>hv</code> CLI or <a href="https://hivemind.projectmentor.org/dev/" target="_blank" rel="noopener">the docs</a>.</p>`);
  getJSON('/api/verify').then(v=>{const a=$('#hAuth'); if(v.ok){a.textContent='✓ v'+(v.version||META.contract)+' authentic';a.className='badge link ok';}else{a.textContent='⚠ modified locally';a.className='badge link warn';}}).catch(()=>{});
  if(VIEWER) document.querySelectorAll('nav button[data-v="telemetry"],nav button[data-v="agents"],nav button[data-v="trust"],nav button[data-v="modules"]').forEach(b=>b.remove());
  document.querySelectorAll('nav button').forEach(b=>b.onclick=()=>goTab(b.dataset.v));
  if(!(await openHash())) render();
})();
function goTab(v){MP.tab='overview';state.view=v;state.node=null;state.detail=null;if(v==='corpus')pg1();if(v==='telemetry')TP=1;
  setNav(v);render();}
function goView(v){state.view=v;state.node=null;state.detail=null;setNav(null);render();}
function render(){
  try{ if(/^#corpus/.test(location.hash)&&(state.view!=='corpus'||state.detail||state.node)) history.replaceState(null,'',location.pathname+location.search); }catch(e){}
  if(state.detail) return renderDetail();
  if(state.node) return renderNode();
  ({overview,corpus,hive,telemetry,status,audit,modules,modulePage,settingsNode,agents:()=>workspace('agents'),trust:()=>workspace('trust'),spend:()=>workspace('spend'),governance:()=>workspace('governance')})[state.view]();
}

/* ---------- modals ---------- */
function closeModal(){ put($('#modal')); }
function openModal(title,body,logo){
  put($('#modal'),html`<div class="modal-bg" onclick=${e=>{if(e.target===e.currentTarget)closeModal();}}><div class="modal">
    <div class="mh">${logo?html`<img src="logo.svg" alt="">`:null}<strong>${title}</strong><button class="x" onclick=${closeModal}>×</button></div>
    <div class="mb">${body}</div></div></div>`);
}
const copyCmd=btn=>{const c=btn.parentElement.querySelector('code'); if(c){try{navigator.clipboard.writeText(c.textContent);}catch(e){} btn.textContent='Copied ✓'; setTimeout(()=>btn.textContent='Copy',1300);}};
const cmdBlock=cmd=>html`<div class="cmd"><code>${cmd}</code><button class="btn" onclick=${e=>copyCmd(e.currentTarget)}>Copy</button></div>`;
const shieldIcon=ok=>html`<svg class=${'shield '+(ok?'c-ok':'c-bad')} viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3l7 3v5c0 4.4-3 7.6-7 9-4-1.4-7-4.6-7-9V6z"/>${ok?html`<path d="M9 12l2 2 4-4"/>`:html`<line x1="12" y1="8.5" x2="12" y2="13"/><line x1="12" y1="15.7" x2="12.01" y2="15.7"/>`}</svg>`;
async function openOfficialModal(){
  openModal('Authenticity',spin('verifying…'),true);
  let v={ok:false,lines:[],version:META.contract};
  try{ v=await getJSON('/api/verify'); }catch(e){}
  const ok=v.ok;
  // Remediation guidance when the local source doesn't match the signed manifest. Read-only on
  // purpose — the operator runs the command in a terminal where they can see what it will do.
  const fix = ok ? null : (v.level==='modified' ? html`
     <div class="fix"><p class="ft">Re-align this install</p>
       <p>If you made local changes, review them first:</p>${cmdBlock('git -C ~/projects/hive-mind status')}
       <p>Re-align to the signed source (clean tree):</p>${cmdBlock('hive-mind update')}
       <p>…or discard local edits and force-align:</p>${cmdBlock('hive-mind reset -y')}
       <p class="c-muted fs12">Run these in a terminal on that device. (A one-click control from the dashboard is coming as an opt-in admin mode.)</p></div>` : html`
     <div class="fix"><p class="ft">Reinstall from the official source</p>
       <p>No signed manifest found — restore a genuine copy:</p>${cmdBlock('cd ~/projects/hive-mind && git fetch origin && git reset --hard origin/main && hive-mind update')}</div>`);
  const head=((v.lines&&v.lines[0])||('HiveMind v'+(v.version||META.contract))).replace(/^[✓⚠✗·\s]+/,'');
  openModal('Official HiveMind',
    html`<div class=${'verdict'+(ok?'':' bad')}>${shieldIcon(ok)} ${head}</div>
     ${(v.lines||[]).slice(1).map(l=>html`<p class="mono c-dim">${l}</p>`)}
     ${fix}
     <p><strong>Use only the official HiveMind from <a href="https://projectmentor.org" target="_blank" rel="noopener">ProjectMentor</a>. Trust no imitations.</strong></p>
     <p>To confirm your copy is genuine, run <code>hv verify</code>. A genuine install shows a green check and confirms it against the canonical source; a fork, mirror, or modified copy is flagged with the official URL.</p>
     <p>Source: <code>${v.official_source||'github.com/projectmentor/hive-mind'}</code> · Site: <a href=${safeUrl(v.site,'https://hivemind.projectmentor.org')} target="_blank" rel="noopener">hivemind.projectmentor.org</a></p>`,
    true);
}

/* ---------- shared rows ---------- */
const confBar=c=>html`<span class="bar"><i style=${{width:Math.max(0,Math.round((c||0)*100))+'%'}}></i></span>`;
const confNum=c=>html`<span style=${{color:confColor(c||0)}}>${(c||0).toFixed(2)}</span>`;
const tagChip=(t,cls)=>html`<span class=${cls?'chip '+cls:'chip'} onclick=${e=>{e.stopPropagation();filterTag(t);}}>${t}</span>`;
const pill=(cls,t)=>html`<span class=${'pill '+cls}>${t}</span>`;
function factRow(f){
  return html`<div class="row link" onclick=${()=>openFact(f.id)}><div class="content">${(f.content||'').slice(0,240)}</div>
   <div class="meta">
     ${confBar(f.confidence)}
     ${confNum(f.confidence)}
     ${f.contested?pill('contested','CONTESTED'):null}${f.forgotten?pill('forgotten','FORGOTTEN'):null}
     ${(f.tags||[]).map(t=>tagChip(t))}
     <span class="mtauto">${f.source} · ${f.created}</span></div></div>`;
}
function supPill(d){
  if(!d.superseded) return null;
  return d.superseded_by_sid
    ? html`<a class="pill superseded" href=${'#'+d.superseded_by_sid} title=${'superseded by '+d.superseded_by_sid+' ('+(d.superseded_by_authority||'hard')+')'} onclick=${e=>e.stopPropagation()}>SUPERSEDED by ${d.superseded_by_sid}</a>`
    : pill('superseded','SUPERSEDED');
}
function supEvidence(d){
  return (d.supersede_evidence||[]).map(e=>html` <span class="muted">supersede by <a href=${'#'+e.sid} class="mono">${e.sid}</a> is evidence only, not in effect</span>`);
}
function decRow(d){
  return html`<div class="row link" onclick=${()=>openDecision(d.id)}><div class="content"><span class="mono muted">${d.sid||('#'+d.id)}</span> ${(d.content||'').slice(0,240)}
     ${supPill(d)}${supEvidence(d)}</div>
   ${d.rationale?html`<div class="rationale">${d.rationale.slice(0,300)}</div>`:null}
   <div class="meta">${(d.tags||[]).map(t=>tagChip(t,'proj'))}
     <span class="mtauto">${d.created}</span></div></div>`;
}
function pager(cur,total,per,fn){
  const pages=Math.ceil(total/per); if(!total||total<=per) return null;
  const b=(lab,pg,dis,on)=>html`<button class=${on?'pg on':'pg'} disabled=${dis} onclick=${()=>fn(pg)}>${lab}</button>`;
  const out=[b('«',1,cur===1),b('‹',cur-1,cur===1)]; const lo=Math.max(1,cur-2),hi=Math.min(pages,cur+2);
  if(lo>1){out.push(b('1',1,false,cur===1)); if(lo>2)out.push(html`<span class="pgdots">…</span>`);}
  for(let p=lo;p<=hi;p++)out.push(b(String(p),p,false,p===cur));
  if(hi<pages){if(hi<pages-1)out.push(html`<span class="pgdots">…</span>`); out.push(b(String(pages),pages,false,cur===pages));}
  out.push(b('›',cur+1,cur===pages),b('»',pages,cur===pages));
  return html`<div class="pager">${out}</div>`;
}
// One list panel's body: heading with count + pager, the rows, and a pager footer.
function listBody(label,total,rows,page,fn,none){
  const pg=()=>pager(page,total,PER,fn);
  return [html`<h2>${total} ${label}${pg()}</h2>`, rows.length?rows:empty(none), total>PER?html`<div class="pgfoot">${pg()}</div>`:null];
}

/* ---------- detail views (fact / decision / session) ---------- */
const openFact=id=>{const f=LAST.facts.find(x=>x.id===id); if(f){state.detail={kind:'fact',data:f}; setHash(f.sid); render();}};
const openDecision=id=>{const d=LAST.decisions.find(x=>x.id===id); if(d){state.detail={kind:'decision',data:d}; setHash(d.sid); render();}};
const openSession=i=>{const s=LAST.sessions[i]; if(s){state.detail={kind:'session',data:s}; render();}};
const closeDetail=()=>{state.detail=null; setHash(''); render();};
// 1.19 PR3b: a detail view is addressable by the entry's STABLE short id — `/#h:…` — resolved server-side
// through journal_index (`/api/item`), so the link survives rebuilds and works on every node. The rowid
// never appears in a URL.
function setHash(sid){ try{ const h=sid?'#'+sid:restHash(); if(location.hash!==h&&(h||location.hash)) history.replaceState(null,'',h||location.pathname+location.search); }catch(e){} }
const ID_RE=/^(h:[0-9a-f]{10}|[^\s:]+(:[^\s:]+)*:\d+)$/;
// Resolve a short id or `node_id:seq` ref to its entry (fact, decision or idea) and open its detail view.
async function openById(h){
  if(!ID_RE.test(h)) return false;
  let r; try{ r=await getJSON('/api/item?sid='+encodeURIComponent(h)); }catch(e){ return false; }
  if(!r||r.error||!r.item||!(r.kind==='fact'||r.kind==='decision'||r.kind==='idea')) return false;
  if(r.kind==='fact') LAST.facts=[r.item]; else if(r.kind==='decision') LAST.decisions=[r.item];
  state.detail={kind:r.kind,data:r.item}; if(r.item.sid) setHash(r.item.sid); render(); return true;
}
async function openHash(){
  const h=(location.hash||'').slice(1), m=/^corpus(?:\/([a-z-]+))?$/.exec(h);
  if(!m) return openById(h);
  const sub=m[1]||'search'; if(!SUB_SET[sub]) return false;
  const shown=VIEWER&&sub==='entities'?'search':sub;   // a viewer has no Entities: land on Search, not on the default view
  state.node=null; state.detail=null; state.view='corpus'; applySub(shown); setNav('corpus'); if(shown!==sub) setHash(''); render(); return true;
}
window.addEventListener('hashchange',()=>{ openHash(); });
const kv=(k,v)=>html`<div class="kv"><div class="k">${k}</div><div class="v">${v}</div></div>`;
const identity=x=>x.ref?kv('Identity',[html`<span class="mono">${x.ref}</span>`, x.sid?html` · <a href=${'#'+x.sid} class="mono">#${x.sid}</a>`:null]):null;
const tagList=(tags,cls)=>{ const l=(tags||[]).map(t=>tagChip(t,cls)); return l.length?l.flatMap((c,i)=>i?[' ',c]:[c]):html`<span class="muted">—</span>`; };
function renderDetail(){
  const d=state.detail;
  const crumb=html`<div class="crumb"><button class="back" onclick=${closeDetail}>‹ Back</button><span class="who">${{fact:'Fact',decision:'Decision',idea:'Idea',session:'Session'}[d.kind]} detail</span></div>`;
  const app=$('#app');
  if(d.kind==='fact'){const f=d.data;
    put(app,crumb,html`<div class="panel"><h2>Fact <span class="mono">${f.sid||('#'+f.id)}</span> <small class="muted">#${f.id} on this node</small></h2><div class="full">${f.content}</div></div>
      <div class="panel"><h2>Details</h2>
        ${kv('Confidence',[confBar(f.confidence),' ',confNum(f.confidence)])}
        ${kv('State',(f.contested||f.forgotten)?[f.contested?pill('contested','CONTESTED'):null,' ',f.forgotten?pill('forgotten','FORGOTTEN'):null]:'live')}
        ${kv('Tags',tagList(f.tags))}
        ${kv('Source',f.source)}${kv('Created',f.created)}
        ${identity(f)}</div>
      <div class="panel"><h2>Related facts</h2><div id="related">${spin()}</div></div>`);
  } else if(d.kind==='decision'){const x=d.data;
    put(app,crumb,html`<div class="panel"><h2>Decision <span class="mono">${x.sid||('#'+x.id)}</span> <small class="muted">#${x.id} on this node</small>${x.superseded?[' ',supPill(x)]:null}${supEvidence(x)}</h2><div class="full">${x.content}</div></div>
      ${x.rationale?html`<div class="panel"><h2>Rationale</h2><div class="full c-dim">${x.rationale}</div></div>`:null}
      <div class="panel"><h2>Details</h2>
        ${kv('Tags',tagList(x.tags,'proj'))}
        ${kv('Created',x.created)}
        ${identity(x)}</div>
      <div class="panel"><h2>Related facts</h2><div id="related">${spin()}</div></div>`);
  } else if(d.kind==='idea'){const f=d.data;
    put(app,crumb,html`<div class="panel"><h2>Idea <span class="mono">${f.sid||('#'+f.id)}</span> <small class="muted">hypothesis; confidence is earned, never asserted</small></h2><div class="full">${f.content}</div></div>
      <div class="panel"><h2>Details</h2>
        ${kv('Confidence',[confBar(f.confidence),' ',confNum(f.confidence)])}
        ${kv('State',f.contested?pill('contested','CONTESTED'):'live')}
        ${kv('Tags',tagList(f.tags))}
        ${kv('Source',f.source)}${kv('Created',f.created)}
        ${identity(f)}</div>`);
  } else {const s=d.data;
    const models=Object.entries(s.models||{});
    put(app,crumb,html`<div class="panel"><h2>Session</h2>
        ${kv('When',s.when)}${kv('Node',s.node_name||s.node||'-')}${kv('Agent',s.agent)}
        ${kv('Project',s.project)}${kv('Duration',fmtDur(s.duration_s))}
        ${kv('Tokens',fmtNum(s.tokens_in)+' in / '+fmtNum(s.tokens_out)+' out')}${kv('Cost',fmtCost(s.cost_usd))}
        ${s.session_id?kv('Session id',html`<span class="mono">${s.session_id}</span>`):null}
        ${s.started_at?kv('Started',html`<span class="mono">${s.started_at}</span>`):null}${s.updated_at?kv('Updated',html`<span class="mono">${s.updated_at}</span>`):null}</div>
      ${models.length?html`<div class="panel"><h2>By model</h2><table><thead><tr><th>Model</th><th>In</th><th>Out</th><th>Cost</th></tr></thead><tbody>${models.map(([m,v])=>html`<tr><td class="mono">${m}</td><td>${fmtNum(v.in)}</td><td>${fmtNum(v.out)}</td><td>${v.cost!=null?fmtCost(v.cost):'unpriced'}</td></tr>`)}</tbody></table></div>`:null}
      <div class="panel"><h2>Related sessions <span class="count">same project</span></h2><div id="relsess">${spin()}</div></div>`);
  }
  if(d.kind==='fact'||d.kind==='decision') loadRelated(d.kind,d.data.id);
  else if(d.kind==='session') loadRelatedSessions(d.data);
}

/* ---------- Overview ---------- */
/* A grid of widgets (hdash_overview_v2 §3). The frame draws at once with a skeleton in each widget; every widget then fills from its own
   read, so one slow or refused read leaves the others alone. The operator page refreshes every 60 s while the tab is visible and the
   viewer page every 120 s; a refresh redraws in place with no animation. A viewer's page leaves out what the viewer listener refuses. */
const navCard=(lbl,val,go,statCls,id)=>html`<div class="card link" id=${id} onclick=${go}><div class="lbl">${lbl}</div><div class=${statCls||'stat'}>${val}</div></div>`;
const OV_EVERY=(VIEWER?120:60)*1000, OV_SPARK_DAYS=14, OV_SPARK_CAP=8;
let OVT=null, OVD={}, OVERR={}, OVSEEN={}, OVAT=0, OVTRY=0, OVFAIL=false;   // OVAT: when a read last succeeded; OVTRY: when a refresh last started; OVFAIL: the last refresh got no read at all
const ovLive=()=>state.view==='overview'&&!state.node&&!state.detail&&!!document.getElementById('ovroot');
const ovAnim=k=>{ const a=!OVSEEN[k]; OVSEEN[k]=1; return {animate:a}; };
const widget=(cls,id,title,go,kind,more)=>html`<section class=${'panel widget '+cls}><h2>${title}${go?html`<button class="wlink" type="button" onclick=${go}>${more||'Details'} ›</button>`:null}</h2><div class="wbody" id=${id}>${VIZ.skeleton(kind)}</div></section>`;
const heroStat=(id,lbl,sub,subId)=>html`<div class="hstat"><div class="lbl">${lbl}</div><div class="big" id=${id}>…</div><div class="sub" id=${subId||null}>${sub}</div></div>`;
const setNum=(id,n)=>{ const el=document.getElementById(id); if(!el||el.dataset.v===String(n)) return; const first=!el.dataset.v; el.dataset.v=String(n); if(first) VIZ.countUp(el,n); else el.textContent=fmtNum(n); };
const ovFail=(key,down,cmd)=>[empty(failText(OVERR[key],down)),cmd?cmdBlock(cmd):null];
const OV_DOWN='could not reach this device\'s HiveMind service — is it running? Check it with:';

/* The devices: admitted devices only. A module's own admitted key is not a device (it is on the Modules page). */
function ovDevices(){
  const ps=OVD.peers; if(!ps) return null;
  const tn={}; ((OVD.tel&&OVD.tel.nodes)||[]).forEach(n=>{ tn[n.node_id]=n; });
  return ps.filter(p=>!isModuleRow(p)).map(p=>{
    const t=tn[p.device];
    const st=p.self||(t&&(t.status==='online'||t.status==='self'))?'online':/diverged|stale/.test(p.status)?'diverged':/in sync|reachable/.test(p.status)?'in sync':p.status==='admitted'?'not checked':'offline';
    return {name:p.name,device:p.device,self:!!p.self,seen:p.seen,state:st,online:st==='online'||st==='in sync'||st==='diverged'};
  });
}
const ovDot=d=>d.self?'self':d.state==='online'||d.state==='in sync'?'ok':d.state==='diverged'?'stale':'off';

const ovAgeDraw=()=>{
  const ago=OVAT?Math.max(0,Math.round((Date.now()-OVAT)/1000))+'s ago':null;
  put(document.getElementById('ovAge'),OVFAIL?html`<span class="c-bad">${ago?'refresh failed. Showing data from '+ago:'could not load this page'}</span>`:ago?'updated '+ago:null);
};

function ovHero(){
  const m=OVD.meta; if(!m) return;
  setNum('ovFacts',m.facts); setNum('ovDecs',m.decisions); setNum('ovContested',m.contested);
  const c=document.getElementById('ovContested'); if(c) c.classList.toggle('c-bad',!!m.contested);
  if(OVD.ideas!=null) setNum('ovIdeas',OVD.ideas);
  const dv=ovDevices();
  if(dv){ setNum('ovOnline',dv.filter(d=>d.online).length); put(document.getElementById('ovOnlineSub'),'of '+dv.length+' admitted (allowed to write to this hive)'); }
  put(document.getElementById('ovWho'),html`<strong>${m.node}</strong> <span class=${'badge '+(m.role==='OWNER'?'owner':'')}>${m.role}</span>`);
  put(document.getElementById('ovMerkle'),m.merkle);
  const v=OVD.verify, s=document.getElementById('ovShield');
  if(s&&v) put(s,shieldIcon(v.ok),html`<span>${v.ok?'v'+(v.version||m.contract)+' genuine':'changed locally'}</span>`);
  ovAgeDraw();
}

function ovFleet(){
  const b=document.getElementById('ovFleet'); if(!b) return;
  const dv=ovDevices();
  if(!dv){ if(OVERR.peers) put(b,...ovFail('peers','the device list could not be read.')); return; }
  const others=dv.filter(d=>!d.self);
  const spark=d=>{ const pd=OVD.perDay&&OVD.perDay[d.device], p=pd&&ovDays(OV_SPARK_DAYS).map(k=>pd.by[k]||0); return p?html`<div class="spk">${VIZ.spark(p,{label:d.name+': sessions per day, last '+OV_SPARK_DAYS+' days',animate:false})}</div>`:null; };
  put(b,html`<div class="wsum">${dv.length} device${dv.length===1?'':'s'}, ${dv.filter(d=>d.online).length} online</div>
    ${dv.map(d=>html`<div class="frow"><span class=${'dot '+ovDot(d)}></span><span class="fname">${d.name}</span>
      <span class=${'fstate '+(d.state==='diverged'?'c-warn':d.online?'c-ok':'c-muted')}>${d.self?'this device':d.state}</span>
      <span class="fseen c-dim">${d.seen&&d.seen!=='—'?'last seen '+d.seen:'never seen'}</span>${VIEWER?null:spark(d)}</div>`)}
    ${others.length?null:html`<div class="wnote">No other device is admitted yet. An invitation lets a second device write to this hive:</div>`}${others.length?null:cmdBlock('hive-mind invite')}`);
}

function ovMix(){
  const b=document.getElementById('ovMix'), m=OVD.meta; if(!b||!m) return;
  const ideas=OVD.ideas||0, con=Math.min(m.contested||0,m.facts||0), tot=(m.facts||0)+(m.decisions||0)+ideas;
  if(!tot){ put(b,empty('nothing remembered yet. Add a fact with:'),cmdBlock('hv remember "<fact>" --tags <tag>')); return; }
  const parts=[{label:'Facts',value:(m.facts||0)-con},{label:'Contested facts',value:con,hatch:true},{label:'Decisions',value:m.decisions||0},{label:'Ideas',value:ideas}];
  put(b,html`<div class="wsum"><span class="big2">${fmtNum(tot)}</span> entries</div>${VIZ.ring(parts,Object.assign({label:'Facts, decisions and ideas: '+parts.map(p=>p.label+' '+fmtNum(p.value)).join(', ')},ovAnim('mix')))}
    <div class="legend">${parts.map((p,i)=>html`<span><i class=${'s'+(i+1)}></i>${p.label} ${fmtNum(p.value)}</span>`)}</div>
    <div class="wnote">A contested fact has a correction recorded against it. An idea is a hypothesis that earns confidence later.</div>`);
}

function ovAudit(){
  const b=document.getElementById('ovAudit'); if(!b) return;
  const a=OVD.audit;
  if(!a){ if(OVERR.audit) put(b,...ovFail('audit',OV_DOWN)); return; }
  const rows=[['Re-check',a.recheck,'facts that can go out of date, past their freshness date'],['Stale',a.stale,'facts not confirmed for a long time'],['Duplicate',a.duplicate,'entries that say the same thing'],['Contravened',a.contravened,'corrections not yet reconciled']];
  if(!rows.some(r=>r[1])){ put(b,empty('clean: nothing to reconcile. Run the full check with:'),cmdBlock('hv audit')); return; }
  put(b,html`<div class="pointer" onclick=${()=>goView('audit')}>${VIZ.bars(rows.map(r=>({label:r[0]+' ('+r[2]+')',value:r[1]})),Object.assign({label:'Audit: '+rows.map(r=>r[0]+' '+r[1]).join(', ')},ovAnim('audit')))}
    <div class="acols">${rows.map(r=>html`<div title=${r[2]}><div class=${'big2 '+(r[1]?'c-warn':'')}>${fmtNum(r[1])}</div><div class="sub">${r[0]}</div></div>`)}</div></div>
    <div class="wnote">Re-check: facts that can go out of date, past their freshness date. Stale: not confirmed for a long time. Contravened: corrections not yet reconciled. Click to open the list.</div>`);
}

function ovModules(){
  const b=document.getElementById('ovModules'); if(!b) return;
  const r=OVD.modules;
  if(!r){ if(OVERR.modules) put(b,...ovFail('modules','modules unavailable — is hive-mind on this node?')); return; }
  if(!r.modules.length){ put(b,empty('no modules installed. A module is an installed add-on, such as hconfig:'),cmdBlock('hive-mind module add hconfig')); return; }
  put(b,r.modules.map(m=>html`<div class="mrow pointer" onclick=${()=>{MP={name:m.name,tab:'overview'};state.view='modulePage';setNav('modules');render();}}>
    <span class="mname"><strong>${m.name}</strong> <small class="c-dim">v${m.version}</small></span>
    <span class="c-dim fs12">${m.trust}</span>${m.signature==='valid'?null:html`<span class="c-warn fs12">signature ${m.signature}</span>`}
    <span class="mhealth">${healthPill(m.doctor)}</span>${m.problem?html`<div class="wnote c-warn">${m.problem}</div>`:null}</div>`));
}

/* Reserved slot (the operator grid must not move when happrove ships): nothing serves happrove data yet. */
function ovApprovals(){
  const b=document.getElementById('ovApprovals'); if(!b) return;
  put(b,empty('happrove (approving owner actions with a tap on your phone) is not installed. Install it with:'),cmdBlock('hive-mind module add happrove'));
}

/* The one hive read carries per-node `by_day` (core 3.x), so the Devices sparklines (14 days) and the Activity chart (21 days) need no
   further read. A node entry without it comes from an older core: only those get one read each (through the request queue, at most OV_SPARK_CAP). */
const OV_ACT_DAYS=21;
const ovDays=n=>[...Array(n)].map((_,i)=>new Date(Date.now()-(n-1-i)*864e5).toISOString().slice(0,10));
const ovBy=l=>{ const by={}; (l||[]).forEach(d=>{ by[d.day]=d.sessions; }); return by; };
function ovSparks(){
  const t=OVD.tel; if(!t||VIEWER) return;
  const reach=(t.nodes||[]).filter(n=>n.reachable), have=reach.filter(n=>Array.isArray(n.by_day)), old=reach.filter(n=>!Array.isArray(n.by_day));
  have.forEach(n=>{ (OVD.perDay=OVD.perDay||{})[n.node_id]={name:n.node,by:ovBy(n.by_day)}; });
  if(have.length){ ovFleet(); ovActivity(); }
  /* The fallback read filters by device NAME. Two devices that share a name would both get the merged series, so they get no read (and no sparkline) until the daemon is updated. */
  const count={}; old.forEach(n=>{ count[n.node]=(count[n.node]||0)+1; });
  OVD.sameName=old.filter(n=>count[n.node]>1).length;
  old.filter(n=>count[n.node]===1).slice(0,OV_SPARK_CAP).forEach(n=>
    getJSON('/api/telemetry?scope=hive&fnode='+encodeURIComponent(n.node)+'&limit=1').then(r=>{
      (OVD.perDay=OVD.perDay||{})[n.node_id]={name:n.node,by:ovBy(r.by_day)};
      ovFleet(); ovActivity();
    }).catch(()=>{}));
}

/* Corpus growth (interim, no new route): facts and decisions added per day, from the newest 200 of each. When a kind has more than
   200 entries the window starts where the shorter list begins, so the two lines cover the same days. */
function ovGrowth(){
  const b=document.getElementById('ovGrowth'); if(!b) return;
  const f=OVD.gfacts, d=OVD.gdecs;
  if(!f||!d){ if(OVERR.gfacts||OVERR.gdecs) put(b,...ovFail(OVERR.gfacts?'gfacts':'gdecs',OV_DOWN)); return; }
  const fl=f.facts||[], dl=d.decisions||[], cut=(l,tot)=>(tot||0)>l.length;
  if(!fl.length&&!dl.length){ put(b,empty('nothing remembered yet. Add a fact with:'),cmdBlock('hv remember "<fact>" --tags <tag>')); return; }
  const day=r=>String(r.created||'').slice(0,10), first=l=>l.map(day).filter(Boolean).sort()[0];
  const lim=[cut(fl,f.facts_total)?first(fl):null,cut(dl,d.decisions_total)?first(dl):null].filter(Boolean).sort();
  const all=[first(fl),first(dl)].filter(Boolean).sort();
  const days=ovDays(90), week=ovDays(7)[0];
  let start=lim.length?lim[lim.length-1]:all[0]; if(start>week) start=week;
  const win=days.filter(x=>x>=start), n=l=>{ const by={}; l.forEach(r=>{ const k=day(r); if(k) by[k]=(by[k]||0)+1; }); return win.map(x=>by[x]||0); };
  const fp=n(fl), dp=n(dl), sum=a=>a.reduce((x,y)=>x+y,0), added=sum(fp)+sum(dp);
  const cap=(cut(fl,f.facts_total)||cut(dl,d.decisions_total))?' (counted from the newest 200 facts and 200 decisions)':'';
  put(b,html`<div class="wsum"><span class="big2">${fmtNum(added)}</span> added in the last ${win.length} days${cap}</div>
    ${VIZ.line([{label:'Facts',points:fp},{label:'Decisions',points:dp}],Object.assign({area:true,label:'Facts and decisions added per day, last '+win.length+' days: '+fmtNum(sum(fp))+' facts, '+fmtNum(sum(dp))+' decisions'},ovAnim('growth')))}
    <div class="legend"><span><i class="s1"></i>Facts ${fmtNum(sum(fp))}</span><span><i class="s2"></i>Decisions ${fmtNum(sum(dp))}</span></div>`);
}

/* Seat activity: sessions in the last 7 days by agent, from the newest 200 sessions on the hive (operator only). */
function ovSeats(){
  const b=document.getElementById('ovSeats'); if(!b) return;
  const t=OVD.tel;
  if(!t){ if(OVERR.tel) put(b,...ovFail('tel',OV_DOWN)); return; }
  const rec=t.recent||[], cut=Date.now()-7*864e5, by={};
  const at=r=>Date.parse(String(r.when||'')+'Z')||0;
  rec.forEach(r=>{ if(at(r)>=cut&&r.agent){ const a=by[r.agent]||(by[r.agent]={agent:r.agent,n:0,last:0}); a.n++; a.last=Math.max(a.last,at(r)); } });
  const rows=Object.values(by).sort((x,y)=>y.n-x.n||y.last-x.last).slice(0,8);
  if(!rows.length){ put(b,empty('no sessions in 7 days. Sessions appear here when an AI session runner (such as Claude Code) uses HiveMind.')); return; }
  const trunc=(t.recent_total||0)>rec.length&&rec.length&&Math.min(...rec.map(at))>cut;
  put(b,html`${VIZ.bars(rows.map(r=>({label:r.agent,value:r.n})),Object.assign({label:'Sessions in 7 days by agent: '+rows.map(r=>r.agent+' '+r.n).join(', ')},ovAnim('seats')))}
    ${rows.map(r=>html`<div class="srow"><span class="sname mono" title=${r.agent}>${r.agent}</span><span class="sn">${fmtNum(r.n)}</span><span class="c-dim fs12">last ${fmtAge(Math.round((Date.now()-r.last)/1000))} ago</span></div>`)}
    <div class="wnote">An agent is one AI session runner, such as <span class="mono">claude-code:david@gregorius</span>.${trunc?' Counted from the newest '+rec.length+' sessions, so a busy week can show fewer than it had.':''}</div>`);
}

/* Spend (interim): the cost of models with a known price is the all-time total; the bars are sessions per day until the daemon reports cost per day. */
function ovSpend(){
  const b=document.getElementById('ovSpend'); if(!b) return;
  const t=OVD.tel;
  if(!t){ if(OVERR.tel) put(b,...ovFail('tel',OV_DOWN)); return; }
  const models=Object.values(t.by_model||{}), unknown=models.filter(m=>!m.priced).length, tot=t.totals||{};
  if(!models.some(m=>m.priced)){ put(b,empty('no session with a known price yet.'),unknown?html`<div class="wnote">Price unknown: ${unknown} model${unknown===1?'':'s'}.</div>`:null); return; }
  const by={}; (t.by_day||[]).forEach(d=>{ by[d.day]=d.sessions; });
  const week=ovDays(7), vals=week.map(x=>by[x]||0);
  put(b,html`<div class="wsum"><span class="big2">${fmtCost(tot.cost_usd)}</span> all time, priced models only</div>
    ${VIZ.bars(week.map((x,i)=>({label:x,value:vals[i]})),Object.assign({label:'Sessions per day, last 7 days: '+vals.join(', ')},ovAnim('spend')))}
    <div class="wnote">Bars: sessions per day, last 7 days (cost per day is not reported yet).${unknown?' Price unknown: '+unknown+' model'+(unknown===1?'':'s')+', not in the total.':''}</div>`);
}

/* Activity: sessions per day across all devices, 21 days (the daemon returns at most the newest 21 days with sessions per device, so 21 calendar days is the longest window that is complete), stacked by device (operator only). Draws from the same per-device reads as the sparklines. */
function ovActivity(){
  const b=document.getElementById('ovActivity'); if(!b) return;
  const t=OVD.tel;
  if(!t){ if(OVERR.tel) put(b,...ovFail('tel',OV_DOWN)); return; }
  const devs=Object.values(OVD.perDay||{});
  if(!devs.length) return;
  const days=ovDays(OV_ACT_DAYS), tot=devs.reduce((a,d)=>a+days.reduce((x,k)=>x+(d.by[k]||0),0),0);
  if(!tot){ put(b,empty('no sessions recorded on any device.')); return; }
  const dup=OVD.sameName?html`<div class="wnote">${OVD.sameName} devices share a name and are left out. Rename one of them.</div>`:null;
  put(b,html`<div class="wsum"><span class="big2">${fmtNum(tot)}</span> sessions in the last ${OV_ACT_DAYS} days, across ${devs.length} device${devs.length===1?'':'s'}</div>
    ${VIZ.bars(days.map(k=>({label:k,parts:devs.map(d=>d.by[k]||0)})),Object.assign({stacked:true,label:'Sessions per day by device, last '+OV_ACT_DAYS+' days: '+devs.map(d=>d.name).join(', ')},ovAnim('activity')))}
    <div class="legend">${devs.map((d,i)=>html`<span><i class=${'s'+(i%6+1)}></i>${d.name}</span>`)}</div>${dup}`);
}

function ovFetch(){
  OVTRY=Date.now();
  let left=0, ok=0;
  const settled=()=>{ if(--left===0&&!ok){ OVFAIL=true; ovAgeDraw(); } };
  const ld=(key,url,post,draw)=>{ left++; getJSON(url).then(r=>{ ok++; OVAT=Date.now(); OVFAIL=false; OVD[key]=post?post(r):r; OVERR[key]=null; draw(); }).catch(e=>{ OVERR[key]=e; if(OVD[key]==null) draw(); }).then(settled); };
  ld('meta','/api/overview',r=>{ META=r; put($('#hMerkle'),r.merkle); return r; },()=>{ ovHero(); ovMix(); });
  ld('ideas','/api/search?kind=idea&limit=1',r=>r.ideas_total==null?(r.ideas||[]).length:r.ideas_total,()=>{ ovHero(); ovMix(); });
  ld('verify','/api/verify',null,ovHero);
  ld('peers','/api/peers?probe=0',r=>r.peers,()=>{ ovHero(); ovFleet(); });
  ld('audit','/api/audit',null,ovAudit);
  ld('gfacts','/api/search?kind=fact&sort=recency&limit=200',null,ovGrowth);
  ld('gdecs','/api/search?kind=decision&sort=recency&limit=200',null,ovGrowth);
  if(!VIEWER){
    ld('tel','/api/telemetry?scope=hive&limit=200&sort=recent',null,()=>{ ovHero(); ovFleet(); ovSparks(); ovSeats(); ovSpend(); ovActivity(); });
    ld('modules','/api/modules',null,ovModules);
    ovApprovals();
  }
}

/* One timer per Overview: it redraws "updated Ns ago", refreshes when the period is up while the tab is visible, and ends with the view. */
function ovTick(){
  if(!ovLive()){ clearInterval(OVT); OVT=null; return; }
  if(document.hidden) return;
  if(Date.now()-OVTRY>=OV_EVERY) ovFetch(); else ovHero();
}
document.addEventListener('visibilitychange',()=>{ if(!document.hidden&&OVT) ovTick(); });

async function overview(){
  OVD={meta:META}; OVERR={}; OVSEEN={}; OVAT=0; OVTRY=0; OVFAIL=false;
  clearInterval(OVT);
  put($('#app'),html`<div class="wgrid" id="ovroot">
    <section class="hero w12">
      <div class="hstats">
        ${heroStat('ovFacts','Facts','things this hive remembers')}
        ${heroStat('ovDecs','Decisions','choices recorded with the reason')}
        ${heroStat('ovIdeas','Ideas','hypotheses that earn confidence later')}
        ${heroStat('ovContested','Contested','facts with a correction against them')}
        ${heroStat('ovOnline','Devices online','of … admitted','ovOnlineSub')}
      </div>
      <div class="hside">
        <button class="hverify" id="ovShield" type="button" title="Check that this software is genuine" onclick=${openOfficialModal}><span class="c-dim">checking…</span></button>
        <div id="ovWho"></div>
        <div class="mono" title="merkle root: a hash of the whole journal of entries. Equal on two devices means they hold the same entries (they are in sync)." id="ovMerkle"></div>
        <div class="sub" id="ovAge"></div>
      </div>
    </section>
    ${widget('w6','ovFleet','Devices',()=>goTab('hive'),'rows','Hive')}
    ${widget('w6','ovGrowth','Corpus growth',()=>goTab('corpus'),'bars','Corpus')}
    ${widget('w4','ovMix','Corpus mix',()=>goTab('corpus'),'ring','Corpus')}
    ${widget(VIEWER?'w8':'w4','ovAudit','Audit',()=>goView('audit'),'bars','Details')}
    ${VIEWER?null:widget('w4','ovModules','Modules',()=>goTab('modules'),'rows','Modules')}
    ${VIEWER?null:widget('w4','ovSeats','Seat activity',()=>goTab('agents'),'bars','Agents')}
    ${VIEWER?null:widget('w4','ovSpend','Spend this week',()=>goTab('spend'),'bars','Spend')}
    ${VIEWER?null:widget('w4','ovApprovals','Approvals',null,'rows')}
    ${VIEWER?null:widget('w12','ovActivity','Activity',()=>goTab('telemetry'),'bars','Telemetry')}
  </div>`);
  ovFetch();
  OVT=setInterval(ovTick,5000);
}

/* ---------- Corpus ---------- */
/* Sub-tabs (hdash_overview_v2 §4). Each sets the kind and sort of the one search behind it; the sub-tab is in the URL hash
   (`#corpus/latest-facts`) so a reload or a pasted link returns to it. Entities is the operator's: the viewer listener refuses it. */
const SUBS=[['search','Search'],['latest-facts','Latest facts'],['latest-decisions','Latest decisions'],['ideas','Ideas'],['entities','Entities']];
const SUB_SET={search:{kind:'all',sort:'confidence'},'latest-facts':{kind:'fact',sort:'recency'},'latest-decisions':{kind:'decision',sort:'recency'},ideas:{kind:'idea',sort:'recency'},entities:{}};
const subList=()=>SUBS.filter(s=>!(VIEWER&&s[0]==='entities'));
const KIND_KEY={fact:'facts',decision:'decisions',idea:'ideas'}, KIND_LABEL={fact:'Facts',decision:'Decisions',idea:'Ideas'}, KIND_PANEL={fact:'fpanel',decision:'dpanel',idea:'ipanel'};
let C={q:'',sub:'search',kind:'all',tags:[],mode:'and',sort:'confidence',status:'all',pg:{fact:1,decision:1,idea:1},res:{fact:{rows:[],total:0},decision:{rows:[],total:0},idea:{rows:[],total:0}},tagList:null,showAll:false,verOpen:false,scan:{}};
const pg1=()=>{C.pg={fact:1,decision:1,idea:1};};
const kindsShown=()=>C.sub==='ideas'?['idea']:C.kind==='all'?['fact','decision']:[C.kind];
const restHash=()=>state.view==='corpus'&&!state.node&&C.sub!=='search'?'#corpus/'+C.sub:'';
function applySub(s){ C.sub=s; Object.assign(C,SUB_SET[s]); C.status='all'; pg1(); }
/* The tag picker: several tags at once, ANDed (a row carries all of them) or ORed (a row carries any). The core's search takes one `tag`, so
   AND asks for the first tag and keeps the rows that carry the rest (up to SCAN_PAGES pages of SCAN_PER; past that the list says it
   stopped), and OR asks once per tag, at most OR_MAX tags, and merges the rows. The viewer listener refuses a repeated `tag`, and both paths send one. */
const NOISE_TAG=/^\d+$|^(?=.*\d)[0-9a-f]{7,}$/, VER_TAG=/^\d+\.[\dx.]+/, TAG_SHOW=150, SCAN_PER=200, SCAN_PAGES=5, OR_MAX=8;
function tagPickFill(){
  const q=(($('#tagq')||{}).value||'').trim().toLowerCase(), all=C.tagList||[], sel=C.tags;
  const isNoise=t=>NOISE_TAG.test(t), isVer=t=>!isNoise(t)&&VER_TAG.test(t);
  const hideNoise=!C.showAll&&!q;   // typing a tag finds it even when it is a number or an id
  const rest=all.filter(t=>!sel.includes(t)&&t.toLowerCase().includes(q)&&!(hideNoise&&isNoise(t)));
  const vers=hideNoise?rest.filter(isVer):[], plain=hideNoise?rest.filter(t=>!isVer(t)):rest, shown=sel.concat(plain);
  const hidden=all.filter(isNoise).length, join=C.mode==='or'?' or ':' + ';
  const opt=t=>html`<label class="tagopt"><input type="checkbox" checked=${sel.includes(t)} onchange=${e=>toggleTag(t,e.target.checked)}> ${t}</label>`;
  put($('#tagsum'),sel.length?'Tags: '+(sel.length>2?sel.length+' selected':sel.join(join)):'All tags');
  put($('#taglist'),shown.slice(0,TAG_SHOW).map(opt),
    vers.length?html`<details class="tagver" open=${C.verOpen} ontoggle=${e=>{C.verOpen=e.target.open;}}><summary>versions (${vers.length})</summary>${vers.slice(0,TAG_SHOW).map(opt)}</details>`:null,
    shown.length>TAG_SHOW?html`<div class="note">${shown.length-TAG_SHOW} more: type to narrow</div>`:null,
    !all.length?html`<div class="note">no tags</div>`:null);
  put($('#tagnoisel'),html`<input type="checkbox" checked=${C.showAll} onchange=${e=>{C.showAll=e.target.checked;tagPickFill();}}> show all${hidden?' ('+hidden+' numbers and ids hidden)':''}`);
  const seg=(m,lab,tip)=>html`<button type="button" class=${C.mode===m?'pg on':'pg'} aria-pressed=${String(C.mode===m)} title=${tip} onclick=${()=>setMode(m)}>${lab}</button>`;
  put($('#tagmode'),html`<span class="seg" role="group" aria-label="Match">${seg('and','AND','a row must carry every selected tag')}${seg('or','OR','a row may carry any selected tag; at most '+OR_MAX+' tags')}</span>`);
  put($('#tagchips'),sel.map(t=>html`<span class="chip sel">${t}<button type="button" class="x" aria-label=${'remove tag '+t} onclick=${()=>toggleTag(t,false)}>×</button></span>`),
    sel.length>1?html`<span class="c-dim fs12">${C.mode==='or'?'rows with any of these'+(sel.length>OR_MAX?' (first '+OR_MAX+' used)':''):'rows with all of these'}</span>`:null);
}
function setMode(m){ if(C.mode===m) return; C.mode=m; pg1(); tagPickFill(); if(C.tags.length>1) loadCorpus(); }
function toggleTag(t,on){ C.tags=on?C.tags.concat(C.tags.includes(t)?[]:[t]):C.tags.filter(x=>x!==t); pg1(); tagPickFill(); loadCorpus(); }
async function scanAnd(kind){   // every row of the first tag's search that also carries the other selected tags
  const key=JSON.stringify([C.q,C.sort,C.status,C.mode,C.tags]), hit=C.scan[kind]; if(hit&&hit.key===key) return hit;
  const f=KIND_KEY[kind], rows=[]; let capped=false;
  for(let pg=0;;pg++){
    const p=new URLSearchParams({q:C.q,kind,sort:C.sort,status:C.status,limit:String(SCAN_PER),offset:String(pg*SCAN_PER),tag:C.tags[0]});
    const s=await getJSON('/api/search?'+p), got=s[f]||[];
    rows.push(...got.filter(r=>C.tags.every(t=>(r.tags||[]).includes(t))));
    if((pg+1)*SCAN_PER>=(s[f+'_total']||got.length)||!got.length) break;
    if(pg+1>=SCAN_PAGES){ capped=true; break; }
  }
  return C.scan[kind]={key,rows,capped};
}
async function scanOr(kind){   // one search per selected tag (at most OR_MAX), merged by short id and sorted again
  const tags=C.tags.slice(0,OR_MAX), key=JSON.stringify([C.q,C.sort,C.status,C.mode,tags]), hit=C.scan[kind]; if(hit&&hit.key===key) return hit;
  const f=KIND_KEY[kind], seen=new Map(); let capped=false;
  const got=await Promise.all(tags.map(t=>getJSON('/api/search?'+new URLSearchParams({q:C.q,kind,sort:C.sort,status:C.status,limit:String(SCAN_PER),offset:'0',tag:t}))));
  got.forEach(s=>{ const rs=s[f]||[]; if((s[f+'_total']||rs.length)>rs.length) capped=true; rs.forEach(r=>{ const k=r.sid||r.ref||r.id; if(!seen.has(k)) seen.set(k,r); }); });
  const rows=[...seen.values()];
  const newest=(a,b)=>String(b.created).localeCompare(String(a.created));   // decisions carry no confidence/importance/utility: newest first
  rows.sort(C.sort==='recency'?newest:(a,b)=>(b[C.sort]||0)-(a[C.sort]||0)||newest(a,b));
  return C.scan[kind]={key,rows,capped};
}
const cappedNote=kind=>{const h=C.scan[kind]; if(C.tags.length<2||!h) return null;
  if(C.mode==='or') return h.capped?html`<div class="note">Showing the first ${SCAN_PER} results for each selected tag only; add a search word to narrow.</div>`:null;
  return h.capped?html`<div class="note">Showing matches among the first ${SCAN_PAGES*SCAN_PER} results for “${C.tags[0]}” only; add a search word or tag to narrow.</div>`:null;};
function corpus(){
  if(C.sub==='entities'&&VIEWER) applySub('search');
  try{ const h=restHash()||(C.sub==='search'?'':'#corpus/'+C.sub); if(location.hash!==h&&/^(#corpus.*)?$/.test(location.hash)) history.replaceState(null,'',h||location.pathname+location.search); }catch(e){}
  const subnav=html`<div class="subnav" role="tablist">${subList().map(s=>html`<button role="tab" aria-selected=${String(C.sub===s[0])} class=${C.sub===s[0]?'on':null} onclick=${()=>goSub(s[0])}>${s[1]}</button>`)}</div>`;
  if(C.sub==='entities'){ put($('#app'),subnav,html`<div id="results">${spin()}</div>`); loadEntities(); return; }
  const srch=C.sub==='search', ideas=C.sub==='ideas';
  put($('#app'),subnav,html`
   <div class="controls">
     <input type="search" id="q" placeholder=${ideas?'Search ideas…':'Search facts & decisions, or paste an id (h:… or node:seq)…'} value=${C.q}>
     ${srch?html`<select id="kind"><option value="all">All</option><option value="fact">Facts</option><option value="decision">Decisions</option></select>`:null}
     ${srch||ideas?html`<select id="sort"><option value="confidence">Sort: confidence</option><option value="importance">Sort: importance</option><option value="utility">Sort: utility</option><option value="recency">Sort: recency</option></select>`:null}
     ${srch||C.sub==='latest-facts'?html`<select id="status"><option value="all">Status: live</option><option value="contested">Contested</option><option value="forgotten">Forgotten</option><option value="volatile">Volatile</option></select>`:null}
     <details class="tagpick"><summary id="tagsum" class="chip"></summary><div class="tagbox">
       <input type="search" id="tagq" placeholder="filter tags…">
       <div class="tagrow"><span id="tagmode"></span><button type="button" class="chip" id="tagclear">clear</button></div>
       <div class="tagrow"><label id="tagnoisel"></label></div>
       <div id="taglist"></div></div></details>
   </div><div id="tagchips" class="tagchips"></div><div id="results">${spin()}</div>`);
  ['kind','sort','status'].forEach(id=>{ const e=$('#'+id); if(e) e.value=C[id]; });
  tagPickFill(); $('#tagq').oninput=tagPickFill; $('#tagclear').onclick=()=>{C.tags=[];pg1();tagPickFill();loadCorpus();};
  if(!C.tagList) getJSON('/api/tags').then(r=>{C.tagList=r.tags||[];tagPickFill();}).catch(()=>{});   // kept across visits: the picker is rebuilt each time the page opens
  let timer; const reload=()=>{C.q=$('#q').value; const id=C.q.trim(); if(ID_RE.test(id)){ openById(id).then(ok=>{ if(!ok) reload2(); }); return; } reload2(); };
  const reload2=()=>{ ['kind','sort','status'].forEach(k=>{ const e=$('#'+k); if(e) C[k]=e.value; }); pg1(); loadCorpus(); };
  $('#q').oninput=()=>{clearTimeout(timer);timer=setTimeout(reload,200);};
  ['kind','sort','status'].forEach(id=>{ const e=$('#'+id); if(e) e.onchange=reload; });
  loadCorpus();
}
function goSub(s){ applySub(s); corpus(); }
/* A name more than one entity holds is shown with its id (`label`); a unique name is shown bare. */
function loadEntities(){
  getJSON('/api/entities').then(r=>{const el=$('#results'); if(!el||state.view!=='corpus'||C.sub!=='entities') return;
    if(!r.entities.length){ put(el,empty('no entities recorded yet')); return; }
    put(el,html`<div class="panel"><h2>Entities <span class="count">${r.entities.length}${r.shared_names?html` · ${r.shared_names} shared name${r.shared_names===1?'':'s'}`:null}</span></h2>
      <table><thead><tr><th>Entity</th><th>Type</th><th>Facts</th></tr></thead><tbody>${r.entities.map(e=>html`<tr><td>${e.label}</td><td>${e.type||''}</td><td>${e.facts}</td></tr>`)}</tbody></table></div>`);
  }).catch(e=>{const el=$('#results'); if(el) put(el,empty(failText(e,'could not read entities')));});
}
function cparams(kind,page){const p=new URLSearchParams({q:C.q,kind,sort:C.sort,status:C.status,limit:String(PER),offset:String((page-1)*PER)});if(C.tags.length)p.set('tag',C.tags[0]);return p.toString();}
async function loadKind(kind){
  const r=C.res[kind], page=C.pg[kind], f=KIND_KEY[kind];
  if(C.tags.length>1){ const h=await (C.mode==='or'?scanOr:scanAnd)(kind); r.rows=h.rows.slice((page-1)*PER,page*PER); r.total=h.rows.length; return; }
  const s=await getJSON('/api/search?'+cparams(kind,page)); r.rows=s[f]||[]; r.total=s[f+'_total']||r.rows.length;
}
const ideaRow=i=>html`<div class="row link" onclick=${()=>{ if(i.sid) openById(i.sid); }}><div class="content">${(i.content||'').slice(0,240)}</div>
   <div class="meta">${confBar(i.confidence)}${confNum(i.confidence)}${i.contested?pill('contested','CONTESTED'):null}${(i.tags||[]).map(t=>tagChip(t))}
     <span class="mtauto">${i.source} · ${i.created}</span></div></div>`;
const KIND_ROW={fact:factRow,decision:decRow,idea:ideaRow};
function panelFill(kind){
  const r=C.res[kind]; if(kind==='fact') LAST.facts=r.rows; else if(kind==='decision') LAST.decisions=r.rows;
  put($('#'+KIND_PANEL[kind]),listBody(KIND_LABEL[kind],r.total,r.rows.map(KIND_ROW[kind]),C.pg[kind],p=>goPage(kind,p),'no matches'),cappedNote(kind));
}
const panelShell=(id,label)=>html`<div id=${id} class="panel"><h2>${label}</h2>${spin()}</div>`;
const panelFail=(kind,e)=>put($('#'+KIND_PANEL[kind]),html`<h2>${KIND_LABEL[kind]}</h2>`,empty(failText(e,'error')));
function loadCorpus(){   // progressive: render each panel's shell, then fill each kind independently
  const ks=kindsShown(), sub=C.sub;
  put($('#results'),ks.map(k=>panelShell(KIND_PANEL[k],KIND_LABEL[k])));
  ks.forEach(k=>loadKind(k).then(()=>{ if(C.sub===sub&&$('#'+KIND_PANEL[k])) panelFill(k); }).catch(e=>{ if($('#'+KIND_PANEL[k])) panelFail(k,e); }));
}
const goPage=async(kind,p)=>{C.pg[kind]=p;const el=$('#'+KIND_PANEL[kind]);put(el,html`<h2>${KIND_LABEL[kind]}</h2>`,spin());try{await loadKind(kind);}catch(err){}if($('#'+KIND_PANEL[kind]))panelFill(kind);if(kind==='fact')window.scrollTo({top:0});};
const filterTag=t=>{if(state.detail||state.node){state.detail=null;state.node=null;}state.view='corpus';C.sub='search';C.tags=[t];C.q='';C.kind='all';C.status='all';pg1();
  setNav('corpus');corpus();};
const openContested=()=>{state.node=null;state.detail=null;state.view='corpus';C.sub='search';C.q='';C.tags=[];C.kind='fact';C.status='contested';C.sort='confidence';pg1();
  setNav('corpus');corpus();};

/* ---------- Hive ---------- */
const dotFor=s=>({'in sync':'ok','reachable':'ok','admitted':'ok','diverged':'stale','stale':'stale','offline':'off'}[s]||'off');
/* A module identity is an admitted key of its own (`module` names it); it is not a device. A core that sends no `module`
   field leaves every row a device, as before. With `host` (the device id) a module identity nests under its device; without it,
   or when the host is not in the list, it joins one section of its own grouped by module name. */
const isModuleRow=p=>typeof p.module==='string'&&p.module!=='';
function groupPeers(all){
  const devices=all.filter(p=>!isModuleRow(p)), ids=new Set(devices.map(p=>p.device)), nested={}, loose=[];
  all.filter(isModuleRow).forEach(m=>{ if(typeof m.host==='string'&&ids.has(m.host)) (nested[m.host]=nested[m.host]||[]).push(m); else loose.push(m); });
  Object.values(nested).forEach(a=>a.sort((x,y)=>x.module<y.module?-1:x.module>y.module?1:0));
  return {devices,nested,loose};
}
const openModule=name=>{MP={name,tab:'overview'};state.view='modulePage';state.node=null;state.detail=null;setNav('modules');render();};
const modLink=m=>html`<button class="linkbtn" type="button" onclick=${()=>openModule(m.module)} title=${"Open Modules › "+m.module}>${m.module}</button>`;
/* One compact line per module (name, then what this page is about); the full card is on Modules. Trust and Governance use it. */
const moduleLines=(mods,facts)=>mods.length?mods.map(m=>html`<div class="mrow"><button class="linkbtn mname" type="button" onclick=${()=>openModule(m.name)} title=${'Open Modules › '+m.name}><strong>${m.name}</strong></button>${facts(m)}</div>`):empty('No modules installed.');
let HOPEN={};   // device ids whose module identities are expanded (Hive and Telemetry share it)
const toggleHost=(id,again)=>{ HOPEN[id]=!HOPEN[id]; again(); };
const hostBtn=(d,n,again)=>n?html`<button class="twist" type="button" aria-expanded=${HOPEN[d.device]?'true':'false'} title=${n+' module identit'+(n===1?'y':'ies')+' on this device'} onclick=${e=>{e.stopPropagation();toggleHost(d.device,again);}}>${HOPEN[d.device]?'▾':'▸'}</button>`:html`<span class="twist"></span>`;
const modCount=n=>n?html` <span class="c-dim sm">${n} module${n===1?'':'s'}</span>`:null;
function peerRows(peers,probing,nested,again){
  const out=[];
  peers.forEach(p=>{const cls=p.self?'self':dotFor(p.status), kids=nested[p.device]||[];
    const st=p.self?p.status:(probing&&!/stale|offline/.test(p.status)?[html`<span class="spin sm"></span>`,' resolving…']:p.status);
    const gone=!p.self&&/stale|offline/.test(p.status);
    out.push(html`<tr class="link" onclick=${()=>openNode(p.device)} title="View this node">
      <td>${hostBtn(p,kids.length,again)}<span class=${'dot '+cls}></span>${p.name}${modCount(kids.length)}
        ${gone?html`<div class="sub c-dim">to remove a device that will not return: <span class="mono">hive-mind group purge ${p.device}</span></div>`:null}</td><td class="mono">${p.device}</td><td>${p.principal}</td>
      <td class="mono">${p.addr}</td><td>${p.seen}</td><td>${st}</td></tr>`);
    if(HOPEN[p.device]) kids.forEach(m=>out.push(html`<tr class="modrow"><td class="nest"><span class="dot off"></span>${modLink(m)} <span class="c-dim sm">module identity</span></td><td class="mono">${m.device}</td><td>${m.principal}</td><td class="mono">${m.addr}</td><td>${m.seen}</td><td>${m.status}</td></tr>`));
  });
  return out;
}
function moduleIdentities(mods){
  if(!mods.length) return null;
  const names=[...new Set(mods.map(p=>p.module))].sort();
  return html`<div class="panel"><h2>Module identities <span class="count">${mods.length} admitted</span></h2>
    <table><thead><tr><th>Module</th><th>Identities</th><th>Last seen</th></tr></thead>
    <tbody>${names.map(n=>{const ids=mods.filter(p=>p.module===n);
      return html`<tr><td>${modLink(ids[0])}</td><td class="mono">${ids.map(p=>html`<div>${p.device}</div>`)}</td><td>${ids.map(p=>html`<div>${p.seen}</div>`)}</td></tr>`;})}</tbody></table></div>
    <div class="note">Each installed module has its own admitted key. They are not devices and are not duplicates: do not purge them.</div>`;
}
function hiveShell(all,probing){
  const g=groupPeers(all), again=()=>hiveShell(all,probing);
  const rows=peerRows(g.devices,probing,g.nested,again);
  put($('#app'),html`<div class="panel"><h2>Devices <span class="count">${g.devices.length} admitted</span>${probing?html`<span class="spin sm"></span>`:null}</h2>
     <table><thead><tr><th>Name</th><th>Device</th><th>Principal</th><th>Address</th><th>Last seen</th><th>Status</th></tr></thead>
     <tbody>${rows.length?rows:html`<tr><td colspan="6" class="empty">no peers</td></tr>`}</tbody></table></div>
   ${moduleIdentities(g.loose)}
   <div class="note">Click a device for its overview, corpus, stats &amp; telemetry. The ▸ beside a device opens the module identities on it.</div>
   <div class="grid cards mt16">
     <div class="card"><div class="lbl">Owner</div><div class="stat fs17">${META.role==='OWNER'?META.node:'(remote)'}</div><div class="sub mono" title="public id — the owner key itself is never shown">${META.owner_id||'—'}${META.owner_id?html` <span class="muted">(public id)</span>`:null}</div></div>
     <div class="card"><div class="lbl">Hive</div><div class="stat mono fs14 c-ink">${META.hive||'—'}</div></div>
     <div class="card"><div class="lbl">Merkle root</div><div class="stat mono fs13 c-accent">${META.merkle}</div><div class="sub">${META.nodes} node(s) admitted</div></div>
   </div>`);
}
async function hive(){
  put($('#app'),spin('loading peers…')); let fast=[];
  try{ fast=(await getJSON('/api/peers?probe=0')).peers; }catch(e){}
  PEERS=fast; hiveShell(fast,true);
  try{ const probed=(await getJSON('/api/peers')).peers; PEERS=probed; if(state.view==='hive'&&!state.node&&!state.detail) hiveShell(probed,false); }
  catch(e){ if(state.view==='hive'&&!state.node&&!state.detail) hiveShell(fast,false); }
}

/* ---------- Telemetry body (shared) ---------- */
const modelTable=(rows)=>html`<div class="panel"><h2>By model</h2><table><thead><tr><th>Model</th><th>In</th><th>Out</th><th>Cost</th></tr></thead><tbody>${rows}</tbody></table></div>`;
function telemetryBody(t,page,pagerFn,showNode,drill,noCards){
  LAST.sessions=t.recent||[];
  const T=t.totals||{}; const days=t.by_day||[]; const max=Math.max(1,...days.map(d=>d.sessions));
  const bars=days.map(d=>html`<div title=${d.day+': '+d.sessions+(drill?' — click to filter':'')} style=${Object.assign({height:Math.round(d.sessions/max*100)+'%'},drill?{cursor:'pointer'}:{})} onclick=${drill?()=>telFilterDay(d.day):null}></div>`);
  const xlab=days.map((d,i)=>html`<div>${(i===0||i===days.length-1)?d.day.slice(5):''}</div>`);
  const models=Object.entries(t.by_model||{}).sort((a,b)=>(b[1].in+b[1].out)-(a[1].in+a[1].out));
  const total=t.recent_total||T.sessions||0; const pg=()=>pager(page,total,PER,pagerFn);
  const recent=(t.recent||[]).map((r,i)=>html`<tr class="link" onclick=${()=>openSession(i)}><td class="mono">${r.when}</td>${showNode?html`<td>${r.node_name||r.node||'-'}</td>`:null}<td>${r.agent}</td><td>${r.project}</td><td>${fmtDur(r.duration_s)}</td><td>${fmtNum(r.tokens_in)}/${fmtNum(r.tokens_out)}</td><td>${fmtCost(r.cost_usd)}</td></tr>`);
  return html`${noCards?null:html`<div class="grid cards">
     <div class="card"><div class="lbl">Sessions</div><div class="stat">${fmtNum(T.sessions||0)}</div></div>
     <div class="card"><div class="lbl">Time</div><div class="stat fs20">${fmtDur(T.duration_s)}</div></div>
     <div class="card"><div class="lbl">Tokens</div><div class="stat fs18">${fmtNum(T.tokens_in)}<small> in</small> / ${fmtNum(T.tokens_out)}<small> out</small></div></div>
     <div class="card"><div class="lbl">Cost</div><div class="stat fs20">${fmtCost(T.cost_usd)}${models.some(([,v])=>!v.priced)?html`<small> priced models only</small>`:null}</div></div></div>`}
   <div class="panel"><h2>Sessions per day</h2><div class="spark">${bars}</div><div class="sparkx">${xlab}</div></div>
   ${models.length?modelTable(models.map(([m,v])=>html`<tr class=${drill?'link':null} onclick=${drill?()=>telFilterModel(m):null}><td class="mono">${m}</td><td>${fmtNum(v.in)}</td><td>${fmtNum(v.out)}</td><td>${v.priced?fmtCost(v.cost):'unpriced'}</td></tr>`)):null}
   <div class="panel"><h2>${fmtNum(total)} Recent session${total===1?'':'s'}${pg()}</h2>
     <table><thead><tr><th>When</th>${showNode?html`<th>Node</th>`:null}<th>Agent</th><th>Project</th><th>Dur</th><th>Tokens</th><th>Cost</th></tr></thead><tbody>${recent}</tbody></table>
     ${total>PER?html`<div class="pgfoot">${pg()}</div>`:null}</div>`;
}


/* The Telemetry storyline (hdash_overview_v2 §5): a question, a headline, three charts from the one hive-wide read the page already
   makes (no per-device reads), then Raw: today's filters and tables, off by default. */
let TRAW=false;
const TEL_DAYS=21; // core _tel_aggregate caps by_day at the 21 most recent active days; a longer window would draw older days as zero
function telStory(t,devs){
  const T=t.totals||{}, by={}; (t.by_day||[]).forEach(d=>{ by[d.day]=d.sessions; });
  const days=ovDays(TEL_DAYS), vals=days.map(k=>by[k]||0), inWin=vals.reduce((a,b)=>a+b,0);
  const models=Object.entries(t.by_model||{}).sort((a,b)=>b[1].out-a[1].out).slice(0,8);
  const unp=models.filter(([,v])=>!v.priced).length;
  const dv=devs.slice().sort((a,b)=>b.sessions-a.sessions).slice(0,8);
  const legend=(rows)=>html`<div class="legend">${rows.map(([label,n,i,h])=>html`<span><i class=${'s'+(i%6+1)}></i>${label} ${fmtNum(n)}${h?' (price unknown)':''}</span>`)}</div>`;
  const a=(k)=>({animate:!TSEEN[k]});
  const out=html`<div class="panel"><div class="note">How much work are my devices doing?</div>
    <div class="wsum"><span class="big2">${fmtNum(T.sessions||0)}</span> sessions in total, ${fmtNum(inWin)} in the last ${TEL_DAYS} days · ${fmtDur(T.duration_s)} of work · ${fmtNum(T.tokens_out)} tokens out · ${fmtCost(T.cost_usd)}${unp?' (models with a known price only)':''}</div></div>
    <div class="panel"><h2>Sessions per day, last ${TEL_DAYS} days</h2>
      ${inWin?VIZ.bars(days.map((k,i)=>({label:k,value:vals[i]})),Object.assign({label:'Sessions per day, last '+TEL_DAYS+' days: '+inWin+' in total'},a('day'))):empty('no sessions in the last '+TEL_DAYS+' days')}
      <div class="sparkx ends"><div>${days[0].slice(5)}</div><div>${days[days.length-1].slice(5)}</div></div></div>
    <div class="panel"><h2>Tokens out by model</h2>
      ${models.length?html`${VIZ.bars(models.map(([m,v])=>({label:m,value:v.out,hatch:!v.priced})),Object.assign({label:'Tokens out by model: '+models.map(([m,v])=>m+' '+fmtNum(v.out)).join(', ')},a('model')))}
        ${legend(models.map(([m,v],i)=>[m,v.out,i,!v.priced]))}
        ${unp?html`<div class="note">Open bars are models with no known price, so they have no cost in the headline.</div>`:null}`:empty('no model usage recorded yet')}</div>
    <div class="panel"><h2>Sessions by device</h2>
      ${dv.length?html`${VIZ.bars(dv.map(n=>({label:n.node,value:n.sessions})),Object.assign({label:'Sessions by device: '+dv.map(n=>n.node+' '+fmtNum(n.sessions)).join(', ')},a('dev')))}
        ${legend(dv.map((n,i)=>[n.node,n.sessions,i]))}`:empty('no device has reported sessions yet')}</div>`;
  ['day','model','dev'].forEach(k=>{ TSEEN[k]=1; });
  return out;
}
const TSEEN={};
const telRaw=on=>{ TRAW=on; if(!on){TF.fnode=TF.fproject=TF.fagent=TF.fday=TF.fmodel='';TP=1;} telemetry(); };

/* ---------- Telemetry tab (combined across the hive, sort+filter) ---------- */
let TP=1, TF={sort:'recent',fnode:'',fproject:'',fagent:'',fday:'',fmodel:''};
const goTel=p=>{TP=p;telemetry();window.scrollTo({top:0});};
const telReload=()=>{TF.sort=$('#tsort').value;TF.fnode=$('#tnode').value;TF.fproject=$('#tproj').value;TF.fagent=$('#tagent').value;TP=1;telemetry();};
const telFilterModel=m=>{TRAW=true;TF.fmodel=m;TP=1;telemetry();};
const telFilterDay=d=>{TRAW=true;TF.fday=d;TP=1;telemetry();};
async function telemetry(){
  put($('#app'),spin('aggregating telemetry across the hive…'));
  const p=new URLSearchParams({scope:'hive',sort:TF.sort,limit:String(PER),offset:String((TP-1)*PER)});
  if(TF.fnode)p.set('fnode',TF.fnode); if(TF.fproject)p.set('fproject',TF.fproject); if(TF.fagent)p.set('fagent',TF.fagent);
  if(TF.fday)p.set('fday',TF.fday); if(TF.fmodel)p.set('fmodel',TF.fmodel);
  let t; try{ t=await getJSON('/api/telemetry?'+p.toString()); }catch(e){ put($('#app'),empty('telemetry unavailable')); return; }
  const fac=t.facets||{projects:[],agents:[],nodes:[]};
  const opt=(arr,sel)=>arr.map(x=>html`<option selected=${x===sel}>${x}</option>`);
  const admitted=t.admitted||(t.nodes||[]).length, online=t.online||0, reporting=t.reporting||0;
  const noTel=online-reporting, off=admitted-online;
  const dotForNode=s=>({self:'self',online:'ok','no-telemetry':'stale',offline:'off'}[s]||'off');
  const statusText=s=>({self:'this node',online:'online','no-telemetry':'online · no telemetry (older code)',offline:'offline'}[s]||s);
  const controls=html`<div class="controls">
     <select id="tsort"><option value="recent">Sort: recency</option><option value="cost">Sort: cost</option><option value="tokens">Sort: tokens</option><option value="duration">Sort: duration</option></select>
     <select id="tnode"><option value="">All nodes</option>${opt(fac.nodes,TF.fnode)}</select>
     <select id="tproj"><option value="">All projects</option>${opt(fac.projects,TF.fproject)}</select>
     <select id="tagent"><option value="">All agents</option>${opt(fac.agents,TF.fagent)}</select>
   </div>`;
  const line=html`<div class="note"><b>${admitted} admitted · ${online} online · ${reporting} reporting telemetry</b>${noTel?` · ${noTel} online without telemetry (older code — joins after update)`:''}${off?` · ${off} offline`:''}. Telemetry is local to each node, aggregated live over the tailnet.</div>`;
  let pr=[]; try{ pr=(await getJSON('/api/peers?probe=0')).peers; }catch(e){}
  const mrow={}; pr.forEach(p=>{ if(isModuleRow(p)) mrow[p.device]=p; });
  const isMod=n=>!!mrow[n.node_id], devs=(t.nodes||[]).filter(n=>!isMod(n)), nest={}, loose=[];
  (t.nodes||[]).filter(isMod).forEach(n=>{ const m=mrow[n.node_id], h=typeof m.host==='string'&&devs.some(d=>d.node_id===m.host)?m.host:null; if(h) (nest[h]=nest[h]||[]).push(n); else loose.push(n); });
  const modName=n=>mrow[n.node_id].module, again=()=>telemetry();
  const modTr=n=>html`<tr class=${'modrow'+(n.status==='offline'?' off':'')}><td class="nest"><span class=${'dot '+dotForNode(n.status)}></span>${modLink(mrow[n.node_id])} <span class="c-dim sm">module identity</span></td><td>${fmtNum(n.sessions)}</td><td>${statusText(n.status)}</td></tr>`;
  const nodeTrs=devs.flatMap(n=>{ const kids=nest[n.node_id]||[];
    return [html`<tr class=${'link'+(n.status==='offline'?' off':'')} onclick=${()=>openNode(n.node_id)}><td>${hostBtn({device:n.node_id},kids.length,again)}<span class=${'dot '+dotForNode(n.status)}></span>${n.node}${modCount(kids.length)}</td><td>${fmtNum(n.sessions)}</td><td>${statusText(n.status)}</td></tr>`,
      ...(HOPEN[n.node_id]?kids.map(modTr):[])]; });
  const nodesPanel=html`<div class="panel"><h2>${devs.length} Devices</h2><table><thead><tr><th>Device</th><th>Sessions</th><th>Status</th></tr></thead><tbody>${nodeTrs}</tbody></table></div>
    ${loose.length?html`<div class="panel"><h2>Module identities <span class="count">${loose.length} admitted</span></h2><table><thead><tr><th>Module</th><th>Sessions</th><th>Status</th></tr></thead><tbody>${loose.sort((x,y)=>modName(x)<modName(y)?-1:1).map(modTr)}</tbody></table></div>`:null}`;
  const chips=[];
  if(TF.fday) chips.push(html`<span class="chip proj">day: ${TF.fday} <a class="pointer" onclick=${()=>telFilterDay('')}>×</a></span>`);
  if(TF.fmodel) chips.push(html`<span class="chip proj">model: ${TF.fmodel} <a class="pointer" onclick=${()=>telFilterModel('')}>×</a></span>`);
  const raw=html`<div class="panel"><button class="btn" aria-pressed=${String(TRAW)} onclick=${()=>telRaw(!TRAW)}>${TRAW?'Hide raw tables':'Raw: show filters and tables'}</button></div>`;
  put($('#app'),telStory(t,devs),nodesPanel,raw,
    TRAW?html`${controls}${chips.length?html`<div class="controls">${chips}</div>`:null}${line}${t.totals&&t.totals.sessions!==undefined?telemetryBody(t,TP,goTel,true,true,true):empty('no sessions')}`:null);
  if(TRAW){ $('#tsort').value=TF.sort;
  ['tsort','tnode','tproj','tagent'].forEach(id=>{const e=$('#'+id);if(e)e.onchange=telReload;}); }
}

/* ---------- Per-node drill-down ---------- */
let NTP=1, NC={fpage:1,dpage:1,status:'all'};
const openNode=id=>{if(VIEWER)return;state.node=id;state.nodeTab='overview';state.detail=null;NTP=1;NC={fpage:1,dpage:1,status:'all'};render();};
const backHive=()=>{state.node=null;state.detail=null;state.view='hive';setNav('hive');render();};
const nodeTab=tab=>{state.nodeTab=tab;if(tab==='telemetry')NTP=1;if(tab==='corpus'){NC={fpage:1,dpage:1,status:'all'};}render();};
const openNodeContested=()=>{state.nodeTab='corpus';NC={fpage:1,dpage:1,status:'contested'};render();};
const goNodeTel=p=>{NTP=p;render();window.scrollTo({top:0});};
const goNFacts=async p=>{NC.fpage=p;renderNode();};
const goNDecs=async p=>{NC.dpage=p;renderNode();};
function nodeQ(extra){return state.node?('node='+encodeURIComponent(state.node)+(extra?'&'+extra:'')):extra;}
const syncNote=n=>html`<div class="kv"><div class="k"></div><div class="v">${n}</div></div>`;
async function renderNode(){
  const p=PEERS.find(x=>x.device===state.node)||{name:state.node,device:state.node,principal:'?',addr:'—',seen:'—',status:'?',self:false};
  const head=body=>{put($('#app'),html`<div class="crumb"><button class="back" onclick=${backHive}>‹ Hive</button>
      <span class="who"><span class=${'dot '+(p.self?'self':dotFor(p.status))}></span>${p.name}</span><span class="mono">${p.device}</span></div>
    <div class="subnav">${['overview','corpus','stats','telemetry'].map(tb=>html`<button class=${state.nodeTab===tb?'on':null} onclick=${()=>nodeTab(tb)}>${tb[0].toUpperCase()+tb.slice(1)}</button>`)}</div>
    <div id="ndbody">${body}</div>`);};
  head(spin('loading…')); const body=()=>$('#ndbody');
  const unreachable=()=>html`<div class="note">${p.name} isn't reachable right now. Per-node views are proxied live over the tailnet, so an offline node — or one on older code without these endpoints — has nothing to show here.</div>`;
  try{
    if(state.nodeTab==='overview'){
      const o=await getJSON('/api/overview?'+nodeQ()); if(!body())return;
      if(o.reachable===false||o.facts===undefined){put(body(),unreachable());return;}
      // divergence: compare the node's FULL merkle to a FRESH local one (META.merkle goes stale as the
      // hive syncs). Never for self — it can't diverge from itself.
      const isSelf = o.node_id && META.node_id && o.node_id===META.node_id;
      let sync=null;
      if(isSelf){ sync=syncNote(html`<span class="c-ok">this node</span>`); }
      else if(o.merkle_full){ try{ const loc=await getJSON('/api/overview'); if(loc.merkle_full) sync=loc.merkle_full===o.merkle_full
          ?syncNote(html`<span class="c-ok">in sync with this node</span>`)
          :syncNote(pill('contested','DIVERGED from this node')); }catch(e){} }
      if(!body())return;
      put(body(),html`<div class="grid cards">
         ${navCard('Facts',o.facts,()=>nodeTab('corpus'))}
         ${navCard('Decisions',o.decisions,()=>nodeTab('corpus'))}
         ${navCard('Contested',o.contested,openNodeContested,o.contested?'stat c-bad':'stat c-ink')}
         <div class="card"><div class="lbl">Role</div><div class="stat fs16">${o.role}</div></div></div>
       <div class="panel"><h2>Node</h2>${kv('Hive',html`<span class="mono">${o.hive||'—'}</span>`)}${kv('Contract','v'+o.contract)}${kv('Address',html`<span class="mono">${o.address||'—'}</span>`)}${kv('Merkle root',html`<span class="mono">${o.merkle}</span>`)}
         ${sync}</div>`);
    } else if(state.nodeTab==='stats'){
      if(!body())return;
      put(body(),statusPanels());   // progressive: whoami/stats fast, doctor fills in
      loadStatus(state.node);
      return;
    } else if(state.nodeTab==='corpus'){
      if(!body())return;
      const st=NC.status||'all';
      const filt=st!=='all'?html`<div class="note">Filtered to <b>${st}</b> facts on this node · <a class="pointer" onclick=${()=>nodeTab('corpus')}>clear</a></div>`:null;
      // progressive: shells first, then fill facts + decisions independently
      put(body(),filt,panelShell('nfpanel','Facts'),st==='all'?panelShell('ndpanel','Decisions'):null);
      getJSON('/api/search?'+nodeQ(`kind=fact&status=${st}&limit=${PER}&offset=${(NC.fpage-1)*PER}`)).then(f=>{
        const b=$('#nfpanel'); if(!b)return;
        if(f.facts===undefined){put(b,html`<h2>Facts</h2>`,unreachable());return;}
        LAST.facts=f.facts; const ft=f.facts_total||f.facts.length;
        put(b,listBody('Facts',ft,f.facts.map(factRow),NC.fpage,goNFacts,'none'));
      }).catch(()=>{put($('#nfpanel'),html`<h2>Facts</h2>`,empty('unavailable'));});
      if(st==='all') getJSON('/api/search?'+nodeQ(`kind=decision&limit=${PER}&offset=${(NC.dpage-1)*PER}`)).then(dd=>{
        const b=$('#ndpanel'); if(!b)return;
        LAST.decisions=dd.decisions; const dt=dd.decisions_total||dd.decisions.length;
        put(b,listBody('Decisions',dt,dd.decisions.map(decRow),NC.dpage,goNDecs,'none'));
      }).catch(()=>{put($('#ndpanel'),html`<h2>Decisions</h2>`,empty('unavailable'));});
      return;
    } else {
      const t=await getJSON('/api/telemetry?'+nodeQ(`limit=${PER}&offset=${(NTP-1)*PER}`)); if(!body())return;
      if(t.reachable===false){put(body(),unreachable());return;}
      if(!t.totals||!t.totals.sessions){put(body(),html`<div class="note">No sessions recorded on this node yet.</div>`);return;}
      put(body(),telemetryBody(t,NTP,goNodeTel,false));
    }
  }catch(e){ put(body(),empty('unavailable')); }
}

/* ---------- Status view (header owner chip) — loads progressively ---------- */
const statusPanels=()=>html`
  <div class="panel"><h2>hv whoami</h2><div id="st-whoami">${spin()}</div></div>
  <div class="panel"><h2>hv stats</h2><div id="st-stats">${spin()}</div></div>
  <div class="panel"><h2>hv doctor</h2><div id="st-doctor">${spin('running doctor…')}</div></div>`;
function loadStatus(nodeParam){   // fire the three commands in parallel; each panel fills as it returns
  const cli=t=>html`<pre class="cli">${t}</pre>`;
  ['whoami','stats','doctor'].forEach(cmd=>{
    const qp=(nodeParam?'node='+encodeURIComponent(nodeParam)+'&':'')+'cmd='+cmd;
    getJSON('/api/status?'+qp).then(s=>put(document.getElementById('st-'+cmd),cli(s[cmd]!=null?s[cmd]:(s.reachable===false?'(node not reachable for this view)':'(no output)'))))
      .catch(()=>put(document.getElementById('st-'+cmd),cli('(unavailable)')));
  });
}
async function status(){
  put($('#app'),html`<div class="crumb"><button class="back" onclick=${()=>goTab('overview')}>‹ Overview</button><span class="who">Device status</span></div><div id="stbody">${statusPanels()}</div>`);
  loadStatus(null);
}

/* ---------- Audit view (Overview audit card) ---------- */
async function audit(){
  put($('#app'),html`<div class="crumb"><button class="back" onclick=${()=>goTab('overview')}>‹ Overview</button><span class="who">Audit</span></div><div id="aubody">${spin()}</div>`);
  let a; try{ a=await getJSON('/api/audit'); }catch(e){ put($('#aubody'),empty('unavailable')); return; }
  const card=(lbl,n,warn)=>html`<div class="card"><div class="lbl">${lbl}</div><div class=${warn&&n?'stat c-warn':'stat'}>${n}</div></div>`;
  const s=a.samples||{};
  const sec=(title,items)=>items&&items.length?html`<div class="panel"><h2>${title} <span class="count">${items.length}</span></h2>${items.map(it=>html`<div class="row">#${it.id} ${it.content}</div>`)}</div>`:null;
  put($('#aubody'),html`<div class="grid cards">${card('Re-check',a.recheck,1)}${card('Stale',a.stale,1)}${card('Duplicate',a.duplicate)}${card('Contravened',a.contravened,1)}</div>
    <div class="note">A read-only reconciliation snapshot (light depth). Run <span class="mono">hv audit</span> for the full report, or reconcile with <span class="mono">hv retract</span> / <span class="mono">hv remember --resolves</span>.</div>
    ${sec('Re-check — volatile, past freshness',s.recheck)}${sec('Contested',s.contested)}${sec('Decayed',s.decayed)}${sec('Contravened — un-reconciled corrections',s.contravened)}`);
}

/* ---------- Related facts (fact/decision detail) ---------- */
async function loadRelated(kind,id){
  let r; try{ r=await getJSON(`/api/related?kind=${encodeURIComponent(kind)}&id=${encodeURIComponent(id)}`); }catch(e){ put($('#related'),empty('none')); return; }
  const el=$('#related'); if(!el)return;
  if(!r.related||!r.related.length){ put(el,empty('No facts share tags with this '+kind+'.')); return; }
  LAST.facts=r.related;
  put(el,html`<table><thead><tr><th>Conf</th><th>Shared tags</th><th>Fact</th></tr></thead><tbody>${r.related.map(f=>html`<tr class="link" onclick=${()=>openFact(f.id)}><td>${confNum(f.confidence)}</td><td>${(f.shared||[]).map(t=>html`<span class="chip">${t}</span> `)}</td><td>${(f.content||'').slice(0,110)}${f.contested?[' ',pill('contested','CONTESTED')]:null}</td></tr>`)}</tbody></table>`);
}
async function loadRelatedSessions(s){
  const el=$('#relsess'); if(!el)return;
  let t; try{ t=await getJSON(`/api/telemetry?scope=hive&fproject=${encodeURIComponent(s.project||'-')}&limit=12`); }
  catch(e){ put(el,empty('none')); return; }
  const rows=(t.recent||[]).filter(r=>!(s.session_id&&r.session_id===s.session_id)).slice(0,10);
  if(!rows.length){ put(el,empty('No other sessions for project '+(s.project||'-')+'.')); return; }
  LAST.sessions=rows;
  put(el,html`<table><thead><tr><th>When</th><th>Node</th><th>Agent</th><th>Dur</th><th>Cost</th></tr></thead><tbody>${rows.map((r,i)=>html`<tr class="link" onclick=${()=>openSession(i)}><td class="mono">${r.when}</td><td>${r.node_name||r.node||'-'}</td><td>${r.agent}</td><td>${fmtDur(r.duration_s)}</td><td>${fmtCost(r.cost_usd)}</td></tr>`)}</tbody></table>`);
}

/* ---------- Settings > Modules (read-only catalog and health) and the generic module page ---------- */
let MP={name:null,tab:'overview'};
const fmtAge=s=>s<90?`${s}s`:s<5400?`${Math.round(s/60)}m`:s<172800?`${Math.round(s/3600)}h`:`${Math.round(s/86400)}d`;
const lvlClass=l=>l==='fail'?'c-warn':l==='warn'?'c-accent':'c-ok';
const healthPill=d=>d?html`<span class=${lvlClass(d.worst)}>${d.worst}</span> <small class="c-dim">${fmtAge(d.age_s)} ago</small>`:html`<span class="c-dim">no doctor result yet</span>`;
const healthBody=d=>!d?empty('No cached doctor result for this module. Run `hv doctor` on this node to refresh it.'):html`
  <div class="note">Cached ${fmtAge(d.age_s)} ago${d.version?' for v'+d.version:''}. This page never runs the module; <span class="mono">hv doctor</span> refreshes the cache.</div>
  ${d.results.length?html`<table><thead><tr><th>Level</th><th>Check</th><th>Message</th></tr></thead><tbody>${d.results.map(r=>html`<tr><td class=${lvlClass(r.level)}>${r.level}</td><td>${r.check}</td><td>${r.message}${r.fix_hint?html`<div class="c-dim fs12">${r.fix_hint}</div>`:null}</td></tr>`)}</tbody></table>`:empty('No results.')}`;
async function modules(){
  put($('#app'),html`<div class="crumb"><span class="who">Settings › Modules</span></div><div id="mbody">${spin()}</div>`);
  let r; try{ r=await getJSON('/api/modules'); }catch(e){ put($('#mbody'),empty('modules unavailable — is hive-mind on this node?')); return; }
  if(!r.modules.length){ put($('#mbody'),empty('No modules installed.')); return; }
  put($('#mbody'),html`<div class="note">Read-only. Install, update and remove are <span class="mono">hive-mind module install|update|remove</span> on this node. Health is the core's cache, not a live run.</div>
    <div class="panel"><table><thead><tr><th>Module</th><th>Version</th><th>Publisher</th><th>Signature</th><th>Service</th><th>Trust</th><th>Health</th></tr></thead><tbody>${r.modules.map(m=>html`<tr class="link" onclick=${()=>{MP={name:m.name,tab:'overview'};state.view='modulePage';render();}}><td><strong>${m.name}</strong></td><td>${m.version}</td><td class="mono">${m.publisher}</td><td class=${m.signature==='valid'?'c-ok':'c-warn'}>${m.signature}</td><td>${m.service}</td><td>${m.trust}</td><td>${healthPill(m.doctor)}</td></tr>`)}</tbody></table></div>`);
}
async function modulePage(){
  put($('#app'),html`<div class="crumb"><button class="back" onclick=${()=>goTab('modules')}>‹ Modules</button><span class="who">${MP.name}</span></div><div id="mpbody">${spin()}</div>`);
  let r; try{ r=await getJSON('/api/module?name='+encodeURIComponent(MP.name)); }catch(e){ put($('#mpbody'),empty('module unavailable')); return; }
  const m=r.module, ui=r.ui, acts=(ui&&ui.actions)||[];
  const tabs=[['overview','Overview'],['health','Health'],['config','Config'],...(acts.length?[['actions','Actions']]:[])];
  if(!tabs.some(t=>t[0]===MP.tab)) MP.tab='overview';
  const kv=(k,v)=>html`<tr><td class="c-dim">${k}</td><td>${v}</td></tr>`;
  const body={
    overview:()=>html`${ui&&ui.summary?html`<p>${ui.summary}</p>`:null}<table><tbody>${kv('Version',m.version)}${kv('Publisher',html`<span class="mono">${m.publisher}</span>`)}${kv('Signature',m.signature)}${kv('Service',m.service)}${kv('Device',m.device)}${kv('Trust',m.trust)}${kv('Quota use',m.quota_use)}${m.cli?kv('Command',html`<span class="mono">${m.cli}</span>`):null}</tbody></table>${m.problem?html`<div class="note c-warn">${m.problem}</div>`:null}<div id="mpids"></div>${ui?null:html`<div class="note">This module declares no page of its own${m.signature==='valid'?'':' (its signature is not valid here, so its manifest is not read)'}.</div>`}`,
    health:()=>healthBody(m.doctor),
    config:()=>settingsPanel('x-'+MP.name+':'),   // its own tab state, apart from Settings › Node
    actions:()=>html`<div class="note">Run these on this node's terminal. The dashboard runs nothing; an owner action is also signed there, never here.</div>${acts.map(a=>html`<div class="panel"><h2>${a.label||a.id}${a.owner?html` <span class="chip">owner</span>`:null}</h2>${a.confirm?html`<p class="c-dim">${a.confirm}</p>`:null}${cmdBlock(a.command)}</div>`)}`,
  };
  put($('#mpbody'),html`<div class="tabs">${tabs.map(t=>html`<button class=${'tab'+(t[0]===MP.tab?' active':'')} onclick=${()=>{MP.tab=t[0];modulePage();}}>${t[1]}</button>`)}</div><div class="panel">${body[MP.tab]()}</div>`);
  if(MP.tab==='overview') moduleIdentitiesOf(MP.name);
}
/* The module's own admitted keys and the device that hosts them (`module` and `host` on /api/peers; an older core sends neither). */
async function moduleIdentitiesOf(name){
  let pr; try{ pr=(await getJSON('/api/peers?probe=0')).peers; }catch(e){ return; }
  const el=$('#mpids'); if(!el||MP.name!==name) return;
  const mine=pr.filter(p=>p.module===name);
  if(!mine.length) return;
  const host=p=>{ const d=pr.find(x=>x.device===p.host&&!isModuleRow(x)); return d?d.name:(p.host||'not reported'); };
  put(el,html`<h3>Identities</h3><div class="note">Each installed module writes with an admitted key of its own. It is not a device and not a duplicate: do not purge it.</div>
    <table><thead><tr><th>Key</th><th>Device</th><th>Last seen</th><th>Status</th></tr></thead><tbody>${mine.map(p=>html`<tr><td class="mono">${p.device}</td><td>${host(p)}</td><td>${p.seen}</td><td>${p.status}</td></tr>`)}</tbody></table>`);
}

/* ---------- Settings forms: rendered from `hconfig list` records; saved by POST /api/settings (hconfig set) ---------- */
let CSRF=null;
/* `hv dash` opens /#k=<launch token>; keep it for this tab only and drop it from the address bar */
(()=>{ const m=/^#k=([\w-]+)$/.exec(location.hash); if(m){ try{ sessionStorage.setItem('hdash-k',m[1]); }catch(e){} history.replaceState(null,'',location.pathname+location.search); } })();
const csrfToken=async()=>{
  if(!CSRF){
    let k=''; try{ k=sessionStorage.getItem('hdash-k')||''; }catch(e){}
    const r=await fetch('/api/csrf',{headers:{'X-HDash-Launch':k}});
    if(!r.ok) throw new Error('Open the dashboard with `hv dash` to save settings.');
    CSRF=(await r.json()).token;
  }
  return CSRF;
};
async function saveSetting(id,value){
  const post=async()=>fetch('/api/settings',{method:'POST',headers:{'Content-Type':'application/json','X-HDash-CSRF':await csrfToken()},body:JSON.stringify({id,value})});
  let r=await post();
  if(r.status===403){ CSRF=null; r=await post(); }   // the server restarted and made a new token
  let j={}; try{ j=await r.json(); }catch(e){}
  return {status:r.status,body:j};
}
const SRC_LABEL={default:'default',node:'this node','fleet-node':'fleet (this device)',fleet:'fleet',env:'environment'};
const showVal=v=>v==null?'—':Array.isArray(v)?v.join(', '):String(v);
const shownVal=r=>r.set?showVal(r.value):'default ('+showVal(r.default)+')';   // an unset key is its default, said so: a bare 0 reads as a setting
function settingInput(r){
  const cur=r.secret?'':r.set?showVal(r.value):showVal(r.default==null?'':r.default).replace(/^—$/,'');
  if(r.type==='bool') return html`<select class="sv">${['true','false'].map(o=>html`<option value=${o} selected=${o===String(r.set?r.value:r.default)}>${o}</option>`)}</select>`;
  if(r.type==='enum'&&Array.isArray(r.values)) return html`<select class="sv">${r.values.map(o=>html`<option value=${o} selected=${o===String(r.set?r.value:r.default)}>${o}</option>`)}</select>`;
  return html`<input class="sv" type=${r.secret?'password':'text'} value=${cur} placeholder=${r.secret?(r.set?'set — type to replace':'not set'):''} autocomplete="off" maxlength="4096">`;
}
let helpSeq=0;
function closeHelp(except){
  document.querySelectorAll('.help-btn[aria-expanded="true"]').forEach(b=>{ if(b!==except){ b.setAttribute('aria-expanded','false'); b.nextElementSibling.hidden=true; } });
}
document.addEventListener('click',e=>{ if(!e.target.closest||!e.target.closest('.help-wrap')) closeHelp(); });
document.addEventListener('keydown',e=>{ if(e.key==='Escape') closeHelp(); });
// The (?) button for a setting's plain-language `help`: a real button, text only (never markup), opens on tap, click,
// Enter/Space, hover and keyboard focus. No `help` text means no icon.
function helpIcon(key,text){
  if(typeof text!=='string'||!text.trim()) return null;
  const id='help-'+(++helpSeq);
  const wrap=html`<span class="help-wrap"><button type="button" class="help-btn" aria-expanded="false" aria-describedby=${id} aria-label=${'What is '+key+'?'}>?</button><span class="help-pop" role="tooltip" id=${id} hidden></span></span>`;
  const btn=wrap.querySelector('.help-btn'), pop=wrap.querySelector('.help-pop');
  pop.textContent=text;
  const open=on=>{ closeHelp(on?btn:null); btn.setAttribute('aria-expanded',String(on)); pop.hidden=!on; };
  // A pointer tap fires mouseenter, focus, then click, so the click must open (not toggle) or it undoes the open; only a
  // keyboard click (detail 0: Enter/Space) toggles.
  btn.addEventListener('click',e=>{ e.stopPropagation(); open(e.detail===0?btn.getAttribute('aria-expanded')!=='true':true); });
  btn.addEventListener('focus',()=>open(true));
  const span=wrap.firstElementChild;
  span.addEventListener('mouseenter',()=>open(true));
  span.addEventListener('mouseleave',()=>{ if(document.activeElement!==btn) open(false); });
  btn.addEventListener('blur',()=>open(false));
  return wrap;
}
function settingRow(r){
  const id=r.id, src=SRC_LABEL[r.source]||(r.source||'unset');
  const meta=html`<div class="c-dim fs12">${r.description||''}${r.min!=null||r.max!=null?` (${showVal(r.min)} .. ${showVal(r.max)})`:''}${r.identifying?' · identifying':''}${r.secret?' · secret':''}</div>${(r.warnings||[]).map(w=>html`<div class="c-accent fs12">${w}</div>`)}`;
  const head=html`<td><span class="mono">${id}</span>${helpIcon(id,r.help)}${meta}</td><td><span class="chip">${src}</span>${r.set_by&&r.set_by.ts?html`<div class="c-dim fs12">set ${r.set_by.ts}</div>`:null}</td>`;
  if(r.template) return html`<tr>${head}<td colspan="2" class="c-dim">a template: add a key with <span class="mono">hconfig set</span></td></tr>`;
  if(r.writable_by==='owner'&&id.startsWith('core:')) return html`<tr>${head}<td>${shownVal(r)}</td><td><div class="c-dim fs12">Read-only here. The owner changes it on the operator's terminal:</div>${r.write_via?cmdBlock(r.write_via):null}</td></tr>`;
  if(r.source==='env') return html`<tr>${head}<td>${showVal(r.value)}</td><td class="c-dim fs12">Overridden by <span class="mono">${r.env||'an environment variable'}</span>; unset it to edit this key.</td></tr>`;
  const tr=html`<tr>${head}<td>${settingInput(r)}${r.set||r.secret||r.type==='bool'||r.type==='enum'?null:html`<div class="c-dim fs12">${['','—'].includes(showVal(r.default))?'not set':'not set: default ('+showVal(r.default)+')'}</div>`}</td><td><button class="btn sv-save">Save</button><div class="sv-msg fs12"></div></td></tr>`;
  return wireRow(tr,r);
}
function wireRow(frag,r){
  const msg=frag.querySelector('.sv-msg'), btn=frag.querySelector('.sv-save'), inp=frag.querySelector('.sv');
  const say=(cls,t,hint)=>{ msg.className='sv-msg fs12 '+cls; put(msg,t,hint?html`<div class="c-dim">${hint}</div>`:null); };
  if(r.writable_by==='owner') say('c-dim','Signed by the owner key through the unlock agent.');
  btn.onclick=async()=>{
    btn.disabled=true; say('c-dim','saving…');
    try{
      const {status,body}=await saveSetting(r.id,inp.value);
      if(body.ok){ say('c-ok',body.changed?'Saved.':'Nothing to change.'); if(inp.type==='password') inp.value=''; }
      else{
        const e=body.error||{};
        if(e.code==='owner-locked') say('c-warn','The owner key is locked.',html`${e.hint||'Unlock it on your terminal, then save again:'} ${cmdBlock('hive-mind owner unlock --module '+(r.id.slice(2).split(':')[0]))}`);
        else say('c-warn',e.message||('refused ('+status+')'),e.hint);
      }
    }catch(err){ say('c-warn',(err&&err.message)||'could not reach the dashboard service'); }
    btn.disabled=false;
  };
  return frag;
}
const settingsTable=keys=>keys.length?html`<table><thead><tr><th>Key</th><th>Source</th><th>Value</th><th></th></tr></thead><tbody>${keys.map(settingRow)}</tbody></table>`:empty('No settings.');
/* Fleet = governed keys (owner-signed, shared by every device); This device = node and module keys (this device only). */
const prefixOf=id=>{ const i=id.indexOf(':'); return i<0?'other':id.slice(0,i+1); };
const settingsGroups=keys=>{
  const by=new Map();
  keys.forEach(k=>{ const p=prefixOf(k.id); if(!by.has(p)) by.set(p,[]); by.get(p).push(k); });
  return [...by.entries()].sort((x,y)=>x[0]<y[0]?-1:1).map(([p,ks])=>html`<h3 class="mono">${p}</h3>${settingsTable(ks)}`);
};
const SETTINGS_TABS={};   // the active tab per page: Settings › Node and each module's Config keep their own
/* Fleet = governed keys; This device = every other class. */
const settingsSplit=keys=>({fleet:keys.filter(k=>k.class==='governed'), dev:keys.filter(k=>k.class!=='governed')});
const fleetNote=n=>'Settings signed by the owner and shared by every device in the hive.'+(n?' An unlocked owner key is needed to change them.':'');
/* Both panes are built once; a tab click only hides one and shows the other, so input typed in a row survives the switch. */
function settingsTabSwitch(tab,btns,panes){
  for(const k in btns){ btns[k].classList.toggle('active',k===tab); panes[k].hidden=k!==tab; }
}
function settingsPanel(prefix,cls){
  const tabKey=prefix||'node';
  const box=html`<div>${spin()}</div>`.firstElementChild;
  getJSON('/api/settings?'+new URLSearchParams(Object.assign({},prefix?{prefix}:{},cls?{class:cls}:{}))).then(r=>{
    const {fleet,dev}=settingsSplit(r.keys);
    const btns={}, panes={};
    const tabs=[['fleet','Fleet',fleet],['device','This device',dev]];
    const pane={
      fleet:html`<div><div class="note">${fleetNote(fleet.length)}</div>${fleet.length?settingsGroups(fleet):empty('No fleet settings.')}</div>`.firstElementChild,
      device:html`<div><div class="note">Settings that apply to this device only.</div>${dev.length?settingsGroups(dev):empty('No device settings.')}</div>`.firstElementChild,
    };
    const bar=html`<div class="tabs">${tabs.map(t=>{
      const b=html`<button class="tab">${t[1]} <span class="c-dim">${t[2].length}</span></button>`.firstElementChild;
      b.addEventListener('click',()=>{ SETTINGS_TABS[tabKey]=t[0]; settingsTabSwitch(t[0],btns,panes); });
      btns[t[0]]=b; panes[t[0]]=pane[t[0]]; return b;
    })}</div>`;
    settingsTabSwitch(SETTINGS_TABS[tabKey]||'device',btns,panes);
    put(box,html`<div class="note">Rendered from <span class="mono">hconfig list</span>; a save runs <span class="mono">hconfig set</span> on this node. This page never signs and never sees the owner passphrase.</div>
      ${(r.warnings||[]).map(w=>html`<div class="note c-accent">${w}</div>`)}`,bar,pane.fleet,pane.device);
  }).catch(()=>put(box,empty('settings unavailable — is hconfig installed on this node? (hive-mind module add hconfig)')));
  return box;
}
async function viewerSettings(){
  put($('#app'),html`<div class="crumb"><span class="who">Settings › Shared values</span></div>`,html`<div class="panel"><h2>Read-only</h2><div id="vset">${spin()}</div></div>`);
  getJSON('/api/config/records').then(r=>put($('#vset'),r.keys.length?html`<table><thead><tr><th>Key</th><th>Value</th><th>Source</th></tr></thead><tbody>${r.keys.map(k=>html`<tr><td class="mono">${k.id}<div class="c-dim fs12">${k.description||''}</div></td><td>${String(k.value!=null?k.value:k.default)}</td><td>${k.source||''}</td></tr>`)}</tbody></table>`:empty('No settings are shared with viewers.')))
    .catch(()=>put($('#vset'),empty('settings unavailable')));
}
async function settingsNode(){
  if(VIEWER) return viewerSettings();
  put($('#app'),html`<div class="crumb"><span class="who">Settings › Node</span></div>`,
    html`<div class="panel"><h2>Settings</h2>${settingsPanel('')}</div>`);
}

/* ---------- Workspaces (Agents, Trust, Spend, Governance): defined here; a module only declares the panels that fill a slot ---------- */
/* A module's quota is the core's default unless its signed manifest asks for less; 0 is a real ask (the module never writes). */
const quotaCell=(q,k)=>(q.from_manifest||[]).includes(k)?html`${q[k]} <small class="c-dim">${q[k]===0?'manifest: none allowed':'manifest'}</small>`:html`<span class="c-dim">default (${q[k]})</span>`;
const cell=v=>v==null?'—':typeof v==='object'?JSON.stringify(v):String(v);
function panelBody(p){
  if(p.data==null) return empty(p.note||'no data');
  const d=p.data;
  if(Array.isArray(d)&&d.every(r=>r&&typeof r==='object'&&!Array.isArray(r))){
    if(!d.length) return empty('none');
    const cols=p.columns.length?p.columns:[...new Set(d.flatMap(r=>Object.keys(r)))].slice(0,8);
    return html`<table><thead><tr>${cols.map(c=>html`<th>${c}</th>`)}</tr></thead><tbody>${d.map(r=>html`<tr>${cols.map(c=>html`<td>${cell(r[c])}</td>`)}</tr>`)}</tbody></table>`;
  }
  if(d&&typeof d==='object'&&!Array.isArray(d)) return html`<table><tbody>${Object.keys(d).map(k=>html`<tr><td class="c-dim">${k}</td><td>${cell(d[k])}</td></tr>`)}</tbody></table>`;
  return html`<div class="stat">${cell(Array.isArray(d)?d.join(', '):d)}</div>`;
}
const wsPanel=p=>html`<div class="panel"><h2>${p.title} <small class="c-dim">${p.module}</small></h2>${p.note&&p.data!=null?html`<div class="note">${p.note}</div>`:null}${panelBody(p)}</div>`;
async function workspace(name){
  const title={agents:'Agents',trust:'Trust',spend:'Spend & limits',governance:'Governance'}[name];
  put($('#app'),html`<div class="crumb"><span class="who">${title}</span></div><div id="wsbody">${spin()}</div>`);
  let w; try{ w=await getJSON('/api/workspace?name='+name); }catch(e){ put($('#wsbody'),empty('workspace unavailable — is hive-mind on this node?')); return; }
  const parts=[html`<div class="note">${w.question} Read-only: nothing on this page changes the hive.</div>`];
  if(name==='trust'){
    parts.push(html`<div class="panel"><h2>Claims and where to verify them</h2><table><thead><tr><th>Claim</th><th>Verify at</th></tr></thead><tbody>${w.claims.map(c=>html`<tr><td>${c.claim}</td><td>${cmdBlock(c.verify)}</td></tr>`)}</tbody></table></div>`);
    parts.push(html`<div class="panel"><h2>Modules: signature and trust</h2>${moduleLines(w.modules,m=>html`<span class=${m.signature==='valid'?'c-ok':'c-warn'}>signature ${m.signature}</span><span class="c-dim fs12">trust ${m.trust}</span>`)}<div class="note">Publisher, health and settings of each module are on its page under Modules.</div></div>`);
  }
  if(name==='governance'){
    parts.push(html`<div class="panel"><h2>Core policy</h2>${w.policy.length?html`<table><thead><tr><th>Key</th><th>Value</th><th>Default</th><th>Set by</th></tr></thead><tbody>${w.policy.map(k=>html`<tr title=${cell(k.description)}><td class="mono">${k.id}${helpIcon(k.id,k.help)}</td><td>${cell(k.value)}</td><td class="c-dim">${cell(k.default)}</td><td class="c-dim">${cell(k.source)}</td></tr>`)}</tbody></table>`:empty(w.policy_note||'No core policy keys.')}</div>`);
    parts.push(html`<div class="panel"><h2>Who may write: admission, trust and signature per module</h2>${moduleLines(w.modules,m=>html`<span class=${m.device==='admitted'?'c-ok':'c-warn'}>device ${m.device}</span><span class="c-dim fs12">trust ${m.trust}</span>${m.signature==='valid'?null:html`<span class="c-warn fs12">signature ${m.signature}</span>`}`)}</div>`);
  }
  const story=name==='agents'||name==='spend';
  if(story){ WSD={name,w,raw:null}; parts.push(html`<div id="wsstory">${VIZ.skeleton('bars')}</div>`); }
  parts.push(...w.panels.map(wsPanel));
  if(name==='agents'&&!w.panels.length) parts.push(empty('No installed module fills the Agents slot yet. hwatch does once it declares one.'));
  parts.push(...w.notes.map(n=>html`<div class="note">${n}</div>`));
  if(story) parts.push(html`<div class="panel"><button class="btn" id="wsrawbtn" aria-pressed=${String(!!WRAW[name])} onclick=${()=>{ WRAW[name]=!WRAW[name]; wsRaw(); }}>${WRAW[name]?'Hide raw tables':'Raw: show tables'}</button></div><div id="wsraw"></div>`);
  put($('#wsbody'),...parts);
  if(name==='agents') agentsStory(); else if(name==='spend') spendStory();
}
/* The Agents and Spend storylines (hdash_overview_v2 §5): a question, a headline, charts in reading order, then Raw (off by default).
   Both draw from hive-wide telemetry reads. The daemon returns at most the newest 21 days with sessions, so 21 calendar days is the
   longest window that is complete and no chart is labelled longer. */
let WRAW={agents:false,spend:false}, WSD={name:'',w:null,raw:null}, WSEEN={};
const WS_DAYS=21, WS_WEEK=7, WS_AGENTS=8;
const WS_CAP_NOTE='The HiveMind service reads at most the newest 2,000 sessions on each device, so a very busy period can show fewer than it had.'; // core api_telemetry_hive per_node_cap
const wsRaw=()=>{
  const on=!!WRAW[WSD.name], b=$('#wsrawbtn');
  if(b){ b.setAttribute('aria-pressed',String(on)); b.textContent=on?'Hide raw tables':'Raw: show tables'; }
  put($('#wsraw'),on&&WSD.raw?WSD.raw():null);
};
const modelRawTable=t=>{
  const models=Object.entries((t&&t.by_model)||{}).sort((a,b)=>(b[1].in+b[1].out)-(a[1].in+a[1].out)).slice(0,50);
  return models.length?modelTable(models.map(([m,v])=>html`<tr><td class="mono">${m}</td><td>${fmtNum(v.in)}</td><td>${fmtNum(v.out)}</td><td>${v.priced?fmtCost(v.cost):'unpriced'}</td></tr>`)):null;
};
const wsStory=(name,...nodes)=>{ if(WSD.name===name) put($('#wsstory'),...nodes); };
const wsAnim=k=>({animate:!WSEEN[k]});

async function agentsStory(){
  let t; try{ t=await getJSON('/api/telemetry?scope=hive&limit=50&sort=recent'); }catch(e){ wsStory('agents',empty(failText(e,'telemetry unavailable'))); return; }
  const rec=t.recent||[], at=r=>Date.parse(String(r.when||'')+'Z')||0;
  const names=[]; rec.forEach(r=>{ if(r.agent&&!names.includes(r.agent)) names.push(r.agent); });
  ((t.facets&&t.facets.agents)||[]).forEach(a=>{ if(!names.includes(a)) names.push(a); });
  const shown=names.slice(0,WS_AGENTS);
  if(!shown.length){ wsStory('agents',empty('no sessions recorded yet. Sessions appear here when an AI session runner (such as Claude Code) uses HiveMind.')); WSD.raw=()=>modelRawTable(t); wsRaw(); return; }
  const days=ovDays(WS_DAYS), wk=days.slice(-WS_WEEK);
  const rows=await Promise.all(shown.map(a=>getJSON('/api/telemetry?scope=hive&limit=1&sort=recent&fagent='+encodeURIComponent(a)).then(r=>{
    const by={}; (r.by_day||[]).forEach(d=>{ by[d.day]=d.sessions; });
    const w7=wk.reduce((x,k)=>x+(by[k]||0),0), w21=days.reduce((x,k)=>x+(by[k]||0),0);
    return {agent:a,w7,rest:w21-w7,w21,last:r.recent&&r.recent[0]?at(r.recent[0]):0,ok:true};
  }).catch(()=>({agent:a,w7:0,rest:0,w21:0,last:0,ok:false}))));
  if(WSD.name!=='agents') return;
  const good=rows.filter(r=>r.ok).sort((x,y)=>y.w21-x.w21||y.last-x.last), bad=rows.length-good.length;
  const s7=good.reduce((x,r)=>x+r.w7,0), s21=good.reduce((x,r)=>x+r.w21,0), more=names.length-shown.length;
  const idle=good.filter(r=>!r.w7).length;
  const ageOf=r=>Math.max(0,Math.round((Date.now()-r.last)/1000));
  const dayMs=864e5, strip=r=>{ const f=r.last?Math.max(0,Math.min(1,1-(Date.now()-r.last)/(WS_WEEK*dayMs))):0; return html`<div class="srow"><span class="sname mono" title=${r.agent}>${r.agent}</span>
      <span class="strip" role="img" aria-label=${r.last?r.agent+': last session '+fmtAge(ageOf(r))+' ago':r.agent+': no session found'}><i class=${'sdot '+(r.last&&f>0?'s1':'old')} style=${{left:(r.last&&f>0?Math.round(f*100):0)+'%'}}></i></span>
      <span class="c-dim fs12 sage">${r.last?(f>0?fmtAge(ageOf(r))+' ago':'over '+WS_WEEK+' days ago'):'no session found'}</span></div>`; };
  const out=[html`<div class="panel"><div class="note">What are my agents doing, and is anything stuck?</div>
    <div class="wsum"><span class="big2">${fmtNum(s7)}</span> sessions in the last ${WS_WEEK} days, ${fmtNum(s21)} in the last ${WS_DAYS} days, across ${good.length} agent${good.length===1?'':'s'}${idle?' · '+idle+' with no session this week':''}. An agent is one AI session runner, such as <span class="mono">claude-code:david@gregorius</span>.</div></div>`,
    html`<div class="panel"><h2>Sessions by agent</h2>
      ${good.length?html`${VIZ.bars(good.map(r=>({label:r.agent,parts:[r.w7,r.rest]})),Object.assign({stacked:true,label:'Sessions by agent, last '+WS_DAYS+' days: '+good.map(r=>r.agent+' '+r.w7+' in the last '+WS_WEEK+' days, '+r.w21+' in '+WS_DAYS).join('; ')},wsAnim('ag')))}
        <div class="legend"><span><i class="s1"></i>last ${WS_WEEK} days</span><span><i class="s2"></i>the ${WS_DAYS-WS_WEEK} days before</span></div>
        ${good.map((r,i)=>html`<div class="srow"><span class="sname mono" title=${r.agent}>${i+1}. ${r.agent}</span><span class="sn">${fmtNum(r.w21)}</span></div>`)}`:empty('could not read the sessions of any agent')}
      ${bad?html`<div class="note">${bad} agent${bad===1?'':'s'} could not be read just now; try again in a moment.</div>`:null}
      <div class="note">${WS_CAP_NOTE}</div>
      ${more>0?html`<div class="note">Showing the ${shown.length} most recently active of ${names.length} agents.</div>`:null}</div>`,
    html`<div class="panel"><h2>Last seen</h2><div class="wsum">Each dot is the agent's newest session on a ${WS_WEEK}-day line; the left end is ${WS_WEEK} days ago and the right end is now.</div>${good.map(strip)}</div>`];
  ['ag'].forEach(k=>{ WSEEN[k]=1; });
  WSD.raw=()=>[html`<div class="panel"><h2>By agent</h2><table><thead><tr><th>Agent</th><th>Last ${WS_WEEK} days</th><th>Last ${WS_DAYS} days</th><th>Newest session</th></tr></thead><tbody>${good.map(r=>html`<tr><td class="mono">${r.agent}</td><td>${fmtNum(r.w7)}</td><td>${fmtNum(r.w21)}</td><td>${r.last?new Date(r.last).toISOString().slice(0,19).replace('T',' '):'-'}</td></tr>`)}</tbody></table></div>`,modelRawTable(t)];
  wsStory('agents',...out); wsRaw();
}

/* "0/h 0/d 0 total" is the core's own use line for a module on this device. */
const quotaUse=s=>{ const m=/^(\d+)\/h (\d+)\/d (\d+) total$/.exec(String(s||'')); return m?{per_hour:+m[1],per_day:+m[2],lifetime:+m[3]}:null; };
async function spendStory(){
  let t; try{ t=await getJSON('/api/telemetry?scope=hive&limit=1'); }catch(e){ wsStory('spend',empty(failText(e,'telemetry unavailable'))); return; }
  if(WSD.name!=='spend') return;
  const T=t.totals||{}, models=Object.entries(t.by_model||{}), priced=models.filter(([,v])=>v.priced).sort((a,b)=>b[1].cost-a[1].cost).slice(0,8), unp=models.filter(([,v])=>!v.priced).map(([m])=>m);
  const q=WSD.w.quotas||[];
  const legend=rows=>html`<div class="legend">${rows.map(([label,n,i])=>html`<span><i class=${'s'+(i%6+1)}></i>${label} ${fmtCost(n)}</span>`)}</div>`;
  const lim=(label,used,cap,k)=>html`<div class="lrow"><span class="lname">${label}</span>${cap?html`<span class="lbar">${VIZ.limits(used,cap,{label:label+': '+fmtNum(used)+' of '+fmtNum(cap)+' used',animate:!WSEEN[k]})}</span><span class="c-dim fs12 lnum">${fmtNum(used)} of ${fmtNum(cap)}</span>`:html`<span class="c-dim fs12">no writes allowed</span>`}</div>`;
  const out=[html`<div class="panel"><div class="note">What is this costing, and what stops it running away?</div>
    <div class="wsum"><span class="big2">${fmtCost(T.cost_usd)}</span> across all devices${unp.length?', models with a known price only':''} · ${fmtNum(T.tokens_out)} tokens out${unp.length?' · price unknown for '+unp.length+' model'+(unp.length===1?'':'s'):''}</div></div>`,
    html`<div class="panel"><h2>Cost by model</h2>
      ${priced.length?html`${VIZ.bars(priced.map(([m,v])=>({label:m,value:v.cost})),Object.assign({label:'Cost by model: '+priced.map(([m,v])=>m+' '+fmtCost(v.cost)).join(', ')},wsAnim('cost')))}${legend(priced.map(([m,v],i)=>[m,v.cost,i]))}`:empty('no session with a known price yet')}
      ${unp.length?html`<div class="note">Price unknown, so not in the chart or the total: <span class="mono">${unp.join(', ')}</span>.</div>`:null}
      <div class="note">${WS_CAP_NOTE}</div>
      <div class="note">Cost per day is not reported by the HiveMind service yet, so there is no daily cost chart.</div></div>`,
    html`<div class="panel"><h2>Write limits per module</h2>
      ${q.length?html`${q.map(m=>{ const u=quotaUse(m.use); return html`<div class="lmod"><div class="fname"><button class="linkbtn" type="button" onclick=${()=>openModule(m.module)} title=${'Open Modules › '+m.module}>${m.module}</button></div>${u?html`${lim('per hour',u.per_hour,m.per_hour,'l'+m.module+'h')}${lim('per day',u.per_day,m.per_day,'l'+m.module+'d')}${lim('lifetime',u.lifetime,m.lifetime,'l'+m.module+'t')}`:html`<div class="c-dim fs12">use not reported: ${cell(m.use)}</div>`}</div>`; })}
        <div class="note">A module's write limit caps how much it can add to the hive, so a stuck module cannot fill it. The bars show use on this device only; the bar turns amber at 70% and red at 90%.</div>`:empty('No modules installed.')}</div>`];
  ['cost'].forEach(k=>{ WSEEN[k]=1; }); q.forEach(m=>['h','d','t'].forEach(x=>{ WSEEN['l'+m.module+x]=1; }));
  WSD.raw=()=>[html`<div class="panel"><h2>Module quotas</h2>${q.length?html`<table><thead><tr><th>Module</th><th>Per hour</th><th>Per day</th><th>Entry bytes</th><th>Lifetime</th><th>Use (this device)</th></tr></thead><tbody>${q.map(m=>html`<tr><td><strong>${m.module}</strong></td>${['per_hour','per_day','entry_bytes','lifetime'].map(k=>html`<td>${quotaCell(m,k)}</td>`)}<td class="mono">${cell(m.use)}</td></tr>`)}</tbody></table><div class="note">Limits are the core's defaults lowered by the module's signed manifest. A raise by the owner is not shown here; see <code>hive-mind module quota NAME</code>.</div>`:empty('No modules installed.')}</div>`,modelRawTable(t)];
  wsStory('spend',...out); wsRaw();
}
