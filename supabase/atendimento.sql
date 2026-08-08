-- Alertas para o painel + pausa do atendimento automático.
-- Execute UMA VEZ no Supabase → SQL Editor.
--
-- Estas duas tabelas são o que faz o "chama a atendente e pausa 10 minutos"
-- funcionar. Se elas não existirem, o agente escala em silêncio e ninguém vê.
-- O IF NOT EXISTS deixa rodar sem medo mesmo se já tiverem sido criadas pelo ERP.

-- ─── ALERTAS (aparecem no painel, com som) ────────────────────────────────────
CREATE TABLE IF NOT EXISTS atendimento_alertas (
  id           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  telefone     TEXT NOT NULL,
  nome_cliente TEXT,
  motivo       TEXT NOT NULL,
  status       TEXT NOT NULL DEFAULT 'aberto',  -- 'aberto' | 'resolvido'
  -- criado_em (não created_at): é o nome que o painel de pedidos já consulta.
  criado_em    TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolvido_em TIMESTAMPTZ
);

-- O painel busca "o que está aberto agora" o tempo todo — este índice mantém
-- essa consulta instantânea.
CREATE INDEX IF NOT EXISTS idx_alertas_abertos
  ON atendimento_alertas (criado_em DESC)
  WHERE status = 'aberto';

CREATE INDEX IF NOT EXISTS idx_alertas_telefone ON atendimento_alertas (telefone);

-- ─── PAUSA DO ATENDIMENTO AUTOMÁTICO ─────────────────────────────────────────
-- Uma linha por telefone. Enquanto pausado_ate estiver no futuro, a IA não
-- responde nada nessa conversa — quem fala é o atendente.
CREATE TABLE IF NOT EXISTS agente_pausas (
  telefone    TEXT PRIMARY KEY,
  pausado_ate TIMESTAMPTZ NOT NULL,
  motivo      TEXT,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ─── RLS: só o service role escreve (o agente usa SUPA_SERVICE_KEY) ──────────
ALTER TABLE atendimento_alertas ENABLE ROW LEVEL SECURITY;
ALTER TABLE agente_pausas       ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'atendimento_alertas' AND policyname = 'service_role_all') THEN
    CREATE POLICY "service_role_all" ON atendimento_alertas
      FOR ALL USING (auth.role() = 'service_role') WITH CHECK (auth.role() = 'service_role');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'agente_pausas' AND policyname = 'service_role_all') THEN
    CREATE POLICY "service_role_all" ON agente_pausas
      FOR ALL USING (auth.role() = 'service_role') WITH CHECK (auth.role() = 'service_role');
  END IF;
END $$;

-- ─── CONSULTAS ÚTEIS ─────────────────────────────────────────────────────────

-- Alertas abertos agora (é isso que o painel deve mostrar):
-- SELECT telefone, nome_cliente, motivo, criado_em
--   FROM atendimento_alertas WHERE status = 'aberto' ORDER BY criado_em DESC;

-- Resolver um alerta E liberar a IA na hora (sem esperar os 10 min):
-- UPDATE atendimento_alertas SET status = 'resolvido', resolvido_em = now() WHERE id = 123;
-- DELETE FROM agente_pausas WHERE telefone = '5544999999999';

-- Quem está com atendimento pausado neste momento:
-- SELECT telefone, motivo, pausado_ate FROM agente_pausas WHERE pausado_ate > now();
