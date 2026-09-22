import type { H } from "../core/handler";
import { GithubRest } from "../github/rest";
import { BlobStore, streamParts } from "../core/blobstore";
import { fmt } from "./cards";
import { code, i, tgEscape } from "../tg/types";
import { kb } from "../tg/keyboards";

/**
 * SOURCE INBOX — download any repository's source tree, straight into Telegram.
 *
 * Delivery is chosen automatically from the archive size and the storage the
 * account actually has:
 *
 *   ≤ 40 MB            → one document, buffered in the isolate
 *   ≤ storage cap      → cached (R2 unlimited / KV ≤ 24 MB) then sent
 *   ≤ 12 × 20 MB parts → **streamed** split: parts are produced from the HTTP
 *                        body as it arrives, so memory stays at one part
 *   bigger             → offloaded to the GitHub Actions helper (7z multipart)
 *
 * Nothing is ever re-downloaded: the cache key is content-addressed by
 * `full_name@ref`, so the second user gets it instantly.
 */
export class Downloader {
  constructor(private maxTgMb = 49) {}

  private get partSize() {
    // keep each part comfortably under Telegram's 50 MB limit, and small
    // enough that streaming never needs a big buffer
    return Math.max(8, Math.min(40, Math.floor(this.maxTgMb * 0.55))) * 1024 * 1024;
  }

  private get oneShot() {
    // anything at or below this is buffered and sent in a single message
    return Math.min(40, Math.floor(this.maxTgMb * 0.8)) * 1024 * 1024;
  }

  async home(h: H) {
    const fa = h.loc === "fa";
    const store = new BlobStore(h.env);
    const recent = await h.env.DB.prepare(
      `SELECT full_name, status, bytes, created_at FROM downloads WHERE user_id=? ORDER BY created_at DESC LIMIT 5`,
    ).bind(h.u.id).all<{ full_name: string; status: string; bytes: number; created_at: number }>().catch(() => ({ results: [] as any[] }));

    await h.reply(
      `📥 <b>${fa ? "صندوق دانلود سورس" : "Source inbox"}</b>\n\n` + (fa
        ? "سورس هر مخزنی را مستقیم به تلگرام بگیر:\n• ZIP یا TAR (بدون واسطه، از خود گیت‌هاب)\n• برنچ/تگ/کامیت دلخواه\n• تقسیم جریانی خودکار برای مخازن بزرگ\n• مخازن چند گیگابایتی → کارخانه ۷z روی GitHub Actions\n\n" +
          `<i>پشتیبان ذخیره‌سازی این اکانت: ${store.backend === "r2" ? "R2 ✅" : "KV (R2 روی این اکانت فعال نیست — تقسیم جریانی فعال است)"}</i>`
        : "Grab any repo's source straight into Telegram — ZIP/TAR, any ref, auto-split for big repos.")
        + `\n\n<code>/dl owner/repo [@tag] [zip|tar]</code>`,
      kb(
        [{ text: "🔥 " + (fa ? "پیشنهاد داغ" : "Hot pick"), cb: "d:trending" }],
        [
          { text: "⭐ " + (fa ? "از علاقه‌مندی‌ها" : "From favourites"), cb: "d:favs" },
        ],
        recent.results?.length ? [[{ text: "🕘 " + (fa ? "دانلودهای اخیر" : "Recent downloads"), cb: "d:recent" }]] : [],
        
      ),
      !!h.cbId,
    );
  }

