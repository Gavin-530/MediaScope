# MediaScope GitHub 自动测试

工作流使用同一本地完整发布测试入口；远端运行是否成功，以对应提交的 Actions 记录为准。工作流修改需提交并推送后才生效。

## 执行与身份

push、Tag、PR、merge_group、workflow_dispatch 执行 Windows Server 2022 x64 完整回归；本地保存文件不触发远端运行。Node.js/FFmpeg 根据 runtime-lock.json 下载并校验，npm ci --ignore-scripts 安装依赖；执行 node scripts/test.mjs --release。Edge 使用 runner 已装版本，并记录其身份。

门槛保持完整套件、干净源码、非零实际检查、零失败/取消/跳过/TODO和全部功能映射通过。本地 `npm run test:release` 使用相同入口和条件；`npm test` 使用相同回归判定但允许未提交修改，部分测试或历史对比不能代替此检查。必需合并检查需配置分支规则；绿色结果不自动发布 Release，也不替代包验证、首次联网部署和人工安装/卸载验收。

本地和远端是独立执行，不能合并成一次结果。同一套用例及证据格式，不保证耗时、路径、截图等字节一致；比较需核对源码及验证器 SHA、实际工具和测试范围。PR 通常执行合并提交。记录仓库、SHA、run_id、run_attempt、job 和触发事件，重跑独立保存。

另有 commit-messages.yml 的 Commit messages 检查，在 Ubuntu 24.04 使用预装 Node.js 检查提交及 PR 标题；不运行产品测试，不计作媒体回归。规则见[贡献规范](contributing.md)。

## 远端证据

测试步骤结束后，即使失败也尝试导出和上传本次证据。导出器限 GitHub-hosted runner，只收集匹配本次仓库、SHA、运行及重跑身份的 App 记录。初始化失败或执行中断时保存一份 blocked 记录与压缩日志，不补造通过数，不导出临时源码和运行时副本；正常完成不重复保存初始化日志。拒绝混入本机档案和无关运行；不收集凭证、完整环境变量、.git 或事件载荷。

导出先验证原始记录，再产生带清单和 SHA-256 的 bundle.zip。产物名为 mediascope-test-evidence-<run_id>-<run_attempt>，保留 90 天，不覆盖。上传使用固定 SHA 的官方 upload-artifact，仅在导出成功后执行；导出失败直接使对应步骤失败。测试通过和上传成功是不同状态。取消、超时或平台故障仍可能没有完整证据，不能承诺每次异常均可保存。

## 本地同步和原样保存

```powershell
npm run github:sync
npm run evidence:list -- -Scope github
npm run github:verify
npm run github:import -- --archive <下载的ZIP> --run <run-id> --attempt <attempt>
```

同步分页查询远端产物，核对实际运行身份和 API 摘要；PR 的分支 head_sha 与实际合并测试 SHA 分别保存，不能混为同一提交，下载后执行本地导入。身份键为仓库/run_id/run_attempt；当前工作流只有一个产品回归 job。将来增加 job/矩阵时须同时扩展产物名及身份键，不能直接复用本方案覆盖不同 job。

鉴权优先 GH_TOKEN/GITHUB_TOKEN，随后使用现有 Git credential helper，禁用交互提示；不将凭证写入日志或档案。下载需具备 Actions 读取权限。导入不执行下载包中的程序，校验安全路径、内部清单、仓库/提交/运行身份和实际发布门槛。支持 bundle ZIP 和 upload-artifact 外层 ZIP，新版 transport schema 2 只保存校验后的独立产品记录，不重复保留 ZIP 传输副本；同步成功后回收该次下载和解包暂存，失败时保留诊断。显式传给导入脚本的原件不删除。旧 transport schema 1 仍按旧格式保存和读取，不重跑测试替代云端记录。

云端永久记录保存到 github-archive/actions/<run-id>/attempts/<attempt>/evidence 下；本地测试和维护记录仍在 evidence-archive。旧云端源先复制保全，通过新目标、原始字节和实际恢复验证后，可由显式 github:prune 逐份清理，普通同步不删除。身份、格式、分页、快照、缺口、离线恢复及命令见[平台档案规范](github-archive.md)。原始时间精度和产品验证门槛保持；相同内容去重，冲突拒绝覆盖。pending 仅保存本工具暂存、锁和检查点；扫描完整、内容取齐与校验通过分别报告。

新版导入只增加很小的 origin.json，保存测试步骤状态和原始清单/传输摘要；结果与测量文件不改写，本地一层校验清单覆盖整份记录。测试断言通过与 CI 步骤完成是不同状态，例如归档后的清理失败可使步骤失败；不会因丢弃 ZIP 而丢掉这一差别。上传步骤及整个工作流的最终状态仍以 GitHub 运行页面为准。

启动和测试不自动同步历史记录。显式运行 github:sync；evidence:sync 为兼容别名，自动调用被禁用。同步只读远端，不上传本机资料，不创建计划任务。

远端临时磁盘和限期产物不是永久备份。过去未上传的文件不能从测试状态补造；可取得的原始日志需明确其证据范围。正式发布 ZIP 与产品用户报告各自保留。
