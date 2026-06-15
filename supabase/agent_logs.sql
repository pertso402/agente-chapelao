-- Tabela de logs do agente de atendimento
-- Execute no Supabase Dashboard → SQL Editor

CREATE TABLE IF NOT EXISTS agent_logs (
  id        bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  request_id  text,
  telefone    text,
  nivel       text CHECK (nivel IN ('info', 'warn', 'error')),
  etapa       text NOT NULL,
  mensagem    text,
  dados       jsonb,
  erro_stack  text,
  created_at  timestamptz DEFAULT now()
);

-- Índices para consultas rápidas
CREATE INDEX IF NOT EXISTS idx_agent_logs_telefone    ON agent_logs (telefone);
CREATE INDEX IF NOT EXISTS idx_agent_logs_nivel       ON agent_logs (nivel);
CREATE INDEX IF NOT EXISTS idx_agent_logs_created_at  ON agent_logs (created_at DESC);

-- RLS: apenas service role pode inserir; anon pode ler (para dashboard)
ALTER TABLE agent_logs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "service pode inserir logs"
  ON agent_logs FOR INSERT
  WITH CHECK (true);

CREATE POLICY "leitura publica dos logs"
  ON agent_logs FOR SELECT
  USING (true);
