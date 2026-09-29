# MediaScope 发布规范

本文件约束 MediaScope 的版本发布过程。目标是让每个 Release 可核验、可追溯且格式稳定。

## 发布说明原则

- Git Tag 使用 `v<version>`，Release 标题沿用 `MediaScope <version>`，附件文件名中的版本与 `package.json` 一致。
- Release 正文使用 `.github/RELEASE_TEMPLATE.md`，主要章节统一使用二级标题。
- 正文只固定“本次更新”和“校验”；“本次更新”用一个列表列出用户可感知的变化。其他确有必要的信息按实际情况补充，不要求特定栏目。
- 固定的下载、环境要求和启动方式由 `README.md` 维护；本版本若改变了相关要求，在发布说明中如实写明。
- 保留版本实际变化，不为了排版统一而合并、扩写或重新解释技术事实。
- 自动化测试只报告可追溯的通过数；不粘贴完整终端日志。
- 没有可靠历史记录时省略相应章节，不补造验证或兼容性结论。
- SHA-256 固定放在“校验”章节，并与确切附件文件名写在同一校验记录中。

## 发布前检查

1. 确认工作区只包含计划发布的变化。
2. 确认目标 Tag 为 `v<version>`，去掉前缀 `v` 后与 `package.json` 中的版本完全一致；包内版本与 ZIP 文件名不加 `v`。
3. 运行 `powershell -NoProfile -ExecutionPolicy Bypass -File scripts/record-test.ps1 -Kind App -RequireClean`，保存逐次测试证据；任何失败都不得发布。
4. 运行 `scripts/package.ps1 -Version <version>`，只生成一个 Windows x64 联网部署包。不得覆盖已存在的包或暂存目录。
5. 运行 `scripts/record-test.ps1 -Kind Package -Archive <zip> -RequireClean`，核对归档文件数、实际字节数及 SHA-256，并执行离线部署验证；另运行 `scripts/record-test.ps1 -Kind OnlineDeployment -Archive <zip> -RequireClean` 验证真实首次联网安装。部署验证必须覆盖环境复用、已有环境与变化检测、切回推荐环境、升级与回退、损坏下载、兼容性失败、用户数据保护、自定义安装位置、共享组件及卸载边界。人工检查首次安装位置选择和取消、首次检测通过后的双选项弹窗、没有合格本地环境时的下载提示、已选择本地环境失效后的确认与拒绝路径，以及从 Windows“已安装的应用”启动卸载后保留报告的路径。运行锁定私有环境下的应用回归测试；记录未验证的 Windows/运行时版本。产品说明必须注明选择推荐环境时首次安装需要联网。
6. 从 `.github/RELEASE_TEMPLATE.md` 创建 Release 草稿，删除提示、占位符及无内容的小节，逐项核对正文中的版本、附件文件名、测试数（若填写）和 SHA-256。
7. 检查正文只包含本版本能够直接支持的事实。
8. 先上传全部附件并再次核对摘要，再发布 Release。

## 本地测试证据

- `scripts/record-test.ps1` 为每次运行建立唯一目录 `local-test-archive/runs/<版本>/<UTC 时间>-<随机号>/`，保存原始输出、退出码、起止时间、版本、Git 提交和工作区状态、执行命令、运行环境及逐文件 SHA-256。失败运行也保留，同时拒绝并发记录，避免测试互相干扰。未提交的源码会标为 dirty；发布验证使用 `-RequireClean`，避免把未提交改动归因于某个提交。
- 只在项目内的 `local-test-archive/` 保存一份记录。每份记录有逐文件 `SHA256SUMS.txt`；根目录 `catalog.json` 登记全部记录及各自校验文件的摘要，因此整份记录丢失也会被发现。运行 `scripts/verify-test-evidence.ps1` 只读校验，不修改证据。`release-verification-2026-09-29-v0.2.0/` 是历史格式，目录名标明类别、日期和版本；归档内容原样保留，不补造逐次运行信息。
- 每次运行的日志默认上限为 16 MiB；超过时尝试 gzip 压缩，压缩后仍超限则保留完整临时日志并报错，不静默截断。单次上限可用 `-MaxLogMiB` 调整。证据总量超过 1 GiB 时警告，不自动删除。合成媒体、部署沙箱、运行时 ZIP 与发布包不重复放进证据目录；发布包记录路径、字节数和 SHA-256。证据不上传 GitHub，也不进入发布包。
- 证据是长期保留资料。本地数据规则见 [LOCAL_DATA.md](LOCAL_DATA.md)；清理工具保护 `local-test-archive/`、`.mediascope/`、`releases/` 和历史验收目录。证据被 Git 忽略，只有这一份；删除整个 MediaScope 目录、换电脑或磁盘损坏会使其丢失。需要抗磁盘故障时应把整个项目目录另行备份。
- 清理可重建的构建沙箱前先用 `scripts/cleanup.ps1 -IncludeBuild -BuildOnly -Preview` 查看目标，再去掉 `-Preview` 并加 `-Apply` 执行。脚本默认只预览；执行前校验归档，只清理由归档日志引用的部署沙箱或对应 ZIP 已保留的打包暂存。下载缓存、未知目录、用户报告和历史验收资料保留。
- 运行 `scripts/list-test-evidence.ps1` 查看按版本和运行次数列出的结果。需要记录其他验证命令时，在 PowerShell 中用 `& .\scripts\record-test.ps1 -Kind Custom -Executable <程序路径> -Arguments @('参数1','参数2') -Label <名称>`；自定义命令的输出和退出码按同一格式归档。
- `releases/` 只保存本机完整版本 ZIP，与 GitHub Release 独立管理；本地文件变化不会自动上传，远端 Release 变化也不会回写到本机。

## 已发布版本的维护

- 可以修正文案排版、失效链接和明显笔误，但不得悄然改变版本实际行为的描述。
- 不替换同一版本的附件；需要改变发布内容时递增版本号。
- 历史补录版本明确标注“历史版本补录”，不为其追加当时没有留存的验证结果。
