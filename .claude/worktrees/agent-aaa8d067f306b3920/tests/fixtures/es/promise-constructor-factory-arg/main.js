const primary = (resolve) => {
    resolve(37);
};

function identityExecutor(executor) {
    return executor;
}

const promise = new Promise(identityExecutor(primary));

promise.then((value) => {
    console.log(value);
});
