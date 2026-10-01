# MediaScope 本地数据规范

[`local-data-policy.json`](../local-data-policy.json) 是目录分类规则，`scripts/local-data.ps1` 负责检查与清理。Git 忽略只表示不跟踪，不表示文件可以删除。

## 分类与保留

| 路径 | 分类与处理 |
| --- | --- |
| `evidence-archive/` | 唯一长期测试/维护证据入口；永久保留，清理工具拒绝删除 |
| `local-test-archive/` | 未迁移时仍保护；迁移后不再写入 |
| `.mediascope/` | 用户报告、任务输入和失败资料；永久保留 |
| `test-work/acceptance-20260921/` | 历史验收原始资料；永久保留 |
| `releases/` | 本机历史版本 ZIP；永久保留 |
| `.build/downloads/` | 可重建下载缓存；默认保留，须显式选择 Downloads 才清理 |
| `.build/` | 构建缓存及可重建打包沙箱；对应发布包/诊断已保存后才清理；未知项保留 |
| `test-work/` 已知生成项 | 完整快照验证一致后才能回收；验收资料和未知项保留 |
| `node_modules/` | 锁定开发依赖，可由 npm ci --ignore-scripts 重建 |

构建、测试活动停止后才清理其工作目录。运行日志和中断证据保存在受保护的 pending；不以“不是源码”为删除依据。永久保留资料、依赖、缓存和本地 ZIP 被 Git 忽略，不进入安装包。本机档案不自动上传。

## 测试归档

目录结构、接收整包、去重校验、历史迁移、编号时间及恢复规则统一由[测试归档说明](evidence-archive.md)维护，本文件只规定整个项目的目录保留和清理。

非证据文件沿用现有命名：规则文档为 docs/<小写名称>.md；README 和 GitHub 模板沿用约定名称；Tag、标题、ZIP 见[发布规范](releasing.md)，用户导出见 README。

## 检查与清理

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/local-data.ps1 -Action Status
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/local-data.ps1 -Action Verify
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/local-data.ps1 -Action Clean -Category TestGenerated
```

Clean 默认预览，核对后加 -Apply；其他类别为 BuildStages、Downloads。执行前检查项目边界、目录链接、永久保护、证据校验和记录锁。未知路径不自动删除。

生成项必须与一份已登记快照的完整文件数、路径、大小和 SHA-256 一致；不同候选可分别匹配不同快照。有变化或无快照时先运行 scripts/archive-test-generated.ps1。scripts/maintain-build.ps1 的 -Apply 先归档诊断和清理清单，再回收已识别历史构建目录。


永久保留是清理策略，不是备份。另行备份整个 evidence-archive、用户报告、验收资料和 releases；校验不能恢复磁盘损坏或误删。
