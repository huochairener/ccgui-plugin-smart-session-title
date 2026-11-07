# 智能会话命名（smart-session-title）

CC GUI 插件：每轮对话结束后，自动为会话生成一个**带 emoji 前缀的简短标题**，替代官方"第一条消息原样截断 80 字"的自动命名。

## 工作方式

1. 监听事件总线 `usage://updated` / `usage://done`，按会话防抖 8 秒合并一轮内的事件（与官方 auto-title 相同的触发模式，支持全部引擎）
2. 用 `node`（`exec:node`）读取 `~/.ccgui-next/app.db` 的会话全文索引——payload 全部内嵌在 `-e` 脚本里，不依赖命令行参数传递
3. **AI 模式**（默认）：用 `exec:<引擎>` 直调该引擎 CLI 的一次性命名调用（默认跟随会话引擎，可固定引擎/模型），标题自带一个贴合主题的 emoji；CLI 报错、超时或未安装时自动回退**本地规则**——清洗第一条用户消息（去盘符路径、代码块、斜杠命令、客气前缀）后智能截断，emoji 按关键词映射挑选（🐛 修复 / 🚀 部署 / 🎨 前端…，无匹配时用 💬）
4. 标题写入 `sessions.custom_title`，调 `ctx.sessions.refresh()` 让侧栏立即刷新

手动改名的会话永远不会被覆盖。

### 命名调用不会在侧栏留下多余对话

引擎每次被拉起都会把那次调用落盘成一份会话记录，宿主历史扫描器再按「记录里的 cwd
是否属于某个已登记工作区」把它收成侧栏会话。命名调用如果沿用被命名会话的工作区，
侧栏就会多出一条标题为「你是对话标题生成器…」的对话（实测确实如此）。

本插件因此不走 `ctx.agent.start`（宿主那条路会按正常引擎管线落盘），而是直调 CLI 并
统一带上各引擎官方的**不落盘参数**，让会话记录从一开头就不产生：

| 引擎 | 参数 | 官方语义 |
|---|---|---|
| pi / omp | `--no-session` | `Don't save session (ephemeral)` |
| claude | `-p` + `--no-session-persistence` | `Disable session persistence - sessions will not be saved to disk and cannot be resumed (only works with --print)` |
| codebuddy | `-p` + `--no-session-persistence` | `Disable session persistence - sessions stay in memory and are not saved to disk` |
| codex | `exec --ephemeral` | `Run without persisting session files to disk` |

另外 claude/codebuddy 还带 `--output-format text`，pi/omp 额外带
`--no-tools --no-extensions --no-skills --thinking off`，codex 带 `--sandbox read-only
--skip-git-repo-check`——命名只需要一段文本输出，不需要工具、扩展与工作区上下文。

> 这些参数均来自本机已安装 CLI 的帮助文本与二进制/源码内字串核对（不是凭记忆写的），
> pi 还追到了实现：`createSessionManager()` 命中 `noSession` 时直接返回
> `SessionManager.inMemory(cwd)`，不创建会话文件。旧版 CLI 不认识参数时会直接报错退出 →
> 插件记日志并退回本地规则，**不会退化成污染侧栏**。

### prompt 为何要先洗字符

Windows 上 `pi` / `claude` 往往是 npm 的 `.cmd` 垫片，宿主会包成 `cmd /c <垫片> <args…>`
启动（`engine/resolve.rs::windows_wrapper`）。cmd.exe 会对命令行**再解析一次**：参数里的
`"` 会提前结束引号，`%VAR%`、`&`、`^`、反引号、换行也会被吃掉。实际后果：一段多行
prompt 只有开头一句能送到模型那里，模型回「好的，请提供对话内容」——而子进程是正常
退出的，所以不报错，只静默出垃圾标题。

