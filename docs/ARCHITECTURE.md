# Architecture — GitHub Lens Ultra

## 1. Why the edge (and not a VPS)

Every feature of this bot has a hard external limit that only gets worse on a
single VPS:

| Limit | VPS reality | Edge reality |
|---|---|---|
| Censorship / blocking (the original bot's users are largely in Iran) | one IP → blocked → bot dies | Cloudflare's anycast; the Worker is reachable where api.telegram.org is |
| Burst (a trending repo gets 500 users in a minute) | you provisioned for 5 rps | 0 → thousands rps automatically |
| Disk for source archives | fill up, then OOM | R2, effectively infinite, 30-day lifecycle |
| "Now" data (star velocity) | a cron you have to babysit | 5 cron tiers, Durable Objects, Queues |
| Cost | €5–20/mo fixed | ~$0–5/mo at hobby scale, free tier covers most |

## 2. Request paths

```
Telegram ──POST /tg/<TELEGRAM_WEBHOOK_SECRET>──► Worker
   header X-Telegram-Bot-Api-Secret-Token checked
   ctx.waitUntil(handleUpdate())      ← ACK in ~2 ms, work continues
   └─ buildH() → H context (env, store, tg, ai, card, session, gh(), loc…)
      ├─ slash command  → routeCommand (77 cases)
      ├─ callback_query → routeCallback (137 actions under 14 namespaces)
      ├─ inline_query   → routeInline (search + repo + trending cards)
      └─ free text      → heuristics: owner/repo → scout, find-words → search,
                          question/long → assistant, wizard state → handler
```

`inputContext()` runs **before** the heuristics: if the user is mid-wizard
(chat-with-repo, workflow generator, secret scan, compare, every dev-util,
IP/ASN lookup), their next plain message is routed there instead of being
mistaken for a new query. Wizard state lives in a per-user Durable Object, so
it survives restarts and is shared across colos.

## 3. Data model (D1, 20 tables)

| Group | Tables | Notes |
|---|---|---|
| Identity | `users` | 5 locales, plan, XP, level, badges, interests, referral, daily quota |
| Telemetry | `events`, `ai_usage`, `analytics_engine_datasets` | per-user, per-day cost metering |
| Repos | `repos`, `repo_snapshots`, `trending` | materialised metadata + time series + prebuilt boards |
| Engagement | `favorites`, `likes`, `subscriptions`, `watch_state` | watermarks make webhook alerts idempotent |
| AI | `chats`, `messages` | conversation history with 60-day retention |
| Downloads | `downloads`, `action_jobs` | R2 keys, part lists, Actions offload audit |
| Graph | `co_star` | "people who starred X also starred Y" → recommendations without ML |
| Ops | `advisories`, `webhook_log`, `flags`, `leaderboard`, `digest_queue` | dedupe, replay, hot config, digests, anti-spam |

Every write is an `INSERT … ON CONFLICT` (idempotent) because webhooks and
queues can both retry.

## 4. The trending engine (the honest part)

GitHub has no official trending API. Scraping `github.com/trending` breaks
monthly and gives you a list with no numbers. Lens Ultra instead:

1. **samples** two GitHub search passes (new + recently-updated) → candidates;
2. **snapshots** star counts to `repo_snapshots` on a 15-minute cron for
   tracked/top repos — so we can compute real `Δstars/day`;
3. **re-ranks** with `velocity × acceleration × novelty × spamPenalty × (0.55 + health/200)`,
   where `health` is our own 0–100 composite (freshness, community, maintenance,
   hygiene, responsiveness; archived repos capped at 25);
4. **persists** the board to `trending` so `/trending` is instant and every
   history chart is derived from our own data, not a third party.

## 5. AI layers

```
Tier "fast"     → @cf/meta/llama-3.1-8b-instruct   → fallback 3.2-3b
Tier "smart"    → @cf/meta/llama-3.3-70b-instruct-fp8-fast → 8b → 3b
Tier "code"     → @cf/qwen/qwen2.5-coder-32b-instruct → 70b → 8b
Embeddings      → @cf/baai/bge-m3 (1024-dim, cosine)   ← Vectorize index matches
Speech-to-text  → @cf/openai/whisper-large-v3-turbo    (voice notes)
Text-to-speech  → @cf/facebook/mms-tts-fas (Persian) → @cf/myshell-ai/melotts
Optional gateway→ any OpenAI-compatible endpoint (OPENAI_COMPAT_*)
```

Rules that keep it cheap and correct:

- **cache everything deterministic**: translations keyed by content hash (30 d),
  analyses by `full_name:stars` (7 d), digests by `scope:day` (12 h). The KV +
  in-isolate memo means the second identical question costs zero tokens. There is
  no audio path to cache any more — see "Audio" in the README.
- **never let the model touch numbers**: prompts receive the already-fetched
  GitHub/OSV JSON and are instructed to only summarise it.
- **meter per user/feature/day** in `ai_usage`; `/admin` shows today's usage and
  the model chain logs which fallback answered.

## 6. Downloads: three escape hatches

```
size ≤  45 MB → sendDocument straight from R2
size ≤ 900 MB → slice the archive byte-stream (ZIP/TAR are sliceable!) into
                partNNN files under the Telegram limit, then instructions to
                `cat part* > file.zip`; the original is kept in R2 so the next
                user downloads instantly
size >  900 MB → repository_dispatch to the helper repo; Actions downloads,
                7z-splits into ~1.9 GB parts, publishes a release, and the bot
                messages the user the links (job tracked in action_jobs)
```

The bot never re-downloads what it already has: R2 keys are
`src/<full_name>@<ref>.<ext>` and are head()-checked first.

## 7. Notifications: webhook, not polling

`POST /gh-webhook` verifies `X-Hub-Signature-256` with HMAC-SHA256
(constant-time compare), stores the raw delivery in `webhook_log` (14-day
retention) and then, in `waitUntil`:

| Event | Behaviour |
|---|---|
| `release` published | notify every `subscriptions` row wanting `release`, with a one-tap "download this tag" button |
| `push` | skips `chore|docs|style` and >25-commit pushes (noise filter), then notifies `commits` subscribers |
| `issues` opened | only if labelled `good first issue|help wanted|bug|security` — that's when you actually care |
| `pull_request` opened | notify `pull_requests`, offer AI review |
| `security_advisory` | broadcast to *all* security subscribers (global) |
| `workflow_run` completed | only failures |
| `star` created | milestone posts at 1k/5k/10k/25k/50k/100k |

## 8. Cron tiers

| Schedule | Job |
|---|---|
| `*/15 * * * *` | snapshot tracked + board repos, rebuild daily board, drain `digest_queue`, run broadcasts at ~20 msg/s (45 ms spacing) |
| `0 * * * *` | push up to 40 fresh repos into Vectorize (README digest embedded, not the whole file), security sweep of watched repos → advisories + alerts |
| `0 6 * * *` | AI morning brief, per-interest picks, enqueue digests for users active in 14 d |
| `0 6 * * 0` | growth leaders, weekly board, leaderboard fan-out, cleanup |
| `0 4 1 * *` | retention: events 180 d, snapshots 2 y, ai_usage 90 d, downloads 30 d, messages 60 d, webhook_log 30 d |

## 9. Failure modes (designed, not discovered)

- **Telegram 429** → `Telegram.call()` honours `retry_after`, then falls back to
  a send (never loses the answer); "message is not modified" is treated as success.
- **Model capacity** → automatic fallback chain; if every Workers AI model
  fails, an optional OpenAI-compatible gateway is tried; if all fail the user
  gets a clear error, not a hang.
- **Queue job failure** → `msg.retry()` with backoff, `max_retries: 3`, then the
  `ghlens-jobs-dlq` dead-letter queue keeps it for inspection.
- **Webhook replay** → `webhook_log` primary key on the delivery id +
  `watch_state` watermarks.
- **Big repo killing the isolate** → we never buffer >45 MB in a Worker for
  sending; slices stream from R2 with range reads.
- **Bad wizard state** → the Durable Object alarm wipes context after 30 min.

## 10. Security posture

- Telegram webhook path contains a secret and the header is compared exactly.
- GitHub webhook is HMAC-verified; unsigned requests are rejected with 401.
- No user data is exposed publicly: `/api/*` is read-only and serves only
  aggregate/board data; personal lists require the bot.
- `webhook_log` stores payloads (truncated to 20 000 chars) — reviewed by
  `/admin` only; 30-day retention.
- `session` DO never stores secrets; only wizard context and a 20-card cache.
