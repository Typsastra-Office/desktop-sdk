import { beforeEach, describe, expect, it, vi } from "vitest";
import { OpenCodeProvider } from "../index";
import { opencodeInfo } from "../info";

const mockList = vi.fn();

vi.mock("openai", () => ({
  default: class MockOpenAI {
    chat = { completions: { create: vi.fn() } };
    models = { list: mockList };
  },
}));

beforeEach(() => {
  mockList.mockReset();
  mockList.mockResolvedValue({ data: [] });
});

describe("OpenCodeProvider (Zen)", () => {
  it("returns the display name", () => {
    expect(new OpenCodeProvider().getName()).toBe(opencodeInfo.name);
  });

  it("uses the Zen base url", () => {
    expect(new OpenCodeProvider().getBaseUrl()).toBe(
      "https://opencode.ai/zen/v1"
    );
  });

  it("maps fetched models with the opencode provider type", async () => {
    mockList.mockResolvedValue({ data: [{ id: "glm-5.2" }, { id: "gpt-5" }] });

    const models = await new OpenCodeProvider().getProviderModels({
      apiKey: "key",
      url: "",
    });

    expect(models).toHaveLength(1);
    expect(models[0]).toMatchObject({ id: "glm-5.2", provider: "opencode" });
  });

  it("falls back to the curated model list when /models fails", async () => {
    mockList.mockRejectedValue(new Error("not supported"));

    const models = await new OpenCodeProvider().getProviderModels({
      apiKey: "key",
      url: "",
    });

    expect(models.length).toBeGreaterThan(0);
    expect(models[0].provider).toBe("opencode");
    expect(models.map((m) => m.id)).toContain("deepseek-v4-pro");
  });
});
