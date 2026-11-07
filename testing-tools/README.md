# 测试工具

此目录保存长期维护的自动验证程序，禁止存放媒体素材、固定参考数据正文、下载缓存、运行日志和一次性实验。

| 内容 | 职责 |
| --- | --- |
| `modules/<模块>/` | 所属模块的正式测试及`tools/`专用助手 |
| `helpers/` | 公共输入、服务启动、执行、结果与来源边界 |
| `modules/catalog.json` | 正式模块、稳定用例ID、允许输入和必须产物的唯一执行清单 |
| `coverage.json` | 指向正式清单的元数据入口，不再维护标题正则覆盖表 |
| `extensions/` | 开发者按需选择的参数化容量、尺寸、长稳和性能工具 |
| `maintenance/` | 独立参考生成及其依赖锁定，不参与正式回归 |
| `input-roles.json` | 固定原件、独立参考、许可和来源附件的角色 |
| `fixtures.lock.json` | 固定输入的不可变来源 URL、精确字节数和 SHA-256；不包含素材正文 |
| `prepare-fixtures.mjs` | 下载缺失固定输入并校验缓存 |

执行入口和通过条件以 [测试规范](../docs/testing.md) 为准。`npm test` 仍是标准命令，由 `scripts/test.mjs` 调度此目录中的程序。固定输入保存在 `.build/testing-fixtures/<清单摘要>/`；测试生成文件写入当前隔离源码工作区内的 `.build/testing-work/`。直接执行单个用例时，相同相对路径位于当前工作目录。

`npm run test:prepare` 可在联网时预先取得全部固定输入；缺失文件会按锁定提交下载，已存在文件也须通过长度和摘要检查。首次迁移固定到本仓库已有提交的历史快照，以保持原有字节和来源信息。后续输入变更必须审核新来源和摘要，禁止用产品输出刷新参考答案。缓存损坏会明确失败；核对后只移走相应缓存文件，再重新准备。清理缓存后需要重新下载。

SI/TI 的固定输入包含上游 siti-tools 0.6.0 源码、五个原始片段、对应发布结果和许可证，以及独立参考矩阵。`layout-oracle.json.gz` 覆盖 150 种整数像素布局、全/有限范围及三种尺寸，共 900 例。142 种布局来自 libavutil 描述符的已知字节，8 种较新高位对齐布局经过 FFmpeg 往返验证；期望值使用独立二维卷积和总体标准差计算。它们与产品代码分别维护，普通回归重放冻结输入。`maintenance/generate-siti-reference.py` 的新输出仅写入 `.build/reference-maintenance/<本次目录>/candidate.json`，不会覆盖锁定缓存。

根目录旧 `test-work/` 是兼容保留位置，包含受保护的历史验收资料，不再承接这些用例的新输出。正式测试记录与中断恢复资料按 [数据与归档](../docs/data-and-archives.md) 单独管理。

`fast-launch.test.mjs` 在 `.build/testing-work/fast-launch` 建立独立源码及安装副本，通过真实 `start.cmd`、原环境验证、原更新/回滚流程和专用隐藏控制台验证快速入口。测试复制的组件、启动记录和控制台日志均留在该范围；目录链接哨兵和真实控制信号只作用于测试创建的目录与进程。原 PowerShell 启动、JSON 原子写入和浏览器生命周期检查仍由原用例覆盖。

重复帧的 `repeat-qualification.test.mjs` 保留正式正确性检查：NIST SHA-256 原始向量、FFmpeg原始FATE定义/答案、运行时布局及可逆表示关系、有限整数码值域与边缘块。固定上游输入和许可证按锁定身份读取，不随应用分发；官方参考与项目控制输入分别记录。满容量和精确资源上限不属于此正式范围。

`npm test -- --module <模块>` 或 `--case <稳定ID>` 选择正式范围，`--list`列举，`--dry-run`预览。未选用例不以跳过占位计数，也不把局部通过称为完整通过。

`npm test -- --extend --list`列出开发者扩展及参数。选择工具并显式指定数量、尺寸、时长、字节数或重复次数；不默认采用软件上限，不自动组合独立负载，不纳入正式完整测试。`repeat-resource.mjs`和码率基准旧文件名只保留兼容入口，内部调用同一扩展调度器。固定输入按实际读取准备，生成输入和结果留在本次`.build/testing-extensions/`。重复分析资源观察使用独立父进程和外部Windows进程采样，峰值是下界。

参考维护通过`npm test -- --maintain --list`列举。`--maintain siti-reference --python <解释器绝对路径>`要求显式的独立Python环境，依赖版本、来源和wheel摘要以`maintenance/environment.lock.json`为准；运行时只准备所需上游原件。新输出带实际Python/NumPy/SciPy与脚本身份，状态为待审候选，不覆盖锁定输入。普通测试不安装或运行Python；维护运行时和依赖也放项目`.build`。

[哈希研究审计](extensions/repeat/hash-audit.md)由 `extensions/repeat/hash-audit.mjs` 显式执行：NIST 字节型 SHA-256/SHA-512/SHA3-256 向量、实际 OpenCL GPU、CPU 指令能力屏蔽及并行、受控媒体的 CUDA 解码/布局/时间/颜色解释，以及分开计时的哈希性能。它不改变生产哈希算法、不提供机构认证，也不替代通用或 GPU 发布门槛；依赖、范围与重现步骤见工具说明。所有输入、编译产物和结果留在项目 `.build/`。

[完整文件 CPU/GPU 分析对照](extensions/repeat/whole-file-gpu-audit.md)另验证批量原生摘要、直接比较、逐分量差异、持久参考静止筛查及原始 PTS 的完整结果：对照现有产品、单次读取 CPU 与两块实际 GPU 的软件/硬件解码路径。独立资格检查逐字节比较完整软硬解输出，并对新内核重放官方 SHA-256 消息和阈值算术边界。研究后端不接入生产分析，端到端、初始化、传输与独立解码基线分开记录。

[CPU/GPU 并行分担完整帧哈希](extensions/repeat/cooperative-gpu-audit.md)在独立证据目录对照 CPU 分担 0/25/50/75/100% 的完整帧 SHA-256，GPU 保留全部样本差异与静止筛查；另验证新增 Windows CNG CPU 提供者和实际并发观察。它只扩展研究工具，不更换生产算法，不把多块摘要拼接当成标准 SHA-256。
