# MediaScope 贡献与提交规范

提交说明用于让审阅者和后续维护者理解改动。采用 [Conventional Commits 1.0.0](https://www.conventionalcommits.org/en/v1.0.0/) 的结构，结合 [Git](https://git-scm.com/docs/SubmittingPatches)、[Node.js](https://github.com/nodejs/node/blob/main/doc/contributing/pull-requests.md) 和 [Angular](https://github.com/angular/angular/blob/main/contributing-docs/commit-message-guidelines.md) 的贡献指南制定以下项目规则。这些是 MediaScope 的约定，不代表所有开源项目都采用同一套规则。

## 提交标题

```text
type(scope): describe the concrete change
```

- 类型使用下表的小写名称；范围可省略。范围使用小写字母、数字，以及分隔用的 `-`、`/`、`.`，例如 `report`、`installer`、`test/server`。
- 标题最多 72 个 Unicode 字符，不带末尾句号。中文、英文都可使用，项目已有英文标题，可优先沿用；英文使用动词原形，专有名词和代码标识保留正确大小写。
- 描述可由差异核对的具体变化。避免只写“优化”“完善”“update”；只有描述明确的行为时才使用“严格”等词，例如 `fix(compare): reject non-monotonic timestamps`。
- 一个提交围绕一个逻辑目的。对应代码、回归测试和必要文档可以一起提交；互不依赖的功能、CI、归档和发布准备分别提交。

| 类型 | 用途 |
| --- | --- |
| `feat` | 增加用户或调用方可用的功能 |
| `fix` | 修正错误行为，包括可读性、布局或文案缺陷 |
| `perf` | 改善性能，并说明测量范围或计算等价性 |
| `refactor` | 调整实现结构，不新增功能或修复错误 |
| `test` | 新增或修正测试用例、夹具与测试框架 |
| `docs` | 文档或代码注释的变化 |
| `style` | 仅代码排版、空白等不改变含义的变化；界面外观变化按目的使用 `feat` 或 `fix` |
| `ci` | GitHub Actions 等持续集成配置与执行流程 |
| `build` | 构建、打包系统或依赖的变化 |
| `chore` | 其他维护事项；版本准备使用 `chore(release)` |
| `revert` | 撤销已有提交，在正文引用被撤销的提交并解释原因 |

## 提交时机与作者身份

- 交付到主分支的提交按可独立理解和验证的逻辑改动组织，对应代码、回归测试和必要文档一起交付。复杂功能可拆为多条有明确用途的提交，不以减少数量为目的混合独立改动。
- 开发中的检查点可以保留在功能分支；审阅期间可以追加修正提交，便于核查反馈。合并时再整理同一改动的临时尝试和连续修正，或采用下文的 squash 方式；提交次数和 CI 运行次数不作为功能完成数或质量指标。
- 提交前核对作者名称和邮箱，使用本人稳定署名及能关联 GitHub 账号的邮箱，可使用 GitHub 官方 noreply 邮箱。不要使用通用开发者名称和占位邮箱代替贡献者身份；整理他人提交时保留原作者信息，身份有疑问时向贡献者核实，不代填推测信息。邮箱关联方法见 [GitHub 指南](https://docs.github.com/en/account-and-profile/how-tos/email-preferences/setting-your-commit-email-address)。
- 不要求每次本地检查点都执行完整回归；实际验证范围与结果仍按[测试规范](testing.md)保存，最终整合源码须满足原有验收条件。

## 正文、兼容性与验证

简单、可从标题和差异直接理解的改动可省略正文。复杂改动须在标题后的空行之后说明：原问题及触发条件、改动后的行为、重要的实现选择，以及兼容性或迁移影响。正文建议按约 72 列换行，URL 和代码标识可保持完整。

```text
fix(report): improve contrast in light theme

Replace fixed report colors with theme variables so notices and frame
details remain readable in light mode.
```

- 增加测试和测试通过是两件事。需要陈述验证时，写明实际命令、结果、执行范围和未执行项；较长记录放在 PR 或对应证据中。`verified`、`fully tested` 等概括不能替代记录。
- 只有与本次源码/附件对应的记录才能支持通过结论。按[测试规范](testing.md)记录真实结果，不补写未执行的检查，不累计历史通过数。原生弹窗、联网安装和应用回归分别说明。
- 涉及不兼容变化时在类型后加 `!`，并在正文末尾写 `BREAKING CHANGE: <影响和迁移办法>`。即使使用 `!`，本项目仍要求这一说明；也可只用该 footer 标记不兼容变化。
- 仅在确有相关记录时填写 `Fixes: #<issue>`、`Refs: <PR URL 或提交 SHA>`、`Co-authored-by:` 等信息。不得虚构贡献者、审批或验证记录。
- `chore(release)` 标题如包含版本号，必须与该提交的 `package.json` 一致；存在 `package-lock.json` 时，其顶层版本及根包版本也须一致。旧版本、撤回原因和纠正关系写在正文，标题只写当前目标版本。

## PR 与合并

使用 [PR 模板](../.github/PULL_REQUEST_TEMPLATE.md) 说明问题、结果、验证与兼容性。PR 标题使用同一标题格式；改变 PR 标题会重新触发检查。

审阅时检查标题与实际差异是否一致、提交是否按逻辑组织、验证陈述是否有记录、版本是否符合[发布规范](releasing.md)。格式检查不能判断这些语义事实。

按改动选择合并方式：一个逻辑改动包含多次修正时，优先考虑 squash；多条提交各自完整且有独立用途时，可以保留。使用 squash 时，维护者须审查最终提交标题与正文，并保留相关 PR 和贡献者信息；包含多个独立改动的 PR 不应仅为减少数量而整体压成一个提交。此做法参考 [Node.js 的提交整理指南](https://github.com/nodejs/node/blob/main/doc/contributing/pull-requests.md#commit-squashing)。

推荐每次改动使用独立功能分支。长期复用的分支不一律 squash：先评估后续 PR 的历史关系，避免再次包含已压缩合并的提交；具体取舍见 [GitHub 合并指南](https://docs.github.com/en/pull-requests/reference/pull-request-merges)。历史整理以尚未合并的功能分支为范围；已共享分支的历史整理须与参与者协调，不为统一格式或减少数量重写主分支、已发布标签及历史证据。

普通提交不能以 `Merge ...` 标题绕过检查；真正有多个父提交的自动 `Merge ...` 提交允许使用 Git 的合并格式。`git revert` 自动生成的 `Revert "..."` 及 `This reverts commit <完整 SHA>.` 也允许保留。

## 检查与历史边界

在项目根目录执行，无需安装额外 npm 依赖：

```powershell
npm run check:commits
npm run check:commits -- --range HEAD~1..HEAD
node scripts/check-commits.mjs --file <UTF-8 提交说明文件>
npm run test:commits
```

默认检查基线之后的提交；指定范围可检查某次提交或一组提交。`--file` 在提交前检查说明格式，不验证尚未创建的提交快照版本。测试命令验证检查工具本身，不属于媒体分析或发布验收的通过数。

基线固定为 `fc648355fcc12e1a07003fd75746cedf8a73bdba`，它及其全部祖先（现有 36 条提交）作为旧历史保留。只豁免这些已有提交的确切 SHA，不豁免从旧分支新增的提交。旧标题可在审计中说明；修正历史版本决策使用新的纠正提交，不为排版重写已发布提交、标签或测试档案。

GitHub 工作流检查推送/PR/合并队列中的新增提交，PR 另检查标题；手动执行默认检查全部基线后提交。工作流只读取事件 JSON，不把标题插入 shell 命令。格式、长度、空行、不兼容说明和发布版本一致性由工具检查；动机、分类和证据真实性由审阅者检查。

工作流推送后才会在 GitHub 运行。仓库管理员还需在分支规则中将 `Commit messages` 配置为必需检查，才会阻止不合格的合并；增加工作流文件本身不会修改仓库规则，也不会发布产品。开发者可以在本地提交前运行 `--file` 检查，不改变全局 Git 设置。

退出码 `0` 表示所选说明检查通过（可能没有新提交）；`1` 表示说明不合格；`2` 表示参数、事件或 Git 对象缺失等检查阻塞。浅克隆需先取回完整历史；对象缺失不当作通过。
