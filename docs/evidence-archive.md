# MediaScope 测试归档

本文的正式记录范围为本地测试、维护和协作者资料。GitHub 平台及云端证据永久位置为 github-archive，见[平台档案规范](github-archive.md)。evidence:list/verify 默认本地范围；-Scope github 查看或校验平台记录，-Scope all 明确综合查看。复制迁移先保留旧云端源；显式 github:prune 经逐份原始字节、产品验证和实际恢复核对后可清理精确匹配的旧云端 records 副本。综合列表按运行身份优先显示新位置，不以清理完成推断独立存储备份已经完成。

维护报告可以带有 GitHub 运行关联，但关联不等于整份报告是重复的云端产品证据。此类独有报告保留，默认本地列表以 `maintenance-with-github-association` 明示，综合列表不能仅凭相同 run/attempt 隐藏它；原来源和关联字段继续显示。

每次测试命令执行对应 `records/<时间>-<唯一编号>/` 下一个独立文件夹。默认保存必要结果；有实测数据或失败诊断时才增加对应文件。记录之间不共享必需附件，不引用前置测试作为解读或校验条件。

## 新记录格式

新的产品记录使用 `evidenceRevision: 2`。App manifest 继续使用 schema 3，包、部署和自定义命令 manifest 继续使用 schema 2；不另套 record.json、README 和 original 封装。

| 文件 | 内容 |
| --- | --- |
| manifest.json | 运行身份、开始/结束时间、范围、版本、Git 提交及未提交状态、内容摘要、环境、命令、结果和验证完整性 |
| results.json | App 的逐项结果、耗时、失败信息及通过/失败/取消/跳过/TODO 计数 |
| features.json | App 的功能映射状态及缺少检查的文件；不是代码覆盖率 |
| measurements.json.gz | 本次实际报告、指标日志和比较双方数值；有测量才生成，无损压缩 JSON |
| deployment-results.json | 包/部署逐项断言；成功须有非零实际检查 |
| output.log.gz | 本次原始执行输出，压缩保存 |
| origin.json | 仅云端导入使用：CI 测试步骤状态、原始清单与传输摘要；不保留传输包 |
| diagnostics/ 或 sandbox-diagnostics/ | 失败时按需保存的截图、错误报告和相关日志 |
| SHA256SUMS.txt | 仅校验本文件夹内容的一层清单，用于检测文件损坏，不认证来源 |

正常结果可以较小；逐帧数据和必要诊断较大时允许增加。大小不是通过条件，不能为缩小文件而丢失必要测量或隐藏失败。不会保存完整源码 ZIP、项目 Markdown、模拟档案/回执、浏览器配置、运行时副本或可重建媒体，也不为被丢弃的每个临时文件保存摘要清单。

源码仍从独立临时工作区执行，测试结束后校验本次记录并原子移动到 records，随后回收本次沙箱。Git 提交、未提交状态和内容摘要用于识别实际测试输入；未提交源码未保存时不承诺将来能精确重现。读取数值和结果不需要原工作区或媒体文件。若某次检查确有保存特殊输入的必要，应将其放在该份目录中并说明用途，不能建立跨记录附件链。

## 查询、校验、复制与删除

```powershell
npm run evidence:list
npm run evidence:verify
npm run evidence:verify -- -Record 'records/<记录文件夹>'
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/verify-test-evidence.ps1 -Record 'D:\独立副本\某份记录'
```

查询和校验扫描实际记录，catalog.json 只是可重建缓存。缓存缺失、损坏、陈旧或历史索引引用缺失，不阻塞新测试。全量 verify 检查仍存在的各份记录；单份 verify 不读取其他记录。某份记录损坏应明确报告，但不阻止无关新测试运行和保存。

执行已经结束的 records 子文件夹可以整份复制、备份或删除。删除后不要求修改其他记录或修复索引；后续发布重建缓存。程序不自动删除已有档案。npm test 不再自动同步 GitHub 历史资料，避免删除后被后台补回；显式 evidence:sync 可重新下载仍可取得的远端记录。

pending 中保存运行锁、正在运行或中断的暂存和失败诊断，不应把活动目录当作已结束记录删除。失败、中断、未执行、部分验证与完整回归分别标识；删除记录不会改变其他记录的通过数。

