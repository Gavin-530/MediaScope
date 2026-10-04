# 测试规范

在项目根执行。要求 Windows x64、`runtime-lock.json` 支持的 Node.js 和具备完整能力的稳定 FFmpeg/FFprobe，浏览器测试使用已安装的 Microsoft Edge。开发依赖不随安装包分发。

## 入口与通过条件

```powershell
npm ci --ignore-scripts
npm test
npm run test:core
npm run test:browser
npm run test:release
```

| 入口 | 范围和条件 |
| --- | --- |
| `npm test` | 当前源码完整回归；允许未提交改动并记录实际源码身份 |
| `test:core` / `test:browser` | 部分范围，不能替代完整回归或发布验证 |
| `test:release` | 等同 `node scripts/test.mjs --release`；完整回归且当前工作区干净，与 Actions 入口一致 |

完整回归要求非零实际检查、零失败/取消/跳过/TODO、全部功能映射通过。缺依赖、初始化失败、零用例或归档阻塞不得称为产品通过。发布入口不能与部分范围或 `--source-ref` 合用；兼容入口为 `scripts/record-test.ps1 -Kind App -Release`。

`--source-ref <提交>` 读取指定提交而不切换工作区，应用与当前验证器身份分别保存。历史缺失功能可明确标为不适用，结论属于历史对比；`--require-clean` 只增加工作区检查，不单独构成发布验收。可用 `FFMPEG_PATH`、`FFPROBE_PATH`、`MEDIASCOPE_BROWSER_PATH` 指定工具；否则优先锁定私有媒体运行时，再查询 PATH。

| 应用退出码 | 含义 |
| --- | --- |
| `0` | 所执行检查通过，仍须看验证模式与完整性 |
| `1` | 测试失败或当前完整回归/发布门槛未满足 |
| `2` | 环境、框架或归档阻塞 |

## 覆盖和结果解释

[`test/coverage.json`](../test/coverage.json) 是功能与用例的唯一映射；新增功能同时更新用例和映射。素材由真实 FFmpeg 编码，测量来自生产代码及真实后端，浏览器执行实际操作。不伪造工具返回、指标、任务状态或 DOM，不改写应用源码制造通过。数学边界、损坏输入和协议用例可以使用明确标记的约定数据。

`features.json` 保存实际功能事件和缺少证据的文件；映射不是代码覆盖率，不证明所有平台或素材组合均已验证。当前源码的必需功能不能通过自动跳过放行；只有显式历史对比允许不适用。主题检查验证文字与实际背景的对比度，不代表完整 WCAG 认证；性能观察不代表目标机器吞吐率。

`manifest.validation` 区分 `full-regression`、`partial-regression`、`historical-comparison`，完整性为 `complete`、`partial`、`incomplete` 或 `failed`。部分范围或历史对比的 `outcome: passed` 只说明已执行检查通过；跳过和 TODO 使验证不完整。旧记录沿用原含义，不补造结论。验证陈述只引用对应源码/附件的真实记录，不累计历史通过数。

浏览器套件串行执行，使用独立数据目录、随机端口和有界等待。仅 Fetch 明确拒绝的 `bad port` 可在产品检查前重新申请端口，最多 10 次并保存日志；产品断言和其他启动错误不重试。

## 记录与故障恢复

应用测试使用独立临时源码工作区，保存并校验本次结果后发布正式记录，再回收自己的沙箱。源码与验证器身份分别记录，未提交源码未保存时不保证将来精确重现。App 保存逐项结果、功能状态、日志和实际测量；包/部署检查保存 Git/包身份及非零结构化断言；Custom 仅证明指定命令与退出码。

日志无损压缩，压缩后默认上限 16 MiB，仍超限则保留完整沙箱并报错，不截断。App 用 `--max-log-mib`、兼容记录器用 `-MaxLogMiB` 调整；总证据默认超过 1 GiB 提醒。记录格式、独立校验、历史维护及保留规则见[数据与归档](data-and-archives.md)。

```powershell
npm run evidence:list
npm run evidence:verify
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/recover-test-evidence.ps1 -RunId <编号>
```

恢复前检查进程和 `evidence-archive/pending/test-run.lock`，不可仅因文件存在或测试未返回就删锁。归档失败保留待处理资料；索引故障不撤销已封存结果，恢复不增加产品通过数。直接执行 `scripts/test-deployment.ps1` 也进入记录器，内部 `-ManagedEvidence` 由记录器/包验证器使用；旧 pending 不自动清理。

## GitHub 自动测试

[产品工作流](../.github/workflows/tests.yml) 在 push（包括 Tag）、PR、merge_group 和 workflow_dispatch 使用 Windows Server 2022 x64，下载并校验锁定运行时，执行 `npm ci --ignore-scripts` 和 `node scripts/test.mjs --release`。Edge 使用 runner 已装版本并记录身份。本地保存文件不触发远端测试，工作流修改提交推送后才生效。

本地和远端是独立执行，不合并通过数。记录仓库、测试 SHA、run_id、run_attempt、job 和事件；PR 的 head SHA 与实际合并测试 SHA 分别保留。比较结果须核对源码、验证器、实际工具和范围，不要求日志/截图字节相同。当前只有一个产品回归 job，扩展矩阵前须同步扩展证据身份及产物名。

测试步骤结束后，即使失败也尝试导出；初始化失败或中断保存明确 blocked 诊断。导出器只用于 GitHub-hosted runner，核对本次身份并验证记录，不导出凭证、完整环境、`.git`、事件载荷、临时源码或运行时。正常完成不重复保存初始化日志。

导出成功后上传带清单和摘要的 `bundle.zip`；产物名为 `mediascope-test-evidence-<run_id>-<run_attempt>`，工作流配置保留 90 天、禁止覆盖，upload-artifact 固定到 SHA。测试、导出、上传和整个工作流完成分别判断，取消或平台故障可能没有完整证据。长期保存、导入、同步和来源核验统一见[数据与归档](data-and-archives.md)。

`Commit messages` 在 Ubuntu 24.04 检查提交及 PR 标题，规则见[贡献规范](contributing.md)。必需合并检查须由管理员配置，绿色工作流不自动发布，也不替代包验证、真实首次联网部署和[人工发布验收](releasing.md)。

归档工具变更先运行 `npm run test:github` 和受影响的存储协议检查；测试入口、导出器等影响产品验证的改动还须完成本次完整回归。
