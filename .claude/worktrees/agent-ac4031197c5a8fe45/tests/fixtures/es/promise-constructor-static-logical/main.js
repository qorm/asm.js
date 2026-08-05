const usePrimary = false;
const primary = (resolve) => {
    resolve(1);
};
const fallback = (resolve) => {
    resolve(29);
};

const executor = (usePrimary && primary) || fallback;
const promise = new Promise(executor);

promise.then((value) => {
    console.log(value);
});
