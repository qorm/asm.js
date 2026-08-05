import fs from "fs";
const man = JSON.parse(fs.readFileSync("es_tests/manifest.json"));
const nodeR = JSON.parse(fs.readFileSync("es_tests/node_result.json"));
const jsR = JSON.parse(fs.readFileSync("es_tests/asmjs_result.json"));
const byId = Object.fromEntries(man.map(t=>[t.id,t]));
// 只比对 node-PASS(feature 在 node 真实工作)
const applicable = man.filter(t=>nodeR[t.id]==="PASS");
// 特性组 = suite + 顶层名(name 里 " / " 前的部分)
function group(t){ return t.suite + " ▸ " + t.name.split(" / ")[0]; }
const cats = {};
let sup=0, notsup=0, cfail=0, crash=0;
for (const t of applicable){
  const v = jsR[t.id] || "MISSING";
  const g = group(t);
  cats[g] = cats[g] || {sup:0,notsup:0,cfail:0,crash:0,items:[]};
  let bucket;
  if (v==="PASS"){ bucket="sup"; sup++; }
  else if (v==="FAIL"){ bucket="notsup"; notsup++; }
  else if (v==="COMPILE_FAIL"){ bucket="cfail"; cfail++; }
  else { bucket="crash"; crash++; } // CRASH/THROW/NOOUT/MISSING
  cats[g][bucket]++;
  cats[g].items.push({name:t.name, v});
}
const total = applicable.length;
console.log("=== asm.js ES 标准差分测试报告(基于 kangax compat-table)===");
console.log(`可比对(node-PASS)测试: ${total} / 生成 ${man.length}`);
console.log(`  ✅ 支持(asm.js PASS):        ${sup}  (${(sup/total*100).toFixed(1)}%)`);
console.log(`  ❌ 不支持(asm.js FAIL):      ${notsup}  (${(notsup/total*100).toFixed(1)}%)`);
console.log(`  🚫 编译失败(不支持语法):    ${cfail}  (${(cfail/total*100).toFixed(1)}%)`);
console.log(`  💥 崩溃/无输出:             ${crash}  (${(crash/total*100).toFixed(1)}%)`);
console.log("");
// 按支持率排序特性组
const rows = Object.entries(cats).map(([g,c])=>{
  const tot = c.sup+c.notsup+c.cfail+c.crash;
  return {g, ...c, tot, rate: c.sup/tot};
}).sort((a,b)=> b.rate-a.rate || b.tot-a.tot);
console.log("=== 按特性组(支持率降序)===");
for (const r of rows){
  const bar = "█".repeat(Math.round(r.rate*10)).padEnd(10,"░");
  console.log(`${bar} ${(r.rate*100).toFixed(0).padStart(3)}%  ${r.g}  [${r.sup}/${r.tot}]  ${r.notsup?"✗"+r.notsup:""} ${r.cfail?"🚫"+r.cfail:""} ${r.crash?"💥"+r.crash:""}`);
}
fs.writeFileSync("es_tests/report_data.json", JSON.stringify({total,sup,notsup,cfail,crash,cats}));
