import { createClient } from "@supabase/supabase-js";

// Essas duas variáveis vêm do arquivo .env (local) ou das "Environment Variables"
// configuradas no painel da Vercel (produção). Nunca coloque a service_role key
// aqui — apenas a "anon public key", que é segura para expor no navegador porque
// as regras de segurança (RLS) do Supabase controlam o que cada usuário pode ver.
const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

if (!supabaseUrl || !supabaseAnonKey) {
  console.error(
    "Faltam as variáveis VITE_SUPABASE_URL e/ou VITE_SUPABASE_ANON_KEY. " +
    "Veja o README.md para configurar."
  );
}

export const supabase = createClient(supabaseUrl, supabaseAnonKey);
