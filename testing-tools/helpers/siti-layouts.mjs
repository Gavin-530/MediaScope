import {readFixture} from './fixtures.mjs';
import {createHash} from 'node:crypto';
import {gunzipSync} from 'node:zlib';
import assert from 'node:assert/strict';

// Frozen independent descriptor/known-byte oracle. Do not regenerate from product code.
export const SITI_LAYOUT_ORACLE_SHA256='1533ae303f91a687effa836a55d54bbb708f2d2c2b612442440559cc2354dfa7';
export async function independentSitiLayouts(){
  const bytes=await readFixture('layout-oracle.json.gz');
  assert.equal(createHash('sha256').update(bytes).digest('hex'),SITI_LAYOUT_ORACLE_SHA256,'Independent SI/TI fixture changed');
  const data=JSON.parse(gunzipSync(bytes));
  assert.equal(data.schema,1);assert.equal(data.cases.length,900);assert.equal(new Set(data.cases.map(c=>c.format)).size,150);
  return data;
}
