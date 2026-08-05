async function f() {
    try {
        await Promise.reject("bad");
    } catch (e) {
        console.log("caught", e);
    } finally {
        console.log("finally");
    }

    console.log("end");
}

f();
