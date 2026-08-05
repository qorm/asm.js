// RegExp shim 引擎子集验收(批次D):字符类/量词/分组/交替/锚点/flags/exec/match/replace
// 本文件同时能在 node 下运行,输出须与 node 逐字节一致。

// --- test: 字面/锚点 ---
console.log("t1", /abc/.test("xxabcyy"));
console.log("t2", /abc/.test("xxaby"));
console.log("t3", /^ab/.test("abc"));
console.log("t4", /^ab/.test("xab"));
console.log("t5", /c$/.test("abc"));
console.log("t6", /^abc$/.test("abc"));

// --- 字符类 ---
console.log("c1", /[a-z]+/.test("XYZ"));
console.log("c2", /[^a-z]/.test("abc1"));
console.log("c3", /[a-cx-z]/.test("y"));
console.log("c4", /[.]/.test("a.b"), /[.]/.test("ab"));
console.log("c5", /\d+/.test("abc123"), /\d/.test("abc"));
console.log("c6", /\w+/.test("__x"), /\W/.test("abc"));
console.log("c7", /\s/.test("a b"), /\S/.test("   "));
console.log("c8", /\bfoo\b/.test("a foo b"), /\bfoo\b/.test("afoob"));

// --- 量词 ---
const m1 = /a+/.exec("baaab");
console.log("q1", m1[0], m1.index);
const m2 = /a{2,3}/.exec("aaaaa");
console.log("q2", m2[0]);
const m3 = /<.+?>/.exec("<a><b>");
console.log("q3", m3[0]);
const m4 = /<.+>/.exec("<a><b>");
console.log("q4", m4[0]);
const m5 = /a?b/.exec("b");
console.log("q5", m5[0], m5.index);
console.log("q6", /a{2}/.test("a"), /a{2}/.test("aa"));

// --- 分组/交替 ---
const g1 = /(a+)(b+)/.exec("xaabbby");
console.log("g1", g1[0], g1[1], g1[2], g1.index);
const g2 = /(?:ab)+/.exec("ababab");
console.log("g2", g2[0], g2.length);
const g3 = /(a)(b)?/.exec("ac");
console.log("g3", g3[0], g3[1], g3[2] === undefined);
const g4 = /(ab|a)(c)/.exec("abc");
console.log("g4", g4[0], g4[1], g4[2]);
console.log("g5", /cat|dog/.test("hotdog"));
const g6 = /^(\d{4})-(\d{2})-(\d{2})$/.exec("2026-07-10");
console.log("g6", g6[1], g6[2], g6[3]);
const g7 = /(a+)ab/.exec("aaab");
console.log("g7", g7[0], g7[1]);

// --- flags: i / m / g ---
console.log("f1", /HELLO/i.test("hello world"));
const f2 = /[a-z]+/i.exec("ABCdef");
console.log("f2", f2[0]);
const f3 = /^b/m.exec("a\nb");
console.log("f3", f3 !== null, f3 === null ? "-" : f3.index);
console.log("f4", /a$/m.test("xa\nb"));

// --- exec g / lastIndex ---
const gre = /\d+/g;
const input = "a1 b22 c333";
let step = gre.exec(input);
console.log("x1", step[0], step.index, gre.lastIndex);
step = gre.exec(input);
console.log("x2", step[0], step.index, gre.lastIndex);
step = gre.exec(input);
console.log("x3", step[0], step.index, gre.lastIndex);
step = gre.exec(input);
console.log("x4", step === null, gre.lastIndex);

// --- match ---
const mm1 = "a1 b22 c333".match(/\d+/g);
console.log("m1", mm1.join(","), mm1.length);
const mm2 = "a1 b22".match(/(\d+)/);
console.log("m2", mm2[0], mm2[1], mm2.index);
console.log("m3", "abc".match(/z+/g) === null);

// --- replace ---
console.log("r1", "hello world world".replace(/world/, "there"));
console.log("r2", "foo boo".replace(/o/g, "0"));
console.log("r3", "john smith".replace(/(\w+) (\w+)/, "$2 $1"));
console.log("r4", "a1 b22".replace(/(\d+)/g, "[$1]"));
console.log("r5", "banana".replace(/a/g, "$&$&"));
console.log("r6", "abc".replace(/x/, "y"));
console.log("r7", "price: 30".replace(/(\d+)/, "$$$1"));

// --- new RegExp / 动态构造 ---
const dyn = new RegExp("b+", "gi");
console.log("d1", "aBbb cB".match(dyn).join(","));
console.log("d2", dyn.source, dyn.flags, dyn.global);
const dyn2 = new RegExp("x");
console.log("d3", dyn2.test("axb"), dyn2.test("ab"));

// --- 转义 ---
console.log("e1", /a\.b/.test("a.b"), /a\.b/.test("axb"));
console.log("e2", /\x41/.test("A"), /B/.test("B"));
console.log("e3", /a\/b/.test("a/b"));
console.log("e4", /\n/.test("a\nb"));
