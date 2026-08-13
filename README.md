# Caixa da Empresa — Sistema Financeiro

Sistema de controle financeiro consolidado, com login real, banco de dados de verdade,
acessível pelo celular, tablet e computador, para até 4 pessoas usarem ao mesmo tempo.

**Arquitetura (100% gratuita para este uso):**
- **Supabase** — banco de dados (PostgreSQL) + login de usuários. Plano gratuito.
- **Vercel** — hospedagem do site, com HTTPS e link próprio. Plano gratuito.

Nenhum dos dois exige cartão de crédito para o plano gratuito.

---

## PASSO 1 — Criar o projeto no Supabase (banco de dados + login)

1. Acesse **https://supabase.com** e crie uma conta gratuita (pode ser com o Google).
2. Clique em **New project**. Dê um nome (ex: `caixa-empresa`), escolha uma senha forte
   para o banco (guarde essa senha em local seguro) e a região mais próxima (South America
   se disponível).
3. Aguarde 1–2 minutos até o projeto ficar pronto.
4. No menu lateral, vá em **SQL Editor** → **New query**.
5. Abra o arquivo `supabase/schema.sql` (está junto com este README), copie **todo** o
   conteúdo, cole no editor e clique em **Run**. Isso cria todas as tabelas, as regras de
   segurança e já insere as 3 contas (Universal, Sicoob, Gilmar) e as categorias padrão.
6. Vá em **Project Settings** (ícone de engrenagem) → **API**. Você vai precisar de dois
   valores nessa tela no próximo passo:
   - **Project URL**
   - **anon public key** (a chave pública — NÃO use a `service_role`, essa é secreta)

## PASSO 2 — Cadastrar as 4 pessoas que vão usar o sistema

1. No painel do Supabase, vá em **Authentication** → **Users** → **Add user** → **Invite user**.
2. Digite o e-mail da pessoa (ex: alessandra@suaempresa.com) e clique em convidar.
3. A pessoa recebe um e-mail com um link para criar a própria senha.
4. Repita para as 4 pessoas.
5. Assim que cada uma logar pela primeira vez, ela aparece automaticamente na tela
   **Configurações** do sistema como "Usuário de lançamento". Depois, quem for
   Administrador entra em Configurações e ajusta o perfil de cada pessoa
   (Administrador / Financeiro / Usuário de lançamento).

> Dica: convide a si mesma primeiro, faça login, e nas Configurações do sistema mude seu
> próprio perfil pra "Administrador" diretamente no banco (veja abaixo) — ou simplesmente
> rode este comando no SQL Editor do Supabase, trocando o e-mail:
>
> ```sql
> update profiles set role = 'admin'
> where id = (select id from auth.users where email = 'seu-email@suaempresa.com');
> ```

## PASSO 3 — Colocar o código no GitHub

1. Crie uma conta gratuita em **https://github.com** (se ainda não tiver).
2. Crie um repositório novo (pode ser privado) e suba todos os arquivos desta pasta
   (`financeiro-app`) para ele. Formas mais fáceis:
   - Pelo site do GitHub: "Add file" → "Upload files" → arraste todos os arquivos.
   - Ou, se tiver o `git` instalado: `git init`, `git add .`, `git commit -m "primeira versão"`,
     depois siga as instruções que o GitHub mostra para o repositório novo.

## PASSO 4 — Publicar na Vercel

1. Acesse **https://vercel.com** e crie uma conta gratuita (pode entrar direto com o GitHub).
2. Clique em **Add New → Project** e selecione o repositório que você acabou de subir.
3. A Vercel detecta automaticamente que é um projeto Vite/React — não precisa mexer nas
   configurações de build.
4. Antes de clicar em "Deploy", abra a seção **Environment Variables** e adicione:
   - `VITE_SUPABASE_URL` → cole o Project URL do Passo 1.6
   - `VITE_SUPABASE_ANON_KEY` → cole a anon public key do Passo 1.6
5. Clique em **Deploy**. Em cerca de 1 minuto, a Vercel te dá um link
   (algo como `caixa-empresa.vercel.app`) — esse é o endereço que as 4 pessoas vão usar,
   no celular, tablet ou computador.

Pronto — sistema no ar, com login de verdade e banco de dados real.

---

## Segurança

- O link da Vercel não é indexado por buscadores por padrão (não colocamos nenhum
  conteúdo público) e o `index.html` já vem com a tag `noindex` — mas ainda assim,
  **não divulgue esse link fora da equipe**.
- Toda a proteção de dados fica nas regras (RLS) do Supabase: só quem faz login
  consegue ler ou gravar qualquer informação, e só quem tem perfil "Administrador"
  pode excluir lançamentos ou gerenciar contas/categorias/pessoas.
- Cada lançamento grava quem criou (`created_by_name`) e quando — isso já é a trilha
  de auditoria básica pedida. Se quiser um histórico de alterações campo a campo,
  posso adicionar depois (exige uma tabela extra de log).

## O que ainda falta (próxima fase, combinado desde o início)

- **Anexo de comprovantes** (fotos de notas fiscais).
- **Importação da planilha atual** (Excel/CSV) com prévia e mapeamento de colunas.
- Ambos exigem um pouco mais de estrutura (armazenamento de arquivos no Supabase Storage,
  e uma tela de importação com detecção de duplicidade) — depois que você validar que os
  cálculos e o fluxo do dia a dia estão corretos, sigo para essa fase.

## Testando (checklist da sua especificação)

Depois do deploy, veja se cada item bate:

1. Cadastrar receita → aparece no dashboard e soma no "Recebido no mês".
2. Cadastrar despesa → some do saldo da conta e aparece em "Despesas reais".
3. Transferência entre contas → sai de uma, entra na outra, **não** mexe em receita/despesa.
4. Adiantamento para o Gilmar → sai da conta, aparece em "Em poder de terceiros", **não**
   conta como despesa ainda.
5. Registrar uso do adiantamento (Gilmar gastou com combustível) → agora sim vira despesa
   por categoria, sem mexer de novo no saldo da conta.
6. Despesa paga do bolso por um sócio (marcar "pendente de reembolso") → conta como despesa
   na hora, aparece em Reembolsos como pendente, sem sair de nenhuma conta ainda.
7. Pagar o reembolso → sai da conta escolhida, mas não duplica a despesa.
8. Abrir em dois celulares ao mesmo tempo, lançar em um, ver aparecer no outro (tempo real).
