import React, { useState, useEffect, useMemo, useCallback, useRef } from "react";
import { supabase } from "./supabaseClient";
import {
  Home, Wallet, TrendingDown, ArrowLeftRight, Users, PiggyBank,
  Landmark, BarChart3, Settings, Plus, X, Check, Clock, AlertCircle,
  ChevronDown, LogOut, Lock, Trash2, Edit2, HandCoins, Receipt,
  ListChecks, Eye, EyeOff, ArrowUpCircle, ArrowDownCircle, ArrowRightLeft,
  Mail, CreditCard, ShieldCheck, Printer, Banknote, FileCheck2, Handshake, LayoutDashboard, Timer
} from "lucide-react";
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
  PieChart, Pie, Cell, Legend, Treemap
} from "recharts";

/* ============================================================
   MODELO DE DADOS (ver supabase/schema.sql para a estrutura real)
   TIPOS DE LANÇAMENTO — mesma regra de ouro do protótipo:
   transferencia / adiantamento (emissão) / reembolso_pagamento / ajuste
   NUNCA contam como receita ou despesa real.
   ============================================================ */

const ROLES = {
  admin: { label: "Administrador", canDelete: true, canManageUsers: true, canManageConfig: true, canLancar: true, isSocio: false, isAdmin: true },
  financeiro: { label: "Financeiro", canDelete: false, canManageUsers: false, canManageConfig: false, canLancar: true, isSocio: false, isAdmin: false },
  lancamento: { label: "Usuário de lançamento", canDelete: false, canManageUsers: false, canManageConfig: false, canLancar: true, isSocio: false, isAdmin: false },
  socio: { label: "Sócio", canDelete: false, canManageUsers: false, canManageConfig: false, canLancar: false, isSocio: true, isAdmin: false },
};

const fmtBRL = (v) => (v || 0).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
// Aceita valor digitado como 1500,50 ou 1500.50 ou 1.500,50 (ponto de milhar + vírgula decimal)
function parseValorBR(str) {
  let s = String(str ?? "").trim();
  if (!s) return NaN;
  const temVirgula = s.includes(",");
  const temPonto = s.includes(".");
  if (temVirgula && temPonto) {
    // ponto = separador de milhar, vírgula = decimal (ex: 1.500,50)
    s = s.replace(/\./g, "").replace(",", ".");
  } else if (temVirgula) {
    // só vírgula → é o decimal (ex: 1500,50)
    s = s.replace(",", ".");
  }
  // só ponto, ou nenhum dos dois → já está em formato válido pro parseFloat (ex: 1500.50)
  return parseFloat(s);
}
const todayISO = () => new Date().toISOString().slice(0, 10);
// Novo início oficial do controle financeiro — julho/agosto ficam como histórico, não somem, só saem da visão padrão
const CORTE_HISTORICO = "2026-09-01";
const fmtDate = (iso) => { if (!iso) return "—"; const [y, m, d] = iso.split("-"); return `${d}/${m}/${y}`; };
const monthLabel = (m, y) => new Date(y, m - 1, 1).toLocaleDateString("pt-BR", { month: "long", year: "numeric" });

/* ---------- mapeamento camelCase (app) <-> snake_case (banco) ---------- */
function toDb(tx) {
  return {
    id: tx.id, type: tx.type, date: tx.date, valor: tx.valor,
    conta: tx.conta || null, conta_origem: tx.contaOrigem || null, conta_destino: tx.contaDestino || null,
    categoria: tx.categoria || null, pessoa: tx.pessoa || null, descricao: tx.descricao || null,
    observacao: tx.observacao || null, documento: tx.documento || null,
    pendente_reembolso: !!tx.pendenteReembolso,
    ref_adiantamento_id: tx.refAdiantamentoId || null, ref_despesa_id: tx.refDespesaId || null,
    ref_recurring_expense_id: tx.refRecurringExpenseId || null,
    conferido: !!tx.conferido, created_by: tx.createdByUid || null, created_by_name: tx.createdBy || null,
  };
}
function fromDb(row) {
  return {
    id: row.id, type: row.type, date: row.date, valor: Number(row.valor),
    conta: row.conta, contaOrigem: row.conta_origem, contaDestino: row.conta_destino,
    categoria: row.categoria, pessoa: row.pessoa, descricao: row.descricao,
    observacao: row.observacao, documento: row.documento,
    pendenteReembolso: row.pendente_reembolso, refAdiantamentoId: row.ref_adiantamento_id,
    refDespesaId: row.ref_despesa_id, refRecurringExpenseId: row.ref_recurring_expense_id, conferido: row.conferido,
    createdBy: row.created_by_name, createdAt: row.created_at,
  };
}

/* ============================================================
   MOTOR DE CÁLCULO FINANCEIRO
   ============================================================ */
function useFinanceEngine(transactions, accounts) {
  return useMemo(() => {
    // saldo "oficial" considera só o controle novo (a partir de 01/09) — jul/ago ficam de fora pra não confundir.
    // Importante: o saldo inicial de cada conta precisa estar atualizado com o valor real de 31/08 pra bater certinho.
    const atuais = transactions.filter((t) => (t.date || "") >= CORTE_HISTORICO);
    const byType = (t) => atuais.filter((x) => x.type === t);
    const saldoPorConta = {};
    accounts.forEach((a) => { saldoPorConta[a.id] = a.saldoInicial || 0; });

    byType("receita").forEach((t) => { saldoPorConta[t.conta] = (saldoPorConta[t.conta] || 0) + t.valor; });
    byType("despesa").forEach((t) => { if (!t.pendenteReembolso) saldoPorConta[t.conta] = (saldoPorConta[t.conta] || 0) - t.valor; });
    byType("transferencia").forEach((t) => {
      saldoPorConta[t.contaOrigem] = (saldoPorConta[t.contaOrigem] || 0) - t.valor;
      saldoPorConta[t.contaDestino] = (saldoPorConta[t.contaDestino] || 0) + t.valor;
    });
    byType("adiantamento").forEach((t) => { saldoPorConta[t.conta] = (saldoPorConta[t.conta] || 0) - t.valor; });
    byType("devolucao_adiantamento").forEach((t) => { saldoPorConta[t.conta] = (saldoPorConta[t.conta] || 0) + t.valor; });
    byType("reembolso_pagamento").forEach((t) => { saldoPorConta[t.conta] = (saldoPorConta[t.conta] || 0) - t.valor; });
    byType("ajuste").forEach((t) => { saldoPorConta[t.conta] = (saldoPorConta[t.conta] || 0) + t.valor; });
    byType("emprestimo_terceiro").forEach((t) => { saldoPorConta[t.conta] = (saldoPorConta[t.conta] || 0) + t.valor; });
    byType("pagamento_emprestimo").forEach((t) => { saldoPorConta[t.conta] = (saldoPorConta[t.conta] || 0) - t.valor; });

    const emprestimosMap = {};
    byType("emprestimo_terceiro").forEach((t) => {
      const key = t.pessoa || "Não identificado";
      if (!emprestimosMap[key]) emprestimosMap[key] = { pessoa: key, recebido: 0, pago: 0 };
      emprestimosMap[key].recebido += t.valor;
    });
    byType("pagamento_emprestimo").forEach((t) => {
      const key = t.pessoa || "Não identificado";
      if (!emprestimosMap[key]) emprestimosMap[key] = { pessoa: key, recebido: 0, pago: 0 };
      emprestimosMap[key].pago += t.valor;
    });
    const emprestimos = Object.values(emprestimosMap).map((e) => ({ ...e, saldoDevedor: e.recebido - e.pago }));
    const totalEmprestimosDevedor = emprestimos.reduce((s, e) => s + Math.max(0, e.saldoDevedor), 0);

    const saldoConsolidado = Object.values(saldoPorConta).reduce((s, v) => s + v, 0);

    const adiantamentos = byType("adiantamento").map((adt) => {
      const usado = byType("baixa_adiantamento").filter((b) => b.refAdiantamentoId === adt.id).reduce((s, b) => s + b.valor, 0);
      const devolvido = byType("devolucao_adiantamento").filter((d) => d.refAdiantamentoId === adt.id).reduce((s, d) => s + d.valor, 0);
      return { ...adt, usado, devolvido, saldoAPrestar: adt.valor - usado - devolvido };
    });
    const totalEmPoderDeTerceiros = adiantamentos.reduce((s, a) => s + Math.max(0, a.saldoAPrestar), 0);

    const reembolsos = byType("despesa").filter((d) => d.pendenteReembolso).map((d) => {
      const pago = byType("reembolso_pagamento").filter((p) => p.refDespesaId === d.id).reduce((s, p) => s + p.valor, 0);
      const status = pago <= 0 ? "pendente" : pago >= d.valor ? "pago" : "parcial";
      return { ...d, pago, restante: d.valor - pago, status };
    });
    const totalReembolsosPendentes = reembolsos.filter((r) => r.status !== "pago").reduce((s, r) => s + r.restante, 0);

    return { saldoPorConta, saldoConsolidado, adiantamentos, totalEmPoderDeTerceiros, reembolsos, totalReembolsosPendentes, emprestimos, totalEmprestimosDevedor };
  }, [transactions, accounts]);
}

function filterByPeriod(transactions, month, year) {
  return transactions.filter((t) => {
    if (!t.date) return false;
    const d = new Date(t.date + "T00:00:00");
    return d.getMonth() + 1 === month && d.getFullYear() === year;
  });
}
function periodTotals(periodTx) {
  const receitas = periodTx.filter((t) => t.type === "receita").reduce((s, t) => s + t.valor, 0);
  const despesasDiretas = periodTx.filter((t) => t.type === "despesa").reduce((s, t) => s + t.valor, 0);
  const baixasAdiantamento = periodTx.filter((t) => t.type === "baixa_adiantamento").reduce((s, t) => s + t.valor, 0);
  const despesas = despesasDiretas + baixasAdiantamento;
  const transferencias = periodTx.filter((t) => t.type === "transferencia").reduce((s, t) => s + t.valor, 0);
  return { receitas, despesas, transferencias, saldoPeriodo: receitas - despesas };
}
function categoryBreakdown(periodTx) {
  const map = {};
  periodTx.filter((t) => t.type === "despesa" || t.type === "baixa_adiantamento").forEach((t) => {
    const cat = t.categoria || "Outros";
    map[cat] = (map[cat] || 0) + t.valor;
  });
  return Object.entries(map).map(([name, value]) => ({ name, value })).sort((a, b) => b.value - a.value);
}
const PIE_COLORS = ["#12213B", "#B8902E", "#0E5952", "#B23A2E", "#4B5573", "#2E7D4F", "#C17F1E", "#6B4E9E", "#1C3153", "#8A6D1E"];

/* ============================================================
   COMPONENTES PEQUENOS REUTILIZÁVEIS
   ============================================================ */
function Money({ v, size = "base", tone }) {
  const color = tone === "pos" ? "var(--green)" : tone === "neg" ? "var(--red)" : "var(--ink)";
  const sizeClass = size === "lg" ? "text-2xl" : size === "sm" ? "text-sm" : "text-base";
  return <span className={`fin-mono font-semibold ${sizeClass}`} style={{ color }}>{fmtBRL(v)}</span>;
}
function Pill({ children, tone = "neutral" }) {
  const tones = {
    neutral: { bg: "#EEEAE0", fg: "var(--ink-soft)" }, green: { bg: "var(--green-soft)", fg: "var(--green)" },
    red: { bg: "var(--red-soft)", fg: "var(--red)" }, amber: { bg: "var(--amber-soft)", fg: "var(--amber)" },
    teal: { bg: "var(--teal-soft)", fg: "var(--teal)" },
  };
  const t = tones[tone] || tones.neutral;
  return <span className="px-2 py-0.5 rounded-full text-xs font-medium" style={{ background: t.bg, color: t.fg }}>{children}</span>;
}
function Card({ children, className = "", style = {} }) {
  return <div className={`fin-card rounded-xl p-4 ${className}`} style={{ background: "var(--panel)", border: "1px solid var(--line)", ...style }}>{children}</div>;
}
function Field({ label, children, required }) {
  return (
    <label className="block mb-3">
      <span className="block text-xs font-medium mb-1" style={{ color: "var(--ink-soft)" }}>{label}{required && <span style={{ color: "var(--red)" }}> *</span>}</span>
      {children}
    </label>
  );
}
const inputStyle = { width: "100%", padding: "9px 11px", borderRadius: 8, border: "1px solid var(--line)", background: "#FBFAF6", fontSize: 14 };
function TextInput(props) { return <input {...props} className={`fin-focus ${props.className || ""}`} style={{ ...inputStyle, ...(props.style || {}) }} />; }
function Select({ children, ...props }) { return <select {...props} className={`fin-focus ${props.className || ""}`} style={{ ...inputStyle, ...(props.style || {}) }}>{children}</select>; }

function Btn({ children, onClick, variant = "primary", type = "button", disabled, className = "", icon: Icon }) {
  const variants = {
    primary: { background: "var(--navy)", color: "#fff", border: "1px solid var(--navy)" },
    gold: { background: "var(--gold)", color: "#fff", border: "1px solid var(--gold)" },
    ghost: { background: "transparent", color: "var(--ink)", border: "1px solid var(--line)" },
    danger: { background: "var(--red-soft)", color: "var(--red)", border: "1px solid var(--red-soft)" },
    subtle: { background: "#EEEAE0", color: "var(--ink)", border: "1px solid #EEEAE0" },
  };
  return (
    <button type={type} onClick={onClick} disabled={disabled}
      className={`fin-btn fin-focus inline-flex items-center gap-1.5 px-3.5 py-2 rounded-lg text-sm font-medium ${disabled ? "opacity-50" : "cursor-pointer"} ${className}`}
      style={variants[variant]}>
      {Icon && <Icon size={15} />}{children}
    </button>
  );
}
function Modal({ title, onClose, children, wide }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-3" style={{ background: "rgba(18,33,59,0.55)" }}>
      <div className="fin-scroll rounded-2xl w-full overflow-y-auto" style={{ background: "var(--panel)", maxWidth: wide ? 640 : 460, maxHeight: "92vh", boxShadow: "0 20px 60px rgba(18,33,59,0.35)" }}>
        <div className="flex items-center justify-between px-5 py-4 sticky top-0" style={{ background: "var(--panel)", borderBottom: "1px solid var(--line)" }}>
          <h3 className="fin-display text-lg font-semibold">{title}</h3>
          <button onClick={onClose} className="fin-focus p-1 rounded-full" style={{ color: "var(--ink-soft)" }}><X size={20} /></button>
        </div>
        <div className="p-5">{children}</div>
      </div>
    </div>
  );
}
function EmptyState({ text }) { return <div className="text-center py-10" style={{ color: "var(--ink-soft)" }}><p className="text-sm">{text}</p></div>; }

/* Logo da empresa: procura /logo.png na raiz do site (pasta "public").
   Se o arquivo ainda não foi enviado, cai automaticamente no ícone padrão. */
function BrandMark({ size = 22 }) {
  const [failed, setFailed] = useState(false);
  if (failed) return <Landmark color="#F1E6C3" size={size} />;
  return <img src="/logo.png" alt="Logo" style={{ height: size + 6, width: "auto", objectFit: "contain" }} onError={() => setFailed(true)} />;
}

/* ============================================================
   TELA DE LOGIN (Supabase Auth — e-mail + senha de verdade)
   ============================================================ */
function LoginScreen() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPw, setShowPw] = useState(false);
  const [err, setErr] = useState("");
  const [loading, setLoading] = useState(false);
  const [resetSent, setResetSent] = useState(false);

  const submit = async (e) => {
    e.preventDefault();
    setErr(""); setLoading(true);
    const { error } = await supabase.auth.signInWithPassword({ email: email.trim(), password });
    setLoading(false);
    if (error) setErr(error.message === "Invalid login credentials" ? "E-mail ou senha incorretos." : error.message);
  };

  const forgotPassword = async () => {
    if (!email.trim()) { setErr("Digite seu e-mail acima primeiro."); return; }
    setErr("");
    const { error } = await supabase.auth.resetPasswordForEmail(email.trim());
    if (error) setErr(error.message); else setResetSent(true);
  };

  return (
    <div className="min-h-screen flex items-center justify-center p-4">
      <div className="w-full" style={{ maxWidth: 380 }}>
        <div className="text-center mb-6">
          <div className="inline-flex items-center justify-center w-14 h-14 rounded-2xl mb-3" style={{ background: "var(--navy)" }}>
            <BrandMark size={26} />
          </div>
          <h1 className="fin-display text-2xl font-semibold">Caixa da Empresa</h1>
          <p className="text-sm mt-1" style={{ color: "var(--ink-soft)" }}>Controle financeiro consolidado</p>
        </div>
        <Card>
          <form onSubmit={submit}>
            <Field label="E-mail" required><TextInput type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoFocus required /></Field>
            <Field label="Senha" required>
              <div className="relative">
                <TextInput type={showPw ? "text" : "password"} value={password} onChange={(e) => setPassword(e.target.value)} required />
                <button type="button" onClick={() => setShowPw((s) => !s)} className="absolute right-2 top-1/2 -translate-y-1/2" style={{ color: "var(--ink-soft)" }}>
                  {showPw ? <EyeOff size={16} /> : <Eye size={16} />}
                </button>
              </div>
            </Field>
            {err && <p className="text-sm mb-3" style={{ color: "var(--red)" }}>{err}</p>}
            {resetSent && <p className="text-sm mb-3" style={{ color: "var(--green)" }}>Link de redefinição enviado — confira seu e-mail.</p>}
            <Btn type="submit" variant="gold" className="w-full justify-center" icon={Lock} disabled={loading}>
              {loading ? "Entrando..." : "Entrar"}
            </Btn>
            <button type="button" onClick={forgotPassword} className="fin-focus text-xs mt-3 block mx-auto" style={{ color: "var(--ink-soft)" }}>
              Esqueci minha senha
            </button>
          </form>
        </Card>
        <p className="text-xs text-center mt-4" style={{ color: "var(--ink-soft)" }}>
          Não tem acesso ainda? Peça ao administrador para te cadastrar no painel do Supabase (Authentication → Users → Invite).
        </p>
      </div>
    </div>
  );
}

/* ============================================================
   MODAL: NOVO LANÇAMENTO
   ============================================================ */
