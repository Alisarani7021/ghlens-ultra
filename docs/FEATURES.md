# Feature inventory — what is actually implemented

Everything below exists in the source and compiles with **0 TypeScript errors**.
Numbers in parentheses are the source file / handler you can open to verify.

Counts: **77 commands · 137 callback actions · 12 dossier tabs · 20 D1 tables ·
9 queue job types · 7 GitHub webhook events · 5 cron tiers · 5 locales ·
35 TypeScript files (~8 800 lines) · 25 passing self-tests.**

---

## A. Discovery (14)

1. Hybrid search — semantic (Vectorize) + lexical (GitHub) fused with RRF `features/search.ts`
2. Semantic-only and lexical-only modes with one-tap switch
3. Natural-language → GitHub query translation (Persian in, qualifiers out)
4. Query explanation — the bot tells you how it understood you
5. Advanced filter presets (stars, created/pushed windows, license, language, labels)
6. Saved searches with daily match checks
7. Empty-state rescue: 3 AI-suggested alternative queries
8. Trending boards: daily / weekly / monthly / all-time
9. Language filter across 18 languages
10. Real-growth leaderboard (`+N ⭐` from our own snapshots)
11. "Newcomers" — rockets created in the last 30 days with per-day velocity
12. Ecosystem map — which topics dominate this week's risers
13. Time travel — what was huge in 2008…2026
14. Random discovery weighted by your interests

## B. Curation & browsing (8)

15. 8 top-level categories with 45+ curated sub-queries (`features/browse.ts`)
16. Organisation browser (Cloudflare, Microsoft, OpenAI, Mozilla, …)
17. Profile browser (users/orgs: bio, followers, top repos)
18. Awesome-list miner — extracts every GitHub link from a README
19. Hidden gems ranking: `health×1.4 + velocity×6 − log10(stars)×8`
20. Co-star recommendation graph (`co_star` table) with topic/language fallback
21. Personalised feed built from interests + favourites
22. Inline mode (`@bot query`) with repo/search/trending cards

## C. Deep dossier — 12 tabs (16)

23. Overview: stars/forks/watchers/issues/PRs/releases/contributors, health meter, red flags, funding links
24. Growth: 30-day sparkline, Δ stars/day, weekly commit activity chart
25. Languages: byte-exact Linguist distribution as ASCII bars + diversity
26. Community: bus factor, top contributors with share bars, 10-point maintenance checklist
27. Releases: cadence (median gap), asset download totals, prerelease flags, recent tags
28. Issues: close rate, stale ratio, hot labels, good-first/help-wanted counts
29. Pull requests: merge rate, drafts, conflicts, diff size classification
30. Commits: type-iconised headlines, Conventional-Commit compliance %, emoji usage
31. CI & hygiene: workflow list, hygiene score, 10-file booster checklist with advice
32. Security tab: GitHub advisories, vulnerability-alert flag, policy presence
33. AI changelog: grouped release notes from the last 40 commits
34. Contribution radar: labelled starter issues, PR acceptance rate
35. One-shot GraphQL query feeds all 12 tabs (single round trip)
36. Compare two repos: 11-row table, health winner, AI verdict
37. AI comparison essay (who should pick which, 180–260 words)
38. Compare share-card endpoint

## D. Downloads (11)

39. ZIP or TAR.GZ, any branch / tag / commit
40. R2 content-addressed cache — second download is instant
41. Byte-stream splitting into Telegram-sized parts (no re-compression)
42. Join instructions generated per part
43. Automatic offload to GitHub Actions when > 900 MB
44. Actions workflow: 7z multipart (~1.9 GB), release publishing, checksums
45. Direct-link view for release assets and source archives
46. Recent-downloads history per user
47. Download-from-trending / favourites shortcuts
48. Per-user download quota (cost control)
49. Job tracking table (`action_jobs`) + completion notification

## E. AI assistant (15)