## GitHub 和协作者传输

本地和 GitHub 使用相同产品记录格式。新版云端 transport schema 2 在导入时校验路径、摘要、仓库、提交、运行和重跑身份，以及成功 CI 的完整回归门槛；取出本次独立产品记录，不在正式档案中重复保存 ZIP 传输副本。初始化失败而没有产品记录时，可保留明确标识的诊断包，不伪造通过结果。

收到一份完整记录或整个 evidence-archive，可放入本机 inbox，再运行：

```powershell
npm run evidence:import
npm run evidence:import -- -Contributor 'Alice' -Apply
```

默认预览；-Folder 可选择收到的外层文件夹。整包无需提供 catalog 缓存，只校验实际独立记录；同身份同内容跳过，不同内容拒绝覆盖。跳过对方 inbox、received、pending 和 tools，不执行收到的程序。贡献者是接收者填写的信息，不是认证身份。

已有协作者接收流程仍保留 received 原件和回执，以兼容旧操作及故障恢复；它们不构成产品记录的读取依赖，也不计作产品回归。不得用外来索引覆盖本机记录。

## 历史兼容与维护

旧 schema 和 evidenceRevision 0/1、record.json/original 封装、旧本地和 GitHub 目录继续原样读取、独立校验。更新程序不自动改写、压缩或删除旧资料。新版产品格式只应用于新运行。

显式运行 `powershell -NoProfile -ExecutionPolicy Bypass -File scripts/maintain-test-evidence.ps1` 预览历史整理；加 `-Apply` 执行。执行前检查活动进程并取得归档锁。每份历史记录先校验，再暂存、校验保留内容、替换原目录，最后回收已核对的冗余。中断时 `.build/evidence-maintenance-*` 保留事务日志供审查，不自动删除未知资料。

整理后的历史档案使用 `archiveRevision: 1`，与产品 `evidenceRevision` 分开。它保留原清单的规格、运行身份、结果、测试计数和时间精度，添加 `archive` 迁移来源与原摘要；不会补造缺失功能映射、实测数值或当前完整验收结论。目录统一为 `records/<原始时间>-<唯一编号>`，无时间的混合资料仍用 `undated`。去掉 `record.json/README/original` 外层封装；真正的维护说明仍保留。

源码/验证器 ZIP、模拟档案与回执、可重建媒体和浏览器/运行时副本可以显式回收；源码身份清单继续保留，已删除未提交源码时不能承诺精确重现。生成素材快照的旧逐文件/逐项源清单一并回收，移除的清单字段记录在 `archive.discardedManifestFields`，原快照摘要只作迁移来源。实际历史附件（包括素材 ZIP 内的测量日志）无损集中到 `historical-data.json.gz`，每项保存原路径、长度、SHA-256 和 base64 字节；解码可恢复原文件。独立验证同时检查压缩包内逐项字节、原结果和结构化计数，不能仅因有迁移标记就放宽结果验证。

`pending` 不是已结束运行的永久位置。正常成功、失败或阻塞运行在保存并校验正式记录后回收自己的沙箱；归档失败才暂留恢复材料。上述显式维护可发布已有最终清单的阻塞记录，没有最终汇总的中断运行仅保存日志、事件、已有测量和中断说明，不计作完整产品通过。旧下载/导入包在永久平台档案中找到逐字节相同副本且校验整个快照后才删除；新版已丢弃传输 ZIP 时，须校验传输、原摘要和逐份产品文件字节一致，并验证永久产品与整个快照。空 `recording.lock` 是互斥锁载体，文件存在不代表进程正在运行；持有锁的状态由独占打开检查。

migrate-test-evidence.ps1 和 organize-test-evidence.ps1 仅作为显式旧目录维护入口，不是新测试的前置步骤；进行目录迁移仍核对原始字节并保留必要恢复资料。旧记录的历史索引快照只是该次维护的材料，不是其他记录的依赖。中断记录由 recover-test-evidence.ps1 审查恢复，不能将暂存存在解释为测试成功。

时间保留来源的表示精度和时区；新运行使用 UTC 毫秒编号，历史秒、日期或未知时间不补位。清理临时目录、用户数据保护和依赖缓存见 local-data.md；执行范围、发布门槛见 testing.md。
