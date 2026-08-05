function* g() {
    yield 1;
    yield 2;
}
const [a, b] = g();
console.log(a);
console.log(b);