  async choose(h: H, full: string) {
    const fa = h.loc === "fa";
    const gh = new GithubRest(h.env);
    const [repo, branches, tags] = await Promise.all([
      gh.repo(full, 900).catch(() => null),
      gh.branches(full, 12).catch(() => [] as any[]),
      gh.tags(full, 12).catch(() => [] as any[]),
    ]);
    if (!repo) return h.reply(fa ? "مخزن پیدا نشد." : "Repo not found.", kb([{ text: "◀️", cb: "d:home" }]), !!h.cbId);
    const sizeMb = (repo.size ?? 0) / 1024;
    const est = sizeMb > 100 ? `~${(sizeMb / 1.7).toFixed(0)} MB` : `~${sizeMb.toFixed(1)} MB`;

    await h.reply(
      `📥 <b>${tgEscape(full)}</b>\n\n` +
        `📦 ${fa ? "حجم تقریبی سورس" : "approx source size"}: <b>${est}</b>\n` +
        `🕒 ${fa ? "آخرین کامیت" : "last push"}: <code>${(repo.pushed_at ?? "").slice(0, 10)}</code>   ` +
        `🌿 <code>${tgEscape(repo.default_branch)}</code>${repo.license?.spdx_id ? `   ⚖️ ${repo.license.spdx_id}` : ""}\n` +
        (sizeMb > 400 ? `\n⚠️ ${fa ? "مخزن بزرگ است — تقسیم جریانی یا آفلاود به Actions انجام می‌شود." : "Large repo — streaming split or Actions offload."}\n` : "") +
        `\n${fa ? "قالب و مرجع را انتخاب کن:" : "Choose format & ref:"}`,
      kb(
        [
          { text: "🗜 ZIP " + (fa ? "پیش‌فرض" : "default"), cb: `d:go:${full}|zip|${repo.default_branch}` },
          { text: "📦 TAR.GZ", cb: `d:go:${full}|tar|${repo.default_branch}` },
        ],
        [
          { text: "🧩 ZIP " + (fa ? "با تقسیم" : "split"), cb: `d:split:${full}|zip|${repo.default_branch}` },
          { text: "🏭 7z " + (fa ? "چندپارت (Actions)" : "multipart (Actions)"), cb: `d:a7z:${full}` },
        ],
        branches.slice(0, 6).map((b) => [{ text: `🌿 ${b.name}`, cb: `d:go:${full}|zip|${b.name}` }]),
        tags.slice(0, 6).map((t) => [{ text: `🏷 ${t.name}`, cb: `d:go:${full}|zip|${t.name}` }]),
        [
          { text: "📄 " + (fa ? "مرور فایل‌ها" : "browse files"), cb: `r:files:${full}` },
          { text: "🔗 " + (fa ? "لینک مستقیم" : "direct link"), cb: `d:link:${full}` },
        ],
        [{ text: "◀️ " + (fa ? "بازگشت" : "Back"), cb: "d:home" }],
      ),
      !!h.cbId,
    );
  }

