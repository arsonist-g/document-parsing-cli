/** 帮助文本：既是 human 用法说明，也是 AI Agent 的调用契约。 */

export const USAGE = `docparse — 文档转 Markdown 命令行（基于 MinerU 解析 API）

用法：
  docparse [全局参数] <命令> [参数...]

命令：
  parse <文件或URL...>    精准解析 → Markdown；支持本地文件与 http(s) 链接，可批量
  flash <文件或URL>       Agent 轻量解析（免 Token，≤10MB / ≤20 页，只出 Markdown；只接受一个输入）
  task <task_id>          查询精准解析任务，--download 可直接取回结果
  batch <batch_id>        续查批量解析任务（--wait 轮询、--download 取回结果）
  config <path|show|init|set>   配置查看与修改（set 只接受白名单键，见下）
  account <list|add|remove|test>  解析账号池管理（多账号自动负载均衡）
  quota [--name <账号>]  查询账号的今日额度与累计用量（不消耗解析额度）
  skills <status|install|update>  把内置 skill 安装到 AI Agent 的 skills 目录
  doctor                  自检：配置、账号、上游连通性、skill 安装状态（有 error 项时退出码 3）

全局参数（可放在任意位置）：
  --config <path>         配置文件路径（默认 ~/.docparse/config.toml）
  --base-url <url>        上游地址，覆盖配置文件（默认 https://mineru.net）
  --token <token>         本次调用使用的 Token，可重复传入以临时组池
  --output json|text      输出格式，默认 text
  --timeout <秒>          等待解析结果的总超时，默认取配置 poll_timeout_sec
  -v, --verbose           打印 HTTP 请求与响应
  -h, --help              查看帮助
  --version               查看版本

parse / flash 的参数：
  --model <pipeline|vlm|MinerU-HTML>   模型版本（默认 vlm；HTML 文件用 MinerU-HTML）
  --language <ch|en|...>   OCR 语言（默认 ch）
  --pages <"2,4-6">        页码范围；flash 只支持 "1-10" 或单页，写得复杂会在上游报错（本地不校验）
  --ocr / --no-ocr         是否开启 OCR（默认关）
  --formula / --no-formula 是否开启公式识别（默认开）
  --table / --no-table     是否开启表格识别（默认开）
  --extra-formats <list>   额外导出格式，逗号分隔：docx,html,latex（仅 parse，对 HTML 源文件无效）
  --out <目录>             结果落盘目录，默认 <cwd>/tmp-doc/<日期>/
  --no-wait                只提交任务不等待结果（此时 stdout 输出 batch_id，随后可用 docparse batch 续查）

task 的参数：
  --download               结果已就绪时下载并解压
  --wait                   未完成时持续轮询等待
  --out <目录>             结果落盘目录
  --slug <名称>            输出文件名（默认取 task_id）

batch 的参数：
  --wait                   未完成时持续轮询等待
  --download               下载已完成的文档并解压
  --out <目录>             结果落盘目录
  --slug <名称>            输出文件名（仅单文档批次可用）

account 子命令：
  account list                                    查看账号池与冷却状态
  account add --token <t> [--name <n>] [--weight <w>]              添加官方 Token 账号
  account remove <名称或序号>
  account test [--name <n>]                       凭证探活（不消耗解析额度）

quota 的参数：
  --name <账号>            只查这一个账号，默认查账号池里全部可用账号
  输出 pages_today / files_today 为「今日已用/上限」；页数上限即官方说的最高优先级解析额度，
  用完后当天仍可解析，只是优先级降低。total_left 为 0 表示免费额度已用尽，不影响日常解析。

skills 子命令：
  skills status [--target codex,claude,...]       查看安装状态
  skills install [--target codex,...] [--skills-root <目录>]
  skills update  等价于 install（覆盖为当前版本）

config set 可用键（其余键请直接编辑配置文件）：
  base_url · output.root · parse.model_version · parse.language · parse.is_ocr ·
  parse.enable_formula · parse.enable_table · parse.poll_interval_sec ·
  parse.poll_timeout_sec · parse.max_upload_mb

输出约定：
  stdout 只输出结果——解析类命令是「Markdown 文件的绝对路径」，每行一个；
  进度、告警、错误一律走 stderr。--output json 时所有命令的 stdout 都是结构化 JSON。

退出码：
  0 成功 · 1 内部错误 · 2 参数错误 · 3 配置错误 · 4 网络错误
  5 账号/鉴权错误 · 6 上游解析失败（全部文档失败或提交阶段失败） · 7 部分成功（部分文档失败）

示例：
  docparse parse report.pdf
  docparse parse https://example.com/paper.pdf --pages 1-20 --out ./docs
  docparse flash scan.png
  docparse parse a.pdf b.pdf --output json
  docparse skills install
`;

export const COMMAND_HELP: Record<string, string> = {
  parse: `docparse parse <文件或URL...> [--model vlm] [--pages "1-20"] [--out 目录] [--no-wait]\n` +
    `把文档提交到 MinerU 精准解析，等待完成后把 Markdown 落盘，stdout 输出该文件的绝对路径。\n` +
    `--out 目录会替换掉默认的 tmp-doc/<日期> 这一段，产物是 <目录>/parse-<slug>-<时间>-<随机>/<slug>.md。`,
  flash: `docparse flash <文件或URL> [--pages "1-10"] [--out 目录]\n` +
    `免 Token 的 Agent 轻量解析，适合小文件快速预览；只接受一个输入（多个输入直接报错，批量请用 parse）。\n` +
    `stdout 输出 Markdown 文件的绝对路径；--out 语义同 parse。`,
  task: `docparse task <task_id> [--download] [--wait] [--out 目录]\n` +
    `查询任务状态；任务归属提交它的账号，命令会自动在账号池里找匹配的账号。`,
  batch: `docparse batch <batch_id> [--wait] [--download] [--out 目录] [--slug 名称]\n` +
    `续查一次批量解析（parse 的提交结果或 --no-wait 打印的 batch_id）；不加 --download 时每行打印 <文件名> <状态>。\n` +
    `--wait 会轮询到全部文档进入终态，--download 把已完成的文档落盘并打印 Markdown 路径；--slug 仅单文档批次可用。`,
  config: `docparse config <path|show|init|set>\n` +
    `path 打印配置文件路径；show 打印当前生效配置；init 生成带注释模板；set <键> <值> 修改单项。`,
  account: `docparse account <list|add|remove|test>\n` +
    `管理解析账号池；池内账号按「在途少 → 最久未用 → 权重高」自动负载均衡，失效账号自动冷却。`,
  skills: `docparse skills <status|install|update> [--target codex,claude,...] [--skills-root 目录]\n` +
    `把内置 skill（SKILL.md 与 references/ 整套）安装到 AI Agent 的 skills 目录；默认 codex 目标即 ~/.agents/skills/docparse。`,
  quota: `docparse quota [--name <账号>]\n` +
    `查询账号的今日额度与累计用量（GET /api/v4/extract/status，不消耗解析额度）；默认查账号池全部可用账号。\n` +
    `pages_today / files_today 是「今日已用/上限」；页数上限即官方说的最高优先级解析额度，用完后当天仍可解析、只是优先级降低。`,
  doctor: `docparse doctor\n自检：Node 版本、配置文件、账号可用性、上游连通性、skill 安装状态。`,
};

