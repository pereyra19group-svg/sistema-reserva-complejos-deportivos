// Datos del proyecto de Supabase → Project Settings → API.
// La "anon public key" PUEDE ir en el frontend: la seguridad la dan
// el login y las políticas RLS de la base (ver database/migrations).
// NUNCA pongas acá la "service_role key".
window.SUPABASE_CONFIG = {
  url:     'https://avwebducuyecelxmcrmy.supabase.co',
  anonKey: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImF2d2ViZHVjdXllY2VseG1jcm15Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTA2MTc3ODgsImV4cCI6MjEwNjE5Mzc4OH0.fuOksHtz1e81wChCoNRc-n-LY_WhO9PMHw4jf6HGAI0',
};
