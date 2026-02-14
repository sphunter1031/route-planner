import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

function requiredEnv(name: string): string {
  const v = Deno.env.get(name);
  if (!v) throw new Error(`Missing env var: ${name}`);
  return v;
}

/**
 * Service Role로 DB 업데이트해야 하므로 Admin client 사용
 * (주의) 이 키는 Edge Function 서버에서만 사용.
 */
export function supabaseAdmin() {
  const url = requiredEnv("SUPABASE_URL");
  const serviceRole = requiredEnv("SUPABASE_SERVICE_ROLE_KEY");

  return createClient(url, serviceRole, {
    auth: { persistSession: false },
  });
}
