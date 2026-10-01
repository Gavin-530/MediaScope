# MediaScope 本地数据规范

[`local-data-policy.json`](../local-data-policy.json) 是目录分类规则，`scripts/local-data.ps1` 负责检查与清理。Git 忽略只表示不跟踪，不表示文件可以删除。

## 分类与保留

| 路径 | 分类与处理 |
| --- | --- |
| `evidence-archive/` | 唯一长期测试/维护证据入口；永久保留，清理工具拒绝删除 |
| `evidence-archive/inbox/` | 协作者归档的接收原件与导入回执；永久保留，不自动上传或清理 |
| `evidence-archive/tools/` | 导入程序；其中 import-local-test-evidence.ps1 随 Git 维护，其余内容不跟踪 |
| `evidence-archive/pending/` | 运行中、待导入、中断证据和锁；不自动删除 |
| `evidence-archive/legacy/local-test-archive/` | 尚未整理的旧档案暂存位置，仍受保护；整理后原文件进入各分类的 original，原 catalog 保存为校验快照 |
| `local-test-archive/` | 未迁移时仍保护；迁移后不再写入 |
| `.mediascope/` | 用户报告、任务输入和失败资料；永久保留 |
| `test-work/acceptance-20260921/` | 历史验收原始资料；永久保留 |
| `releases/` | 本机历史版本 ZIP；永久保留 |
| `.build/downloads/` | 可重建下载缓存；默认保留，须显式选择 Downloads 才清理 |
| `.build/` | 构建缓存及可重建打包沙箱；对应发布包/诊断已保存后才清理；未知项保留 |
| `test-work/` 已知生成项 | 完整快照验证一致后才能回收；验收资料和未知项保留 |
| `node_modules/` | 锁定开发依赖，可由 npm ci --ignore-scripts 重建 |

构建、测试活动停止后才清理其工作目录。运行日志和中断证据保存在受保护的 pending；不以“不是源码”为删除依据。永久保留资料、依赖、缓存和本地 ZIP 被 Git 忽略，不进入安装包。本机档案不自动上传。

## 归档结构与命名

统一目录说明及时间精度规则见[归档入口模板](evidence-archive-template.md)。产品记录按来源进入 tests/local 或 tests/github-actions；维护进入 maintenance，素材快照进入 fixtures。产品与素材目录为 时间部分-8位编号，维护为 时间部分_事项_8位编号。时间部分按原编号保留毫秒、秒、日期或 undated；带 Z 的时刻为 UTC，仅日期不自动指定时区。不能补小数、补零点或用当前归档时间冒充原运行时间。编号时间、实际运行开始和清单创建时间分别保留，版本、提交和类型在清单中表达。

非证据文件沿用现有命名：规则文档为 docs/<小写名称>.md；README 和 GitHub 模板沿用约定名称；Tag、标题、ZIP 见[发布规范](releasing.md)，用户导出见 README。

每份新记录有 README.md、record.json、original/ 和 SHA256SUMS.txt。新封装 schema 3 明确保存编号时间的值、表示精度、时区与来源；旧封装 schema 1/2 不改写。original 保存原始证据，按其原 schema 解读；封存不意味着产品通过。GitHub 导入另保留 bundle.zip；通过 Actions 外层 ZIP 下载时还保留 artifact.zip。重跑、更正、失败分别保存，禁止覆盖旧记录。全部封存记录登记 catalog.json；pending 不计作产品通过数。

历史档案按原 schema 验证，不补造缺失证据、不改变原字节。迁移先预览，校验全部原文件后按内容分类并记录维护审计；旧索引作为原字节快照保存在维护归档中。已封存的旧维护记录仅改目录名，原清单中的旧路径保留为身份，当前路径在 catalog 与整理映射中登记：

```powershell
npm run evidence:migrate
npm run evidence:migrate -- -Apply
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/organize-test-evidence.ps1
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/organize-test-evidence.ps1 -Apply
npm run evidence:list
npm run evidence:verify
```

## 接收协作者归档

接收入口统一为 `evidence-archive/inbox/`；处理入口为 `evidence-archive/tools/import-local-test-evidence.ps1`，也可使用 `npm run evidence:import`。工具不执行收到的脚本，不改变媒体分析、界面或安装流程。接收目录受本地数据策略保护并被 Git 忽略；导入规则与程序随 Git 共享。

