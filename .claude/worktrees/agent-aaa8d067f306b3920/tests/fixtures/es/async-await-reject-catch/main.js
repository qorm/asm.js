async function f() {
    try {
        await Promise.reject("bad");
    } catch (e) {
        console.log(e);
    }
}

f();
