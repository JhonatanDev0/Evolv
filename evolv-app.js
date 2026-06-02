// ═══════════════════════════════════════════════════════════════
// EVOLV — app logic
// Correções v2:
//  [SEC-1] Escape de HTML em todos os templates com dados do usuário (XSS)
//  [SEC-2] Sanitização de fichas importadas via JSON
//  [TIMER] Timer resiliente a background via timestamp (iOS/PWA safe)
//  [PERF]  renderAW() com atualização cirúrgica de checkboxes/progresso
//
// Melhorias v3:
//  [CACHE-WO] Cache de treino em andamento
//  [UPDATE]   Sistema de atualização via Service Worker
//
// Infra v4:
//  [IDB]      IndexedDB como storage local persistente (substitui localStorage)
//  [SYNC]     Fila de sync offline — writes enfileirados, drenados ao reconectar
//  [DOT]      Status dot com 3 estados: online / offline / sincronizando
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

// ─── [IDB] IndexedDB wrapper ──────────────────────────────────────
// Substitui localStorage para dados do usuário.
// API simétrica ao localStorage mas assíncrona e sem limite de 5MB.
// Stores: fichas | sessoes | pesos | prefs | sync_queue
const IDB = {
  _db: null,
  DB_NAME: 'evolv_db',
  DB_VER:  2,
  STORES:  ['fichas','sessoes','pesos','prefs','sync_queue'],

  async open(){
    if(IDB._db) return IDB._db;
    return new Promise((res, rej)=>{
      const req = indexedDB.open(IDB.DB_NAME, IDB.DB_VER);
      req.onupgradeneeded = e=>{
        const db = e.target.result;
        IDB.STORES.forEach(name=>{
          if(!db.objectStoreNames.contains(name))
            db.createObjectStore(name, {keyPath: name==='prefs'?'key':'id'});
        });
      };
      req.onsuccess = e=>{ IDB._db = e.target.result; res(IDB._db); };
      req.onerror   = e=>rej(e.target.error);
    });
  },

  async getAll(store){
    const db = await IDB.open();
    return new Promise((res, rej)=>{
      const tx  = db.transaction(store,'readonly');
      const req = tx.objectStore(store).getAll();
      req.onsuccess = ()=>res(req.result||[]);
      req.onerror   = ()=>rej(req.error);
    });
  },

  async put(store, obj){
    const db = await IDB.open();
    return new Promise((res, rej)=>{
      const tx  = db.transaction(store,'readwrite');
      const req = tx.objectStore(store).put(obj);
      req.onsuccess = ()=>res();
      req.onerror   = ()=>rej(req.error);
    });
  },

  async del(store, id){
    const db = await IDB.open();
    return new Promise((res, rej)=>{
      const tx  = db.transaction(store,'readwrite');
      const req = tx.objectStore(store).delete(id);
      req.onsuccess = ()=>res();
      req.onerror   = ()=>rej(req.error);
    });
  },

  async clear(store){
    const db = await IDB.open();
    return new Promise((res, rej)=>{
      const tx  = db.transaction(store,'readwrite');
      const req = tx.objectStore(store).clear();
      req.onsuccess = ()=>res();
      req.onerror   = ()=>rej(req.error);
    });
  },

  // Salva array inteiro substituindo store
  async setAll(store, items){
    const db = await IDB.open();
    return new Promise((res, rej)=>{
      const tx = db.transaction(store,'readwrite');
      const os = tx.objectStore(store);
      os.clear();
      items.forEach(item=>os.put(item));
      tx.oncomplete = ()=>res();
      tx.onerror    = ()=>rej(tx.error);
    });
  },

  // Prefs: { key, value } pairs
  async getPref(key){
    const db = await IDB.open();
    return new Promise((res)=>{
      const tx  = db.transaction('prefs','readonly');
      const req = tx.objectStore('prefs').get(key);
      req.onsuccess = ()=>res(req.result?.value);
      req.onerror   = ()=>res(undefined);
    });
  },

  async setPref(key, value){
    return IDB.put('prefs', {key, value});
  },

  // Migra dados do localStorage para IDB (roda uma vez)
  async migrateFromLocalStorage(){
    if(localStorage.getItem('evolv_idb_migrated')) return;
    try{
      const g = k=>{ try{ return JSON.parse(localStorage.getItem('ev_'+k))||[]; }catch{ return []; } };
      const fichas  = g('fichas');
      const sessoes = g('sessoes');
      const pesos   = g('pesos');
      const prefs   = (() => { try{ return JSON.parse(localStorage.getItem('ev_prefs'))||{}; }catch{ return {}; } })();
      if(fichas.length)  await IDB.setAll('fichas',  fichas);
      if(sessoes.length) await IDB.setAll('sessoes', sessoes);
      if(pesos.length)   await IDB.setAll('pesos',   pesos);
      // Migra prefs para formato key/value
      for(const [k,v] of Object.entries(prefs)) await IDB.setPref(k,v);
      localStorage.setItem('evolv_idb_migrated','1');
      console.info('[EVOLV] Dados migrados localStorage → IDB');
    }catch(e){
      console.warn('[EVOLV] Migração IDB falhou (não crítico):', e);
    }
  },
};

// ─── [SYNC] Fila de operações offline ────────────────────────────
// Cada item: { id, op:'set'|'update'|'remove', col, docId, data, ts }
// Quando online, drena a fila em ordem e sincroniza com Firebase.
const SyncQueue = {
  _draining: false,

  async push(op, col, docId, data=null){
    const item = { id: uid(), op, col, docId, data, ts: Date.now() };
    await IDB.put('sync_queue', item);
    SyncQueue._notifyPending();
  },

  async drain(){
    if(SyncQueue._draining || !DB._db || !DB._uid) return;
    const items = await IDB.getAll('sync_queue');
    if(!items.length) return;

    SyncQueue._draining = true;
    SyncQueue._setSyncing(true);

    for(const item of items.sort((a,b)=>a.ts-b.ts)){
      try{
        const ref = DB._db.ref(`users/${DB._uid}/${item.col}/${item.docId}`);
        if(item.op==='set')    await ref.set(item.data);
        if(item.op==='update') await ref.update(item.data);
        if(item.op==='remove') await ref.remove();
        await IDB.del('sync_queue', item.id);
      }catch(e){
        console.warn('[EVOLV] Sync queue erro:', e);
        break; // Para na primeira falha e tenta de novo depois
      }
    }

    SyncQueue._draining = false;
    const remaining = await IDB.getAll('sync_queue');
    SyncQueue._setSyncing(false);
    if(remaining.length) SyncQueue._notifyPending();
    else App.updateDot();
  },

  async count(){
    const items = await IDB.getAll('sync_queue');
    return items.length;
  },

  _setSyncing(v){
    DB._syncing = v;
    App.updateDot();
  },

  _notifyPending(){
    App.updateDot();
  },
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
  cache:{fichas:[],sessoes:[],pesos:[],prefs:{}},
  ready:false, _local:false, _db:null, _uid:null,
  _loadCount:0, _resolveReady:null, _online:true, _syncing:false,

  async init(){
    // Migra dados antigos do localStorage para IDB (roda uma vez)
    await IDB.migrateFromLocalStorage();

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
      await DB._fallback();
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

      DB._listen('fichas'); DB._listen('sessoes'); DB._listen('pesos'); DB._listenPrefs();
      DB._migratePrefs();

      // Monitora conectividade — ao reconectar, drena a fila pendente
      window.addEventListener('online', async ()=>{
        DB._online = true;
        App.updateDot();
        await SyncQueue.drain();
      });
      window.addEventListener('offline', ()=>{
        DB._online = false;
        App.updateDot();
        App.toast('Sem conexão — dados salvos localmente');
      });
      DB._online = navigator.onLine;

      // Drena fila pendente imediatamente se houver items do boot offline
      if(DB._online) await SyncQueue.drain();

    }catch(e){
      console.error('[EVOLV] Firebase falhou:', e.code || e.message);
      await DB._fallback();
      const msg = e.code === 'auth/network-request-failed'
        ? 'Sem conexão — dados salvos localmente'
        : e.message?.includes('databaseURL') || e.code === 'app/invalid-credential'
          ? 'Config Firebase inválida — verifique databaseURL'
          : 'Firebase indisponível — dados salvos localmente';
      setTimeout(()=>App && App.toast && App.toast(`⚠️ ${msg}`), 1200);
    }
  },

  _col(n){ return DB._db.ref(`users/${DB._uid}/${n}`); },

  _listen(name){
    DB._col(name).on('value', snap=>{
      const data = snap.val() || {};
      DB.cache[name] = Object.keys(data).map(id=>({id,...data[id]}));
      if(name==='pesos')   DB.cache.pesos.sort((a,b)=>a.date.localeCompare(b.date));
      if(name==='sessoes') DB.cache.sessoes.sort((a,b)=>a.date.localeCompare(b.date));
      if(name==='fichas')  DB.cache.fichas.sort((a,b)=>(a.at||0)-(b.at||0));
      // Espelha no IDB para acesso offline
      IDB.setAll(name, DB.cache[name]).catch(()=>{});
      DB._loadCount++;
      if(DB._loadCount >= 4 && !DB.ready){ DB.ready=true; DB._resolveReady(); }
      else if(DB.ready){ App.renderPage(S.page); }
    }, err=>{ DB._loadCount++; if(DB._loadCount>=4 && !DB.ready){DB.ready=true; DB._resolveReady();} });
  },

  // Fallback: carrega do IDB (dados espelhados da última sessão online)
  async _fallback(){
    DB._local = true;
    try{
      const [fichas, sessoes, pesos] = await Promise.all([
        IDB.getAll('fichas'),
        IDB.getAll('sessoes'),
        IDB.getAll('pesos'),
      ]);
      // Carrega prefs do IDB
      const prefKeys = ['weekTarget','pesoGoal','restTime','theme','onboarded','displayName'];
      const prefsArr = await Promise.all(prefKeys.map(async k=>({ k, v: await IDB.getPref(k) })));
      const prefs = {};
      prefsArr.forEach(({k,v})=>{ if(v!==undefined) prefs[k]=v; });
      // Fallback para localStorage legado se IDB estiver vazio
      if(!Object.keys(prefs).length){
        try{
          const legacy = JSON.parse(localStorage.getItem('ev_prefs')||'{}');
          Object.assign(prefs, legacy);
        }catch{}
      }
      DB.cache = { fichas, sessoes, pesos: pesos.sort((a,b)=>a.date.localeCompare(b.date)), prefs };
    }catch(e){
      console.warn('[EVOLV] IDB fallback falhou, usando localStorage:', e);
      const g = k=>{ try{ return JSON.parse(localStorage.getItem('ev_'+k))||[]; }catch{ return []; } };
      const prefsLocal = (() => { try{ return JSON.parse(localStorage.getItem('ev_prefs'))||{}; }catch{ return {}; } })();
      DB.cache = { fichas:g('fichas'), sessoes:g('sessoes'), pesos:g('pesos'), prefs:prefsLocal };
    }
    DB.ready = true;
    DB._resolveReady();
  },

  // Escreve para Firebase OU enfileira se offline
  async _write(op, col, docId, data=null){
    if(!DB._local && DB._online && DB._db){
      try{
        const ref = DB._col(col).child(docId);
        if(op==='set')    await ref.set(data);
        if(op==='update') await ref.update(data);
        if(op==='remove') await ref.remove();
        return;
      }catch(e){
        console.warn('[EVOLV] Write falhou, enfileirando:', e);
      }
    }
    // Offline ou Firebase indisponível: enfileira
    if(!DB._local) await SyncQueue.push(op, col, docId, data);
  },

  fichas:()=>DB.cache.fichas,
  sessoes:()=>DB.cache.sessoes,
  pesos:()=>DB.cache.pesos,

  async addFicha(d){
    DB.cache.fichas.push(d);
    await IDB.put('fichas', d);
    if(DB._local){ return; }
    await DB._write('set','fichas',d.id,d);
  },
  async updFicha(id,d){
    const i = DB.cache.fichas.findIndex(f=>f.id===id);
    if(i>=0){ DB.cache.fichas[i]={...DB.cache.fichas[i],...d}; await IDB.put('fichas', DB.cache.fichas[i]); }
    if(DB._local){ return; }
    await DB._write('update','fichas',id,d);
  },
  async delFicha(id){
    DB.cache.fichas = DB.cache.fichas.filter(f=>f.id!==id);
    await IDB.del('fichas', id);
    if(DB._local){ return; }
    await DB._write('remove','fichas',id);
  },
  async addSessao(d){
    DB.cache.sessoes.push(d);
    await IDB.put('sessoes', d);
    if(DB._local){ return; }
    await DB._write('set','sessoes',d.id,d);
  },
  async delSessao(id){
    DB.cache.sessoes = DB.cache.sessoes.filter(s=>s.id!==id);
    await IDB.del('sessoes', id);
    if(DB._local){ return; }
    await DB._write('remove','sessoes',id);
  },
  async addPeso(d){
    DB.cache.pesos.push(d);
    DB.cache.pesos.sort((a,b)=>a.date.localeCompare(b.date));
    await IDB.put('pesos', d);
    if(DB._local){ return; }
    await DB._write('set','pesos',d.id,d);
  },
  async delPeso(id){
    DB.cache.pesos = DB.cache.pesos.filter(p=>p.id!==id);
    await IDB.del('pesos', id);
    if(DB._local){ return; }
    await DB._write('remove','pesos',id);
  },

  // ─── PREFS ───────────────────────────────────────────────────
  getPrefs(){ return DB.cache.prefs||{}; },

  getPref(key, defaultVal){
    const v = DB.cache.prefs?.[key];
    return v !== undefined ? v : defaultVal;
  },

  async setPref(key, value){
    DB.cache.prefs = {...(DB.cache.prefs||{}), [key]:value};
    // Persiste no IDB sempre
    await IDB.setPref(key, value);
    if(DB._local){ return; }
    // Firebase: update direto no nó prefs (não passa por _write para evitar path errado)
    if(DB._online && DB._db){
      try{
        await DB._col('prefs').update({[key]: value});
        return;
      }catch(e){
        console.warn('[EVOLV] setPref Firebase falhou, enfileirando:', e);
      }
    }
    // Offline: enfileira com path correto
    await SyncQueue.push('update', 'prefs', '', {[key]: value});
  },

  _listenPrefs(){
    DB._col('prefs').on('value', snap=>{
      DB.cache.prefs = snap.val() || {};
      // Espelha prefs no IDB
      Object.entries(DB.cache.prefs).forEach(([k,v])=>IDB.setPref(k,v).catch(()=>{}));
      DB._loadCount++;
      if(DB._loadCount >= 4 && !DB.ready){ DB.ready=true; DB._resolveReady(); }
      else if(DB.ready){ App.renderPage(S.page); }
    }, ()=>{ DB._loadCount++; if(DB._loadCount>=4 && !DB.ready){DB.ready=true; DB._resolveReady();} });
  },

  async _migratePrefs(){
    if(DB._local) return;
    const migrated = localStorage.getItem('ev_prefs_migrated');
    if(migrated) return;
    const patch = {};
    const wt = localStorage.getItem('evolv_week_target');
    if(wt) patch.weekTarget = +wt;
    const pg = localStorage.getItem('evolv_peso_goal');
    if(pg) patch.pesoGoal = +pg;
    if(Object.keys(patch).length){
      await DB._col('prefs').update(patch);
      console.info('[EVOLV] Prefs migradas para Firebase:', patch);
    }
    localStorage.setItem('ev_prefs_migrated', '1');
  },
};
DB.whenReady = new Promise(r=>{DB._resolveReady=r;});

