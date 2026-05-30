# EVOLV — App de Gestão de Treinos

PWA para registro e acompanhamento de treinos em academia. Roda direto no navegador, funciona offline, sincroniza entre dispositivos via Firebase e não requer instalação.

---

## Funcionalidades

**Fichas de treino**
Crie rotinas com múltiplos dias, exercícios, séries e repetições. Importe fichas via JSON ou baixe o modelo para preencher fora do app.

**Treino ativo**
Overlay de treino com checklist de séries, registro de carga por exercício, timer de descanso configurável e histórico da última carga usada em cada exercício. O treino é salvo automaticamente — se o app fechar no meio, um banner de recuperação aparece na próxima abertura.

**Timer**
Cronômetro independente com presets de tempo (30s, 60s, 90s, 2min, 3min) e visualização em anel. Funciona corretamente mesmo com o app em background no iOS.

**Stats**
Frequência semanal com gráfico de barras animado, carga média por série, streak de dias consecutivos, personal records por exercício com medalhas de ouro/prata/bronze e exercícios mais praticados.

**Peso corporal**
Registro de pesagens com gráfico de evolução e meta configurável.

**Perfil e preferências**
Nome, tema claro/escuro, meta semanal, descanso padrão entre séries, notificações push, backup e sync entre dispositivos — tudo em um lugar.

**Backup e exportação**
Export do backup completo em JSON (fichas + histórico + pesagens + prefs), export do histórico em CSV compatível com Excel e Google Sheets, e import de backup com merge inteligente (sem duplicatas).

---

## Stack

| Camada | Tecnologia |
|---|---|
| Frontend | HTML + CSS + JavaScript vanilla |
| Banco de dados | Firebase Realtime Database |
| Autenticação | Firebase Auth (anônima) |
| Storage local | IndexedDB (via wrapper `IDB`) |
| Cache offline | Service Worker (Network First) |
| Hospedagem | GitHub Pages |
| Charts | Chart.js |

Sem frameworks, sem bundler, sem dependências de build. Um único arquivo JS de ~4000 linhas.

---

## Arquitetura

```
evolv/
├── index.html          # Shell do app — estrutura, navbar, páginas vazias
├── evolv-app.js        # Toda a lógica do app (~4000 linhas)
├── evolv-styles.css    # Design system — variáveis, componentes, layout
├── evolv-tokens.css    # Tokens de cor e tipografia
├── sw.js               # Service Worker — cache e atualizações
├── icon.png            # Ícone PWA 512×512 (sem transparência)
├── icon_192.png        # Ícone PWA 192×192
└── logo.png            # Logo para o header
```

### Módulos principais em `evolv-app.js`

```
IDB          → Wrapper de IndexedDB (get/put/del/clear/getAll/setAll/getPref/setPref)
SyncQueue    → Fila de operações offline (drain ao reconectar)
DB           → Camada de dados (cache em memória + IDB + Firebase)
App          → Toda a lógica de UI, navegação, modais e renderização
IC           → Biblioteca de ícones SVG inline
WorkoutCache → Persistência do treino em andamento no localStorage
```

### Fluxo de dados

```
Ação do usuário
      │
      ▼
DB.add*/upd*/del*()
      │
      ├─── Atualiza cache em memória (síncrono)
      ├─── Persiste no IndexedDB (assíncrono)
      └─── Firebase online? ──→ Escreve no Firebase
                    │
                    └── Offline? ──→ SyncQueue.push()
                                          │
                                    ao reconectar
                                          │
                                    SyncQueue.drain()
                                          │
                                    Firebase ←────┘
```

### Sincronização entre dispositivos

Cada usuário recebe um **SyncID** (UUID anônimo gerado pelo Firebase Auth) gravado no `localStorage`. Os dados ficam em `users/{syncId}/` no Realtime Database. Para sincronizar em outro dispositivo, basta copiar o SyncID via **Perfil → Sync entre dispositivos**.

---

## Configuração do Firebase

O arquivo `evolv-app.js` contém as credenciais do Firebase diretamente. Para rodar sua própria instância:

