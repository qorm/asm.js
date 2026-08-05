import { execSync } from "child_process";
import fs from "fs";
const man = JSON.parse(fs.readFileSync("es_tests/manifest.json"));
const res = {};
let np=0,nf=0,nt=0,no=0;
for (const t of man){
  let out="";
  try { out = execSync(`node es_tests/${t.id}.js`, {timeout:5000, stdio:["ignore","pipe","ignore"]}).toString(); }
  catch(e){ out = (e.stdout?e.stdout.toString():"") ; }
  const m = out.match(/RESULT:(\w+)/);
  const v = m ? m[1] : "NOOUT";
  res[t.id] = v;
  if(v==="PASS")np++; else if(v==="FAIL")nf++; else if(v==="THROW")nt++; else no++;
}
fs.writeFileSync("es_tests/node_result.json", JSON.stringify(res));
console.log("node 基线: PASS",np,"FAIL",nf,"THROW",nt,"OTHER/NOOUT",no,"总",man.length);