// ─── STATE ───────────────────────────────────────────────────────
const S = {
  page:'home', series:0,
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
// Retorna a data LOCAL de hoje no formato YYYY-MM-DD (sem conversão UTC)
const today=()=>{
  const n=new Date();
  return `${n.getFullYear()}-${String(n.getMonth()+1).padStart(2,'0')}-${String(n.getDate()).padStart(2,'0')}`;
};
// Converte qualquer ISO string para data LOCAL no formato YYYY-MM-DD
// Evita o bug de fuso: "2026-06-01T03:00:00.000Z".slice(0,10) = "2026-05-31" (UTC-3)
const localDate=(iso)=>{
  if(!iso) return '';
  const d = new Date(iso);
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
};
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
  const prev = S.page;
  S.page = p;

  document.querySelectorAll('.ni').forEach(el=>el.classList.remove('active'));
  document.querySelector(`[data-p="${p}"]`)?.classList.add('active');

  const incoming = $('pg-' + p);
  const outgoing = prev && prev !== p ? $('pg-' + prev) : null;

  // Renderiza conteúdo antes de animar
  App.renderPage(p);

  // Fade-in na página que entra
  incoming.style.opacity = '0';
  incoming.style.transition = 'none';
  incoming.offsetHeight; // reflow

  document.querySelectorAll('.page').forEach(el => el.classList.remove('active'));
  incoming.classList.add('active');

  incoming.style.transition = 'opacity 0.18s ease';
  incoming.style.opacity = '1';

  // Limpa o estilo inline após a transição
  setTimeout(() => { incoming.style.cssText = ''; }, 200);
},

renderPage(p){
  if(p==='home') App.renderHome();
  else if(p==='fichas') App.renderFichas();
  else if(p==='timer'){ App.renderTimerTicks(); App._syncRestTimeUI(); }
  else if(p==='stats') App.renderStats();
  else if(p==='peso') App.renderPeso();
  else if(p==='perfil') App.renderPerfil();
},