  /** Main entry: fetch → (cache) → deliver. */
  async run(h: H, full: string, format: "zip" | "tar", ref: string, opts: { split?: boolean } = {}) {
    const fa = h.loc === "fa";
    if (!(await h.store.quota(h.u.id, 3)).ok) {
      return h.reply(
        `🚦 ${fa ? "سهمیه روزانه تمام شد." : "Daily quota reached."}`,
        kb([[{ text: "⚡ " + (fa ? "ارتقا" : "Upgrade"), cb: "me:plan" }]]),
        !!h.cbId,
      );
    }
    const blobs = new BlobStore(h.env);
    const ext = format === "zip" ? "zip" : "tar.gz";
    const cacheKey = `src/${`${full}@${ref}`.replace(/[^\w@.\-/]/g, "_")}.${ext}`;
    const filename = `${full.replace("/", "-")}-${ref.replace(/\//g, "_")}.${ext}`;

    if (opts.split) {
      await h.toast(fa ? "🧩 تقسیم جریانی…" : "🧩 streaming…");
      return this.streamFromGithub(h, full, format, ref, filename, true);
    }

    // ── 1. cache hit? ──────────────────────────────────────────────────────
    const cached = await blobs.head(cacheKey);
    if (cached) {
      const body = await blobs.get(cacheKey);
      if (body) {
        const info = await blobs.head(cacheKey);
        await h.tg.sendChatAction(h.chatId, "upload_document").catch((e: any) => console.error("lens-swallowed", String(e?.message ?? e)));
        const buf = await body.arrayBuffer();
        await this.deliver(h, filename, buf, info?.size ?? buf.byteLength, ref, format, full);
        await h.store.event(h.u.id, "download_cache_hit", full, { bytes: info?.size ?? buf.byteLength, backend: blobs.backend });
        await h.store.addXp(h.u.id, 2, "download");
        return;
      }
    }

    // ── 2. HEAD the archive to learn the real size before touching it ──────
    const url = this.archiveUrl(full, format, ref);
    const head = await fetch(url, {
      method: "HEAD",
      headers: h.env.GITHUB_TOKEN ? { authorization: `Bearer ${h.env.GITHUB_TOKEN}` } : {},
      redirect: "follow",
    }).catch(() => null);
    const size = Number(head?.headers.get("content-length") ?? 0);
    if (size > 900 * 1024 * 1024) return this.offloadToActions(h, full, ref, size);

    // ── 3. small enough to one-shot? ───────────────────────────────────────
    if (size && size <= this.oneShot) {
      const res = await fetch(url, { headers: h.env.GITHUB_TOKEN ? { authorization: `Bearer ${h.env.GITHUB_TOKEN}` } : {} });
      if (!res.ok || !res.body) return this.fetchFailed(h, full, res.status);
      const buf = await res.arrayBuffer();
      await h.store.event(h.u.id, "download_fetch", full, { bytes: buf.byteLength, format, ref });
      // opportunistic caching (only when it fits the backend's limit)
      if (BlobStore.cacheable(buf.byteLength, blobs.backend)) {
        await blobs.put(cacheKey, buf, {
          contentType: format === "zip" ? "application/zip" : "application/gzip",
          metadata: { full_name: full, ref, format },
        });
      }
      await this.record(h, full, ref, format, buf.byteLength, cacheKey);
      await h.tg.sendChatAction(h.chatId, "upload_document").catch((e: any) => console.error("lens-swallowed", String(e?.message ?? e)));
      await this.deliver(h, filename, buf, buf.byteLength, ref, format, full);
      await h.store.addXp(h.u.id, 3, "download");
      return;
    }

    // ── 4. bigger → stream and split on the fly ───────────────────────────
    return this.streamFromGithub(h, full, format, ref, filename, false, size);
  }

  /** Send one document (re-splitting on the off chance Telegram refuses it). */
  private async deliver(h: H, filename: string, buf: ArrayBuffer | Uint8Array, bytes: number, ref: string, format: string, full: string) {
    const fa = h.loc === "fa";
    const caption =
      `📥 <b>${tgEscape(filename)}</b>\n` +
      `📦 ${(bytes / 1048576).toFixed(2)} MB · ${format.toUpperCase()} · <code>${tgEscape(ref)}</code>\n` +
      `🔗 ${fa ? "منبع" : "source"}: <a href="https://github.com/${full}">github.com/${tgEscape(full)}</a>`;
    const res = await h.tg.sendDocument(h.chatId, filename, buf, caption, {
      parse_mode: "HTML",
      reply_markup: this.afterKb(h, full) as any,
    });
    if ((res as any).ok === false) {
      const msg = String((res as any).description ?? "");
      if (/too big|Request Entity Too Large/i.test(msg)) {
        const arr = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
        return this.splitFromBuffer(h, filename, arr, full, ref);
      }
      await h.reply(
        `⚠️ ${fa ? "ارسال ناموفق بود" : "send failed"}: <code>${tgEscape(msg.slice(0, 160))}</code>\n` +
          `🔗 ${fa ? "لینک مستقیم" : "direct"}: ${this.archiveUrl(full, format as any, ref)}`,
        kb([[{ text: "🌐 GitHub", url: `https://github.com/${full}` }]]),
      );
    }
  }

