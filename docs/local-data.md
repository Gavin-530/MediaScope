# MediaScope 本地数据规范

local-data-policy.json 描述目录分类；scripts/local-data.ps1 负责检查与清理。Git 忽略不表示文件可以自动删除。

| 路径 | 处理 |
| --- | --- |
| evidence-archive/records | 独立测试和旧维护记录；用户可逐份复制或删除，程序不自动删除 |
| evidence-archive/pending | 正在运行、中断的暂存和锁；清理前审查进程与运行状态 |
| evidence-archive/inbox、received | 待接收原件、接收原件及回执；不由广泛清理操作删除 |
| local-test-archive | 旧位置；显式迁移前保留原件 |
| .mediascope | 用户报告、任务输入和失败资料；测试清理不得触及 |
| test-work/acceptance-20260921 | 历史验收资料；排除在测试临时文件清理之外 |
| test-work 的明确生成项 | 活动进程结束后可显式回收；无需先制作永久素材快照 |
| releases | 本机版本包；测试清理不得触及 |
| .build/downloads | 可重建但下载成本较高的缓存；仅显式选择 Downloads 时清理 |
| .build | 构建沙箱和缓存；未知项保留 |
| node_modules | 可通过锁文件和 npm ci --ignore-scripts 重建 |

新测试入口先保留本次必要结果再回收自己创建的沙箱。已知可重建临时媒体、运行时和浏览器配置不作为每次永久档案；用户报告、未知目录和历史验收材料不得因“不属于源码”而删除。

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/local-data.ps1 -Action Status
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/local-data.ps1 -Action Verify
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/local-data.ps1 -Action Clean -Category TestGenerated
```

Clean 默认预览；核对后显式加 -Apply。保留项目路径边界、目录链接、受保护数据和活动进程检查。TestGenerated 只选择已知生成命名，未知项与验收目录保留，不再要求先归档全部生成素材。archive-test-generated.ps1 保留为特殊情况下的显式素材快照工具，不是清理前置要求。

BuildStages、Downloads 是其他显式类别。maintain-build.ps1 的旧构建维护流程仍保留必要诊断后回收；不自动处理旧 pending 或修改旧测试记录。测试记录的独立格式、复制、校验、删除和历史兼容由 evidence-archive.md 统一说明。
