# 原生帧哈希研究审计

`hash-audit.mjs` 是显式运行的研究工具，不接入生产哈希选择，不替代通用/GPU 发布门槛。它分别检查哈希算法、原生样本、解码路径、时间及解释元数据，并记录有限范围的 CPU/GPU 性能。

```powershell
node testing-tools/tools/hash-audit.mjs --out .build/hash-audit/<本次目录>
```

输出必须在当前工作区 `.build/`；完整审计要求新建的空输出目录。不覆盖现有正式资料或冻结输入。Node、FFmpeg/FFprobe 版本、实际可执行文件摘要、源码摘要、原始结果及失败诊断均进入本次目录。可以显式运行 `prepare`、`gpu`、`performance`、`cpu-dispatch`、`cpu-threads`、`ffmpeg-vectors`、`media`、`regressions`、`integration`、`report` 阶段；后续阶段依赖前序输出，不能据单个阶段宣称完整通过。`integration` 需要测试进程能够连接它自己启动的本机 HTTP 服务，权限阻止属于环境阻塞，不能伪装为 API 通过。

## 依据与通过条件

- SHA-256/SHA-512：FIPS 180-4；SHA3-256：FIPS 202。重放 NIST 原始字节型 ShortMsg/LongMsg；SHA-2 CPU 另执行原始 Monte Carlo。摘要所有位必须匹配，不允许数值容差。
- NIST 明确说明公开向量仅可非正式核验实现，不能替代 CAVP 验证。本工具不提供 CAVP、FIPS 140 或编解码器符合性认证。
- SHA-2 固定原件沿用 `fixtures.lock.json`；SHA-3 原件来自 NIST 官方链接，审计入口锁定长度和 SHA-256，缺失时下载到 `.build/hash-audit-inputs/sha-3bytetestvectors.zip`。下载失败或摘要不符时失败，不跳过。
- GPU 使用测试专用 OpenCL 整数实现，要求实际 `CL_DEVICE_TYPE_GPU`，禁止 CPU 回退。保留每个设备、驱动、构建和逐任务检查点；按官方答案及独立 CPU 结果核对每次测量摘要。
- 一条工作项处理一条完整消息。多个有界启动传递标准哈希状态，不能把分块摘要拼接或另算树哈希冒充原算法。
- 媒体采用明确标记的项目已知字节。无损编码须先对原始字节验证；NV12/P010 适配仅允许可逆重排及位对齐，并独立往返检查。CUDA 解码必须输出 CUDA 帧供 `hwdownload` 使用，不能以软件回退满足硬件检查。
- 既有重复分析回归中的构造报告字段/强制相同摘要属于协议和判据边界测试，不是真实 SHA-256 碰撞，也不作为密码分析依据。

## 性能解释

CPU 与 GPU 分别记录预热和五次测量。CPU 输入已在主机内存；GPU 分别测显存已驻留及含主机上传模式。两者在主机取得摘要二进制结果时结束墙钟计时，不含十六进制转换和答案核验。GPU 另保留设备事件耗时；编译、上下文、分配、磁盘和生成输入不混入稳态哈希时间。

此 OpenCL 内核是标准流程的测试实现，不是最佳 GPU 性能实现。固定顺序、整机背景负载与功耗温度未受实验室控制；结果只描述本次机器和代码，不证明某类设备或算法普遍更快。OpenSSL 能力屏蔽对照通过新进程的官方环境变量执行，不冒称已经跟踪每条汇编指令。完整生产媒体分析流水线的加速效果必须另测。

## 重现依赖

Windows x64、支持的 Node、具备相应编码器及 CUDA/NVDEC 的 FFmpeg/FFprobe、实际 OpenCL GPU 和驱动、.NET Framework x64 C# 编译器。默认媒体工具位置沿用本机已核验稳定运行时缓存，可用 `FFMPEG_PATH`、`FFPROBE_PATH` 显式指定。所有首次下载、源码生成、编译、媒体及日志只写项目 `.build/`。

依赖缺失或某个要求检查失败时保留诊断，不改为跳过或自动降低标准。比特型向量、GPU Monte Carlo、所有合法码流、动态 HDR、AV1 颗粒、物理显示、BLAKE3/xxHash 实测等不在当前覆盖范围。
