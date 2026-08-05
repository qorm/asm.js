function makeExecutor() {
    return (resolve) => {
        resolve(31);
    };
}

const promise = new Promise(makeExecutor());

promise.then((value) => {
    console.log(value);
});
