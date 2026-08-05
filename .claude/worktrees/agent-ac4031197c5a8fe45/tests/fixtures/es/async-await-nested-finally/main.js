async function f() {
    try {
        try {
            await Promise.reject("bad");
        } finally {
            console.log("inner-finally");
        }
    } catch (e) {
        console.log("caught", e);
    } finally {
        console.log("outer-finally");
    }
}

f();
