"use strict";
const { randomUUID } = require("node:crypto");
const { transaction, withLocks } = require("./database");
const { assert, isCurrent, isControlCurrent } = require("./domain");
const { IDS } = require("./config");
const context = require("./legacy-context");
let runtimeEngine = null;

async function enqueue(engine, q, c, text, author = "ai") {
  if (!text) return;
  assert(typeof text === "string" && text.length <= 16000, 422, "Resposta extensa: conferir com a equipe.");
  const id = randomUUID();
  await q.query(
    "insert into cw_messages(id,restaurant_id,instance_id,conversation_id,cycle,direction,author,text,status,control_epoch,inbound_seq,config_epoch) values($1,$2,$3,$4,$5,'out',$6,$7,'pending',$8,$9,$10)",
    [id,c.restaurant_id,c.instance_id,c.id,c.cycle,author,text,c.control_epoch,c.inbound_seq,c.config_epoch],
  );
  await engine.job(q,"send",c.instance_id,c.id,{messageId:id},"send:"+id);
}
async function phoneLock(q, phone) {
  const start=Date.now();
  while (true) {
    const result=await q.query("select pg_try_advisory_lock(hashtextextended($1,0)) as locked",["cw:legacy-phone:"+phone]);
    if(result.rows[0].locked)return;
    assert(Date.now()-start<12000,409,"O pedido anterior ainda está sendo processado.");
    await new Promise(r=>setTimeout(r,50));
  }
}
// A mensagem deste job, como foi gravada na central.
async function currentInbound(q,c,job){
  const id=job.payload?.providerMessage?.key?.id;
  if(!id)return null;
  return (await q.query("select id,kind,text,created_at from cw_messages where conversation_id=$1 and provider_id=$2 and direction='in' limit 1",[c.id,id])).rows[0]||null;
}
// Texto que chegou depois de outro texto: o job mais novo responde pelos dois
// (ver burst abaixo), então este pode desistir. Mídia nunca desiste — áudio e
// comprovante têm tratamento próprio e se perderiam se fossem pulados.
async function superseded(q,c,job){
  const current=await currentInbound(q,c,job);
  if(!current||current.kind!=="text")return false;
  const newer=await q.query("select 1 from cw_messages where conversation_id=$1 and direction='in' and kind='text' and created_at>$2 limit 1",[c.id,current.created_at]);
  return newer.rows.length>0;
}
async function shouldRun(q,c,job){
  if(!isControlCurrent(c,c,job.payload))return false;
  if(isCurrent(c,c,job.payload))return true;
  return !(await superseded(q,c,job));
}
async function run(engine, job) {
  const initial=await engine.context(engine.pool,job.conversation_id);
  if(!(await shouldRun(engine.pool,initial,job)))return;
  return withLocks(engine.pool,initial.instance_id,initial.chat_jid,async q=>{
    let c=await engine.context(q,initial.id);
    if(!(await shouldRun(q,c,job)))return;
    await engine.checkLease(q,job);
    const previous=await q.query("select status from cw_private.legacy_runs where decision_key=$1",[job.dedup_key]);
    if(previous.rows[0]?.status==="done"||previous.rows[0]?.status==="uncertain")return;
    const completed=await q.query("select decision_key from cw_private.ai_decisions where decision_key=$1",[job.dedup_key]);
    if(completed.rows.length)return;
    if(previous.rows.length){
      await transaction(q,async()=>{
        await engine.checkLease(q,job);
        await engine.handoff(q,c,"legacy_uncertain","O processamento anterior foi interrompido. Confira se o pedido foi gravado antes de tentar novamente.");
        await q.query("update cw_private.legacy_runs set status='uncertain',completed_at=now() where decision_key=$1",[job.dedup_key]);
      });
      return;
    }
    const data=job.payload.providerMessage;
    if(c.instance_id!==IDS.primary||!c.phone||!/^[0-9]{10,15}$/.test(c.phone)||!data?.key?.id){
      await transaction(q,()=>engine.handoff(q,c,"missing_knowledge","Não foi possível confirmar o telefone ou o evento de entrada para o agente original."));
      return;
    }
    await phoneLock(q,c.phone);
    // Mensagens picadas ("Média" / "arroz, feijão" / "frango") viram UMA
    // rodada, como no agruparMensagem do agente original: os textos que
    // chegaram desde a última rodada e foram cobertos por este job seguem
    // juntos, e o agente lê o pedido inteiro em vez de só o último pedaço.
    const current=await currentInbound(q,c,job);
    const lastRun=(await q.query("select max(started_at) as t from cw_private.legacy_runs where conversation_id=$1",[c.id])).rows[0]?.t||null;
    const burst=current&&current.kind==="text"
      ? (await q.query(
          "select id,text from cw_messages where conversation_id=$1 and cycle=$2 and direction='in' and kind='text' and id<>$3 and created_at<=$4 and created_at>$4::timestamptz-interval '3 minutes' and ($5::timestamptz is null or created_at>$5) order by created_at,id",
          [c.id,c.cycle,current.id,current.created_at,lastRun],
        )).rows.filter(m=>m.text&&m.text.trim())
      : [];
    await q.query("insert into cw_private.legacy_runs(decision_key,restaurant_id,instance_id,conversation_id,status) values($1,$2,$3,$4,'running')",[job.dedup_key,c.restaurant_id,c.instance_id,c.id]);
    const texts=[];
    let scope,uncertain=false;
    try{
      const loadHistory=engine.loadLegacyHistory||require("../services/supabase").carregarHistorico;
      const prior=await loadHistory(c.phone,32);
      const recent=(await q.query(
        // pending/sending entram: a resposta da rodada anterior pode ainda não
        // ter saído, e sem ela no histórico o agente pergunta de novo.
        "select id,direction,author,text,created_at from cw_messages where conversation_id=$1 and cycle=$2 and status in ('received','accepted','delivered','read','pending','sending') order by created_at desc,id desc limit 40",[c.id,c.cycle],
      )).rows.reverse();
      const ids=new Set(prior.map(m=>m.central_message_id).filter(Boolean));
      for(const m of burst)ids.add(m.id); // entram no texto juntado, não como falas soltas
      const history=[
        ...prior,
        ...recent.filter(m=>!ids.has(m.id)).map(m=>({
          role:m.direction==="in"?"user":"assistant",
          content:m.author==="human"?"[Equipe humana] "+m.text:m.text,
          ts:Date.parse(m.created_at),central_message_id:m.id,
        })),
      ].sort((a,b)=>(a.ts||0)-(b.ts||0));
      const current=(await q.query("select id from cw_messages where conversation_id=$1 and provider_id=$2 and direction='in'",[c.id,data.key.id])).rows[0];
      scope={
        history,currentMessageId:current?.id,handoffReason:null,
        async respond(phone,text){
          assert(phone===c.phone,403,"O agente não pode escolher outro destinatário.");
          texts.push(String(text));
        },
        requestHandoff(reason){this.handoffReason=String(reason||"O agente solicitou atendimento humano.").slice(0,2000);},
        async recordHistory(role,content){
          const entry={role,content,ts:Date.now(),central_message_id:role==="user"?this.currentMessageId:undefined};
          const existing=role==="user"?this.history.findIndex(m=>m.central_message_id===this.currentMessageId):-1;
          if(existing>=0)this.history[existing]=entry;else this.history.push(entry);
          // Texto juntado não sobrescreve a mensagem no painel: ela continua
          // mostrando só o que o cliente mandou nela. A transcrição de áudio,
          // sim, substitui o "[audio]".
          if(role==="user"&&this.currentMessageId&&!burst.length)
            await q.query("update cw_messages set text=$2 where id=$1 and conversation_id=$3",[this.currentMessageId,String(content).slice(0,16000),c.id]);
        },
      };
      const processor=engine.processLegacy||require("../index").processarMensagem;
      const extract=engine.extractLegacy||require("../services/evolution").extrairMensagem;
      const msg=extract({data});
      assert(msg&&!msg.fromMe,422,"Evento sem mensagem de cliente.");
      msg.telefone=c.phone;
      if(burst.length)msg.texto=[...burst.map(m=>m.text.trim()),String(msg.texto||"").trim()].filter(Boolean).join("\n");
      await context.run(scope,()=>processor(msg,job.dedup_key));
    }catch{
      uncertain=true;
      if(!scope)scope={handoffReason:null};
      scope.handoffReason="O agente original encontrou uma falha. Confira o pedido e o histórico antes de retomar.";
    }
    await transaction(q,async()=>{
      await engine.checkLease(q,job);
      c=await engine.context(q,c.id);
      // A rodada já gravou rascunho/pedido: a resposta sai mesmo que o cliente
      // tenha escrito de novo no meio. Só a tomada humana a descarta.
      if(!isControlCurrent(c,c,job.payload))return;
      const text=texts.join("\n\n");
      if(scope.handoffReason||text.length>16000){
        await engine.handoff(q,c,uncertain?"legacy_uncertain":"legacy_handoff",scope.handoffReason||"Resposta extensa: conferir com a equipe.");
        c=await engine.context(q,c.id);
        if(text&&text.length<=16000)await enqueue(engine,q,c,text,"system");
      }else await enqueue(engine,q,c,text);
      await q.query(
        "insert into cw_private.ai_decisions(decision_key,restaurant_id,instance_id,conversation_id,action) values($1,$2,$3,$4,$5) on conflict(decision_key) do nothing",
        [job.dedup_key,c.restaurant_id,c.instance_id,c.id,scope.handoffReason?"handoff":text?"reply":"no_action"],
      );
      await q.query("update cw_private.legacy_runs set status=$2,completed_at=now() where decision_key=$1",[job.dedup_key,uncertain?"uncertain":"done"]);
      await engine.audit(q,c,null,"original_agent_completed",{handoff:Boolean(scope.handoffReason),uncertain});
    });
  });
}
async function lookup(engine,phone){
  return (await engine.pool.query("select c.*,i.ai_enabled,i.config_epoch from cw_conversations c join cw_instances i on i.id=c.instance_id where c.instance_id=$1 and c.phone=$2 order by c.updated_at desc,c.id desc limit 1",[IDS.primary,String(phone).replace(/\D/g,"")])).rows[0];
}
async function ensureBackground(engine,phone){
  const digits=String(phone).replace(/\D/g,"");
  if(!/^[0-9]{10,15}$/.test(digits))return null;
  const existing=await lookup(engine,digits);if(existing)return existing;
  return withLocks(engine.pool,IDS.primary,digits+"@s.whatsapp.net",q=>transaction(q,async()=>{
    const instance=(await q.query("select * from cw_instances where id=$1",[IDS.primary])).rows[0];
    if(!instance?.ai_enabled)return null;
    const c=(await q.query("insert into cw_conversations(restaurant_id,instance_id,chat_jid,phone,state) values($1,$2,$3,$4,'ai') on conflict(instance_id,chat_jid) do update set phone=excluded.phone returning *",[engine.config.restaurantId,IDS.primary,digits+"@s.whatsapp.net",digits])).rows[0];
    return c;
  }));
}
async function backgroundPaused(phone){
  if(!runtimeEngine)return null;
  const c=await lookup(runtimeEngine,phone);
  return c?c.state!=="ai"||!c.ai_enabled:null;
}
async function backgroundReply(phone,text,{requestId,etapa}){
  const engine=runtimeEngine;
  if(!engine)return false;
  const c=await ensureBackground(engine,phone);
  if(!c)return false;
  return withLocks(engine.pool,c.instance_id,c.chat_jid,q=>transaction(q,async()=>{
    const fresh=await engine.context(q,c.id);
    if(fresh.state!=="ai"||!fresh.ai_enabled)return false;
    const resumed=(await q.query("select created_at from cw_activity_log where conversation_id=$1 and action='resume-ai' order by created_at desc limit 1",[c.id])).rows[0];
    if(resumed){
      const incoming=await q.query("select id from cw_messages where conversation_id=$1 and direction='in' and created_at>$2 limit 1",[c.id,resumed.created_at]);
      if(!incoming.rows.length)return false;
    }
    const key="legacy-background:"+etapa+":"+requestId;
    const inserted=await q.query("insert into cw_private.ai_decisions(decision_key,restaurant_id,instance_id,conversation_id,action) values($1,$2,$3,$4,'reply') on conflict(decision_key) do nothing returning decision_key",[key,c.restaurant_id,c.instance_id,c.id]);
    if(!inserted.rows.length)return false;
    await enqueue(engine,q,fresh,text);
    return true;
  }));
}
async function backgroundHandoff(phone,reason){
  const engine=runtimeEngine;if(!engine)return;
  const c=await ensureBackground(engine,phone);if(!c)return;
  return withLocks(engine.pool,c.instance_id,c.chat_jid,q=>transaction(q,async()=>{
    const fresh=await engine.context(q,c.id);
    await engine.handoff(q,fresh,"legacy_handoff",String(reason||"Conferir pedido em andamento.").slice(0,2000));
  }));
}
async function recordAccepted(c,message){
  if(c.instance_id!==IDS.primary||!c.phone)return;
  const legacy=require("../services/supabase");
  await legacy.salvarMensagem(c.phone,"assistant",(message.author==="human"?"[Equipe humana] ":"")+message.text,{centralMessageId:message.id});
  if(message.author==="human")await legacy.stamparRascunho(c.phone,{ultima_msg_role:"human",followup_enviado:true});
}
function configure(engine){
  runtimeEngine=engine;
  process.env.EVOLUTION_KEY=engine.config.instances.find(i=>i.id===IDS.primary).key;
  process.env.EVOLUTION_INSTANCE=engine.config.instances.find(i=>i.id===IDS.primary).name;
  let pending=Promise.resolve(),polling=false;
  const timer=setInterval(()=>{
    if(polling)return;
    polling=true;
    pending=require("../index").pollar().catch(()=>console.error('{"event":"original_agent.poller_failed"}')).finally(()=>{polling=false;});
  },60000);
  return async()=>{clearInterval(timer);await pending;runtimeEngine=null;};
}
module.exports={run,configure,backgroundPaused,backgroundReply,backgroundHandoff,recordAccepted,enqueue};
