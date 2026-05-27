// ═══════════════════════════════════════════════════════════════
// EVOLV — app logic (integrated redesign)
// All Firebase / Firestore / Chart.js / business logic preserved from
// the original; only the rendering layer was rewritten to match the
// new design system in evolv-styles.css.
// ═══════════════════════════════════════════════════════════════

// ─── FIREBASE CONFIG ─────────────────────────────────────────────
// Substitua pelos seus dados ou o app pedirá no 1º acesso.
// Regras Realtime Database recomendadas:
//   {
//     "rules": {
//       "users": {
//         "$uid": {
//           ".read": "auth != null && auth.uid == $uid",
//           ".write": "auth != null && auth.uid == $uid"
//         }
//       }
//     }
//   }
const FIREBASE_CONFIG = {
  apiKey: "AIzaSyCvwm5Abo4sL0WTGcUdIBPUj4qUSDtO4J8",
  authDomain: "evolv-82ec2.firebaseapp.com",
  projectId: "evolv-82ec2",
  storageBucket: "evolv-82ec2.firebasestorage.app",
  messagingSenderId: "934840298557",
  appId: "1:934840298557:web:8f79f024e8e2d8ce6a0e54",
  measurementId: "G-E27HHXWXPX"
};

// ─── ICON HELPER ─────────────────────────────────────────────────
const IC = {
  _s:(p,s=20,sw=1.7)=>`<svg width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="${sw}" stroke-linecap="round" stroke-linejoin="round">${p}</svg>`,
  activity:(s=20)=>IC._s('<path d="M22 12h-4l-3 9L9 3l-3 9H2"/>',s),
  layers:(s=20)=>IC._s('<path d="M12 3 2 8l10 5 10-5z"/><path d="M2 13l10 5 10-5M2 18l10 5 10-5"/>',s),
  scale:(s=20)=>IC._s('<path d="M12 4v16M5 8h14l-3 8a4 4 0 0 1-8 0z"/><circle cx="12" cy="4" r="1.4"/>',s),
  trophy:(s=20)=>IC._s('<path d="M6 9H4.5a2.5 2.5 0 0 1 0-5H6"/><path d="M18 9h1.5a2.5 2.5 0 0 0 0-5H18"/><path d="M4 22h16"/><path d="M10 14.66V17c0 .55-.47.98-.97 1.21C7.85 18.75 7 20.24 7 22"/><path d="M14 14.66V17c0 .55.47.98.97 1.21C16.15 18.75 17 20.24 17 22"/><path d="M18 2H6v7a6 6 0 0 0 12 0V2z"/>',s),
  flame:(s=20)=>IC._s('<path d="M12 3c1 4 5 5 5 10a5 5 0 0 1-10 0c0-2 1-3 2-4-1 4 2 4 2 1 0-3-1-4 1-7z"/>',s),
  trendUp:(s=20)=>IC._s('<path d="M3 17l6-6 4 4 8-8"/><path d="M14 7h7v7"/>',s),
  trendDown:(s=20)=>IC._s('<path d="M3 7l6 6 4-4 8 8"/><path d="M14 17h7v-7"/>',s),
  sun:(s=18)=>IC._s('<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41"/>',s),
  moon:(s=18)=>IC._s('<path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/>',s),
  zap:(s=18)=>IC._s('<path d="M13 2 4 14h7l-1 8 9-12h-7z"/>',s),
  clipboard:(s=20)=>IC._s('<rect width="8" height="4" x="8" y="2" rx="1"/><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/><path d="M12 11h4M12 16h4M8 11h.01M8 16h.01"/>',s),
  check:(s=16)=>IC._s('<path d="M5 12l5 5L20 6"/>',s,2.2),
  trash:(s=14)=>IC._s('<path d="M3 6h18M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/>',s),
  edit:(s=14)=>IC._s('<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/>',s),
  close:(s=16)=>IC._s('<path d="M18 6 6 18M6 6l12 12"/>',s,2.2),
  play:(s=14)=>`<svg width="${s}" height="${s}" viewBox="0 0 24 24" fill="currentColor"><path d="M7 5.5c0-1.1 1.2-1.8 2.2-1.2l11 6.5c.9.6.9 2 0 2.5l-11 6.5c-1 .6-2.2-.1-2.2-1.2z"/></svg>`,
  plus:(s=14)=>IC._s('<path d="M12 5v14M5 12h14"/>',s,2.4),
  arrowDown:(s=12)=>IC._s('<path d="M12 5v14M19 12l-7 7-7-7"/>',s,2.4),
  arrowUp:(s=12)=>IC._s('<path d="M12 19V5M5 12l7-7 7 7"/>',s,2.4),
  arrowRight:(s=14)=>IC._s('<path d="M5 12h14M13 6l6 6-6 6"/>',s),
  chevronRight:(s=14)=>IC._s('<path d="M9 6l6 6-6 6"/>',s),
  download:(s=14)=>IC._s('<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="M7 10l5 5 5-5M12 15V3"/>',s),
  target:(s=18)=>IC._s('<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="5"/><circle cx="12" cy="12" r="1.4"/>',s),
};

// ─── DB ──────────────────────────────────────────────────────────
const DB = {
  cache:{fichas:[],sessoes:[],pesos:[]},
  ready:false, _local:false, _db:null, _uid:null,
  _loadCount:0, _resolveReady:null, _online:true,

  async init(){
    let cfg = FIREBASE_CONFIG;
    if(!cfg.apiKey){
      const saved = localStorage.getItem('evolv_fbcfg');
      if(saved) try{ cfg = JSON.parse(saved); }catch{}
    }
    if(!cfg.apiKey || localStorage.getItem('evolv_offline')==='1'){
      App.showFBSetup(!cfg.apiKey);
      return;
    }
    try{
      firebase.initializeApp(cfg);
      DB._db = firebase.database();
      const cred = await firebase.auth().signInAnonymously();
      DB._uid = cred.user.uid;
      DB._listen('fichas'); DB._listen('sessoes'); DB._listen('pesos');
      window.addEventListener('online',  ()=>{ DB._online=true;  App.updateDot(); });
      window.addEventListener('offline', ()=>{ DB._online=false; App.updateDot(); });
      DB._online = navigator.onLine;
    } catch(e){
      console.warn('Firebase falhou, usando offline:', e);
      DB._fallback();
    }
  },

  _col(n){ return DB._db.ref(`users/${DB._uid}/${n}`); },

  _listen(name){
    DB._col(name).on('value', snap=>{
      const data = snap.val() || {};
      DB.cache[name] = Object.keys(data).map(id=>({id,...data[id]}));
      if(name==='pesos') DB.cache.pesos.sort((a,b)=>a.date.localeCompare(b.date));
      if(name==='sessoes') DB.cache.sessoes.sort((a,b)=>a.date.localeCompare(b.date));
      if(name==='fichas') DB.cache.fichas.sort((a,b)=>(a.at||0)-(b.at||0));
      DB._loadCount++;
      if(DB._loadCount >= 3 && !DB.ready){
        DB.ready=true; DB._resolveReady();
      } else if(DB.ready){
        App.renderPage(S.page);
      }
    }, err=>{ DB._loadCount++; if(DB._loadCount>=3 && !DB.ready){DB.ready=true; DB._resolveReady();} });
  },

  _fallback(){
    DB._local=true;
    const g=(k)=>{try{return JSON.parse(localStorage.getItem('ev_'+k))||[]}catch{return[]}};
    DB.cache={fichas:g('fichas'),sessoes:g('sessoes'),pesos:g('pesos')};
    DB.ready=true; DB._resolveReady();
  },

  _lsave(k){ if(DB._local) localStorage.setItem('ev_'+k, JSON.stringify(DB.cache[k])); },

  fichas:()=>DB.cache.fichas,
  sessoes:()=>DB.cache.sessoes,
  pesos:()=>DB.cache.pesos,

  async addFicha(d){
    if(DB._local){DB.cache.fichas.push(d);DB._lsave('fichas');App.renderFichas();return;}
    await DB._col('fichas').child(d.id).set(d);
  },
  async updFicha(id,d){
    if(DB._local){const i=DB.cache.fichas.findIndex(f=>f.id===id);if(i>=0)DB.cache.fichas[i]={...DB.cache.fichas[i],...d};DB._lsave('fichas');App.renderFichas();return;}
    await DB._col('fichas').child(id).update(d);
  },
  async delFicha(id){
    if(DB._local){DB.cache.fichas=DB.cache.fichas.filter(f=>f.id!==id);DB._lsave('fichas');App.renderFichas();return;}
    await DB._col('fichas').child(id).remove();
  },
  async addSessao(d){
    if(DB._local){DB.cache.sessoes.push(d);DB._lsave('sessoes');return;}
    await DB._col('sessoes').child(d.id).set(d);
  },
  async addPeso(d){
    if(DB._local){DB.cache.pesos.push(d);DB.cache.pesos.sort((a,b)=>a.date.localeCompare(b.date));DB._lsave('pesos');App.renderPeso();return;}
    await DB._col('pesos').child(d.id).set(d);
  },
  async delPeso(id){
    if(DB._local){DB.cache.pesos=DB.cache.pesos.filter(p=>p.id!==id);DB._lsave('pesos');App.renderPeso();return;}
    await DB._col('pesos').child(id).remove();
  },
};
DB.whenReady = new Promise(r=>{DB._resolveReady=r;});

