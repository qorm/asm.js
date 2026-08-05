function* g() {
    yield 1;
    yield 2;
    yield 3;
    yield 4;
}
const [a, ...rest] = g();
console.log(a);
console.log(rest.join(","));
