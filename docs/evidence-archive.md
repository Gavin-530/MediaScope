# MediaScope 测试归档

本文件是归档规则的唯一说明，集中保存在 docs 中。evidence-archive 只存归档资料、索引和工具，不另生成一份规则 README。每份封存记录内的 README 是该次检查的历史说明，属于证据，不是本文件的副本。

所有正式封存记录集中在 records，一份记录一个文件夹；不再按本地、GitHub 或维护类型划分多层目录。来源、类型、版本、结果和执行范围由 record.json、原始清单及查询表表达，不合并不同执行的通过数。

| 目录 | 内容 |
| --- | --- |
| records | 全部正式封存记录：测试、GitHub 下载证据、维护审查和素材快照；一份记录一个文件夹 |
| pending | 正在运行、待导入、失败或中断的证据；不自动清理 |
| inbox | 直接放入对方的整个归档文件夹，等待程序处理；不计作正式记录 |
| received | 导入完成后保留的整包原件及回执，由程序自动生成接收编号；不计作正式记录 |
| tools | 本机导入程序；import-local-test-evidence.ps1 随 Git 维护，收到的 tools 不执行、不覆盖 |
| catalog.json | 正式记录索引，保存当前位置和校验摘要；不把 inbox、received、pending 当作通过结果 |

```text
evidence-archive/
  records/          # 正式档案，直接存每份记录
  inbox/            # 新收到的整包，等待导入
  received/         # 导入完成后的整包原件与回执
  pending/          # 正在运行或未完成的资料、事务和锁
  tools/            # 导入程序
  catalog.json      # 索引
```

每份新归档有 README.md、record.json、original/、SHA256SUMS.txt。GitHub 导入还保存原始 bundle.zip；通过 Actions 外层 ZIP 下载时也保存 artifact.zip。
catalog.json 登记所有封存记录，并校验历史原 catalog 快照的 SHA-256；索引缺失、文件变化及未登记记录都会报错。
pending 的存在不表示测试通过；运行结果与归档状态分别记录。
origin=local 表示原始检查在本地执行，origin=github-actions 表示原始检查在 GitHub 的自动测试机器上执行；它们是清单字段，不是文件夹名称。协作者贡献者另记在导入回执中，不改变原始执行来源。维护审查或素材快照不计作产品回归。导入、导出、迁移及整理入口省略 Project 时，在脚本初始化后计算其所在项目根目录，与当前工作目录无关。

在项目根目录执行 npm run evidence:list 查看时间、来源、版本、类型、结果和路径；可加 -- -Origin local/github-actions、-Version 或 -Outcome 筛选。npm run evidence:verify 校验完整性，npm run evidence:sync 下载 GitHub 证据，不上传本机档案。

## 接收整包或单份测试记录

收到对方整个 evidence-archive 后，直接放到本机 inbox 中，无需手动创建批次或 records。例如导入前：

```text
evidence-archive/
  inbox/
    evidence-archive/           # 直接放入对方整包，保留 catalog.json
      catalog.json
      records/                  # 对方的正式记录
      inbox/                    # 跳过
      received/                 # 跳过
      tools/                    # 跳过，不执行
  tools/
    import-local-test-evidence.ps1
```

ZIP 先自行解压；单份完整封存记录也可以直接放入 inbox。多个整包同名时先改外层文件夹名，例如 alice-evidence-archive、bob-evidence-archive，不修改内部编号或索引，不覆盖已有待处理资料。在项目根目录运行：

```powershell
npm run evidence:import
npm run evidence:import -- -Contributor "Alice" -Apply
npm run evidence:verify
```

第一条自动扫描 inbox 并预览，第二条正式导入。不同贡献者的整包可用 `-Folder "外层文件夹名"` 分别处理。多个整包逐包提交，遇到错误停止后续处理，先前成功的整包保留其结果；冲突或损坏的当前整包不部分导入。

单份记录须保留 README.md、record.json、SHA256SUMS.txt、original/ 和原压缩附件；整包须保留 catalog.json。旧版已封存的 tests/local、tests/github-actions、maintenance、fixtures 布局也能接收，入库时统一进入 records；不能直接导入尚未封装的旧资料。

