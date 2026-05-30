// ═══════════════════════════════════════════════════════════════
// EVOLV — app logic
// Correções v2:
//  [SEC-1] Escape de HTML em todos os templates com dados do usuário (XSS)
//  [SEC-2] Sanitização de fichas importadas via JSON
//  [TIMER] Timer resiliente a background via timestamp (iOS/PWA safe)
//  [PERF]  renderAW() com atualização cirúrgica de checkboxes/progresso
//
// Melhorias v3:
//  [CACHE-WO] Cache de treino em andamento — persiste estado completo no
//             localStorage a cada interação; restaura automaticamente ao
//             reabrir o app, com banner de recuperação e opção de descartar.
//  [UPDATE]   Sistema de atualização via Service Worker — detecta novo SW
//             disponível e exibe banner não-intrusivo com opções
//             "Atualizar agora" e "Depois". Atualizar agora faz skipWaiting
//             + reload; "Depois" descarta o banner até o próximo ciclo.
// ═══════════════════════════════════════════════════════════════

const FIREBASE_CONFIG = {
  apiKey: "AIzaSyCvwm5Abo4sL0WTGcUdIBPUj4qUSDtO4J8",
  authDomain: "evolv-82ec2.firebaseapp.com",
  databaseURL: "https://evolv-82ec2-default-rtdb.firebaseio.com",
  projectId: "evolv-82ec2",
  storageBucket: "evolv-82ec2.firebasestorage.app",
  messagingSenderId: "934840298557",
  appId: "1:934840298557:web:8f79f024e8e2d8ce6a0e54",
  measurementId: "G-E27HHXWXPX"
};

// ─── [SEC-1] HELPER DE ESCAPE HTML ───────────────────────────────
// Usado em TODOS os lugares onde dados do usuário são inseridos no DOM.
// Previne XSS via nomes de exercícios, fichas, observações, etc.
const esc = s => {
  if (s == null) return '';
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
};

// ─── [CACHE-WO] WORKOUT CACHE ────────────────────────────────────
// Persiste o estado completo do treino em andamento no localStorage.
// Chamado a cada interação (togSet, updSet, addSet, startWorkout).
// Na inicialização, verifica se há cache válido e oferece restauração.
//
// Estrutura salva:
// {
//   fichaId, dayIdx, t0,          ← identificação e horário de início
//   exs: [...],                   ← estado completo dos exercícios/sets
//   savedAt: <timestamp>          ← para exibir "há X minutos"
// }
const WorkoutCache = {
  KEY: 'evolv_workout_cache',
  // Máximo de horas que um cache é considerado válido
  MAX_AGE_H: 12,

  save(){
    if(!S.workout.on) return;
    try{
      const snapshot = {
        fichaId:  S.workout.fichaId,
        dayIdx:   S.workout.dayIdx,
        t0:       S.workout.t0,
        exs:      JSON.parse(JSON.stringify(S.workout.exs)), // deep clone
        savedAt:  Date.now(),
      };
      localStorage.setItem(WorkoutCache.KEY, JSON.stringify(snapshot));
    }catch(e){ console.warn('[WorkoutCache] Falha ao salvar:', e); }
  },

  load(){
    try{
      const raw = localStorage.getItem(WorkoutCache.KEY);
      if(!raw) return null;
      const data = JSON.parse(raw);
      // Valida estrutura mínima
      if(!data.fichaId || !Array.isArray(data.exs) || !data.t0) return null;
      // Descarta cache muito antigo
      const ageH = (Date.now() - data.savedAt) / 3600000;
      if(ageH > WorkoutCache.MAX_AGE_H){ WorkoutCache.clear(); return null; }
      return data;
    }catch(e){ return null; }
  },

  clear(){
    localStorage.removeItem(WorkoutCache.KEY);
  },

  // Formata tempo decorrido desde o cache para exibir no banner
  ageLabel(savedAt){
    const min = Math.round((Date.now() - savedAt) / 60000);
    if(min < 1)  return 'agora mesmo';
    if(min < 60) return `há ${min} min`;
    const h = Math.floor(min / 60);
    return `há ${h}h${min%60 > 0 ? ` ${min%60}min` : ''}`;
  },
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
  upload:(s=14)=>IC._s('<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/>',s),
  export:(s=14)=>IC._s('<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/>',s),
  info:(s=14)=>IC._s('<circle cx="12" cy="12" r="10"/><path d="M12 8v4M12 16h.01"/>',s),
  bell:(s=18)=>IC._s('<path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0"/>',s),
  target:(s=18)=>IC._s('<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="5"/><circle cx="12" cy="12" r="1.4"/>',s),
  stopwatch:(s=16)=>IC._s('<circle cx="12" cy="13" r="8"/><path d="M12 9v4l2.5 2.5"/><path d="M9.5 2.5h5M12 2.5v2"/>',s),
  sync:(s=16)=>IC._s('<path d="M21 2v6h-6"/><path d="M3 12a9 9 0 0 1 15-6.7L21 8"/><path d="M3 22v-6h6"/><path d="M21 12a9 9 0 0 1-15 6.7L3 16"/>',s),
  dumbbell:(s=16)=>IC._s('<path d="M6.5 6.5h11M6.5 17.5h11M5 5v14M8 4v2M8 18v2M16 4v2M16 18v2"/>',s),
  weight:(s=16)=>IC._s('<path d="M2 20h20M7 20V10a5 5 0 0 1 10 0v10M12 7v3"/>',s),
};

