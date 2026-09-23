import type { Env } from "../env";

/**
 * BlobStore — one storage API, two backends.
 *
 *  • R2 (`FILES` binding) when the account has R2 enabled → unlimited size,
 *    range reads, cheap egress.
 *  • KV (`CACHE` namespace) as an automatic fallback → works on accounts where
 *    R2 has not been switched on. KV values are capped at 25 MiB, so the
 *    download pipeline avoids caching anything bigger and streams instead.
 *
 * The rest of the code never needs to know which one is live: `/health`
 * reports it, and large-archive handling adapts automatically.
 */
export type BlobMeta = { size: number; contentType?: string; key: string; backend: "r2" | "kv" };

export interface BlobBody {
  size: number;
  arrayBuffer(): Promise<ArrayBuffer>;
  stream(): ReadableStream;
}

const KV_MAX = 24 * 1024 * 1024; // stay just under the 25 MiB hard limit

export class BlobStore {
  constructor(private env: Env) {}

  get backend(): "r2" | "kv" {
    return this.env.FILES ? "r2" : "kv";
  }

  /** True when this file is small enough to be cached on the active backend. */
  static cacheable(bytes: number, backend: "r2" | "kv") {
    return backend === "r2" ? bytes <= 900 * 1024 * 1024 : bytes <= KV_MAX;
  }

  async head(key: string): Promise<BlobMeta | null> {
    if (this.env.FILES) {
      const o = await this.env.FILES.head(key).catch(() => null);
      if (!o) return null;
      return { size: o.size, contentType: (o.httpMetadata as any)?.contentType, key, backend: "r2" };
    }
    const meta = await this.env.CACHE.get<{ size: number; contentType?: string }>(`blobmeta:${key}`, "json").catch(() => null);
    if (!meta) return null;
    return { size: meta.size, contentType: meta.contentType, key, backend: "kv" };
  }

  async put(
    key: string,
    body: ArrayBuffer | Uint8Array | ReadableStream,
    opts: { contentType?: string; cacheControl?: string; metadata?: Record<string, string> } = {},
  ): Promise<BlobMeta | null> {
    if (this.env.FILES) {
      const buf: any = body instanceof ReadableStream ? body : (body as any);
      const stored = await this.env.FILES.put(key, buf, {
        httpMetadata: { contentType: opts.contentType, cacheControl: opts.cacheControl },
        customMetadata: opts.metadata,
      });
      const size = (stored as any)?.size ?? (body instanceof ReadableStream ? 0 : (body as any).byteLength ?? 0);
      return { size, contentType: opts.contentType, key, backend: "r2" };
    }
    // KV backend: must be a concrete buffer, so stream in and enforce the cap.
    let bytes: Uint8Array;
    if (body instanceof ReadableStream) {
      bytes = await readAll(body, KV_MAX);
    } else {
      bytes = body instanceof Uint8Array ? body : new Uint8Array(body as ArrayBuffer);
    }
    if (bytes.byteLength > KV_MAX) {
      // too big for KV — we simply don't cache it (streaming path handles delivery)
      return null;
    }
    await this.env.CACHE.put(key, bytes, {
      expirationTtl: 60 * 60 * 24 * 30,
      metadata: { size: bytes.byteLength, contentType: opts.contentType },
    });
    await this.env.CACHE.put(`blobmeta:${key}`, JSON.stringify({ size: bytes.byteLength, contentType: opts.contentType }), {
      expirationTtl: 60 * 60 * 24 * 30,
    });
    return { size: bytes.byteLength, contentType: opts.contentType, key, backend: "kv" };
  }

  async get(key: string, range?: { offset: number; length: number }): Promise<BlobBody | null> {
    if (this.env.FILES) {
      const o = (await this.env.FILES.get(key, range ? ({ range } as any) : undefined)) as R2ObjectBody | null;
      if (!o) return null;
      return { size: (o as any).size ?? 0, arrayBuffer: () => o.arrayBuffer(), stream: () => (o as any).body };
    }
    const raw = await this.env.CACHE.get(key, "arrayBuffer").catch(() => null);
    if (!raw) return null;
    const full = new Uint8Array(raw as ArrayBuffer);
    const view = range ? full.slice(range.offset, range.offset + range.length) : full;
    return {
      size: view.byteLength,
      arrayBuffer: async () => (view.buffer as ArrayBuffer).slice(view.byteOffset, view.byteOffset + view.byteLength),
      stream: () => new Blob([view]).stream(),
    };
  }

  async delete(key: string) {
    if (this.env.FILES) return this.env.FILES.delete(key).catch((e: any) => console.error("lens-swallowed", String(e?.message ?? e)));
    await this.env.CACHE.delete(key).catch((e: any) => console.error("lens-swallowed", String(e?.message ?? e)));
    await this.env.CACHE.delete(`blobmeta:${key}`).catch((e: any) => console.error("lens-swallowed", String(e?.message ?? e)));
  }

  /** Free-form small values (cached drafts, short scripts, sync markers). */
  async getText(key: string): Promise<string | null> {
    if (this.env.FILES) {
      const o = await this.env.FILES.get(key).catch(() => null);
      return o ? await o.text() : null;
    }
    return this.env.STATE.get(key).catch(() => null);
  }

  async putText(key: string, value: string, ttlSeconds = 172800) {
    if (this.env.FILES) {
      await this.env.FILES.put(key, value, { httpMetadata: { contentType: "text/plain; charset=utf-8" } }).catch((e: any) => console.error("lens-swallowed", String(e?.message ?? e)));
      return;
    }
    await this.env.STATE.put(key, value, { expirationTtl: ttlSeconds }).catch((e: any) => console.error("lens-swallowed", String(e?.message ?? e)));
  }
}

/** Read a stream into memory with a hard cap (returns what it got if over). */
async function readAll(stream: ReadableStream, cap: number): Promise<Uint8Array> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      chunks.push(value as Uint8Array);
      total += (value as Uint8Array).byteLength;
      if (total > cap) {
        await reader.cancel().catch((e: any) => console.error("lens-swallowed", String(e?.message ?? e)));
        break;
      }
    }
  }
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.byteLength;
  }
  return out;
}

/**
 * Streaming splitter: consumes an HTTP body and yields Telegram-sized chunks
 * without ever holding the whole archive in memory. Used when R2 is absent and
 * the archive is bigger than what we may buffer at once.
 */
export async function* streamParts(body: ReadableStream, partSize: number, maxParts = 12) {
  const reader = body.getReader();
  let pending: Uint8Array[] = [];
  let pendingBytes = 0;
  let index = 1;
  for (;;) {
    const { done, value } = await reader.read();
    if (value) {
      pending.push(value as Uint8Array);
      pendingBytes += (value as Uint8Array).byteLength;
    }
    if (pendingBytes >= partSize || (done && pendingBytes > 0)) {
      if (index > maxParts) {
        await reader.cancel().catch((e: any) => console.error("lens-swallowed", String(e?.message ?? e)));
        return;
      }
      const part = new Uint8Array(pendingBytes);
      let off = 0;
      for (const c of pending) {
        part.set(c, off);
        off += c.byteLength;
      }
      pending = [];
      pendingBytes = 0;
      yield { index: index++, bytes: part };
    }
    if (done) return;
  }
}
