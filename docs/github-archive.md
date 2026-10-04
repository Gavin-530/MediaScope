# GitHub 平台本地档案

本档案仅绑定 github.com/Gavin-530/MediaScope，数字仓库 ID 1377031380。名称、主机和数字 ID 必须同时匹配；fork、贡献者、跨仓库链接仅保留关联元数据。不扫描账号，不修改远端，不自动启动同步，不建立计划任务，不重启应用。

## 命令

在项目根使用 Node.js 22 或更新版本和 Windows PowerShell 5.1：

```powershell
npm run github:inventory
npm run github:migrate
npm run github:sync
npm run github:list
npm run github:status
npm run github:verify
npm run github:reindex
npm run github:boundary
npm run github:prune
npm run github:prune -- -Plan 'D:\Projects\MediaScope\.build\github-archive-implementation\prune-plan-<时间>.json' -Apply
npm run github:backup -- --backup 'E:\MediaScope-backups'
```

inventory 先只读盘点本地证据、发布包、数字身份、功能和权限；报告保存在 .build/github-archive-implementation。migrate 校验并复制有可靠 GitHub 清单身份的记录，保存映射，实际进行独立复制和原路径恢复试验，保留全部旧源。sync 必须先有身份盘点；只发起读取请求。默认总时间 30 分钟、单次下载最多 3072 MiB，可显式指定 --budget-minutes 和 --max-download-mib；限额不触发历史删除。

凭证依次来自 GH_TOKEN、GITHUB_TOKEN、现有 Git credential helper，不写入档案或命令行。下载仅接受已核对的 GitHub 存储重定向，不转发认证头。网络、权限、404 未确认不存在、过期、进行中、等待和错误分别报告。首次及后续扫描都完整分页并复核第一页，不信任外来水位。中断后的正式记录保留；检查 pending/archive.lock 的进程及任务状态后才能人工处理遗留锁。工具不会根据 PID 猜测并自动删除锁。

旧 evidence:sync 仅作新 sync 的兼容入口；自动调用被禁用。手动云端导入入口为 github:import，需要 --archive、--run、--attempt；必须联网核对平台数字身份、run、attempt、job 和 artifact 摘要，验证 ZIP 及产品结果。未知或无平台摘要的外来文件不认证为可信云端测试，原件保留。

## 正式格式与边界

github-archive 是普通本地目录，根级 Git 忽略并登记为 protected；不初始化 Git、不提交、不上传。releases 仍是软件包唯一正式位置；.mediascope 用户资料不参与此流程。本地证据、混合维护记录、协作者原件和未知暂存留在 evidence-archive。

格式版本为 1，验证器为 scripts/github-archive-store.mjs 的 v1。repository.json 保存身份与版本。coverage.json 区分已配置类别、扫描完成程度、内容缺口和文件完整性，不能只凭分页完成或绿色工作流宣称全部归档。最新观察时间与历史采集窗口分别保留；多接口采集不是原子快照。

目录按原长版计划执行：job 位于 actions/<run>/attempts/<attempt>/jobs/<job>，通用产物位于同一 attempt 的 artifacts/<artifact>，产品证据位于 evidence/<内容摘要>。禁止写入 actions/<run>/artifacts；平台只提供 run 关联且已有多次 attempt 时，不猜测产物归属，下载内容保存在 pending 并报告 unresolved-attempt，确认独立来源后才能正式导入。仅有一次平台 attempt 的通用产物可确定归属 attempt 1。校验同时核对清单 object 与实际对象目录，不能只核对字节。

每个对象的 revisions/<UTC时间>-<摘要> 保存 archive-manifest.json、SHA256SUMS.txt 和声明的全部文件。清单保存相对路径、长度、SHA-256、稳定身份、采集窗口和来源时间。清单本身由 SHA256SUMS 覆盖；SHA256SUMS 不包含自己的摘要。验证器拒绝缺失、额外、摘要不符、路径穿越、链接及大小写冲突。SHA-256 检查完整性，不能认证作者身份。下载内容不执行。

