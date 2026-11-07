// Numerical acceptance for identical, fixed RD inputs, in percentage points.
// FAU-LMS reports PCHIP/Excel agreement to at least 10 decimal positions;
// functions.py returns a percentage (multiplies the fraction by 100).
// We operationalize that published accuracy claim as an absolute 1e-10 gate.
// This is a project criterion with an external basis, not an official tolerance
// or a bound on interpolation/sampling error for arbitrary RD curves.
export const bdNumericAcceptance = Object.freeze({
  id: 'pchip-excel-10-decimal-accuracy-v1',
  absolutePercentagePoints: 1e-10,
  basis: 'FAU-LMS/bjontegaard: PCHIP agrees with Excel to at least 10 decimal positions',
  source: 'https://github.com/FAU-LMS/bjontegaard/blob/aef9b4d96c52873833cb76ebbe38eb928e0f5da7/README.md',
  unitSource: 'https://github.com/FAU-LMS/bjontegaard/blob/aef9b4d96c52873833cb76ebbe38eb928e0f5da7/bjontegaard/functions.py#L130-L137',
});
