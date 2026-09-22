#!/usr/bin/env node
/**
 * Smoke-test every slash command through /selfcheck and report what a user
 * would actually see: an answer, a loader that never resolved, or an error.
 *
 *   source ./.secrets.local.sh && node scripts/audit-commands.mjs
 */
import { readFileSync, writeFileSync } from 'node:fs';

const URL_BASE = process.env.URL_BASE ?? 'https://ghlens-ultra.gitguts.workers.dev';
const SECRET = process.env.TELEGRAM_WEBHOOK_SECRET ?? process.env.TG_HOOK_SECRET;
const UID = process.env.UID_BOT ?? '999999';
if (!SECRET) { console.error('set TG_HOOK_SECRET'); process.exit(1); }
const arg = (n) => { const i = process.argv.indexOf(n); return i >= 0 ? process.argv[i + 1] : undefined; };

const src = readFileSync('src/index.ts', 'utf8');
const cmds = [...new Set([...src.matchAll(/case "(\/[a-z-]+)"/g)].map((m) => m[1]))].sort();

const LOADING_ONLY = /^\s*[^\p{L}\p{N}]{0,3}\s*(در حال|دارم|چند لحظه|Searching|Loading|Analyzing)/u;
// system failures only: an error line, not a repo/issue title that happens to
// contain the word "Error:"
const BAD = [/^❌/m, /^\s*(?:⚠️|⛔)?\s*Error[:\s]/m, /\bNaN\b/, /\bundefined\b/, /[а-яА-Я]/, /[ăâêôơưđ]/];

const rows = [];
for (const cmd of cmds) {
  const url = `${URL_BASE}/selfcheck?deep=${SECRET}&uid=${UID}&text=${encodeURIComponent(cmd)}`;
  let row;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(150000) });
    const d = await res.json();
    const replies = (d.replies ?? []).map((r) => ({ m: r.m, text: (r.text ?? r.cb_text ?? '').trim(), kb: r.kb ?? 0, buttons: r.buttons ?? [], doc: r.doc }));
    const body = replies.map((r) => r.text).join('\n');
    const visible = replies.filter((r) => r.text || r.kb || r.doc);
    const last = visible[visible.length - 1];
    const loader = !!last && LOADING_ONLY.test(String(last.text ?? '').replace(/<[^>]+>/g, ''));
    const bad = BAD.filter((p) => p.test(body)).map(String);
    // standing rule from the owner: every screen with buttons also offers a way
    // back to the menu
    const NEEDS_HOME = /^🤖|^🧠|^⚙️|^🚀/;
    const HOMEY = /منو|بازگشت|◀|✖|خانه|Menu|Back/i;
    // /start *is* the main menu, so it needs no way back to itself
    const screensWithButtons = cmd === '/start' ? [] : replies.filter((r) => (r.kb ?? 0) > 0);
    const missingHome = screensWithButtons.filter(
      (r) => !(r.buttons ?? []).some((b) => HOMEY.test(String(b))),
    ).length;
    const status = !d.ok ? 'error' : bad.length ? 'bad-text' : loader ? 'stuck' : missingHome ? 'noback' : visible.length ? 'ok' : 'empty';
    row = { cmd, ms: d.ms, status, bad, missingHome, first: (visible[0]?.text ?? '').replace(/\s+/g, ' ').slice(0, 120), replies: replies.length };
  } catch (e) {
    row = { cmd, status: 'threw', first: String(e.message) };
  }
  rows.push(row);
  const icon = row.status === 'ok' ? '✅' : row.status === 'stuck' ? '⏳' : row.status === 'empty' ? '⚪' : row.status === 'noback' ? '↩️' : '❌';
  console.log(`${icon} ${cmd.padEnd(16)} ${String(row.ms ?? '').padStart(7)}ms  ${row.first ?? ''}`);
}

const count = (s) => rows.filter((r) => r.status === s).length;
console.log(`\n${count('ok')} ok · ${count('noback')} without a back path · ${count('stuck')} stuck · ${count('empty')} empty · ${count('bad-text') + count('error') + count('threw')} failing  (of ${rows.length})`);
const out = arg('--json');
if (out) { writeFileSync(out, JSON.stringify(rows, null, 1)); console.log('report →', out); }
