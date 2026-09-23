# Deploy — GitHub Lens Ultra, step by step

Everything here is free-tier friendly. Total time: ~20 minutes.

---


## 0. What you need

| Thing | Where | Notes |
|---|---|---|
| Cloudflare account | dash.cloudflare.com | Free plan is enough (Workers Paid unlocks higher AI/Queue limits — optional) |
| `wrangler` | `npm i -D wrangler` (already in package.json) | CLI v3.78+ |
| Node 20+ | nodejs.org | the sandbox scripts assume `node`/`npx` |
| Bot token | Telegram → **@BotFather** → `/newbot` | keep it secret |
| GitHub token | github.com → Settings → Developer settings → **Fine-grained or classic PAT** | scope: `public_repo` (read-only is enough for everything except `repository_dispatch`, which uses the *helper* token) |
| Cloudflare API token | My Profile → API Tokens → **Edit Cloudflare Workers** template | add `Account → D1:Edit`, `Workers KV Storage:Edit`, `Queues:Edit`, `Workers AI:Read` (no R2 and no Vectorize — neither is used) |

---

## 1. Clone & install

```bash
git clone <repo> ghlens-ultra
cd ghlens-ultra
npm install
```

---

## 2. Create the resources

Either run the script:

```bash
export CLOUDFLARE_API_TOKEN=…
export CLOUDFLARE_ACCOUNT_ID=…
./scripts/bootstrap.sh
```

…or do it by hand:

```bash
npx wrangler kv namespace create CACHE
npx wrangler kv namespace create STATE
npx wrangler d1 create ghlens
npx wrangler r2 bucket create ghlens-files
npx wrangler queues create ghlens-jobs
npx wrangler queues create ghlens-jobs-dlq
npx wrangler vectorize create ghlens-index --dimensions=1024 --metric=cosine
```

> **1024 dimensions is not arbitrary** — it must equal `@cf/baai/bge-m3`'s output.
> Creating the index with 768 will make every upsert fail.

Paste the ids into `wrangler.jsonc` (`REPLACE_WITH_CACHE_KV_ID`,
`REPLACE_WITH_STATE_KV_ID`, `REPLACE_WITH_D1_ID`), then:

```bash
npx wrangler d1 execute ghlens --remote --file=./schema/d1.sql
```

Apply the R2 lifecycle (delete `src/*` after 30 days):

```bash
npx wrangler r2 bucket lifecycle add ghlens-files --name expire-src --prefix src/ --expire-days 30
```

---

## 3. Secrets

```bash
export BOT_TOKEN='123456:ABC…'
export BOT_USERNAME='MyLensBot'
export GITHUB_TOKEN='ghp_…'
export CF_ACCOUNT_ID='…'          # for Browser Rendering share cards
export CF_API_TOKEN='…'          # same
export HELPER_REPO='you/ghlens-jobs'        # optional
export HELPER_REPO_TOKEN='ghp_…'            # optional (repo scope on the helper)
./scripts/set-secrets.sh
```

The script generates `TELEGRAM_WEBHOOK_SECRET`, `GITHUB_WEBHOOK_SECRET` and
`DOWNLOAD_SIGNING_KEY` if you don't provide them, and prints them — **save the
output**, you need the webhook secrets in steps 5 and 6.

Then set your public URL and admins in `wrangler.jsonc`:

```jsonc
"vars": {
  "WORKER_URL": "https://ghlens-ultra.<your-subdomain>.workers.dev",
  "ADMIN_IDS": "123456789",        // your Telegram user id (use /id in the bot)
  ...
}
```

Deploy:

```bash
npx wrangler deploy
```

---

## 4. Health check

```bash
curl -s https://ghlens-ultra.<sub>.workers.dev/health | jq
```

Every binding must be `true`:

```json
{ "ok": true, "bindings": { "d1": true, "kv_cache": true, "kv_state": true,
  "r2": true, "queue": true, "ai": true, "vectorize": true,
  "analytics": true, "browser": true, "do": true, "secrets": { … } } }
```

If something is `false`, fix `wrangler.jsonc` and redeploy — the bot will tell
you which subsystem is missing instead of failing silently.

---

## 5. Point Telegram at the Worker

```bash
export WORKER_URL=https://ghlens-ultra.<sub>.workers.dev
export TELEGRAM_WEBHOOK_SECRET=<printed by set-secrets.sh>
export BOT_TOKEN=…
./scripts/set-webhook.sh
```

This registers the webhook **and** the slash-command menus for `fa` and `en`.
Then open the bot and send `/start`.

---

## 6. GitHub webhook (instant release/CVE alerts)

In the repository you want notifications from (or an organisation-level hook):

- **Payload URL**: `https://ghlens-ultra.<sub>.workers.dev/gh-webhook`
- **Content type**: `application/json`
- **Secret**: the `GITHUB_WEBHOOK_SECRET` value
- **Events**: Releases, Pushes, Issues, Pull requests, Security advisories, Workflow runs, Stars

