# Errors and exit codes

Load this file when a call fails, or when you need to decide whether a failure is worth retrying. Anything the entry already carries is not repeated here.

A failure prints one line to stderr, `error: <message>`, and sets the process exit code. Set `DOCPARSE_DEBUG` to any non-empty value before the call to have the upstream response details added to stderr as JSON. For `parse`, `flash`, and `task`, stdout stays empty when the call fails, so read the exit code, not the output; on exit 7 the paths that did succeed are already there. The administrative commands differ, because `account test`, `quota`, and `doctor` print their report to stdout and then exit with the failing code.

## Exit codes

| Code | Class | What it means | Action |
|---|---|---|---|
| 0 | success | The call completed. | Read the printed paths. |
| 1 | internal | A bug in the tool. | Report it with the message. |
| 2 | arguments | A flag, a value, or a subcommand is wrong. A local file over the size ceiling is refused here, before anything is uploaded. | Fix the command line. For an oversized local file the ceiling is checked locally, so `-60005` and `-30001` are what a URL source can still produce. |
| 3 | configuration | The config file, or a check in `doctor`, is wrong. | Run `docparse config show` and `docparse doctor`. |
| 4 | network | The upstream could not be reached. | Retry once. If it repeats, check the network path to `base_url`. |
| 5 | account | Every account in the pool was rejected, or none is configured (`parse` reports an empty pool this way; `task`, `batch`, and `quota` with no account exit 2). | Run `docparse account test`, then fix the credential. Retrying changes nothing. |
| 6 | upstream | The document failed, the submission failed, or the wait timed out. | Keep the `task_id` from the message and re-query it with `docparse task <task_id>`, or the `batch_id` with `docparse batch <batch_id>`. Do not resubmit the document. |
| 7 | partial | Some documents in the call succeeded. | The paths already printed stay valid. Re-submit only the inputs that failed. |

## Upstream codes

These come from the vendor and appear inside the message. The retry column says what the tool does with the code and what is left for you to do; a code that also has a row in the entry appears in both places, with the entry giving the shorter version.

| Code | Meaning | Retry |
|---|---|---|
| `A0202` | The token is wrong. | With another account only. |
| `A0211` | The token has expired. | With another account only. |
| `-500` | A parameter or the content type is wrong. | No. |
| `-10001` | The upstream service failed. | Yes. |
| `-10002` | A request parameter is malformed. | No. |
| `-60001` | Creating the upload URL failed. | Yes. |
| `-60002` | The file type is unsupported. | No. |
| `-60003` | The file could not be read. | No. |
| `-60004` | The file is empty. | No. |
| `-60005` | The file is over the 200 MB ceiling. | No. |
| `-60006` | The document is over the 200 page ceiling. | No. |
| `-60007` | The parsing model is temporarily unavailable. | Yes. |
| `-60008` | The vendor could not read your source URL in time. | No. Download the file and upload it instead. |
| `-60009` | The submission queue is full. | Yes. |
| `-60010` | Parsing failed. | Yes. |
| `-60011` | No valid file was found, so the upload did not land. | No. |
| `-60012` | The task does not exist, or it has expired. | No. |
| `-60013` | The task belongs to another account. | With the account that submitted it. |
| `-60015` | The file could not be converted for parsing. | No. Convert it to PDF yourself first. |
| `-60016` | Converting to an extra export format failed. | No. Drop that format. |
| `-60018` | The vendor refused the call: the daily page allowance is spent. | The next day, or with another account. The pool cools that account until the next day and prefers another one, but it still falls back to a cooling account when none is ready, so with a single account a same-day retry is still attempted. |
| `-60019` | The HTML allowance is short. | The next day, or with another account. |
| `-60020` | No meaning is known: the vendor does not document it and the tool carries no hint. | Yes. |
| `-60021` | Reading the page count failed. | Yes. |
| `-60022` | Fetching the web page failed, often from rate limiting. | Yes. |
| `-30001` | The input is over the 10 MB `flash` ceiling. | Use `parse`. |
| `-30002` | The `flash` channel does not support this file type. | Use `parse`. |
| `-30003` | The input is over the 20 page `flash` ceiling. | Use `parse`. |
| `-30004` | A `flash` request parameter is invalid. | No. |
| any `5xx` | The upstream returned a server error. | Yes. |

## Retrying

- A retryable code is retried on another account first, because the pool spreads the call and cools down the account that failed. That is why you rarely see one.
- `A0202`, `A0211`, `-60018`, and `-60019` also cool the account down, so the pool stops preferring it while a ready account exists, and falls back to it when none is. This is why exit 5 keeps appearing after the credential is replaced: the new account has to be added, not the old one retried.
- The vendor also describes the page allowance as its top-priority tier, which it says keeps serving at lower priority, while the refusal above is explicit. Whether a lower-priority allowance survives `-60018` is not settled by the documentation; the pool stops preferring that account for the rest of the day, and a same-day retry may still go through.
- An error that is not retryable, such as `-60002`, stops the call at once, because another account would meet the same answer.
- A code in neither table above is treated as fatal for that document: keep the message, and do not resubmit it without a reason. Report it with the code if it keeps happening.
- When the retryable path is exhausted, the error that surfaces is the last real failure, not a substitute. On `parse`, `quota`, and `account test` a rejected or expired token finishes as exit 5; `task` and `batch` switch accounts on it and finish as exit 6 instead. Every other upstream failure finishes as exit 6, with the vendor's code kept inside the message whenever it sent one.
