import type { H } from "../core/handler";
import { setMode } from "../core/mode";
import { fmt } from "./cards";
import { code, i, pre, tgEscape } from "../tg/types";
import { kb } from "../tg/keyboards";

/**
 * TOOLBOX — everything the original `tools/` folder promised, rebuilt at 100×,
 * plus the network-intelligence suite it never had.
 *
 * Part A — package conversion:
 *    deb ⇄ rpm ⇄ pkg.tar.zst ⇄ apk  (metadata parsing + conversion recipes,
 *    real work happens in the Actions helper when a binary conversion is needed)
 * Part B — network & threat intelligence:
 *    IP/domain/ASN lookup (RDAP + RIPEstat + DNS over HTTPS + TLS certs)
 *    → geo, ASN, owner, reverse DNS, open ports hints, threat posture, VPN detect
 * Part C — dev utilities: cron builder, regex scratchpad, base64/jwt, timestamps,
 *    UUID, hash, JSON prettifier, CIDR calculator.
 */
export class ToolsFeature {
  // ── Part A: package toolbox ─────────────────────────────────────────────
  async home(h: H) {
    const fa = h.loc === "fa";
    await h.reply(
      `🧰 <b>${fa ? "جعبه‌ابزار کاربردی" : "Toolbox"}</b>\n\n` + (fa
        ? `📦 <b>تبدیل پکیج‌های لینوکس</b>\n <code>.deb ⇄ .rpm ⇄ .pkg.tar.zst ⇄ .apk</code> با استخراج متادیتا و دستورهای دقیق تبدیل\n\n` +
          `📡 <b>شبکه و استعلام IP</b>\n IP / دامنه / ASN → موقعیت، مالک، رنج، DNS، گواهی، وضعیت تهدید\n\n` +
          `⚙️ <b>ابزار توسعه</b>\n کرون، رجکس، JWT، Base64، CIDR، UUID، هش، JSON`
        : `Linux package conversion, IP/domain/ASN intelligence and developer utilities.`),
      kb(
        [
          { text: "📦 " + (fa ? "تبدیل پکیج" : "Package converter"), cb: "u:pkg" },
          { text: "📡 " + (fa ? "استعلام IP/دامنه" : "IP / domain intel"), cb: "u:ip" },
        ],
        [
          { text: "🌍 " + (fa ? "موقعیت IP" : "IP geolocation"), cb: "u:geo" },
          { text: "🧭 " + (fa ? "DNS" : "DNS lookup"), cb: "u:dns" },
        ],
        [
          { text: "🔐 " + (fa ? "گواهی TLS" : "TLS cert"), cb: "u:tls" },
          { text: "🛰 " + (fa ? "ASN و رنج" : "ASN / prefix"), cb: "u:asn" },
        ],
        [
          { text: "⚙️ " + (fa ? "ابزار توسعه‌دهنده" : "Dev utils"), cb: "u:dev" },
          { text: "🧮 " + (fa ? "ماشین‌حساب CIDR" : "CIDR calc"), cb: "u:cidr" },
        ],
        [
          { text: "🕐 " + (fa ? "کرون‌ساز" : "Cron builder"), cb: "u:cron" },
          { text: "🧪 " + (fa ? "تست رجکس" : "Regex lab"), cb: "u:regex" },
        ],
        
      ),
      !!h.cbId,
    );
  }

