async function main() {
    const f = async function (a, b) { return a - b; };
    console.log(await f(10, 3));
}

main();
