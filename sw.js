// ─── EVOLV Service Worker ────────────────────────────────────────
// COMO FUNCIONA O SISTEMA DE ATUALIZAÇÃO:
//
//  1. O browser verifica se sw.js mudou a cada acesso ao app
//     (ou a cada 24h no máximo). Basta alterar qualquer byte
//     neste arquivo — normalmente só o CACHE_NAME abaixo.
//
//  2. Se detectar mudança, instala o novo SW em paralelo
//     (estado "installing" → "installed/waiting").
//
//  3. A página detecta isso via o evento "updatefound" e exibe
//     o banner "Nova versão disponível".
//
//  4. Ao clicar "Atualizar agora", a página envia a mensagem
//     {type: 'SKIP_WAITING'} para este SW.
//
//  5. O SW chama skipWaiting(), torna-se ativo imediatamente,
//     dispara "controllerchange" na página, que recarrega.
//
// PARA PUBLICAR UMA ATUALIZAÇÃO:
//  → Mude apenas o número em CACHE_NAME (ex: evolv-v17, evolv-v18…)
//  → Suba o sw.js modificado junto com os demais arquivos
//  → Na próxima vez que o usuário abrir o app, o banner aparece
// ─────────────────────────────────────────────────────────────────

const CACHE_NAME = 'evolv-v1.0.1';

// Arquivos que serão cacheados no install para funcionamento offline
const PRECACHE = [
  './',
  './index.html',
  './evolv-app.js',
  './evolv-styles.css',
  './evolv-tokens.css',
  './icon.png',
  './logo.png',
];

// ── Install ───────────────────────────────────────────────────────
// Não chama skipWaiting() aqui — deixa a PÁGINA decidir o momento.
// Isso evita recarregar no meio de um treino em andamento.
self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => cache.addAll(PRECACHE))
      .catch(() => {}) // falha silenciosa se offline no install
  );
});

// ── Activate ──────────────────────────────────────────────────────
// Remove caches de versões antigas ao ativar.
self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(
        keys
          .filter(k => k !== CACHE_NAME && k.startsWith('evolv-'))
          .map(k => caches.delete(k))
      ))
      .then(() => clients.claim())
  );
});

// ── Fetch ─────────────────────────────────────────────────────────
// Estratégia: Network First com fallback para cache.
// Sempre tenta a rede primeiro; se falhar (offline), serve o cache.
// Atualiza o cache em background a cada resposta bem-sucedida.
self.addEventListener('fetch', e => {
  // Ignora requisições não-HTTP (chrome-extension://, etc.)
  if (!e.request.url.startsWith('http')) return;

  // Ignora Firebase e CDNs externos — não faz sentido cachear
  const url = new URL(e.request.url);
  const isExternal = !url.hostname.includes(self.location.hostname) &&
    !url.hostname.endsWith('firebaseio.com') === false;
  if (url.hostname !== self.location.hostname) {
    // Para recursos externos: apenas tenta a rede, sem cache
    return;
  }

  e.respondWith(
    fetch(e.request)
      .then(res => {
        // Atualiza cache com a resposta mais recente
        const copy = res.clone();
        caches.open(CACHE_NAME).then(c => c.put(e.request, copy));
        return res;
      })
      .catch(() =>
        // Rede falhou → serve do cache
        caches.open(CACHE_NAME)
          .then(c => c.match(e.request))
          .then(r => r || new Response('', { status: 503 }))
      )
  );
});

// ── Message ───────────────────────────────────────────────────────
// Recebe {type: 'SKIP_WAITING'} da página para forçar ativação.
// Isso dispara o evento 'controllerchange' na página,
// que então chama window.location.reload() automaticamente.
self.addEventListener('message', e => {
  if (e.data && e.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});

// ── Notification click ────────────────────────────────────────────
self.addEventListener('notificationclick', e => {
  e.notification.close();
  e.waitUntil(
    clients.matchAll({ type: 'window' }).then(cs => {
      for (const c of cs) {
        if (c.url && 'focus' in c) return c.focus();
      }
      if (clients.openWindow) return clients.openWindow('./');
    })
  );
});