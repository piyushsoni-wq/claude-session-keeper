# claude-session-keeper

Backs up Claude Code session transcripts before Claude Code's own cleanup
deletes them, and gives you a small local dashboard to browse, reopen, and
summarize past sessions.

## Why

Claude Code deletes transcripts under `~/.claude/projects/` after
`cleanupPeriodDays` (default 30, see [data usage
docs](https://code.claude.com/docs/en/data-usage)), based on file mtime,
on every startup. Real GitHub issues report this cleanup sometimes
misbehaves — deleting sessions newer than configured, leaving orphaned
sidebar entries — so raising the retention number isn't a complete
guarantee. A real backup is a different kind of protection than "delete it
later."

## Scope — read this before relying on it

- **macOS only** for the dashboard's "Open in Terminal" feature and the
  launchd install script. `backup.sh` / `restore.sh` are plain bash and
  should work on Linux, but that's untested.
- **No semantic/vector search.** Summaries are flat markdown + a JSON
  index, searched by keyword substring only. Real semantic search needs an
  embeddings model (no public Anthropic embeddings endpoint) — a real
  dependency/cost decision, not something this repo adds silently.
- **Subagent transcripts are not handled.** `<session-id>/subagents/agent-*.jsonl`
  files are ignored entirely — not backed up separately (they live inside
  the same session directory tree so the mirror/snapshot still captures
  them), not included in context estimates, not summarized.
- **Large sessions truncate.** Summarization truncates to the most recent
  ~150,000 characters of transcript rather than chunking + map-reducing.
  Fine for most sessions; will drop early context on very long ones (the
  UI/output says so when it happens).
- **Not a kanban-style session manager.** This tool is about
  persistence/recall after a session goes cold, not live-session
  ergonomics (auto-tiling terminals, quick-prompt boards, etc.).

## Setup

Requires Node.js >= 18 and the `claude` CLI on your `PATH` (for
summarization) — no npm install needed, this repo has zero dependencies
on purpose, both for the backup/restore scripts and the dashboard server.

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
(see `config.json`). The mirror gets deletions propagated too — real
protection against Claude Code's cleanup comes from the dated snapshots,
which are never modified after being written, only pruned past
`keepCount`.

Override the backup location with `CLAUDE_SESSION_KEEPER_BACKUP_ROOT`.

### Restore

```bash
./restore.sh --mirror              # restore from the mirror
./restore.sh --latest              # restore from the newest dated snapshot
./restore.sh path/to/archive.tar.gz
./restore.sh --mirror --target /tmp/some-other-dir
```

Restore only fills in files that are missing at the target
(`rsync --ignore-existing`) — it never overwrites an existing file. That
makes it safe to run straight against the live `~/.claude/projects`, even
with a Claude Code session currently open and appending to its own
transcript file.

### Automate it (macOS, launchd)

```bash
./scripts/install-launchd.sh
```

Renders `scripts/com.user.claudesessionkeeper.plist.template` with this
repo's absolute path, loads it, and forces one run so you can confirm it
actually works before trusting it. Runs `backup.sh` daily (mirror
freshness); the dated-snapshot cadence is separately governed by
`intervalDays` in `config.json`.

If you already have an older ad hoc backup cron/launchd job, verify this
one works first, then unload the old one so they don't both run:

```bash
launchctl unload ~/Library/LaunchAgents/<old-label>.plist
```

### Dashboard

```bash
node dashboard/server.js   # or: npm run dashboard
```

Open `http://localhost:4317`. Lets you:

- See live (not-yet-cleaned-up) sessions with an estimated context-window
  usage %, and reopen one in Terminal (`claude --resume <id>`, `cd`'d into
  the session's real original working directory first).
- Trigger a backup, and restore from the mirror or the latest snapshot.
- Generate and search resume-brief summaries, one at a time or in bulk.
- Edit `config.json` (`keepCount`, `intervalDays`, `contextWindowTokens`,
  `summarizeModel`).

**"Open in Terminal" needs a macOS Automation permission grant** the
first time it runs (System Settings → Privacy & Security → Automation →
your terminal app → Terminal). If it fails, the dashboard surfaces that
directly instead of a raw error.

### Summarization

Needs no API key. Summarization shells out to your local `claude` CLI in
headless mode (`claude -p ... --output-format json`), which authenticates
however your interactive `claude` sessions already do (OAuth/keychain,
enterprise SSO, whatever your plan uses) — no `ANTHROPIC_API_KEY` required
and none is ever read. Each call passes `--no-session-persistence` so
summarizing a session doesn't itself create a new session transcript, and
`--tools ""` so it's a pure text-in/text-out call with no file/bash
access. Model is configurable via `config.json`'s `summarizeModel`
(default: `sonnet` — accepts a `claude` CLI model alias like `sonnet` /
`opus`, or a full model name).

## How it works

- **Storage location:** `~/.claude/projects/<encoded-project-path>/<session-id>.jsonl`.
  `<encoded-project-path>` is the original cwd with non-alphanumeric
  characters replaced by `-` — lossy, not decoded for display.
- **Real cwd recovery:** every line in a session's JSONL carries a
  top-level `"cwd"` field with the actual, un-mangled original working
  directory. `lib/sessions.js`'s `resolveSessionCwd()` reads this from the
  first parseable line — this is what "Open in Terminal" `cd`s into
  before `claude --resume`.
- **Context-usage estimate:** `message.usage.input_tokens` is frequently a
  streaming placeholder (often exactly `1`), not a final value. `lib/sessions.js`'s
  `estimateContextUsage()` scans a session file from the end backward and
  uses the first usage total that clears a 50-token noise threshold — a
  heuristic, not exact.
- **Format stability:** the transcript format is internal to Claude Code
  and can change between releases. Every parser in this repo fails soft
  (skip the file / line, mark the field "unknown") rather than throwing —
  keep that pattern in anything you add.

## Directory layout

```
claude-session-keeper/
├── backup.sh / restore.sh          # bash, POSIX-ish
├── config.json                     # keepCount, intervalDays, contextWindowTokens, summarizeModel
├── scripts/
│   ├── com.user.claudesessionkeeper.plist.template
│   └── install-launchd.sh
├── lib/
│   ├── sessions.js                 # listLiveSessions, estimateContextUsage, resolveSessionCwd, readCleanupPeriodDays
│   ├── shell.js                    # shQuote / asQuote — see test/shell.test.js before touching
│   ├── summarize.js                # shells out to `claude -p`, resume-brief generation
│   └── summaries-store.js          # flat markdown + JSON index, keyword search only
├── dashboard/
│   ├── server.js                   # Node http, zero npm deps
│   └── public/                     # vanilla JS/CSS, no framework, no build step
├── summaries/                      # generated content, gitignored (dir tracked via .gitkeep)
└── test/                           # node --test, zero deps
```
