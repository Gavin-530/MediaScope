# MediaScope 本地数据管理

`local-data-policy.json` 是随源码提交的目录分类规则；`scripts/local-data.ps1` 读取它并管理本地文件。`.gitignore` 只决定是否跟踪，不能决定保留期限。当前本地数据继续留在 MediaScope 项目内，不迁移已有目录。

| 路径 | 分类 | 处理方式 |
| --- | --- | --- |
| `local-test-archive/` | 永久保留 | 唯一测试归档；逐文件哈希和总目录清单校验，清理工具拒绝删除 |
| `.mediascope/` | 永久保留 | 源码运行产生的报告、任务输入和失败记录；清理工具拒绝删除 |
| `test-work/acceptance-20260921/` | 永久保留 | 历史性能验收报告及原始比较资料；271 个原始文件已列入目录内的 `SHA256SUMS.txt`，清理前验证 |
| `releases/` | 永久保留 | 只保存本机版本 ZIP；ZIP 被 Git 忽略，不自动删除，也不会与 GitHub Release 自动同步 |
| `.build/downloads/` | 可重建缓存 | 默认保留；只有明确选择 `Downloads` 类别并执行才清理，清理后可能需重新联网下载 |
| `.build/evidence-staging/` | 待处理 | 归档失败时可能留有完整日志，不作为缓存清理 |
| `.build/verify-*/` 及未知路径 | 未分类 | 默认保留；审查来源后再扩充规则 |
| `test-work/` 的已知测试生成目录和文件 | 可重建 | 只识别测试源码使用的固定名称、媒体/日志文件名及随机目录前缀；先运行 `scripts/archive-test-generated.ps1` 保存完整快照并校验归档，才能执行清理。未知文件与验收目录保留 |
| `.build/` 的已知打包、部署沙箱 | 可重建 | 只有找到对应发布 ZIP 或已归档测试日志才列入清理候选 |

常用命令（在项目根目录执行）：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/local-data.ps1 -Action Status
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/local-data.ps1 -Action Verify
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/local-data.ps1 -Action Clean -Category BuildStages
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/local-data.ps1 -Action Clean -Category TestGenerated
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/local-data.ps1 -Action Clean -Category Downloads
```

`Clean` 默认只预览。核对列出的**每个路径**后，再为同一命令加 `-Apply`。执行前会校验测试证据与历史验收文件、检查项目边界与目录链接，并拒绝与永久保留目录重叠；清理测试生成目录时还会检查常用测试 Node、FFmpeg/FFprobe 进程及归档锁。未知路径不会自动清理。旧的 `scripts/cleanup.ps1` 仍可使用 `-IncludeBuild -BuildOnly -Preview`，但现在也默认只预览，实际执行必须加 `-Apply`。历史验收校验值只能检测改变，不能代替文件副本。

清理测试生成目录时，先运行 `powershell -NoProfile -ExecutionPolicy Bypass -File scripts/archive-test-generated.ps1`。脚本把候选目录压缩为带逐文件摘要的维护快照，验证 ZIP 内容并登记在总目录清单。清理工具会再次核对候选目录的每个文件与快照完全一致；有新增或修改时拒绝清理，必须重新归档。成功完成的性能和 SI/TI 测试会自行删除本次生成的随机目录；失败时保留用于排查。

这套规则防止项目自带清理脚本误删资料。`catalog.json` 登记每份记录及其校验文件摘要；校验会发现整份记录丢失、文件变动和未完成归档。归档内容不自动修复或删除，人为修改后校验会失败，应保留原记录并新增说明或新测试。单份归档无法从文件丢失中恢复，也不能阻止手动删除整个项目、`git clean -fdx` 或磁盘损坏。长期留存需要对整个 MediaScope 目录另行备份。新生成且值得保留的资料应先归入永久保留规则，再考虑清理它的来源目录。
