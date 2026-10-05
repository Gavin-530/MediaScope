# 数据与归档

目录分类由 `local-data-policy.json` 和 `scripts/local-data.ps1` 实施。Git 忽略、清理保护和独立备份是三件事：忽略不表示可删除，项目清理保护不能防止手工覆盖或磁盘故障。测试通过条件统一见[测试规范](testing.md)。

## 日期与时间

- 绝对时间统一 UTC、大写 `T` 和 `Z`。数据、API、日志、正文及界面用 RFC 3339 格式 `2026-10-05T03:04:05Z`；文件名和目录名的时间片段用 ISO 8601 基本形式 `20261005T030405Z`。
- 默认到秒；小数秒以点分隔，至少一位数字（如 `.123Z`）。来源已有的小数位保留，不补零、不截断。
- 日期用 `YYYY-MM-DD` 并注明时区，新生成日期优先 UTC；地区日期注明时区名称（如 `Asia/Shanghai`）。来源时区未知时标记未知，不猜测、不补午夜。
- 视频时间轴、时长与耗时保留原时间基及单位。历史原件及命名保留，迁移另行决定。

兼容性保留：任务排队、开始和结束时间用于耗时及排序，盘点、清理计划和备份名称用于减少重名，继续使用毫秒精度。新测试编号使用秒加随机编号；读取兼容旧格式。

## 目录和保留

| 位置 | 用途及边界 |
| --- | --- |
| `docs/`、项目 Git | 当前正式文档、源码、工具与工作流；随对应代码提交 |
| `local-notes/` | 本机计划、历史安排、操作回执和研究参考；整根忽略、受保护、另行备份；命名见[文档管理](README.md) |
| `.mediascope` / 安装根的 `data` | 软件运行数据，保留规则见下节 |
| `.mediascope-saved-media` | 旧版明确保留的实验视频迁移位置；不自动清理 |
| `evidence-archive/records` | 本地测试、维护和协作者记录；执行结束后可逐份复制或删除，不自动过期 |
| `evidence-archive/pending` | 运行、中断和归档失败暂存及锁；不自动清理旧项 |
| `evidence-archive/inbox`、`received` | 待接收原件、已接收原件和回执；禁止广泛清理 |
| `github-archive/` | 当前仓库的平台历史与云端证据；整根忽略、长期保护，不自动过期 |
| `releases/` | 发布包唯一正式位置；ZIP 不进入 Git，测试清理不得触及 |
| `local-test-archive` | 旧位置；明确迁移并验证前保留 |
| `test-work/acceptance-20260921` | 历史验收资料；清理保护 |
| `test-work`、`.build` | 生成项与未知/恢复资料混存；只回收明确属于本次任务或显式类别的可重建内容 |
| `.build/downloads`、`node_modules` | 下载缓存 / 可由锁文件重建的开发依赖 |

