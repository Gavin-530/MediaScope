# MediaScope GitHub 自动测试

工作流配置为自动执行完整测试并显示控制台检查结果；没有产物上传步骤。详细测试证据的远端存储及批量同步尚未启用，本地导入工具用于校验符合约定格式的证据包。远端是否实际运行成功，以对应提交的 Actions 记录为准。

## 执行与门槛

工作流在推送分支或 Tag、创建/更新/重新打开 PR、合并队列和手动启动时执行。只在本地修改或保存文件不会触发；默认不定时执行。分支推送与 PR 检查可能分别产生记录，两者测试的提交可能不同。

使用 GitHub 托管的 Windows Server 2022 x64 临时机器，不使用本机 runner。`scripts/run-ci-tests.ps1` 使用 `runtime-lock.json` 的 Node.js/FFmpeg 下载和 SHA-256 校验、`npm ci --ignore-scripts` 以及同一个 `node scripts/test.mjs --release`。Edge 使用 runner 已安装版本，并记录实际版本；不把云端耗时解释为用户电脑速度。

严格门槛与[本地测试规范](testing.md)一致：完整套件、干净源码、非零实际检查、零失败/取消/跳过/TODO、全部功能映射通过。设置为必需合并检查是另一个仓库设置，写入工作流并不自动禁止合并，也不自动发布 Release。

PR 默认测试 GitHub 合并提交；推送/Tag 测试该提交。证据同时记录实际 SHA、运行编号和重新运行次数，不能以分支名或版本号代替提交身份。失败重跑不覆盖前次证据，不自动取消较早运行。

## 证据范围与保留

计划上传范围仅限 GitHub 临时机器本次测试新生成的记录：已提交源码的测试快照、结构化结果与功能映射、测量日志/CSV/报告/失败截图、工具身份及 SHA-256。另保存准备环境日志和失败时尚未完成归档的沙箱；异常诊断不算测试通过。

禁止复制或上传这台电脑已有的 `local-test-archive/`、用户报告、历史验收、开发依赖或运行时缓存。未来的证据导出命令须限定在隔离的 GitHub 托管 runner 上，不能用来上传本地档案，不收集完整环境变量、凭证、`.git` 或事件载荷。正式发布 ZIP 按用户授权另行上传到 Release，与测试产物分开管理。

远端产物计划统一命名 `mediascope-test-evidence-<GitHub运行编号>-<重跑次数>`，保留 90 天；重新运行生成独立产物。云端临时磁盘及 GitHub 产物都不是永久档案。取消、超时或平台故障可能使最终导出/上传无法完成，必须检查产物是否存在，不承诺每次异常都有完整证据。

本地不会同步产生一份。产物需在到期前下载，再执行：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/import-github-test-evidence.ps1 -Archive <下载的产物ZIP>
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/verify-test-evidence.ps1
```

导入工具不执行 ZIP 中的程序，校验安全路径、内部清单/摘要、仓库与运行身份、实际测试记录和发布门槛后，将原始证据保存到 `local-test-archive/github-actions-<UTC运行编号>/` 并登记总目录。内部 `records/runs/<版本>/<编号>/` 保持原内容；同次同内容导入不重复保存，不同内容拒绝覆盖。导入失败保留 `.build/github-evidence-import/` 中的诊断副本。

导入成功后按[本地数据规范](local-data.md)永久保留，不跟随远端到期删除。未在到期前下载的记录可能无法找回；本地磁盘离线、损坏或丢失也需要另行备份。之后接入同步命令可批量下载新记录；当前不创建后台任务或系统定时任务。

应用回归、确切发布包验证、首次联网部署和人工安装/卸载验收分别保留。Actions 绿色结果不能替代后面三项。
