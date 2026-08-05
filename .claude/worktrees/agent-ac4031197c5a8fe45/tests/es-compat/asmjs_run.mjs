import { spawn } from "child_process";
import fs from "fs";
const man = JSON.parse(fs.readFileSync("es_tests/manifest.json"));
const ASMJS = "/Users/dmy/work/jsbin/cli.js";
const CONC = 6;
const res = {};
let done = 0;
function runOne(t){
  return new Promise((resolve)=>{
    const bin = `es_bin/${t.id}`;
    // 编译(30s 超时)
    const c = spawn("node", [ASMJS, `es_tests/${t.id}.js`, "-o", bin], {stdio:["ignore","ignore","pipe"]});
    let cerr="";
    c.stderr.on("data",d=>cerr+=d);
    const ckill = setTimeout(()=>c.kill("SIGKILL"), 30000);
    c.on("close",(code)=>{
      clearTimeout(ckill);
      if (code !== 0 || !fs.existsSync(bin)){ res[t.id]="COMPILE_FAIL"; finish(); return; }
      // 运行(10s 超时)
      const r = spawn(bin, [], {stdio:["ignore","pipe","ignore"]});
      let out="";
      r.stdout.on("data",d=>out+=d);
      const rkill = setTimeout(()=>r.kill("SIGKILL"), 10000);
      r.on("close",(rc)=>{
        clearTimeout(rkill);
        const m = out.match(/RESULT:(\w+)/);
        if (m) res[t.id]=m[1];
        else if (rc && rc!==0) res[t.id]="CRASH";
        else res[t.id]="NOOUT";
        finish();
      });
      r.on("error",()=>{ clearTimeout(rkill); res[t.id]="CRASH"; finish(); });
    });
    c.on("error",()=>{ clearTimeout(ckill); res[t.id]="COMPILE_FAIL"; finish(); });
    function finish(){ done++; if(done%100===0){ console.log(`  ...${done}/${man.length}`); fs.writeFileSync("es_tests/asmjs_result.json", JSON.stringify(res)); } resolve(); }
  });
}
let i=0;
async function worker(){ while(i<man.length){ const t=man[i++]; await runOne(t); } }
await Promise.all(Array.from({length:CONC}, worker));
fs.writeFileSync("es_tests/asmjs_result.json", JSON.stringify(res));
console.log("asm.js 差分完成:", Object.keys(res).length);
