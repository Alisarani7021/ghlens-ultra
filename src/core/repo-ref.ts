/**
 * «این ورودی چه مخزنی است؟»
 *
 * People paste whatever the GitHub app gave them: a full URL, a URL that still
 * has /tree/main or /blob/main/README.md on the end, an ssh clone URL, a bare
 * owner/repo, sometimes with .git, sometimes with a trailing slash or a ?tab=
 * query. Typing «owner/repo» was the only form the bot accepted, so a pasted
 * link ended in «❌ README پیدا نشد» — the owner hit exactly that.
 *
 * Everything ends in the same canonical `owner/repo`, or null when the text is
 * not a repository at all (so the caller can search for it instead).
 */
const PART = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,38})$/;
const GITHUB_FILES = /^(tree|blob|issues|pulls?|releases?|actions|wiki|discussions|commits?|branches|tags|graphs|network|security|settings|archive|compare|projects|packages|deployments|codespaces|sponsors|stargazers|watchers|forks)$/i;

export function parseRepoRef(raw: string): string | null {
  let t = String(raw ?? "").trim().replace(/^[<«"']+|[>»"']+$/g, "");
  if (!t || /\s{2,}/.test(t)) return null;
  t = t
    .replace(/^git@github\.com:/i, "")
    .replace(/^ssh:\/\/git@github\.com\//i, "")
    .replace(/^(https?:\/\/)?(www\.)?github\.com\//i, "");
  t = t.split(/[?#]/)[0]!.replace(/\/+$/, "");
  const seg = t.split("/").filter(Boolean);
  if (seg.length < 2) return null;
  if (seg.length > 2 && GITHUB_FILES.test(seg[2]!)) seg.length = 2;
  if (seg.length !== 2) return null;
  const owner = seg[0]!;
  const repo = seg[1]!.replace(/\.git$/i, "");
  if (!PART.test(owner) || !PART.test(repo)) return null;
  if (GITHUB_FILES.test(owner)) return null;
  return `${owner}/${repo}`;
}
