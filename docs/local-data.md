# MediaScope 本地数据规范

local-data-policy.json 描述目录分类；scripts/local-data.ps1 负责检查与清理。Git 忽略不表示文件可以自动删除。

| 路径 | 处理 |
| --- | --- |
| local-notes | 本机计划和操作笔记；不提交，不自动清理 |
| github-archive | 指定仓库的平台档案；正式根、子目录和包含它的上级目录禁止通用清理；长期保留，不自动过期，独立备份见 [平台档案规范](github-archive.md) |
| evidence-archive/records | 独立测试和旧维护记录；用户可逐份复制或删除，程序不自动删除 |
| evidence-archive/pending | 正在运行、中断的暂存和锁；清理前审查进程与运行状态 |
| evidence-archive/inbox、received | 待接收原件、接收原件及回执；不由广泛清理操作删除 |
| local-test-archive | 旧位置；显式迁移前保留原件 |
| .mediascope | 可丢弃的运行数据；最多保留最近 10 次已结束任务、合计 100 MiB；软件退出后允许整目录手动删除 |
| .mediascope-saved-media | 旧版用户明确保留的实验视频迁移位置；自动清理不得触及 |
| test-work/acceptance-20260921 | 历史验收资料；排除在测试临时文件清理之外 |
| test-work 的明确生成项 | 活动进程结束后可显式回收；无需先制作永久素材快照 |
| releases | 本机版本包；测试清理不得触及 |
| .build/downloads | 可重建但下载成本较高的缓存；仅显式选择 Downloads 时清理 |
| .build | 构建沙箱和缓存；未知项保留 |
| node_modules | 可通过锁文件和 npm ci --ignore-scripts 重建 |

新测试入口先保留本次必要结果再回收自己创建的沙箱。已知可重建临时媒体、运行时和浏览器配置不作为每次永久档案；用户另存的报告和视频、未知目录和历史验收材料不得因“不属于源码”而删除。测试使用独立数据目录，不向开发版 .mediascope 写入记录。

## 软件运行数据

源码版使用 .mediascope，安装版使用安装根目录的 data，二者执行相同保留规则。最近 10 次指成功、失败和取消的已结束任务，按结束时间跨重启计数；运行中与排队任务不参与淘汰。启动时恢复近期记录供查看、导出和重排队，超出数量或总量时删除最旧记录。单份超过 100 MiB 的报告仅在当前会话可查看、导出，关闭后删除；正在导出的记录等读取结束再清理，可能短暂超过上限。

任务结束后回收中间媒体与测量日志，报告中的最终指标继续保留。保存实验视频时必须选择运行目录之外的保存位置，输出放入该位置的任务编号子目录，自动清理不会删除它们。旧版明确保留的实验视频首次启动移到运行目录旁的 <运行目录名>-saved-media；迁移失败时保留原件并报错。

desktop-profile 是专用 Edge/Chrome 的可丢弃配置目录。启动前回收上次遗留目录，退出时等待专用浏览器结束后删除；正在使用的目录不清理。主题与“退出后清空近期记录”写入小型 settings.json；整目录手动删除也会重置这些偏好。浏览器可能在使用期间再次下载组件，运行目录大小上限不包含活跃任务、当前会话的大报告和浏览器运行缓存。

界面“本地数据”显示占用，提供“清空近期记录”“清理运行缓存”和“退出后清空近期记录”。退出后可手动删除整个 .mediascope/data；不影响原始媒体、外部导出文件、独立测试归档或私有运行时。自动清理只处理明确的任务目录和浏览器/会话目录；未知项不自动删除。通用测试和构建清理脚本不负责清理软件运行目录。

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/local-data.ps1 -Action Status
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/local-data.ps1 -Action Verify
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/local-data.ps1 -Action Clean -Category TestGenerated
```

Clean 默认预览；核对后显式加 -Apply。保留项目路径边界、目录链接、受保护数据和活动进程检查。TestGenerated 只选择已知生成命名，未知项与验收目录保留，不再要求先归档全部生成素材。archive-test-generated.ps1 保留为特殊情况下的显式素材快照工具，不是清理前置要求。

BuildStages、Downloads 是其他显式类别。maintain-build.ps1 的旧构建维护流程仍保留必要诊断后回收；不自动处理旧 pending 或修改旧测试记录。测试记录的独立格式、复制、校验、删除和历史兼容由 evidence-archive.md 统一说明。
