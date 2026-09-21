import type { Env } from "../env";
import type { AiBrain } from "./brain";
import { Telegram } from "../tg/api";
import { BlobStore } from "../core/blobstore";

/**
 * Lens Podcast — a daily/weekly AI audio brief of trending repositories.
 * Script (LLM) → TTS (Workers AI) → R2 → Telegram voice message.
 *
 * This is the feature the original bot cannot even dream about: a Persian
 * tech podcast generated automatically every morning from live GitHub data.
 */
export class Podcast {
  constructor(private env: Env, private ai: AiBrain, private tg: Telegram) {}

  async script(rows: any[], scope: "daily" | "weekly" = "daily"): Promise<string> {
    const brief = rows.slice(0, 6).map((r) => ({
      name: r.full_name, desc: r.description, stars: r.stars, gained: r.gained, lang: r.language, topics: (r.topics ?? []).slice(0, 4),
    }));
    const out = await this.ai.chat(
      `You are the host of a short Persian tech podcast called «لنز» about open-source.\n` +
        `Write a spoken script (NO markdown, NO emojis, NO stage directions) of about 260 Persian words.\n` +
        `Structure: warm greeting → what happened in open-source ${scope === "daily" ? "today" : "this week"} → ` +
        `walk through 4 of these repos one by one (why they matter, who should care, one practical tip) → a closing thought.\n` +
        `Numbers must be read naturally in Persian (مثلاً «دوازده هزار و چهارصد ستاره»).\n\nDATA:\n${JSON.stringify(brief)}`,
      { tier: "smart", max_tokens: 1100, temperature: 0.6, cacheKey: `pod:${scope}:${new Date().toISOString().slice(0, 10)}`, cacheTtl: 43200 },
    );
    return out;
  }

  /** Generate + publish. Returns the storage key (R2 or KV depending on account). */
  async publish(rows: any[], scope: "daily" | "weekly" = "daily") {
    const day = new Date().toISOString().slice(0, 10);
    const key = `podcast/${scope}-${day}.mp3`;
    const blobs = new BlobStore(this.env);
    const existing = await blobs.head(key);
    if (existing) return { key, script: await blobs.getText(`pod:script:${scope}-${day}`) ?? "" };

    const script = await this.script(rows, scope);
    if (!script) return null;
    const audio = await this.ai.speak(script, "fa");
    if (!audio) {
      await blobs.putText(`pod:script:${scope}-${day}`, script);
      return { key: null, script };
    }
    await blobs.put(key, audio, { contentType: "audio/mpeg", cacheControl: "public, max-age=86400" });
    await blobs.putText(`pod:script:${scope}-${day}`, script);
    return { key, script };
  }

  /** Send the podcast to one chat (used by /podcast and by the digest fan-out). */
  async sendTo(chatId: number, scope: "daily" | "weekly" = "daily", rows?: any[]) {
    const day = new Date().toISOString().slice(0, 10);
    const key = `podcast/${scope}-${day}.mp3`;
    const blobs = new BlobStore(this.env);
    const obj = await blobs.get(key);
    if (obj) {
      const buf = await obj.arrayBuffer();
      return this.tg.sendAudio(chatId, buf, `🎙 پادکست ${scope === "daily" ? "روزانه" : "هفتگی"} لنز — ${day}`, {}, `${scope}-${day}.mp3`);
    }
    // generate on demand (first listener pays the cost)
    const data = rows ?? (await this.env.DB.prepare(
      `SELECT payload FROM trending WHERE period=? AND language='all' AND day=(SELECT MAX(day) FROM trending WHERE period=?) ORDER BY rank LIMIT 6`,
    ).bind(scope, scope).all<{ payload: string }>().catch(() => ({ results: [] as any[] }))).results?.map((r) => JSON.parse(r.payload)) ?? [];
    if (!data.length) return { ok: false as const, description: "no data" };
    const built = await this.publish(data, scope);
    if (!built?.key) return { ok: false as const, description: "tts unavailable" };
    const obj2 = await blobs.get(built.key);
    if (!obj2) return { ok: false as const, description: "missing" };
    const buf = await obj2.arrayBuffer();
    await this.tg.sendAudio(chatId, buf, `🎙 پادکست ${scope === "daily" ? "روزانه" : "هفتگی"} لنز — ${day}`, {});
    return { ok: true as const, description: built.script };
  }
}
