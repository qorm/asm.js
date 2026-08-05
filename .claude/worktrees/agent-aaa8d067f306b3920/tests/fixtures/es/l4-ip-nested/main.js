// L4 边界:内外层同名变量互不干扰(各自函数级扫描)
let s = "outer";
function inner() {
    let s = "";
    for (let i = 0; i < 5; i++) s += "*";
    return s;
}
console.log(inner(), s);
