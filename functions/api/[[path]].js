const FIREBASE_API_KEY = 'AIzaSyB3LZHkENqVw0ckjaWaseeO2QParuhEfBM';
const MAX_BODY_BYTES = 16 * 1024;

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function response(data, status = 200) {
  return Response.json(data, {
    status,
    headers: {
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff'
    }
  });
}

async function readJson(request) {
  const length = Number(request.headers.get('content-length') || 0);
  if (length > MAX_BODY_BYTES) throw new HttpError(413, 'Solicitud demasiado grande.');
  try {
    return await request.json();
  } catch {
    throw new HttpError(400, 'El contenido enviado no es válido.');
  }
}

async function authenticate(request) {
  const authorization = request.headers.get('authorization') || '';
  if (!authorization.startsWith('Bearer ')) throw new HttpError(401, 'Iniciá sesión nuevamente.');
  const idToken = authorization.slice(7);
  if (!idToken || idToken.length > 4096) throw new HttpError(401, 'Sesión no válida.');

  const verification = await fetch(
    `https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=${FIREBASE_API_KEY}`,
    {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({idToken})
    }
  );
  if (!verification.ok) throw new HttpError(401, 'La sesión venció. Volvé a ingresar.');
  const data = await verification.json();
  const identity = data.users?.[0];
  if (!identity?.localId || identity.disabled) throw new HttpError(401, 'Sesión no válida.');
  return {
    uid: identity.localId,
    email: identity.email || '',
    displayName: identity.displayName || ''
  };
}

async function ensureUser(db, identity) {
  const now = new Date().toISOString();
  await db.prepare(`
    INSERT INTO users (firebase_uid, email, display_name, updated_at)
    VALUES (?1, ?2, ?3, ?4)
    ON CONFLICT(firebase_uid) DO UPDATE SET
      email = excluded.email,
      display_name = CASE WHEN excluded.display_name <> '' THEN excluded.display_name ELSE users.display_name END,
      updated_at = excluded.updated_at
  `).bind(identity.uid, identity.email, identity.displayName, now).run();
}

async function activeSubscription(db, uid) {
  return db.prepare(`
    SELECT plan_id, status, current_period_end, cancel_at_period_end
    FROM subscriptions
    WHERE firebase_uid = ?1
      AND status IN ('authorized', 'active', 'cancelled')
      AND current_period_end > ?2
    ORDER BY current_period_end DESC
    LIMIT 1
  `).bind(uid, new Date().toISOString()).first();
}

async function getProfile(db, identity) {
  const [user, subscription] = await Promise.all([
    db.prepare(`
      SELECT display_name, email, theme_preference, free_measurement_used, has_had_subscription
      FROM users WHERE firebase_uid = ?1
    `).bind(identity.uid).first(),
    activeSubscription(db, identity.uid)
  ]);
  return {
    id: identity.uid,
    name: user?.display_name || identity.displayName || identity.email.split('@')[0] || 'Usuario',
    email: user?.email || identity.email,
    themePreference: user?.theme_preference || 'system',
    freeMeasurementUsed: Boolean(user?.free_measurement_used),
    hasHadSubscription: Boolean(user?.has_had_subscription),
    subscription: subscription ? {
      planId: subscription.plan_id,
      planName: subscription.plan_id === 'plus' ? 'Plus' : subscription.plan_id === 'pro' ? 'Pro' : 'Anual',
      endsAt: subscription.current_period_end,
      cancelled: Boolean(subscription.cancel_at_period_end) || subscription.status === 'cancelled'
    } : null
  };
}

function validNumber(value, minimum, maximum) {
  return typeof value === 'number' && Number.isFinite(value) && value >= minimum && value <= maximum;
}

function optionalNumber(value, minimum, maximum) {
  return value == null || validNumber(value, minimum, maximum);
}

function validateMeasurement(body) {
  const id = String(body.id || '');
  const preserveName = String(body.conserva || '').trim();
  const confidence = String(body.confidence || '').trim();
  const timestamp = String(body.timestamp || '');
  if (!/^[0-9a-f-]{36}$/i.test(id)) throw new HttpError(400, 'Identificador de medición no válido.');
  if (!preserveName || preserveName.length > 100) throw new HttpError(400, 'Nombre de conserva no válido.');
  if (!confidence || confidence.length > 80) throw new HttpError(400, 'Calidad de captura no válida.');
  if (!validNumber(body.ph, 0, 14)) throw new HttpError(400, 'Valor de pH no válido.');
  if (!timestamp || Number.isNaN(Date.parse(timestamp))) throw new HttpError(400, 'Fecha no válida.');
  if (!optionalNumber(body.lab?.l, -200, 200) || !optionalNumber(body.lab?.a, -200, 200) || !optionalNumber(body.lab?.b, -200, 200)) throw new HttpError(400, 'Datos Lab no válidos.');
  if (!optionalNumber(body.hsv?.h, 0, 360) || !optionalNumber(body.hsv?.s, 0, 100) || !optionalNumber(body.hsv?.v, 0, 100)) throw new HttpError(400, 'Datos HSV no válidos.');
  return {id, preserveName, confidence, timestamp};
}

