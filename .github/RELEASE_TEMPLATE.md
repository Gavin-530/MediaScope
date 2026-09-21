# Release 正文模板

<!-- GitHub 页面已显示 Release 标题，正文不要再添加一级标题。 -->
<!-- 删除不适用的可选章节，不要填写“暂无”或推测性内容。 -->

一句话说明本版本的主要变化，使用可由代码、测试或文档直接支持的事实表述。

## 本次更新

- 保留用户可感知的变化、兼容性变化和重要实现变化。
- 不把提交记录原样堆叠成发布说明。

<!-- 只有存在影响用户升级决策的内容时才保留本节。 -->
## 兼容性与已知限制

- 写明运行环境、迁移要求、破坏性变化或仍未解决的重要限制。

## 下载与校验

说明包类型、是否包含运行时，以及运行环境要求。

- 文件：`MediaScope-<version>.zip`
- SHA-256：

```text
<SHA-256>  MediaScope-<version>.zip
```

完整变更：[`<previous-tag>...<current-tag>`](https://github.com/Gavin-530/MediaScope/compare/<previous-tag>...<current-tag>)