// Sincroniza o label e preset da página Timer com a pref restTime
_syncRestTimeUI(){
  const t = DB.getPref('restTime', 90);
  const label = $('rest-time-label');
  if(label) label.textContent = `Descanso padrão: ${t<60?t+'s':t/60+'min'}`;
  // Aplica o preset salvo nos botões visuais (sem alterar se timer estiver rodando)
  if(!S.timer.running){
    document.querySelectorAll('.tp').forEach(b=>b.classList.remove('on'));
    [30,45,60,90,120,180].forEach((v,i)=>{
      if(v===t) document.querySelectorAll('.tp')[i]?.classList.add('on');
    });
    if($('cmin')) $('cmin').value=Math.floor(t/60);
    if($('csec')) $('csec').value=t%60;
    S.timer.total=t; S.timer.rem=t; App.updTimer();
  }
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

  const sessDays = new Set(sess.map(s=>localDate(s.date)));
  let streak = 0;
  for(let i=0;i<60;i++){
    const d=new Date(now); d.setDate(now.getDate()-i);
    const k=localDate(d.toISOString());
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
  const weekTarget = DB.getPref('weekTarget', 5);
  const weekDone   = new Set(wk.map(s=>localDate(s.date))).size;
  const weekDots = Array.from({length:7}).map((_,i)=>{
    const d=new Date(now); d.setDate(now.getDate()-(6-i));
    const k=localDate(d.toISOString());
    const done = sessDays.has(k); const isToday = i===6; const dow = d.getDay();
    return `<div class="wk-day">
      <div class="wd">${dayLabels[dow]}</div>
      <div class="wdot ${done?'done':''} ${isToday&&!done?'today':''}">${done?IC.check(14):''}</div>
    </div>`;
  }).join('');

  const srow_html = `
    <div class="srow">
      <div class="sc">
        <div class="sl">Semana</div>
        <div class="sv" data-count="${weekDone}">${weekDone}<small>/${weekTarget}</small></div>
        <div class="ss">treinos</div>
      </div>
      <div class="sc">
        <div class="sl" style="color:var(--heat)">Carga média</div>
        <div class="sv" data-count="${avgLoad}">${avgLoad}<small>kg</small></div>
        <div class="ss">${wk.length?'por série':'sem dados'}</div>
      </div>
      <div class="sc">
        <div class="sl" style="color:var(--cool)">Streak</div>
        <div class="sv" data-count="${streak}">${streak}<small>d</small></div>
        <div class="ss">${streak>0?'ativo':'—'}</div>
      </div>
    </div>
  `;

  $('pg-home').innerHTML = `
    <div class="hero" style="overflow:hidden;position:relative">
      <!-- Padrão vetorial de fundo -->
      <svg style="position:absolute;inset:0;width:100%;height:100%;opacity:.045;pointer-events:none" viewBox="0 0 360 200" preserveAspectRatio="xMidYMid slice">
        <!-- Grade de pontos -->
        ${Array.from({length:8},(_,row)=>Array.from({length:12},(_,col)=>`<circle cx="${col*34+8}" cy="${row*28+8}" r="1.5" fill="currentColor"/>`).join('')).join('')}
        <!-- Linhas de tendência -->
        <polyline points="0,160 40,140 80,150 120,110 160,120 200,90 240,100 280,70 320,80 360,50" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
        <polyline points="0,180 40,170 80,175 120,155 160,160 200,140 240,148 280,125 320,132 360,108" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round" opacity=".6"/>
      </svg>
      <div class="hg">${ico}<span>${txt}</span></div>
      <div class="ht">${heroTitle}</div>
      ${heroMeta?`<div class="hmeta">${heroMeta}</div>`:''}
      <button class="btn bp lg" onclick="App.startTodayWorkout()">
        ${IC.play(14)}<span>Iniciar treino</span>
      </button>
    </div>
    ${srow_html}
    <div class="card">
      <div class="between" style="margin-bottom:12px">
        <div class="eyebrow">Esta semana</div>
        <button onclick="App.showWeekTargetModal()" style="
          display:flex;align-items:center;gap:5px;
          color:${weekDone>=weekTarget?'var(--green)':'var(--t2)'};
          font-size:12px;font-family:var(--font);font-weight:600;
          background:none;border:1px solid var(--line-2);
          border-radius:8px;padding:4px 10px;cursor:pointer;
          transition:color .15s,border-color .15s;
        ">
          ${weekDone>=weekTarget?IC.check(12):IC.edit(12)}
          ${weekDone} / ${weekTarget} dias
        </button>
      </div>
      ${weekDone>0?`
      <div class="prog-track" style="margin-bottom:12px">
        <div class="prog-bar" style="width:${Math.min(100,Math.round(weekDone/weekTarget*100))}%;background:${weekDone>=weekTarget?'var(--green)':'var(--cool)'}"></div>
      </div>`:''}
      <div class="wk-grid">${weekDots}</div>
    </div>
    <div class="between" style="padding:18px 2px 8px">
      <div class="eyebrow">Últimos treinos</div>
      ${recent.length?`<button onclick="App.nav('stats')" style="display:flex;align-items:center;gap:4px;color:var(--t1);font-size:12px">Ver tudo ${IC.chevronRight(14)}</button>`:''}
    </div>
    <div>${recentHtml}</div>
  `;

  // Contador animado nos cards de stats (0 → valor em ~600ms)
  requestAnimationFrame(() => {
    $('pg-home').querySelectorAll('.sv[data-count]').forEach(el => {
      const target = +el.dataset.count;
      if(!target) return;
      const suffix = el.innerHTML.match(/<small>.*<\/small>/)?.[0] || '';
      const dur = 600, start = performance.now();
      const tick = (now) => {
        const t = Math.min(1, (now - start) / dur);
        const ease = 1 - Math.pow(1 - t, 3); // cubic ease-out
        el.innerHTML = Math.round(ease * target) + suffix;
        if(t < 1) requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });
  });
},

// ─── META SEMANAL ─────────────────────────────────────────────────
showWeekTargetModal(){
  App.closeModal();
  const current = DB.getPref('weekTarget', 5);
  const m=document.createElement('div'); m.className='mo';
  m.innerHTML=`<div class="md">
    <div class="mhandle"></div>
    <div class="mtitle">Meta semanal de treinos</div>
    <div style="font-size:13px;color:var(--t2);margin:-10px 0 18px;line-height:1.5">
      Quantos dias por semana você planeja treinar?
    </div>
    <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:10px;margin-bottom:20px">
      ${[2,3,4,5,6,7].map(n=>`
        <button onclick="App.saveWeekTarget(${n})" style="
          height:56px;border-radius:14px;
          background:${n===current?'var(--green-dim)':'var(--bg-3)'};
          border:1.5px solid ${n===current?'var(--green-line)':'var(--line-2)'};
          color:${n===current?'var(--green)':'var(--t1)'};
          font-family:var(--mono);font-weight:700;font-size:20px;
          cursor:pointer;transition:all .15s;display:flex;flex-direction:column;
          align-items:center;justify-content:center;gap:2px;
        ">
          ${n}
          <span style="font-size:9px;font-family:var(--font);font-weight:600;
            letter-spacing:.1em;text-transform:uppercase;opacity:.6">
            ${n===1?'dia':'dias'}
          </span>
        </button>
      `).join('')}
    </div>
    <button class="btn bg" onclick="App.closeModal()">Cancelar</button>
  </div>`;
  m.addEventListener('click',e=>{if(e.target===m)App.closeModal();});
  $('mroot').appendChild(m);
},

saveWeekTarget(n){
  DB.setPref('weekTarget', n);
  App.closeModal();
  App.renderHome();
  if(S.page==='perfil') App.renderPerfil();
  App.toast(`Meta: ${n} treinos por semana`);
},
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
      <button class="icon-btn" onclick="App.showBackupModal()" title="Backup e exportação">
        ${IC.export(16)}
      </button>
      <button class="icon-btn" onclick="App.downloadTemplate()" title="Baixar modelo JSON">
        ${IC.info(16)}
      </button>
    </div>
  `;

  if(!fichas.length){
    root.innerHTML = top + `
      <div style="text-align:center;padding:48px 24px 32px">
        <div style="
          width:72px;height:72px;border-radius:22px;
          background:var(--green-dim);color:var(--green);
          border:1px solid var(--green-line);
          display:inline-flex;align-items:center;justify-content:center;
          margin-bottom:20px;
        ">${IC.clipboard(32)}</div>
        <div style="font-size:20px;font-weight:700;color:var(--t0);letter-spacing:-0.02em;margin-bottom:8px">
          Nenhuma ficha criada
        </div>
        <div style="font-size:14px;color:var(--t2);line-height:1.6;margin-bottom:24px">
          Crie sua primeira rotina de treino.<br>Adicione dias, exercícios e séries.
        </div>
        <button class="btn bp lg" onclick="App.newFicha()">
          ${IC.plus(16)} Criar primeira ficha
        </button>
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
        <div class="fc-stat"><div class="num">${fSess.length}</div><div class="lbl">sessões</div></div>
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

  const endAt = Date.now() + S.timer.rem * 1000;
  localStorage.setItem('evolv_timer_end', String(endAt));

  App.setTimerStatus('Contando');
  App.setTimerPlayIcon(true);
  App._scheduleTimerPush(S.timer.rem);

  S.timer.iv=setInterval(()=>{
    const rem = Math.max(0, Math.round((+localStorage.getItem('evolv_timer_end') - Date.now()) / 1000));
    S.timer.rem = rem;
    App.updTimer();
    if(rem<=0){
      App.stopTimer();
      App.setTimerStatus('Tempo!');
      if(navigator.vibrate) navigator.vibrate([250,100,250,100,250]);
      App.toast('Intervalo finalizado!');
      // Só notifica via página se o SW não foi quem disparou
      // (visibilityState visible = app estava aberto o tempo todo)
      if(document.visibilityState === 'visible'){
        App.sendTimerNotification();
      }
    }
  },1000);
},

_scheduleTimerPush(seconds){
  if(!navigator.serviceWorker?.controller) return;
  navigator.serviceWorker.controller.postMessage({
    type: 'SCHEDULE_TIMER',
    delay: seconds * 1000,
    title: 'EVOLV — Timer',
    body: 'Intervalo encerrado. Próxima série!',
    tag: 'evolv-timer',
  });
},

stopTimer(){
  S.timer.running=false;
  clearInterval(S.timer.iv);
  localStorage.removeItem('evolv_timer_end');
  App.setTimerPlayIcon(false);
  App.setTimerStatus(S.timer.rem>0?'Pausado':'Pronto');
  if(navigator.serviceWorker?.controller)
  navigator.serviceWorker.controller.postMessage({type:'CANCEL_TIMER'});  
},

resetTimer(){
  App.stopTimer();
  S.timer.rem=S.timer.total;
  App.updTimer();
  App.setTimerStatus('Pronto');
},

bumpTimer(seconds){
  S.timer.rem=Math.max(1,S.timer.rem+seconds);
  S.timer.total=Math.max(S.timer.total,S.timer.rem);
  if(S.timer.running){
    const newEnd = Date.now() + S.timer.rem * 1000;
    localStorage.setItem('evolv_timer_end', String(newEnd));
    App._scheduleTimerPush(S.timer.rem); // reagenda com o novo tempo
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
    // Não notifica aqui — o SW já disparou enquanto estava em background
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
    root.innerHTML=`
      <div style="text-align:center;padding:48px 24px 32px">
        <div style="
          width:72px;height:72px;border-radius:22px;
          background:var(--cool-dim);color:var(--cool);
          border:1px solid rgba(107,168,255,0.25);
          display:inline-flex;align-items:center;justify-content:center;
          margin-bottom:20px;
        ">${IC.trendUp(32)}</div>
        <div style="font-size:20px;font-weight:700;color:var(--t0);letter-spacing:-0.02em;margin-bottom:8px">
          Sem dados ainda
        </div>
        <div style="font-size:14px;color:var(--t2);line-height:1.6;margin-bottom:24px">
          Complete seu primeiro treino para<br>ver suas estatísticas e evolução.
        </div>
        <button class="btn bg lg" onclick="App.nav('home')">
          ${IC.play(16)} Ir para o início
        </button>
      </div>
    `;
    return;
  }
  const now=new Date();

  // ── Frequência ────────────────────────────────────────────────
  const total = sess.length;
  const sessDays = new Set(sess.map(s=>localDate(s.date)));

  // Treinos últimos 30 dias
  const mo30 = sess.filter(s=>(now-new Date(s.date))/864e5<=30);

  // Consistência %: dias treinados / 30
  const consistency = Math.round((new Set(mo30.map(s=>localDate(s.date))).size / 30) * 100);

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
            <div class="bar" style="height:${Math.max(h,v?8:2)}%;transform:scaleY(0);transform-origin:bottom;transition:transform 0.45s cubic-bezier(0.25,1,0.5,1) ${i*40}ms"></div>
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
        const medals = [
          {bg:'linear-gradient(135deg,#FFD700,#FFA500)',shadow:'rgba(255,180,0,0.35)',label:'#7A4F00'},
          {bg:'linear-gradient(135deg,#E0E0E0,#A0A0A0)',shadow:'rgba(160,160,160,0.3)',label:'#444'},
          {bg:'linear-gradient(135deg,#CD7F32,#A0522D)',shadow:'rgba(160,100,50,0.3)',label:'#5C2E00'},
        ];
        const m = medals[i];
        const badge = m
          ? `<div style="
              width:28px;height:28px;border-radius:8px;flex-shrink:0;
              background:${m.bg};
              box-shadow:0 2px 8px ${m.shadow};
              display:flex;align-items:center;justify-content:center;
              font-size:13px;font-weight:800;color:${m.label};
              font-variant-numeric:tabular-nums;
            ">${i+1}</div>`
          : `<div style="
              width:28px;height:28px;border-radius:8px;flex-shrink:0;
              background:var(--bg-3);border:1px solid var(--line-2);
              display:flex;align-items:center;justify-content:center;
              font-family:var(--mono);font-size:11px;color:var(--t2);font-weight:700;
            ">${i+1}</div>`;
        return `<div class="prow" style="border-bottom:${i<prs.length-1?'1px solid var(--line)':'none'};display:flex;align-items:center;gap:10px;padding:10px 0">
          ${badge}
          <div style="flex:1;min-width:0">
            <div style="font-size:13px;font-weight:600;color:var(--t0);white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(n)}</div>
          </div>
          <div style="font-family:var(--mono);font-weight:800;font-size:17px;color:var(--t0);flex-shrink:0;font-variant-numeric:tabular-nums">
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

    <!-- HISTÓRICO DE TREINOS -->
    ${sess.length?`
    <div class="eyebrow" style="margin:18px 0 10px">Histórico de treinos</div>
    <div class="card" style="padding:8px 0">
      ${sess.slice().reverse().map((s,i,arr)=>{
        const fichas=DB.fichas();
        const f=fichas.find(x=>x.id===s.fichaId);
        const d=f?.days?.[s.dayIdx];
        const name=esc(d?.name||f?.name||'Treino');
        const durMin=Math.round((s.dur||0)/60);
        const sets=(s.exs||[]).reduce((a,e)=>a+(e.sets||[]).filter(x=>x.done).length,0);
        const exCount=(s.exs||[]).length;
        const dateLabel=fd(localDate(s.date));
        const color=S.fichaColors[fichas.indexOf(f)%S.fichaColors.length]||'var(--green)';
        return `<div class="prow" style="padding:12px 16px;border-bottom:${i<arr.length-1?'1px solid var(--line)':'none'}">
          <div style="flex:1;min-width:0">
            <div style="font-size:13.5px;font-weight:600;color:var(--t0);
              white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${name}</div>
            <div style="font-size:11.5px;color:var(--t2);margin-top:3px;display:flex;gap:10px;flex-wrap:wrap">
              <span>${dateLabel}</span>
              ${durMin>0?`<span>${IC.stopwatch(11)} ${durMin}min</span>`:''}
              <span>${IC.dumbbell(11)} ${exCount} ex · ${sets} séries</span>
            </div>
          </div>
          <div class="del" onclick="App.delSessao('${esc(s.id)}')" title="Excluir treino"
            style="width:32px;height:32px;border-radius:9px;background:var(--red-dim);
              color:var(--red);display:flex;align-items:center;justify-content:center;
              cursor:pointer;flex-shrink:0;margin-left:12px;transition:transform .12s">
            ${IC.trash(14)}
          </div>
        </div>`;
      }).join('')}
    </div>`:''}
  `;

  setTimeout(()=>{
    Object.values(S.charts).forEach(c=>{try{c.destroy()}catch{}}); S.charts={};
    if($('ch-pe')&&pesos.length>=2){
      const lp=pesos.slice(-24);
      const op={...CDO,scales:{...CDO.scales,y:{...CDO.scales.y,beginAtZero:false}}};
      S.charts.pe=new Chart($('ch-pe'),{type:'line',data:{labels:lp.map(p=>fd(p.date)),datasets:[{data:lp.map(p=>p.w),borderColor:ACCENT,backgroundColor:'rgba(31,224,122,0.08)',fill:true,tension:0.35,pointRadius:3,pointBackgroundColor:ACCENT,borderWidth:2}]},options:op});
    }
    // Anima barras de frequência (scaleY: 0 → 1)
    document.querySelectorAll('.bar-chart .bar').forEach(b=>{
      b.style.transform='scaleY(1)';
    });
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

  const savedGoal = DB.getPref('pesoGoal', 0);
  const goal = savedGoal || Math.round(cur.w*0.95*2)/2;
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
  const savedGoal = DB.getPref('pesoGoal', 0);
  const m=document.createElement('div');m.className='mo';
  m.innerHTML=`<div class="md">
    <div class="mhandle"></div>
    <div class="mtitle">Definir meta de peso</div>
    <div class="ig"><label>Meta (kg)</label>
      <input type="number" id="goal-input" placeholder="ex: 75.0" step="0.5" min="30" max="300" value="${savedGoal?savedGoal:''}" inputmode="decimal">
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
  DB.setPref('pesoGoal', v);
  App.closeModal(); App.toast(`Meta: ${v.toFixed(1)}kg definida!`); App.renderPeso();
},

clearWeightGoal(){
  DB.setPref('pesoGoal', 0);
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

async delSessao(id){
  await App.showConfirmDialog({
    title: 'Excluir treino',
    message: 'Este treino será removido permanentemente do seu histórico e não afetará mais suas estatísticas.',
    confirmText: 'Excluir treino',
    cancelText: 'Cancelar',
    isDangerous: true,
    onConfirm: async()=>{
      try{
        await DB.delSessao(id);
        App.renderStats();
        if(S.page==='home') App.renderHome();
        App.toast('Treino excluído.');
      }catch(e){ App.toast('Erro ao excluir.'); }
    }
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
// ═══════════════════════════════════════════════════════════════
// BACKUP & EXPORT
// ═══════════════════════════════════════════════════════════════

showBackupModal(){
  App.closeModal();
  const fichas  = DB.fichas();
  const sessoes = DB.sessoes();
  const pesos   = DB.pesos();

  const m = document.createElement('div'); m.className='mo';
  m.innerHTML=`<div class="md">
    <div class="mhandle"></div>
    <div style="display:flex;align-items:center;gap:10px;margin-bottom:20px">
      <div style="width:42px;height:42px;border-radius:12px;background:var(--green-dim);color:var(--green);border:1px solid var(--green-line);display:flex;align-items:center;justify-content:center;flex-shrink:0">
        ${IC.export(20)}
      </div>
      <div>
        <div style="font-size:19px;font-weight:700;letter-spacing:-0.01em">Backup e exportação</div>
        <div style="font-size:12px;color:var(--t2);margin-top:1px">Seus dados, no seu controle</div>
      </div>
    </div>

    <!-- Resumo dos dados -->
    <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:8px;margin-bottom:20px">
      <div style="background:var(--bg-3);border-radius:12px;padding:12px;text-align:center">
        <div style="font-family:var(--mono);font-weight:800;font-size:20px;color:var(--t0)">${fichas.length}</div>
        <div style="font-size:10px;color:var(--t2);margin-top:2px;text-transform:uppercase;letter-spacing:.06em">fichas</div>
      </div>
      <div style="background:var(--bg-3);border-radius:12px;padding:12px;text-align:center">
        <div style="font-family:var(--mono);font-weight:800;font-size:20px;color:var(--t0)">${sessoes.length}</div>
        <div style="font-size:10px;color:var(--t2);margin-top:2px;text-transform:uppercase;letter-spacing:.06em">treinos</div>
      </div>
      <div style="background:var(--bg-3);border-radius:12px;padding:12px;text-align:center">
        <div style="font-family:var(--mono);font-weight:800;font-size:20px;color:var(--t0)">${pesos.length}</div>
        <div style="font-size:10px;color:var(--t2);margin-top:2px;text-transform:uppercase;letter-spacing:.06em">pesagens</div>
      </div>
    </div>

    <!-- Exportar backup completo -->
    <div class="card" style="margin-bottom:10px">
      <div class="eyebrow" style="margin-bottom:6px">Backup completo</div>
      <div style="font-size:12px;color:var(--t2);line-height:1.5;margin-bottom:12px">
        Exporta tudo: fichas, histórico de treinos, pesagens e preferências. Use para migrar para outro aparelho ou guardar um backup seguro.
      </div>
      <button class="btn bp lg" onclick="App.exportFullBackup()">
        ${IC.export(15)} Exportar backup (.json)
      </button>
    </div>

    <!-- Exportar CSV -->
    <div class="card" style="margin-bottom:10px">
      <div class="eyebrow" style="margin-bottom:6px">Histórico em planilha</div>
      <div style="font-size:12px;color:var(--t2);line-height:1.5;margin-bottom:12px">
        Exporta o histórico de treinos como CSV — compatível com Excel, Google Sheets e qualquer editor de planilhas.
      </div>
      <button class="btn bg lg" onclick="App.exportSessionsCsv()" ${!sessoes.length?'disabled style="opacity:.45"':''}>
        ${IC.trendUp(15)} Exportar histórico (.csv)
      </button>
    </div>

    <!-- Importar backup -->
    <div class="card" style="margin-bottom:10px">
      <div class="eyebrow" style="margin-bottom:6px">Restaurar backup</div>
      <div style="font-size:12px;color:var(--t2);line-height:1.5;margin-bottom:12px">
        Importa um backup EVOLV (.json). Fichas e pesagens são mescladas; sessões já existentes não são duplicadas.
      </div>
      <div style="display:flex;gap:8px">
        <button class="btn bg lg" onclick="App.importBackupFileSelector()" style="flex:1">
          ${IC.download(15)} Selecionar arquivo
        </button>
        <button class="btn bg lg" onclick="App.showImportFicha()" style="flex:1">
          ${IC.clipboard(15)} Importar fichas
        </button>
      </div>
    </div>

    <button class="btn bg" onclick="App.closeModal()">Fechar</button>
  </div>`;
  m.addEventListener('click',e=>{if(e.target===m)App.closeModal();});
  $('mroot').appendChild(m);
},

exportFullBackup(){
  const data = {
    evolv_backup: true,
    version: 2,
    exported_at: new Date().toISOString(),
    sync_id: localStorage.getItem('evolv_sync_id')||null,
    fichas:  DB.fichas(),
    sessoes: DB.sessoes(),
    pesos:   DB.pesos(),
    prefs:   DB.getPrefs(),
  };
  const blob = new Blob([JSON.stringify(data, null, 2)], {type:'application/json'});
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `evolv-backup-${today()}.json`;
  a.click();
  setTimeout(()=>URL.revokeObjectURL(a.href), 10000);
  App.toast('Backup exportado!');
},

exportSessionsCsv(){
  const sessoes = DB.sessoes();
  const fichas  = DB.fichas();
  if(!sessoes.length){ App.toast('Nenhuma sessão para exportar'); return; }

  const rows = [
    ['Data','Ficha','Dia','Duração (min)','Exercícios','Séries totais','Volume (kg)']
  ];

  sessoes.slice().reverse().forEach(s=>{
    const f = fichas.find(x=>x.id===s.fichaId);
    const d = f?.days?.[s.dayIdx];
    const durMin  = Math.round((s.dur||0)/60);
    const exCount = (s.exs||[]).length;
    const series  = (s.exs||[]).reduce((a,e)=>a+(e.sets||[]).filter(x=>x.done).length, 0);
    const volume  = (s.exs||[]).reduce((a,e)=>a+(e.sets||[]).filter(x=>x.done).reduce((b,x)=>b+(+x.reps||0)*(+x.w||0),0), 0);
    rows.push([
      localDate(s.date),
      f?.name||'—',
      d?.name||'—',
      durMin||'—',
      exCount,
      series,
      volume||'—',
    ]);
  });

  const csv = rows.map(r=>r.map(v=>`"${String(v).replace(/"/g,'""')}"`).join(',')).join('\r\n');
  const bom = '\uFEFF'; // BOM para Excel reconhecer UTF-8
  const blob = new Blob([bom + csv], {type:'text/csv;charset=utf-8'});
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `evolv-historico-${today()}.csv`;
  a.click();
  setTimeout(()=>URL.revokeObjectURL(a.href), 10000);
  App.toast('CSV exportado!');
},

importBackupFileSelector(){
  // Reutiliza o input de arquivo existente, mudando o accept temporariamente
  const inp = $('import-file-input');
  if(!inp) return;
  inp.accept = 'application/json,.json,.csv';
  inp.onchange = App.handleBackupFile;
  inp.click();
},

handleBackupFile(e){
  const file = e.target.files?.[0]; if(!file) return;
  const reader = new FileReader();
  reader.onload = ()=>{
    if(file.name.endsWith('.csv')){
      App.toast('Para importar, use o arquivo .json de backup.');
    } else {
      App.importFullBackup(reader.result);
    }
  };
  reader.onerror = ()=>App.toast('Não foi possível ler o arquivo.');
  reader.readAsText(file, 'UTF-8');
  e.target.value = '';
  // Restaura o handler original
  e.target.onchange = App.handleImportFile;
  e.target.accept   = 'application/json';
},

async importFullBackup(raw){
  App.closeModal();
  if(!raw?.trim()){ App.toast('Arquivo inválido.'); return; }

  let data;
  try{ data = JSON.parse(raw); }
  catch{ App.toast('JSON inválido — verifique o arquivo.'); return; }

  if(!data.evolv_backup){ App.toast('Este arquivo não é um backup EVOLV válido.'); return; }

  const safeStr = (v, max=200)=>String(v||'').slice(0,max).replace(/[<>]/g,'');
  const safeNum = (v,fb=0)=>{ const n=+v; return isNaN(n)?fb:n; };

  // Contadores para o relatório
  let fichasAdded=0, sessoesAdded=0, pesosAdded=0;

  // Merge fichas — evita duplicatas por ID
  const fichasExistentes = new Set(DB.fichas().map(f=>f.id));
  for(const f of (data.fichas||[])){
    if(!f?.name || fichasExistentes.has(f.id)) continue;
    const item = {
      id:   f.id||uid(), at: f.at||Date.now(),
      name: safeStr(f.name, 80),
      days: (f.days||[]).slice(0,30).map(d=>({
        name: safeStr(d.name||'Dia', 80),
        exs:  (d.exs||[]).slice(0,50).map(e=>({
          name: safeStr(e.name||'', 80),
          sets: Math.min(20, Math.max(1, +e.sets||3)),
          reps: Math.min(200, Math.max(1, +e.reps||12)),
          w: 0,
        })).filter(e=>e.name.trim()),
      })),
    };
    await DB.addFicha(item);
    fichasAdded++;
  }

  // Merge sessões — evita duplicatas por ID
  const sessoesExistentes = new Set(DB.sessoes().map(s=>s.id));
  for(const s of (data.sessoes||[])){
    if(!s?.id || sessoesExistentes.has(s.id)) continue;
    const item = {
      id:      s.id,
      fichaId: safeStr(s.fichaId||'', 50),
      dayIdx:  safeNum(s.dayIdx, 0),
      date:    safeStr(s.date||new Date().toISOString(), 30),
      dur:     safeNum(s.dur, 0),
      exs:     (s.exs||[]).slice(0,50).map(e=>({
        name: safeStr(e.name||'', 80),
        sets: (e.sets||[]).slice(0,30).map(x=>({
          reps: safeNum(x.reps, 0), w: safeNum(x.w, 0), done: !!x.done,
        })),
      })),
    };
    await DB.addSessao(item);
    sessoesAdded++;
  }

  // Merge pesos — evita duplicatas por ID
  const pesosExistentes = new Set(DB.pesos().map(p=>p.id));
  for(const p of (data.pesos||[])){
    if(!p?.id || pesosExistentes.has(p.id)) continue;
    const item = {
      id:   p.id,
      w:    safeNum(p.w, 0),
      date: safeStr(p.date||new Date().toISOString().slice(0,10), 20),
      obs:  safeStr(p.obs||'', 200),
    };
    await DB.addPeso(item);
    pesosAdded++;
  }

  // Restaura prefs (sem sobrescrever tema atual)
  if(data.prefs && typeof data.prefs === 'object'){
    const skip = new Set(['theme','onboarded']);
    for(const [k,v] of Object.entries(data.prefs)){
      if(!skip.has(k)) await DB.setPref(k, v);
    }
  }

  App.renderPage(S.page);
  App.notify(
    `Backup importado: ${fichasAdded} fichas, ${sessoesAdded} treinos, ${pesosAdded} pesagens.`,
    'success'
  );
},

exportFichas(){
  // Mantido para compatibilidade — redireciona para o backup completo
  App.showBackupModal();
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

  // ── [HIST-LOAD] Busca última carga usada por exercício ────────
  // Percorre as sessões de trás para frente e pega a carga mais
  // recente de cada set de cada exercício pelo nome.
  // Resultado: { 'Supino Reto': [80, 80, 75], 'Agachamento': [100, 100, 100] }
  const lastLoads = {};
  const sessoes = DB.sessoes().slice().reverse(); // mais recente primeiro
  (d.exs||[]).forEach(ex=>{
    if(!ex.name || lastLoads[ex.name]) return;
    for(const s of sessoes){
      const match = (s.exs||[]).find(e=>e.name===ex.name);
      if(match){
        const done = (match.sets||[]).filter(x=>x.done);
        if(done.length){
          lastLoads[ex.name] = done.map(x=>+x.w||0);
          break;
        }
      }
    }
  });

  S.workout={on:true,minimized:false,fichaId,dayIdx,t0:Date.now(),iv:null,
    exs:(d.exs||[]).map(e=>{
      const hist = lastLoads[e.name] || [];
      return {
        name: e.name,
        ts:   e.sets||3,
        tr:   e.reps||12,
        // Pré-preenche sets com a carga histórica correspondente.
        // Se havia 3 sets antes e agora há 4, o 4º recebe a última carga.
        sets: Array.from({length:e.sets||3},(_,si)=>({
          reps: e.reps||12,
          w:    hist[si] ?? hist[hist.length-1] ?? 0,
          done: false,
        })),
        // Guarda histórico para exibir badge "última vez"
        lastLoads: hist,
      };
    })};

  $('aw').classList.add('open'); $('aw-title').textContent=d.name;
  App.updateWorkoutResume();
  WorkoutCache.save();
  S.workout.iv=setInterval(()=>{
    const el=$('aw-timer');
    if(el) el.textContent=ft(Math.floor((Date.now()-S.workout.t0)/1000));
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
          // Micro-bounce ao marcar a série
          if(s.done){
            chk.style.transform='scale(0)';
            chk.style.transition='none';
            chk.offsetHeight; // reflow
            chk.style.transition='transform 0.22s cubic-bezier(0.34,1.56,0.64,1)';
            chk.style.transform='scale(1)';
          }
          // Atualiza opacidade dos inputs da linha sem recriar
          const row=card.querySelectorAll('.set-row')[si]; if(!row) return;
          row.querySelectorAll('input').forEach(inp=>inp.style.opacity=s.done?'0.45':'');
        }
      });
    });
    return;
  }

  // Rebuild completo (primeira vez ou após addSet)
  body.innerHTML=exs.map((ex,ei)=>{
    const allDone=ex.sets.every(s=>s.done);
    // Badge de última carga — mostra a carga máxima do histórico anterior
    const hist = ex.lastLoads||[];
    const histMax = hist.length ? Math.max(...hist) : 0;
    const histBadge = histMax > 0
      ? `<span style="
          font-size:10px;font-family:var(--mono);font-weight:600;
          color:var(--t2);background:var(--bg-3);border:1px solid var(--line);
          border-radius:6px;padding:2px 7px;margin-left:8px;
        ">${histMax}kg última vez</span>`
      : '';
    return `<div class="ex-card ${allDone?'glow':''}">
      <div class="ex-hdr">
        <div style="flex:1;min-width:0">
          <div class="ex-name">${esc(ex.name)}</div>
          ${histBadge}
        </div>
        <span class="ex-tag">${ex.sets.filter(s=>s.done).length}/${ex.sets.length}</span>
      </div>
      <div class="sets-hdr"><span></span><span>Carga (kg)</span><span>Reps</span><span></span></div>
      ${ex.sets.map((s,si)=>`
        <div class="set-row">
          <div class="sn">${si+1}</div>
          <input type="number" value="${s.w||''}" placeholder="${hist[si]??hist[hist.length-1]??0}" min="0" step="0.5" onchange="App.updSet(${ei},${si},'w',this.value)" inputmode="decimal" style="${s.done?'opacity:0.45':''}">
          <input type="number" value="${s.reps||''}" placeholder="${ex.tr}" min="1" onchange="App.updSet(${ei},${si},'reps',this.value)" inputmode="numeric" style="${s.done?'opacity:0.45':''}">
          <div class="set-chk ${s.done?'done':''}" onclick="App.togSet(${ei},${si})">${s.done?IC.check(16):''}</div>
        </div>`).join('')}
    </div>`;
  }).join('');
},

