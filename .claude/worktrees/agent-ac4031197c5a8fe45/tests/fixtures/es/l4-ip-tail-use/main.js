// L4 正向:活跃区之后的使用(return/拼接)不否决,且 IP 生效
function build(n) {
    let s = "<";
    for (let i = 0; i < n; i++) s += i + ",";
    return s + ">";
}
console.log(build(5));
let acc = "";
for (let i = 0; i < 20; i++) acc = acc + "#";
console.log(acc.length, typeof acc);