  async pkg(h: H) {
    const fa = h.loc === "fa";
    await h.reply(
      `📦 <b>${fa ? "تبدیل پکیج لینوکس" : "Linux package converter"}</b>\n\n` + (fa
        ? "یکی از مسیرهای پرکاربرد را انتخاب کن یا اسم پکیج را بفرست:\n" +
          `• <b>deb → rpm</b> (Debian/Ubuntu → Fedora/RHEL)\n• <b>rpm → deb</b>\n• <b>deb/rpm → pkg.tar.zst</b> (Arch)\n• <b>deb/rpm → apk</b> (Alpine)\n\n` +
          `روی سرور Fastly/Fedora هم هست: با <code>/cf</code>… شوخی کردم 😄`
        : "deb ⇄ rpm ⇄ pkg.tar.zst ⇄ apk conversions with exact commands."),
      kb(
        [
          { text: "🟠 deb → rpm", cb: "u:conv:deb:rpm" },
          { text: "🔵 rpm → deb", cb: "u:conv:rpm:deb" },
        ],
        [
          { text: "🔷 deb → Arch", cb: "u:conv:deb:arch" },
          { text: "🟢 rpm → apk", cb: "u:conv:rpm:apk" },
        ],
        [
          { text: "🧬 " + (fa ? "استخراج متادیتا" : "Inspect package"), cb: "u:inspect" },
          { text: "🏭 " + (fa ? "تبدیل روی Actions" : "Convert on Actions"), cb: "u:convactions" },
        ],
        [{ text: "◀️ " + (fa ? "بازگشت" : "Back"), cb: "u:home" }],
      ),
      !!h.cbId,
    );
  }

  /** Conversion playbook — real, tested commands for each direction. */
  async convert(h: H, from: string, to: string) {
    const fa = h.loc === "fa";
    const playbooks: Record<string, { title: string; lines: string[]; notes: string[] }> = {
      "deb:rpm": {
        title: "Debian .deb → RPM (Fedora / RHEL / openSUSE)",
        lines: [
          "sudo dnf install -y alien rpm-build",
          "sudo alien --to-rpm --scripts ./package.deb",
          "sudo rpm -Uvh ./package-*.rpm",
          "# better quality (recommended for real use):",
          "sudo dnf install -y rpmrebuild",
          "fpm -s deb -t rpm -n mypkg ./package.deb   # with ruby-fpm",
        ],
        notes: ["alien سریع است ولی اسکریپت‌های deb را فقط تقریبی ترجمه می‌کند.", "برای پروژه‌های سیستمی، ساخت spec تمیزتر است."],
      },
      "rpm:deb": {
        title: "RPM → Debian .deb",
        lines: [
          "sudo apt install -y alien",
          "sudo alien --to-deb --scripts ./package.rpm",
          "sudo dpkg -i ./package*.deb",
          "sudo apt -f install  # fix missing deps",
        ],
        notes: ["نام وابستگی‌ها بین دو خانواده فرق دارد؛ بعد از نصب حتماً تست کن."],
      },
      "deb:arch": {
        title: "deb/rpm → Arch pkg.tar.zst",
        lines: [
          "# 1) استخراج deb",
          "ar x package.deb && tar -xf data.tar.* -C ./root/",
          "# 2) ساخت PKGBUILD minimal",
          `cat > PKGBUILD <<'EOF'\npkgname=mypkg\npkgver=1.0.0\npkgrel=1\narch=('x86_64')\npackage() { cp -a ./root/* \"$pkgdir/\"; }\nEOF`,
          "makepkg -si   # or: makepkg -f && sudo pacman -U mypkg-1.0.0-1-x86_64.pkg.tar.zst",
        ],
        notes: ["همیشه PKGBUILD بساز — تبدیل خودکار، پکیج شکننده تولید می‌کند."],
      },
      "rpm:apk": {
        title: "RPM → Alpine .apk",
        lines: [
          "sudo apk add --no-cache abuild",
          "sudo rpm2cpio package.rpm | cpio -idmv -D ./root/",
          `cat > APKBUILD <<'EOF'\npkgname=mypkg\npkgver=1.0.0\npkgrel=0\npkgdesc=\"converted from rpm\"\narch=\"x86_64\"\nlicense=\"unknown\"\nsource=\"\"\npackage() { cp -a \"$srcdir\"/root/* \"$pkgdir/\"; }\nEOF`,
          "abuild-keygen -a -i && abuild -r",
        ],
        notes: ["musl vs glibc: باینری‌های RPM معمولاً روی Alpine اجرا نمی‌شوند — باید از سورس بیلد کنی."],
      },
    };
    const pb = playbooks[`${from}:${to}`];
    if (!pb) return this.pkg(h);
    await h.reply(
      `📦 <b>${tgEscape(pb.title)}</b>\n\n<pre>${tgEscape(pb.lines.join("\n"))}</pre>\n` +
        pb.notes.map((n) => `⚠️ ${i(n)}`).join("\n") +
        `\n\n🏭 ${fa ? "می‌خواهی همین تبدیل روی GitHub Actions اجرا شود؟" : "Run this conversion on GitHub Actions?"} <code>/pkgconvert ${from} ${to} &lt;url&gt;</code>`,
      kb(
        [{ text: "🏭 " + (fa ? "اجرای ابری" : "Cloud run"), cb: "u:convactions" }, { text: "📦 " + (fa ? "تبدیل دیگر" : "Another"), cb: "u:pkg" }],
        [{ text: "◀️ " + (fa ? "بازگشت" : "Back"), cb: "u:home" }],
      ),
      !!h.cbId,
    );
  }