updSet(ei,si,f,v){
  S.workout.exs[ei].sets[si][f]=+v;
  WorkoutCache.save();

  // Pulso verde no input de carga quando supera o histórico
  if(f==='w'){
    const ex = S.workout.exs[ei];
    const hist = ex.lastLoads||[];
    const histMax = hist.length ? Math.max(...hist) : 0;
    if(histMax>0 && +v>histMax){
      // Encontra o input específico e aplica o pulso
      const cards = document.querySelectorAll('.ex-card');
      const card  = cards[ei];
      if(card){
        const inp = card.querySelectorAll('.set-row')[si]?.querySelector('input[type="number"]:first-of-type');
        if(inp){
          inp.style.transition='none';
          inp.style.background='var(--green-dim)';
          inp.style.borderColor='var(--green-line)';
          inp.style.color='var(--green)';
          setTimeout(()=>{
            inp.style.transition='background .6s ease, border-color .6s ease, color .6s ease';
            inp.style.background='';
            inp.style.borderColor='';
            inp.style.color='';
          },80);
        }
      }
    }
  }
},

togSet(ei,si){
  const s=S.workout.exs[ei].sets[si]; s.done=!s.done;
  WorkoutCache.save();
  App.renderAW(false);

  if(s.done){
    App.addSeries(1);

    // ── [REST] Descanso configurável ──────────────────────────
    // Se o usuário nunca configurou o tempo de descanso,
    // pergunta uma vez e salva no Firebase. Depois usa o valor salvo.
    const restTime = DB.getPref('restTime', null);

    if(restTime === null){
      // Primeira vez — mostra modal de configuração
      App.showRestTimeSetup(()=>{
        const t = DB.getPref('restTime', 90);
        App.setPreset(t);
        App.startTimer();
        App.toast('Timer iniciado!');
      });
    } else {
      App.setPreset(restTime);
      App.startTimer();
      App.toast('Timer iniciado!');
    }
  }
},

addSet(ei){
  const e=S.workout.exs[ei]; e.sets.push({reps:e.tr,w:0,done:false});
  WorkoutCache.save();
  App.renderAW(true);
},

// ── [REST] Modal de configuração — primeira vez ───────────────
// Aparece automaticamente ao marcar a primeira série do histórico.
// onConfirm é chamado depois de salvar, para iniciar o timer.
showRestTimeSetup(onConfirm){
  App.closeModal();
  const OPTIONS = [30,45,60,90,120,180];
  const m=document.createElement('div'); m.className='mo';
  m.innerHTML=`<div class="md">
    <div class="mhandle"></div>
    <div class="mtitle">Tempo de descanso padrão</div>
    <div style="font-size:13px;color:var(--t2);margin:-10px 0 18px;line-height:1.5">
      Quanto tempo você descansa entre as séries? Pode alterar a qualquer momento na página Timer.
    </div>
    <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:10px;margin-bottom:20px">
      ${OPTIONS.map(s=>`
        <button onclick="App._saveRestTime(${s}, this._onConfirm)" data-s="${s}" style="
          height:64px;border-radius:14px;
          background:var(--bg-3);border:1.5px solid var(--line-2);
          color:var(--t1);cursor:pointer;transition:all .15s;
          display:flex;flex-direction:column;align-items:center;justify-content:center;gap:3px;
        ">
          <span style="font-family:var(--mono);font-weight:700;font-size:18px;color:var(--t0)">${s<60?s+'s':s/60+'min'}</span>
          <span style="font-size:10px;letter-spacing:.08em;opacity:.55">${s===90?'recomendado':s<=45?'curto':s>=180?'longo':''}</span>
        </button>
      `).join('')}
    </div>
    <button class="btn bg sm" onclick="App.closeModal()" style="margin-bottom:4px">Pular por agora</button>
  </div>`;
  // Injeta o callback nos botões (não pode ir no onclick inline por ser função)
  m.addEventListener('click',e=>{if(e.target===m)App.closeModal();});
  $('mroot').appendChild(m);
  // Guarda callback para os botões usarem
  m.querySelectorAll('button[data-s]').forEach(btn=>{
    btn.addEventListener('click',()=>{
      const s=+btn.dataset.s;
      App._saveRestTime(s, onConfirm);
    });
  });
},

