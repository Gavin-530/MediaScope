# MediaScope 检查证据归档

所有检查证据使用一个入口。编号时间保留来源实际提供的表示精度：毫秒、秒、日期或未知。末尾编号用于防重名；编号生成时间、实际运行开始、原清单创建和本次归档时间分别保存。表示精度不代表系统时钟的准确度，也不代表经过校时。

| 目录 | 内容 |
| --- | --- |
| tests/local | 本机产品测试、包验证、联网部署和自定义检查 |
| tests/github-actions | 下载并校验的 GitHub 原始证据，以及 runner 本次运行的记录 |
| maintenance | 审查、迁移、恢复、维护与历史材料集合，不计作产品回归 |
| fixtures | 测试素材快照 |
| pending | 正在运行、待导入、失败或中断的证据；不自动清理 |
| legacy | 尚未整理的旧格式资料暂存位置；旧资料按内容整理后不再留在此处 |

每份新归档有 README.md、record.json、original/、SHA256SUMS.txt。GitHub 导入还保存原始 bundle.zip；通过 Actions 外层 ZIP 下载时也保存 artifact.zip。
catalog.json 登记所有封存记录，并校验历史原 catalog 快照的 SHA-256；索引缺失、文件变化及未登记记录都会报错。
pending 的存在不表示测试通过；运行结果与归档状态分别记录。

在项目根目录执行 npm run evidence:list、npm run evidence:verify、npm run evidence:sync。
维护目录采用 时间部分_事项_8位编号；产品和素材采用 时间部分-8位编号。时间部分按来源精度选择：

| 来源 | 时间部分示例 | 时区 |
| --- | --- | --- |
| 毫秒 | 2026-10-01T10-20-30.220Z | UTC |
| 秒 | 2026-10-01T10-20-30Z | UTC |
| 仅日期 | 2026-10-01 | 未指定，不补成 UTC 零点 |
| 未知 | undated | 未指定 |

例如秒级维护记录为 2026-10-01T10-20-30Z_test-system-audit_1234abcd。只使用 ASCII 字母、数字、连字符、下划线和点，时间不用 Windows 禁止的冒号；资料整理检查完整路径长度。原编号支持 yyyyMMddTHHmmssfffZ、yyyyMMddTHHmmssZ、yyyyMMdd 或 undated，后接连字符和 8 位编号；无效日期、时间与无法识别的格式报错，不能静默当作未知。
新创建的本地运行和 Actions 导出器仍使用系统提供的毫秒格式；历史导入可以使用其他已明确的精度。内部活跃沙箱采用当前生成器的固定格式，与历史归档读取规则分开。未知时间必须在来源编号中明确标为 undated，不以读取异常触发“猜一个时间”。
新封装 schema 3 的 record.json 明确保存 identifierTime、identifierTimePrecision、identifierTimeZone 和 identifierTimeSource；校验器核对原编号、目录名、时间元数据和原清单值。秒级时间不能补 .000；仅日期不能补时分秒或时区；未知不能用当前时间或文件修改时间替代。归档时间可记录当前时刻，但不能冒充原运行时间。北京时间显示保留原时间字符串的小数位数；仅日期不做时区转换，缺少时区或非法值显示未知并保留原值。
既有封装 schema 1/2 和原始证据 schema 保持原样并继续校验，不批量改写历史记录补字段。查询中的 not-recorded 表示旧封装没有单独记录精度元数据，不能据此断言原始资料没有时间。
来源本来就包含 .000 时可原样保留；禁止的是把仅到秒的来源擅自补成 .000。当前生成器读取系统时钟，不以文件修改时间兜底；读取或格式校验失败应报告阻塞并保留待处理证据。
归档 JSON 中的时间按字符串读取，防止 PowerShell 自动转换日期类型后改变小数位。支持 Windows PowerShell 5.1 及提供 DateKind String 的 PowerShell；其他解析器若会改变时间字符串，明确报错，不能隐式补位。
缺少统一清单的混合历史材料使用 undated_release-materials_摘要前8位，明确标记时间与整体结果未知。不会从文件修改时间补造测试时间，也不把旧说明中的多次检查合并成一次通过结果。
旧记录按类型进入正式目录；原文件保存在 original，旧路径映射和原清单快照保存在 archive-organization 维护记录。已封存的旧维护记录仅改外层目录名，原 record.json.path 作为历史身份不改写，当前位置以 catalog 和路径映射为准。
同步只下载远端证据，不会上传本机档案。离线时延后，远端过期的文件无法自动找回。
资料由 Git 忽略并永久保留；另需备份本目录。正式发布 ZIP 和用户报告仍分别保存在 releases 与 .mediascope。
