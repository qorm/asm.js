// L4 反例:循环中 t = s 别名化 → 门控否决,t 冻结在别名时刻的值
// (若原地拼接泄漏:t.length 会变成 100 而非 50)
let s = "";
let t;
for (let i = 0; i < 100; i++) {
    if (i === 50) t = s;
    s = s + "x";
}
console.log(t.length, s.length);
