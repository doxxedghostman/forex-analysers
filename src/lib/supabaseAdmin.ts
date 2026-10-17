import { createClient } from '@supabase/supabase-js';

// Server-side only client using the service role key — this bypasses Row
// Level Security entirely, so it must NEVER be imported into any client
// component or exposed to the browser. Only use this inside API routes /
// server callbacks (like the NextAuth session callback).
export function getSupabaseAdmin() {
  const url = process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url || !serviceKey) {
    throw new Error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY environment variables');
  }

  return createClient(url, serviceKey, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
    },
  });
}
