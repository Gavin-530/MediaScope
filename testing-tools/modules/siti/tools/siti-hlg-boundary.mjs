// Known native bytes near the pinned HLG 0.5 branch. Expected values below use
// independent scalar equations and 2D convolution, never product math/output.
const matrices={bt601:[.299,.587,.114],bt709:[.2126,.7152,.0722],bt2020:[.2627,.678,.0593]},f=Math.fround;
const pq=v=>{const linear=v<=.5?v*v/3:Math.exp((v-1.00429347)/.17883277)-.02372241,luminance=(1000-.01)*linear**1.2+.01,y=(luminance/10000)**(2610/16384);return ((3424/4096+(2413/128)*y)/(1+(2392/128)*y))**(2523/32)};
const std=a=>{const mean=a.reduce((s,v)=>s+v,0)/a.length;return Math.sqrt(a.reduce((s,v)=>s+(v-mean)**2,0)/a.length)};
function metrics(a,previous){const gx=[-1,0,1,-2,0,2,-1,0,1],gy=[-1,-2,-1,0,0,0,1,2,1],gradient=[];for(let y=1;y<6;y++)for(let x=1;x<8;x++){let sx=0,sy=0;for(let k=0;k<9;k++){const v=a[(y+Math.floor(k/3)-1)*9+x+k%3-1];sx+=v*gx[k];sy+=v*gy[k]}gradient.push(Math.sqrt(sx*sx+sy*sy))}return {si:255*std(gradient),ti:previous?255*std(a.map((v,i)=>v-previous[i])):null}}
export function hlgBoundaryCases(){
 const cases=[];
 for(const depth of [8,10,16])for(const range of ['pc','tv'])for(const [matrix,w]of Object.entries(matrices)){
  const lo=range==='pc'?0:16*2**(depth-8),hi=range==='pc'?2**depth-1:235*2**(depth-8),span=hi-lo,triples=[];
  for(let r=lo;r<=hi&&triples.length<64;r+=Math.max(1,Math.floor(span/478)))for(let g=lo;g<=hi&&triples.length<64;g+=Math.max(1,Math.floor(span/274))){
   const ideal=lo+(span*.5-w[0]*(r-lo)-w[1]*(g-lo))/w[2];
   for(const b of [Math.floor(ideal),Math.ceil(ideal)])if(b>=lo&&b<=hi){const v=w[0]*(r-lo)/span+w[1]*(g-lo)/span+w[2]*(b-lo)/span,single=f(f(f(f(f(w[0])*(r-lo))/span)+f(f(f(w[1])*(g-lo))/span))+f(f(f(w[2])*(b-lo))/span));if((v<=.5)!==(single<=.5))triples.push({r,g,b,v,single})}
  }
  if(!triples.length)continue;
  const planes=[],frames=[0,1].map(frame=>{const bytes=depth===8?1:2,raw=Buffer.alloc(63*3*bytes),values=[];for(let i=0;i<63;i++){const t=i%3===0?{r:lo,g:lo,b:lo}:triples[(i+frame)%triples.length];for(const [channel,key]of ['r','g','b'].entries()){const offset=depth===10?({r:126,g:0,b:63}[key]+i)*2:(i*3+channel)*bytes;if(bytes===1)raw[offset]=t[key];else raw.writeUInt16LE(t[key],offset)}values.push(pq(w[0]*(t.r-lo)/span+w[1]*(t.g-lo)/span+w[2]*(t.b-lo)/span))}planes.push(values);return raw.toString('base64')});
  cases.push({name:`hlg-rgb-join-${depth}-${range}-${matrix}`,format:depth===8?'rgb24':depth===10?'gbrp10le':'rgb48le',range,domain:'hlg',width:9,height:7,settings:{transfer:'hlg',range,matrix,hlg:{whiteCdM2:1000,blackCdM2:.01}},frames,normalized:planes,expected:planes.map((a,i)=>({frame:i,...metrics(a,i?planes[i-1]:null)})),branchCandidates:triples});
 }
 return cases;
}
