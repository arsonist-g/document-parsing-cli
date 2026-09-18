# docparse

把文档转换成磁盘上的 Markdown 文件，并只输出**这个文件的路径，而不是内容**。

`docparse` 是给 AI Agent 用的命令行工具，底层是 [MinerU](https://mineru.net/apiManage/docs) 文档解析
API。输入 PDF、扫描图像（png/jpg/jpeg/jp2/webp/gif/bmp）、Word（doc/docx）、PPT（ppt/pptx）、
Excel（xls/xlsx）、网页，输出本地 Markdown 文件。因为只有路径进 stdout，一份 200 页的 PDF 只占
一行上下文而不是几千行，Agent 再按需只读它关心的那几页。音频、视频、压缩包、EPUB、纯文本这类
格式没有解析器。

## 安装

```sh
npm install -g docparse-cli
docparse skills install          # 把 skill 装到 ~/.agents/skills/document-parsing
```

## 快速开始

```sh
# Token 在 https://mineru.net/apiManage/token 创建
docparse account add --token <TOKEN>

docparse parse report.pdf                       # → /…/tmp-doc/2026-09-18/parse-report-10-31-02-a1b2c3/report.md
docparse parse https://example.com/paper.pdf --pages 1-20
docparse parse a.pdf b.pdf c.pdf                # 批量：一行一个路径
docparse flash scan.png                         # 免 Token，≤10MB / ≤20 页
docparse batch <batch_id> --download            # 按 batch_id 续查批量任务
docparse doctor                                 # 自检：配置、账号、连通性、skill
```

## 命令

| 命令 | 作用 |
|---|---|
| `parse <文件或URL...>` | 精准解析 PDF、图片、Word/PPT/Excel、HTML 网页。本地文件与 URL 都可，支持批量；输出 Markdown + JSON + 图片，可选 `docx`/`html`/`latex`。需要 Token。 |
| `flash <文件或URL>` | 免 Token 的轻量解析，只接受一份 PDF、图片、docx、pptx 或 xlsx，≤10MB / ≤20 页，只出 Markdown。 |
| `task <task_id>` | 查询精准解析任务；`--download` 直接取回并解包结果。 |
| `batch <batch_id>` | 按 `batch_id`（`parse --no-wait` 打印的那个）续查批量任务；`--wait` 轮询，`--download` 取回已完成的文档。 |
| `config <path\|show\|init\|set>` | 查看 / 修改配置。 |
| `account <list\|add\|remove\|test>` | 管理解析账号池。 |
| `quota [--name <账号>]` | 查询各账号今日额度与累计用量，不消耗解析额度。 |
| `skills <status\|install\|update>` | 把内置 skill 安装到 AI Agent 的 skills 目录。 |
| `doctor` | 自检：Node、配置、账号、上游连通性、skill 状态。 |

常用参数：`--model pipeline\|vlm\|MinerU-HTML`、`--pages "2,4-6"`、`--ocr/--no-ocr`、
`--formula/--no-formula`、`--table/--no-table`、`--language ch`、`--extra-formats docx,html`、
`--out 目录`、`--no-wait`、`--output json`、`--base-url URL`、`--token TOKEN`、`--timeout 秒`。
完整清单见 `docparse --help`。

## 结果落盘位置

结果落在调用方工作目录下，与同系列的 research CLI 保持同一套 `tmp-doc/<日期>/` 约定：

```
tmp-doc/2026-09-18/parse-report-10-31-02-a1b2c3/
├── report.md      ← stdout 打印的就是这个路径
├── images/        ← report.md 里相对引用的图片
└── *.json         ← layout / 内容列表 / 模型输出
```

每份文档独占一个目录，Markdown 里的图片链接才不会失效；目录名带时间戳与随机后缀，已存在的
文件绝不覆盖。`--out 目录` 会替换掉 `tmp-doc/<日期>` 这一段，所以 `--out ./docs` 的产物是
`./docs/parse-report-…/report.md`。

**stdout 只放结果** —— 每行一个 Markdown 绝对路径；`--output json` 时所有命令都改出 JSON，
`parse` 的形状是 `{"results":[{input,kind,state,md_path?,out_dir?,task_id?,error?}],"batch_ids":[...],"failed":N}`。
进度、告警、错误全部走 stderr，因此输出可以安全地接管道。

## 多账号与自定义 base_url

配多个账号即自动负载均衡：优先在途请求少的，其次最久未使用的，再看 `weight`：

```sh
docparse account add --token <TOKEN-A> --name a
docparse account add --token <TOKEN-B> --name b
docparse account list           # 账号池状态，含冷却情况
docparse account test           # 凭证探活，不消耗解析额度
docparse quota                  # 各账号今日还剩多少额度
```

失败账号会被冷却并跳过：Token 错误或过期（`A0202`/`A0211`）冷却 24 小时；当日额度用尽
（`-60018`）冷却到次日；限流或上游抖动则短时冷却。冷却状态存在 `~/.docparse/state.json`，
以凭证的哈希为键，不存凭证明文。

`docparse quota` 的 `pages_today` / `files_today` 是「今日已用/上限」：页数上限即官方说的最高优先级
解析额度，用完当天仍可解析，只是优先级降低；`total_left` 为 0 表示免费额度已用尽，同样不影响日常解析。

换上游地址用 `--base-url https://gateway.example.com` 或配置里的 `base_url`。需要自定义请求头的
网关，在账号上声明它，其中 `${token}` 会被替换：

```toml
[[account]]
name = "gateway"
token = "..."
base_url = "https://gateway.example.com"
headers = { Authorization = "Bearer ${token}" }
```

环境变量覆盖：`DOCPARSE_TOKEN`、`DOCPARSE_TOKENS=a,b,c`、`DOCPARSE_BASE_URL`、`DOCPARSE_HOME`、
`DOCPARSE_CONFIG`、`MINERU_TOKEN`。

## 配置

`~/.docparse/config.toml`，可用 `docparse config init` 生成：

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

用 `docparse config path | show | init | set <键> <值>` 管理。注意 `config set` 会重写整个文件，
手写的注释不会被保留。

## 退出码

`0` 成功 · `1` 内部错误 · `2` 参数错误 · `3` 配置错误 · `4` 网络错误 · `5` 账号/鉴权错误 ·
`6` 上游/解析失败——全部文档失败、提交失败或等待结果超时（消息里保留 `batch_id`/`task_id`）·
`7` 部分成功（部分文档失败）——退出码为 `7` 时，已打印的路径都是可用的。

退出码 `5` 表示凭证不对、而不是请求不对：所有配置的账号都被拒绝，应当去核对或更换密钥，而不是原样重试。

## 开发

```sh
npm install
npm run build        # tsc → dist/
npm run typecheck
npm test             # node --test + tsx
```

## 许可

MIT