50. Free-form Q&A grounded in live GitHub search when needed (classifier → fetch → answer)
51. Chat-with-repo RAG over README + `docs/*` + CONTRIBUTING/SECURITY/ARCHITECTURE
52. Citations with similarity scores for every RAG answer
53. Conversation memory (D1 `chats`/`messages`) with /clear
54. Structured AI dossier: one-liner, what, who-for, pros, cons, alternatives, learning curve, production readiness, security note, Persian tags
55. README translation that preserves code blocks, YAML, badges (2 600+ chars per pass)
56. Paged translation continuation
57. On-demand translation to other locales
58. Printable HTML export of a translation
59. GitHub Actions workflow generator (8 presets + free text)
60. Code explainer (purpose, flow, tricky parts, complexity, 2 improvements)
61. PR reviewer fed with the real `application/vnd.github.v3.diff`
62. Voice note → Whisper → same pipelines as text
63. Text answer → Persian TTS audio
64. AI morning brief + per-interest picks inside the daily digest

## F. Podcast (5)

65. Daily Persian audio brief of trending repos
66. Weekly edition
67. Transcript view
68. R2 caching per day (first listener pays, the rest are free)
69. Script-only fallback when TTS is unavailable

## G. Security (10)

70. Dependency extraction from 7 ecosystems (npm, PyPI, Go, Cargo, Maven, RubyGems, Packagist)
71. OSV.dev batch vulnerability lookup with detailed hydration
72. Severity normalisation (CVSS → CRITICAL/HIGH/MODERATE/LOW/UNKNOWN)
73. Fixed-version surfacing and advisory links
74. Repository security score with A–F grade
75. Secret heuristics: AWS, GitHub, Slack, Google, Stripe, Telegram tokens, private keys, generic passwords
76. Remediation playbook (rotate, purge history, .gitignore, gitleaks)
77. Advisory monitoring with dedupe (`advisories` table)
78. Instant CVE alerts via the GitHub `security_advisory` webhook
79. Security posture tab inside the dossier

## H. Network & packages (10)

80. IP intelligence: RDAP + geo + ASN + reverse DNS in one view
81. Threat posture: proxy/VPN, datacenter, mobile, CGNAT detection with risk bar
82. Domain intelligence: A/AAAA/MX/TXT/NS/CNAME/SOA/CAA + registrar + dates
83. TLS/edge check + recent certificates from crt.sh + SSL Labs link
84. ASN lookup: holder, announced prefix count and list, bgp.tools/PeeringDB links
85. Package conversion playbooks: deb→rpm, rpm→deb, deb→Arch, rpm→apk (real commands + pitfalls)
86. Manifest detection across common monorepo folders
87. Actions-based binary conversion job
88. Recursive file browser inside Telegram (dirs + files + previews)
89. Deep links to Shodan/GreyNoise/AbuseIPDB/urlscan/VirusTotal

## I. Developer utilities (12)

90. Cron explainer in Persian + next-5-runs calculator (brute-force UTC scan)
91. Regex lab with match list and capture groups
92. CIDR calculator: network/mask/wildcard/broadcast/range/hosts/private detection + subnetting preview
93. JWT decoder with expiry status
94. Base64/hex/URL encode + decode in one shot
95. SHA-1/256/384/512 via WebCrypto
96. UUID v4, ULID (time-sortable), NanoID, API-key generator
97. Timestamp converter (ISO, unix s/ms, UTC, Tehran, Zurich, relative)
98. JSON validator + stats (keys/depth/arrays/types) + minified view + error position
99. `.gitignore` generator for 10 stacks + OS patterns (sent as a file)
100. SemVer explainer and one-tap major/minor/patch/rc bumps
101. Colour tool: RGB/HSL, luminance, WCAG advice, nearest Tailwind token

## J. Contribution (6)

102. Personalised beginner-issue radar (labels × languages × topics × recency × low comments)
103. Per-repo contribution radar (good-first / help-wanted / docs)
104. First-PR walkthrough with exact git/gh commands and etiquette
105. 7-day contribution plan generated from your interests + real issues
106. "Welcoming repos" — where newcomers actually get merged
107. License explainer (MIT, Apache, BSD, GPL, AGPL, LGPL, MPL, none) with commercial-use guidance

## K. Account, gamification, admin (18)

108. 5 locales (fa/en/ar/ru/zh) for UI and translations
109. XP + level curve, 4 badge tiers
110. Weekly leaderboard (queries) with row highlighting
111. Referral links with XP rewards
112. Daily free quota + plan tiers (free/pro/team)
113. Dashboard: 30-day activity, streak, AI usage, favourite languages
114. Interests editor (24 tags) that drives feed/digest/recommendations
115. Favourites with notes and Markdown export
116. Subscriptions with per-event granularity and mute
117. GDPR-style data export (JSON)
118. Admin console: users/active/repos/events/subs/downloads/jobs/volume
119. Live GitHub rate-limit meters (core/search/graphql)
120. AI usage per feature/token today
121. Feature flags editable from chat
122. Broadcast fan-out at ~20 msg/s with 200-user windows
123. Manual snapshot / cleanup triggers
124. AI self-test (fast/smart/code/embed/TTS/whisper/translate with timings)
125. Analytics Engine data points on every command and cron run

