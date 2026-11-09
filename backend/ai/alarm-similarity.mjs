import sharp from 'sharp';

// Whole-image averages alone hide a small new person/vehicle. Also reject local
// changes; uncertain comparisons always fall back to a fresh model analysis.
export async function sameAlarmScene(left, right) {
 const decode = async image => sharp(image, {limitInputPixels:16000000})
  .resize(320,180,{fit:'fill'}).removeAlpha().toColourspace('srgb').raw().toBuffer();
 const [a,b] = await Promise.all([decode(left),decode(right)]);
 const tiles=new Float64Array(16*9);let total=0,changed=0;
 for(let y=0;y<180;y++)for(let x=0;x<320;x++){
  const p=(y*320+x)*3;
  const delta=Math.max(Math.abs(a[p]-b[p]),Math.abs(a[p+1]-b[p+1]),Math.abs(a[p+2]-b[p+2]));
  total+=delta;if(delta>24)changed++;
  tiles[Math.floor(y/20)*16+Math.floor(x/20)]+=delta;
 }
 return total/(320*180)<=2 && changed/(320*180)<=0.001 && tiles.every(sum=>sum/400<=4);
}
