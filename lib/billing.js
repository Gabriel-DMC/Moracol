// Pagos únicos Checkout Pro. Ningún secreto ni importe procede del navegador.
export const PLANS = Object.freeze({
  plus: Object.freeze({name:'Plus',amount:2000,days:7}),
  pro: Object.freeze({name:'Pro',amount:6000,days:30}),
  annual: Object.freeze({name:'Anual',amount:60000,days:365})
});
export class BillingError extends Error {
  constructor(status,message){super(message);this.status=status;}
}
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const paymentId=/^[1-9][0-9]{0,24}$/;
export const BILLING_SCHEMA=`CREATE TABLE IF NOT EXISTS billing_orders (
  id TEXT PRIMARY KEY, firebase_uid TEXT NOT NULL,
  plan_id TEXT NOT NULL CHECK(plan_id IN ('plus','pro','annual')),
  amount INTEGER NOT NULL, currency TEXT NOT NULL DEFAULT 'ARS', days INTEGER NOT NULL,
  mode TEXT NOT NULL CHECK(mode IN ('test','live')),
  status TEXT NOT NULL DEFAULT 'pending', preference_id TEXT,
  winning_payment_id TEXT UNIQUE, latest_payment_id TEXT,
  provider_updated_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  FOREIGN KEY(firebase_uid) REFERENCES users(firebase_uid) ON DELETE CASCADE
)`;
async function storage(db){await db.batch([
  db.prepare(BILLING_SCHEMA),
  db.prepare('CREATE INDEX IF NOT EXISTS idx_billing_owner ON billing_orders(firebase_uid,created_at DESC)')
]);}
function settings(env){
  let origin='';
  try{const url=new URL(env.APP_URL);if(url.protocol==='https:'&&url.pathname==='/'&&!url.search&&!url.hash&&!url.username&&!url.password)origin=url.origin;}catch{}
  const mode=env.MP_MODE==='live'?'live':'test';
  const ready=Boolean(origin&&env.MP_ACCESS_TOKEN&&env.MP_WEBHOOK_SECRET&&/^[1-9][0-9]*$/.test(env.MP_COLLECTOR_ID||''));
  const enabled=ready&&env.PAYMENTS_ENABLED==='true'&&
    (mode==='live'?env.PAYMENTS_LEGAL_READY==='true':Boolean(env.MP_TEST_UID));
  return {origin,mode,ready,enabled};
}
export function paymentConfig(env,request){
  const c=settings(env);
  return {enabled:c.enabled&&new URL(request.url).origin===c.origin,mode:c.mode,currency:'ARS',plans:PLANS};
}
export async function boundedJson(request,limit=16384){
  if(Number(request.headers.get('content-length')||0)>limit)throw new BillingError(413,'Solicitud demasiado grande.');
  const reader=request.body?.getReader();
  if(!reader)throw new BillingError(400,'El contenido enviado no es válido.');
  let size=0;const chunks=[];
  try{while(true){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;
    if(size>limit){await reader.cancel();throw new BillingError(413,'Solicitud demasiado grande.');}chunks.push(value);}
    const bytes=new Uint8Array(size);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length;}
    const result=JSON.parse(new TextDecoder().decode(bytes));
    if(!result||typeof result!=='object'||Array.isArray(result))throw new Error('object required');
    return result;
  }catch(error){if(error instanceof BillingError)throw error;throw new BillingError(400,'El contenido enviado no es válido.');}
  finally{reader.releaseLock();}
}
async function provider(env,path,options={}){
  // No registrar respuestas de MP: pueden contener información personal.
  let result;
  try{result=await fetch('https://api.mercadopago.com'+path,{...options,
    headers:{Authorization:`Bearer ${env.MP_ACCESS_TOKEN}`,'Content-Type':'application/json'},
    redirect:'error',signal:AbortSignal.timeout(10000)});
  }catch{throw new BillingError(503,'Mercado Pago no respondió. Intentá nuevamente.');}
  if(!result.ok){await result.body?.cancel();throw new BillingError(502,'No se pudo verificar la operación con Mercado Pago.');}
  try{return await boundedJson(result,131072);}catch{throw new BillingError(502,'Respuesta de Mercado Pago no válida.');}
}
function publicOrder(order){return {id:order.id,planId:order.plan_id,amount:order.amount,currency:order.currency,days:order.days,status:order.status,mode:order.mode};}
export async function checkout(request,env,identity,body){
  const c=settings(env);
  if(!c.enabled||new URL(request.url).origin!==c.origin)throw new BillingError(503,'Los cobros todavía no están habilitados.');
  if(c.mode==='test'&&identity.uid!==env.MP_TEST_UID)throw new BillingError(403,'Los pagos están en prueba y todavía no están disponibles.');
  if(request.headers.get('origin')&&request.headers.get('origin')!==c.origin)throw new BillingError(403,'Origen no válido.');
  const plan=Object.hasOwn(PLANS,body.planId)?PLANS[body.planId]:null;
  if(!plan)throw new BillingError(400,'Plan no válido.');
  const now=new Date().toISOString();
  const active=await env.DB.prepare("SELECT id FROM subscriptions WHERE firebase_uid=?1 AND status IN ('active','authorized','cancelled') AND current_period_end>?2 LIMIT 1").bind(identity.uid,now).first();
  if(active)throw new BillingError(409,'Tu plan todavía está activo. Podrás renovarlo cuando venza.');
  await storage(env.DB);
  const id=crypto.randomUUID();
  await env.DB.prepare('INSERT INTO billing_orders(id,firebase_uid,plan_id,amount,days,mode,created_at,updated_at) VALUES (?1,?2,?3,?4,?5,?6,?7,?7)').bind(id,identity.uid,body.planId,plan.amount,plan.days,c.mode,now).run();
  const back=`${c.origin}/?billing_order=${id}`;
  const preference=await provider(env,'/checkout/preferences',{method:'POST',body:JSON.stringify({
    items:[{id:body.planId,title:`Moracol ${plan.name} — ${plan.days} días`,quantity:1,currency_id:'ARS',unit_price:plan.amount}],
    external_reference:id,back_urls:{success:back,pending:back,failure:back},auto_return:'approved',
    notification_url:`${c.origin}/api/payments/webhook`,
    expires:true,expiration_date_from:now,expiration_date_to:new Date(Date.now()+3600000).toISOString()
  })});
  const target=c.mode==='live'?preference.init_point:preference.sandbox_init_point;
  let url;try{url=new URL(target);}catch{throw new BillingError(502,'Enlace de pago no válido.');}
  if(url.protocol!=='https:'||!['www.mercadopago.com.ar','sandbox.mercadopago.com.ar'].includes(url.hostname)||url.username||url.password||url.port)
    throw new BillingError(502,'Enlace de pago no válido.');
  if(typeof preference.id!=='string'||String(preference.collector_id)!==String(env.MP_COLLECTOR_ID))throw new BillingError(502,'Cuenta de cobro no válida.');
  await env.DB.prepare('UPDATE billing_orders SET preference_id=?1,updated_at=?2 WHERE id=?3').bind(preference.id,new Date().toISOString(),id).run();
  return {orderId:id,checkoutUrl:url.href,mode:c.mode};
}
export async function getOrder(env,identity,id){
  if(!uuid.test(id||''))throw new BillingError(400,'Orden no válida.');
  await storage(env.DB);
  const order=await env.DB.prepare('SELECT * FROM billing_orders WHERE id=?1 AND firebase_uid=?2').bind(id,identity.uid).first();
  if(!order)throw new BillingError(404,'Orden no encontrada.');
  return publicOrder(order);
}
export async function applyPayment(env,payment,expectedOrder){
  if(!paymentId.test(String(payment.id||''))||!uuid.test(payment.external_reference||''))throw new BillingError(400,'Pago no válido.');
  await storage(env.DB);
  const order=await env.DB.prepare('SELECT * FROM billing_orders WHERE id=?1').bind(payment.external_reference).first();
  if(!order){if(expectedOrder)throw new BillingError(404,'Orden no encontrada.');return {ignored:true};}
  const c=settings(env);
  if(expectedOrder&&order.id!==expectedOrder)throw new BillingError(409,'El pago no corresponde a esta orden.');
  if(String(payment.collector_id)!==String(env.MP_COLLECTOR_ID)||payment.currency_id!==order.currency||
    typeof payment.transaction_amount!=='number'||payment.transaction_amount!==order.amount||
    typeof payment.live_mode!=='boolean'||payment.live_mode!==(order.mode==='live')||
    (order.mode==='test'&&order.firebase_uid!==env.MP_TEST_UID)||!c.ready)
    throw new BillingError(409,'El pago no coincide con la orden.');
  const updatedMs=Date.parse(payment.date_last_updated);
  if(!Number.isFinite(updatedMs))throw new BillingError(502,'Fecha del pago no válida.');
  const updated=new Date(updatedMs).toISOString(),now=new Date().toISOString(),pid=String(payment.id);
  const approved=payment.status==='approved'&&Number.isFinite(Date.parse(payment.date_approved));
  const revoked=['refunded','charged_back'].includes(payment.status)||
    (payment.status==='cancelled'&&order.winning_payment_id===pid)||
    (typeof payment.transaction_amount_refunded==='number'&&payment.transaction_amount_refunded>=order.amount);
  const status=revoked?'revoked':approved?'approved':['rejected','pending','in_process','in_mediation','cancelled'].includes(payment.status)?payment.status:'pending';
  const grantId='mp-order-'+order.id;
  // D1 batch es transaccional. Una notificación duplicada nunca extiende el período.
  await env.DB.batch([
    env.DB.prepare(`UPDATE billing_orders SET status=?1,latest_payment_id=?2,provider_updated_at=?3,updated_at=?4,
      winning_payment_id=CASE WHEN ?1 IN ('approved','revoked') THEN COALESCE(winning_payment_id,?2) ELSE winning_payment_id END
      WHERE id=?5 AND (winning_payment_id=?2 OR winning_payment_id IS NULL)
      AND (provider_updated_at IS NULL OR provider_updated_at<=?3 OR (winning_payment_id IS NULL AND latest_payment_id<>?2))
      AND NOT(status='revoked' AND ?1='approved')`).bind(status,pid,updated,now,order.id),
    env.DB.prepare(`INSERT OR IGNORE INTO subscriptions(id,firebase_uid,provider,plan_id,status,period_start,current_period_end,created_at,updated_at)
      SELECT ?1,firebase_uid,'mercadopago_one_time',plan_id,'active',?2,
      strftime('%Y-%m-%dT%H:%M:%fZ',MAX(?2,COALESCE((SELECT MAX(current_period_end) FROM subscriptions s
        WHERE s.firebase_uid=billing_orders.firebase_uid AND s.status IN ('active','authorized','cancelled')),?2)), '+'||days||' days'),?2,?2
      FROM billing_orders WHERE id=?3 AND status='approved' AND winning_payment_id=?4
      AND provider_updated_at=?5`).bind(grantId,now,order.id,pid,updated),
    env.DB.prepare(`UPDATE subscriptions SET status='expired',updated_at=?1 WHERE id=?2
      AND EXISTS(SELECT 1 FROM billing_orders WHERE id=?3 AND status='revoked' AND winning_payment_id=?4)`)
      .bind(now,grantId,order.id,pid),
    env.DB.prepare(`UPDATE users SET has_had_subscription=1,updated_at=?1 WHERE firebase_uid=?2
      AND EXISTS(SELECT 1 FROM subscriptions WHERE id=?3)`).bind(now,order.firebase_uid,grantId)
  ]);
  const result=await env.DB.prepare('SELECT * FROM billing_orders WHERE id=?1').bind(order.id).first();
  return publicOrder(result);
}
async function fetchPayment(env,id){
  if(!paymentId.test(String(id||'')))throw new BillingError(400,'Identificador de pago no válido.');
  const payment=await provider(env,'/v1/payments/'+id);
  if(String(payment.id)!==String(id))throw new BillingError(502,'Identificador recibido no válido.');
  return payment;
}
export async function reconcile(env,identity,body){
  const own=await getOrder(env,identity,body.orderId);
  if(!settings(env).ready)throw new BillingError(503,'La verificación de pagos no está configurada.');
  const row=await env.DB.prepare('SELECT latest_payment_id FROM billing_orders WHERE id=?1').bind(own.id).first();
  const id=body.paymentId||row.latest_payment_id;
  if(!id)return own;
  return applyPayment(env,await fetchPayment(env,id),own.id);
}
export async function webhook(request,env){
  if(!settings(env).ready)throw new BillingError(503,'Notificaciones no configuradas.');
  const id=new URL(request.url).searchParams.get('data.id')||'';
  const rid=request.headers.get('x-request-id')||'',header=request.headers.get('x-signature')||'';
  const parts=header.split(',').map(s=>s.trim().split('='));
  const ts=parts.filter(([key])=>key==='ts'),hash=parts.filter(([key])=>key==='v1');
  if(!paymentId.test(id)||!rid||rid.length>200||/[;\r\n]/.test(rid)||ts.length!==1||hash.length!==1||
    !/^[0-9]{1,16}$/.test(ts[0][1]||'')||!/^[0-9a-f]{64}$/i.test(hash[0][1]||''))throw new BillingError(401,'Firma no válida.');
  const key=await crypto.subtle.importKey('raw',new TextEncoder().encode(env.MP_WEBHOOK_SECRET),{name:'HMAC',hash:'SHA-256'},false,['verify']);
  const bytes=Uint8Array.from(hash[0][1].match(/../g),hex=>parseInt(hex,16));
  const manifest=`id:${id};request-id:${rid};ts:${ts[0][1]};`;
  if(!await crypto.subtle.verify('HMAC',key,bytes,new TextEncoder().encode(manifest)))throw new BillingError(401,'Firma no válida.');
  const body=await boundedJson(request);
  if(body.type!=='payment')return {ok:true,ignored:true};
  if(String(body.data?.id)!==id)throw new BillingError(400,'Identificador de notificación no válido.');
  await applyPayment(env,await fetchPayment(env,id));
  return {ok:true};
}
