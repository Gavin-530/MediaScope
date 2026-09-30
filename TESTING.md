# MediaScope 测试与证据

默认入口为 `npm test`。功能与用例映射在 `test/coverage.json`，每次运行从实际测试事件生成 `features.json`。失败、跳过、未执行分别列出；一个用例通过不能推断全部平台、媒体和交互都通过。

## 运行

Windows x64，使用 `runtime-lock.json` 支持的 Node 和完整的稳定 FFmpeg/FFprobe。浏览器测试使用已安装的 Microsoft Edge；固定开发依赖 `playwright-core` 不下载浏览器，也不随发布包分发。

```powershell
npm ci --ignore-scripts
npm test
npm run test:core
npm run test:browser
node scripts/test.mjs --source-ref <准确提交哈希>
node scripts/test.mjs --require-clean
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/verify-test-evidence.ps1
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/list-test-evidence.ps1
```

`core`/`browser` 是部分范围，不能代替完整回归。`--source-ref` 读取 Git 提交，不切换或合并分支；应用来自该提交，测试来自当前系统，二者分别记录。发布前使用 `--require-clean`。开发允许未提交变化，但保存确切文件和摘要，不能仅用 HEAD 标识这些变化。

优先使用已安装的锁定私有 FFmpeg/FFprobe，再查询 PATH；`FFMPEG_PATH`、`FFPROBE_PATH` 可显式指定，但必须通过实际能力检查。`MEDIASCOPE_BROWSER_PATH` 可指定兼容 Chromium 的浏览器。缺少依赖或浏览器时记录环境阻塞，不能跳过整个浏览器套件后报告成功。

## 功能与实际证据

| 功能 | 验证内容 | 主要测试 |
| --- | --- | --- |
| 页面/API | 完整 ES 模块、随机端口、会话令牌、本机访问保护 | server、browser startup |
| 信息/完整分析 | Unicode、多音轨、帧和包体积、H.264 IDR/HEVC CRA/AV1 事件、GOP | engine、browser analysis |
| 图表 | 实际 GOP 翻页、缩放/定位、逐帧 CSV 对照报告、页签状态 | chart-model、browser analysis/tab-retention |
| 质量比较 | 同文件恒等、有损误差、PSNR/SSIM/VMAF、YUV 420/422/444、8/10/12-bit、SDR/PQ/HLG | engine、bitdepth、browser comparison |
| 时间轴/解释 | 严格及帧序配对、用户确认、色度假设和来源 | engine、chroma-assumption、browser alignment |
| SI/TI | 实际逐帧样本、串行/并行一致、请求/实际线程 | siti、server、browser analysis |
| 试编码 | x264/x265/AV1、CRF/preset/位深矩阵、精确转换、真实指标、临时文件生命周期 | trial、engine、browser trial |
| 队列 | 暂停/继续/取消、失败后继续、重排队、计划顺序和原子导入 | server、browser queue-plans |
| 报告 | 实际 API/GUI 数据精确往返、旧封装兼容、损坏拒绝、保留当前报告 | report、portable、browser portable |
| 优化正确性 | 共享/分离解码、缓存、并行分析结果及原始日志一致 | performance |
| PR 新 UI | 异步侧边栏真实点击、紧凑失败状态、主题转换后按钮及实际报告文字的可读性 | browser sidebar/compact-task/theme |

素材由真实 FFmpeg 编码；精确位深测试从已知原始像素编码成无损媒体。测量结果必须来自生产代码和真实 FFmpeg，生成的视频不等于虚构报告。不得伪造 FFprobe 返回、指标、任务成功状态、DOM，也不得改写应用源码后执行“测试”。旧 VM 假 DOM 测试已替换为真实浏览器和实际报告测试。

独立算法/验证仍需要数学边界输入，例如无穷、折线断点、非法参数、元数据冲突；这些测试验证函数约定，不声称产生媒体测量。坏文件测试明确损坏实际导出数据。未知字段保留检查只添加非测量扩展，不能添加伪造 PSNR/VMAF。

浏览器执行用户操作，真实后端计算。场景有独立报告目录和随机端口；串行运行避免旧用例共享文件名互相覆盖。颜色检查等待实际 CSS 过渡结束；页面条件使用有界等待，不得靠删除失败断言使测试通过。

## 结果和归档

应用测试退出码：`0` 已执行检查通过、`1` 存在测试失败、`2` 环境/框架/归档阻塞。零用例、没有结构化汇总、缺少依赖、初始化失败不能通过。断言失败、基础设施失败、需审查运行异常分别记录；分类辅助排查，不能证明所有断言失败都是产品缺陷。跳过不计入通过数；旧版本没有侧边栏等功能时明确说明，新功能合并检查应实际执行对应项。

测试前实际检查编码器、滤镜、指标、HTTP 与浏览器。环境失败保留原因，不冒充产品结果。结果来自 Node 结构化事件，不依赖人类日志语言、源码引号或换行。

唯一归档沿用 `local-test-archive/runs/<版本>/<UTC 时间>-<随机号>/`：

- `manifest.json`（schema 3）：范围、应用/测试身份、工作区、命令、时间、程序路径/版本/摘要和状态。
- `results.json`、`features.json`：逐项结果、错误、跳过原因和功能对应；`events.jsonl.gz` 与 `output.log.gz` 保留完整原始输出。
- `source.zip`、`source-manifest.json`：确切应用/测试源码及摘要。复现需相同程序版本、固定开发依赖；素材由源码和 `fixture-recipe.json` 重建，不能重放已删沙箱的绝对路径。
- `artifacts/`：实际报告、任务输入/失败、生成命令、指标日志、CSV、失败截图，gzip 压缩；`artifact-manifest.json` 记录生成文件摘要和是否保留。
- `SHA256SUMS.txt`、根目录 `catalog.json`：校验文件变化和整份记录缺失。失败不能被重跑成功覆盖；历史记录不修改。

不重复保存程序、上游 ZIP、生成视频。测试在 `.build/test-runs/<本次编号>/` 的快照中运行，只有归档登记并完整校验后才删除本次沙箱；中断/归档失败时保留。`test-run.lock` 含进程信息，先检查活跃进程及待处理证据，不能直接删除锁。压缩日志仍超过默认 16 MiB 时保留完整沙箱并报错，不截断；`--max-log-mib` 可调整。总证据超过默认 1 GiB 提醒，不自动删证据。

目录清单使用原子替换，Windows 暂时占用时短暂重试；仍失败则保留证据并把尚未登记的记录退回暂存。确认该次进程已结束后，`scripts/recover-test-evidence.ps1 -RunId <编号>` 可校验并恢复准确记录，保留清单候选的维护审计，再回收沙箱。维护恢复不重新计算或增加产品测试通过数。产品用例通过后发生归档失败，运行器仍返回 2，不能忽略这类错误。

旧入口 `record-test.ps1 -Kind App` 委托同一新运行器。`Package`/`OnlineDeployment` 仍验证准确 ZIP，保存本次状态/报告/日志，校验归档后回收本次部署/解包沙箱。离线运输夹具复制经哈希校验的真实上游 ZIP，验证复用/损坏；它不能代表联网下载已通过。

Windows 原生选择弹窗、全部响应式尺寸/媒体组合、真实首次联网下载和目标机器性能预算没有自动宣称通过。交互安装/卸载、联网部署按 `RELEASING.md` 单独验收。新增功能须更新映射和实际用例；合并前再核对准确提交、最新目标分支、冲突、GitHub 必需检查和审批。