CLI 侧没有通用的「从文件读 prompt」通道（只有 codex 有 `--prompt-file`），宿主
`plugin_exec_run` 的 stdin 又是 `null`，因此本插件在把素材放进 argv 前，先把
`" ' `` % & | < > ( ) { } [ ] $ ; : ! \` 与换行压成空格并限制总长；提示词自身也避开
这些字符（分隔符用全角「」而不是尖括号）。洗掉的只是标点，不影响命名质量。

## 状态反馈（右下角状态栏）

- `✦ 会话命名中…` —— 正在命名
- `⚠ 命名失败` —— 出错常驻显示，**鼠标悬停看原因**，点击进设置页；下次成功自动消失
- `✓ 已命名：xxx` —— 成功提示，6 秒后消失

所有步骤写入调试日志（设置页可见最近 12 条，完整文件在插件数据目录 `debug.log`），排障不靠猜。

## 安装

1. CC GUI 侧边栏 →「插件」→「从本地目录安装」
2. 选择本目录（包含 `manifest.json` 的这一层）
3. 依赖系统 PATH 里有 `node`（≥ v22.5；本机为 v24.4.0，已由其他插件的 node 调用验证可用）
4. AI 命名需要对应引擎的 CLI 已在 PATH 里且已登录：`pi` / `omp` / `claude` / `codebuddy` / `codex`；
   没装则该项自动退回本地规则（仍能自动命名，不会报错卡住）

## 使用

- **自动**：正常聊天即可，每轮结束 8 秒后侧栏标题自动更新
- **手动**：会话列表右键 → 「智能命名（AI 重新起名）」/ 「恢复默认标题」；命令面板搜「智能命名」可给最近会话起名
- **设置**（插件页 → 智能会话命名）：
  - 命名方式：AI 智能命名 / 本地规则 / 关闭
  - 标题 emoji：开启 / 关闭（只影响之后的命名；emoji 不计入最大长度）
  - 命名引擎：留空 = 跟随会话引擎；可固定 pi / omp / claude / codebuddy / codex
  - 命名模型：留空 = 引擎默认模型（claude 缺省用 haiku，命名不需要大模型）
  - 标题语言 / 最大长度（8–60 字，不含 emoji 前缀）
  - **「测试完整链路」**：检查 node 与数据库，并为最近会话实际触发一次命名
  - 底部实时显示调试日志与最近错误

## 出问题时怎么排查

1. 打开插件设置页，点「测试完整链路」——每一步的成功/失败都直接显示
2. 看右下角状态栏的 ⚠ 提示（悬停显示原因）
3. 设置页底部有完整调试日志（含每次事件触发、node 调用、CLI 命名调用与退出码、写入结果）

## 迭代 / 卸载

- 改完代码后重新走一次「从本地目录安装」即可热重载（同 id 覆盖，配置保留），无需重启应用
- 卸载在插件页操作；插件数据保留 30 天

## 与官方 auto-title 的差异

- 官方插件依赖 `exec:python3` 读库——Windows 上若只有 Microsoft Store 的 python3 占位 stub 会一直"生成失败"；本插件用 `exec:node`（node:sqlite 内置，零依赖）
- 官方只支持 codex / omp / pi / claude 四个引擎；本插件的**触发与写入**按引擎无关设计，grok / codebuddy 等同样能自动命名
- 命名调用统一带各引擎的不落盘参数（见上节），不给会话列表与引擎历史留垃圾

### 引擎支持范围

| 会话引擎 | 自动命名 | 标题来源 |
|---|---|---|
| pi / omp / claude / codebuddy / codex | ✅ | 模型（需该 CLI 已安装并登录） |
| grok / kimi / gemini 等未内置后端的引擎 | ✅ | 本地规则 |
| 全部引擎 | ✅ | 触发、写库、侧栏刷新机制一致 |

上表里没内置后端的引擎（如 grok）会自动走本地规则，仍然会自动命名与加 emoji，
只是标题来自关键词规则而非模型。`sessions` 表里出现过的 engine 字段为
`claude / codex / codebuddy / grok / pi`，其中四个已内置后端。
