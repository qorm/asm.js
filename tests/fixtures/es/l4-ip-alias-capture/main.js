// L4 反例:闭包捕获 s(boxed)→ 门控否决;每轮快照长度应为 1..10
// (若原地拼接泄漏:所有快照同指一块,长度全为 10)
let s = "";
let stash = [];
let g = () => stash.push(s);
for (let i = 0; i < 10; i++) { s = s + "a"; g(); }
console.log(stash.map(x => x.length).join(","));
