# 发布规范

## 版本与附件

| 对象 | 命名 |
| --- | --- |
| 软件版本 | 与 `package.json` 一致；预发布为 `-alpha`、`-beta`、`-rc`，可附 `.数字` |
| Git Tag | `v<版本>`，指向实际测试及打包提交 |
| Release 标题 | `MediaScope <版本>` |
| Windows ZIP | `MediaScope-<版本>-win-x64.zip`，包内版本与附件名不加 `v` |

修复递增补丁号，兼容功能新增递增次版本号。不兼容变化在 `0.x` 阶段递增次版本号，`1.0.0` 起递增主版本号。预发布在 GitHub 标记为预发布。版本按实际发布范围确定，不仅凭提交类型自动改号。同版本不覆盖本地包或替换已发布附件；新字节须用新版本。

## 发布步骤

1. 按[贡献规范](contributing.md)提交对应代码、测试和文档，运行 `npm run check:commits`，核对版本、提交及 Tag。版本号相同不能证明源码相同。
2. 在干净工作区运行 `npm run test:release`，达到[完整回归门槛](testing.md)。任何失败、不完整覆盖或归档阻塞均不得发布。
3. 执行 `scripts/package.ps1 -Version <版本>`，生成一个 Windows x64 联网部署 ZIP。已有包及暂存目录不覆盖。
4. 对确切附件执行下列离线及真实首次联网部署检查，核对 ZIP 摘要、字节数和结构化断言；另在锁定私有环境下验证应用。离线运输夹具不能证明联网下载通过。

   ```powershell
   powershell -NoProfile -ExecutionPolicy Bypass -File scripts/record-test.ps1 -Kind Package -Archive <zip> -RequireClean
   powershell -NoProfile -ExecutionPolicy Bypass -File scripts/record-test.ps1 -Kind OnlineDeployment -Archive <zip> -RequireClean
   ```

5. 完成人工验收和兼容性核对，保存实际结果和未验证范围。
6. 使用[Release 模板](../.github/RELEASE_TEMPLATE.md)创建草稿并审查正文；核对最新目标分支、冲突、必需检查与审批，以及确切发布 SHA 的云端回归。PR 合并提交通过不能替代另一个 Tag 提交的验证。
7. 上传附件、再次核对摘要，再发布 Release。说明如实注明推荐环境首次安装需要联网。发布后显式同步平台资料，云端限期产物及时下载并校验；方法见[数据与归档](data-and-archives.md)。

自动部署检查覆盖环境复用/变化检测、切回推荐环境、升级/回退、下载损坏、兼容失败、用户数据、自定义安装位置、共享组件及卸载边界。人工至少检查首次位置选择/取消、可用环境的双选项弹窗、无合格环境的下载提示、环境失效后的确认/拒绝，以及 Windows 卸载并保留报告。每版核对旧报告/配置、升级方式、环境要求和实际已知问题；未执行项不得写为通过。

## 发布正文

- 模板只固定“本次更新”和“校验”二级标题。先写相对上一发布版的主要产品变化，必要时分类；测试、归档和流程调整放后面，较长验证细节可折叠。外部贡献注明真实贡献者和 PR。
- 固定安装、启动和环境说明引用[README](../README.md)，只有本版改变相关要求时另写。兼容或已知问题只写实际影响和必要操作；无内容的可选栏目省略，不填“无”。
- 验证遵循[测试规范](testing.md)，不粘贴完整日志，不把历史数累计成当前结果。校验逐行填写确切附件名及整个 ZIP 的 SHA-256；比较链接使用核对过的 Tag。
- 发布前移除提示、占位符和空小节。已发布正文只修排版、失效链接和明显笔误；历史补录明确标注，不改变当时行为或补造验收结论。

本地档案、归档工具和文档整理不会自动发布软件，正式包继续单独保存在 `releases/`。
