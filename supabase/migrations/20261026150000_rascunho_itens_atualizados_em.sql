-- Quando o carrinho do rascunho mudou pela última vez. Um pedido gravado depois
-- disso (pela equipe, no painel) significa que o carrinho já foi atendido.
-- Aplicada em produção em 26/10/2026, antes do código que a usa.
alter table public.pedido_rascunho add column if not exists itens_atualizados_em timestamptz;
