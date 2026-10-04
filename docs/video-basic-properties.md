# 视频基础属性与证据

字段定义核对基线为 FFmpeg `n8.1.3`；锁定运行时来源见 `runtime-lock.json`。兼容环境的实际程序和库版本保存在报告中，不能用本文基线代替其他环境的证据。

## 读取和解释

基础读取保留 `-show_format -show_streams -show_chapters -of json` 的完整结果。另一次读取保存实际程序的 `-show_pixel_formats -show_program_version -show_library_versions` 完整 JSON，包括所有描述及标志。二者不构成独立的容器/码流交叉核验。

以下定义核对自 FFmpeg **n8.1.3**，不使用 trunk 替代对应版本。源代码链接同时说明 FFprobe 如何取得这些值。

| 字段 | 来源与单位、解释 |
| --- | --- |
| `size` | 文件系统字节数；另保留 `raw.format.size` 的 FFprobe 文件大小 |
| `format_name`、`index`、`codec_type` | 容器名称、从零开始的轨道编号、媒体类型；来源是 [FFprobe 输出实现](https://github.com/FFmpeg/FFmpeg/blob/n8.1.3/fftools/ffprobe.c) |
| `duration`、`start_time`、`bit_rate` | 容器和轨道分别显示，单位为秒、秒、bit/s；时长/码率可能经工具估计，不等于实测包统计；见 [AVFormatContext / AVStream](https://github.com/FFmpeg/FFmpeg/blob/n8.1.3/libavformat/avformat.h) |
| `codec_name`、`codec_tag_string`、`profile`、`level` | 编码名称、FourCC、Profile、编码专属的原始 Level；不统一换算不同编码的 Level；见 [AVCodecParameters](https://github.com/FFmpeg/FFmpeg/blob/n8.1.3/libavcodec/codec_par.h) |
| `width`、`height`、`coded_width`、`coded_height` | 像素单位；画面尺寸来自 codec parameters，编码尺寸来自 decoder context，零值不推算；见 [AVCodecContext](https://github.com/FFmpeg/FFmpeg/blob/n8.1.3/libavcodec/avcodec.h) |
| `sample_aspect_ratio`、`display_aspect_ratio` | 保留冒号有理数；FFprobe 的 SAR 可由工具选择，DAR 由尺寸与 SAR 计算；见 `show_stream`，不标为独立文件声明 |
| `tags.rotate`、Display Matrix | 旋转标签与附加显示矩阵分别保留；矩阵旋转为工具提取的角度（度），不合并冲突值，也不自动交换尺寸；见 [显示矩阵定义](https://github.com/FFmpeg/FFmpeg/blob/n8.1.3/libavutil/display.h) |
| `pix_fmt`、descriptor `components.bit_depth` | 格式名称及每个分量的 bit 数；不同分量可有不同深度；见 [AVPixFmtDescriptor](https://github.com/FFmpeg/FFmpeg/blob/n8.1.3/libavutil/pixdesc.h) |
| `bits_per_raw_sample` | n8.1.3 FFprobe 取 decoder context 的内部像素/样本位数，非从像素格式名推断。界面称“报告有效位数”，解释限于工具报告；与分量深度分别展示 |
| `bits_per_coded_sample` | 编码样本位数；不等同于解码像素位深。此版 FFprobe 的视频 `show_stream` 未输出该字段，因此显示未报告；不拿音频 `bits_per_sample` 顶替 |
| descriptor `bits_per_pixel` | 由 `av_get_bits_per_pixel` 取得，不含填充，不能作为分量存储宽度；此工具不输出 step/offset/shift/plane 或 padded bits |
| descriptor chroma / flags | `log2_chroma_w/h` 描述网格缩小量并向上取整。`planar` 只说明至少一分量不在第一平面；RGB、palette、hwaccel、alpha 等标志原样保存。透明支持不证明实际透明内容，布局不解释色彩 |
| `color_primaries`、`color_transfer`、`color_space`、`color_range`、`chroma_location` | 色原色、传递函数、矩阵、范围、色度位置分别展示；工具名称核对 [pixdesc.c 的名称映射](https://github.com/FFmpeg/FFmpeg/blob/n8.1.3/libavutil/pixdesc.c) 及 [pixfmt.h 的枚举](https://github.com/FFmpeg/FFmpeg/blob/n8.1.3/libavutil/pixfmt.h)。仅解释名称，不作色彩正确性或 HDR 认证 |
| `field_order` | progressive / tt / bb / tb / bt 原值；样本 `interlaced_frame` 与 `top_field_first` 独立显示，逐行样本的场优先标志不适用；见 [AVFrame flags](https://github.com/FFmpeg/FFmpeg/blob/n8.1.3/libavutil/frame.h) |
| `time_base`、`r_frame_rate`、`avg_frame_rate`、`nb_frames` | 秒/tick、帧/秒、帧/秒、帧。保留原始分数；基础帧率可能为估计，报告帧数并非此次扫描计数；不由两种帧率推断全片 CFR/VFR |
| 附加数据 | 当前读取保留轨道 `side_data_list` 和所有未知扩展字段，标明工具报告来源；旧报告的帧时间戳、附加数据及样本来源继续保留，不由轨道值补造 |

缺失显示“未报告”，工具 unknown/unspecified/N/A 和未知枚举显示未知并保留文字，非法数字/分数显示无效；合法零起点、零时长、零计数保留。正值字段的零表示未指定；Level 的 -99 为未知。RGB/灰度的色度采样、无视频时的帧抽样显示不适用；读取失败显示明确失败原因。全部展示是附加解释，不修改原始值或指标输入。

## 当前读取和页面

基础读取执行容器、轨道、章节探测，并查询像素格式及程序/库版本。**不自动执行开头帧抽样**：有视频时 `frameSampleRead.status` 为 `not-requested`、`frameSample` 为 null，tracks/commands 为空；无视频时为 `not-applicable`。不发送 `-read_intervals` 或抽样 `-show_frames`，因此不设当前开头抽样包数或抽样超时。

GOP、码率、SI/TI 等用户请求的分析仍按各自流程执行；基础读取不抽样不表示分析阶段不扫描帧。当前附加数据来自轨道报告，没有帧级读取不能证明全片不存在其他附加数据。像素描述是工具定义查询，不是像素测量，也不构成独立容器/码流核验。

像素描述查询默认超时 5 秒；失败保留基础探测成功结果并说明原因。用户取消继续传播，命令在进程关闭后定稿。单次未流式探测输出沿用 32 MiB 的安全上限，不新增容器或像素格式白名单。

报告首先显示一个“文件基本信息”区块，容器和所选轨道常用属性常驻；属性选择器可访问视频、音频、字幕、附件及其他轨道，不改变 GOP/SI/TI 的分析目标。

“全部属性”默认折叠，展示其余属性、标签、标志、像素解释、显示矩阵、HDR、未知附加数据及章节。相同附加数据在所属轨道内合并。分量列表完整且位深均为合法相同正整数时简写为“8 bit”等；否则逐分量显示，完整列表可展开。不把缺失分量当作一致，不把分量位深相加作为每像素位数。

“读取与原始记录”保留基础 JSON、像素描述、状态、版本和命令；失败及实际大小来源差异在主区块提示。旧报告确有开头样本时，仍展示样本数量、时间范围、分布、原始帧及来源差异，不用样本值覆盖轨道值，不推断全片一致。基础信息之后保留分析摘要及 GOP、AV1、各轨码率、体积与 SI/TI 区块。

## 报告兼容和验证边界

报告格式仍为 `MediaScope/0.2`，扩展字段可选，兼容旧 `0.1`/`0.2` 与统一封装。导入导出保留原始 JSON、工具版本、命令和未知字段；解析器核对状态及样本计数。旧报告缺少某字段时标为未保存，不能补造测量。历史抽样记录的 `ok`/`failed` 状态、预算和时间证据沿用原值；它们不表示当前新任务仍执行抽样。

[`test/basic-properties.test.mjs`](../test/basic-properties.test.mjs) 验证真实 YUV 420/422/444 × 8/10/12-bit、RGB、灰度、透明、半平面、不等分量位深，以及色彩标签、SAR、旋转、扫描标记、多轨道和附加图像。HDR 帧附加数据用明确的旧抽样报告验证兼容，不宣称当前基础探测进行了帧抽样。

缺失、未知、零值、非法值、样本差异和未知字段使用明确标记的约定输入；损坏媒体、补充查询超时和取消使用真实进程。报告和浏览器测试验证新旧内容保存、展开、轨道切换和导入导出。覆盖映射见 [`test/coverage.json`](../test/coverage.json)，正式通过结论按[测试规范](testing.md)保存。

性能用相同环境和素材比较旧读取基线与当前流程，记录耗时、RSS、报告体积及 FFprobe OS 峰值工作集观察；采样可能遗漏最终峰值，不代表通用吞吐率或内存上限。具体运行数据留在独立证据，不写入当前规范。

当前不提供容器/码流的独立交叉核验、全片属性认证或 MediaInfo 接入。