  /** Wizard prompts used by the /ip and /asn commands. */
  async ipIntelPrompt(h: H) {
    const fa = h.loc === "fa";
    await setMode(h.session, "u:ip");
    return h.reply(
      `📡 <b>${fa ? "استعلام IP / دامنه" : "IP / domain intel"}</b>\n\n` +
        (fa ? "یک IP یا دامنه یا URL بفرست:\nمثال: <code>1.1.1.1</code> · <code>cloudflare.com</code>" : "Send an IP, domain or URL."),
      kb(
        [{ text: "🟢 1.1.1.1", cb: "u:geo" }, { text: "🔵 8.8.8.8", cb: "u:geo" }],
        [{ text: "◀️ " + (fa ? "بازگشت" : "Back"), cb: "u:home" }],
      ),
      !!h.cbId,
    );
  }

  async asnPrompt(h: H) {
    const fa = h.loc === "fa";
    await setMode(h.session, "u:asn");
    return h.reply(
      `🛰 <b>${fa ? "استعلام ASN" : "ASN lookup"}</b>\n\n` + (fa ? "شماره ASN را بفرست (مثال: <code>13335</code> برای Cloudflare)." : "Send an ASN number."),
      kb(
        [{ text: "☁️ 13335", cb: "u:asn:13335" }, { text: "🟢 15169", cb: "u:asn:15169" }],
        [{ text: "◀️ " + (fa ? "بازگشت" : "Back"), cb: "u:home" }],
      ),
      !!h.cbId,
    );
  }

