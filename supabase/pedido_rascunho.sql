-- Tabela de rascunho do pedido: persiste o estado entre mensagens do WhatsApp.
-- Uma linha por telefone (upsert). Limpar após pedido finalizado.

CREATE TABLE IF NOT EXISTS pedido_rascunho (
  telefone        TEXT PRIMARY KEY,
  nome_cliente    TEXT,
  itens           JSONB,          -- array [{nome, quantidade, preco_unitario}]
  tipo_entrega    TEXT,           -- 'delivery' | 'retirada'
  endereco        TEXT,
  forma_pagamento TEXT,           -- 'pix' | 'dinheiro' | 'cartao'
  etapa_atual     TEXT DEFAULT 'inicio',
                                  -- 'inicio' | 'coletando_itens' | 'coletando_dados'
                                  -- | 'aguardando_confirmacao' | 'aguardando_pix'
  updated_at      TIMESTAMPTZ DEFAULT now()
);

-- RLS: apenas service role pode ler/escrever (o agente usa SUPA_SERVICE_KEY)
ALTER TABLE pedido_rascunho ENABLE ROW LEVEL SECURITY;

CREATE POLICY "service_role_all" ON pedido_rascunho
  FOR ALL
  USING (auth.role() = 'service_role')
  WITH CHECK (auth.role() = 'service_role');
