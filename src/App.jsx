import React, { useState, useEffect, useMemo, useCallback, useRef } from "react";
import { supabase } from "./supabaseClient";
import {
  Home, Wallet, TrendingDown, ArrowLeftRight, Users, PiggyBank,
  Landmark, BarChart3, Settings, Plus, X, Check, Clock, AlertCircle,
  ChevronDown, LogOut, Lock, Trash2, Edit2, HandCoins, Receipt,
  ListChecks, Eye, EyeOff, ArrowUpCircle, ArrowDownCircle, ArrowRightLeft,
  Mail
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
  admin: { label: "Administrador", canDelete: true, canManageUsers: true, canManageConfig: true, canLancar: true, isSocio: false },
  financeiro: { label: "Financeiro", canDelete: false, canManageUsers: false, canManageConfig: false, canLancar: true, isSocio: false },
  lancamento: { label: "Usuário de lançamento", canDelete: false, canManageUsers: false, canManageConfig: false, canLancar: true, isSocio: false },
  socio: { label: "Sócio", canDelete: false, canManageUsers: false, canManageConfig: false, canLancar: false, isSocio: true },
};

const fmtBRL = (v) => (v || 0).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
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
    refDespesaId: row.ref_despesa_id, conferido: row.conferido,
    createdBy: row.created_by_name, createdAt: row.created_at,
  };
}

/* ============================================================
   MOTOR DE CÁLCULO FINANCEIRO
   ============================================================ */