本地测试不向开发版运行目录写入结果。成功任务先保存必要结果再回收自身沙箱，不为每次可重建媒体、浏览器或运行时保存永久副本。用户导出的报告、视频、接收原件、未知项及历史验收材料不能因“不属于源码”删除。

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/local-data.ps1 -Action Status
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/local-data.ps1 -Action Verify
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/local-data.ps1 -Action Clean -Category TestGenerated
```

`Clean` 默认预览，核对后加 `-Apply`。`TestGenerated` 仅选择已知生成命名；`BuildStages`、`Downloads` 是其他显式类别。保留路径边界、目录链接、受保护资料和活动进程检查。通用清理不得删除平台档案根、其子目录或包含它的上级目录。`archive-test-generated.ps1` 是特殊情况下的显式素材快照工具，不是普通清理前置要求；构建维护不自动处理未知项或旧 pending。

## 软件运行数据

源码版 `.mediascope` 和安装版 `data` 使用相同规则：最近 10 次成功、失败或取消的已结束任务，合计不超过 100 MiB，按结束时间跨重启计算。活动和排队任务不参与淘汰。启动恢复近期结果供查看、导出和重排队，不自动恢复未运行队列；超限删除最旧结果。单份超限报告只在当前会话保存，须导出长期保留。读取中的导出暂缓清理，可能短暂超限。

任务结束后回收中间媒体和日志，最终指标在报告中保留。保存实验视频须选择运行目录外的位置，输出进入任务 ID 子目录；旧版明确保留的视频迁到运行目录旁的 `<运行目录名>-saved-media`，失败保留原件并报错。

`desktop-profile` 是专用 Edge/Chrome 配置，启动前处理上次遗留，退出后等待浏览器结束再删除。`settings.json` 保存主题和“退出后清空近期记录”。界面提供占用查询、清空近期记录、清理运行缓存和退出清空选项。100 MiB 上限不包含活跃任务、会话大报告及活跃浏览器缓存；未知项不自动删除。

软件及相关浏览器退出后，可手动删除源码版整个 `.mediascope`，或安装根内整个 `data`；这会清空近期结果及偏好，不影响原始媒体、外部导出、独立测试记录或私有运行时。通用测试/构建清理工具不负责此运行目录。

## 本地测试证据

每次命令执行保存一份 `evidence-archive/records/<来源时间>-<唯一编号>/`。记录不共享必需附件、不依赖其他测试记录或全局索引，单份复制后仍可读取和校验。新运行使用 UTC 秒编号 `YYYYMMDDTHHmmssZ` 加随机编号，目录中的时间片段使用相同基本形式；历史秒、日期和未知时间保留原精度，不补造。

新产品记录使用 `evidenceRevision: 2`；App manifest 为 schema 3，包、部署和 Custom 为 schema 2。

| 文件 | 内容 |
| --- | --- |
| `manifest.json` | 身份、时间、范围、Git/包及验证器身份、环境、命令、结果和完整性 |
| `results.json`、`features.json` | App 逐项结果及功能映射状态 |
| `measurements.json.gz` | 有实际测量时保存完整报告、日志和数值，无损压缩 |
| `deployment-results.json` | 包/部署结构化断言，成功须有非零检查 |
| `output.log.gz` | 本次原始输出；记录器按实际压缩状态声明文件名 |
| `diagnostics/`、`sandbox-diagnostics/` | 必要失败诊断 |
| `origin.json` | 云端导入的 CI 步骤状态、原清单及传输摘要 |
| `SHA256SUMS.txt` | 本份内容的一层校验清单，不认证作者或来源 |

新记录不另套 `record.json/README/original`，不保存整份源码、项目文档、模拟档案/回执或可重建媒体与运行环境。Git SHA、未提交状态和内容摘要识别测试输入；未保存的未提交源码不保证精确重现。若确需保留特殊输入，应放在该份目录并说明用途。证据体积不是通过条件，不为精简而丢测量或隐藏失败。

```powershell
npm run evidence:list
npm run evidence:verify
npm run evidence:verify -- -Record 'records/<记录名>'
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/verify-test-evidence.ps1 -Record 'E:\备份\某份记录'
npm run evidence:list -- -Scope all
```

`list/verify` 默认本地范围，`-Scope github` 明确平台范围，`-Scope all` 综合核对。综合列表优先显示新位置的云端产品记录；带 GitHub 关联的独有维护报告仍以 `maintenance-with-github-association` 显示，不能仅按相同 run/attempt 隐藏。`catalog.json` 是可重建缓存，其缺失或损坏不阻塞无关测试；某记录损坏不应阻止其他记录保存。

执行结束的正式记录可整份复制、备份或删除，删除不改变其他记录，不要求修复索引。启动及测试不自动同步云端历史，显式同步仍可能重新取得远端保留的内容。pending、锁及活动目录须先检查进程与状态；恢复入口见[测试规范](testing.md)。

### 协作者资料与历史维护

收到完整记录或整个 `evidence-archive`，放入本机 inbox 后执行 `npm run evidence:import` 预览；核对后用 `npm run evidence:import -- -Contributor 'Alice' -Apply`。`-Folder` 可指定外层目录。按实际记录验证，不信任外来 catalog，同身份同内容跳过、冲突拒绝覆盖；跳过对方 inbox、received、pending、tools，不执行对方程序。贡献者字段是接收者填写的声明，不是认证。received 原件及回执保留，但不构成产品记录读取依赖。

旧 schema、`evidenceRevision 0/1` 及封装继续原样读取，普通运行不改写旧记录。显式 `scripts/maintain-test-evidence.ps1` 默认预览，`-Apply` 取得锁后逐份校验、暂存、核验保留内容再替换；中断保留 `.build/evidence-maintenance-*` 事务资料。

整理结果用独立的 `archiveRevision: 1`，保留原运行身份、计数、结果和时间精度，记录迁移来源与原摘要，不补造功能映射或测量。目录统一为 records，未知时间用 `undated`。可回收源码/验证器 ZIP、模拟资料、生成媒体和环境副本；移除的清单字段记录在 `archive.discardedManifestFields`。实际历史附件无损收入 `historical-data.json.gz`，逐项保存原路径、长度、SHA-256 和 base64 字节，验证器核对并可恢复原文件。

有最终清单的阻塞记录可经维护封存；未完成汇总的中断运行只保存已有日志、事件、测量及中断说明。旧下载/导入暂存只有在永久目标完整校验、传输身份/原摘要及逐份原始字节一致后才可回收。空 `recording.lock` 是互斥载体，文件存在不代表锁被持有；用独占打开核对。`migrate-test-evidence.ps1`、`organize-test-evidence.ps1` 为显式旧目录维护入口，不是新测试前置步骤。

<!-- github-archive-readme:start -->
## GitHub 平台档案

范围固定为 `github.com/Gavin-530/MediaScope`，数字仓库 ID `1377031380`，名称、主机和 ID 同时匹配。fork、贡献者、跨仓库链接只保存关联元数据，不扩展到账号或其他仓库。数据在普通本地 `github-archive/`，不初始化 Git、不上传；同步只读远端、不重启应用、不创建计划任务。

### 操作入口

在完整项目根使用 Node.js 22+ 和 Windows PowerShell 5.1：

```powershell
npm run github:inventory
npm run github:migrate
npm run github:sync
npm run github:list
npm run github:status
npm run github:verify
npm run github:reindex
npm run github:boundary
npm run github:backup -- --backup 'E:\MediaScope-backups'
```

`inventory` 先盘点本地身份、证据、发布包和远端能力/权限，回执在 `.build/github-archive-implementation`。写入前须有成功联网核对仓库身份的盘点；`migrate` 校验后复制可靠云端记录，保存映射并实际验证独立复制与原路径恢复，保留旧源。`sync` 每次完整分页并复核首页，默认 30 分钟、单次下载 3072 MiB，可用 `--budget-minutes`、`--max-download-mib` 降低或在支持范围内调整；到限额留下缺口/检查点，不删除历史。旧 `evidence:sync` 为兼容入口，启动和测试均不自动同步。

鉴权依次使用 `GH_TOKEN`、`GITHUB_TOKEN`、现有 Git credential helper，禁用交互，不保存凭证。只接受核对过的存储重定向，不转发认证头。区分等待、权限不足、过期、未确认不存在、错误和内容缺口；不采用外来续传水位。遗留 `pending/archive.lock` 先核对进程和任务，不能据 PID 猜测自动删锁。

手动导入用 `npm run github:import -- --archive <ZIP> --run <run-id> --attempt <attempt>`，联网核对仓库、运行、attempt、job、artifact 摘要及产品门槛，不执行下载程序。新版 transport schema 2 只留下验证后的独立记录及 `origin.json`，不保存重复 ZIP；schema 1 继续原样读取。CI 步骤状态与测试断言结果分别保留；整个工作流最终状态还须看平台。显式提供的原件不删除，未知来源或无对应平台摘要的外来声明不认证为可信云端测试。

### 格式、身份和内容变化

格式版本为 1，验证器为 `scripts/github-archive-store.mjs`。`repository.json` 保存身份，`coverage.json` 分别说明扫描覆盖、内容缺口及文件完整性；多接口采集不是原子快照。

| 对象 | 正式位置 |
| --- | --- |
| Release、运行、Issue、PR | `releases/<id>`、`actions/<run>`、`issues/<id>`、`pull-requests/<id>` |
| job、通用 artifact | `actions/<run>/attempts/<attempt>/jobs/<job>`、同级 `artifacts/<artifact>` |
| 云端产品证据 | `actions/<run>/attempts/<attempt>/evidence/<内容摘要>` |
| 配置及补充资料 | `repository/`、`supplements/` |
| 操作回执 / 暂存 | `sync-reports/`、`migration-reports/` / `pending/` |

每个对象在 `revisions/<UTC时间>-<摘要>/` 封存，带 `archive-manifest.json`、`SHA256SUMS.txt` 和全部声明文件。清单列出稳定身份、采集窗口、来源时间、路径、长度和摘要；SHA256SUMS 覆盖清单本身，不覆盖自身。验证拒绝缺失、额外内容、摘要错误、路径穿越、链接、大小写冲突及清单与实际对象目录不符。

禁止 run 层 `actions/<run>/artifacts`。仅有一次平台 attempt 时可确定通用产物属于 attempt 1；多次重跑且无可靠归属时保存在 pending，报告 `unresolved-attempt`，不按名字或最新 attempt 猜测。不同 run、attempt、job 不合并。

比较规则版本为 1，排除 `download_count`；源正文、状态或附件集合变化新增快照，相同内容更新 latest 检查状态，历史字节保持不变。每次同步回执独立保存，不等于重复源内容。`latest.json`、index 和 HTTP 缓存可重建，不是历史读取依赖；重建指针不证明当前远端状态。

迁入证据的 `original/` 保存原记录和旧清单，`provenance.json` 保存外层来源。旧封装内冗余未经验证不精简，新格式不重复保存传输包；原时间精度及产品门槛不变。SHA-256 能检查字节完整性，不能认证作者或单独证明测试通过。

### 采集能力与缺口

采集器保存 Releases、所有工作流不限状态的运行及可发现 attempt、jobs/steps、可取得日志、产物清单和内容；保存 Issues、PR、评论、评审及逐行回复、事件、反应、checks/statuses 和注释，以及仓库配置、标签、里程碑、分支、refs、可读保护/规则、环境、部署、权限、runner 和脱敏 webhook。PR 不另存为 Issue，PR 源码不整份归档；缺失本地 Git 对象单列，不自动拉取其他仓库。

Wiki 正文、网页附件和已启用 Discussions 尚有适配缺口；Projects v2、Packages 按固定仓库 GraphQL 查询关联元数据，完整内容另列缺口，无权限不能推断为空。评审线程超过评论 ID 分页能力时报告未完成。Pages 单次 404 不能证明未启用，`has_pages=false` 可以；统计 202 表示等待。账号/组织审计、付款、账号级项目和外部服务不纳入。

Release 附件按 asset ID、长度及摘要核对：软件 ZIP 仅在 `releases/` 保存，平台记录使用相对关联；说明附件保存在相应 asset 对象。同名异字节拒绝覆盖并保留诊断。单独复制平台档案不包含外部软件包，其缺失与平台正文损坏分开报告。过期/删除内容及两次观察间未捕获编辑无法凭当前状态恢复，不声明备份了全部 GitHub 历史。

### 清理、外来副本与恢复

`npm run github:prune` 只生成精确旧源清理计划。核对复制迁移回执、身份、目标完整性、产品验证和全部原始字节，并逐份实际测试原路径恢复；再显式执行：

```powershell
npm run github:prune -- -Plan '<清理计划绝对路径>' -Apply
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/prune-github-evidence.ps1 -Plan '<同一计划>' -RestoreSource 'evidence-archive/records/<原记录名>'
```

操作同时持有证据与平台锁，源/目标变化则停止，事务中断可续作；恢复拒绝覆盖已有路径。仅精确匹配的旧云端产品副本可清理，本地测试、独有维护、接收原件和未知项保留。普通 sync 不删除旧源或正式历史。确认可恢复与独立存储备份分别验收，不把删源完成当作全部归档或备份完成。`boundary` 区分有有效回执及目标原件的精确迁出与其他损坏。

外来同格式副本用 `npm run github:merge -- --source <独立档案目录>`，先核对身份、路径和全部摘要。相同对象同内容去重，独有历史保存到 `supplements/received`；原封存字节、来源声明和源副本保留。不采用对方锁、凭证、进度或 latest，不覆盖本机观察。自带摘要只证明自洽性，来源标为未确认，之后须全量联网复核。

封存 JSON、正文、日志及证据可离线读取。备份入口持锁复制正式集合、携带验证工具，生成外部清单和 ZIP，在另一目录实际解包并用复制工具验证；pending/HTTP 缓存不纳入。备份不能放在自身归档内，ZIP 摘要放包外。真正独立存储由用户选择；同卷恢复试验不能作为独立备份，不同盘符也不保证不同物理介质。

备份生成的 `verification-tools` 可离线运行，不需要原项目或网络：

```powershell
node '<备份目录>\verification-tools\github-archive.mjs' verify --root '<独立副本>\github-archive'
node '<备份目录>\verification-tools\github-archive.mjs' reindex --root '<独立副本>\github-archive'
powershell -NoProfile -ExecutionPolicy Bypass -File '<备份目录>\verification-tools\verify-github-archive-standalone.ps1' -Root '<独立副本>\github-archive'
```

系统 PowerShell 校验器检查字节、清单和仓库身份，不认证作者或产品通过。任一文件可用 `Get-FileHash -LiteralPath '<文件>' -Algorithm SHA256` 对照 SHA256SUMS；完整目录验证还须核对所有声明、额外文件及路径，不能只查一份文件。按迁移回执 source/target 映射恢复原路径时，复制 target 下整份 original，并先确认源不存在。

完整项目恢复还需分别备份 `releases/`、项目 Git、本地笔记和用户导出资料；平台备份不包含这些，也不包含未完成暂存。历史内容与恢复回执不能仅依赖 `.build` 缓存保留。
<!-- github-archive-readme:end -->
