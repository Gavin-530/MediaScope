// Exact matches only: new or unrecognized messages remain visible as warnings.
// These strings are also used by the producers, without changing saved reports.
export const unconfirmedSceneNote = '场景边界未确认，全片结果可能含剪辑点 TI；分场景比较须确认边界。';

export const analysisNotes = {
  bitrate: '码率曲线按绝对 PTS 的所选窗口统计包负载，首尾除以实际区间时长；缺失 PTS 或持续时间时明确不可计算。100 ms 可聚合显示为 1 秒。全程平均值沿用原有独立口径。',
  gop: 'GOP 视图按显示顺序的随机访问/关键帧边界分组；不将 CRA 自动标为闭合 GOP，也不声称已验证所有跨组引用。',
  frameSize: '帧大小取解码器报告的 pkt_size；AV1 多编码帧可能共用一个包，不重复相加估计编码帧体积。',
  metadata: '附加数据来自轨道报告，本次未执行帧级附加数据读取；码流头解析范围见 coding，不等同于完整解释所有私有 SEI。',
  siti: [
    '采用固定 siti-tools 0.6.0（c537e337）PQ 计算流程，所有输入位深均乘以 255；与原版比较须使用相同输入解释、显示参数和场景。',
    'SDR／逆 sRGB 按上游归一化 EOTF 后仿射映射至 300 / 0.1 cd/m²。HLG 保留固定上游公式及其分段跳变，使用记录的峰值／黑位；PQ 输入保持 PQ。此为指定版本兼容，不构成严格 P.910 符合性证明。',
    '原版共同位深为 8/10/12-bit；9/14/16-bit 端点扩展、原生布局、灰度和 RGB 亮度提取属于本软件适配，不能称为原版文件读取支持。',
    'SI：Sobel 梯度幅值的总体标准差，剔除一像素边界；TI：相邻帧差的总体标准差。场景首帧 TI 为 null，不纳入统计；逐帧值保留未舍入结果。',
    'CPU 串行、并行和 GPU 共用输入解释及固定上游计算模型。GPU 指标采用 FP32，HLG RGB 关键前处理保留 FP64；CPU 并行共用一次软件解码并传递相邻原始帧。验证保留未修改上游函数及发布文件结果；这不等于 ITU 官方认证。比较须保持相同显示假设、分辨率、帧率、场景及前处理条件。',
  ],
};

export function analysisNoticeGroups(report) {
  const groups = {frames: [], bitrate: [], metadata: [], siti: [], warnings: [], sitiWarnings: []};
  const destinations = new Map([
    [analysisNotes.gop, 'frames'], [analysisNotes.frameSize, 'frames'],
    [analysisNotes.bitrate, 'bitrate'], [analysisNotes.metadata, 'metadata'],
  ]);
  for (const text of report.warnings || []) groups[destinations.get(text) || 'warnings'].push(text);
  for (const text of report.content?.notes || []) {
    const method = analysisNotes.siti.includes(text) ||
      text === '按用户确认的场景分别统计，不计算跨场景 TI。';
    groups[method ? 'siti' : 'sitiWarnings'].push(text);
  }
  return groups;
}