function useFinanceEngine(transactions, accounts) {
  return useMemo(() => {
    const byType = (t) => transactions.filter((x) => x.type === t);
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

    return { saldoPorConta, saldoConsolidado, adiantamentos, totalEmPoderDeTerceiros, reembolsos, totalReembolsosPendentes };
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
    ajuste: { label: "Ajuste manual de saldo", icon: Edit2 },
  };

  const submit = async () => {
    const v = parseFloat(String(valor).replace(",", "."));
    if (!v || v <= 0) { setErr("Informe um valor válido maior que zero."); return; }
    if (!date) { setErr("Informe a data."); return; }
    if (type === "transferencia" && conta === contaDestino) { setErr("A conta de origem e destino devem ser diferentes."); return; }
    if ((type === "receita" || type === "despesa" || type === "adiantamento" || type === "ajuste") && !conta) { setErr("Selecione a conta."); return; }
    if (type === "transferencia" && (!conta || !contaDestino)) { setErr("Selecione as duas contas."); return; }

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

      {(type === "receita" || type === "despesa" || type === "adiantamento" || type === "ajuste") && (
        <Field label="Conta" required>
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
      <Field label={type === "adiantamento" ? "Pessoa que vai receber o adiantamento" : "Pessoa / beneficiário"}>
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
    const v = parseFloat(String(valor).replace(",", "."));
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
    const v = parseFloat(String(valor).replace(",", "."));
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
    const v = parseFloat(String(valor).replace(",", "."));
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
    const v = parseFloat(String(valor).replace(",", "."));
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
function DashboardView({ accounts, transactions, engine, onQuickAction, role, categories, despesasPrevistas, contasReceber }) {
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
          <p className="font-semibold mb-2 fin-display">📊 Previsão financeira</p>
          <Card style={{ background: "var(--navy)", border: "none" }} className="text-white">
            {(() => {
              const saidasPrevistas = (despesasPrevistas || []).filter((d) => d.status !== "paga").reduce((s, d) => s + d.valor_previsto, 0);
              const entradasPrevistas = (contasReceber || []).filter((n) => n.status !== "recebido").reduce((s, n) => s + n.valor, 0);
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

  // saldo consolidado da empresa acumulado até cada lançamento (em ordem cronológica real,
  // independente dos filtros aplicados na tela — assim o saldo mostrado sempre bate com a realidade)
  const saldoAcumuladoPorId = useMemo(() => {
    const inicio = accounts.reduce((s, a) => s + (a.saldoInicial || 0), 0);
    const chron = [...transactions].sort((a, b) => (a.date || "").localeCompare(b.date || "") || (a.createdAt || "").localeCompare(b.createdAt || ""));
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
  }, [transactions, accounts]);

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
    await onAdd({ name: name.trim(), active: true, saldoInicial: parseFloat(String(saldoInicial).replace(",", ".")) || 0 });
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
    <div className="space-y-5">
      <div className="flex flex-wrap gap-2 items-center">
        <Select value={month} onChange={(e) => setMonth(Number(e.target.value))} style={{ width: 160 }}>
          {Array.from({ length: 12 }, (_, i) => i + 1).map((m) => <option key={m} value={m}>{new Date(2000, m - 1, 1).toLocaleDateString("pt-BR", { month: "long" })}</option>)}
        </Select>
        <Select value={year} onChange={(e) => setYear(Number(e.target.value))} style={{ width: 110 }}>{[year - 1, year, year + 1].map((y) => <option key={y} value={y}>{y}</option>)}</Select>
        <Select value={groupBy} onChange={(e) => setGroupBy(e.target.value)} style={{ width: 170 }}>
          <option value="categoria">Agrupar por categoria</option><option value="conta">Agrupar por conta</option><option value="pessoa">Agrupar por pessoa</option>
        </Select>
      </div>
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
function AdiantamentosView({ engine, accounts, onBaixa, onDevolucao }) {
  const abertos = engine.adiantamentos.filter((a) => a.saldoAPrestar > 0.009);
  const quitados = engine.adiantamentos.filter((a) => a.saldoAPrestar <= 0.009);
  return (
    <div className="space-y-5">
      <div>
        <p className="font-semibold mb-2 fin-display">Em aberto — valores em poder de terceiros</p>
        {abertos.length === 0 ? <EmptyState text="Nenhum adiantamento em aberto." /> : (
          <div className="grid md:grid-cols-2 gap-3">
            {abertos.map((a) => (
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
                <div className="flex gap-2 mt-3">
                  <Btn variant="subtle" onClick={() => onBaixa(a)}>Registrar despesa</Btn>
                  <Btn variant="ghost" onClick={() => onDevolucao(a)}>Registrar devolução</Btn>
                </div>
              </Card>
            ))}
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
    const v = parseFloat(String(valor).replace(",", "."));
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

function MarcarPagaModal({ despesa, accounts, onClose, onSave }) {
  const [dataPagamento, setDataPagamento] = useState(todayISO());
  const [valorPago, setValorPago] = useState(String(despesa.valor_previsto).replace(".", ","));
  const [conta, setConta] = useState(accounts[0]?.id || "");
  const [err, setErr] = useState("");
  const [saving, setSaving] = useState(false);

  const submit = async () => {
    const v = parseFloat(String(valorPago).replace(",", "."));
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

function DespesasPrevistasView({ despesasPrevistas, accounts, categories, canManage, onAdd, onMarcarPaga }) {
  const [modal, setModal] = useState(null);
  const comStatus = despesasPrevistas.map((d) => ({ ...d, statusCalc: despesaPrevistaStatus(d) }));
  const abertas = comStatus.filter((d) => d.statusCalc !== "paga").sort((a, b) => (a.data_vencimento || "").localeCompare(b.data_vencimento || ""));
  const pagas = comStatus.filter((d) => d.statusCalc === "paga").sort((a, b) => (b.data_pagamento || "").localeCompare(a.data_pagamento || ""));
  const totais = {
    prevista: comStatus.filter((d) => d.statusCalc === "prevista").reduce((s, d) => s + d.valor_previsto, 0),
    atrasada: comStatus.filter((d) => d.statusCalc === "atrasada").reduce((s, d) => s + d.valor_previsto, 0),
    paga: pagas.reduce((s, d) => s + (d.valor_pago || d.valor_previsto), 0),
  };

  return (
    <div className="space-y-5">
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

function NovaNotaModal({ onClose, onSave }) {
  const [cliente, setCliente] = useState("");
  const [numeroNf, setNumeroNf] = useState("");
  const [valor, setValor] = useState("");
  const [dataEmissao, setDataEmissao] = useState(todayISO());
  const [prazoDias, setPrazoDias] = useState("30");
  const [err, setErr] = useState("");
  const [saving, setSaving] = useState(false);

  const submit = async () => {
    const v = parseFloat(String(valor).replace(",", "."));
    if (!cliente.trim()) { setErr("Informe o cliente."); return; }
    if (!v || v <= 0) { setErr("Informe um valor válido."); return; }
    setSaving(true);
    const prazo = parseInt(prazoDias, 10) || 0;
    const dataPrevista = new Date(dataEmissao + "T00:00:00");
    dataPrevista.setDate(dataPrevista.getDate() + prazo);
    const ok = await onSave({
      cliente: cliente.trim(), numero_nf: numeroNf.trim(), valor: v, status: "a_receber",
      data_emissao_nf: dataEmissao, prazo_pagamento_dias: prazo,
      data_prevista_recebimento: dataPrevista.toISOString().slice(0, 10),
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
        <Field label="Data de emissão"><TextInput type="date" value={dataEmissao} onChange={(e) => setDataEmissao(e.target.value)} /></Field>
        <Field label="Prazo de pagamento (dias)"><TextInput inputMode="numeric" value={prazoDias} onChange={(e) => setPrazoDias(e.target.value)} /></Field>
      </div>
      {err && <p className="text-sm mb-2" style={{ color: "var(--red)" }}>{err}</p>}
      <div className="flex justify-end gap-2 mt-2">
        <Btn variant="ghost" onClick={onClose}>Cancelar</Btn>
        <Btn variant="gold" icon={Check} onClick={submit} disabled={saving}>{saving ? "Salvando..." : "Salvar nota"}</Btn>
      </div>
    </Modal>
  );
}

function MarcarRecebidoModal({ nota, accounts, onClose, onSave }) {
  const [dataRecebimento, setDataRecebimento] = useState(todayISO());
  const [valorRecebido, setValorRecebido] = useState(String(nota.valor).replace(".", ","));
  const [valorBloqueado, setValorBloqueado] = useState("0");
  const [conta, setConta] = useState(accounts[0]?.id || "");
  const [err, setErr] = useState("");
  const [saving, setSaving] = useState(false);

  const vRecebido = parseFloat(String(valorRecebido).replace(",", ".")) || 0;
  const vBloqueado = parseFloat(String(valorBloqueado).replace(",", ".")) || 0;
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
    const v = parseFloat(String(valor).replace(",", "."));
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

function ContasReceberView({ contasReceber, accounts, canManage, onAdd, onMarcarRecebido, onLiberarBloqueio }) {
  const [modal, setModal] = useState(null);
  const aReceber = contasReceber.filter((n) => n.status !== "recebido").sort((a, b) => (a.data_prevista_recebimento || "").localeCompare(b.data_prevista_recebimento || ""));
  const recebidas = contasReceber.filter((n) => n.status === "recebido").sort((a, b) => (b.data_efetiva_recebimento || "").localeCompare(a.data_efetiva_recebimento || ""));

  const totais = {
    previsto: aReceber.reduce((s, n) => s + n.valor, 0),
    atrasado: aReceber.filter((n) => (n.data_prevista_recebimento || "") < todayISO()).reduce((s, n) => s + n.valor, 0),
    recebido: recebidas.reduce((s, n) => s + (n.valor_recebido || n.valor), 0),
    bloqueado: recebidas.reduce((s, n) => s + (n.valor_bloqueado || 0), 0),
    disponivel: recebidas.reduce((s, n) => s + ((n.valor_recebido || n.valor) - (n.valor_bloqueado || 0)), 0),
  };

  return (
    <div className="space-y-5">
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

      {modal?.kind === "nova" && <NovaNotaModal onClose={() => setModal(null)} onSave={async (n) => { const ok = await onAdd(n); if (ok) setModal(null); return ok; }} />}
      {modal?.kind === "receber" && <MarcarRecebidoModal nota={modal.nota} accounts={accounts.filter((a) => a.active)} onClose={() => setModal(null)} onSave={async (n, p) => { const ok = await onMarcarRecebido(n, p); if (ok) setModal(null); return ok; }} />}
      {modal?.kind === "liberar" && <LiberarBloqueioModal nota={modal.nota} accounts={accounts.filter((a) => a.active)} onClose={() => setModal(null)} onSave={async (n, p) => { const ok = await onLiberarBloqueio(n, p); if (ok) setModal(null); return ok; }} />}
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
  { key: "adiantamentos", label: "Adiantamentos", icon: HandCoins },
  { key: "reembolsos", label: "Reembolsos", icon: Receipt },
  { key: "contas", label: "Contas", icon: Landmark },
  { key: "categorias", label: "Categorias", icon: BarChart3 },
  { key: "relatorios", label: "Relatórios", icon: BarChart3 },
  { key: "config", label: "Configurações", icon: Settings },
];
// Sócios (Elisângela, Gilmar) veem uma navegação simplificada — só visão gerencial, sem telas operacionais
const NAV_SOCIO = [
  { key: "dashboard", label: "Dashboard", icon: Home },
  { key: "despesas-previstas", label: "Despesas Previstas", icon: TrendingDown },
  { key: "contas-receber", label: "Contas a Receber", icon: Wallet },
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
      const [{ data: profileRows }, { data: accountRows }, { data: categoryRows }, { data: txRows }, { data: despesasPrevistasRows }, { data: contasReceberRows }] = await Promise.all([
        supabase.from("profiles").select("*").order("name"),
        supabase.from("accounts").select("*").order("created_at"),
        supabase.from("categories").select("*").order("name"),
        supabase.from("transactions").select("*").order("date", { ascending: false }),
        supabase.from("despesas_previstas").select("*").order("data_vencimento"),
        supabase.from("revenue_forecast").select("*").order("data_prevista_recebimento"),
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
    const { error } = await supabase.from("transactions").update(toDb(updated)).eq("id", original.id);
    if (error) { setErrorBanner("Não consegui salvar a edição: " + error.message); return false; }
    const logRows = changedFields.map((f) => ({
      transaction_id: original.id, changed_by: currentUser.id, changed_by_name: currentUser.name,
      field_name: EDITABLE_FIELDS[f], old_value: String(original[f] ?? ""), new_value: String(updated[f] ?? ""), action: "edit",
    }));
    await supabase.from("transaction_audit_log").insert(logRows);
    setErrorBanner(""); setModal(null); return true;
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

          {tab === "dashboard" && <DashboardView accounts={accounts} transactions={transactions} engine={engine} onQuickAction={openQuick} role={role} categories={categories} despesasPrevistas={despesasPrevistas} contasReceber={contasReceber} />}
          {tab === "fluxo" && <FluxoCaixaView transactions={transactions} accounts={accounts} categories={categories} onToggleConferido={toggleConferido} onDelete={deleteTransaction} onEdit={(t) => setModal({ kind: "edit-tx", tx: t })} canDelete={role.canDelete} />}
          {tab === "adiantamentos" && <AdiantamentosView engine={engine} accounts={accounts} onBaixa={(a) => setModal({ kind: "baixa", adiantamento: a })} onDevolucao={(a) => setModal({ kind: "devolucao", adiantamento: a })} />}
          {tab === "reembolsos" && <ReembolsosView engine={engine} onPagar={(r) => setModal({ kind: "reembolso", reembolso: r })} />}
          {tab === "despesas-previstas" && <DespesasPrevistasView despesasPrevistas={despesasPrevistas} accounts={accounts} categories={categories} canManage={role.canLancar} onAdd={addDespesaPrevista} onMarcarPaga={marcarDespesaComoPaga} />}
          {tab === "contas-receber" && <ContasReceberView contasReceber={contasReceber} accounts={accounts} canManage={role.canLancar} onAdd={addContaReceber} onMarcarRecebido={marcarContaComoRecebida} onLiberarBloqueio={liberarBloqueio} />}
          {tab === "contas" && <ContasView accounts={accounts} engine={engine} onAdd={addAccount} onToggleActive={toggleAccountActive} canManage={role.canManageConfig} />}
          {tab === "categorias" && <CategoriasView categories={categories} onAdd={addCategory} onToggleActive={toggleCategoryActive} onUpdateEmoji={updateCategoryEmoji} canManage={role.canManageConfig} />}
          {tab === "relatorios" && <RelatoriosView transactions={transactions} accounts={accounts} engine={engine} />}
          {tab === "config" && <ConfiguracoesView profiles={profiles} currentUser={currentUser} onChangeRole={changeRole} />}
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
    </div>
  );
}