比较规则版本为 1；download_count 被排除，重复观察只更新 latest.json 的 lastCheckedAt，历史字节不变。正文、状态和附件集合的变化新增快照。latest.json、index 和 HTTP ETag 缓存不是历史读取依赖，损坏的 HTTP 缓存重新请求。每次 sync 的报告是独立采集回执，因采集时间不同而新增；它不代表重复保存源内容。

迁入证据放在 actions/<run>/attempts/<attempt>/evidence/<内容摘要>/revisions 下。original 保留整份原始记录及旧清单，不改写历史格式；provenance.json 是外层来源、原路径和校验说明。旧格式内部 ZIP 与解包冗余保持原样，不进行未经验证的格式精简。新格式仅保留校验后的独立证据，不重复保存传输 ZIP。不同 run、attempt 和 job 不合并。产品验证继续调用既有证据验证器，完整性通过与产品回归通过分别判定。

## 范围和已知限制

当前采集器保存 Releases、所有工作流的不限定状态运行、每个可发现 attempt 的 jobs/steps 与原始可取得 job 日志、全部产物清单、产品证据及通用产物；另保存 Issues、PR、普通评论、评审、逐行评论与回复关系、事件、反应、检查及注释、仓库配置、标签、里程碑、分支、标签引用、可读规则与保护、环境、部署、协作者权限、runner 和脱敏 webhook 配置。每类失败和不可读接口明确列在回执。Issues 中 PR 不重复保存为 issue。PR 源码不整份归档。

Wiki 内容和正文附件仍有适配缺口；coverage 与回执不得把它们表示为已保存。仓库关联 Projects v2 和 Packages 使用固定仓库 GraphQL 读取查询，Packages 显式以实际仓库 node ID 过滤；不查询整个账号。当前凭证缺少这两类 scope 时记录无权限，不能推断空资料；有记录时目前保存关联元数据，完整内容适配另列缺口。PR 评审线程读取 resolved 状态及评论 ID，并与完整 REST 评论关联；超过评论 ID 页能力时明确报告未完成。Discussions 未启用时记录 not-enabled；启用后尚需适配。Pages 单次 404 只记为未确认；has_pages=false 可明确记为未启用。统计接口 202 表示等待生成。账号/组织审计、付款、账号级项目与外部服务明确排除。覆盖不承诺恢复已过期或删除的文件、两次观察之间未捕获的编辑历史。

refs 记录本地 Git 对象是否存在，缺失时明确报告，不自动拉取其他仓库。Release 附件按 asset ID、长度与实际摘要核对，本地包相同只建立 ../releases 相对关联；同名不同字节保留诊断并拒绝覆盖。平台独有说明附件保存到相应 release 的 asset 对象。复制单独档案时外部包可能缺失，验证报告分开列出，不能把它误报为正文损坏。

通用 artifact 的 attempt 若平台列表未提供可靠信息且无法由唯一 attempt 确认，保留在 pending，不把名称或最新 attempt 视为可信运行身份。产品导出器目前仅支持 full-regression 单 job；新增矩阵前须扩展身份和验证规则。网页附件不递归下载，离线依赖单列。

## 离线核对、搬移与恢复

每个封存目录可单独读取，JSON、正文、日志和原始证据均不依赖索引。独立副本可在复制验证器文件后离线使用：

```powershell
node D:\维护工具\github-archive.mjs verify --root 'E:\备份\github-archive'
node D:\维护工具\github-archive.mjs reindex --root 'E:\备份\github-archive'
```

backup 自动将命令行所需的 github-archive*.mjs（不含测试）与产品验证 PowerShell 工具一并复制到 verification-tools；可使用该目录的 github-archive.mjs 离线 verify/reindex。系统自带 PowerShell 可以直接核对任一独立封存目录，不需要网络、原项目或原盘符：

