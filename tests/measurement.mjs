import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {DatabaseSync} from 'node:sqlite';
import * as measurement from '../moracol-assets/measurement.js';

const {METHOD,TOLERANCES,analyzeRGB,evaluateSample,rgbToHSV,rgbToLab,signedHueDifference}=measurement;
let checks=0;
function check(condition,label){assert.ok(condition,label);checks++;}
const ref={rgb:[152.06,101.91,114.42],hsv:{h:345.07,s:33.27,v:59.63},lab:{l:48.75,a:22.07,b:1.33}};
for(const [space,limits] of Object.entries(TOLERANCES))for(const [key,limit] of Object.entries(limits)){
  for(const sign of [-1,1])for(const [offset,expected] of [[0,true],[0.0001,false]]){
    const sample=structuredClone(ref);
    if(space==='rgb')sample.rgb[{r:0,g:1,b:2}[key]]+=sign*(limit+offset);
    else sample[space][key]+=sign*(limit+offset);
    check(evaluateSample(ref,sample).withinRange===expected,`${space}.${key} ${sign} límite ${offset}`);
  }
}
check(signedHueDifference(1,359)===2,'Cruce 360 positivo');
check(signedHueDifference(359,1)===-2,'Cruce 360 negativo');
check(evaluateSample({...ref,hsv:{...ref.hsv,h:359}},{...ref,hsv:{...ref.hsv,h:1}}).withinRange,'Tono circular');
const invalid=structuredClone(ref);invalid.lab.a=NaN;
check(!evaluateSample(ref,invalid).withinRange,'Valores no finitos');
assert.throws(()=>analyzeRGB([1,2,NaN]));checks++;
assert.deepEqual(rgbToHSV([255,0,0]),{h:0,s:100,v:100});checks++;
check(Math.abs(rgbToLab([255,255,255]).l-100)<0.01,'Lab D65 blanco');
check(evaluateSample(analyzeRGB(ref.rgb),analyzeRGB(ref.rgb)).withinRange,'Capturas iguales');
check(!evaluateSample(analyzeRGB(ref.rgb),analyzeRGB([170,140,160])).withinRange,'Capturas distintas');

