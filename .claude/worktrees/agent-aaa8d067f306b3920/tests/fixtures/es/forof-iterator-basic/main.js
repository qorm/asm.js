// Custom iterator using Symbol.iterator
let i = 0;
const iterator = {
    next() {
        if (i < 3) {
            return { value: i++, done: false };
        }
        return { value: undefined, done: true };
    }
};

const obj = {};
obj[Symbol.iterator] = function() { return iterator; };

for (const v of obj) {
    console.log(v);
}