首次执行 `npm run evidence:import` 创建接收目录并列出批次。对方可发送单份完整封存记录，也可发送整个 evidence-archive。收到 ZIP 后先自行解压，放入同一批次的 records；不要直接覆盖本机归档根目录。结构如下：

```text
evidence-archive/
  tools/
    import-local-test-evidence.ps1
  inbox/
    alice-20261001/
      records/
        evidence-archive/   # 对方整个归档，含其 catalog.json
          tests/
          maintenance/
          fixtures/
          inbox/            # 会跳过，保持原件
          tools/            # 会跳过，不执行或覆盖本机程序
        单份封存记录目录/     # 也可直接放单份或多份记录
      receipts/             # 程序生成
```

批次名使用 ASCII 字母、数字、点、下划线、连字符，并以字母或数字开头。单份封存记录必须包含 README.md、record.json、SHA256SUMS.txt、original/ 及原有压缩附件。整包须保留自己的 catalog.json；程序核对它，但不会用它替换本机索引。不要把整个项目放进 records，不手工补造清单或修改编号来绕过冲突。暂不支持旧版未封装目录和直接读取 ZIP；整包内的 pending 待处理资料仅保留原件，不正式导入。

套娃处理以记录为单位：程序识别包装目录及嵌套的 evidence-archive，只提取已封存记录；到达一份记录后不再拆其 original。每份收到的归档中的 inbox、pending、tools、receipts 和旧版 evidence-inbox 都会跳过，不进入它们继续寻找档案，即使包含循环目录链接也不跟随。嵌套包装最多 24 层，超限停止。对方接收箱中尚未正式导入的记录若也要收集，应由对方另行单独提供，不自动混入本次导入。

```powershell
# 预览：完整检查本机索引和全部接收记录，但不写入正式归档
npm run evidence:import -- -Batch alice-20261001
# 应用：贡献者可填写名称或账号；含空格时加引号
npm run evidence:import -- -Batch alice-20261001 -Contributor "Alice" -Apply
npm run evidence:verify
```

工具按收到的封装身份进入既有 tests/local、tests/github-actions、maintenance 或 fixtures 分类；保留原始文件字节、编号、时间精度、提交、运行范围和失败结果。逐项校验完整性，同编号同内容跳过，同编号不同内容停止整个批次；不把他人的测试改称本机执行或合并成一次通过。贡献者由接收者填写，不能作为经过认证的身份。

应用时使用现有归档记录锁，先校验并暂存所有新记录，再统一更新本机 catalog.json；不会导入对方的索引或程序。来源、提交（原清单已记录时）、接收批次、源索引摘要、跳过目录及逐条记录摘要另存为 maintenance 中的 local-evidence-import 审计记录。接收原件保留在 records，本机索引快照与回执留在 receipts；成功后没有新增未完成 pending，重复运行不会新增记录或审计。正式分类中不会新增一层 evidence-archive 或外来 inbox；接收批次内保留的原始目录层级不是正式归档层级。

正常捕获的提交前错误会将本批新目录移回 pending 事务目录，保留旧索引和接收原件；不删除已有资料。进程被强行终止或断电时可能留下待恢复事务，工具不会忽略索引异常继续导入。遇到报错保留接收批次和提示中的 pending/local-import-*，先核对 plan.json、catalog-before.json（若已生成）及正式索引，不手工覆盖或删除档案。

## 检查与清理

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/local-data.ps1 -Action Status
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/local-data.ps1 -Action Verify
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/local-data.ps1 -Action Clean -Category TestGenerated
```

Clean 默认预览，核对后加 -Apply；其他类别为 BuildStages、Downloads。执行前检查项目边界、目录链接、永久保护、证据校验和记录锁。未知路径不自动删除。

生成项必须与一份已登记快照的完整文件数、路径、大小和 SHA-256 一致；不同候选可分别匹配不同快照。有变化或无快照时先运行 scripts/archive-test-generated.ps1。scripts/maintain-build.ps1 的 -Apply 先归档诊断和清理清单，再回收已识别历史构建目录。

SHA256SUMS.txt 与 catalog.json 检测文件变化、记录缺失及未登记记录。正常校验列出 pending；使用 verify-test-evidence.ps1 -RequireComplete 可拒绝未完成项。失败不能被后来成功覆盖；恢复只处理证据，不增加产品通过数。

永久保留是清理策略，不是备份。另行备份整个 evidence-archive（包含 inbox）、用户报告、验收资料和 releases；校验不能恢复磁盘损坏或误删。