// API: SQLite real y autenticación simulada, sin modificar cuentas ni créditos reales.
const sqlite=new DatabaseSync(':memory:');
sqlite.exec(fs.readFileSync(new URL('../schema.sql',import.meta.url),'utf8'));
sqlite.exec('DROP TABLE comparison_measurements');
const DB={
  prepare(sql){let args=[];return {bind(...values){args=values;return this;},
    async run(){const r=sqlite.prepare(sql).run(...args);return {success:true,meta:{changes:Number(r.changes)}};},
    async all(){return {success:true,results:sqlite.prepare(sql).all(...args)};},
    async first(){return sqlite.prepare(sql).get(...args)||null;}};},
  async batch(statements){sqlite.exec('BEGIN');try{const r=[];for(const s of statements)r.push(await s.run());sqlite.exec('COMMIT');return r;}catch(e){sqlite.exec('ROLLBACK');throw e;}}
};
globalThis.fetch=async()=>Response.json({users:[{localId:'user-a',email:'test@example.com'}]});
const apiSource=fs.readFileSync(new URL('../functions/api/[[path]].js',import.meta.url),'utf8').replace('../../moracol-assets/measurement.js',new URL('../moracol-assets/measurement.js',import.meta.url).href);
const {onRequest}=await import('data:text/javascript;base64,'+Buffer.from(apiSource).toString('base64'));
async function request(method,path,body){return onRequest({env:{DB},params:{path:path.split('/')},request:new Request('https://test.example/api/'+path,{method,headers:{Authorization:'Bearer test','Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{})})});}
let response=await request('POST','measurements',{id:'12345678-1234-1234-1234-123456789012',method:METHOD,conserva:'Test',indicator:{rgb:ref.rgb},sample:{rgb:ref.rgb},withinRange:false});
check(response.status===201,'Guardado nuevo sin pH');
check((await response.json()).withinRange,'Resultado recalculado por servidor');
check(sqlite.prepare('SELECT count(*) AS n FROM measurements').get().n===0,'No escribe pH ficticio');
const stored=sqlite.prepare('SELECT * FROM comparison_measurements').get();
check(JSON.parse(stored.indicator_json).hsv.h>0,'Guarda indicador completo');
check(stored.firebase_uid==='user-a','Historial vinculado al usuario autenticado');
response=await request('POST','measurements',{id:'22345678-1234-1234-1234-123456789012',method:METHOD,conserva:'Test',indicator:{rgb:ref.rgb},sample:{rgb:[300,1,1]}});
check(response.status===400,'Rechaza RGB inválido');
response=await request('GET','measurements');
check((await response.json()).measurements[0].withinRange,'Historial devuelve veredicto');
response=await request('POST','access/consume');check(response.status===200,'Primer acceso gratuito');
response=await request('POST','access/consume');check(response.status===403,'No consume crédito dos veces');
response=await request('DELETE','measurements');check(response.status===200,'Borrado compatible');
check(sqlite.prepare('SELECT count(*) AS n FROM comparison_measurements').get().n===0,'Borra comparaciones');

// Flujo de interfaz con cámara y nube simuladas.
const html=fs.readFileSync(new URL('../index.html',import.meta.url),'utf8');
check(!html.includes('Cambiar cámara')&&!html.includes('id="switch"'),'Sin cambiar cámara');
check(!html.includes('<table')&&!html.includes('colorTable')&&!html.includes('estimatePH'),'Sin tabla ni estimador anterior');
let script=html.match(/<script type="module">([\s\S]*?)<\/script>/)[1].replace(/import[\s\S]*?from\s*'[^']+';/g,'')+'\nshowToast=()=>{};';
const elements=new Map();
function element(id){if(!elements.has(id))elements.set(id,{id,value:id==='conserva'?'Dulce de batata':'',dataset:{},style:{},textContent:'',className:'',classList:{add(){},remove(){},toggle(){},contains(){return false;}},setAttribute(){},addEventListener(){},scrollIntoView(){},focus(){},getBoundingClientRect(){return {width:400,height:300};}});return elements.get(id);}
const video=element('video');Object.assign(video,{videoWidth:1280,videoHeight:720,readyState:4});
const canvas=element('canvas');let captureRGB=ref.rgb,unusable=false;
canvas.getContext=()=>({drawImage(){},getImageData(){const data=new Uint8ClampedArray(160*160*4);for(let i=0;i<data.length;i+=4){data.set(unusable?[0,0,0,255]:[...captureRGB.map(Math.round),255],i);}return {data};}});
let consumes=0,delay=null;
const context=vm.createContext({...measurement,console,crypto,Date,Number,Object,Array,String,Math,JSON,Error,Uint8ClampedArray,
  document:{getElementById:element,querySelector:()=>element('guide'),querySelectorAll:()=>[],body:{classList:{add(){},remove(){}}},documentElement:{dataset:{},setAttribute(){}},addEventListener(){}},
  window:{matchMedia:()=>({matches:false,addEventListener(){}}),setInterval(){},setTimeout(){},scrollTo(){}},
  localStorage:{getItem(){return null;},setItem(){}},navigator:{mediaDevices:{async getUserMedia(){return {getTracks(){return [];}};}}},
  initializeApp(){return {};},getAuth(){return {currentUser:{getIdToken:async()=> 'mock'}};},GoogleAuthProvider:class {},onAuthStateChanged(){},
  fetch:async url=>{if(url==='/api/access/consume'){consumes++;if(delay)await delay;return {ok:true,json:async()=>({allowed:true,freeConsumed:true})};}return {ok:true,json:async()=>({})};}});
new vm.Script(script+`\nglobalThis.testUI={captureMeasurement,resetMeasurement,state:()=>({referenceMeasurement,pendingMeasurement,measurementBusy}),setUser:(id)=>{currentUser={id,name:'Test',freeMeasurementUsed:false,hasHadSubscription:false};}};`).runInContext(context);
context.testUI.setUser('user-a');
unusable=true;await context.testUI.captureMeasurement();check(consumes===0,'Captura inválida no consume crédito');unusable=false;
let release;delay=new Promise(resolve=>{release=resolve;});
const first=context.testUI.captureMeasurement();await context.testUI.captureMeasurement();
check(consumes===1,'Doble clic bloqueado antes de pedir acceso');release();await first;delay=null;
check(element('capture').textContent==='Capturar muestra','Botón pasa a segunda foto');
check(context.testUI.state().referenceMeasurement!==null,'Referencia conservada');
unusable=true;await context.testUI.captureMeasurement();check(context.testUI.state().referenceMeasurement!==null,'Error de muestra permite reintentar');unusable=false;
await context.testUI.captureMeasurement();
check(consumes===1,'Una evaluación consume solo una medición');
check(element('verdict').textContent==='Dentro del rango','Resultado dentro');
check(!('ph' in context.testUI.state().pendingMeasurement),'Sin pH ficticio en cliente');
check(element('capture').textContent==='Capturar indicador','Botón reinicia');
context.testUI.setUser('user-a');await context.testUI.captureMeasurement();captureRGB=[170,140,160];await context.testUI.captureMeasurement();
check(element('verdict').textContent==='Fuera del rango','Resultado fuera');
context.testUI.resetMeasurement();check(!context.testUI.state().pendingMeasurement,'Cambio de cuenta borra resultado pendiente');
console.log(`${checks} verificaciones correctas: límites, conversiones, API e interfaz.`);
