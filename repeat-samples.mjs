import {differenceConfiguration} from './public/repeat-difference.js';

// Two bounded native buffers. Buffer.equals supplies the final exact comparison.
// Integer totals stay below 2^53 at the 128 MiB product frame boundary, even at 16 bits.
export class NativeSampleComparison {
  constructor(format){
    this.format=format;this.configuration=differenceConfiguration(format);this.offset=0;this.previous=null;
    this.current=Buffer.allocUnsafe(format.bytes);this.spare=Buffer.allocUnsafe(format.bytes);
  }
  push(part){
    if(this.offset+part.length>this.current.length)throw Error('原生比较分帧边界溢出');
    part.copy(this.current,this.offset);this.offset+=part.length;
    if(this.offset!==this.current.length)return null;
    const equalPrevious=this.previous===null?null:this.current.equals(this.previous);
    const difference=equalPrevious===false?nativeDifference(this.previous,this.current,this.format,this.configuration):null;
    const old=this.previous;this.previous=this.current;this.current=old??this.spare;this.spare=null;this.offset=0;
    return {equalPrevious,difference};
  }
}
export function nativeDifference(a,b,format,configuration=differenceConfiguration(format)){
  if(a.length!==format.bytes||b.length!==format.bytes)throw Error('原生差异输入长度不符');
  const result=[];let planeOffset=0,componentIndex=0;
  for(const plane of format.planes){
    const stride=plane.components*format.storage,columns=Math.ceil(plane.width/16),rows=Math.ceil(plane.height/16);
    for(let channel=0;channel<plane.components;channel++){
      const sums=new Float64Array(columns*rows);let sad=0,changed=0,max=0;
      for(let y=0;y<plane.height;y++){
        let offset=planeOffset+(y*plane.width*plane.components+channel)*format.storage,block=Math.floor(y/16)*columns;
        for(let x=0;x<plane.width;x++,offset+=stride){
          let av,bv;
          if(format.storage===1){av=a[offset];bv=b[offset];}
          else if(format.endian==='le'){av=(a[offset]|a[offset+1]<<8)>>>format.shift;bv=(b[offset]|b[offset+1]<<8)>>>format.shift;}
          else{av=(a[offset]<<8|a[offset+1])>>>format.shift;bv=(b[offset]<<8|b[offset+1])>>>format.shift;}
          const d=Math.abs(av-bv);if(d){sad+=d;changed++;if(d>max)max=d;sums[block+(x>>>4)]+=d;}
        }
      }
      let bestSum=0,bestCount=Math.min(16,plane.width)*Math.min(16,plane.height),bestX=0,bestY=0;
      for(let by=0;by<rows;by++)for(let bx=0;bx<columns;bx++){
        const sum=sums[by*columns+bx],count=Math.min(16,plane.width-bx*16)*Math.min(16,plane.height-by*16);
        if(sum*bestCount>bestSum*count){bestSum=sum;bestCount=count;bestX=bx*16;bestY=by*16;}
      }
      if(configuration.components[componentIndex++].samples!==plane.width*plane.height)throw Error('原生差异分量布局不一致');
      result.push([sad,changed,max,bestSum,bestCount,bestX,bestY]);
    }
    planeOffset+=plane.width*plane.height*plane.components*format.storage;
  }
  return result;
}
