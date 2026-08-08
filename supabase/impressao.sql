-- Controle de impressão automática na térmica.
-- Execute UMA VEZ no Supabase → SQL Editor.
--
-- A fila de impressão mora na própria tabela `pedidos`: quando a internet do
-- restaurante cai, o pedido simplesmente continua com impresso = false e sai
-- assim que a conexão volta. Nada se perde.

ALTER TABLE pedidos
  ADD COLUMN IF NOT EXISTS impresso              BOOLEAN     NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS impresso_em           TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS impressao_tentativas  INTEGER     NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS impressao_erro        TEXT;

-- Índice parcial: o agente pergunta "tem pedido não impresso?" a cada 3
-- segundos. Indexar só as linhas pendentes mantém a consulta instantânea
-- mesmo com anos de histórico na tabela.
CREATE INDEX IF NOT EXISTS idx_pedidos_fila_impressao
  ON pedidos (created_at)
  WHERE impresso = false;

-- Pedidos que já existiam antes desta feature não devem sair da impressora
-- todos de uma vez quando o agente subir pela primeira vez.
UPDATE pedidos
   SET impresso = true, impresso_em = now()
 WHERE impresso = false
   AND created_at < now() - INTERVAL '1 day';

-- ─── REIMPRIMIR UM PEDIDO ────────────────────────────────────────────────────
-- UPDATE pedidos
--    SET impresso = false, impressao_tentativas = 0, impressao_erro = NULL
--  WHERE numero_pedido = 1234;

-- ─── VER A FILA E OS ERROS ───────────────────────────────────────────────────
-- SELECT numero_pedido, created_at, impressao_tentativas, impressao_erro
--   FROM pedidos
--  WHERE impresso = false
--  ORDER BY created_at;