// ─── STATE ───────────────────────────────────────────────────────
const S = {
  page:'home', timerTab:0, series:0,
  timer:{total:90,rem:90,running:false,iv:null},
  workout:{on:false,fichaId:null,dayIdx:null,t0:null,iv:null,exs:[]},
  charts:{},
  notifications:[],
  // colors cycled across fichas for the watermark/accent
  fichaColors: ['var(--heat)','var(--cool)','var(--violet)','var(--green)','var(--amber)','var(--red)'],
};

// ─── UTILS ───────────────────────────────────────────────────────
const $=id=>document.getElementById(id);
const uid=()=>Date.now().toString(36)+Math.random().toString(36).slice(2,6);
const ft=s=>`${String(Math.floor(s/60)).padStart(2,'0')}:${String(s%60).padStart(2,'0')}`;
const fd=d=>{
  if(!d)return '—';
  return new Date(d+(d.length===10?'T12:00':'')).toLocaleDateString('pt-BR',{day:'2-digit',month:'short'});
};
const today=()=>new Date().toISOString().slice(0,10);
const relTime=(iso)=>{
  if(!iso) return '';
  const diff=(Date.now()-new Date(iso).getTime())/86400000;
  if(diff < 0.04) return 'agora';
  if(diff < 0.1)  return 'há minutos';
  if(diff < 1)    return 'hoje';
  if(diff < 2)    return 'ontem';
  if(diff < 7)    return `há ${Math.floor(diff)} dias`;
  if(diff < 14)   return 'há 1 semana';
  if(diff < 30)   return `há ${Math.floor(diff/7)} semanas`;
  return `há ${Math.floor(diff/30)} meses`;
};

// Chart.js default options matching the new dark theme
const CDO = {
  responsive:true, maintainAspectRatio:false,
  plugins:{legend:{display:false},tooltip:{
    backgroundColor:'#1D2028',titleColor:'#F5F6F8',bodyColor:'#F5F6F8',
    borderColor:'rgba(255,255,255,0.09)',borderWidth:1,padding:10,cornerRadius:10,
    titleFont:{family:'Space Grotesk',weight:'600',size:12},
    bodyFont:{family:'JetBrains Mono',size:12},
  }},
  scales:{
    x:{grid:{color:'rgba(255,255,255,0.04)',drawTicks:false},ticks:{color:'rgba(245,246,248,0.42)',font:{size:9,family:'JetBrains Mono'}},border:{display:false}},
    y:{grid:{color:'rgba(255,255,255,0.04)',drawTicks:false},ticks:{color:'rgba(245,246,248,0.42)',font:{size:9,family:'JetBrains Mono'}},beginAtZero:true,border:{display:false}}
  }
};

const ACCENT = '#1FE07A';
const ACCENT_2 = '#15B863';
const ACCENT_DIM = 'rgba(31,224,122,0.18)';
const COOL = '#6BA8FF';
const HEAT = '#FF8A3B';

