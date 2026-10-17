# 独立输入与数学参考

`layout-oracle.json.gz`来自2026-10-17的独立输入实验，包含150种实际整数像素布局、全/有限范围、9×7/8×6/3×3尺寸和每例三帧，共900例。逐样本期望与指标期望均未调用生产代码。

- 142种布局按未经修改的libavutil描述符API的plane/step/offset/shift/depth和实际平面尺寸写入；8种较新MSB布局由当前FFmpeg作同位深转换并逐字节验证逆转换。
- 非线性RGB按已声明BT.709权重导出浮点亮度，测试域为PQ；Sobel以独立二维卷积计算，使用独立总体标准差及相邻帧差，倍率255。
- `provenance`记录描述符DLL、FFmpeg及独立输入摘要；压缩文件摘要固定在`test/helpers/siti-layouts.mjs`。`normalized`用于逐样本读取检查；`expected`是独立公式的冻结结果，不能用产品测量替换。
- 其他传递函数、指定上游完整流程和发布文件仍由`vqeg-060.json`、`vqeg-reference.py`及`published/`独立约束。这份文件不是150种封装文件的声明。

精确生成方法由独立实验中的`inventory.mjs`、`oracle.py`、`msb-oracle.py`和`verify.mjs`组成；需要原libavutil描述符环境和FFmpeg才能重新生成。普通回归直接重放冻结输入，无需安装Python。重要修订应新增参考版本并独立复核，禁止为使生产代码通过而刷新摘要或期望。
