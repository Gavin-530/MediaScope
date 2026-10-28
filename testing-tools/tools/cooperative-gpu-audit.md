# CPU / GPU 并行分担完整帧哈希

这是 `whole-file-gpu-audit.mjs` 的独立研究实验，结果写入新 `.build/` 目录，不修改上一轮证据或生产分析后端。

```powershell
node testing-tools/tools/cooperative-gpu-audit.mjs --out .build/cooperative-gpu-audit/example --input-audit .build/whole-file-gpu-audit/example
```

完整运行要求新的空输出目录。也可用 `--phase build`、`qualify`、`matrix`、`report`、`finalize` 分阶段恢复本次工作。输入审计目录须已完成完整文件测试、独立字节核查及官方/项目 SHA 向量资格；本工具复用其中实际文件和参考原消息，读取前后核对完整文件摘要。

实验使用实际 OpenCL GPU 设备（device 0，实际型号与能力以运行记录为准）和 Windows CNG 的 `SHA256Cng`。CPU 使用四个工作线程，在每批原生帧中承担前 0%、25%、50%、75%、100% 的完整帧摘要，其余完整帧摘要由 GPU 计算；按批向上取整，实际帧数逐批保留。不是把同一帧的分块摘要拼接，也不把 SHA-256 和其他算法的摘要相互比较。

CPU 任务与非阻塞 OpenCL 队列并行调度。结果记录 CPU 任务的单调时钟起止、GPU 结束的主机观察时刻，以及“CPU 任务已经开始且尚未结束时，GPU 事件已经完成”的实际观察。该观察证明任务生命周期发生重叠，不声称已经用校准过的 CPU/GPU 时钟量出重叠百分比。

所有配置仍由 GPU 计算每一对相邻样本的整数差异和静止参考比较/状态。CPU 100% 仅指全部**哈希**交给 CPU，不能称为纯 CPU 分析；现有产品 CPU 路径另作基线。时间戳探测、源文件完整性、时间网格/区间汇总及报告核验继续在 CPU。

新增 CPU 提供者使用 Windows CNG，和既有 Node/OpenSSL 不同。`qualify` 对七条锁定 NIST 原始 SHA-256 消息以及七条项目填充/2048-block 状态传递边界消息，各构造两个完整帧，让 CPU 和 GPU 各计算同一完整原消息一次，分别核对官方或独立预期。项目输入不能冒充官方向量，公开向量通过也不是 CAVP 验证。

`matrix` 对先前的四份完整文件和六种配置各运行三次，轮换配置顺序，比较所有逐帧原始 PTS、哈希、直接相等和差异、精确重复段、PTS ≥2秒区间、时间网格及完整静止事件/区间。配置、设备、命令和实际分工本来不同，分别保留；关联时间用精确有理数核对。

计时沿用上一轮分析入口至完整结果构造的墙钟定义：包含 GPU 子进程启动、上下文/程序/分配和 CPU 工作线程/CNG 创建，排除外层 Node 启动/导入和最终结果文件写盘。不清空系统缓存，不控制温度/功耗/背景负载，也未搜索所有线程数、分配比例、GPU 型号或最优代码；三个观察不构成跨硬件性能承诺。

此完整文件并行实验只使用 SHA-256。SHA-512 和 SHA3-256 的此前向量/微基准结果不能冒充它们已经通过该并行完整分析流程。源码分别按 [FIPS 180-4](https://csrc.nist.gov/pubs/fips/180-4/upd1/final) 和 [FIPS 202](https://csrc.nist.gov/pubs/fips/202/final) 核验；[NIST 官方说明](https://csrc.nist.gov/projects/cryptographic-algorithm-validation-program/secure-hashing)明确区分公开向量重放与正式验证。