1. Crie um projeto no [Firebase Console](https://console.firebase.google.com)
2. Ative o **Realtime Database** e o **Authentication** (método anônimo)
3. Substitua o objeto `FIREBASE_CONFIG` no topo de `evolv-app.js`:

```js
const FIREBASE_CONFIG = {
  apiKey: "...",
  authDomain: "...",
  databaseURL: "https://seu-projeto-default-rtdb.firebaseio.com",
  projectId: "...",
  storageBucket: "...",
  messagingSenderId: "...",
  appId: "..."
};
```

4. Configure as regras do Realtime Database:

```json
{
  "rules": {
    "users": {
      "$uid": {
        ".read": "auth != null && auth.uid == $uid",
        ".write": "auth != null && auth.uid == $uid"
      }
    }
  }
}
```

---

## Deploy no GitHub Pages

```bash
# 1. Clone o repositório
git clone https://github.com/seu-usuario/evolv.git
cd evolv

# 2. Faça as alterações desejadas

# 3. Commit e push
git add .
git commit -m "descrição das mudanças"
git push origin main

# 4. Ative o GitHub Pages nas configurações do repositório
#    Settings → Pages → Source: main branch / root
```

O app estará disponível em `https://seu-usuario.github.io/evolv/`.

---

## Publicar uma atualização

O sistema de atualização é controlado pelo Service Worker. Para notificar os usuários de uma nova versão:

1. Abra `sw.js`
2. Incremente o número em `CACHE_NAME`:
   ```js
   // antes
   const CACHE_NAME = 'evolv-v16';
   // depois
   const CACHE_NAME = 'evolv-v17';
   ```
3. Faça o deploy normalmente

Na próxima abertura do app, um banner verde "Nova versão disponível" aparece com as opções **Atualizar agora** e **Depois**. Clicar em "Atualizar agora" dispara `skipWaiting()` e recarrega a página automaticamente.

> O skipWaiting não é chamado automaticamente no install para evitar recarregar o app no meio de um treino em andamento.

---

## Modo offline

O app funciona sem internet. Ao ficar offline:

- Um toast avisa o usuário
- Todas as escritas (fichas, treinos, pesagens, prefs) são salvas no IndexedDB imediatamente
- As operações pendentes entram na `SyncQueue`
- O status dot no header muda para **laranja pulsante** (pendências) ou **vermelho** (offline)
- Ao reconectar, a fila drena automaticamente em ordem cronológica

O IndexedDB espelha os dados do Firebase a cada sync, então o app carrega com os dados mais recentes mesmo sem internet.

---

## Testes e debug

```js
// Forçar onboarding
App.showOnboarding(true)

// Marcar onboarding como concluído
DB.setPref('onboarded', true)

// Ver dados em cache
DB.fichas()
DB.sessoes()
DB.pesos()
DB.getPrefs()

// Ver fila de sync pendente
IDB.getAll('sync_queue').then(console.log)

// Simular offline
localStorage.setItem('evolv_offline', '1'); location.reload()

// Voltar modo online
localStorage.removeItem('evolv_offline'); location.reload()

// Status do Service Worker
navigator.serviceWorker.getRegistration().then(r => console.log(r))

// Trocar tema via console
App.toggleTheme()
```

---

## Estrutura de dados no Firebase

```
users/
  {syncId}/
    fichas/
      {id}: { id, name, at, days: [{ name, exs: [{ name, sets, reps, w }] }] }
    sessoes/
      {id}: { id, fichaId, dayIdx, date, dur, exs: [{ name, sets: [{ reps, w, done }] }] }
    pesos/
      {id}: { id, w, date, obs }
    prefs/
      { weekTarget, pesoGoal, restTime, theme, onboarded, displayName }
```

---

## Segurança

- Escape de HTML (`esc()`) em todos os templates que renderizam dados do usuário — previne XSS
- Sanitização completa (`safeStr()`, `safeNum()`, allowlist de campos) em fichas importadas via JSON
- Regras do Firebase restringem leitura e escrita ao próprio `uid` do usuário
- Nenhum dado sensível em URL parameters

---

## Licença

Projeto pessoal — uso livre.