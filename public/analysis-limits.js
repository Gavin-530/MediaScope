// Product resource boundaries, not SI/TI or codec standard requirements.
export const MAX_ANALYSIS_FRAMES = 2_000_000;
export const MAX_SITI_PIXELS = 8192 * 4320;

export function validateSitiDimensions(width, height) {
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 3 || height < 3 || width * height > MAX_SITI_PIXELS)
    throw Error(`SI/TI 帧尺寸须至少为 3×3，总像素不得超过 ${MAX_SITI_PIXELS.toLocaleString('en-US')}（8192×4320）`);
}
