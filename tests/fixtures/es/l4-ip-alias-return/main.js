// L4 反例:循环中 r = s(函数内)→ 门控否决,应为 20/40
function h() {
    let s = "";
    let r;
    for (let i = 0; i < 40; i++) {
        if (i === 20) r = s;
        s = s + "q";
    }
    return r.length + "/" + s.length;
}
console.log(h());
