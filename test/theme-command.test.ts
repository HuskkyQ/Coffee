import assert from "node:assert/strict";
import test from "node:test";

import { getThemeSelectionModel } from "../src/theme-command.js";

test("builds registered themes in stable order with the current index", () => {
  const model = getThemeSelectionModel("coast", "truecolor");

  assert.equal(model.initialIndex, 1);
  assert.deepEqual(
    model.items.map(({ label, value, status }) => ({ label, value, status })),
    [
      { label: "奶油拿铁", value: "latte", status: undefined },
      { label: "周末海岸", value: "coast", status: "当前" },
      { label: "暮色露营", value: "camp", status: undefined },
    ],
  );
  for (const item of model.items) {
    assert.match(item.preview ?? "", /●/u);
    assert.match(item.preview ?? "", /\u001b\[/u);
  }
});

test("keeps a readable three-dot preview without color", () => {
  const model = getThemeSelectionModel("latte", "none");

  assert.equal(model.initialIndex, 0);
  assert.deepEqual(
    model.items.map((item) => item.preview),
    ["● ● ●", "● ● ●", "● ● ●"],
  );
});
