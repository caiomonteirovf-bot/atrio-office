# Atrio Office — RUNBOOK de Patches Recorrentes

Cada item aqui foi um **bug que já mordeu** e voltou a morder. Antes de mexer em algo
relacionado, leia. Antes de declarar "mistério", rode `bin/smoke.sh`.

> Atualize aqui sempre que algo voltar a quebrar — vira memória institucional do projeto.

## Smoke test (sempre o primeiro passo)

```bash
/opt/atrio-office/bin/smoke.sh
```

22 checks, < 30s. Se algum falhar, o output traz o comando de fix.

---

## Tela preta em Datalake / Ecossistema / Growth

**Sintoma:** UI mostra `Erro: could not connect to server "gesthub_srv"` ou
`"banking_srv"`. Páginas que dependem de FDW ficam pretas.

**Causa-raiz:** O container `atrio-office-db-1` precisa estar nas redes
`gesthub_default` e `atrio_default` pros FDWs resolverem os hostnames
`gesthub-db` e `atrio-db-1`. Quando o container é recriado, perde adesão se a
config não tiver explícita.

**Fix definitivo (já no compose):**
```yaml
db:
  networks:
    - default
    - atrio_finance   # external: atrio_default (banking)
    - gesthub         # external: gesthub_default
```

**Fix manual (se acontecer mesmo assim):**
```bash
docker network connect gesthub_default atrio-office-db-1
docker network connect atrio_default atrio-office-db-1
```

---

## Browser mostra UI antiga após deploy

**Sintoma:** Você buildou e fez deploy, mas o usuário continua vendo a versão
anterior. Tabs sumindo, botões antigos voltando, etc.

**Causa-raiz:** Service Worker cacheou bundle antigo. Sem bump da `CACHE_VERSION`,
o SW serve do cache mesmo com novo bundle no servidor.

**Fix definitivo (já automatizado):** `client/scripts/bump-sw.js` roda no
`prebuild` do npm. Cada `npm run build` substitui `CACHE_VERSION` por um
timestamp único.

**Fix manual no navegador do usuário:**
```
F12 → Application → Service Workers → Unregister
F12 → Application → Storage → Clear site data
Ctrl+Shift+R
```

---

## Container do server não sobe ("Cannot find package 'web-push'")

**Sintoma:** `docker compose up -d server` cai em loop de crash com
`ERR_MODULE_NOT_FOUND` apontando pra `web-push`.

**Causa-raiz:** Source no host (bind-mount) importa `web-push`, mas a imagem
buildada não tem essa dep instalada — porque a imagem é antiga, anterior à
adição do package.

**Fix:**
```bash
cd /opt/atrio-office && docker compose build server && docker compose up -d server
```

Ou seja: rebuild da imagem antes de subir.

---

## Luna mandando msgs pra clientes

**Sintoma:** Após reconectar WhatsApp, Luna envia greetings ("Bom dia, X!")
pra clientes externos, contrariando diretiva.

**Causa-raiz:** Múltiplos caminhos no whatsapp.js (escalation timers, first-touch,
greeting legacy) podem disparar envio sem passar pelo kill-switch — ou o
kill-switch tinha lógica frágil que não cobria todos os casos.

**Mitigação atual:**
- Constante `HARD_BLOCK_CLIENTE = true` em `whatsapp.js`
- Função `isClientOutboundAllowed(chatId)` é a fonte única — bloqueia tudo
  exceto grupo interno + DM com colaborador (lista cached do Gesthub)
- `opts.manual=true` (humano via painel) **bypassa** o kill-switch — não
  bloqueie isso ou parceiros externos não conseguem ser respondidos

**WARNING crítico:** NÃO adicionar gates extras que ignorem `opts.manual`. Já
foi feito uma vez (07/05/2026), bloqueou painel inteiro pra Beto Contábil.

**Pra reativar Luna pra clientes no futuro:**
```js
// whatsapp.js, ~linha 705
const HARD_BLOCK_CLIENTE = false;
```
Restart server.

---

## "Sumiram funções" / TopBar com 6 tabs em vez de 14

**Sintoma:** Usuário relata que tabs do menu superior desapareceram.

**Causa-raiz:** **Browser cache do bundle antigo**. Source local + dist do servidor
estão corretos. O navegador só está servindo do cache.

**Fix:** mesma coisa do "Browser mostra UI antiga" — limpar SW + Ctrl+Shift+R.

**Como confirmar:** rodar smoke test → se SW versioning estiver consistente,
problema é só no navegador do usuário.

---

