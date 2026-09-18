import assert from 'node:assert/strict';
import fs from 'node:fs';
import {DatabaseSync} from 'node:sqlite';
import {PLANS,BILLING_SCHEMA,paymentConfig,checkout,getOrder,reconcile,applyPayment,webhook,boundedJson} from '../lib/billing.js';
import {onRequest} from '../functions/api/[[path]].js';
let checks=0;
const check=(condition,label)=>{assert.ok(condition,label);checks++;};
async function rejects(call,status){await assert.rejects(call,error=>error.status===status);checks++;}
const sqlite=new DatabaseSync(':memory:');
sqlite.exec(fs.readFileSync(new URL('../schema.sql',import.meta.url),'utf8'));
sqlite.exec("INSERT INTO users(firebase_uid,email) VALUES ('a','a@example.com'),('b','b@example.com')");
const DB={prepare(sql){let args=[];return {bind(...values){args=values;return this;},
  async run(){const result=sqlite.prepare(sql).run(...args);return {success:true,meta:{changes:Number(result.changes)}};},
  async first(){return sqlite.prepare(sql).get(...args)||null;},async all(){return {results:sqlite.prepare(sql).all(...args)};}};},
  async batch(statements){sqlite.exec('BEGIN');try{const results=[];for(const s of statements)results.push(await s.run());sqlite.exec('COMMIT');return results;}catch(error){sqlite.exec('ROLLBACK');throw error;}}
};
const env={DB,APP_URL:'https://moracol.pages.dev',MP_ACCESS_TOKEN:'test-secret',MP_WEBHOOK_SECRET:'webhook-secret',MP_COLLECTOR_ID:'123456',MP_MODE:'test',MP_TEST_UID:'a',PAYMENTS_ENABLED:'true'};
const identity={uid:'a',email:'a@example.com'};
const req=()=>new Request(env.APP_URL+'/api/payments/checkout',{method:'POST',headers:{Origin:env.APP_URL}});
check(!paymentConfig({DB},req()).enabled,'Sin secretos: cobros deshabilitados');
check(paymentConfig(env,req()).enabled,'Configuración de prueba habilitada');
check(!paymentConfig({...env,MP_TEST_UID:''},req()).enabled,'Modo de prueba requiere cuenta autorizada');
check(!paymentConfig({...env,MP_MODE:'live'},req()).enabled,'Cobros reales requieren documentos legales');
check(paymentConfig({...env,MP_MODE:'live',PAYMENTS_LEGAL_READY:'true'},req()).enabled,'Configuración explícita real');
check(!paymentConfig(env,new Request('https://preview.pages.dev/api/payments/config')).enabled,'Preview no cobra en nombre de producción');
const publicConfigResponse=await onRequest({env:{DB},params:{path:['payments','config']},request:new Request(env.APP_URL+'/api/payments/config')});
check(publicConfigResponse.status===200&&!JSON.stringify(await publicConfigResponse.json()).includes('secret'),'Configuración pública sin autenticación ni secretos');
await rejects(()=>checkout(req(),{...env,PAYMENTS_ENABLED:'false'},identity,{planId:'pro'}),503);
await rejects(()=>checkout(req(),env,{uid:'b'},{planId:'pro'}),403);
await rejects(()=>checkout(req(),env,identity,{planId:'unknown'}),400);
await rejects(()=>boundedJson(new Request(env.APP_URL,{method:'POST',body:JSON.stringify({text:'x'.repeat(17000)})})),413);
await rejects(()=>boundedJson(new Request(env.APP_URL,{method:'POST',body:'[]'})),400);
sqlite.exec(BILLING_SCHEMA);
const payments=new Map();let preferenceCalls=0;
globalThis.fetch=async (url,options)=>{
  check(options.headers.Authorization==='Bearer test-secret','Token enviado solo al servidor MP');
  if(url==='https://api.mercadopago.com/checkout/preferences'){
    preferenceCalls++;const body=JSON.parse(options.body);
    const plan=PLANS[body.items[0].id];
    check(body.items[0].quantity===1&&body.items[0].unit_price===plan.amount&&body.items[0].currency_id==='ARS','Precio y moneda calculados por el servidor');
    check(body.external_reference&&body.notification_url===env.APP_URL+'/api/payments/webhook','Orden y notificación vinculadas al servidor');
    check(Object.values(body.back_urls).every(url=>url.startsWith(env.APP_URL+'/?billing_order=')),'Retorno con orden no manipulada por cliente');
    check(!('preapproval_plan_id' in body)&&!('payer' in body),'Sin suscripción automática ni correo compartido innecesariamente');
    return Response.json({id:'pref-'+preferenceCalls,collector_id:123456,init_point:'https://www.mercadopago.com.ar/checkout/v1/redirect?pref_id=live',sandbox_init_point:'https://sandbox.mercadopago.com.ar/checkout/v1/redirect?pref_id=test'});
  }
  const id=url.split('/').at(-1);
  if(payments.has(id))return Response.json(payments.get(id));
  return new Response('',{status:404});
};
function payment(orderId,id,status='approved',date='2026-09-18T01:00:00Z'){
  return {id:Number(id),external_reference:orderId,collector_id:123456,currency_id:'ARS',transaction_amount:6000,live_mode:false,status,date_last_updated:date,date_approved:'2026-09-18T00:59:59Z',transaction_amount_refunded:0};
}
const order=await checkout(req(),env,identity,{planId:'pro',amount:1,currency:'USD',days:999,uid:'b',back_urls:{success:'https://evil.example'}});
check(order.checkoutUrl.startsWith('https://sandbox.mercadopago.com.ar/'),'Prueba usa checkout sandbox');
const stored=sqlite.prepare('SELECT * FROM billing_orders WHERE id=?').get(order.orderId);
check(stored.amount===6000&&stored.days===30&&stored.firebase_uid==='a','Ignora manipulación de precio, días y usuario');
await rejects(()=>getOrder(env,{uid:'b'},order.orderId),404);
const approved=payment(order.orderId,'111');payments.set('111',approved);
check((await reconcile(env,identity,{orderId:order.orderId})).status==='pending','Retorno sin pago nunca activa');
check(sqlite.prepare('SELECT count(*) AS n FROM subscriptions').get().n===0,'Sin activación anticipada');
for(const status of ['pending','in_process','rejected']){
  const result=await applyPayment(env,payment(order.orderId,'112',status));
  check(result.status===status,'Estado '+status+' almacenado');
  check(sqlite.prepare('SELECT count(*) AS n FROM subscriptions').get().n===0,'Estado '+status+' no activa');
}
for(const patch of [{collector_id:999},{currency_id:'USD'},{transaction_amount:1},{live_mode:true},{date_last_updated:'invalid'}]){
  await rejects(()=>applyPayment(env,{...approved,...patch}),patch.date_last_updated?502:409);
}
check(sqlite.prepare('SELECT count(*) AS n FROM subscriptions').get().n===0,'Datos incorrectos no activan');
check((await reconcile(env,identity,{orderId:order.orderId,paymentId:'111',status:'rejected'})).status==='approved','Estado aprobado verificado vía API, no URL');
let grant=sqlite.prepare('SELECT * FROM subscriptions').get();
check(grant.plan_id==='pro'&&grant.firebase_uid==='a'&&grant.provider==='mercadopago_one_time','Acceso vinculado a usuario y plan correctos');
check(Date.parse(grant.current_period_end)-Date.parse(grant.period_start)===30*86400000,'Pro dura exactamente 30 días');
check(sqlite.prepare("SELECT has_had_subscription FROM users WHERE firebase_uid='a'").get().has_had_subscription===1,'Cuenta actualizada tras aprobación');
const initialEnd=grant.current_period_end;
await applyPayment(env,approved);await applyPayment(env,approved);
check(sqlite.prepare('SELECT count(*) AS n FROM subscriptions').get().n===1,'Repeticiones no duplican accesos');
check(sqlite.prepare('SELECT current_period_end FROM subscriptions').get().current_period_end===initialEnd,'Repeticiones no suman días');
await applyPayment(env,payment(order.orderId,'113','rejected','2026-09-19T00:00:00Z'));
check((await getOrder(env,identity,order.orderId)).status==='approved','Otro intento rechazado no invalida pago ganador');
await rejects(()=>checkout(req(),env,identity,{planId:'plus'}),409);
const otherOrder=crypto.randomUUID();
sqlite.prepare('INSERT INTO billing_orders(id,firebase_uid,plan_id,amount,days,mode,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)').run(otherOrder,'b','pro',6000,30,'test',new Date().toISOString(),new Date().toISOString());
await rejects(()=>reconcile(env,identity,{orderId:order.orderId,paymentId:'999'}),502);
payments.set('114',payment(otherOrder,'114'));
await rejects(()=>reconcile(env,identity,{orderId:order.orderId,paymentId:'114'}),409);
sqlite.prepare(`INSERT INTO subscriptions(id,firebase_uid,provider,plan_id,status,period_start,current_period_end) VALUES ('manual','a','manual','pro','active',?,?)`).run(new Date().toISOString(),new Date(Date.now()+90*86400000).toISOString());
const refund={...approved,status:'refunded',transaction_amount_refunded:6000,date_last_updated:'2026-09-20T01:00:00Z'};
await applyPayment(env,refund);
check(sqlite.prepare("SELECT status FROM subscriptions WHERE id=?").get(grant.id).status==='expired','Reversión invalida solo acceso pagado');
check(sqlite.prepare("SELECT status FROM subscriptions WHERE id='manual'").get().status==='active','Plan manual intacto');
await applyPayment(env,approved);
check((await getOrder(env,identity,order.orderId)).status==='revoked','Aprobación vieja no revive una reversión');
check(sqlite.prepare('SELECT current_period_end FROM subscriptions WHERE id=?').get(grant.id).current_period_end===initialEnd,'Reversión/reintento conserva fechas');
async function notification(id,overrides={}){
  const rid='test-request-id',ts='1704908010';
  const key=await crypto.subtle.importKey('raw',new TextEncoder().encode(env.MP_WEBHOOK_SECRET),{name:'HMAC',hash:'SHA-256'},false,['sign']);
  const digest=new Uint8Array(await crypto.subtle.sign('HMAC',key,new TextEncoder().encode(`id:${id};request-id:${rid};ts:${ts};`)));
  const hash=Array.from(digest,x=>x.toString(16).padStart(2,'0')).join('');
  return new Request(env.APP_URL+'/api/payments/webhook?data.id='+id,{method:'POST',headers:{'x-request-id':rid,'x-signature':`ts=${ts},v1=${hash}`,...overrides},body:JSON.stringify({type:'payment',data:{id}})});
}
payments.set('111',refund);
check((await webhook(await notification('111'),env)).ok,'Firma válida acepta reintento antiguo, idempotente');
await rejects(async()=>webhook(await notification('111',{'x-signature':'ts=1704908010,v1='+'0'.repeat(64)}),env),401);
await rejects(async()=>webhook(await notification('111',{'x-request-id':'changed'}),env),401);
await rejects(async()=>webhook(await notification('111',{'x-signature':'ts=1,ts=2,v1='+'0'.repeat(64)}),env),401);
await rejects(()=>webhook(new Request(env.APP_URL+'/api/payments/webhook?data.id=111',{method:'POST',body:'{}'}),env),401);
const webhookDenied=await onRequest({env,params:{path:['payments','webhook']},request:new Request(env.APP_URL+'/api/payments/webhook',{method:'POST',body:'{}'})});
check(webhookDenied.status===401,'Webhook público exige firma, no Firebase');
check(sqlite.prepare("SELECT status FROM subscriptions WHERE id='manual'").get().status==='active','Pruebas jamás alteran acceso manual');
const earlyRefundOrder=crypto.randomUUID();
sqlite.prepare('INSERT INTO billing_orders(id,firebase_uid,plan_id,amount,days,mode,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)').run(earlyRefundOrder,'a','pro',6000,30,'test',new Date().toISOString(),new Date().toISOString());
await applyPayment(env,{...payment(earlyRefundOrder,'115'),status:'refunded',date_last_updated:'2026-09-20T01:00:00Z'});
await applyPayment(env,payment(earlyRefundOrder,'115'));
check((await getOrder(env,identity,earlyRefundOrder)).status==='revoked','Reversión recibida antes de aprobación no se pierde');
check(!sqlite.prepare('SELECT id FROM subscriptions WHERE id=?').get('mp-order-'+earlyRefundOrder),'Reversión previa no concede acceso');
// Todos los períodos del servidor son exactos; misma transacción real SQLite.
for(const [planId,plan] of Object.entries(PLANS)){
  const id=crypto.randomUUID(),uid='test-'+planId;
  sqlite.prepare('INSERT INTO users(firebase_uid,email) VALUES (?,?)').run(uid,uid+'@example.com');
  sqlite.prepare('INSERT INTO billing_orders(id,firebase_uid,plan_id,amount,days,mode,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)').run(id,uid,planId,plan.amount,plan.days,'test',new Date().toISOString(),new Date().toISOString());
  await applyPayment({...env,MP_TEST_UID:uid},{...payment(id,String(200+plan.days)),transaction_amount:plan.amount});
  const result=sqlite.prepare('SELECT * FROM subscriptions WHERE firebase_uid=?').get(uid);
  check(Date.parse(result.current_period_end)-Date.parse(result.period_start)===plan.days*86400000,planId+' duración exacta');
}
console.log(`${checks} verificaciones de pagos correctas. SQLite y Mercado Pago simulados; ninguna operación real.`);
