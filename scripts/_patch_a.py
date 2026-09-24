import pathlib, sys

def edit(path, old, new, n=1):
    p = pathlib.Path(path); s = p.read_text()
    if old not in s:
        print(f"!! anchor missed in {path}: {old[:70]!r}"); sys.exit(1)
    p.write_text(s.replace(old, new, n)); print(f"ok {path}  «{old.strip()[:48]}…»")

# ── A1. the decoder every feature stands on ─────────────────────────────────
# `Uint8Array.from(bin, cb)` runs a JS callback per character: 22× slower than a
# plain indexed loop on the same 18 KB (1.87 ms vs 0.086 ms). On Workers' free
# tier the CPU budget is 10 ms per request, so one line here decided whether a
# README screen rendered or died with 1102 — and it is on every file, PDF and
# upload path in the bot.
edit("src/features/assistant.ts",
'''export function decodeB64(s: string): string {
  try {
    const bin = atob(s.replace(/\\s/g, ""));
    const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
    return new TextDecoder("utf-8").decode(bytes);
  } catch {
    try { return atob(s.replace(/\\s/g, "")); } catch { return ""; }
  }
}''',
'''export function decodeB64(s: string): string {
  try {
    const bin = atob(s.replace(/\\s/g, ""));
    /* Indexed loop, not Uint8Array.from(bin, cb): the callback version spends
       ~1.9 ms on 18 KB where this spends 0.09 ms, and this runner is on the
       README / source / PDF / upload paths of a worker with a 10 ms CPU budget. */
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new TextDecoder("utf-8").decode(bytes);
  } catch {
    try { return atob(s.replace(/\\s/g, "")); } catch { return ""; }
  }
}

/**
 * Decode one byte range of a base64 document.
 *
 * A README arrives base64-encoded as a whole; decoding all of it to show page
 * one is what put this screen over the CPU limit. Base64 maps every 3 bytes to
 * 4 characters, so a byte range translates to an exact character range when it
 * is aligned to those groups — and a cut that lands mid-character is trimmed by
 * the replacement character the decoder leaves behind.
 */
export function decodeB64Range(b64: string, fromByte: number, toByte: number): string {
  const g0 = Math.floor(Math.max(0, fromByte) / 3) * 4;
  const g1 = Math.ceil(Math.max(0, toByte) / 3) * 4;
  let text = decodeB64(b64.slice(g0, g1));
  // a range boundary can split a multi-byte character: drop the stub
  if (text.endsWith("\\uFFFD")) text = text.slice(0, -1);
  return text;
}''')

# ── A2. the README screen: work one page at a time ──────────────────────────
edit("src/features/assistant.ts",
'''    const md = decodeB64(raw.content);

    const cacheKey = `trl:${full}:${h.loc}`;
    let translated = await h.env.STATE.get(cacheKey);
    if (!translated) {
      // keep the structure: translate in two passes for very long READMEs
      // parts go out in parallel through *different* pooled keys, so several
      // donated keys genuinely share one long translation
      const parts = splitMd(md, 14000).slice(0, 3);
      const out = await h.ai.translateMany(parts, h.loc, "README");
      translated = out.join("\\n\\n");
      // never cache an empty translation — it silently poisons the feature
      if (translated) {
        await h.env.STATE.put(cacheKey, translated, { expirationTtl: 2592000 }).catch((e: any) => console.error("lens-swallowed", String(e?.message ?? e)));
      }
    }''',
'''    /* One page per request, deliberately.
     *
     * This screen used to decode the entire README, split it into three 14 000
     * character parts and translate all three before rendering — and died with
     * «error code: 1102» (the worker's CPU limit) on any README worth reading.
     * The work now scales with the page being shown, not with the file: the byte
     * range for page N is decoded, translated and cached on its own, and the
     * rest of the document waits until the reader asks for it. It also makes
     * «ادامه» mean something for very long READMEs, which used to stop at the
     * second page because only three parts ever existed. */
    const total = readmePages(raw.size ?? 0, raw.content.length);
    const cacheKey = readmePageKey(full, h.loc, 0);
    let translated = await h.env.STATE.get(cacheKey);
    if (!translated) {
      const out = await h.ai.translateMany([readmeSlice(raw.content, 0, total)], h.loc, "README");
      translated = out.join("\\n\\n");
      // never cache an empty translation — it silently poisons the feature
      if (translated) {
        await h.env.STATE.put(cacheKey, translated, { expirationTtl: 2592000 }).catch((e: any) => console.error("lens-swallowed", String(e?.message ?? e)));
      }
    }''')

edit("src/features/assistant.ts",
'''    const MD = await import("../hub/richdoc");
    const pages = MD.paginateMd(translated.slice(0, 24000), MD.README_PAGE_CHARS);
    await h.replyRich(await readmePage(full, pages[0], 0, pages.length, raw.html_url, fa), kb(
      pages.length > 1 ? [{ text: (fa ? "ادامه" : "Continue") + " ➡️", cb: `ai:trmore:${full}:1` }] : [],''',
'''    const MD = await import("../hub/richdoc");
    /* The page is already the size of a page: one render, no 24 000-character
       paginate pass over the whole document. */
    const pages = MD.paginateMd(translated, MD.README_PAGE_CHARS, 1);
    await h.replyRich(await readmePage(full, pages[0], 0, total, raw.html_url, fa), kb(
      total > 1 ? [{ text: (fa ? "ادامه" : "Continue") + " ➡️", cb: `ai:trmore:${full}:1` }] : [],''')

