import type { Env } from "../env";

/**
 * Secret handling shared by GitHub tokens, donated AI keys and OAuth state.
 *
 * Everything sensitive is encrypted with AES-GCM under a key derived (HKDF) from
 * whatever secret the deployment has: TOKEN_ENCRYPTION_KEY if set, otherwise
 * DOWNLOAD_SIGNING_KEY, otherwise the Telegram webhook secret. Only ciphertext
 * is ever stored, and the 12-byte IV travels with the payload.
 */
async function tokenKey(env: Env, purpose = "github-token"): Promise<CryptoKey> {
  const secret = (env as any).TOKEN_ENCRYPTION_KEY || env.DOWNLOAD_SIGNING_KEY || env.TELEGRAM_WEBHOOK_SECRET;
  const base = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), "HKDF", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt: new TextEncoder().encode("ghlens-token-v1"), info: new TextEncoder().encode(purpose) },
    base, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"],
  );
}

export async function encryptSecret(env: Env, plain: string, purpose = "github-token"): Promise<string> {
  const key = await tokenKey(env, purpose);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, new TextEncoder().encode(plain));
  const packed = new Uint8Array(iv.length + ct.byteLength);
  packed.set(iv, 0);
  packed.set(new Uint8Array(ct), iv.length);
  return btoa(String.fromCharCode(...packed));
}

export async function decryptSecret(env: Env, packedB64: string, purpose = "github-token"): Promise<string | null> {
  try {
    const packed = Uint8Array.from(atob(packedB64), (c) => c.charCodeAt(0));
    const key = await tokenKey(env, purpose);
    const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: packed.slice(0, 12) }, key, packed.slice(12));
    return new TextDecoder().decode(plain);
  } catch (e: any) {
    console.error("secret-decrypt-failed", String(e?.message ?? e));
    return null;
  }
}
