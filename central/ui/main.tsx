import React, { useState, useEffect, useRef, useCallback } from "react";
import { createRoot } from "react-dom/client";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import "./style.css";
type Config = {
  supabaseUrl: string;
  publishableKey: string;
  restaurantId: string;
  demo: boolean;
  authMode: "password" | "internal_network" | "trusted_device";
};
type Me = { id: string; name: string; role: string };
type Instance = {
  id: string;
  label: string;
  ai_enabled: boolean;
  connection_state: string;
  checked_at: string;
};
type Member = { user_id: string; display_name: string; role: string };
type Conversation = {
  id: string;
  instance_id: string;
  customer_name: string;
  phone: string | null;
  chat_jid: string;
  state: string;
  assignee_id: string | null;
  label?: string;
  reason_detail?: string;
  reason_code?: string;
  summary?: string;
  waiting_since?: string;
  created_at: string;
  cycle: number;
};
type Message = {
  id: string;
  direction: string;
  author: string;
  author_id: string | null;
  kind: string;
  text: string;
  status: string;
  created_at: string;
  provider_at: string | null;
  cycle: number;
};
const stateNames: Record<string, string> = {
  waiting_human: "Precisa de ajuda",
  human: "Atendimento humano",
  ai: "Com a IA",
  closed: "Encerrada",
};
const statuses: Record<string, string> = {
  pending: "Na fila de envio",
  sending: "Enviando…",
  accepted: "Aceita pela API",
  delivered: "Entregue",
  read: "Lida",
  failed: "Falhou",
  unknown: "Envio incerto · confira antes de reenviar",
  cancelled: "Cancelada",
  received: "Recebida",
};
function initials(name: string) {
  return name
    .split(" ")
    .slice(0, 2)
    .map((n) => n[0])
    .join("")
    .toUpperCase();
}
function hour(date: string) {
  return new Date(date).toLocaleTimeString("pt-BR", {
    hour: "2-digit",
    minute: "2-digit",
  });
}
function elapsed(date: string) {
  const m = Math.max(
    0,
    Math.floor((Date.now() - new Date(date).getTime()) / 60000),
  );
  return m < 1
    ? "agora"
    : m < 60
      ? m + " min"
      : Math.floor(m / 60) + "h " + (m % 60) + "min";
}
function Icon({ name, size = 20 }: { name: string; size?: number }) {
  const paths: Record<string, React.ReactNode> = {
    chat: (
      <>
        <path d="M21 11.5a8.4 8.4 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.4 8.4 0 0 1-3.8-.9L3 21l1.9-5.7a8.4 8.4 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.4 8.4 0 0 1 3.8-.9H13a8.5 8.5 0 0 1 8 8v.5Z" />
      </>
    ),
    search: (
      <>
        <circle cx="10.5" cy="10.5" r="6.5" />
        <path d="m16 16 4 4" />
      </>
    ),
    bell: (
      <>
        <path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9M10 21h4" />
      </>
    ),
    send: (
      <>
        <path d="m22 2-7 20-4-9-9-4 20-7ZM22 2 11 13" />
      </>
    ),
    check: <path d="m5 12 4 4L19 6" />,
    clock: (
      <>
        <circle cx="12" cy="12" r="9" />
        <path d="M12 7v5l3 2" />
      </>
    ),
    arrow: <path d="m9 5 7 7-7 7" />,
    logout: (
      <>
        <path d="M9 4H4v16h5M14 8l4 4-4 4M8 12h10" />
      </>
    ),
    user: (
      <>
        <circle cx="12" cy="8" r="4" />
        <path d="M4 21v-2a8 8 0 0 1 16 0v2" />
      </>
    ),
    robot: (
      <>
        <rect x="4" y="7" width="16" height="13" rx="3" />
        <path d="M12 3v4M8 12h1M15 12h1M9 16h6M1 11v5M23 11v5" />
      </>
    ),
    sound: (
      <>
        <path d="m11 5-6 4H2v6h3l6 4V5ZM16 8a6 6 0 0 1 0 8M19 4a11 11 0 0 1 0 16" />
      </>
    ),
    settings: (
      <>
        <path d="M12 3v3M12 18v3M3 12h3M18 12h3M5.6 5.6l2.1 2.1M16.3 16.3l2.1 2.1M5.6 18.4l2.1-2.1M16.3 7.7l2.1-2.1" />
        <circle cx="12" cy="12" r="5" />
      </>
    ),
  };
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {paths[name] || paths.chat}
    </svg>
  );
}
// Activation credentials stay in the fragment, never query strings or referrers.
let activationToken = new URLSearchParams(window.location.hash.slice(1)).get("activate");
if (activationToken) window.history.replaceState(null, "", window.location.pathname + window.location.search);
async function readResponse(response: Response) {
  try { return await response.json(); }
  catch { throw new Error("A central está temporariamente indisponível. Tente novamente."); }
}
function App() {
  const [config, setConfig] = useState<Config | null>(null),
    [client, setClient] = useState<SupabaseClient | null>(null),
    [token, setToken] = useState("");
  const [me, setMe] = useState<Me | null>(null),
    [instances, setInstances] = useState<Instance[]>([]),
    [team, setTeam] = useState<Member[]>([]);
  const [list, setList] = useState<Conversation[]>([]),
    [selected, setSelected] = useState<Conversation | null>(null),
    [messages, setMessages] = useState<Message[]>([]);
  const [tab, setTab] = useState("waiting_human"),
    [instance, setInstance] = useState(""),
    [search, setSearch] = useState(""),
    [query, setQuery] = useState("");
  const [hasMore, setHasMore] = useState(false),
    [older, setOlder] = useState(false),
    [pending, setPending] = useState(0),
    [drafts, setDrafts] = useState<Record<string, string>>({});
  const [error, setError] = useState(""),
    [syncError, setSyncError] = useState(""),
    [notice, setNotice] = useState(""),
    [busy, setBusy] = useState(""),
    [connection, setConnection] = useState("Conectando…"),
    [sound, setSound] = useState(false);
  const [internalMembers, setInternalMembers] = useState<
    { user_id: string; display_name: string }[]
  >([]);
  const [operator, setOperator] = useState("");
  const [internalLoading, setInternalLoading] = useState(false);
  const [email, setEmail] = useState(""),
    [password, setPassword] = useState(""),
    [loginBusy, setLoginBusy] = useState(false),
    [settings, setSettings] = useState(false),
    [transfer, setTransfer] = useState("");
  const [reset, setReset] = useState(false),
    [recovery, setRecovery] = useState(false);
  const [access, setAccess] = useState<(Member & { active: boolean })[]>([]);
  const [operations, setOperations] = useState<{
    jobs: { type: string; status: string; count: number }[];
    messages: { status: string; count: number }[];
  } | null>(null);
  const audio = useRef<AudioContext | null>(null),
    leader = useRef(false),
    countRef = useRef(0),
    keys = useRef(new Map<string, string>()),
    generation = useRef(0),
    scroll = useRef<HTMLDivElement | null>(null),
    selectedId = useRef<string | null>(null);
  const logout = useCallback(async () => {
    if (config && config.authMode !== "password") {
      const response = await fetch("/api/internal/logout", { method: "POST" });
      if (!response.ok) {
        setError(
          "Não foi possível trocar a pessoa responsável. Tente novamente.",
        );
        return;
      }
    }
    setToken("");
    setMe(null);
    setList([]);
    setMessages([]);
    setSelected(null);
    setDrafts({});
    setSound(false);
    if (client) await client.auth.signOut();
  }, [client, config]);
  useEffect(() => {
    fetch("/api/config")
      .then((r) => readResponse(r))
      .then((c: Config) => {
        setConfig(c);
        if (c.authMode !== "password") return;
        if (c.demo) {
          setToken("demo");
          return;
        }
        if (!c.demo) {
          const sb = createClient(c.supabaseUrl, c.publishableKey);
          setClient(sb);
          sb.auth
            .getSession()
            .then(({ data }) => setToken(data.session?.access_token || ""));
          sb.auth.onAuthStateChange((event, session) => {
            setToken(session?.access_token || "");
            if (event === "PASSWORD_RECOVERY") setRecovery(true);
          });
        }
      })
      .catch(() =>
        setError("Não foi possível carregar a central. Recarregue a página."),
      );
  }, []);
  useEffect(() => {
    if (!config || config.authMode === "password" || token) return;
    let active = true;
    setInternalLoading(true);
    const activate = activationToken;
    activationToken = null;
    const ready = activate ? fetch("/api/internal/enroll", {
      method:"POST", headers:{"Content-Type":"application/json"}, body:JSON.stringify({token:activate})
    }).then(async r => { const v=await readResponse(r); if(!r.ok) throw new Error(v.error || "Não foi possível ativar este aparelho."); }) : Promise.resolve();
    ready.then(() => fetch("/api/internal/access"))
      .then(async (r) => {
        const v = await readResponse(r);
        if (!r.ok) throw new Error(v.error || "Acesso interno indisponível.");
        return v;
      })
      .then((v) => {
        if (!active) return;
        setInternalMembers(v.members);
        if (v.selected) setToken("internal-session");
      })
      .catch((e) => {
        if (active) setError(e.message);
      })
      .finally(() => {
        if (active) setInternalLoading(false);
      });
    return () => {
      active = false;
    };
  }, [config, token]);
  async function enterInternal(event: React.FormEvent) {
    event.preventDefault();
    setLoginBusy(true);
    setError("");
    try {
      const r = await fetch("/api/internal/select", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userId: operator }),
      });
      const v = await readResponse(r);
      if (!r.ok) throw new Error(v.error || "Não foi possível entrar.");
      setToken("internal-session");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoginBusy(false);
    }
  }
  const api = useCallback(
    async (url: string, init: RequestInit = {}) => {
      const response = await fetch("/api" + url, {
        ...init,
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer " + token,
          ...init.headers,
        },
      });
      if (response.status === 401 || response.status === 403) {
        if (
          response.status === 401 ||
          (response.status === 403 && !init.method)
        ) {
          setMe(null);
          setToken("");
          setList([]);
          setMessages([]);
          setSelected(null);
          setDrafts({});
          setSound(false);
        }
      }
      const value = await readResponse(response);
      if (!response.ok) throw new Error(value.error || "A operação falhou.");
      return value;
    },
    [token],
  );
  const tone = useCallback(async () => {
    const a = audio.current;
    if (!a) return;
    await a.resume();
    const o = a.createOscillator(),
      g = a.createGain();
    o.connect(g);
    g.connect(a.destination);
    o.frequency.value = 640;
    g.gain.setValueAtTime(0.12, a.currentTime);
    g.gain.exponentialRampToValueAtTime(0.001, a.currentTime + 0.45);
    o.start();
    o.stop(a.currentTime + 0.5);
  }, []);
  useEffect(() => {
    let release: (() => void) | undefined;
    let alive = true,
      trying = false;
    const take = () => {
      if (trying || !navigator.locks) return;
      trying = true;
      navigator.locks
        .request(
          "chapelao-alert-sound",
          { ifAvailable: true },
          async (lock) => {
            if (lock && alive) {
              leader.current = true;
              await new Promise<void>((r) => {
                release = r;
              });
              leader.current = false;
            }
          },
        )
        .finally(() => {
          trying = false;
        });
    };
    take();
    const t = setInterval(take, 3000);
    return () => {
      alive = false;
      clearInterval(t);
      release?.();
      leader.current = false;
    };
  }, []);
  useEffect(() => {
    countRef.current = pending;
    if (sound && pending > 0 && leader.current)
      tone().catch(() => setSound(false));
  }, [pending, sound, tone]);
  useEffect(() => {
    if (!sound) return;
    const t = setInterval(() => {
      if (countRef.current > 0 && leader.current)
        tone().catch(() => setSound(false));
    }, 30000);
    return () => clearInterval(t);
  }, [sound, tone]);
  useEffect(() => {
    const t = setTimeout(() => setQuery(search), 250);
    return () => clearTimeout(t);
  }, [search]);
  const params = useCallback(
    () =>
      "?" +
      new URLSearchParams({
        state: tab === "mine" ? "human" : tab,
        ...(tab === "mine" ? { mine: "true" } : {}),
        ...(instance ? { instance } : {}),
        ...(query ? { search: query } : {}),
      }),
    [tab, instance, query],
  );
  const loadMessages = useCallback(
    async (id: string, before?: string) => {
      const r = await api(
        "/conversations/" +
          id +
          "/messages" +
          (before ? "?before=" + before : ""),
      );
      if (selectedId.current !== id) return;
      setMessages((old) =>
        before
          ? [
              ...r.items,
              ...old.filter(
                (m) => !r.items.some((n: Message) => n.id === m.id),
              ),
            ]
          : r.items,
      );
      setOlder(r.hasMore);
    },
    [api],
  );
  const refresh = useCallback(async () => {
    if (!token) return;
    const gen = ++generation.current;
    try {
      const [who, nums, members, convos, queue] = await Promise.all([
        api("/me"),
        api("/instances"),
        api("/team"),
        api("/conversations" + params()),
        api("/queue-count"),
      ]);
      if (gen !== generation.current) return;
      setMe(who);
      setInstances(nums);
      setTeam(members);
      setList(convos.items);
      setHasMore(convos.hasMore);
      setPending(queue.count);
      setSyncError("");
      if (config && config.authMode !== "password")
        setConnection(config.demo ? "Demonstração local" : "Atualização automática");
      const id = selectedId.current;
      if (id) {
        const detail = await api("/conversations/" + id);
        if (selectedId.current === id)
          setSelected((old) => ({
            ...old,
            ...detail,
            label: nums.find((i: Instance) => i.id === detail.instance_id)
              ?.label,
          }));
        await loadMessages(id);
      }
    } catch (e) {
      setSyncError("Não foi possível atualizar agora. Tentando reconectar automaticamente…");
      setConnection("Reconectando…");
    }
  }, [token, api, params, loadMessages, config?.authMode, config?.demo]);
  useEffect(() => {
    if (!token) return;
    refresh();
    const t = setInterval(
      refresh,
      config && config.authMode !== "password" ? 1500 : 30000,
    );
    const focus = () => {
      if (!document.hidden) refresh();
    };
    document.addEventListener("visibilitychange", focus);
    window.addEventListener("focus", focus);
    return () => {
      clearInterval(t);
      document.removeEventListener("visibilitychange", focus);
      window.removeEventListener("focus", focus);
    };
  }, [token, refresh, config?.authMode]);
  useEffect(() => {
    if (!token || !config) return;
    if (config.demo) {
      setConnection("Demonstração local");
      return;
    }
    if (config.authMode !== "password") {
      setConnection("Atualização automática");
      return;
    }
    if (!client) return;
    let stale = false,
      timer: ReturnType<typeof setTimeout> | undefined;
    const changed = () => {
      stale = true;
      clearTimeout(timer);
      timer = setTimeout(() => {
        stale = false;
        refresh();
      }, 100);
    };
    const channel = client.channel("central:" + config.restaurantId);
    for (const table of [
      "cw_instances",
      "cw_conversations",
      "cw_messages",
      "cw_handoffs",
    ])
      channel.on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table,
          filter: "restaurant_id=eq." + config.restaurantId,
        },
        changed,
      );
    channel.subscribe((status) => {
      if (status === "SUBSCRIBED") {
        setConnection("Ao vivo");
        refresh().then(() => {
          if (stale) refresh();
        });
      } else if (["CLOSED", "CHANNEL_ERROR", "TIMED_OUT"].includes(status)) {
        setConnection("Conexão degradada · consulta a cada 30s");
      }
    });
    return () => {
      clearTimeout(timer);
      client.removeChannel(channel);
    };
  }, [client, config, token, refresh]);
  useEffect(() => {
    scroll.current?.scrollTo({ top: scroll.current.scrollHeight });
  }, [selected?.id, messages.length]);
  useEffect(() => {
    if (settings && me?.role === "admin") {
      api("/operations")
        .then(setOperations)
        .catch((e) => setError(e.message));
      api("/team/access")
        .then(setAccess)
        .catch((e) => setError(e.message));
    }
  }, [settings, me?.role, api]);
  async function choose(c: Conversation) {
    selectedId.current = c.id;
    setSelected(c);
    setMessages([]);
    setError("");
    setTransfer("");
    try {
      await loadMessages(c.id);
    } catch (e) {
      setError((e as Error).message);
    }
  }
  async function command(action: string, body: unknown = {}) {
    if (!selected) return;
    const id = selected.id;
    const signature = JSON.stringify({ id, action, body });
    if (!keys.current.has(signature))
      keys.current.set(signature, crypto.randomUUID());
    setBusy(action);
    setError("");
    try {
      await api("/conversations/" + id + "/" + action, {
        method: "POST",
        headers: { "Idempotency-Key": keys.current.get(signature)! },
        body: JSON.stringify(body),
      });
      keys.current.delete(signature);
      if (action === "messages") setDrafts((old) => ({ ...old, [id]: "" }));
      setNotice(
        action === "messages"
          ? "Mensagem enfileirada. Acompanhe o status no histórico."
          : "Atendimento atualizado.",
      );
      await refresh();
    } catch (e) {
      setError((e as Error).message);
      await refresh();
    } finally {
      setBusy("");
    }
  }
  async function toggleAI(i: Instance) {
    setBusy("ai");
    setError("");
    try {
      await api("/instances/" + i.id + "/ai", {
        method: "POST",
        headers: { "Idempotency-Key": crypto.randomUUID() },
        body: JSON.stringify({ enabled: !i.ai_enabled }),
      });
      await refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy("");
    }
  }
  async function login(event: React.FormEvent) {
    event.preventDefault();
    if (!client) return;
    setLoginBusy(true);
    setError("");
    try {
      if (recovery) {
        const { error } = await client.auth.updateUser({ password });
        if (error) throw error;
        setRecovery(false);
        setNotice("Senha atualizada.");
      } else if (reset) {
        const { error } = await client.auth.resetPasswordForEmail(email, {
          redirectTo: window.location.origin,
        });
        if (error) throw error;
        setNotice(
          "Se o e-mail estiver cadastrado, você receberá as instruções.",
        );
      } else {
        const { data, error } = await client.auth.signInWithPassword({
          email,
          password,
        });
        if (error) throw error;
        setToken(data.session?.access_token || "");
      }
    } catch {
      setError(
        "Não foi possível concluir. Confira os dados e a configuração do Supabase.",
      );
    } finally {
      setLoginBusy(false);
    }
  }
  if (!config)
    return (
      <div className="loading">
        Carregando a central…{error && <p role="alert">{error}</p>}
      </div>
    );
  if (!token && config.authMode !== "password")
    return (
      <main className="internal-entry">
        <section className="internal-card">
          <div className="brand-mark">
            C<span>•</span>
          </div>
          <span className="eyebrow">CENTRAL CHAPELÃO · USO INTERNO</span>
          <h1>
            Bom atendimento
            <br />
            começa com a equipe.
          </h1>
          <p>
            Escolha seu nome para identificar os atendimentos que você assumir.
            Este navegador lembrará a escolha.
          </p>
          <form onSubmit={enterInternal}>
            <label>
              Quem está atendendo?
              <select
                required
                aria-label="Seu nome"
                value={operator}
                onChange={(e) => setOperator(e.target.value)}
              >
                <option value="">Selecione seu nome</option>
                {internalMembers.map((m) => (
                  <option key={m.user_id} value={m.user_id}>
                    {m.display_name}
                  </option>
                ))}
              </select>
            </label>
            <button
              className="primary"
              disabled={loginBusy || internalLoading || !operator}
            >
              {internalLoading
                ? "Conferindo acesso da empresa…"
                : loginBusy
                  ? "Abrindo…"
                  : "Abrir central"}
              <Icon name="arrow" />
            </button>
          </form>
          {!internalLoading && !internalMembers.length && !error && (
            <div className="notice">
              A equipe ainda precisa ser cadastrada na configuração da central.
            </div>
          )}
          {error && (
            <div className="error" role="alert">
              {error}
            </div>
          )}
          <small>
            Acesso salvo neste aparelho · Sem e-mail e senha
          </small>
          {config.demo && (
            <p className="demo-caption">
              Demonstração com dados fictícios. Nenhum WhatsApp real conectado.
            </p>
          )}
        </section>
      </main>
    );
  if (!token || recovery)
    return (
      <main className="login">
        <div className="login-art">
          <div className="brand-mark">
            C<span>•</span>
          </div>
          <p className="eyebrow">RESTAURANTE CHAPELÃO</p>
          <h1>
            Uma equipe.
            <br />
            Cada conversa
            <br />
            no seu lugar.
          </h1>
          <p>
            Os dois WhatsApps, um atendimento próximo.
            <br />A IA ajuda. A sua equipe assume quando precisa.
          </p>
          <div className="login-note">
            <Icon name="chat" /> Central de atendimento
          </div>
        </div>
        <form className="login-form" onSubmit={login}>
          <span className="eyebrow">BEM-VINDA À CENTRAL</span>
          <h2>
            {recovery
              ? "Crie sua nova senha"
              : reset
                ? "Recuperar acesso"
                : "Bom atendimento começa aqui."}
          </h2>
          <p>Entre com a sua conta da equipe Chapelão.</p>
          {!recovery && (
            <label>
              E-mail
              <input
                type="email"
                required
                autoComplete="username"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="seu@email.com"
              />
            </label>
          )}
          {(!reset || recovery) && (
            <label>
              Senha
              <input
                type="password"
                required
                minLength={8}
                autoComplete={recovery ? "new-password" : "current-password"}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="Sua senha"
              />
            </label>
          )}
          <button className="primary" disabled={loginBusy}>
            {loginBusy
              ? "Aguarde…"
              : recovery
                ? "Salvar senha"
                : reset
                  ? "Enviar instruções"
                  : "Entrar na central"}
            <Icon name="arrow" />
          </button>
          {!recovery && (
            <button
              className="link"
              type="button"
              onClick={() => {
                setReset(!reset);
                setError("");
              }}
            >
              {reset ? "Voltar para o login" : "Esqueci minha senha"}
            </button>
          )}
          {config.demo && (
            <button
              type="button"
              className="secondary"
              onClick={() => setToken("demo")}
            >
              Abrir demonstração com dados fictícios
            </button>
          )}
          {error && (
            <div className="error" role="alert">
              {error}
            </div>
          )}
          {notice && (
            <div role="status" className="notice">
              {notice}
            </div>
          )}
          <small>Contas individuais · Acesso exclusivo da equipe</small>
        </form>
      </main>
    );
  const activeInstance = instances.find((i) => i.id === selected?.instance_id),
    own = selected?.state === "human" && selected.assignee_id === me?.id;
  const responsible = team.find(
    (m) => m.user_id === selected?.assignee_id,
  )?.display_name;
  return (
    <div className="app-shell">
      {config.demo && (
        <div className="demo-banner">
          Demonstração local · dados fictícios · nenhum envio para WhatsApps
          reais
        </div>
      )}
      <header className="topbar">
        <a className="brand" href="/" aria-label="Chapelão Central">
          <span className="brand-logo">
            C<span>•</span>
          </span>
          <span>
            chapelão<small>CENTRAL DE ATENDIMENTO</small>
          </span>
        </a>
        <div className="connections">
          {instances.map((i) => (
            <span className="connection" key={i.id}>
              <i
                className={i.connection_state === "open" ? "dot" : "dot off"}
              />
              {i.label.replace("WhatsApp ", "")}
              <small>
                {i.connection_state === "open" ? "Conectado" : "Desconectado"}
              </small>
            </span>
          ))}
        </div>
        <div className="top-actions">
          <button
            className={sound ? "sound enabled" : "sound"}
            onClick={async () => {
              try {
                if (sound) {
                  setSound(false);
                  return;
                }
                audio.current ??= new AudioContext();
                await tone();
                setSound(true);
              } catch {
                setSound(false);
                setError(
                  "O navegador bloqueou o som. Clique para tentar novamente.",
                );
              }
            }}
          >
            <Icon name="sound" size={17} />
            {sound ? "Som ativado" : "Ativar som"}
          </button>
          <span className="divider" />
          <span className="avatar small">{initials(me?.name || "Equipe")}</span>
          <span className="user-name">
            {me?.name || "Carregando"}
            <small>
              {me?.role === "admin" ? "Administradora" : "Atendente"}
            </small>
          </span>
          <button
            className="icon-button"
            title={config.authMode !== "password" ? "Trocar pessoa" : "Sair"}
            aria-label={config.authMode !== "password" ? "Trocar pessoa" : "Sair"}
            onClick={logout}
          >
            <Icon name="logout" />
          </button>
        </div>
      </header>
      <div className="workspace-heading">
        <div>
          <span className="eyebrow">CADA CLIENTE IMPORTA</span>
          <h1>
            Caixa de entrada{" "}
            <span className="live">
              <i className="dot" />
              {connection}
            </span>
          </h1>
        </div>
        <div className="queue-badge">
          <Icon name="clock" size={18} />
          <strong>{pending}</strong>{" "}
          {pending === 1 ? "conversa aguardando" : "conversas aguardando"}
        </div>
        {me?.role === "admin" && (
          <button
            className="icon-button"
            onClick={() => setSettings(!settings)}
            title="Operação e instâncias"
            aria-label="Operação e instâncias"
          >
            <Icon name="settings" />
          </button>
        )}
      </div>
      {(error || syncError) && (
        <div className="global-error" role="alert">
          {error || syncError}
          <button onClick={() => { setError(""); setSyncError(""); }} aria-label="Fechar aviso">
            ×
          </button>
        </div>
      )}
      {notice && (
        <div className="global-notice" role="status">
          {notice}
          <button onClick={() => setNotice("")} aria-label="Fechar confirmação">
            ×
          </button>
        </div>
      )}
      {settings && (
        <section className="settings-panel">
          <h2>Operação da central</h2>
          <div className="instance-settings">
            {instances.map((i) => (
              <div key={i.id}>
                <strong>{i.label}</strong>
                <span>IA {i.ai_enabled ? "habilitada" : "pausada"}</span>
                <button
                  className="secondary"
                  disabled={!!busy}
                  onClick={() => toggleAI(i)}
                >
                  {i.ai_enabled ? "Pausar IA" : "Habilitar IA"}
                </button>
              </div>
            ))}
          </div>
          <p>
            Habilitar a IA não retira atendimentos da fila. Cada conversa
            precisa de retomada explícita.
          </p>
          <div className="team-access">
            <h3>Acesso da equipe</h3>
            {access.map((m) => (
              <div key={m.user_id}>
                <span>
                  {m.display_name} · {m.active ? "Ativo" : "Desativado"}
                </span>
                <button
                  className="secondary"
                  disabled={!!busy || m.user_id === me?.id}
                  onClick={async () => {
                    setBusy("member");
                    try {
                      await api("/team/" + m.user_id + "/access", {
                        method: "POST",
                        headers: { "Idempotency-Key": crypto.randomUUID() },
                        body: JSON.stringify({ active: !m.active }),
                      });
                      setAccess(await api("/team/access"));
                      await refresh();
                    } catch (e) {
                      setError((e as Error).message);
                    } finally {
                      setBusy("");
                    }
                  }}
                >
                  {m.active ? "Desativar acesso" : "Reativar acesso"}
                </button>
              </div>
            ))}
          </div>
          <div className="operations">
            {operations?.jobs.map((j) => (
              <span key={j.type + j.status}>
                {j.type} · {j.status}: <strong>{j.count}</strong>
              </span>
            ))}
            {operations?.messages.map((m) => (
              <span key={m.status}>
                {statuses[m.status]}: <strong>{m.count}</strong>
              </span>
            ))}
          </div>
        </section>
      )}
      <main className={"inbox " + (selected ? "has-selected" : "")}>
        <aside className="queue">
          <div className="queue-title">
            <h2>Conversas</h2>
            <span className="muted">02 números</span>
          </div>
          <div className="tabs">
            {[
              ["waiting_human", "Precisa de ajuda", "bell"],
              ["mine", "Meus atendimentos", "user"],
              ["ai", "Com a IA", "robot"],
              ["closed", "Encerradas", "check"],
            ].map(([id, label, icon]) => (
              <button
                key={id}
                className={tab === id ? "tab active" : "tab"}
                onClick={() => {
                  setTab(id);
                  setList([]);
                }}
              >
                <Icon name={icon} size={16} />
                {label}
                {id === "waiting_human" && <b>{pending}</b>}
              </button>
            ))}
          </div>
          <div className="queue-filters">
            <label className="search">
              <Icon name="search" size={17} />
              <input
                aria-label="Buscar cliente ou telefone"
                placeholder="Buscar cliente ou telefone"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
            </label>
            <label className="number-select">
              <span>WhatsApp</span>
              <select
                aria-label="Filtrar WhatsApp"
                value={instance}
                onChange={(e) => setInstance(e.target.value)}
              >
                <option value="">Todos os números</option>
                {instances.map((i) => (
                  <option value={i.id} key={i.id}>
                    {i.label}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <div className="list-title">
            <span>
              {tab === "waiting_human"
                ? "MAIS ANTIGAS PRIMEIRO"
                : tab === "mine"
                  ? "COM VOCÊ"
                  : tab === "ai"
                    ? "EM ATENDIMENTO"
                    : "HISTÓRICO"}
            </span>
            <span>
              {list.length}
              {hasMore ? "+" : ""}
            </span>
          </div>
          <div className="conversation-list">
            {list.length === 0 && (
              <div className="empty-list">
                <Icon name="check" size={28} />
                <strong>
                  {query
                    ? "Nenhuma conversa encontrada"
                    : "Tudo em dia por aqui"}
                </strong>
                <p>
                  {query
                    ? "Tente outro nome ou telefone."
                    : "As conversas desta fila aparecerão aqui."}
                </p>
              </div>
            )}
            {list.map((c) => (
              <button
                key={c.id}
                className={
                  "conversation-card " +
                  (selected?.id === c.id ? "selected" : "")
                }
                onClick={() => choose(c)}
              >
                <div className="card-top">
                  <span
                    className={
                      "number-tag " +
                      (c.instance_id ===
                      instances.find((i) => i.label.includes("secundário"))?.id
                        ? "secondary-number"
                        : "")
                    }
                  >
                    <Icon name="chat" size={12} />
                    {c.label}
                  </span>
                  <time>{elapsed(c.waiting_since || c.created_at)}</time>
                </div>
                <div className="card-name">
                  <span className="avatar">{initials(c.customer_name)}</span>
                  <div>
                    <strong>{c.customer_name}</strong>
                    <span>
                      {c.phone ? "+" + c.phone : "Identificador WhatsApp · LID"}
                    </span>
                  </div>
                  <Icon name="arrow" size={14} />
                </div>
                <p>{c.reason_detail || stateNames[c.state]}</p>
                {c.state === "waiting_human" && (
                  <span className="waiting-marker">● Aguardando equipe</span>
                )}
              </button>
            ))}
            {hasMore && (
              <button
                className="load-more"
                onClick={async () => {
                  try {
                    const r = await api(
                      "/conversations" + params() + "&after=" + list.at(-1)!.id,
                    );
                    setList((old) => [
                      ...old,
                      ...r.items.filter(
                        (n: Conversation) => !old.some((c) => c.id === n.id),
                      ),
                    ]);
                    setHasMore(r.hasMore);
                  } catch (e) {
                    setError((e as Error).message);
                  }
                }}
              >
                Carregar mais conversas
              </button>
            )}
          </div>
          <footer className="queue-footer">
            <i className="dot" />
            {connection}
          </footer>
        </aside>
        {selected ? (
          <>
            <section className="chat">
              <header className="chat-heading">
                <button
                  className="back-button"
                  onClick={() => {
                    selectedId.current = null;
                    setSelected(null);
                  }}
                >
                  ← Voltar
                </button>
                <span className="avatar">
                  {initials(selected.customer_name)}
                </span>
                <div>
                  <h2>{selected.customer_name}</h2>
                  <p>
                    {selected.phone ? "+" + selected.phone : selected.chat_jid}
                  </p>
                </div>
                <span className="number-tag">
                  <Icon name="chat" size={13} />
                  {activeInstance?.label}
                </span>
              </header>
              <div className="chat-state">
                <span className={"state-pill " + selected.state}>
                  {stateNames[selected.state]}
                </span>
                <span>
                  {responsible
                    ? "Responsável: " + responsible
                    : "Histórico separado por WhatsApp"}
                </span>
                <small>Ciclo {selected.cycle}</small>
              </div>
              <div className="compact-context">
                <strong>
                  {selected.reason_detail ||
                    "Confira o histórico antes de responder."}
                </strong>
                {selected.summary && <p>{selected.summary}</p>}
              </div>
              <div className="messages" ref={scroll}>
                {older && (
                  <button
                    className="load-more"
                    onClick={() =>
                      loadMessages(selected.id, messages[0]?.id).catch((e) =>
                        setError(e.message),
                      )
                    }
                  >
                    Carregar mensagens anteriores
                  </button>
                )}
                <div className="history-note">
                  Esta conversa pertence ao{" "}
                  {activeInstance?.label.toLowerCase()}.
                </div>
                {messages.map((m) => (
                  <article
                    key={m.id}
                    className={
                      "message " +
                      (m.direction === "out" ? "outgoing" : "incoming")
                    }
                  >
                    <div className="message-author">
                      {m.direction === "in"
                        ? selected.customer_name
                        : m.author === "human"
                          ? team.find((t) => t.user_id === m.author_id)
                              ?.display_name || "Equipe humana"
                          : m.author === "ai"
                            ? "Chapinha · IA"
                            : m.author === "external"
                              ? "Resposta externa pelo WhatsApp"
                              : "Sistema"}
                    </div>
                    <p>{m.text}</p>
                    {m.kind !== "text" && (
                      <Media message={m} token={token} onError={setError} />
                    )}
                    <footer>
                      <time>{hour(m.provider_at || m.created_at)}</time>
                      {m.direction === "out" && (
                        <span className={"delivery " + m.status}>
                          {statuses[m.status]}
                        </span>
                      )}
                    </footer>
                    {m.status === "unknown" && me?.role === "admin" && (
                      <button
                        className="link"
                        onClick={() => {
                          const note = window.prompt(
                            "Descreva a conferência do envio no WhatsApp (mínimo 8 caracteres):",
                          );
                          if (note)
                            command("resolve-message", {
                              messageId: m.id,
                              note,
                            });
                        }}
                      >
                        Registrar conferência
                      </button>
                    )}
                  </article>
                ))}
              </div>
              <div className="composer">
                <div className="sending-from">
                  <Icon name="chat" size={14} />
                  Respondendo pelo <strong>{activeInstance?.label}</strong>
                  {own && <span>· Atendimento com você</span>}
                </div>
                {own ? (
                  <form
                    onSubmit={(e) => {
                      e.preventDefault();
                      command("messages", { text: drafts[selected.id] || "" });
                    }}
                  >
                    <textarea
                      aria-label="Sua resposta"
                      placeholder="Escreva uma resposta para o cliente…"
                      rows={3}
                      maxLength={4000}
                      value={drafts[selected.id] || ""}
                      onChange={(e) =>
                        setDrafts((old) => ({
                          ...old,
                          [selected.id]: e.target.value,
                        }))
                      }
                    />
                    <div className="composer-bottom">
                      <small>O envio é feito pelo número de origem.</small>
                      <button
                        className="primary"
                        disabled={!!busy || !(drafts[selected.id] || "").trim()}
                      >
                        Enviar <Icon name="send" size={16} />
                      </button>
                    </div>
                  </form>
                ) : (
                  <div className="composer-locked">
                    <Icon name="user" size={17} />
                    {selected.state === "closed"
                      ? "Encerrada. Uma nova mensagem do cliente inicia outro ciclo."
                      : selected.state === "human"
                        ? "Esta conversa está com " + responsible + "."
                        : "Assuma o atendimento para responder ao cliente."}
                  </div>
                )}
              </div>
            </section>
            <aside className="context">
              <div className="context-title">
                <Icon name="user" size={17} />
                <h2>Sobre o atendimento</h2>
              </div>
              <div className="context-section">
                <label>WHATSAPP DE ORIGEM</label>
                <div className="origin-card">
                  <span className="origin-icon">
                    <Icon name="chat" />
                  </span>
                  <div>
                    <strong>{activeInstance?.label}</strong>
                    <span>
                      <i
                        className={
                          activeInstance?.connection_state === "open"
                            ? "dot"
                            : "dot off"
                        }
                      />
                      {activeInstance?.connection_state === "open"
                        ? "Conectado"
                        : "Desconectado"}
                    </span>
                  </div>
                </div>
              </div>
              <div className="context-section">
                <label>MOTIVO DO ENCAMINHAMENTO</label>
                <p>
                  {selected.reason_detail || "Sem encaminhamento registrado."}
                </p>
              </div>
              <div className="context-section">
                <label>RESUMO PARA A EQUIPE</label>
                <div className="summary">
                  {selected.summary ||
                    "Confira as mensagens do cliente antes de assumir."}
                </div>
              </div>
              <div className="context-metrics">
                <div>
                  <Icon name="clock" size={17} />
                  <span>
                    Tempo de espera
                    <strong>
                      {selected.waiting_since
                        ? elapsed(selected.waiting_since)
                        : "—"}
                    </strong>
                  </span>
                </div>
                <div>
                  <Icon name="user" size={17} />
                  <span>
                    Responsável
                    <strong>{responsible || "Ainda não assumido"}</strong>
                  </span>
                </div>
              </div>
              <div className="context-actions">
                {["ai", "waiting_human"].includes(selected.state) && (
                  <button
                    className="primary"
                    disabled={!!busy}
                    onClick={() => command("claim")}
                  >
                    <Icon name="user" size={17} />
                    {busy === "claim"
                      ? "Finalizando envio em andamento…"
                      : "Assumir atendimento"}
                  </button>
                )}
                {own && (
                  <>
                    <button
                      className="secondary"
                      disabled={!!busy}
                      onClick={() => command("release")}
                    >
                      Devolver à fila
                    </button>
                    <button
                      className="secondary"
                      disabled={!!busy || !activeInstance?.ai_enabled}
                      onClick={() => command("resume-ai")}
                    >
                      <Icon name="robot" size={17} />
                      Devolver à IA
                    </button>
                  </>
                )}
                {(own || me?.role === "admin") &&
                  selected.state !== "closed" && (
                    <button
                      className="close-conversation"
                      disabled={!!busy}
                      onClick={() => command("close")}
                    >
                      <Icon name="check" size={17} />
                      Encerrar atendimento
                    </button>
                  )}
                {selected.state === "human" && me?.role === "admin" && (
                  <>
                    <label className="transfer">
                      Transferir para
                      <select
                        aria-label="Transferir responsável"
                        value={transfer}
                        onChange={(e) => setTransfer(e.target.value)}
                      >
                        <option value="">Selecione a pessoa</option>
                        {team
                          .filter((t) => t.user_id !== selected.assignee_id)
                          .map((t) => (
                            <option key={t.user_id} value={t.user_id}>
                              {t.display_name}
                            </option>
                          ))}
                      </select>
                    </label>
                    <button
                      className="secondary"
                      disabled={!!busy || !transfer}
                      onClick={() => command("transfer", { userId: transfer })}
                    >
                      Transferir atendimento
                    </button>
                  </>
                )}
              </div>
              <div className="human-note">
                <Icon name="robot" size={16} />
                <p>
                  {selected.state === "human"
                    ? "A IA permanece pausada até uma ação explícita da equipe."
                    : selected.state === "closed"
                      ? "A próxima mensagem do cliente poderá iniciar um novo ciclo."
                      : "O atendimento fica sempre no WhatsApp de origem."}
                </p>
              </div>
            </aside>
          </>
        ) : (
          <section className="empty-chat">
            <div className="empty-illustration">
              <Icon name="chat" size={44} />
              <span>✓</span>
            </div>
            <span className="eyebrow">BOM ATENDIMENTO, EM EQUIPE</span>
            <h2>Cada conversa tem seu lugar.</h2>
            <p>
              Selecione uma conversa para ver o histórico,
              <br />
              entender o contexto e ajudar o cliente.
            </p>
            <div className="empty-points">
              <span>
                <i className="dot" />
                Dois números, uma equipe
              </span>
              <span>
                <Icon name="user" size={14} />
                Controle humano persistente
              </span>
            </div>
          </section>
        )}
      </main>
    </div>
  );
}
function Media({
  message,
  token,
  onError,
}: {
  message: Message;
  token: string;
  onError: (e: string) => void;
}) {
  const [url, setUrl] = useState(""),
    [type, setType] = useState(""),
    [loading, setLoading] = useState(false);
  useEffect(
    () => () => {
      if (url) URL.revokeObjectURL(url);
    },
    [url],
  );
  async function load() {
    setLoading(true);
    try {
      const r = await fetch("/api/messages/" + message.id + "/media", {
        headers: { Authorization: "Bearer " + token },
      });
      if (!r.ok) {
        const b = await readResponse(r);
        throw new Error(b.error || "Não foi possível recuperar a mídia.");
      }
      const blob = await r.blob();
      setType(blob.type);
      setUrl(URL.createObjectURL(blob));
    } catch (e) {
      onError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }
  if (!url)
    return (
      <button className="media-button" disabled={loading} onClick={load}>
        {loading ? "Carregando…" : "Abrir anexo privado"}
      </button>
    );
  if (type.startsWith("image/"))
    return (
      <img className="attachment" src={url} alt="Imagem enviada pelo cliente" />
    );
  if (type.startsWith("audio/")) return <audio controls src={url} />;
  return (
    <a className="media-button" href={url} download="anexo">
      Baixar anexo
    </a>
  );
}
createRoot(document.getElementById("root")!).render(<App />);
