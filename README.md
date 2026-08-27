# claude-session-keeper

Backs up Claude Code session transcripts before Claude Code's own cleanup
deletes them, and gives you a small local dashboard to browse, restore,
rename, and pick back up old sessions.

## Why

Claude Code deletes transcripts under `~/.claude/projects/` after
`cleanupPeriodDays` (default 30, see [data usage
docs](https://code.claude.com/docs/en/data-usage)), based on file mtime,
on every startup. Real GitHub issues report this cleanup sometimes
misbehaves — deleting sessions newer than configured, leaving orphaned
sidebar entries — so raising the retention number isn't a complete
guarantee: it only guards Claude Code's own automatic sweep, not you or a
script accidentally deleting a project folder, and an unbounded period
means unbounded local disk growth with no compression. A real backup is a
different kind of protection than "delete it later." Worth knowing
plainly: backups here live on the same disk — this protects against
Claude Code's cleanup and human error, not disk failure or a lost
machine.

## Scope — read this before relying on it

- **macOS only** for the dashboard's "Open"/"Continue" Terminal features
  and the launchd install/stop scripts. `backup.sh` / `restore.sh` are
  plain bash and should work on Linux, but that's untested.
- **No semantic/vector search.** The sessions table is searched by
  keyword substring only. Real semantic search needs an embeddings model
  (no public Anthropic embeddings endpoint) — a real dependency/cost
  decision, not something this repo adds silently.
- **Subagent transcripts aren't tracked as their own rows**, but they do
  get backed up: `<session-id>/subagents/agent-*.jsonl` files live inside
  the same session directory tree, so the mirror/snapshot capture them
  along with everything else — they're just not surfaced as separate
  entries in the sessions table.
- **Large sessions truncate.** Generating a resume-brief truncates to the
  most recent ~150,000 characters of transcript rather than chunking +
  map-reducing. Fine for most sessions; will drop early context on very
  long ones (the resulting brief says so when it happens).
- **Not a kanban-style session manager.** This tool is about
  persistence/recall after a session goes cold, not live-session
  ergonomics (auto-tiling terminals, quick-prompt boards, etc.).
- **Title-based noise filtering is a manual stopgap, not automation.**
  `titleExcludePatterns` in `config.json` hides matching sessions from
  the default view (e.g. an unrelated bot's auto-generated sessions) —
  it doesn't stop them from being generated in the first place.

## Setup

Requires Node.js >= 18 and the `claude` CLI on your `PATH` (for
generating resume-briefs) — no npm install needed, this repo has zero
dependencies on purpose, both for the backup/restore scripts and the
dashboard server.

```bash
git clone <this-repo>
cd claude-session-keeper
npm test   # runs the unit tests, node --test, zero deps
```

### Run a backup manually

```bash
./backup.sh
```

Mirrors `~/.claude/projects` into `~/claude-session-keeper-backups/mirror`
every run, and cuts an immutable dated snapshot into
`~/claude-session-keeper-backups/snapshots/` once every `intervalDays`
(see `config.json`). The mirror gets deletions propagated too (it's a
live sync, not an archive) — real protection against Claude Code's
cleanup comes entirely from the dated snapshots, which are never
modified after being written, only pruned past `keepCount`. The mirror
only updates when a backup actually runs (this script, the daily
automation, or at login) — it is not a continuous/real-time sync.

Override the backup location with `CLAUDE_SESSION_KEEPER_BACKUP_ROOT`.

### Restore

```bash
./restore.sh --mirror              # restore from the mirror
./restore.sh --latest              # restore from the newest dated snapshot
./restore.sh path/to/archive.tar.gz
./restore.sh --mirror --target /tmp/some-other-dir
./restore.sh --session <id> --source mirror              # just one session
./restore.sh --session <id> --source path/to/archive.tar.gz
```

Restore only fills in files that are missing at the target
(`rsync --ignore-existing`) — it never overwrites an existing file. That
makes it safe to run straight against the live `~/.claude/projects`, even
with a Claude Code session currently open and appending to its own
transcript file.

**mtime is reset on restore, on purpose.** `rsync -a` preserves the
source file's original modification time — a restored session would keep
its old, already-cleanup-eligible mtime and just get deleted again by
Claude Code's own cleanup on its next startup (confirmed with a real
test, not assumed). So every file actually restored to the live
`~/.claude/projects` gets its mtime reset to now. A `--target` override
(restoring elsewhere to inspect/export) keeps the original timestamps,
since that's a different use case.

### Automate it (macOS, launchd)

```bash
./scripts/install-launchd.sh   # install/start
./scripts/stop-launchd.sh      # pause — plist stays in place, restart any time
```

`install-launchd.sh` renders `scripts/com.user.claudesessionkeeper.plist.template`
with this repo's absolute path, loads it, and forces one run so you can
confirm it actually works before trusting it. Runs `backup.sh` daily
(mirror freshness); the dated-snapshot cadence is separately governed by
`intervalDays` in `config.json`. Both scripts are also available as
buttons on the dashboard's Automation tab.

**Sleep/power-off behavior** (looked up directly, not assumed): if the
Mac is asleep at the scheduled time, the missed run fires as soon as it
wakes (launchd coalesces missed intervals). If it's fully powered off,
a missed run does *not* auto-fire on power-on by default — but this
job's `RunAtLoad` setting (already set in the template) fires it at your
very next login regardless, so both cases are covered without extra
configuration.

If you already have an older ad hoc backup cron/launchd job, verify this
one works first, then unload the old one so they don't both run:

```bash
launchctl unload ~/Library/LaunchAgents/<old-label>.plist
```

### Dashboard

```bash
node dashboard/server.js   # or: npm run dashboard
```

Open `http://localhost:4317`. Two tabs:

- **Backups** (primary) — one unified, searchable, paginated table of
  every session this tool knows about, merged from live/mirror/every
  snapshot into a single row per session id (never duplicated), tagged
  with badges for where it currently exists. When the same session
  exists in more than one place, live data wins over mirror, which wins
  over the newest snapshot that has it. Actions are contextual to what's
  available: **Open** (live only), **Continue** (any source — see
  below), **Rename** (live/mirror only), **Restore** (mirror/snapshot
  only, with a confirmation naming the exact source), **Delete**
  (live/mirror, composed automatically — never touches a snapshot).
  Search overrides `titleExcludePatterns`, so hidden noise can still be
  found and bulk-deleted (`Select all N matching`). Below that: on-demand
  backup, and the dated-snapshots list (browse one's exact contents,
  restore an older version specifically, or delete the whole snapshot).
- **Automation & Settings** — whether the launchd job is actually loaded,
  its run count/last exit code, and an *estimated* next-run time for
  both the daily mirror sync and the next dated snapshot (launchd itself
  exposes no scheduled-next-fire time for this kind of job — checked
  directly, see above). Install/start or stop it with one click. Edit
  Claude Code's own `cleanupPeriodDays` (in `~/.claude/settings.json`,
  backed up before every change, with the "why this doesn't replace
  backups" reasoning right there in the UI) and this tool's own
  `config.json`, including `titleExcludePatterns`.

**"Open"/"Continue" need a macOS Automation permission grant** the first
time they run (System Settings → Privacy & Security → Automation → your
terminal app → Terminal). If it fails, the dashboard surfaces that
directly instead of a raw error.

**Session titles**, shown instead of a raw UUID: Claude Code writes both
an auto-generated `ai-title` and, if a session's been renamed, a
`custom-title` (plus a `custom-title.json` side-car file, which wins if
present — confirmed against real sessions, both sources agreed in every
case checked). Falls back to a truncated first user message, then the
short session id, if neither exists. The dashboard's Rename action writes
that same side-car file — it doesn't invent a second mechanism.

### Continue (generate a resume-brief, pick up in a new session)

One action, for any session regardless of source (live, mirror-only, or
extracted from a snapshot), as long as its original working directory
still exists on disk. It:

1. Generates a resume-brief by shelling out to the local `claude` CLI in
   headless mode (`claude -p ... --output-format json`) — no API key,
   authenticates however your interactive `claude` sessions already do
   (OAuth/keychain, enterprise SSO, whatever your plan uses).
2. Writes the brief to a temp file and opens a **new** Terminal window in
   the session's original directory running `claude "$(cat <brief file>)"`
   — an interactive session seeded with that brief as its first turn.
   (The brief is passed via a temp file + command substitution rather
   than typed directly as a giant multi-line argument — confirmed by
   actually running it that a huge multi-line quoted argument works
   correctly but visibly looks like a stuck shell while `do script`
   "types" it; the temp-file form keeps what's visibly typed to one
   short line.)

The original session, if it's live, is left completely untouched —
nothing is deleted automatically.

## How it works

- **Storage location:** `~/.claude/projects/<encoded-project-path>/<session-id>.jsonl`.
  `<encoded-project-path>` is the original cwd with non-alphanumeric
  characters replaced by `-` — lossy, not decoded for display.
- **Real cwd recovery:** every line in a session's JSONL carries a
  top-level `"cwd"` field with the actual, un-mangled original working
  directory. `lib/sessions.js`'s `resolveSessionCwd()` reads this from
  the first parseable line.
- **Context-usage estimate:** `message.usage.input_tokens` is frequently a
  streaming placeholder (often exactly `1`), not a final value. A single
  forward pass over the file keeps *overwriting* "last qualifying usage
  total" whenever a line clears a 50-token noise threshold — provably the
  same result as scanning backward for the first qualifying line, without
  a second pass. Default window is 1,000,000 tokens (current Sonnet
  5/Opus 5-class models); lower `contextWindowTokens` in the dashboard's
  Settings tab if you're pinned to a smaller-window model.
- **launchd has no "next run" time.** `launchctl print` was checked
  directly against the real loaded job — `state`/`runs`/`last exit
  code`/`run interval` are exposed, nothing else. "Next run" in the
  dashboard is computed from the last completed run (parsed from
  `backup.log`, which logs ISO 8601 timestamps specifically so this
  parses reliably — bash's default `date` output does not: `new
  Date("Thu Aug 27 22:55:12 IST 2026")` is `Invalid Date`, confirmed) plus
  the interval, and is presented as an estimate.
- **Format stability:** the transcript format is internal to Claude Code
  and can change between releases. Every parser in this repo fails soft
  (skip the file / line, mark the field "unknown") rather than throwing —
  keep that pattern in anything you add.
- **Path-traversal guards:** session ids and snapshot filenames arrive
  from HTTP request bodies and get joined into filesystem paths (to open,
  continue, rename, restore, or delete a file) — every entry point
  validates the id/filename shape first (`lib/sessions.js`'s
  `isSafeSessionId`, `lib/backups.js`'s `SNAPSHOT_NAME_RE`) before it's
  ever used in a path.
- **Merging sessions across live/mirror/snapshots stays cheap as
  snapshots pile up**: attaching an "in snapshot X" badge only ever needs
  a snapshot's member *listing* (`tar -tzf`, no decompression of
  contents) — a full per-session extraction only happens for a session
  that exists in no live or mirror copy at all (rare), and even then only
  once per snapshot file regardless of how many such sessions it needs to
  supply.

## Directory layout

```
claude-session-keeper/
├── backup.sh / restore.sh          # bash, POSIX-ish
├── config.json                     # keepCount, intervalDays, contextWindowTokens, summarizeModel, titleExcludePatterns
├── scripts/
│   ├── com.user.claudesessionkeeper.plist.template
│   ├── install-launchd.sh
│   └── stop-launchd.sh
├── lib/
│   ├── sessions.js                 # analyzeSessionFile (single-pass: cwd/title/usage), listSessionsInDir, writeSessionTitle, delete/find helpers
│   ├── claude-settings.js          # ~/.claude/settings.json cleanupPeriodDays read/write (backed up, atomic write)
│   ├── automation.js               # launchd status + "next run" estimates
│   ├── backups.js                  # snapshot listing/contents/delete, mirror-session delete, session extraction
│   ├── unified-sessions.js         # merges live + mirror + every snapshot into one row per session id
│   ├── shell.js                    # shQuote / asQuote — see test/shell.test.js before touching
│   └── summarize.js                # shells out to `claude -p`, resume-brief generation
├── dashboard/
│   ├── server.js                   # Node http, zero npm deps
│   └── public/                     # vanilla JS/CSS, no framework, no build step
│       ├── index.html              # tab shell: Backups / Automation & Settings
│       ├── app.js                  # shared: fetchJson, icons, pagination, tab switching
│       ├── backups.js / automation.js  # one per tab (each wrapped in an IIFE — classic
│       │                                 <script> tags share one global scope)
│       └── style.css
└── test/                           # node --test, zero deps
```