// ═══════════════════════════════════════════════════════════════
//  APP
// ═══════════════════════════════════════════════════════════════
const App = {

nav(p){
  S.page=p;
  document.querySelectorAll('.page').forEach(el=>el.classList.remove('active'));
  document.querySelectorAll('.ni').forEach(el=>el.classList.remove('active'));
  $('pg-'+p).classList.add('active');
  document.querySelector(`[data-p="${p}"]`)?.classList.add('active');
  App.renderPage(p);
},

renderPage(p){
  if(p==='home') App.renderHome();
  else if(p==='fichas') App.renderFichas();
  else if(p==='timer') App.renderTimerTicks();
  else if(p==='stats') App.renderStats();
  else if(p==='peso') App.renderPeso();
},

// ─── SFX (WebAudio) ─────────────────────────────────────────────
sound:{
  enabled: localStorage.getItem('evolv_sfx')!=='0',
  _ctx:null,_gain:null,
  init(){
    try{
      const C = window.AudioContext || window.webkitAudioContext;
      this._ctx = new C();
      this._gain = this._ctx.createGain();
      this._gain.connect(this._ctx.destination);
      this._gain.gain.value = 0.12;
    }catch(e){ this._ctx = null; }
  },
  play(type='click'){
    if(!this.enabled) return;
    if(!this._ctx) try{ this.init(); }catch{}
    if(!this._ctx) return;
    const now = this._ctx.currentTime;
    const g = this._gain;
    const o = this._ctx.createOscillator();
    o.type = 'sine';
    o.frequency.setValueAtTime(type==='click'?1100:800, now);
    const gg = this._ctx.createGain();
    gg.gain.setValueAtTime(0.0001, now);
    gg.gain.exponentialRampToValueAtTime(1, now + 0.006);
    gg.gain.exponentialRampToValueAtTime(0.0001, now + 0.06);
    o.connect(gg); gg.connect(g);
    o.start(now); o.stop(now + 0.07);
  },
  toggle(v){ this.enabled = typeof v==='boolean' ? v : !this.enabled; localStorage.setItem('evolv_sfx', this.enabled ? '1' : '0'); }
},


// ─── HOME ────────────────────────────────────────────────────────
renderHome(){
  const h=new Date().getHours();
  const [ico,txt] = h<12?[IC.sun(14),'Bom dia']:h<18?[IC.zap(14),'Boa tarde']:[IC.moon(14),'Boa noite'];
  const sess=DB.sessoes(), pesos=DB.pesos(), fichas=DB.fichas(), now=new Date();

  // metrics
  const wk = sess.filter(s=>(now-new Date(s.date))/864e5<=7);
  const mo = sess.filter(s=>{const d=new Date(s.date);return d.getMonth()===now.getMonth()&&d.getFullYear()===now.getFullYear();});
  const vol = mo.reduce((a,s)=>a+(s.exs||[]).reduce((b,e)=>b+(e.sets||[]).filter(x=>x.done).reduce((c,x)=>c+(+x.reps||0)*(+x.w||0),0),0),0);

  // streak: consecutive days with at least 1 session, going back from today
  const sessDays = new Set(sess.map(s=>s.date.slice(0,10)));
  let streak = 0;
  for(let i=0;i<60;i++){
    const d=new Date(now); d.setDate(now.getDate()-i);
    const k=d.toISOString().slice(0,10);
    if(sessDays.has(k)) streak++;
    else if(i>0) break;
  }

  // last session
  const last = sess.length ? sess[sess.length-1] : null;
  const suggestedFicha = fichas[0];

  // Hero — adapt copy based on data state
  const heroTitle = suggestedFicha
    ? `Pronto para <em>${(suggestedFicha.days?.[0]?.name || suggestedFicha.name).slice(0,28)}</em>?`
    : `Sua evolução <em>começa aqui.</em>`;
  const heroMeta = suggestedFicha
    ? `<span>${IC.layers(14)} ${suggestedFicha.days?.length||0} dias</span><span>${IC.activity(14)} ${(suggestedFicha.days||[]).reduce((a,d)=>a+(d.exs||[]).length,0)} exercícios</span>`
    : '';

  // recent sessions
  const recent = sess.slice(-3).reverse();
  const recentHtml = recent.length
    ? recent.map((s,i)=>{
        const f=fichas.find(f=>f.id===s.fichaId);
        const d=f?.days?.[s.dayIdx];
        const v=(s.exs||[]).reduce((a,e)=>a+(e.sets||[]).filter(x=>x.done).reduce((b,x)=>b+(+x.reps||0)*(+x.w||0),0),0);
        const sets=(s.exs||[]).reduce((a,e)=>a+(e.sets||[]).filter(x=>x.done).length,0);
        const tag=String.fromCharCode(65+i);
        const color=S.fichaColors[i%S.fichaColors.length];
        return `<div class="wi">
          <div class="wi-ico" style="background:color-mix(in oklab, ${color} 14%, transparent);color:${color};border-color:color-mix(in oklab, ${color} 32%, transparent)">${tag}</div>
          <div class="wi-info">
            <div class="wi-name">${d?.name||f?.name||'Treino'}</div>
            <div class="wi-sub">${relTime(s.date)} · ${sets} séries</div>
          </div>
          <div class="wi-right">
            <div class="num">${ft(s.dur||0)}</div>
            <div class="meta">${v?(v>=1000?(v/1000).toFixed(1)+'t':v+'kg'):'—'}</div>
          </div>
        </div>`;
      }).join('')
    : `<div class="empty">
        <div class="empty-ico">${IC.activity(28)}</div>
        <div class="et">Nenhum treino registrado</div>
        <div class="es">Inicie um treino para ver<br>seu histórico aqui.</div>
      </div>`;

  // week dots: 7 days ending today
  const dayLabels=['D','S','T','Q','Q','S','S'];
  const weekDots = Array.from({length:7}).map((_,i)=>{
    const d=new Date(now); d.setDate(now.getDate()-(6-i));
    const k=d.toISOString().slice(0,10);
    const done = sessDays.has(k);
    const today = i===6;
    const dow = d.getDay();
    return `<div class="wk-day">
      <div class="wd">${dayLabels[dow]}</div>
      <div class="wdot ${done?'done':''} ${today&&!done?'today':''}">${done?IC.check(14):''}</div>
    </div>`;
  }).join('');

  const weekTarget = 5;
  $('pg-home').innerHTML = `
    <div class="hero">
      <div class="hg">${ico}<span>${txt}</span></div>
      <div class="ht">${heroTitle}</div>
      ${heroMeta?`<div class="hmeta">${heroMeta}</div>`:''}
      <button class="btn bp lg" onclick="App.startTodayWorkout()">
        ${IC.play(14)}
        <span>Iniciar treino</span>
      </button>
    </div>

    <div class="srow">
      <div class="sc"><div class="sl">Semana</div><div class="sv">${wk.length}<small>/${weekTarget}</small></div><div class="ss">treinos</div></div>
      <div class="sc"><div class="sl" style="color:var(--heat)">Volume</div><div class="sv">${vol>=1000?(vol/1000).toFixed(1):vol}<small>${vol>=1000?'t':'kg'}</small></div><div class="ss">este mês</div></div>
      <div class="sc"><div class="sl" style="color:var(--cool)">Streak</div><div class="sv">${streak}<small>d</small></div><div class="ss">${streak>0?'ativo':'—'}</div></div>
    </div>

    <div class="card">
      <div class="between" style="margin-bottom:12px">
        <div class="eyebrow">Esta semana</div>
        <div class="meta">${wk.length} / ${weekTarget} planejado</div>
      </div>
      <div class="wk-grid">${weekDots}</div>
    </div>

    <div class="between" style="padding:18px 2px 8px">
      <div class="eyebrow">Últimos treinos</div>
      ${recent.length?`<button onclick="App.nav('stats')" style="display:flex;align-items:center;gap:4px;color:var(--t1);font-size:12px">Ver tudo ${IC.chevronRight(14)}</button>`:''}
    </div>
    <div>${recentHtml}</div>
  `;
},

// ─── FICHAS ──────────────────────────────────────────────────────
renderFichas(){
  const fichas=DB.fichas();
  const sess=DB.sessoes();
  const root=$('pg-fichas');

  const top = `
    <div style="margin:4px 0 14px">
      <div class="eyebrow" style="color:var(--green)">Suas fichas</div>
      <div class="between" style="margin-top:6px">
        <div class="h1" style="font-size:24px">${fichas.length} ${fichas.length===1?'rotina ativa':'rotinas ativas'}</div>
      </div>
    </div>
    <div class="row" style="margin-bottom:14px;gap:8px">
      <button class="btn bp sm" style="flex:1" onclick="App.showAddFicha()">
        ${IC.plus(14)} Nova ficha
      </button>
      <button class="icon-btn" onclick="App.showImportFicha()" title="Importar JSON">${IC.download(16)}</button>
    </div>
  `;

  if(!fichas.length){
    root.innerHTML = top + `
      <div class="empty">
        <div class="empty-ico">${IC.clipboard(28)}</div>
        <div class="et">Nenhuma ficha criada</div>
        <div class="es">Crie sua primeira ficha de treino<br>para começar a registrar suas sessões.</div>
      </div>
    `;
    return;
  }

  root.innerHTML = top + fichas.map((f,fi)=>{
    const color = S.fichaColors[fi % S.fichaColors.length];
    const tag = String.fromCharCode(65 + fi);
    const totalEx = (f.days||[]).reduce((a,d)=>a+(d.exs||[]).length,0);
    // sessions for this ficha
    const fSess = sess.filter(s=>s.fichaId===f.id);
    const lastDate = fSess.length ? fSess[fSess.length-1].date : null;
    const totalVol = fSess.reduce((a,s)=>a+(s.exs||[]).reduce((b,e)=>b+(e.sets||[]).filter(x=>x.done).reduce((c,x)=>c+(+x.reps||0)*(+x.w||0),0),0),0);
    const avgVol = fSess.length ? totalVol / fSess.length : 0;
    // progress = ratio of sets done in the last session
    let progress = 0;
    if(fSess.length){
      const ls = fSess[fSess.length-1];
      const done = (ls.exs||[]).reduce((a,e)=>a+(e.sets||[]).filter(x=>x.done).length,0);
      const total = (ls.exs||[]).reduce((a,e)=>a+(e.sets||[]).length,0);
      progress = total ? done/total : 0;
    }

    return `<div class="fc">
      <div class="fc-accent" style="background:${color}"></div>
      <div class="fc-watermark" style="color:color-mix(in oklab, ${color} 8%, transparent)">${tag}</div>

      <div class="fc-head">
        <div class="fc-head-info">
          <div class="fc-name">
            <span class="fc-tag" style="background:color-mix(in oklab, ${color} 18%, transparent);color:${color}">${tag}</span>
            ${f.name}
          </div>
          <div class="fc-meta">${(f.days||[]).length} dias · ${totalEx} exercícios</div>
        </div>
        <button class="icon-btn" style="width:32px;height:32px;border-radius:9px" onclick="App.editFicha('${f.id}')">${IC.edit(14)}</button>
        <button class="icon-btn danger" style="width:32px;height:32px;border-radius:9px" onclick="App.delFicha('${f.id}')">${IC.trash(14)}</button>
      </div>

      <div class="fc-stats">
        <div class="fc-stat">
          <div class="num">${(f.days||[]).length}</div>
          <div class="lbl">dias</div>
        </div>
        <div class="fc-divider"></div>
        <div class="fc-stat">
          <div class="num">${avgVol>=1000?(avgVol/1000).toFixed(1)+'t':Math.round(avgVol)+'kg'}</div>
          <div class="lbl">volume médio</div>
        </div>
        <div class="fc-divider"></div>
        <div class="fc-stat">
          <div style="font-size:13px;color:var(--t1);font-weight:500">${lastDate?relTime(lastDate):'—'}</div>
          <div class="lbl">última</div>
        </div>
      </div>

      ${fSess.length ? `
      <div class="fc-prog-row">
        <div class="eyebrow" style="font-size:10px">Última sessão</div>
        <div class="mono" style="font-size:11px;color:${color}">${Math.round(progress*100)}%</div>
      </div>
      <div class="prog-track">
        <div class="prog-bar" style="width:${progress*100}%;background:${color}"></div>
      </div>` : ''}

      <div style="margin-top:14px">
        ${(f.days||[]).map((d,di)=>`
          <div class="fc-day" onclick="App.startWorkout('${f.id}',${di})">
            <div class="dn" style="background:color-mix(in oklab, ${color} 14%, transparent);color:${color}">${di+1}</div>
            <div class="di">
              <div class="dn2">${d.name}</div>
              <div class="ds">${(d.exs||[]).map(e=>e.name).filter(Boolean).join(', ')||'—'}</div>
            </div>
            <div class="dgo">${IC.play(12)}</div>
          </div>
        `).join('')}
      </div>
    </div>`;
  }).join('');
},

// ─── TIMER ───────────────────────────────────────────────────────
renderTimerTicks(){
  const g = document.getElementById('tring-ticks');
  if(!g || g.childElementCount) return; // only once
  const size = 280, r = 126, stroke = 14;
  for(let i=0;i<60;i++){
    const angle = (i/60)*2*Math.PI - Math.PI/2;
    const innerR = r - stroke/2 - 8;
    const outerR = r - stroke/2 - (i%5===0 ? 14 : 11);
    const x1 = size/2 + Math.cos(angle)*innerR;
    const y1 = size/2 + Math.sin(angle)*innerR;
    const x2 = size/2 + Math.cos(angle)*outerR;
    const y2 = size/2 + Math.sin(angle)*outerR;
    const line = document.createElementNS('http://www.w3.org/2000/svg','line');
    line.setAttribute('x1',x1); line.setAttribute('y1',y1);
    line.setAttribute('x2',x2); line.setAttribute('y2',y2);
    line.setAttribute('stroke', i%5===0 ? 'rgba(255,255,255,0.16)' : 'rgba(255,255,255,0.06)');
    line.setAttribute('stroke-width', i%5===0 ? '1.6' : '1');
    line.setAttribute('stroke-linecap','round');
    g.appendChild(line);
  }
},

showTimerTab(i){
  S.timerTab=i;
  document.querySelectorAll('.seg-btn').forEach((b,bi)=>b.classList.toggle('on',bi===i));
  $('tab-interval').style.display = i===0?'block':'none';
  $('tab-series').style.display = i===1?'block':'none';
},

setPreset(s){
  if(S.timer.running) App.stopTimer();
  S.timer.total=s; S.timer.rem=s; App.updTimer();
  document.querySelectorAll('.tp').forEach(b=>b.classList.remove('on'));
  [30,45,90,120,180].forEach((v,i)=>{ if(v===s) document.querySelectorAll('.tp')[i]?.classList.add('on'); });
  if($('cmin')) $('cmin').value = Math.floor(s/60);
  if($('csec')) $('csec').value = s%60;
},

setCustomTime(){
  const t = (+($('cmin')?.value||0))*60 + (+($('csec')?.value||0));
  if(t>0){
    if(S.timer.running) App.stopTimer();
    S.timer.total=t; S.timer.rem=t; App.updTimer();
    document.querySelectorAll('.tp').forEach(b=>b.classList.remove('on'));
  }
},

toggleTimer(){ S.timer.running ? App.stopTimer() : App.startTimer(); },

startTimer(){
  if(S.timer.rem<=0) S.timer.rem = S.timer.total;
  S.timer.running=true;
  $('tstatus').textContent='Contando';
  $('tplayico').outerHTML = '<svg id="tplayico" width="28" height="28" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="5" width="4.5" height="14" rx="1.2"/><rect x="13.5" y="5" width="4.5" height="14" rx="1.2"/></svg>';
  S.timer.iv = setInterval(()=>{
    S.timer.rem--; App.updTimer();
    if(S.timer.rem<=0){
      App.stopTimer();
      $('tstatus').textContent='Tempo!';
      if(navigator.vibrate) navigator.vibrate([250,100,250,100,250]);
      App.toast('Intervalo finalizado!');
    }
  },1000);
},

stopTimer(){
  S.timer.running=false; clearInterval(S.timer.iv);
  const old = $('tplayico');
  if(old) old.outerHTML = '<svg id="tplayico" width="28" height="28" viewBox="0 0 24 24" fill="currentColor"><path d="M7 5.5c0-1.1 1.2-1.8 2.2-1.2l11 6.5c.9.6.9 2 0 2.5l-11 6.5c-1 .6-2.2-.1-2.2-1.2z"/></svg>';
  $('tstatus').textContent = S.timer.rem>0 ? 'Pausado' : 'Pronto';
},

resetTimer(){ App.stopTimer(); S.timer.rem=S.timer.total; App.updTimer(); $('tstatus').textContent='Pronto'; },

bumpTimer(seconds){
  S.timer.rem = Math.max(1, S.timer.rem + seconds);
  S.timer.total = Math.max(S.timer.total, S.timer.rem);
  App.updTimer();
},

updTimer(){
  const {total,rem} = S.timer;
  const r=126; const C = 2*Math.PI*r;
  const d=$('tdisplay'), ring=$('tring');
  if(d) d.textContent = ft(rem);
  if(ring){
    const p = total>0 ? rem/total : 1;
    ring.setAttribute('stroke-dasharray', C);
    ring.setAttribute('stroke-dashoffset', C*(1-p));
    ring.setAttribute('stroke', rem<=10 && rem>0 ? '#FF5577' : 'url(#tg)');
  }
},

// ─── SERIES counter ──────────────────────────────────────────────
addSeries(d){
  S.series = Math.max(0, S.series + d);
  const el=$('sc-num');
  if(el){
    el.textContent = S.series;
    el.style.color = S.series>0 ? 'var(--green)' : 'var(--t0)';
    el.classList.add('bump');
    setTimeout(()=>el.classList.remove('bump'), 160);
  }
},

resetSeries(){
  S.series=0;
  const el=$('sc-num');
  if(el){ el.textContent=0; el.style.color='var(--t0)'; }
},

// ─── STATS ───────────────────────────────────────────────────────
renderStats(){
  const sess=DB.sessoes(), pesos=DB.pesos();
  const root=$('stats-content');
  if(!sess.length && !pesos.length){
    root.innerHTML = `<div class="empty">
      <div class="empty-ico">${IC.trendUp(28)}</div>
      <div class="et">Sem dados ainda</div>
      <div class="es">Registre treinos e pesagens<br>para ver suas estatísticas.</div>
    </div>`;
    return;
  }

  const now=new Date();
  // total counts
  const total = sess.length;
  const vol = sess.reduce((a,s)=>a+(s.exs||[]).reduce((b,e)=>b+(e.sets||[]).filter(x=>x.done).reduce((c,x)=>c+(+x.reps||0)*(+x.w||0),0),0),0);
  const series = sess.reduce((a,s)=>a+(s.exs||[]).reduce((b,e)=>b+(e.sets||[]).filter(x=>x.done).length,0),0);

  // last 12 weeks volume (each week sum, current = last bar)
  const weeks=[]; const weekLabels=[];
  for(let i=11;i>=0;i--){
    const start=new Date(now); start.setDate(now.getDate()-(i*7+6));
    const end=new Date(now);   end.setDate(now.getDate()-(i*7));
    const v = sess.filter(s=>{const d=new Date(s.date);return d>=start&&d<=end;})
      .reduce((a,s)=>a+(s.exs||[]).reduce((b,e)=>b+(e.sets||[]).filter(x=>x.done).reduce((c,x)=>c+(+x.reps||0)*(+x.w||0),0),0),0);
    weeks.push(v); weekLabels.push(i===0?'agora':`-${i}s`);
  }
  const maxW = Math.max(...weeks, 1);
  const avgW = (weeks.reduce((a,b)=>a+b,0) / weeks.length) || 0;
  const lastW = weeks[weeks.length-1];
  const prevW = weeks[weeks.length-2] || 0;
  const wDelta = prevW ? ((lastW - prevW)/prevW)*100 : 0;

  // top exercises by total volume across all sessions
  const byEx = {};
  sess.forEach(s=>{ (s.exs||[]).forEach(e=>{
    const v = (e.sets||[]).filter(x=>x.done).reduce((c,x)=>c+(+x.reps||0)*(+x.w||0),0);
    if(!e.name) return;
    byEx[e.name] = (byEx[e.name]||0) + v;
  });});
  const topEx = Object.entries(byEx).sort((a,b)=>b[1]-a[1]).slice(0,5);
  const topMax = topEx[0]?.[1] || 1;

  root.innerHTML = `
    <div class="stats-hero">
      <div class="eyebrow">Estatísticas</div>
      <div class="h1" style="margin-top:4px">
        ${vol>=1000?(vol/1000).toFixed(1):vol}<small>${vol>=1000?'t volume':'kg volume'}</small>
        <small style="margin:0 6px">·</small>
        ${total}<small> treinos</small>
      </div>
      <div class="meta" style="margin-top:4px">
        ${total?`${series} séries · ${wDelta>=0?'+':''}${wDelta.toFixed(0)}% vs semana anterior`:'sem dados de treino'}
      </div>
    </div>

    <div class="srow">
      <div class="sc"><div class="sl">Treinos</div><div class="sv">${total}</div><div class="ss">total</div></div>
      <div class="sc"><div class="sl" style="color:var(--heat)">Volume</div><div class="sv">${vol>=1000?(vol/1000).toFixed(1):vol}<small>${vol>=1000?'t':'kg'}</small></div><div class="ss">total</div></div>
      <div class="sc"><div class="sl" style="color:var(--cool)">Séries</div><div class="sv">${series}</div><div class="ss">total</div></div>
    </div>

    <div class="card">
      <div class="between" style="margin-bottom:12px">
        <div>
          <div class="eyebrow">Volume por semana</div>
          <div class="row" style="gap:6px;margin-top:4px;align-items:baseline">
            <div class="num" style="font-size:20px">${avgW>=1000?(avgW/1000).toFixed(1)+'t':Math.round(avgW)+'kg'}</div>
            <div class="meta">média</div>
          </div>
        </div>
        ${wDelta>=0 ? `<div class="row" style="gap:4px;color:var(--green)">${IC.trendUp(14)}<span class="num" style="font-size:13px">+${wDelta.toFixed(0)}%</span></div>`
                   : `<div class="row" style="gap:4px;color:var(--heat)">${IC.trendDown(14)}<span class="num" style="font-size:13px">${wDelta.toFixed(0)}%</span></div>`}
      </div>
      <div class="bar-chart">
        ${weeks.map((v,i)=>{
          const h = (v/maxW)*100;
          const cur = i===weeks.length-1;
          return `<div class="bar-col ${cur?'cur':''}">
            <div class="bar" style="height:${h}%;min-height:${v?4:2}px"></div>
            <div class="blabel">${i===0?'-11':i===weeks.length-1?'agora':''}</div>
          </div>`;
        }).join('')}
      </div>
    </div>

    ${pesos.length>=2 ? `
    <div class="card">
      <div class="eyebrow">Evolução do peso</div>
      <div class="row" style="gap:6px;margin-top:6px;align-items:baseline">
        <div class="num" style="font-size:22px">${pesos[pesos.length-1].w}<small style="font-size:13px;color:var(--t2);font-weight:500;margin-left:2px">kg</small></div>
        ${(() => {
          const first=pesos[0].w, last=pesos[pesos.length-1].w, diff=(last-first).toFixed(1);
          const cls = diff>0?'color:var(--heat)':'color:var(--cool)';
          return `<div class="meta" style="${cls}">${diff>0?'+':''}${diff}kg · ${pesos.length} pesagens</div>`;
        })()}
      </div>
      <div class="cwrap" style="margin-top:8px"><canvas id="ch-pe"></canvas></div>
    </div>` : ''}

    ${topEx.length ? `
    <div class="eyebrow" style="margin:22px 0 10px">Exercícios · top volume</div>
    <div>
      ${topEx.map(([n,v])=>{
        const pct = (v/topMax)*100;
        return `<div class="lb-row">
          <div class="lb-head">
            <div class="lb-name">${n}</div>
            <div class="lb-val">${v>=1000?(v/1000).toFixed(1)+'t':v+'kg'}</div>
          </div>
          <div class="lb-bar"><div class="lb-fill" style="width:${pct}%"></div></div>
        </div>`;
      }).join('')}
    </div>` : ''}
  `;

  // peso chart
  setTimeout(()=>{
    Object.values(S.charts).forEach(c=>{try{c.destroy()}catch{}}); S.charts={};
    if($('ch-pe') && pesos.length>=2){
      const lp=pesos.slice(-24);
      const op={...CDO, scales:{...CDO.scales, y:{...CDO.scales.y, beginAtZero:false}}};
      S.charts.pe = new Chart($('ch-pe'),{
        type:'line',
        data:{labels:lp.map(p=>fd(p.date)),datasets:[{
          data:lp.map(p=>p.w),
          borderColor:ACCENT, backgroundColor:'rgba(31,224,122,0.08)',
          fill:true, tension:0.35, pointRadius:3, pointBackgroundColor:ACCENT, borderWidth:2,
        }]},
        options:op,
      });
    }
  }, 50);
},

// ─── PESO ────────────────────────────────────────────────────────
renderPeso(){
  const pesos=DB.pesos();
  const root=$('peso-content');
  // setup form (sheet trigger + minimal info) — main UI is data viz
  if(!pesos.length){
    root.innerHTML = `
      <div class="peso-cur">
        <div class="eyebrow">Peso</div>
        <div class="h1" style="font-size:24px;margin-top:6px">Sem dados ainda</div>
        <div class="meta" style="margin-top:4px">Registre sua primeira pesagem.</div>
      </div>
      <button class="btn bp lg" onclick="App.showWeighIn()" style="margin-top:14px">${IC.plus(16)} Registrar pesagem</button>
      <div class="empty" style="margin-top:24px">
        <div class="empty-ico">${IC.scale(28)}</div>
        <div class="et">Histórico vazio</div>
        <div class="es">Suas pesagens aparecem aqui<br>com gráfico e tendência.</div>
      </div>`;
    return;
  }

  const cur = pesos[pesos.length-1];
  const first = pesos[0];
  const delta = (cur.w - first.w).toFixed(1);
  const deltaCls = +delta > 0 ? 'up' : '';
  const deltaIco = +delta > 0 ? IC.arrowUp(11) : IC.arrowDown(11);

  // last 7d avg
  const last7 = pesos.slice(-7);
  const avg7 = last7.reduce((a,p)=>a+p.w,0) / last7.length;
  const minW = Math.min(...pesos.map(p=>p.w));
  const variation = ((cur.w - first.w) / first.w * 100).toFixed(1);

  // goal: simple inference — round down to nearest .5
  const goal = +localStorage.getItem('evolv_peso_goal') || Math.floor(Math.min(cur.w, first.w) * 2 - 4) / 2;
  const progress = Math.min(1, Math.max(0, (first.w - cur.w) / Math.max(0.1, first.w - goal)));

  root.innerHTML = `
    <div class="peso-cur">
      <div class="eyebrow">Peso atual</div>
      <div class="pcr" style="margin-top:4px">
        <div class="pcv">${cur.w.toFixed(1)}<small>kg</small></div>
        ${delta!=='0.0' ? `<div class="pdelta ${deltaCls}">${deltaIco}${Math.abs(delta)}kg</div>` : ''}
      </div>
      <div class="meta" style="margin-top:6px">
        em ${pesos.length} pesagens · meta ${goal.toFixed(1)}kg ${cur.w>goal?`(faltam ${(cur.w-goal).toFixed(1)}kg)`:'atingida!'}
      </div>

      <div class="peso-goal-bar">
        <div class="peso-goal-fill" style="width:${progress*100}%"></div>
        <div class="peso-goal-mark" style="right:0"></div>
      </div>
      <div class="peso-goal-row">
        <span class="mono">${first.w.toFixed(1)} início</span>
        <span class="mono" style="color:var(--green)">${goal.toFixed(1)} meta</span>
      </div>
    </div>

    <div class="card" style="margin-top:16px">
      <div class="between">
        <div class="eyebrow">Evolução · ${pesos.length} registros</div>
      </div>
      <div class="cwrap"><canvas id="peso-chart"></canvas></div>
    </div>

    <div class="peso-mini">
      <div class="sc"><div class="sl">Média 7d</div><div class="sv">${avg7.toFixed(1)}<small>kg</small></div></div>
      <div class="sc"><div class="sl">Mínimo</div><div class="sv">${minW.toFixed(1)}<small>kg</small></div></div>
      <div class="sc"><div class="sl" style="color:var(--cool)">Variação</div><div class="sv" style="color:var(--cool)">${+variation>0?'+':''}${variation}<small>%</small></div></div>
    </div>

    <button class="btn bp lg" onclick="App.showWeighIn()" style="margin-top:16px">${IC.plus(16)} Registrar pesagem</button>

    <div class="eyebrow" style="margin-top:22px;margin-bottom:10px">Histórico</div>
    <div class="card">
      <div id="peso-hist"></div>
    </div>
  `;

  // history rows
  const hist = $('peso-hist');
  hist.innerHTML = pesos.slice(-30).reverse().map((p,i,arr)=>{
    const prev = arr[i+1];
    const diff = prev ? (p.w-prev.w).toFixed(1) : null;
    const cls = diff===null?'eq':+diff>0?'up':+diff<0?'dn':'eq';
    const d = new Date(p.date+(p.date.length===10?'T12:00':''));
    const dayLabel = i===0 ? 'Hoje' : i===1 ? 'Antes' : fd(p.date);
    return `<div class="prow">
      <div class="pday">
        <div class="pday-d">${dayLabel}</div>
        <div class="pday-t mono">${d.toLocaleDateString('pt-BR',{day:'2-digit',month:'2-digit'})}</div>
      </div>
      <div class="pdata">
        <div>
          <span class="pval">${p.w.toFixed(1)}<small>kg</small></span>
          ${diff!==null ? `<span class="pdif ${cls}">${diff>0?'+':''}${diff}</span>` : ''}
        </div>
        ${p.obs ? `<div class="pobs">${p.obs}</div>` : ''}
      </div>
      ${p.period ? `<div class="pper">${p.period}</div>` : ''}
      <div class="del" onclick="App.delPeso('${p.id}')" title="Excluir">${IC.trash(13)}</div>
    </div>`;
  }).join('');

  // chart
  setTimeout(()=>{
    if(S.charts.peso){try{S.charts.peso.destroy()}catch{}delete S.charts.peso;}
    const cw=$('peso-chart');
    if(cw && pesos.length>=2){
      const lp=pesos.slice(-24);
      const op={...CDO, scales:{...CDO.scales, y:{...CDO.scales.y, beginAtZero:false}}};
      S.charts.peso = new Chart(cw,{
        type:'line',
        data:{labels:lp.map(p=>fd(p.date)),datasets:[{
          data:lp.map(p=>p.w),
          borderColor:COOL, backgroundColor:'rgba(107,168,255,0.1)',
          fill:true, tension:0.35, pointRadius:3, pointBackgroundColor:COOL, borderWidth:2,
        }]},
        options:op,
      });
    } else if(cw){
      cw.parentElement.innerHTML='<div style="height:120px;display:flex;align-items:center;justify-content:center;color:var(--t2);font-size:13px">Registre ao menos 2 pesagens para ver o gráfico</div>';
    }
  }, 50);
},

// ─── WEIGH-IN MODAL ──────────────────────────────────────────────
showWeighIn(){
  App.closeModal();
  const m=document.createElement('div'); m.className='mo';
  m.innerHTML = `<div class="md">
    <div class="mhandle"></div>
    <div class="mtitle">Registrar pesagem</div>
    <div class="ig"><label>Peso (kg)</label>
      <input type="number" id="p-weight" placeholder="ex: 82.5" step="0.1" min="30" max="300" inputmode="decimal">
    </div>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">
      <div class="ig"><label>Data</label><input type="date" id="p-date"></div>
      <div class="ig"><label>Período</label>
        <select id="p-period">
          <option value="">Geral</option>
          <option value="Manhã">Manhã</option>
          <option value="Noite">Noite</option>
          <option value="Jejum">Jejum</option>
          <option value="Pós-treino">Pós-treino</option>
        </select>
      </div>
    </div>
    <div class="ig"><label>Obs (opcional)</label>
      <input type="text" id="p-obs" placeholder="Anotação livre...">
    </div>
    <button class="btn bp lg" onclick="App.savePeso()">${IC.check(16)} Salvar pesagem</button>
    <button class="btn bg" onclick="App.closeModal()" style="margin-top:8px">Cancelar</button>
  </div>`;
  m.addEventListener('click',e=>{if(e.target===m)App.closeModal();});
  $('mroot').appendChild(m);
  setTimeout(()=>{
    if($('p-date')) $('p-date').value = today();
    $('p-weight')?.focus();
  }, 200);
},

async savePeso(){
  const w = parseFloat($('p-weight')?.value);
  const date = $('p-date')?.value || today();
  const obs = $('p-obs')?.value?.trim() || '';
  const period = $('p-period')?.value || '';
  if(!w || w<30 || w>300){ App.toast('Informe um peso válido'); return; }
  try{
    await DB.addPeso({id:uid(), w, date, obs, period});
    App.closeModal();
    App.toast(`${w}kg registrado!`);
    App.renderPeso();
  } catch(e){ App.toast('Erro ao salvar.'); }
},

async delPeso(id){
  if(!confirm('Excluir esta pesagem?')) return;
  await DB.delPeso(id); App.renderPeso();
},

// ─── FICHA CRUD ──────────────────────────────────────────────────
showAddFicha(ficha=null){
  App.closeModal();
  const m=document.createElement('div'); m.className='mo';
  m.innerHTML = `<div class="md">
    <div class="mhandle"></div>
    <div class="mtitle">${ficha?'Editar ficha':'Nova ficha'}</div>
    <div class="ig"><label>Nome da ficha</label>
      <input type="text" id="f-name" placeholder="ex: Hipertrofia ABC" value="${ficha?.name||''}">
    </div>
    <div id="f-days"></div>
    <button class="btn bg" onclick="App.addDay()" style="margin-bottom:10px">${IC.plus(14)} Adicionar dia</button>
    <button class="btn bp lg" onclick="App.saveFicha('${ficha?.id||''}')">Salvar</button>
    <button class="btn bg" onclick="App.closeModal()" style="margin-top:8px">Cancelar</button>
  </div>`;
  m.addEventListener('click',e=>{if(e.target===m)App.closeModal();});
  $('mroot').appendChild(m);
  setTimeout(()=>$('f-name')?.focus(), 250);

  if(ficha) setTimeout(()=>{
    (ficha.days||[]).forEach(day=>{
      App.addDay();
      const blocks = document.querySelectorAll('#f-days .db');
      const b = blocks[blocks.length-1];
      b.querySelector('.db-name').value = day.name||'';
      (day.exs||[]).forEach(ex=>{
        App.addExRow(b.querySelector('.ex-list'));
        const rows = b.querySelectorAll('.ex-row');
        const r = rows[rows.length-1];
        r.querySelector('.en').value = ex.name||'';
        r.querySelector('.es').value = ex.sets||3;
        r.querySelector('.er').value = ex.reps||12;
      });
    });
  }, 100);
},

addDay(){
  const cont = $('f-days');
  const n = cont.querySelectorAll('.db').length + 1;
  const db = document.createElement('div');
  db.className='db';
  db.innerHTML = `
    <div class="db-hdr">
      <span class="db-lbl">DIA ${n}</span>
      <input type="text" class="db-name" placeholder="Nome (ex: Peito/Tríceps)">
      <button class="x-mini" onclick="this.closest('.db').remove()">${IC.close(14)}</button>
    </div>
    <div class="ex-list"></div>
    <button class="btn bg sm" onclick="App.addExRow(this.previousElementSibling)" style="width:auto;padding:0 12px;margin-top:4px">${IC.plus(12)} Exercício</button>
  `;
  cont.appendChild(db);
},

addExRow(list){
  const r=document.createElement('div');
  r.className='ex-row';
  r.innerHTML = `
    <input type="text" class="en" placeholder="Exercício">
    <input type="number" class="es" placeholder="Sér" value="3" min="1">
    <input type="number" class="er" placeholder="Rep" value="12" min="1">
    <button class="x-mini" onclick="this.parentElement.remove()">${IC.close(14)}</button>
  `;
  list.appendChild(r);
},

async saveFicha(editId){
  const name = $('f-name')?.value?.trim();
  if(!name){ App.toast('Digite o nome da ficha'); return; }
  const days = [...document.querySelectorAll('#f-days .db')].map((b,i)=>({
    name: b.querySelector('.db-name')?.value?.trim() || `Dia ${i+1}`,
    exs: [...b.querySelectorAll('.ex-row')].map(r=>({
      name: r.querySelector('.en')?.value?.trim()||'',
      sets: +r.querySelector('.es')?.value || 3,
      reps: +r.querySelector('.er')?.value || 12,
      w: 0,
    })).filter(e=>e.name)
  }));
  try{
    if(editId) await DB.updFicha(editId, {name, days, updAt:Date.now()});
    else        await DB.addFicha({id:uid(), name, days, at:Date.now()});
    App.closeModal(); App.renderFichas();
    App.notify(editId ? 'Ficha atualizada!' : 'Ficha criada!');
  } catch(e){ App.toast('Erro ao salvar.'); }
},

editFicha(id){
  const f = DB.fichas().find(x=>x.id===id);
  if(f) App.showAddFicha(f);
},

async delFicha(id){
  if(!confirm('Excluir esta ficha?')) return;
  try{ await DB.delFicha(id); App.toast('Ficha excluída'); }
  catch(e){ App.toast('Erro ao excluir.'); }
},

// ─── IMPORT ──────────────────────────────────────────────────────
showImportFicha(){
  App.closeModal();
  const m=document.createElement('div'); m.className='mo';
  m.innerHTML = `<div class="md">
    <div class="mhandle"></div>
    <div class="mtitle">Importar fichas JSON</div>
    <div class="ig"><label>Cole o JSON abaixo</label>
      <textarea id="import-json" placeholder='[{"name":"Ficha A","days":[{"name":"Dia 1","exs":[{"name":"Agachamento","sets":4,"reps":10}]}]}]' style="min-height:140px"></textarea>
    </div>
    <button class="btn bp" onclick="App.importFichasFromJson(document.getElementById('import-json').value)">Importar</button>
    <button class="btn bg" onclick="App.importFileSelector()" style="margin-top:8px">${IC.download(14)} Selecionar arquivo</button>
    <button class="btn bg" onclick="App.closeModal()" style="margin-top:8px">Cancelar</button>
  </div>`;
  m.addEventListener('click',e=>{if(e.target===m)App.closeModal();});
  $('mroot').appendChild(m);
},

handleImportFile(e){
  const file = e.target.files?.[0];
  if(!file) return;
  const reader = new FileReader();
  reader.onload = () => App.importFichasFromJson(reader.result);
  reader.onerror = () => App.toast('Não foi possível ler o arquivo.');
  reader.readAsText(file, 'UTF-8');
  e.target.value = '';
},

importFileSelector(){ $('import-file-input')?.click(); },

async importFichasFromJson(raw){
  App.closeModal();
  if(!raw || !raw.trim()){ App.toast('Cole um JSON válido.'); return; }
  try{
    const data = JSON.parse(raw);
    const itens = Array.isArray(data) ? data : (data.fichas ? data.fichas : [data]);
    const valid = itens.filter(f=>f && f.name && Array.isArray(f.days));
    if(!valid.length){ App.toast('Nenhum objeto de ficha válido.'); return; }
    let imported = 0;
    for(const ficha of valid){
      const item = {
        ...ficha,
        days: ficha.days.map(d=>({
          name: d.name||'Dia',
          exs: (Array.isArray(d.exs)?d.exs:[]).map(e=>({
            name: e.name||'', sets: +e.sets||3, reps: +e.reps||12, w: +e.w||0
          }))
        })),
        id: ficha.id || uid(),
        at: Date.now()
      };
      if(DB.fichas().some(x=>x.id===item.id)) item.id = uid();
      await DB.addFicha(item);
      imported++;
    }
    App.renderFichas();
    App.notify(`${imported} ${imported===1?'ficha importada':'fichas importadas'}.`);
  } catch(e){ App.toast('JSON inválido. Verifique e tente novamente.'); }
},

// ─── ACTIVE WORKOUT ──────────────────────────────────────────────
startTodayWorkout(){
  if(!DB.fichas().length){
    App.toast('Crie uma ficha de treino primeiro!');
    App.nav('fichas');
    return;
  }
  App.showPickModal();
},

showPickModal(){
  App.closeModal();
  const fichas=DB.fichas();
  const m=document.createElement('div'); m.className='mo';
  m.innerHTML = `<div class="md">
    <div class="mhandle"></div>
    <div class="mtitle">Selecionar treino</div>
    ${fichas.map((f,fi)=>{
      const color = S.fichaColors[fi % S.fichaColors.length];
      const tag = String.fromCharCode(65+fi);
      return `<div style="margin-bottom:16px">
        <div class="eyebrow" style="margin-bottom:8px">
          <span style="color:${color}">${tag}</span> · ${f.name}
        </div>
        ${(f.days||[]).map((d,di)=>`
          <div class="wi" onclick="App.startWorkout('${f.id}',${di});App.closeModal()">
            <div class="wi-ico" style="background:color-mix(in oklab, ${color} 14%, transparent);color:${color};border-color:color-mix(in oklab, ${color} 32%, transparent)">${di+1}</div>
            <div class="wi-info">
              <div class="wi-name">${d.name}</div>
              <div class="wi-sub">${(d.exs||[]).length} exercícios</div>
            </div>
            <div style="color:var(--green);display:flex">${IC.play(14)}</div>
          </div>
        `).join('')}
      </div>`;
    }).join('')}
    <button class="btn bg" onclick="App.closeModal()">Cancelar</button>
  </div>`;
  m.addEventListener('click',e=>{if(e.target===m)App.closeModal();});
  $('mroot').appendChild(m);
},

startWorkout(fichaId, dayIdx){
  const f = DB.fichas().find(x=>x.id===fichaId);
  const d = f?.days?.[dayIdx];
  if(!d) return;
  App.closeModal();
  S.workout = {
    on:true, fichaId, dayIdx, t0:Date.now(), iv:null,
    exs: (d.exs||[]).map(e=>({
      name: e.name, ts: e.sets||3, tr: e.reps||12,
      sets: Array.from({length:e.sets||3}, ()=>({reps: e.reps||12, w: 0, done: false}))
    }))
  };
  $('aw').classList.add('open');
  $('aw-title').textContent = d.name;
  S.workout.iv = setInterval(()=>{
    const el=$('aw-timer'); if(el) el.textContent = ft(Math.floor((Date.now()-S.workout.t0)/1000));
  }, 1000);
  App.renderAW();
},

renderAW(){
  const {exs} = S.workout;
  const done = exs.reduce((a,e)=>a+e.sets.filter(s=>s.done).length, 0);
  const total = exs.reduce((a,e)=>a+e.sets.length, 0);
  $('aw-sub').textContent = `${exs.length} exercícios · ${done}/${total} séries`;
  $('aw-pbar').style.width = total ? `${(done/total)*100}%` : '0%';
  $('aw-body').innerHTML = exs.map((ex,ei)=>{
    const allDone = ex.sets.every(s=>s.done);
    return `<div class="ex-card ${allDone?'glow':''}">
      <div class="ex-hdr">
        <div class="ex-name">${ex.name}</div>
        <span class="ex-tag">${ex.sets.filter(s=>s.done).length}/${ex.sets.length}</span>
      </div>
      <div class="sets-hdr"><span></span><span>Carga (kg)</span><span>Reps</span><span></span></div>
      ${ex.sets.map((s,si)=>`
        <div class="set-row">
          <div class="sn">${si+1}</div>
          <input type="number" value="${s.w||''}" placeholder="0" min="0" step="0.5"
            onchange="App.updSet(${ei},${si},'w',this.value)" inputmode="decimal"
            style="${s.done?'opacity:0.45':''}">
          <input type="number" value="${s.reps||''}" placeholder="${ex.tr}" min="1"
            onchange="App.updSet(${ei},${si},'reps',this.value)" inputmode="numeric"
            style="${s.done?'opacity:0.45':''}">
          <div class="set-chk ${s.done?'done':''}" onclick="App.togSet(${ei},${si})">${s.done?IC.check(16):''}</div>
        </div>`).join('')}
      <button class="btn bg sm" onclick="App.addSet(${ei})" style="width:auto;padding:0 12px;margin-top:6px">${IC.plus(12)} Série</button>
    </div>`;
  }).join('');
},

updSet(ei,si,f,v){ S.workout.exs[ei].sets[si][f] = +v; },

togSet(ei,si){
  const s = S.workout.exs[ei].sets[si];
  s.done = !s.done;
  App.renderAW();
  if(s.done){
    App.addSeries(1);
    App.resetTimer(); App.startTimer();
    App.toast('Timer iniciado!');
  }
},

addSet(ei){
  const e = S.workout.exs[ei];
  e.sets.push({reps: e.tr, w: 0, done: false});
  App.renderAW();
},

cancelWorkout(){ if(!confirm('Descartar treino?')) return; App._endWO(false); },
finishWorkout(){ App._endWO(true); },

async _endWO(save){
  clearInterval(S.workout.iv);
  if(save){
    try{
      await DB.addSessao({
        id:uid(),
        fichaId:S.workout.fichaId,
        dayIdx:S.workout.dayIdx,
        date:new Date().toISOString(),
        dur:Math.floor((Date.now()-S.workout.t0)/1000),
        exs:S.workout.exs.map(e=>({name:e.name, sets:e.sets}))
      });
      App.notify('Treino concluído!');
      App.resetSeries();
    } catch(e){ App.toast('Erro ao salvar treino.'); }
  }
  $('aw').classList.remove('open');
  S.workout = {on:false};
  if(S.page==='home') App.renderHome();
},

// ─── NOTIFICATIONS ──────────────────────────────────────────────
loadNotifications(){
  try{ const raw=localStorage.getItem('evolv_notifications'); if(raw) S.notifications=JSON.parse(raw); }catch{S.notifications=[];}
  App.renderNotifyBadge();
},

renderNotifyBadge(){
  const badge=$('notify-badge'); if(!badge) return;
  const unread = S.notifications.filter(n=>!n.read).length;
  badge.textContent = unread ? String(unread) : '';
  badge.classList.toggle('has', unread>0);
},

showNotifications(){
  App.closeModal();
  const m=document.createElement('div'); m.className='mo';
  m.innerHTML = `<div class="md">
    <div class="mhandle"></div>
    <div class="np-head">
      <div class="np-title">Notificações</div>
      ${S.notifications.length?'<button class="btn bg sm" onclick="App.markAllNotificationsRead()" style="width:auto;padding:0 14px">Marcar todas</button>':''}
    </div>
    ${S.notifications.length
      ? S.notifications.map(n=>`<div class="np-item ${n.read?'read':''}">
          <div class="np-dot"></div>
          <div>
            <div class="np-message">${n.msg}</div>
            <div class="np-date">${new Date(n.date).toLocaleString('pt-BR',{day:'2-digit',month:'short',hour:'2-digit',minute:'2-digit'})}</div>
          </div>
        </div>`).join('')
      : `<div class="np-empty">Nenhuma notificação ainda.</div>`}
    <button class="btn bg" onclick="App.closeModal()" style="margin-top:12px">Fechar</button>
  </div>`;
  m.addEventListener('click', e=>{ if(e.target===m) App.closeModal(); });
  $('mroot').appendChild(m);
  S.notifications.forEach(n=>n.read=true);
  localStorage.setItem('evolv_notifications', JSON.stringify(S.notifications));
  App.renderNotifyBadge();
},

markAllNotificationsRead(){
  S.notifications.forEach(n=>n.read=true);
  localStorage.setItem('evolv_notifications', JSON.stringify(S.notifications));
  App.renderNotifyBadge();
  App.closeModal(); App.showNotifications();
},

notify(msg, type='info'){
  const item={id:uid(), msg, type, date:new Date().toISOString(), read:false};
  S.notifications.unshift(item);
  if(S.notifications.length>30) S.notifications.length=30;
  localStorage.setItem('evolv_notifications', JSON.stringify(S.notifications));
  App.renderNotifyBadge();
  App.toast(msg);
},

// ─── FIREBASE SETUP ─────────────────────────────────────────────
showFBSetup(needsCfg=true){
  $('loading').style.display='none';
  $('fbsetup').classList.add('open');
},

saveFBConfig(){
  const raw = $('fb-cfg-input')?.value?.trim();
  try{
    const match = raw.match(/\{[\s\S]*\}/);
    if(!match) throw new Error();
    const cfg = JSON.parse(match[0]);
    if(!cfg.apiKey) throw new Error('missing apiKey');
    localStorage.setItem('evolv_fbcfg', JSON.stringify(cfg));
    localStorage.removeItem('evolv_offline');
    location.reload();
  } catch(e){ App.toast('Config inválida. Verifique o JSON.'); }
},

skipFBSetup(){
  localStorage.setItem('evolv_offline','1');
  $('fbsetup').classList.remove('open');
  DB._fallback();
  App.boot();
},

// ─── BOOT ───────────────────────────────────────────────────────
boot(){
  $('loading').style.display='none';
  $('app').style.display='flex';
  App.loadNotifications();
  App.renderTimerTicks();
  App.updTimer();
  App.renderHome();
  App.updateDot();
  // init sfx and global click sound
  try{ App.sound.init(); }catch{}
  document.addEventListener('click', e=>{
    try{
      if(!App.sound.enabled) return;
      const btn = e.target.closest('button, .ni, .icon-btn');
      if(btn) App.sound.play('click');
    }catch{}
  }, {capture:false});
  window.addEventListener('beforeinstallprompt', e=>{ e.preventDefault(); App._ip=e; });
},

updateDot(){
  const dot=$('status-dot'); if(!dot) return;
  const on = DB._local ? false : (DB._online!==false);
  dot.classList.toggle('off', !on);
  dot.title = on ? 'Sincronizado' : DB._local ? 'Modo offline' : 'Sem conexão';
},

// ─── UTILS ──────────────────────────────────────────────────────
closeModal(){ document.querySelectorAll('.mo').forEach(m=>m.remove()); },

toast(msg){
  document.querySelectorAll('.toast').forEach(t=>t.remove());
  const t=document.createElement('div'); t.className='toast'; t.textContent=msg;
  document.body.appendChild(t);
  setTimeout(()=>t.remove(), 2800);
},

};

