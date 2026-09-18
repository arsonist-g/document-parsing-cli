---
name: document-parsing
description: 把文档转成 Markdown，支持 PDF、扫描图像（png、jpg、jpeg、jp2、webp、gif、bmp）、Word（doc、docx）、PowerPoint（ppt、pptx）、Excel（xls、xlsx）与 HTML。此 skill 驱动 docparse CLI，它把文件送往 MinerU 解析服务，落成磁盘上的 Markdown 文件并打印其路径。适用于读 PDF 或扫描件、把 Office 文档或网页转成 Markdown、批量转换多篇论文与报告这类任务。
---

> 本文件是中文翻译版，供人阅读校对；实际生效的是同目录的英文版 `SKILL.md`。两版内容一一对应。

# document-parsing

`docparse` 把一个文档转成磁盘上的 Markdown **文件**，并打印该文件的路径。它把每一份文档送到上游的 MinerU 解析服务，所以一次调用需要网络，精准解析通道还需要一个 API Token。安装方式、凭证配置、`base_url`、配置项与管理类命令都在 `references/install-and-config.md`。

## 输出边界

此 skill 转换文档并交回文件路径。它不做：

- 不总结、不翻译、不回答关于文档的问题。那件事请读返回的文件。
- 不打印文档内容。stdout 承载的是路径，所以把转换命令管道给文本阅读器，你得到的是一个路径，不是正文。
- 不在本地做任何解析。转换在上游发生，这正是「厂商取不到你的 URL」或「额度用尽」会成为可能失败的原因。
- 不替你决定需要哪些页。它转换整份文档，或你指定的页码范围，然后把文件交给你。

## 怎么读此 skill

- 带「必须」「不要」「绝不」的句子是规则。表格、围栏代码块、标注为「示例」的文字是参考。
- `references/install-and-config.md` 承载安装、凭证、`base_url`、配置项与管理类命令。首次使用时加载它，或当某个凭证、某个上游地址、某个账号池设置发生变化时加载。
- `references/errors.md` 承载工具带有释义的上游错误码、退出码，以及哪些失败值得重试。当一次调用以你不认识的错误码失败时加载它。
- 三个文件不会同时加载：本入口，加上任务需要的那一两份 reference。常见路径只需要本入口文件。
- 每个文件旁边都有一个中文孪生版本，本入口是 `skill-zh.md`，其余是 `references/<名字>-zh.md`：留着供人校对的翻译。生效的是英文文件。

## 支持的输入

`parse` 接受 PDF、图片（png、jpg、jpeg、jp2、webp、gif、bmp）、Word（doc、docx）、PowerPoint（ppt、pptx）、Excel（xls、xlsx）与 HTML；`flash` 只接受 PDF、图片、docx、pptx、xlsx。

| 通道 | 格式 | 限制 |
|---|---|---|
| `parse` | PDF、图片（png、jpg、jpeg、jp2、webp、gif、bmp）、doc、docx、ppt、pptx、xls、xlsx、html | 每份文件 200 MB、200 页，单次 200 个文件（上传链接每次申请 50 个） |
| `flash` | PDF、图片（png、jpg、jpeg、jp2、webp、gif、bmp）、docx、pptx、xlsx | 10 MB、20 页、单文件 |

列表之外的格式没有解析器：音频、视频、压缩包、EPUB，以及 txt、md、csv 这类纯文本都会在上游失败，`parse` 会打印厂商的 `unsupported file type` 消息。PDF 与图片由 OCR 或视觉模型读取，所以扫描件、照片都能处理；`--ocr`、`--formula`、`--table`、`--language` 只对 `pipeline` 与 `vlm` 两个模型生效。

## 一次调用需要什么

| 命令 | 前置条件 |
|---|---|
| `parse` | 一个可用账号。凭证可以来自配置文件、环境变量，或本次调用命令行上的参数；具体给法见 `references/install-and-config.md`。 |
| `task` | 一个 `task_id`，以及账号池里含提交它的那个账号。 |
| `flash` | 什么都不需要。这个通道不带 token，按 IP 限频。 |

账号池是池子，不是单把钥匙。有多个账号时，调用会分散到它们上面，失败的账号会被冷却并跳过，所以「凭证被拒」是池级别的状况，而不是某一把钥匙坏了。

## 循环

