"use strict";
require("dotenv").config({path:".env.central",quiet:true});
require("dotenv").config({quiet:true});
const fs=require("node:fs/promises"),path=require("node:path");
const {createDatabase}=require("../src/central/database");
(async()=>{
 const pool=createDatabase();
 try{
  const sql=await fs.readFile(path.join(__dirname,"../supabase/migrations/20261015084000_full_agent.sql"),"utf8");
  await pool.query(sql);
  console.log("Coordenação do agente original instalada; tabelas de pedidos preservadas.");
 }finally{await pool.end();}
})().catch(()=>{console.error("Não foi possível instalar a coordenação do agente original.");process.exitCode=1;});
