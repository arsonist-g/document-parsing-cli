---
name: document-parsing
description: Convert a document into Markdown, covering PDF, scanned images (png, jpg, jpeg, jp2, webp, gif, bmp), Word (doc, docx), PowerPoint (ppt, pptx), Excel (xls, xlsx), and HTML. This skill drives the docparse CLI, which sends the file to the MinerU parsing service and writes a Markdown file on disk, printing its path. It fits tasks that read a PDF or a scanned image, turn an Office document or a web page into Markdown, or batch-convert several papers and reports.
---

# document-parsing

`docparse` converts a document into a Markdown **file on disk** and prints the path of that file. It sends every document to the upstream MinerU parsing service, so a call needs network access and, on the precise channel, an API token. The install path, the credential setup, the `base_url`, the configuration keys, and the administrative commands are in `references/install-and-config.md`.

## Output boundary

This skill converts documents and hands back file paths. It does not:

- Summarize, translate, or answer questions about a document. Read the returned file for that.
- Print document content. stdout carries paths, so piping a conversion command into a text reader gives you a path, not prose.
- Parse anything locally. Conversion happens upstream, which is why a URL the vendor cannot fetch, or a spent allowance, is a possible failure.
- Choose which pages you need. It converts the document, or the page range you name, and hands you the file.

## How to read this skill

- Sentences with "must", "do not", or "never" are rules. Tables, fenced blocks, and text marked "example" are reference.
- `references/install-and-config.md` holds install, credentials, `base_url`, the configuration keys, and the administrative commands. Load it on first use, or when a credential, an upstream address, or a pool setting changes.
- `references/errors.md` holds the upstream codes the tool has a hint for, the exit codes, and which failures are worth retrying. Load it when a call fails with a code you do not recognize.
- Not all three files load at once: this entry, plus whichever of the two references the task needs. The common path is this entry alone.
- Each file has a Chinese twin beside it, `skill-zh.md` for this entry and `references/<name>-zh.md` for the rest: translations kept for human proofreading. The English file is the one in force.

## Supported inputs

`parse` takes PDF, images (png, jpg, jpeg, jp2, webp, gif, bmp), Word (doc, docx), PowerPoint (ppt, pptx), Excel (xls, xlsx), and HTML. `flash` takes PDF, images, docx, pptx, and xlsx only.

| Channel | Formats | Limits |
|---|---|---|
| `parse` | PDF, images (png, jpg, jpeg, jp2, webp, gif, bmp), doc, docx, ppt, pptx, xls, xlsx, html | 200 MB and 200 pages per file, 200 files per call (upload links are requested 50 at a time) |
| `flash` | PDF, images (png, jpg, jpeg, jp2, webp, gif, bmp), docx, pptx, xlsx | 10 MB, 20 pages, one file |

Anything outside those lists has no parser: audio, video, archives, EPUB, and plain-text formats such as txt, md, and csv fail upstream, and `parse` prints the vendor's `unsupported file type` message. PDFs and images are read by OCR or a vision model, so a scan or a photo works, and `--ocr`, `--formula`, `--table`, and `--language` act on the `pipeline` and `vlm` models only.

## What a call needs

| Command | Precondition |
|---|---|
| `parse` | One usable account. Credentials come from the config file, from the environment, or from a flag on this call; `references/install-and-config.md` lists the ways. |
| `task` | A `task_id`, plus the account pool containing the account that submitted it. |
| `flash` | Nothing. This channel takes no token, and is rate limited by IP address. |

The pool is a pool, not one key. With several accounts, calls spread across them, and an account that fails is cooled down and skipped, so a rejected credential is a pool-wide condition rather than one bad key.

## The loop

```sh
docparse account test                    # confirm the credential is accepted
docparse parse ./report.pdf              # convert, and print the path it wrote
# stdout: /home/me/proj/tmp-doc/2026-09-18/parse-report-14-22-05-9f3c1a/report.md
```

`account test` prints `ok <name>: 鉴权通过` and exits 0. The `-60012` in its parentheses is expected: the probe asks for a task id that does not exist, and the vendor answers that way for one.

Then read the printed path with your own file tool. The mistake to avoid is re-running the conversion, or asking the tool to print the Markdown, in order to see the content: that spends allowance again and writes a second copy of the document.

A precise-channel call runs in stages, which is why it can take minutes and why a failure still tells you where to look:

```mermaid
flowchart LR
  A["submit"] --> B["vendor queues the job"]
  B --> C["you poll, or the CLI polls for you"]
  C --> D["download the result archive"]
  D --> E["write <slug>.md beside images/"]
  E --> F["print the absolute path"]
```

To convert several documents, pass them all to one `parse` call. It batches them and prints one path per document as they finish.

## Command usage

```sh
docparse [global flags] <command> [positionals] [flags]

docparse parse ./papers/a.pdf ./papers/b.pdf --pages "1-20" --out ./markdown
```

- Positionals come after the command, in the order the command table gives them. Flags may sit anywhere on the line, before or after the command.
- A flag that takes a value accepts both `--flag value` and `--flag=value`. A boolean flag accepts a `--no-` prefix to switch it off, example `--no-table`.
- Pass `--` to stop flag parsing, for an input path that begins with a dash.
- The global flags below hold for every command, and the per-command tables do not repeat them.
- Run `docparse --help` before a call whose signature you are unsure of: it is the fuller of the two help levels, and the runtime source of truth. `docparse <command> --help` prints a short synopsis only, so it is not where a flag is confirmed.

