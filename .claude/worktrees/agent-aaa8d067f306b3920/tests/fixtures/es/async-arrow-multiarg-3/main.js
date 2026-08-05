async function main() {
    const f = async (x, y, z) => x * y + z;
    console.log(await f(2, 3, 4));
}

main();