  /** Streaming split from GitHub: memory stays at one part, no R2 needed. */
  private async streamFromGithub(h: H, full: string, format: "zip" | "tar", ref: string, filename: string, forced: boolean, knownSize = 0) {
    const fa = h.loc === "fa";
    const ext = format === "zip" ? "zip" : "tar.gz";
    const url = this.archiveUrl(full, format, ref);
    const res = await fetch(url, {
      headers: h.env.GITHUB_TOKEN ? { authorization: `Bearer ${h.env.GITHUB_TOKEN}` } : {},
      redirect: "follow",
    }).catch(() => null);
    if (!res?.ok || !res.body) return this.fetchFailed(h, full, res?.status ?? 0);

    const size = Number(res.headers.get("content-length") ?? 0) || knownSize;
    const parts = size ? Math.ceil(size / this.partSize) : 0;
    if (parts > 12) return this.offloadToActions(h, full, ref, size, parts);

    if (forced || (parts > 1)) {
      await h.reply(
        `🧩 <b>${fa ? "ارسال جریانی" : "Streaming delivery"}</b>\n` +
          (fa
            ? `حجم کل ${size ? (size / 1048576).toFixed(1) + " MB" : "نامشخص"} — پارت‌ها ~${Math.round(this.partSize / 1048576)} MB هستند و بدون ذخیره‌سازی میانی ساخته می‌شوند.\nپارت‌ها را به ترتیب دانلود کن.`
            : `Total ${size ? (size / 1048576).toFixed(1) + " MB" : "unknown"}, ~${Math.round(this.partSize / 1048576)} MB per part.`),
      );
    }

    const base = `${full.replace("/", "-")}-${ref.replace(/\//g, "_")}.${ext}`;
    let sent = 0;
    let total = 0;
    for await (const part of streamParts(res.body as ReadableStream, this.partSize, 12)) {
      const name = `${base}.part${String(part.index).padStart(3, "0")}`;
      await h.tg.sendChatAction(h.chatId, "upload_document").catch((e: any) => console.error("lens-swallowed", String(e?.message ?? e)));
      await h.tg.sendDocument(h.chatId, name, part.bytes,
        `🧩 ${part.index}/${parts || "?"} — ${name}\n${fa ? "ادغام:" : "merge:"} <code>cat "${base}".part* > "${base}"</code>`,
        { parse_mode: "HTML" });
      sent++;
      total += part.bytes.byteLength;
      await h.store.event(h.u.id, "download_part", full, { part: part.index, bytes: part.bytes.byteLength });
    }

    if (sent === 0) return this.fetchFailed(h, full, 0);
    if (sent === 1) {
      // it turned out to fit in one part anyway
      await h.reply(`✅ <b>${tgEscape(base)}</b> — ${(total / 1048576).toFixed(2)} MB`, kb([{ text: "📥 " + (fa ? "دانلود دیگر" : "Another ref"), cb: `d:repo:${full}` }], []));
    } else {
      await h.tg.sendMessage(h.chatId,
        `✅ <b>${fa ? "همه پارت‌ها ارسال شد" : "All parts sent"}</b> — ${sent} × ${(this.partSize / 1048576).toFixed(0)} MB\n` +
          `${fa ? "دستور ادغام در هر پیام پارت آمده" : "merge command is in each part's caption"}`,
        { parse_mode: "HTML", reply_markup: this.afterKb(h, full) as any });
    }
    await this.record(h, full, ref, format, total, null);
    await h.store.addXp(h.u.id, 4, "download_split");
  }

  /** Fallback split when Telegram rejects a buffered document. */
  private async splitFromBuffer(h: H, filename: string, bytes: Uint8Array, full: string, ref: string) {
    const fa = h.loc === "fa";
    const size = this.partSize;
    const parts = Math.ceil(bytes.byteLength / size);
    await h.reply(`🧩 ${fa ? "تقسیم به" : "splitting into"} ${parts} ${fa ? "پارت" : "parts"}…`);
    for (let i = 0; i < parts; i++) {
      const chunk = bytes.slice(i * size, Math.min((i + 1) * size, bytes.byteLength));
      await h.tg.sendDocument(h.chatId, `${filename}.part${String(i + 1).padStart(3, "0")}`, chunk,
        `🧩 ${i + 1}/${parts}\n${fa ? "ادغام:" : "merge:"} <code>cat "${filename}".part* > "${filename}"</code>`,
        { parse_mode: "HTML" });
    }
    await this.tg_summary(h, full);
  }

  private tg_summary(h: H, full: string) {
    return h.tg.sendMessage(h.chatId, `✅ ${h.loc === "fa" ? "تکمیل شد" : "done"}`, {
      reply_markup: this.afterKb(h, full) as any,
    });
  }

