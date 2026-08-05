function executor(resolve) {
    resolve(11);
}

const promise = new Promise(executor);

promise.then((value) => {
    console.log(value);
});