程序识别嵌套包装，但跳过对方的 inbox、received、pending、tools、receipts 和旧版 evidence-inbox；仅校验、去重并登记已封存记录，不执行对方代码。包装最多 24 层，超限停止；到达单份记录后不再拆它的 original。同编号同内容跳过，同编号不同内容停止。导入后 records 不增加 evidence-archive 或 inbox 层；整包原件移到 `received/<自动编号>/records/<收到的文件夹名>/`，回执放在同一编号下的 receipts。即使整包全部是重复记录，也保留本次原件和去重回执并移出 inbox，不重复创建正式记录或维护审计。

旧式 `-Batch` 手动批次入口保留兼容，其原件和回执仍沿用原有位置；日常整包接收使用上面的直接放入流程。程序不会后台监听文件夹，也不自动下载外来档案；放入后需执行导入命令。也可接收同一电脑其他工作树的测试归档。贡献者由接收者填写，不能当作经过认证的身份。

导入使用现有记录锁：先校验并暂存当前包全部新记录，再原子替换本机索引；不拿对方的索引覆盖本机索引。来源提交、源索引摘要、跳过目录和逐条摘要保存在回执，新增记录时另封存 local-evidence-import 审计。提交前报错会回退当前包的新目录，保留旧索引和 inbox 原件。索引已提交而原件移动受文件占用阻碍时，原件和回执仍保留，再次导入会去重并完成移动。断电或强行终止可能留下 pending 事务；保留 inbox、received、pending 及报错中的 plan.json、catalog-before.json，不手工覆盖或删除。

## 整理旧目录

现有旧目录用同一个整理程序先预览，再应用：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/organize-test-evidence.ps1
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/organize-test-evidence.ps1 -Apply
npm run evidence:verify
```

整理按校验结果移动整份记录到 records，保留已经封存的所有文件字节，包括原 record.json 中的旧路径。catalog.json 记录当前位置，整理审计保存旧路径到新路径的映射及原索引。旧目录仅在确认空目录后移除，不删除未知文件、未完成资料或失败记录；重复运行没有需要整理的记录时不新增审计。同名冲突或校验失败会停止。

如果还有项目根目录的旧 local-test-archive，先运行 npm run evidence:migrate 预览，再加 -- -Apply；原始资料校验后迁移并整理，不补造缺失证据。

## 时间与记录规则

编号时间保留来源实际提供的表示精度：毫秒、秒、日期或未知。末尾编号用于防重名；编号生成时间、实际运行开始、原清单创建和本次归档时间分别保存。表示精度不代表系统时钟的准确度，也不代表经过校时。不补造缺失证据，失败记录不被成功重跑覆盖。

records 下的维护记录文件夹采用 时间部分_事项_8位编号；产品和素材采用 时间部分-8位编号。时间部分按来源精度选择：

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
旧记录统一进入 records；原文件保存在 original，旧路径映射和原清单快照保存在 archive-organization 维护记录。已封存记录仅改外层位置，原 record.json.path 作为历史身份不改写，当前位置以 catalog 和路径映射为准。
同步只下载远端证据，不会上传本机档案。离线时延后，远端过期的文件无法自动找回。
归档数据、inbox、received 和 catalog.json 由 Git 忽略；tools/import-local-test-evidence.ps1 与本文件随 Git 维护。另需备份整个归档目录（包括 inbox、received 和 pending）；正式发布 ZIP 和用户报告仍分别保存在 releases 与 .mediascope。永久保留是清理策略，不等于备份，校验无法恢复损坏或误删。整个项目的目录保留和清理规则见[本地数据规范](local-data.md)。

SHA256SUMS.txt 与 catalog.json 检测文件变化、缺失和未登记记录。正常校验列出 pending；使用 scripts/verify-test-evidence.ps1 -RequireComplete 可拒绝未完成项。封存记录内的 README 和接收原件中的历史说明保留原样，不随当前规则更新。
