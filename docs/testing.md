# 软件代码、测试工具与数据总记录

本正文集中说明软件行为契约、测试入口、各个维护文件和输入的用途。实际结果由对应源码的执行回执记录。

[产品契约](../testing-tools/product.json)登记业务、行为要求、运行与构建文件、API 和表单控件。[正式用例目录](../testing-tools/modules/catalog.json)登记可执行用例。实际通过以同一源码身份的执行回执为准。

正文导航：[边界与判定](#边界与判定) · [环境与准备](#环境与准备) · [选择入口](#入口与选择) · [目录分工](#实际目录与分工) · [软件要求与判据](#软件要求判据与执行绑定) · [每个文件](#每个文件的用途) · [每个用例](#每个正式与工具自证用例) · [动态素材](#每个测试文件的动态素材与控制数据) · [固定原件](#每项固定数据来源与资格) · [拓展](#独立拓展与维护清单) · [验收回执](#验收回执)

## 边界与判定

正式测试检查正常行为、错误拒绝、取消/恢复、真实计算和数据往返。资源上限只做轻量准入校验，不解码最大工作负载。大尺寸、长时、大帧数、导出容量、性能与研究实验均由开发者显式选择拓展工具和参数，绝不自动加入软件正式全量，也不把不同上限组合成一个未经请求的测试。

完整软件验证由通用回归（含浏览器和工具自证）、真实GPU、真实Windows交互、同源打包与离线部署、同一包首次联网部署五阶段组成。缺硬件/交互桌面/网络或阶段、实际失败、skip/TODO/取消、零断言、缺测量、来源不一致均不能报完整通过。候选验证不等于 main 已交付或正式发布已验收。

每例有稳定ID及唯一主责，相关API/报告/界面层可共同覆盖一个业务域，但相同ID只执行一次。测试不能用生产实现生成自己的预期答案；合成媒体用于控制特征，协议非法样本只证明拒绝规则，历史参考只证明兼容。SI/TI采用明确的VQEG兼容剖面，VMAF以官方引擎/模型对照，不宣称标准认证或任意场景的主观质量保证。

执行证据保留真实输入摘要、生产返回/拒绝、实际HTTP/浏览器数据、断言和必要测量；另保留V8函数/范围计数作为查漏线索。V8计数不覆盖C#/PowerShell、全部分支或全部组合，不能用一个百分比承诺不存在未知缺陷。

临时源码、生成媒体和日志只在项目.build下。正式固定输入唯一来源为fixtures.lock.json；维护输入另有清单；测试工具目录禁止混入运行垃圾或未锁定素材。旧资料未迁移、删除或作为默认输入引入。

扩展新功能时，先在product.json补行为要求/判据及新文件、接口/API、控件对应，再添加稳定用例和有来源的输入。新接口/文件/控件、无归属用例或不明输入会被阻断；已有函数内部语义变化仍需开发者审阅行为要求，不会由静态扫描自动推断其充分性。

## 环境与准备

在候选根目录执行。Node须满足runtime-lock.json（当前22或24主版本）；开发依赖按package-lock.json安装，浏览器驱动为固定版本playwright-core。依赖缺失时执行 npm ci --cache .build/npm-cache；候选及其依赖均位于项目.build中。

媒体计算使用runtime-lock.json规定的FFmpeg/FFprobe和必要编码器/指标能力；可用FFMPEG_PATH、FFPROBE_PATH指定已核验的实际程序。每次需要媒体的选择均先实跑能力检查并保存程序摘要，不把PATH中任意版本视为合格。Node纯模型/协议选择不需要生成媒体。

浏览器阶段默认使用本机Edge，也可用MEDIASCOPE_BROWSER_PATH指定实际浏览器程序。完整验证还需要真实OpenCL GPU、Windows交互桌面、PowerShell/.NET编译环境，以及首次联网部署需要的网络。缺失条件应报告未完成；不能用CPU回退、无头页面或缓存下载冒充这些阶段。

固定输入按用例实际需要下载并验摘要；MEDIASCOPE_TEST_FIXTURES可指定项目.build内已核验缓存。普通正式测试不安装Python/NumPy/SciPy；仅显式参考维护使用environment.lock.json的独立环境。临时目录、安装缓存和生成文件保持在本项目.build内。

## 入口与选择

在候选根执行；可先用 --dry-run 查看精确ID、文件和阶段。正式阶段与拓展不能互相顶替。

```powershell
npm run test:all                     # 五阶段软件完整验证；通用阶段默认2个文件并行
npm run test:all -- --require-clean  # 干净候选提交，统一产生严格通用和 GPU 验收回执
npm test                            # 通用阶段，不代表五阶段完整通过
npm test -- --module bitrate        # 本业务及对应API/报告/界面用例
npm test -- --module frames,repeat
npm test -- --requirement repeat.samples # 细分行为组（直接用例）
npm test -- --case <稳定ID>          # 精确单例
npm test -- --suite gpu --module siti
npm run test:native
npm test -- --affected HEAD --dry-run # 按变更文件保守选业务；未知共享代码扩大范围
npm test -- --module reports --jobs 2
npm test -- --extend --list
npm test -- --extend <工具ID> --config <显式配置.json>
npm test -- --maintain --list
```

full（默认通用阶段）/core/browser/gpu/native是执行阶段过滤；--module是业务及关联层过滤，--requirement是细分行为组直接用例，--case是精确用例过滤，组合时取交集，矛盾或未知项报错。拓展和维护使用独立前缀及目录；规模参数必须显式提供。工具自身用例在tooling/test-system，不属于软件业务模块。

命名兼容说明：test:release保留通用回归加干净工作区资格检查，test:gpu:release保留GPU加干净工作区资格检查；它们各自的通过不能替代五阶段test:all。主线候选的范围和回执见[本地与 Actions 分工验收](#本地与-actions-分工验收)。

## 实际目录与分工

| 位置 | 职责 |
| --- | --- |
| testing-tools/modules/<业务>/ | 11业务区的正式用例及专用工具 |
| testing-tools/tooling/test-system/ | 调度/归档/来源/清理边界等工具自身的自证 |
| testing-tools/helpers/ | 跨业务共用的控制媒体、选择、观察、进程、ZIP等；不放专属压力程序 |
| testing-tools/data/ | 3项获审本地正式固定数据；均受正式锁定清单核验 |
| testing-tools/extensions/ | 显式开发者拓展；独立结果在.build/testing-extensions |
| testing-tools/maintenance/ | 独立参考生成与环境/输入锁；输出仅为待审候选 |
| .build/test-runs/<ID>/s/ | 单次隔离执行快照和可回收生成输入 |
| evidence-archive/records/<ID>/ | 实际通过/失败回执、输入、测量和日志；失败也保留 |
| .build/complete/<ID>/complete.json | 五阶段源码/工具/规则/同包关联及最终判定 |

| 业务分区 | 主责用例数 | 阶段 | 正式目录 |
| --- | --- | --- | --- |
| desktop / 安装、启动与环境 | 21 | general, browser, native | [testing-tools/modules/desktop/](<../testing-tools/modules/desktop/>) |
| media-info / 媒体信息与轨道 | 9 | general | [testing-tools/modules/media-info/](<../testing-tools/modules/media-info/>) |
| frames / 帧结构、GOP与时基 | 6 | general | [testing-tools/modules/frames/](<../testing-tools/modules/frames/>) |
| bitrate / 码率与包分布 | 14 | general | [testing-tools/modules/bitrate/](<../testing-tools/modules/bitrate/>) |
| siti / SI/TI | 21 | general, gpu | [testing-tools/modules/siti/](<../testing-tools/modules/siti/>) |
| repeat / 重复帧与时间诊断 | 21 | general | [testing-tools/modules/repeat/](<../testing-tools/modules/repeat/>) |
| quality / 画质比较 | 29 | general | [testing-tools/modules/quality/](<../testing-tools/modules/quality/>) |
| trials / 试编码与BD-rate | 37 | general | [testing-tools/modules/trials/](<../testing-tools/modules/trials/>) |
| jobs / API、队列与运行数据 | 24 | browser, general | [testing-tools/modules/jobs/](<../testing-tools/modules/jobs/>) |
| reports / 报告与文件协议 | 32 | general | [testing-tools/modules/reports/](<../testing-tools/modules/reports/>) |
| ui / 界面与图表 | 66 | general, browser | [testing-tools/modules/ui/](<../testing-tools/modules/ui/>) |

## 软件要求、判据与执行绑定

本节汇总行为边界和独立判据。直接用例与关联集成用例分别登记在[产品契约](../testing-tools/product.json)的 `cases` 和 `integrationCases` 中。`npm run test:list -- --requirement <要求ID>` 可预览默认套件内的直接用例。GPU 或原生用例使用对应套件。执行状态见同一候选的[验收回执](#验收回执)。

| 要求 ID / 业务 | 行为与边界 | 独立判据 |
| --- | --- | --- |
| media-info.properties / media-info | 原始媒体、轨道、色彩和附属信息：真实8/10/12位、RGB/灰度、半平面、多轨、字幕/附件/章节；未知值不伪造；损坏补充读不覆盖已成功的基本读。 | 独立FFprobe原始字段、生成配方、已知描述符 |
| media-info.inventory / media-info | 路径与完整轨道清单：Unicode路径、音轨清单、每帧和每包计数；重复side-data保留来源。 | 独立FFprobe逐项原始输出 |
| frames.codec / frames | 帧、NAL、GOP和AV1参考关系：H.264 IDR来自NAL；HEVC CRA/IDR分离；AV1隐藏帧、show-existing及参考槽不丢失。 | 实际编码器输出与NAL/OBU原始头 |
| frames.budget / frames | 头跟踪预算与逐帧结果分离：跟踪预算耗尽必须显式说明；解码GOP及独立SI/TI仍完整，不能静默截断。 | 人为受控小预算与实际解码帧 |
| frames.execution / frames | 并发与串行帧结构一致：同文件并发和串行逐项帧、包及头结构结果一致。 | 同源同参数串行对照 |
| bitrate.windows / bitrate | 有理时间戳与半开窗口：VFR、负PTS、重复/缺失PTS、零字节、裁尾和大整数时间不丢字节；100ms和1s守恒。 | 整数手算、独立窗口聚合与PCM已知字节 |
| bitrate.distribution / bitrate | 离散包与帧时间视图：原始包数量、时间、字节证据不可改变；缺失时刻或预算超限显示不可用。 | 显式整数控制数据与拒绝样本 |
| bitrate.engine / bitrate | 多音轨实际包归属：各轨包、逐窗口字节和总计一致；不能把容器字节充当视频有效码流。 | 独立FFprobe包清单 |
| bitrate.validation / bitrate | 实际高包率和VFR窗口：普通规模编码包的窗口结果、空窗、缺失时刻与序列化均满足字节守恒。 | 独立包原始输出重新聚合 |
| siti.admission / siti | SI/TI输入准入：在真实解码之前拒绝非法尺寸、帧数、场景索引及设备参数；只验证常量边界，不解码上限工作负载。 | 常量导出的正反例和未启动命令记录 |
| siti.recovery / siti | SI/TI解码失败收束：无效样本必须停止并排空正在运行的真实解码器，不能悬挂或冒充完整结果。 | 实际失败与子进程退出 |
| siti.frames / siti | 每解码帧的SI/TI对应：实际每帧对应一条测量，首帧和场景边界TI规则明确。 | 实际解码帧清单 |
| siti.preflight / siti | 入队前检查所选轨道的亮度码值。完整扫描才可报告未发现越界。命中可提前结束，由用户选择严格模式或标称裁剪。结论仅对匹配的文件状态、轨道与设置有效。 | 已知码值的真实解码与原生帧字节、HTTP 进度与结论、文件签名及最终报告配置 |
| siti.reference / siti | SI/TI公式、布局、输入解释与兼容：完整格式布局、范围/传递/矩阵、alpha、隔行、场景、确定性及历史方法分开验证；采用明确的VQEG兼容剖面，不宣称标准认证。 | 固定独立字节向量、锁定VQEG函数、上游HLG、自制SDR/PQ控制及容差规范 |
| siti.hardware / siti | GPU真实计算与故障回退：实际设备必须是GPU；逐点独立判据及CPU对照通过；故障回退/恢复真实发生，CPU fallback不能满足GPU验收。 | 独立参考与真实OpenCL输出、设备和故障记录 |
| repeat.admission / repeat | 重复帧输入准入：非法原生帧字节描述符在解码前拒绝，不用巨大媒体假装边界覆盖。 | 受控微型原件和未启动命令记录 |
| repeat.samples / repeat | 原生样本比较：各布局、角落、padding、组件位深和差异整数依据独立标量判据；摘要碰撞不能替代直接相等。 | 自制原生字节和独立整数oracle |
| repeat.measurement / repeat | 重复区间、时间、差异与预览：真实视频的重复/变化、VFR/缺失时刻、静止候选、格式中途变化、取消和只读预览均检查；保留原样本和PTS。 | 已知逐帧配方、独立指纹/差异、实际FFmpeg证据 |
| repeat.qualification / repeat | 原生指纹与上游资格：NIST摘要及FFmpeg FATE向量进入真实产品链；取消和错误不能变成complete。 | 锁定NIST、FATE及官方输入 |
| quality.comparison / quality | 原生画质比较和时序准入：恒等/有损、位深/色度/色彩/时间序列、音视频偏移与取消；无法比较必须拒绝。 | 恒等解析值、独立FFmpeg日志和真实损坏 |
| quality.bitdepth / quality | 显式跨位深比较：未经确认不能转换；所有整数码、两个方向及色度损伤按规定公共域计算。 | 穷举整数映射和手算误差 |
| quality.chroma / quality | 用户色度位置假设：只补充未知值；不能覆盖声明、隐藏冲突或更改原始元数据。 | 声明/未知/冲突的明确控制输入 |
| quality.vmaf / quality | 官方VMAF模型和池化：HD/4K/NEG模型身份、方向、默认裁剪、Full/Limited、深度、色度和VFR按官方引擎逐点及池化对照。 | 官方libvmaf独立命令及模型身份 |
| quality.execution / quality | 解码复用与缓存正确性：共享/独立计算原始日志一致；源文件变化使缓存失效；取消保留不可完成状态。 | 同变量分离命令对照和真实变更 |
| trials.options / trials | 片段实验矩阵与双深度：编码器、preset/CRF矩阵、双深度、转换、取消、保留/清理边界明确，不能删除以前保留的素材。 | 自制源、整数归一化及原始编码日志 |
| trials.native / trials | 原生片段截取与多编码器：非关键帧起点、非零轨道、VFR、格式/位深与官方模型身份保持；不适用时拒绝。 | 独立解码源像素与官方VMAF |
| trials.encoders / trials | 真实编码与清理：H.264/H.265/AV1真实产生曲线，保持可比较采样格式，并移除任务临时素材。 | 真实编码和逐项输出文件检查 |
| trials.bd / trials | BD积分、插值与可用性：比例/反转/仿射解析值、稀疏警告、公共区间、单调性、重复及无穷输入不可静默删点。 | 解析曲线、独立SciPy和FAU/ITU样例 |
| trials.reference / trials | BD参考测量资格：原始JVET单元格含错误、原生像素SSE、视频码流字节、实际编码及JSON防篡改保持一致。 | 锁定原始JVET工作簿和独立整数像素oracle |
| jobs.api / jobs | 会话保护、任务与队列：会话/Origin、目标组合、所有任务类型、暂停/取消/重试/删除、计划原子导入及错误后继续执行。 | 真实HTTP、实际任务结果和文件生命周期 |
| jobs.admission / jobs | 场景列表API请求准入：合法较长场景列表可入队且不启动计算；非法上限索引拒绝。 | 真实HTTP请求字节与队列状态 |
| jobs.retention / jobs | 运行数据归属与清理：仅内存结果、显式保存媒体、导出持有、重启、活跃锁、链接及历史原件均遵守所有权边界。 | 真实磁盘/进程/链接与重启 |
| jobs.browser / jobs | 运行结果显式导入导出：真实浏览器导出后重启不自动恢复，只有明确导入恢复。 | 真实下载与重启后DOM |
| reports.protocol / reports | 报告内容完整性：四类真实报告与历史方法往返、原始证据、测量时间和工具不改变；非法/截断/非有限内容按协议拒绝。 | 真实报告逐字段深比较与损坏变体 |
| reports.portable / reports | 可移植容器与计划：现行/历史版本、生产者来源、选项、输入、扩展能力及非法内容均按协议处理。 | 独立控制容器、严格往返与拒绝样本 |
| reports.repeat / reports | 重复证据协议：摘要算法/编码/长度/输入、直接比较与碰撞、区间整数、可选元数据和执行身份不能混淆。 | 独立协议控制数据与精确不变量 |
| reports.time / reports | 并发时间汇总：只汇总任务墙钟，不把并发阶段相加，不伪造缺失时间。 | 已知重叠时间线解析值 |
| reports.units / reports | 单位及数值显示：十进制容量/码率前缀大小写、缺失和无穷、统一图轴及原始值保持。 | 明确数值和单位表 |
| desktop.atomic / desktop | 安装状态与包准入：Windows共享锁下原子替换不损坏原状态；私有资料/媒体进入包时拒绝。 | 真实文件共享锁和构造包 |
| desktop.window / desktop | 桌面窗口和服务寿命：验证前可显示但禁止媒体任务；缩放/多屏/最小化/最大化/损坏配置、刷新与关闭服务。 | 真实Edge窗口、HTTP与持久化配置 |
| desktop.environment / desktop | 组件选择和环境缓存：非PATH组件、单独FFprobe、取消/非法/下载分支、验证与无下载重用；此组弹窗边界模拟不代替native阶段。 | 真实工具摘要、安装状态和明确模拟边界 |
| desktop.fast / desktop | 快速启动、安全回退和退出：任意cwd、源/安装目录、过期/恶意提示、源变化、更新回滚、真实Ctrl事件及退出不泄漏服务。 | 实际CMD/C#入口和Windows控制事件 |
| desktop.transport / desktop | 启动端口前置条件：真实被Fetch禁止的端口在产品断言前重选，失败启动记录保留；其它错误不能重试掩盖。 | 实际HTTP/Fetch端口规则 |
| desktop.validation / desktop | 后台环境验证：日常启动避免重复全扫描；显式检查检测真实工具/DLL变化；失败保留可用界面和凭据。 | 真实工具更改、后台验证及缓存 |
| desktop.pickers / desktop | 真实文件和目录选择器：Unicode原件和目录、取消、重复打开与重入保护通过真实Windows对话框；环境不支持时阻断而非跳过。 | 仅操控本测试拥有的原生窗口及实际API返回 |
| ui.notes / ui | 方法和警告显示：未知/更改方法、资源限制和未确认场景仍可见，不修改原始报告。 | 受控报告与原件深比较 |
| ui.geometry / ui | 图表模型：实际行排序、时间/数值、缺失/无穷、整数刻度及显式Y界限，不改变源报告。 | 真实试编码行与解析几何控制值 |
| ui.interaction / ui | 完整浏览器交互：真实画布、范围/悬浮/固定点、表分页/导出、折叠、主题、侧栏、任务状态、错误恢复及全部业务流程。 | 真实Edge DOM/Canvas、HTTP、下载、报告与独立数据模型 |
| ui.workflows / ui | 用户操作与生命周期：选中范围导出、确认清理、悬浮任务拖动吸附、帧/包分页、AV1事件与旧GOP表示、色度假设、退出确认和网络恢复均检查实际状态；控制界面时间只用于文件命名，不替代计算证据。 | 真实HTTP、实际输入/测量/下载、DOM/Canvas及原生确认；无压力规模或伪计算报告 |

## 每个文件的用途

下表说明受维护文件的用途。测试文件的具体用例、数量和固定输入以[正式用例目录](#每个正式与工具自证用例)为准。

| 文件 | 角色 / 主责 | 具体用途 |
| --- | --- | --- |
| [.gitattributes](<../.gitattributes>) | 配置/资料 | Git 文件属性及换行规则。候选只规定文本处理；主工作区另有文档/代码角色分类改动，不能混为当前候选的 CI 规则。 |
| [.github/CONTRIBUTING.md](<../.github/CONTRIBUTING.md>) | 文档 | GitHub 贡献入口，指向 docs/contributing.md 的正式规则，避免维护第二份交付政策。 |
| [.github/PULL_REQUEST_TEMPLATE.md](<../.github/PULL_REQUEST_TEMPLATE.md>) | 文档 | PR 审阅模板：改动/验证/风险、主线交付和未完成范围；模板勾选本身不等于测试通过。 |
| [.github/RELEASE_TEMPLATE.md](<../.github/RELEASE_TEMPLATE.md>) | 文档 | 发布正文模板及实际附件摘要提示；须由 check-release-notes 和实际验收分别核对。 |
| [.github/workflows/commit-messages.yml](<../.github/workflows/commit-messages.yml>) | 配置/资料 | 现有提交/PR 标题工作流，在 Ubuntu 运行检查器自测及实际事件检查；不检查媒体计算。 |
| [.github/workflows/candidate-evidence-review.yml](<../.github/workflows/candidate-evidence-review.yml>) | 配置/资料 | 候选证据评审工作流，核对同一候选的本地回执和云端证据，并记录受保护环境审批。 |
| [.github/workflows/tests.yml](<../.github/workflows/tests.yml>) | 配置/资料 | 候选保留的 Windows 通用回归工作流：确切 SHA、锁定运行时、测试执行、证据导出上传及中断诊断；不提供真实 GPU 硬件矩阵。 |
| [.gitignore](<../.gitignore>) | 配置/资料 | 排除依赖、缓存、用户数据、正式记录正文、本机资料和发行 ZIP；忽略不等于允许清理，保护依据仍在数据策略中。 |
| [AGENTS.md](<../AGENTS.md>) | 文档 | 工作区操作约束：本机资料准入/检查、临时数据留在项目 .build、分支与主线交付边界。供开发代理执行任务时读取。 |
| [README.md](<../README.md>) | 文档 | 软件使用入口：安装/更新、环境选择、分析功能、报告与限制；面向用户，不承载逐次测试回执。 |
| [Uninstall.cmd](<../Uninstall.cmd>) | 运行源码/配置 / desktop | 用户双击卸载入口；委托 scripts/uninstall.ps1 执行组件/应用卸载与用户数据保护。 |
| [analysis.mjs](<../analysis.mjs>) | 运行源码/配置 / media-info, frames, bitrate, siti, trials | 分析编排：各轨包与码率、H.264/HEVC/AV1 结构跟踪、GOP、摘要、复杂度及试编码。调用 engine/SI/TI 等实现，组合实际测量结果，不充当独立测试答案。 |
| [bd-measure.mjs](<../bd-measure.mjs>) | 运行源码/配置 / trials | 从实际编码文件、参考片段及比较证据测量 BD 点：验证有效范围/像素，保存分量 SSE/PSNR、基本码流字节与摘要；供试编码/BD 参考使用。 |
| [docs/README.md](<../docs/README.md>) | 文档 | 正式文档职责索引及本机长期资料分类、准入、冻结和核查规则；local-notes 维护以此为准。 |
| [docs/bd-rate.md](<../docs/bd-rate.md>) | 文档 | BD-rate 方法、曲线/质量域、参考点测量、插值、容差及结果解释。 |
| [docs/bitrate-curve.md](<../docs/bitrate-curve.md>) | 文档 | 逐包 PTS 窗口码率、精确字节/持续时间、缺失值与前端聚合的唯一方法说明。 |
| [docs/chart-controls.md](<../docs/chart-controls.md>) | 文档 | 横纵轴范围、手动锁定、切换曲线、缩放/裁剪与数据保留规则。 |
| [docs/contributing.md](<../docs/contributing.md>) | 文档 | 开发、提交、审阅、风险分类、分支/主线交付规则；用户本轮明确分支授权优先。 |
| [docs/data-and-archives.md](<../docs/data-and-archives.md>) | 文档 | 用户/本机/临时数据、正式证据和平台档案的路径、保护、来源、恢复、保留及对外边界。 |
| [docs/json-format.md](<../docs/json-format.md>) | 文档 | 可移植报告/计划结构、历史读取兼容、无损明细编码、repeat/扩展证据和文件命名协议。 |
| [docs/releasing.md](<../docs/releasing.md>) | 文档 | 版本、确切提交/附件、部署/联网/人工验收与对外发布流程；不将单次通用全绿视为发布完成。 |
| [docs/repeat-analysis.md](<../docs/repeat-analysis.md>) | 文档 | 原生整数重复、分量/块差异、时间/样本不变/低变化及资格清单和不能推断的来源边界。 |
| [docs/siti-p910-2023.md](<../docs/siti-p910-2023.md>) | 文档 | SI/TI 计算口径、上游兼容与配置、输入解释、HDR/场景、CPU/GPU及数值验收边界。 |
| [docs/testing.md](<../docs/testing.md>) | 文档 | 本测试体系唯一完整正文：规则、选择方式、软件要求、每个代码文件/数据的角色、判据和实际验证状态。 |
| [docs/video-basic-properties.md](<../docs/video-basic-properties.md>) | 文档 | 媒体基础属性的原始读取、报告字段解释及推导边界，供属性实现和测试核对。 |
| [docs/vmaf.md](<../docs/vmaf.md>) | 文档 | VMAF 模型、原始输入与汇总、显示/主观解释边界及实际调用验证说明。 |
| [engine.mjs](<../engine.mjs>) | 运行源码/配置 / media-info, frames, quality | 媒体后端：定位 FFmpeg/FFprobe、运行/取消子进程、解析 probe/帧/包、片段/对齐/色度与位深校验、质量指标及参考缓存。输入实际媒体和上下文，输出原始证据、指标及命令记录。 |
| [evidence-archive/tools/import-local-test-evidence.ps1](<../evidence-archive/tools/import-local-test-evidence.ps1>) | 配置/资料 | 协作者本机正式记录的预览、验证、导入、去重和冲突保护 |
| [gpu/SitiOpenCl.cs](<../gpu/SitiOpenCl.cs>) | 运行源码/配置 / siti | 生产 GPU SI/TI 的 C# 控制台/OpenCL 桥接：设备能力、缓冲区、内核与结果通信；由 siti 后端调用。研究工具的内核不能替代本文件的验证。 |
| [gpu/siti-opencl.ps1](<../gpu/siti-opencl.ps1>) | 运行源码/配置 / siti | 用系统 C# 编译器编译 SitiOpenCl.cs 到显式 OutputPath，输出实际错误/退出码；不直接计算独立参考答案。 |
| [licenses/Node-LICENSE.txt](<../licenses/Node-LICENSE.txt>) | 授权资料 | 随组件来源保留的 Node 许可与第三方声明原文；不是测试素材或当前执行二进制身份。 |
| [licenses/RUNTIME-SOURCES.md](<../licenses/RUNTIME-SOURCES.md>) | 授权资料 | Node/FFmpeg 等运行时来源、构建/版本和许可分发说明；与 runtime-lock 和实际包校验配合。 |
| [licenses/VQEG-siti-tools.txt](<../licenses/VQEG-siti-tools.txt>) | 授权资料 | 所依据/使用的 VQEG siti-tools 实现许可与归属原文；视频的独立许可仍看固定输入中的 LICENSES。 |
| [local-data-policy.json](<../local-data-policy.json>) | 配置/资料 | 本机路径分类、受保护资料、清理边界和已审核历史命名例外基线；清理/本机资料检查读取，不能因位于 .build 或被 Git 忽略就绕过。 |
| [package-lock.json](<../package-lock.json>) | 配置/资料 | 锁定 npm 开发依赖的精确版本、下载来源与完整性；npm ci 据此安装浏览器驱动代码，非视频素材。 |
| [package.json](<../package.json>) | 运行源码/配置 / desktop | 项目名称/版本/Node 要求、npm 启动/测试/维护命令与 Playwright 开发依赖入口；不存素材或测量答案。 |
| [public/analysis-limits.js](<../public/analysis-limits.js>) | 运行源码/配置 / siti, repeat | 产品资源限制常量与 SI/TI 尺寸合法性校验；描述支持边界，不把最大规模转成正式测试必跑负载。 |
| [public/analysis-notes.js](<../public/analysis-notes.js>) | 运行源码/配置 / ui | 从实际报告收集分析说明、未知/变化字段、资源限制和未确认场景提示并分组；只解释证据，不修改输入数值。 |
| [public/app.js](<../public/app.js>) | 运行源码/配置 / ui, jobs | 浏览器主控制器：表单、任务/队列、探测与分析目标、设备/参数、导入导出、本机数据、图表交互和原生选择 API；调用各模型与视图模块。 |
| [public/basic-info.js](<../public/basic-info.js>) | 运行源码/配置 / media-info | 把 FFprobe 原始轨道、容器、章节/标签及像素描述显示为完整基础信息面板，处理轨道切换和展开；与 properties 的单字段解释配合。 |
| [public/bd-rate.js](<../public/bd-rate.js>) | 运行源码/配置 / trials | 固定方法的 BD-rate 数学实现：校验并整理 RD 曲线、PCHIP 插值、重叠积分和结果状态；输入曲线、输出差异和方法依据。 |
| [public/bd-reference.js](<../public/bd-reference.js>) | 运行源码/配置 / trials | BD 测量协议：固定像素/码率/质量口径、输入与测量字段校验、容差及结果等价；被实际点测量、报告和 BD 计算使用。 |
| [public/bd-trial.js](<../public/bd-trial.js>) | 运行源码/配置 / trials | 从试编码报告提取统一 BD 测量点、验证同源/同质量域/范围并调用 bdRate；拒绝不兼容或不足的曲线。 |
| [public/bitrate-model.js](<../public/bitrate-model.js>) | 运行源码/配置 / bitrate | 按绝对 PTS 窗口累计精确包字节/持续时间，构成码率曲线、聚合视图并校验；不把包分布当成网络吞吐量。 |
| [public/charts.js](<../public/charts.js>) | 运行源码/配置 / ui | Canvas 曲线/GOP 绘制、范围/刻度/有限段、可见点/区间筛选和交互基础；视图裁剪不改变报告原始数据。 |
| [public/distribution-model.js](<../public/distribution-model.js>) | 运行源码/配置 / bitrate | 帧时间点和各音轨逐包大小分布模型、整数时间基换算与报告校验；保留缺失字段/超限状态，不回退 DTS 冒充 PTS。 |
| [public/index.html](<../public/index.html>) | 运行源码/配置 / ui | 实际页面结构、表单、任务/报告区和控件 ID；server 注入会话 token、版本、主题及导入限制，再加载 app.js。 |
| [public/metric-summary.js](<../public/metric-summary.js>) | 运行源码/配置 / quality | 严格解析 FFmpeg PSNR/SSIM 原始汇总文本和各分量值；采用官方汇总而非对已舍入逐帧值直接平均，坏输出明确失败。 |
| [public/portable.js](<../public/portable.js>) | 运行源码/配置 / reports | 可移植文件封装、格式/字节限制、命名、导入/导出和 report 转换；校验成功后才交给产品使用，支持声明的历史格式。 |
| [public/properties.js](<../public/properties.js>) | 运行源码/配置 / media-info | 单项视频属性的取值/格式/来源解释、像素格式描述和旧抽样字段摘要；不把推测或标签改写为原始测量。 |
| [public/repeat-csv.js](<../public/repeat-csv.js>) | 运行源码/配置 / repeat, reports | 将重复帧、连续段、样本不变区间、时间间隔和低变化事件生成完整 CSV 记录，逐步计算字节数；全部成功后才允许发布导出。 |
| [public/repeat-difference.js](<../public/repeat-difference.js>) | 运行源码/配置 / repeat | 差异证据字段、分类带、分量/块配置、汇总、逐帧校验和显示值；固定来源分类边界，避免仅凭细微差异推断编码前来源。 |
| [public/repeat-fingerprint.js](<../public/repeat-fingerprint.js>) | 运行源码/配置 / repeat | 保存的通用帧摘要描述与 hex/base64 表示校验；检查算法名/位数/参数和长度，不负责证明任意算法实现正确。 |
| [public/repeat-model.js](<../public/repeat-model.js>) | 运行源码/配置 / repeat | 重复分析协议、原生格式描述、整数时间证据、精确重复/样本不变/时间网格/低变化区间聚合与报告校验；供后端与 UI 共用。 |
| [public/repeat-view.js](<../public/repeat-view.js>) | 运行源码/配置 / repeat, ui | 重复分析页面：摘要、分布、帧/区间定位、按需预览、差异和 CSV 交互；从已校验报告读取，不生成独立测试真值。 |
| [public/report-codec.js](<../public/report-codec.js>) | 运行源码/配置 / reports | 报告明细无损表格编码/解码：列式数据、常量、稀疏字段及对象还原；不计算指标或丢弃测量字段。 |
| [public/report-extensions.js](<../public/report-extensions.js>) | 运行源码/配置 / reports | 报告可选元数据和能力要求协议：限制 JSON 结构预算、拒绝保留键/访问器/循环和不支持要求；元数据不作为可执行方法运行。 |
| [public/report.js](<../public/report.js>) | 运行源码/配置 / reports | 分析/比较/试编码报告的主结构与数值/证据关联校验及解析；负责拒绝不一致结果，调用 SI/TI、repeat、BD 等专用校验。 |
| [public/siti.js](<../public/siti.js>) | 运行源码/配置 / siti | CPU/前后端共享 SI/TI 数学与协议：配置/传递函数、整数布局读取、预处理、逐帧 SI/TI、场景/时间/尝试记录校验；还生成生产 GPU 参数。 |
| [public/style.css](<../public/style.css>) | 运行源码/配置 / ui | 页面主题、布局、表单/侧栏/报告/图表响应式样式；被 index.html 加载，浏览器测试只证明所测布局/交互范围。 |
| [public/timing.js](<../public/timing.js>) | 运行源码/配置 / reports, quality | 实际记录时长、命令/任务计时汇总与显示；不以存在耗时字段推断跨硬件速度或独立阶段耗时。 |
| [public/trial-model.js](<../public/trial-model.js>) | 运行源码/配置 / trials | 试编码行标识/排序、CRF 解析、指标名称/取值、BD 汇总和图表数据；保留逐帧时间及组别元数据。 |
| [public/units.js](<../public/units.js>) | 运行源码/配置 / reports | 精确字节依据、十进制容量/码率数量级、数值格式、图表缩放和限制文案；区分原始值与显示单位。 |
| [public/vmaf.js](<../public/vmaf.js>) | 运行源码/配置 / quality | VMAF 可选模型、输入/配置说明、原始日志逐帧/池化解析及校验；保存模型/库版本与解释边界，不把分数当任意显示条件的主观保证。 |
| [repeat-samples.mjs](<../repeat-samples.mjs>) | 运行源码/配置 / repeat | 原生整数样本比较：分块接收字节，按布局解读分量，精确判等并累计分量/局部块差异、变化数与最大码值差；被 repeat 调用。 |
| [repeat.mjs](<../repeat.mjs>) | 运行源码/配置 / repeat | 实际重复分析流水线：文件身份、原生解码/完整帧摘要、直接相邻比较、时间区间/静止/低变化候选和按需预览；保留原始时间与证据，不从摘要相等单独推断来源。 |
| [runtime-lock.json](<../runtime-lock.json>) | 运行源码/配置 / desktop | 推荐 Node/FFmpeg/FFprobe 发行环境的版本、下载身份和能力要求；部署工具读取，正式记录另保存实际二进制摘要。 |
| [scripts/archive-test-generated.ps1](<../scripts/archive-test-generated.ps1>) | 开发/运维工具 | 旧 test-work 生成物的显式历史归档工具：只识别白名单目录/文件，核对摘要并保存历史来源；不是当前 scripts/test.mjs 的单次测量采集入口，不自动吸纳未知旧资料。 |
| [scripts/benchmark-bitrate-window.mjs](<../scripts/benchmark-bitrate-window.mjs>) | 开发/运维工具 | 旧基准入口，委托同一开发者扩展 |
| [scripts/build-launcher.ps1](<../scripts/build-launcher.ps1>) | 构建工具 / desktop | 构建产品 Windows 启动器并记录构建身份 |
| [scripts/check-commits.mjs](<../scripts/check-commits.mjs>) | 开发/运维工具 | 提交/PR 标题检查，不检查产品功能 |
| [scripts/check-environment.mjs](<../scripts/check-environment.mjs>) | 运行源码/配置 / desktop | Node/FFmpeg/FFprobe 与功能能力检查 |
| [scripts/check-release-notes.mjs](<../scripts/check-release-notes.mjs>) | 开发/运维工具 | 发布正文与所给实际 ZIP 摘要检查，不检查产品运行 |
| [scripts/ci-scope.mjs](<../scripts/ci-scope.mjs>) | 开发/运维工具 | 根据确切提交、Git 文件角色和已有合格检查选择完整回归或纯说明文档检查，保存对应的结构化范围回执。 |
| [scripts/cleanup.ps1](<../scripts/cleanup.ps1>) | 开发/运维工具 | 按保护策略预览/清理可重建数据 |
| [scripts/deployment.ps1](<../scripts/deployment.ps1>) | 运行源码/配置 / desktop | 产品组件安装、下载/验证、配置写入与环境复用 |
| [scripts/desktop.mjs](<../scripts/desktop.mjs>) | 运行源码/配置 / desktop | 产品桌面浏览器和生命周期 |
| [scripts/evidence-lib.ps1](<../scripts/evidence-lib.ps1>) | 开发/运维工具 | 共享证据格式、摘要、验证和原子存储基础 |
| [scripts/export-github-test-evidence.ps1](<../scripts/export-github-test-evidence.ps1>) | 开发/运维工具 | 导出 Actions 记录供上传/转移 |
| [scripts/fast-bootstrap.mjs](<../scripts/fast-bootstrap.mjs>) | 运行源码/配置 / desktop | 快速启动引导 |
| [scripts/fast-launch.ps1](<../scripts/fast-launch.ps1>) | 运行源码/配置 / desktop | 产品快速启动、组件/配置校验与缓存 |
| [scripts/github-archive-api.mjs](<../scripts/github-archive-api.mjs>) | 开发/运维工具 | 平台 HTTP/REST 调用层 |
| [scripts/github-archive-capacity.mjs](<../scripts/github-archive-capacity.mjs>) | 开发/运维工具 | 平台档案容量与保存边界 |
| [scripts/github-archive-collect.mjs](<../scripts/github-archive-collect.mjs>) | 开发/运维工具 | 采集平台记录/元数据与附件 |
| [scripts/github-archive-evidence-names.mjs](<../scripts/github-archive-evidence-names.mjs>) | 开发/运维工具 | 平台档案中的正式记录身份/命名关联 |
| [scripts/github-archive-evidence.ps1](<../scripts/github-archive-evidence.ps1>) | 开发/运维工具 | 平台档案与正式证据的 PowerShell 适配 |
| [scripts/github-archive-graphql.mjs](<../scripts/github-archive-graphql.mjs>) | 开发/运维工具 | 平台 GraphQL 查询层 |
| [scripts/github-archive-inventory.mjs](<../scripts/github-archive-inventory.mjs>) | 开发/运维工具 | 平台档案盘点/状态 |
| [scripts/github-archive-migration.mjs](<../scripts/github-archive-migration.mjs>) | 开发/运维工具 | 平台档案迁移 |
| [scripts/github-archive-prune.mjs](<../scripts/github-archive-prune.mjs>) | 开发/运维工具 | 平台档案显式清理规划/执行 |
| [scripts/github-archive-store.mjs](<../scripts/github-archive-store.mjs>) | 开发/运维工具 | 平台档案存储、索引、完整性及原子写入 |
| [scripts/github-archive.mjs](<../scripts/github-archive.mjs>) | 开发/运维工具 | 平台档案命令分派入口，不是另一套产品算法测试 |
| [scripts/github-evidence-lib.ps1](<../scripts/github-evidence-lib.ps1>) | 开发/运维工具 | 云端证据交换的共享格式/校验 |
| [scripts/import-github-test-evidence.ps1](<../scripts/import-github-test-evidence.ps1>) | 开发/运维工具 | 导入并验证 Actions 正式记录 |
| [scripts/install-location.ps1](<../scripts/install-location.ps1>) | 运行源码/配置 / desktop | 产品安装位置选择与解析 |
| [scripts/launcher/Launcher.cs](<../scripts/launcher/Launcher.cs>) | 编译源输入 / desktop | 产品原生启动器源代码 |
| [scripts/list-test-evidence.ps1](<../scripts/list-test-evidence.ps1>) | 开发/运维工具 | 列出正式记录和状态，不执行产品测试 |
| [scripts/local-data.ps1](<../scripts/local-data.ps1>) | 开发/运维工具 | 本机数据分类、盘点、验证与保护 |
| [scripts/local-notes.mjs](<../scripts/local-notes.mjs>) | 开发/运维工具 | 本机资料准入、索引、角色和冻结摘要检查 |
| [scripts/maintain-build.ps1](<../scripts/maintain-build.ps1>) | 开发/运维工具 | 构建目录维护包装 |
| [scripts/manage.ps1](<../scripts/manage.ps1>) | 运行源码/配置 / desktop | 产品组件管理/安装交互 |
| [scripts/migrate-test-evidence.ps1](<../scripts/migrate-test-evidence.ps1>) | 开发/运维工具 | 显式迁移旧证据，保留来源与映射 |
| [scripts/migrate-time-paths.mjs](<../scripts/migrate-time-paths.mjs>) | 开发/运维工具 | 显式日期时间路径迁移，不是测试调度 |
| [scripts/organize-test-evidence.ps1](<../scripts/organize-test-evidence.ps1>) | 开发/运维工具 | 显式整理历史证据布局：锁定档案、检查无活动运行、按原 kind/来源规划移动并保留事务与路径映射；未知历史集合拒绝处理。 |
| [scripts/package-prerelease.ps1](<../scripts/package-prerelease.ps1>) | 开发/运维工具 | 预发行打包包装 |
| [scripts/package.ps1](<../scripts/package.ps1>) | 构建工具 / desktop | 产品发行打包；不等于测试源码候选 ZIP |
| [scripts/prune-github-evidence.ps1](<../scripts/prune-github-evidence.ps1>) | 开发/运维工具 | 云端证据保存/清理包装 |
| [scripts/record-test.ps1](<../scripts/record-test.ps1>) | 开发/运维工具 | App / Package / OnlineDeployment 等不同正式记录阶段的入口 |
| [scripts/recover-interrupted-data.mjs](<../scripts/recover-interrupted-data.mjs>) | 开发/运维工具 | 识别/恢复中断事务数据 |
| [scripts/recover-test-evidence.ps1](<../scripts/recover-test-evidence.ps1>) | 开发/运维工具 | 恢复中断的正式记录 |
| [scripts/rename-evidence-records.ps1](<../scripts/rename-evidence-records.ps1>) | 开发/运维工具 | 显式规范化记录名并维护映射/别名 |
| [scripts/replay-bitrate-evidence.mjs](<../scripts/replay-bitrate-evidence.mjs>) | 开发/运维工具 | 重放已有逐包/窗口证据，核对数值而非重新声称媒体测量 |
| [scripts/run-ci-tests.ps1](<../scripts/run-ci-tests.ps1>) | 开发/运维工具 | 旧 Actions 全量入口及结构化状态 |
| [scripts/split-tests.mjs](<../scripts/split-tests.mjs>) | 开发/运维工具 | 分工计划、本地执行、云端预检、合并核验与发布复核入口 |
| [scripts/split-test-cloud-cases.json](<../scripts/split-test-cloud-cases.json>) | 测试基础设施 | 按测试文件和稳定用例 ID 登记可由 Actions 执行的通用用例。 |
| [scripts/split-test-plan.mjs](<../scripts/split-test-plan.mjs>) | 测试基础设施 | 由确切比较基线和登记用例计算本地、云端及提交自测的无重叠清单 |
| [scripts/split-test-receipts.mjs](<../scripts/split-test-receipts.mjs>) | 测试基础设施 | 复核实际执行证据及同源部署包 |
| [scripts/split-test-github.mjs](<../scripts/split-test-github.mjs>) | 测试基础设施 | 核验 GitHub 工作流、尝试、作业、产物摘要与同 SHA 复用 |
| [scripts/run-project.mjs](<../scripts/run-project.mjs>) | 开发/运维工具 | npm 统一入口，选择运行时后分派启动/测试 |
| [scripts/runtime-data.mjs](<../scripts/runtime-data.mjs>) | 运行源码/配置 / jobs | 产品报告/设置/本机运行数据保存和清理 |
| [scripts/start-source.ps1](<../scripts/start-source.ps1>) | 开发/运维工具 | 源码启动入口 |
| [scripts/sync-github-test-evidence.mjs](<../scripts/sync-github-test-evidence.mjs>) | 开发/运维工具 | 显式同步云端证据 |
| [scripts/test-complete.mjs](<../scripts/test-complete.mjs>) | 开发/运维工具 | 软件完整验证调度及五阶段判定：冻结运行代码/测试工具/规则身份，实跑通用、GPU、原生交互、同源构建及离线/首次联网部署；缺阶段、跳过或身份不符时不通过。 |
| [scripts/test-deployment.ps1](<../scripts/test-deployment.ps1>) | 开发/运维工具 | 实际包部署场景断言；离线与真实联网阶段分开 |
| [scripts/preview-measurement-compaction.mjs](<../scripts/preview-measurement-compaction.mjs>) | 开发/运维工具 | 只读试算符合条件的历史 App 测量附件的无损去重收益，可输出待验证附件。 |
| [scripts/read-measurements.mjs](<../scripts/read-measurements.mjs>) | 测试基础设施 | 读取或检查测量附件，兼容测量 schema 1、2、3。 |
| [scripts/stage-measurement-compaction.ps1](<../scripts/stage-measurement-compaction.ps1>) | 开发/运维工具 | 在 .build 内准备并核验无损去重副本，输出前后摘要。 |
| [scripts/test-evidence.mjs](<../scripts/test-evidence.mjs>) | 开发/运维工具 | 正式运行委托声明/真实观察收集器并压缩结构化结果；旧测量规则仅供旧记录/协议自测兼容，不作为新运行的任意JSON收集入口。 |
| [scripts/test-launch.mjs](<../scripts/test-launch.mjs>) | 开发/运维工具 | 隔离测试启动、标准输出与退出/信号传递 |
| [scripts/test-storage.ps1](<../scripts/test-storage.ps1>) | 开发/运维工具 | 正式证据存储动作：Validate/Lock/Allocate/Zip/Commit/Clean；限制路径留在项目内并拒绝链接，协调运行编号、锁、提交和打包。 |
| [scripts/test.mjs](<../scripts/test.mjs>) | 开发/运维工具 | 统一测试入口：业务模块/用例/阶段/变更影响选择、隔离快照、前置检查、有限并行、真实结果/断言/输入/执行计数收集及封存；显式分派拓展和参考维护。 |
| [scripts/time.mjs](<../scripts/time.mjs>) | 运行源码/配置 / reports | 共享 UTC 命名/时间协议 |
| [scripts/uninstall.ps1](<../scripts/uninstall.ps1>) | 运行源码/配置 / desktop | 产品卸载与用户数据保留 |
| [scripts/validate-launch.ps1](<../scripts/validate-launch.ps1>) | 运行源码/配置 / desktop | 对实际运行环境/应用启动执行验证 |
| [scripts/verify-bitrate-equivalence.mjs](<../scripts/verify-bitrate-equivalence.mjs>) | 开发/运维工具 | 码率等价诊断实现；由扩展显式调用 |
| [scripts/verify-github-archive-standalone.ps1](<../scripts/verify-github-archive-standalone.ps1>) | 开发/运维工具 | 档案独立副本的完整性核验 |
| [scripts/verify-maintenance-copy.mjs](<../scripts/verify-maintenance-copy.mjs>) | 开发/运维工具 | 平台档案永久副本的校验入口：从给定文件路径定位 revisions/<编号>，调用 verifySnapshot 核查整份平台快照；不运行 SI/TI 参考生成，也不核对临时测试源码副本。 |
| [scripts/verify-release.ps1](<../scripts/verify-release.ps1>) | 开发/运维工具 | ZIP 清单、文件边界、启动器和摘要/发行结构检查 |
| [scripts/verify-source-tests.mjs](<../scripts/verify-source-tests.mjs>) | 开发/运维工具 | 确切提交的通用 + GPU 记录关联与发布源码验收 |
| [scripts/verify-test-evidence.ps1](<../scripts/verify-test-evidence.ps1>) | 开发/运维工具 | 逐记录结果、必需文件及摘要完整性验证 |
| [server.mjs](<../server.mjs>) | 运行源码/配置 / jobs, reports, desktop | 本地 HTTP/API 服务与任务队列：鉴权、探测、创建/暂停/取消/重试任务、计划/报告、本机数据、原生文件/目录选择、GPU能力和桌面退出；提供 public 静态资源。 |
| [siti-preflight.mjs](<../siti-preflight.mjs>) | 运行源码/配置 / siti | 检查所选轨道的亮度码值并绑定文件状态，供正常 SI/TI 任务入队前使用。 |
| [siti.mjs](<../siti.mjs>) | 运行源码/配置 / siti | SI/TI 测量后端：实际解码、CPU 工作线程与生产 OpenCL 进程通信、GPU资格、自检、输入/场景校验、取消/故障回退与恢复；返回逐帧及执行依据。 |
| [start.cmd](<../start.cmd>) | 运行源码/配置 / desktop | 用户双击入口；启动原生启动器/快速引导流程，进入已选环境、组件准备和本地应用启动。 |
| [testing-tools/README.md](<../testing-tools/README.md>) | 测试基础设施 | 维护者入口、目录边界与分块/扩展/参考维护说明 |
| [testing-tools/coverage.json](<../testing-tools/coverage.json>) | 测试基础设施 | 指向正式用例目录的兼容元数据；不是实测代码覆盖率 |
| [testing-tools/data/controlled-siti.json](<../testing-tools/data/controlled-siti.json>) | 正式固定数据 | 自制SDR/PQ二维整数图案、原始帧摘要及独立Python逐帧SI/TI答案。 |
| [testing-tools/data/layout-reference.json](<../testing-tools/data/layout-reference.json>) | 正式固定数据 | 新生成的150格式/900组已知整数布局：原始字节、逐样本归一化值、2700帧独立SI/TI答案及完整重建来源。 |
| [testing-tools/data/siti-corpus.json](<../testing-tools/data/siti-corpus.json>) | 正式固定数据 | 三段明确授权上游HLG视频及其答案的身份/来源对应；仅为来源清单，不是数值答案。 |
| [testing-tools/extensions/benchmark.mjs](<../testing-tools/extensions/benchmark.mjs>) | 显式拓展 | 同一调用者文件的探测/码率耗时与采样内存观察；显式重复次数 |
| [testing-tools/extensions/bitrate.mjs](<../testing-tools/extensions/bitrate.mjs>) | 显式拓展 | 调用者真实文件的窗口与直接计算诊断 |
| [testing-tools/extensions/export.mjs](<../testing-tools/extensions/export.mjs>) | 显式拓展 | 指定 CSV 字节数的序列化接受/拒绝边界 |
| [testing-tools/extensions/index.mjs](<../testing-tools/extensions/index.mjs>) | 显式拓展 | 显式拓展目录/参数/配置验证及执行记录；没有暗中启动的大规模默认负载，不参与正式全量选择。 |
| [testing-tools/extensions/repeat.mjs](<../testing-tools/extensions/repeat.mjs>) | 显式拓展 | 开发者指定帧数/原生尺寸/时长和取消阶段的重复分析观察 |
| [testing-tools/extensions/repeat/cooperative-gpu-audit.md](<../testing-tools/extensions/repeat/cooperative-gpu-audit.md>) | 显式拓展 | CPU/GPU 协作研究的边界、使用与结果解释 |
| [testing-tools/extensions/repeat/cooperative-gpu-audit.mjs](<../testing-tools/extensions/repeat/cooperative-gpu-audit.mjs>) | 显式拓展 | 协作研究阶段控制、资格矩阵和报告 |
| [testing-tools/extensions/repeat/cooperative-gpu-source.mjs](<../testing-tools/extensions/repeat/cooperative-gpu-source.mjs>) | 显式拓展 | 协作研究专用 CPU/GPU 实现源码模板 |
| [testing-tools/extensions/repeat/hash-audit-media.mjs](<../testing-tools/extensions/repeat/hash-audit-media.mjs>) | 显式拓展 | 研究所需受控媒体/解码输入准备 |
| [testing-tools/extensions/repeat/hash-audit-worker.mjs](<../testing-tools/extensions/repeat/hash-audit-worker.mjs>) | 显式拓展 | 研究专用并行 CPU 工作进程 |
| [testing-tools/extensions/repeat/hash-audit.md](<../testing-tools/extensions/repeat/hash-audit.md>) | 显式拓展 | 哈希/并行研究工具的用途与操作说明 |
| [testing-tools/extensions/repeat/hash-audit.mjs](<../testing-tools/extensions/repeat/hash-audit.mjs>) | 显式拓展 | 哈希官方向量、CPU/GPU/媒体阶段和研究报告 |
| [testing-tools/extensions/repeat/hash-opencl-source.mjs](<../testing-tools/extensions/repeat/hash-opencl-source.mjs>) | 显式拓展 | 研究专用 OpenCL 实现模板；不是产品 GPU 实现 |
| [testing-tools/extensions/repeat/tools/repeat-resource-run.mjs](<../testing-tools/extensions/repeat/tools/repeat-resource-run.mjs>) | 显式拓展 | 拓展重复分析的独立父进程观察器：实际子进程、外部内存采样、心跳及取消时钟；不作为普通正式输入生成器。 |
| [testing-tools/extensions/repeat/tools/repeat-resource-worker.mjs](<../testing-tools/extensions/repeat/tools/repeat-resource-worker.mjs>) | 显式拓展 | 拓展的真实分析工作进程：调用产品重复分析，对静止、已知末样本差异或独立变化斜坡逐帧核验，返回真实时间/摘要/取消结果。 |
| [testing-tools/extensions/repeat/whole-file-gpu-audit.md](<../testing-tools/extensions/repeat/whole-file-gpu-audit.md>) | 显式拓展 | 完整文件 GPU 后端实验的边界与操作说明 |
| [testing-tools/extensions/repeat/whole-file-gpu-audit.mjs](<../testing-tools/extensions/repeat/whole-file-gpu-audit.mjs>) | 显式拓展 | 完整文件 GPU 实验阶段控制与结果汇总 |
| [testing-tools/extensions/repeat/whole-file-gpu-qualification.mjs](<../testing-tools/extensions/repeat/whole-file-gpu-qualification.mjs>) | 显式拓展 | 实验后端的解码字节、整数阈值和官方向量资格核验 |
| [testing-tools/extensions/repeat/whole-file-gpu-source.mjs](<../testing-tools/extensions/repeat/whole-file-gpu-source.mjs>) | 显式拓展 | 实验后端源码模板；不能替代生产路径验收 |
| [testing-tools/extensions/research.mjs](<../testing-tools/extensions/research.mjs>) | 显式拓展 | 显式适配研究阶段；独立输出，不作为生产 GPU 正式验证 |
| [testing-tools/extensions/siti.mjs](<../testing-tools/extensions/siti.mjs>) | 显式拓展 | 开发者指定尺寸或帧数的解析输入、实际 CPU/GPU 结果检查 |
| [testing-tools/fixtures.lock.json](<../testing-tools/fixtures.lock.json>) | 测试基础设施 | 正式19项固定输入的唯一身份与用途清单：字节、摘要、来源/本地原件、角色、授权附件；不混入维护或压力输入。 |
| [testing-tools/helpers/assert.mjs](<../testing-tools/helpers/assert.mjs>) | 测试基础设施 | 转发真实严格断言，计数每例实际执行的断言和方法；不改变预期值或容差。 |
| [testing-tools/helpers/browser-harness.mjs](<../testing-tools/helpers/browser-harness.mjs>) | 测试基础设施 | 浏览器用例统一执行器：真实服务/Edge、独立上下文、实际请求与输入摘要、DOM/控件事件、V8范围、错误及失败现场；跨界面测试共用同一收集规则。 |
| [testing-tools/helpers/case-catalog.mjs](<../testing-tools/helpers/case-catalog.mjs>) | 测试基础设施 | 校验唯一主责/目录/ID/工作区，选择业务关联层，判定实际用例身份和状态，强制固定输入及附件先声明后读。 |
| [testing-tools/helpers/case-test.mjs](<../testing-tools/helpers/case-test.mjs>) | 测试基础设施 | 稳定用例注册与精确选择、独立上下文、实际断言回执；未选用例不注册为skip，占位或零断言不能冒充通过。 |
| [testing-tools/helpers/encoded-controls.mjs](<../testing-tools/helpers/encoded-controls.mjs>) | 测试基础设施 | 按需生成普通规模多轨H.264、HDR HEVC及AV1控制媒体；每用例自行取得依赖，不依赖前一用例遗留文件。 |
| [testing-tools/helpers/execution-coverage.mjs](<../testing-tools/helpers/execution-coverage.mjs>) | 测试基础设施 | 保存Node及浏览器V8函数/范围的实际执行计数；相同源码副本须校验字节，修改过的夹具不计入；不是100%分支或原生代码证明。 |
| [testing-tools/helpers/feature-policy.mjs](<../testing-tools/helpers/feature-policy.mjs>) | 测试基础设施 | 当前功能缺失失败、历史比较显式不适用；还混有 UI 主题模式常量 |
| [testing-tools/helpers/fixtures.mjs](<../testing-tools/helpers/fixtures.mjs>) | 测试基础设施 | 从正式或维护的独立锁定清单准备、复核固定输入；支持获审本地原件和HTTPS，逐次检查字节/摘要/附件/链接；缓存损坏不能被刷新摘要掩盖。 |
| [testing-tools/helpers/measurement-codec.mjs](<../testing-tools/helpers/measurement-codec.mjs>) | 测试基础设施 | 对重复测量值做可还原去重，并读取新旧测量附件。 |
| [testing-tools/helpers/measurement-store.mjs](<../testing-tools/helpers/measurement-store.mjs>) | 测试基础设施 | 仅收集所选用例的真实观察及显式声明的测量；检查断言回执，不把任意JSON夹具扫成产品测量。 |
| [testing-tools/helpers/native-dialog.ps1](<../testing-tools/helpers/native-dialog.ps1>) | 测试基础设施 | 只定位本测试拥有的Windows对话框，进行实际文件/目录/确认/取消操作；拒绝窗口归属不明和缺失控件，并保留真实操作回执。 |
| [testing-tools/helpers/observations.mjs](<../testing-tools/helpers/observations.mjs>) | 测试基础设施 | 采集实际被测函数返回/拒绝、输入字节摘要、参数、耗时和断言回执；以gzip保存，不生成测试答案。 |
| [testing-tools/helpers/probe-memory.ps1](<../testing-tools/helpers/probe-memory.ps1>) | 测试基础设施 | 外部Windows进程内存取样；标明采样峰值为观察下界，不作普遍吞吐/内存承诺。 |
| [testing-tools/helpers/product-contract.mjs](<../testing-tools/helpers/product-contract.mjs>) | 测试基础设施 | 核对软件清单/接口/控件/API与要求绑定；区分未选、部分、失败和通过，提供保守变更影响选择及运行代码身份。 |
| [testing-tools/helpers/real-media.mjs](<../testing-tools/helpers/real-media.mjs>) | 测试基础设施 | 创建真实多音轨参考、失真候选、无损 SDR 媒体及命令/探测配方 |
| [testing-tools/helpers/reporter.mjs](<../testing-tools/helpers/reporter.mjs>) | 测试基础设施 | 实际 node:test 事件转为带用例身份的结构化结果 |
| [testing-tools/helpers/server.mjs](<../testing-tools/helpers/server.mjs>) | 测试基础设施 | 在文件专属目录启动真实随机端口服务并管理其会话/关闭；转发真实HTTP，记录实际返回和输入身份，仅对确认的Fetch禁用端口做启动前置重选。 |
| [testing-tools/helpers/source-layout.mjs](<../testing-tools/helpers/source-layout.mjs>) | 测试基础设施 | 验证测试树的目录主责、维护代码类型和获准JSON；本地固定原件须在锁定清单中，生成媒体、依赖、链接和未知数据不能混进源码树。 |
| [testing-tools/helpers/subject.mjs](<../testing-tools/helpers/subject.mjs>) | 测试基础设施 | 真实生产函数的观察适配层，完整转发调用并保留结果；同步函数直接导出，不替代算法或进程。 |
| [testing-tools/helpers/test-results.mjs](<../testing-tools/helpers/test-results.mjs>) | 测试基础设施 | 部分/完整/历史/GPU 与确切源码验收结果判定 |
| [testing-tools/helpers/workspace.mjs](<../testing-tools/helpers/workspace.mjs>) | 测试基础设施 | 每测试文件独立且碰撞受检的短路径工作区；所有临时数据留在项目.build中。 |
| [testing-tools/helpers/zip.mjs](<../testing-tools/helpers/zip.mjs>) | 测试基础设施 | 通用ZIP成员读取，供不同领域参考数据解析共用；不再挂在BD业务目录下。 |
| [testing-tools/maintenance/environment.lock.json](<../testing-tools/maintenance/environment.lock.json>) | 参考维护 | 参考生成环境的Python、NumPy、SciPy及PyAV wheel/DLL版本和摘要；与正式运行环境分离。 |
| [testing-tools/maintenance/extract-descriptor.py](<../testing-tools/maintenance/extract-descriptor.py>) | 参考维护 | 先验证PyAV wheel及目标DLL摘要，再仅提取获准上游DLL到新建.build目录；不安装进软件发行包。 |
| [testing-tools/maintenance/generate-controlled-siti.py](<../testing-tools/maintenance/generate-controlled-siti.py>) | 参考维护 | 以自制整数二维图案和锁定未修改VQEG Python函数独立生成SDR/PQ逐帧答案；不导入生产JS/C#。 |
| [testing-tools/maintenance/generate-layout-reference.py](<../testing-tools/maintenance/generate-layout-reference.py>) | 参考维护 | 全新原生整数控制输入：上游描述符打包和逐样本反读，MSB同位深官方往返；预期SI/TI来自自制码值与独立标量Sobel/总体标准差。 |
| [testing-tools/maintenance/generate-siti-reference.py](<../testing-tools/maintenance/generate-siti-reference.py>) | 参考维护 | 使用锁定Python环境和未修改上游VQEG函数重建兼容向量候选；留存独立生成身份，不覆盖正式锁定数据。 |
| [testing-tools/maintenance/index.mjs](<../testing-tools/maintenance/index.mjs>) | 参考维护 | 独立参考维护入口：选择兼容向量、自制SDR/PQ、独立原生布局生成器；只生成待审候选，不自动替换正式答案。 |
| [testing-tools/maintenance/inputs.lock.json](<../testing-tools/maintenance/inputs.lock.json>) | 参考维护 | 维护专用3项锁定输入：Python源、维护向量和独立描述符wheel；不会作为正式媒体输入自动下载。 |
| [testing-tools/maintenance/layout-spec.json](<../testing-tools/maintenance/layout-spec.json>) | 参考维护 | 独立布局生成的格式/微型形状/范围规格；不含预期答案，也不含最大规模压力默认值。 |
| [testing-tools/modules/bitrate/bitrate-model.test.mjs](<../testing-tools/modules/bitrate/bitrate-model.test.mjs>) | 正式行为测试 / bitrate | 码率与包分布用例。 |
| [testing-tools/modules/bitrate/distribution-model.test.mjs](<../testing-tools/modules/bitrate/distribution-model.test.mjs>) | 正式行为测试 / bitrate | 码率与包分布用例。 |
| [testing-tools/modules/bitrate/packet-engine.test.mjs](<../testing-tools/modules/bitrate/packet-engine.test.mjs>) | 正式行为测试 / bitrate | 码率与包分布用例。 |
| [testing-tools/modules/bitrate/tools/bitrate-evidence.mjs](<../testing-tools/modules/bitrate/tools/bitrate-evidence.mjs>) | 测试基础设施 | 保存实际逐包/窗口核算、等价与守恒证据以及输入身份 |
| [testing-tools/modules/bitrate/tools/validation.mjs](<../testing-tools/modules/bitrate/tools/validation.mjs>) | 测试基础设施 | 构造真实短高帧率/VFR、故障输入并运行正式码率验证 |
| [testing-tools/modules/bitrate/validation.test.mjs](<../testing-tools/modules/bitrate/validation.test.mjs>) | 正式行为测试 / bitrate | 码率与包分布用例。 |
| [testing-tools/modules/catalog.json](<../testing-tools/modules/catalog.json>) | 测试基础设施 | 每个正式/工具自证用例的稳定ID、唯一主责、相关业务域、阶段、真实前置条件、允许固定输入和必须保留的测量。选择去重后执行一次。 |
| [testing-tools/modules/desktop/deployment-json.test.mjs](<../testing-tools/modules/desktop/deployment-json.test.mjs>) | 正式行为测试 / desktop | 安装、启动与环境用例。 |
| [testing-tools/modules/desktop/desktop-browser.test.mjs](<../testing-tools/modules/desktop/desktop-browser.test.mjs>) | 正式行为测试 / desktop | 安装、启动与环境用例。 |
| [testing-tools/modules/desktop/environment-selection.test.mjs](<../testing-tools/modules/desktop/environment-selection.test.mjs>) | 正式行为测试 / desktop | 安装、启动与环境用例。 |
| [testing-tools/modules/desktop/fast-launch.test.mjs](<../testing-tools/modules/desktop/fast-launch.test.mjs>) | 正式行为测试 / desktop | 安装、启动与环境用例。 |
| [testing-tools/modules/desktop/http-startup.test.mjs](<../testing-tools/modules/desktop/http-startup.test.mjs>) | 正式行为测试 / desktop | 安装、启动与环境用例。 |
| [testing-tools/modules/desktop/native-dialogs.test.mjs](<../testing-tools/modules/desktop/native-dialogs.test.mjs>) | 正式行为测试 / desktop | 安装、启动与环境用例。 |
| [testing-tools/modules/desktop/startup-desktop.test.mjs](<../testing-tools/modules/desktop/startup-desktop.test.mjs>) | 正式行为测试 / desktop | 安装、启动与环境用例。 |
| [testing-tools/modules/desktop/tools/deployment-json.ps1](<../testing-tools/modules/desktop/tools/deployment-json.ps1>) | 测试基础设施 | 调用实际部署 JSON 写入逻辑，测试锁定、原子替换及坏数据 |
| [testing-tools/modules/desktop/tools/environment-selection.ps1](<../testing-tools/modules/desktop/tools/environment-selection.ps1>) | 测试基础设施 | 只替换模态弹窗边界，执行实际路径解析、组件验证和对象释放 |
| [testing-tools/modules/desktop/tools/fast-launch-fixture.ps1](<../testing-tools/modules/desktop/tools/fast-launch-fixture.ps1>) | 测试基础设施 | 准备隔离源码/安装/组件副本并运行快速启动动作 |
| [testing-tools/modules/desktop/tools/launcher-console.ps1](<../testing-tools/modules/desktop/tools/launcher-console.ps1>) | 测试基础设施 | 实际拥有的控制台/控制信号、启动器退出与进程树边界 |
| [testing-tools/modules/desktop/tools/native-environment.ps1](<../testing-tools/modules/desktop/tools/native-environment.ps1>) | 测试基础设施 | 加载确切生产选择函数，实跑组件选择、Yes/No/Cancel及安装目录/确认弹窗；仅隔离已有用户安装发现，不替代模态界面或实施安装。 |
| [testing-tools/modules/desktop/tools/startup-cache.ps1](<../testing-tools/modules/desktop/tools/startup-cache.ps1>) | 测试基础设施 | 实际快速启动缓存，组件 EXE/DLL 变化后失效与重建 |
| [testing-tools/modules/frames/analysis-budget.test.mjs](<../testing-tools/modules/frames/analysis-budget.test.mjs>) | 正式行为测试 / frames | 帧结构、GOP与时基用例。 |
| [testing-tools/modules/frames/codec-structure.test.mjs](<../testing-tools/modules/frames/codec-structure.test.mjs>) | 正式行为测试 / frames | 帧结构、GOP与时基用例。 |
| [testing-tools/modules/frames/execution-equivalence.test.mjs](<../testing-tools/modules/frames/execution-equivalence.test.mjs>) | 正式行为测试 / frames | 帧结构、GOP与时基用例。 |
| [testing-tools/modules/jobs/admission.test.mjs](<../testing-tools/modules/jobs/admission.test.mjs>) | 正式行为测试 / jobs | API、队列与运行数据用例。 |
| [testing-tools/modules/jobs/runtime-data-browser.test.mjs](<../testing-tools/modules/jobs/runtime-data-browser.test.mjs>) | 正式行为测试 / jobs | API、队列与运行数据用例。 |
| [testing-tools/modules/jobs/runtime-data.test.mjs](<../testing-tools/modules/jobs/runtime-data.test.mjs>) | 正式行为测试 / jobs | API、队列与运行数据用例。 |
| [testing-tools/modules/jobs/server.test.mjs](<../testing-tools/modules/jobs/server.test.mjs>) | 正式行为测试 / jobs | API、队列与运行数据用例。 |
| [testing-tools/modules/media-info/basic-properties.test.mjs](<../testing-tools/modules/media-info/basic-properties.test.mjs>) | 正式行为测试 / media-info | 媒体信息与轨道用例。 |
| [testing-tools/modules/media-info/engine.test.mjs](<../testing-tools/modules/media-info/engine.test.mjs>) | 正式行为测试 / media-info | 媒体信息与轨道用例。 |
| [testing-tools/modules/media-info/tools/basic-properties.mjs](<../testing-tools/modules/media-info/tools/basic-properties.mjs>) | 测试基础设施 | 生成格式/元数据矩阵；legacyFrameSample 只用于旧报告兼容 |
| [testing-tools/modules/quality/bitdepth.test.mjs](<../testing-tools/modules/quality/bitdepth.test.mjs>) | 正式行为测试 / quality | 画质比较用例。 |
| [testing-tools/modules/quality/chroma-assumption.test.mjs](<../testing-tools/modules/quality/chroma-assumption.test.mjs>) | 正式行为测试 / quality | 画质比较用例。 |
| [testing-tools/modules/quality/comparison.test.mjs](<../testing-tools/modules/quality/comparison.test.mjs>) | 正式行为测试 / quality | 画质比较用例。 |
| [testing-tools/modules/quality/execution-equivalence.test.mjs](<../testing-tools/modules/quality/execution-equivalence.test.mjs>) | 正式行为测试 / quality | 画质比较用例。 |
| [testing-tools/modules/quality/vmaf.test.mjs](<../testing-tools/modules/quality/vmaf.test.mjs>) | 正式行为测试 / quality | 画质比较用例。 |
| [testing-tools/modules/repeat/admission.test.mjs](<../testing-tools/modules/repeat/admission.test.mjs>) | 正式行为测试 / repeat | 重复帧与时间诊断用例。 |
| [testing-tools/modules/repeat/repeat-qualification.test.mjs](<../testing-tools/modules/repeat/repeat-qualification.test.mjs>) | 正式行为测试 / repeat | 重复帧与时间诊断用例。 |
| [testing-tools/modules/repeat/repeat-samples.test.mjs](<../testing-tools/modules/repeat/repeat-samples.test.mjs>) | 正式行为测试 / repeat | 重复帧与时间诊断用例。 |
| [testing-tools/modules/repeat/repeat.test.mjs](<../testing-tools/modules/repeat/repeat.test.mjs>) | 正式行为测试 / repeat | 重复帧与时间诊断用例。 |
| [testing-tools/modules/repeat/tools/repeat-layouts.mjs](<../testing-tools/modules/repeat/tools/repeat-layouts.mjs>) | 测试基础设施 | 独立列出 103 布局、分量标签和可逆布局构造 |
| [testing-tools/modules/repeat/tools/repeat-official.mjs](<../testing-tools/modules/repeat/tools/repeat-official.mjs>) | 测试基础设施 | 读取 NIST SHA256 向量及指定 FFmpeg FATE 预期，核对实际结果 |
| [testing-tools/modules/repeat/tools/repeat-oracle.mjs](<../testing-tools/modules/repeat/tools/repeat-oracle.mjs>) | 测试基础设施 | 不导入产品算法的标量分量寻址、差异和边块参考 |
| [testing-tools/modules/repeat/tools/repeat-report-fixture.mjs](<../testing-tools/modules/repeat/tools/repeat-report-fixture.mjs>) | 测试基础设施 | 明确为协议测试构造的已知字节报告，含占位工具身份；不能作为真实媒体测量 |
| [testing-tools/modules/repeat/tools/repeat-tooling.mjs](<../testing-tools/modules/repeat/tools/repeat-tooling.mjs>) | 测试基础设施 | 定位实际工具并记录可执行文件摘要 |
| [testing-tools/modules/repeat/tools/repeat-upstream.mjs](<../testing-tools/modules/repeat/tools/repeat-upstream.mjs>) | 测试基础设施 | 103 布局已知字节与 FFmpeg identity / 产品结果交叉核对 |
| [testing-tools/modules/reports/portable-repeat.test.mjs](<../testing-tools/modules/reports/portable-repeat.test.mjs>) | 正式行为测试 / reports | 报告与文件协议用例。 |
| [testing-tools/modules/reports/portable.test.mjs](<../testing-tools/modules/reports/portable.test.mjs>) | 正式行为测试 / reports | 报告与文件协议用例。 |
| [testing-tools/modules/reports/report.test.mjs](<../testing-tools/modules/reports/report.test.mjs>) | 正式行为测试 / reports | 报告与文件协议用例。 |
| [testing-tools/modules/reports/timing.test.mjs](<../testing-tools/modules/reports/timing.test.mjs>) | 正式行为测试 / reports | 报告与文件协议用例。 |
| [testing-tools/modules/reports/units.test.mjs](<../testing-tools/modules/reports/units.test.mjs>) | 正式行为测试 / reports | 报告与文件协议用例。 |
| [testing-tools/modules/siti/admission.test.mjs](<../testing-tools/modules/siti/admission.test.mjs>) | 正式行为测试 / siti | SI/TI用例。 |
| [testing-tools/modules/siti/preflight.test.mjs](<../testing-tools/modules/siti/preflight.test.mjs>) | 正式行为测试 / siti | 验证亮度预检的边界码值、命中和完整扫描，核对 API 裁剪选项、过期结果拒绝及最终报告。 |
| [testing-tools/modules/siti/decoder-recovery.test.mjs](<../testing-tools/modules/siti/decoder-recovery.test.mjs>) | 正式行为测试 / siti | SI/TI用例。 |
| [testing-tools/modules/siti/engine-reference.test.mjs](<../testing-tools/modules/siti/engine-reference.test.mjs>) | 正式行为测试 / siti | SI/TI用例。 |
| [testing-tools/modules/siti/siti-gpu-hardware.test.mjs](<../testing-tools/modules/siti/siti-gpu-hardware.test.mjs>) | 正式行为测试 / siti | SI/TI用例。 |
| [testing-tools/modules/siti/siti.test.mjs](<../testing-tools/modules/siti/siti.test.mjs>) | 正式行为测试 / siti | SI/TI用例。 |
| [testing-tools/modules/siti/tools/reference-clips.mjs](<../testing-tools/modules/siti/tools/reference-clips.mjs>) | 测试基础设施 | 核验并提供明确授权的三段上游HLG原件，以及两组自制SDR/PQ控制；逐项保留来源身份，不把五组都称为发表视频。 |
| [testing-tools/modules/siti/tools/siti-hlg-boundary.mjs](<../testing-tools/modules/siti/tools/siti-hlg-boundary.mjs>) | 测试基础设施 | 已知输入字节、HLG 拼接点独立标量及二维数值参考 |
| [testing-tools/modules/siti/tools/siti-input-audit.mjs](<../testing-tools/modules/siti/tools/siti-input-audit.mjs>) | 测试基础设施 | 比较生产 GPU 实际工作平面与独立输入；区分 FP32/HLG 精度 |
| [testing-tools/modules/siti/tools/siti-input-audit.ps1](<../testing-tools/modules/siti/tools/siti-input-audit.ps1>) | 测试基础设施 | 读取实际生产缓冲区，避免用替代 GPU 内核代替被测实现 |
| [testing-tools/modules/siti/tools/siti-inputs.mjs](<../testing-tools/modules/siti/tools/siti-inputs.mjs>) | 测试基础设施 | 已知字节构成实际编码/无损输入，并核查解码后的布局 |
| [testing-tools/modules/siti/tools/siti-layouts.mjs](<../testing-tools/modules/siti/tools/siti-layouts.mjs>) | 测试基础设施 | 解压并校验冻结的 900 PQ 输入布局 oracle 与固定摘要 |
| [testing-tools/modules/siti/tools/siti-raw-gpu.mjs](<../testing-tools/modules/siti/tools/siti-raw-gpu.mjs>) | 测试基础设施 | 把原始字节送入实际 GPU 桥接程序，禁止 CPU 回退蒙混硬件测试 |
| [testing-tools/modules/trials/bd-rate.test.mjs](<../testing-tools/modules/trials/bd-rate.test.mjs>) | 正式行为测试 / trials | 试编码与BD-rate用例。 |
| [testing-tools/modules/trials/bd-reference.test.mjs](<../testing-tools/modules/trials/bd-reference.test.mjs>) | 正式行为测试 / trials | 试编码与BD-rate用例。 |
| [testing-tools/modules/trials/encoder-matrix.test.mjs](<../testing-tools/modules/trials/encoder-matrix.test.mjs>) | 正式行为测试 / trials | 试编码与BD-rate用例。 |
| [testing-tools/modules/trials/native-trial.test.mjs](<../testing-tools/modules/trials/native-trial.test.mjs>) | 正式行为测试 / trials | 试编码与BD-rate用例。 |
| [testing-tools/modules/trials/tools/bd-precision.mjs](<../testing-tools/modules/trials/tools/bd-precision.mjs>) | 测试基础设施 | 固定 RD 数值容差及来源；百分比点误差约束 |
| [testing-tools/modules/trials/tools/jvet-reference.mjs](<../testing-tools/modules/trials/tools/jvet-reference.mjs>) | 测试基础设施 | 读取原始 ZIP/OOXML、输入和缓存答案，不执行宏、不用产品算法重算参考；通用 ZIP 函数被其他模块复用 |
| [testing-tools/modules/trials/trial.test.mjs](<../testing-tools/modules/trials/trial.test.mjs>) | 正式行为测试 / trials | 试编码与BD-rate用例。 |
| [testing-tools/modules/ui/analysis-notes.test.mjs](<../testing-tools/modules/ui/analysis-notes.test.mjs>) | 正式行为测试 / ui | 界面与图表用例。 |
| [testing-tools/modules/ui/browser.test.mjs](<../testing-tools/modules/ui/browser.test.mjs>) | 正式行为测试 / ui | 界面与图表用例。 |
| [testing-tools/modules/ui/chart-model.test.mjs](<../testing-tools/modules/ui/chart-model.test.mjs>) | 正式行为测试 / ui | 界面与图表用例。 |
| [testing-tools/modules/ui/workflow.test.mjs](<../testing-tools/modules/ui/workflow.test.mjs>) | 正式行为测试 / ui | 界面与图表用例。 |
| [testing-tools/prepare-fixtures.mjs](<../testing-tools/prepare-fixtures.mjs>) | 测试基础设施 | 显式选择正式/维护范围或单项，按清单准备并核验缓存；普通测试按需读取，不强制下载全部维护环境。 |
| [testing-tools/product.json](<../testing-tools/product.json>) | 测试基础设施 | 软件功能契约：业务区、行为组、运行/构建输入及发行角色、接口、页面控件、API模板、用例和判据对应。自动执行只核验，不能默默补齐此清单。 |
| [testing-tools/repeat-resource.mjs](<../testing-tools/repeat-resource.mjs>) | 测试基础设施 | 历史调用兼容入口，委托统一扩展调度，不是另一套正式测试 |
| [testing-tools/tooling/test-system/archive-layout.test.mjs](<../testing-tools/tooling/test-system/archive-layout.test.mjs>) | 工具自证 / test-system | 测试工具自身用例。 |
| [testing-tools/tooling/test-system/check-commits.test.mjs](<../testing-tools/tooling/test-system/check-commits.test.mjs>) | 工具自证 / test-system | 测试工具自身用例。 |
| [testing-tools/tooling/test-system/ci-scope.test.mjs](<../testing-tools/tooling/test-system/ci-scope.test.mjs>) | 工具自证 / test-system | 测试工具自身用例。 |
| [testing-tools/tooling/test-system/evidence.test.mjs](<../testing-tools/tooling/test-system/evidence.test.mjs>) | 工具自证 / test-system | 测试工具自身用例。 |
| [testing-tools/tooling/test-system/fixtures.test.mjs](<../testing-tools/tooling/test-system/fixtures.test.mjs>) | 工具自证 / test-system | 测试工具自身用例。 |
| [testing-tools/tooling/test-system/github-archive.test.mjs](<../testing-tools/tooling/test-system/github-archive.test.mjs>) | 工具自证 / test-system | 测试工具自身用例。 |
| [testing-tools/tooling/test-system/local-notes.test.mjs](<../testing-tools/tooling/test-system/local-notes.test.mjs>) | 工具自证 / test-system | 测试工具自身用例。 |
| [testing-tools/tooling/test-system/process-observer.test.mjs](<../testing-tools/tooling/test-system/process-observer.test.mjs>) | 工具自证 / test-system | 测试工具自身用例。 |
| [testing-tools/tooling/test-system/product-contract.test.mjs](<../testing-tools/tooling/test-system/product-contract.test.mjs>) | 工具自证 / test-system | 测试工具自身用例。 |
| [testing-tools/tooling/test-system/release-notes.test.mjs](<../testing-tools/tooling/test-system/release-notes.test.mjs>) | 工具自证 / test-system | 测试工具自身用例。 |
| [testing-tools/tooling/test-system/selection.test.mjs](<../testing-tools/tooling/test-system/selection.test.mjs>) | 工具自证 / test-system | 测试工具自身用例。 |
| [testing-tools/tooling/test-system/test-system.test.mjs](<../testing-tools/tooling/test-system/test-system.test.mjs>) | 工具自证 / test-system | 测试工具自身用例。 |
| [testing-tools/tooling/test-system/tools/archive-layout-protocol.ps1](<../testing-tools/tooling/test-system/tools/archive-layout-protocol.ps1>) | 测试基础设施 | 在自有协议工作区实测归档布局迁移、统一封装、失败记录、去重和恢复边界，不使用真实用户档案作夹具。 |
| [testing-tools/tooling/test-system/tools/compacted-evidence.ps1](<../testing-tools/tooling/test-system/tools/compacted-evidence.ps1>) | 测试基础设施 | 核查压缩历史证据读写与完整性：保留原始状态和精度，拒绝缺数据、改计数或伪造声明。 |
| [testing-tools/tooling/test-system/tools/evidence-names-protocol.ps1](<../testing-tools/tooling/test-system/tools/evidence-names-protocol.ps1>) | 测试基础设施 | 实测可读记录名、完整原身份映射、冲突和中断恢复，避免短名覆盖唯一原件。 |
| [testing-tools/tooling/test-system/tools/evidence-protocol.ps1](<../testing-tools/tooling/test-system/tools/evidence-protocol.ps1>) | 测试基础设施 | 真实文件系统边界协议：清理分类、保护范围、链接/穿越/坏清单和旧证据验证；仅自有可回收夹具。 |
| [testing-tools/tooling/test-system/tools/github-evidence-protocol.ps1](<../testing-tools/tooling/test-system/tools/github-evidence-protocol.ps1>) | 测试基础设施 | 离线构造可追溯云证据传输，实跑导出/导入、尝试身份、损坏和路径拒绝；不向GitHub发送消息。 |
| [testing-tools/tooling/test-system/tools/archive-maintenance.mjs](<../testing-tools/tooling/test-system/tools/archive-maintenance.mjs>) | 开发/运维工具 | 在独立夹具上运行显式归档维护用例。 |
| [testing-tools/tooling/test-system/tools/independent-evidence.ps1](<../testing-tools/tooling/test-system/tools/independent-evidence.ps1>) | 测试基础设施 | 独立记录搬移/复制、缓存缺失、删除后的离线核验及真实导入导出，证明回执不依赖原工作目录。 |
| [testing-tools/tooling/test-system/tools/local-data.test.ps1](<../testing-tools/tooling/test-system/tools/local-data.test.ps1>) | 测试基础设施 | 开发维护工具的独立文件系统自证：受保护资料、清理、保留及恢复规则；不是媒体计算答案或压力负载。 |
| [testing-tools/tooling/test-system/tools/local-import-protocol.ps1](<../testing-tools/tooling/test-system/tools/local-import-protocol.ps1>) | 测试基础设施 | 自有接收目录中的协作者证据导入、来源/去重/完整性与回滚；不会覆盖主工作区真实历史。 |
| [testing-tools/tooling/test-system/tools/release-boundary.ps1](<../testing-tools/tooling/test-system/tools/release-boundary.ps1>) | 测试基础设施 | 构造包及保留资料边界的负面资格样本，拒绝夹带私有资料或运行素材；不把结构检查冒充实际部署。 |

## 每个正式与工具自证用例

完整清单以[正式用例目录](../testing-tools/modules/catalog.json)为准。每条用例登记稳定 ID、测试文件、名称、套件、主模块、覆盖模块、执行条件及允许使用的固定输入。按[入口与选择](#入口与选择)查看指定模块、需求或单个 ID，可用 `npm run test:list -- --case <稳定ID>` 预览。GPU 或原生用例分别加 `--suite gpu` 或 `--suite native`。正式候选的必跑 ID、执行位置和专项以[分工预览](#本地与-actions-分工验收)为准。

`inputs` 列出允许读取的固定输入。空数组仅表示未登记固定输入，用例仍可使用源码控制数据或按需生成的媒体。实际读取见 `inputs.json`，生成与观察的相关证据按记录核对 `measurements.json.gz`。允许读取的清单不能当作实际读取记录。

## 每个测试文件的动态素材与控制数据

下表说明测试文件使用的生成材料、用途和判据。确切文件名取决于用例工作区，运行时保留路径、字节身份和命令。固定输入权限见[正式用例目录](#每个正式与工具自证用例)，原件来源见[固定数据](#每项固定数据来源与资格)。

| 测试文件 | 生成材料 / 控制数据 | 用途与判据 |
| --- | --- | --- |
| [testing-tools/modules/bitrate/bitrate-model.test.mjs](<../testing-tools/modules/bitrate/bitrate-model.test.mjs>) | 内联已知包字节、整数 PTS/时间基、负值/边界/空区间/VFR 控制序列 | 独立逐窗计算与精确守恒；不需要长视频或测速。 |
| [testing-tools/modules/bitrate/distribution-model.test.mjs](<../testing-tools/modules/bitrate/distribution-model.test.mjs>) | 内联音轨包/帧时间数据、缺失 PTS/时长与超限状态 | 校验分布、时间与禁用视图的产品行为，超限状态不等于满容量压测。 |
| [testing-tools/modules/bitrate/packet-engine.test.mjs](<../testing-tools/modules/bitrate/packet-engine.test.mjs>) | 普通多音轨控制和HDR PCM短片、各轨独立FFprobe包清单 | 按真实轨道逐包聚合与字节守恒；不把容器大小当作视频有效字节。 |
| [testing-tools/modules/bitrate/validation.test.mjs](<../testing-tools/modules/bitrate/validation.test.mjs>) | validation 助手生成的短高帧率/VFR 媒体与故障输入 | 真实包/窗口等价和守恒，生成 bitrate-validation-* JSON 测量。 |
| [testing-tools/modules/desktop/deployment-json.test.mjs](<../testing-tools/modules/desktop/deployment-json.test.mjs>) | 隔离 current/config JSON、锁文件、破损/并发状态 | 实际部署原子写入与读回；这些是控制文件负例，不是媒体测量。 |
| [testing-tools/modules/desktop/desktop-browser.test.mjs](<../testing-tools/modules/desktop/desktop-browser.test.mjs>) | 临时浏览器配置、启动 URL 与进程/响应状态 | 桌面浏览器选择/启动/关闭协议；不覆盖原生媒体选择弹窗。 |
| [testing-tools/modules/desktop/environment-selection.test.mjs](<../testing-tools/modules/desktop/environment-selection.test.mjs>) | 隔离组件路径、有效/无效程序及预设弹窗选择 | 实际环境解析/程序验证；模态交互被替换，不能记为真实弹窗验收。 |
| [testing-tools/modules/desktop/fast-launch.test.mjs](<../testing-tools/modules/desktop/fast-launch.test.mjs>) | 隔离源码/安装版本、真实组件副本、配置缓存和 EXE/DLL 变化 | 实际 start.cmd、更新/回滚/缓存失效与锁定；只作用于自有目录和进程。 |
| [testing-tools/modules/desktop/http-startup.test.mjs](<../testing-tools/modules/desktop/http-startup.test.mjs>) | 短媒体、服务启动阶段/失败状态、请求响应 | HTTP 准备/错误行为及实际探测；不是吞吐量或压力负载。 |
| [testing-tools/modules/desktop/native-dialogs.test.mjs](<../testing-tools/modules/desktop/native-dialogs.test.mjs>) | Unicode小文件与目录、隔离组件/安装目录及真实Edge页面 | 真实Windows文件/文件夹/组件/确认选择、取消与重开；只操作自有进程窗口，未实施用户安装。 |
| [testing-tools/modules/desktop/startup-desktop.test.mjs](<../testing-tools/modules/desktop/startup-desktop.test.mjs>) | 隔离启动器/运行配置、实际页面/控制台与进程日志 | 检查服务/窗口生命周期和退出；真实系统选择弹窗由native-dialogs另测。 |
| [testing-tools/modules/frames/analysis-budget.test.mjs](<../testing-tools/modules/frames/analysis-budget.test.mjs>) | 短实际无损H.264和人为缩小的包预算；AV1解析器使用明确的trace-header控制行 | 预算耗尽须显式标记；真实解码帧与SI/TI不能被截断；AV1控制行只证明解析器拒绝规则。 |
| [testing-tools/modules/frames/codec-structure.test.mjs](<../testing-tools/modules/frames/codec-structure.test.mjs>) | 实际H.264、HEVC及AV1编码短片 | 以原始NAL/OBU及探测输出检查IDR/CRA、隐藏/重复显示和参考槽，不靠文件扩展名猜结构。 |
| [testing-tools/modules/frames/execution-equivalence.test.mjs](<../testing-tools/modules/frames/execution-equivalence.test.mjs>) | 同一实际短媒体、同参数串行与并发读取 | 逐项帧、包及结构结果相等；只做功能等价，不把时间比称为速度基准。 |
| [testing-tools/modules/jobs/admission.test.mjs](<../testing-tools/modules/jobs/admission.test.mjs>) | 2048个实际4×4灰度Y4M帧，对应0至2047场景起始索引；普通缩进JSON正文超过通用小请求门限 | 只验证合法请求排队及非法索引拒绝，不运行这些帧；每个合法索引均在实际素材内。 |
| [testing-tools/modules/jobs/runtime-data-browser.test.mjs](<../testing-tools/modules/jobs/runtime-data-browser.test.mjs>) | 自有服务器/浏览器、设置、短任务/导出和清理状态 | 界面操作与实际持有/清理反馈；工作数据仅在隔离运行目录。 |
| [testing-tools/modules/jobs/runtime-data.test.mjs](<../testing-tools/modules/jobs/runtime-data.test.mjs>) | 隔离 .mediascope 状态、任务报告、导出持有/显式保存媒体和恢复数据 | 验证保护、清理、重启、事务和保留边界；不触碰用户原报告。 |
| [testing-tools/modules/jobs/server.test.mjs](<../testing-tools/modules/jobs/server.test.mjs>) | 真实短媒体、自有 HTTP 服务/会话与不同目标/队列/计划负例 | 实际 API/计算/报告、取消重试与数据保护；不含原生选择窗口的实际交互。 |
| [testing-tools/modules/media-info/basic-properties.test.mjs](<../testing-tools/modules/media-info/basic-properties.test.mjs>) | 64×48普通8/10/12位、RGB/灰度/半平面、多轨/字幕/附件/章节、色彩标签矩阵及坏媒体 | 由basic-properties工具按配方实际编码；逐字段对照独立FFprobe原始输出。内存观察器的快退出进程已归工具自证。 |
| [testing-tools/modules/media-info/engine.test.mjs](<../testing-tools/modules/media-info/engine.test.mjs>) | engineControl生成192×108、12帧H.264及440/880Hz两条AAC音轨；内联重复side-data对象 | 真实探测/帧/包数量和音轨清单；side-data对象只验证合并与来源，不冒充探测结果。 |
| [testing-tools/modules/quality/bitdepth.test.mjs](<../testing-tools/modules/quality/bitdepth.test.mjs>) | 实际跨位深参考/候选、显式归一化和无效组合 | 检查拒绝/选择、转换值及原始命令/报告证据，不能用媒体标签代替像素核验。 |
| [testing-tools/modules/quality/chroma-assumption.test.mjs](<../testing-tools/modules/quality/chroma-assumption.test.mjs>) | 实际不同色度位置/缺失标签/合法和冲突组合视频 | 检查显式假设、兼容/拒绝和报告说明。 |
| [testing-tools/modules/quality/comparison.test.mjs](<../testing-tools/modules/quality/comparison.test.mjs>) | 普通短参考/有损候选、HDR、原生色度/位深及时序偏移控制 | 恒等解析值、独立FFmpeg指标与拒绝/取消；实际生成素材按格式和参数核验。 |
| [testing-tools/modules/quality/execution-equivalence.test.mjs](<../testing-tools/modules/quality/execution-equivalence.test.mjs>) | 同一真实质量比较输入和重复计算缓存 | 串行/并发及复用解码、缓存命中/失效的逐帧值一致；不测最大吞吐。 |
| [testing-tools/modules/quality/vmaf.test.mjs](<../testing-tools/modules/quality/vmaf.test.mjs>) | 18 种范围/色度/位深控制输入、模型/方向/自比较和坏日志 | 产品与独立 FFmpeg 图的逐帧/官方池化/解析对照；不等于主观评分数据库验证。 |
| [testing-tools/modules/repeat/admission.test.mjs](<../testing-tools/modules/repeat/admission.test.mjs>) | 1帧4×4灰度Y4M原件，加故意超限的帧字节描述参数 | 检查特定原生帧字节错误且没有启动解码；非法描述不代表文件真实尺寸。 |
| [testing-tools/modules/repeat/repeat-qualification.test.mjs](<../testing-tools/modules/repeat/repeat-qualification.test.mjs>) | 锁定NIST/FATE配方与答案、独立布局的已知整数样本和边缘块/差异控制 | 分别核验摘要、指定官方配方和逐样本比较；不宣称全部FATE或任意容器认证。 |
| [testing-tools/modules/repeat/repeat-samples.test.mjs](<../testing-tools/modules/repeat/repeat-samples.test.mjs>) | 原生整数格式/分量/Alpha 的已知字节、分块切分和无效输入 | 精确判等、每码值/分量/边块差异；预期由独立标量控制，不拿产品输出刷新答案。 |
| [testing-tools/modules/repeat/repeat.test.mjs](<../testing-tools/modules/repeat/repeat.test.mjs>) | 实际编码的相同/改变帧、原始时间、连续/开放结尾和低变化控制片段 | 测量真实 repeat 结果、时间证据、错误/取消；容量/长稳由扩展承担。 |
| [testing-tools/modules/reports/portable-repeat.test.mjs](<../testing-tools/modules/reports/portable-repeat.test.mjs>) | 实际 repeat 报告 + 明确 protocol-fixture 已知字节报告，历史方法/摘要描述负例 | 验证完整导入导出/兼容和差异证据关联；构造报告不是测量样本。 |
| [testing-tools/modules/reports/portable.test.mjs](<../testing-tools/modules/reports/portable.test.mjs>) | 实际分析/试编码报告、压缩列明细、旧格式和恶意/损坏字段 | 验证序列化往返/协议拒绝；大字节量生成留扩展。 |
| [testing-tools/modules/reports/report.test.mjs](<../testing-tools/modules/reports/report.test.mjs>) | 实际报告、锁定历史方法配置及结构/数值/扩展字段控制对象 | 验证合法性、旧方法兼容和不一致拒绝；协议控制对象不充当真实计算样本。 |
| [testing-tools/modules/reports/timing.test.mjs](<../testing-tools/modules/reports/timing.test.mjs>) | 已知整数时间戳、分数时间基、缺失/非法时间及计时汇总 | 精确换算/格式/语义测试，不比较不同设备速度。 |
| [testing-tools/modules/reports/units.test.mjs](<../testing-tools/modules/reports/units.test.mjs>) | 已知字节/码率/单位边界、精度与显示控制数据 | 区分十进制容量和原始整数依据；不生成极大导出文件。 |
| [testing-tools/modules/siti/admission.test.mjs](<../testing-tools/modules/siti/admission.test.mjs>) | 有效普通尺寸描述符，加单一非法帧数/类型/设备或场景参数；未打开路径只作解码前拒绝对象 | 检查具体错误原因和命令数为0；稀疏数组仅验证准入，不是大帧数媒体计算。 |
| [testing-tools/modules/siti/preflight.test.mjs](<../testing-tools/modules/siti/preflight.test.mjs>) | 生成有限范围 8/10/12 位亮度测试片、原生字节和修改文件状态的负例 | 核对标称端点、越界命中、完整扫描、取消、HTTP 进度及结论，并验证裁剪接入普通分析和旧结论失效。 |
| [testing-tools/modules/siti/decoder-recovery.test.mjs](<../testing-tools/modules/siti/decoder-recovery.test.mjs>) | 故意不可完成的SI/TI实际解码/样本输入及真实子进程 | 错误必须收束、排空解码器并保留失败；不是成功计算的替代输入。 |
| [testing-tools/modules/siti/engine-reference.test.mjs](<../testing-tools/modules/siti/engine-reference.test.mjs>) | 192×108、12帧无损FFV1 SDR；同规模单一亮度码值15的声明limited非法视频 | 检查真实解码每帧对应、非零指标和首帧TI；非法亮度必须保留准确拒绝原因。数值精度另由独立参考用例检查。 |
| [testing-tools/modules/siti/siti-gpu-hardware.test.mjs](<../testing-tools/modules/siti/siti-gpu-hardware.test.mjs>) | 新900组原生布局、锁定数值向量、3段上游HLG与2组自制SDR/PQ、实际编码及受控故障 | 真实OpenCL GPU逐点对照独立答案与CPU，检查故障回退/恢复；CPU fallback不能满足GPU通过。 |
| [testing-tools/modules/siti/siti.test.mjs](<../testing-tools/modules/siti/siti.test.mjs>) | 按本例声明的锁定参考、已知原始字节、实际无损编码及传递/场景/线程控制 | 对照独立数值、输入/场景和兼容/拒绝行为；答案、来源、许可分别计角色，不以产品输出刷新答案。 |
| [testing-tools/modules/trials/bd-rate.test.mjs](<../testing-tools/modules/trials/bd-rate.test.mjs>) | 固定 RD 曲线、无重叠/非法点、质量域和显示控制数据 | 验证数学、状态及同域比较；不依赖大型视频。 |
| [testing-tools/modules/trials/bd-reference.test.mjs](<../testing-tools/modules/trials/bd-reference.test.mjs>) | JVET原工作簿，已知整数像素原始帧/无损候选、实际码流及跨报告控制 | 原始工作簿数值/错误、独立SSE/PSNR闭式及实际码率/文件摘要；不以产品积分生成预期。 |
| [testing-tools/modules/trials/encoder-matrix.test.mjs](<../testing-tools/modules/trials/encoder-matrix.test.mjs>) | 明确原生位深/参数的短参考片、实际H.264/HEVC/AV1编码候选 | 检查实际编码输出、试编码指标和清理行为；不以编码器存在代替执行。 |
| [testing-tools/modules/trials/native-trial.test.mjs](<../testing-tools/modules/trials/native-trial.test.mjs>) | 真实编码器的原生位深/参数/片段及缓存/清理控制文件 | 检查实际输出和拒绝边界，不能用编码器存在或日志字符串代替执行。 |
| [testing-tools/modules/trials/trial.test.mjs](<../testing-tools/modules/trials/trial.test.mjs>) | 短实际参考视频、不同 preset/CRF/指标的试编码矩阵 | 测量实际行/逐帧时间、模型和保存/清理结果。 |
| [testing-tools/modules/ui/analysis-notes.test.mjs](<../testing-tools/modules/ui/analysis-notes.test.mjs>) | 已知风险/缺失字段/资源限制和场景提示的报告控制对象 | 提示分组和可见性；不改源数据、不充当数值测量。 |
| [testing-tools/modules/ui/browser.test.mjs](<../testing-tools/modules/ui/browser.test.mjs>) | makeMedia 短参考/候选、实际任务/报告、已知 repeat 协议对象和浏览器场景 | 实际 Edge 页面、图表/队列/导入导出；无头页面测试不能覆盖系统模态选择器。 |
| [testing-tools/modules/ui/chart-model.test.mjs](<../testing-tools/modules/ui/chart-model.test.mjs>) | 短实际参考/候选及两preset/两CRF试编码；纯坐标、刻度、范围和缺失数据控制 | 实际逐帧图表值与独立几何断言；纯模型选择不生成试编码媒体。 |
| [testing-tools/modules/ui/workflow.test.mjs](<../testing-tools/modules/ui/workflow.test.mjs>) | 实际多GOP H.264/PCM、AV1、质量假设媒体、真实报告/导出/缓存/排队状态及受控一次网络中断 | 实际Edge控件/HTTP、文件内容往返、图表分页和任务生命周期；不模拟测量或进度来充当实际计算。 |
| [testing-tools/tooling/test-system/archive-layout.test.mjs](<../testing-tools/tooling/test-system/archive-layout.test.mjs>) | 明确标识的历史档案/账本/别名/中断迁移合成目录 | 测试归档工具，不代表产品计算或真实 GitHub 远端执行。 |
| [testing-tools/tooling/test-system/check-commits.test.mjs](<../testing-tools/tooling/test-system/check-commits.test.mjs>) | 提交说明/PR 标题和 Git 事件的正反例 | 规则检查器自测，不是软件功能数据。 |
| [testing-tools/tooling/test-system/ci-scope.test.mjs](<../testing-tools/tooling/test-system/ci-scope.test.mjs>) | 自有微型 Git 仓库、确定的提交树、模拟检查回执和自有环回 HTTP 服务 | 验证保守范围分类、角色规则、缺失或失败时完整回归、CLI 结构化产物及本地文档链接。 |
| [testing-tools/tooling/test-system/evidence.test.mjs](<../testing-tools/tooling/test-system/evidence.test.mjs>) | 合成合法/损坏记录、摘要/日志/测量/路径和导入事务 | 检查结果验收、完整性及保护，合成通过记录绝不代替产品真实运行。 |
| [testing-tools/tooling/test-system/fixtures.test.mjs](<../testing-tools/tooling/test-system/fixtures.test.mjs>) | 隔离下载/缓存/摘要错误、角色附件和源码目录样本 | 检查固定输入管理与边界，不修改23项锁定原件。 |
| [testing-tools/tooling/test-system/github-archive.test.mjs](<../testing-tools/tooling/test-system/github-archive.test.mjs>) | 模拟平台接口/分页/响应、原件/索引/迁移/清理边界控制资料 | 验证平台工具协议与保护；模拟接口不证明真实联网服务工作。 |
| [testing-tools/tooling/test-system/local-notes.test.mjs](<../testing-tools/tooling/test-system/local-notes.test.mjs>) | 隔离 notes 索引/清单、冻结附件、分类/命名/遗失/篡改负例 | 本机资料保护工具自测，不自动登记或更新用户实际摘要。 |
| [testing-tools/tooling/test-system/process-observer.test.mjs](<../testing-tools/tooling/test-system/process-observer.test.mjs>) | 8个交替退出码0/7并各写stdout/stderr的短Node进程 | 只检查外部采样/退出和双流保留；不是媒体性能或产品计算覆盖。 |
| [testing-tools/tooling/test-system/product-contract.test.mjs](<../testing-tools/tooling/test-system/product-contract.test.mjs>) | 实际软件契约/目录和明确的缺阶段、错身份、错包字节、改启动器输入等协议控制对象 | 真实契约校验和独立正反断言；合成通过回执只用于验证拒绝器，不是产品通过证据。 |
| [testing-tools/tooling/test-system/release-notes.test.mjs](<../testing-tools/tooling/test-system/release-notes.test.mjs>) | Release 正文、实际小型 ZIP 附件和名称/摘要负例 | 验证正文检查器；不把正文合规当软件发布验收。 |
| [testing-tools/tooling/test-system/selection.test.mjs](<../testing-tools/tooling/test-system/selection.test.mjs>) | 合成选择/结果、真实原生子测试、扩展参数和 CLI 预览 | 验证模块/用例筛选、缺失/重复/跳过拒绝和扩展隔离，不执行扩展重负载。 |
| [testing-tools/tooling/test-system/test-system.test.mjs](<../testing-tools/tooling/test-system/test-system.test.mjs>) | 隔离源码清单、错误日志、实际短命进程、记录/前提/测量负例 | 自测测试框架/介质前提/结果判定；独立 local-data.test.ps1 不在该清单内。 |

## 每项固定数据、来源与资格

默认正式缓存位于 `.build/testing-fixtures/<正式锁摘要>`，维护缓存位于 `.build/reference-fixtures/<维护锁摘要>`。[正式素材锁](../testing-tools/fixtures.lock.json)与[维护素材锁](../testing-tools/maintenance/inputs.lock.json)记录路径、来源、字节数及 SHA-256。正式固定输入的允许消费者可按路径检索[用例目录](../testing-tools/modules/catalog.json)的 `inputs`，附件关系见正式素材锁。运行时逐次校验缓存。

### 正式

| 输入 / 本地原件 | 用途与证明边界 | 来源 |
| --- | --- | --- |
| siti/historical-v7.json | 冻结的旧版SI/TI计算方法及答案；只检查旧报告兼容，不替代现行公式判据。 | [锁定来源](https://raw.githubusercontent.com/Gavin-530/MediaScope/0f0f77e33e7156294c7313101cb50d7795c6e2a5/test/reference/siti/historical-v7.json) |
| siti/layout-reference.json<br>[testing-tools/data/layout-reference.json](<../testing-tools/data/layout-reference.json>) | 全新自制整数布局、原始字节、逐样本归一化值与独立标量SI/TI答案；900组/2700帧，逐布局核对，不证明最大尺寸吞吐。 | 项目自制/获审固定原件 |
| siti/published/fall-hlg.json | 仅对应fall-hlg.mov的固定逐帧SI/TI参考；须与该视频、配置及容差共同使用。 | [原始上游](https://raw.githubusercontent.com/VQEG/siti-tools/c537e33793266187aad87c859fd62a9de9033854/test/ground_truth/fall-hlg.json)；[锁定副本](https://raw.githubusercontent.com/Gavin-530/MediaScope/0f0f77e33e7156294c7313101cb50d7795c6e2a5/test/reference/siti/published/fall-hlg.json) |
| siti/published/lights-hlg.json | 仅对应lights-hlg.mov的固定逐帧SI/TI参考；须与该视频、配置及容差共同使用。 | [原始上游](https://raw.githubusercontent.com/VQEG/siti-tools/c537e33793266187aad87c859fd62a9de9033854/test/ground_truth/lights-hlg.json)；[锁定副本](https://raw.githubusercontent.com/Gavin-530/MediaScope/0f0f77e33e7156294c7313101cb50d7795c6e2a5/test/reference/siti/published/lights-hlg.json) |
| siti/published/manifest.json<br>[testing-tools/data/siti-corpus.json](<../testing-tools/data/siti-corpus.json>) | 上述三段HLG原件与各自答案、来源及身份的对应清单；不含测量答案。 | 项目自制/获审固定原件 |
| siti/published/sunset-hlg.json | 仅对应sunset-hlg.mov的固定逐帧SI/TI参考；须与该视频、配置及容差共同使用。 | [原始上游](https://raw.githubusercontent.com/VQEG/siti-tools/c537e33793266187aad87c859fd62a9de9033854/test/ground_truth/sunset-hlg.json)；[锁定副本](https://raw.githubusercontent.com/Gavin-530/MediaScope/0f0f77e33e7156294c7313101cb50d7795c6e2a5/test/reference/siti/published/sunset-hlg.json) |
| siti/videos/LICENSES | 三段上游HLG素材的授权依据；附件本身不证明计算正确。 | [原始上游](https://raw.githubusercontent.com/VQEG/siti-tools/c537e33793266187aad87c859fd62a9de9033854/test/videos/LICENSES)；[锁定副本](https://raw.githubusercontent.com/Gavin-530/MediaScope/0f0f77e33e7156294c7313101cb50d7795c6e2a5/test/reference/siti/videos/LICENSES) |
| siti/videos/fall-hlg.mov | 明确授权的fall HLG实拍视频原件；与fall-hlg.json配对，验证实际解码后的逐帧计算。 | [原始上游](https://raw.githubusercontent.com/VQEG/siti-tools/c537e33793266187aad87c859fd62a9de9033854/test/videos/fall-hlg.mov)；[锁定副本](https://raw.githubusercontent.com/Gavin-530/MediaScope/0f0f77e33e7156294c7313101cb50d7795c6e2a5/test/reference/siti/videos/fall-hlg.mov) |
| siti/videos/lights-hlg.mov | 明确授权的lights HLG实拍视频原件；与lights-hlg.json配对，验证实际解码后的逐帧计算。 | [原始上游](https://raw.githubusercontent.com/VQEG/siti-tools/c537e33793266187aad87c859fd62a9de9033854/test/videos/lights-hlg.mov)；[锁定副本](https://raw.githubusercontent.com/Gavin-530/MediaScope/0f0f77e33e7156294c7313101cb50d7795c6e2a5/test/reference/siti/videos/lights-hlg.mov) |
| siti/videos/sunset-hlg.mov | 明确授权的sunset HLG实拍视频原件；与sunset-hlg.json配对，验证实际解码后的逐帧计算。 | [原始上游](https://raw.githubusercontent.com/VQEG/siti-tools/c537e33793266187aad87c859fd62a9de9033854/test/videos/sunset-hlg.mov)；[锁定副本](https://raw.githubusercontent.com/Gavin-530/MediaScope/0f0f77e33e7156294c7313101cb50d7795c6e2a5/test/reference/siti/videos/sunset-hlg.mov) |
| siti/vqeg-060.json | 锁定VQEG 0.6.0兼容剖面的数值向量：传递、范围、配置及逐点计算；不是ITU认证或全部自然内容。 | [锁定来源](https://raw.githubusercontent.com/Gavin-530/MediaScope/0f0f77e33e7156294c7313101cb50d7795c6e2a5/test/reference/siti/vqeg-060.json) |
| siti/vqeg-reference.py | 未修改、固定提交的VQEG Python实现；核验参考来源/独立重建环境，不在产品运行时执行。 | [原始上游](https://raw.githubusercontent.com/VQEG/siti-tools/c537e33793266187aad87c859fd62a9de9033854/src/siti_tools/siti.py)；[锁定副本](https://raw.githubusercontent.com/Gavin-530/MediaScope/0f0f77e33e7156294c7313101cb50d7795c6e2a5/test/reference/siti/vqeg-reference.py) |
| bd-rate/JVET-O0003-v1.zip | 原始JVET工作簿压缩包；读取原数字、公式结果与错误单元格，核验BD插值/积分兼容性。 | [原始上游](https://www.itu.int/wftp3/av-arch/jvet-site/2019_07_O_Gothenburg/documents/JVET-O0003-v1.zip)；[锁定副本](https://www.itu.int/wftp3/av-arch/jvet-site/2019_07_O_Gothenburg/documents/JVET-O0003-v1.zip) |
| repeat/nist-shabytetestvectors.zip | NIST公开SHA字节向量；核验摘要内核，不能替代媒体逐样本相等或重复判定。 | [原始上游](https://csrc.nist.gov/CSRC/media/Projects/Cryptographic-Algorithm-Validation-Program/documents/shs/shabytetestvectors.zip)；[锁定副本](https://csrc.nist.gov/CSRC/media/Projects/Cryptographic-Algorithm-Validation-Program/documents/shs/shabytetestvectors.zip) |
| repeat/ffmpeg-n8.1.3/tests/fate/filter-video.mak | 官方FATE测试配方，标明freezedetect控制输入/命令；与其参考输出配对，不是任意视频的答案。 | [原始上游](https://raw.githubusercontent.com/FFmpeg/FFmpeg/1041abdc962f4cc4f394aa8de9dc5236c0c3b9e7/tests/fate/filter-video.mak)；[锁定副本](https://raw.githubusercontent.com/FFmpeg/FFmpeg/1041abdc962f4cc4f394aa8de9dc5236c0c3b9e7/tests/fate/filter-video.mak) |
| repeat/ffmpeg-n8.1.3/tests/ref/fate/filter-metadata-freezedetect | 对应官方FATE配方的冻结检测元数据答案；检查指定控制序列的上游资格。 | [原始上游](https://raw.githubusercontent.com/FFmpeg/FFmpeg/1041abdc962f4cc4f394aa8de9dc5236c0c3b9e7/tests/ref/fate/filter-metadata-freezedetect)；[锁定副本](https://raw.githubusercontent.com/FFmpeg/FFmpeg/1041abdc962f4cc4f394aa8de9dc5236c0c3b9e7/tests/ref/fate/filter-metadata-freezedetect) |
| repeat/ffmpeg-n8.1.3/libavfilter/vf_identity.c | 固定版本官方identity滤镜源码；保留上游比较语义和来源，不能当作本产品独立样本oracle。 | [原始上游](https://raw.githubusercontent.com/FFmpeg/FFmpeg/1041abdc962f4cc4f394aa8de9dc5236c0c3b9e7/libavfilter/vf_identity.c)；[锁定副本](https://raw.githubusercontent.com/FFmpeg/FFmpeg/1041abdc962f4cc4f394aa8de9dc5236c0c3b9e7/libavfilter/vf_identity.c) |
| repeat/ffmpeg-n8.1.3/COPYING.LGPLv2.1 | 对应FFmpeg来源代码的授权原件；不作为数值判据。 | [原始上游](https://raw.githubusercontent.com/FFmpeg/FFmpeg/1041abdc962f4cc4f394aa8de9dc5236c0c3b9e7/COPYING.LGPLv2.1)；[锁定副本](https://raw.githubusercontent.com/FFmpeg/FFmpeg/1041abdc962f4cc4f394aa8de9dc5236c0c3b9e7/COPYING.LGPLv2.1) |
| siti/controlled-siti.json<br>[testing-tools/data/controlled-siti.json](<../testing-tools/data/controlled-siti.json>) | 自制64×48 SDR/PQ整数图案、原始帧身份及锁定VQEG Python独立生成的逐帧答案；替换来源存疑的同类正式输入。 | 项目自制/获审固定原件 |

### 参考维护专用

| 输入 / 本地原件 | 用途与证明边界 | 来源 |
| --- | --- | --- |
| siti/vqeg-pq.json | 仅供开发者显式重建/比较旧PQ参考的维护输入；正式全量不读取。 | [锁定来源](https://raw.githubusercontent.com/Gavin-530/MediaScope/0f0f77e33e7156294c7313101cb50d7795c6e2a5/test/reference/siti/vqeg-pq.json) |
| siti/vqeg-reference.py | 未修改、固定提交的VQEG Python实现；核验参考来源/独立重建环境，不在产品运行时执行。 | [原始上游](https://raw.githubusercontent.com/VQEG/siti-tools/c537e33793266187aad87c859fd62a9de9033854/src/siti_tools/siti.py)；[锁定副本](https://raw.githubusercontent.com/Gavin-530/MediaScope/0f0f77e33e7156294c7313101cb50d7795c6e2a5/test/reference/siti/vqeg-reference.py) |
| descriptor/av-15.1.0.whl | 官方PyAV wheel中的固定FFmpeg描述符DLL，仅供独立布局参考生成；wheel与DLL均验摘要，不进入软件发行包。 | [锁定来源](https://files.pythonhosted.org/packages/15/74/6f8e38a3b0aea5f28e72813672ff45b64615f2c69e6a4a558718c95edb9f/av-15.1.0-cp312-cp312-win_amd64.whl) |

正式素材包括媒体、数值答案、向量、源码和授权附件。来源和授权附件用于核对资格。旧的来源或授权存疑材料保留原位，正式入口按现行素材锁读取。参考生成只输出候选，审核其来源、独立性、逐项差异和用途后才可修改正式素材锁。

按需生成输入由被选用例及其专用工具明确产生：普通多轨/质量对照来自encoded-controls或real-media；布局/传递/场景来自SI/TI输入工具；重复帧来自已知整数样本与静止/变化序列；画质/BD来自已知像素/独立编码对照；API/报告/UI从这些真实结果或明确标注的协议控制对象取得。每项生成原件的路径/字节摘要、实际命令及生产返回保留在对应用例的观察中，成功封存后不在测试源码目录遗留媒体。

## 独立拓展与维护清单

| 拓展ID / 业务 | 目的 | 可选或必须显式指定的参数 |
| --- | --- | --- |
| siti-dimensions / siti | Analytic edge at an explicitly chosen size | width（必填）, height（必填）, device（默认cpu） |
| siti-frames / siti | Every measured point of an explicitly chosen frame count | frames（必填）, device（默认cpu） |
| repeat-frames / repeat | Exact native repeat evidence at a chosen count | frames（必填）, cancel-stage（可选） |
| repeat-native / repeat | Native frame bytes and final-sample difference at a chosen size | width（必填）, height（必填）, cancel-stage（可选） |
| repeat-long / repeat | Static synthetic endurance input at chosen duration and rate | width（必填）, height（必填）, seconds（必填）, rate（必填）, cancel-stage（可选） |
| repeat-changing / repeat | Changing integer ramp with known paired repeats; every decoded frame checked independently | width（必填）, height（必填）, frames（必填）, rate（必填）, cancel-stage（可选） |
| export-bytes / reports | CSV byte count and accepted/rejected serialization | bytes（必填） |
| probe-performance / media-info | Same-file probe timing and sampled memory observations | file（必填）, repetitions（必填） |
| bitrate-performance / bitrate | Same-file window calculation and serialization observations | file（必填）, repetitions（必填） |
| bitrate-diagnostic / bitrate | Fine/direct window equivalence for explicit caller media | file（必填） |
| hash-research / repeat | Explicit phase of the independent hash research tool | out（必填）, phase（必填） |
| whole-file-research / repeat | Explicit phase of the independent complete-file GPU experiment | out（必填）, phase（必填）, repetitions（可选） |
| cooperative-research / repeat | Explicit phase of the independent CPU/GPU cooperative experiment | out（必填）, input-audit（必填）, phase（必填）, repetitions（可选） |

维护入口：siti-reference、controlled-siti和layout-reference；解释器必须显式指定，布局生成另指定FFmpeg。它们不属于软件正式全量，也不会自动升级答案。

## CI 文档轻量检查

分支 push 的纯说明性文档可以执行轻量检查：文件角色由根 `.gitattributes` 的 `mediascope-validation` 明确声明，判定器从确切测试提交读取规则。普通说明文档标为 `docs`；贡献、测试、发布、本机资料规则以及工具读取的归档说明和重复帧资料保留 `full`。这些是经源码读取关系审阅的项目策略，不是自动依赖分析；新增程序消费者时须同步核对角色。未分类、混合改动、规则自身变化、新增/删除/改名/模式变化、空差异、缺失比较对象或强推均执行完整回归。PR、合并队列和手动执行始终保留完整回归。

轻量准入还要求比较基线在 GitHub 上已有同一确切 SHA、预期 Actions 来源、完成且成功的必需回归检查；接口不可用或状态不合格则执行完整回归。`main` 比较 push 的完整 `before..after`，其他分支及 `verify-main-*` 标签比较 `origin/main..测试SHA` 并要求祖先关系，避免只看最后一个文档提交而遗漏代码改动。检查内容为差异空白、UTF-8、非空正文、代码围栏及普通本地链接目标；说明含义、外链和锚点仍须人工审阅。

现有必需 job 始终执行，实际范围写入摘要及 `mediascope-ci-scope-<run>-<attempt>` 产物。轻量结果明确声明未运行产品回归，不能替代发布验收；发布须有确切提交的完整回归记录，必要时手动触发。归档核对范围产物的结构、提交、仓库、run/attempt 和检查结果，保存传输原件后才将该次产品记录标为不适用；缺失或身份不符继续记录缺口，不从步骤显示名称推断。

本地专项入口：`node --test testing-tools/tooling/test-system/ci-scope.test.mjs`。首次引入本调整及后续修改规则/CI 时仍执行完整回归；远端在配置提交推送后才采用新规则。

## 本地与 Actions 分工验收

本机资料维护和候选验收独立执行。任务结束仍用 `npm run notes:check` 核对真实本机资料，按需用 `npm run github:verify` 核对本机平台档案。产品测试不依赖这些真实资料的状态，仍拒绝将受保护资料纳入 Git。修改归档维护工具或其用例时，在本机执行 `node testing-tools/tooling/test-system/tools/archive-maintenance.mjs`，它只使用测试夹具，结果留在 `.build/`。目录中标记为 `archiveMaintenance` 的用例不计入普通产品回归或 Actions 验收；显式 `test:all` 仍执行它们。候选证据校验、读取器和解包等共享能力继续纳入原有验收范围。

分工入口采用同一候选 SHA 和同一比较基线。先确定本次应跑的通用与浏览器用例，再按执行位置分区。Windows Actions 固定 1 路运行已在 `scripts/split-test-cloud-cases.json` 按测试文件和稳定用例 ID 审查登记的通用用例。云端用例须显式无需媒体工具，且无需浏览器或正式固定素材。其余通用与浏览器用例归本地，用 2 路运行；新增通用用例同样归本地，包括在已登记文件中新增的用例。已批准用例的先决条件发生变化时，计划会拒绝该项准入，须复核分工并同步修订登记。`Commit messages` 独立运行自己的提交检查器自测。三组稳定 ID 不重叠，合计覆盖本次应跑范围。分区归属由登记决定，每次实际执行的数量由计划决定；合格的空分区无需执行产品用例。

涉及桌面、安装、启动或卸载时追加原生交互及两轮部署；涉及 GPU 的改动追加真实硬件验证。本地按计划顺序执行专项，GPU 和原生用例各用 1 路。正式素材锁或固定数据变更时执行完整通用回归，并根据实际及原有附件关系和消费用例追加专项。无法追溯消费关系时执行全部专项。测试门禁、共用素材准备和候选证据验证入口变更时执行全部阶段。部署阶段使用同一确切 ZIP。测量内容通过现有独立证据封存与校验，附件读取及旧版兼容见[数据与归档](data-and-archives.md#本地测试证据)。

**检阅粒度。** [正式用例目录](../testing-tools/modules/catalog.json)以稳定 ID 登记用例。候选预览列出本次的 `local`、`cloud`、`commits`、`stages` 和 `stageCases`。通用与浏览器用例按单个 ID 纳入计划；提交检查器自测在预检时整组执行；GPU 和原生专项触发时执行对应整套用例；打包及离线部署与首次联网部署成对触发，分别出具回执。按 `--case` 单独诊断的结果只证明该用例的执行。候选放行以同一 SHA、同一计划要求的全部证据为准。当前目录规模与单次必跑数量分别以目录和候选预览为准。

分工用于 `verify-main-*` 标签预检、对同一标签手动核验及其后的 `main` push。`verify-main-pilot-*` 标签可在主线切换前独立试跑，其余分工事件在仓库变量 `MEDIASCOPE_SPLIT_ENABLED=true` 后启用。需要本地证据的候选使用 GitHub 环境 `mediascope-local-evidence`，由仓库所有者审批。分工验收核对该次运行的原生审批记录。普通 PR、合并队列及其他分支仍提供原全量回归；切换后的 `main` 直推采用独立必需检查 `MediaScope split acceptance`，旧结果不能满足该检查。若需要由 PR 或合并队列交付，先保留原门禁，直到该路径有等价验收。

可选仓库变量 `MEDIASCOPE_SPLIT_BASELINE` 只登记已有合格完整分工验收的确切祖先 SHA。留空时分工按完整范围执行。登记后，已登记的纯说明文档可以走轻量检查。功能选测接受 `public/bitrate-model.js`、`public/distribution-model.js` 的单独或组合常规修改，以及 `public/repeat-view.js` 的单文件常规修改。相对实际基线和登记基线的两组差异合起来必须落入同一个获审范围。选测覆盖产品契约登记的模块、关联需求和集成用例。重复帧视图覆盖重复帧和界面两个模块。Actions 核验登记基线的完整验收回执；回执缺失、过期或只有部分验收时轻量档失败，可用完整标签重跑。显式完整预检和本地 `--full` 使用同一实际基线，跳过选测锚点。

1. 冻结候选提交，核对最新 `origin/main`。在干净检出执行 `npm run test:split -- plan --base <main-SHA> --explain` 预览两组差异、选测理由和专项触发路径。解释信息不计入计划摘要，基线证据以 Actions 核验为准。云端若登记了全量基线，本地使用同一 `MEDIASCOPE_SPLIT_BASELINE` 或 `--anchor <SHA>`。完整预检标签用 `verify-main-full-*`，本地传 `--full`。发布标签预检用 `verify-main-release-*`，本地传 `--release` 和 `--archive <ZIP>`。
2. 使用获授权的预检标签启动 Actions，同时本地执行 `npm run test:split -- local --base <main-SHA>`，按计划提供 `--archive <ZIP>`。本地入口核对源码、用例、实际结果及封存记录。保留本地记录和回执供审批人复核。云端预检独立完成并保留证据。文档轻量档由云端检查，本地审阅文义和链接。
3. 两侧结束后，对需要本地证据的同一标签手动运行 `MediaScope candidate evidence review`，提交 `local-receipt.txt` 中的一行回执作为 `local_receipt`。准备作业核验候选、范围、云端通过状态和产物摘要。仓库所有者在 GitHub 的 Review deployments 中核对同一候选、回执摘要及本地封存记录后批准。文档轻量档对同一标签手动运行 `MediaScope tests`，不创建审批作业。缺项、失败、旧 SHA、错范围或缺少所需审批均阻止放行。需要重试时重新手动发起验收，以获得新的审批记录。
4. 手动验收通过后，将同一 SHA 推送到新的 `verify-main-accepted-*` 标签。该次 `push` 的 `MediaScope split acceptance` 复核已有验收，提供服务器认可的必需检查。GitHub 不用手动事件的成功结果满足此门禁。两项必需检查都通过后，重新确认 `origin/main` 与验收基线一致，再普通快进更新 `main`。放行标签和主线复用同一 SHA 的回执。失败或被拒绝的原记录独立保留。

切换审批工作流时，先用原有门禁交付新增工作流文件，保留原审批入口。待新工作流已在默认分支登记，再验收并交付切换候选；手动触发的工作流必须先存在于默认分支。切换后分别用普通候选和文档轻量候选验证 GitHub 提交页的所有适用检查均为成功。历史工作流记录继续按原身份查阅。

发布继续要求完整范围、真实 GPU、原生交互、同一 ZIP 的离线与真实首次联网部署。分工发布复核入口为 `npm run test:split -- release --archive <ZIP>`，读取对应 GitHub 验收和原生审批记录，并复核实际 ZIP。单侧范围记录仍标为部分测试，验收范围在分工回执中记录。

### 临时测试标签的清理

预检和放行标签只用于将候选提交交给 GitHub Actions。测试按候选 SHA 和比较基线选测，无需创建分支或调整软件版本。先固定候选和两侧计划，再推送预检标签并独立启动本地分工。两侧可以并行，实际重叠时间取决于各自启动和排队。重试复用仍合格的原执行证据。

- 正常交付时，等同 SHA 的主线必需检查结束并确认通过，再清理该次预检和放行标签。放弃的候选等相关运行及审批结束后清理。若还要用该候选完成后续验收，等验收结束。
- 清理前按标签名称与对象 SHA 核对本地和远端身份，按提交 SHA、运行和尝试编号归档并验证必要的云端产物、审批记录与本地证据。候选源码若只有临时标签可达，先保存并实测可恢复的源码副本。证据或恢复核查未完成的条目仍待清理。
- 逐个清理已核对的 `verify-main-*`，并重新查询 GitHub 与本地标签确认结果。清理中断时从未完成的标签继续核查。发布标签 `v<版本>` 与各自已发布版本一一对应。

部署前从 `runtime-lock.json` 指定的来源准备 `.build/downloads/node.zip` 和 `.build/downloads/ffmpeg.zip`。本地入口在开始长回归前核对这两个离线传输夹具的 SHA-256。联网阶段仍使用真实锁定下载。

维护 `mediascope-local-evidence` 环境时，只授权仓库所有者，并限制为 `verify-main-*` 标签。审批作业只在需本地证据且准备作业成功时运行。`main` 的必需检查保持 `Commit messages` 和 `MediaScope split acceptance`，来源限定 GitHub Actions。验证门禁改动时，先证明缺审批会拒绝，再使用同一候选的真实证据和审批通过正常推送。保留验收与失败记录。

### 主线历史恢复验收

普通推送和按需测试沿用原规则。普通交付、发布和按需测试基线只查询普通验收；恢复只查询恢复验收。查询先区分用途，再取同一 SHA 下该用途的最新一次运行；该次运行失败或未完成时不会回退到较早的成功结果。此入口仅适用于启用分工验收的仓库，且目标提交本身须包含支持恢复的工作流及校验代码。服务器须能单独授予专用恢复身份非快进更新权限，并继续强制两项必需检查和其他适用保护。未验证服务器能够执行这些条件时，保持强推禁用。

1. 仓库所有者授权一次确定的恢复。记录当前远端 `main` 的 SHA、恢复目标 SHA、双方都可追溯的验收基线、将退出主线的提交、可验证的恢复副本及旧测试证据。把同一组精确 SHA 以 JSON 对象 `{"before":"<原主线SHA>","after":"<目标SHA>","base":"<比较基线SHA>"}` 登记到仓库变量 `MEDIASCOPE_MAIN_RECOVERY`。变量缺失、旧或新 SHA 不符时拒绝恢复。
2. 用 `verify-main-recovery-*` 对目标 SHA 发起云端预检，同时在干净候选检出中设置同样的本机环境变量，执行 `npm run test:split -- local --recovery --archive <ZIP>`。恢复强制完整通用范围，并执行真实 GPU、原生交互和同一 ZIP 的离线及首次联网部署。它不构成发布验收。计划摘要包含三项恢复 SHA，普通回执或其他恢复操作的回执不能代用。
3. 对同一预检标签发起手动验收。仓库所有者核对恢复 SHA、本地封存记录和回执摘要后审批。再在同一 SHA 上推送 `verify-main-accepted-recovery-*`，等 `Commit messages` 和 `MediaScope split acceptance` 都成功。执行者重新读取远端 `main`，只在它仍指向授权的旧 SHA 时用带明确期望 SHA 的 `--force-with-lease=refs/heads/main:<原主线SHA>` 更新主线。目标若发生变化，重新验收。
4. 推送后核对远端实际 SHA 并等该次主线检查结束。保留恢复授权、前后 SHA、验收及失败记录，随后移除仓库变量。后续如需重新验收，须重新核对授权；清理临时标签前，核对标签指向和证据存档，并确认候选可从恢复副本还原。

## 验收回执

完整验证将软件、工具、用例身份、实际断言和同包部署结果写入项目 `.build/complete`。通用、GPU及原生阶段的独立执行记录保存于 `evidence-archive/records`。推送和发布使用其对应提交的正式检查与验收记录。

19项固定资料包括3段媒体、10项参考和向量、6项来源／配方／授权材料。附件读取核验和实际计算判据分别记录。同一批读取复用通过核验的素材，下一批重新核验。

采用 V8 函数和范围计数帮助查漏。功能验收以登记的行为与实际回执为准。
