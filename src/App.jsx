-- ============================================================
-- ESQUEMA DO BANCO — Sistema Financeiro "Caixa da Empresa"
-- Rode este arquivo inteiro em: Supabase > SQL Editor > New query > Run
-- ============================================================

-- extensão para gerar UUID
create extension if not exists "pgcrypto";

-- ---------- PERFIS (vinculado ao login do Supabase Auth) ----------
create table if not exists profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  name text not null,
  role text not null default 'lancamento' check (role in ('admin','financeiro','lancamento')),
  created_at timestamptz default now()
);

-- cria automaticamente um perfil "lancamento" quando um novo usuário faz cadastro
create or replace function public.handle_new_user()
returns trigger as $$
begin
  insert into public.profiles (id, name, role)
  values (new.id, coalesce(new.raw_user_meta_data->>'name', new.email), 'lancamento')
  on conflict (id) do nothing;
  return new;
end;
$$ language plpgsql security definer;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute procedure public.handle_new_user();

-- ---------- CONTAS ----------
create table if not exists accounts (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  active boolean not null default true,
  saldo_inicial numeric(14,2) not null default 0,
  created_at timestamptz default now()
);

-- ---------- CATEGORIAS ----------
create table if not exists categories (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  active boolean not null default true
);

-- ---------- LANÇAMENTOS (tabela única, todos os tipos) ----------
create table if not exists transactions (
  id uuid primary key default gen_random_uuid(),
  type text not null check (type in (
    'receita','despesa','transferencia','adiantamento',
    'baixa_adiantamento','devolucao_adiantamento','reembolso_pagamento','ajuste'
  )),
  date date not null,
  valor numeric(14,2) not null check (valor > 0),
  conta uuid references accounts(id),
  conta_origem uuid references accounts(id),
  conta_destino uuid references accounts(id),
  categoria text,
  pessoa text,
  descricao text,
  observacao text,
  documento text,
  pendente_reembolso boolean default false,
  ref_adiantamento_id uuid references transactions(id),
  ref_despesa_id uuid references transactions(id),
  conferido boolean not null default false,
  created_by uuid references auth.users(id),
  created_by_name text,
  created_at timestamptz default now()
);

create index if not exists idx_transactions_date on transactions(date);
create index if not exists idx_transactions_type on transactions(type);

-- ============================================================
-- SEGURANÇA (Row Level Security)
-- Regra: qualquer pessoa autenticada (as 4 da equipe) pode ver e lançar.
-- Só quem tem role='admin' pode excluir lançamentos ou gerenciar contas/categorias.
-- ============================================================
alter table profiles enable row level security;
alter table accounts enable row level security;
alter table categories enable row level security;
alter table transactions enable row level security;

-- profiles: todo mundo autenticado pode ver a lista (pra saber nomes/perfis)
create policy "profiles_select_authenticated" on profiles for select
  using (auth.role() = 'authenticated');
create policy "profiles_update_own" on profiles for update
  using (auth.uid() = id);
create policy "profiles_update_admin" on profiles for update
  using (exists (select 1 from profiles p where p.id = auth.uid() and p.role = 'admin'));

-- accounts: leitura para autenticados; escrita/alteração só admin
create policy "accounts_select_authenticated" on accounts for select
  using (auth.role() = 'authenticated');
create policy "accounts_insert_admin" on accounts for insert
  with check (exists (select 1 from profiles where id = auth.uid() and role = 'admin'));
create policy "accounts_update_admin" on accounts for update
  using (exists (select 1 from profiles where id = auth.uid() and role = 'admin'));

-- categories: leitura para autenticados; escrita/alteração só admin
create policy "categories_select_authenticated" on categories for select
  using (auth.role() = 'authenticated');
create policy "categories_insert_admin" on categories for insert
  with check (exists (select 1 from profiles where id = auth.uid() and role = 'admin'));
create policy "categories_update_admin" on categories for update
  using (exists (select 1 from profiles where id = auth.uid() and role = 'admin'));

-- transactions: leitura para autenticados; qualquer autenticado pode inserir e marcar conferido;
-- só admin pode excluir.
create policy "transactions_select_authenticated" on transactions for select
  using (auth.role() = 'authenticated');
