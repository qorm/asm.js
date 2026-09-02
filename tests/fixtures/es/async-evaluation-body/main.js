var called;
async function foo() {
    called = true;
    await new Promise(function () {});
}
foo();
console.log(called === true ? "called" : "not-called");
