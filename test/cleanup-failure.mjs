import { appendFileSync } from "node:fs";
import { Interface } from "node:readline";

import Database from "better-sqlite3";

const markerPath = process.env.COFFEE_TEST_CLEANUP_MARKER;
if (!markerPath) {
  throw new Error("缺少 COFFEE_TEST_CLEANUP_MARKER");
}

const originalDatabaseClose = Database.prototype.close;
Database.prototype.close = function (...args) {
  appendFileSync(markerPath, "database\n", "utf8");
  return originalDatabaseClose.apply(this, args);
};

const originalInputClose = Interface.prototype.close;
Interface.prototype.close = function (...args) {
  originalInputClose.apply(this, args);
  appendFileSync(markerPath, "input\n", "utf8");
  throw new Error("injected input cleanup failure");
};

globalThis.fetch = async () => {
  throw new Error("意外的网络请求");
};
