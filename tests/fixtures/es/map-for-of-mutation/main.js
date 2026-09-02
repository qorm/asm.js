// Map for-of uses a live insertion-order view: deleted unvisited nodes are
// skipped, while a delete+set appends a fresh node that remains observable.
var contract = new Map();
contract.set(0, "a");
contract.set(1, "b");
var contractKeys = "";
for (var entry of contract) {
  contractKeys += entry[0];
  contract.delete(1);
}

var expand = new Map();
expand.set(0, "a");
expand.set(1, "b");
var expandedKeys = "";
var first = true;
for (var pair of expand) {
  expandedKeys += pair[0];
  if (first) {
    first = false;
    expand.delete(1);
    expand.set(1, "b");
  }
}

console.log(contractKeys, expandedKeys);
