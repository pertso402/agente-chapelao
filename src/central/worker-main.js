"use strict";
require("dotenv").config({path:".env.central",quiet:true});
require("dotenv").config({quiet:true});
const {createDatabase}=require("./database");
const {configuration}=require("./config");
const {createEvolution}=require("./evolution");
const {Engine}=require("./engine");
const {decide}=require("./agent");
function startWorker(options={}){
 const ownedPool=!options.pool;
 const pool=options.pool||createDatabase();
 const config=options.config||configuration();
 const engine=options.engine||new Engine({pool,config,evolution:createEvolution(config),decide});
 const stopOriginal=config.fullAgent?require("./full-agent").configure(engine):null;
 let stopped=false,refreshing=false;
 const refresh=async()=>{
  if(refreshing)return;
  refreshing=true;
  try{for(const instance of config.instances)await engine.refreshConnection(instance.id);}
  catch{console.error('{"event":"worker.connection_refresh_failed"}');}
  finally{refreshing=false;}
 };
 const timer=setInterval(refresh,30000);
 const loop=async()=>{
  while(!stopped){
   try{if(!(await engine.tick()))await new Promise(r=>setTimeout(r,400));}
   catch{console.error('{"event":"worker.tick_failed"}');await new Promise(r=>setTimeout(r,2000));}
  }
 };
 function stop(){stopped=true;clearInterval(timer);}
 const done=(async()=>{
  try{await refresh();await Promise.all([loop(),loop()]);}
  finally{stop();if(stopOriginal)await stopOriginal();if(ownedPool)await pool.end();}
 })();
 return {stop,done,engine};
}
if(require.main===module){
 const worker=startWorker();
 process.once("SIGTERM",worker.stop);process.once("SIGINT",worker.stop);
 worker.done.catch(()=>{console.error('{"event":"worker.start_failed"}');process.exitCode=1;});
}
module.exports={startWorker};
