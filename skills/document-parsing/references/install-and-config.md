# Install and configuration

Load this file on first use, or when a credential, an upstream address, a pool setting, or the skill installation changes. The common path needs none of it.

## Install

The tool is a Node package and needs Node 18.17 or newer.

```sh
npm install -g docparse-cli
docparse --version
```

## First run

```sh
docparse config init                     # write a commented config template
docparse account add --token <TOKEN>     # store an account; repeat for a pool
docparse account test                    # probe the credential, spends no allowance
docparse doctor                          # self-check, exits 3 when a check reports an error
```

Create a token at `https://mineru.net/apiManage/token`. `docparse account test` queries a task id that does not exist, so a "task not found" answer means the credential is accepted.

## Install this skill into an agent

```sh
docparse skills install                  # default target: codex
docparse skills install --target all
docparse skills status
```

| Target | Skills root |
|---|---|
| `codex` (default) | `~/.agents/skills` |
| `pidesktop` | `~/.agents/skills` |
| `claude` | `~/.claude/skills` |
| `cursor` | `~/.cursor/skills` |
| `hermes` | `~/.hermes/skills` |

`--skills-root DIR` replaces the skills root for every target, and `skills update` is `skills install` again. The copied directory holds this entry, both references, and their translations.

## Credentials

Give a token in any of three ways. The first is persistent, the second suits a container, the third suits one call.

```sh
docparse account add --token <TOKEN> --name main --weight 2   # config file
docparse parse ./report.pdf --token <TOKEN>                   # this call only
```

The second way sets `DOCPARSE_TOKEN` in the calling environment before the call; it is how a caller passes a token without writing it into a file. How an environment variable is set is the shell's business, and the table below lists the rest.

Add several accounts and calls spread across them: fewest in flight first, then the account idle longest, then the higher `weight`. An account that fails is cooled down and skipped: 24 hours for a rejected or expired token (`A0202`, `A0211`), until the next day once the daily allowance is spent (`-60018`), and briefly for throttling or upstream trouble. Cooldown state is in `~/.docparse/state.json`, keyed by a hash of the credential and never by the credential itself.

A self-hosted or gateway deployment is pointed at with `--base-url`, or with `base_url` on the account. A gateway that needs custom headers declares them in the config file, where `${token}` is substituted:

```toml
[[account]]
name = "gateway"
token = "..."
base_url = "https://gw.example.com"
headers = { Authorization = "Bearer ${token}" }
```

| Environment variable | Effect |
|---|---|
| `DOCPARSE_TOKEN` | One token. |
| `DOCPARSE_TOKENS` | Comma separated tokens, forming a pool. |
| `MINERU_TOKEN` | Same as `DOCPARSE_TOKEN`, for compatibility with MinerU's own tooling. |
| `DOCPARSE_BASE_URL` | Upstream address. |
| `DOCPARSE_CONFIG` | Config file path. |
| `DOCPARSE_HOME` | Data directory holding the config and the state file. |
| `DOCPARSE_MODEL_VERSION`, `DOCPARSE_LANGUAGE`, `DOCPARSE_OUTPUT_ROOT` | The matching config keys. |
| `DOCPARSE_DEBUG` | Any non-empty value adds the upstream response details to stderr on failure. |

## Configuration keys

The file is TOML, at `~/.docparse/config.toml` unless `--config`, `DOCPARSE_CONFIG`, or `DOCPARSE_HOME` moves it. `docparse config set <key> <value>` accepts only the keys below; edit the file directly for the account block.

| Key | Default | Meaning |
|---|---|---|
| `base_url` | `https://mineru.net` | Upstream address, for a self-hosted or gateway deployment. |
| `parse.model_version` | `vlm` | Parsing model: `pipeline`, `vlm`, or `MinerU-HTML`. Use `MinerU-HTML` for an HTML source. |
| `parse.language` | `ch` | OCR language. |
| `parse.is_ocr` | `false` | Force OCR. |
| `parse.enable_formula` | `true` | Recognize formulas. |
| `parse.enable_table` | `true` | Recognize tables. |
| `parse.poll_interval_sec` | `5` | Seconds between polls, minimum 1. |
| `parse.poll_timeout_sec` | `1800` | Total wait per call, minimum 5. `--timeout` overrides it. |
| `parse.max_upload_mb` | `200` | Local upload ceiling, minimum 1. The vendor also caps at 200 MB. |
| `output.root` | `tmp-doc` | Output root, relative to the working directory. |

Each `[[account]]` block takes `name`, `token`, `base_url`, `headers`, `weight`, and `enabled`.

## Administrative commands

Every command here also accepts `--output json`.

| Command | Description | Parameters | Notes |
|---|---|---|---|
| `config path` | Prints the config file path. | | |
| `config show` | Prints the effective configuration and the pool. | | |
| `config init` | Writes a commented template. | `--force` | Without `--force` an existing file is left alone. |
| `config set` | Changes one key. | `<key> <value>` | Rejects a key outside the table above with exit 2. |
| `account list` | Prints the pool, with cooldown state. | | |
| `account add` | Adds an account. | `--token <token>`, `--name <name>`, `--base-url <url>`, `--weight <n>` | Repeat it to build a pool. Here `--base-url` is written into that account's record, so the account keeps its own upstream; the global flag of the same name covers one call only. |
| `account remove` | Removes an account. | `<name-or-index>*` | |
| `account test` | Probes credentials without spending allowance. | `--name <name>` | Exit 5 when a credential is rejected. |
| `quota` | Prints today's pages and files as used over allowance, plus cumulative usage per account. | `--name <name>` | Reads the vendor's own counters. The remaining page count is in `--output json` under `daily.left`. A zero `total_left` means the free balance is spent, which does not block parsing. |
| `skills status` | Prints the installation state per target. | `--target <list>`, `--skills-root <dir>` | |
| `skills install`, `skills update` | Copies this skill into the target. | `--target <list>`, `--skills-root <dir>` | |
| `doctor` | Checks Node, the config file, the pool, upstream reachability, and the skill installation. | `--target <list>`, `--skills-root <dir>` | Exits 3 when a check reports an error. |
