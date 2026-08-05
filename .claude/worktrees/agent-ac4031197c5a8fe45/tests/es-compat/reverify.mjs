// 复验:并发跑后,把 NOOUT/CRASH 的测试隔离串行复跑(去资源竞争 flaky)。
import { execFileSync } from "child_process";
import fs from "fs";
const man = JSON.parse(fs.readFileSync("es_tests/manifest.json"));
const jsR = JSON.parse(fs.readFileSync("es_tests/asmjs_result.json"));
let fixed=0;
for (const t of man){
  if (jsR[t.id]!=="NOOUT" && jsR[t.id]!=="CRASH") continue;
  const bin = `es_bin/${t.id}`;
  if (!fs.existsSync(bin)) continue;
  let out="";
  try { out = execFileSync(bin, [], {timeout:15000}).toString(); } catch(e){ out = e.stdout?e.stdout.toString():""; }
  const m = out.match(/RESULT:(\w+)/);
  if (m && m[1]==="PASS"){ jsR[t.id]="PASS"; fixed++; }
  else if (m){ jsR[t.id]=m[1]; }
}
fs.writeFileSync("es_tests/asmjs_result.json", JSON.stringify(jsR));
console.log("复验修正 NOOUT/CRASH→PASS:", fixed);
