import { schedule } from "./schedule.js";

console.log("sync");

schedule(() => {
    console.log("tick");
});