edit("src/features/assistant.ts",
'''    await h.session.set(`tr:${full}`, translated);
  }''',
'''    await h.session.set(`tr:${full}`, translated);
  }

  /**
   * Page N of a README translation, translated on demand and cached per page.
   *
   * The pages of a README are cheap to talk about (a byte range) and expensive
   * to produce, so each one is produced when it is first read and then kept
   * for a month. A reader who never leaves page one pays for page one.
   */
  async readmeMore(h: H, full: string, page: number) {
    const fa = h.loc === "fa";
    const gh = new GithubRest(h.env);
    const raw = await gh.readme(full, 3600).catch(() => null);
    if (!raw?.content) return h.toast(fa ? "دوباره امتحان کن" : "try again", true);
    const total = readmePages(raw.size ?? 0, raw.content.length);
    const idx = Math.max(0, Math.min(page, total - 1));
    await h.loading(fa ? `🌍 صفحهٔ ${idx + 1} را ترجمه می‌کنم…` : `🌍 translating page ${idx + 1}…`);

    const cacheKey = readmePageKey(full, h.loc, idx);
    let translated = await h.env.STATE.get(cacheKey);
    if (!translated) {
      const out = await h.ai.translateMany([readmeSlice(raw.content, idx, total)], h.loc, "README");
      translated = out.join("\\n\\n");
      if (translated) {
        await h.env.STATE.put(cacheKey, translated, { expirationTtl: 2592000 }).catch(() => null);
      }
    }
    if (!translated) {
      const notice = await aiDownNotice(h.env, h.loc);
      return h.reply(`${notice}\\n\\n📄 <a href="${raw.html_url}">README</a>`, kb([{ text: "◀️ " + (fa ? "بازگشت" : "Back"), cb: `s:card:${full}` }]), true);
    }

    const MD = await import("../hub/richdoc");
    const pages = MD.paginateMd(translated, MD.README_PAGE_CHARS, 1);
    const nav: any[] = [];
    if (idx > 0) nav.push({ text: "⬅️ " + (fa ? "قبلی" : "Prev"), cb: `ai:trmore:${full}:${idx - 1}` });
    if (idx + 1 < total) nav.push({ text: (fa ? "ادامه" : "Continue") + " ➡️", cb: `ai:trmore:${full}:${idx + 1}` });
    return h.replyRich(
      await readmePage(full, pages[0], idx, total, raw.html_url, fa),
      kb(nav, [
        { text: "🇬🇧 English", cb: `ai:tre:${full}:en` },
        { text: "🖨 PDF", cb: `ai:trpdf:${full}` },
      ], [{ text: "◀️ " + (fa ? "بازگشت" : "Back"), cb: `s:card:${full}` }]),
      true,
    );
  }''')

# ── A3. the helpers the two paths share ─────────────────────────────────────
edit("src/features/assistant.ts",
'''function splitMd(md: string, size: number): string[] {''',
'''/** How many pages a README of this size has. Bytes, not characters: the size
    arrives with the API response, so the count costs nothing to compute. */
export const README_PAGE_BYTES = 11000;
export function readmePages(sizeBytes: number, b64Len: number): number {
  const bytes = sizeBytes > 0 ? sizeBytes : Math.floor(b64Len * 0.75);
  return Math.max(1, Math.min(9, Math.ceil(bytes / README_PAGE_BYTES)));
}
export function readmePageKey(full: string, loc: string, page: number): string {
  return `trlp:${full}:${loc}:${page}`;
}
/** The markdown for one page — one decode, one page's worth of work. */
export function readmeSlice(b64: string, page: number, total: number): string {
  const per = Math.ceil((Math.min(9, Math.max(1, total)) * README_PAGE_BYTES) / Math.max(1, total));
  return decodeB64Range(b64, page * per, (page + 1) * per);
}

function splitMd(md: string, size: number): string[] {''')

# ── A4. every page turn goes through the same page-wise path ────────────────
edit("src/index.ts",
'''  const text = (await h.session.get(`tr:${full}`)) as string | null;
  const source = text ?? (await h.env.STATE.get(`trl:${full}:${h.loc}`));
  if (!source) return h.toast(h.loc === "fa" ? "دوباره ترجمه کن" : "re-translate first", true);''',
'''  /* The translated README is no longer stored whole: page N is decoded,
     translated and cached on its own, so a page turn costs one page. The old
     session copy is still honoured, so a message sent before this change keeps
     working. */
  const session = (await h.session.get(`tr:${full}`)) as string | null;
  const legacy = session ?? (await h.env.STATE.get(`trl:${full}:${h.loc}`));
  if (!legacy && page > 0) return assistant.readmeMore(h, full, page);
  if (!legacy) return h.toast(h.loc === "fa" ? "دوباره ترجمه کن" : "re-translate first", true);
  const source = legacy;''')

# ── B. an identity is never overwritten by an empty one ─────────────────────
edit("src/core/db.ts",
'''       ON CONFLICT(id) DO UPDATE SET username=excluded.username, first_name=excluded.first_name,
         last_seen_at=excluded.last_seen_at, locale=COALESCE(NULLIF(excluded.locale, ''), users.locale)`,''',
'''       /* Names only ever move forward: an incoming *empty* name is a caller that
          had none to give (an audit impersonating the owner, a forwarded message
          with no sender name), and writing it blanked a real person's row — the
          audit that drove the owner's own id renamed him «Self» on the public
          leaderboard. A real rename still lands, because it is not empty. */
       ON CONFLICT(id) DO UPDATE SET
         username=COALESCE(NULLIF(excluded.username, ''), users.username),
         first_name=COALESCE(NULLIF(excluded.first_name, ''), users.first_name),
         last_seen_at=excluded.last_seen_at,
         locale=COALESCE(NULLIF(excluded.locale, ''), users.locale)`,''')

print("round-13 patches applied")