// ─── NOTIFICATION CONFIG ─────────────────────────────────────────
const NOTIF_CONFIG = {
  timer:   { ic:(s=16)=>IC.stopwatch(s),  color:'var(--cool)',   bg:'var(--cool-dim)' },
  workout: { ic:(s=16)=>IC.trophy(s),     color:'var(--green)',  bg:'var(--green-dim)' },
  weight:  { ic:(s=16)=>IC.scale(s),      color:'var(--violet)', bg:'var(--violet-dim)' },
  ficha:   { ic:(s=16)=>IC.clipboard(s),  color:'var(--amber)',  bg:'rgba(245,192,74,.14)' },
  success: { ic:(s=16)=>IC.check(s),      color:'var(--green)',  bg:'var(--green-dim)' },
  info:    { ic:(s=16)=>IC.info(s),       color:'var(--t2)',     bg:'var(--bg-4)' },
  error:   { ic:(s=16)=>IC._s('<circle cx="12" cy="12" r="10"/><path d="M15 9l-6 6M9 9l6 6"/>',s), color:'var(--red)', bg:'var(--red-dim)' },
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

    if(!cfg.apiKey){
      App.showFBSetup(true);
      return;
    }

    if(localStorage.getItem('evolv_offline')==='1'){
      console.info('[EVOLV] Modo offline ativo.');
      DB._fallback();
      return;
    }

    if(!cfg.databaseURL){
      const guessed = `https://${cfg.projectId}-default-rtdb.firebaseio.com`;
      console.warn(`[EVOLV] databaseURL ausente. Tentando: ${guessed}`);
      cfg = { ...cfg, databaseURL: guessed };
    }

    try{
      firebase.initializeApp(cfg);
      DB._db = firebase.database();
      await DB._db.ref('.info/connected').once('value');
      const cred = await firebase.auth().signInAnonymously();
      let syncId = localStorage.getItem('evolv_sync_id');
      if(!syncId){ syncId = cred.user.uid; localStorage.setItem('evolv_sync_id', syncId); }
      DB._uid = syncId;
      console.info('[EVOLV] Firebase conectado. SyncID:', DB._uid);

      DB._listen('fichas'); DB._listen('sessoes'); DB._listen('pesos');

      window.addEventListener('online',  ()=>{ DB._online=true;  App.updateDot(); });
      window.addEventListener('offline', ()=>{ DB._online=false; App.updateDot(); });
      DB._online = navigator.onLine;

    } catch(e){
      console.error('[EVOLV] Firebase falhou:', e.code || e.message);
      DB._fallback();
      const msg = e.code === 'auth/network-request-failed'
        ? 'Sem conexão com internet'
        : e.message?.includes('databaseURL') || e.code === 'app/invalid-credential'
          ? 'Config Firebase inválida — verifique databaseURL'
          : 'Firebase indisponível';
      setTimeout(()=>App && App.toast && App.toast(`⚠️ ${msg} — dados salvos localmente`), 1200);
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
      if(DB._loadCount >= 3 && !DB.ready){ DB.ready=true; DB._resolveReady(); }
      else if(DB.ready){ App.renderPage(S.page); }
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
  workout:{on:false,minimized:false,fichaId:null,dayIdx:null,t0:null,iv:null,exs:[]},
  charts:{},
  notifications:[],
  fichaColors: ['var(--heat)','var(--cool)','var(--violet)','var(--green)','var(--amber)','var(--red)'],
};

// ─── UTILS ───────────────────────────────────────────────────────
const $=id=>document.getElementById(id);
const uid=()=>Date.now().toString(36)+Math.random().toString(36).slice(2,6);
const ft=s=>`${String(Math.floor(s/60)).padStart(2,'0')}:${String(s%60).padStart(2,'0')}`;
const fd=d=>{
  if(!d) return '—';
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

const ACCENT='#1FE07A', ACCENT_2='#15B863', COOL='#6BA8FF', HEAT='#FF8A3B';

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

// ─── SFX ────────────────────────────────────────────────────────
sound:{
  enabled: localStorage.getItem('evolv_sfx')!=='0',
  _ctx:null,_gain:null,
  init(){
    try{
      const C = window.AudioContext || window.webkitAudioContext;
      this._ctx = new C(); this._gain = this._ctx.createGain();
      this._gain.connect(this._ctx.destination); this._gain.gain.value = 0.12;
    }catch(e){ this._ctx = null; }
  },
  play(type='click'){
    if(!this.enabled) return;
    if(!this._ctx) try{ this.init(); }catch{}
    if(!this._ctx) return;
    const now = this._ctx.currentTime;
    const o = this._ctx.createOscillator(); o.type='sine';
    o.frequency.setValueAtTime(type==='click'?1100:800, now);
    const gg = this._ctx.createGain();
    gg.gain.setValueAtTime(0.0001,now);
    gg.gain.exponentialRampToValueAtTime(1,now+0.006);
    gg.gain.exponentialRampToValueAtTime(0.0001,now+0.06);
    o.connect(gg); gg.connect(this._gain);
    o.start(now); o.stop(now+0.07);
  },
  toggle(v){ this.enabled=typeof v==='boolean'?v:!this.enabled; localStorage.setItem('evolv_sfx',this.enabled?'1':'0'); }
},

// ─── HOME ────────────────────────────────────────────────────────
renderHome(){
  const h=new Date().getHours();
  const [ico,txt] = h<12?[IC.sun(14),'Bom dia']:h<18?[IC.zap(14),'Boa tarde']:[IC.moon(14),'Boa noite'];
  const sess=DB.sessoes(), pesos=DB.pesos(), fichas=DB.fichas(), now=new Date();

  const wk = sess.filter(s=>(now-new Date(s.date))/864e5<=7);

  // Carga média por série (últimos 7 dias) — mais legível que volume total
  const wkSeries = wk.reduce((a,s)=>a+(s.exs||[]).reduce((b,e)=>b+(e.sets||[]).filter(x=>x.done).length,0),0);
  const wkVol    = wk.reduce((a,s)=>a+(s.exs||[]).reduce((b,e)=>b+(e.sets||[]).filter(x=>x.done).reduce((c,x)=>c+(+x.reps||0)*(+x.w||0),0),0),0);
  const avgLoad  = wkSeries > 0 ? Math.round(wkVol / wkSeries) : 0;

  // Duração média de treino (todas as sessões com dur > 0)
  const sessWithDur = sess.filter(s=>s.dur>0);
  const avgDur = sessWithDur.length
    ? Math.round(sessWithDur.reduce((a,s)=>a+s.dur,0)/sessWithDur.length/60)
    : 0;

  const sessDays = new Set(sess.map(s=>s.date.slice(0,10)));
  let streak = 0;
  for(let i=0;i<60;i++){
    const d=new Date(now); d.setDate(now.getDate()-i);
    const k=d.toISOString().slice(0,10);
    if(sessDays.has(k)) streak++;
    else if(i>0) break;
  }

  const suggestedFicha = fichas[0];
  const heroTitle = suggestedFicha
    ? `Pronto para <em>${esc((suggestedFicha.days?.[0]?.name || suggestedFicha.name).slice(0,28))}</em>?`
    : `Sua evolução <em>começa aqui.</em>`;
  const heroMeta = suggestedFicha
    ? `<span>${IC.layers(14)} ${suggestedFicha.days?.length||0} dias</span><span>${IC.activity(14)} ${(suggestedFicha.days||[]).reduce((a,d)=>a+(d.exs||[]).length,0)} exercícios</span>`
    : '';

  const recent = sess.slice(-3).reverse();
  const recentHtml = recent.length
    ? recent.map((s,i)=>{
        const f=fichas.find(f=>f.id===s.fichaId);
        const d=f?.days?.[s.dayIdx];
        const sets=(s.exs||[]).reduce((a,e)=>a+(e.sets||[]).filter(x=>x.done).length,0);
        const tag=String.fromCharCode(65+i);
        const color=S.fichaColors[i%S.fichaColors.length];
        const durMin=Math.round((s.dur||0)/60);
        return `<div class="wi">
          <div class="wi-ico" style="background:color-mix(in oklab, ${color} 14%, transparent);color:${color};border-color:color-mix(in oklab, ${color} 32%, transparent)">${tag}</div>
          <div class="wi-info">
            <div class="wi-name">${esc(d?.name||f?.name||'Treino')}</div>
            <div class="wi-sub">${relTime(s.date)} · ${sets} séries</div>
          </div>
          <div class="wi-right">
            <div class="num">${ft(s.dur||0)}</div>
            <div class="meta">${durMin>0?durMin+'min':'—'}</div>
          </div>
        </div>`;
      }).join('')
    : `<div class="empty">
        <div class="empty-ico">${IC.activity(28)}</div>
        <div class="et">Nenhum treino registrado</div>
        <div class="es">Inicie um treino para ver<br>seu histórico aqui.</div>
      </div>`;

  const dayLabels=['D','S','T','Q','Q','S','S'];
  const weekTarget = 5;
  const weekDots = Array.from({length:7}).map((_,i)=>{
    const d=new Date(now); d.setDate(now.getDate()-(6-i));
    const k=d.toISOString().slice(0,10);
    const done = sessDays.has(k); const isToday = i===6; const dow = d.getDay();
    return `<div class="wk-day">
      <div class="wd">${dayLabels[dow]}</div>
      <div class="wdot ${done?'done':''} ${isToday&&!done?'today':''}">${done?IC.check(14):''}</div>
    </div>`;
  }).join('');

  $('pg-home').innerHTML = `
    <div class="hero">
      <div class="hg">${ico}<span>${txt}</span></div>
      <div class="ht">${heroTitle}</div>
      ${heroMeta?`<div class="hmeta">${heroMeta}</div>`:''}
      <button class="btn bp lg" onclick="App.startTodayWorkout()">
        ${IC.play(14)}<span>Iniciar treino</span>
      </button>
    </div>
    <div class="srow">
      <div class="sc">
        <div class="sl">Semana</div>
        <div class="sv">${wk.length}<small>/${weekTarget}</small></div>
        <div class="ss">treinos</div>
      </div>
      <div class="sc">
        <div class="sl" style="color:var(--heat)">Carga média</div>
        <div class="sv">${avgLoad}<small>kg</small></div>
        <div class="ss">${wk.length?'por série':'sem dados'}</div>
      </div>
      <div class="sc">
        <div class="sl" style="color:var(--cool)">Streak</div>
        <div class="sv">${streak}<small>d</small></div>
        <div class="ss">${streak>0?'ativo':'—'}</div>
      </div>
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
      <button class="icon-btn" onclick="App.showImportFicha()" title="Importar JSON">
        ${IC.upload(16)}
      </button>
      <button class="icon-btn" onclick="App.exportFichas()" title="Exportar fichas">
        ${IC.export(16)}
      </button>
      <button class="icon-btn" onclick="App.downloadTemplate()" title="Baixar modelo JSON">
        ${IC.info(16)}
      </button>
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
    const fSess = sess.filter(s=>s.fichaId===f.id);
    const lastDate = fSess.length ? fSess[fSess.length-1].date : null;
    const totalVol = fSess.reduce((a,s)=>a+(s.exs||[]).reduce((b,e)=>b+(e.sets||[]).filter(x=>x.done).reduce((c,x)=>c+(+x.reps||0)*(+x.w||0),0),0),0);
    const avgVol = fSess.length ? totalVol / fSess.length : 0;
    let progress = 0;
    if(fSess.length){
      const ls = fSess[fSess.length-1];
      const done = (ls.exs||[]).reduce((a,e)=>a+(e.sets||[]).filter(x=>x.done).length,0);
      const total = (ls.exs||[]).reduce((a,e)=>a+(e.sets||[]).length,0);
      progress = total ? done/total : 0;
    }

    // [SEC-1] esc() em todos os campos vindos do usuário
    return `<div class="fc">
      <div class="fc-accent" style="background:${color}"></div>
      <div class="fc-watermark" style="color:color-mix(in oklab, ${color} 8%, transparent)">${tag}</div>
      <div class="fc-head">
        <div class="fc-head-info">
          <div class="fc-name">
            <span class="fc-tag" style="background:color-mix(in oklab, ${color} 18%, transparent);color:${color}">${tag}</span>
            ${esc(f.name)}
          </div>
          <div class="fc-meta">${(f.days||[]).length} dias · ${totalEx} exercícios</div>
        </div>
        <button class="icon-btn" style="width:32px;height:32px;border-radius:9px" onclick="App.editFicha('${esc(f.id)}')">${IC.edit(14)}</button>
        <button class="icon-btn danger" style="width:32px;height:32px;border-radius:9px" onclick="App.delFicha('${esc(f.id)}')">${IC.trash(14)}</button>
      </div>
      <div class="fc-stats">
        <div class="fc-stat"><div class="num">${(f.days||[]).length}</div><div class="lbl">dias</div></div>
        <div class="fc-divider"></div>
        <div class="fc-stat"><div class="num">${avgVol>=1000?(avgVol/1000).toFixed(1)+'t':Math.round(avgVol)+'kg'}</div><div class="lbl">volume médio</div></div>
        <div class="fc-divider"></div>
        <div class="fc-stat"><div style="font-size:13px;color:var(--t1);font-weight:500">${lastDate?relTime(lastDate):'—'}</div><div class="lbl">última</div></div>
      </div>
      ${fSess.length ? `
        <div class="fc-prog-row">
          <div class="eyebrow" style="font-size:10px">Última sessão</div>
          <div class="mono" style="font-size:11px;color:${color}">${Math.round(progress*100)}%</div>
        </div>
        <div class="prog-track"><div class="prog-bar" style="width:${progress*100}%;background:${color}"></div></div>
      ` : ''}
      <div style="margin-top:14px">
        ${(f.days||[]).map((d,di)=>`
          <div class="fc-day" onclick="App.startWorkout('${esc(f.id)}',${di})">
            <div class="dn" style="background:color-mix(in oklab, ${color} 14%, transparent);color:${color}">${di+1}</div>
            <div class="di">
              <div class="dn2">${esc(d.name)}</div>
              <div class="ds">${esc((d.exs||[]).map(e=>e.name).filter(Boolean).join(', '))||'—'}</div>
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
  if(!g || g.childElementCount) return;
  const size=280, r=126, stroke=14;
  for(let i=0;i<60;i++){
    const angle=(i/60)*2*Math.PI-Math.PI/2;
    const innerR=r-stroke/2-8, outerR=r-stroke/2-(i%5===0?14:11);
    const x1=size/2+Math.cos(angle)*innerR, y1=size/2+Math.sin(angle)*innerR;
    const x2=size/2+Math.cos(angle)*outerR, y2=size/2+Math.sin(angle)*outerR;
    const line=document.createElementNS('http://www.w3.org/2000/svg','line');
    line.setAttribute('x1',x1);line.setAttribute('y1',y1);
    line.setAttribute('x2',x2);line.setAttribute('y2',y2);
    line.setAttribute('stroke',i%5===0?'rgba(255,255,255,0.16)':'rgba(255,255,255,0.06)');
    line.setAttribute('stroke-width',i%5===0?'1.6':'1');
    line.setAttribute('stroke-linecap','round');
    g.appendChild(line);
  }
},

showTimerTab(i){
  S.timerTab=i;
  document.querySelectorAll('.seg-btn').forEach((b,bi)=>b.classList.toggle('on',bi===i));
  $('tab-interval').style.display=i===0?'block':'none';
  $('tab-series').style.display=i===1?'block':'none';
},

setPreset(s){
  if(S.timer.running) App.stopTimer();
  S.timer.total=s; S.timer.rem=s; App.updTimer();
  document.querySelectorAll('.tp').forEach(b=>b.classList.remove('on'));
  [30,45,90,120,180].forEach((v,i)=>{ if(v===s) document.querySelectorAll('.tp')[i]?.classList.add('on'); });
  if($('cmin')) $('cmin').value=Math.floor(s/60);
  if($('csec')) $('csec').value=s%60;
},

setCustomTime(){
  const t=(+($('cmin')?.value||0))*60+(+($('csec')?.value||0));
  if(t>0){
    if(S.timer.running) App.stopTimer();
    S.timer.total=t; S.timer.rem=t; App.updTimer();
    document.querySelectorAll('.tp').forEach(b=>b.classList.remove('on'));
  }
},

toggleTimer(){ S.timer.running ? App.stopTimer() : App.startTimer(); },

// ─── [TIMER] Timer resiliente a background ───────────────────────
// Ao iniciar, salva o timestamp de fim no localStorage.
// Ao voltar ao foco, recalcula o tempo restante a partir do timestamp.
// Isso garante que o timer continue correto mesmo que o iOS/PWA
// congele a aba e suspenda o setInterval.
startTimer(){
  if(S.timer.rem<=0) S.timer.rem=S.timer.total;
  S.timer.running=true;

  // Persiste o momento exato em que o timer deve acabar
  const endAt = Date.now() + S.timer.rem * 1000;
  localStorage.setItem('evolv_timer_end', String(endAt));

  App.setTimerStatus('Contando');
  App.setTimerPlayIcon(true);

  S.timer.iv=setInterval(()=>{
    // Recalcula sempre a partir do timestamp — imune a drift e background
    const rem = Math.max(0, Math.round((+localStorage.getItem('evolv_timer_end') - Date.now()) / 1000));
    S.timer.rem = rem;
    App.updTimer();
    if(rem<=0){
      App.stopTimer();
      App.setTimerStatus('Tempo!');
      if(navigator.vibrate) navigator.vibrate([250,100,250,100,250]);
      App.toast('Intervalo finalizado!');
      App.sendTimerNotification();
    }
  },1000);
},

stopTimer(){
  S.timer.running=false;
  clearInterval(S.timer.iv);
  localStorage.removeItem('evolv_timer_end');
  App.setTimerPlayIcon(false);
  App.setTimerStatus(S.timer.rem>0?'Pausado':'Pronto');
},

resetTimer(){
  App.stopTimer();
  S.timer.rem=S.timer.total;
  App.updTimer();
  App.setTimerStatus('Pronto');
},

bumpTimer(seconds){
  // Atualiza tanto o rem quanto o timestamp persistido
  S.timer.rem=Math.max(1,S.timer.rem+seconds);
  S.timer.total=Math.max(S.timer.total,S.timer.rem);
  if(S.timer.running){
    const newEnd = Date.now() + S.timer.rem * 1000;
    localStorage.setItem('evolv_timer_end', String(newEnd));
  }
  App.updTimer();
},

// Restaura o timer ao voltar ao foco (após iOS suspender a aba)
_onVisibilityChange(){
  if(document.visibilityState !== 'visible') return;
  const endAt = +localStorage.getItem('evolv_timer_end');
  if(!endAt || !S.timer.running) return;
  const rem = Math.max(0, Math.round((endAt - Date.now()) / 1000));
  S.timer.rem = rem;
  App.updTimer();
  if(rem <= 0){
    App.stopTimer();
    App.setTimerStatus('Tempo!');
    App.toast('Intervalo finalizado!');
    App.sendTimerNotification();
  }
},

setTimerStatus(text){
  const a=$('tstatus'), b=$('aw-tstatus');
  if(a) a.textContent=text;
  if(b) b.textContent=text;
},

setTimerPlayIcon(paused){
  const pause='<rect x="6" y="5" width="4.5" height="14" rx="1.2"/><rect x="13.5" y="5" width="4.5" height="14" rx="1.2"/>';
  const play='<path d="M7 5.5c0-1.1 1.2-1.8 2.2-1.2l11 6.5c.9.6.9 2 0 2.5l-11 6.5c-1 .6-2.2-.1-2.2-1.2z"/>';
  const body=paused?pause:play;
  const main=$('tplayico');
  if(main) main.innerHTML=body;
},

sendTimerNotification(){
  App.notify('Intervalo finalizado!', 'timer');
  App._pushNotif('EVOLV — Timer','Intervalo encerrado. Próxima série!',{
    tag:'evolv-timer', vibrate:[200,80,200,80,400],
  });
},

_pushNotif(title, body, extra={}){
  if(!('Notification' in window) || Notification.permission!=='granted') return;
  const opts={body,icon:'icon.png',badge:'icon.png',vibrate:[200,100,200],requireInteraction:false,...extra};
  if(navigator.serviceWorker?.controller){
    navigator.serviceWorker.ready
      .then(reg=>reg.showNotification(title,opts))
      .catch(()=>{try{new Notification(title,opts);}catch{}});
  } else { try{new Notification(title,opts);}catch{} }
},

async requestNotifPermission(){
  if(!('Notification' in window)){ App.toast('Browser não suporta notificações'); return; }
  if(Notification.permission==='denied'){ App.toast('Permissão bloqueada — habilite nas configurações do browser'); return; }
  const r=await Notification.requestPermission();
  if(r==='granted'){
    App.notify('Notificações push ativadas!','success');
    App._pushNotif('EVOLV','Notificações ativadas com sucesso!',{tag:'evolv-test'});
  } else {
    App.toast('Permissão negada');
  }
},

updTimer(){
  const{total,rem}=S.timer;
  const r=126; const C=2*Math.PI*r;
  const d=$('tdisplay'), ring=$('tring');
  if(d) d.textContent=ft(rem);
  if(ring){
    const p=total>0?rem/total:1;
    ring.setAttribute('stroke-dasharray',C);
    ring.setAttribute('stroke-dashoffset',C*(1-p));
    ring.setAttribute('stroke',rem<=10&&rem>0?'#FF5577':'url(#tg)');
  }
},

// ─── SERIES ──────────────────────────────────────────────────────
addSeries(d){
  S.series=Math.max(0,S.series+d);
  const el=$('sc-num');
  if(el){ el.textContent=S.series; el.style.color=S.series>0?'var(--green)':'var(--t0)'; el.classList.add('bump'); setTimeout(()=>el.classList.remove('bump'),160); }
},
resetSeries(){
  S.series=0;
  const el=$('sc-num'); if(el){el.textContent=0;el.style.color='var(--t0)';}
},

// ─── STATS ───────────────────────────────────────────────────────
renderStats(){
  const sess=DB.sessoes(), pesos=DB.pesos();
  const root=$('stats-content');
  if(!sess.length&&!pesos.length){
    root.innerHTML=`<div class="empty"><div class="empty-ico">${IC.trendUp(28)}</div><div class="et">Sem dados ainda</div><div class="es">Registre treinos e pesagens<br>para ver suas estatísticas.</div></div>`;
    return;
  }
  const now=new Date();

  // ── Frequência ────────────────────────────────────────────────
  const total = sess.length;
  const sessDays = new Set(sess.map(s=>s.date.slice(0,10)));

  // Treinos últimos 30 dias
  const mo30 = sess.filter(s=>(now-new Date(s.date))/864e5<=30);

  // Consistência %: dias treinados / 30
  const consistency = Math.round((new Set(mo30.map(s=>s.date.slice(0,10))).size / 30) * 100);

  // Frequência semanal média (últimas 8 semanas)
  const weekCounts = [];
  for(let i=7;i>=0;i--){
    const start=new Date(now); start.setDate(now.getDate()-(i*7+6));
    const end=new Date(now);   end.setDate(now.getDate()-(i*7));
    weekCounts.push(sess.filter(s=>{const d=new Date(s.date);return d>=start&&d<=end;}).length);
  }
  const avgFreq = (weekCounts.reduce((a,b)=>a+b,0)/weekCounts.length).toFixed(1);
  const lastWCount = weekCounts[weekCounts.length-1];
  const prevWCount = weekCounts[weekCounts.length-2]||0;

  // ── Duração ───────────────────────────────────────────────────
  const sessWithDur = sess.filter(s=>s.dur>0);
  const avgDurSec   = sessWithDur.length
    ? Math.round(sessWithDur.reduce((a,s)=>a+s.dur,0)/sessWithDur.length)
    : 0;
  const avgDurMin   = Math.round(avgDurSec/60);

  // Duração total acumulada em horas
  const totalHours  = (sess.reduce((a,s)=>a+(s.dur||0),0)/3600).toFixed(1);

  // ── Carga média por série ────────────────────────────────────
  const allSeries   = sess.reduce((a,s)=>a+(s.exs||[]).reduce((b,e)=>b+(e.sets||[]).filter(x=>x.done).length,0),0);
  const allVol      = sess.reduce((a,s)=>a+(s.exs||[]).reduce((b,e)=>b+(e.sets||[]).filter(x=>x.done).reduce((c,x)=>c+(+x.reps||0)*(+x.w||0),0),0),0);
  const avgLoad     = allSeries>0 ? Math.round(allVol/allSeries) : 0;

  // Carga média últimas 4 semanas vs 4 semanas anteriores (progressão)
  const recent4w  = sess.filter(s=>(now-new Date(s.date))/864e5<=28);
  const prev4w    = sess.filter(s=>{const d=(now-new Date(s.date))/864e5; return d>28&&d<=56;});
  const loadOf = arr=>{
    const s=arr.reduce((a,s)=>a+(s.exs||[]).reduce((b,e)=>b+(e.sets||[]).filter(x=>x.done).length,0),0);
    const v=arr.reduce((a,s)=>a+(s.exs||[]).reduce((b,e)=>b+(e.sets||[]).filter(x=>x.done).reduce((c,x)=>c+(+x.reps||0)*(+x.w||0),0),0),0);
    return s>0?Math.round(v/s):0;
  };
  const loadRecent = loadOf(recent4w);
  const loadPrev   = loadOf(prev4w);
  const loadDelta  = loadPrev>0 ? Math.round(((loadRecent-loadPrev)/loadPrev)*100) : 0;

  // ── PR por exercício ─────────────────────────────────────────
  const prMap={};
  sess.forEach(s=>(s.exs||[]).forEach(e=>{
    if(!e.name) return;
    (e.sets||[]).filter(x=>x.done&&+x.w>0).forEach(x=>{
      if(!prMap[e.name]||+x.w>prMap[e.name]) prMap[e.name]=+x.w;
    });
  }));
  const prs = Object.entries(prMap).sort((a,b)=>b[1]-a[1]).slice(0,5);

  // ── Exercício mais frequente ──────────────────────────────────
  const freqMap={};
  sess.forEach(s=>(s.exs||[]).forEach(e=>{
    if(!e.name) return;
    freqMap[e.name]=(freqMap[e.name]||0)+1;
  }));
  const topFreqEx = Object.entries(freqMap).sort((a,b)=>b[1]-a[1]).slice(0,5);
  const topFreqMax = topFreqEx[0]?.[1]||1;

  // ── Treinos por semana — barras (8 semanas) ───────────────────
  const maxWC = Math.max(...weekCounts,1);

  // ── Render ────────────────────────────────────────────────────
  root.innerHTML=`
    <div class="stats-hero">
      <div class="eyebrow">Visão geral</div>
      <div class="h1" style="margin-top:4px">
        ${total}<small> treinos</small>
        <small style="margin:0 6px">·</small>
        ${totalHours}<small>h</small>
      </div>
      <div class="meta" style="margin-top:4px">
        ${allSeries} séries · ${avgDurMin>0?`média de ${avgDurMin} min por treino`:'sem dados de duração'}
      </div>
    </div>

    <!-- FREQUÊNCIA -->
    <div class="eyebrow" style="margin:4px 0 10px">Frequência</div>
    <div class="srow">
      <div class="sc">
        <div class="sl">Consistência</div>
        <div class="sv">${consistency}<small>%</small></div>
        <div class="ss">últimos 30d</div>
      </div>
      <div class="sc">
        <div class="sl" style="color:var(--green)">Freq. semanal</div>
        <div class="sv">${avgFreq}<small>x</small></div>
        <div class="ss">média 8 sem.</div>
      </div>
      <div class="sc">
        <div class="sl" style="color:var(--cool)">Esta semana</div>
        <div class="sv">${lastWCount}</div>
        <div class="ss">${lastWCount>=prevWCount?'↑':'↓'} vs anterior</div>
      </div>
    </div>

    <!-- BARRAS DE FREQUÊNCIA SEMANAL -->
    <div class="card">
      <div class="between" style="margin-bottom:12px">
        <div>
          <div class="eyebrow">Treinos por semana</div>
          <div class="row" style="gap:6px;margin-top:4px;align-items:baseline">
            <div class="num" style="font-size:20px">${avgFreq}</div>
            <div class="meta">média</div>
          </div>
        </div>
        ${lastWCount>=prevWCount
          ?`<div class="row" style="gap:4px;color:var(--green)">${IC.trendUp(14)}<span class="num" style="font-size:13px">${lastWCount} esta sem.</span></div>`
          :`<div class="row" style="gap:4px;color:var(--heat)">${IC.trendDown(14)}<span class="num" style="font-size:13px">${lastWCount} esta sem.</span></div>`}
      </div>
      <div class="bar-chart">
        ${weekCounts.map((v,i)=>{
          const h=(v/maxWC)*100, cur=i===weekCounts.length-1;
          return `<div class="bar-col ${cur?'cur':''}">
            <div class="bar" style="height:${Math.max(h,v?8:2)}%;"></div>
            <div class="blabel">${i===0?'-7w':i===weekCounts.length-1?'agora':''}</div>
          </div>`;
        }).join('')}
      </div>
    </div>

    <!-- CARGA E DURAÇÃO -->
    <div class="eyebrow" style="margin:18px 0 10px">Desempenho</div>
    <div class="srow">
      <div class="sc">
        <div class="sl" style="color:var(--heat)">Carga média</div>
        <div class="sv">${avgLoad}<small>kg</small></div>
        <div class="ss">por série</div>
      </div>
      <div class="sc">
        <div class="sl" style="color:var(--violet)">Progresso</div>
        <div class="sv" style="color:${loadDelta>=0?'var(--green)':'var(--heat)'}">${loadDelta>=0?'+':''}${loadDelta}<small>%</small></div>
        <div class="ss">carga 4s vs 4s</div>
      </div>
      <div class="sc">
        <div class="sl" style="color:var(--cool)">Duração</div>
        <div class="sv">${avgDurMin>0?avgDurMin:'—'}<small>${avgDurMin>0?'min':''}</small></div>
        <div class="ss">média por treino</div>
      </div>
    </div>

    <!-- PRs -->
    ${prs.length?`
    <div class="eyebrow" style="margin:18px 0 10px">Personal records · maior carga</div>
    <div class="card" style="padding:8px 16px">
      ${prs.map(([n,w],i)=>{
        const medal = i===0?'🥇':i===1?'🥈':i===2?'🥉':'';
        return `<div class="prow" style="border-bottom:${i<prs.length-1?'1px solid var(--line)':'none'}">
          <div class="pday" style="width:24px;flex-shrink:0">
            <div style="font-size:14px">${medal||`<span style="font-family:var(--mono);font-size:11px;color:var(--t2)">${i+1}</span>`}</div>
          </div>
          <div class="pdata" style="flex:1;min-width:0">
            <div style="font-size:13px;font-weight:600;color:var(--t0);white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(n)}</div>
          </div>
          <div style="font-family:var(--mono);font-weight:700;font-size:16px;color:var(--t0);flex-shrink:0">
            ${w}<small style="font-size:11px;color:var(--t2);font-weight:500;margin-left:2px">kg</small>
          </div>
        </div>`;
      }).join('')}
    </div>`:''}

    <!-- EXERCÍCIOS MAIS FREQUENTES -->
    ${topFreqEx.length?`
    <div class="eyebrow" style="margin:18px 0 10px">Exercícios · mais praticados</div>
    <div>
      ${topFreqEx.map(([n,c])=>{
        const pct=(c/topFreqMax)*100;
        return `<div class="lb-row">
          <div class="lb-head">
            <div class="lb-name">${esc(n)}</div>
            <div class="lb-val">${c}x</div>
          </div>
          <div class="lb-bar"><div class="lb-fill" style="width:${pct}%"></div></div>
        </div>`;
      }).join('')}
    </div>`:''}

    <!-- EVOLUÇÃO DO PESO -->
    ${pesos.length>=2?`
    <div class="eyebrow" style="margin:18px 0 10px">Evolução do peso</div>
    <div class="card">
      <div class="row" style="gap:6px;align-items:baseline">
        <div class="num" style="font-size:22px">${pesos[pesos.length-1].w}<small style="font-size:13px;color:var(--t2);font-weight:500;margin-left:2px">kg</small></div>
        ${(()=>{const first=pesos[0].w,last=pesos[pesos.length-1].w,diff=(last-first).toFixed(1);const cls=+diff>0?'color:var(--heat)':'color:var(--cool)';return `<div class="meta" style="${cls}">${+diff>0?'+':''}${diff}kg desde o início</div>`;})()}
      </div>
      <div class="cwrap" style="margin-top:8px"><canvas id="ch-pe"></canvas></div>
    </div>`:''}
  `;

  setTimeout(()=>{
    Object.values(S.charts).forEach(c=>{try{c.destroy()}catch{}}); S.charts={};
    if($('ch-pe')&&pesos.length>=2){
      const lp=pesos.slice(-24);
      const op={...CDO,scales:{...CDO.scales,y:{...CDO.scales.y,beginAtZero:false}}};
      S.charts.pe=new Chart($('ch-pe'),{type:'line',data:{labels:lp.map(p=>fd(p.date)),datasets:[{data:lp.map(p=>p.w),borderColor:ACCENT,backgroundColor:'rgba(31,224,122,0.08)',fill:true,tension:0.35,pointRadius:3,pointBackgroundColor:ACCENT,borderWidth:2}]},options:op});
    }
  },50);
},

// ─── PESO ────────────────────────────────────────────────────────
renderPeso(){
  const pesos=DB.pesos();
  const root=$('peso-content');
  if(!pesos.length){
    root.innerHTML=`
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

  const cur=pesos[pesos.length-1], first=pesos[0];
  const delta=(cur.w-first.w).toFixed(1);
  const deltaCls=+delta>0?'up':'';

  const last7=pesos.slice(-7);
  const avg7=last7.reduce((a,p)=>a+p.w,0)/last7.length;
  const minW=Math.min(...pesos.map(p=>p.w));
  const variation=((cur.w-first.w)/first.w*100).toFixed(1);

  const savedGoal=+localStorage.getItem('evolv_peso_goal');
  const goal=savedGoal||Math.round(cur.w*0.95*2)/2;
  const progress=Math.min(1,Math.max(0,(first.w-cur.w)/Math.max(0.1,first.w-goal)));

  root.innerHTML=`
    <div class="peso-cur">
      <div class="between">
        <div class="eyebrow">Peso atual</div>
        <button onclick="App.showWeightGoalModal()" style="display:flex;align-items:center;gap:5px;color:var(--green);font-size:12px;background:none;border:1px solid var(--green-line);border-radius:8px;padding:4px 10px;cursor:pointer;font-family:inherit">
          ${IC.target(13)} Meta: ${goal.toFixed(1)}kg
        </button>
      </div>
      <div class="pcr" style="margin-top:4px">
        <div class="pcv">${cur.w.toFixed(1)}<small>kg</small></div>
        ${delta!=='0.0'?`<div class="pdelta ${deltaCls}">${+delta>0?IC.arrowUp(11):IC.arrowDown(11)}${Math.abs(delta)}kg</div>`:''}
      </div>
      <div class="meta" style="margin-top:6px">
        ${pesos.length} pesagens ·
        ${cur.w>goal
          ?`faltam <strong style="color:var(--cool)">${(cur.w-goal).toFixed(1)}kg</strong> para a meta`
          :`<span style="color:var(--green)">meta atingida!</span>`}
      </div>
      <div class="peso-goal-bar" style="margin-top:12px">
        <div class="peso-goal-fill" style="width:${progress*100}%"></div>
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
    <div class="card"><div id="peso-hist"></div></div>
  `;

  const hist=$('peso-hist');
  // [SEC-1] esc() em obs e period vindos do usuário
  hist.innerHTML=pesos.slice(-30).reverse().map((p,i,arr)=>{
    const prev=arr[i+1];
    const diff=prev?(p.w-prev.w).toFixed(1):null;
    const cls=diff===null?'eq':+diff>0?'up':+diff<0?'dn':'eq';
    const d=new Date(p.date+(p.date.length===10?'T12:00':''));
    const dayLabel=i===0?'Hoje':i===1?'Antes':fd(p.date);
    return `<div class="prow">
      <div class="pday"><div class="pday-d">${dayLabel}</div><div class="pday-t mono">${d.toLocaleDateString('pt-BR',{day:'2-digit',month:'2-digit'})}</div></div>
      <div class="pdata">
        <div><span class="pval">${p.w.toFixed(1)}<small>kg</small></span>${diff!==null?`<span class="pdif ${cls}">${+diff>0?'+':''}${diff}</span>`:''}</div>
        ${p.obs?`<div class="pobs">${esc(p.obs)}</div>`:''}
      </div>
      ${p.period?`<div class="pper">${esc(p.period)}</div>`:''}
      <div class="del" onclick="App.delPeso('${esc(p.id)}')" title="Excluir">${IC.trash(13)}</div>
    </div>`;
  }).join('');

  setTimeout(()=>{
    if(S.charts.peso){try{S.charts.peso.destroy()}catch{}delete S.charts.peso;}
    const cw=$('peso-chart');
    if(cw&&pesos.length>=2){
      const lp=pesos.slice(-24);
      const op={...CDO,scales:{...CDO.scales,y:{...CDO.scales.y,beginAtZero:false}}};
      S.charts.peso=new Chart(cw,{type:'line',data:{labels:lp.map(p=>fd(p.date)),datasets:[{data:lp.map(p=>p.w),borderColor:COOL,backgroundColor:'rgba(107,168,255,0.1)',fill:true,tension:0.35,pointRadius:3,pointBackgroundColor:COOL,borderWidth:2}]},options:op});
    } else if(cw){
      cw.parentElement.innerHTML='<div style="height:120px;display:flex;align-items:center;justify-content:center;color:var(--t2);font-size:13px">Registre ao menos 2 pesagens para ver o gráfico</div>';
    }
  },50);
},

// ─── WEIGH-IN MODAL ──────────────────────────────────────────────
showWeighIn(){
  App.closeModal();
  const m=document.createElement('div');m.className='mo';
  m.innerHTML=`<div class="md">
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
    <div class="ig"><label>Obs (opcional)</label><input type="text" id="p-obs" placeholder="Anotação livre..."></div>
    <button class="btn bp lg" onclick="App.savePeso()">${IC.check(16)} Salvar pesagem</button>
    <button class="btn bg" onclick="App.closeModal()" style="margin-top:8px">Cancelar</button>
  </div>`;
  m.addEventListener('click',e=>{if(e.target===m)App.closeModal();});
  $('mroot').appendChild(m);
  setTimeout(()=>{ if($('p-date'))$('p-date').value=today(); $('p-weight')?.focus(); },200);
},

async savePeso(){
  const w=parseFloat($('p-weight')?.value);
  const date=$('p-date')?.value||today();
  const obs=$('p-obs')?.value?.trim()||'';
  const period=$('p-period')?.value||'';
  if(!w||w<30||w>300){App.toast('Informe um peso válido');return;}
  try{
    await DB.addPeso({id:uid(),w,date,obs,period});
    App.closeModal(); App.toast(`${w}kg registrado!`); App.renderPeso();
  }catch(e){App.toast('Erro ao salvar.');}
},

async delPeso(id){
  await App.showConfirmDialog({
    title:'Excluir pesagem',
    message:'Esta pesagem será removida permanentemente do seu histórico.',
    confirmText:'Excluir pesagem',
    cancelText:'Cancelar',
    isDangerous:true,
    onConfirm:async()=>{try{await DB.delPeso(id);App.renderPeso();App.toast('Pesagem excluída');}catch(e){App.toast('Erro ao excluir.');}}
  });
},

showWeightGoalModal(){
  App.closeModal();
  const pesos=DB.pesos();
  const cur=pesos.length?pesos[pesos.length-1].w:0;
  const savedGoal=localStorage.getItem('evolv_peso_goal')||'';
  const m=document.createElement('div');m.className='mo';
  m.innerHTML=`<div class="md">
    <div class="mhandle"></div>
    <div class="mtitle">Definir meta de peso</div>
    <div class="ig"><label>Meta (kg)</label>
      <input type="number" id="goal-input" placeholder="ex: 75.0" step="0.5" min="30" max="300" value="${esc(savedGoal)}" inputmode="decimal">
    </div>
    <div style="background:var(--bg-3);border:1px solid var(--line);border-radius:12px;padding:14px;margin-bottom:16px">
      <div style="font-size:12px;color:var(--t2);margin-bottom:4px">Peso atual</div>
      <div class="num" style="font-size:24px">${cur}<small style="font-size:14px;color:var(--t2);font-weight:500;margin-left:4px">kg</small></div>
      ${savedGoal?`<div class="meta" style="margin-top:4px">Meta atual: <strong style="color:var(--green)">${(+savedGoal).toFixed(1)}kg</strong></div>`:''}
    </div>
    <button class="btn bp lg" onclick="App.saveWeightGoal()">${IC.check(16)} Salvar meta</button>
    ${savedGoal?`<button class="btn bg" onclick="App.clearWeightGoal()" style="margin-top:8px">Remover meta</button>`:''}
    <button class="btn bg" onclick="App.closeModal()" style="margin-top:8px">Cancelar</button>
  </div>`;
  m.addEventListener('click',e=>{if(e.target===m)App.closeModal();});
  $('mroot').appendChild(m);
  setTimeout(()=>$('goal-input')?.focus(),200);
},

saveWeightGoal(){
  const v=parseFloat($('goal-input')?.value);
  if(!v||v<30||v>300){App.toast('Informe um peso válido');return;}
  localStorage.setItem('evolv_peso_goal',v);
  App.closeModal(); App.toast(`Meta: ${v.toFixed(1)}kg definida!`); App.renderPeso();
},

clearWeightGoal(){
  localStorage.removeItem('evolv_peso_goal');
  App.closeModal(); App.toast('Meta removida.'); App.renderPeso();
},

// ─── FICHA CRUD ──────────────────────────────────────────────────
showAddFicha(ficha=null){
  App.closeModal();
  const m=document.createElement('div');m.className='mo';
  m.innerHTML=`<div class="md">
    <div class="mhandle"></div>
    <div class="mtitle">${ficha?'Editar ficha':'Nova ficha'}</div>
    <div class="ig"><label>Nome da ficha</label>
      <input type="text" id="f-name" placeholder="ex: Hipertrofia ABC" value="${esc(ficha?.name||'')}">
    </div>
    <div id="f-days"></div>
    <button class="btn bg" onclick="App.addDay()" style="margin-bottom:10px">${IC.plus(14)} Adicionar dia</button>
    <button class="btn bp lg" onclick="App.saveFicha('${esc(ficha?.id||'')}')">Salvar</button>
    <button class="btn bg" onclick="App.closeModal()" style="margin-top:8px">Cancelar</button>
  </div>`;
  m.addEventListener('click',e=>{if(e.target===m)App.closeModal();});
  $('mroot').appendChild(m);
  setTimeout(()=>$('f-name')?.focus(),250);
  if(ficha) setTimeout(()=>{
    (ficha.days||[]).forEach(day=>{
      App.addDay();
      const blocks=document.querySelectorAll('#f-days .db');
      const b=blocks[blocks.length-1];
      b.querySelector('.db-name').value=day.name||'';
      (day.exs||[]).forEach(ex=>{
        App.addExRow(b.querySelector('.ex-list'));
        const rows=b.querySelectorAll('.ex-row');
        const r=rows[rows.length-1];
        r.querySelector('.en').value=ex.name||'';
        r.querySelector('.es').value=ex.sets||3;
        r.querySelector('.er').value=ex.reps||12;
      });
    });
  },100);
},

addDay(){
  const cont=$('f-days'), n=cont.querySelectorAll('.db').length+1;
  const db=document.createElement('div'); db.className='db';
  db.innerHTML=`
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
  const r=document.createElement('div'); r.className='ex-row';
  r.innerHTML=`
    <input type="text" class="en" placeholder="Exercício">
    <input type="number" class="es" placeholder="Sér" value="3" min="1">
    <input type="number" class="er" placeholder="Rep" value="12" min="1">
    <button class="x-mini" onclick="this.parentElement.remove()">${IC.close(14)}</button>
  `;
  list.appendChild(r);
},

async saveFicha(editId){
  const name=$('f-name')?.value?.trim();
  if(!name){App.toast('Digite o nome da ficha');return;}
  const days=[...document.querySelectorAll('#f-days .db')].map((b,i)=>({
    name:b.querySelector('.db-name')?.value?.trim()||`Dia ${i+1}`,
    exs:[...b.querySelectorAll('.ex-row')].map(r=>({
      name:r.querySelector('.en')?.value?.trim()||'',
      sets:+r.querySelector('.es')?.value||3,
      reps:+r.querySelector('.er')?.value||12,
      w:0,
    })).filter(e=>e.name)
  }));
  try{
    if(editId) await DB.updFicha(editId,{name,days,updAt:Date.now()});
    else       await DB.addFicha({id:uid(),name,days,at:Date.now()});
    App.closeModal(); App.renderFichas(); App.notify(editId?'Ficha atualizada!':'Ficha criada!', editId?'success':'ficha');
  }catch(e){App.toast('Erro ao salvar.');}
},

editFicha(id){ const f=DB.fichas().find(x=>x.id===id); if(f)App.showAddFicha(f); },

// ─── CONFIRM DIALOG ──────────────────────────────────────────────
async showConfirmDialog(opts){
  App.closeModal();
  const {title='Confirmar', message='Tem certeza?', confirmText='Confirmar', cancelText='Cancelar', onConfirm=null, isDangerous=false}=opts;
  return new Promise(resolve=>{
    const m=document.createElement('div');m.className='mo';
    m.innerHTML=`<div class="md">
      <div class="mhandle"></div>
      <div class="confirm-content">
        <div class="confirm-icon">${isDangerous?IC.trash(28):IC.info(28)}</div>
        <div class="confirm-title">${esc(title)}</div>
        <div class="confirm-message">${esc(message)}</div>
      </div>
      <div class="confirm-actions">
        <button class="btn bg" id="confirm-cancel">${esc(cancelText)}</button>
        <button class="btn ${isDangerous?'bd':'bp'}" id="confirm-ok">${esc(confirmText)}</button>
      </div>
    </div>`;
    m.addEventListener('click',e=>{if(e.target===m){App.closeModal();resolve(false);}});
    $('mroot').appendChild(m);
    $('confirm-cancel').addEventListener('click',()=>{App.closeModal();resolve(false);});
    $('confirm-ok').addEventListener('click',async()=>{
      App.closeModal();
      if(onConfirm) await onConfirm();
      resolve(true);
    });
  });
},

async delFicha(id){
  await App.showConfirmDialog({
    title:'Excluir ficha',
    message:'Esta ação não pode ser desfeita. A ficha será removida permanentemente.',
    confirmText:'Excluir ficha',
    cancelText:'Cancelar',
    isDangerous:true,
    onConfirm:async()=>{try{await DB.delFicha(id);App.renderFichas();App.toast('Ficha excluída');}catch(e){App.toast('Erro ao excluir.');}}
  });
},

// ─── EXPORT / IMPORT ─────────────────────────────────────────────
exportFichas(){
  const fichas=DB.fichas();
  if(!fichas.length){App.toast('Nenhuma ficha para exportar');return;}
  const data={
    evolv_export:true,
    exported_at:new Date().toISOString(),
    fichas:fichas.map(f=>({name:f.name,days:f.days}))
  };
  const a=document.createElement('a');
  a.href=URL.createObjectURL(new Blob([JSON.stringify(data,null,2)],{type:'application/json'}));
  a.download=`evolv-fichas-${today()}.json`;
  a.click();
  App.toast('Fichas exportadas!');
},

downloadTemplate(){
  const tmpl={evolv_export:true,fichas:[{
    name:"Hipertrofia ABC",
    days:[
      {name:"Treino A — Peito/Tríceps",exs:[{name:"Supino Reto",sets:4,reps:10},{name:"Supino Inclinado",sets:3,reps:12},{name:"Crucifixo",sets:3,reps:15},{name:"Tríceps Corda",sets:3,reps:12}]},
      {name:"Treino B — Costas/Bíceps",exs:[{name:"Remada Curvada",sets:4,reps:10},{name:"Puxada Frente",sets:3,reps:12},{name:"Rosca Direta",sets:3,reps:12},{name:"Rosca Martelo",sets:3,reps:12}]},
      {name:"Treino C — Pernas",exs:[{name:"Agachamento Livre",sets:4,reps:10},{name:"Leg Press",sets:4,reps:12},{name:"Extensora",sets:3,reps:15},{name:"Panturrilha",sets:4,reps:20}]}
    ]
  }]};
  const a=document.createElement('a');
  a.href=URL.createObjectURL(new Blob([JSON.stringify(tmpl,null,2)],{type:'application/json'}));
  a.download='evolv-modelo.json';
  a.click();
  App.toast('Modelo baixado!');
},

showImportFicha(){
  App.closeModal();
  const m=document.createElement('div');m.className='mo';
  m.innerHTML=`<div class="md">
    <div class="mhandle"></div>
    <div class="mtitle">Importar fichas JSON</div>
    <div class="ig"><label>Cole o JSON abaixo</label>
      <textarea id="import-json" style="min-height:140px"></textarea>
    </div>
    <button class="btn bp" onclick="App.importFichasFromJson(document.getElementById('import-json').value)">Importar</button>
    <button class="btn bg" onclick="App.importFileSelector()" style="margin-top:8px">${IC.download(14)} Selecionar arquivo</button>
    <button class="btn bg" onclick="App.downloadTemplate()" style="margin-top:8px">${IC.info(14)} Baixar modelo</button>
    <button class="btn bg" onclick="App.closeModal()" style="margin-top:8px">Cancelar</button>
  </div>`;
  m.addEventListener('click',e=>{if(e.target===m)App.closeModal();});
  $('mroot').appendChild(m);
},

handleImportFile(e){
  const file=e.target.files?.[0]; if(!file)return;
  const reader=new FileReader();
  reader.onload=()=>App.importFichasFromJson(reader.result);
  reader.onerror=()=>App.toast('Não foi possível ler o arquivo.');
  reader.readAsText(file,'UTF-8'); e.target.value='';
},

importFileSelector(){ $('import-file-input')?.click(); },

// ─── [SEC-2] Importação com sanitização completa ─────────────────
// Garante que nenhum campo de fichas importadas contenha tipos
// inesperados. Strings são truncadas, números são coagidos,
// campos extras são ignorados (allowlist explícita).
async importFichasFromJson(raw){
  App.closeModal();
  if(!raw||!raw.trim()){App.toast('Cole um JSON válido.');return;}

  // Helper: extrai string segura com limite de tamanho
  const safeStr = (v, maxLen=200) => String(v||'').slice(0, maxLen).replace(/[<>]/g,'');
  // Helper: número positivo dentro de faixa
  const safeInt = (v, min=1, max=99, fallback=3) => {
    const n = parseInt(v, 10);
    return (isNaN(n) || n < min || n > max) ? fallback : n;
  };

  try{
    const data=JSON.parse(raw);
    const itens=Array.isArray(data)?data:(data.fichas?data.fichas:[data]);

    // Valida campos obrigatórios ANTES de persistir qualquer coisa
    const valid=itens.filter(f=>f && typeof f.name==='string' && f.name.trim() && Array.isArray(f.days));

    if(!valid.length){App.toast('Nenhum objeto de ficha válido.');return;}

    let imported=0;
    for(const ficha of valid){
      // allowlist explícita: apenas name e days (com exs) são aceitos
      const item={
        id: ficha.id && typeof ficha.id==='string' ? ficha.id : uid(),
        at: Date.now(),
        name: safeStr(ficha.name, 80),
        days: (Array.isArray(ficha.days) ? ficha.days : []).slice(0, 30).map(d=>({
          name: safeStr(d.name||'Dia', 80),
          exs: (Array.isArray(d.exs) ? d.exs : []).slice(0, 50).map(e=>({
            name: safeStr(e.name||'', 80),
            sets: safeInt(e.sets, 1, 20, 3),
            reps: safeInt(e.reps, 1, 200, 12),
            w:    0,  // peso sempre começa em zero; não importa do JSON
          })).filter(e=>e.name.trim()),
        })),
      };

      // Evita ID duplicado
      if(DB.fichas().some(x=>x.id===item.id)) item.id=uid();
      await DB.addFicha(item);
      imported++;
    }
    App.renderFichas();
    App.notify(`${imported} ${imported===1?'ficha importada':'fichas importadas'}.`,'ficha');
  }catch(e){App.toast('JSON inválido. Verifique e tente novamente.');}
},

// ─── ACTIVE WORKOUT ──────────────────────────────────────────────
startTodayWorkout(){
  if(!DB.fichas().length){App.toast('Crie uma ficha de treino primeiro!');App.nav('fichas');return;}
  App.showPickModal();
},

showPickModal(){
  App.closeModal();
  const fichas=DB.fichas();
  const m=document.createElement('div');m.className='mo';
  m.innerHTML=`<div class="md">
    <div class="mhandle"></div>
    <div class="mtitle">Selecionar treino</div>
    ${fichas.map((f,fi)=>{
      const color=S.fichaColors[fi%S.fichaColors.length];
      const tag=String.fromCharCode(65+fi);
      // [SEC-1] esc() em nomes de fichas e dias
      return `<div style="margin-bottom:16px">
        <div class="eyebrow" style="margin-bottom:8px"><span style="color:${color}">${tag}</span> · ${esc(f.name)}</div>
        ${(f.days||[]).map((d,di)=>`
          <div class="wi" onclick="App.startWorkout('${esc(f.id)}',${di});App.closeModal()">
            <div class="wi-ico" style="background:color-mix(in oklab, ${color} 14%, transparent);color:${color};border-color:color-mix(in oklab, ${color} 32%, transparent)">${di+1}</div>
            <div class="wi-info"><div class="wi-name">${esc(d.name)}</div><div class="wi-sub">${(d.exs||[]).length} exercícios</div></div>
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

startWorkout(fichaId,dayIdx){
  const f=DB.fichas().find(x=>x.id===fichaId);
  const d=f?.days?.[dayIdx]; if(!d)return;
  App.closeModal();
  App.resetSeries();
  App.resetTimer();
  S.workout={on:true,minimized:false,fichaId,dayIdx,t0:Date.now(),iv:null,
    exs:(d.exs||[]).map(e=>({name:e.name,ts:e.sets||3,tr:e.reps||12,sets:Array.from({length:e.sets||3},()=>({reps:e.reps||12,w:0,done:false}))}))};
  $('aw').classList.add('open'); $('aw-title').textContent=d.name;
  App.updateWorkoutResume();
  // [CACHE-WO] Salva estado inicial imediatamente
  WorkoutCache.save();
  S.workout.iv=setInterval(()=>{
    const el=$('aw-timer');
    if(el) el.textContent=ft(Math.floor((Date.now()-S.workout.t0)/1000));
    // [CACHE-WO] Persiste a cada 10s para não spammar localStorage
    if(Math.floor((Date.now()-S.workout.t0)/1000) % 10 === 0) WorkoutCache.save();
  },1000);
  App.renderAW();
},

minimizeWorkout(){
  if(!S.workout.on)return;
  S.workout.minimized=true;
  $('aw')?.classList.remove('open');
  App.updateWorkoutResume();
  App.nav('timer');
},

resumeWorkout(){
  if(!S.workout.on)return;
  S.workout.minimized=false;
  $('aw')?.classList.add('open');
  App.updateWorkoutResume();
  App.renderAW();
},

updateWorkoutResume(){
  const btn=$('aw-resume');
  if(!btn)return;
  btn.classList.toggle('show',!!(S.workout.on&&S.workout.minimized));
  const title=$('aw-resume-title'), sub=$('aw-resume-sub');
  if(title) title.textContent=$('aw-title')?.textContent||'Treino em andamento';
  if(sub&&S.workout.on){
    const exs=S.workout.exs||[];
    const done=exs.reduce((a,e)=>a+e.sets.filter(s=>s.done).length,0);
    const total=exs.reduce((a,e)=>a+e.sets.length,0);
    sub.textContent=`${done}/${total} séries · toque para voltar`;
  }
},

// ─── [PERF] renderAW com atualização cirúrgica ───────────────────
// Na primeira chamada (ou após addSet) reconstrói o DOM completo.
// Nas chamadas subsequentes (togSet), apenas atualiza o checkbox
// e o progresso — evitando perda de foco nos inputs mobile.
renderAW(forceRebuild=false){
  const{exs}=S.workout;
  const done=exs.reduce((a,e)=>a+e.sets.filter(s=>s.done).length,0);
  const total=exs.reduce((a,e)=>a+e.sets.length,0);

  // Atualiza sub e barra de progresso sempre (cirúrgico)
  const subEl=$('aw-sub');
  if(subEl) subEl.textContent=`${exs.length} exercícios · ${done}/${total} séries`;
  const pbar=$('aw-pbar');
  if(pbar) pbar.style.width=total?`${(done/total)*100}%`:'0%';
  App.updateWorkoutResume();

  const body=$('aw-body');
  const alreadyBuilt = body && body.querySelector('.ex-card');

  if(!forceRebuild && alreadyBuilt){
    // Atualização cirúrgica: só toca nos checkboxes e tags de contagem
    exs.forEach((ex,ei)=>{
      const card=body.querySelectorAll('.ex-card')[ei]; if(!card) return;
      const doneCount=ex.sets.filter(s=>s.done).length;
      const tag=card.querySelector('.ex-tag');
      if(tag) tag.textContent=`${doneCount}/${ex.sets.length}`;
      card.classList.toggle('glow', ex.sets.every(s=>s.done));
      ex.sets.forEach((s,si)=>{
        const chk=card.querySelectorAll('.set-chk')[si]; if(!chk) return;
        const wasDone=chk.classList.contains('done');
        if(wasDone !== s.done){
          chk.classList.toggle('done',s.done);
          chk.innerHTML=s.done?IC.check(16):'';
          // Atualiza opacidade dos inputs da linha sem recriar
          const row=card.querySelectorAll('.set-row')[si]; if(!row) return;
          row.querySelectorAll('input').forEach(inp=>inp.style.opacity=s.done?'0.45':'');
        }
      });
    });
    return;
  }

  // Rebuild completo (primeira vez ou após addSet)
  // [SEC-1] esc() em nomes de exercícios
  body.innerHTML=exs.map((ex,ei)=>{
    const allDone=ex.sets.every(s=>s.done);
    return `<div class="ex-card ${allDone?'glow':''}">
      <div class="ex-hdr"><div class="ex-name">${esc(ex.name)}</div><span class="ex-tag">${ex.sets.filter(s=>s.done).length}/${ex.sets.length}</span></div>
      <div class="sets-hdr"><span></span><span>Carga (kg)</span><span>Reps</span><span></span></div>
      ${ex.sets.map((s,si)=>`
        <div class="set-row">
          <div class="sn">${si+1}</div>
          <input type="number" value="${s.w||''}" placeholder="0" min="0" step="0.5" onchange="App.updSet(${ei},${si},'w',this.value)" inputmode="decimal" style="${s.done?'opacity:0.45':''}">
          <input type="number" value="${s.reps||''}" placeholder="${ex.tr}" min="1" onchange="App.updSet(${ei},${si},'reps',this.value)" inputmode="numeric" style="${s.done?'opacity:0.45':''}">
          <div class="set-chk ${s.done?'done':''}" onclick="App.togSet(${ei},${si})">${s.done?IC.check(16):''}</div>
        </div>`).join('')}
      <button class="btn bg sm" onclick="App.addSet(${ei})" style="width:auto;padding:0 12px;margin-top:6px">${IC.plus(12)} Série</button>
    </div>`;
  }).join('');
},

updSet(ei,si,f,v){
  S.workout.exs[ei].sets[si][f]=+v;
  // [CACHE-WO] Persiste imediatamente ao alterar carga/reps
  WorkoutCache.save();
},

togSet(ei,si){
  const s=S.workout.exs[ei].sets[si]; s.done=!s.done;
  // [CACHE-WO] Persiste imediatamente ao marcar/desmarcar série
  WorkoutCache.save();
  // Atualização cirúrgica — não reconstrói o DOM
  App.renderAW(false);
  if(s.done){ App.addSeries(1); App.resetTimer(); App.startTimer(); App.toast('Timer iniciado!'); }
},

addSet(ei){
  const e=S.workout.exs[ei]; e.sets.push({reps:e.tr,w:0,done:false});
  // [CACHE-WO] Persiste ao adicionar série
  WorkoutCache.save();
  // Rebuild completo pois estrutura mudou
  App.renderAW(true);
},

async cancelWorkout(){
  await App.showConfirmDialog({
    title:'Descartar treino',
    message:'Toda a sessão de treino será perdida. Tem certeza que deseja continuar?',
    confirmText:'Descartar treino',
    cancelText:'Continuar',
    isDangerous:true,
    onConfirm:async()=>{App._endWO(false);}
  });
},
finishWorkout(){ App._endWO(true); },

async _endWO(save){
  clearInterval(S.workout.iv);
  App.resetTimer();
  App.resetSeries();
  // [CACHE-WO] Limpa o cache sempre que o treino termina (salvo ou descartado)
  WorkoutCache.clear();
  if(save){
    try{
      await DB.addSessao({id:uid(),fichaId:S.workout.fichaId,dayIdx:S.workout.dayIdx,date:new Date().toISOString(),dur:Math.floor((Date.now()-S.workout.t0)/1000),exs:S.workout.exs.map(e=>({name:e.name,sets:e.sets}))});
      App.notify('Treino concluído!','workout');
      App._pushNotif('EVOLV — Treino','Treino finalizado. Excelente trabalho!',{tag:'evolv-workout'});
      App.resetSeries();
    }catch(e){App.toast('Erro ao salvar treino.');}
  }
  $('aw').classList.remove('open'); S.workout={on:false,minimized:false,exs:[]};
  App.updateWorkoutResume();
  if(S.page==='home') App.renderHome();
},

// ─── NOTIFICATIONS ───────────────────────────────────────────────
loadNotifications(){
  try{const raw=localStorage.getItem('evolv_notifications');if(raw)S.notifications=JSON.parse(raw);}catch{S.notifications=[];}
  App.renderNotifyBadge();
},

renderNotifyBadge(){
  const badge=$('notify-badge');if(!badge)return;
  const unread=S.notifications.filter(n=>!n.read).length;
  badge.textContent=unread>9?'9+':unread||'';
  badge.classList.toggle('has',unread>0);
  const btn=$('notify-btn');
  if(btn&&unread>0){btn.classList.add('np-bell-shake');setTimeout(()=>btn.classList.remove('np-bell-shake'),600);}
},

showNotifications(){
  App.closeModal();
  S.notifications.forEach(n=>n.read=true);
  localStorage.setItem('evolv_notifications',JSON.stringify(S.notifications));
  App.renderNotifyBadge();

  const m=document.createElement('div');m.className='mo';
  m.innerHTML=`<div class="md" style="padding-left:0;padding-right:0">
    <div class="mhandle" style="margin-left:auto;margin-right:auto"></div>
    <div style="display:flex;align-items:center;justify-content:space-between;padding:0 20px 14px;border-bottom:1px solid var(--line)">
      <div>
        <div style="font-size:20px;font-weight:700;letter-spacing:-0.02em">Notificações</div>
        <div style="font-size:11px;color:var(--t2);margin-top:2px">${S.notifications.length} registros</div>
      </div>
      ${S.notifications.length?`
        <button onclick="App.clearAllNotifications()" style="display:flex;align-items:center;gap:6px;height:34px;padding:0 14px;border-radius:10px;background:var(--red-dim);color:var(--red);border:none;cursor:pointer;font-size:12px;font-weight:600;font-family:inherit">
          ${IC.trash(13)} Limpar tudo
        </button>`:''}
    </div>
    <div id="np-perm-banner" style="padding:0 20px"></div>
    <div id="np-list" style="padding:0 20px;max-height:55vh;overflow-y:auto"></div>
    <div style="padding:14px 20px 0">
      <button class="btn bg" onclick="App.closeModal()">Fechar</button>
    </div>
  </div>`;
  m.addEventListener('click',e=>{if(e.target===m)App.closeModal();});
  $('mroot').appendChild(m);
  App._renderNotifItems();
  App._renderPermBanner();
},

_renderPermBanner(){
  const el=document.getElementById('np-perm-banner'); if(!el)return;
  const perm='Notification' in window?Notification.permission:'unsupported';
  if(perm==='granted'){el.innerHTML='';return;}
  el.innerHTML=`
    <div style="background:var(--bg-3);border:1px solid var(--line-2);border-radius:13px;padding:14px;margin:14px 0;display:flex;align-items:center;gap:12px">
      <div style="width:36px;height:36px;border-radius:10px;background:var(--cool-dim);color:var(--cool);display:flex;align-items:center;justify-content:center;flex-shrink:0">
        ${IC.bell(18)}
      </div>
      <div style="flex:1">
        <div style="font-size:13px;font-weight:600;margin-bottom:2px">Ativar notificações push</div>
        <div style="font-size:11.5px;color:var(--t1)">Alertas do timer no celular mesmo minimizado</div>
      </div>
      ${perm==='denied'
        ?`<div style="font-size:11px;color:var(--red);text-align:center;flex-shrink:0;line-height:1.3">Bloqueado<br>no browser</div>`
        :`<button onclick="App.requestNotifPermission()" style="height:36px;padding:0 14px;border-radius:10px;background:linear-gradient(135deg,var(--green),var(--green-2));color:#06140C;border:none;cursor:pointer;font-size:12px;font-weight:700;font-family:inherit;flex-shrink:0">Ativar</button>`
      }
    </div>`;
},

_renderNotifItems(){
  const el=document.getElementById('np-list'); if(!el)return;
  if(!S.notifications.length){
    el.innerHTML=`<div style="text-align:center;padding:40px 0;color:var(--t2)">
      <div style="width:56px;height:56px;border-radius:14px;background:var(--bg-3);border:1px solid var(--line);display:inline-flex;align-items:center;justify-content:center;margin-bottom:12px;color:var(--t3)">${IC.bell(24)}</div>
      <div style="font-size:14px;font-weight:600;color:var(--t1);margin-bottom:4px">Sem notificações</div>
      <div style="font-size:12px">As notificações aparecerão aqui</div>
    </div>`;
    return;
  }
  // [SEC-1] esc() em mensagens de notificação
  el.innerHTML=S.notifications.map(n=>{
    const cfg=NOTIF_CONFIG[n.type]||NOTIF_CONFIG.info;
    const timeStr=relTime(n.date);
    return `<div style="display:flex;align-items:flex-start;gap:12px;padding:13px 0;border-bottom:1px solid var(--line)">
      <div style="width:38px;height:38px;border-radius:11px;background:${cfg.bg};color:${cfg.color};display:flex;align-items:center;justify-content:center;flex-shrink:0;border:1px solid color-mix(in oklab,${cfg.color} 20%,transparent)">
        ${cfg.ic(16)}
      </div>
      <div style="flex:1;min-width:0">
        <div style="font-size:13.5px;font-weight:500;color:var(--t0);line-height:1.35">${esc(n.msg)}</div>
        <div style="font-size:11px;color:var(--t2);margin-top:4px;font-family:var(--mono)">${timeStr}</div>
      </div>
      <button onclick="App.deleteNotification('${esc(n.id)}')" title="Apagar"
        style="width:28px;height:28px;border-radius:8px;background:transparent;color:var(--t3);border:none;cursor:pointer;display:flex;align-items:center;justify-content:center;flex-shrink:0;transition:background .12s"
        onmouseenter="this.style.background='var(--red-dim)';this.style.color='var(--red)'"
        onmouseleave="this.style.background='transparent';this.style.color='var(--t3)'">
        ${IC.close(13)}
      </button>
    </div>`;
  }).join('');
},

deleteNotification(id){
  S.notifications=S.notifications.filter(n=>n.id!==id);
  localStorage.setItem('evolv_notifications',JSON.stringify(S.notifications));
  App.renderNotifyBadge();
  App._renderNotifItems();
  // Atualiza contador no cabeçalho
  const sub=document.querySelector('#mroot .mo .md div[style*="registros"]');
  if(sub) sub.textContent=`${S.notifications.length} registros`;
  // Esconde o botão "Limpar tudo" quando não há mais notificações
  const clearBtn=document.querySelector('#mroot .mo .md button[onclick*="clearAllNotifications"]');
  if(clearBtn) clearBtn.style.display=S.notifications.length?'':'none';
},

clearAllNotifications(){
  S.notifications=[];
  localStorage.removeItem('evolv_notifications');
  App.renderNotifyBadge();
  App.closeModal();
  App.showNotifications();
},

notify(msg,type='info'){
  const item={id:uid(),msg,type,date:new Date().toISOString(),read:false};
  S.notifications.unshift(item);
  if(S.notifications.length>50) S.notifications.length=50;
  localStorage.setItem('evolv_notifications',JSON.stringify(S.notifications));
  App.renderNotifyBadge();
  App.toast(msg);
},

// ─── SYNC ────────────────────────────────────────────────────────
showSyncModal(){
  App.closeModal();
  const sid=localStorage.getItem('evolv_sync_id')||'—';
  const m=document.createElement('div');m.className='mo';
  m.innerHTML=`<div class="md">
    <div class="mhandle"></div>
    <div style="display:flex;align-items:center;gap:10px;margin-bottom:18px">
      <div style="width:42px;height:42px;border-radius:12px;background:var(--cool-dim);color:var(--cool);display:flex;align-items:center;justify-content:center;flex-shrink:0">
        ${IC.sync(20)}
      </div>
      <div>
        <div style="font-size:19px;font-weight:700;letter-spacing:-0.01em">Sync entre dispositivos</div>
        <div style="font-size:12px;color:var(--t2);margin-top:1px">Acesse seus dados em qualquer aparelho</div>
      </div>
    </div>
    <div class="card" style="margin-bottom:10px">
      <div class="eyebrow" style="margin-bottom:10px">Seu código de sync</div>
      <div style="display:flex;gap:8px;align-items:center;margin-bottom:10px">
        <div style="flex:1;background:var(--bg-3);border:1px solid var(--line-2);border-radius:10px;padding:11px 14px;font-family:var(--mono);font-size:11.5px;color:var(--green);letter-spacing:0.04em;word-break:break-all">${esc(sid)}</div>
        <button onclick="(navigator.clipboard?.writeText('${esc(sid)}')||Promise.reject()).then(()=>App.toast('Código copiado!')).catch(()=>App.toast('Selecione e copie o código manualmente'))" style="width:40px;height:40px;border-radius:11px;background:var(--green-dim);color:var(--green);border:1px solid var(--green-line);cursor:pointer;display:flex;align-items:center;justify-content:center;flex-shrink:0">
          ${IC.clipboard(16)}
        </button>
      </div>
      <div style="font-size:12px;color:var(--t2);line-height:1.55">Compartilhe este código no outro aparelho para sincronizar todos os seus dados.</div>
    </div>
    <div class="card" style="margin-bottom:10px">
      <div class="eyebrow" style="margin-bottom:10px">Entrar com código de outro aparelho</div>
      <div class="ig" style="margin-bottom:10px">
        <input type="text" id="sync-code-input" placeholder="Cole o código aqui..." autocomplete="off" spellcheck="false" style="font-family:var(--mono);font-size:13px;letter-spacing:0.04em">
      </div>
      <button class="btn bp" onclick="App.applySyncCode()">${IC.sync(15)} Conectar e recarregar</button>
    </div>
    <div style="background:rgba(245,192,74,0.09);border:1px solid rgba(245,192,74,0.28);border-radius:12px;padding:13px;margin-bottom:14px">
      <div style="font-size:12px;color:var(--amber);line-height:1.6">
        <strong>⚠ Firebase Rules</strong> — Para o sync funcionar entre dispositivos, atualize as regras do Realtime Database em <em>console.firebase.google.com</em>:<br>
        <code style="display:block;margin-top:7px;background:var(--bg-3);border-radius:8px;padding:9px 11px;font-family:var(--mono);font-size:11px;color:var(--t0);white-space:pre-wrap;">"users": {
  "$uid": {
    ".read": "auth != null",
    ".write": "auth != null"
  }
}</code>
      </div>
    </div>
    <button class="btn bg" onclick="App.closeModal()">Fechar</button>
  </div>`;
  m.addEventListener('click',e=>{if(e.target===m)App.closeModal();});
  $('mroot').appendChild(m);
  setTimeout(()=>$('sync-code-input')?.focus(),200);
},

applySyncCode(){
  const code=($('sync-code-input')?.value||'').trim();
  if(code.length<10){App.toast('Código inválido — muito curto');return;}
  App.showConfirmDialog({
    title:'Trocar código de sync',
    message:'Seus dados serão substituídos pelos dados do código informado. O app vai recarregar.',
    confirmText:'Confirmar e recarregar',
    cancelText:'Cancelar',
    isDangerous:false,
    onConfirm:async()=>{
      localStorage.setItem('evolv_sync_id',code);
      App.toast('Aplicado! Recarregando...');
      setTimeout(()=>location.reload(),800);
    }
  });
},

// ─── FIREBASE SETUP ──────────────────────────────────────────────
showFBSetup(needsCfg=true){ $('loading').style.display='none'; $('fbsetup').classList.add('open'); },

saveFBConfig(){
  const raw=$('fb-cfg-input')?.value?.trim();
  try{
    const match=raw.match(/\{[\s\S]*\}/);
    if(!match) throw new Error();
    const cfg=JSON.parse(match[0]);
    if(!cfg.apiKey) throw new Error('missing apiKey');
    localStorage.setItem('evolv_fbcfg',JSON.stringify(cfg));
    localStorage.removeItem('evolv_offline');
    location.reload();
  }catch(e){App.toast('Config inválida. Verifique o JSON.');}
},

skipFBSetup(){
  localStorage.setItem('evolv_offline','1');
  $('fbsetup').classList.remove('open');
  DB._fallback(); App.boot();
},

// ─── [CACHE-WO] RECUPERAÇÃO DE TREINO ────────────────────────────
// Verifica se há treino em cache ao inicializar o app.
// Exibe um banner fixo (não-modal) para não bloquear a UI.
// O usuário pode retomar o treino ou descartar o cache.
checkWorkoutCache(){
  const cache = WorkoutCache.load();
  if(!cache) return;

  // Valida que a ficha ainda existe no banco
  const ficha = DB.fichas().find(f => f.id === cache.fichaId);
  if(!ficha){ WorkoutCache.clear(); return; }

  const day = ficha.days?.[cache.dayIdx];
  const ageLabel = WorkoutCache.ageLabel(cache.savedAt);
  const doneCount = cache.exs.reduce((a,e)=>a+e.sets.filter(s=>s.done).length,0);
  const totalCount = cache.exs.reduce((a,e)=>a+e.sets.length,0);

  // Cria banner de recuperação
  const banner = document.createElement('div');
  banner.id = 'wo-recovery-banner';
  banner.innerHTML = `
    <div style="
      position:fixed;bottom:calc(var(--nav-h) + 12px);left:14px;right:14px;
      background:var(--bg-2);border:1px solid var(--green-line);border-radius:18px;
      padding:14px 16px;z-index:90;
      box-shadow:0 8px 32px rgba(0,0,0,0.5), 0 0 0 1px rgba(31,224,122,0.12);
      animation:mslide .3s cubic-bezier(0.32,0.72,0,1);
    ">
      <div style="display:flex;align-items:center;gap:12px">
        <div style="
          width:42px;height:42px;border-radius:13px;flex-shrink:0;
          background:var(--green-dim);color:var(--green);
          border:1px solid var(--green-line);
          display:flex;align-items:center;justify-content:center;
        ">${IC.activity(20)}</div>
        <div style="flex:1;min-width:0">
          <div style="font-size:13.5px;font-weight:700;color:var(--t0);line-height:1.2">
            Treino interrompido
          </div>
          <div style="font-size:12px;color:var(--t2);margin-top:3px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">
            ${esc(day?.name || ficha.name)} · ${doneCount}/${totalCount} séries · ${ageLabel}
          </div>
        </div>
        <button id="wo-recovery-dismiss" style="
          width:28px;height:28px;border-radius:8px;flex-shrink:0;
          background:var(--bg-3);color:var(--t2);border:1px solid var(--line);
          display:flex;align-items:center;justify-content:center;cursor:pointer;
        ">${IC.close(13)}</button>
      </div>
      <div style="display:flex;gap:8px;margin-top:12px">
        <button id="wo-recovery-discard" class="btn bg sm" style="flex:1">
          Descartar
        </button>
        <button id="wo-recovery-resume" class="btn bp sm" style="flex:2">
          ${IC.play(13)} Retomar treino
        </button>
      </div>
    </div>
  `;
  document.body.appendChild(banner);

  // Retomar treino
  document.getElementById('wo-recovery-resume').addEventListener('click', () => {
    banner.remove();
    App._restoreWorkoutFromCache(cache, ficha, day);
  });

  // Descartar cache
  document.getElementById('wo-recovery-discard').addEventListener('click', () => {
    WorkoutCache.clear();
    banner.remove();
    App.toast('Treino descartado.');
  });

  // Fechar banner (mantém cache para próxima vez)
  document.getElementById('wo-recovery-dismiss').addEventListener('click', () => {
    banner.remove();
  });
},

// Restaura o estado completo do treino a partir do cache
_restoreWorkoutFromCache(cache, ficha, day){
  App.resetSeries();
  App.resetTimer();

  S.workout = {
    on: true,
    minimized: false,
    fichaId: cache.fichaId,
    dayIdx:  cache.dayIdx,
    t0:      cache.t0,        // mantém o t0 original para duração correta
    iv:      null,
    exs:     cache.exs,       // restaura sets/cargas/reps/done exatamente
  };

  const dayName = day?.name || ficha.name;
  $('aw').classList.add('open');
  $('aw-title').textContent = dayName;
  App.updateWorkoutResume();

  // Reinicia o cronômetro visual a partir do t0 original
  S.workout.iv = setInterval(() => {
    const el = $('aw-timer');
    if(el) el.textContent = ft(Math.floor((Date.now() - S.workout.t0) / 1000));
    if(Math.floor((Date.now() - S.workout.t0) / 1000) % 10 === 0) WorkoutCache.save();
  }, 1000);

  // Recalcula e restaura o contador de séries feitas
  const doneCount = cache.exs.reduce((a,e)=>a+e.sets.filter(s=>s.done).length,0);
  S.series = doneCount;
  const scNum = $('sc-num');
  if(scNum){ scNum.textContent = doneCount; scNum.style.color = doneCount > 0 ? 'var(--green)' : 'var(--t0)'; }

  App.renderAW(true);
  App.toast('Treino restaurado!');
},

// ─── [UPDATE] SISTEMA DE ATUALIZAÇÃO ────────────────────────────
// Detecta quando o Service Worker registrou uma nova versão (estado
// 'installing' → 'installed'). Exibe um banner não-intrusivo com
// "Atualizar agora" (skipWaiting + reload) e "Depois" (descarta).
//
// O SW precisa responder à mensagem {type:'SKIP_WAITING'} para que
// o skipWaiting funcione a partir da página. O SW atualizado neste
// arquivo já inclui esse listener.
_swReg: null,  // guarda a registration para uso posterior

initUpdateSystem(){
  if(!('serviceWorker' in navigator)) return;
  navigator.serviceWorker.ready.then(reg => {
    App._swReg = reg;

    // Verifica se já há um worker instalado aguardando (SW atualizado
    // enquanto o app estava em background)
    if(reg.waiting){
      App._showUpdateBanner(reg.waiting);
      return;
    }

    // Escuta novos workers que entrem no estado 'installed'
    reg.addEventListener('updatefound', () => {
      const newWorker = reg.installing;
      if(!newWorker) return;
      newWorker.addEventListener('statechange', () => {
        if(newWorker.state === 'installed' && navigator.serviceWorker.controller){
          // Novo worker instalado e pronto, mas ainda não ativo
          App._showUpdateBanner(newWorker);
        }
      });
    });
  }).catch(() => {});

  // Quando o SW ativo muda (após skipWaiting), recarrega automaticamente
  let refreshing = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if(refreshing) return;
    refreshing = true;
    window.location.reload();
  });
},

_showUpdateBanner(worker){
  if(document.getElementById('update-banner')) return;

  const banner = document.createElement('div');
  banner.id = 'update-banner';
  banner.innerHTML = `
    <div id="update-overlay" style="
      position:fixed;inset:0;
      background:rgba(8,9,12,0.55);
      backdrop-filter:blur(6px);
      -webkit-backdrop-filter:blur(6px);
      z-index:94;
      animation:mfade .3s ease;
    "></div>
    <div style="
      position:fixed;top:calc(var(--hdr-h) + var(--st) + 14px);
      left:14px;right:14px;
      background:var(--bg-2);
      border:1px solid var(--green-line);
      border-top:2px solid var(--green);
      border-radius:18px;
      padding:16px;
      z-index:95;
      box-shadow:0 12px 40px rgba(0,0,0,0.6), var(--green-glow);
      animation:fadeUp .32s cubic-bezier(0.22,0.95,0.32,1);
    ">
      <div style="display:flex;align-items:center;gap:12px;margin-bottom:14px">
        <div style="
          width:42px;height:42px;border-radius:13px;flex-shrink:0;
          background:var(--green-dim);color:var(--green);
          border:1px solid var(--green-line);
          display:flex;align-items:center;justify-content:center;
        ">${IC.sync(20)}</div>
        <div style="flex:1;min-width:0">
          <div style="font-size:14px;font-weight:700;color:var(--t0);letter-spacing:-0.01em">
            Nova versão disponível
          </div>
          <div style="font-size:12px;color:var(--t2);margin-top:3px">
            Atualize para obter melhorias e correções
          </div>
        </div>
      </div>
      <div style="display:flex;gap:8px">
        <button id="update-later" class="btn bg sm" style="flex:1">
          Depois
        </button>
        <button id="update-now" class="btn bp sm" style="flex:2">
          ${IC.sync(13)} Atualizar agora
        </button>
      </div>
    </div>
  `;
  document.body.appendChild(banner);
  document.body.appendChild(banner);

  // Atualizar agora: envia mensagem para o SW fazer skipWaiting
  document.getElementById('update-now').addEventListener('click', () => {
    if(S.workout.on){
      App.showConfirmDialog({
        title: 'Atualizar durante treino',
        message: 'O treino está em andamento e foi salvo em cache. Será restaurado após a atualização.',
        confirmText: 'Atualizar mesmo assim',
        cancelText:  'Cancelar',
        isDangerous: false,
        onConfirm: () => { WorkoutCache.save(); worker.postMessage({type:'SKIP_WAITING'}); },
      });
    } else {
      worker.postMessage({type:'SKIP_WAITING'});
    }
  });

  // Depois: remove banner + overlay
  document.getElementById('update-later').addEventListener('click', () => {
    banner.remove();
  });
},

// ─── BOOT ────────────────────────────────────────────────────────
boot(){
  $('loading').style.display='none'; $('app').style.display='flex';
  App.loadNotifications();
  App.renderTimerTicks();
  App.updTimer();
  App.renderHome();
  App.updateDot();
  try{App.sound.init();}catch{}

  document.addEventListener('click',e=>{
    try{ if(!App.sound.enabled)return; const btn=e.target.closest('button,.ni,.icon-btn'); if(btn)App.sound.play('click'); }catch{}
  },{capture:false});

  window.addEventListener('beforeinstallprompt',e=>{e.preventDefault();App._ip=e;});

  // [TIMER] Registra listener de visibilidade para corrigir timer após background
  document.addEventListener('visibilitychange', App._onVisibilityChange);

  // [CACHE-WO] Verifica treino interrompido após o DB estar pronto
  // (pequeno delay para garantir que o DOM da home já está renderizado)
  setTimeout(() => App.checkWorkoutCache(), 600);

  // [UPDATE] Inicia sistema de detecção de atualizações do SW
  App.initUpdateSystem();

  // [SWIPE] Ativa gesto pull-to-dismiss em todos os modais
  App._initSwipeObserver();

  // CSS de animação do sino
  if(!document.getElementById('evolv-notif-styles')){
    const s=document.createElement('style');
    s.id='evolv-notif-styles';
    s.textContent=`
      @keyframes np-shake{0%,100%{transform:rotate(0)}15%{transform:rotate(18deg)}30%{transform:rotate(-14deg)}45%{transform:rotate(10deg)}60%{transform:rotate(-6deg)}75%{transform:rotate(3deg)}}
      .np-bell-shake svg{animation:np-shake .55s ease}
      #notify-btn{transition:background .15s}
      #notify-btn:hover{background:var(--bg-3)}
      #nav{position:fixed!important;left:14px!important;right:14px!important;bottom:0!important;flex-shrink:0;height:var(--nav-h)!important;border-radius:20px 20px 0 0!important;border:1px solid var(--line-2)!important;border-bottom:0!important;align-items:center!important;padding:0 6px!important;box-shadow:0 -12px 32px rgba(0,0,0,.35)!important}
      .ni{position:relative!important}
      .ni + .ni::before{content:'';position:absolute;left:0;top:13px;bottom:13px;width:1px;background:var(--line-2)}
      .ni.active{background:transparent!important}
      #app{padding-bottom:0!important}
      #pages{margin-bottom:var(--nav-h)!important}
      .page{padding-bottom:18px!important}
      @supports (height:100dvh){html,body,#app{height:100dvh!important}}
      @supports (-webkit-touch-callout:none){html{height:-webkit-fill-available!important}body,#app{min-height:-webkit-fill-available!important}}
    `;
    document.head.appendChild(s);
  }
},

updateDot(){
  const dot=$('status-dot');if(!dot)return;
  const on=DB._local?false:(DB._online!==false);
  dot.classList.toggle('off',!on);
  if(DB._local){
    dot.title='Modo offline — clique para reconectar';
    dot.style.cursor='pointer';
    dot.onclick=()=>App.showReconnectModal();
  } else {
    dot.title=on?'Firebase OK — clique para sync':'Sem conexão';
    dot.style.cursor=on?'pointer':'default';
    dot.onclick=on?()=>App.showSyncModal():null;
  }
},

showReconnectModal(){
  App.closeModal();
  const m=document.createElement('div');m.className='mo';
  m.innerHTML=`<div class="md">
    <div class="mhandle"></div>
    <div class="mtitle">Modo offline</div>
    <div style="background:var(--bg-3);border:1px solid var(--line-2);border-radius:13px;padding:14px;margin-bottom:18px">
      <div style="font-size:13px;font-weight:600;margin-bottom:4px">Os dados estão salvos localmente</div>
      <div style="font-size:12px;color:var(--t1);line-height:1.5">
        Para sincronizar com o Firebase e acessar em outros dispositivos, reconecte abaixo.
      </div>
    </div>
    <button class="btn bp lg" onclick="localStorage.removeItem('evolv_offline');location.reload()" style="margin-bottom:8px">
      ${IC.check(16)} Reconectar ao Firebase
    </button>
    <button class="btn bg" onclick="App.showFBSetup();App.closeModal()" style="margin-bottom:8px">Reconfigurar Firebase</button>
    <button class="btn bg" onclick="App.closeModal()">Continuar offline</button>
  </div>`;
  m.addEventListener('click',e=>{if(e.target===m)App.closeModal();});
  $('mroot').appendChild(m);
},

closeModal(){ document.querySelectorAll('.mo').forEach(m=>m.remove()); },

// ─── SWIPE TO DISMISS ────────────────────────────────────────────
// Aplica o gesto de arrastar para baixo em qualquer .md (sheet modal)
// dentro de #mroot. Centralizado via MutationObserver — funciona
// automaticamente em todos os modais existentes e futuros sem
// precisar tocar em cada um individualmente.
//
// Comportamento:
//  - Arrasto < 80px  → volta ao lugar com spring (transition)
//  - Arrasto ≥ 80px  → dismiss com animação de saída
//  - Velocidade > 400px/s → dismiss imediato (flick)
//  - Scroll vertical dentro do .md não é confundido com swipe
_attachSwipeToDismiss(md){
  if(md._swipeAttached) return;
  md._swipeAttached = true;

  const THRESHOLD  = 80;    // px para dismiss
  const VELOCITY   = 0.4;   // px/ms para flick
  const mo = md.closest('.mo');

  let startY=0, startX=0, curY=0, t0=0, dragging=false, scrollLocked=false;

  const onStart = e => {
    const touch = e.touches?.[0] || e;
    startY  = touch.clientY;
    startX  = touch.clientX;
    curY    = 0;
    t0      = Date.now();
    dragging    = false;
    scrollLocked = false;
    md.style.transition = 'none';
  };

  const onMove = e => {
    const touch = e.touches?.[0] || e;
    const dy = touch.clientY - startY;
    const dx = touch.clientX - startX;

    // Determina intenção apenas uma vez por gesto
    if(!dragging && !scrollLocked){
      if(Math.abs(dy) < 6 && Math.abs(dx) < 6) return; // ainda indeciso
      if(Math.abs(dx) > Math.abs(dy)){
        scrollLocked = true; // gesto horizontal → ignora
        return;
      }
      if(dy < 0){
        scrollLocked = true; // arrastar para cima → scroll normal
        return;
      }
      // Verifica se o elemento que iniciou o toque ainda tem scroll a dar
      const target = e.target.closest('[style*="overflow"],[class*="scroll"],.md');
      if(target && target !== md){
        const { scrollTop } = target;
        if(scrollTop > 0){ scrollLocked = true; return; }
      }
      dragging = true;
    }

    if(!dragging) return;
    e.preventDefault();

    curY = Math.max(0, dy); // só para baixo
    // Resistência suave quando além do threshold
    const effective = curY > THRESHOLD
      ? THRESHOLD + (curY - THRESHOLD) * 0.3
      : curY;
    md.style.transform = `translateY(${effective}px)`;
    // Fade no overlay proporcional ao arrasto
    if(mo) mo.style.background = `rgba(0,0,0,${0.6 * Math.max(0, 1 - curY / 260)})`;
  };

  const onEnd = () => {
    if(!dragging){ md.style.transition=''; md.style.transform=''; return; }
    const elapsed = Date.now() - t0;
    const velocity = curY / elapsed; // px/ms

    if(curY >= THRESHOLD || velocity >= VELOCITY){
      // Dismiss com animação de saída
      md.style.transition = 'transform .22s cubic-bezier(0.32,0,0.67,0)';
      md.style.transform  = `translateY(105%)`;
      if(mo){ mo.style.transition='background .22s'; mo.style.background='rgba(0,0,0,0)'; }
      setTimeout(()=>App.closeModal(), 220);
    } else {
      // Volta com spring
      md.style.transition = 'transform .35s cubic-bezier(0.34,1.56,0.64,1)';
      md.style.transform  = 'translateY(0)';
      if(mo){ mo.style.transition='background .35s'; mo.style.background=''; }
    }
    dragging = false;
  };

  // Touch (mobile)
  md.addEventListener('touchstart', onStart, {passive:true});
  md.addEventListener('touchmove',  onMove,  {passive:false});
  md.addEventListener('touchend',   onEnd,   {passive:true});
  md.addEventListener('touchcancel',onEnd,   {passive:true});
},

// Inicializa o observer — chamado no boot
_initSwipeObserver(){
  const root = document.getElementById('mroot');
  if(!root) return;
  const obs = new MutationObserver(mutations => {
    mutations.forEach(m => {
      m.addedNodes.forEach(node => {
        if(node.nodeType !== 1) return;
        // Aplica ao .md diretamente adicionado ou a filhos .md
        const mds = node.classList?.contains('md')
          ? [node]
          : [...node.querySelectorAll('.md')];
        mds.forEach(md => App._attachSwipeToDismiss(md));
      });
    });
  });
  obs.observe(root, {childList:true, subtree:true});
},

toast(msg){
  document.querySelectorAll('.toast').forEach(t=>t.remove());
  const t=document.createElement('div');t.className='toast';t.textContent=msg;
  document.body.appendChild(t); setTimeout(()=>t.remove(),2800);
},

};

// ─── PWA ─────────────────────────────────────────────────────────
// ─── PWA — Service Worker ────────────────────────────────────────
// O SW é um arquivo físico (sw.js) e não um Blob inline.
// Isso é OBRIGATÓRIO para o sistema de atualização funcionar:
// o browser só detecta "nova versão disponível" quando consegue
// comparar o conteúdo do sw.js entre duas requisições HTTP.
// Com Blob URLs isso é impossível — cada registro gera uma URL
// única e o browser nunca sabe se é o mesmo SW ou um novo.
//
// PARA PUBLICAR UMA ATUALIZAÇÃO DO APP:
//  1. Incremente CACHE_NAME em sw.js  (ex: evolv-v16 → evolv-v17)
//  2. Suba sw.js junto com os demais arquivos alterados
//  3. O banner "Nova versão disponível" aparece automaticamente
// ─────────────────────────────────────────────────────────────────
if ('serviceWorker' in navigator) {
  navigator.serviceWorker
    .register('./sw.js')
    .catch(() => {});
}
(()=>{
  // [ICON] Dois entries separados para o mesmo arquivo:
  //  - "any"      → Android/Chrome usa o ícone sem máscara (preserva bordas arredondadas e fundo escuro)
  //  - "maskable" → sistemas que exigem maskable usam este entry, mas como o ícone já tem
  //                 safe zone adequada (fundo escuro cobrindo toda a área) o resultado é correto
  // NÃO combine "any maskable" num único entry: isso faz o Chrome Android aplicar
  // a máscara circular e recortar o ícone, gerando a borda branca indesejada.
  const icons = [
    { src:'icon.png', sizes:'192x192', type:'image/png', purpose:'any' },
    { src:'icon.png', sizes:'512x512', type:'image/png', purpose:'any' },
    { src:'icon.png', sizes:'512x512', type:'image/png', purpose:'maskable' },
  ];
  const mf = {
    name: 'EVOLV',
    short_name: 'EVOLV',
    description: 'Aplicativo de gestão de treinos',
    theme_color: '#0E1015',
    background_color: '#0E1015',   // cor usada no splash screen, deve combinar com o ícone
    display: 'standalone',
    orientation: 'portrait',
    start_url: '.',
    scope: '.',
    icons,
  };
  const l = document.createElement('link');
  l.rel = 'manifest';
  l.href = URL.createObjectURL(new Blob([JSON.stringify(mf)], {type:'application/json'}));
  document.head.appendChild(l);
})();

// ─── INIT ────────────────────────────────────────────────────────
window.App=App; window.DB=DB; window.S=S;

DB.init().then(()=>{
  DB.whenReady.then(()=>App.boot());
  setTimeout(()=>{ if(!DB.ready){DB.ready=true;DB._resolveReady();} },6000);
});