## L. Platform (12)

126. Telemetry: `events` + Analytics Engine
127. Queue consumer with 9 job types, retry/backoff, dead-letter queue
128. Durable Object per user: wizard state, 20-card hot cache, 30-min auto-expiry alarm, in-flight locks
129. HMAC-verified GitHub webhooks with delivery log and star milestones
130. 5 cron tiers (15-min, hourly, daily, weekly, monthly)
131. `Telegram.call()` retry logic: 429 `retry_after`, 5xx backoff, silent "not modified", smart 4000-char splitting
132. ETag conditional requests (304s don't consume GitHub quota)
133. Vector indexing cron: README digests embedded, incremental (`indexed_at`)
134. Public JSON API: `/api/miniapp`, `/api/repo`, `/api/card`, `/api/compare-card`, `/api/stats`, `/api/search`
135. Telegram **Mini App** (WebApp): tabs for trending/weekly/gems/favourites/subs + live search
136. Landing page with health endpoint
137. Landing/share cards rendered as standalone HTML (screenshot-ready at 1200×630)

---

## What we deliberately did **not** do (and why)

| Idea | Why not (yet) |
|---|---|
| Scrape `github.com/trending` | Breaks monthly, gives no numbers; our own snapshot engine is more accurate |
| Send 2 GB files through Telegram | Impossible by protocol — we split or offload instead |
| Store READMEs forever | Copyright + storage: we cache translations for 30 d and keep digests only |
| Let the LLM generate statistics | Hallucination risk — all numbers come from GitHub/OSV, the model only summarises |
| Full OAuth GitHub login | Needs a client secret + callback page; the bot works read-only without it. Roadmap item |
| Voice *calls* / music podcast | Workers AI TTS speaks, it doesn't sing; multi-voice dialogue is a roadmap item |


---

## M. عملیات و پایداری (افزوده‌شده در استقرار زنده)

| # | قابلیت | چه می‌کند |
|---|---|---|
| 138 | `/health` | وضعیت هر بایندینگ + بک‌اند ذخیره‌سازی (`r2` یا `kv`) |
| 139 | `/health?deep=<secret>` | ۱۰ آزمون زنده: نوشتن/خواندن D1، راندتریپ باینری KV، `getMe` تلگرام، سهمیه‌ی GitHub، تولید متن AI، امبدینگ، صف، Durable Object، صدا |
| 140 | `/health?cron=1` | ضربان زمان‌بند: آخرین کرون، چند دقیقه پیش، آخرین خطا |
| 141 | `/health?tts=probe` | آزمون تک‌تک مدل‌های TTS و گزارش شکل پاسخ هرکدام |
| 142 | `/selfcheck?text=…&uid=…` | کل مسیر یک آپدیت را درون‌خطی اجرا می‌کند و خطای دقیق را برمی‌گرداند (دیباگ روی محیط زنده بدون نیاز به تلگرام) |
| 143 | `npm test` | ۲۵ تست الگوریتمی + گارد SQL: تطابق تعداد `?` و مقادیر `bind()` در ۸۸ دستور |
| 144 | لاگ `lens-swallowed` | هیچ خطای نوشتن در D1 دیگر بی‌صدا نمی‌ماند |
| 145 | BlobStore | یک انتزاع برای R2/KV: اگر R2 نبود، خودکار روی KV (سقف ۲۴ مگابایت) کار می‌کند |
| 146 | تقسیم جریانی دانلود | فایل بزرگ بدون بافرکردن کل آرشیو، به قطعات تلگرامی تقسیم می‌شود (تا ۱۲ قطعه) و در نهایت به GitHub Actions آفلاود می‌شود |
| 147 | روت دامنه + حذف پیشوند مسیر | کارکردن روی دامنه‌ی اختصاصی وقتی `workers.dev` در دسترس نیست؛ همه‌ی لینک‌های تولیدی درست می‌مانند |