create policy "transactions_insert_authenticated" on transactions for insert
  with check (auth.role() = 'authenticated');
create policy "transactions_update_authenticated" on transactions for update
  using (auth.role() = 'authenticated');
create policy "transactions_delete_admin" on transactions for delete
  using (exists (select 1 from profiles where id = auth.uid() and role = 'admin'));

-- ============================================================
-- DADOS INICIAIS (contas e categorias padrão)
-- ============================================================
insert into accounts (name) values
  ('Conta Universal'), ('Conta Sicoob'), ('Conta Gilmar')
on conflict do nothing;

insert into categories (name) values
  ('Alimentação funcionários'), ('Alimentação empresa'), ('Combustível'), ('Salários'),
  ('Adiantamento salarial'), ('Vale mercado'), ('Fornecedores'), ('Material'),
  ('Equipamentos'), ('Manutenção'), ('Transporte'), ('Hospedagem'), ('Impostos'),
  ('Taxas bancárias'), ('Reembolso'), ('Despesas pessoais/sócios'),
  ('Despesas administrativas'), ('Contabilidade'), ('Jurídico'), ('Serviços'), ('Outros')
on conflict do nothing;

-- ============================================================
-- MIGRAÇÃO 07/09/2026: melhorias solicitadas (já aplicadas em produção
-- via Supabase MCP — este trecho é só para manter o schema.sql
-- sincronizado com o banco real; NÃO rodar de novo em produção)
-- ============================================================

-- Distinção conta bancária x cartão de crédito (ex: Cartão Josué)
alter table accounts
  add column if not exists tipo text not null default 'banco' check (tipo in ('banco','cartao_credito')),
  add column if not exists dia_fechamento smallint,
  add column if not exists dia_vencimento smallint;

-- Histórico de edição de lançamentos (valor antigo x novo por campo)
create table if not exists transaction_audit_log (
  id uuid primary key default gen_random_uuid(),
  transaction_id uuid not null references transactions(id) on delete cascade,
  changed_by uuid references auth.users(id),
  changed_by_name text,
  changed_at timestamptz not null default now(),
  field_name text not null,
  old_value text,
  new_value text,
  action text not null default 'edit' check (action in ('edit','delete'))
);
alter table transaction_audit_log enable row level security;

-- Despesas fixas/recorrentes: salários, boletos, parcelas de empréstimo
create table if not exists recurring_expenses (
  id uuid primary key default gen_random_uuid(),
  descricao text not null,
  categoria text,
  valor numeric not null check (valor > 0),
  dia_vencimento smallint not null check (dia_vencimento between 1 and 31),
  conta_id uuid references accounts(id),
  pessoa text,
  tipo_recorrencia text not null default 'indefinida' check (tipo_recorrencia in ('indefinida','parcelada')),
  parcelas_totais smallint,
  parcelas_restantes smallint,
  ativo boolean not null default true,
  observacao text,
  created_at timestamptz not null default now(),
  created_by uuid references auth.users(id)
);
alter table recurring_expenses enable row level security;
alter table transactions add column if not exists ref_recurring_expense_id uuid references recurring_expenses(id);

-- Funil de faturamento: orçamento -> pedido -> NF -> a receber -> recebido
create table if not exists revenue_forecast (
  id uuid primary key default gen_random_uuid(),
  cliente text not null,
  numero_orcamento text,
  numero_pedido text,
  numero_nf text,
  valor numeric not null check (valor > 0),
  status text not null default 'orcamento_enviado' check (status in (
    'orcamento_enviado','orcamento_perdido','aguardando_pedido','pedido_recebido',
    'aguardando_faturamento','nf_emitida','a_receber','recebido'
  )),
  data_emissao_nf date,
  prazo_pagamento_dias smallint,
  data_prevista_recebimento date,
  data_efetiva_recebimento date,
  transaction_id uuid references transactions(id),
  observacao text,
  created_at timestamptz not null default now(),
  created_by uuid references auth.users(id)
);
alter table revenue_forecast enable row level security;
Editar lançamento + dashboard clicável + logo