  private async fetchFailed(h: H, full: string, status: number) {
    const fa = h.loc === "fa";
    await h.reply(
      `❌ ${fa ? "دریافت از گیت‌هاب ناموفق بود" : "GitHub fetch failed"} (${status || "network"})\n\n` +
        `🔗 ${fa ? "لینک مستقیم" : "direct"}: <a href="https://github.com/${full}/archive/refs/heads/HEAD.zip">zip</a>`,
      kb([[{ text: "🔁 " + (fa ? "تلاش دوباره" : "Retry"), cb: `d:repo:${full}` }]]),
      !!h.cbId,
    );
  }

  private archiveUrl(full: string, format: "zip" | "tar", ref: string) {
    return format === "zip"
      ? `https://codeload.github.com/${full}/zip/${encodeURIComponent(ref)}`
      : `https://codeload.github.com/${full}/tar.gz/${encodeURIComponent(ref)}`;
  }

  private async record(h: H, full: string, ref: string, kind: string, bytes: number, r2Key: string | null) {
    await h.env.DB.prepare(
      `INSERT INTO downloads (id, user_id, full_name, ref, kind, bytes, r2_key, status, expires_at, created_at)
       VALUES (?,?,?,?,?,?,?,'ready',?,?)`,
    ).bind(crypto.randomUUID(), h.u.id, full, ref, kind, bytes, r2Key, Date.now() + 30 * 86400000, Date.now()).run().catch((e: any) => console.error("lens-swallowed", String(e?.message ?? e)));
  }

  private afterKb(h: H, full: string) {
    const fa = h.loc === "fa";
    return kb(
      [
        { text: "📥 " + (fa ? "دانلود دیگر" : "Another ref"), cb: `d:repo:${full}` },
        { text: "🛰 " + (fa ? "کاوش" : "Scout"), cb: `s:go:${full}` },
      ],
      [
        { text: "⭐ " + (fa ? "ذخیره" : "Save"), cb: `f:add:${full}` },
        { text: "🛡 " + (fa ? "امنیت" : "Security"), cb: `sec:repo:${full}` },
      ],
    );
  }

  /**
   * Offload to the GitHub Actions helper repo (for 1 GB+ archives):
   * the workflow downloads, splits with 7z and publishes a release with parts.
   */
  async offloadToActions(h: H, full: string, ref: string, bytes: number, parts?: number) {
    const fa = h.loc === "fa";
    const jobId = crypto.randomUUID();
    await h.env.DB.prepare(`INSERT INTO action_jobs (id, user_id, kind, payload, created_at) VALUES (?,?,?,?,?)`)
      .bind(jobId, h.u.id, "split-7z", JSON.stringify({ full, ref, bytes, parts }), Date.now()).run().catch((e: any) => console.error("lens-swallowed", String(e?.message ?? e)));

    let dispatched = false;
    let detail = "";
    if (h.env.HELPER_REPO_TOKEN && h.env.HELPER_REPO) {
      const res = await fetch(`https://api.github.com/repos/${h.env.HELPER_REPO}/dispatches`, {
        method: "POST",
        headers: { authorization: `Bearer ${h.env.HELPER_REPO_TOKEN}`, accept: "application/vnd.github+json", "user-agent": "GitHubLensUltra" },
        body: JSON.stringify({ event_type: "pack-repo", client_payload: { full, ref, job_id: jobId, chat_id: h.chatId, part_mb: 1900 } }),
      }).catch(() => null);
      dispatched = !!res?.ok;
      if (!dispatched && res) detail = `(${res.status})`;
    }
    await h.reply(
      `🏭 <b>${fa ? "سپردن به کارخانه Actions" : "Offloaded to Actions"}</b>\n\n` +
        (fa
          ? `این مخزن ${bytes ? `(${(bytes / 1073741824).toFixed(2)} GB)` : ""} برای تلگرام بزرگ است.\nورک‌فلوی GitHub Actions آن را دانلود، با 7z به پارت‌های ۱.۹ گیگابایتی تقسیم و در Release آپلود می‌کند؛ لینک‌ها همین‌جا می‌آید.`
          : `Too big for Telegram: an Actions workflow splits it with 7z and publishes parts.`) +
        `\n\n🧾 ${fa ? "شناسه کار" : "job"}: <code>${jobId.slice(0, 8)}</code> ` +
        (dispatched ? `✅ ${fa ? "ورک‌فلو شروع شد" : "workflow dispatched"}` : `⚠️ ${fa ? "کارخانه Actions تنظیم نشده" : "Actions helper not configured"} ${detail}`) +
        `\n\n🔗 ${fa ? "لینک مستقیم فعلی" : "direct now"}: <a href="${this.archiveUrl(full, "zip", ref)}">ZIP</a> · ` +
        `<a href="${this.archiveUrl(full, "tar", ref)}">TAR.GZ</a>`,
      kb(
        [{ text: "🔔 " + (fa ? "خبرم کن" : "Notify me"), cb: `sub:add:${full}` }],
        [{ text: "◀️ " + (fa ? "بازگشت" : "Back"), cb: `d:repo:${full}` }],
      ),
    );
    await h.store.event(h.u.id, "download_offload", full, { bytes });
  }