Then in the bot: open a repo card → 🔔 **Subscribe** → pick `release` or
`release,security`. The first alert arrives instantly; correctness is checked by
HMAC, duplicates are dropped by delivery id.

> Organisation hooks need a token with `admin:org_hook`. User-level hooks are
> configured per-repo and are the common case.

---

## 6.5 Bot profile text and the mini app button

Telegram shows two strings that come from the bot itself: the card on the Web App
splash screen ("What can this bot do?") — that is `description` — and the "About"
line in the profile (`short_description`). Both are settable over the API, so
BotFather is not needed for them:

```bash
export BOT_TOKEN=…                       # from .secrets.local.sh
export WORKER_URL=https://ghlens-ultra.<sub>.workers.dev
./scripts/set-profile.sh                 # fa · en · ar · ru · zh + the language-less default
./scripts/set-profile.sh --dry            # show what would be sent
```

Caps enforced by the API: `description` ≤ 512 characters, `short_description`
≤ 120. A `BOT_DESC_INVALID` answer means you went over one of them.

> **Measured, not assumed:** the chat menu button next to the message box cannot
> be a Web App on this API version. `setChatMenuButton` answers `true` and
> `getChatMenuButton` still reports `commands` (it *does* work per-chat, which is
> how the limit was isolated).
>
> The Telegram Mini App was **removed from this project** by owner request: no
> `/app` route, no web app button, no `src/web/`. The bot's interface is the chat
> itself, and the worker's only web surface is the landing page at `/`.

### Why `/app` answers with a redirect and not a 404

`setChatMenuButton` was used earlier to put a Web App button on the *default*
menu-button scope. On this Bot API version that scope is write-once in practice:
subsequent calls — `commands`, `default`, or another `web_app` — all return
`{"ok":true,"result":true}` and the read-back keeps returning the original
`web_app` entry, so the address cannot be un-shipped from the worker side. Every
client therefore still shows a «Mini App» button that opens
`https://ghlens-ultra.gitguts.workers.dev/app`.

Until that button is moved (`/setmenubutton` in BotFather, or `/empty`), the
worker answers `/app` with a `302` to the landing page: no web app, no Telegram
WebApp SDK, no state, nothing to keep in sync. Per-chat overrides *do* work, and
`scripts/set-profile.sh` sets `commands` back for the known real chats.

## 7. The heavy-work helper repo (optional, for 1 GB+ repos)

1. Create a repo (e.g. `you/ghlens-jobs`), copy `actions/pack-repo.yml` to
   `.github/workflows/pack-repo.yml`.
2. Add a secret `BOT_WEBHOOK_URL` = your Worker URL.
3. Add a PAT with `contents:write` on that repo as `HELPER_REPO_TOKEN` in the
   Worker, and set `HELPER_REPO=you/ghlens-jobs`.
4. Nothing else: when a user asks for a giant repo, the Worker dispatches
   `repository_dispatch: pack-repo`, Actions 7z-splits into ~1.9 GB parts,
   publishes a release and the bot messages the links.

---

## 8. Local development

```bash
npm run db:init:local     # schema into the local D1
npm run dev               # wrangler dev --remote (needs the same secrets via .dev.vars)
npm run typecheck         # must print 0 errors
node scripts/selftest.mjs # 25 assertions on cron/CIDR/JSON/ID/colour helpers
```

`.dev.vars` (never commit):

```
BOT_TOKEN=…
BOT_USERNAME=…
GITHUB_TOKEN=…
TELEGRAM_WEBHOOK_SECRET=dev
GITHUB_WEBHOOK_SECRET=dev
DOWNLOAD_SIGNING_KEY=dev
CF_ACCOUNT_ID=…
CF_API_TOKEN=…
ADMIN_IDS=…
```

For local webhook testing use a tunnel (`cloudflared tunnel --url
http://localhost:8787`) and register that URL with `set-webhook.sh`.

---

## 9. Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `/health` shows `vectorize: false` | index name mismatch | `wrangler vectorize list`; the binding must be `ghlens-index` |
| Bot answers nothing | webhook not set / wrong secret | re-run `set-webhook.sh`; check `wrangler tail` |
| `403 forbidden` on the hook | header token mismatch | it must equal `TELEGRAM_WEBHOOK_SECRET` |
| Search returns nothing | nothing indexed yet (normal on day 1) | the hourly cron indexes fresh repos; semantic search reads vectors stored in D1, so no Vectorize index has to exist |
| Podcast has no audio | TTS capacity | script is still delivered, retry later; check `/admin → AI self-test` |
| Download says "Actions token missing" | helper repo not configured | set `HELPER_REPO` + `HELPER_REPO_TOKEN` |
| Share card falls back to a link | Browser Rendering needs `CF_API_TOKEN`+`CF_ACCOUNT_ID` | set both |
| 429 from Telegram | too many messages | the client already retries; broadcasts are rate-limited to ~20/s |

