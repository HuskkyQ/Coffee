#!/usr/bin/env node

import path from "node:path";
import { fileURLToPath } from "node:url";
import { tsImport } from "tsx/esm/api";

const appRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const { launchCoffee } = await tsImport(
  path.join(appRoot, "src", "launcher.ts"),
  import.meta.url,
);
await launchCoffee(appRoot);
