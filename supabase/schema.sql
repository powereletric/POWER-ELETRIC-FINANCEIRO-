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