Watch live logs:

```bash
npx wrangler tail --format pretty
```

---

## 10. Cost estimate (hobby traffic, ~200 active users)

| Resource | Monthly |
|---|---|
| Workers requests | free tier (100k/day) |
| D1 rows read/written | free tier (5M reads/day) — snapshots dominate; the 15-min cron is deliberately scoped to ~40 repos |
| R2 storage | first 10 GB free, then $0.015/GB — lifecycle deletes source archives after 30 d |
| Queues | free tier (1M ops/month) |
| Durable Objects | SQLite-backed DOs: free tier for light use, cents after |
| Workers AI | the real cost driver: with caching + fallback chains this stays inside the free daily neurons for a small community; beyond that, a few dollars |
| Browser Rendering | 10 min/day free — share cards only |
| GitHub Actions (helper) | free minutes on public repos |


---

## 8. Known constraints discovered in a real deployment (2026-09-21)

These were hit live while deploying `ghlens-ultra` to a **Free** plan account. Each has a fix baked into the code, so the project survives them:

| Symptom | Real cause | What the repo does about it |
|---|---|---|
| Every script returns `error code: 1101`, even a hello-world worker; `wrangler tail` shows no invocations | the account's `*.workers.dev` subdomain is broken on Cloudflare's side (the same code runs fine on a custom domain) | the worker is mounted on a zone route (`drsarli.ir/lens`) and `src/index.ts` strips the path prefix; `WORKER_URL` carries the prefix so every generated link (mini-app, share cards, magic links) is correct |
| `deploy` uploads the script then fails on the schedules step: *"reached the Workers Free limit of 5 cron triggers per account"* | the limit is per **account**, not per worker, and other projects use it | only two triggers are declared (`*/15 * * * *`, `0 6 * * *`); `classifyCron()` promotes weekly work on Sundays and monthly retention on the 1st inside the daily run, so re-adding the other three on a paid plan needs no code change |
| Cloudflare's cron parser rejects `0 6 * * 0` | day-of-week must be `SUN`…`SAT` or 1–7 (and `PUT /schedules` wants a bare JSON array body) | `wrangler.jsonc` uses named days |
| Data silently not saved: profiles, favourites, XP all empty while the bot "worked" | `INSERT INTO users` had 8 `?` but only 7 `bind()` values, and the error was swallowed by `.catch(() => {})` | fixed, all 84 swallow-sites now log `lens-swallowed`, and `scripts/sqlcheck.mjs` (part of `npm test`) fails the build on any placeholder/bind mismatch |
| Public `/api/*` returned 404 behind the path prefix | downstream handlers re-parse `request.url` and saw the un-stripped path | the Request is rebuilt after stripping, so every handler sees clean paths |
| Workers AI ships **no Persian voice** on this account (`mms-tts-fas` → 5007, `melotts` → 3043) | only `@cf/deepgram/aura-1` (English) is available | `AiBrain.speak()` speaks a live English translation of the Persian text and reports which voice it used in `/health?deep` |


---

## 9. Migration between Cloudflare accounts (2026-09-21)

The whole stack was moved from account `4beda91649bed6f5d1271b89056d0565` to
`88a4e920dc6f9606c9987b872ac9ed69` in one pass. It is a 10-minute job:

1. verify the token, pick the account, then **create the workers.dev subdomain**
   (`PUT /accounts/<id>/workers/subdomain`) — a fresh account has none, and
   `wrangler deploy` will not create it for you;
2. deploy a three-line hello-world worker and open it in a browser: this is the
   only reliable way to tell a healthy account from a broken one;
3. create KV ×2, D1, queue + DLQ (`npx wrangler …` or the REST API);
4. `npx wrangler d1 execute ghlens --remote --file=./schema/d1.sql` → expect `num_tables: 20`;
5. upload the 8 secrets (`wrangler secret put`), then `npx wrangler deploy`
   with the new ids in `wrangler.jsonc` and `WORKER_URL` pointing at the new host;
6. `POST setWebhook` with `<new-url>/tg/<secret>` **and** re-run `setMyCommands`
   (the command menu lives on Telegram's side, not in the worker);
7. prove it: `/health?deep=<secret>` must report `pass: true`, then run a few
   `/selfcheck?text=…&uid=…` probes before declaring success;
8. only then delete the old account's resources — a worker, its zone routes,
   two KV namespaces, one D1 database and two queues.

`scripts/finish-migration.sh` automates steps 5–8's leftovers (uploading a GitHub
token and wiping the old account) because those need credentials only the owner
holds. The internal secrets (Telegram webhook, GitHub webhook, download signing)
should simply be **regenerated** during a migration rather than copied — they are
pure internal values and regenerating invalidates anything an attacker captured.
