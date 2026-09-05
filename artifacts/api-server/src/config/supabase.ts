import { createClient } from "@supabase/supabase-js";
import { env } from "./env.js";

export const supabaseClient = createClient(
  env.SUPABASE_URL,
  env.SUPABASE_ANON_KEY,
);

export const supabaseAdmin = createClient(
  env.SUPABASE_URL,
  env.SUPABASE_SERVICE_ROLE_KEY,
  {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
  },
);

// Dedicated client for auth operations (token verification, sign-in).
// These operations (getUser/signInWithPassword/signInWithIdToken) mutate the
// client's in-memory session and Authorization header. Keeping them off
// `supabaseAdmin` ensures service-role data queries always bypass RLS instead
// of inheriting an authenticated user's token.
export const supabaseAuth = createClient(
  env.SUPABASE_URL,
  env.SUPABASE_ANON_KEY,
  {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
  },
);