// ─── PWA ─────────────────────────────────────────────────────────
if('serviceWorker' in navigator){
  const sw = `const C='evolv-v3';self.addEventListener('install',e=>{self.skipWaiting();});self.addEventListener('activate',e=>{e.waitUntil(clients.claim());});self.addEventListener('fetch',e=>{if(!e.request.url.startsWith('http'))return;e.respondWith(caches.open(C).then(c=>c.match(e.request).then(r=>r||fetch(e.request).then(res=>{c.put(e.request,res.clone());return res;}).catch(()=>new Response('',{status:503})))));});`;
  navigator.serviceWorker.register(URL.createObjectURL(new Blob([sw],{type:'application/javascript'}))).catch(()=>{});
}
(()=>{
  const mf = {name:'EVOLV', short_name:'EVOLV', theme_color:'#0E1015', background_color:'#0E1015', display:'standalone', orientation:'portrait', start_url:'.', icons:[{src:'icon.png', sizes:'512x512', type:'image/png', purpose:'any maskable'}]};
  const l = document.createElement('link'); l.rel='manifest';
  l.href = URL.createObjectURL(new Blob([JSON.stringify(mf)],{type:'application/json'}));
  document.head.appendChild(l);
})();

// ─── INIT ───────────────────────────────────────────────────────
window.App = App; window.DB = DB; window.S = S;

DB.init().then(()=>{
  DB.whenReady.then(()=>App.boot());
  setTimeout(()=>{ if(!DB.ready){ DB.ready=true; DB._resolveReady(); } }, 6000);
});
