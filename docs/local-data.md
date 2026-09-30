# MediaScope 本地数据规范

[`local-data-policy.json`](../local-data-policy.json) 是目录分类规则，`scripts/local-data.ps1` 负责检查与清理。Git 忽略只表示不跟踪，不表示文件可以删除。

## 分类与保留

| 路径 | 分类与处理 |
| --- | --- |
| `local-test-archive/` | 唯一长期测试/维护归档；永久保留，清理工具拒绝删除 |
| `.mediascope/` | 源码运行的用户报告、任务输入和失败资料；永久保留 |
| `test-work/acceptance-20260921/` | 历史性能验收资料；保留原文件与 `SHA256SUMS.txt` |
| `releases/` | 本机历史版本 ZIP；永久保留，与 GitHub Release 独立管理 |
| `.build/downloads/` | 可重建运行时下载缓存；默认保留，须显式选择 Downloads 才清理 |
| `.build/test-runs/`、`.build/evidence-staging/` | 运行中或待处理证据；归档失败、中断时保留，不能当缓存删除 |
| `test-work/` 已知生成项 | 先确认完整快照与当前文件一致，再回收；验收资料和未知项保留 |
| `.build/` 已知打包/部署沙箱 | 对应 ZIP 或必要诊断已保留并校验后才回收；未知项保留 |
| `node_modules/` | 锁定的开发依赖，可由 `npm ci --ignore-scripts` 重建，不属于长期证据 |

测试记录、用户报告、生成素材、缓存、开发依赖和本地 ZIP 被 Git 忽略，不自动上传，也不进入安装包；测试代码与本规范可以随源码提交。历史审查报告留在本地归档，不在根目录重复保存。

## 统一命名

| 对象 | 格式 |
| --- | --- |
| 规则文档 | `docs/<小写名称>.md`，多词用连字符；`README.md` 和 GitHub 模板沿用约定文件名 |
| 产品测试记录 | `local-test-archive/runs/<版本>/<运行编号>/` |
| 运行编号 | `yyyyMMddTHHmmssfffZ-<8 位小写十六进制随机号>`；UTC、毫秒精度 |
| 维护记录 | `local-test-archive/<类别>-<运行编号>/`；不带产品版本，不计作产品通过数 |
| GitHub 证据包 | `local-test-archive/github-actions-<运行编号>/`；内部原始测试记录保留版本及编号，以 GitHub 运行编号/重跑次数去重 |
| 发布 Tag / 标题 / ZIP | 统一见[发布规范](releasing.md) |
| 用户导出文件 | 按任务/素材与本地时间命名，见 [README](../README.md#报告与资源边界)；与测试归档 UTC 编号用途不同 |

历史归档、验收目录和已保留版本包保持原名、原内容；不为统一外观重写旧证据。新运行目录的格式由校验器检查。

## 检查与清理

在项目根目录执行：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/local-data.ps1 -Action Status
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/local-data.ps1 -Action Verify
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/local-data.ps1 -Action Clean -Category TestGenerated
```

`Clean` 默认预览，核对每个目标后加 `-Apply` 才执行。其他类别为 `BuildStages`、`Downloads`。执行前检查项目边界、目录链接、永久保留路径、证据校验及相关进程/记录锁；未知路径不自动删除。

已知测试生成项必须与已登记快照的完整文件数、路径、大小和 SHA-256 一致。不同候选可由不同快照覆盖，单个候选须完整匹配一份快照。有新增/变化或没有快照时，先运行 `scripts/archive-test-generated.ps1`，校验后再清理。历史构建目录可用 `scripts/maintain-build.ps1` 预览；加 `-Apply` 会先归档诊断和清理清单，再回收已识别目录。旧 `scripts/cleanup.ps1` 同样默认预览。

各记录的 `SHA256SUMS.txt` 与总 `catalog.json` 检测文件变化、整份记录缺失及未完成归档；失败不能被重跑成功覆盖。异常时保留原记录并新增说明，不自动修复或删证据。

永久保留是清理策略，不是异地备份。数据仍在项目目录内，校验不能恢复删除、磁盘损坏或 `git clean -fdx` 造成的丢失；长期保存需另行备份项目的本地数据。测试记录内容和恢复入口见[测试规范](testing.md)。
