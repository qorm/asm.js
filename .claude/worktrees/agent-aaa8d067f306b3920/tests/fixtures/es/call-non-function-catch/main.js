try {
    const f = 0;
    f();
    console.log("bad");
} catch (e) {
    console.log("caught-call");
}

try {
    const obj = {};
    obj.missing();
    console.log("bad-member");
} catch (e) {
    console.log("caught-member");
}
