import { writeFileSync } from "node:fs";

const outputPath = process.env.COFFEE_TEST_ENVIRONMENT_PATH;
if (!outputPath) {
  throw new Error("缺少 COFFEE_TEST_ENVIRONMENT_PATH");
}

writeFileSync(
  outputPath,
  JSON.stringify({
    HOME: process.env.HOME,
    HOMEDRIVE: process.env.HOMEDRIVE,
    HOMEPATH: process.env.HOMEPATH,
    USERPROFILE: process.env.USERPROFILE,
  }),
  "utf8",
);

globalThis.fetch = async () => {
  throw new Error("意外的网络请求");
};
