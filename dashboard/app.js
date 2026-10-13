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
const getJSON=async u=>{
  if(VIEWER) u=viewerUrl(u);
  const r=await fetch(u);
  if(!r.ok){ if(VIEWER){ let b=null; try{b=await r.json();}catch(e){} if(b&&b.listener==='viewer') viewerRefused(u,b); } throw new Error(r.status); }
  return r.json();
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
  try{ META=await getJSON('/api/overview'); }catch(e){ put($('#app'),empty('could not reach /api/overview — is the daemon running?')); return; }
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
function goTab(v){MP.tab='overview';state.view=v;state.node=null;state.detail=null;if(v==='corpus'){C.fpage=1;C.dpage=1;}if(v==='telemetry')TP=1;
  setNav(v);render();}
function goView(v){state.view=v;state.node=null;state.detail=null;setNav(null);render();}
function render(){
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
const shieldIcon=ok=>html`<svg class="shield" viewBox="0 0 24 24" width="20" height="20" fill="none" stroke=${ok?'#3fb950':'#f85149'} stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3l7 3v5c0 4.4-3 7.6-7 9-4-1.4-7-4.6-7-9V6z"/>${ok?html`<path d="M9 12l2 2 4-4"/>`:html`<line x1="12" y1="8.5" x2="12" y2="13"/><line x1="12" y1="15.7" x2="12.01" y2="15.7"/>`}</svg>`;
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
function setHash(sid){ try{ if(sid){ if(location.hash!=='#'+sid) history.replaceState(null,'','#'+sid); } else if(location.hash) history.replaceState(null,'',location.pathname+location.search); }catch(e){} }
const ID_RE=/^(h:[0-9a-f]{10}|[^\s:]+(:[^\s:]+)*:\d+)$/;
// Resolve a short id or `node_id:seq` ref to its entry (fact, decision or idea) and open its detail view.
async function openById(h){
  if(!ID_RE.test(h)) return false;
  let r; try{ r=await getJSON('/api/item?sid='+encodeURIComponent(h)); }catch(e){ return false; }
  if(!r||r.error||!r.item||!(r.kind==='fact'||r.kind==='decision'||r.kind==='idea')) return false;
  if(r.kind==='fact') LAST.facts=[r.item]; else if(r.kind==='decision') LAST.decisions=[r.item];
  state.detail={kind:r.kind,data:r.item}; if(r.item.sid) setHash(r.item.sid); render(); return true;
}
async function openHash(){ return openById((location.hash||'').slice(1)); }
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
const navCard=(lbl,val,go,statCls,id)=>html`<div class="card link" id=${id} onclick=${go}><div class="lbl">${lbl}</div><div class=${statCls||'stat'}>${val}</div></div>`;
async function overview(){
  put($('#app'),html`
   <div class="grid cards">
     ${navCard('Facts',META.facts,()=>goTab('corpus'))}
     ${navCard('Decisions',META.decisions,()=>goTab('corpus'))}
     ${navCard('Nodes',[META.nodes,' ',html`<small>admitted</small>`],()=>goTab('hive'))}
     ${navCard('Contested',META.contested,openContested,META.contested?'stat c-bad':'stat c-ink')}
     ${navCard('Audit',html`<span class="spin"></span>`,()=>goView('audit'),'stat','auditCard')}
   </div>
   <div class="panel"><h2>Top facts</h2><div id="ovFacts">${spin()}</div></div>
   <div class="panel"><h2>Recent decisions</h2><div id="ovDecs">${spin()}</div></div>`);
  getJSON('/api/audit').then(a=>{const c=$('#auditCard'); if(c)put(c,html`<div class="lbl">Audit</div><div class=${'stat fs15 '+((a.recheck+a.stale+a.duplicate)?'c-warn':'c-ink')}>${a.recheck} <small>re-check · ${a.stale} stale · ${a.duplicate} dup${a.contravened?` · ${a.contravened} contra`:''}</small></div>`);}).catch(()=>{});
  getJSON('/api/search?limit=8').then(s=>{LAST.facts=s.facts;LAST.decisions=s.decisions;
    const f=$('#ovFacts'); if(f)put(f,s.facts.slice(0,5).map(factRow).concat(s.facts.length?[]:[empty('none')]));
    const d=$('#ovDecs'); if(d)put(d,s.decisions.slice(0,4).map(decRow).concat(s.decisions.length?[]:[empty('none')]));}).catch(()=>{});
}

/* ---------- Corpus ---------- */
let C={q:'',kind:'all',tags:[],sort:'confidence',status:'all',fpage:1,dpage:1,facts:[],decs:[],ftotal:0,dtotal:0,tagList:null,hideNoise:true,scan:{}};
/* The tag picker: several tags at once, ANDed. The core's search takes one `tag`, so with two or more the page asks for the first
   and keeps the rows that carry them all (up to SCAN_PAGES pages of SCAN_PER; past that the list says it stopped). */
const NOISE_TAG=/^\d+$|^(?=.*\d)[0-9a-f]{8,}$/, TAG_SHOW=150, SCAN_PER=200, SCAN_PAGES=5;
function tagPickFill(){
  const q=(($('#tagq')||{}).value||'').trim().toLowerCase(), all=C.tagList||[], sel=C.tags;
  const rest=all.filter(t=>!sel.includes(t)&&!(C.hideNoise&&NOISE_TAG.test(t))&&t.toLowerCase().includes(q));
  const shown=sel.concat(rest), hidden=all.filter(t=>NOISE_TAG.test(t)).length;
  put($('#tagsum'),sel.length?'Tags: '+(sel.length>2?sel.length+' selected':sel.join(' + ')):'All tags');
  put($('#taglist'),shown.slice(0,TAG_SHOW).map(t=>html`<label class="tagopt"><input type="checkbox" checked=${sel.includes(t)} onchange=${e=>toggleTag(t,e.target.checked)}> ${t}</label>`),
    shown.length>TAG_SHOW?html`<div class="note">${shown.length-TAG_SHOW} more: type to narrow</div>`:null,
    !all.length?html`<div class="note">no tags</div>`:null);
  put($('#tagnoisel'),html`<input type="checkbox" checked=${C.hideNoise} onchange=${e=>{C.hideNoise=e.target.checked;tagPickFill();}}> hide numbers and ids${hidden?' ('+hidden+')':''}`);
}
function toggleTag(t,on){ C.tags=on?C.tags.concat(C.tags.includes(t)?[]:[t]):C.tags.filter(x=>x!==t); C.fpage=1; C.dpage=1; tagPickFill(); loadCorpus(); }
async function scanAnd(kind){   // every row of the first tag's search that also carries the other selected tags
  const key=JSON.stringify([C.q,C.sort,C.status,C.tags]), hit=C.scan[kind]; if(hit&&hit.key===key) return hit;
  const f=kind==='fact'?'facts':'decisions', rows=[]; let capped=false;
  for(let pg=0;;pg++){
    const p=new URLSearchParams({q:C.q,kind,sort:C.sort,status:C.status,limit:String(SCAN_PER),offset:String(pg*SCAN_PER),tag:C.tags[0]});
    const s=await getJSON('/api/search?'+p), got=s[f]||[];
    rows.push(...got.filter(r=>C.tags.every(t=>(r.tags||[]).includes(t))));
    if((pg+1)*SCAN_PER>=(s[f+'_total']||got.length)||!got.length) break;
    if(pg+1>=SCAN_PAGES){ capped=true; break; }
  }
  return C.scan[kind]={key,rows,capped};
}
const cappedNote=kind=>{const h=C.scan[kind]; return C.tags.length>1&&h&&h.capped?html`<div class="note">Showing matches among the first ${SCAN_PAGES*SCAN_PER} results for “${C.tags[0]}” only; add a search word or tag to narrow.</div>`:null;};
function corpus(){
  put($('#app'),html`
   <div class="controls">
     <input type="search" id="q" placeholder="Search facts &amp; decisions, or paste an id (h:… or node:seq)…" value=${C.q}>
     <select id="kind"><option value="all">All</option><option value="fact">Facts</option><option value="decision">Decisions</option></select>
     <select id="sort"><option value="confidence">Sort: confidence</option><option value="importance">Sort: importance</option><option value="utility">Sort: utility</option><option value="recency">Sort: recency</option></select>
     <select id="status"><option value="all">Status: live</option><option value="contested">Contested</option><option value="forgotten">Forgotten</option><option value="volatile">Volatile</option></select>
     <details class="tagpick"><summary id="tagsum" class="chip"></summary><div class="tagbox">
       <input type="search" id="tagq" placeholder="filter tags…">
       <div class="tagrow"><label id="tagnoisel"></label><button type="button" class="chip" id="tagclear">clear</button></div>
       <div id="taglist"></div></div></details>
   </div><div id="results">${spin()}</div><div id="epanel"></div>`);
  $('#kind').value=C.kind; $('#sort').value=C.sort; $('#status').value=C.status;
  tagPickFill(); $('#tagq').oninput=tagPickFill; $('#tagclear').onclick=()=>{C.tags=[];C.fpage=1;C.dpage=1;tagPickFill();loadCorpus();};
  if(!C.tagList) getJSON('/api/tags').then(r=>{C.tagList=r.tags||[];tagPickFill();}).catch(()=>{});   // kept across visits: the picker is rebuilt each time the page opens
  let timer; const reload=()=>{C.q=$('#q').value; const id=C.q.trim(); if(ID_RE.test(id)){ openById(id).then(ok=>{ if(!ok) reload2(); }); return; } reload2(); }; const reload2=()=>{C.kind=$('#kind').value;C.sort=$('#sort').value;C.status=$('#status').value;C.fpage=1;C.dpage=1;loadCorpus();};
  $('#q').oninput=()=>{clearTimeout(timer);timer=setTimeout(reload,200);};
  ['kind','sort','status'].forEach(id=>$('#'+id).onchange=reload);
  loadCorpus(); loadEntities();
}
/* A name more than one entity holds is shown with its id (`label`); a unique name is shown bare. */
function loadEntities(){
  getJSON('/api/entities').then(r=>{const el=$('#epanel'); if(!el||!r.entities.length)return;
    put(el,html`<div class="panel"><h2>Entities <span class="count">${r.entities.length}${r.shared_names?html` · ${r.shared_names} shared name${r.shared_names===1?'':'s'}`:null}</span></h2>
      <table><thead><tr><th>Entity</th><th>Type</th><th>Facts</th></tr></thead><tbody>${r.entities.map(e=>html`<tr><td>${e.label}</td><td>${e.type||''}</td><td>${e.facts}</td></tr>`)}</tbody></table></div>`);
  }).catch(()=>{});
}
function cparams(kind,page){const p=new URLSearchParams({q:C.q,kind,sort:C.sort,status:C.status,limit:String(PER),offset:String((page-1)*PER)});if(C.tags.length)p.set('tag',C.tags[0]);return p.toString();}
async function loadFacts(){if(C.kind==='decision'){C.facts=[];C.ftotal=0;return;}if(C.tags.length>1){const h=await scanAnd('fact');C.facts=h.rows.slice((C.fpage-1)*PER,C.fpage*PER);C.ftotal=h.rows.length;return;}const s=await getJSON('/api/search?'+cparams('fact',C.fpage));C.facts=s.facts;C.ftotal=s.facts_total||s.facts.length;}
async function loadDecs(){if(C.kind==='fact'){C.decs=[];C.dtotal=0;return;}if(C.tags.length>1){const h=await scanAnd('decision');C.decs=h.rows.slice((C.dpage-1)*PER,C.dpage*PER);C.dtotal=h.rows.length;return;}const s=await getJSON('/api/search?'+cparams('decision',C.dpage));C.decs=s.decisions;C.dtotal=s.decisions_total||s.decisions.length;}
function fpanelFill(){LAST.facts=C.facts;put($('#fpanel'),listBody('Facts',C.ftotal,C.facts.map(factRow),C.fpage,goFacts,'no matches'),cappedNote('fact'));}
function dpanelFill(){LAST.decisions=C.decs;put($('#dpanel'),listBody('Decisions',C.dtotal,C.decs.map(decRow),C.dpage,goDecs,'no matches'),cappedNote('decision'));}
const panelShell=(id,label)=>html`<div id=${id} class="panel"><h2>${label}</h2>${spin()}</div>`;
function loadCorpus(){   // progressive: render each panel's shell, then fill facts and decisions independently
  put($('#results'),C.kind!=='decision'?panelShell('fpanel','Facts'):null,C.kind!=='fact'?panelShell('dpanel','Decisions'):null);
  if(C.kind!=='decision') loadFacts().then(fpanelFill).catch(()=>put($('#fpanel'),html`<h2>Facts</h2>`,empty('error')));
  if(C.kind!=='fact') loadDecs().then(dpanelFill).catch(()=>put($('#dpanel'),html`<h2>Decisions</h2>`,empty('error')));
}
const goFacts=async p=>{C.fpage=p;put($('#fpanel'),html`<h2>Facts</h2>`,spin());try{await loadFacts();}catch(err){}if($('#fpanel'))fpanelFill();window.scrollTo({top:0});};
const goDecs=async p=>{C.dpage=p;put($('#dpanel'),html`<h2>Decisions</h2>`,spin());try{await loadDecs();}catch(err){}if($('#dpanel'))dpanelFill();};
const filterTag=t=>{if(state.detail||state.node){state.detail=null;state.node=null;}state.view='corpus';C.tags=[t];C.q='';C.kind='all';C.status='all';C.fpage=1;C.dpage=1;
  setNav('corpus');corpus();};
const openContested=()=>{state.node=null;state.detail=null;state.view='corpus';C.q='';C.tags=[];C.kind='fact';C.status='contested';C.sort='confidence';C.fpage=1;C.dpage=1;
  setNav('corpus');corpus();};

/* ---------- Hive ---------- */
const dotFor=s=>({'in sync':'ok','reachable':'ok','admitted':'ok','diverged':'stale','stale':'stale','offline':'off'}[s]||'off');
function peerRows(peers,probing){
  return peers.map(p=>{const cls=p.self?'self':dotFor(p.status);
    const st=p.self?p.status:(probing&&!/stale|offline/.test(p.status)?[html`<span class="spin sm"></span>`,' resolving…']:p.status);
    return html`<tr class="link" onclick=${()=>openNode(p.device)} title="View this node">
      <td><span class=${'dot '+cls}></span>${p.name}</td><td class="mono">${p.device}</td><td>${p.principal}</td>
      <td class="mono">${p.addr}</td><td>${p.seen}</td><td>${st}</td></tr>`;});
}
/* A module identity is an admitted key of its own (`module` names it); it is not a device. A core that sends no `module`
   field leaves every row a device, as before. Core records no host device for a module, so they group by module name. */
const isModuleRow=p=>typeof p.module==='string'&&p.module!=='';
function moduleIdentities(mods){
  if(!mods.length) return null;
  const names=[...new Set(mods.map(p=>p.module))].sort();
  return html`<div class="panel"><h2>Module identities <span class="count">${mods.length} admitted</span></h2>
    <table><thead><tr><th>Module</th><th>Identities</th><th>Last seen</th></tr></thead>
    <tbody>${names.map(n=>{const ids=mods.filter(p=>p.module===n);
      return html`<tr><td>${n}</td><td class="mono">${ids.map(p=>html`<div>${p.device}</div>`)}</td><td>${ids.map(p=>html`<div>${p.seen}</div>`)}</td></tr>`;})}</tbody></table></div>
    <div class="note">Each installed module has its own admitted key. They are not devices and are not duplicates: do not purge them.</div>`;
}
function hiveShell(all,probing){
  const peers=all.filter(p=>!isModuleRow(p)), mods=all.filter(isModuleRow);
  const rows=peerRows(peers,probing);
  put($('#app'),html`<div class="panel"><h2>Peers <span class="count">${peers.length} admitted</span>${probing?html`<span class="spin sm"></span>`:null}</h2>
     <table><thead><tr><th>Name</th><th>Device</th><th>Principal</th><th>Address</th><th>Last seen</th><th>Status</th></tr></thead>
     <tbody>${rows.length?rows:html`<tr><td colspan="6" class="empty">no peers</td></tr>`}</tbody></table></div>
   ${moduleIdentities(mods)}
   <div class="note">Click a node for its overview, corpus, stats &amp; telemetry · Stale device? Owner: <span class="mono">hive-mind group purge &lt;device_id&gt;</span></div>
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
function telemetryBody(t,page,pagerFn,showNode,drill){
  LAST.sessions=t.recent||[];
  const T=t.totals||{}; const days=t.by_day||[]; const max=Math.max(1,...days.map(d=>d.sessions));
  const bars=days.map(d=>html`<div title=${d.day+': '+d.sessions+(drill?' — click to filter':'')} style=${Object.assign({height:Math.round(d.sessions/max*100)+'%'},drill?{cursor:'pointer'}:{})} onclick=${drill?()=>telFilterDay(d.day):null}></div>`);
  const xlab=days.map((d,i)=>html`<div>${(i===0||i===days.length-1)?d.day.slice(5):''}</div>`);
  const models=Object.entries(t.by_model||{}).sort((a,b)=>(b[1].in+b[1].out)-(a[1].in+a[1].out));
  const total=t.recent_total||T.sessions||0; const pg=()=>pager(page,total,PER,pagerFn);
  const recent=(t.recent||[]).map((r,i)=>html`<tr class="link" onclick=${()=>openSession(i)}><td class="mono">${r.when}</td>${showNode?html`<td>${r.node_name||r.node||'-'}</td>`:null}<td>${r.agent}</td><td>${r.project}</td><td>${fmtDur(r.duration_s)}</td><td>${fmtNum(r.tokens_in)}/${fmtNum(r.tokens_out)}</td><td>${fmtCost(r.cost_usd)}</td></tr>`);
  return html`<div class="grid cards">
     <div class="card"><div class="lbl">Sessions</div><div class="stat">${fmtNum(T.sessions||0)}</div></div>
     <div class="card"><div class="lbl">Time</div><div class="stat fs20">${fmtDur(T.duration_s)}</div></div>
     <div class="card"><div class="lbl">Tokens</div><div class="stat fs18">${fmtNum(T.tokens_in)}<small> in</small> / ${fmtNum(T.tokens_out)}<small> out</small></div></div>
     <div class="card"><div class="lbl">Cost</div><div class="stat fs20">${fmtCost(T.cost_usd)}${models.some(([,v])=>!v.priced)?html`<small> priced models only</small>`:null}</div></div></div>
   <div class="panel"><h2>Sessions per day</h2><div class="spark">${bars}</div><div class="sparkx">${xlab}</div></div>
   ${models.length?modelTable(models.map(([m,v])=>html`<tr class=${drill?'link':null} onclick=${drill?()=>telFilterModel(m):null}><td class="mono">${m}</td><td>${fmtNum(v.in)}</td><td>${fmtNum(v.out)}</td><td>${v.priced?fmtCost(v.cost):'unpriced'}</td></tr>`)):null}
   <div class="panel"><h2>${fmtNum(total)} Recent session${total===1?'':'s'}${pg()}</h2>
     <table><thead><tr><th>When</th>${showNode?html`<th>Node</th>`:null}<th>Agent</th><th>Project</th><th>Dur</th><th>Tokens</th><th>Cost</th></tr></thead><tbody>${recent}</tbody></table>
     ${total>PER?html`<div class="pgfoot">${pg()}</div>`:null}</div>`;
}

/* ---------- Telemetry tab (combined across the hive, sort+filter) ---------- */
let TP=1, TF={sort:'recent',fnode:'',fproject:'',fagent:'',fday:'',fmodel:''};
const goTel=p=>{TP=p;telemetry();window.scrollTo({top:0});};
const telReload=()=>{TF.sort=$('#tsort').value;TF.fnode=$('#tnode').value;TF.fproject=$('#tproj').value;TF.fagent=$('#tagent').value;TP=1;telemetry();};
const telFilterModel=m=>{TF.fmodel=m;TP=1;telemetry();};
const telFilterDay=d=>{TF.fday=d;TP=1;telemetry();};
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
  const nodesPanel=html`<div class="panel"><h2>${(t.nodes||[]).length} Nodes</h2><table><thead><tr><th>Node</th><th>Sessions</th><th>Status</th></tr></thead><tbody>${(t.nodes||[]).map(n=>html`<tr class=${'link'+(n.status==='offline'?' off':'')} onclick=${()=>openNode(n.node_id)}><td><span class=${'dot '+dotForNode(n.status)}></span>${n.node}</td><td>${fmtNum(n.sessions)}</td><td>${statusText(n.status)}</td></tr>`)}</tbody></table></div>`;
  const chips=[];
  if(TF.fday) chips.push(html`<span class="chip proj">day: ${TF.fday} <a class="pointer" onclick=${()=>telFilterDay('')}>×</a></span>`);
  if(TF.fmodel) chips.push(html`<span class="chip proj">model: ${TF.fmodel} <a class="pointer" onclick=${()=>telFilterModel('')}>×</a></span>`);
  put($('#app'),controls,chips.length?html`<div class="controls">${chips}</div>`:null,line,nodesPanel,
    (t.totals&&t.totals.sessions!==undefined?telemetryBody(t,TP,goTel,true,true):empty('no sessions')));
  $('#tsort').value=TF.sort;
  ['tsort','tnode','tproj','tagent'].forEach(id=>{const e=$('#'+id);if(e)e.onchange=telReload;});
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
    overview:()=>html`${ui&&ui.summary?html`<p>${ui.summary}</p>`:null}<table><tbody>${kv('Version',m.version)}${kv('Publisher',html`<span class="mono">${m.publisher}</span>`)}${kv('Signature',m.signature)}${kv('Service',m.service)}${kv('Device',m.device)}${kv('Trust',m.trust)}${kv('Quota use',m.quota_use)}${m.cli?kv('Command',html`<span class="mono">${m.cli}</span>`):null}</tbody></table>${m.problem?html`<div class="note c-warn">${m.problem}</div>`:null}${ui?null:html`<div class="note">This module declares no page of its own${m.signature==='valid'?'':' (its signature is not valid here, so its manifest is not read)'}.</div>`}`,
    health:()=>healthBody(m.doctor),
    config:()=>settingsPanel('x-'+MP.name+':'),
    actions:()=>html`<div class="note">Run these on this node's terminal. The dashboard runs nothing; an owner action is also signed there, never here.</div>${acts.map(a=>html`<div class="panel"><h2>${a.label||a.id}${a.owner?html` <span class="chip">owner</span>`:null}</h2>${a.confirm?html`<p class="c-dim">${a.confirm}</p>`:null}${cmdBlock(a.command)}</div>`)}`,
  };
  put($('#mpbody'),html`<div class="tabs">${tabs.map(t=>html`<button class=${'tab'+(t[0]===MP.tab?' active':'')} onclick=${()=>{MP.tab=t[0];modulePage();}}>${t[1]}</button>`)}</div><div class="panel">${body[MP.tab]()}</div>`);
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
function settingInput(r){
  const cur=r.secret?'':r.set?showVal(r.value):showVal(r.default==null?'':r.default).replace(/^—$/,'');
  if(r.type==='bool') return html`<select class="sv">${['true','false'].map(o=>html`<option value=${o} selected=${o===String(r.set?r.value:r.default)}>${o}</option>`)}</select>`;
  if(r.type==='enum'&&Array.isArray(r.values)) return html`<select class="sv">${r.values.map(o=>html`<option value=${o} selected=${o===String(r.set?r.value:r.default)}>${o}</option>`)}</select>`;
  return html`<input class="sv" type=${r.secret?'password':'text'} value=${cur} placeholder=${r.secret?(r.set?'set — type to replace':'not set'):''} autocomplete="off" maxlength="4096">`;
}
function settingRow(r){
  const id=r.id, src=SRC_LABEL[r.source]||(r.source||'unset');
  const meta=html`<div class="c-dim fs12">${r.description||''}${r.min!=null||r.max!=null?` (${showVal(r.min)} .. ${showVal(r.max)})`:''}${r.identifying?' · identifying':''}${r.secret?' · secret':''}</div>${(r.warnings||[]).map(w=>html`<div class="c-accent fs12">${w}</div>`)}`;
  const head=html`<td><span class="mono">${id}</span>${meta}</td><td><span class="chip">${src}</span>${r.set_by&&r.set_by.ts?html`<div class="c-dim fs12">set ${r.set_by.ts}</div>`:null}</td>`;
  if(r.template) return html`<tr>${head}<td colspan="2" class="c-dim">a template: set a concrete key with <span class="mono">hconfig set</span></td></tr>`;
  if(r.writable_by==='owner'&&id.startsWith('core:')) return html`<tr>${head}<td>${showVal(r.set?r.value:r.default)}</td><td><div class="c-dim fs12">Read-only here. The owner changes it on the operator's terminal:</div>${r.write_via?cmdBlock(r.write_via):null}</td></tr>`;
  if(r.source==='env') return html`<tr>${head}<td>${showVal(r.value)}</td><td class="c-dim fs12">Overridden by <span class="mono">${r.env||'an environment variable'}</span>; unset it to edit this key.</td></tr>`;
  const tr=html`<tr>${head}<td>${settingInput(r)}</td><td><button class="btn sv-save">Save</button><div class="sv-msg fs12"></div></td></tr>`;
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
function settingsPanel(prefix,cls){
  const box=html`<div>${spin()}</div>`.firstElementChild;
  getJSON('/api/settings?'+new URLSearchParams(Object.assign({prefix},cls?{class:cls}:{}))).then(r=>{
    const fleet=r.keys.filter(k=>k.class==='governed'), nodeK=r.keys.filter(k=>k.class!=='governed');
    put(box,html`<div class="note">Rendered from <span class="mono">hconfig list</span>; a save runs <span class="mono">hconfig set</span> on this node. This page never signs and never sees the owner passphrase.</div>
      ${(r.warnings||[]).map(w=>html`<div class="note c-accent">${w}</div>`)}
      ${nodeK.length?html`<h3>Per-node</h3>${settingsTable(nodeK)}`:null}${fleet.length?html`<h3>Fleet (owner-signed)</h3>${settingsTable(fleet)}`:null}${!r.keys.length?empty('No settings.'):null}`);
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
    html`<div class="panel"><h2>Node</h2>${settingsPanel('node:','node')}<h2>Core governed keys</h2>${settingsPanel('core:','governed')}</div>`);
}

/* ---------- Workspaces (Agents, Trust, Spend, Governance): defined here; a module only declares the panels that fill a slot ---------- */
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
    parts.push(html`<div class="panel"><h2>Modules: signature, publisher and health</h2>${w.modules.length?html`<table><thead><tr><th>Module</th><th>Version</th><th>Publisher</th><th>Signature</th><th>Trust</th><th>Health</th></tr></thead><tbody>${w.modules.map(m=>html`<tr class="link" onclick=${()=>{MP={name:m.name,tab:'overview'};state.view='modulePage';render();}}><td><strong>${m.name}</strong></td><td>${m.version}</td><td class="mono">${m.publisher}</td><td class=${m.signature==='valid'?'c-ok':'c-warn'}>${m.signature}</td><td>${m.trust}</td><td>${healthPill(m.doctor)}</td></tr>`)}</tbody></table>`:empty('No modules installed.')}</div>`);
  }
  if(name==='spend'){
    parts.push(html`<div class="panel"><h2>Module quotas</h2>${w.quotas.length?html`<table><thead><tr><th>Module</th><th>Per hour</th><th>Per day</th><th>Entry bytes</th><th>Lifetime</th><th>Use (this device)</th></tr></thead><tbody>${w.quotas.map(q=>html`<tr><td><strong>${q.module}</strong></td><td>${q.per_hour}</td><td>${q.per_day}</td><td>${q.entry_bytes}</td><td>${q.lifetime}</td><td class="mono">${cell(q.use)}</td></tr>`)}</tbody></table><div class="note">Limits are the core's defaults lowered by the module's signed manifest. A raise by the owner is not shown here; see <code>hive-mind module quota NAME</code>.</div>`:empty('No modules installed.')}</div>`);
  }
  if(name==='governance'){
    parts.push(html`<div class="panel"><h2>Core policy</h2>${w.policy.length?html`<table><thead><tr><th>Key</th><th>Value</th><th>Default</th><th>Set by</th></tr></thead><tbody>${w.policy.map(k=>html`<tr title=${cell(k.description)}><td class="mono">${k.id}</td><td>${cell(k.value)}</td><td class="c-dim">${cell(k.default)}</td><td class="c-dim">${cell(k.source)}</td></tr>`)}</tbody></table>`:empty(w.policy_note||'No core policy keys.')}</div>`);
    parts.push(html`<div class="panel"><h2>Who may write: admission, trust and signature per module</h2>${w.modules.length?html`<table><thead><tr><th>Module</th><th>Publisher</th><th>Signature</th><th>Device</th><th>Trust</th></tr></thead><tbody>${w.modules.map(m=>html`<tr class="link" onclick=${()=>{MP={name:m.name,tab:'overview'};state.view='modulePage';render();}}><td><strong>${m.name}</strong></td><td class="mono">${m.publisher}</td><td class=${m.signature==='valid'?'c-ok':'c-warn'}>${m.signature}</td><td class=${m.device==='admitted'?'c-ok':'c-warn'}>${m.device}</td><td>${m.trust}</td></tr>`)}</tbody></table>`:empty('No modules installed.')}</div>`);
  }
  parts.push(...w.panels.map(wsPanel));
  if(name==='agents'&&!w.panels.length) parts.push(empty('No installed module fills the Agents slot yet. hwatch does once it declares one.'));
  parts.push(...w.notes.map(n=>html`<div class="note">${n}</div>`));
  put($('#wsbody'),...parts);
  if(name==='agents'||name==='spend') agentsTelemetry();
}
async function agentsTelemetry(){
  let t; try{ t=await getJSON('/api/telemetry'); }catch(e){ return; }
  const models=Object.entries((t&&t.by_model)||{}).sort((a,b)=>(b[1].in+b[1].out)-(a[1].in+a[1].out)).slice(0,50);
  const el=$('#wsbody'); if(!el||!models.length) return;
  el.append(...toNodes(modelTable(models.map(([m,v])=>html`<tr><td class="mono">${m}</td><td>${fmtNum(v.in)}</td><td>${fmtNum(v.out)}</td><td>${v.priced?fmtCost(v.cost):'unpriced'}</td></tr>`))));
}