```powershell
$record = 'E:\备份\github-archive\actions\某运行\revisions\某快照'
$declared = @{}
Get-Content -LiteralPath (Join-Path $record 'SHA256SUMS.txt') | ForEach-Object {
  if ($_ -notmatch '^([a-f0-9]{64})  (.+)$') { throw 'Malformed checksum' }
  $expected = $Matches[1]; $relative = $Matches[2]
  if ($relative -match '(^[/\\]|:|(^|[/\\])\.\.?([/\\]|$))') { throw 'Unsafe path' }
  $file = Join-Path $record $relative
  if ($declared.ContainsKey($relative)) { throw 'Duplicate path' }
  $declared[$relative] = $true
  if ((Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash -ne $expected) { throw "Mismatch: $relative" }
}
$actual = @(Get-ChildItem -LiteralPath $record -File -Recurse -Force | Where-Object { $_.Name -ne 'SHA256SUMS.txt' -or $_.DirectoryName -ne $record })
if ($actual.Count -ne $declared.Count) { throw 'Unexpected or missing files' }
```

另阅读 archive-manifest.json 的 files 核对所有内容的长度、摘要及来源。原路径恢复：按照迁移 report.json 的 source/target 映射，把 target/original 的整份内容复制回 source 路径，在覆盖前先确认源不存在；不得只复制清单或依赖全局索引。

backup 使用归档写入锁、复制封存集合、生成外部备份清单、打包、在另一目录实际解包并离线校验；ZIP 摘要保存在包外。pending 和 HTTP 缓存不进入备份。备份不能放在被打包的档案内。真正独立存储由用户指定；项目内恢复试验不等于独立备份。

备份另带 verification-tools 中的系统 PowerShell 校验器和原始产品验证器，在解包后从复制的工具实际验证，不依赖原项目、网络或索引。verify-github-archive-standalone.ps1 只验证字节、清单和仓库身份，不认证作者或测试成功。备份回执区分同卷恢复试验与用户选择的其他卷，不声称不同盘符一定是不同物理存储。

当前 migrate 不删除旧源。github:prune 默认只生成精确清理计划：核对既有复制迁移回执、原路径、GitHub 运行身份、新封存校验、全部原始字节及产品验证，并逐份实际复制和验证原路径恢复。显式传入该计划并使用 -Apply，才会清理完全匹配的旧 records 子文件夹；本地、混合、未知及接收原件不纳入。操作同时持有证据记录锁与平台归档锁，先验证全部候选，再逐份移入本工具暂存、按文件摘要删除，并封存去向和释放体积。源或目标变化时停止；删源中断可按原计划续作，旧路径可由新封存 original 恢复。boundary 将有完整封存回执且目标原件仍通过校验的精确迁出与其他旧文件损坏分开报告。

恢复单份已清理原路径使用 `powershell -NoProfile -ExecutionPolicy Bypass -File scripts/prune-github-evidence.ps1 -Plan '<上述计划的绝对路径>' -RestoreSource 'evidence-archive/records/<原记录名>'`；拒绝覆盖已有路径。普通 sync 不删除旧源、正式历史或未知暂存。阶段 F 的条件是新目标完整且实际确认可恢复；独立存储备份仍是阶段 G 的单独验收要求，未落实时不能宣布全部归档完成。

外来同格式副本可用 github:merge -- --source <独立档案目录> 接收。先核对仓库 ID、路径与全部封存摘要；相同对象同内容跳过，独有历史保存到 supplements/received，并保留原封存字节与来源声明。不采用对方锁、凭证、续传状态或 latest 指针，不覆盖本机当前观察。自带摘要只能证明自洽性，来源标记为未确认；未经平台身份与产物摘要验证的测试声明不会进入可信云端测试列表。源副本不删除，之后仍须显式全量联网核对当前仓库。