async function route(request, env, identity, path) {
  if (request.method === 'GET' && path === 'me') {
    return response(await getProfile(env.DB, identity));
  }

  if (request.method === 'PATCH' && path === 'me') {
    const body = await readJson(request);
    const theme = String(body.themePreference || '');
    if (!['system', 'light', 'dark'].includes(theme)) throw new HttpError(400, 'Tema no válido.');
    await env.DB.prepare(`
      UPDATE users SET theme_preference = ?1, updated_at = ?2 WHERE firebase_uid = ?3
    `).bind(theme, new Date().toISOString(), identity.uid).run();
    return response({ok: true});
  }

  if (request.method === 'POST' && path === 'access/consume') {
    const subscription = await activeSubscription(env.DB, identity.uid);
    if (subscription) return response({allowed: true, unlimited: true});
    const result = await env.DB.prepare(`
      UPDATE users
      SET free_measurement_used = 1, updated_at = ?1
      WHERE firebase_uid = ?2 AND free_measurement_used = 0 AND has_had_subscription = 0
    `).bind(new Date().toISOString(), identity.uid).run();
    if (result.meta.changes === 1) return response({allowed: true, freeConsumed: true});
    throw new HttpError(403, 'No tenés mediciones disponibles. Elegí un plan para seguir midiendo.');
  }

  if (request.method === 'GET' && path === 'measurements') {
    const result = await env.DB.prepare(`
      SELECT id, preserve_name AS conserva, ph, confidence,
        lab_l, lab_a, lab_b, hsv_h, hsv_s, hsv_v,
        reference_r, reference_g, reference_b, distance, hue_distance, created_at AS timestamp
      FROM measurements
      WHERE firebase_uid = ?1
      ORDER BY created_at DESC
      LIMIT 100
    `).bind(identity.uid).all();
    return response({measurements: result.results});
  }

  if (request.method === 'POST' && path === 'measurements') {
    const body = await readJson(request);
    const clean = validateMeasurement(body);
    await env.DB.prepare(`
      INSERT OR IGNORE INTO measurements (
        id, firebase_uid, preserve_name, ph, confidence,
        lab_l, lab_a, lab_b, hsv_h, hsv_s, hsv_v,
        reference_r, reference_g, reference_b, distance, hue_distance, created_at
      ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17)
    `).bind(
      clean.id, identity.uid, clean.preserveName, body.ph, clean.confidence,
      body.lab?.l ?? null, body.lab?.a ?? null, body.lab?.b ?? null,
      body.hsv?.h ?? null, body.hsv?.s ?? null, body.hsv?.v ?? null,
      body.reference?.[0] ?? null, body.reference?.[1] ?? null, body.reference?.[2] ?? null,
      body.distance ?? null, body.hueDistance ?? null, clean.timestamp
    ).run();
    return response({ok: true}, 201);
  }

  if (request.method === 'DELETE' && path === 'measurements') {
    await env.DB.prepare('DELETE FROM measurements WHERE firebase_uid = ?1').bind(identity.uid).run();
    return response({ok: true});
  }

  throw new HttpError(404, 'Ruta no encontrada.');
}

export async function onRequest(context) {
  const path = Array.isArray(context.params.path)
    ? context.params.path.join('/')
    : String(context.params.path || '');
  try {
    if (context.request.method === 'GET' && path === 'health') {
      await context.env.DB.prepare('SELECT 1 AS connected').first();
      return response({ok: true, database: 'connected'});
    }
    const identity = await authenticate(context.request);
    await ensureUser(context.env.DB, identity);
    return await route(context.request, context.env, identity, path);
  } catch (error) {
    const status = error instanceof HttpError ? error.status : 500;
    if (status === 500) {
      console.error(JSON.stringify({message: 'api_request_failed', path, error: error instanceof Error ? error.message : String(error)}));
    }
    return response({error: status === 500 ? 'Ocurrió un error en el servidor.' : error.message}, status);
  }
}