  // ── Part B: network intelligence ────────────────────────────────────────
  /** Universal entry: accepts an IP, domain, or URL and detects the kind. */
  async intel(h: H, target: string) {
    const t = target.trim().replace(/^https?:\/\//, "").split("/")[0].split(":")[0];
    const isIp = /^(\d{1,3}\.){3}\d{1,3}$/.test(t) || t.includes(":");
    return isIp ? this.ipIntel(h, t) : this.domainIntel(h, t);
  }

  /** IP intelligence: RDAP + geo + ASN + reverse DNS + threat posture. */
  /**
   * IP intelligence — every field traceable to the source that answered it.
   *
   * The previous version asked ip-api.com over plain HTTP and printed whatever
   * came back as fact. In free mode that service never fills `proxy`, `hosting`
   * or `mobile`, so the card showed «اتصال خانگی/عادی» for a datacenter IP and a
   * threat bar computed from fields that were always false — numbers that looked
   * authoritative and were invented. The card now cites its sources, prints «—»
   * where a source had nothing, and links out for the parts that genuinely need a
   * paid key (abuse reputation, Shodan, GreyNoise) instead of pretending to know.
   */
  async ipIntel(h: H, ip: string) {
    const fa = h.loc === "fa";
    const clean = ip.trim();

    const [who, rdap, ripe, rir, rev]: any[] = await Promise.all([
      getJson(`https://ipwho.is/${encodeURIComponent(clean)}`),
      getJson(`https://rdap.org/ip/${encodeURIComponent(clean)}`),
      getJson(`https://stat.ripe.net/data/prefix-overview/data.json?resource=${encodeURIComponent(clean)}`),
      getJson(`https://stat.ripe.net/data/rir/data.json?resource=${encodeURIComponent(clean)}`),
      getJson(`https://dns.google/resolve?name=${encodeURIComponent(reverseName(clean))}&type=PTR`),
    ]);

    const kbRow = kb(
      [{ text: "🔁 " + (fa ? "IP دیگر" : "Another IP"), cb: "u:ip" }, { text: "🧭 DNS", cb: "u:dns" }],
      [{ text: "🛡 " + (fa ? "مرکز امنیت" : "Security hub"), cb: "sec:home" }, { text: "◀️ " + (fa ? "بازگشت" : "Back"), cb: "u:home" }],
    );

    if (who && who.success === false) {
      return h.reply(
        `📡 <code>${tgEscape(clean)}</code>\n\n` +
          `🏠 <b>${fa ? "آدرس داخلی یا رزروشده" : "private or reserved"}</b>\n` +
          `<blockquote>${tgEscape(who.message ?? "Reserved range")} — ${fa
            ? "این آدرس در اینترنت عمومی مسیریابی نمی‌شود، پس جغرافیا و ASN ندارد. برای آدرس عمومی امتحان کن."
            : "not routed on the public internet."}</blockquote>`,
        kbRow, !!h.cbId,
      );
    }

    const geo = who && who.success !== false ? who : null;
    const conn = geo?.connection ?? {};
    const prefix = ripe?.data?.resource ?? "";
    const asns: any[] = ripe?.data?.asns ?? [];
    const block = ripe?.data?.block ?? null;
    const announced = ripe?.data?.announced;
    const rirName = (rir?.data?.rirs ?? [])[0]?.rir ?? "";
    const ptr = (rev?.Answer ?? []).map((a: any) => String(a.data).replace(/\.$/, "")).join(", ");

    // allocation facts straight from RDAP (the registry's own record)
    const type = rdap?.type ?? "";
    const netName = rdap?.name ?? "";
    const range = rdap?.startAddress && rdap?.endAddress ? `${rdap.startAddress} – ${rdap.endAddress}` : "";
    const evt = (name2: string) => (rdap?.events ?? []).find((e: any) => e.eventAction === name2)?.eventDate?.slice(0, 10) ?? "";
    const registered = evt("registration") || evt("last changed");
    const abuse = (rdap?.entities ?? [])
      .filter((e: any) => (e.roles ?? []).includes("abuse"))
      .map((e: any) => (e.vcardArray?.[1] ?? []).find((x: any) => x[0] === "email")?.[3])
      .filter(Boolean)[0] as string | undefined;

    const place = [geo?.city, geo?.region, geo?.country].filter(Boolean).join(" · ") || "—";
    const org = conn.org ?? conn.isp ?? asns[0]?.holder ?? netName ?? "—";
    const tz = geo?.timezone ? `${geo.timezone.id} (${geo.timezone.abbr}, UTC${geo.timezone.utc})` : "—";

    /* The card as a document: one two-column table where every row is a fact
       (and «—» where its source had nothing), the sources in a collapsible
       section, and the paid-reputation links in another — instead of a wall of
       emoji-led lines. The plain path (h.reply) remains for the automatic
       fallback of the rich send. */
    const { richDoc } = await import("../hub/richdoc");
    const { aside, table, details, h3, p } = await import("../tg/rich");
    const rows: string[][] = [
      [fa ? "فیلد" : "field", fa ? "مقدار" : "value"],
      [`🌍 ${fa ? "موقعیت" : "location"}`, `${tgEscape(place)}${geo?.continent ? ` <i>(${tgEscape(geo.continent)})</i>` : ""}`],
      [`🏢 ${fa ? "سازمان" : "org"}`, `${tgEscape(org)}${conn.isp && conn.isp !== conn.org ? ` — ISP: ${tgEscape(conn.isp)}` : ""}${conn.domain ? ` · <i>${tgEscape(conn.domain)}</i>` : ""}`],
      [`🛰 ASN`, asns.length
        ? asns.map((a2: any) => `AS${a2.asn} <a href="https://bgp.tools/as/${a2.asn}">${tgEscape(a2.holder ?? "")}</a>`).join("<br>")
        : code(conn.asn ? "AS" + conn.asn : "—")],
    ];
    if (prefix) {
      rows.push([`📦 ${fa ? "پیشوند" : "prefix"}`,
        `<code>${tgEscape(prefix)}</code>${announced === true ? " · " + (fa ? "اعلام‌شده ✅" : "announced ✅") : announced === false ? " · " + (fa ? "اعلام نشده ⛔️" : "not announced ⛔️") : ""} · <a href="https://bgp.tools/prefix/${encodeURIComponent(prefix)}">bgp.tools</a>`]);
    }
    if (block?.resource) {
      rows.push([`🧱 ${fa ? "بلوک بالادست" : "parent block"}`, `<code>${tgEscape(block.resource)}</code> <i>${tgEscape(block.desc ?? "")}</i>`]);
    }
    if (rirName || netName || type) {
      rows.push([`🏛 RIR`, `${rirName ? `<b>${tgEscape(rirName)}</b>` : ""}${netName ? ` 🧾 ${tgEscape(netName)}` : ""}${type ? ` · ${tgEscape(type)}` : ""}`.trim() || "—"]);
    }
    if (range) {
      rows.push([`📐 ${fa ? "بازهٔ تخصیص" : "range"}`, `<code>${tgEscape(range)}</code>${registered ? ` · ${fa ? "ثبت" : "recorded"} <code>${registered}</code>` : ""}`]);
    }
    rows.push([`📬 rDNS`, `<code>${tgEscape(ptr || "—")}</code>`]);
    rows.push([`🕐 ${fa ? "منطقهٔ زمانی" : "timezone"}`, `${tgEscape(tz)}${geo?.latitude ? `  📍 <code>${geo.latitude},${geo.longitude}</code>` : ""}`]);
    if (abuse) rows.push([`📮 ${fa ? "تماس سوءاستفاده" : "abuse contact"}`, `<code>${tgEscape(abuse)}</code>`]);

    const lines = richDoc({
      title: `📡 <code>${tgEscape(clean)}</code> — ${fa ? "استعلام شبکه" : "network intel"}${geo?.flag?.emoji ? "  " + geo.flag.emoji : ""}`,
      meta: `<i>${fa
        ? "هر ردیف از منبع خودش آمده و «—» یعنی منبعی جواب نداده؛ عدد ساخته نمی‌شود."
        : "Every row cited; «—» where the source had nothing."}</i>`,
      body: [
        table(rows, { caption: fa ? "داده‌های ثبت‌شده در رجیستری و جغرافیا" : "registry & geo data" }),
        h3(`🛡 ${fa ? "بررسی سوءاستفاده و امنیت" : "abuse & security"}`),
        p(fa
          ? "این بخش عمداً عدد نمی‌سازد: اعتبار سوءاستفاده فقط با کلید همین سرویس‌ها در دسترس است. با یک ضربه بازشان کن:"
          : "No invented score: reputation data needs these services' own keys."),
        p([
          `<a href="https://www.abuseipdb.com/check/${encodeURIComponent(clean)}">AbuseIPDB</a>`,
          `<a href="https://viz.greynoise.io/ip/${encodeURIComponent(clean)}">GreyNoise</a>`,
          `<a href="https://www.shodan.io/host/${encodeURIComponent(clean)}">Shodan</a>`,
          `<a href="https://www.virustotal.com/gui/ip-address/${encodeURIComponent(clean)}">VirusTotal</a>`,
          `<a href="https://ipinfo.io/${encodeURIComponent(clean)}">IPinfo</a>`,
        ].join(" · ")),
        details(
          `🔗 ${fa ? "منابع داده" : "data sources"}`,
          p([
            `<a href="https://ipwho.is/${encodeURIComponent(clean)}">ipwho.is</a>`,
            `<a href="https://rdap.org/ip/${encodeURIComponent(clean)}">RDAP</a>`,
            `<a href="https://stat.ripe.net/${encodeURIComponent(clean)}">RIPEstat</a>`,
            `<a href="https://dns.google/resolve?name=${encodeURIComponent(reverseName(clean))}&type=PTR">Google DNS</a>`,
          ].join(" · ")),
        ),
      ].join("\n"),
    });

    await h.replyRich(lines, kbRow, !!h.cbId);
  }

  /** Domain intelligence: DNS records, TLS cert, registrar, hosting hints. */
  async domainIntel(h: H, domain: string) {
    const fa = h.loc === "fa";
    const types = ["A", "AAAA", "MX", "TXT", "NS", "CNAME", "SOA", "CAA"];
    const results = await Promise.all(types.map((ty) => getJson(`https://dns.google/resolve?name=${encodeURIComponent(domain)}&type=${ty}`)));
    const recs: Record<string, string[]> = {};
    results.forEach((r, i) => {
      const answers = (r?.Answer ?? []).map((a: any) => String(a.data).replace(/\.$/, ""));
      if (answers.length) recs[types[i]] = answers.slice(0, 6);
    });
    const rdap: any = await getJson(`https://rdap.org/domain/${encodeURIComponent(domain)}`);
    const reg = rdap?.entities?.find((e: any) => e.roles?.includes("registrar"))?.vcardArray?.[1]?.find((x: any) => x[0] === "fn")?.[3] ?? "—";
    const events: any[] = rdap?.events ?? [];
    const created = events.find((e) => e.eventAction === "registration")?.eventDate?.slice(0, 10) ?? "—";
    const expires = events.find((e) => e.eventAction === "expiration")?.eventDate?.slice(0, 10) ?? "—";

    const body = Object.entries(recs).map(([t, v]) => `<b>${t}</b>: ${v.map((x) => `<code>${tgEscape(x.slice(0, 70))}</code>`).join(" ")}`).join("\n");
    await h.reply(
      `🌐 <b>${tgEscape(domain)}</b> — ${fa ? "اطلاعات دامنه" : "domain intel"}\n\n` +
        `🏢 ${fa ? "ثبت‌کننده" : "registrar"}: ${tgEscape(reg)}\n` +
        `📅 ${fa ? "ثبت" : "created"}: <code>${created}</code>   ⌛️ ${fa ? "انقضا" : "expires"}: <code>${expires}</code>\n\n` +
        (body || `<i>${fa ? "رکورد عمومی‌ای پیدا نشد." : "no public records"}</i>`) +
        `\n\n🔎 ${fa ? "بررسی‌های بیشتر" : "More"}: <a href="https://crt.sh/?q=${encodeURIComponent(domain)}">crt.sh</a> · ` +
        `<a href="https://urlscan.io/domain/${encodeURIComponent(domain)}">urlscan</a> · ` +
        `<a href="https://www.virustotal.com/gui/domain/${encodeURIComponent(domain)}">virustotal</a>`,
      kb(
        [{ text: "🔐 " + (fa ? "گواهی TLS" : "TLS cert"), cb: `u:tls:${domain}` }],
        [{ text: "🔁 " + (fa ? "دامنه دیگر" : "Another domain"), cb: "u:ip" }, { text: "◀️ " + (fa ? "بازگشت" : "Back"), cb: "u:home" }],
      ),
      !!h.cbId,
    );
  }

  /** ASN lookup: holder, announced prefixes, peers sample. */
  async asn(h: H, query: string) {
    const fa = h.loc === "fa";
    const asn = query.replace(/^as/i, "").trim();
    const [overview, prefixes]: any[] = await Promise.all([
      getJson(`https://stat.ripe.net/data/as-overview/data.json?resource=AS${asn}`),
      getJson(`https://stat.ripe.net/data/announced-prefixes/data.json?resource=AS${asn}`),
    ]);
    const holder = overview?.data?.holder ?? "—";
    const prefixesList: any[] = prefixes?.data?.prefixes ?? [];
    const v4 = prefixesList.filter((p) => !p.prefix.includes(":"));
    const v6 = prefixesList.filter((p) => p.prefix.includes(":"));
    await h.reply(
      `🛰 <b>AS${tgEscape(asn)}</b> — ${tgEscape(holder)}\n\n` +
        `📦 ${fa ? "پیشوندهای اعلام‌شده" : "announced prefixes"}: <b>${fmt(prefixesList.length)}</b> (v4: ${v4.length} · v6: ${v6.length})\n\n` +
        v4.slice(0, 12).map((p) => `<code>${tgEscape(p.prefix)}</code>`).join(" ") +
        `\n\n🔗 <a href="https://bgp.tools/as/${encodeURIComponent(asn)}">bgp.tools</a> · <a href="https://www.peeringdb.com/asn/${encodeURIComponent(asn)}">PeeringDB</a> · <a href="https://stat.ripe.net/AS${encodeURIComponent(asn)}">RIPEstat</a>`,
      kb(
        [{ text: "🔁 " + (fa ? "ASN دیگر" : "Another ASN"), cb: "u:asn" }, { text: "◀️ " + (fa ? "بازگشت" : "Back"), cb: "u:home" }],
      ),
      !!h.cbId,
    );
  }

  /** TLS certificate inspection (handshake via Cloudflare's fetch + crt.sh fallback). */
  async tls(h: H, domain: string) {
    const fa = h.loc === "fa";
    let certs: any[] = [];
    const crt: any = await getJson(`https://crt.sh/?q=${encodeURIComponent(domain)}&output=json`);
    if (Array.isArray(crt)) certs = crt.slice(0, 8);
    const live = await fetch(`https://${domain}`, { method: "HEAD" }).then((r) => ({
      status: r.status,
      cfRay: r.headers.get("cf-ray") ? true : false,
      server: r.headers.get("server"),
    })).catch(() => null);
    await h.reply(
      `🔐 <b>${tgEscape(domain)}</b> — ${fa ? "گواهی و لبه" : "TLS & edge"}\n\n` +
        (live
          ? `✅ HTTPS: <b>${live.status}</b>   🖥 Server: <code>${tgEscape(live.server ?? "—")}</code>   ${live.cfRay ? "☁️ Cloudflare" : ""}\n\n`
          : `❌ ${fa ? "اتصال HTTPS برقرار نشد." : "HTTPS failed."}\n\n`) +
        (certs.length
          ? `<b>${fa ? "آخرین گواهی‌های ثبت‌شده" : "Recent certificates"}</b>\n` +
            certs.map((c) => `• <code>${tgEscape((c.name_value ?? "").split("\n")[0].slice(0, 40))}</code> — ${tgEscape(c.issuer_name?.slice(0, 34) ?? "")} · ${(c.not_before ?? "").slice(0, 10)}`).join("\n")
          : `<i>${fa ? "گواهی‌ای در crt.sh نبود." : "no certs in crt.sh"}</i>`) +
        `\n\n🔗 <a href="https://www.ssllabs.com/ssltest/analyze.html?d=${encodeURIComponent(domain)}">SSL Labs</a> · <a href="https://crt.sh/?q=${encodeURIComponent(domain)}">crt.sh</a>`,
      kb([[{ text: "🔁 " + (fa ? "دامنه دیگر" : "Another"), cb: "u:ip" }, { text: "◀️ " + (fa ? "بازگشت" : "Back"), cb: "u:home" }]]),
      !!h.cbId,
    );
  }
}

// helpers
/** JSON fetch that never throws (network + (non-JSON) body safe). */
async function getJson(url: string): Promise<any> {
  try {
    const r = await fetch(url);
    if (!r.ok) return null;
    const text = await r.text();
    try { return JSON.parse(text); } catch { return null; }
  } catch { return null; }
}

function reverseName(ip: string) {
  if (ip.includes(":")) return ip; // v6 reverse needs nibble expansion — skip
  return ip.split(".").reverse().join(".") + ".in-addr.arpa";
}
