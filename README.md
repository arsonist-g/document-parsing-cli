# docparse

Convert a document into a Markdown file on disk, and print **the path of that file — never its content**.

`docparse` is a CLI for AI agents, built on the [MinerU](https://mineru.net/apiManage/docs) parsing
API. PDF, scanned images (png/jpg/jpeg/jp2/webp/gif/bmp), Word (doc/docx), PowerPoint (ppt/pptx),
Excel (xls/xlsx) and HTML pages go in; a local Markdown file comes out. Because only the path reaches
stdout, a 200-page PDF costs one line of context instead of thousands, and the agent reads exactly
the pages it needs. Audio, video, archives, EPUB and plain-text formats have no parser here.

## Install

```sh
npm install -g docparse-cli
docparse skills install          # installs the skill into ~/.agents/skills/document-parsing
```

## Quick start

```sh
# a token from https://mineru.net/apiManage/token
docparse account add --token <TOKEN>

docparse parse report.pdf                       # → /…/tmp-doc/2026-09-18/parse-report-10-31-02-a1b2c3/report.md
docparse parse https://example.com/paper.pdf --pages 1-20
docparse parse a.pdf b.pdf c.pdf                # batch: one path per line
docparse flash scan.png                         # no token, ≤10 MB / ≤20 pages
docparse batch <batch_id> --download            # resume a parse by its batch_id
docparse doctor                                 # check config, accounts, connectivity, skill
```

## Commands

| Command | What it does |
|---|---|
| `parse <file-or-url>...` | Precise parsing of a PDF, an image, a Word/PowerPoint/Excel file, or an HTML page. Local files and URLs, one or many; Markdown + JSON + images, optional `docx`/`html`/`latex` exports. Needs a token. |
| `flash <file-or-url>` | Token-free lightweight parsing of one PDF, image, docx, pptx, or xlsx, ≤10 MB / ≤20 pages, Markdown only. |
| `task <task_id>` | Look up a precise-parse task; `--download` fetches and unpacks the result. |
| `batch <batch_id>` | Look a batch up by its `batch_id` (printed by `parse --no-wait`); `--wait` polls, `--download` fetches the finished documents. |
| `config <path\|show\|init\|set>` | Inspect or edit configuration. |
| `account <list\|add\|remove\|test>` | Manage the parsing account pool. |
| `quota [--name NAME]` | Today's page/file allowance and cumulative usage per account; spends no quota. |
| `skills <status\|install\|update>` | Install the bundled skill into an AI agent's skills directory. |
| `doctor` | Self-check: Node, config, accounts, upstream reachability, skill state. |

Key flags: `--model pipeline\|vlm\|MinerU-HTML`, `--pages "2,4-6"`, `--ocr/--no-ocr`,
`--formula/--no-formula`, `--table/--no-table`, `--language ch`, `--extra-formats docx,html`,
`--out DIR`, `--no-wait`, `--output json`, `--base-url URL`, `--token TOKEN`, `--timeout SECONDS`.
Run `docparse --help` for the full list.

## Output layout

Results land next to the caller's working directory, using the same `tmp-doc/<date>/` convention as
the sibling research CLI:

```
tmp-doc/2026-09-18/parse-report-10-31-02-a1b2c3/
├── report.md      ← the path printed on stdout
├── images/        ← referenced by report.md
└── *.json         ← layout / content list / model output
```

Each document takes its own directory so the Markdown keeps working image links; the name carries a
timestamp and a random suffix, and an existing file is never overwritten. `--out DIR` replaces the
`tmp-doc/<date>` part, so `--out ./docs` writes `./docs/parse-report-…/report.md`.

**stdout carries results only** — one absolute Markdown path per line. With `--output json` every
command prints JSON instead; `parse` returns `{"results":[{input,kind,state,md_path?,out_dir?,task_id?,error?}],
"batch_ids":[...],"failed":N}`. Progress, warnings and errors all go to stderr, so output pipes cleanly.

## Multiple accounts and custom base_url

Add several accounts and the pool load-balances by itself — fewer in-flight calls first, then the
account idle longest, then the higher `weight`:

```sh
docparse account add --token <TOKEN-A> --name a
docparse account add --token <TOKEN-B> --name b
docparse account list           # pool state, including cooldowns
docparse account test           # credential probe, spends no parse quota
docparse quota                  # what each account has left today
```

A failing account is cooled down and skipped: 24 h for an invalid or expired token
(`A0202`/`A0211`), until the next day once the daily quota is used up (`-60018`), and briefly for
throttling or upstream outages. Cooldown state lives in `~/.docparse/state.json`, keyed by a hash of
the credential — never by the credential itself.

In `docparse quota`, `pages_today` / `files_today` read as "used/allowance" for today. The page
allowance is the vendor's highest-priority quota: running it out does not stop parsing, it only drops
the rest of the day to lower priority. `total_left` at 0 means the free balance is spent, which is
likewise not a blocker.

Point the CLI somewhere else with `--base-url https://gateway.example.com` or `base_url` in the
config. A gateway that needs a different header layout declares it on the account, where `${token}`
is substituted:

```toml
[[account]]
name = "gateway"
token = "..."
base_url = "https://gateway.example.com"
headers = { Authorization = "Bearer ${token}" }
```

Environment overrides: `DOCPARSE_TOKEN`, `DOCPARSE_TOKENS=a,b,c`, `DOCPARSE_BASE_URL`,
`DOCPARSE_HOME`, `DOCPARSE_CONFIG`, `MINERU_TOKEN`.

## Configuration

`~/.docparse/config.toml`, created by `docparse config init`:

```toml
schema_version = 1
base_url = "https://mineru.net"

[[account]]
name = "main"
token = "..."

[parse]
model_version = "vlm"        # pipeline | vlm | MinerU-HTML
language = "ch"
is_ocr = false
enable_formula = true
enable_table = true
poll_interval_sec = 5
poll_timeout_sec = 1800
max_upload_mb = 200

[output]
root = "tmp-doc"
```

`docparse config path | show | init | set <key> <value>` manage it. Note that `config set` rewrites
the file, so comments added by hand are not preserved.

## Exit codes

`0` ok · `1` internal · `2` bad arguments · `3` configuration · `4` network · `5` auth/account ·
`6` upstream/parse failure — every document failed, submission failed, or waiting timed out (the
message keeps the `batch_id`/`task_id`) · `7` partial success — on `7` the paths already printed are valid.

Exit `5` means the credential is wrong, not the request: every configured account was rejected, so
verify or replace the key instead of retrying the same call.

## Development

```sh
npm install
npm run build        # tsc → dist/
npm run typecheck
npm test             # node --test with tsx
```

## License

MIT

