"use strict";
// Actual worker process and kernel fs.read operations; test-only OS/cgroup and
// descendant dependency seams isolate allocation behavior, not staging proof.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const worker = require.resolve("./resource-staging-worker");
async function scenario(mode) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "qw-burst-unit-")), metricsFile = path.join(root, "metrics.json"), preload = path.join(root, "fixture.cjs");
  fs.writeFileSync(preload, `const Module=require("node:module"), fs=require("node:fs"), original=Module._load;
const metrics={calls:0,bytes:0,full:0,closed:false}; let zero;
const wrapper={...fs,openSync(file,...args){const fd=fs.openSync(file,...args);if(file==="/dev/zero")zero=fd;return fd;},closeSync(fd){if(fd===zero)metrics.closed=true;return fs.closeSync(fd);},readdirSync(file,...args){if(file==="/proc/self/task"&&process.platform!=="linux")return Array.from({length:23},(_,i)=>String(process.pid+i));return fs.readdirSync(file,...args);},read(fd,buffer,offset,length,position,callback){metrics.calls++;metrics.bytes+=length;const call=metrics.calls;return fs.read(fd,buffer,offset,length,position,(error,bytes,b)=>{if(!error&&bytes===length&&buffer[0]===0&&buffer[length-1]===0)metrics.full++;if(call===1&&${JSON.stringify(mode)}==="short")bytes--;if(call===1&&${JSON.stringify(mode)}==="error")error=new Error("controlled read failure");callback(error,bytes,b);});}};
Module._load=function(request,parent,main){if(parent?.filename===${JSON.stringify(worker)}){if(request==="fs")return wrapper;if(request==="./resource-linux-facts")return {readProcess:()=>({cgroup:"/unit-fixture"}),verifyWorkerGroup(){}};if(request==="child_process")return {spawn(){return {pid:42,on(){},kill(){}};}};}return original.call(this,request,parent,main);};
process.on("exit",()=>fs.writeFileSync(${JSON.stringify(metricsFile)},JSON.stringify(metrics)));
`);
  const child = spawn(process.execPath, ["--require", preload, worker], { env: { ...process.env, TMPDIR: root }, stdio: ["pipe", "pipe", "pipe"] });
  const records = []; let pending = "", stderr = "", sent = false;
  child.stderr.on("data", (b) => { stderr += b; });
  child.stdout.on("data", (b) => {
    pending += b.toString();
    while (pending.includes("\n")) {
      const end = pending.indexOf("\n"), line = pending.slice(0,end); pending = pending.slice(end+1);
      if (!line.startsWith("QW_RESOURCE:")) continue;
      const row = JSON.parse(line.slice(12)); records.push(row);
      if (row.kind === "ready" && !sent) { sent = true; child.stdin.write(JSON.stringify({kind:"pressure",challenge:"wrong"})+"\n"); child.stdin.write(JSON.stringify({kind:"ping",challenge:row.challenge,nonce:"prepressure"})+"\n"); }
      if (row.kind === "pong") { assert.equal(records.some((r) => r.kind.startsWith("allocation")), false); const challenge=records.find((r)=>r.kind==="ready").challenge; child.stdin.write((JSON.stringify({kind:"pressure",challenge})+"\n").repeat(2)); }
      if (row.kind === "allocation_cap_reached") child.stdin.write(JSON.stringify({kind:"exit",challenge:records.find((r)=>r.kind==="ready").challenge})+"\n");
    }
  });
  let timer; const exit = new Promise((resolve,reject) => { child.once("error",reject); child.once("exit",(code,signal)=>resolve({code,signal})); timer=setTimeout(()=>{child.kill("SIGKILL");reject(new Error("bounded worker test timeout"));},10000); });
  try {
    const ended = await exit; assert.deepEqual(ended,{code:mode==="full"?23:2,signal:null}); assert.equal(stderr,"");
    const metrics=JSON.parse(fs.readFileSync(metricsFile,"utf8")); assert.equal(metrics.calls,20);assert.equal(metrics.bytes,160*1024*1024);
    assert.equal(records.filter((r)=>r.kind==="allocation_start").length,1,"duplicate pressure never allocates again");
    if(mode==="full"){assert.equal(metrics.full,20);assert.equal(metrics.closed,true);assert.equal(records.filter((r)=>r.kind==="allocation").length,20);}
    else {assert.equal(records.some((r)=>r.kind==="allocation_failed"),true);assert.equal(records.some((r)=>r.kind==="allocation_cap_reached"),false);}
    console.log("resource-staging-worker: actual bounded kernel reads "+mode+" passed");
  } finally { clearTimeout(timer); if(child.exitCode===null)child.kill("SIGKILL");await exit.catch(()=>{});fs.rmSync(root,{recursive:true}); }
}
(async()=>{for(const mode of ["full","short","error"])await scenario(mode);})().catch((e)=>{console.error(e);process.exitCode=1;});
