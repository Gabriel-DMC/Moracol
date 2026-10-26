import assert from 'node:assert/strict';
import {onRequest} from '../functions/api/[[path]].js';
import {EXHIBITION_MODE} from '../moracol-assets/exhibition.js';
assert.equal(EXHIBITION_MODE,true);
let calls=0;
globalThis.fetch=async()=>{calls++;throw new Error('No se debe contactar a un proveedor');};
const env={
  APP_URL:'https://moracol.pages.dev',MP_ACCESS_TOKEN:'fake',MP_WEBHOOK_SECRET:'fake',
  MP_COLLECTOR_ID:'123',MP_MODE:'live',PAYMENTS_ENABLED:'true',PAYMENTS_LEGAL_READY:'true',
  DB:{prepare(){throw new Error('No se debe modificar la base de datos');}}
};
async function request(method,path,authenticated=false){
  return onRequest({env,params:{path:path.split('/')},request:new Request(env.APP_URL+'/api/'+path,{
    method,headers:authenticated?{Authorization:'Bearer simulated'}:{}
  })});
}
for(const authenticated of [false,true]){
  for(let i=0;i<10;i++){
    const result=await request('POST','access/consume',authenticated);
    assert.equal(result.status,200);
    assert.deepEqual(await result.json(),{allowed:true,unlimited:true,exhibitionMode:true});
  }
  assert.equal((await request('POST','payments/checkout',authenticated)).status,503);
}
const config=await (await request('GET','payments/config')).json();
assert.equal(config.enabled,false);
assert.equal(config.exhibitionMode,true);
for(const [method,path] of [['GET','me'],['GET','measurements'],['POST','measurements'],['DELETE','measurements']]){
  assert.equal((await request(method,path)).status,401,'El historial sigue protegido');
}
assert.equal(calls,0);
console.log('Exposición verificada: acceso repetido sin cuenta, sin consumir créditos, pagos bloqueados e historial protegido.');