| Global flag | Meaning |
|---|---|
| `--config PATH` | Config file to read, default `~/.docparse/config.toml`. |
| `--base-url URL` | Upstream address, overriding the config, default `https://mineru.net`. |
| `--token TOKEN` | Token for this call only; repeat it to build a temporary pool. |
| `--output json\|text` | Output format, default `text`. |
| `--timeout SECONDS` | Total wait for a result, overriding `parse.poll_timeout_sec`. |
| `-v`, `--verbose` | Print the HTTP requests and responses to stderr. |
| `-h`, `--help` | Help for the tool, or for one command. |
| `--version` | Print the version. |

## Command surface

The tool groups its commands as its own help does. Marking: `<x>` a required positional, `[x]` an optional positional, `--flag` an optional flag, `a | b` mutually exclusive alternatives, and a trailing `*` on a positional means it repeats.

| Group | Commands |
|---|---|
| Parsing | `parse`, `flash`, `task`, `batch` |
| Setup and administration | `config`, `account`, `quota`, `skills`, `doctor`, all documented in `references/install-and-config.md` |

### Parsing

| Command | Description | Parameters | Notes |
|---|---|---|---|
| `parse` | Converts local files or URLs through the precise channel and writes the result to disk. | `<file-or-url>*` `--model <pipeline \| vlm \| MinerU-HTML>` `--language <code>` `--pages <range>` `--ocr` `--no-ocr` `--formula` `--no-formula` `--table` `--no-table` `--extra-formats <list>` `--out <dir>` `--no-wait` | One absolute Markdown path per document on stdout. `--pages` takes the vendor grammar, example `"2,4-6"`. `--extra-formats` is a comma separated subset of `docx`, `html`, `latex`, and does nothing for an HTML source. `--no-wait` prints a `batch_id` and returns at once; resume it with `docparse batch <batch_id>`. |
| `flash` | Converts one small input through the token-free channel. | `<file-or-url>` `--model <pipeline \| vlm \| MinerU-HTML>` `--language <code>` `--pages <range>` `--ocr` `--no-ocr` `--formula` `--no-formula` `--table` `--no-table` `--out <dir>` | Exactly one input: a second one is an error, so batch through `parse`. `--pages` accepts only `"1-10"` or a single page, and the vendor rejects a richer range. `--extra-formats` is accepted but does nothing here. The whole output is one Markdown file. |
| `task` | Reports a precise-channel task and optionally fetches its result. | `<task-id>` `--download` `--wait` `--out <dir>` `--slug <name>` | Without `--download` it prints `<task_id> <state>`. One id only: a second one is ignored rather than refused. The task belongs to the account that submitted it, so the command searches the pool for a matching one. |
| `batch` | Reports a batch by its `batch_id` and optionally fetches what is finished. | `<batch-id>` `--download` `--wait` `--out <dir>` `--slug <name>` | Without `--download` it prints `<file name> <state>` per document. `--wait` polls until every document settles. `--slug` applies to a single-document batch only. The batch belongs to the account that submitted it, so the command searches the pool. |

The parsing defaults come from the config: `vlm`, `ch`, OCR off, formula and table on. A flag on the line overrides the config for that call.

## Reading the returned path

- stdout carries one absolute Markdown path per line and nothing else. Progress, warnings, and errors go to stderr, so the output pipes cleanly.
- The layout is `<cwd>/tmp-doc/<YYYY-MM-DD>/parse-<slug>-<HH-MM-SS>-<rand>/<slug>.md`. The directory beside the Markdown holds the `images/` and JSON that the Markdown references relatively, so move or copy that whole directory, never the `.md` alone.
- `<slug>` comes from the source name: the file name without its extension, or the host plus the last path segment for a URL. Every character outside `A-Za-z0-9-` becomes `-`, the result is cut to 48 characters, and a name with nothing usable left becomes `document`.
- `--out DIR` replaces the `tmp-doc/<date>` part only, so `--out ./docs` writes `./docs/parse-report-.../report.md`.
- An existing name is never overwritten: a collision appends `-1`, then `-2`.
- `--output json` wraps the same results in one object, with `md_path` absent for a document that failed, and `error` present only on failure. That object appears once the call reaches the service: an input rejected before it starts, such as a missing local file, exits 2 with a plain `error:` line and no JSON.

## Red lines

- Never ask the tool for document content. Read the path it printed.
- Do not re-run a conversion to look at the output: it spends allowance and leaves a second copy.
- Do not write a token into a file you commit. It belongs in `~/.docparse/config.toml`, in an environment variable, or on one call's command line.
- Do not retry a call that exited 5 under the same credential: exit 5 means every account in the pool was rejected.

## Errors

| Code | Meaning | Action |
|---|---|---|
| exit 5 | Every account was rejected. | Verify or replace the credential with `docparse account test`. Retrying the same call changes nothing. |
| exit 6 | The upstream failed, or the wait timed out. | The message carries the vendor's reason, and its code when the vendor sent one. A `task_id` is re-queried with `docparse task <task_id>`, and a `batch_id` with `docparse batch <batch_id>`. Do not resubmit the document. |
| exit 7 | Some documents succeeded. | The paths already printed stay valid. Re-submit only the inputs that failed. |
| `-60008` | The vendor could not fetch your URL. | Download the file and pass a local path instead. |
| `-30001`, `-30003` | The input exceeds a `flash` limit. | Convert that document with `parse`. |
| `-60018` | The vendor refused the call: the daily page allowance is spent. | The pool parks that account until the next day, so a retry today does not go through on it. Another account still works, and `docparse quota` reports what is left. |
| any other code | The vendor sent a code the tool carries no hint for. | Keep the message as it is, and do not resubmit the document without a reason. A code that `references/errors.md` lists is not this row's business: that table's retry column governs. The call exits 6. |

The remaining codes, what each means, and which failures are worth retrying are in `references/errors.md`.
