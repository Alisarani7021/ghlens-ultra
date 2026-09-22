import type { H } from "../core/handler";
import { kb } from "../tg/keyboards";
import { tgEscape } from "../tg/types";

export class AppGen {
  async prompt(h: H) {
    const fa = h.loc === "fa";
    return h.reply(
      fa
        ? `🏗️ <b>ساخت نرم‌افزار کامل آمادهٔ ران (Text-to-Full-App in Zip)</b>\n\n` +
          `ایده یا پروژه‌ای که می‌خواهی را بنویس (مثلاً:\n` +
          `• «یک ربات تلگرام دانلودر یوتیوب با پایتون و yt-dlp»\n` +
          `• «یک اسکریپت بک‌آپ‌گیر از دیتابیس با داکر و ناتیف تلگرام»\n` +
          `• «یک API سرور سبک با FastAPI و پای‌دنتیک»)\n\n` +
          `هوش مصنوعی تمام فایل‌ها (کد اصلی، requirements، داکر، تنظیمات و راهنما) را می‌سازد و به شکل یک <b>فایل ZIP آماده برای دانلود</b> تحویل می‌دهد!`
        : `🏗️ <b>Text-to-Full-App Generator</b>\n\nDescribe the application you want, and I will generate the complete project as a downloadable ZIP file!`,
      kb([[{ text: "◀️ " + (fa ? "بازگشت" : "Back"), cb: "m:home" }]]),
      !!h.cbId,
    );
  }

  async build(h: H, query: string) {
    const fa = h.loc === "fa";
    await h.loading(fa ? "🏗️ در حال معماری ساختار فایل‌ها و تولید کد کامل…" : "Generating project files and zip…");

    const prompt =
      `You are an expert full-stack developer. The user wants to build the following complete standalone application:\n` +
      `"${query}"\n\n` +
      `Generate the essential files for this application in JSON format as an array of objects:\n` +
      `[\n` +
      `  {"path": "main.py", "content": "..."},\n` +
      `  {"path": "requirements.txt", "content": "..."},\n` +
      `  {"path": "README.md", "content": "..."},\n` +
      `  {"path": ".env.example", "content": "..."}\n` +
      `]\n` +
      `Ensure the code is complete, modern, working, and has no placeholders. Return ONLY valid JSON array with no markdown fence.`;

    const res = await h.ai.chat(prompt, {
      tier: "smart",
      max_tokens: 3000,
      temperature: 0.2,
      feature: "app_gen",
    });

    let files: { path: string; content: string }[] = [];
    try {
      const clean = (res ?? "").replace(/^```json/m, "").replace(/^```/m, "").trim();
      files = JSON.parse(clean);
    } catch {
      // fallback single file
      files = [
        { path: "app.py", content: res ?? "# Failed to format, here is output:\n" + (res ?? "") },
        { path: "README.md", content: `# Generated App\n\nPrompt: ${query}\n` },
      ];
    }

    // Build zip file manually with a simple zip encoder
    const zipBytes = createSimpleZip(files);
    const safeName = query.slice(0, 20).replace(/[^a-zA-Z0-9]/g, "_").toLowerCase() || "app";
    const filename = `${safeName}.zip`;

    await h.tg.sendDocument(
      h.chatId,
      filename,
      zipBytes,
      `🎉 <b>پروژهٔ شما آماده شد!</b>\n` +
      `📦 شامل ${files.length} فایل (${files.map((f) => f.path).join(", ")})\n` +
      `<i>فایل ZIP را اکسترکت کن و طبق README.md ران کن.</i>`
    );

    return h.toast(fa ? "✅ فایل زیپ ارسال شد" : "ZIP generated");
  }
}

