import pathlib, sys

def edit(path, old, new, n=1):
    p = pathlib.Path(path); s = p.read_text()
    if old not in s:
        print(f"!! anchor missed in {path}: {old[:70]!r}"); sys.exit(1)
    p.write_text(s.replace(old, new, n)); print(f"ok {path}  «{old.strip().splitlines()[0][:52]}…»")

# ── ① the highlights line carried the changelog's own bullet ──────────────
# `- • fixed …` kept one marker after the strip, so every highlight rendered as
# «• • …» in the post the owner reads in the channel.
edit("src/hub/editor.ts",
'''    if (!/^(?:[-*•]|\\d+[.)])\\s+/.test(line)) continue;
    let item = line.replace(/^(?:[-*•]|\\d+[.)])\\s+/, "");''',
'''    if (!/^(?:[-*•]|\\d+[.)])\\s+/.test(line)) continue;
    // strip *every* leading marker: a changelog writes «- • text» often enough
    // that one pass leaves a bullet behind and the post reads «• • text»
    let item = line;
    while (/^(?:[-*•]|\\d+[.)])\\s+/.test(item)) item = item.replace(/^(?:[-*•]|\\d+[.)])\\s+/, "");''')

# ── ③ a placeholder name must never overwrite a person's name ─────────────
edit("src/core/db.ts",
'''      `INSERT INTO users (id, username, first_name, locale, referral_code, created_at, last_seen_at)''',
'''      /* `?`, `-` and `Self` are not names, they are what a handler that was not
         given a real one writes. The deferred-work path builds a synthetic
         update (`first_name: "?"`) to run a queued feature, so every queued
         button was renaming its user to «?» — which then showed up on the
         public leaderboard as `🥇 ?`. Placeholders neither overwrite a real
         name (first branch) nor get stored as one (second branch). */
      `INSERT INTO users (id, username, first_name, locale, referral_code, created_at, last_seen_at)''')

edit("src/core/db.ts",
'''       ON CONFLICT(id) DO UPDATE SET username=excluded.username, first_name=excluded.first_name,''',
'''       ON CONFLICT(id) DO UPDATE SET username=excluded.username,
         first_name=CASE
           WHEN COALESCE(excluded.first_name,'') IN ('', '?', '-', 'Self') THEN users.first_name
           ELSE excluded.first_name
         END,''')

# the queue's synthetic update stops pretending to be a name
edit("src/core/queue.ts",
'''            { from: { id: job.user_id, is_bot: false, first_name: "?" } as any, chat: { id: job.chat_id } as any, message_id: job.message_id },''',
'''            // no invented name: the stored one belongs to the person who pressed
            // the button, and a queued job has no business rewriting it
            { from: { id: job.user_id, is_bot: false } as any, chat: { id: job.chat_id } as any, message_id: job.message_id },''')

# and the board never shows a bare placeholder
edit("src/features/profile.ts",
'''          const name = r.first_name ?? r.username ?? `#${r.user_id}`;''',
'''          /* A row with no name is a real person the bot has not been introduced
             to yet (the update that carried their name was a callback, not a
             message). Show that honestly instead of a «?». */
          const clean = String(r.first_name ?? "").trim();
          const name = clean && !["?", "-", "Self"].includes(clean)
            ? clean
            : r.username ? `@${r.username}` : `#…${String(r.user_id).slice(-4)}`;''')

# ── fan-out branches shared the parent's run id ───────────────────────────
edit("src/hub/engine.ts",
'''      for (const extra of nextList.slice(1)) {
        const sub = await runWorkflow(ctx, { ...wf, dag: { entry: extra, nodes: wf.dag.nodes } }, bag, id);''',
'''      for (const extra of nextList.slice(1)) {
        /* Its own row. Reusing the parent's id made the second insert fail
           (`UNIQUE constraint failed: hub_runs.id`) and then *overwrite* the
           parent's steps, so the run log of a fan-out workflow described only
           the last branch. */
        const sub = await runWorkflow(ctx, { ...wf, dag: { entry: extra, nodes: wf.dag.nodes } }, bag, `${id}~${extra}`);''')

print("four defects fixed")
