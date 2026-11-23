"use strict";
const {test}=require("node:test");
const assert=require("node:assert/strict");
const {randomUUID}=require("node:crypto");
const scopeStore=require("../src/central/legacy-context");
let draft,orders,conversationCalls,history,errors;
const fakeResult=payment=>({numeroPedido:42,total:21,subtotal:21,taxaEntrega:0,desconto:0,brindes:[],formaPagamento:payment});
function reset(payment="dinheiro"){
 draft={nome_cliente:"Cliente teste",tipo_entrega:"retirada",forma_pagamento:payment,itens:JSON.stringify([{nome:"Marmitex Média",quantidade:1,preco_unitario:21}]),etapa_atual:"aguardando_confirmacao"};
 orders=[];conversationCalls=0;history=[];errors=[];
}
const services={
 async carregarRascunho(){return draft?{...draft}:null;},
 async salvarRascunho(phone,fields){draft={...(draft||{}),...fields};},
 async stamparRascunho(){},
 async limparRascunho(){draft=null;},
 async carregarHistorico(){return scopeStore.current().history;},
 async salvarMensagem(phone,role,content){await scopeStore.current().recordHistory(role,content);},
 async verificarPausa(){return Boolean(scopeStore.current()?.handoffReason);},
 async pausarAtendimento(phone,ms,reason){scopeStore.current().requestHandoff(reason);},
 async criarAlertaAtendimento(){},
 async buscarLojaAberta(){return true;},
 async garantirCliente(){},
 async buscarCupomAtivoPorTelefone(){return null;},
 async buscarComboPorId(){return null;},
 async buscarInfo(){return {chave_pix:"chave-ficticia-para-teste"};},
 async tentarIniciarConfirmacao(){if(draft?.etapa_atual!=="aguardando_confirmacao")return false;draft.etapa_atual="processando";return true;},
 async tentarIniciarPagamento(){if(draft?.etapa_atual!=="aguardando_pix")return null;const prior={...draft};draft.etapa_atual="processando";return prior;},
 async criarPedidoCompleto(data){orders.push(data);return fakeResult(data.formaPagamento);},
 async precificarPedido(){return fakeResult("pix");},
 async garantirPedidoDeTaxa(){return {estado:"dispensado"};},
};
const dbPath=require.resolve("../src/services/supabase");
require.cache[dbPath]={id:dbPath,filename:dbPath,loaded:true,exports:new Proxy(services,{get(obj,key){return key in obj?obj[key]:async()=>null;}})};
const loggerPath=require.resolve("../src/logger");
require.cache[loggerPath]={id:loggerPath,filename:loggerPath,loaded:true,exports:new Proxy({},{get:(_obj,key)=>key==="error"?(...args)=>errors.push(args):()=>{}})};
const evolutionPath=require.resolve("../src/services/evolution");
const originalEvolution=require(evolutionPath);
require.cache[evolutionPath]={id:evolutionPath,filename:evolutionPath,loaded:true,exports:{...originalEvolution,
 async enviarTexto(){throw new Error("Direct Evolution sending must not be used in the central.");},
 manterDigitando:()=>()=>{},
 async downloadMidia(){return {base64:"dGVzdA==",mimetype:"image/jpeg"};},
}};
const mediaPath=require.resolve("../src/services/media");
require.cache[mediaPath]={id:mediaPath,filename:mediaPath,loaded:true,exports:{
 async transcreverAudio(){return "SIM";},
 async analisarImagem(){return {isComprovante:true,valor:21,confianca:"alta",analise:"Comprovante fictício do teste."};},
}};
const originalAgent=require("../src/agent");
const agentPath=require.resolve("../src/agent");
require.cache[agentPath].exports={...originalAgent,async rodarAgente(){conversationCalls++;return {texto:"Vamos montar seu pedido.",atendenteChamado:false,mostrouCardapio:false};}};
const {processarMensagem}=require("../src/index");
async function run(message){
 const texts=[];
 const scope={history:[],handoffReason:null,
  async respond(phone,text){assert.equal(phone,"554400000000");texts.push(text);},
  requestHandoff(reason){this.handoffReason=reason;},
  async recordHistory(role,content){this.history.push({role,content});history.push({role,content});},
 };
 await scopeStore.run(scope,()=>processarMensagem({telefone:"554400000000",pushName:"Cliente teste",tipo:"text",texto:"SIM",key:{id:randomUUID(),remoteJid:"554400000000@s.whatsapp.net",fromMe:false},...message},randomUUID()));
 const programmingErrors=errors.filter(args=>/is not defined|is not a function|cannot read/i.test(String(args[1])));
 assert.deepEqual(programmingErrors,[]);
 return {texts,scope};
}
test("fluxo original: SIM confirma pedido e mantém criação para o painel",async()=>{
 reset();const result=await run({});
 assert.equal(orders.length,1);assert.equal(orders[0].nomeCliente,"Cliente teste");assert.equal(conversationCalls,0);
 assert.ok(result.texts.some(t=>t.includes("#42")&&t.includes("confirmado")));assert.equal(draft,null);
 assert.equal(result.scope.handoffReason,null);
});
test("fluxo original: PIX reserva sem criar pedido antes do comprovante",async()=>{
 reset("pix");const result=await run({});
 assert.equal(orders.length,0);assert.equal(draft.etapa_atual,"aguardando_pix");assert.equal(draft.total_confirmado,21);
 assert.ok(result.texts.some(t=>t.includes("comprovante")));assert.equal(result.scope.handoffReason,null);
});
test("fluxo original: comprovante conferido cria pedido no painel",async()=>{
 reset("pix");draft.etapa_atual="aguardando_pix";draft.total_confirmado=21;
 const result=await run({tipo:"imageMessage",texto:"comprovante",base64:"dGVzdA==",mimetype:"image/jpeg"});
 assert.equal(orders.length,1);assert.equal(orders[0].formaPagamento,"pix");assert.equal(draft,null);
 assert.ok(result.texts.some(t=>t.includes("#42")));assert.equal(result.scope.handoffReason,null);
});
test("fluxo original: áudio transcrito segue confirmação autônoma",async()=>{
 reset();const result=await run({tipo:"audioMessage",texto:"",base64:"dGVzdA==",mimetype:"audio/ogg"});
 assert.equal(orders.length,1);assert.ok(result.texts.some(t=>t.includes("#42")));assert.equal(result.scope.handoffReason,null);
});
test("ferramentas completas de coleta, status e atendimento continuam disponíveis",()=>{
 const names=require("../src/tools").TOOLS.map(t=>t.function.name);
 for(const name of ["buscar_cardapio","buscar_itens_do_dia","salvar_dados_pedido","atualizar_status_pedido","chamar_atendente"])assert.ok(names.includes(name));
});
