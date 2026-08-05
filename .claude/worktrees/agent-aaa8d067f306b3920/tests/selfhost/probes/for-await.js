async function main() {
    let s = 0;
    for await (const x of [Promise.resolve(1), Promise.resolve(2), 3]) s += x;
    let t = 0;
    for await (const x of new Set([10, 20, 30])) t += x;
    console.log((s === 6 && t === 60) ? "for-await-ok" : "for-await-FAIL");
}
main();