```sh
docparse account test                    # 确认凭证被接受
docparse parse ./report.pdf              # 转换，并打印它写出的路径
# stdout: /home/me/proj/tmp-doc/2026-09-18/parse-report-14-22-05-9f3c1a/report.md
```

`account test` 打印 `ok <名字>: 鉴权通过` 并退出 0。括号里的 `-60012` 属预期：探针问的是一个不存在的任务 id，厂商对不存在的任务就是这个答复。

然后用你自己的文件工具读那个打印出来的路径。要避免的错误是：为了看内容而重新跑一次转换，或要求工具打印 Markdown。那会再花一次额度，并留下同一份文档的第二份拷贝。

一次精准解析调用分阶段进行，这解释了它为什么可能要几分钟，也解释了为什么失败时仍然告诉你去哪儿查：

```mermaid
flowchart LR
  A["提交"] --> B["厂商排队"]
  B --> C["你轮询，或由 CLI 替你轮询"]
  C --> D["下载结果压缩包"]
  D --> E["把 <slug>.md 写在 images/ 旁边"]
  E --> F["打印绝对路径"]
```

要转换多份文档，就把它们一起交给一次 `parse` 调用。它会分批处理，并在每份文档完成时打印一个路径。

## 命令用法

```sh
docparse [全局参数] <命令> [位置参数] [参数]

docparse parse ./papers/a.pdf ./papers/b.pdf --pages "1-20" --out ./markdown
```

- 位置参数跟在命令之后，按命令表给出的顺序排列。参数可以放在行内任意位置，命令之前或之后都行。
- 取值的参数同时接受 `--flag value` 与 `--flag=value`。布尔参数接受 `--no-` 前缀以关闭它，示例 `--no-table`。
- 传入 `--` 停止参数解析，用于以短横线开头的输入路径。
- 下面这些全局参数对每条命令都成立，各命令表不再重复它们。
- 当你不确定某个签名时，先跑 `docparse --help`：两层帮助里它更完整，是运行时的权威。`docparse <command> --help` 只打印一段简短摘要，确认某个参数不要看它。

| 全局参数 | 含义 |
|---|---|
| `--config PATH` | 要读取的配置文件，默认 `~/.docparse/config.toml`。 |
| `--base-url URL` | 上游地址，覆盖配置，默认 `https://mineru.net`。 |
| `--token TOKEN` | 仅本次调用使用的 Token；重复传入可组成临时账号池。 |
| `--output json\|text` | 输出格式，默认 `text`。 |
| `--timeout SECONDS` | 等待结果的总时长，覆盖 `parse.poll_timeout_sec`。 |
| `-v`, `--verbose` | 把 HTTP 请求与响应打到 stderr。 |
| `-h`, `--help` | 工具整体的帮助，或某一条命令的帮助。 |
| `--version` | 打印版本。 |

## 命令面

工具按它自己帮助里的方式给命令分组。标记法：`<x>` 必填位置参数，`[x]` 可选位置参数，`--flag` 可选参数，`a | b` 互斥的备选值，位置参数后缀 `*` 表示可重复。

| 分组 | 命令 |
|---|---|
| 解析 | `parse`、`flash`、`task`、`batch` |
| 安装与管理 | `config`、`account`、`quota`、`skills`、`doctor`，全部记录在 `references/install-and-config.md` |

### 解析

| 命令 | 描述 | 参数 | 备注 |
|---|---|---|---|
| `parse` | 通过精准解析通道转换本地文件或 URL，并把结果写到磁盘。 | `<file-or-url>*` `--model <pipeline \| vlm \| MinerU-HTML>` `--language <code>` `--pages <range>` `--ocr` `--no-ocr` `--formula` `--no-formula` `--table` `--no-table` `--extra-formats <list>` `--out <dir>` `--no-wait` | stdout 上每份文档一个 Markdown 绝对路径。`--pages` 用厂商语法，示例 `"2,4-6"`。`--extra-formats` 是 `docx`、`html`、`latex` 的逗号分隔子集，对 HTML 来源不起作用。`--no-wait` 打印一个 `batch_id` 并立即返回，之后用 `docparse batch <batch_id>` 续查。 |
| `flash` | 通过免 Token 通道转换一个小输入。 | `<file-or-url>` `--model <pipeline \| vlm \| MinerU-HTML>` `--language <code>` `--pages <range>` `--ocr` `--no-ocr` `--formula` `--no-formula` `--table` `--no-table` `--out <dir>` | 恰好一个输入：再给一个就是错误，批量请走 `parse`。`--pages` 只接受 `"1-10"` 或单独一页，更复杂的范围由厂商拒绝。`--extra-formats` 收得下，但在这里不产生作用。产物就是一个 Markdown 文件。 |
| `task` | 报告一个精准解析任务，并可选地取回结果。 | `<task-id>` `--download` `--wait` `--out <dir>` `--slug <name>` | 不带 `--download` 时打印 `<task_id> <state>`。只用一个 id：再给一个会被忽略，而不是报错。任务归属于提交它的账号，所以命令会在账号池里找一个匹配的。 |
| `batch` | 按 `batch_id` 查询一次批量任务，并可选地取回已完成的部分。 | `<batch-id>` `--download` `--wait` `--out <dir>` `--slug <name>` | 不带 `--download` 时每份文档打印一行 `<文件名> <状态>`。`--wait` 轮询到每份文档都进入终态。`--slug` 只对单文档批次有效。批次归属于提交它的账号，所以命令会在账号池里找一个匹配的。 |

