// Datos del proyecto de Supabase → Project Settings → API.
// La "anon public key" PUEDE ir en el frontend: la seguridad la dan
// el login y las políticas RLS de la base (ver database/migrations).
// NUNCA pongas acá la "service_role key".
window.SUPABASE_CONFIG = {
  url:     '',
  anonKey: '',
};
