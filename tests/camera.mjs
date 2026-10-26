import assert from 'node:assert/strict';
import fs from 'node:fs';
import {createCameraController,cameraErrorMessage} from '../moracol-assets/camera.js';
let checks=0;
function check(value,label){assert.ok(value,label);checks++;}
const flush=async()=>{for(let i=0;i<8;i++)await Promise.resolve();};
function fixture({getMedia,play,secure=true,missing=false}={}){
  const states=[];let calls=0,stops=0,ended,timeout;
  const track={readyState:'live',stop(){stops++;this.readyState='ended';},addEventListener(type,fn){if(type==='ended')ended=fn;}};
  const stream={getTracks:()=>[track],getVideoTracks:()=>[track]};
  const video={readyState:0,videoWidth:0,videoHeight:0,srcObject:null,
    async play(){if(play)return play(this);this.readyState=4;this.videoWidth=1280;this.videoHeight=720;}};
  const controller=createCameraController({video,secureContext:secure,
    mediaDevices:missing?undefined:{getUserMedia(options){calls++;assert.equal(options.audio,false);return getMedia?getMedia(stream):Promise.resolve(stream);}},
    onState:(state,message)=>states.push({state,message}),
    setTimer(fn){timeout=fn;return 1;},clearTimer(){timeout=null;}});
  return {controller,video,states,track,stream,calls:()=>calls,stops:()=>stops,expire:()=>timeout(),disconnect:()=>{track.readyState='ended';ended();}};
}
let f=fixture();
check(f.calls()===0,'No solicita permiso al cargar');
await f.controller.start();
check(f.controller.isReady(),'Permiso y reproducción habilitan captura');
check(f.video.muted,'Video sin sonido');
check(f.states.at(-1).state==='ready','Indica lista después de reproducir');
await f.controller.start();check(f.calls()===1,'No vuelve a solicitar una cámara activa');
f.controller.stop();check(f.stops()===1&&!f.controller.isReady()&&f.video.srcObject===null,'Apagar libera cámara');

for(const name of ['NotAllowedError','NotFoundError','NotReadableError','OverconstrainedError','SecurityError','AbortError']){
  f=fixture({getMedia:()=>Promise.reject({name})});await f.controller.start();
  check(f.states.at(-1).state==='error'&&!f.controller.isReady(),name+' permite recuperación');
  check(f.states.at(-1).message===cameraErrorMessage({name}),name+' mensaje específico');
}
for(const options of [{secure:false},{missing:true}]){
  f=fixture(options);await f.controller.start();check(f.calls()===0&&f.states.at(-1).state==='error','Detecta HTTPS o API ausente');
}
let resolve;
f=fixture({getMedia:s=>new Promise(r=>{resolve=()=>r(s);})});
let attempt=f.controller.start();await f.controller.start();
check(f.calls()===1,'Doble clic no duplica solicitudes');
f.expire();await attempt;check(f.states.at(-1).state==='error','Permiso ignorado no espera indefinidamente');
resolve();await flush();check(f.stops()===1&&f.video.srcObject===null,'Respuesta tardía libera cámara');

f=fixture({getMedia:s=>new Promise(r=>{resolve=()=>r(s);})});
attempt=f.controller.start();f.controller.stop();await attempt;
resolve();await flush();check(f.stops()===1&&f.states.at(-1).state==='idle','Cancelar no reactiva cámara con permiso tardío');

f=fixture({play:()=>Promise.reject({name:'NotAllowedError'})});await f.controller.start();
check(f.stops()===1&&f.states.at(-1).message.includes('video no pudo'),'Reproducción bloqueada libera cámara y explica');
f=fixture({play:()=>Promise.resolve()});await f.controller.start();
check(!f.controller.isReady()&&f.states.at(-1).state==='error','Sin cuadros no informa cámara lista');
f=fixture({play:()=>new Promise(()=>{})});attempt=f.controller.start();await flush();f.expire();await attempt;
check(f.stops()===1&&!f.controller.isReady(),'Video que no inicia vence y libera cámara');

f=fixture();await f.controller.start();f.disconnect();
check(!f.controller.isReady()&&f.states.at(-1).message.includes('desconectó'),'Desconexión bloquea capturas');

let denied=true;
f=fixture({getMedia:s=>denied?Promise.reject({name:'NotAllowedError'}):Promise.resolve(s)});
await f.controller.start();denied=false;await f.controller.start();
check(f.controller.isReady()&&f.calls()===2,'Se recupera tras corregir permiso y reintentar');
const html=fs.readFileSync(new URL('../index.html',import.meta.url),'utf8');
check(html.includes('id="startCamera"')&&html.includes('id="capture" disabled'),'Controles iniciales seguros');
check(!html.includes('startCamera();'),'Sin petición automática al abrir');
check(html.includes("window.addEventListener('pagehide',()=>camera.stop())"),'Salir libera cámara');
console.log(`${checks} verificaciones de cámara correctas.`);