function TransactionModal({ initialType, accounts, categories, currentUser, onClose, onSave }) {
  const activeAccounts = accounts.filter((a) => a.active);
  const [type, setType] = useState(initialType);
  const [date, setDate] = useState(todayISO());
  const [conta, setConta] = useState(activeAccounts[0]?.id || "");
  const [contaDestino, setContaDestino] = useState(activeAccounts[1]?.id || activeAccounts[0]?.id || "");
  const [valor, setValor] = useState("");
  const [categoria, setCategoria] = useState(categories[0]?.name || "");
  const [pessoa, setPessoa] = useState("");
  const [descricao, setDescricao] = useState("");
  const [observacao, setObservacao] = useState("");
  const [documento, setDocumento] = useState("");
  const [pendenteReembolso, setPendenteReembolso] = useState(false);
  const [err, setErr] = useState("");
  const [saving, setSaving] = useState(false);


  const activeCategories = categories.filter((c) => c.active);

  const typeMeta = {
    receita: { label: "Receita", icon: ArrowUpCircle },
    despesa: { label: "Despesa", icon: ArrowDownCircle },
    transferencia: { label: "Transferência", icon: ArrowRightLeft },
    adiantamento: { label: "Adiantamento a terceiro", icon: HandCoins },
    emprestimo_terceiro: { label: "Empréstimo recebido", icon: HandCoins },
    ajuste: { label: "Ajuste manual de saldo", icon: Edit2 },
  };

  const submit = async () => {
    const v = parseValorBR(valor);
    if (!v || v <= 0) { setErr("Informe um valor válido maior que zero."); return; }
    if (!date) { setErr("Informe a data."); return; }
    if (type === "transferencia" && conta === contaDestino) { setErr("A conta de origem e destino devem ser diferentes."); return; }
    if ((type === "receita" || type === "despesa" || type === "adiantamento" || type === "ajuste" || type === "emprestimo_terceiro") && !conta) { setErr("Selecione a conta."); return; }
    if (type === "transferencia" && (!conta || !contaDestino)) { setErr("Selecione as duas contas."); return; }
    if (type === "emprestimo_terceiro" && !pessoa.trim()) { setErr("Informe o nome de quem emprestou."); return; }

    const base = {
      type, date, valor: v, descricao: descricao.trim(), observacao: observacao.trim(),
      documento: documento.trim(), pessoa: pessoa.trim(), conferido: false,
      createdBy: currentUser.name, createdByUid: currentUser.id,
    };
    let tx = { ...base };
    if (type === "receita") tx = { ...tx, conta, categoria };
    if (type === "despesa") tx = { ...tx, conta, categoria, pendenteReembolso };
    if (type === "transferencia") tx = { ...tx, contaOrigem: conta, contaDestino };
    if (type === "adiantamento") tx = { ...tx, conta };
    if (type === "emprestimo_terceiro") tx = { ...tx, conta };
    if (type === "ajuste") tx = { ...tx, conta, descricao: descricao.trim() };

    setSaving(true);
    const ok = await onSave(tx);
    setSaving(false);
    if (!ok) setErr("Não consegui salvar. Tente novamente.");
  };

  return (
    <Modal title="Novo lançamento" onClose={onClose}>
      <div className="flex gap-2 mb-4 flex-wrap">
        {Object.entries(typeMeta).map(([k, m]) => (
          <button key={k} onClick={() => setType(k)}
            className="fin-focus fin-btn flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium"
            style={{ background: type === k ? "var(--navy)" : "#EEEAE0", color: type === k ? "#fff" : "var(--ink)" }}>
            <m.icon size={14} />{m.label}
          </button>
        ))}
      </div>

      <div className="grid grid-cols-2 gap-3">
        <Field label="Data" required><TextInput type="date" value={date} onChange={(e) => setDate(e.target.value)} /></Field>
        <Field label="Valor (R$)" required><TextInput inputMode="decimal" placeholder="0,00" value={valor} onChange={(e) => setValor(e.target.value)} /></Field>
      </div>

      {(type === "receita" || type === "despesa" || type === "adiantamento" || type === "ajuste" || type === "emprestimo_terceiro") && (
        <Field label={type === "emprestimo_terceiro" ? "Conta que recebeu o empréstimo" : "Conta"} required>
          <Select value={conta} onChange={(e) => setConta(e.target.value)}>
            {activeAccounts.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
          </Select>
        </Field>
      )}
      {type === "transferencia" && (
        <div className="grid grid-cols-2 gap-3">
          <Field label="Conta origem" required>
            <Select value={conta} onChange={(e) => setConta(e.target.value)}>{activeAccounts.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}</Select>
          </Field>
          <Field label="Conta destino" required>
            <Select value={contaDestino} onChange={(e) => setContaDestino(e.target.value)}>{activeAccounts.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}</Select>
          </Field>
        </div>
      )}
      {(type === "receita" || type === "despesa") && (
        <Field label="Categoria"><Select value={categoria} onChange={(e) => setCategoria(e.target.value)}>{activeCategories.map((c) => <option key={c.id} value={c.name}>{c.name}</option>)}</Select></Field>
      )}
      {type === "despesa" && (
        <label className="flex items-center gap-2 mb-3 text-sm cursor-pointer">
          <input type="checkbox" checked={pendenteReembolso} onChange={(e) => setPendenteReembolso(e.target.checked)} />
          Foi paga por alguém do próprio bolso (gera reembolso pendente, não sai de nenhuma conta agora)
        </label>
      )}
      <Field label={type === "adiantamento" ? "Pessoa que vai receber o adiantamento" : type === "emprestimo_terceiro" ? "Quem emprestou o dinheiro" : "Pessoa / beneficiário"}>
        <TextInput value={pessoa} onChange={(e) => setPessoa(e.target.value)} placeholder="Nome" />
      </Field>
      <Field label="Nº documento / observação">
        <div className="grid grid-cols-2 gap-2">
          <TextInput value={documento} onChange={(e) => setDocumento(e.target.value)} placeholder="Nº NF, recibo..." />
          <TextInput value={observacao} onChange={(e) => setObservacao(e.target.value)} placeholder="Observação livre" />
        </div>
      </Field>

      {err && <p className="text-sm mb-2" style={{ color: "var(--red)" }}>{err}</p>}
      <div className="flex justify-end gap-2 mt-2">
        <Btn variant="ghost" onClick={onClose}>Cancelar</Btn>
        <Btn variant="gold" icon={Check} onClick={submit} disabled={saving}>{saving ? "Salvando..." : "Salvar lançamento"}</Btn>
      </div>
    </Modal>
  );
}

/* ============================================================
   MODAL: EDITAR LANÇAMENTO
   Permite corrigir um lançamento já salvo sem apagar e recadastrar.
   Toda alteração grava o valor antigo x novo em transaction_audit_log.
   ============================================================ */
function EditTransactionModal({ tx, accounts, categories, currentUser, onClose, onSave }) {
  const activeAccounts = accounts.filter((a) => a.active || a.id === tx.conta || a.id === tx.contaOrigem || a.id === tx.contaDestino);
  const [date, setDate] = useState(tx.date || "");
  const [valor, setValor] = useState(String(tx.valor ?? "").replace(".", ","));
  const [conta, setConta] = useState(tx.conta || tx.contaOrigem || activeAccounts[0]?.id || "");
  const [contaDestino, setContaDestino] = useState(tx.contaDestino || activeAccounts[0]?.id || "");
  const [categoria, setCategoria] = useState(tx.categoria || "");
  const [pessoa, setPessoa] = useState(tx.pessoa || "");
  const [descricao, setDescricao] = useState(tx.descricao || "");
  const [observacao, setObservacao] = useState(tx.observacao || "");
  const [documento, setDocumento] = useState(tx.documento || "");
  const [err, setErr] = useState("");
  const [saving, setSaving] = useState(false);
  const activeCategories = categories.filter((c) => c.active || c.name === tx.categoria);
  const isTransfer = tx.type === "transferencia";

  const submit = async () => {
    const v = parseValorBR(valor);
    if (!v || v <= 0) { setErr("Informe um valor válido maior que zero."); return; }
    if (!date) { setErr("Informe a data."); return; }
    setSaving(true);
    const updated = {
      ...tx, date, valor: v, categoria: categoria || null, pessoa: pessoa.trim(),
      descricao: descricao.trim(), observacao: observacao.trim(), documento: documento.trim(),
      ...(isTransfer ? { contaOrigem: conta, contaDestino } : { conta }),
    };
    const ok = await onSave(tx, updated);
    setSaving(false);
    if (!ok) setErr("Não consegui salvar a edição. Tente novamente.");
  };

  return (
    <Modal title="Editar lançamento" onClose={onClose}>
      <Card className="mb-4" style={{ background: "var(--amber-soft)", border: "none" }}>
        <p className="text-xs">Toda alteração fica registrada no histórico do lançamento — data, valor e usuário que editou.</p>
      </Card>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Data" required><TextInput type="date" value={date} onChange={(e) => setDate(e.target.value)} /></Field>
        <Field label="Valor (R$)" required><TextInput inputMode="decimal" value={valor} onChange={(e) => setValor(e.target.value)} /></Field>
      </div>
      {isTransfer ? (
        <div className="grid grid-cols-2 gap-3">
          <Field label="Conta origem"><Select value={conta} onChange={(e) => setConta(e.target.value)}>{activeAccounts.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}</Select></Field>
          <Field label="Conta destino"><Select value={contaDestino} onChange={(e) => setContaDestino(e.target.value)}>{activeAccounts.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}</Select></Field>
        </div>
      ) : (
        <Field label="Conta"><Select value={conta} onChange={(e) => setConta(e.target.value)}>{activeAccounts.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}</Select></Field>
      )}
      {(tx.type === "receita" || tx.type === "despesa") && (
        <Field label="Categoria"><Select value={categoria} onChange={(e) => setCategoria(e.target.value)}>{activeCategories.map((c) => <option key={c.id} value={c.name}>{c.name}</option>)}</Select></Field>
      )}
      <Field label="Pessoa / beneficiário"><TextInput value={pessoa} onChange={(e) => setPessoa(e.target.value)} /></Field>
      <Field label="Descrição"><TextInput value={descricao} onChange={(e) => setDescricao(e.target.value)} /></Field>
      <Field label="Nº documento / observação">
        <div className="grid grid-cols-2 gap-2">
          <TextInput value={documento} onChange={(e) => setDocumento(e.target.value)} placeholder="Nº NF, recibo..." />
          <TextInput value={observacao} onChange={(e) => setObservacao(e.target.value)} placeholder="Observação livre" />
        </div>
      </Field>
      {err && <p className="text-sm mb-2" style={{ color: "var(--red)" }}>{err}</p>}
      <div className="flex justify-end gap-2 mt-2">
        <Btn variant="ghost" onClick={onClose}>Cancelar</Btn>
        <Btn variant="gold" icon={Check} onClick={submit} disabled={saving}>{saving ? "Salvando..." : "Salvar alterações"}</Btn>
      </div>
    </Modal>
  );
}

/* ============================================================
   MODAIS: BAIXA DE ADIANTAMENTO / DEVOLUÇÃO / PAGAMENTO DE REEMBOLSO
   ============================================================ */
function BaixaAdiantamentoModal({ adiantamento, categories, accounts, currentUser, onClose, onSave }) {
  const [valor, setValor] = useState("");
  const [categoria, setCategoria] = useState(categories[0]?.name || "");
  const [descricao, setDescricao] = useState("");
  const [conta, setConta] = useState(adiantamento.conta || accounts[0]?.id || "");
  const [date, setDate] = useState(todayISO());
  const [err, setErr] = useState("");
  const [saving, setSaving] = useState(false);

  const submit = async () => {
    const v = parseValorBR(valor);
    if (!v || v <= 0) { setErr("Informe um valor válido."); return; }
    if (v > adiantamento.saldoAPrestar + 0.009) { setErr(`O saldo disponível com ${adiantamento.pessoa} é de ${fmtBRL(adiantamento.saldoAPrestar)}.`); return; }
    setSaving(true);
    const ok = await onSave({
      type: "baixa_adiantamento", date, valor: v, categoria, descricao: descricao.trim(), conta,
      pessoa: adiantamento.pessoa, refAdiantamentoId: adiantamento.id, conferido: false,
      createdBy: currentUser.name, createdByUid: currentUser.id,
    });
    setSaving(false);
    if (!ok) setErr("Não consegui salvar. Tente novamente.");
  };

  return (
    <Modal title={`Uso do adiantamento — ${adiantamento.pessoa}`} onClose={onClose}>
      <Card className="mb-4" style={{ background: "var(--amber-soft)", border: "none" }}>
        <p className="text-sm">Saldo em poder de <b>{adiantamento.pessoa}</b>: <Money v={adiantamento.saldoAPrestar} /></p>
      </Card>
      <Field label="Data"><TextInput type="date" value={date} onChange={(e) => setDate(e.target.value)} /></Field>
      <Field label="Valor gasto (R$)" required><TextInput inputMode="decimal" value={valor} onChange={(e) => setValor(e.target.value)} placeholder="0,00" /></Field>
      <Field label="Conta que originou esse dinheiro">
        <Select value={conta} onChange={(e) => setConta(e.target.value)}>{accounts.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}</Select>
      </Field>
      <Field label="Categoria"><Select value={categoria} onChange={(e) => setCategoria(e.target.value)}>{categories.map((c) => <option key={c.id} value={c.name}>{c.name}</option>)}</Select></Field>
      <Field label="Descrição"><TextInput value={descricao} onChange={(e) => setDescricao(e.target.value)} placeholder="Ex: Combustível" /></Field>
      {err && <p className="text-sm mb-2" style={{ color: "var(--red)" }}>{err}</p>}
      <div className="flex justify-end gap-2 mt-2">
        <Btn variant="ghost" onClick={onClose}>Cancelar</Btn>
        <Btn variant="gold" icon={Check} onClick={submit} disabled={saving}>{saving ? "Salvando..." : "Registrar despesa"}</Btn>
      </div>
    </Modal>
  );
}

function DevolucaoAdiantamentoModal({ adiantamento, accounts, currentUser, onClose, onSave }) {
  const [valor, setValor] = useState(String(adiantamento.saldoAPrestar.toFixed(2)).replace(".", ","));
  const [conta, setConta] = useState(accounts[0]?.id || "");
  const [date, setDate] = useState(todayISO());
  const [err, setErr] = useState("");
  const [saving, setSaving] = useState(false);

  const submit = async () => {
    const v = parseValorBR(valor);
    if (!v || v <= 0) { setErr("Informe um valor válido."); return; }
    if (v > adiantamento.saldoAPrestar + 0.009) { setErr("Valor maior que o saldo disponível."); return; }
    setSaving(true);
    const ok = await onSave({
      type: "devolucao_adiantamento", date, valor: v, conta, pessoa: adiantamento.pessoa,
      refAdiantamentoId: adiantamento.id, conferido: false, createdBy: currentUser.name, createdByUid: currentUser.id,
    });
    setSaving(false);
    if (!ok) setErr("Não consegui salvar. Tente novamente.");
  };
  return (
    <Modal title={`Devolução de saldo — ${adiantamento.pessoa}`} onClose={onClose}>
      <Field label="Data"><TextInput type="date" value={date} onChange={(e) => setDate(e.target.value)} /></Field>
      <Field label="Valor devolvido (R$)" required><TextInput inputMode="decimal" value={valor} onChange={(e) => setValor(e.target.value)} /></Field>
      <Field label="Conta que recebeu a devolução"><Select value={conta} onChange={(e) => setConta(e.target.value)}>{accounts.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}</Select></Field>
      {err && <p className="text-sm mb-2" style={{ color: "var(--red)" }}>{err}</p>}
      <div className="flex justify-end gap-2 mt-2">
        <Btn variant="ghost" onClick={onClose}>Cancelar</Btn>
        <Btn variant="gold" icon={Check} onClick={submit} disabled={saving}>{saving ? "Salvando..." : "Registrar devolução"}</Btn>
      </div>
    </Modal>
  );
}

function PagamentoReembolsoModal({ reembolso, accounts, currentUser, onClose, onSave }) {
  const [valor, setValor] = useState(String(reembolso.restante.toFixed(2)).replace(".", ","));
  const [conta, setConta] = useState(accounts[0]?.id || "");
  const [date, setDate] = useState(todayISO());
  const [err, setErr] = useState("");
  const [saving, setSaving] = useState(false);

  const submit = async () => {
    const v = parseValorBR(valor);
    if (!v || v <= 0) { setErr("Informe um valor válido."); return; }
    if (v > reembolso.restante + 0.009) { setErr("Valor maior que o restante a pagar."); return; }
    setSaving(true);
    const ok = await onSave({
      type: "reembolso_pagamento", date, valor: v, conta, pessoa: reembolso.pessoa,
      refDespesaId: reembolso.id, conferido: false, createdBy: currentUser.name, createdByUid: currentUser.id,
    });
    setSaving(false);
    if (!ok) setErr("Não consegui salvar. Tente novamente.");
  };
  return (
    <Modal title={`Pagar reembolso — ${reembolso.pessoa}`} onClose={onClose}>
      <Card className="mb-4" style={{ background: "var(--teal-soft)", border: "none" }}>
        <p className="text-sm">{reembolso.descricao || reembolso.categoria} — despesa de <Money v={reembolso.valor} size="sm" /></p>
        <p className="text-sm mt-1">Já pago: <Money v={reembolso.pago} size="sm" /> · Restante: <Money v={reembolso.restante} size="sm" /></p>
      </Card>
      <Field label="Data do pagamento"><TextInput type="date" value={date} onChange={(e) => setDate(e.target.value)} /></Field>
      <Field label="Valor a pagar agora (R$)" required><TextInput inputMode="decimal" value={valor} onChange={(e) => setValor(e.target.value)} /></Field>
      <Field label="Conta pagadora"><Select value={conta} onChange={(e) => setConta(e.target.value)}>{accounts.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}</Select></Field>
      {err && <p className="text-sm mb-2" style={{ color: "var(--red)" }}>{err}</p>}
      <div className="flex justify-end gap-2 mt-2">
        <Btn variant="ghost" onClick={onClose}>Cancelar</Btn>
        <Btn variant="gold" icon={Check} onClick={submit} disabled={saving}>{saving ? "Salvando..." : "Confirmar pagamento"}</Btn>
      </div>
    </Modal>
  );
}

/* ============================================================
   EMPRÉSTIMOS DE TERCEIROS (Conta Gilmar e afins)
   ============================================================ */
function PagamentoEmprestimoModal({ emprestimo, accounts, currentUser, onClose, onSave }) {
  const [valor, setValor] = useState(String(emprestimo.saldoDevedor.toFixed(2)).replace(".", ","));
  const [conta, setConta] = useState(accounts[0]?.id || "");
  const [date, setDate] = useState(todayISO());
  const [err, setErr] = useState("");
  const [saving, setSaving] = useState(false);

  const submit = async () => {
    const v = parseValorBR(valor);
    if (!v || v <= 0) { setErr("Informe um valor válido."); return; }
    if (v > emprestimo.saldoDevedor + 0.009) { setErr("Valor maior que o saldo devedor."); return; }
    setSaving(true);
    const ok = await onSave({
      type: "pagamento_emprestimo", date, valor: v, conta, pessoa: emprestimo.pessoa,
      conferido: false, createdBy: currentUser.name, createdByUid: currentUser.id,
    });
    setSaving(false);
    if (!ok) setErr("Não consegui salvar. Tente novamente.");
  };
  return (
    <Modal title={`Pagar empréstimo — ${emprestimo.pessoa}`} onClose={onClose}>
      <Card className="mb-4" style={{ background: "var(--amber-soft)", border: "none" }}>
        <p className="text-sm">Recebido: <Money v={emprestimo.recebido} size="sm" /> · Já devolvido: <Money v={emprestimo.pago} size="sm" /></p>
        <p className="text-sm mt-1">Saldo devedor: <Money v={emprestimo.saldoDevedor} size="sm" tone="neg" /></p>
      </Card>
      <Field label="Data do pagamento"><TextInput type="date" value={date} onChange={(e) => setDate(e.target.value)} /></Field>
      <Field label="Valor a devolver agora (R$)" required><TextInput inputMode="decimal" value={valor} onChange={(e) => setValor(e.target.value)} /></Field>
      <Field label="Conta pagadora"><Select value={conta} onChange={(e) => setConta(e.target.value)}>{accounts.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}</Select></Field>
      {err && <p className="text-sm mb-2" style={{ color: "var(--red)" }}>{err}</p>}
      <div className="flex justify-end gap-2 mt-2">
        <Btn variant="ghost" onClick={onClose}>Cancelar</Btn>
        <Btn variant="gold" icon={Check} onClick={submit} disabled={saving}>{saving ? "Salvando..." : "Confirmar devolução"}</Btn>
      </div>
    </Modal>
  );
}

function EmprestimosView({ engine, onPagar }) {
  const abertos = engine.emprestimos.filter((e) => e.saldoDevedor > 0.009);
  const quitados = engine.emprestimos.filter((e) => e.saldoDevedor <= 0.009);
  return (
    <div className="space-y-5">
      <Card style={{ background: "var(--amber-soft)", border: "none" }}>
        <p className="text-sm">Dinheiro emprestado por terceiros (não é receita) pra pagar contas da empresa — e o que ainda falta devolver.</p>
      </Card>
      <div>
        <p className="font-semibold mb-2 fin-display">Em aberto</p>
        {abertos.length === 0 ? <EmptyState text="Nenhum empréstimo em aberto." /> : (
          <Card className="p-0 overflow-hidden">
            {abertos.map((e, i) => (
              <div key={e.pessoa} className="flex items-center justify-between px-4 py-3" style={{ borderTop: i ? "1px solid var(--line)" : "none" }}>
                <div>
                  <p className="text-sm font-medium">{e.pessoa}</p>
                  <p className="text-xs" style={{ color: "var(--ink-soft)" }}>Recebido <Money v={e.recebido} size="sm" /> · Devolvido <Money v={e.pago} size="sm" /></p>
                </div>
                <div className="flex items-center gap-3">
                  <Money v={e.saldoDevedor} size="sm" tone="neg" />
                  <Btn variant="gold" onClick={() => onPagar(e)}>Registrar devolução</Btn>
                </div>
              </div>
            ))}
          </Card>
        )}
      </div>
      {quitados.length > 0 && (
        <div>
          <p className="font-semibold mb-2 fin-display" style={{ color: "var(--ink-soft)" }}>Quitados</p>
          <Card className="p-0 overflow-hidden">
            {quitados.map((e, i) => (
              <div key={e.pessoa} className="flex items-center justify-between px-4 py-2.5 text-sm" style={{ borderTop: i ? "1px solid var(--line)" : "none", opacity: 0.7 }}>
                <span>{e.pessoa}</span><Money v={e.recebido} size="sm" />
              </div>
            ))}
          </Card>
        </div>
      )}
    </div>
  );
}

/* ============================================================
   VIEW: DASHBOARD
   ============================================================ */
const CATEGORY_EMOJI = [
  [/ped[aá]gio|deslocamento/i, "🛣️"],
  [/alimenta/i, "🍽️"], [/combust/i, "⛽"], [/sal[aá]rio/i, "👷"], [/manuten|pneu/i, "🔧"],
  [/fornecedor/i, "🧾"], [/imposto|taxa/i, "🏛️"], [/s[oó]cio/i, "👥"], [/reembolso/i, "↩️"],
  [/transporte|frete/i, "🚚"], [/material|equipamento/i, "🧰"], [/hospedagem/i, "🏨"],
  [/jur[ií]dico/i, "⚖️"], [/contabilidade/i, "📑"], [/servi[cç]o/i, "🛠️"], [/adiantamento/i, "💵"],
  [/viagem/i, "✈️"],
];
function categoryEmoji(name) {
  const hit = CATEGORY_EMOJI.find(([re]) => re.test(name || ""));
  return hit ? hit[1] : "📂";
}
// Prioriza o emoji escolhido manualmente na categoria; se não tiver, tenta adivinhar pelo nome
function resolveCategoryEmoji(categories, name) {
  const cat = (categories || []).find((c) => c.name === name);
  if (cat?.emoji) return cat.emoji;
  return categoryEmoji(name);
}
const QUICK_EMOJIS = ["🍽️", "⛽", "🛣️", "👷", "🔧", "🧾", "🏛️", "👥", "↩️", "🚚", "🧰", "🏨", "⚖️", "📑", "🛠️", "💵", "✈️", "📂", "🏦", "💳", "🛒", "📦", "🧹", "🎓"];
function DashboardView({ accounts, transactions, engine, onQuickAction, role, categories, despesasPrevistas, contasReceber, recurringExpenses }) {
  const now = new Date();
  const [month, setMonth] = useState(now.getMonth() + 1);
  const [year, setYear] = useState(now.getFullYear());
  const periodTx = filterByPeriod(transactions, month, year);
  const totals = periodTotals(periodTx);
  const activeAccounts = accounts.filter((a) => a.active);
  const [drill, setDrill] = useState(null); // null | "receitas" | "despesas"
  const [drillCategoria, setDrillCategoria] = useState(null);
  const despesasPeriodo = periodTx.filter((t) => t.type === "despesa" || t.type === "baixa_adiantamento");
  const receitasPeriodo = periodTx.filter((t) => t.type === "receita");
  const despesasPorCategoria = categoryBreakdown(periodTx);
  const closeDrill = () => { setDrill(null); setDrillCategoria(null); };

  const quick = [
    { type: "receita", label: "Receita", icon: ArrowUpCircle, tone: "var(--green)" },
    { type: "despesa", label: "Despesa", icon: ArrowDownCircle, tone: "var(--red)" },
    { type: "transferencia", label: "Transferência", icon: ArrowRightLeft, tone: "var(--teal)" },
    { type: "adiantamento", label: "Adiantamento", icon: HandCoins, tone: "var(--amber)" },
  ];

  return (
    <div className="space-y-5">
      <Card style={{ background: "var(--navy)", border: "none" }} className="text-white">
        <p className="text-xs uppercase tracking-wide" style={{ color: "var(--gold-soft)" }}>Dinheiro da empresa — saldo consolidado</p>
        <p className="fin-mono fin-display font-semibold mt-1" style={{ fontSize: 40 }}>{fmtBRL(engine.saldoConsolidado)}</p>
        <div className="flex flex-wrap gap-4 mt-4">
          {activeAccounts.map((a) => (
            <div key={a.id} className="rounded-lg px-3 py-2" style={{ background: "rgba(255,255,255,0.08)" }}>
              <p className="text-xs" style={{ color: "var(--gold-soft)" }}>{a.name}</p>
              <p className="fin-mono font-semibold">{fmtBRL(engine.saldoPorConta[a.id] || 0)}</p>
            </div>
          ))}
        </div>
      </Card>

      {(() => {
        const em7dias = new Date(); em7dias.setDate(em7dias.getDate() + 7);
        const limite = em7dias.toISOString().slice(0, 10);
        const despesasVencendo = (despesasPrevistas || []).filter((d) => d.status !== "paga" && (d.data_vencimento || "") <= limite);
        const notasVencendo = (contasReceber || []).filter((n) => n.status !== "recebido" && (n.data_prevista_recebimento || "") <= limite);
        const total = despesasVencendo.length + notasVencendo.length;
        if (total === 0) return null;
        let texto;
        if (despesasVencendo.length > 0 && notasVencendo.length > 0) {
          texto = `${total} contas vencendo ou já vencidas nos próximos 7 dias — ${despesasVencendo.length} a pagar · ${notasVencendo.length} a receber`;
        } else if (despesasVencendo.length > 0) {
          texto = `${despesasVencendo.length} despesa${despesasVencendo.length > 1 ? "s" : ""} a pagar vencendo ou já vencida${despesasVencendo.length > 1 ? "s" : ""} nos próximos 7 dias`;
        } else {
          texto = `${notasVencendo.length} nota${notasVencendo.length > 1 ? "s" : ""} a receber vencendo ou já vencida${notasVencendo.length > 1 ? "s" : ""} nos próximos 7 dias`;
        }
        return (
          <Card style={{ background: "var(--amber-soft)", border: "none" }} className="flex items-center gap-2">
            <AlertCircle size={18} style={{ color: "var(--amber)" }} />
            <p className="text-sm">{texto}</p>
          </Card>
        );
      })()}

      {!role?.isSocio && (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          {quick.map((q) => (
            <button key={q.type} onClick={() => onQuickAction(q.type)} className="fin-btn fin-card fin-focus rounded-xl p-4 text-left" style={{ background: "var(--panel)", border: "1px solid var(--line)" }}>
              <q.icon size={22} style={{ color: q.tone }} />
              <p className="font-semibold text-sm mt-2">{q.label}</p>
            </button>
          ))}
        </div>
      )}

      <div className="flex items-center gap-2 flex-wrap">
        <Select value={month} onChange={(e) => setMonth(Number(e.target.value))} style={{ width: 160 }}>
          {Array.from({ length: 12 }, (_, i) => i + 1).map((m) => <option key={m} value={m}>{new Date(2000, m - 1, 1).toLocaleDateString("pt-BR", { month: "long" })}</option>)}
        </Select>
        <Select value={year} onChange={(e) => setYear(Number(e.target.value))} style={{ width: 110 }}>
          {[year - 1, year, year + 1].map((y) => <option key={y} value={y}>{y}</option>)}
        </Select>
        <span className="text-sm capitalize" style={{ color: "var(--ink-soft)" }}>{monthLabel(month, year)}</span>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <button onClick={() => setDrill("receitas")} className="fin-btn fin-card fin-focus text-left rounded-xl" style={{ cursor: receitasPeriodo.length ? "pointer" : "default" }}>
          <Card><p className="text-xs" style={{ color: "var(--ink-soft)" }}>💰 Recebido no mês</p><Money v={totals.receitas} tone="pos" size="lg" /></Card>
        </button>
        <button onClick={() => setDrill("despesas")} className="fin-btn fin-card fin-focus text-left rounded-xl" style={{ cursor: despesasPeriodo.length ? "pointer" : "default" }}>
          <Card><p className="text-xs" style={{ color: "var(--ink-soft)" }}>💸 Despesas do mês</p><Money v={totals.despesas} tone="neg" size="lg" /></Card>
        </button>
        <Card><p className="text-xs" style={{ color: "var(--ink-soft)" }}>🔄 Transferências internas</p><Money v={totals.transferencias} size="lg" /></Card>
        <Card><p className="text-xs" style={{ color: "var(--ink-soft)" }}>💵 Saldo do mês</p><Money v={totals.saldoPeriodo} tone={totals.saldoPeriodo >= 0 ? "pos" : "neg"} size="lg" /></Card>
      </div>

      {despesasPorCategoria.length > 0 && (
        <div>
          <p className="font-semibold mb-2 fin-display" style={{ color: "var(--ink-soft)" }}>Com o que a Power gastou este mês</p>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            {despesasPorCategoria.map((c) => (
              <button key={c.name} onClick={() => { setDrill("despesas"); setDrillCategoria(c.name); }} className="fin-btn fin-card fin-focus text-left rounded-xl">
                <Card>
                  <p className="text-xs truncate" style={{ color: "var(--ink-soft)" }}>{resolveCategoryEmoji(categories, c.name)} {c.name}</p>
                  <Money v={c.value} tone="neg" />
                </Card>
              </button>
            ))}
          </div>
        </div>
      )}

      {drill === "receitas" && (
        <Modal title={`Recebimentos — ${monthLabel(month, year)}`} onClose={closeDrill} wide>
          {receitasPeriodo.length === 0 ? <EmptyState text="Nenhum recebimento neste período." /> : (
            <div className="divide-y" style={{ borderColor: "var(--line)" }}>
              {[...receitasPeriodo].sort((a, b) => (b.date || "").localeCompare(a.date || "")).map((t) => (
                <div key={t.id} className="flex items-center justify-between py-2.5">
                  <div>
                    <p className="text-sm font-medium">{t.pessoa || t.descricao || "Recebimento"}</p>
                    <p className="text-xs" style={{ color: "var(--ink-soft)" }}>
                      {fmtDate(t.date)} · {accName(accounts, t.conta)}{t.documento ? ` · Doc. ${t.documento}` : ""}{t.categoria ? ` · ${t.categoria}` : ""}
                    </p>
                  </div>
                  <Money v={t.valor} tone="pos" size="sm" />
                </div>
              ))}
            </div>
          )}
        </Modal>
      )}

      {drill === "despesas" && !drillCategoria && (
        <Modal title={`Despesas reais — ${monthLabel(month, year)}`} onClose={closeDrill} wide>
          {despesasPorCategoria.length === 0 ? <EmptyState text="Nenhuma despesa neste período." /> : (
            <div className="divide-y" style={{ borderColor: "var(--line)" }}>
              {despesasPorCategoria.map((c) => (
                <button key={c.name} onClick={() => setDrillCategoria(c.name)} className="fin-btn fin-focus w-full flex items-center justify-between py-2.5 text-left">
                  <span className="text-sm font-medium">{c.name}</span>
                  <Money v={c.value} tone="neg" size="sm" />
                </button>
              ))}
              <div className="flex items-center justify-between py-2.5 pt-3" style={{ borderTop: "2px solid var(--line)" }}>
                <span className="text-sm font-semibold">Total</span>
                <Money v={totals.despesas} tone="neg" />
              </div>
            </div>
          )}
        </Modal>
      )}

      {drill === "despesas" && drillCategoria && (
        <Modal title={drillCategoria} onClose={() => setDrillCategoria(null)} wide>
          <div className="divide-y" style={{ borderColor: "var(--line)" }}>
            {despesasPeriodo.filter((t) => (t.categoria || "Outros") === drillCategoria)
              .sort((a, b) => (b.date || "").localeCompare(a.date || ""))
              .map((t) => (
                <div key={t.id} className="py-2.5">
                  <div className="flex items-center justify-between">
                    <p className="text-sm font-medium">{t.descricao ? (t.descricao + (t.pessoa ? ` · ${t.pessoa}` : "")) : (t.pessoa || "—")}</p>
                    <Money v={t.valor} tone="neg" size="sm" />
                  </div>
                  <p className="text-xs" style={{ color: "var(--ink-soft)" }}>
                    {fmtDate(t.date)} · {accName(accounts, t.conta)}{t.documento ? ` · Doc. ${t.documento}` : ""}
                  </p>
                </div>
              ))}
          </div>
          <Btn variant="ghost" className="mt-3" onClick={() => setDrillCategoria(null)}>← Voltar às categorias</Btn>
        </Modal>
      )}

      <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
        <Card>
          <div className="flex items-center gap-2 mb-1"><AlertCircle size={16} style={{ color: "var(--red)" }} /><p className="text-xs font-medium" style={{ color: "var(--ink-soft)" }}>Reembolsos pendentes</p></div>
          <Money v={engine.totalReembolsosPendentes} tone="neg" />
        </Card>
        <Card>
          <div className="flex items-center gap-2 mb-1"><HandCoins size={16} style={{ color: "var(--amber)" }} /><p className="text-xs font-medium" style={{ color: "var(--ink-soft)" }}>Em poder de terceiros</p></div>
          <Money v={engine.totalEmPoderDeTerceiros} />
        </Card>
        <Card>
          <div className="flex items-center gap-2 mb-1"><ListChecks size={16} style={{ color: "var(--teal)" }} /><p className="text-xs font-medium" style={{ color: "var(--ink-soft)" }}>Lançamentos não conferidos</p></div>
          <p className="fin-mono text-2xl font-semibold">{transactions.filter((t) => !t.conferido).length}</p>
        </Card>
      </div>

      {(despesasPrevistas || contasReceber) && (
        <div>
          <p className="font-semibold mb-2 fin-display">📊 Previsão financeira — {monthLabel(month, year)}</p>
          <Card style={{ background: "var(--navy)", border: "none" }} className="text-white">
            {(() => {
              const noMesSelecionado = (data) => (data || "").slice(0, 7) === `${year}-${String(month).padStart(2, "0")}`;
              const saidasDespesasPrevistas = (despesasPrevistas || []).filter((d) => d.status !== "paga" && noMesSelecionado(d.data_vencimento)).reduce((s, d) => s + d.valor_previsto, 0);
              const mesSelecionadoStr = `${year}-${String(month).padStart(2, "0")}`;
              const baixasFixasDoMes = new Set(transactions.filter((t) => t.refRecurringExpenseId && (t.date || "").slice(0, 7) === mesSelecionadoStr).map((t) => t.refRecurringExpenseId));
              const saidasFixasPendentes = (recurringExpenses || []).filter((r) => r.ativo && !baixasFixasDoMes.has(r.id)).reduce((s, r) => s + r.valor, 0);
              const saidasPrevistas = saidasDespesasPrevistas + saidasFixasPendentes;
              const entradasPrevistas = (contasReceber || []).filter((n) => n.status !== "recebido" && noMesSelecionado(n.data_prevista_recebimento)).reduce((s, n) => s + n.valor, 0);
              const saldoProjetado = engine.saldoConsolidado + entradasPrevistas - saidasPrevistas;
              return (
                <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                  <div>
                    <p className="text-xs" style={{ color: "var(--gold-soft)" }}>💰 Entradas previstas (a receber)</p>
                    <p className="fin-mono font-semibold text-xl">{fmtBRL(entradasPrevistas)}</p>
                  </div>
                  <div>
                    <p className="text-xs" style={{ color: "var(--gold-soft)" }}>💸 Saídas previstas (a pagar)</p>
                    <p className="fin-mono font-semibold text-xl">{fmtBRL(saidasPrevistas)}</p>
                  </div>
                  <div>
                    <p className="text-xs" style={{ color: "var(--gold-soft)" }}>💵 Saldo projetado</p>
                    <p className="fin-mono font-semibold text-xl">{fmtBRL(saldoProjetado)}</p>
                  </div>
                </div>
              );
            })()}
            <p className="text-xs mt-3" style={{ color: "#C7CEDC" }}>Previsto ainda não é realizado — o saldo bancário real só muda quando o dinheiro entra ou sai de fato.</p>
          </Card>
        </div>
      )}
    </div>
  );
}

/* ============================================================
   VIEW: FLUXO DE CAIXA
   ============================================================ */
const TYPE_LABELS = {
  receita: { label: "Receita", tone: "green" }, despesa: { label: "Despesa", tone: "red" },
  transferencia: { label: "Transferência", tone: "teal" }, adiantamento: { label: "Adiantamento", tone: "amber" },
  baixa_adiantamento: { label: "Uso de adiantamento", tone: "amber" }, devolucao_adiantamento: { label: "Devolução adiant.", tone: "teal" },
  reembolso_pagamento: { label: "Pagto. reembolso", tone: "neutral" }, ajuste: { label: "Ajuste", tone: "neutral" },
  emprestimo_terceiro: { label: "Empréstimo recebido", tone: "amber" }, pagamento_emprestimo: { label: "Pagto. empréstimo", tone: "neutral" },
};
function accName(accounts, id) { return accounts.find((a) => a.id === id)?.name || "—"; }

function FluxoCaixaView({ transactions, accounts, categories, onToggleConferido, onDelete, onEdit, canDelete }) {
  const [onlyPending, setOnlyPending] = useState(false);
  const [typeFilter, setTypeFilter] = useState("todos");
  const [accountFilter, setAccountFilter] = useState("todas");
  const [categoriaFilter, setCategoriaFilter] = useState("todas");
  const [dataInicial, setDataInicial] = useState(CORTE_HISTORICO);
  const [dataFinal, setDataFinal] = useState("");
  const [q, setQ] = useState("");
  const verHistorico = dataInicial !== CORTE_HISTORICO;

  // saldo acumulado do controle novo (a partir de 01/09), pra bater com o card do Dashboard.
  // No modo histórico, calcula à parte a partir de zero — é só pra consulta, não representa saldo real de caixa.
  const saldoAcumuladoPorId = useMemo(() => {
    const inicio = verHistorico ? 0 : accounts.reduce((s, a) => s + (a.saldoInicial || 0), 0);
    const base = verHistorico ? transactions.filter((t) => (t.date || "") < CORTE_HISTORICO) : transactions.filter((t) => (t.date || "") >= CORTE_HISTORICO);
    const chron = [...base].sort((a, b) => (a.date || "").localeCompare(b.date || "") || (a.createdAt || "").localeCompare(b.createdAt || ""));
    let acc = inicio;
    const map = {};
    chron.forEach((t) => {
      if (t.type === "receita") acc += t.valor;
      else if (t.type === "despesa" && !t.pendenteReembolso) acc -= t.valor;
      else if (t.type === "adiantamento") acc -= t.valor;
      else if (t.type === "devolucao_adiantamento") acc += t.valor;
      else if (t.type === "reembolso_pagamento") acc -= t.valor;
      else if (t.type === "ajuste") acc += t.valor;
      map[t.id] = acc;
    });
    return map;
  }, [transactions, accounts, verHistorico]);

  const sorted = [...transactions].sort((a, b) => (b.date || "").localeCompare(a.date || "") || (b.createdAt || "").localeCompare(a.createdAt || ""));
  const filtered = sorted.filter((t) => {
    if (onlyPending && t.conferido) return false;
    if (typeFilter !== "todos" && t.type !== typeFilter) return false;
    if (categoriaFilter !== "todas" && t.categoria !== categoriaFilter) return false;
    if (dataInicial && (t.date || "") < dataInicial) return false;
    if (dataFinal && (t.date || "") > dataFinal) return false;
    if (accountFilter !== "todas") {
      const accs = [t.conta, t.contaOrigem, t.contaDestino].filter(Boolean);
      if (!accs.includes(accountFilter)) return false;
    }
    if (q.trim()) {
      const s = `${t.descricao} ${t.pessoa} ${t.categoria} ${t.observacao}`.toLowerCase();
      if (!s.includes(q.toLowerCase())) return false;
    }
    return true;
  });

  return (
    <div className="space-y-4">
      <Card style={{ background: verHistorico ? "var(--amber-soft)" : "var(--teal-soft)", border: "none" }} className="flex items-center justify-between flex-wrap gap-2">
        <p className="text-sm">
          {verHistorico
            ? "📁 Mostrando histórico completo, incluindo julho e agosto (dados antigos, ainda em conferência)."
            : "✅ Mostrando o controle novo, a partir de 01/09/2026 — julho e agosto ficam guardados como histórico."}
        </p>
        <Btn variant={verHistorico ? "subtle" : "ghost"} onClick={() => setDataInicial(verHistorico ? CORTE_HISTORICO : "")}>
          {verHistorico ? "Voltar pro controle atual" : "Ver histórico (jul/ago)"}
        </Btn>
      </Card>
      <div className="flex flex-wrap gap-2 items-end">
        <TextInput placeholder="Buscar por descrição, pessoa, categoria..." value={q} onChange={(e) => setQ(e.target.value)} style={{ maxWidth: 260 }} />
        <Select value={typeFilter} onChange={(e) => setTypeFilter(e.target.value)} style={{ width: 180 }}>
          <option value="todos">Todos os tipos</option>
          {Object.entries(TYPE_LABELS).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
        </Select>
        <Select value={accountFilter} onChange={(e) => setAccountFilter(e.target.value)} style={{ width: 170 }}>
          <option value="todas">Todas as contas</option>
          {accounts.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
        </Select>
        <Select value={categoriaFilter} onChange={(e) => setCategoriaFilter(e.target.value)} style={{ width: 170 }}>
          <option value="todas">Todas as categorias</option>
          {categories.map((c) => <option key={c.id} value={c.name}>{c.name}</option>)}
        </Select>
        <Field label="De"><TextInput type="date" value={dataInicial} onChange={(e) => setDataInicial(e.target.value)} style={{ width: 150 }} /></Field>
        <Field label="Até"><TextInput type="date" value={dataFinal} onChange={(e) => setDataFinal(e.target.value)} style={{ width: 150 }} /></Field>
        <label className="flex items-center gap-1.5 text-sm cursor-pointer ml-auto mb-3">
          <input type="checkbox" checked={onlyPending} onChange={(e) => setOnlyPending(e.target.checked)} />Somente não conferidos
        </label>
      </div>

      <Card className="p-0 overflow-hidden">
        <div className="fin-scroll overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr style={{ background: "#F0ECE0", color: "var(--ink-soft)" }}>
                {["Data", "Tipo", "Descrição", "Conta", "Categoria", "Entrada", "Saída", "Saldo"].map((h) => (
                  <th key={h} className="text-left px-3 py-2 font-medium text-xs whitespace-nowrap">{h}</th>
                ))}
                <th className="text-center px-2 py-2 font-medium text-xs whitespace-nowrap" style={{ position: "sticky", right: 80, width: 40, minWidth: 40, maxWidth: 40, background: "#F0ECE0", boxShadow: "-4px 0 4px -2px rgba(0,0,0,0.08)", zIndex: 2 }}>Conf.</th>
                <th className="px-2 py-2" style={{ position: "sticky", right: 40, width: 40, minWidth: 40, maxWidth: 40, background: "#F0ECE0", zIndex: 2 }}></th>
                <th className="px-2 py-2" style={{ position: "sticky", right: 0, width: 40, minWidth: 40, maxWidth: 40, background: "#F0ECE0", zIndex: 2 }}></th>
              </tr>
            </thead>
            <tbody>
              {filtered.length === 0 && <tr><td colSpan={11}><EmptyState text="Nenhum lançamento encontrado." /></td></tr>}
              {filtered.map((t) => {
                const meta = TYPE_LABELS[t.type];
                const contaTxt = t.type === "transferencia" ? `${accName(accounts, t.contaOrigem)} → ${accName(accounts, t.contaDestino)}` : accName(accounts, t.conta);
                return (
                  <tr key={t.id} className="border-t" style={{ borderColor: "var(--line)" }}>
                    <td className="px-3 py-2 whitespace-nowrap fin-mono text-xs">{fmtDate(t.date)}</td>
                    <td className="px-3 py-2 whitespace-nowrap"><Pill tone={meta?.tone}>{meta?.label}</Pill></td>
                    <td className="px-3 py-2 max-w-[340px] truncate" title={t.descricao}>
                      {t.descricao
                        ? <>{t.descricao}{t.pessoa ? <span style={{ color: "var(--ink-soft)" }}> · {t.pessoa}</span> : ""}</>
                        : (t.pessoa || <span style={{ color: "var(--ink-soft)" }}>—</span>)}
                      {t.type === "despesa" && t.pendenteReembolso && <span className="ml-1"><Pill tone="amber">reembolso pendente</Pill></span>}
                    </td>
                    <td className="px-3 py-2 whitespace-nowrap text-xs">{contaTxt}</td>
                    <td className="px-3 py-2 whitespace-nowrap text-xs">{t.categoria || "—"}</td>
                    <td className="px-3 py-2 fin-mono text-xs" style={{ color: "var(--green)" }}>{["receita", "devolucao_adiantamento", "transferencia"].includes(t.type) ? fmtBRL(t.valor) : ""}</td>
                    <td className="px-3 py-2 fin-mono text-xs" style={{ color: "var(--red)" }}>{((t.type === "despesa" && !t.pendenteReembolso) || t.type === "adiantamento" || t.type === "reembolso_pagamento") ? fmtBRL(t.valor) : ""}</td>
                    <td className="px-3 py-2 fin-mono text-xs whitespace-nowrap">{fmtBRL(saldoAcumuladoPorId[t.id])}</td>
                    <td className="px-2 py-2 text-center" style={{ position: "sticky", right: 80, width: 40, minWidth: 40, maxWidth: 40, background: "var(--panel)", boxShadow: "-4px 0 4px -2px rgba(0,0,0,0.08)", zIndex: 1 }}>
                      <button onClick={() => onToggleConferido(t)} className="fin-focus" title="Marcar conferido">
                        {t.conferido ? <Check size={16} style={{ color: "var(--green)" }} /> : <Clock size={16} style={{ color: "var(--ink-soft)" }} />}
                      </button>
                    </td>
                    <td className="px-2 py-2 text-center" style={{ position: "sticky", right: 40, width: 40, minWidth: 40, maxWidth: 40, background: "var(--panel)", zIndex: 1 }}>
                      <button onClick={() => onEdit(t)} className="fin-focus" title="Editar"><Edit2 size={15} style={{ color: "var(--ink-soft)" }} /></button>
                    </td>
                    <td className="px-2 py-2 text-center" style={{ position: "sticky", right: 0, width: 40, minWidth: 40, maxWidth: 40, background: "var(--panel)", zIndex: 1 }}>
                      {canDelete && <button onClick={() => onDelete(t)} className="fin-focus" title="Excluir"><Trash2 size={15} style={{ color: "var(--red)" }} /></button>}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}

/* ============================================================
   VIEW: CONTAS
   ============================================================ */
function ContasView({ accounts, engine, onAdd, onToggleActive, canManage }) {
  const [name, setName] = useState("");
  const [saldoInicial, setSaldoInicial] = useState("0");
  const [saving, setSaving] = useState(false);

  const submit = async () => {
    if (!name.trim()) return;
    setSaving(true);
    await onAdd({ name: name.trim(), active: true, saldoInicial: parseValorBR(saldoInicial) || 0 });
    setSaving(false);
    setName(""); setSaldoInicial("0");
  };

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        {accounts.map((a) => (
          <Card key={a.id} className="flex items-center justify-between">
            <div>
              <p className="font-semibold flex items-center gap-2">{a.name} {a.tipo === "cartao_credito" && <Pill tone="amber">cartão de crédito</Pill>} {!a.active && <Pill tone="neutral">inativa</Pill>}</p>
              <Money v={engine.saldoPorConta[a.id] || 0} size="lg" tone={(engine.saldoPorConta[a.id] || 0) >= 0 ? "pos" : "neg"} />
            </div>
            {canManage && <Btn variant="ghost" onClick={() => onToggleActive(a)}>{a.active ? "Desativar" : "Ativar"}</Btn>}
          </Card>
        ))}
      </div>
      {canManage && (
        <Card>
          <p className="font-semibold mb-3 fin-display">Adicionar nova conta</p>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-3 items-end">
            <Field label="Nome da conta"><TextInput value={name} onChange={(e) => setName(e.target.value)} placeholder="Ex: Conta GL da Cruz" /></Field>
            <Field label="Saldo inicial (opcional)"><TextInput inputMode="decimal" value={saldoInicial} onChange={(e) => setSaldoInicial(e.target.value)} /></Field>
            <Btn variant="gold" icon={Plus} onClick={submit} disabled={saving}>{saving ? "Adicionando..." : "Adicionar conta"}</Btn>
          </div>
        </Card>
      )}
    </div>
  );
}

/* ============================================================
   VIEW: CATEGORIAS
   ============================================================ */
function EmojiPicker({ value, onChange }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="relative">
      <button type="button" onClick={() => setOpen((o) => !o)} className="fin-focus fin-btn flex items-center justify-center rounded-lg"
        style={{ ...inputStyle, width: 46, height: 40, padding: 0, fontSize: 18 }}>
        {value || "📂"}
      </button>
      {open && (
        <div className="absolute z-10 mt-1 p-2 rounded-lg grid grid-cols-6 gap-1" style={{ background: "var(--panel)", border: "1px solid var(--line)", boxShadow: "0 8px 24px rgba(18,33,59,0.15)" }}>
          {QUICK_EMOJIS.map((e) => (
            <button key={e} type="button" onClick={() => { onChange(e); setOpen(false); }} className="fin-focus rounded-md p-1.5 text-lg hover:opacity-70">{e}</button>
          ))}
          <div className="col-span-6 mt-1 pt-1" style={{ borderTop: "1px solid var(--line)" }}>
            <TextInput value={value} onChange={(e) => onChange(e.target.value)} placeholder="Ou cole outro emoji aqui" style={{ fontSize: 14 }} />
          </div>
        </div>
      )}
    </div>
  );
}

function CategoriasView({ categories, onAdd, onToggleActive, onUpdateEmoji, canManage }) {
  const [name, setName] = useState("");
  const [emoji, setEmoji] = useState("");
  const [saving, setSaving] = useState(false);
  const submit = async () => { if (!name.trim()) return; setSaving(true); await onAdd({ name: name.trim(), active: true, emoji: emoji || null }); setSaving(false); setName(""); setEmoji(""); };
  return (
    <div className="space-y-4">
      <Card className="p-0 overflow-hidden">
        {categories.map((c, i) => (
          <div key={c.id} className="flex items-center justify-between px-4 py-2.5" style={{ borderTop: i ? "1px solid var(--line)" : "none" }}>
            <div className="flex items-center gap-2">
              {canManage
                ? <EmojiPicker value={c.emoji || categoryEmoji(c.name)} onChange={(e) => onUpdateEmoji(c, e)} />
                : <span style={{ fontSize: 16 }}>{c.emoji || categoryEmoji(c.name)}</span>}
              <span className={c.active ? "" : "line-through"} style={{ color: c.active ? "var(--ink)" : "var(--ink-soft)" }}>{c.name}</span>
            </div>
            {canManage && <Btn variant="ghost" onClick={() => onToggleActive(c)}>{c.active ? "Desativar" : "Ativar"}</Btn>}
          </div>
        ))}
      </Card>
      {canManage && (
        <Card>
          <div className="flex gap-2 items-end">
            <EmojiPicker value={emoji} onChange={setEmoji} />
            <div className="flex-1"><Field label="Nova categoria"><TextInput value={name} onChange={(e) => setName(e.target.value)} placeholder="Ex: Marketing" /></Field></div>
            <Btn variant="gold" icon={Plus} onClick={submit} disabled={saving}>Adicionar</Btn>
          </div>
        </Card>
      )}
    </div>
  );
}

/* ============================================================
   VIEW: RELATÓRIOS — "Para onde foi o dinheiro?"
   ============================================================ */
function RelatoriosView({ transactions, accounts, engine }) {
  const now = new Date();
  const [month, setMonth] = useState(now.getMonth() + 1);
  const [year, setYear] = useState(now.getFullYear());
  const [groupBy, setGroupBy] = useState("categoria");

  const periodTx = filterByPeriod(transactions, month, year);
  const totals = periodTotals(periodTx);
  const breakdown = categoryBreakdown(periodTx);
  const byAccount = accounts.map((a) => ({ name: a.name, value: periodTx.filter((t) => t.type === "despesa" && t.conta === a.id).reduce((s, t) => s + t.valor, 0) })).filter((x) => x.value > 0);
  const byPerson = useMemo(() => {
    const map = {};
    periodTx.filter((t) => t.type === "despesa" || t.type === "baixa_adiantamento").forEach((t) => { const p = t.pessoa || "Não informado"; map[p] = (map[p] || 0) + t.valor; });
    return Object.entries(map).map(([name, value]) => ({ name, value })).sort((a, b) => b.value - a.value);
  }, [periodTx]);
  const data = groupBy === "categoria" ? breakdown : groupBy === "conta" ? byAccount : byPerson;

  return (
    <div className="space-y-5" id="relatorio-print-area">
      <div className="flex flex-wrap gap-2 items-center fin-no-print">
        <Select value={month} onChange={(e) => setMonth(Number(e.target.value))} style={{ width: 160 }}>
          {Array.from({ length: 12 }, (_, i) => i + 1).map((m) => <option key={m} value={m}>{new Date(2000, m - 1, 1).toLocaleDateString("pt-BR", { month: "long" })}</option>)}
        </Select>
        <Select value={year} onChange={(e) => setYear(Number(e.target.value))} style={{ width: 110 }}>{[year - 1, year, year + 1].map((y) => <option key={y} value={y}>{y}</option>)}</Select>
        <Select value={groupBy} onChange={(e) => setGroupBy(e.target.value)} style={{ width: 170 }}>
          <option value="categoria">Agrupar por categoria</option><option value="conta">Agrupar por conta</option><option value="pessoa">Agrupar por pessoa</option>
        </Select>
        <Btn variant="ghost" icon={Printer} onClick={() => window.print()} className="ml-auto">Imprimir / exportar PDF</Btn>
      </div>
      <p className="fin-print-only text-lg font-semibold fin-display" style={{ display: "none" }}>Relatório — {monthLabel(month, year)}</p>
      <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
        <Card><p className="text-xs" style={{ color: "var(--ink-soft)" }}>Quanto entrou</p><Money v={totals.receitas} tone="pos" /></Card>
        <Card><p className="text-xs" style={{ color: "var(--ink-soft)" }}>Quanto foi gasto</p><Money v={totals.despesas} tone="neg" /></Card>
        <Card><p className="text-xs" style={{ color: "var(--ink-soft)" }}>Só transferido</p><Money v={totals.transferencias} /></Card>
        <Card><p className="text-xs" style={{ color: "var(--ink-soft)" }}>Saldo do período</p><Money v={totals.saldoPeriodo} tone={totals.saldoPeriodo >= 0 ? "pos" : "neg"} /></Card>
        <Card><p className="text-xs" style={{ color: "var(--ink-soft)" }}>Disponível (todas as contas)</p><Money v={engine.saldoConsolidado} /></Card>
      </div>
      <Card>
        <p className="font-semibold mb-3 fin-display">Despesas por {groupBy}</p>
        {data.length === 0 ? <EmptyState text="Sem despesas no período selecionado." /> : (
          <div className="grid md:grid-cols-2 gap-4">
            <div style={{ height: 260 }}>
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={data} layout="vertical" margin={{ left: 8, right: 20 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#E4DFCF" />
                  <XAxis type="number" tickFormatter={(v) => fmtBRL(v)} fontSize={11} />
                  <YAxis type="category" dataKey="name" width={130} fontSize={11} />
                  <Tooltip formatter={(v) => fmtBRL(v)} />
                  <Bar dataKey="value" fill="#12213B" radius={[0, 4, 4, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </div>
            <div style={{ height: 260 }}>
              <ResponsiveContainer width="100%" height="100%">
                <PieChart>
                  <Pie data={data} dataKey="value" nameKey="name" innerRadius={55} outerRadius={90} paddingAngle={2}>
                    {data.map((_, i) => <Cell key={i} fill={PIE_COLORS[i % PIE_COLORS.length]} />)}
                  </Pie>
                  <Tooltip formatter={(v) => fmtBRL(v)} /><Legend wrapperStyle={{ fontSize: 11 }} />
                </PieChart>
              </ResponsiveContainer>
            </div>
          </div>
        )}
      </Card>
    </div>
  );
}

/* ============================================================
   VIEWS: ADIANTAMENTOS / REEMBOLSOS
   ============================================================ */
function AdiantamentosView({ engine, accounts, onBaixa, onDevolucao, onExcluir, canDelete }) {
  const abertos = engine.adiantamentos.filter((a) => a.saldoAPrestar > 0.009);
  const quitados = engine.adiantamentos.filter((a) => a.saldoAPrestar <= 0.009);
  return (
    <div className="space-y-5">
      <div>
        <p className="font-semibold mb-2 fin-display">Em aberto — valores em poder de terceiros</p>
        {abertos.length === 0 ? <EmptyState text="Nenhum adiantamento em aberto." /> : (
          <div className="grid md:grid-cols-2 gap-3">
            {abertos.map((a) => {
              const semUso = a.usado <= 0.009 && a.devolvido <= 0.009;
              return (
                <Card key={a.id}>
                  <div className="flex justify-between items-start">
                    <div><p className="font-semibold">{a.pessoa}</p><p className="text-xs" style={{ color: "var(--ink-soft)" }}>Enviado em {fmtDate(a.date)} · {accName(accounts, a.conta)}</p></div>
                    <Pill tone="amber">a prestar contas</Pill>
                  </div>
                  <div className="grid grid-cols-3 gap-2 mt-3 text-xs">
                    <div><p style={{ color: "var(--ink-soft)" }}>Enviado</p><Money v={a.valor} size="sm" /></div>
                    <div><p style={{ color: "var(--ink-soft)" }}>Usado</p><Money v={a.usado} size="sm" /></div>
                    <div><p style={{ color: "var(--ink-soft)" }}>A prestar</p><Money v={a.saldoAPrestar} size="sm" tone="neg" /></div>
                  </div>
                  <div className="flex gap-2 mt-3 flex-wrap">
                    <Btn variant="subtle" onClick={() => onBaixa(a)}>Registrar despesa</Btn>
                    <Btn variant="ghost" onClick={() => onDevolucao(a)}>Registrar devolução</Btn>
                    {canDelete && semUso && <Btn variant="danger" icon={Trash2} onClick={() => onExcluir(a)}>Excluir</Btn>}
                  </div>
                </Card>
              );
            })}
          </div>
        )}
      </div>
      {quitados.length > 0 && (
        <div>
          <p className="font-semibold mb-2 fin-display" style={{ color: "var(--ink-soft)" }}>Quitados</p>
          <div className="grid md:grid-cols-2 gap-3">
            {quitados.map((a) => (
              <Card key={a.id} style={{ opacity: 0.7 }}><p className="font-semibold">{a.pessoa}</p><p className="text-xs" style={{ color: "var(--ink-soft)" }}>{fmtDate(a.date)} · <Money v={a.valor} size="sm" /> totalmente prestado</p></Card>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function ReembolsosView({ engine, onPagar }) {
  const pendentes = engine.reembolsos.filter((r) => r.status !== "pago");
  const pagos = engine.reembolsos.filter((r) => r.status === "pago");
  const statusTone = { pendente: "red", parcial: "amber", pago: "green" };
  return (
    <div className="space-y-5">
      <div>
        <p className="font-semibold mb-2 fin-display">Pendentes / parciais</p>
        {pendentes.length === 0 ? <EmptyState text="Nenhum reembolso pendente." /> : (
          <Card className="p-0 overflow-hidden">
            {pendentes.map((r, i) => (
              <div key={r.id} className="flex items-center justify-between px-4 py-3" style={{ borderTop: i ? "1px solid var(--line)" : "none" }}>
                <div>
                  <p className="font-medium text-sm">{r.pessoa} <Pill tone={statusTone[r.status]}>{r.status}</Pill></p>
                  <p className="text-xs" style={{ color: "var(--ink-soft)" }}>{r.descricao || r.categoria} · {fmtDate(r.date)}</p>
                </div>
                <div className="flex items-center gap-4">
                  <div className="text-right text-xs"><p>Total: <Money v={r.valor} size="sm" /></p><p>Restante: <Money v={r.restante} size="sm" tone="neg" /></p></div>
                  <Btn variant="gold" onClick={() => onPagar(r)}>Pagar</Btn>
                </div>
              </div>
            ))}
          </Card>
        )}
      </div>
      {pagos.length > 0 && (
        <div>
          <p className="font-semibold mb-2 fin-display" style={{ color: "var(--ink-soft)" }}>Pagos</p>
          <Card className="p-0 overflow-hidden">
            {pagos.map((r, i) => (
              <div key={r.id} className="flex items-center justify-between px-4 py-2.5 text-sm" style={{ borderTop: i ? "1px solid var(--line)" : "none", opacity: 0.7 }}>
                <span>{r.pessoa} — {r.descricao || r.categoria}</span><Money v={r.valor} size="sm" />
              </div>
            ))}
          </Card>
        </div>
      )}
    </div>
  );
}

/* ============================================================
   VIEW: DESPESAS PREVISTAS
   Prevista (🟡) → Paga (🟢, ao "Marcar como paga" cria a despesa real e liga aqui)
   Em atraso (🔴) = prevista + venceu.
   Não altera a estrutura de Despesas existente — é uma camada de "ainda vai acontecer".
   ============================================================ */
function despesaPrevistaStatus(d) {
  if (d.status === "paga") return "paga";
  if ((d.data_vencimento || "") < todayISO()) return "atrasada";
  return "prevista";
}
const DP_STATUS_META = {
  prevista: { label: "Prevista", emoji: "🟡", tone: "amber" },
  paga: { label: "Paga", emoji: "🟢", tone: "green" },
  atrasada: { label: "Em atraso", emoji: "🔴", tone: "red" },
};

function NovaDespesaPrevistaModal({ categories, onClose, onSave }) {
  const [descricao, setDescricao] = useState("");
  const [categoria, setCategoria] = useState(categories[0]?.name || "");
  const [valor, setValor] = useState("");
  const [dataVencimento, setDataVencimento] = useState(todayISO());
  const [pessoa, setPessoa] = useState("");
  const [err, setErr] = useState("");
  const [saving, setSaving] = useState(false);

  const submit = async () => {
    const v = parseValorBR(valor);
    if (!descricao.trim()) { setErr("Informe a descrição."); return; }
    if (!v || v <= 0) { setErr("Informe um valor válido."); return; }
    if (!dataVencimento) { setErr("Informe a data de vencimento."); return; }
    setSaving(true);
    const ok = await onSave({ descricao: descricao.trim(), categoria, valor_previsto: v, data_vencimento: dataVencimento, pessoa: pessoa.trim() });
    setSaving(false);
    if (!ok) setErr("Não consegui salvar. Tente novamente.");
  };

  return (
    <Modal title="Nova despesa prevista" onClose={onClose}>
      <Field label="Descrição" required><TextInput value={descricao} onChange={(e) => setDescricao(e.target.value)} placeholder="Ex: Aluguel de setembro" /></Field>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Valor previsto (R$)" required><TextInput inputMode="decimal" value={valor} onChange={(e) => setValor(e.target.value)} placeholder="0,00" /></Field>
        <Field label="Vencimento" required><TextInput type="date" value={dataVencimento} onChange={(e) => setDataVencimento(e.target.value)} /></Field>
      </div>
      <Field label="Categoria"><Select value={categoria} onChange={(e) => setCategoria(e.target.value)}>{categories.map((c) => <option key={c.id} value={c.name}>{c.name}</option>)}</Select></Field>
      <Field label="Pessoa / fornecedor"><TextInput value={pessoa} onChange={(e) => setPessoa(e.target.value)} /></Field>
      {err && <p className="text-sm mb-2" style={{ color: "var(--red)" }}>{err}</p>}
      <div className="flex justify-end gap-2 mt-2">
        <Btn variant="ghost" onClick={onClose}>Cancelar</Btn>
        <Btn variant="gold" icon={Check} onClick={submit} disabled={saving}>{saving ? "Salvando..." : "Salvar previsão"}</Btn>
      </div>
    </Modal>
  );
}

function EditDespesaPrevistaModal({ despesa, categories, onClose, onSave }) {
  const [descricao, setDescricao] = useState(despesa.descricao || "");
  const [categoria, setCategoria] = useState(despesa.categoria || categories[0]?.name || "");
  const [valor, setValor] = useState(String(despesa.valor_previsto ?? "").replace(".", ","));
  const [dataVencimento, setDataVencimento] = useState(despesa.data_vencimento || todayISO());
  const [pessoa, setPessoa] = useState(despesa.pessoa || "");
  const [err, setErr] = useState("");
  const [saving, setSaving] = useState(false);

  const submit = async () => {
    const v = parseValorBR(valor);
    if (!descricao.trim()) { setErr("Informe a descrição."); return; }
    if (!v || v <= 0) { setErr("Informe um valor válido."); return; }
    if (!dataVencimento) { setErr("Informe a data de vencimento."); return; }
    setSaving(true);
    const ok = await onSave(despesa, { descricao: descricao.trim(), categoria, valor_previsto: v, data_vencimento: dataVencimento, pessoa: pessoa.trim() });
    setSaving(false);
    if (!ok) setErr("Não consegui salvar. Tente novamente.");
  };

  return (
    <Modal title="Editar despesa prevista" onClose={onClose}>
      <Field label="Descrição" required><TextInput value={descricao} onChange={(e) => setDescricao(e.target.value)} placeholder="Ex: Aluguel de setembro" /></Field>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Valor previsto (R$)" required><TextInput inputMode="decimal" value={valor} onChange={(e) => setValor(e.target.value)} placeholder="0,00" /></Field>
        <Field label="Vencimento" required><TextInput type="date" value={dataVencimento} onChange={(e) => setDataVencimento(e.target.value)} /></Field>
      </div>
      <Field label="Categoria"><Select value={categoria} onChange={(e) => setCategoria(e.target.value)}>{categories.map((c) => <option key={c.id} value={c.name}>{c.name}</option>)}</Select></Field>
      <Field label="Pessoa / fornecedor"><TextInput value={pessoa} onChange={(e) => setPessoa(e.target.value)} /></Field>
      {err && <p className="text-sm mb-2" style={{ color: "var(--red)" }}>{err}</p>}
      <div className="flex justify-end gap-2 mt-2">
        <Btn variant="ghost" onClick={onClose}>Cancelar</Btn>
        <Btn variant="gold" icon={Check} onClick={submit} disabled={saving}>{saving ? "Salvando..." : "Salvar alterações"}</Btn>
      </div>
    </Modal>
  );
}

function MarcarPagaModal({ despesa, accounts, onClose, onSave }) {
  const [dataPagamento, setDataPagamento] = useState(todayISO());
  const [valorPago, setValorPago] = useState(String(despesa.valor_previsto).replace(".", ","));
  const [conta, setConta] = useState(accounts[0]?.id || "");
  const [err, setErr] = useState("");
  const [saving, setSaving] = useState(false);

  const submit = async () => {
    const v = parseValorBR(valorPago);
    if (!v || v <= 0) { setErr("Informe um valor válido."); return; }
    if (!conta) { setErr("Selecione a conta."); return; }
    setSaving(true);
    const ok = await onSave(despesa, { dataPagamento, valorPago: v, conta });
    setSaving(false);
    if (!ok) setErr("Não consegui registrar o pagamento. Tente novamente.");
  };

  return (
    <Modal title="Marcar como paga" onClose={onClose}>
      <Card className="mb-4" style={{ background: "var(--amber-soft)", border: "none" }}>
        <p className="text-sm">{despesa.descricao} — previsto <Money v={despesa.valor_previsto} size="sm" /> em {fmtDate(despesa.data_vencimento)}</p>
      </Card>
      <Field label="Data do pagamento" required><TextInput type="date" value={dataPagamento} onChange={(e) => setDataPagamento(e.target.value)} /></Field>
      <Field label="Valor efetivamente pago (R$)" required><TextInput inputMode="decimal" value={valorPago} onChange={(e) => setValorPago(e.target.value)} /></Field>
      <Field label="Conta utilizada" required><Select value={conta} onChange={(e) => setConta(e.target.value)}>{accounts.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}</Select></Field>
      {err && <p className="text-sm mb-2" style={{ color: "var(--red)" }}>{err}</p>}
      <div className="flex justify-end gap-2 mt-2">
        <Btn variant="ghost" onClick={onClose}>Cancelar</Btn>
        <Btn variant="gold" icon={Check} onClick={submit} disabled={saving}>{saving ? "Registrando..." : "Confirmar pagamento"}</Btn>
      </div>
    </Modal>
  );
}

function DespesasPrevistasView({ despesasPrevistas, accounts, categories, canManage, onAdd, onMarcarPaga, onEditDespesa }) {
  const [modal, setModal] = useState(null);
  const [filtroMes, setFiltroMes] = useState(todayISO().slice(0, 7));
  const comStatus = despesasPrevistas.map((d) => ({ ...d, statusCalc: despesaPrevistaStatus(d) }));

  const mesesDisponiveis = Array.from(new Set(
    comStatus.map((d) => (d.statusCalc === "paga" ? d.data_pagamento : d.data_vencimento) || "").filter(Boolean).map((x) => x.slice(0, 7))
  )).sort();
  if (filtroMes && !mesesDisponiveis.includes(filtroMes)) mesesDisponiveis.push(filtroMes);
  mesesDisponiveis.sort();

  const noMes = (data) => !filtroMes || (data || "").slice(0, 7) === filtroMes;

  const abertas = comStatus.filter((d) => d.statusCalc !== "paga" && noMes(d.data_vencimento)).sort((a, b) => (a.data_vencimento || "").localeCompare(b.data_vencimento || ""));
  const pagas = comStatus.filter((d) => d.statusCalc === "paga" && noMes(d.data_pagamento)).sort((a, b) => (b.data_pagamento || "").localeCompare(a.data_pagamento || ""));
  const totais = {
    prevista: abertas.filter((d) => d.statusCalc === "prevista").reduce((s, d) => s + d.valor_previsto, 0),
    atrasada: abertas.filter((d) => d.statusCalc === "atrasada").reduce((s, d) => s + d.valor_previsto, 0),
    paga: pagas.reduce((s, d) => s + (d.valor_pago || d.valor_previsto), 0),
  };

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <p className="font-semibold fin-display text-lg">Despesas Previstas</p>
        <Select value={filtroMes} onChange={(e) => setFiltroMes(e.target.value)} className="w-auto">
          <option value="">Todos os meses</option>
          {mesesDisponiveis.map((ym) => <option key={ym} value={ym}>{fmtMesAno(ym)}</option>)}
        </Select>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <Card><p className="text-xs" style={{ color: "var(--ink-soft)" }}>🟡 Previstas (em aberto)</p><Money v={totais.prevista} /></Card>
        <Card><p className="text-xs" style={{ color: "var(--ink-soft)" }}>🔴 Em atraso</p><Money v={totais.atrasada} tone="neg" /></Card>
        <Card><p className="text-xs" style={{ color: "var(--ink-soft)" }}>🟢 Pagas</p><Money v={totais.paga} /></Card>
        <Card><p className="text-xs" style={{ color: "var(--ink-soft)" }}>Total em aberto</p><Money v={totais.prevista + totais.atrasada} tone="neg" /></Card>
      </div>

      {canManage && <Btn variant="gold" icon={Plus} onClick={() => setModal({ kind: "nova" })}>Nova despesa prevista</Btn>}

      <div>
        <p className="font-semibold mb-2 fin-display">Em aberto</p>
        {abertas.length === 0 ? <EmptyState text="Nenhuma despesa prevista em aberto." /> : (
          <Card className="p-0 overflow-hidden">
            {abertas.map((d, i) => {
              const meta = DP_STATUS_META[d.statusCalc];
              return (
                <div key={d.id} className="flex items-center justify-between px-4 py-3" style={{ borderTop: i ? "1px solid var(--line)" : "none" }}>
                  <div>
                    <p className="text-sm font-medium">{meta.emoji} {d.descricao} <Pill tone={meta.tone}>{meta.label}</Pill></p>
                    <p className="text-xs" style={{ color: "var(--ink-soft)" }}>{d.categoria || "—"} · vence {fmtDate(d.data_vencimento)}{d.pessoa ? ` · ${d.pessoa}` : ""}</p>
                  </div>
                  <div className="flex items-center gap-3">
                    <Money v={d.valor_previsto} size="sm" tone="neg" />
                    {canManage && <Btn variant="ghost" onClick={() => setModal({ kind: "editar", despesa: d })}>Editar</Btn>}
                    {canManage && <Btn variant="gold" onClick={() => setModal({ kind: "pagar", despesa: d })}>Marcar como paga</Btn>}
                  </div>
                </div>
              );
            })}
          </Card>
        )}
      </div>

      {pagas.length > 0 && (
        <div>
          <p className="font-semibold mb-2 fin-display" style={{ color: "var(--ink-soft)" }}>Pagas</p>
          <Card className="p-0 overflow-hidden">
            {pagas.map((d, i) => (
              <div key={d.id} className="flex items-center justify-between px-4 py-2.5 text-sm" style={{ borderTop: i ? "1px solid var(--line)" : "none", opacity: 0.7 }}>
                <span>🟢 {d.descricao} · pago em {fmtDate(d.data_pagamento)}</span>
                <Money v={d.valor_pago} size="sm" />
              </div>
            ))}
          </Card>
        </div>
      )}

      {modal?.kind === "nova" && <NovaDespesaPrevistaModal categories={categories.filter((c) => c.active)} onClose={() => setModal(null)} onSave={async (d) => { const ok = await onAdd(d); if (ok) setModal(null); return ok; }} />}
      {modal?.kind === "editar" && <EditDespesaPrevistaModal despesa={modal.despesa} categories={categories.filter((c) => c.active)} onClose={() => setModal(null)} onSave={async (d, p) => { const ok = await onEditDespesa(d, p); if (ok) setModal(null); return ok; }} />}
      {modal?.kind === "pagar" && <MarcarPagaModal despesa={modal.despesa} accounts={accounts.filter((a) => a.active)} onClose={() => setModal(null)} onSave={async (d, p) => { const ok = await onMarcarPaga(d, p); if (ok) setModal(null); return ok; }} />}
    </div>
  );
}

/* ============================================================
   VIEW: CONTAS A RECEBER (notas)
   Recebido pode vir com parte bloqueada — o disponível é sempre valor_recebido - valor_bloqueado.
   ============================================================ */
const CR_STATUS_LABELS = {
  orcamento_enviado: "Orçamento enviado", orcamento_perdido: "Orçamento perdido", aguardando_pedido: "Aguardando pedido",
  pedido_recebido: "Pedido recebido", aguardando_faturamento: "Aguardando faturamento", nf_emitida: "NF emitida",
  a_receber: "A receber", recebido: "Recebido",
};

function NovaNotaModal({ accounts, onClose, onSave }) {
  const [cliente, setCliente] = useState("");
  const [numeroNf, setNumeroNf] = useState("");
  const [valor, setValor] = useState("");
  const [dataEmissao, setDataEmissao] = useState(todayISO());
  const [dataPrevista, setDataPrevista] = useState(todayISO());
  const [conta, setConta] = useState(accounts[0]?.id || "");
  const [err, setErr] = useState("");
  const [saving, setSaving] = useState(false);

  const submit = async () => {
    const v = parseValorBR(valor);
    if (!cliente.trim()) { setErr("Informe o cliente."); return; }
    if (!v || v <= 0) { setErr("Informe um valor válido."); return; }
    if (!dataPrevista) { setErr("Informe a data prevista de recebimento."); return; }
    setSaving(true);
    const ok = await onSave({
      cliente: cliente.trim(), numero_nf: numeroNf.trim(), valor: v, status: "a_receber",
      data_emissao_nf: dataEmissao, data_prevista_recebimento: dataPrevista,
      conta_recebimento_id: conta || null,
    });
    setSaving(false);
    if (!ok) setErr("Não consegui salvar. Tente novamente.");
  };

  return (
    <Modal title="Nova nota a receber" onClose={onClose}>
      <Field label="Cliente" required><TextInput value={cliente} onChange={(e) => setCliente(e.target.value)} /></Field>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Valor da nota (R$)" required><TextInput inputMode="decimal" value={valor} onChange={(e) => setValor(e.target.value)} placeholder="0,00" /></Field>
        <Field label="Nº da NF"><TextInput value={numeroNf} onChange={(e) => setNumeroNf(e.target.value)} /></Field>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Data emitida"><TextInput type="date" value={dataEmissao} onChange={(e) => setDataEmissao(e.target.value)} /></Field>
        <Field label="Data prevista" required><TextInput type="date" value={dataPrevista} onChange={(e) => setDataPrevista(e.target.value)} /></Field>
      </div>
      <Field label="Conta prevista para o recebimento"><Select value={conta} onChange={(e) => setConta(e.target.value)}>{accounts.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}</Select></Field>
      {err && <p className="text-sm mb-2" style={{ color: "var(--red)" }}>{err}</p>}
      <div className="flex justify-end gap-2 mt-2">
        <Btn variant="ghost" onClick={onClose}>Cancelar</Btn>
        <Btn variant="gold" icon={Check} onClick={submit} disabled={saving}>{saving ? "Salvando..." : "Salvar nota"}</Btn>
      </div>
    </Modal>
  );
}

function EditNotaModal({ nota, accounts, onClose, onSave }) {
  const [cliente, setCliente] = useState(nota.cliente || "");
  const [numeroNf, setNumeroNf] = useState(nota.numero_nf || "");
  const [valor, setValor] = useState(String(nota.valor ?? "").replace(".", ","));
  const [dataEmissao, setDataEmissao] = useState(nota.data_emissao_nf || todayISO());
  const [dataPrevista, setDataPrevista] = useState(nota.data_prevista_recebimento || todayISO());
  const [conta, setConta] = useState(nota.conta_recebimento_id || accounts[0]?.id || "");
  const [err, setErr] = useState("");
  const [saving, setSaving] = useState(false);

  const submit = async () => {
    const v = parseValorBR(valor);
    if (!cliente.trim()) { setErr("Informe o cliente."); return; }
    if (!v || v <= 0) { setErr("Informe um valor válido."); return; }
    if (!dataPrevista) { setErr("Informe a data prevista de recebimento."); return; }
    setSaving(true);
    const ok = await onSave(nota, {
      cliente: cliente.trim(), numero_nf: numeroNf.trim(), valor: v,
      data_emissao_nf: dataEmissao, data_prevista_recebimento: dataPrevista,
      conta_recebimento_id: conta || null,
    });
    setSaving(false);
    if (!ok) setErr("Não consegui salvar. Tente novamente.");
  };

  return (
    <Modal title="Editar nota a receber" onClose={onClose}>
      <Field label="Cliente" required><TextInput value={cliente} onChange={(e) => setCliente(e.target.value)} /></Field>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Valor da nota (R$)" required><TextInput inputMode="decimal" value={valor} onChange={(e) => setValor(e.target.value)} placeholder="0,00" /></Field>
        <Field label="Nº da NF"><TextInput value={numeroNf} onChange={(e) => setNumeroNf(e.target.value)} /></Field>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Data emitida"><TextInput type="date" value={dataEmissao} onChange={(e) => setDataEmissao(e.target.value)} /></Field>
        <Field label="Data prevista" required><TextInput type="date" value={dataPrevista} onChange={(e) => setDataPrevista(e.target.value)} /></Field>
      </div>
      <Field label="Conta prevista para o recebimento"><Select value={conta} onChange={(e) => setConta(e.target.value)}>{accounts.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}</Select></Field>
      {err && <p className="text-sm mb-2" style={{ color: "var(--red)" }}>{err}</p>}
      <div className="flex justify-end gap-2 mt-2">
        <Btn variant="ghost" onClick={onClose}>Cancelar</Btn>
        <Btn variant="gold" icon={Check} onClick={submit} disabled={saving}>{saving ? "Salvando..." : "Salvar alterações"}</Btn>
      </div>
    </Modal>
  );
}

function MarcarRecebidoModal({ nota, accounts, onClose, onSave }) {
  const [dataRecebimento, setDataRecebimento] = useState(todayISO());
  const [valorRecebido, setValorRecebido] = useState(String(nota.valor).replace(".", ","));
  const [valorBloqueado, setValorBloqueado] = useState("0");
  const [conta, setConta] = useState(nota.conta_recebimento_id || accounts[0]?.id || "");
  const [err, setErr] = useState("");
  const [saving, setSaving] = useState(false);

  const vRecebido = parseValorBR(valorRecebido) || 0;
  const vBloqueado = parseValorBR(valorBloqueado) || 0;
  const vDisponivel = vRecebido - vBloqueado;

  const submit = async () => {
    if (!vRecebido || vRecebido <= 0) { setErr("Informe o valor recebido."); return; }
    if (vBloqueado < 0 || vBloqueado > vRecebido) { setErr("O valor bloqueado não pode ser maior que o recebido."); return; }
    if (vDisponivel > 0 && !conta) { setErr("Selecione a conta que recebeu o valor disponível."); return; }
    setSaving(true);
    const ok = await onSave(nota, { dataRecebimento, valorRecebido: vRecebido, valorBloqueado: vBloqueado, conta: vDisponivel > 0 ? conta : null });
    setSaving(false);
    if (!ok) setErr("Não consegui registrar o recebimento. Tente novamente.");
  };

  return (
    <Modal title={`Marcar como recebido — ${nota.cliente}`} onClose={onClose}>
      <Card className="mb-4" style={{ background: "var(--teal-soft)", border: "none" }}>
        <p className="text-sm">Nota: <Money v={nota.valor} size="sm" />{nota.numero_nf ? ` · NF ${nota.numero_nf}` : ""}</p>
      </Card>
      <Field label="Data do recebimento" required><TextInput type="date" value={dataRecebimento} onChange={(e) => setDataRecebimento(e.target.value)} /></Field>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Valor recebido (R$)" required><TextInput inputMode="decimal" value={valorRecebido} onChange={(e) => setValorRecebido(e.target.value)} /></Field>
        <Field label="Valor bloqueado (R$)"><TextInput inputMode="decimal" value={valorBloqueado} onChange={(e) => setValorBloqueado(e.target.value)} placeholder="0,00" /></Field>
      </div>
      <Card className="mb-3" style={{ background: "#EEEAE0", border: "none" }}>
        <p className="text-sm">Valor disponível em caixa: <Money v={vDisponivel} tone={vDisponivel >= 0 ? "pos" : "neg"} size="sm" /></p>
      </Card>
      {vDisponivel > 0 && (
        <Field label="Conta que recebeu o valor disponível" required>
          <Select value={conta} onChange={(e) => setConta(e.target.value)}>{accounts.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}</Select>
        </Field>
      )}
      {err && <p className="text-sm mb-2" style={{ color: "var(--red)" }}>{err}</p>}
      <div className="flex justify-end gap-2 mt-2">
        <Btn variant="ghost" onClick={onClose}>Cancelar</Btn>
        <Btn variant="gold" icon={Check} onClick={submit} disabled={saving}>{saving ? "Registrando..." : "Confirmar recebimento"}</Btn>
      </div>
    </Modal>
  );
}

function LiberarBloqueioModal({ nota, accounts, onClose, onSave }) {
  const bloqueadoAtual = nota.valor_bloqueado || 0;
  const [valor, setValor] = useState(String(bloqueadoAtual).replace(".", ","));
  const [conta, setConta] = useState(accounts[0]?.id || "");
  const [err, setErr] = useState("");
  const [saving, setSaving] = useState(false);

  const submit = async () => {
    const v = parseValorBR(valor);
    if (!v || v <= 0) { setErr("Informe um valor válido."); return; }
    if (v > bloqueadoAtual + 0.009) { setErr(`Só há ${fmtBRL(bloqueadoAtual)} bloqueado.`); return; }
    setSaving(true);
    const ok = await onSave(nota, { valor: v, conta });
    setSaving(false);
    if (!ok) setErr("Não consegui liberar. Tente novamente.");
  };

  return (
    <Modal title={`Liberar valor bloqueado — ${nota.cliente}`} onClose={onClose}>
      <Card className="mb-4" style={{ background: "var(--amber-soft)", border: "none" }}>
        <p className="text-sm">Bloqueado atualmente: <Money v={bloqueadoAtual} size="sm" /></p>
      </Card>
      <Field label="Valor a liberar (R$)" required><TextInput inputMode="decimal" value={valor} onChange={(e) => setValor(e.target.value)} /></Field>
      <Field label="Conta que recebe o valor liberado" required><Select value={conta} onChange={(e) => setConta(e.target.value)}>{accounts.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}</Select></Field>
      {err && <p className="text-sm mb-2" style={{ color: "var(--red)" }}>{err}</p>}
      <div className="flex justify-end gap-2 mt-2">
        <Btn variant="ghost" onClick={onClose}>Cancelar</Btn>
        <Btn variant="gold" icon={Check} onClick={submit} disabled={saving}>{saving ? "Liberando..." : "Confirmar liberação"}</Btn>
      </div>
    </Modal>
  );
}

const MES_NOMES = ["Janeiro", "Fevereiro", "Março", "Abril", "Maio", "Junho", "Julho", "Agosto", "Setembro", "Outubro", "Novembro", "Dezembro"];
const fmtMesAno = (ym) => { const [y, m] = ym.split("-"); return `${MES_NOMES[parseInt(m, 10) - 1]} ${y}`; };

function ContasReceberView({ contasReceber, accounts, canManage, onAdd, onMarcarRecebido, onLiberarBloqueio, onEditNota }) {
  const [modal, setModal] = useState(null);
  const [filtroMes, setFiltroMes] = useState(todayISO().slice(0, 7));

  const mesesDisponiveis = Array.from(new Set(
    contasReceber.map((n) => (n.status === "recebido" ? n.data_efetiva_recebimento : n.data_prevista_recebimento) || "").filter(Boolean).map((d) => d.slice(0, 7))
  )).sort();
  if (filtroMes && !mesesDisponiveis.includes(filtroMes)) mesesDisponiveis.push(filtroMes);
  mesesDisponiveis.sort();

  const noMes = (data) => !filtroMes || (data || "").slice(0, 7) === filtroMes;

  const aReceber = contasReceber.filter((n) => n.status !== "recebido" && noMes(n.data_prevista_recebimento)).sort((a, b) => (a.data_prevista_recebimento || "").localeCompare(b.data_prevista_recebimento || ""));
  const recebidas = contasReceber.filter((n) => n.status === "recebido" && noMes(n.data_efetiva_recebimento)).sort((a, b) => (b.data_efetiva_recebimento || "").localeCompare(a.data_efetiva_recebimento || ""));

  const totais = {
    previsto: aReceber.reduce((s, n) => s + n.valor, 0),
    atrasado: aReceber.filter((n) => (n.data_prevista_recebimento || "") < todayISO()).reduce((s, n) => s + n.valor, 0),
    recebido: recebidas.reduce((s, n) => s + (n.valor_recebido || n.valor), 0),
    bloqueado: recebidas.reduce((s, n) => s + (n.valor_bloqueado || 0), 0),
    disponivel: recebidas.reduce((s, n) => s + ((n.valor_recebido || n.valor) - (n.valor_bloqueado || 0)), 0),
  };
  const totalGeral = aReceber.reduce((s, n) => s + n.valor, 0) + recebidas.reduce((s, n) => s + n.valor, 0);
  const percentRecebido = totalGeral > 0 ? (totais.recebido / totalGeral) * 100 : 0;

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <p className="font-semibold fin-display text-lg">Contas a Receber</p>
        <Select value={filtroMes} onChange={(e) => setFiltroMes(e.target.value)} className="w-auto">
          <option value="">Todos os meses</option>
          {mesesDisponiveis.map((ym) => <option key={ym} value={ym}>{fmtMesAno(ym)}</option>)}
        </Select>
      </div>

      <Card style={{ background: "var(--navy)", border: "none" }} className="text-white">
        <p className="text-xs uppercase tracking-wide mb-2" style={{ color: "var(--gold-soft)" }}>{filtroMes ? `Resumo de ${fmtMesAno(filtroMes)}` : "Resumo — todos os meses"}</p>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          <div><p className="text-xs" style={{ color: "#C7CEDC" }}>Total previsto</p><p className="fin-mono font-semibold text-lg">{fmtBRL(totalGeral)}</p></div>
          <div><p className="text-xs" style={{ color: "#C7CEDC" }}>Total recebido</p><p className="fin-mono font-semibold text-lg">{fmtBRL(totais.recebido)}</p></div>
          <div><p className="text-xs" style={{ color: "#C7CEDC" }}>A receber</p><p className="fin-mono font-semibold text-lg">{fmtBRL(totais.previsto)}</p></div>
          <div><p className="text-xs" style={{ color: "#C7CEDC" }}>% recebido</p><p className="fin-mono font-semibold text-lg">{percentRecebido.toFixed(1)}%</p></div>
        </div>
      </Card>

      <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
        <Card><p className="text-xs" style={{ color: "var(--ink-soft)" }}>A receber</p><Money v={totais.previsto} /></Card>
        <Card><p className="text-xs" style={{ color: "var(--ink-soft)" }}>Em atraso</p><Money v={totais.atrasado} tone="neg" /></Card>
        <Card><p className="text-xs" style={{ color: "var(--ink-soft)" }}>Recebido</p><Money v={totais.recebido} tone="pos" /></Card>
        <Card><p className="text-xs" style={{ color: "var(--ink-soft)" }}>Recebido bloqueado</p><Money v={totais.bloqueado} /></Card>
        <Card><p className="text-xs" style={{ color: "var(--ink-soft)" }}>Recebido disponível</p><Money v={totais.disponivel} tone="pos" /></Card>
      </div>

      {canManage && <Btn variant="gold" icon={Plus} onClick={() => setModal({ kind: "nova" })}>Nova nota a receber</Btn>}

      <div>
        <p className="font-semibold mb-2 fin-display">A receber</p>
        {aReceber.length === 0 ? <EmptyState text="Nenhuma nota a receber em aberto." /> : (
          <Card className="p-0 overflow-hidden">
            {aReceber.map((n, i) => {
              const atrasada = (n.data_prevista_recebimento || "") < todayISO();
              return (
                <div key={n.id} className="flex items-center justify-between px-4 py-3" style={{ borderTop: i ? "1px solid var(--line)" : "none" }}>
                  <div>
                    <p className="text-sm font-medium">{n.cliente} {atrasada && <Pill tone="red">Em atraso</Pill>}</p>
                    <p className="text-xs" style={{ color: "var(--ink-soft)" }}>{n.numero_nf ? `NF ${n.numero_nf} · ` : ""}previsto para {fmtDate(n.data_prevista_recebimento)}</p>
                  </div>
                  <div className="flex items-center gap-3">
                    <Money v={n.valor} size="sm" tone="pos" />
                    {canManage && <Btn variant="ghost" onClick={() => setModal({ kind: "editar", nota: n })}>Editar</Btn>}
                    {canManage && <Btn variant="gold" onClick={() => setModal({ kind: "receber", nota: n })}>Marcar recebido</Btn>}
                  </div>
                </div>
              );
            })}
          </Card>
        )}
      </div>

      {recebidas.length > 0 && (
        <div>
          <p className="font-semibold mb-2 fin-display" style={{ color: "var(--ink-soft)" }}>Recebidas</p>
          <Card className="p-0 overflow-hidden">
            {recebidas.map((n, i) => (
              <div key={n.id} className="flex items-center justify-between px-4 py-3" style={{ borderTop: i ? "1px solid var(--line)" : "none" }}>
                <div>
                  <p className="text-sm font-medium">{n.cliente} · recebido em {fmtDate(n.data_efetiva_recebimento)}</p>
                  <p className="text-xs" style={{ color: "var(--ink-soft)" }}>
                    Recebido <Money v={n.valor_recebido || n.valor} size="sm" />
                    {(n.valor_bloqueado || 0) > 0 && <> · bloqueado <Money v={n.valor_bloqueado} size="sm" tone="neg" /></>}
                  </p>
                </div>
                {canManage && (n.valor_bloqueado || 0) > 0 && <Btn variant="subtle" onClick={() => setModal({ kind: "liberar", nota: n })}>Liberar bloqueio</Btn>}
              </div>
            ))}
          </Card>
        </div>
      )}

      {modal?.kind === "nova" && <NovaNotaModal accounts={accounts.filter((a) => a.active)} onClose={() => setModal(null)} onSave={async (n) => { const ok = await onAdd(n); if (ok) setModal(null); return ok; }} />}
      {modal?.kind === "editar" && <EditNotaModal nota={modal.nota} accounts={accounts.filter((a) => a.active)} onClose={() => setModal(null)} onSave={async (n, p) => { const ok = await onEditNota(n, p); if (ok) setModal(null); return ok; }} />}
      {modal?.kind === "receber" && <MarcarRecebidoModal nota={modal.nota} accounts={accounts.filter((a) => a.active)} onClose={() => setModal(null)} onSave={async (n, p) => { const ok = await onMarcarRecebido(n, p); if (ok) setModal(null); return ok; }} />}
      {modal?.kind === "liberar" && <LiberarBloqueioModal nota={modal.nota} accounts={accounts.filter((a) => a.active)} onClose={() => setModal(null)} onSave={async (n, p) => { const ok = await onLiberarBloqueio(n, p); if (ok) setModal(null); return ok; }} />}
    </div>
  );
}

/* ============================================================
   VIEW: DESPESAS FIXAS / RECORRENTES
   Salários, boletos, parcelas de empréstimo. Ao "dar baixa" no mês, cria a despesa
   real ligada (ref_recurring_expense_id) — não duplica se já foi dada baixa no mês.
   ============================================================ */
function NovaDespesaFixaModal({ categories, onClose, onSave }) {
  const [descricao, setDescricao] = useState("");
  const [categoria, setCategoria] = useState(categories[0]?.name || "");
  const [valor, setValor] = useState("");
  const [diaVencimento, setDiaVencimento] = useState("5");
  const [pessoa, setPessoa] = useState("");
  const [tipoRecorrencia, setTipoRecorrencia] = useState("indefinida");
  const [parcelasTotais, setParcelasTotais] = useState("12");
  const [err, setErr] = useState("");
  const [saving, setSaving] = useState(false);

  const submit = async () => {
    const v = parseValorBR(valor);
    const dia = parseInt(diaVencimento, 10);
    if (!descricao.trim()) { setErr("Informe a descrição."); return; }
    if (!v || v <= 0) { setErr("Informe um valor válido."); return; }
    if (!dia || dia < 1 || dia > 31) { setErr("Informe um dia de vencimento válido (1-31)."); return; }
    setSaving(true);
    const parcelas = tipoRecorrencia === "parcelada" ? (parseInt(parcelasTotais, 10) || 1) : null;
    const ok = await onSave({
      descricao: descricao.trim(), categoria, valor: v, dia_vencimento: dia,
      pessoa: pessoa.trim(), tipo_recorrencia: tipoRecorrencia,
      parcelas_totais: parcelas, parcelas_restantes: parcelas, ativo: true,
    });
    setSaving(false);
    if (!ok) setErr("Não consegui salvar. Tente novamente.");
  };

  return (
    <Modal title="Nova despesa fixa" onClose={onClose}>
      <Field label="Descrição" required><TextInput value={descricao} onChange={(e) => setDescricao(e.target.value)} placeholder="Ex: Salário Alex, Aluguel, Parcela empréstimo BB" /></Field>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Valor da parcela (R$)" required><TextInput inputMode="decimal" value={valor} onChange={(e) => setValor(e.target.value)} placeholder="0,00" /></Field>
        <Field label="Dia do vencimento" required><TextInput inputMode="numeric" value={diaVencimento} onChange={(e) => setDiaVencimento(e.target.value)} placeholder="Ex: 5" /></Field>
      </div>
      <Field label="Categoria"><Select value={categoria} onChange={(e) => setCategoria(e.target.value)}>{categories.map((c) => <option key={c.id} value={c.name}>{c.name}</option>)}</Select></Field>
      <Card className="mb-3" style={{ background: "var(--teal-soft)", border: "none" }}>
        <p className="text-xs">A conta usada pra pagar você escolhe na hora de dar baixa a cada mês, já que pode variar.</p>
      </Card>
      <Field label="Pessoa / fornecedor"><TextInput value={pessoa} onChange={(e) => setPessoa(e.target.value)} /></Field>
      <Field label="Tipo">
        <Select value={tipoRecorrencia} onChange={(e) => setTipoRecorrencia(e.target.value)}>
          <option value="indefinida">Fixa (sem previsão de terminar)</option>
          <option value="parcelada">Parcelada (tem prazo pra acabar)</option>
        </Select>
      </Field>
      {tipoRecorrencia === "parcelada" && (
        <Field label="Quantidade de parcelas" required><TextInput inputMode="numeric" value={parcelasTotais} onChange={(e) => setParcelasTotais(e.target.value)} /></Field>
      )}
      {err && <p className="text-sm mb-2" style={{ color: "var(--red)" }}>{err}</p>}
      <div className="flex justify-end gap-2 mt-2">
        <Btn variant="ghost" onClick={onClose}>Cancelar</Btn>
        <Btn variant="gold" icon={Check} onClick={submit} disabled={saving}>{saving ? "Salvando..." : "Salvar despesa fixa"}</Btn>
      </div>
    </Modal>
  );
}

function DarBaixaRecorrenteModal({ despesa, accounts, mesReferencia, onClose, onSave }) {
  const dataDefault = mesReferencia === todayISO().slice(0, 7)
    ? todayISO()
    : `${mesReferencia}-${String(Math.min(despesa.dia_vencimento || 5, 28)).padStart(2, "0")}`;
  const [dataPagamento, setDataPagamento] = useState(dataDefault);
  const [valor, setValor] = useState(String(despesa.valor ?? "").replace(".", ","));
  const [juros, setJuros] = useState("0");
  const [conta, setConta] = useState(accounts[0]?.id || "");
  const [err, setErr] = useState("");
  const [saving, setSaving] = useState(false);

  const vParcela = parseValorBR(valor) || 0;
  const vJuros = parseValorBR(juros) || 0;
  const total = vParcela + vJuros;

  const submit = async () => {
    if (!vParcela || vParcela <= 0) { setErr("Informe o valor da parcela."); return; }
    if (!conta) { setErr("Selecione a conta."); return; }
    if (!dataPagamento) { setErr("Informe a data do pagamento."); return; }
    setSaving(true);
    const ok = await onSave(despesa, { dataPagamento, valorParcela: vParcela, juros: vJuros, valorTotal: total, conta });
    setSaving(false);
    if (!ok) setErr("Não consegui registrar. Tente novamente.");
  };

  return (
    <Modal title={`Dar baixa — ${despesa.descricao}`} onClose={onClose}>
      <Field label="Data do pagamento" required><TextInput type="date" value={dataPagamento} onChange={(e) => setDataPagamento(e.target.value)} /></Field>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Valor da parcela (R$)" required><TextInput inputMode="decimal" value={valor} onChange={(e) => setValor(e.target.value)} /></Field>
        <Field label="Juros / multa (R$)"><TextInput inputMode="decimal" value={juros} onChange={(e) => setJuros(e.target.value)} placeholder="0,00" /></Field>
      </div>
      <Field label="Conta utilizada" required><Select value={conta} onChange={(e) => setConta(e.target.value)}>{accounts.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}</Select></Field>
      <Card className="mb-3" style={{ background: "#EEEAE0", border: "none" }}>
        <p className="text-sm">Total a sair da conta: <Money v={total} size="sm" tone="neg" /></p>
      </Card>
      {err && <p className="text-sm mb-2" style={{ color: "var(--red)" }}>{err}</p>}
      <div className="flex justify-end gap-2 mt-2">
        <Btn variant="ghost" onClick={onClose}>Cancelar</Btn>
        <Btn variant="gold" icon={Check} onClick={submit} disabled={saving}>{saving ? "Registrando..." : "Confirmar baixa"}</Btn>
      </div>
    </Modal>
  );
}

function DespesasFixasView({ recurringExpenses, transactions, accounts, categories, canManage, onAdd, onToggleAtivo, onDarBaixa, onDesfazerBaixa }) {
  const [modal, setModal] = useState(null);
  const [filtroMes, setFiltroMes] = useState(() => {
    const corteMes = CORTE_HISTORICO.slice(0, 7);
    const agora = todayISO().slice(0, 7);
    return agora >= corteMes ? agora : corteMes;
  });
  const ativas = recurringExpenses.filter((r) => r.ativo);
  const inativas = recurringExpenses.filter((r) => !r.ativo);
  const totalMensal = ativas.reduce((s, r) => s + r.valor, 0);

  const mesesDisponiveis = (() => {
    const arr = [];
    const [anoCorte, mesCorteNum] = CORTE_HISTORICO.slice(0, 7).split("-").map(Number);
    const [anoAtual, mesAtualNum] = todayISO().slice(0, 7).split("-").map(Number);
    const totalMesesAteAtual = (anoAtual - anoCorte) * 12 + (mesAtualNum - mesCorteNum);
    for (let i = 0; i <= totalMesesAteAtual + 6; i++) {
      const d = new Date(anoCorte, mesCorteNum - 1 + i, 1);
      arr.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`);
    }
    return arr;
  })();

  const baixasDoMes = new Map();
  transactions.filter((t) => t.refRecurringExpenseId && (t.date || "").slice(0, 7) === filtroMes).forEach((t) => baixasDoMes.set(t.refRecurringExpenseId, t));

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <p className="font-semibold fin-display text-lg">Despesas Fixas</p>
        <Select value={filtroMes} onChange={(e) => setFiltroMes(e.target.value)} className="w-auto">
          {mesesDisponiveis.map((ym) => <option key={ym} value={ym}>{fmtMesAno(ym)}</option>)}
        </Select>
      </div>

      <Card><p className="text-xs" style={{ color: "var(--ink-soft)" }}>Total fixo por mês</p><Money v={totalMensal} tone="neg" size="lg" /></Card>
      {canManage && <Btn variant="gold" icon={Plus} onClick={() => setModal({ kind: "nova" })}>Nova despesa fixa</Btn>}

      <Card className="p-0 overflow-hidden">
        {ativas.length === 0 ? <div className="p-4"><EmptyState text="Nenhuma despesa fixa cadastrada." /></div> : ativas.map((r, i) => {
          const txBaixa = baixasDoMes.get(r.id);
          return (
            <div key={r.id} className="flex items-center justify-between px-4 py-3" style={{ borderTop: i ? "1px solid var(--line)" : "none" }}>
              <div>
                <p className="text-sm font-medium">
                  {r.descricao}
                  {r.tipo_recorrencia === "parcelada" && <Pill tone="teal"> {(r.parcelas_totais - r.parcelas_restantes) + 1}/{r.parcelas_totais}</Pill>}
                </p>
                <p className="text-xs" style={{ color: "var(--ink-soft)" }}>{r.categoria || "—"} · vence dia {r.dia_vencimento}{r.pessoa ? ` · ${r.pessoa}` : ""}</p>
              </div>
              <div className="flex items-center gap-3">
                <Money v={r.valor} size="sm" tone="neg" />
                {canManage && (
                  <>
                    {txBaixa ? (
                      <>
                        <Pill tone="green">Baixa dada · {accName(accounts, txBaixa.conta)}</Pill>
                        <Btn variant="ghost" onClick={() => onDesfazerBaixa(r, txBaixa)}>Desfazer baixa</Btn>
                      </>
                    ) : (
                      <Btn variant="gold" onClick={() => setModal({ kind: "baixar", despesa: r })}>Dar baixa · {fmtMesAno(filtroMes)}</Btn>
                    )}
                    <Btn variant="ghost" onClick={() => onToggleAtivo(r)}>Desativar</Btn>
                  </>
                )}
              </div>
            </div>
          );
        })}
      </Card>

      {inativas.length > 0 && (
        <div>
          <p className="font-semibold mb-2 fin-display" style={{ color: "var(--ink-soft)" }}>Inativas / quitadas</p>
          <Card className="p-0 overflow-hidden">
            {inativas.map((r, i) => (
              <div key={r.id} className="flex items-center justify-between px-4 py-2.5 text-sm" style={{ borderTop: i ? "1px solid var(--line)" : "none", opacity: 0.7 }}>
                <span>{r.descricao}</span>
                {canManage && <Btn variant="ghost" onClick={() => onToggleAtivo(r)}>Reativar</Btn>}
              </div>
            ))}
          </Card>
        </div>
      )}

      {modal?.kind === "nova" && <NovaDespesaFixaModal categories={categories.filter((c) => c.active)} onClose={() => setModal(null)} onSave={async (d) => { const ok = await onAdd(d); if (ok) setModal(null); return ok; }} />}
      {modal?.kind === "baixar" && <DarBaixaRecorrenteModal despesa={modal.despesa} accounts={accounts.filter((a) => a.active)} mesReferencia={filtroMes} onClose={() => setModal(null)} onSave={async (d, p) => { const ok = await onDarBaixa(d, p); if (ok) setModal(null); return ok; }} />}
    </div>
  );
}

/* ============================================================
   VIEW: FATURA DO CARTÃO
   ============================================================ */
function CartaoView({ transactions, accounts }) {
  const cartoes = accounts.filter((a) => a.tipo === "cartao_credito");
  const now = new Date();
  const [cartaoId, setCartaoId] = useState(cartoes[0]?.id || "");
  const [month, setMonth] = useState(now.getMonth() + 1);
  const [year, setYear] = useState(now.getFullYear());

  if (cartoes.length === 0) return <EmptyState text="Nenhum cartão de crédito cadastrado ainda (cadastre em Contas, com o tipo 'cartão de crédito')." />;

  const periodTx = filterByPeriod(transactions, month, year).filter((t) => t.type === "despesa" && t.conta === cartaoId);
  const total = periodTx.reduce((s, t) => s + t.valor, 0);
  const porCategoria = categoryBreakdown(periodTx);

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap gap-2 items-center">
        <Select value={cartaoId} onChange={(e) => setCartaoId(e.target.value)} style={{ width: 200 }}>
          {cartoes.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </Select>
        <Select value={month} onChange={(e) => setMonth(Number(e.target.value))} style={{ width: 160 }}>
          {Array.from({ length: 12 }, (_, i) => i + 1).map((m) => <option key={m} value={m}>{new Date(2000, m - 1, 1).toLocaleDateString("pt-BR", { month: "long" })}</option>)}
        </Select>
        <Select value={year} onChange={(e) => setYear(Number(e.target.value))} style={{ width: 110 }}>
          {[year - 1, year, year + 1].map((y) => <option key={y} value={y}>{y}</option>)}
        </Select>
      </div>
      <Card><p className="text-xs" style={{ color: "var(--ink-soft)" }}>Total gasto no cartão — {monthLabel(month, year)}</p><Money v={total} tone="neg" size="lg" /></Card>
      <Card>
        <p className="font-semibold mb-3 fin-display">Por categoria</p>
        {porCategoria.length === 0 ? <EmptyState text="Nenhuma compra no cartão neste período." /> : (
          <div className="space-y-2">
            {porCategoria.map((c) => (
              <div key={c.name} className="flex items-center justify-between py-1.5" style={{ borderBottom: "1px solid var(--line)" }}>
                <span className="text-sm">{c.name}</span>
                <Money v={c.value} size="sm" tone="neg" />
              </div>
            ))}
          </div>
        )}
      </Card>
    </div>
  );
}

/* ============================================================
   VIEW: APROVAÇÕES (edições feitas por quem não é admin)
   ============================================================ */
function AprovacoesView({ pendingEdits, transactions, isAdmin, onApprove, onReject }) {
  const pendentes = pendingEdits.filter((p) => p.status === "pending").sort((a, b) => (b.requested_at || "").localeCompare(a.requested_at || ""));
  const resolvidas = pendingEdits.filter((p) => p.status !== "pending").sort((a, b) => (b.reviewed_at || "").localeCompare(a.reviewed_at || "")).slice(0, 20);

  return (
    <div className="space-y-5">
      <Card style={{ background: "var(--teal-soft)", border: "none" }}>
        <p className="text-sm">{isAdmin ? "Edições feitas por quem não é administrador ficam aqui esperando sua aprovação." : "Suas edições de lançamentos passam por aqui até serem aprovadas pelo administrador."}</p>
      </Card>
      <div>
        <p className="font-semibold mb-2 fin-display">Pendentes</p>
        {pendentes.length === 0 ? <EmptyState text="Nenhuma edição pendente." /> : (
          <Card className="p-0 overflow-hidden">
            {pendentes.map((p, i) => {
              const tx = transactions.find((t) => t.id === p.transaction_id);
              return (
                <div key={p.id} className="px-4 py-3" style={{ borderTop: i ? "1px solid var(--line)" : "none" }}>
                  <p className="text-sm font-medium">{tx?.descricao || tx?.pessoa || "Lançamento"} <Pill tone="amber">pedido por {p.requested_by_name}</Pill></p>
                  <div className="text-xs mt-1 space-y-0.5" style={{ color: "var(--ink-soft)" }}>
                    {Object.entries(p.changes).map(([field, c]) => (
                      <p key={field}>{c.label}: <s>{c.old || "—"}</s> → <b>{c.new || "—"}</b></p>
                    ))}
                  </div>
                  {isAdmin && (
                    <div className="flex gap-2 mt-2">
                      <Btn variant="gold" onClick={() => onApprove(p)}>Aprovar</Btn>
                      <Btn variant="danger" onClick={() => onReject(p)}>Rejeitar</Btn>
                    </div>
                  )}
                </div>
              );
            })}
          </Card>
        )}
      </div>
      {resolvidas.length > 0 && (
        <div>
          <p className="font-semibold mb-2 fin-display" style={{ color: "var(--ink-soft)" }}>Últimas resolvidas</p>
          <Card className="p-0 overflow-hidden">
            {resolvidas.map((p, i) => (
              <div key={p.id} className="flex items-center justify-between px-4 py-2.5 text-sm" style={{ borderTop: i ? "1px solid var(--line)" : "none" }}>
                <span>Pedido de {p.requested_by_name}</span>
                <Pill tone={p.status === "approved" ? "green" : "red"}>{p.status === "approved" ? "Aprovada" : "Rejeitada"}</Pill>
              </div>
            ))}
          </Card>
        </div>
      )}
    </div>
  );
}

/* ============================================================
   RH — FUNCIONÁRIOS
   ============================================================ */
const CONTRATO_OPCOES = ["CLT", "PJ", "Temporário", "Intermitente", "Estagiário", "Outro"];

function NovoFuncionarioModal({ onClose, onSave, editing }) {
  const [nome, setNome] = useState(editing?.nome || "");
  const [empresa, setEmpresa] = useState(editing?.empresa || "Power Eletric");
  const [cargo, setCargo] = useState(editing?.cargo || "");
  const [tipoContrato, setTipoContrato] = useState(editing?.tipo_contrato || "CLT");
  const [salarioBase, setSalarioBase] = useState(editing ? String(editing.salario_base).replace(".", ",") : "");
  const [valorHora, setValorHora] = useState(editing?.valor_hora ? String(editing.valor_hora).replace(".", ",") : "");
  const [periculosidade, setPericulosidade] = useState(editing?.periculosidade_insalubridade || "");
  const [valorAdicional, setValorAdicional] = useState(editing?.valor_adicional ? String(editing.valor_adicional).replace(".", ",") : "");
  const [unidade, setUnidade] = useState(editing?.unidade || "");
  const [dataAdmissao, setDataAdmissao] = useState(editing?.data_admissao || todayISO());
  const [observacoes, setObservacoes] = useState(editing?.observacoes || "");
  const [err, setErr] = useState("");
  const [saving, setSaving] = useState(false);
  const isIntermitente = tipoContrato === "Intermitente";

  const submit = async () => {
    const sal = parseValorBR(salarioBase) || 0;
    const hora = parseValorBR(valorHora) || 0;
    if (!nome.trim()) { setErr("Informe o nome."); return; }
    if (isIntermitente) {
      if (!hora || hora <= 0) { setErr("Informe o valor da hora."); return; }
    } else if (!sal || sal <= 0) { setErr("Informe um salário-base válido."); return; }
    setSaving(true);
    const ok = await onSave({
      nome: nome.trim(), empresa, cargo: cargo.trim(), tipo_contrato: tipoContrato,
      salario_base: sal, valor_hora: hora || null,
      periculosidade_insalubridade: periculosidade || null,
      valor_adicional: parseValorBR(valorAdicional) || 0,
      unidade: unidade.trim(), data_admissao: dataAdmissao, observacoes: observacoes.trim(), status: "ativo",
    });
    setSaving(false);
    if (!ok) setErr("Não consegui salvar. Tente novamente.");
  };

  return (
    <Modal title={editing ? "Editar funcionário" : "Novo funcionário"} onClose={onClose}>
      <Field label="Nome" required><TextInput value={nome} onChange={(e) => setNome(e.target.value)} /></Field>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Empresa" required>
          <Select value={empresa} onChange={(e) => setEmpresa(e.target.value)}>
            <option value="Power Eletric">Power Eletric</option>
            <option value="Power Equipamentos">Power Equipamentos</option>
          </Select>
        </Field>
        <Field label="Cargo/função"><TextInput value={cargo} onChange={(e) => setCargo(e.target.value)} /></Field>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Tipo de contrato"><Select value={tipoContrato} onChange={(e) => setTipoContrato(e.target.value)}>{CONTRATO_OPCOES.map((c) => <option key={c} value={c}>{c}</option>)}</Select></Field>
        <Field label="Data de admissão"><TextInput type="date" value={dataAdmissao} onChange={(e) => setDataAdmissao(e.target.value)} /></Field>
      </div>
      {isIntermitente ? (
        <>
          <Card className="mb-3" style={{ background: "var(--teal-soft)", border: "none" }}>
            <p className="text-xs">Intermitente é pago por hora trabalhada, sem salário mensal fixo.</p>
          </Card>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Valor da hora (R$)" required><TextInput inputMode="decimal" value={valorHora} onChange={(e) => setValorHora(e.target.value)} placeholder="0,00" /></Field>
            <Field label="Salário-base (R$) — opcional"><TextInput inputMode="decimal" value={salarioBase} onChange={(e) => setSalarioBase(e.target.value)} placeholder="0,00" /></Field>
          </div>
        </>
      ) : (
        <Field label="Salário-base (R$)" required><TextInput inputMode="decimal" value={salarioBase} onChange={(e) => setSalarioBase(e.target.value)} placeholder="0,00" /></Field>
      )}
      <div className="grid grid-cols-2 gap-3">
        <Field label="Periculosidade/Insalubridade">
          <Select value={periculosidade} onChange={(e) => setPericulosidade(e.target.value)}>
            <option value="">Nenhum</option><option value="periculosidade">Periculosidade</option><option value="insalubridade">Insalubridade</option>
          </Select>
        </Field>
        <Field label="Valor/percentual do adicional (R$)"><TextInput inputMode="decimal" value={valorAdicional} onChange={(e) => setValorAdicional(e.target.value)} placeholder="0,00" /></Field>
      </div>
      <Field label="Unidade/local de trabalho"><TextInput value={unidade} onChange={(e) => setUnidade(e.target.value)} /></Field>
      <Field label="Observações"><TextInput value={observacoes} onChange={(e) => setObservacoes(e.target.value)} /></Field>
      {err && <p className="text-sm mb-2" style={{ color: "var(--red)" }}>{err}</p>}
      <div className="flex justify-end gap-2 mt-2">
        <Btn variant="ghost" onClick={onClose}>Cancelar</Btn>
        <Btn variant="gold" icon={Check} onClick={submit} disabled={saving}>{saving ? "Salvando..." : "Salvar"}</Btn>
      </div>
    </Modal>
  );
}

function FuncionariosView({ employees, canManage, onAdd, onEdit, onToggleStatus }) {
  const [q, setQ] = useState("");
  const [modal, setModal] = useState(null);
  const ativos = employees.filter((e) => e.status === "ativo");
  const inativos = employees.filter((e) => e.status === "inativo");
  const filtro = (list) => list.filter((e) => !q.trim() || `${e.nome} ${e.cargo}`.toLowerCase().includes(q.toLowerCase()));

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap gap-2 items-center">
        <TextInput placeholder="Buscar por nome ou cargo..." value={q} onChange={(e) => setQ(e.target.value)} style={{ maxWidth: 280 }} />
        {canManage && <Btn variant="gold" icon={Plus} className="ml-auto" onClick={() => setModal({ kind: "novo" })}>Novo funcionário</Btn>}
      </div>
      <Card className="p-0 overflow-hidden">
        {filtro(ativos).length === 0 ? <div className="p-4"><EmptyState text="Nenhum funcionário ativo encontrado." /></div> : filtro(ativos).map((f, i) => {
          const isIntermitente = f.tipo_contrato === "Intermitente";
          const adicional = f.periculosidade_insalubridade ? (f.valor_adicional || 0) : 0;
          const totalComAdicional = f.salario_base + adicional;
          const valorHora = isIntermitente ? (f.valor_hora || 0) : f.salario_base / 220;
          return (
            <div key={f.id} className="flex items-center justify-between px-4 py-3" style={{ borderTop: i ? "1px solid var(--line)" : "none" }}>
              <div>
                <p className="text-sm font-medium">{f.nome} {f.periculosidade_insalubridade && <Pill tone="amber">{f.periculosidade_insalubridade}</Pill>} {isIntermitente && <Pill tone="teal">intermitente</Pill>}</p>
                <p className="text-xs" style={{ color: "var(--ink-soft)" }}>{f.empresa ? `${f.empresa} · ` : ""}{f.cargo || "—"} · {f.tipo_contrato} · {f.unidade || "—"} · admitido em {fmtDate(f.data_admissao)}</p>
              </div>
              <div className="flex items-center gap-3">
                <div className="text-right">
                  {isIntermitente ? (
                    <>
                      <Money v={valorHora} size="sm" />
                      <p className="text-xs" style={{ color: "var(--ink-soft)" }}>por hora{adicional > 0 ? ` + ${f.periculosidade_insalubridade} ${fmtBRL(adicional)}` : ""}</p>
                    </>
                  ) : (
                    <>
                      <Money v={totalComAdicional} size="sm" />
                      <p className="text-xs" style={{ color: "var(--ink-soft)" }}>
                        {adicional > 0 ? `base ${fmtBRL(f.salario_base)} + ${f.periculosidade_insalubridade} ${fmtBRL(adicional)}` : `hora ≈ ${fmtBRL(valorHora)}`}
                      </p>
                    </>
                  )}
                </div>
                {canManage && (
                  <>
                    <Btn variant="ghost" onClick={() => setModal({ kind: "editar", employee: f })}>Editar</Btn>
                    <Btn variant="ghost" onClick={() => onToggleStatus(f)}>Desativar</Btn>
                  </>
                )}
              </div>
            </div>
          );
        })}
      </Card>
      {inativos.length > 0 && (
        <div>
          <p className="font-semibold mb-2 fin-display" style={{ color: "var(--ink-soft)" }}>Inativos</p>
          <Card className="p-0 overflow-hidden">
            {filtro(inativos).map((f, i) => (
              <div key={f.id} className="flex items-center justify-between px-4 py-2.5 text-sm" style={{ borderTop: i ? "1px solid var(--line)" : "none", opacity: 0.7 }}>
                <span>{f.nome}</span>
                {canManage && <Btn variant="ghost" onClick={() => onToggleStatus(f)}>Reativar</Btn>}
              </div>
            ))}
          </Card>
        </div>
      )}
      {modal?.kind === "novo" && <NovoFuncionarioModal onClose={() => setModal(null)} onSave={async (d) => { const ok = await onAdd(d); if (ok) setModal(null); return ok; }} />}
      {modal?.kind === "editar" && <NovoFuncionarioModal editing={modal.employee} onClose={() => setModal(null)} onSave={async (d) => { const ok = await onEdit(modal.employee, d); if (ok) setModal(null); return ok; }} />}
    </div>
  );
}

/* ============================================================
   RH — FOLHA DE PAGAMENTO
   ============================================================ */
function payrollTotal(p) {
  return (p.salario || 0) + (p.adiantamento || 0) + (p.vale_mercado || 0) + (p.vale_transporte || 0) + (p.vale_refeicao || 0) + (p.horas_extras || 0) + (p.ajuda_custo || 0) + (p.outros_proventos || 0) - (p.descontos || 0);
}
function payrollStatus(p, pago) {
  const total = payrollTotal(p);
  if (pago >= total - 0.009 && total > 0) return "pago";
  if (pago > 0.009) return "parcial";
  if ((p.data_prevista_pagamento || "") < todayISO()) return "atrasado";
  return "previsto";
}
const PAYROLL_STATUS_META = {
  previsto: { label: "Previsto", tone: "amber" }, parcial: { label: "Parcial", tone: "teal" },
  pago: { label: "Pago", tone: "green" }, atrasado: { label: "Atrasado", tone: "red" },
};

function RegistrarPagamentoFolhaModal({ entry, funcionario, pendente, accounts, onClose, onSave }) {
  const [dataPagamento, setDataPagamento] = useState(todayISO());
  const [valorPago, setValorPago] = useState(String(pendente.toFixed(2)).replace(".", ","));
  const [conta, setConta] = useState(accounts[0]?.id || "");
  const [observacao, setObservacao] = useState("");
  const [err, setErr] = useState("");
  const [saving, setSaving] = useState(false);

  const submit = async () => {
    const v = parseValorBR(valorPago);
    if (!v || v <= 0) { setErr("Informe um valor válido."); return; }
    if (!conta) { setErr("Selecione a conta."); return; }
    setSaving(true);
    const ok = await onSave(entry, { dataPagamento, valorPago: v, conta, observacao: observacao.trim() });
    setSaving(false);
    if (!ok) setErr("Não consegui registrar. Tente novamente.");
  };

  return (
    <Modal title={`Registrar pagamento — ${funcionario.nome}`} onClose={onClose}>
      <Card className="mb-4" style={{ background: "var(--amber-soft)", border: "none" }}>
        <p className="text-sm">Total a pagar: <Money v={payrollTotal(entry)} size="sm" /> · Pendente: <Money v={pendente} size="sm" tone="neg" /></p>
      </Card>
      <Field label="Data do pagamento" required><TextInput type="date" value={dataPagamento} onChange={(e) => setDataPagamento(e.target.value)} /></Field>
      <Field label="Valor pago (R$)" required><TextInput inputMode="decimal" value={valorPago} onChange={(e) => setValorPago(e.target.value)} /></Field>
      <Field label="Conta utilizada" required><Select value={conta} onChange={(e) => setConta(e.target.value)}>{accounts.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}</Select></Field>
      <Field label="Observação"><TextInput value={observacao} onChange={(e) => setObservacao(e.target.value)} /></Field>
      {err && <p className="text-sm mb-2" style={{ color: "var(--red)" }}>{err}</p>}
      <div className="flex justify-end gap-2 mt-2">
        <Btn variant="ghost" onClick={onClose}>Cancelar</Btn>
        <Btn variant="gold" icon={Check} onClick={submit} disabled={saving}>{saving ? "Registrando..." : "Confirmar pagamento"}</Btn>
      </div>
    </Modal>
  );
}

function FolhaRow({ entry, funcionario, pagamentos, accounts, canManage, onUpdateField, onPagar }) {
  const [local, setLocal] = useState({
    adiantamento: entry.adiantamento, vale_mercado: entry.vale_mercado, vale_transporte: entry.vale_transporte, vale_refeicao: entry.vale_refeicao,
    horas_extras: entry.horas_extras, ajuda_custo: entry.ajuda_custo, outros_proventos: entry.outros_proventos, descontos: entry.descontos,
  });
  const pago = pagamentos.filter((p) => p.payroll_entry_id === entry.id).reduce((s, p) => s + p.valor_pago, 0);
  const total = payrollTotal({ ...entry, ...local });
  const pendente = total - pago;
  const status = payrollStatus({ ...entry, ...local }, pago);
  const meta = PAYROLL_STATUS_META[status];

  const commit = (field) => {
    const v = parseValorBR(local[field]) || 0;
    if (v !== entry[field]) onUpdateField(entry, field, v);
  };
  const numInput = (field, w = 90) => (
    <TextInput inputMode="decimal" disabled={!canManage} value={local[field]} style={{ width: w, padding: "6px 8px", fontSize: 13 }}
      onChange={(e) => setLocal((s) => ({ ...s, [field]: e.target.value }))} onBlur={() => commit(field)} />
  );

  return (
    <tr className="border-t" style={{ borderColor: "var(--line)" }}>
      <td className="px-3 py-2 text-sm whitespace-nowrap">{funcionario?.nome || "—"}</td>
      <td className="px-3 py-2 fin-mono text-xs whitespace-nowrap">{fmtBRL(entry.salario)}</td>
      <td className="px-2 py-2">{numInput("adiantamento")}</td>
      <td className="px-2 py-2">{numInput("vale_mercado")}</td>
      <td className="px-2 py-2">{numInput("vale_transporte")}</td>
      <td className="px-2 py-2">{numInput("vale_refeicao")}</td>
      <td className="px-2 py-2">{numInput("horas_extras")}</td>
      <td className="px-2 py-2">{numInput("ajuda_custo")}</td>
      <td className="px-2 py-2">{numInput("outros_proventos")}</td>
      <td className="px-2 py-2">{numInput("descontos")}</td>
      <td className="px-3 py-2 fin-mono text-xs font-semibold whitespace-nowrap">{fmtBRL(total)}</td>
      <td className="px-3 py-2 fin-mono text-xs whitespace-nowrap" style={{ color: "var(--green)" }}>{fmtBRL(pago)}</td>
      <td className="px-3 py-2 fin-mono text-xs whitespace-nowrap" style={{ color: pendente > 0.009 ? "var(--red)" : "var(--ink-soft)" }}>{fmtBRL(Math.max(0, pendente))}</td>
      <td className="px-2 py-2 whitespace-nowrap"><Pill tone={meta.tone}>{meta.label}</Pill></td>
      <td className="px-2 py-2 whitespace-nowrap">
        {canManage && pendente > 0.009 && <Btn variant="gold" onClick={() => onPagar(entry, funcionario, pendente)}>Pagar</Btn>}
      </td>
    </tr>
  );
}

function FolhaPagamentoView({ employees, payrollEntries, payrollPayments, accounts, canManage, onEnsureEntries, onUpdateField, onPagar }) {
  const now = new Date();
  const [month, setMonth] = useState(now.getMonth() + 1);
  const [year, setYear] = useState(now.getFullYear());
  const [modal, setModal] = useState(null);
  const competencia = `${year}-${String(month).padStart(2, "0")}-01`;
  const ativos = employees.filter((e) => e.status === "ativo");

  useEffect(() => { onEnsureEntries(competencia, ativos); }, [competencia]); // eslint-disable-line

  const entriesDoMes = payrollEntries.filter((p) => p.competencia === competencia);
  const totals = entriesDoMes.reduce((acc, e) => {
    const pago = payrollPayments.filter((p) => p.payroll_entry_id === e.id).reduce((s, p) => s + p.valor_pago, 0);
    const total = payrollTotal(e);
    acc.total += total; acc.pago += pago; acc.pendente += Math.max(0, total - pago);
    if (payrollStatus(e, pago) === "atrasado") acc.atrasadas += 1;
    return acc;
  }, { total: 0, pago: 0, pendente: 0, atrasadas: 0 });

  return (
    <div className="space-y-5">
      <div className="flex items-center gap-2 flex-wrap">
        <Select value={month} onChange={(e) => setMonth(Number(e.target.value))} style={{ width: 160 }}>
          {Array.from({ length: 12 }, (_, i) => i + 1).map((m) => <option key={m} value={m}>{new Date(2000, m - 1, 1).toLocaleDateString("pt-BR", { month: "long" })}</option>)}
        </Select>
        <Select value={year} onChange={(e) => setYear(Number(e.target.value))} style={{ width: 110 }}>{[year - 1, year, year + 1].map((y) => <option key={y} value={y}>{y}</option>)}</Select>
      </div>
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <Card><p className="text-xs" style={{ color: "var(--ink-soft)" }}>Total da folha</p><Money v={totals.total} tone="neg" /></Card>
        <Card><p className="text-xs" style={{ color: "var(--ink-soft)" }}>Já pago</p><Money v={totals.pago} tone="pos" /></Card>
        <Card><p className="text-xs" style={{ color: "var(--ink-soft)" }}>Pendente</p><Money v={totals.pendente} tone="neg" /></Card>
        <Card><p className="text-xs" style={{ color: "var(--ink-soft)" }}>Atrasadas</p><p className="fin-mono text-xl font-semibold" style={{ color: totals.atrasadas > 0 ? "var(--red)" : "var(--ink)" }}>{totals.atrasadas}</p></Card>
      </div>
      <Card className="p-0 overflow-hidden">
        <div className="fin-scroll overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr style={{ background: "#F0ECE0", color: "var(--ink-soft)" }}>
                {["Funcionário", "Salário", "Adiant.", "Vale merc.", "Vale transp.", "Vale refeição", "H. extras", "Ajuda custo", "Outros", "Descontos", "Total", "Pago", "Pendente", "Status", ""].map((h) => (
                  <th key={h} className="text-left px-2 py-2 font-medium text-xs whitespace-nowrap">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {entriesDoMes.length === 0 && <tr><td colSpan={15}><EmptyState text="Nenhum funcionário ativo nesta competência." /></td></tr>}
              {entriesDoMes.map((entry) => (
                <FolhaRow key={entry.id} entry={entry} funcionario={ativos.find((f) => f.id === entry.funcionario_id)}
                  pagamentos={payrollPayments} accounts={accounts.filter((a) => a.active)} canManage={canManage}
                  onUpdateField={onUpdateField} onPagar={(e, f, pend) => setModal({ entry: e, funcionario: f, pendente: pend })} />
              ))}
            </tbody>
          </table>
        </div>
      </Card>
      {modal && <RegistrarPagamentoFolhaModal entry={modal.entry} funcionario={modal.funcionario} pendente={modal.pendente} accounts={accounts.filter((a) => a.active)} onClose={() => setModal(null)} onSave={async (e, p) => { const ok = await onPagar(e, p); if (ok) setModal(null); return ok; }} />}
    </div>
  );
}

/* ============================================================
   RH — HORAS EXTRAS
   Valor calculado alimenta automaticamente a folha (payroll_entries.horas_extras)
   do funcionário na competência correspondente, somando todos os registros do mês.
   ============================================================ */
function firstOfMonth(dateStr) { return (dateStr || "").slice(0, 7) + "-01"; }

function NovaHoraExtraModal({ employees, onClose, onSave }) {
  const [funcionarioId, setFuncionarioId] = useState(employees[0]?.id || "");
  const [data, setData] = useState(todayISO());
  const [quantidadeHoras, setQuantidadeHoras] = useState("");
  const [percentual, setPercentual] = useState("50");
  const [motivo, setMotivo] = useState("");
  const [local, setLocal] = useState("");
  const [autorizadoPor, setAutorizadoPor] = useState("");
  const [err, setErr] = useState("");
  const [saving, setSaving] = useState(false);

  const funcionario = employees.find((f) => f.id === funcionarioId);
  const horas = parseValorBR(quantidadeHoras) || 0;
  const perc = parseValorBR(percentual) || 0;
  const valorHoraNormal = funcionario ? (funcionario.tipo_contrato === "Intermitente" ? (funcionario.valor_hora || 0) : funcionario.salario_base / 220) : 0;
  const valorCalculado = valorHoraNormal * (1 + perc / 100) * horas;

  const submit = async () => {
    if (!funcionarioId) { setErr("Selecione o funcionário."); return; }
    if (!horas || horas <= 0) { setErr("Informe a quantidade de horas."); return; }
    setSaving(true);
    const ok = await onSave({
      funcionario_id: funcionarioId, data, quantidade_horas: horas, percentual: perc,
      valor_calculado: valorCalculado, motivo: motivo.trim(), local: local.trim(),
      autorizado_por: autorizadoPor.trim(), competencia: firstOfMonth(data),
    });
    setSaving(false);
    if (!ok) setErr("Não consegui salvar. Tente novamente.");
  };

  return (
    <Modal title="Registrar hora extra" onClose={onClose}>
      <Field label="Funcionário" required><Select value={funcionarioId} onChange={(e) => setFuncionarioId(e.target.value)}>{employees.map((f) => <option key={f.id} value={f.id}>{f.nome}</option>)}</Select></Field>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Data" required><TextInput type="date" value={data} onChange={(e) => setData(e.target.value)} /></Field>
        <Field label="Quantidade de horas" required><TextInput inputMode="decimal" value={quantidadeHoras} onChange={(e) => setQuantidadeHoras(e.target.value)} placeholder="Ex: 2" /></Field>
      </div>
      <Field label="Percentual da hora extra (%)"><TextInput inputMode="decimal" value={percentual} onChange={(e) => setPercentual(e.target.value)} placeholder="50 ou 100" /></Field>
      <Card className="mb-3" style={{ background: "var(--teal-soft)", border: "none" }}>
        <p className="text-sm">Valor calculado (baseado no salário-base ÷ 220h): <Money v={valorCalculado} size="sm" /></p>
      </Card>
      <Field label="Motivo/atividade"><TextInput value={motivo} onChange={(e) => setMotivo(e.target.value)} /></Field>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Local/unidade"><TextInput value={local} onChange={(e) => setLocal(e.target.value)} /></Field>
        <Field label="Quem autorizou"><TextInput value={autorizadoPor} onChange={(e) => setAutorizadoPor(e.target.value)} /></Field>
      </div>
      {err && <p className="text-sm mb-2" style={{ color: "var(--red)" }}>{err}</p>}
      <div className="flex justify-end gap-2 mt-2">
        <Btn variant="ghost" onClick={onClose}>Cancelar</Btn>
        <Btn variant="gold" icon={Check} onClick={submit} disabled={saving}>{saving ? "Salvando..." : "Salvar"}</Btn>
      </div>
    </Modal>
  );
}

function HorasExtrasView({ overtimeEntries, employees, canManage, onAdd }) {
  const [modal, setModal] = useState(null);
  const ordenadas = [...overtimeEntries].sort((a, b) => (b.data || "").localeCompare(a.data || ""));
  const totalHoras = overtimeEntries.reduce((s, o) => s + o.quantidade_horas, 0);
  const totalValor = overtimeEntries.reduce((s, o) => s + o.valor_calculado, 0);

  return (
    <div className="space-y-5">
      <div className="grid grid-cols-2 gap-3">
        <Card><p className="text-xs" style={{ color: "var(--ink-soft)" }}>Total de horas extras</p><p className="fin-mono text-xl font-semibold">{totalHoras.toFixed(1)}h</p></Card>
        <Card><p className="text-xs" style={{ color: "var(--ink-soft)" }}>Valor total</p><Money v={totalValor} tone="neg" size="lg" /></Card>
      </div>
      {canManage && <Btn variant="gold" icon={Plus} onClick={() => setModal({ kind: "nova" })}>Registrar hora extra</Btn>}
      <Card className="p-0 overflow-hidden">
        {ordenadas.length === 0 ? <div className="p-4"><EmptyState text="Nenhuma hora extra registrada." /></div> : ordenadas.map((o, i) => {
          const f = employees.find((e) => e.id === o.funcionario_id);
          return (
            <div key={o.id} className="flex items-center justify-between px-4 py-2.5" style={{ borderTop: i ? "1px solid var(--line)" : "none" }}>
              <div>
                <p className="text-sm font-medium">{f?.nome || "—"}</p>
                <p className="text-xs" style={{ color: "var(--ink-soft)" }}>{fmtDate(o.data)} · {o.quantidade_horas}h a {o.percentual}% {o.motivo ? `· ${o.motivo}` : ""}</p>
              </div>
              <Money v={o.valor_calculado} size="sm" tone="neg" />
            </div>
          );
        })}
      </Card>
      {modal?.kind === "nova" && <NovaHoraExtraModal employees={employees.filter((e) => e.status === "ativo")} onClose={() => setModal(null)} onSave={async (d) => { const ok = await onAdd(d); if (ok) setModal(null); return ok; }} />}
    </div>
  );
}

/* ============================================================
   RH — DOCUMENTOS / ASO / NRs
   ============================================================ */
function docStatus(dataVencimento) {
  if (!dataVencimento) return { label: "Sem vencimento", tone: "neutral", dias: null };
  const dias = Math.ceil((new Date(dataVencimento + "T00:00:00") - new Date(todayISO() + "T00:00:00")) / 86400000);
  if (dias < 0) return { label: `Vencido há ${Math.abs(dias)} dias`, tone: "red", emoji: "🔴", dias };
  if (dias <= 7) return { label: `Vence em ${dias} dias`, tone: "amber", emoji: "🟠", dias };
  if (dias <= 30) return { label: `Vence em ${dias} dias`, tone: "amber", emoji: "🟡", dias };
  if (dias <= 60) return { label: `Vence em ${dias} dias`, tone: "amber", emoji: "🟡", dias };
  return { label: "Em dia", tone: "green", emoji: "🟢", dias };
}
const ASO_SUBTIPOS = ["Admissional", "Periódico", "Retorno ao trabalho", "Mudança de função", "Demissional"];

function NovoTipoDocumentoModal({ onClose, onSave }) {
  const [nome, setNome] = useState("");
  const [err, setErr] = useState("");
  const [saving, setSaving] = useState(false);
  const submit = async () => {
    if (!nome.trim()) { setErr("Informe o nome."); return; }
    setSaving(true);
    const ok = await onSave(nome.trim());
    setSaving(false);
    if (!ok) setErr("Não consegui salvar (talvez já exista esse tipo).");
  };
  return (
    <Modal title="Novo tipo de documento/NR" onClose={onClose}>
      <Field label="Nome" required><TextInput value={nome} onChange={(e) => setNome(e.target.value)} placeholder="Ex: NR-12, Certificado X" /></Field>
      {err && <p className="text-sm mb-2" style={{ color: "var(--red)" }}>{err}</p>}
      <div className="flex justify-end gap-2 mt-2">
        <Btn variant="ghost" onClick={onClose}>Cancelar</Btn>
        <Btn variant="gold" icon={Check} onClick={submit} disabled={saving}>{saving ? "Salvando..." : "Salvar"}</Btn>
      </div>
    </Modal>
  );
}

function NovoDocumentoModal({ employees, tipos, onClose, onSave }) {
  const [funcionarioId, setFuncionarioId] = useState(employees[0]?.id || "");
  const [tipoDocumento, setTipoDocumento] = useState(tipos[0]?.nome || "");
  const [subtipoAso, setSubtipoAso] = useState(ASO_SUBTIPOS[0]);
  const [dataRealizacao, setDataRealizacao] = useState(todayISO());
  const [dataValidade, setDataValidade] = useState("");
  const [dataVencimento, setDataVencimento] = useState("");
  const [unidade, setUnidade] = useState("");
  const [observacoes, setObservacoes] = useState("");
  const [anexoUrl, setAnexoUrl] = useState("");
  const [err, setErr] = useState("");
  const [saving, setSaving] = useState(false);

  const submit = async () => {
    if (!funcionarioId) { setErr("Selecione o funcionário."); return; }
    if (!tipoDocumento) { setErr("Selecione o tipo."); return; }
    setSaving(true);
    const ok = await onSave({
      funcionario_id: funcionarioId, tipo_documento: tipoDocumento,
      subtipo_aso: tipoDocumento === "ASO" ? subtipoAso : null,
      data_realizacao: dataRealizacao || null, data_validade: dataValidade || null,
      data_vencimento: dataVencimento || null, unidade: unidade.trim(),
      observacoes: observacoes.trim(), anexo_url: anexoUrl.trim() || null,
    });
    setSaving(false);
    if (!ok) setErr("Não consegui salvar. Tente novamente.");
  };

  return (
    <Modal title="Novo documento/NR" onClose={onClose}>
      <Field label="Funcionário" required><Select value={funcionarioId} onChange={(e) => setFuncionarioId(e.target.value)}>{employees.map((f) => <option key={f.id} value={f.id}>{f.nome}</option>)}</Select></Field>
      <Field label="Tipo de documento/NR" required><Select value={tipoDocumento} onChange={(e) => setTipoDocumento(e.target.value)}>{tipos.map((t) => <option key={t.id} value={t.nome}>{t.nome}</option>)}</Select></Field>
      {tipoDocumento === "ASO" && (
        <Field label="Tipo de ASO"><Select value={subtipoAso} onChange={(e) => setSubtipoAso(e.target.value)}>{ASO_SUBTIPOS.map((s) => <option key={s} value={s}>{s}</option>)}</Select></Field>
      )}
      <div className="grid grid-cols-2 gap-3">
        <Field label="Data de realização"><TextInput type="date" value={dataRealizacao} onChange={(e) => setDataRealizacao(e.target.value)} /></Field>
        <Field label="Data de validade"><TextInput type="date" value={dataValidade} onChange={(e) => setDataValidade(e.target.value)} /></Field>
      </div>
      <Field label="Data de vencimento" required><TextInput type="date" value={dataVencimento} onChange={(e) => setDataVencimento(e.target.value)} /></Field>
      <Field label="Unidade/local"><TextInput value={unidade} onChange={(e) => setUnidade(e.target.value)} /></Field>
      <Field label="Link do anexo (opcional)"><TextInput value={anexoUrl} onChange={(e) => setAnexoUrl(e.target.value)} placeholder="Cole aqui o link do documento, se tiver" /></Field>
      <Field label="Observações"><TextInput value={observacoes} onChange={(e) => setObservacoes(e.target.value)} /></Field>
      {err && <p className="text-sm mb-2" style={{ color: "var(--red)" }}>{err}</p>}
      <div className="flex justify-end gap-2 mt-2">
        <Btn variant="ghost" onClick={onClose}>Cancelar</Btn>
        <Btn variant="gold" icon={Check} onClick={submit} disabled={saving}>{saving ? "Salvando..." : "Salvar"}</Btn>
      </div>
    </Modal>
  );
}

function DocumentosView({ documentos, tipos, employees, canManage, onAdd, onAddTipo }) {
  const [modal, setModal] = useState(null);
  const comStatus = documentos.map((d) => ({ ...d, statusCalc: docStatus(d.data_vencimento) }));
  const ordenados = [...comStatus].sort((a, b) => (a.statusCalc.dias ?? 999999) - (b.statusCalc.dias ?? 999999));
  const vencidos = comStatus.filter((d) => d.statusCalc.dias !== null && d.statusCalc.dias < 0).length;
  const em7 = comStatus.filter((d) => d.statusCalc.dias !== null && d.statusCalc.dias >= 0 && d.statusCalc.dias <= 7).length;
  const em30 = comStatus.filter((d) => d.statusCalc.dias !== null && d.statusCalc.dias > 7 && d.statusCalc.dias <= 30).length;

  return (
    <div className="space-y-5">
      <div className="grid grid-cols-3 gap-3">
        <Card><p className="text-xs" style={{ color: "var(--ink-soft)" }}>🔴 Vencidos</p><p className="fin-mono text-xl font-semibold" style={{ color: "var(--red)" }}>{vencidos}</p></Card>
        <Card><p className="text-xs" style={{ color: "var(--ink-soft)" }}>🟠 Em até 7 dias</p><p className="fin-mono text-xl font-semibold" style={{ color: "var(--amber)" }}>{em7}</p></Card>
        <Card><p className="text-xs" style={{ color: "var(--ink-soft)" }}>🟡 Em até 30 dias</p><p className="fin-mono text-xl font-semibold" style={{ color: "var(--amber)" }}>{em30}</p></Card>
      </div>
      {canManage && (
        <div className="flex gap-2">
          <Btn variant="gold" icon={Plus} onClick={() => setModal({ kind: "novo" })}>Novo documento</Btn>
          <Btn variant="ghost" icon={Plus} onClick={() => setModal({ kind: "novo-tipo" })}>Adicionar documento/NR</Btn>
        </div>
      )}
      <Card className="p-0 overflow-hidden">
        {ordenados.length === 0 ? <div className="p-4"><EmptyState text="Nenhum documento cadastrado." /></div> : ordenados.map((d, i) => {
          const f = employees.find((e) => e.id === d.funcionario_id);
          return (
            <div key={d.id} className="flex items-center justify-between px-4 py-3" style={{ borderTop: i ? "1px solid var(--line)" : "none" }}>
              <div>
                <p className="text-sm font-medium">{f?.nome || "—"} — {d.tipo_documento}{d.subtipo_aso ? ` (${d.subtipo_aso})` : ""}</p>
                <p className="text-xs" style={{ color: "var(--ink-soft)" }}>{d.unidade ? `${d.unidade} · ` : ""}vencimento {fmtDate(d.data_vencimento)}</p>
              </div>
              <Pill tone={d.statusCalc.tone}>{d.statusCalc.emoji} {d.statusCalc.label}</Pill>
            </div>
          );
        })}
      </Card>
      {modal?.kind === "novo" && <NovoDocumentoModal employees={employees.filter((e) => e.status === "ativo")} tipos={tipos.filter((t) => t.ativo)} onClose={() => setModal(null)} onSave={async (d) => { const ok = await onAdd(d); if (ok) setModal(null); return ok; }} />}
      {modal?.kind === "novo-tipo" && <NovoTipoDocumentoModal onClose={() => setModal(null)} onSave={async (n) => { const ok = await onAddTipo(n); if (ok) setModal(null); return ok; }} />}
    </div>
  );
}

/* ============================================================
   RH — ACORDOS
   ============================================================ */
function parcelaStatus(p) {
  if (p.status === "paga") return { label: "Paga", tone: "green" };
  if (p.valor_pago > 0.009) return { label: "Parcial", tone: "teal" };
  if ((p.vencimento || "") < todayISO()) return { label: "Atrasada", tone: "red" };
  return { label: "Prevista", tone: "amber" };
}

function NovoAcordoModal({ employees, onClose, onSave }) {
  const [funcionarioId, setFuncionarioId] = useState(employees[0]?.id || "");
  const [tipoAcordo, setTipoAcordo] = useState("");
  const [motivo, setMotivo] = useState("");
  const [dataAcordo, setDataAcordo] = useState(todayISO());
  const [valorTotal, setValorTotal] = useState("");
  const [qtdParcelas, setQtdParcelas] = useState("1");
  const [primeiroVencimento, setPrimeiroVencimento] = useState(todayISO());
  const [formaPagamento, setFormaPagamento] = useState("");
  const [observacoes, setObservacoes] = useState("");
  const [anexoUrl, setAnexoUrl] = useState("");
  const [err, setErr] = useState("");
  const [saving, setSaving] = useState(false);

  const total = parseValorBR(valorTotal) || 0;
  const qtd = parseInt(qtdParcelas, 10) || 1;
  const valorParcela = qtd > 0 ? total / qtd : 0;

  const submit = async () => {
    if (!funcionarioId) { setErr("Selecione o funcionário."); return; }
    if (!total || total <= 0) { setErr("Informe o valor total."); return; }
    if (!qtd || qtd <= 0) { setErr("Informe a quantidade de parcelas."); return; }
    setSaving(true);
    const ok = await onSave({
      funcionario_id: funcionarioId, tipo_acordo: tipoAcordo.trim(), motivo: motivo.trim(),
      data_acordo: dataAcordo, valor_total: total, qtd_parcelas: qtd, valor_parcela: valorParcela,
      primeiro_vencimento: primeiroVencimento, forma_pagamento: formaPagamento.trim(),
      observacoes: observacoes.trim(), anexo_url: anexoUrl.trim() || null,
    });
    setSaving(false);
    if (!ok) setErr("Não consegui salvar. Tente novamente.");
  };

  return (
    <Modal title="Novo acordo" onClose={onClose} wide>
      <Field label="Funcionário" required><Select value={funcionarioId} onChange={(e) => setFuncionarioId(e.target.value)}>{employees.map((f) => <option key={f.id} value={f.id}>{f.nome}</option>)}</Select></Field>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Tipo de acordo"><TextInput value={tipoAcordo} onChange={(e) => setTipoAcordo(e.target.value)} /></Field>
        <Field label="Data do acordo"><TextInput type="date" value={dataAcordo} onChange={(e) => setDataAcordo(e.target.value)} /></Field>
      </div>
      <Field label="Motivo/descrição"><TextInput value={motivo} onChange={(e) => setMotivo(e.target.value)} /></Field>
      <div className="grid grid-cols-3 gap-3">
        <Field label="Valor total (R$)" required><TextInput inputMode="decimal" value={valorTotal} onChange={(e) => setValorTotal(e.target.value)} placeholder="0,00" /></Field>
        <Field label="Qtd. parcelas" required><TextInput inputMode="numeric" value={qtdParcelas} onChange={(e) => setQtdParcelas(e.target.value)} /></Field>
        <Field label="Primeiro vencimento" required><TextInput type="date" value={primeiroVencimento} onChange={(e) => setPrimeiroVencimento(e.target.value)} /></Field>
      </div>
      <Card className="mb-3" style={{ background: "var(--teal-soft)", border: "none" }}>
        <p className="text-sm">{qtd}x de <Money v={valorParcela} size="sm" /> — as parcelas são geradas automaticamente ao salvar</p>
      </Card>
      <Field label="Forma de pagamento"><TextInput value={formaPagamento} onChange={(e) => setFormaPagamento(e.target.value)} placeholder="Ex: Desconto em folha, transferência..." /></Field>
      <Field label="Link do anexo (opcional)"><TextInput value={anexoUrl} onChange={(e) => setAnexoUrl(e.target.value)} /></Field>
      <Field label="Observações"><TextInput value={observacoes} onChange={(e) => setObservacoes(e.target.value)} /></Field>
      {err && <p className="text-sm mb-2" style={{ color: "var(--red)" }}>{err}</p>}
      <div className="flex justify-end gap-2 mt-2">
        <Btn variant="ghost" onClick={onClose}>Cancelar</Btn>
        <Btn variant="gold" icon={Check} onClick={submit} disabled={saving}>{saving ? "Salvando..." : "Salvar acordo"}</Btn>
      </div>
    </Modal>
  );
}

function RegistrarPagamentoParcelaModal({ parcela, acordo, funcionario, accounts, onClose, onSave }) {
  const pendente = parcela.valor - parcela.valor_pago;
  const [dataPagamento, setDataPagamento] = useState(todayISO());
  const [valorPago, setValorPago] = useState(String(pendente.toFixed(2)).replace(".", ","));
  const [conta, setConta] = useState(accounts[0]?.id || "");
  const [err, setErr] = useState("");
  const [saving, setSaving] = useState(false);

  const submit = async () => {
    const v = parseValorBR(valorPago);
    if (!v || v <= 0) { setErr("Informe um valor válido."); return; }
    if (!conta) { setErr("Selecione a conta."); return; }
    setSaving(true);
    const ok = await onSave(parcela, acordo, { dataPagamento, valorPago: v, conta });
    setSaving(false);
    if (!ok) setErr("Não consegui registrar. Tente novamente.");
  };

  return (
    <Modal title={`Pagar parcela ${parcela.numero_parcela}/${acordo.qtd_parcelas} — ${funcionario?.nome}`} onClose={onClose}>
      <Card className="mb-4" style={{ background: "var(--amber-soft)", border: "none" }}>
        <p className="text-sm">Parcela: <Money v={parcela.valor} size="sm" /> · Já pago: <Money v={parcela.valor_pago} size="sm" /> · Pendente: <Money v={pendente} size="sm" tone="neg" /></p>
      </Card>
      <Field label="Data do pagamento" required><TextInput type="date" value={dataPagamento} onChange={(e) => setDataPagamento(e.target.value)} /></Field>
      <Field label="Valor pago (R$)" required><TextInput inputMode="decimal" value={valorPago} onChange={(e) => setValorPago(e.target.value)} /></Field>
      <Field label="Conta" required><Select value={conta} onChange={(e) => setConta(e.target.value)}>{accounts.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}</Select></Field>
      {err && <p className="text-sm mb-2" style={{ color: "var(--red)" }}>{err}</p>}
      <div className="flex justify-end gap-2 mt-2">
        <Btn variant="ghost" onClick={onClose}>Cancelar</Btn>
        <Btn variant="gold" icon={Check} onClick={submit} disabled={saving}>{saving ? "Registrando..." : "Confirmar pagamento"}</Btn>
      </div>
    </Modal>
  );
}

function AcordoCard({ acordo, parcelas, funcionario, accounts, canManage, onPagar }) {
  const [open, setOpen] = useState(false);
  const pago = parcelas.reduce((s, p) => s + p.valor_pago, 0);
  return (
    <Card>
      <button className="fin-btn fin-focus w-full flex items-center justify-between text-left" onClick={() => setOpen((o) => !o)}>
        <div>
          <p className="text-sm font-medium">{funcionario?.nome} {acordo.tipo_acordo ? `— ${acordo.tipo_acordo}` : ""} <Pill tone={acordo.status === "quitado" ? "green" : acordo.status === "cancelado" ? "neutral" : "amber"}>{acordo.status}</Pill></p>
          <p className="text-xs" style={{ color: "var(--ink-soft)" }}>{acordo.motivo} · {fmtDate(acordo.data_acordo)}</p>
        </div>
        <div className="text-right">
          <Money v={acordo.valor_total} size="sm" />
          <p className="text-xs" style={{ color: "var(--ink-soft)" }}>pago <Money v={pago} size="sm" /></p>
        </div>
      </button>
      {open && (
        <div className="mt-3 pt-3 space-y-2" style={{ borderTop: "1px solid var(--line)" }}>
          {parcelas.sort((a, b) => a.numero_parcela - b.numero_parcela).map((p) => {
            const meta = parcelaStatus(p);
            return (
              <div key={p.id} className="flex items-center justify-between text-sm">
                <span>{p.numero_parcela}/{acordo.qtd_parcelas} — vence {fmtDate(p.vencimento)} <Pill tone={meta.tone}>{meta.label}</Pill></span>
                <div className="flex items-center gap-2">
                  <Money v={p.valor} size="sm" />
                  {canManage && p.status !== "paga" && <Btn variant="gold" onClick={() => onPagar(p, acordo)}>Pagar</Btn>}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </Card>
  );
}

function AcordosView({ agreements, installments, employees, accounts, canManage, onAdd, onPagar }) {
  const [modal, setModal] = useState(null);
  const ativos = agreements.filter((a) => a.status === "ativo" || a.status === "atrasado");
  const outros = agreements.filter((a) => a.status === "quitado" || a.status === "cancelado");
  const valorTotal = ativos.reduce((s, a) => s + a.valor_total, 0);
  const pendente = ativos.reduce((s, a) => {
    const parc = installments.filter((p) => p.acordo_id === a.id);
    return s + parc.reduce((s2, p) => s2 + (p.valor - p.valor_pago), 0);
  }, 0);

  return (
    <div className="space-y-5">
      <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
        <Card><p className="text-xs" style={{ color: "var(--ink-soft)" }}>Acordos ativos</p><p className="fin-mono text-xl font-semibold">{ativos.length}</p></Card>
        <Card><p className="text-xs" style={{ color: "var(--ink-soft)" }}>Valor total</p><Money v={valorTotal} /></Card>
        <Card><p className="text-xs" style={{ color: "var(--ink-soft)" }}>Pendente</p><Money v={pendente} tone="neg" /></Card>
      </div>
      {canManage && <Btn variant="gold" icon={Plus} onClick={() => setModal({ kind: "novo" })}>Novo acordo</Btn>}
      <div className="space-y-3">
        {ativos.length === 0 ? <EmptyState text="Nenhum acordo ativo." /> : ativos.map((a) => (
          <AcordoCard key={a.id} acordo={a} parcelas={installments.filter((p) => p.acordo_id === a.id)} funcionario={employees.find((e) => e.id === a.funcionario_id)} accounts={accounts} canManage={canManage} onPagar={(p, ac) => setModal({ kind: "pagar", parcela: p, acordo: ac })} />
        ))}
      </div>
      {outros.length > 0 && (
        <div>
          <p className="font-semibold mb-2 fin-display" style={{ color: "var(--ink-soft)" }}>Quitados / cancelados</p>
          <div className="space-y-3">
            {outros.map((a) => (
              <AcordoCard key={a.id} acordo={a} parcelas={installments.filter((p) => p.acordo_id === a.id)} funcionario={employees.find((e) => e.id === a.funcionario_id)} accounts={accounts} canManage={false} onPagar={() => {}} />
            ))}
          </div>
        </div>
      )}
      {modal?.kind === "novo" && <NovoAcordoModal employees={employees.filter((e) => e.status === "ativo")} onClose={() => setModal(null)} onSave={async (d) => { const ok = await onAdd(d); if (ok) setModal(null); return ok; }} />}
      {modal?.kind === "pagar" && <RegistrarPagamentoParcelaModal parcela={modal.parcela} acordo={modal.acordo} funcionario={employees.find((e) => e.id === modal.acordo.funcionario_id)} accounts={accounts.filter((a) => a.active)} onClose={() => setModal(null)} onSave={async (p, a, dados) => { const ok = await onPagar(p, a, dados); if (ok) setModal(null); return ok; }} />}
    </div>
  );
}

/* ============================================================
   RH — DASHBOARD
   ============================================================ */
function RHDashboardView({ employees, payrollEntries, payrollPayments, overtimeEntries, documentos, agreements, installments }) {
  const now = new Date();
  const competencia = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-01`;
  const ativos = employees.filter((e) => e.status === "ativo").length;
  const inativos = employees.filter((e) => e.status === "inativo").length;

  const folhaMes = payrollEntries.filter((p) => p.competencia === competencia);
  const folhaTotais = folhaMes.reduce((acc, e) => {
    const pago = payrollPayments.filter((p) => p.payroll_entry_id === e.id).reduce((s, p) => s + p.valor_pago, 0);
    const total = payrollTotal(e);
    acc.total += total; acc.pago += pago;
    if (payrollStatus(e, pago) === "atrasado") acc.atrasadas += 1;
    return acc;
  }, { total: 0, pago: 0, atrasadas: 0 });

  const horasMes = overtimeEntries.filter((o) => o.competencia === competencia);
  const horasTotais = { qtd: horasMes.reduce((s, o) => s + o.quantidade_horas, 0), valor: horasMes.reduce((s, o) => s + o.valor_calculado, 0) };

  const docsComStatus = documentos.map((d) => docStatus(d.data_vencimento));
  const docsVencidos = docsComStatus.filter((d) => d.dias !== null && d.dias < 0).length;
  const docsEm7 = docsComStatus.filter((d) => d.dias !== null && d.dias >= 0 && d.dias <= 7).length;
  const docsEm30 = docsComStatus.filter((d) => d.dias !== null && d.dias > 7 && d.dias <= 30).length;
  const docsEm60 = docsComStatus.filter((d) => d.dias !== null && d.dias > 30 && d.dias <= 60).length;

  const acordosAtivos = agreements.filter((a) => a.status === "ativo" || a.status === "atrasado");
  const acordosPago = acordosAtivos.reduce((s, a) => s + installments.filter((p) => p.acordo_id === a.id).reduce((s2, p) => s2 + p.valor_pago, 0), 0);
  const acordosPendente = acordosAtivos.reduce((s, a) => s + installments.filter((p) => p.acordo_id === a.id).reduce((s2, p) => s2 + (p.valor - p.valor_pago), 0), 0);
  const parcelasAtrasadas = installments.filter((p) => p.status !== "paga" && (p.vencimento || "") < todayISO()).length;

  return (
    <div className="space-y-6">
      <div>
        <p className="font-semibold mb-2 fin-display">👥 Funcionários</p>
        <div className="grid grid-cols-2 gap-3">
          <Card><p className="text-xs" style={{ color: "var(--ink-soft)" }}>Ativos</p><p className="fin-mono text-xl font-semibold">{ativos}</p></Card>
          <Card><p className="text-xs" style={{ color: "var(--ink-soft)" }}>Inativos</p><p className="fin-mono text-xl font-semibold">{inativos}</p></Card>
        </div>
      </div>
      <div>
        <p className="font-semibold mb-2 fin-display">💵 Folha — {monthLabel(now.getMonth() + 1, now.getFullYear())}</p>
        <div className="grid grid-cols-3 gap-3">
          <Card><p className="text-xs" style={{ color: "var(--ink-soft)" }}>Total previsto</p><Money v={folhaTotais.total} size="sm" /></Card>
          <Card><p className="text-xs" style={{ color: "var(--ink-soft)" }}>Pago</p><Money v={folhaTotais.pago} size="sm" tone="pos" /></Card>
          <Card><p className="text-xs" style={{ color: "var(--ink-soft)" }}>Atrasadas</p><p className="fin-mono text-lg font-semibold" style={{ color: folhaTotais.atrasadas > 0 ? "var(--red)" : "var(--ink)" }}>{folhaTotais.atrasadas}</p></Card>
        </div>
      </div>
      <div>
        <p className="font-semibold mb-2 fin-display">⏱️ Horas extras — este mês</p>
        <div className="grid grid-cols-2 gap-3">
          <Card><p className="text-xs" style={{ color: "var(--ink-soft)" }}>Total de horas</p><p className="fin-mono text-lg font-semibold">{horasTotais.qtd.toFixed(1)}h</p></Card>
          <Card><p className="text-xs" style={{ color: "var(--ink-soft)" }}>Valor total</p><Money v={horasTotais.valor} size="sm" /></Card>
        </div>
      </div>
      <div>
        <p className="font-semibold mb-2 fin-display">📄 Documentos</p>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <Card><p className="text-xs" style={{ color: "var(--ink-soft)" }}>🔴 Vencidos</p><p className="fin-mono text-lg font-semibold">{docsVencidos}</p></Card>
          <Card><p className="text-xs" style={{ color: "var(--ink-soft)" }}>🟠 7 dias</p><p className="fin-mono text-lg font-semibold">{docsEm7}</p></Card>
          <Card><p className="text-xs" style={{ color: "var(--ink-soft)" }}>🟡 30 dias</p><p className="fin-mono text-lg font-semibold">{docsEm30}</p></Card>
          <Card><p className="text-xs" style={{ color: "var(--ink-soft)" }}>🟡 60 dias</p><p className="fin-mono text-lg font-semibold">{docsEm60}</p></Card>
        </div>
      </div>
      <div>
        <p className="font-semibold mb-2 fin-display">🤝 Acordos</p>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <Card><p className="text-xs" style={{ color: "var(--ink-soft)" }}>Ativos</p><p className="fin-mono text-lg font-semibold">{acordosAtivos.length}</p></Card>
          <Card><p className="text-xs" style={{ color: "var(--ink-soft)" }}>Pago</p><Money v={acordosPago} size="sm" tone="pos" /></Card>
          <Card><p className="text-xs" style={{ color: "var(--ink-soft)" }}>Pendente</p><Money v={acordosPendente} size="sm" tone="neg" /></Card>
          <Card><p className="text-xs" style={{ color: "var(--ink-soft)" }}>Parcelas atrasadas</p><p className="fin-mono text-lg font-semibold" style={{ color: parcelasAtrasadas > 0 ? "var(--red)" : "var(--ink)" }}>{parcelasAtrasadas}</p></Card>
        </div>
      </div>
    </div>
  );
}

/* ============================================================
   VIEW: CONFIGURAÇÕES
   ============================================================ */
function ConfiguracoesView({ profiles, currentUser, onChangeRole }) {
  return (
    <div className="space-y-5">
      <Card>
        <p className="font-semibold mb-3 fin-display">Pessoas com acesso</p>
        <div className="divide-y" style={{ borderColor: "var(--line)" }}>
          {profiles.map((u) => (
            <div key={u.id} className="flex items-center justify-between py-2.5">
              <div className="flex items-center gap-2">
                <div className="w-8 h-8 rounded-full flex items-center justify-center text-xs font-semibold" style={{ background: "var(--gold-soft)", color: "var(--gold)" }}>
                  {(u.name || "?").slice(0, 2).toUpperCase()}
                </div>
                <span className="text-sm font-medium">{u.name}{u.id === currentUser.id && <span style={{ color: "var(--ink-soft)" }}> (você)</span>}</span>
              </div>
              {currentUser.role === "admin" ? (
                <Select value={u.role} onChange={(e) => onChangeRole(u, e.target.value)} style={{ width: 190 }}>
                  {Object.entries(ROLES).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
                </Select>
              ) : (
                <Pill tone="teal">{ROLES[u.role]?.label}</Pill>
              )}
            </div>
          ))}
        </div>
      </Card>
      <Card style={{ background: "var(--teal-soft)", border: "none" }}>
        <p className="text-sm">
          <b>Para adicionar uma nova pessoa:</b> no painel do Supabase, vá em Authentication → Users → Invite user,
          digite o e-mail dela. Ela recebe um link para criar a senha e aparece automaticamente aqui como "Usuário de lançamento" — o admin pode então mudar o perfil dela na lista acima.
        </p>
      </Card>
      <Card style={{ background: "var(--amber-soft)", border: "none" }}>
        <p className="text-sm">
          <b>Perfis:</b> Administrador tem acesso total (exclui lançamentos, gerencia contas/categorias/pessoas).
          Financeiro lança receitas, despesas, transferências e vê relatórios. Usuário de lançamento lança despesas/transferências e vê o dashboard.
        </p>
      </Card>
    </div>
  );
}

/* ============================================================
   APP PRINCIPAL
   ============================================================ */
const NAV = [
  { key: "dashboard", label: "Dashboard", icon: Home },
  { key: "fluxo", label: "Fluxo de caixa", icon: ListChecks },
  { key: "despesas-previstas", label: "Despesas Previstas", icon: TrendingDown },
  { key: "contas-receber", label: "Contas a Receber", icon: Wallet },
  { key: "despesas-fixas", label: "Despesas Fixas", icon: Clock },
  { key: "cartao", label: "Fatura do Cartão", icon: CreditCard },
  { key: "adiantamentos", label: "Adiantamentos", icon: HandCoins },
  { key: "emprestimos", label: "Empréstimos", icon: PiggyBank },
  { key: "reembolsos", label: "Reembolsos", icon: Receipt },
  { key: "aprovacoes", label: "Aprovações", icon: ShieldCheck },
  { key: "contas", label: "Contas", icon: Landmark },
  { key: "categorias", label: "Categorias", icon: BarChart3 },
  { key: "relatorios", label: "Relatórios", icon: BarChart3 },
  { key: "funcionarios", label: "Funcionários", icon: Users },
  { key: "folha", label: "Folha de Pagamento", icon: Banknote },
  { key: "horas-extras", label: "Horas Extras", icon: Timer },
  { key: "documentos-rh", label: "Documentos/NRs", icon: FileCheck2 },
  { key: "acordos", label: "Acordos", icon: Handshake },
  { key: "dashboard-rh", label: "Dashboard RH", icon: LayoutDashboard },
  { key: "config", label: "Configurações", icon: Settings },
];
// Sócios (Elisângela, Gilmar) veem uma navegação simplificada — só visão gerencial, sem telas operacionais
const NAV_SOCIO = [
  { key: "dashboard", label: "Dashboard", icon: Home },
  { key: "despesas-previstas", label: "Despesas Previstas", icon: TrendingDown },
  { key: "contas-receber", label: "Contas a Receber", icon: Wallet },
  { key: "funcionarios", label: "Funcionários", icon: Users },
  { key: "folha", label: "Folha de Pagamento", icon: Banknote },
  { key: "acordos", label: "Acordos", icon: Handshake },
  { key: "dashboard-rh", label: "Dashboard RH", icon: LayoutDashboard },
  { key: "relatorios", label: "Relatórios", icon: BarChart3 },
  { key: "contas", label: "Contas", icon: Landmark },
];

export default function App() {
  const [session, setSession] = useState(undefined); // undefined = carregando, null = deslogado
  const [currentUser, setCurrentUser] = useState(null); // perfil (name, role) do usuário logado
  const [profiles, setProfiles] = useState([]);
  const [accounts, setAccounts] = useState([]);
  const [categories, setCategories] = useState([]);
  const [transactions, setTransactions] = useState([]);
  const [despesasPrevistas, setDespesasPrevistas] = useState([]);
  const [contasReceber, setContasReceber] = useState([]);
  const [recurringExpenses, setRecurringExpenses] = useState([]);
  const [employees, setEmployees] = useState([]);
  const [payrollEntries, setPayrollEntries] = useState([]);
  const [payrollPayments, setPayrollPayments] = useState([]);
  const [overtimeEntries, setOvertimeEntries] = useState([]);
  const [hrDocumentTypes, setHrDocumentTypes] = useState([]);
  const [hrDocuments, setHrDocuments] = useState([]);
  const [agreements, setAgreements] = useState([]);
  const [agreementInstallments, setAgreementInstallments] = useState([]);
  const [pendingEdits, setPendingEdits] = useState([]);
  const [dataLoading, setDataLoading] = useState(true);
  const [tab, setTab] = useState("dashboard");
  const [modal, setModal] = useState(null);
  const [navOpen, setNavOpen] = useState(false);
  const [errorBanner, setErrorBanner] = useState("");
  const channelRef = useRef(null);

  // sessão de autenticação
  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => setSession(data.session ?? null));
    const { data: sub } = supabase.auth.onAuthStateChange((_event, s) => setSession(s));
    return () => sub.subscription.unsubscribe();
  }, []);

  // carregar dados quando autenticado; recarregar em tempo real quando outra pessoa altera algo
  useEffect(() => {
    if (!session) { setDataLoading(false); return; }
    let cancelled = false;

    async function loadAll() {
      setDataLoading(true);
      const [{ data: profileRows }, { data: accountRows }, { data: categoryRows }, { data: txRows }, { data: despesasPrevistasRows }, { data: contasReceberRows }, { data: recurringRows }, { data: pendingEditsRows }, { data: employeeRows }, { data: payrollRows }, { data: payrollPaymentRows }, { data: overtimeRows }, { data: hrDocTypeRows }, { data: hrDocRows }, { data: agreementRows }, { data: installmentRows }] = await Promise.all([
        supabase.from("profiles").select("*").order("name"),
        supabase.from("accounts").select("*").order("created_at"),
        supabase.from("categories").select("*").order("name"),
        supabase.from("transactions").select("*").order("date", { ascending: false }),
        supabase.from("despesas_previstas").select("*").order("data_vencimento"),
        supabase.from("revenue_forecast").select("*").order("data_prevista_recebimento"),
        supabase.from("recurring_expenses").select("*").order("dia_vencimento"),
        supabase.from("pending_edits").select("*").order("requested_at", { ascending: false }),
        supabase.from("employees").select("*").order("nome"),
        supabase.from("payroll_entries").select("*"),
        supabase.from("payroll_payments").select("*"),
        supabase.from("overtime_entries").select("*"),
        supabase.from("hr_document_types").select("*").order("nome"),
        supabase.from("hr_documents").select("*"),
        supabase.from("agreements").select("*"),
        supabase.from("agreement_installments").select("*"),
      ]);
      if (cancelled) return;
      setProfiles(profileRows || []);
      const me = (profileRows || []).find((p) => p.id === session.user.id);
      setCurrentUser(me ? { id: me.id, name: me.name, role: me.role } : { id: session.user.id, name: session.user.email, role: "lancamento" });
      setAccounts((accountRows || []).map((a) => ({ id: a.id, name: a.name, active: a.active, saldoInicial: Number(a.saldo_inicial), tipo: a.tipo || "banco" })));
      setCategories(categoryRows || []);
      setTransactions((txRows || []).map(fromDb));
      setDespesasPrevistas(despesasPrevistasRows || []);
      setContasReceber(contasReceberRows || []);
      setRecurringExpenses(recurringRows || []);
      setPendingEdits(pendingEditsRows || []);
      setEmployees(employeeRows || []);
      setPayrollEntries((payrollRows || []).map((p) => ({ ...p, salario: Number(p.salario), adiantamento: Number(p.adiantamento), vale_mercado: Number(p.vale_mercado), vale_transporte: Number(p.vale_transporte), vale_refeicao: Number(p.vale_refeicao), horas_extras: Number(p.horas_extras), ajuda_custo: Number(p.ajuda_custo), outros_proventos: Number(p.outros_proventos), descontos: Number(p.descontos) })));
      setPayrollPayments((payrollPaymentRows || []).map((p) => ({ ...p, valor_pago: Number(p.valor_pago) })));
      setOvertimeEntries((overtimeRows || []).map((o) => ({ ...o, quantidade_horas: Number(o.quantidade_horas), percentual: Number(o.percentual), valor_calculado: Number(o.valor_calculado) })));
      setHrDocumentTypes(hrDocTypeRows || []);
      setHrDocuments(hrDocRows || []);
      setAgreements((agreementRows || []).map((a) => ({ ...a, valor_total: Number(a.valor_total), valor_parcela: Number(a.valor_parcela) })));
      setAgreementInstallments((installmentRows || []).map((p) => ({ ...p, valor: Number(p.valor), valor_pago: Number(p.valor_pago) })));
      setDataLoading(false);
    }
    loadAll();

    // tempo real: qualquer INSERT/UPDATE/DELETE em transactions atualiza todo mundo na hora
    const channel = supabase
      .channel("db-transactions")
      .on("postgres_changes", { event: "*", schema: "public", table: "transactions" }, () => loadAll())
      .on("postgres_changes", { event: "*", schema: "public", table: "accounts" }, () => loadAll())
      .on("postgres_changes", { event: "*", schema: "public", table: "categories" }, () => loadAll())
      .on("postgres_changes", { event: "*", schema: "public", table: "despesas_previstas" }, () => loadAll())
      .on("postgres_changes", { event: "*", schema: "public", table: "revenue_forecast" }, () => loadAll())
      .on("postgres_changes", { event: "*", schema: "public", table: "recurring_expenses" }, () => loadAll())
      .on("postgres_changes", { event: "*", schema: "public", table: "pending_edits" }, () => loadAll())
      .on("postgres_changes", { event: "*", schema: "public", table: "employees" }, () => loadAll())
      .on("postgres_changes", { event: "*", schema: "public", table: "payroll_entries" }, () => loadAll())
      .on("postgres_changes", { event: "*", schema: "public", table: "payroll_payments" }, () => loadAll())
      .on("postgres_changes", { event: "*", schema: "public", table: "overtime_entries" }, () => loadAll())
      .on("postgres_changes", { event: "*", schema: "public", table: "hr_document_types" }, () => loadAll())
      .on("postgres_changes", { event: "*", schema: "public", table: "hr_documents" }, () => loadAll())
      .on("postgres_changes", { event: "*", schema: "public", table: "agreements" }, () => loadAll())
      .on("postgres_changes", { event: "*", schema: "public", table: "agreement_installments" }, () => loadAll())
      .subscribe();
    channelRef.current = channel;

    return () => { cancelled = true; supabase.removeChannel(channel); };
  }, [session]);

  const engine = useFinanceEngine(transactions, accounts);
  const role = currentUser ? (ROLES[currentUser.role] || ROLES.lancamento) : ROLES.lancamento;
  const navItems = role.isSocio ? NAV_SOCIO : NAV;

  const addTransaction = async (tx) => {
    const { error } = await supabase.from("transactions").insert(toDb(tx));
    if (error) { setErrorBanner("Não consegui salvar: " + error.message); return false; }
    setErrorBanner(""); setModal(null); return true;
  };
  const toggleConferido = async (t) => {
    const { error } = await supabase.from("transactions").update({ conferido: !t.conferido }).eq("id", t.id);
    if (error) setErrorBanner("Não consegui atualizar: " + error.message);
  };
  const deleteTransaction = async (t) => {
    if (!confirm("Excluir este lançamento? Essa ação não pode ser desfeita.")) return;
    const { error } = await supabase.from("transactions").delete().eq("id", t.id);
    if (error) setErrorBanner("Não consegui excluir: " + error.message);
  };
  // Campos que o usuário pode editar em um lançamento já salvo, e o rótulo de cada um no histórico
  const EDITABLE_FIELDS = {
    date: "Data", valor: "Valor", conta: "Conta", contaOrigem: "Conta origem", contaDestino: "Conta destino",
    categoria: "Categoria", pessoa: "Pessoa", descricao: "Descrição", observacao: "Observação", documento: "Documento",
  };
  const updateTransaction = async (original, updated) => {
    const changedFields = Object.keys(EDITABLE_FIELDS).filter((f) => (original[f] ?? "") !== (updated[f] ?? ""));
    if (changedFields.length === 0) { setModal(null); return true; }

    if (!role.isAdmin) {
      // não é admin: fica pendente de aprovação, o lançamento original não muda ainda
      const changes = {};
      changedFields.forEach((f) => { changes[f] = { old: original[f] ?? null, new: updated[f] ?? null, label: EDITABLE_FIELDS[f] }; });
      const { error } = await supabase.from("pending_edits").insert({
        transaction_id: original.id, requested_by: currentUser.id, requested_by_name: currentUser.name, changes,
      });
      if (error) { setErrorBanner("Não consegui enviar pra aprovação: " + error.message); return false; }
      setErrorBanner(""); setModal(null); return true;
    }

    const { error } = await supabase.from("transactions").update(toDb(updated)).eq("id", original.id);
    if (error) { setErrorBanner("Não consegui salvar a edição: " + error.message); return false; }
    const logRows = changedFields.map((f) => ({
      transaction_id: original.id, changed_by: currentUser.id, changed_by_name: currentUser.name,
      field_name: EDITABLE_FIELDS[f], old_value: String(original[f] ?? ""), new_value: String(updated[f] ?? ""), action: "edit",
    }));
    await supabase.from("transaction_audit_log").insert(logRows);
    setErrorBanner(""); setModal(null); return true;
  };
  const approvePendingEdit = async (pe) => {
    const original = transactions.find((t) => t.id === pe.transaction_id);
    if (!original) { setErrorBanner("Lançamento não encontrado (pode ter sido excluído)."); return false; }
    const updated = { ...original };
    Object.entries(pe.changes).forEach(([field, c]) => { updated[field] = c.new; });
    const { error } = await supabase.from("transactions").update(toDb(updated)).eq("id", original.id);
    if (error) { setErrorBanner("Não consegui aplicar a edição: " + error.message); return false; }
    const logRows = Object.entries(pe.changes).map(([field, c]) => ({
      transaction_id: original.id, changed_by: pe.requested_by, changed_by_name: pe.requested_by_name,
      field_name: c.label, old_value: String(c.old ?? ""), new_value: String(c.new ?? ""), action: "edit",
    }));
    await supabase.from("transaction_audit_log").insert(logRows);
    const { error: err2 } = await supabase.from("pending_edits").update({
      status: "approved", reviewed_by: currentUser.id, reviewed_by_name: currentUser.name, reviewed_at: new Date().toISOString(),
    }).eq("id", pe.id);
    if (err2) { setErrorBanner("Edição aplicada, mas não consegui atualizar o status: " + err2.message); return false; }
    setErrorBanner(""); return true;
  };
  const rejectPendingEdit = async (pe) => {
    const { error } = await supabase.from("pending_edits").update({
      status: "rejected", reviewed_by: currentUser.id, reviewed_by_name: currentUser.name, reviewed_at: new Date().toISOString(),
    }).eq("id", pe.id);
    if (error) { setErrorBanner("Não consegui rejeitar: " + error.message); return false; }
    setErrorBanner(""); return true;
  };
  const addAccount = async (a) => {
    const { error } = await supabase.from("accounts").insert({ name: a.name, active: a.active, saldo_inicial: a.saldoInicial });
    if (error) setErrorBanner("Não consegui adicionar a conta: " + error.message);
  };
  const toggleAccountActive = async (a) => {
    const { error } = await supabase.from("accounts").update({ active: !a.active }).eq("id", a.id);
    if (error) setErrorBanner("Não consegui atualizar a conta: " + error.message);
  };
  const addCategory = async (c) => {
    const { error } = await supabase.from("categories").insert({ name: c.name, active: c.active, emoji: c.emoji || null });
    if (error) setErrorBanner("Não consegui adicionar a categoria: " + error.message);
  };
  const toggleCategoryActive = async (c) => {
    const { error } = await supabase.from("categories").update({ active: !c.active }).eq("id", c.id);
    if (error) setErrorBanner("Não consegui atualizar a categoria: " + error.message);
  };
  const updateCategoryEmoji = async (c, emoji) => {
    setCategories((prev) => prev.map((x) => (x.id === c.id ? { ...x, emoji } : x))); // atualiza a tela na hora
    const { error } = await supabase.from("categories").update({ emoji }).eq("id", c.id);
    if (error) setErrorBanner("Não consegui salvar o emoji: " + error.message);
  };

  // ---------- Despesas previstas ----------
  const addDespesaPrevista = async (d) => {
    const { error } = await supabase.from("despesas_previstas").insert({ ...d, created_by: currentUser.id });
    if (error) { setErrorBanner("Não consegui salvar a previsão: " + error.message); return false; }
    setErrorBanner(""); return true;
  };
  const editDespesaPrevista = async (despesa, updated) => {
    const { error } = await supabase.from("despesas_previstas").update(updated).eq("id", despesa.id);
    if (error) { setErrorBanner("Não consegui salvar a edição: " + error.message); return false; }
    setErrorBanner(""); return true;
  };
  const marcarDespesaComoPaga = async (despesa, { dataPagamento, valorPago, conta }) => {
    // cria a despesa real (mesma estrutura de sempre) e liga à previsão — não duplica se já foi marcada
    const { data: txRow, error: txErr } = await supabase.from("transactions").insert(toDb({
      type: "despesa", date: dataPagamento, valor: valorPago, conta, categoria: despesa.categoria,
      pessoa: despesa.pessoa, descricao: despesa.descricao, conferido: false,
      createdBy: currentUser.name, createdByUid: currentUser.id,
    })).select().single();
    if (txErr) { setErrorBanner("Não consegui registrar o pagamento: " + txErr.message); return false; }
    const { error } = await supabase.from("despesas_previstas").update({
      status: "paga", data_pagamento: dataPagamento, valor_pago: valorPago,
      conta_pagamento_id: conta, transaction_id: txRow.id,
    }).eq("id", despesa.id);
    if (error) { setErrorBanner("Despesa foi paga, mas não consegui atualizar a previsão: " + error.message); return false; }
    setErrorBanner(""); return true;
  };

  // ---------- Contas a receber ----------
  const addContaReceber = async (n) => {
    const { error } = await supabase.from("revenue_forecast").insert({ ...n, created_by: currentUser.id });
    if (error) { setErrorBanner("Não consegui salvar a nota: " + error.message); return false; }
    setErrorBanner(""); return true;
  };
  const editContaReceber = async (nota, updated) => {
    const { error } = await supabase.from("revenue_forecast").update(updated).eq("id", nota.id);
    if (error) { setErrorBanner("Não consegui salvar a edição: " + error.message); return false; }
    setErrorBanner(""); return true;
  };
  const marcarContaComoRecebida = async (nota, { dataRecebimento, valorRecebido, valorBloqueado, conta }) => {
    const disponivel = valorRecebido - valorBloqueado;
    let txId = null;
    if (disponivel > 0.009) {
      const { data: txRow, error: txErr } = await supabase.from("transactions").insert(toDb({
        type: "receita", date: dataRecebimento, valor: disponivel, conta,
        pessoa: nota.cliente, descricao: `Recebimento NF ${nota.numero_nf || ""}`.trim(),
        documento: nota.numero_nf, conferido: false, createdBy: currentUser.name, createdByUid: currentUser.id,
      })).select().single();
      if (txErr) { setErrorBanner("Não consegui registrar o recebimento: " + txErr.message); return false; }
      txId = txRow.id;
    }
    const { error } = await supabase.from("revenue_forecast").update({
      status: "recebido", data_efetiva_recebimento: dataRecebimento,
      valor_recebido: valorRecebido, valor_bloqueado: valorBloqueado,
      conta_recebimento_id: conta, transaction_id: txId,
    }).eq("id", nota.id);
    if (error) { setErrorBanner("Recebimento registrado, mas não consegui atualizar a nota: " + error.message); return false; }
    setErrorBanner(""); return true;
  };
  const liberarBloqueio = async (nota, { valor, conta }) => {
    const { error: txErr } = await supabase.from("transactions").insert(toDb({
      type: "receita", date: todayISO(), valor, conta, pessoa: nota.cliente,
      descricao: `Liberação de bloqueio — NF ${nota.numero_nf || ""}`.trim(), documento: nota.numero_nf,
      conferido: false, createdBy: currentUser.name, createdByUid: currentUser.id,
    }));
    if (txErr) { setErrorBanner("Não consegui liberar o valor: " + txErr.message); return false; }
    const { error } = await supabase.from("revenue_forecast").update({ valor_bloqueado: (nota.valor_bloqueado || 0) - valor }).eq("id", nota.id);
    if (error) { setErrorBanner("Valor liberado, mas não consegui atualizar a nota: " + error.message); return false; }
    setErrorBanner(""); return true;
  };

  // ---------- Despesas fixas / recorrentes ----------
  const addRecurringExpense = async (r) => {
    const { error } = await supabase.from("recurring_expenses").insert({ ...r, created_by: currentUser.id });
    if (error) { setErrorBanner("Não consegui salvar a despesa fixa: " + error.message); return false; }
    setErrorBanner(""); return true;
  };
  const toggleRecurringExpenseAtivo = async (r) => {
    const { error } = await supabase.from("recurring_expenses").update({ ativo: !r.ativo }).eq("id", r.id);
    if (error) setErrorBanner("Não consegui atualizar: " + error.message);
  };
  const darBaixaRecorrente = async (r, { dataPagamento, valorTotal, juros, conta }) => {
    const descricaoComJuros = juros > 0.009 ? `${r.descricao} (inclui R$ ${juros.toFixed(2).replace(".", ",")} de juros/multa)` : r.descricao;
    const { data: txRow, error: txErr } = await supabase.from("transactions").insert(toDb({
      type: "despesa", date: dataPagamento, valor: valorTotal, conta, categoria: r.categoria,
      pessoa: r.pessoa, descricao: descricaoComJuros, refRecurringExpenseId: r.id,
      conferido: false, createdBy: currentUser.name, createdByUid: currentUser.id,
    })).select().single();
    if (txErr) { setErrorBanner("Não consegui registrar a despesa: " + txErr.message); return false; }
    if (r.tipo_recorrencia === "parcelada") {
      const restantes = (r.parcelas_restantes || 1) - 1;
      const { error } = await supabase.from("recurring_expenses").update({
        parcelas_restantes: restantes, ativo: restantes > 0,
      }).eq("id", r.id);
      if (error) setErrorBanner("Despesa registrada, mas não consegui atualizar as parcelas: " + error.message);
    }
    setErrorBanner(""); return true;
  };
  const desfazerBaixaRecorrente = async (r, txBaixa) => {
    if (!confirm(`Desfazer a baixa de "${r.descricao}"? Isso remove o lançamento e devolve o dinheiro pra conta.`)) return false;
    const { error: delErr } = await supabase.from("transactions").delete().eq("id", txBaixa.id);
    if (delErr) { setErrorBanner("Não consegui desfazer a baixa: " + delErr.message); return false; }
    if (r.tipo_recorrencia === "parcelada") {
      const restantes = (r.parcelas_restantes || 0) + 1;
      const { error } = await supabase.from("recurring_expenses").update({ parcelas_restantes: restantes, ativo: true }).eq("id", r.id);
      if (error) setErrorBanner("Baixa desfeita, mas não consegui atualizar as parcelas: " + error.message);
    }
    setErrorBanner(""); return true;
  };

  // ---------- RH: Funcionários ----------
  const addEmployee = async (e) => {
    const { error } = await supabase.from("employees").insert({ ...e, created_by: currentUser.id });
    if (error) { setErrorBanner("Não consegui salvar o funcionário: " + error.message); return false; }
    setErrorBanner(""); return true;
  };
  const editEmployee = async (original, e) => {
    const { error } = await supabase.from("employees").update(e).eq("id", original.id);
    if (error) { setErrorBanner("Não consegui salvar: " + error.message); return false; }
    setErrorBanner(""); return true;
  };
  const toggleEmployeeStatus = async (e) => {
    const { error } = await supabase.from("employees").update({ status: e.status === "ativo" ? "inativo" : "ativo" }).eq("id", e.id);
    if (error) setErrorBanner("Não consegui atualizar: " + error.message);
  };

  // ---------- RH: Folha de pagamento ----------
  const ensurePayrollEntries = async (competencia, ativos) => {
    const jaExistem = new Set(payrollEntries.filter((p) => p.competencia === competencia).map((p) => p.funcionario_id));
    const faltando = ativos.filter((f) => !jaExistem.has(f.id));
    if (faltando.length === 0) return;
    const novasLinhas = faltando.map((f) => {
      const adicional = f.periculosidade_insalubridade ? (f.valor_adicional || 0) : 0;
      return {
        funcionario_id: f.id, competencia, salario: f.salario_base, adiantamento: 0, vale_mercado: 0,
        vale_transporte: 0, vale_refeicao: 0, horas_extras: 0, ajuda_custo: 0, outros_proventos: adicional, descontos: 0,
        observacoes: adicional > 0 ? `Inclui ${f.periculosidade_insalubridade} (R$ ${adicional.toFixed(2).replace(".", ",")})` : null,
        data_prevista_pagamento: competencia, created_by: currentUser.id,
      };
    });
    const { error } = await supabase.from("payroll_entries").insert(novasLinhas);
    if (error) setErrorBanner("Não consegui carregar a folha do mês: " + error.message);
  };
  const updatePayrollField = async (entry, field, value) => {
    setPayrollEntries((prev) => prev.map((p) => (p.id === entry.id ? { ...p, [field]: value } : p))); // atualiza a tela na hora
    const { error } = await supabase.from("payroll_entries").update({ [field]: value }).eq("id", entry.id);
    if (error) setErrorBanner("Não consegui salvar: " + error.message);
  };
  const registrarPagamentoFolha = async (entry, { dataPagamento, valorPago, conta, observacao }) => {
    const funcionario = employees.find((f) => f.id === entry.funcionario_id);
    const { data: txRow, error: txErr } = await supabase.from("transactions").insert(toDb({
      type: "despesa", date: dataPagamento, valor: valorPago, conta, categoria: "Salários",
      pessoa: funcionario?.nome, descricao: `Folha ${entry.competencia.slice(0, 7)} — ${funcionario?.nome || ""}`,
      conferido: false, createdBy: currentUser.name, createdByUid: currentUser.id,
    })).select().single();
    if (txErr) { setErrorBanner("Não consegui registrar o pagamento: " + txErr.message); return false; }
    const { error } = await supabase.from("payroll_payments").insert({
      payroll_entry_id: entry.id, data_pagamento: dataPagamento, valor_pago: valorPago,
      conta_id: conta, observacao, transaction_id: txRow.id, created_by: currentUser.id,
    });
    if (error) { setErrorBanner("Pagamento lançado, mas não consegui atualizar a folha: " + error.message); return false; }
    setErrorBanner(""); return true;
  };

  // ---------- RH: Horas extras ----------
  const addOvertimeEntry = async (o) => {
    const { error } = await supabase.from("overtime_entries").insert({ ...o, created_by: currentUser.id });
    if (error) { setErrorBanner("Não consegui salvar: " + error.message); return false; }
    // soma todas as horas extras dessa competência e já alimenta a folha (cria a linha se não existir)
    const todasDoMes = [...overtimeEntries, o].filter((x) => x.funcionario_id === o.funcionario_id && x.competencia === o.competencia);
    const somaValor = todasDoMes.reduce((s, x) => s + x.valor_calculado, 0);
    const existente = payrollEntries.find((p) => p.funcionario_id === o.funcionario_id && p.competencia === o.competencia);
    if (existente) {
      await supabase.from("payroll_entries").update({ horas_extras: somaValor }).eq("id", existente.id);
    } else {
      const funcionario = employees.find((f) => f.id === o.funcionario_id);
      await supabase.from("payroll_entries").insert({
        funcionario_id: o.funcionario_id, competencia: o.competencia, salario: funcionario?.salario_base || 0,
        horas_extras: somaValor, data_prevista_pagamento: o.competencia, created_by: currentUser.id,
      });
    }
    setErrorBanner(""); return true;
  };

  // ---------- RH: Documentos ----------
  const addHrDocumentType = async (nome) => {
    const { error } = await supabase.from("hr_document_types").insert({ nome });
    if (error) { setErrorBanner("Não consegui salvar o tipo: " + error.message); return false; }
    setErrorBanner(""); return true;
  };
  const addHrDocument = async (d) => {
    const { error } = await supabase.from("hr_documents").insert({ ...d, created_by: currentUser.id });
    if (error) { setErrorBanner("Não consegui salvar o documento: " + error.message); return false; }
    setErrorBanner(""); return true;
  };

  // ---------- RH: Acordos ----------
  const addAgreement = async (a) => {
    const { data: agRow, error } = await supabase.from("agreements").insert({ ...a, created_by: currentUser.id }).select().single();
    if (error) { setErrorBanner("Não consegui salvar o acordo: " + error.message); return false; }
    const parcelas = [];
    let somaParcelas = 0;
    for (let i = 1; i <= a.qtd_parcelas; i++) {
      const venc = new Date(a.primeiro_vencimento + "T00:00:00");
      venc.setMonth(venc.getMonth() + (i - 1));
      const valor = i === a.qtd_parcelas ? a.valor_total - somaParcelas : Math.round(a.valor_parcela * 100) / 100;
      somaParcelas += valor;
      parcelas.push({ acordo_id: agRow.id, numero_parcela: i, vencimento: venc.toISOString().slice(0, 10), valor });
    }
    const { error: errParcelas } = await supabase.from("agreement_installments").insert(parcelas);
    if (errParcelas) { setErrorBanner("Acordo salvo, mas não consegui gerar as parcelas: " + errParcelas.message); return false; }
    setErrorBanner(""); return true;
  };
  const pagarParcelaAcordo = async (parcela, acordo, { dataPagamento, valorPago, conta }) => {
    const funcionario = employees.find((f) => f.id === acordo.funcionario_id);
    const { data: txRow, error: txErr } = await supabase.from("transactions").insert(toDb({
      type: "despesa", date: dataPagamento, valor: valorPago, conta, categoria: "Acordos",
      pessoa: funcionario?.nome, descricao: `Acordo — parcela ${parcela.numero_parcela}/${acordo.qtd_parcelas} — ${funcionario?.nome || ""}`,
      conferido: false, createdBy: currentUser.name, createdByUid: currentUser.id,
    })).select().single();
    if (txErr) { setErrorBanner("Não consegui registrar o pagamento: " + txErr.message); return false; }
    const novoValorPago = parcela.valor_pago + valorPago;
    const novoStatus = novoValorPago >= parcela.valor - 0.009 ? "paga" : "parcial";
    const { error: errParc } = await supabase.from("agreement_installments").update({
      valor_pago: novoValorPago, status: novoStatus, data_pagamento: dataPagamento, conta_id: conta, transaction_id: txRow.id,
    }).eq("id", parcela.id);
    if (errParc) { setErrorBanner("Pagamento lançado, mas não consegui atualizar a parcela: " + errParc.message); return false; }
    // se todas as parcelas desse acordo estão pagas, marca o acordo como quitado
    const outrasParcelas = agreementInstallments.filter((p) => p.acordo_id === acordo.id && p.id !== parcela.id);
    const todasPagas = outrasParcelas.every((p) => p.status === "paga") && novoStatus === "paga";
    if (todasPagas) await supabase.from("agreements").update({ status: "quitado" }).eq("id", acordo.id);
    setErrorBanner(""); return true;
  };

  const changeRole = async (u, role) => {
    const { error } = await supabase.from("profiles").update({ role }).eq("id", u.id);
    if (error) setErrorBanner("Não consegui alterar o perfil: " + error.message);
    else setProfiles((prev) => prev.map((p) => (p.id === u.id ? { ...p, role } : p)));
  };

  if (session === undefined) {
    return <div className="min-h-screen flex items-center justify-center"><p className="text-sm" style={{ color: "var(--ink-soft)" }}>Carregando...</p></div>;
  }
  if (!session) return <LoginScreen />;
  if (dataLoading || !currentUser) {
    return <div className="min-h-screen flex items-center justify-center"><p className="text-sm" style={{ color: "var(--ink-soft)" }}>Carregando dados financeiros...</p></div>;
  }

  const openQuick = (type) => setModal({ kind: "tx", type });

  return (
    <div className="min-h-screen flex">
      <aside className="hidden md:flex flex-col w-60 shrink-0 p-4" style={{ background: "var(--navy)" }}>
        <div className="flex items-center gap-2 mb-8 px-1">
          <BrandMark /><span className="fin-display text-white font-semibold text-lg">Caixa</span>
        </div>
        <nav className="flex-1 space-y-1">
          {navItems.map((n) => (
            <button key={n.key} onClick={() => setTab(n.key)} className="fin-focus fin-btn w-full flex items-center gap-2.5 px-3 py-2.5 rounded-lg text-sm"
              style={{ background: tab === n.key ? "rgba(241,230,195,0.14)" : "transparent", color: tab === n.key ? "#F1E6C3" : "#C7CEDC" }}>
              <n.icon size={17} />{n.label}
            </button>
          ))}
        </nav>
        <div className="pt-4 mt-4" style={{ borderTop: "1px solid rgba(255,255,255,0.1)" }}>
          <p className="text-xs px-1" style={{ color: "#C7CEDC" }}>{currentUser.name}</p>
          <p className="text-xs px-1 mb-2" style={{ color: "#8593AD" }}>{role.label}</p>
          <button onClick={() => supabase.auth.signOut()} className="fin-focus flex items-center gap-2 px-1 text-sm" style={{ color: "#C7CEDC" }}><LogOut size={15} /> Sair</button>
        </div>
      </aside>

      {navOpen && (
        <div className="fixed inset-0 z-40 md:hidden" style={{ background: "rgba(18,33,59,0.6)" }} onClick={() => setNavOpen(false)}>
          <aside className="absolute left-0 top-0 bottom-0 w-64 p-4" style={{ background: "var(--navy)" }} onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center gap-2 mb-8 px-1"><BrandMark /><span className="fin-display text-white font-semibold text-lg">Caixa</span></div>
            <nav className="space-y-1">
              {navItems.map((n) => (
                <button key={n.key} onClick={() => { setTab(n.key); setNavOpen(false); }} className="fin-focus fin-btn w-full flex items-center gap-2.5 px-3 py-2.5 rounded-lg text-sm"
                  style={{ background: tab === n.key ? "rgba(241,230,195,0.14)" : "transparent", color: tab === n.key ? "#F1E6C3" : "#C7CEDC" }}>
                  <n.icon size={17} />{n.label}
                </button>
              ))}
              <button onClick={() => supabase.auth.signOut()} className="fin-focus flex items-center gap-2 px-3 py-2.5 text-sm mt-3" style={{ color: "#C7CEDC" }}><LogOut size={15} /> Sair</button>
            </nav>
          </aside>
        </div>
      )}

      <main className="flex-1 min-w-0">
        <div className="md:hidden flex items-center justify-between px-4 py-3" style={{ background: "var(--navy)" }}>
          <button onClick={() => setNavOpen(true)} className="fin-focus text-white"><ChevronDown className="rotate-90" size={22} /></button>
          <span className="fin-display text-white font-semibold">{navItems.find((n) => n.key === tab)?.label}</span>
          <div className="w-6 h-6 rounded-full flex items-center justify-center text-xs font-semibold" style={{ background: "var(--gold-soft)", color: "var(--gold)" }}>{currentUser.name.slice(0, 2).toUpperCase()}</div>
        </div>

        <div className={`p-4 md:p-7 mx-auto ${tab === "fluxo" ? "max-w-full" : "max-w-6xl"}`}>
          <div className="hidden md:flex items-center justify-between mb-6">
            <h1 className="fin-display text-2xl font-semibold">{navItems.find((n) => n.key === tab)?.label}</h1>
            {role.canLancar && <Btn variant="gold" icon={Plus} onClick={() => openQuick("despesa")}>Novo lançamento</Btn>}
          </div>

          {errorBanner && <Card className="mb-4" style={{ background: "var(--red-soft)", border: "none" }}><p className="text-sm" style={{ color: "var(--red)" }}>{errorBanner}</p></Card>}

          {tab === "dashboard" && <DashboardView accounts={accounts} transactions={transactions} engine={engine} onQuickAction={openQuick} role={role} categories={categories} despesasPrevistas={despesasPrevistas} contasReceber={contasReceber} recurringExpenses={recurringExpenses} />}
          {tab === "fluxo" && <FluxoCaixaView transactions={transactions} accounts={accounts} categories={categories} onToggleConferido={toggleConferido} onDelete={deleteTransaction} onEdit={(t) => setModal({ kind: "edit-tx", tx: t })} canDelete={role.canDelete} />}
          {tab === "adiantamentos" && <AdiantamentosView engine={engine} accounts={accounts} onBaixa={(a) => setModal({ kind: "baixa", adiantamento: a })} onDevolucao={(a) => setModal({ kind: "devolucao", adiantamento: a })} onExcluir={deleteTransaction} canDelete={role.canDelete} />}
          {tab === "reembolsos" && <ReembolsosView engine={engine} onPagar={(r) => setModal({ kind: "reembolso", reembolso: r })} />}
          {tab === "emprestimos" && <EmprestimosView engine={engine} onPagar={(e) => setModal({ kind: "pagar-emprestimo", emprestimo: e })} />}
          {tab === "despesas-fixas" && <DespesasFixasView recurringExpenses={recurringExpenses} transactions={transactions} accounts={accounts} categories={categories} canManage={role.canLancar} onAdd={addRecurringExpense} onToggleAtivo={toggleRecurringExpenseAtivo} onDarBaixa={darBaixaRecorrente} onDesfazerBaixa={desfazerBaixaRecorrente} />}
          {tab === "cartao" && <CartaoView transactions={transactions} accounts={accounts} />}
          {tab === "aprovacoes" && <AprovacoesView pendingEdits={pendingEdits} transactions={transactions} isAdmin={role.isAdmin} onApprove={approvePendingEdit} onReject={rejectPendingEdit} />}
          {tab === "despesas-previstas" && <DespesasPrevistasView despesasPrevistas={despesasPrevistas} accounts={accounts} categories={categories} canManage={role.canLancar} onAdd={addDespesaPrevista} onMarcarPaga={marcarDespesaComoPaga} onEditDespesa={editDespesaPrevista} />}
          {tab === "contas-receber" && <ContasReceberView contasReceber={contasReceber} accounts={accounts} canManage={role.canLancar} onAdd={addContaReceber} onMarcarRecebido={marcarContaComoRecebida} onLiberarBloqueio={liberarBloqueio} onEditNota={editContaReceber} />}
          {tab === "contas" && <ContasView accounts={accounts} engine={engine} onAdd={addAccount} onToggleActive={toggleAccountActive} canManage={role.canManageConfig} />}
          {tab === "categorias" && <CategoriasView categories={categories} onAdd={addCategory} onToggleActive={toggleCategoryActive} onUpdateEmoji={updateCategoryEmoji} canManage={role.canManageConfig} />}
          {tab === "relatorios" && <RelatoriosView transactions={transactions} accounts={accounts} engine={engine} />}
          {tab === "funcionarios" && <FuncionariosView employees={employees} canManage={role.canLancar} onAdd={addEmployee} onEdit={editEmployee} onToggleStatus={toggleEmployeeStatus} />}
          {tab === "folha" && <FolhaPagamentoView employees={employees} payrollEntries={payrollEntries} payrollPayments={payrollPayments} accounts={accounts} canManage={role.canLancar} onEnsureEntries={ensurePayrollEntries} onUpdateField={updatePayrollField} onPagar={registrarPagamentoFolha} />}
          {tab === "horas-extras" && <HorasExtrasView overtimeEntries={overtimeEntries} employees={employees} canManage={role.canLancar} onAdd={addOvertimeEntry} />}
          {tab === "documentos-rh" && <DocumentosView documentos={hrDocuments} tipos={hrDocumentTypes} employees={employees} canManage={role.canLancar} onAdd={addHrDocument} onAddTipo={addHrDocumentType} />}
          {tab === "acordos" && <AcordosView agreements={agreements} installments={agreementInstallments} employees={employees} accounts={accounts} canManage={role.canLancar} onAdd={addAgreement} onPagar={pagarParcelaAcordo} />}
          {tab === "dashboard-rh" && <RHDashboardView employees={employees} payrollEntries={payrollEntries} payrollPayments={payrollPayments} overtimeEntries={overtimeEntries} documentos={hrDocuments} agreements={agreements} installments={agreementInstallments} />}
          {tab === "config" && <ConfiguracoesView profiles={profiles} currentUser={currentUser} onChangeRole={changeRole} />}

          <p className="text-center text-xs mt-8 mb-4 fin-no-print" style={{ color: "var(--ink-soft)", opacity: 0.6 }}>Sistema Power</p>
        </div>

        {role.canLancar && (
          <button onClick={() => openQuick("despesa")} className="md:hidden fixed bottom-5 right-5 w-14 h-14 rounded-full flex items-center justify-center shadow-lg fin-focus" style={{ background: "var(--gold)", color: "#fff" }}>
            <Plus size={26} />
          </button>
        )}
      </main>

      {modal?.kind === "tx" && <TransactionModal initialType={modal.type} accounts={accounts} categories={categories} currentUser={currentUser} onClose={() => setModal(null)} onSave={addTransaction} />}
      {modal?.kind === "edit-tx" && <EditTransactionModal tx={modal.tx} accounts={accounts} categories={categories} currentUser={currentUser} onClose={() => setModal(null)} onSave={updateTransaction} />}
      {modal?.kind === "baixa" && <BaixaAdiantamentoModal adiantamento={modal.adiantamento} categories={categories.filter((c) => c.active)} accounts={accounts.filter((a) => a.active)} currentUser={currentUser} onClose={() => setModal(null)} onSave={addTransaction} />}
      {modal?.kind === "devolucao" && <DevolucaoAdiantamentoModal adiantamento={modal.adiantamento} accounts={accounts.filter((a) => a.active)} currentUser={currentUser} onClose={() => setModal(null)} onSave={addTransaction} />}
      {modal?.kind === "reembolso" && <PagamentoReembolsoModal reembolso={modal.reembolso} accounts={accounts.filter((a) => a.active)} currentUser={currentUser} onClose={() => setModal(null)} onSave={addTransaction} />}
      {modal?.kind === "pagar-emprestimo" && <PagamentoEmprestimoModal emprestimo={modal.emprestimo} accounts={accounts.filter((a) => a.active)} currentUser={currentUser} onClose={() => setModal(null)} onSave={addTransaction} />}
    </div>
  );
}
