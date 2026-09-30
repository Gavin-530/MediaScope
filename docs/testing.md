# MediaScope 测试规范

在项目根目录执行。要求 Windows x64、`runtime-lock.json` 支持的 Node.js 和具备完整能力的稳定 FFmpeg/FFprobe；浏览器测试使用已安装的 Microsoft Edge。开发依赖不随安装包分发。

## 运行入口

```powershell
npm ci --ignore-scripts
npm test
npm run test:core
npm run test:browser
node scripts/test.mjs --release
```

- `npm test` 是完整回归；`core`、`browser` 是部分范围，不能替代发布验证。
- `--release` 要求干净的当前工作区、完整套件、零失败/取消/跳过/TODO，以及全部功能映射通过；不能与部分范围或 `--source-ref` 合用。兼容入口为 `scripts/record-test.ps1 -Kind App -Release`。
- `--source-ref <提交>` 只读取指定提交，不切换分支；应用与当前测试系统的身份分别保存。普通开发测试允许 dirty 工作区并保存确切源码；`--require-clean` 仅检查工作区，不等同于发布验收。
- 优先使用锁定私有 FFmpeg/FFprobe，再查询 PATH。可用 `FFMPEG_PATH`、`FFPROBE_PATH`、`MEDIASCOPE_BROWSER_PATH` 指定程序；缺少依赖、初始化失败或零用例都不能报告成功。

## 覆盖与结果

功能与用例的唯一映射为 [`test/coverage.json`](../test/coverage.json)，覆盖媒体分析、指标与位深/色彩、时间轴、SI/TI、试编码、队列、报告、图表和真实浏览器交互。新增功能须同时更新用例与映射。

素材由真实 FFmpeg 编码，测量来自生产代码和真实后端；不得伪造工具返回、指标、任务状态或 DOM，也不得改写应用源码制造通过。数学边界、损坏数据和测试系统协议用例可使用明确标记的约定输入，不声称产生媒体测量。

`features.json` 按实际事件列出通过、失败、跳过、未执行及缺少证据的文件；部分覆盖标为 `partial`。映射不是代码覆盖率，一个用例通过不能证明所有平台或素材组合通过。性能测试验证计算等价，不代表目标机器吞吐率。

| 应用测试退出码 | 含义 |
| --- | --- |
| `0` | 已执行检查通过；普通模式仍可能有明确跳过项 |
| `1` | 测试失败或未满足发布门槛 |
| `2` | 环境、框架或归档阻塞；不得当作产品通过 |

浏览器执行实际用户操作，使用独立报告目录和随机端口；套件串行执行，等待条件有明确边界。只有 Fetch 明确拒绝的 `bad port` 可在产品检查前重新申请端口（最多 10 次，保留启动日志）；产品断言和其他启动错误不重试。

## 证据与维护

每次应用测试从独立源码快照运行，自动归档成功和失败记录，校验后才回收本次沙箱。前置阻塞也保留调用参数和原因。

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

恢复前先确认进程已结束并审查 `test-run.lock`，不能直接删除锁。应用记录提交使用原子清单替换；登记失败保留待处理证据，恢复不增加产品测试通过数。包/部署或其他未完成记录须先审查暂存及日志。

原生安装/卸载弹窗、全部响应式尺寸和媒体组合、真实首次联网下载仍按[发布规范](releasing.md)分别验收。归档命名、永久保留、Git 范围及清理统一见[本地数据规范](local-data.md)。

GitHub 自动执行使用同一完整发布入口，远端运行身份、证据范围及本地长期导入见 [GitHub 自动测试](github-actions.md)。本地证据不会自动上传；云端证据必须下载并校验后才能称为本地永久归档。
