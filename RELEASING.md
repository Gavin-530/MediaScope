# MediaScope 发布规范

本文件约束 MediaScope 的版本发布过程。目标是让每个 Release 可核验、可追溯且格式稳定。

## 发布说明原则

- Git Tag、`package.json` 版本、Release 标题和附件文件名必须一致。
- Release 正文使用 `.github/RELEASE_TEMPLATE.md`，主要章节统一使用二级标题。
- 保留版本实际变化，不为了排版统一而合并、扩写或重新解释技术事实。
- 自动化测试只报告可追溯的通过数；不粘贴完整终端日志。
- 没有可靠历史记录时省略相应章节，不补造验证或兼容性结论。
- SHA-256 固定放在“下载与校验”章节，并与确切附件文件名写在同一校验记录中。

## 预发布检查

1. 确认工作区只包含计划发布的变化。
2. 确认 `package.json` 版本与目标 Tag 一致。
3. 运行 `npm test`，保存通过数及失败数；任何失败都不得发布。
4. 运行 `scripts/package-prerelease.ps1 -Version <version>` 生成轻量预发布包；正式版仅在明确指定时使用 `scripts/package.ps1 -Version <version> -Formal`。
5. 运行 `scripts/verify-release.ps1 -Archive <zip>`，核对归档文件数及 SHA-256。
6. 从 `.github/RELEASE_TEMPLATE.md` 创建 Release 草稿，逐项核对正文中的版本、文件名、测试数和 SHA-256。
7. 检查正文只包含本版本能够直接支持的事实。
8. 先上传全部附件并再次核对摘要，再发布 Release。

## 已发布版本的维护

- 可以修正文案排版、失效链接和明显笔误，但不得悄然改变版本实际行为的描述。
- 不替换同一版本的附件；需要改变发布内容时递增版本号。
- 历史补录版本明确标注“历史版本补录”，不为其追加当时没有留存的验证结果。
