async function main() {
    const v = await Promise.resolve(7);
    console.log(v);
}

main();