  /** Direct links for release assets + source archives. */
  async direct(h: H, full: string) {
    const fa = h.loc === "fa";
    const gh = new GithubRest(h.env);
    const [releases, repo] = await Promise.all([gh.releases(full, 5).catch(() => [] as any[]), gh.repo(full, 900).catch(() => null)]);
    const branch = repo?.default_branch ?? "main";
    const assets = releases.flatMap((r: any) => (r.assets ?? []).map((a: any) => ({ ...a, tag: r.tag_name })));
    const rows = assets.slice(0, 8).map((a: any) => [{ text: `⬇️ ${a.name} (${(a.size / 1048576).toFixed(1)}MB)`, url: a.browser_download_url }]);
    await h.reply(
      `🔗 <b>${tgEscape(full)}</b> — ${fa ? "لینک‌های مستقیم" : "direct links"}\n\n` +
        `• ${fa ? "سورس ZIP" : "source ZIP"}: <a href="${this.archiveUrl(full, "zip", branch)}">download</a>\n` +
        `• ${fa ? "سورس TAR" : "source TAR"}: <a href="${this.archiveUrl(full, "tar", branch)}">download</a>\n` +
        `• ${fa ? "آخرین نسخه" : "latest release"}: <a href="https://github.com/${full}/releases/latest">page</a>\n\n` +
        (assets.length ? `<b>${fa ? "دارایی‌های نسخه" : "release assets"}</b>` : ""),
      kb(...rows, [{ text: "◀️ " + (fa ? "بازگشت" : "Back"), cb: `d:repo:${full}` }]),
      !!h.cbId,
    );
  }

  async recent(h: H) {
    const fa = h.loc === "fa";
    const { results } = await h.env.DB.prepare(
      `SELECT id, full_name, ref, kind, bytes, status, created_at FROM downloads WHERE user_id=? ORDER BY created_at DESC LIMIT 12`,
    ).bind(h.u.id).all<any>().catch(() => ({ results: [] as any[] }));
    await h.reply(
      `🕘 <b>${fa ? "دانلودهای اخیر" : "Recent downloads"}</b>\n\n` +
        ((results ?? []).map((r, i2) =>
          `${i2 + 1}. <b>${tgEscape(r.full_name)}</b> <code>${tgEscape(r.ref ?? "")}</code> — ${fmt((r.bytes ?? 0) / 1048576)} MB ${r.status === "ready" ? "✅" : "⏳"}`).join("\n") ||
          (fa ? "<i>خالی است.</i>" : "<i>empty</i>")),
      kb(
        ...(results ?? []).slice(0, 6).map((r) => [{ text: `📦 ${r.full_name}`, cb: `d:repo:${r.full_name}` }]),
        [{ text: "◀️ " + (fa ? "بازگشت" : "Back"), cb: "d:home" }],
      ),
      !!h.cbId,
    );
  }
}
