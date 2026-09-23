import { describe, expect, it } from "vitest";
import { computeFindings, type DocModel } from "../agentFindings";

type Fixture = { name: string; model: DocModel; expect: string[] };

const modules = import.meta.glob("./corpus/*.json", { eager: true }) as Record<
  string,
  { default: Fixture }
>;

describe("findings corpus", () => {
  const entries = Object.entries(modules);

  it("loads fixtures", () => {
    expect(entries.length).toBeGreaterThan(0);
  });

  for (const [path, mod] of entries) {
    const fx = mod.default;
    it(`${fx.name} (${path})`, () => {
      const codes = computeFindings(fx.model).map((f) => f.code);
      for (const expected of fx.expect) {
        expect(codes, `${path} should contain ${expected}`).toContain(expected);
      }
      // Deterministic: same input yields the same output.
      expect(computeFindings(fx.model).map((f) => f.code)).toEqual(codes);
    });
  }
});
