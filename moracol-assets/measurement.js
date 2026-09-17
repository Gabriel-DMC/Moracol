// Comparación colorimétrica relativa. No estima pH ni certifica inocuidad.
export const METHOD = 'indicator-comparison-v1';
export const TOLERANCES = Object.freeze({
  rgb: Object.freeze({r:5.25,g:19.84,b:18.88}),
  hsv: Object.freeze({h:4.57,s:10.49,v:2.06}),
  lab: Object.freeze({l:6.05,a:6.33,b:2.26})
});

export function rgbToHSV([r,g,b]) {
  r/=255; g/=255; b/=255;
  const max=Math.max(r,g,b), min=Math.min(r,g,b), d=max-min;
  let h=0;
  if(d) {
    if(max===r) h=60*(((g-b)/d+6)%6);
    else if(max===g) h=60*((b-r)/d+2);
    else h=60*((r-g)/d+4);
  }
  return {h,s:max===0?0:(d/max)*100,v:max*100};
}

export function rgbToLab(rgb) {
  const [r,g,b]=rgb.map(value=>{
    value/=255;
    return value<=0.04045?value/12.92:((value+0.055)/1.055)**2.4;
  });
  const x=(r*0.4124+g*0.3576+b*0.1805)/0.95047;
  const y=r*0.2126+g*0.7152+b*0.0722;
  const z=(r*0.0193+g*0.1192+b*0.9505)/1.08883;
  const f=value=>value>0.008856?Math.cbrt(value):7.787*value+16/116;
  const fx=f(x),fy=f(y),fz=f(z);
  return {l:116*fy-16,a:500*(fx-fy),b:200*(fy-fz)};
}

export function analyzeRGB(rgb) {
  if(!Array.isArray(rgb)||rgb.length!==3||!rgb.every(value=>
    typeof value==='number'&&Number.isFinite(value)&&value>=0&&value<=255)) {
    throw new TypeError('Datos RGB no válidos.');
  }
  return {rgb:[...rgb],hsv:rgbToHSV(rgb),lab:rgbToLab(rgb)};
}

export function signedHueDifference(sample,reference) {
  return ((sample-reference+540)%360)-180;
}

export function evaluateSample(reference,sample) {
  const variation={
    rgb:{r:sample.rgb[0]-reference.rgb[0],g:sample.rgb[1]-reference.rgb[1],b:sample.rgb[2]-reference.rgb[2]},
    hsv:{h:signedHueDifference(sample.hsv.h,reference.hsv.h),s:sample.hsv.s-reference.hsv.s,v:sample.hsv.v-reference.hsv.v},
    lab:{l:sample.lab.l-reference.lab.l,a:sample.lab.a-reference.lab.a,b:sample.lab.b-reference.lab.b}
  };
  const withinRange=Object.entries(TOLERANCES).every(([space,limits])=>
    Object.entries(limits).every(([component,limit])=>
      Number.isFinite(variation[space][component])&&Math.abs(variation[space][component])<=limit+1e-9));
  return {withinRange,variation};
}

export function outcomeLabel(withinRange) {
  return withinRange?'Dentro del rango':'Fuera del rango';
}
