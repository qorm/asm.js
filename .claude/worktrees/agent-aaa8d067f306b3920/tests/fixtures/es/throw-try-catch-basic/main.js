try {
    console.log("before");
    throw "x";
} catch (e) {
    console.log("caught", e);
}

console.log("end");
