import { existsSync } from "node:fs";

const [target, stop] = process.argv.slice(2);
let missing = 0,
  observations = 0;
console.log("observer ready");
while (!existsSync(stop)) {
  for (let i = 0; i < 1000; i++) {
    observations++;
    if (!existsSync(target)) missing++;
  }
}
console.log(JSON.stringify({ missing, observations }));
