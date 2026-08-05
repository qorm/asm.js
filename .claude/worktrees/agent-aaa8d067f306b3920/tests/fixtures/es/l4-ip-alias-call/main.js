// L4 反例:循环中 f(s) 参数逃逸 → 门控否决
let seen = -1;
function f(x) { seen = x.length; }
let s = "";
for (let i = 0; i < 80; i++) {
    if (i === 40) f(s);
    s += "y";
}
console.log(seen, s.length);
