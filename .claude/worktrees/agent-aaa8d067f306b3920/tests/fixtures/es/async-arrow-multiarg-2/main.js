async function main() {
    const add = async (x, y) => x + y;
    console.log(await add(2, 3));
}

main();