async _saveRestTime(seconds, onConfirm){
  await DB.setPref('restTime', seconds);
  App.closeModal();
  App.renderTimerPage();
  if(S.page==='perfil') App.renderPerfil();
  if(onConfirm) onConfirm();
},

// Atualiza a página timer para refletir o preset ativo das prefs
renderTimerPage(){
  App._syncRestTimeUI();
  const label = $('rest-time-label');
  const t = DB.getPref('restTime', 90);
  if(label) label.textContent = `Descanso padrão: ${t<60?t+'s':t/60+'min'}`;
},

// Modal de edição do descanso — acessível pelo botão na página Timer
showRestTimeModal(){
  const current = DB.getPref('restTime', 90);
  const OPTIONS = [30,45,60,90,120,180];
  App.closeModal();
  const m=document.createElement('div'); m.className='mo';
  m.innerHTML=`<div class="md">
    <div class="mhandle"></div>
    <div class="mtitle">Tempo de descanso padrão</div>
    <div style="font-size:13px;color:var(--t2);margin:-10px 0 18px;line-height:1.5">
      Usado automaticamente ao marcar cada série durante o treino.
    </div>
    <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:10px;margin-bottom:20px">
      ${OPTIONS.map(s=>`
        <button data-s="${s}" style="
          height:64px;border-radius:14px;
          background:${s===current?'var(--green-dim)':'var(--bg-3)'};
          border:1.5px solid ${s===current?'var(--green-line)':'var(--line-2)'};
          color:${s===current?'var(--green)':'var(--t1)'};
          cursor:pointer;transition:all .15s;
          display:flex;flex-direction:column;align-items:center;justify-content:center;gap:3px;
        ">
          <span style="font-family:var(--mono);font-weight:700;font-size:18px">${s<60?s+'s':s/60+'min'}</span>
          <span style="font-size:10px;letter-spacing:.08em;opacity:.6">${s===90?'recomendado':s<=45?'curto':s>=180?'longo':''}</span>
        </button>
      `).join('')}
    </div>
    <button class="btn bg" onclick="App.closeModal()">Cancelar</button>
  </div>`;
  m.addEventListener('click',e=>{if(e.target===m)App.closeModal();});
  $('mroot').appendChild(m);
  m.querySelectorAll('button[data-s]').forEach(btn=>{
    btn.addEventListener('click',()=>{
      App._saveRestTime(+btn.dataset.s, null);
      App.toast(`Descanso padrão: ${+btn.dataset.s<60?btn.dataset.s+'s':+btn.dataset.s/60+'min'}`);
    });
  });
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
  WorkoutCache.clear();

  const snapshot = {
    fichaId: S.workout.fichaId,
    dayIdx:  S.workout.dayIdx,
    t0:      S.workout.t0,
    exs:     S.workout.exs.map(e=>({
      name:      e.name,
      sets:      e.sets,
      lastLoads: e.lastLoads||[],
    })),
  };

  $('aw').classList.remove('open');
  S.workout = {on:false, minimized:false, exs:[]};
  App.updateWorkoutResume();

  if(save){
    try{
      const sessao = {
        id:      uid(),
        fichaId: snapshot.fichaId,
        dayIdx:  snapshot.dayIdx,
        date:    new Date().toISOString(),
        dur:     Math.floor((Date.now()-snapshot.t0)/1000),
        exs:     snapshot.exs.map(e=>({name:e.name, sets:e.sets})),
      };
      await DB.addSessao(sessao);
      App.notify('Treino concluído!','workout');
      App._pushNotif('EVOLV — Treino','Treino finalizado. Excelente trabalho!',{tag:'evolv-workout'});
      App._showWorkoutResult(sessao, snapshot);
    }catch(e){ App.toast('Erro ao salvar treino.'); }
  } else {
    if(S.page==='home') App.renderHome();
  }
},

