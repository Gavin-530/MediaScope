# JSON 文件协议 0.4

报告接口和用户主动导出使用相同的普通 JSON 协议。所有用户导出包括单份结果、多份结果、待运行计划以及两者混合，不按用途派生另一套格式。结果仅在本次服务的内存中保留；导入的 JSON 在当前页面解码查看，不自动保存副本。

## 文件头和内容

顶层字段为 `format: "MediaScope"`、`formatVersion: "0.4"`、`createdAt`、`producer`、`results`、`plans` 和 `timing`。版本号使用字符串，格式版本只在文件顶层出现一次。单份报告不含 `schema` 或另一个 `formatVersion`。软件设置、任务状态、失败记录、测试证据和第三方原始日志不属于本协议。

`producer.applicationVersion` 是本次写出文件的实际应用版本。`createdAt` 是文件生成时间，默认使用 UTC 秒级 RFC 3339。来源已有小数秒原样保留；媒体时间戳、时长和计算耗时不按秒截断。日期规则见[数据与归档](data-and-archives.md#日期与时间)。

`results` 和 `plans` 都是最多 10,000 项的数组，单个数组内 `entryId` 为非空且不重复的字符串。每项结果包含 `report`，每项计划包含 `input`。计划参数由服务端逐项验证后才允许排队；查看结果不会自动创建计划。没有内容的用户导出和导入拒绝；空计划列表接口仍能返回同一协议的空列表。

结果保留原有生成时间、`producer.applicationVersion`、素材与轨道信息、工具版本、命令及耗时、指标配置、逐帧与逐包数据、汇总、原始证据、警告、不可用/失败/资源受限状态。重新导出只更新外层生成信息，不覆盖每份结果的来源。`type` 为 `inspect`、`analyze`、`compare` 或 `trial`；前两者归入文件分析功能。

按目标运行的 `analyze` 报告增加 `analysisTargets: {frames, bitrate, complexity}`，三项均为布尔值；选择重复帧时另加 `repeat: true`，未选时省略，全部目标至少一项为真。`frames` 或 `complexity` 开启时保存核验显示帧及汇总；`frames` 开启时保存编码结构。`frames` 或 `bitrate` 开启时保存轨道包统计及所选轨道引用；仅选 SI/TI 或重复帧时不保存这些包字段。关闭 `bitrate` 时各轨道 `bins` 为空且不保存 `bitrateCurve`；开启时遵循原窗口协议。未选项目不以空图或失败结果代替。无 `analysisTargets` 的旧报告继续要求原完整分析字段。计划使用 `frameAnalysis`、`bitrate`、`complexity`、`repeatAnalysis` 与 `freezeDetection` 开关；前两项缺省时按原完整分析兼容，后两项缺省为关闭；持续静止必须同时选择重复帧。

`repeatAnalysis` 使用方法 `configurationVersion: 1`，保存实际原生格式、源文件身份摘要、逐帧样本 SHA-256、源帧与哈希输出的独立时间字段、精确比较计数与段、时间间隔与候选网格，以及可选持续静止事件。导入重新计算并核对派生量，不接受部分指纹冒充完整结果。方法未支持时保存原因；未选择则无此字段。旧报告不补造该项。详见[重复帧测量规则](repeat-analysis.md)。

`timing` 为所含结果的计算耗时汇总，读取时核对一致性。各指标自己的配置版本、实施解释、模型和工具版本继续保留，不等于重复的文件版本。原始日志字符串逐字保留；原始 JSON 对象的属性顺序和排版不承诺与工具输出文本相同。

## 明细表

只对明确列出的路径采用表格编码，不递归重写原始证据：

| 路径 | 编号规则/上限 |
| --- | --- |
| `report.frames` | 每行一个原显示帧；最多 2,000,000 行 |
| `report.repeatAnalysis.frames` | 第 i 行的 `frame` 固定为 i；最多 2,000,000 行 |
| `report.repeatAnalysis.exact.runs` | 连续相邻精确重复段；最多 2,000,000 行 |
| `report.repeatAnalysis.timeline.intervals` | 整数 tick 间隔及次数；最多 2,000,000 行 |
| `report.content.points` | 第 i 行的 `frame` 固定为 i，省略重复编号 |
| `report.content.scenes` | 第 i 行的 `index` 固定为 i；最多 2048 行 |
| `report.coding.packets` | 第 i 行的 `index` 固定为 i；最多 500,000 行 |
| `report.coding.events` | 第 i 行的 `id` 固定为 i；最多 750,000 行 |
| `report.coding.gops` | 第 i 行的 `index` 固定为 i |
| `report.tracks[].bins` | 原秒级码率记录；最多 1,000,001 行 |
| `report.tracks[].bitrateCurve.bins` | 原精确区间码率记录；最多 1,000,000 行 |

这些是原有分析/校验预算，不额外提高计算上限。音频逐包记录原本已经是固定四列数组，继续保存原结构，最多 500,000 行。比较指标的数值数组、原始日志和试编码各参数组合保留现有内容。

每张表含 `count`、`columns`、`rows`，可选 `constants` 和 `sparse`：

- `count` 等于 `rows.length`，每行长度等于 `columns.length`，列名唯一。
- 每行都存在且值完全相同的字段放在 `constants` 中，只存一次；不是从第一帧或轨道声明推断全片恒定。
- 每行存在且变化的字段列入 `columns`，对应值按列顺序存入 `rows`。
- 只在部分行存在的字段放在 `sparse` 中：字段名对应按行号严格递增的 `[rowIndex, value]` 数组。没有该行表示字段缺失，值为 `null` 表示明确空值。
- 三组字段互不重叠；不能与该路径的隐含编号冲突；拒绝重复、负数或越界索引，以及原型污染键。缺列、缺行、非法数量和截断 JSON 明确失败。

解码后还核对必需字段及语义：显示帧的 PTS、时间、时长、体积、帧型和布尔标记不能整列缺失；汇总帧数与明细一致；视频包保留原有基础头记录，AV1 事件保留原始 `fields`；帧、包与事件之间的引用不能越界。校验不能证明文件从未被人为改写，但不会把已识别的缺失或矛盾内容当作完整结果。

表格不抽样、不舍入、不丢弃记录，不转换为 Float32。大整数 PTS、区间分子、精确字节计数等原有十进制字符串继续原样保存。扫描和 SI/TI 的时间戳分别保存，不根据平均帧率重建或因容差内相近而合并。

## 去重与来源

完整分析的所选视频轨道由 `report.stream` 唯一定位到 `report.tracks`。文件不再保存重复 `report.packets`；解码时引用对应轨道还原原界面模型。编码前两者若不一致则拒绝写出，不静默舍弃其中一份。

场景声明、码率曲线、音频包分布在旧内存模型中的结构版本固定由本协议定义，文件中省略这些 `version: 1`，解码时恢复。SI/TI `configurationVersion`、模型和原始证据中的版本不移除。完整像素格式目录和各轨道记录保留，不把不同音轨当作重复对象。

## 文件名

仅四个模板，变量只有源文件基名和 UTC 导出时间：

| 功能/内容 | 模板 |
| --- | --- |
| 文件分析，读取信息或完整分析 | `MediaScope-analyze-<file>-<UTC>.json` |
| 质量比较 | `MediaScope-compare-<UTC>.json` |
| 片段实验 | `MediaScope-trial-<file>-<UTC>.json` |
| 实际导出两项及以上 | `MediaScope-queue-<UTC>.json` |

单项计划和结果使用同一所属功能模板；一次试编码的多个 CRF 不算多项。时间使用 `YYYYMMDDTHHmmssZ`，不增加版本、数量、计划标签、随机码或软件自定义避重编号。源名只取最后一个路径分量，保留原语言和扩展名，清理 Windows 非法字符和尾部点/空格，并限制长度；无可用源名时使用 `media`。浏览器可能自行处理同名下载，这不是本软件模板的一部分。导入不依赖文件名。

## 保存、限制和旧文件

文件紧凑序列化；用户主动导出时通过下载保存，不自动写入运行目录。导入/导出上限为 256,000,000 字节。没有引入 JSONL、压缩包或新的自动格式切换。

解码后完整对象仍驻留内存，因此磁盘体积减少不代表内存按相同比例减少。整份 JSON 字符串、解析及绘图仍有资源边界；不承诺所有设备均能处理最大帧数、分辨率或最大文件组合。

不读取旧报告文件协议，也不自动改写、迁移或删除旧报告。启动不自动读取任何历史报告；旧版与当前格式的已有报告及旧会话目录均保留原状。用户原媒体、外部导出文件和旧版明确保留的实验视频不因格式升级而清理。

## BD-rate 可选测量与比较

trial 的 rows 可增加 bdRateMeasurement（version: 1）。status 为 ok 时，保存固定 profile、比较域、帧数、位深峰值、零 MSE 规则、Y/U/V 样本数/逐帧整数 SSE/PSNR 均值、参考与候选像素 SHA-256，以及基本码流格式/字节/摘要/CFR 帧率/时长/码率和时间核查。status 为 unavailable 时保存 version 和非空 reason。旧报告缺少该字段仍可导入，不能据此生成参考模式结果。

专用 BD-rate 导出在完整 trial 报告增加 bdRateComparisons，最多64项；每项保存 anchor、test、metric、profile（reference 或 exploratory）和 result。导入核对测量与源格式/时间轴，重新求均值与码率、重新积分，并比较保存结果及依据配置；改动结果或不一致配置明确拒绝。缺少这两个可选字段的0.4文件含义不变；这是带独立测量版本的可选证据扩展，外层继续0.4。原 pooled PSNR 与新 PSNR-Y 分开保留，不迁移或重解释旧值。协议校验只证明记录内部一致，不证明外来报告的真实来源。详细公式、参考版本和边界见 [BD-rate 测量规则](bd-rate.md)。