/** Pure-JS uncompressed ZIP writer (Store method) to avoid external npm packages */
function createSimpleZip(files: { path: string; content: string }[]): Uint8Array {
  const enc = new TextEncoder();
  const fileRecords: { nameBytes: Uint8Array; dataBytes: Uint8Array; offset: number; crc: number }[] = [];
  const parts: Uint8Array[] = [];
  let currentOffset = 0;

  for (const f of files) {
    const nameBytes = enc.encode(f.path);
    const dataBytes = enc.encode(f.content);
    const crc = crc32(dataBytes);

    // Local file header (30 bytes + name length)
    const header = new Uint8Array(30 + nameBytes.length);
    const v = new DataView(header.buffer);
    v.setUint32(0, 0x04034b50, true); // signature
    v.setUint16(4, 20, true); // version needed
    v.setUint16(6, 0, true); // general purpose bit
    v.setUint16(8, 0, true); // compression (0 = store)
    v.setUint16(10, 0, true); // mod time
    v.setUint16(12, 0, true); // mod date
    v.setUint32(14, crc, true); // crc-32
    v.setUint32(18, dataBytes.length, true); // compressed size
    v.setUint32(22, dataBytes.length, true); // uncompressed size
    v.setUint16(26, nameBytes.length, true); // file name length
    v.setUint16(28, 0, true); // extra field length
    header.set(nameBytes, 30);

    parts.push(header, dataBytes);
    fileRecords.push({ nameBytes, dataBytes, offset: currentOffset, crc });
    currentOffset += header.length + dataBytes.length;
  }

  const centralDirStart = currentOffset;
  let centralDirSize = 0;

  for (const r of fileRecords) {
    // Central directory header (46 bytes + name length)
    const cd = new Uint8Array(46 + r.nameBytes.length);
    const v = new DataView(cd.buffer);
    v.setUint32(0, 0x02014b50, true); // signature
    v.setUint16(4, 20, true); // version made by
    v.setUint16(6, 20, true); // version needed
    v.setUint16(8, 0, true); // bit flag
    v.setUint16(10, 0, true); // compression
    v.setUint16(12, 0, true); // time
    v.setUint16(14, 0, true); // date
    v.setUint32(16, r.crc, true); // crc32
    v.setUint32(20, r.dataBytes.length, true); // compressed size
    v.setUint32(24, r.dataBytes.length, true); // uncompressed size
    v.setUint16(28, r.nameBytes.length, true); // name length
    v.setUint16(30, 0, true); // extra length
    v.setUint16(32, 0, true); // comment length
    v.setUint16(34, 0, true); // disk start
    v.setUint16(36, 0, true); // internal attrs
    v.setUint32(38, 0, true); // external attrs
    v.setUint32(42, r.offset, true); // local header offset
    cd.set(r.nameBytes, 46);

    parts.push(cd);
    centralDirSize += cd.length;
    currentOffset += cd.length;
  }

  // End of central directory record (22 bytes)
  const eocd = new Uint8Array(22);
  const ev = new DataView(eocd.buffer);
  ev.setUint32(0, 0x06054b50, true); // signature
  ev.setUint16(4, 0, true); // disk num
  ev.setUint16(6, 0, true); // cd disk num
  ev.setUint16(8, fileRecords.length, true); // disk entries
  ev.setUint16(10, fileRecords.length, true); // total entries
  ev.setUint32(12, centralDirSize, true); // cd size
  ev.setUint32(16, centralDirStart, true); // cd offset
  ev.setUint16(20, 0, true); // comment length
  parts.push(eocd);

  const totalLength = parts.reduce((acc, p) => acc + p.length, 0);
  const out = new Uint8Array(totalLength);
  let pos = 0;
  for (const p of parts) {
    out.set(p, pos);
    pos += p.length;
  }
  return out;
}

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) {
    c = (c >>> 8) ^ CRC_TABLE[(c ^ bytes[i]) & 0xff];
  }
  return (c ^ 0xffffffff) >>> 0;
}

const CRC_TABLE = new Uint32Array(256);
for (let i = 0; i < 256; i++) {
  let c = i;
  for (let j = 0; j < 8; j++) {
    c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  }
  CRC_TABLE[i] = c >>> 0;
}
