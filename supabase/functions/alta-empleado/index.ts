// ─────────────────────────────────────────────────────────────
//  Edge Function: alta-empleado
//  La usa la sección "Equipo" del panel (solo jefes).
//
//  accion = "alta"     → crea el usuario de login (si no existe) con una
//                        contraseña temporal y lo carga en "empleados".
//  accion = "resetear" → le genera una contraseña temporal nueva.
//
//  Necesita la service_role key, por eso corre en el servidor de Supabase
//  y nunca en el navegador. SUPABASE_URL, SUPABASE_ANON_KEY y
//  SUPABASE_SERVICE_ROLE_KEY ya vienen cargadas en las Edge Functions.
// ─────────────────────────────────────────────────────────────
import { createClient } from 'npm:@supabase/supabase-js@2';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });

// Contraseña temporal fácil de dictar (sin 0/O, 1/l/I)
function passwordTemporal(largo = 10) {
  const abc = 'abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = crypto.getRandomValues(new Uint8Array(largo));
  return Array.from(bytes, b => abc[b % abc.length]).join('');
}

async function manejar(req: Request): Promise<Response> {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST')    return json({ error: 'Método no permitido.' }, 405);

  const url     = Deno.env.get('SUPABASE_URL')!;
  // La anon key también viene en el header "apikey" que manda el navegador
  const anonKey = Deno.env.get('SUPABASE_ANON_KEY') || req.headers.get('apikey') || '';
  const srvKey  = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '';
  if (!url || !anonKey || !srvKey) {
    return json({ error: 'A la función le faltan las claves de Supabase (SUPABASE_URL / SUPABASE_ANON_KEY / SUPABASE_SERVICE_ROLE_KEY).' }, 500);
  }
  const authHeader = req.headers.get('Authorization') ?? '';

  // 1) Quien llama tiene que ser jefe (se verifica con SU sesión)
  const comoUsuario = createClient(url, anonKey, { global: { headers: { Authorization: authHeader } } });
  const { data: esJefe, error: errJefe } = await comoUsuario.rpc('es_jefe');
  if (errJefe || !esJefe) return json({ error: 'Solo un Admin puede dar de alta personas.' }, 403);

  // 2) Datos
  let body: { accion?: string; email?: string; nombre?: string; rol?: string };
  try { body = await req.json(); } catch { return json({ error: 'Datos inválidos.' }, 400); }
  const accion = body.accion === 'resetear' ? 'resetear' : 'alta';
  const email  = String(body.email ?? '').trim().toLowerCase();
  const nombre = String(body.nombre ?? '').trim() || null;
  const rol    = body.rol === 'jefe' ? 'jefe' : 'empleado';
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return json({ error: 'El email no es válido.' }, 400);

  const admin = createClient(url, srvKey, { auth: { persistSession: false, autoRefreshToken: false } });
  const password = passwordTemporal();

  // 3) Usuario de login
  const { data: idExistente, error: errBuscar } = await admin.rpc('id_usuario_por_email', { p_email: email });
  if (errBuscar) return json({ error: 'No se pudo verificar el usuario: ' + errBuscar.message }, 500);

  let creado = false;
  if (accion === 'resetear') {
    if (!idExistente) return json({ error: 'Esa persona todavía no tiene usuario.' }, 404);
    const { error } = await admin.auth.admin.updateUserById(idExistente, { password });
    if (error) return json({ error: 'No se pudo cambiar la contraseña: ' + error.message }, 500);
  } else if (!idExistente) {
    const { error } = await admin.auth.admin.createUser({ email, password, email_confirm: true });
    if (error) return json({ error: 'No se pudo crear el usuario: ' + error.message }, 500);
    creado = true;
  }

  // 4) Alta en "empleados" con la sesión del jefe (así queda registrado quién lo hizo)
  if (accion === 'alta') {
    const { error } = await comoUsuario.from('empleados')
      .upsert({ email, nombre, rol, activo: true }, { onConflict: 'email' });
    if (error) return json({ error: 'Usuario creado, pero no se pudo cargar en el equipo: ' + error.message }, 500);
  }

  return json({
    ok: true,
    email,
    creado,
    // Solo se devuelve si se generó una contraseña nueva
    password: creado || accion === 'resetear' ? password : null,
  });
}

// Cualquier error inesperado vuelve como mensaje legible (y queda en Logs)
Deno.serve(async (req) => {
  try {
    return await manejar(req);
  } catch (e) {
    console.error(e);
    return json({ error: 'Error interno de la función: ' + ((e as Error)?.message ?? String(e)) }, 500);
  }
});
