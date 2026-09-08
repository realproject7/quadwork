"use strict";
// Actual worker, reserved buffers and kernel reads. Test-only OS/descendant
// dependencies isolate the protocol; these scenarios cannot grant staging PASS.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const worker = require.resolve("./resource-staging-worker");
async function scenario(mode) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "qw-arm-unit-")), metricsFile = path.join(root, "metrics.json"), preload = path.join(root, "fixture.cjs");
  fs.writeFileSync(preload, `const Module=require("node:module"), fs=require("node:fs"), original=Module._load;
const metrics={reservations:0,opens:0,calls:0,bytes:0,full:0,closed:false,verifications:0}; let zero;
const save=()=>fs.writeFileSync(${JSON.stringify(metricsFile)},JSON.stringify(metrics)); save();
const allocate=Buffer.allocUnsafe; Buffer.allocUnsafe=function(size){const buffer=allocate(size);if(size===8388608){metrics.reservations++;save();}return buffer;};
const wrapper={...fs,openSync(file,...args){const fd=fs.openSync(file,...args);if(file==="/dev/zero"){zero=fd;metrics.opens++;save();}return fd;},closeSync(fd){if(fd===zero){metrics.closed=true;save();}return fs.closeSync(fd);},readdirSync(file,...args){if(file==="/proc/self/task"&&process.platform!=="linux")return Array.from({length:23},(_,i)=>String(process.pid+i));return fs.readdirSync(file,...args);},read(fd,buffer,offset,length,position,callback){metrics.calls++;metrics.bytes+=length;save();const call=metrics.calls;return fs.read(fd,buffer,offset,length,position,(error,bytes,b)=>{if(!error&&bytes===length&&buffer[0]===0&&buffer[length-1]===0)metrics.full++;if(call===1&&${JSON.stringify(mode)}==="short")bytes--;if(call===1&&${JSON.stringify(mode)}==="error")error=new Error("controlled read failure");save();callback(error,bytes,b);});}};
Module._load=function(request,parent,main){if(parent?.filename===${JSON.stringify(worker)}){if(request==="fs")return wrapper;if(request==="./resource-linux-facts")return {readProcess:()=>({cgroup:"/unit-fixture"}),verifyWorkerGroup(){metrics.verifications++;save();if((${JSON.stringify(mode)}==="arm-limit"&&metrics.verifications===1)||(${JSON.stringify(mode)}==="release-limit"&&metrics.verifications===2))throw new Error("actual cap unavailable fixture");}};if(request==="child_process")return {spawn(){return {pid:42,on(){},kill(){}};}};}return original.call(this,request,parent,main);};
process.on("exit",save);
`);
  const child = spawn(process.execPath, ["--require", preload, worker], { env: { ...process.env, TMPDIR: root }, stdio: ["pipe", "pipe", "pipe"] });
  const records = []; let pending = "", stderr = "", challenge = null, failure = null;
  const metrics = () => JSON.parse(fs.readFileSync(metricsFile, "utf8"));
  const send = (kind, fields = {}) => child.stdin.write(JSON.stringify({ kind, challenge, ...fields }) + "\n");
  child.stdin.on("error", () => {}); child.stderr.on("data", (b) => { stderr += b; });
  child.stdout.on("data", (b) => {
    try {
      pending += b.toString();
      while (pending.includes("\n")) {
        const end = pending.indexOf("\n"), line = pending.slice(0, end); pending = pending.slice(end + 1);
        if (!line.startsWith("QW_RESOURCE:")) continue;
        const row = JSON.parse(line.slice(12)); records.push(row);
        if (row.kind === "ready" && challenge === null) {
          challenge = row.challenge;
          send("pressure"); // The old single-command path no longer allocates.
          send("pressure_release"); send("pressure_arm", { challenge: "wrong" });
          send("ping", { nonce: "before-arm" });
        }
        if (row.kind === "pong" && row.nonce === "before-arm") {
          assert.equal(metrics().reservations, 0); assert.equal(metrics().opens, 0); assert.equal(metrics().calls, 0);
          send("pressure_arm"); send("pressure_arm");
        }
        if (row.kind === "allocation_armed") {
          assert.equal(row.buffers, 20); assert.equal(row.buffer_bytes, 8388608); assert.equal(row.bytes, 167772160);
          send("pressure_arm"); send("pressure_release", { challenge: "wrong" });
          send("ping", { nonce: "waiting-for-release" });
        }
        if (row.kind === "pong" && row.nonce === "waiting-for-release") {
          assert.equal(metrics().reservations, 20, "duplicates do not reserve again");
          assert.equal(metrics().opens, 0, "no pressure descriptor before release");
          assert.equal(metrics().calls, 0, "no actual kernel read before correct release");
          if (mode === "missing-release") send("exit");
          else { send("pressure_release"); send("pressure_release"); send("pressure_arm"); }
        }
        if (row.kind === "allocation_cap_reached") send("exit");
      }
    } catch (error) { failure = error; child.kill("SIGKILL"); }
  });
  const exit = new Promise((resolve, reject) => { child.once("error", reject); child.once("exit", (code, signal) => resolve({ code, signal })); });
  const timer = setTimeout(() => { failure = new Error("bounded worker test timeout"); child.kill("SIGKILL"); }, 10000);
  try {
    const ended = await exit; if (failure) throw failure;
    const successfulExit = mode === "full" || mode === "missing-release";
    assert.deepEqual(ended, { code: successfulExit ? 23 : 2, signal: null }); assert.equal(stderr, "");
    const observed = metrics(), released = ["full", "short", "error"].includes(mode);
    assert.equal(observed.reservations, mode === "arm-limit" ? 0 : 20);
    assert.equal(observed.opens, released ? 1 : 0); assert.equal(observed.calls, released ? 20 : 0);
    assert.equal(observed.bytes, released ? 160 * 1024 * 1024 : 0);
    assert.equal(records.filter((r) => r.kind === "allocation_armed").length, mode === "arm-limit" ? 0 : 1);
    if (mode === "full") { assert.equal(observed.full, 20); assert.equal(observed.closed, true); assert.equal(records.filter((r) => r.kind === "allocation").length, 20); }
    else assert.equal(records.some((r) => r.kind === "allocation_cap_reached"), false);
    if (mode === "short" || mode === "error" || mode === "release-limit") assert.equal(records.some((r) => r.kind === "allocation_failed"), true);
    console.log("resource-staging-worker: real arm/release, fixed reservation and kernel reads " + mode + " passed");
  } finally { clearTimeout(timer); if (child.exitCode === null) child.kill("SIGKILL"); await exit.catch(() => {}); fs.rmSync(root, { recursive: true }); }
}
(async () => { for (const mode of ["full", "short", "error", "missing-release", "arm-limit", "release-limit"]) await scenario(mode); })().catch((e) => { console.error(e); process.exitCode = 1; });
