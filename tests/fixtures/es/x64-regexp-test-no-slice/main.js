var a = [];
for (var i = 0; i < 4000; i++) a.push(0x4E00 + i);
var s = String.fromCodePoint.apply(null, a);
print(String(/^\P{Script=Latin}+$/u.test(s)));
print(String(/^\P{Script=Latn}+$/u.test(s)));
print(String(/^\P{sc=Latin}+$/u.test(s)));
print(String(/^\P{sc=Latn}+$/u.test(s)));
print(String(/^\p{Script=Latin}+$/u.test(s)));
