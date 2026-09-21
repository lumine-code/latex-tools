const manifest = require("../package.json");

describe("latex-tools bootstrap", () => {
  it("uses passive service exchange and JavaScript registration", () => {
    for (const descriptor of Object.values(manifest.providedServices || {})) {
      expect(descriptor.activation).toBeUndefined();
    }
  });
});