解析的默认值来自配置：`vlm`、`ch`、OCR 关、公式与表格开。写在命令行上的参数只对本次调用覆盖配置。

## 怎么读返回的路径

- stdout 每行一个 Markdown 绝对路径，别无其他。进度、告警与错误走 stderr，所以输出可以直接管道。
- 布局是 `<cwd>/tmp-doc/<YYYY-MM-DD>/parse-<slug>-<HH-MM-SS>-<随机>/<slug>.md`。Markdown 旁边的目录里放着它相对引用的 `images/` 与 JSON，所以要移动或复制就搬整个目录，绝不要只搬那个 `.md`。
- `<slug>` 从来源名生成：文件名去掉扩展名，来源是 URL 时是主机名加最后一段路径。`A-Za-z0-9-` 之外的每个字符都变成 `-`，结果截到 48 个字符，剩下的内容不可用时取名 `document`。
- `--out DIR` 只替换 `tmp-doc/<日期>` 这一段，所以 `--out ./docs` 写出 `./docs/parse-report-.../report.md`。
- 已存在的名字绝不覆盖：撞名时先追加 `-1`，再追加 `-2`。
- `--output json` 把同样的结果包成一个对象：失败的文档没有 `md_path`，`error` 只在失败时出现。这个对象在调用真的到达服务之后才出现：还没开始就被拒的输入（例如本地文件不存在）以退出码 2 结束，只在 stderr 留一行 `error:`，没有 JSON。

## 红线

- 绝不要向工具索要文档内容。读它打印出来的路径。
- 不要为了看输出而重跑一次转换：那会花额度，并留下第二份拷贝。
- 不要把 Token 写进你会上交的文件。它属于 `~/.docparse/config.toml`、某个环境变量，或某一次调用的命令行。
- 对以退出码 5 结束的调用，不要拿同一把凭证重试：退出码 5 意味着账号池里每一个账号都被拒绝了。

## 错误

| 码 | 含义 | 处置 |
|---|---|---|
| 退出码 5 | 每个账号都被拒绝。 | 用 `docparse account test` 核实或更换凭证。重试同一次调用不会改变结果。 |
| 退出码 6 | 上游失败，或等待超时。 | 消息里带着厂商给的原因，厂商给了错误码时也带着码。`task_id` 用 `docparse task <task_id>` 重新查询；`batch_id` 用 `docparse batch <batch_id>` 重新查询。不要重新提交文档。 |
| 退出码 7 | 部分文档成功。 | 已经打印的路径依然有效。只重新提交失败的那些输入。 |
| `-60008` | 厂商取不到你的 URL。 | 先把文件下下来，改传本地路径。 |
| `-30001`、`-30003` | 输入超出了 `flash` 的上限。 | 用 `parse` 转换这份文档。 |
| `-60018` | 厂商拒绝了这次调用：当日页数额度已用完。 | 账号池会把该账号停用到次日，所以今天用它重试不会成功。换一个账号仍然可用，`docparse quota` 会报告还剩多少。 |
| 其余任何码 | 厂商给了一个工具没有释义的码。 | 保留消息原样，没有理由就不要重新提交该文档。`references/errors.md` 里列出的码不归这一行管：以那张表的「重试」列为准。这次调用以退出码 6 结束。 |

其余的码、各自的含义，以及哪些失败值得重试，都在 `references/errors.md`。
