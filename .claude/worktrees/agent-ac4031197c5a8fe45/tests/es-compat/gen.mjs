import { createRequire } from "module";
import fs from "fs";
const require = createRequire(import.meta.url);
const suites = [["ES6","./compat-es6.js"],["ES2016+","./compat-es2016.js"]];
const OUT = "es_tests";
let idx = 0;
const manifest = [];
function bodyOf(fn){
  const s = fn.toString();
  const m = s.match(/\/\*([\s\S]*?)\*\//);
  if (m) return m[1];
  // 无注释体:取函数体
  const b = s.match(/\{([\s\S]*)\}/);
  return b ? b[1] : "";
}
for (const [suite, path] of suites){
  const data = require(path);
  for (const t of data.tests){
    const leaves = Array.isArray(t.subtests) ? t.subtests.map(st=>({name:t.name+" / "+st.name, exec:st.exec})) : [{name:t.name, exec:t.exec}];
    for (const lf of leaves){
      if (typeof lf.exec !== "function"){ continue; }
      const body = bodyOf(lf.exec).trim();
      if (!body){ continue; }
      const id = "t"+(idx++);
      // 包成:__test 返回 boolean;RESULT 标记。用 var 避免 let/const TDZ 干扰对比。
      const prog =
`function __test(){\n${body}\n}\nvar __r;\ntry { __r = __test(); } catch(e){ console.log("RESULT:THROW"); __r = "__caught"; }\nif (__r !== "__caught") { console.log("RESULT:" + (__r === true ? "PASS" : (__r === false ? "FAIL" : "OTHER"))); }\n`;
      fs.writeFileSync(`${OUT}/${id}.js`, prog);
      manifest.push({id, suite, name:lf.name});
    }
  }
}
fs.writeFileSync(`${OUT}/manifest.json`, JSON.stringify(manifest));
console.log("生成测试:", manifest.length, "个 →", OUT+"/");
