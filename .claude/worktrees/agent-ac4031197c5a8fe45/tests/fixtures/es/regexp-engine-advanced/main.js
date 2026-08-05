// RegExp shim 高级特性验收:lookahead/lookbehind、反向引用、命名组、dotAll(s)、
// sticky(y)、matchAll、replace 函数参。本文件同时能在 node 下运行,输出须逐字节一致。

// --- lookahead (?= (?!) ---
console.log("la1", /foo(?=bar)/.test("foobar"));
console.log("la2", /foo(?=bar)/.test("foobaz"));
console.log("la3", /foo(?!bar)/.test("foobaz"));
console.log("la4", /\d+(?=px)/.exec("10px 20em")[0]);
console.log("la5", /^(?=.*\d)(?=.*[a-z]).+$/.test("abc1"), /^(?=.*\d)(?=.*[a-z]).+$/.test("abcd"));
console.log("la6", "a1b2".replace(/(?=\d)/g, "-"));

// --- 反向引用 \1..\9 ---
console.log("br1", /(a)\1/.test("aa"), /(a)\1/.test("ab"));
console.log("br2", /(\w)\1/.exec("hello")[0]);
console.log("br3", "aabbcc".replace(/(\w)\1/g, "[$1]"));
console.log("br4", /\b(\w+)\s+\1\b/.test("the the"), /\b(\w+)\s+\1\b/.test("the cat"));
console.log("br5", /(ab)(cd)\2\1/.exec("abcdcdab")[0]);

// --- 命名组 (?<name>) + \k<name> + .groups ---
var ng = /(?<y>\d{4})-(?<mo>\d{2})/.exec("2026-07");
console.log("ng1", ng.groups.y, ng.groups.mo);
console.log("ng2", ng[1], ng[2]);
console.log("ng3", "john smith".replace(/(?<f>\w+) (?<l>\w+)/, "$<l> $<f>"));
console.log("ng4", /(?<q>['"]).*?\k<q>/.test("say 'hi'"));
console.log("ng5", /(?<d>\d)\k<d>/.test("55"), /(?<d>\d)\k<d>/.test("56"));

// --- dotAll s ---
console.log("ds1", /./s.test("\n"), /./.test("\n"));
console.log("ds2", /a.b/s.exec("a\nb")[0].length);
console.log("ds3", "a\nb".replace(/./gs, "X"));
console.log("ds4", /foo.bar/s.test("foo\nbar"));

// --- lookbehind (?<= (?<!) ---
console.log("lb1", /(?<=\$)\d+/.exec("$100")[0]);
console.log("lb2", /(?<!foo)bar/.test("foobar"), /(?<!foo)bar/.test("xxxbar"));
console.log("lb3", "1234567".replace(/(?<=\d)(?=(\d{3})+$)/g, ","));
console.log("lb4", /(?<=foo)bar/.test("foobar"), /(?<=x)y/.test("zy"));

// --- sticky y ---
var sy = /\d+/y;
sy.lastIndex = 0;
var s1 = sy.exec("12 34");
console.log("sy1", s1[0], sy.lastIndex);
var s2 = sy.exec("12 34");
console.log("sy2", s2 === null, sy.lastIndex);
console.log("sy3", /b/y.test("ab"), /a/y.test("ab"));

// --- matchAll(for-of,node 返回迭代器/asm.js 返回数组,均可 for-of) ---
var acc = "";
for (var mm of "a1 b2 c3".matchAll(/(\w)(\d)/g)) {
    acc = acc + mm[0] + ":" + mm[1] + mm[2] + " ";
}
console.log("ma1", acc);
var cnt = 0;
for (var m2 of "x y z".matchAll(/\w/g)) {
    cnt = cnt + 1;
}
console.log("ma2", cnt);
var gacc = "";
for (var m3 of "2026-07 2027-08".matchAll(/(?<y>\d{4})-(?<mo>\d{2})/g)) {
    gacc = gacc + m3.groups.y + "/" + m3.groups.mo + " ";
}
console.log("ma3", gacc);

// --- replace 函数参 fn(match, p1..pn, offset, string) ---
console.log("rf1", "a1b2".replace(/\d/g, function (m) { return "[" + m + "]"; }));
console.log("rf2", "john smith".replace(/(\w+) (\w+)/, function (m, p1, p2) { return p2 + " " + p1; }));
console.log("rf3", "abc".replace(/b/, function (m, off) { return m + "@" + off; }));
console.log("rf4", "hello".replace(/l/g, function () { return "L"; }));
console.log("rf5", "a1 b22".replace(/(\d+)/g, function (m, p1) { return "" + p1.length; }));
console.log("rf6", "aAbB".replace(/[a-z]/g, function (m) { return m.toUpperCase(); }));

// --- 组合/回归 ---
console.log("cx1", "2026-07-11".replace(/(\d{4})-(\d{2})-(\d{2})/, "$3/$2/$1"));
console.log("cx2", /(?<=@)\w+(?=\.)/.exec("a@host.com")[0]);
