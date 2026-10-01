# MediaScope 本地数据规范

[`local-data-policy.json`](../local-data-policy.json) 是目录分类规则，`scripts/local-data.ps1` 负责检查与清理。Git 忽略只表示不跟踪，不表示文件可以删除。

## 分类与保留

| 路径 | 分类与处理 |
| --- | --- |
| `evidence-archive/` | 唯一长期测试/维护证据入口；永久保留，清理工具拒绝删除 |
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

## 检查与清理

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/local-data.ps1 -Action Status
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/local-data.ps1 -Action Verify
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/local-data.ps1 -Action Clean -Category TestGenerated
```

Clean 默认预览，核对后加 -Apply；其他类别为 BuildStages、Downloads。执行前检查项目边界、目录链接、永久保护、证据校验和记录锁。未知路径不自动删除。

生成项必须与一份已登记快照的完整文件数、路径、大小和 SHA-256 一致；不同候选可分别匹配不同快照。有变化或无快照时先运行 scripts/archive-test-generated.ps1。scripts/maintain-build.ps1 的 -Apply 先归档诊断和清理清单，再回收已识别历史构建目录。

SHA256SUMS.txt 与 catalog.json 检测文件变化、记录缺失及未登记记录。正常校验列出 pending；使用 verify-test-evidence.ps1 -RequireComplete 可拒绝未完成项。失败不能被后来成功覆盖；恢复只处理证据，不增加产品通过数。

永久保留是清理策略，不是备份。另行备份 evidence-archive、用户报告、验收资料和 releases；校验不能恢复磁盘损坏或误删。
