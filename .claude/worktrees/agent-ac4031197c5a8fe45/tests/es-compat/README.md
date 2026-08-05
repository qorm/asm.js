# ES 标准差分测试(基于 kangax compat-table)

用业界通用的 [kangax/compat-table](https://github.com/kangax/compat-table) ES 兼容性测试集,对 asm.js 编译产物做 **vs node 的差分测试**,得到逐特性支持矩阵。

## 方法

1. 下载 compat-table 数据(`data-es6.js` + `data-es2016plus.js`,依赖 `data-common`——用 Proxy 桩替代其转译器标注)。
2. `gen.mjs`:每个测试的 `exec` 函数体在 compat-table 里放于 `/* ... */` 注释内(返回 boolean,true=特性可用)。抽出包成独立程序 `function __test(){…}` + `RESULT:` 标记。
3. `node_ref.mjs`:node 跑全部,得基线(**只有 node-PASS 的测试才是"特性在 node 真实工作"的可比对项**)。
4. `asmjs_run.mjs`:asm.js 逐个编译(30s 超时)+ 运行(10s 超时),分类 `PASS/FAIL/COMPILE_FAIL/CRASH/NOOUT`。6 路并发。
5. `report.mjs`:合并三方结果,按特性组出支持率矩阵。

## 复现

```sh
cd $(mktemp -d)
for f in data-es6.js data-es2016plus.js; do
  curl -sSo compat-${f#data-} https://raw.githubusercontent.com/kangax/compat-table/gh-pages/$f
done
# data-common 桩(见 README 顶部)
printf 'const h={get:()=>new Proxy(function(){},h)};module.exports=new Proxy(function(){},h);\n' > data-common.js
cp <此目录>/*.mjs .
node gen.mjs && node node_ref.mjs && node asmjs_run.mjs && node report.mjs
```

## 结果解读(重要)

原始"支持率"会**严重低估** asm.js 的功能覆盖,因为 compat-table 是为**完整 JS 引擎**设计的,大量测试用 asm.js 有意不实现或用不同模型实现的探测手法:

- **`typeof X.y === "function"` intrinsic 失配**(~100 项):asm.js 把 `Math.sign`/`Number.isNaN`/`Array.from` 等实现为**调用点 intrinsic**,`Math.sign(-3)` 正常出 `-1`,但 `Math.sign` 作为一等函数值不存在(`typeof` 返 "number")→ 测试判 false。**功能可用,只是非一等值。**
- **设计外**(~235 项):Symbol/well-known symbols、Proxy、Reflect、继承内建(subclass `Array`/`Function`/`RegExp`)——封闭世界 AOT 子集有意不做。
- **描述符**(~25 项):`defineProperty` attrs/`getOwnPropertyDescriptor`/`__proto__` 元操作,部分设计外。
- **真缺口/边界**(~264 项):astral-plane 字符串、稀疏数组、模板串缓存、`Number("0o..")`、默认参 TDZ 等进阶边界——这批才是值得接力的清单。

见 `last_report.txt`(逐组矩阵)、`last_run.json`(富数据:每组 sup/fail/cfail/crash + 失败成因分布)。
