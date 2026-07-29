import { appendFileSync } from "node:fs";
import { spawn } from "node:child_process";

const tracePath = process.argv[2];
const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
  stdio: "ignore",
});

appendFileSync(tracePath, `${process.pid},${child.pid}\n`, "utf8");
setInterval(() => {}, 1000);
