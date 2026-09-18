# 安装与配置

首次使用时加载本文件，或当某个凭证、某个上游地址、某个账号池设置、或 skill 的安装发生变化时加载。常见路径一项都不需要。

## 安装

工具是一个 Node 包，需要 Node 18.17 或更新。

```sh
npm install -g docparse-cli
docparse --version
```

## 首次运行

```sh
docparse config init                     # 写出带注释的配置模板
docparse account add --token <TOKEN>     # 存一个账号；做账号池就重复几次
docparse account test                    # 探活凭证，不花额度
docparse doctor                          # 自检，有检查项报错时退出码 3
```

在 `https://mineru.net/apiManage/token` 创建 Token。`docparse account test` 查的是一个不存在的 task id，所以「找不到任务」这个答复就意味着凭证被接受了。

## 把此 skill 安装到某个 Agent

```sh
docparse skills install                  # 默认目标：codex
docparse skills install --target all
docparse skills status
```

| 目标 | skills 根目录 |
|---|---|
| `codex`（默认） | `~/.agents/skills` |
| `pidesktop` | `~/.agents/skills` |
| `claude` | `~/.claude/skills` |
| `cursor` | `~/.cursor/skills` |
| `hermes` | `~/.hermes/skills` |

`--skills-root DIR` 对每个目标替换 skills 根目录，`skills update` 就是再跑一次 `skills install`。被复制过去的目录里含本入口文件、两个 reference，以及它们各自的译本。

## 凭证

Token 有三种给法。第一种是持久的，第二种适合容器，第三种适合单次调用。

```sh
docparse account add --token <TOKEN> --name main --weight 2   # 配置文件
docparse parse ./report.pdf --token <TOKEN>                   # 仅本次调用
```

第二种是在调用前把 `DOCPARSE_TOKEN` 设进调用方的环境；调用方借此传入 Token，而不必写进文件。环境变量怎么设是 shell 的事，其余变量见下表。

多配几个账号，调用就会分散到它们上面：优先在途最少的，其次最久未使用的，再看 `weight` 更高的。失败的账号会被冷却并跳过：Token 被拒或过期（`A0202`、`A0211`）冷却 24 小时；当日额度用尽（`-60018`）冷却到次日；限流或上游抖动则短时冷却。冷却状态存在 `~/.docparse/state.json`，以凭证的哈希为键，绝不以凭证本身为键。

自建或网关部署用 `--base-url` 指定，或在账号上写 `base_url`。需要自定义请求头的网关，在配置文件里声明它，其中 `${token}` 会被替换：

```toml
[[account]]
name = "gateway"
token = "..."
base_url = "https://gw.example.com"
headers = { Authorization = "Bearer ${token}" }
```

| 环境变量 | 作用 |
|---|---|
| `DOCPARSE_TOKEN` | 一个 Token。 |
| `DOCPARSE_TOKENS` | 逗号分隔的多个 Token，组成一个池。 |
| `MINERU_TOKEN` | 等同于 `DOCPARSE_TOKEN`，用于兼容 MinerU 自家工具。 |
| `DOCPARSE_BASE_URL` | 上游地址。 |
| `DOCPARSE_CONFIG` | 配置文件路径。 |
| `DOCPARSE_HOME` | 数据目录，存放配置文件与状态文件。 |
| `DOCPARSE_MODEL_VERSION`、`DOCPARSE_LANGUAGE`、`DOCPARSE_OUTPUT_ROOT` | 对应的配置项。 |
| `DOCPARSE_DEBUG` | 设成任意非空值，失败时会把上游响应细节附到 stderr。 |

## 配置项

文件是 TOML，默认在 `~/.docparse/config.toml`，除非被 `--config`、`DOCPARSE_CONFIG` 或 `DOCPARSE_HOME` 挪走。`docparse config set <键> <值>` 只接受下表这些键；账号块请直接编辑文件。

| 键 | 默认值 | 含义 |
|---|---|---|
| `base_url` | `https://mineru.net` | 上游地址，用于自建或网关部署。 |
| `parse.model_version` | `vlm` | 解析模型：`pipeline`、`vlm` 或 `MinerU-HTML`。来源是 HTML 时用 `MinerU-HTML`。 |
| `parse.language` | `ch` | OCR 语言。 |
| `parse.is_ocr` | `false` | 强制 OCR。 |
| `parse.enable_formula` | `true` | 识别公式。 |
| `parse.enable_table` | `true` | 识别表格。 |
| `parse.poll_interval_sec` | `5` | 轮询间隔秒数，最小 1。 |
| `parse.poll_timeout_sec` | `1800` | 每次调用的总等待秒数，最小 5。`--timeout` 覆盖它。 |
| `parse.max_upload_mb` | `200` | 本地上传上限，最小 1。厂商同样限制 200 MB。 |
| `output.root` | `tmp-doc` | 输出根目录，相对工作目录。 |

每个 `[[account]]` 块接受 `name`、`token`、`base_url`、`headers`、`weight`、`enabled`。

## 管理类命令

这里的每条命令也都接受 `--output json`。

| 命令 | 描述 | 参数 | 备注 |
|---|---|---|---|
| `config path` | 打印配置文件路径。 | | |
| `config show` | 打印生效的配置与账号池。 | | |
| `config init` | 写出带注释的模板。 | `--force` | 不带 `--force` 时已有的文件保持不动。 |
| `config set` | 修改单个键。 | `<key> <value>` | 键不在上表内时报退出码 2。 |
| `account list` | 打印账号池与冷却状态。 | | |
| `account add` | 添加账号。 | `--token <token>`、`--name <name>`、`--base-url <url>`、`--weight <n>` | 多跑几次即可组成账号池。这里的 `--base-url` 会写进该账号的记录，让这个账号长期用自己的上游；同名的全局参数只覆盖一次调用。 |
| `account remove` | 删除账号。 | `<name-or-index>*` | |
| `account test` | 探活凭证，不花额度。 | `--name <name>` | 凭证被拒时退出码 5。 |
| `quota` | 按账号打印今日页数与文件数的「已用/上限」，以及累计用量。 | `--name <name>` | 读的是厂商自己的计数器。剩余页数在 `--output json` 的 `daily.left` 里。`total_left` 为 0 意味着免费额度已用尽，它不阻塞解析。 |
| `skills status` | 按目标打印安装状态。 | `--target <list>`、`--skills-root <dir>` | |
| `skills install`、`skills update` | 把此 skill 复制到目标目录。 | `--target <list>`、`--skills-root <dir>` | |
| `doctor` | 检查 Node、配置文件、账号池、上游连通性与 skill 安装状态。 | `--target <list>`、`--skills-root <dir>` | 有检查项报错时退出码 3。 |