_showWorkoutResult(sessao, snapshot){
  const fichas = DB.fichas();
  const f = fichas.find(x=>x.id===sessao.fichaId);
  const d = f?.days?.[sessao.dayIdx];
  const nome = d?.name || f?.name || 'Treino';

  // ── Métricas ─────────────────────────────────────────────────
  const durTot  = sessao.dur || 0;
  const durMin  = Math.floor(durTot / 60);
  const durSec  = durTot % 60;
  const durStr  = durMin > 0 ? `${durMin}min${durSec > 0 ? ' ' + durSec + 's' : ''}` : `${durSec}s`;

  const exsDone   = (sessao.exs||[]).filter(e=>(e.sets||[]).some(s=>s.done));
  const totalSets = exsDone.reduce((a,e)=>a+(e.sets||[]).filter(s=>s.done).length, 0);
  const totalVol  = exsDone.reduce((a,e)=>a+(e.sets||[]).filter(s=>s.done).reduce((b,s)=>b+(+s.reps||0)*(+s.w||0),0), 0);
  const volStr    = totalVol >= 1000 ? (totalVol/1000).toFixed(1)+'t' : totalVol+'kg';

  // ── PRs ──────────────────────────────────────────────────────
  const prs = [];
  exsDone.forEach(e=>{
    const done = (e.sets||[]).filter(s=>s.done && +s.w>0);
    if(!done.length) return;
    const maxW   = Math.max(...done.map(s=>+s.w));
    const snapEx = snapshot.exs.find(x=>x.name===e.name);
    const prevMax = snapEx?.lastLoads?.filter(v=>v>0).length
      ? Math.max(...snapEx.lastLoads.filter(v=>v>0)) : 0;
    if(maxW > prevMax) prs.push({name: e.name, w: maxW, prev: prevMax});
  });

  // ── Exercícios ───────────────────────────────────────────────
  const exRows = exsDone.map((e,i)=>{
    const done   = (e.sets||[]).filter(s=>s.done);
    const maxW   = done.length ? Math.max(...done.map(s=>+s.w||0)) : 0;
    const vol    = done.reduce((a,s)=>a+(+s.reps||0)*(+s.w||0), 0);
    const snapEx = snapshot.exs.find(x=>x.name===e.name);
    const prevMax = snapEx?.lastLoads?.filter(v=>v>0).length
      ? Math.max(...snapEx.lastLoads.filter(v=>v>0)) : 0;
    const isPR   = maxW > 0 && maxW > prevMax;
    const color  = S.fichaColors[i % S.fichaColors.length];
    const volStr = vol >= 1000 ? (vol/1000).toFixed(1)+'t' : vol > 0 ? vol+'kg' : '—';

    return `
      <div style="
        display:flex;align-items:center;gap:12px;
        padding:12px 0;
        border-bottom:1px solid var(--line);
      ">
        <!-- Ícone letra -->
        <div style="
          width:38px;height:38px;border-radius:11px;flex-shrink:0;
          background:color-mix(in oklab,${color} 14%,transparent);
          color:${color};
          border:1px solid color-mix(in oklab,${color} 32%,transparent);
          display:flex;align-items:center;justify-content:center;
          font-size:13px;font-weight:700;
        ">${String.fromCharCode(65+i)}</div>
        <!-- Nome + detalhe -->
        <div style="flex:1;min-width:0">
          <div style="
            font-size:13.5px;font-weight:600;color:var(--t0);
            white-space:nowrap;overflow:hidden;text-overflow:ellipsis;
            display:flex;align-items:center;gap:6px;
          ">
            <span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(e.name)}</span>
            ${isPR ? `<span style="
              flex-shrink:0;font-size:9px;font-weight:700;letter-spacing:.05em;
              color:var(--green);background:var(--green-dim);
              border:1px solid var(--green-line);border-radius:5px;padding:1px 5px;
            ">PR</span>` : ''}
          </div>
          <div style="font-size:11.5px;color:var(--t2);margin-top:2px">
            ${done.length} séries${maxW > 0 ? ' · ' + maxW + 'kg' : ''}
          </div>
        </div>
        <!-- Volume -->
        <div style="text-align:right;flex-shrink:0">
          <div style="font-family:var(--mono);font-size:14px;font-weight:700;color:var(--t0)">${volStr}</div>
          <div style="font-size:10px;color:var(--t2);margin-top:1px">volume</div>
        </div>
      </div>`;
  });

  // ── Overlay ──────────────────────────────────────────────────
  const overlay = document.createElement('div');
  overlay.id = 'workout-result';
  overlay.style.cssText = `
    position:fixed;inset:0;z-index:300;
    background:var(--bg-0);
    overflow-y:auto;-webkit-overflow-scrolling:touch;
    transform:translateY(100%);
    transition:transform 0.42s cubic-bezier(0.25,1,0.5,1);
  `;

  overlay.innerHTML = `

    <!-- ── Hero ────────────────────────────────────────── -->
    <div style="
      padding:52px 24px 32px;
      text-align:center;
      background:radial-gradient(ellipse 100% 80% at 50% 0%,
        color-mix(in oklab, var(--green) 12%, transparent), transparent 70%);
      position:relative;overflow:hidden;
    ">
      <!-- Padrão de fundo -->
      <svg style="position:absolute;inset:0;width:100%;height:100%;opacity:.04;pointer-events:none" viewBox="0 0 360 240" preserveAspectRatio="xMidYMid slice">
        ${Array.from({length:7},(_,row)=>Array.from({length:11},(_,col)=>`<circle cx="${col*36+10}" cy="${row*36+10}" r="1.8" fill="currentColor"/>`).join('')).join('')}
      </svg>
      <!-- Botão fechar -->
      <button onclick="App._closeWorkoutResult()" style="
        position:absolute;top:14px;right:16px;
        width:32px;height:32px;border-radius:10px;
        background:var(--bg-3);border:1px solid var(--line-2);
        display:flex;align-items:center;justify-content:center;
        color:var(--t2);cursor:pointer;
      ">${IC.close(15)}</button>
      <!-- Ícone -->
      <div style="
        width:64px;height:64px;border-radius:20px;
        background:var(--green-dim);color:var(--green);
        border:1.5px solid var(--green-line);
        display:inline-flex;align-items:center;justify-content:center;
        margin-bottom:16px;
        box-shadow:0 8px 24px -8px color-mix(in oklab,var(--green) 40%,transparent);
      ">${IC.trophy(28)}</div>
      <div style="font-size:24px;font-weight:800;color:var(--t0);letter-spacing:-0.03em;line-height:1.1;margin-bottom:6px">
        Treino concluído!
      </div>
      <div style="font-size:14px;color:var(--t2)">${esc(nome)}</div>
    </div>

    <!-- ── Métricas ─────────────────────────────────────── -->
    <div style="
      display:grid;grid-template-columns:repeat(3,1fr);
      gap:10px;padding:20px 16px 0;
    ">
      ${[
        {label:'Duração',  value:durStr,           sub:'tempo total', color:'var(--t0)'},
        {label:'Séries',   value:totalSets,         sub:'completadas', color:'var(--t0)'},
        {label:'Volume',   value:volStr,            sub:'total',       color:'var(--heat)'},
      ].map(m=>`
        <div style="
          background:var(--bg-2);border:1px solid var(--line-2);
          border-radius:14px;padding:14px 10px;text-align:center;
        ">
          <div style="font-size:11px;font-weight:600;color:var(--t2);letter-spacing:.05em;text-transform:uppercase;margin-bottom:6px">${m.label}</div>
          <div style="font-family:var(--mono);font-size:20px;font-weight:800;color:${m.color};font-variant-numeric:tabular-nums;line-height:1">${m.value}</div>
          <div style="font-size:10px;color:var(--t3);margin-top:4px">${m.sub}</div>
        </div>
      `).join('')}
    </div>

    <!-- ── PRs ──────────────────────────────────────────── -->
    ${prs.length ? `
    <div style="padding:24px 16px 0">
      <div style="font-size:11px;font-weight:600;color:var(--t2);letter-spacing:.07em;text-transform:uppercase;margin-bottom:10px;display:flex;align-items:center;gap:6px">
        <span style="width:5px;height:5px;border-radius:50%;background:var(--green);display:inline-block"></span>
        Personal records
      </div>
      <div style="background:var(--bg-2);border:1px solid var(--line-2);border-radius:16px;overflow:hidden">
        ${prs.map((pr,i)=>`
          <div style="
            display:flex;align-items:center;gap:12px;
            padding:13px 16px;
            ${i < prs.length-1 ? 'border-bottom:1px solid var(--line)' : ''}
          ">
            <div style="
              width:36px;height:36px;border-radius:10px;flex-shrink:0;
              background:var(--green-dim);color:var(--green);
              border:1px solid var(--green-line);
              display:flex;align-items:center;justify-content:center;
            ">${IC.trendUp(15)}</div>
            <div style="flex:1;min-width:0">
              <div style="font-size:13px;font-weight:600;color:var(--t0);white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(pr.name)}</div>
              <div style="font-size:11px;color:var(--t2);margin-top:2px">${pr.prev > 0 ? 'anterior: '+pr.prev+'kg' : 'primeira carga registrada'}</div>
            </div>
            <div style="text-align:right;flex-shrink:0">
              <div style="font-family:var(--mono);font-size:16px;font-weight:800;color:var(--green)">${pr.w}kg</div>
              <div style="font-size:10px;color:var(--t2);margin-top:1px">novo PR</div>
            </div>
          </div>
        `).join('')}
      </div>
    </div>` : ''}

    <!-- ── Exercícios ───────────────────────────────────── -->
    <div style="padding:24px 16px 0">
      <div style="font-size:11px;font-weight:600;color:var(--t2);letter-spacing:.07em;text-transform:uppercase;margin-bottom:10px;display:flex;align-items:center;gap:6px">
        <span style="width:5px;height:5px;border-radius:50%;background:var(--green);display:inline-block"></span>
        Exercícios
      </div>
      <div style="background:var(--bg-2);border:1px solid var(--line-2);border-radius:16px;overflow:hidden;padding:0 16px">
        ${exRows.map((r,i)=>i===exRows.length-1
          ? r.replace('border-bottom:1px solid var(--line)', 'border-bottom:none')
          : r
        ).join('')}
      </div>
    </div>

    <!-- ── Botão ─────────────────────────────────────────── -->
    <div style="padding:24px 16px 56px">
      <button class="btn bp lg" onclick="App._closeWorkoutResult()">
        ${IC.check(16)} Fechar
      </button>
    </div>

  `;

  document.body.appendChild(overlay);
  requestAnimationFrame(()=>requestAnimationFrame(()=>{
    overlay.style.transform = 'translateY(0)';
  }));
  if(S.page==='home') App.renderHome();
},

_closeWorkoutResult(){
  const overlay = document.getElementById('workout-result');
  if(!overlay) return;
  overlay.style.transition = 'transform 0.32s cubic-bezier(0.4,0,1,1)';
  overlay.style.transform  = 'translateY(100%)';
  setTimeout(()=>overlay.remove(), 340);
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
  el.innerHTML=S.notifications.map(n=>{
    const cfg=NOTIF_CONFIG[n.type]||NOTIF_CONFIG.info;
    const timeStr=relTime(n.date);
    return `<div data-nid="${esc(n.id)}" style="
        display:flex;align-items:flex-start;gap:12px;padding:13px 0;
        border-bottom:1px solid var(--line);
        transition:transform .22s cubic-bezier(0.4,0,0.2,1),opacity .22s ease,max-height .25s ease;
        overflow:hidden;max-height:120px;
      ">
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

// Anima um elemento de notificação para fora (desliza para direita + some)
_animateNotifOut(el, onDone){
  if(!el){ onDone(); return; }
  el.style.transition='transform .2s cubic-bezier(0.4,0,1,1),opacity .2s ease,max-height .25s ease .05s,padding .25s ease .05s';
  el.style.transform='translateX(60px)';
  el.style.opacity='0';
  el.style.maxHeight='0';
  el.style.paddingTop='0';
  el.style.paddingBottom='0';
  el.style.borderBottomColor='transparent';
  setTimeout(onDone, 270);
},

deleteNotification(id){
  const el=document.querySelector(`[data-nid="${id}"]`);
  App._animateNotifOut(el, ()=>{
    S.notifications=S.notifications.filter(n=>n.id!==id);
    localStorage.setItem('evolv_notifications',JSON.stringify(S.notifications));
    App.renderNotifyBadge();
    if(!S.notifications.length){
      // Última notificação removida — fecha o modal
      App.closeModal();
      return;
    }
    App._renderNotifItems();
    const sub=document.querySelector('#mroot .mo .md div[style*="registros"]');
    if(sub) sub.textContent=`${S.notifications.length} registros`;
    const clearBtn=document.querySelector('#mroot .mo .md button[onclick*="clearAllNotifications"]');
    if(clearBtn) clearBtn.style.display=S.notifications.length?'':'none';
  });
},

clearAllNotifications(){
  // Anima todos os itens em cascata antes de limpar
  const items=[...document.querySelectorAll('#np-list [data-nid]')];
  if(!items.length){
    S.notifications=[];
    localStorage.removeItem('evolv_notifications');
    App.renderNotifyBadge();
    App.closeModal();
    App.showNotifications();
    return;
  }
  items.forEach((el,i)=>{
    setTimeout(()=>{
      el.style.transition='transform .18s cubic-bezier(0.4,0,1,1),opacity .18s ease,max-height .22s ease .04s,padding .22s ease .04s';
      el.style.transform='translateX(60px)';
      el.style.opacity='0';
      el.style.maxHeight='0';
      el.style.paddingTop='0';
      el.style.paddingBottom='0';
      el.style.borderBottomColor='transparent';
    }, i*45); // cascata de 45ms entre cada item
  });
  const totalDelay = items.length*45 + 260;
  setTimeout(()=>{
    S.notifications=[];
    localStorage.removeItem('evolv_notifications');
    App.renderNotifyBadge();
    App.closeModal();
  }, totalDelay);
},

notify(msg,type='info'){
  // Notificações de timer não acumulam — substitui a anterior do mesmo tipo
  if(type==='timer') S.notifications = S.notifications.filter(n=>n.type!=='timer');
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
    <button class="btn bg lg" onclick="App.closeModal();setTimeout(()=>App.showBackupModal(),100)" style="margin-bottom:8px">
      ${IC.export(15)} Backup e exportação
    </button>
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

  // Helper: anima banner para baixo e remove
  const dismissBanner = (el, cb) => {
    const inner = el.querySelector('div');
    if(inner){
      inner.style.transition = 'transform 0.28s cubic-bezier(0.4,0,1,1), opacity 0.22s ease';
      inner.style.transform  = 'translateY(calc(100% + 20px))';
      inner.style.opacity    = '0';
    }
    setTimeout(() => { el.remove(); cb && cb(); }, 300);
  };

  // Retomar treino
  document.getElementById('wo-recovery-resume').addEventListener('click', () => {
    dismissBanner(banner, () => App._restoreWorkoutFromCache(cache, ficha, day));
  });

  // Descartar cache
  document.getElementById('wo-recovery-discard').addEventListener('click', () => {
    dismissBanner(banner, () => { WorkoutCache.clear(); App.toast('Treino descartado.'); });
  });

  // Fechar banner (mantém cache para próxima vez)
  document.getElementById('wo-recovery-dismiss').addEventListener('click', () => {
    dismissBanner(banner);
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

  // Depois: anima banner para cima e overlay some
  document.getElementById('update-later').addEventListener('click', () => {
    const inner = banner.querySelector('div:last-child');
    const overlay = document.getElementById('update-overlay');
    const dur = '0.32s cubic-bezier(0.4,0,1,1)';
    if(inner){
      inner.style.transition = `transform ${dur}, opacity 0.24s ease`;
      inner.style.transform  = 'translateY(-120%)';
      inner.style.opacity    = '0';
    }
    if(overlay){
      overlay.style.transition = 'opacity 0.28s ease';
      overlay.style.opacity    = '0';
    }
    setTimeout(() => banner.remove(), 380);
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

  // [THEME] Aplica tema salvo antes de qualquer render
  App._applyTheme(DB.getPref('theme', 'dark'));

  document.addEventListener('click',e=>{
    try{ if(!App.sound.enabled)return; const btn=e.target.closest('button,.ni,.icon-btn'); if(btn)App.sound.play('click'); }catch{}
  },{capture:false});

  window.addEventListener('beforeinstallprompt',e=>{e.preventDefault();App._ip=e;});

  // [TIMER] Registra listener de visibilidade para corrigir timer após background
  document.addEventListener('visibilitychange', App._onVisibilityChange);

  // [CACHE-WO] Verifica treino interrompido após o DB estar pronto
  setTimeout(() => App.checkWorkoutCache(), 600);

  // [UPDATE] Inicia sistema de detecção de atualizações do SW
  App.initUpdateSystem();

  // [SWIPE] Ativa gesto pull-to-dismiss em todos os modais
  App._initSwipeObserver();

  // [ONBOARDING] Exibe boas-vindas se for a primeira vez
  if(!DB.getPref('onboarded', false)){
    setTimeout(() => App.showOnboarding(), 400);
  }

  // CSS de animação do sino e modal fluido
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

      /* ── Animação fluida do modal sheet (sobrescreve o base) ──
         Curva: começa rápido (saindo do fundo da tela), desacelera
         expressivamente no final — igual ao sheet do iOS.
         will-change garante que o browser use compositor layer (GPU).  */
      @keyframes mslide{
        from{ transform:translateY(100%); }
        to{   transform:translateY(0);    }
      }
      .md{
        animation: mslide .38s cubic-bezier(0.25,1,0.5,1) !important;
        will-change: transform;
      }
      @keyframes mfade{
        from{ opacity:0; }
        to{   opacity:1; }
      }
      .mo{ animation: mfade .25s ease !important; }

      /* ── Feedback tátil nos cards ── */
      .card, .fc, .wi, .sc, .ex-card, .lb-row {
        transition: transform 0.18s cubic-bezier(0.34,1.56,0.64,1) !important;
      }
      .card:active, .fc:active, .wi:active, .sc:active {
        transform: scale(0.977) !important;
        transition: transform 0.08s ease !important;
      }

      /* ── Navbar: pill colorido na aba ativa ── */
      .ni {
        border-radius: 14px;
        padding: 6px 10px !important;
        transition: background 0.18s ease, color 0.18s ease !important;
        position: relative;
      }
      .ni.active {
        background: var(--green-dim) !important;
        color: var(--green) !important;
      }
      .ni.active svg { stroke: var(--green) !important; }
      .ni.active .ni-label { color: var(--green) !important; }
      /* Remove o ::before separator — visualmente conflita com o pill */
      .ni + .ni::before { display: none !important; }

      /* ── Eyebrow com ponto decorativo ── */
      .eyebrow {
        display: flex;
        align-items: center;
        gap: 6px;
      }
      .eyebrow::before {
        content: '';
        display: inline-block;
        width: 5px;
        height: 5px;
        border-radius: 50%;
        background: var(--green);
        opacity: 0.7;
        flex-shrink: 0;
      }

      /* ── Status dot — 3 estados ── */
      .status-dot { transition: background .3s, box-shadow .3s; }
      .status-dot.off {
        background: var(--red) !important;
        box-shadow: 0 0 0 0 transparent !important;
      }
      .status-dot.pending {
        background: var(--heat) !important;
        box-shadow: 0 0 6px var(--heat) !important;
        animation: dot-pulse 1.8s ease-in-out infinite;
      }
      .status-dot.syncing {
        background: var(--cool) !important;
        box-shadow: 0 0 6px var(--cool) !important;
        animation: dot-spin 1s linear infinite;
      }
      @keyframes dot-pulse {
        0%,100%{ opacity:1; } 50%{ opacity:.45; }
      }
      @keyframes dot-spin {
        0%{ box-shadow: 0 0 6px var(--cool); }
        50%{ box-shadow: 0 0 12px var(--cool); }
        100%{ box-shadow: 0 0 6px var(--cool); }
      }
      .sv, .num, .h1, #tdisplay {
        font-variant-numeric: tabular-nums !important;
        font-weight: 800 !important;
      }

      #theme-toggle-knob {
        transition: left .22s cubic-bezier(0.34,1.56,0.64,1) !important;
      }
      #theme-toggle-pill {
        transition: background .2s ease, border-color .2s ease !important;
      }

      /* ── Perfil — linhas de preferência ── */
      .pref-row {
        display: flex; align-items: center; gap: 12px;
        padding: 13px 16px; border-bottom: 1px solid var(--line);
        cursor: pointer; transition: background .12s;
        -webkit-tap-highlight-color: transparent;
      }
      .pref-row:active { background: var(--bg-3); }
      .pref-ico {
        width: 36px; height: 36px; border-radius: 10px; flex-shrink: 0;
        display: flex; align-items: center; justify-content: center;
        color: var(--t1);
      }
      .pref-info { flex: 1; min-width: 0; }
      .pref-label { font-size: 14px; font-weight: 600; color: var(--t0); }
      .pref-val   { font-size: 12px; color: var(--t2); margin-top: 1px; }
      [data-theme="light"] .pref-row:active { background: var(--bg-2); }
    `;
    document.head.appendChild(s);
  }
},

// ═══════════════════════════════════════════════════════════════
// PERFIL
// ═══════════════════════════════════════════════════════════════
renderPerfil(){
  const root = $('perfil-content'); if(!root) return;
  const name     = DB.getPref('displayName','');
  const theme    = DB.getPref('theme','dark');
  const restTime = DB.getPref('restTime', 90);
  const weekTarget = DB.getPref('weekTarget', 5);
  const sid      = localStorage.getItem('evolv_sync_id')||'—';
  const isLight  = theme === 'light';

  const fichas  = DB.fichas();
  const sessoes = DB.sessoes();
  const pesos   = DB.pesos();

  // Avatar baseado nas iniciais do nome
  const initials = name.trim()
    ? name.trim().split(/\s+/).slice(0,2).map(w=>w[0].toUpperCase()).join('')
    : '?';

  root.innerHTML = `
    <!-- Avatar + nome -->
    <div style="text-align:center;padding:28px 20px 20px">
      <div onclick="App.editProfileName()" style="
        width:72px;height:72px;border-radius:24px;
        background:var(--green-dim);color:var(--green);
        border:1.5px solid var(--green-line);
        display:inline-flex;align-items:center;justify-content:center;
        font-size:24px;font-weight:800;letter-spacing:-0.02em;
        cursor:pointer;margin-bottom:12px;
        transition:transform .15s cubic-bezier(0.34,1.56,0.64,1);
      " onmousedown="this.style.transform='scale(0.93)'" onmouseup="this.style.transform=''" ontouchstart="this.style.transform='scale(0.93)'" ontouchend="this.style.transform=''">${esc(initials)}</div>
      <div style="font-size:20px;font-weight:700;color:var(--t0);letter-spacing:-0.02em;margin-bottom:4px">
        ${name ? esc(name) : '<span style="color:var(--t3)">Adicionar nome</span>'}
      </div>
      <div style="font-size:12px;color:var(--t2)">${sessoes.length} treinos registrados</div>
    </div>

    <!-- Stats rápidas -->
    <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:8px;margin:0 0 20px">
      <div class="sc">
        <div class="sl">Fichas</div>
        <div class="sv">${fichas.length}</div>
        <div class="ss">criadas</div>
      </div>
      <div class="sc">
        <div class="sl" style="color:var(--heat)">Treinos</div>
        <div class="sv">${sessoes.length}</div>
        <div class="ss">totais</div>
      </div>
      <div class="sc">
        <div class="sl" style="color:var(--cool)">Pesagens</div>
        <div class="sv">${pesos.length}</div>
        <div class="ss">registradas</div>
      </div>
    </div>

    <!-- PREFERÊNCIAS -->
    <div class="eyebrow" style="margin:0 0 10px">Preferências</div>
    <div class="card" style="padding:0;overflow:hidden;margin-bottom:20px">

      <!-- Tema -->
      <div class="pref-row" onclick="App.toggleTheme()">
        <div class="pref-ico" style="background:var(--bg-3)">${IC.moon(18)}</div>
        <div class="pref-info">
          <div class="pref-label">Tema</div>
          <div class="pref-val">${isLight ? 'Claro' : 'Escuro'}</div>
        </div>
        <div id="theme-toggle-pill" style="
          width:44px;height:26px;border-radius:999px;flex-shrink:0;pointer-events:none;
          background:${isLight?'var(--green)':'var(--bg-4)'};
          border:1px solid ${isLight?'var(--green-line)':'var(--line-2)'};
          position:relative;transition:background .2s,border-color .2s;
        ">
        <div id="theme-toggle-knob" style="
            position:absolute;top:3px;
            left:${isLight?'21px':'3px'};
            width:18px;height:18px;border-radius:50%;
            background:#fff;
            box-shadow:0 1px 4px rgba(0,0,0,0.2);
          "></div>
        </div>
      </div>

      <!-- Meta semanal -->
      <div class="pref-row" onclick="App.showWeekTargetModal()">
        <div class="pref-ico" style="background:var(--cool-dim);color:var(--cool)">${IC.activity(18)}</div>
        <div class="pref-info">
          <div class="pref-label">Meta semanal</div>
          <div class="pref-val">${weekTarget} dia${weekTarget!==1?'s':''} por semana</div>
        </div>
        ${IC.chevronRight(16)}
      </div>

      <!-- Descanso padrão -->
      <div class="pref-row" onclick="App.showRestTimeModal()">
        <div class="pref-ico" style="background:var(--heat-dim);color:var(--heat)">${IC.stopwatch(18)}</div>
        <div class="pref-info">
          <div class="pref-label">Descanso padrão</div>
          <div class="pref-val">${restTime<60?restTime+'s':restTime/60+'min'} entre séries</div>
        </div>
        ${IC.chevronRight(16)}
      </div>

      <!-- Notificações -->
      <div class="pref-row" onclick="App.requestNotifPermission()" style="border-bottom:none">
        <div class="pref-ico" style="background:var(--violet-dim);color:var(--violet)">${IC.bell(18)}</div>
        <div class="pref-info">
          <div class="pref-label">Notificações push</div>
          <div class="pref-val">${typeof Notification!=='undefined'&&Notification.permission==='granted'?'Ativadas':'Toque para ativar'}</div>
        </div>
        ${IC.chevronRight(16)}
      </div>
    </div>

    <!-- DADOS E SYNC -->
    <div class="eyebrow" style="margin:0 0 10px">Dados e sync</div>
    <div class="card" style="padding:0;overflow:hidden;margin-bottom:20px">

      <!-- Backup -->
      <div class="pref-row" onclick="App.showBackupModal()">
        <div class="pref-ico" style="background:var(--green-dim);color:var(--green)">${IC.export(18)}</div>
        <div class="pref-info">
          <div class="pref-label">Backup e exportação</div>
          <div class="pref-val">JSON completo · CSV · importar</div>
        </div>
        ${IC.chevronRight(16)}
      </div>

      <!-- Sync -->
      <div class="pref-row" onclick="App.showSyncModal()" style="border-bottom:none">
        <div class="pref-ico" style="background:var(--cool-dim);color:var(--cool)">${IC.sync(18)}</div>
        <div class="pref-info">
          <div class="pref-label">Sync entre dispositivos</div>
          <div class="pref-val" style="font-family:var(--mono);font-size:10px;letter-spacing:.04em">${sid.slice(0,20)}…</div>
        </div>
        ${IC.chevronRight(16)}
      </div>
    </div>

    <!-- SOBRE -->
    <div class="eyebrow" style="margin:0 0 10px">Sobre</div>
    <div class="card" style="padding:0;overflow:hidden;margin-bottom:20px">
      <div class="pref-row" style="border-bottom:none;cursor:default">
        <div class="pref-ico" style="background:var(--bg-3)">
          <img src="logo.png" style="width:18px;height:18px;object-fit:contain">
        </div>
        <div class="pref-info">
          <div class="pref-label">EVOLV</div>
          <div class="pref-val">App de gestão de treinos</div>
        </div>
      </div>
    </div>

    <!-- ZONA DE PERIGO -->
    <div class="eyebrow" style="margin:0 0 10px;color:var(--red)">Zona de perigo</div>
    <div class="card" style="padding:0;overflow:hidden;border-color:var(--red-dim);margin-bottom:32px">
      <div class="pref-row" onclick="App.confirmClearData('sessoes')" style="border-bottom:1px solid var(--line)">
        <div class="pref-ico" style="background:var(--red-dim);color:var(--red)">${IC.trash(18)}</div>
        <div class="pref-info">
          <div class="pref-label" style="color:var(--red)">Apagar histórico de treinos</div>
          <div class="pref-val">${sessoes.length} sessões serão removidas</div>
        </div>
        ${IC.chevronRight(16)}
      </div>
      <div class="pref-row" onclick="App.confirmClearData('all')" style="border-bottom:none">
        <div class="pref-ico" style="background:var(--red-dim);color:var(--red)">${IC.close(18)}</div>
        <div class="pref-info">
          <div class="pref-label" style="color:var(--red)">Apagar todos os dados</div>
          <div class="pref-val">Fichas, treinos, pesagens e prefs</div>
        </div>
        ${IC.chevronRight(16)}
      </div>
    </div>
  `;
},

editProfileName(){
  App.closeModal();
  const current = DB.getPref('displayName','');
  const m = document.createElement('div'); m.className='mo';
  m.innerHTML=`<div class="md">
    <div class="mhandle"></div>
    <div class="mtitle">Seu nome</div>
    <div class="ig" style="margin-bottom:16px">
      <label>Como quer ser chamado?</label>
      <input type="text" id="profile-name-input" value="${esc(current)}" placeholder="Seu nome" maxlength="40" autocomplete="off">
    </div>
    <button class="btn bp lg" onclick="App.saveProfileName()">Salvar</button>
    <button class="btn bg" onclick="App.closeModal()" style="margin-top:8px">Cancelar</button>
  </div>`;
  m.addEventListener('click',e=>{if(e.target===m)App.closeModal();});
  $('mroot').appendChild(m);
  setTimeout(()=>{ const inp=$('profile-name-input'); inp?.focus(); inp?.select(); }, 200);
},

async saveProfileName(){
  const inp = document.getElementById('profile-name-input');
  const val = (inp?.value||'').trim().slice(0,40);
  await DB.setPref('displayName', val);
  App.closeModal();
  App.renderPerfil();
  App.toast(val ? `Olá, ${val}!` : 'Nome removido');
},

async confirmClearData(what){
  const labels = {
    sessoes: { title:'Apagar histórico', msg:`Todos os ${DB.sessoes().length} treinos registrados serão removidos permanentemente. Fichas e pesagens são mantidas.`, btn:'Apagar histórico' },
    all:     { title:'Apagar tudo',      msg:'Todos os seus dados serão removidos: fichas, treinos, pesagens e preferências. Esta ação não pode ser desfeita.', btn:'Apagar tudo' },
  };
  const l = labels[what];
  App.showConfirmDialog({
    title: l.title,
    message: l.msg,
    confirmText: l.btn,
    cancelText: 'Cancelar',
    isDangerous: true,
    onConfirm: async ()=>{ await App._clearData(what); },
  });
},

async _clearData(what){
  if(what==='sessoes' || what==='all'){
    for(const s of [...DB.sessoes()]) await DB.delSessao(s.id);
  }
  if(what==='all'){
    for(const f of [...DB.fichas()])  await DB.delFicha(f.id);
    for(const p of [...DB.pesos()])   await DB.delPeso(p.id);
    await IDB.clear('prefs');
    DB.cache.prefs = {};
  }
  App.renderPerfil();
  App.renderHome();
  App.toast(what==='all' ? 'Todos os dados removidos.' : 'Histórico apagado.');
},

updateDot(){
  const dot=$('status-dot'); if(!dot) return;

  // Limpa classes anteriores
  dot.className = 'status-dot';

  if(DB._syncing){
    // Sincronizando fila pendente
    dot.classList.add('syncing');
    dot.title = 'Sincronizando dados pendentes…';
    dot.style.cursor = 'default';
    dot.onclick = null;
    return;
  }

  // Verifica itens pendentes na fila (async, atualiza depois)
  SyncQueue.count().then(pending=>{
    if(pending>0){
      dot.classList.add('pending');
      dot.title = `${pending} operação${pending>1?'s':''} pendente${pending>1?'s':''} — aguardando conexão`;
      dot.style.cursor = 'pointer';
      dot.onclick = ()=>App.showSyncStatusModal();
    } else if(DB._local){
      dot.classList.add('off');
      dot.title = 'Modo offline — clique para reconectar';
      dot.style.cursor = 'pointer';
      dot.onclick = ()=>App.showReconnectModal();
    } else if(!DB._online){
      dot.classList.add('off');
      dot.title = 'Sem conexão — dados salvos localmente';
      dot.style.cursor = 'default';
      dot.onclick = null;
    } else {
      // Online e sincronizado
      dot.title = 'Sincronizado — clique para detalhes';
      dot.style.cursor = 'pointer';
      dot.onclick = ()=>App.showSyncModal();
    }
  });
},

// Modal de status de sync — mostra itens pendentes
async showSyncStatusModal(){
  const items = await IDB.getAll('sync_queue');
  const m = document.createElement('div'); m.className='mo';
  m.innerHTML=`<div class="md">
    <div class="mhandle"></div>
    <div class="mtitle">Dados pendentes de sync</div>
    <div style="font-size:13px;color:var(--t2);margin:-10px 0 16px;line-height:1.5">
      ${items.length} operação${items.length!==1?'es':''} aguardando conexão com internet.
      Seus dados estão seguros no dispositivo.
    </div>
    <div style="background:var(--bg-3);border-radius:12px;padding:12px 14px;margin-bottom:16px">
      ${items.slice(0,8).map(it=>`
        <div style="display:flex;align-items:center;gap:8px;padding:5px 0;border-bottom:1px solid var(--line);font-size:12px;color:var(--t1)">
          <span style="font-family:var(--mono);font-size:10px;color:var(--t2);flex-shrink:0">${it.op.toUpperCase()}</span>
          <span style="flex:1">${it.col} / ${it.docId.slice(0,8)}…</span>
          <span style="color:var(--t3);font-size:10px">${new Date(it.ts).toLocaleTimeString('pt-BR',{hour:'2-digit',minute:'2-digit'})}</span>
        </div>
      `).join('')}
      ${items.length>8?`<div style="font-size:11px;color:var(--t2);padding-top:6px">+${items.length-8} mais…</div>`:''}
    </div>
    <button class="btn bp lg" onclick="App.closeModal()">Fechar</button>
  </div>`;
  m.addEventListener('click',e=>{if(e.target===m)App.closeModal();});
  $('mroot').appendChild(m);
},

// ═══════════════════════════════════════════════════════════════
// ONBOARDING
// ═══════════════════════════════════════════════════════════════
showOnboarding(force=false){
  // Pula automaticamente se o usuário já tem dados (sync de outro dispositivo)
  // mas respeita o flag force para testes via console
  if(!force && (DB.fichas().length || DB.sessoes().length)){
    DB.setPref('onboarded', true);
    return;
  }

  const steps = [
    {
      icon: IC.clipboard(28),
      color: 'var(--green)',
      dim: 'var(--green-dim)',
      line: 'var(--green-line)',
      title: 'Crie sua ficha',
      desc: 'Vá em <strong>Fichas</strong> e crie sua primeira rotina de treino. Adicione os dias, exercícios, séries e repetições.',
    },
    {
      icon: IC.play(28),
      color: 'var(--cool)',
      dim: 'var(--cool-dim)',
      line: 'rgba(107,168,255,0.32)',
      title: 'Inicie o treino',
      desc: 'Na <strong>Home</strong>, toque em "Iniciar treino" ou selecione um dia diretamente na ficha para começar a sessão.',
    },
    {
      icon: IC.activity(28),
      color: 'var(--violet)',
      dim: 'var(--violet-dim)',
      line: 'rgba(181,131,255,0.32)',
      title: 'Marque as séries',
      desc: 'Durante o treino, registre a carga e toque no <strong>✓</strong> ao completar cada série. O timer inicia automaticamente.',
    },
    {
      icon: IC.trendUp(28),
      color: 'var(--heat)',
      dim: 'var(--heat-dim)',
      line: 'rgba(255,138,59,0.32)',
      title: 'Acompanhe a evolução',
      desc: 'Em <strong>Stats</strong> veja sua frequência, personal records e exercícios mais praticados. Em <strong>Peso</strong>, registre suas pesagens.',
    },
  ];

  let step = 0;

  // Detecta tema ativo para adaptar as cores do overlay
  const isLight = document.documentElement.getAttribute('data-theme') === 'light';
  const overlayBg    = isLight ? 'rgba(241,243,245,0.97)' : 'rgba(8,9,12,0.95)';
  const textPrimary  = isLight ? '#0D0F12' : '#F5F6F8';
  const textSecond   = isLight ? 'rgba(13,15,18,0.60)' : 'rgba(245,246,248,0.55)';
  const dotInactive  = isLight ? '#DEE2E6' : 'rgba(245,246,248,0.15)';
  const btnSkipBg    = isLight ? 'rgba(0,0,0,0.06)' : 'rgba(255,255,255,0.08)';
  const btnSkipColor = isLight ? 'rgba(13,15,18,0.55)' : 'rgba(245,246,248,0.55)';

  const overlay = document.createElement('div');
  overlay.id = 'onboarding-overlay';
  overlay.style.cssText = `
    position:fixed;inset:0;z-index:400;
    background:${overlayBg};
    display:flex;flex-direction:column;align-items:center;justify-content:center;
    padding:32px 24px;animation:mfade .3s ease;
  `;

  document.body.appendChild(overlay);

  const finish = () => {
    overlay.remove();
    DB.setPref('onboarded', true);
    App.nav('fichas');
  };
  const skip = () => {
    overlay.remove();
    DB.setPref('onboarded', true);
  };

  const render = () => {
    const s = steps[step];
    const isLast = step === steps.length - 1;
    overlay.innerHTML = `
      <div style="width:100%;max-width:320px;text-align:center">

        <!-- Ícone do step -->
        <div style="
          width:80px;height:80px;border-radius:24px;
          background:${s.dim};color:${s.color};
          border:1.5px solid ${s.line};
          display:inline-flex;align-items:center;justify-content:center;
          margin-bottom:28px;
        ">${s.icon.replace('20','32').replace('20','32')}</div>

        <!-- Título -->
        <div style="
          font-size:24px;font-weight:700;
          color:${textPrimary};
          letter-spacing:-0.025em;line-height:1.1;
          margin-bottom:12px;
        ">${s.title}</div>

        <!-- Descrição -->
        <div style="
          font-size:14px;color:${textSecond};
          line-height:1.65;margin-bottom:36px;
        ">${s.desc}</div>

        <!-- Dots -->
        <div style="display:flex;justify-content:center;gap:6px;margin-bottom:28px">
          ${steps.map((_,i)=>`<div style="
            width:${i===step?22:6}px;height:6px;border-radius:999px;
            background:${i===step?s.color:dotInactive};
            transition:width .25s,background .25s;
          "></div>`).join('')}
        </div>

        <!-- Botão principal -->
        <button id="ob-next" style="
          width:100%;height:52px;border-radius:16px;border:none;cursor:pointer;
          background:linear-gradient(160deg,${s.color},${s.color === 'var(--green)' ? 'var(--green-2)' : s.color});
          color:${s.color === 'var(--green)' ? '#06140C' : '#fff'};
          font-family:var(--font);font-size:15px;font-weight:700;
          display:flex;align-items:center;justify-content:center;gap:8px;
          margin-bottom:12px;
          box-shadow:0 8px 24px -8px ${s.color === 'var(--green)' ? 'rgba(31,224,122,0.5)' : 'rgba(0,0,0,0.2)'};
        ">
          ${isLast?`${IC.check(16)} Começar agora`:`Próximo ${IC.chevronRight(16)}`}
        </button>

        <!-- Botões secundários -->
        <div style="display:flex;gap:8px">
          ${step>0?`
            <button id="ob-back" style="
              flex:1;height:42px;border-radius:12px;cursor:pointer;
              background:${btnSkipBg};border:none;
              color:${btnSkipColor};font-family:var(--font);font-size:13px;font-weight:600;
            ">Voltar</button>
          `:''}
          ${step===0?`
            <button id="ob-skip" style="
              flex:1;height:42px;border-radius:12px;cursor:pointer;
              background:none;border:none;
              color:${btnSkipColor};font-family:var(--font);font-size:13px;font-weight:500;
            ">Pular</button>
          `:''}
        </div>
      </div>
    `;

    overlay.querySelector('#ob-next').addEventListener('click', () => {
      isLast ? finish() : (step++, render());
    });
    overlay.querySelector('#ob-back')?.addEventListener('click', () => { step--; render(); });
    overlay.querySelector('#ob-skip')?.addEventListener('click', skip);
  };

  render();
},

// ═══════════════════════════════════════════════════════════════
// TEMA CLARO / ESCURO
// ═══════════════════════════════════════════════════════════════
_applyTheme(theme){
  const root = document.documentElement;

  // Injeta o bloco de CSS do tema claro uma única vez
  if(!document.getElementById('evolv-light-theme')){
    const s = document.createElement('style');
    s.id = 'evolv-light-theme';
    s.textContent = `
      /* ── Tema claro — sobrescreve hardcodes do CSS base ── */
      [data-theme="light"] {
        color-scheme: light;
        background: #FFFFFF;
      }

      /* Body e html */
      [data-theme="light"] html,
      [data-theme="light"] body {
        background: #F1F3F5;
      }

      /* Inputs e selects — remove color-scheme dark */
      [data-theme="light"] input,
      [data-theme="light"] select,
      [data-theme="light"] textarea {
        color-scheme: light;
        background: #E9ECEF;
        border-color: rgba(0,0,0,0.10);
        color: #0D0F12;
      }
      [data-theme="light"] input:focus,
      [data-theme="light"] select:focus,
      [data-theme="light"] textarea:focus {
        background: #E9ECEF;
        border-color: rgba(31,224,122,0.5);
      }

      /* Header */
      [data-theme="light"] #hdr {
        background: #FFFFFF;
        border-bottom-color: rgba(0,0,0,0.06);
      }

      /* Navbar */
      [data-theme="light"] #nav {
        background: rgba(255,255,255,0.96) !important;
        border-color: rgba(0,0,0,0.10) !important;
        box-shadow: 0 -8px 24px rgba(0,0,0,0.08) !important;
      }
      [data-theme="light"] .ni { color: rgba(13,15,18,0.4); }
      [data-theme="light"] .ni.active { color: #0D0F12; }

      /* Hero da home — gradiente claro */
      [data-theme="light"] .hero {
        background:
          radial-gradient(120% 100% at 0% 0%, rgba(31,224,122,0.14) 0%, transparent 55%),
          linear-gradient(160deg, #F1F3F5 0%, #FFFFFF 100%);
        border-color: rgba(0,0,0,0.08);
      }
      [data-theme="light"] .hero::after {
        background: radial-gradient(circle, rgba(31,224,122,0.10), transparent 65%);
      }

      /* Cards */
      [data-theme="light"] .card {
        background: #FFFFFF;
        border-color: rgba(0,0,0,0.06);
      }

      /* Modais */
      [data-theme="light"] .mo {
        background: rgba(0,0,0,0.3);
      }
      [data-theme="light"] .md {
        background: #FFFFFF;
        border-top-color: rgba(0,0,0,0.08);
      }

      /* Overlay de treino ativo */
      [data-theme="light"] #aw,
      [data-theme="light"] .aw-hdr,
      [data-theme="light"] .aw-ftr {
        background: #FFFFFF;
        border-color: rgba(0,0,0,0.06);
      }
      [data-theme="light"] .pbar-wrap { background: #F1F3F5; }
      [data-theme="light"] .ex-card { background: #F1F3F5; border-color: rgba(0,0,0,0.06); }

      /* Stats cells */
      [data-theme="light"] .sc { background: #FFFFFF; border-color: rgba(0,0,0,0.06); }
      [data-theme="light"] .sc .sv { color: #0D0F12; }

      /* Ficha cards */
      [data-theme="light"] .fc { background: #FFFFFF; border-color: rgba(0,0,0,0.06); }
      [data-theme="light"] .fc-day { background: #F1F3F5; border-color: rgba(0,0,0,0.06); }

      /* Workout items */
      [data-theme="light"] .wi { background: #FFFFFF; border-color: rgba(0,0,0,0.06); }
      [data-theme="light"] .wi:active { background: #F1F3F5; }

      /* Week dots */
      [data-theme="light"] .wdot { background: #E9ECEF; border-color: rgba(0,0,0,0.08); }

      /* Botões */
      [data-theme="light"] .bg { border-color: rgba(0,0,0,0.12); color: rgba(13,15,18,0.7); }
      [data-theme="light"] .bg:hover { background: #F1F3F5; }
      [data-theme="light"] .bs { background: #F1F3F5; border-color: rgba(0,0,0,0.10); }
      [data-theme="light"] .icon-btn { background: #F1F3F5; border-color: rgba(0,0,0,0.10); color: rgba(13,15,18,0.6); }
      [data-theme="light"] .icon-btn:hover { background: #E9ECEF; }
      [data-theme="light"] .set-chk { background: #E9ECEF; border-color: rgba(0,0,0,0.12); }

      /* Leaderboard rows */
      [data-theme="light"] .lb-row { background: #FFFFFF; border-color: rgba(0,0,0,0.06); }
      [data-theme="light"] .lb-bar { background: #E9ECEF; }

      /* DB builder */
      [data-theme="light"] .db { background: #F1F3F5; border-color: rgba(0,0,0,0.06); }

      /* Barras de progresso */
      [data-theme="light"] .prog-track { background: #E9ECEF; }
      [data-theme="light"] .bar-col .bar { background: #E9ECEF; border-color: rgba(0,0,0,0.06); }

      /* Toast */
      [data-theme="light"] .toast {
        background: #FFFFFF;
        border-color: rgba(0,0,0,0.10);
        color: #0D0F12;
        box-shadow: 0 8px 24px rgba(0,0,0,0.12);
      }

      /* Status dot */
      [data-theme="light"] .status-dot {
        box-shadow: 0 0 8px rgba(31,224,122,0.5);
      }

      /* Chart.js tooltip — override inline style injetado pelo Chart.js */
      [data-theme="light"] .chartjs-tooltip {
        background: #FFFFFF !important;
        color: #0D0F12 !important;
      }

      /* Loading */
      [data-theme="light"] #loading {
        background: radial-gradient(circle at top, rgba(31,224,122,0.06), transparent 42%), #FFFFFF;
      }

      /* Peso history rows */
      [data-theme="light"] .prow { border-bottom-color: rgba(0,0,0,0.06); }

      /* Barra de progresso de peso */
      [data-theme="light"] .peso-goal-bar { background: #E9ECEF; border-color: rgba(0,0,0,0.08); }

      /* Timer ring glow */
      [data-theme="light"] .tring-wrap::before {
        background: radial-gradient(circle, rgba(31,224,122,0.08), transparent 65%);
      }

      /* Preset buttons do timer */
      [data-theme="light"] .tp {
        background: #E9ECEF;
        border-color: rgba(0,0,0,0.10);
        color: rgba(13,15,18,0.7);
      }
      [data-theme="light"] .tp.on {
        background: var(--green-dim);
        border-color: var(--green-line);
        color: var(--green);
      }

      /* Segmented control */
      [data-theme="light"] .seg { background: #F1F3F5; border-color: rgba(0,0,0,0.08); }
      [data-theme="light"] .seg-btn.on { background: #FFFFFF; color: #0D0F12; }

      /* Empty states */
      [data-theme="light"] .empty-ico { background: #F1F3F5; border-color: rgba(0,0,0,0.06); }

      /* AW resume pill */
      [data-theme="light"] .aw-resume {
        background: rgba(255,255,255,0.96);
        border-color: rgba(0,0,0,0.10);
        box-shadow: 0 8px 24px rgba(0,0,0,0.10);
      }

      /* Notif badge */
      [data-theme="light"] .notify-badge {
        box-shadow: 0 0 0 2px #FFFFFF;
      }
    `;
    document.head.appendChild(s);
  }

  // Aplica/remove variáveis e atributo
  if(theme === 'light'){
    root.style.setProperty('--bg-0','#F8F9FA');
    root.style.setProperty('--bg-1','#FFFFFF');
    root.style.setProperty('--bg-2','#F1F3F5');
    root.style.setProperty('--bg-3','#E9ECEF');
    root.style.setProperty('--bg-4','#DEE2E6');
    root.style.setProperty('--line','rgba(0,0,0,0.06)');
    root.style.setProperty('--line-2','rgba(0,0,0,0.10)');
    root.style.setProperty('--line-3','rgba(0,0,0,0.16)');
    root.style.setProperty('--t0','#0D0F12');
    root.style.setProperty('--t1','rgba(13,15,18,0.72)');
    root.style.setProperty('--t2','rgba(13,15,18,0.48)');
    root.style.setProperty('--t3','rgba(13,15,18,0.28)');
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content','#FFFFFF');
    const ico = document.getElementById('theme-ico');
    if(ico) ico.innerHTML='<path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/>';
  } else {
    ['--bg-0','--bg-1','--bg-2','--bg-3','--bg-4',
     '--line','--line-2','--line-3',
     '--t0','--t1','--t2','--t3'].forEach(v=>root.style.removeProperty(v));
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content','#0E1015');
    const ico = document.getElementById('theme-ico');
    if(ico) ico.innerHTML='<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41"/>';
  }
  // Atualiza toggle pill do perfil se estiver visível
  const pill  = document.getElementById('theme-toggle-pill');
  const knob  = document.getElementById('theme-toggle-knob');
  if(pill && knob){
    pill.style.background    = theme==='light' ? 'var(--green)' : 'var(--bg-4)';
    pill.style.borderColor   = theme==='light' ? 'var(--green-line)' : 'var(--line-2)';
    knob.style.left          = theme==='light' ? '21px' : '3px';
  }

  root.setAttribute('data-theme', theme);

  // Re-renderiza a página atual para atualizar cores inline dos charts
  if(typeof S !== 'undefined' && S.page) App.renderPage(S.page);
},

toggleTheme(){
  const current = DB.getPref('theme','dark');
  const next = current === 'dark' ? 'light' : 'dark';
  DB.setPref('theme', next);
  App._applyTheme(next);
  App.toast(next === 'light' ? 'Tema claro ativado' : 'Tema escuro ativado');
  // Atualiza a página de perfil se estiver aberta
  if(S.page === 'perfil') App.renderPerfil();
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

closeModal(){
  document.querySelectorAll('.mo').forEach(mo=>{
    if(mo._closing) return;
    mo._closing = true;
    const md = mo.querySelector('.md');
    if(!md){ mo.remove(); return; }
    // Se o swipe já iniciou a saída, só aguarda e remove
    const ty = md.style.transform;
    if(ty && ty !== 'translateY(0px)' && ty !== 'translateY(0)' && ty !== ''){
      setTimeout(()=>mo.remove(), 260);
      return;
    }
    // Anima sheet para baixo + overlay some
    md.style.transition = 'transform 0.28s cubic-bezier(0.4,0,1,1)';
    md.style.transform  = 'translateY(105%)';
    mo.style.transition = 'opacity 0.22s ease';
    mo.style.opacity    = '0';
    setTimeout(()=>mo.remove(), 300);
  });
},

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