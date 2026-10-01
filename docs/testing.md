# MediaScope 测试规范

在项目根目录执行。要求 Windows x64、`runtime-lock.json` 支持的 Node.js 和具备完整能力的稳定 FFmpeg/FFprobe；浏览器测试使用已安装的 Microsoft Edge。开发依赖不随安装包分发。

## 运行入口

```powershell
npm ci --ignore-scripts
npm test
npm run test:core
npm run test:browser
npm run test:release
```

- `npm test` 验证当前版本完整回归：非零实际检查、零失败/取消/跳过/TODO、全部功能映射通过。通过条件与 Actions 一致；本地开发允许未提交修改，并保存源码快照。
- `core`、`browser` 是部分范围。退出码 0 只表示所执行检查通过，输出明确标为部分验证；出现跳过或 TODO 则标为验证不完整，不能替代完整回归或发布验证。
- `npm run test:release` 等同于 `node scripts/test.mjs --release`，在上述完整回归条件之外要求干净的当前工作区；这是与 Actions 完全对应的本地入口。不能与部分范围或 `--source-ref` 合用。兼容入口为 `scripts/record-test.ps1 -Kind App -Release`。
- `--source-ref <提交>` 只读取指定提交，不切换分支；应用与当前测试系统的身份分别保存。历史对比允许明确标为不适用的功能，但输出不得称为当前版本完整验收；`--require-clean` 仅检查工作区，不等同于发布验收。
- 优先使用锁定私有 FFmpeg/FFprobe，再查询 PATH。可用 `FFMPEG_PATH`、`FFPROBE_PATH`、`MEDIASCOPE_BROWSER_PATH` 指定程序；缺少依赖、初始化失败或零用例都不能报告成功。

提交规范工具使用独立命令 `npm run test:commits` 验证格式、事件范围及真实 Git 提交快照。该检查无需媒体运行时，不纳入应用功能映射或产品发布测试数；入口和 PR 要求见[贡献与提交规范](contributing.md)。

## 覆盖与结果

功能与用例的唯一映射为 [`test/coverage.json`](../test/coverage.json)，覆盖媒体分析、指标与位深/色彩、时间轴、SI/TI、试编码、队列、报告、图表和真实浏览器交互。新增功能须同时更新用例与映射。

素材由真实 FFmpeg 编码，测量来自生产代码和真实后端；不得伪造工具返回、指标、任务状态或 DOM，也不得改写应用源码制造通过。数学边界、损坏数据和测试系统协议用例可使用明确标记的约定输入，不声称产生媒体测量。

`features.json` 按实际事件列出通过、失败、跳过、未执行及缺少证据的文件；部分覆盖标为 `partial`。映射不是代码覆盖率，一个用例通过不能证明所有平台或素材组合通过。性能测试验证计算等价，不代表目标机器吞吐率。

当前版本支持报告侧边栏、紧凑任务状态以及浅色/深色主题；这些必需功能缺失时直接失败，不能通过自动跳过放行。只有运行器明确指定的历史源码对比允许缺失功能标为不适用；历史主题检查验证其实际声明支持的主题。主题检查验证文字与实际背景的对比度，不要求说明文字和正文使用相同颜色，不代表完整 WCAG 合规认证。

新记录的 `manifest.validation` 明确区分 `full-regression`、`partial-regression` 和 `historical-comparison`，并记录 `complete`、`partial`、`incomplete` 或 `failed`。`outcome: passed` 在部分范围和历史对比中仅表示所执行检查通过，应结合 validation 与 scope 解读；旧记录按原有含义读取，不补造完整性结论。

| 应用测试退出码 | 含义 |
| --- | --- |
| `0` | 当前完整回归通过，或部分范围/历史对比的已执行检查通过；须同时查看验证范围及完整性 |
| `1` | 测试失败，或当前完整回归/发布门槛未满足 |
| `2` | 环境、框架或归档阻塞；不得当作产品通过 |

浏览器执行实际用户操作，使用独立报告目录和随机端口；套件串行执行，等待条件有明确边界。只有 Fetch 明确拒绝的 `bad port` 可在产品检查前重新申请端口（最多 10 次，保留启动日志）；产品断言和其他启动错误不重试。

## 证据与维护

每次应用测试从独立源码快照运行，成功、失败和前置阻塞都保留记录。运行沙箱及证据位于 evidence-archive/pending；校验并登记正式归档后才回收本次沙箱。新的统一目录包裹 original 原始记录，不改写原 schema。
归档封装与产品 manifest 是独立 schema：新封装 schema 3 记录编号时间的来源、精度和时区，并兼容旧封装 schema 1/2。毫秒、秒、日期和未知时间按来源保存，不补造精度；目录编号时间不是产品运行耗时或时钟准确度证明。具体规则见[归档说明](evidence-archive-template.md)。

| 记录 | 保留内容 |
| --- | --- |
| App（manifest schema 3） | 源码 ZIP/摘要、程序身份、逐项结果、功能映射、gzip 原始事件与输出、实际报告/指标日志/CSV/失败截图、生成素材摘要 |
| Package / OnlineDeployment（schema 2，新记录 evidenceRevision 1） | 确切 ZIP 的摘要与大小、验证脚本及运行时锁快照、结构化部署断言、必要状态/报告/日志；成功必须有非零实际断言 |
| Custom | 指定程序的命令、输出和退出码；须填写 `-Executable`、`-Arguments`、`-Label`，不自动解释为完整产品验收 |

新 App 使用 `evidenceRevision: 1`；功能记录使用 schema 2。旧记录按原 schema 解读，不补造缺失信息。串行/并行测量结果与已有指标日志先保留，再由运行器归档；程序、上游 ZIP 和可重建媒体不重复进入新应用证据。

日志默认以 16 MiB 为保存上限，必要时压缩；仍超限则保留完整沙箱并报错，不截断。App 用 `--max-log-mib` 调整，兼容入口用 `-MaxLogMiB`。总证据默认超过 1 GiB 提醒，不自动删除。

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/verify-test-evidence.ps1
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/list-test-evidence.ps1
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/recover-test-evidence.ps1 -RunId <编号>
```

恢复前先确认进程已结束并审查 `evidence-archive/pending/test-run.lock`，不能直接删除锁。应用记录提交使用原子清单替换；登记失败保留待处理证据，恢复不增加产品测试通过数。包/部署或其他未完成记录须先审查暂存及日志。

原生安装/卸载弹窗、全部响应式尺寸和媒体组合、真实首次联网下载仍按[发布规范](releasing.md)分别验收。npm run evidence:list 支持 -- -Origin local/github-actions、-Version、-Outcome、-Json 筛选。归档命名、永久保留、Git 范围及清理统一见[本地数据规范](local-data.md)。

GitHub 自动执行使用同一完整发布入口，远端运行身份、证据范围及本地长期导入见 [GitHub 自动测试](github-actions.md)。本地证据不会自动上传；云端证据必须下载并校验后才能称为本地永久归档。使用 npm run evidence:sync 同步；npm start/npm test 的包装入口会尝试补同步，网络失败不会改变应用测试结果。直接调用测试脚本不自动同步。
