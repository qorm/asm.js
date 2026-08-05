const primary = (resolve) => {
    resolve(41);
};

const pickExecutor = (executor) => executor;
const factory = pickExecutor;

const promise = new Promise(factory(primary));

promise.then((value) => {
    console.log(value);
});
