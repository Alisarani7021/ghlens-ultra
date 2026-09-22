/**
 * «آیا این یک پرسش است؟»
 *
 * JavaScript's `\b` is ASCII-only, so `\bچطور\b` never matched inside a Persian
 * sentence — the only Persian questions we recognised were the ones that ended
 * in «؟». Everything else («چطور این پروژه را نصب کنم») fell through to search.
 * Word boundaries are explicit here instead: a blank, punctuation, or a string
 * edge on both sides. «چهارچوب» is therefore not a question, «چه» alone is.
 */
const FA_Q = /(^|[\s،.:؛!?«»"'()\-])(چطور|چگونه|چرا|آیا|کدام|کدوم|چقدر|چند|چیه|چیست|چی|چه|کجا|کِی|کی|کدام‌یک)([\s،.:؛!?«»"'()\-]|$)/;
const EN_Q = /(^|[\s"'(`-])(how|why|what|which|who|when|where|is|are|can|could|should|does|do|explain|difference)([\s"'`)?.,:;!-]|$)/i;

/** True when a free-text query reads like a question rather than a search term. */
export function isQuestion(text: string): boolean {
  const t = (text ?? "").trim();
  if (!t) return false;
  if (/[?؟]\s*$/.test(t)) return true;
  if (FA_Q.test(t)) return true;
  return EN_Q.test(t);
}