## WhatsApp diz "conectado" mas tá zumbi (desemparelhado pelo celular)

**Sintoma:** Painel mostra "Luna ativa · 5581...", mas msgs do cliente não chegam
e tentar enviar dá timeout.

**Causa-raiz:** `whatsapp-web.js` nem sempre dispara o evento `disconnected` quando
o usuário desemparelha pelo celular. `isReady` fica preso em `true`.

**Fix definitivo (já no código):** `Sintoma 6` no `checkChromiumHealth()` chama
`client.getState()` periodicamente. Se != `CONNECTED`, força `isReady = false` e
broadcast `whatsapp_disconnected`.

`/api/whatsapp/status` agora também valida live (`getStatusLive()`) antes de
responder.

---

## Watchdog spam de "stale scan: operator does not exist: integer = text"

**Sintoma:** Logs do server enchidos com esse erro a cada 15s.

**Causa-raiz:** Em `luna-watchdog.js`, query `JOIN datalake_gesthub.clients g ON
g.id = lc.gesthub_id` falha porque `g.id` é integer e `lc.gesthub_id` é text.

**Fix (já aplicado):**
```sql
LEFT JOIN datalake_gesthub.clients g ON g.id::text = lc.gesthub_id
```

Cast pra text é mais robusto que reverso (`::integer` falha em valores não-numéricos).

---

## Convenções de mudança de código

1. **Sempre rodar `bin/smoke.sh` após deploys** — economia barata, captura 22
   classes de problemas.
2. **Patches via SSH no VPS são temporários** — sempre fazer `scp` de volta pro
   source local depois pra git não divergir.
3. **Ao adicionar gate de segurança que pode quebrar fluxo manual:** colocar
   comentário `// WARNING: ` ligando à diretiva real e ao histórico do bug.
4. **Antes de recriar container:** verificar `docker-compose.yml` declara as
   redes externas necessárias (FDWs).
5. **Cache do navegador é frequente fonte de "não funciona":** `Ctrl+Shift+R`
   antes de reportar bug.

---

## Referências

- `docker-compose.yml` — redes externas no service `db`
- `client/scripts/bump-sw.js` — cache busting automático
- `bin/smoke.sh` — checks consolidados
- `server/src/services/whatsapp.js` — kill-switch + sintoma 6 do healthcheck
- `server/src/services/luna-watchdog.js` — query corrigida


---

## Anexos sumindo após rebuild ⚠️ CRÍTICO

**Sintoma:** Mensagens com anexos do WhatsApp mostrando "arquivo nao encontrado no
storage". Pode acontecer com PDFs, imagens, áudios.

**Causa-raiz histórica (08/05/2026):** O diretório
`/app/storage/whatsapp-attachments` **não tinha bind-mount** no compose. Era
filesystem efêmero do container. Cada `docker compose build server` apagava
TODOS os anexos. Perdemos 344 de 415 anexos (82%) por causa disso, ao longo
de várias rebuilds no dia.

**Fix definitivo (já aplicado):**
```yaml
# docker-compose.yml, service server, volumes:
- ./server/whatsapp-attachments:/app/storage/whatsapp-attachments
```

Bind-mount no host garante persistência além do ciclo de vida do container.

**Backup automático (já configurado):**
- Script: `/opt/atrio-office/bin/backup_attachments.sh`
- Cron: 03:00 diário
- Destino: `/opt/backups/whatsapp-attachments/YYYY-MM-DD/` com hard links pra dedup
- Retenção: 14 dias

**Como auditar perda:**
```bash
/tmp/audit_attachments.sh
```
Compara `whatsapp_messages.metadata->attachment->storage_path` contra arquivos
no disco e mostra divergência.

**Recuperação parcial dos perdidos:**
Possível recuperar via 2 caminhos:
1. **WhatsApp re-fetch** — `client.fetchMessages` reabaixa mídia (limitado a chats
   recentes ainda em cache)
2. **Atrio Finance overlap** — extratos importados ficam em
   `atrio-banking-system-1:/app/storage/uploads/`. Se um anexo perdido foi
   processado pelo Finance, pode ser recuperado de lá pelo nome de arquivo.

Não automatizado — exige decisão caso a caso.

**Smoke test alerta:** `bin/smoke.sh` agora compara DB refs vs disco. Falha se
perda > 30%, warn se 5-30%, ok se < 5%.

**Convenção pra novos diretórios de storage:**
- SEMPRE bind-mount no compose ANTES de começar a salvar arquivos
- SEMPRE incluir no backup_attachments.sh (ou criar script paralelo)
- SEMPRE adicionar check no smoke.sh
