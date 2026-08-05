const executor = (resolve) => {
    resolve(13);
};

const promise = new Promise(executor);

promise.then((value) => {
    console.log(value);
});
