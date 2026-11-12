# Agent notes

## TypeScript

The app and server are TypeScript with `strict` on. Run `npm run typecheck` after a change and leave it with no errors. Avoid `any`, `@ts-ignore` and `@ts-expect-error`; use `import type` for imports that are only types.

## Changelog

`CHANGELOG.md` is shown to players in the changelog dialog (Settings > About), so write it for them: what changed for them, not about the code.

- Keep entries short: one line, one sentence, ideally under 15 words. Say what changed, not how it works: no step-by-step instructions, no list of every case, no reasons or comparisons with before. Name a shortcut key if there is one.
- Add an entry for changes a player would notice: new features, changed behaviour, visible fixes, noticeably better performance. Skip small visual tweaks, refactors, tooling and changes to these notes. Group several small fixes into one line ("Fixes for split screen and sharing"). Update the entry as a change evolves rather than adding a second one.
- Each `## ` section is one day, titled with the date, for example `## 30 September 2026`. Newest section first. Add entries to today's section, starting it above the others if it isn't there yet.
- Entries are `- ` bullets. The dialog renders `**bold**`, `` `code` `` and `[links](url)`, nothing else.

## UI components

- Every text field is a `TextField` (`src/components/TextField.tsx`), never a bare `<input className="text">`, so all fields share one size and look. Use its `bad` and `compact` props instead of adding size overrides in CSS. Range, file and the small number box in the new jigsaw form are not text fields.

## Database changes

The SQLite database in `data/` is live in production, so schema changes must never break an existing database.

- Every change to the database (new tables, columns, indexes, data fixes) goes in a new migration file in `server/migrations/`, named `NNN-short-description.sql` with the next number, for example `001-add-piece-locks.sql`.
- Migrations run automatically, in order, when the Vite server starts (`npm run dev` or `npm run start`), each exactly once. The applied version is tracked with `PRAGMA user_version` (see `migrate()` in `server/db.ts`).
- Do not edit the baseline `CREATE TABLE` statements in `server/db.ts`, and never edit or renumber a migration that has already shipped. Fix mistakes with a new migration.
- Write migrations so they work on a database that already holds data: give new `NOT NULL` columns a default, and backfill in the same migration when needed.
