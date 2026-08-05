async function main() {
    const f = async function (a, b, c) { return a + b + c; };
    console.log(await f(1, 2, 3));
}

main();
