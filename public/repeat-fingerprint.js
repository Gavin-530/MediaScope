import {validateReportMetadata} from './report-extensions.js';

export const genericRepeatAlgorithm='native-bytes-equal+frame-digest/v1';
const fixedBits={sha224:224,sha256:256,sha384:384,sha512:512,'sha512-224':224,'sha512-256':256,'sha3-224':224,'sha3-256':256,'sha3-384':384,'sha3-512':512};

// This validates the saved descriptor and representation, not the hash implementation.
export function validateFrameFingerprint(value){
  if(!value||value.version!==1||typeof value.algorithm!=='string'||!/^[a-z0-9][a-z0-9._/-]{0,79}$/.test(value.algorithm)||!Number.isSafeInteger(value.bits)||value.bits<8||value.bits>4096||value.bits%8||!['hex','base64'].includes(value.encoding)||value.input!=='native-frame-bytes'||Object.keys(value).some(key=>!['version','algorithm','bits','encoding','input','parameters','extensions'].includes(key)))throw Error('帧摘要配置无效');
  validateReportMetadata(value.parameters);
  if(value.extensions!==undefined)validateReportMetadata(value.extensions);
  if(Object.hasOwn(fixedBits,value.algorithm)&&(value.bits!==fixedBits[value.algorithm]||Object.keys(value.parameters).length))throw Error('标准帧摘要参数或长度不一致');
}

export function validFrameDigest(value,configuration){
  if(typeof value!=='string')return false;
  if(configuration.encoding==='hex')return value.length===configuration.bits/4&&/^[a-f0-9]+$/.test(value);
  if(value.length!==4*Math.ceil(configuration.bits/8/3)||!/^[A-Za-z0-9+/]*={0,2}$/.test(value))return false;
  try{const bytes=atob(value);return bytes.length===configuration.bits/8&&btoa(bytes)===value;}catch{return false;}
}
