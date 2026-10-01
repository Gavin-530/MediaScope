# MediaScope GitHub 自动测试

工作流使用同一本地完整发布测试入口；远端运行是否成功，以对应提交的 Actions 记录为准。工作流修改需提交并推送后才生效。

## 执行与身份

push、Tag、PR、merge_group、workflow_dispatch 执行 Windows Server 2022 x64 完整回归；本地保存文件不触发远端运行。Node.js/FFmpeg 根据 runtime-lock.json 下载并校验，npm ci --ignore-scripts 安装依赖；执行 node scripts/test.mjs --release。Edge 使用 runner 已装版本，并记录其身份。

门槛保持完整套件、干净源码、非零实际检查、零失败/取消/跳过/TODO和全部功能映射通过。必需合并检查需配置分支规则；绿色结果不自动发布 Release，也不替代包验证、首次联网部署和人工安装/卸载验收。

本地和远端是独立执行，不能合并成一次结果。同一套用例及证据格式，不保证耗时、路径、截图等字节一致；比较需核对源码及验证器 SHA、实际工具和测试范围。PR 通常执行合并提交。记录仓库、SHA、run_id、run_attempt、job 和触发事件，重跑独立保存。

另有 commit-messages.yml 的 Commit messages 检查，在 Ubuntu 24.04 使用预装 Node.js 检查提交及 PR 标题；不运行产品测试，不计作媒体回归。规则见[贡献规范](contributing.md)。

## 远端证据

测试步骤结束后，即使失败也尝试导出和上传本次证据。导出器限 GitHub-hosted runner，只收集匹配本次仓库、SHA、运行及重跑身份的 App 记录，以及本次初始化诊断和未完成沙箱。拒绝混入本机档案和无关运行；不收集凭证、完整环境变量、.git 或事件载荷。

导出先验证原始记录，再产生带清单和 SHA-256 的 bundle.zip。产物名为 mediascope-test-evidence-<run_id>-<run_attempt>，保留 90 天，不覆盖。上传使用固定 SHA 的官方 upload-artifact。测试通过和上传成功是不同状态；导出/上传失败必须明确报错。取消、超时或平台故障仍可能没有完整证据，不能承诺每次异常均可保存。

## 本地同步和原样保存

```powershell
npm run evidence:sync
npm run evidence:list -- -Origin github-actions
npm run evidence:verify
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/import-github-test-evidence.ps1 -Archive <下载的ZIP>
```

同步分页查询远端产物，核对实际运行身份和 API 摘要；PR 的分支 head_sha 与实际合并测试 SHA 分别保存，不能混为同一提交，下载后执行本地导入。身份键为仓库/run_id/run_attempt；当前工作流只有一个产品回归 job。将来增加 job/矩阵时须同时扩展产物名及身份键，不能直接复用本方案覆盖不同 job。

鉴权优先 GH_TOKEN/GITHUB_TOKEN，随后使用现有 Git credential helper，禁用交互提示；不将凭证写入日志或档案。下载需具备 Actions 读取权限。导入不执行下载包中的程序，校验安全路径、内部清单、仓库/提交/运行身份和实际发布门槛。支持 bundle ZIP 和 upload-artifact 外层 ZIP，保留原始传输字节及内部文件，不重跑测试替代云端记录。

正式记录位于 evidence-archive/tests/github-actions/<原时间精度与编号>/；当前导出器生成毫秒 UTC 编号，历史导入不强制补毫秒，精度规则见[归档说明](evidence-archive-template.md)。新本地封装的时间来源及精度与 GitHub 的仓库/run_id/run_attempt/SHA 身份分别校验，精度兼容不会放宽成功 CI 的完整证据门槛。同次同内容导入不重复，不同内容拒绝覆盖。未完成下载、导入失败诊断保存在 pending。sync-state.json 区分已保存、缺失、过期和同步错误；partial scan 说明分页范围尚未完整，不能据此宣称全部运行已归档。

npm start、npm test、test:core、test:browser 运行前会尝试小范围补同步，失败不阻止原命令；MEDIASCOPE_SKIP_EVIDENCE_SYNC=1 可跳过。本轮不安装后台服务或系统定时任务；需要全量补查时显式运行 evidence:sync。同步不会上传本机资料，电脑离线时延后。

远端临时磁盘和限期产物不是永久备份。过去未上传的文件不能从测试状态补造；可取得的原始日志需明确其证据范围。正式发布 ZIP 与产品用户报告各自保留。
