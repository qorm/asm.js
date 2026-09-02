var saw = 0;
{
    async function f() {
        return 7;
    }
    f().then(function (v) { saw = v; });
}
console.log(typeof (function () {
    async function g() { return 1; }
    return g();
}()).then);
