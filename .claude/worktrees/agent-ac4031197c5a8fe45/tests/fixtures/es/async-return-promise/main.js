async function f() {
    return await Promise.resolve(9);
}

const result = f();
console.log(typeof result);
result.then(function(v) {
    console.log(v);
});
