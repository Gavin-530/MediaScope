# 完整文件 CPU / GPU 重复分析研究工具

本工具用于对完整视频轨道（首帧至 EOF）进行重复、原生差异、静止候选及原始 PTS 分析的端到端对照。它不替换生产后端，不涵盖 MediaScope 的其他分析模块，也不是 CAVP 或编解码器符合性认证。

需要 Windows x64、Node、.NET Framework x64 C# 编译器、真实 OpenCL GPU，以及具备 CUDA/NVDEC 的已核验 FFmpeg/FFprobe。工具沿用应用的环境选择：优先使用显式 `FFMPEG_PATH` / `FFPROBE_PATH`，否则使用应用内运行时或 PATH；运行前应选用已核验的稳定版本。所有下载、原始媒体、生成源码、可执行文件和测量结果只放在项目 `.build/`。

## 重现

为每次正式重测选择新目录；下面路径只是示例。先把两份完整公开视频下载至该目录的 `inputs/`，分别命名 `sintel-trailer.mp4` 和 `bbb-trailer-1080p.mov`：

- https://media.w3.org/2010/05/sintel/trailer.mp4
- https://download.blender.org/peach/trailer/trailer_1080p.mov

下载对象不是不可变的官方测试向量；`prepare` 记录实际完整文件 SHA-256，重现时须核对历史记录，不能仅根据 URL 宣称字节相同。固定 NIST 输入仍由现有 `fixtures.lock.json` 管理。

```powershell
node testing-tools/tools/whole-file-gpu-audit.mjs --out .build/whole-file-gpu-audit/example --phase prepare
node testing-tools/tools/whole-file-gpu-audit.mjs --out .build/whole-file-gpu-audit/example --phase threshold
node testing-tools/tools/whole-file-gpu-audit.mjs --out .build/whole-file-gpu-audit/example --repetitions 3
node testing-tools/tools/whole-file-gpu-qualification.mjs --out .build/whole-file-gpu-audit/example --phase decode
node testing-tools/tools/whole-file-gpu-qualification.mjs --out .build/whole-file-gpu-audit/example --phase vectors
node testing-tools/tools/whole-file-gpu-audit.mjs --out .build/whole-file-gpu-audit/example --phase decode-baseline
node testing-tools/tools/whole-file-gpu-audit.mjs --out .build/whole-file-gpu-audit/example --phase finalize
```

`prepare` 另构造有独立原始字节摘要/相等掩码的 1080p 8-bit H.264 与 720p 10-bit HEVC 无损控制文件：完全静止、末边缘/色度最低位变化、全局运动、开放至 EOF 的静止片段。控制文件不是官方测试码流。可以通过 `prepare --file <绝对路径>` 追加实际用户文件；当前硬解适配仅接受原生 `yuv420p` / `yuv420p10le`、偶数宽高且有完整递增 PTS 的视频，其他情景明确失败，不能冒充支持。

## 四种路径及通过条件

- `production`：现有 `analyzeRepeats(...,{freeze:true})`，作为产品结果参考。
- `cpu-stream`：研究用单次原生解码，CPU 计算样本摘要/差异及同判据静止事件，识别遍数和流程重排的影响。
- `gpu-sw`：软件解码，GPU 批量计算摘要、直接比较、全部逐分量整数差异及静止事件。
- `gpu-hw`：强制 CUDA/NVDEC 帧输出，经 `hwdownload` 后上传 OpenCL，GPU 执行相同计算。不是零拷贝集成；Intel 计算路径在此模式下仍使用 NVIDIA 解码器，报告中明确区分。

GPU 枚举仅使用 `CL_DEVICE_TYPE_GPU`，不允许 CPU 回退。GPU 初始化、程序构建及分配发生在分析计时内，管道、设备事件、读等待、上传和下载另记。SHA-256 使用标准消息链；标量展开、字序转置和有界内核状态传递不更换摘要算法。

逐帧比较 SHA-256、直接相等标志、每分量七项整数差异、原始 PTS/时长/颜色标签，并比较全部重复区间、PTS ≥2 秒区间、时间网格和静止事件/区间。通过实际解码器 `showinfo` 对每帧原始 PTS 另外核对，不把 FFprobe 扫描结果直接当作硬解已经保留了 PTS 的证明。

原生原始字节管道没有独立的 framehash 封装时间基。研究结果对其关联时间作精确整数重标度，并与产品 framehash 时间值作有理数对照；原始时间戳证据始终保留。研究算法名称、设备身份、命令和生产输出不同，不修改生产报告协议来伪装后端。

`decode` 资格检查在计时之外并行读取软硬解的完整字节流，用独立 NV12/P010 逆适配逐帧 `Buffer.equals`，不依赖摘要相等来声称原始样本相同；P010 被移除的六位必须先验证全零。`vectors` 对新 GPU 内核重放选定 NIST 原始 SHA-256 向量以及新消息填充/2048-block 状态传递边界控制，不借用旧内核的向量通过结果。

## 静止阈值的严谨实现

FFmpeg n8.1.3 的 `vf_freezedetect.c` 用持久参考帧，判据是二进制双精度 `sad / count / 2^depth <= 0.001`。部分 GPU 无 FP64，不能直接换成 float。

在本工具有限整数样本域中，`0.001 = M × 2^-62`，`M=4611686018427388` 为偶数。按 IEEE 最近偶数舍入，该比较等价于：

`sad × 2^(63-depth) <= count × (2M+1)`

这是阈值上侧舍入中点的精确比较，使用两个 128 位无符号乘积的高/低 64 位实现。对二的幂缩放在该域中精确；没有更换为近似阈值。`threshold` 在两块实际 GPU 上重放密集小计数、实际分辨率、域边界、随机计数及临界 SAD，用 CPU 原始双精度表达式逐项作参考。官方源码及时间格式化规则是判据依据，项目边界测试不是官方向量或机构认证。

## 性能与适用范围

每个输入/路径测三次，轮换路径执行顺序，报告全部原始值及最小/中位/最大。端到端墙钟从工作进程进入分析函数开始，到完整结果构造及前后文件核对结束；不含外层 Node 启动/模块加载、最终结果文件写盘或源码到 C# 可执行文件的编译。GPU 子进程启动、上下文、内核程序构建及分配包含在内。

操作系统文件缓存没有清空，温度、功耗、进程亲和性和背景负载没有实验室控制；这不是跨机器性能承诺。GPU 后端融合了生产的多次读取，仍须参考 `cpu-stream`，不能把全部收益解释成 GPU 哈希加速。自定义内核也不是优化上限。时间/区间汇总和报告核验仍由 CPU 执行，不能称为全部分析都在 GPU 上完成。

复核、失败诊断和研究证据都留在 `.build/`。`finalize` 只检查并索引本轮明确的结果和源码，不发布、不提交，也不自动登记到 `local-notes/`。
