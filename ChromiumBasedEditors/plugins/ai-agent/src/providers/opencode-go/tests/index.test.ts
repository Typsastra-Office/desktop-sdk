import { beforeEach, describe, expect, it, vi } from "vitest";
import { OpenCodeGoProvider } from "../index";
import { opencodeGoInfo } from "../info";

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

describe("OpenCodeGoProvider", () => {
  it("returns the display name", () => {
    expect(new OpenCodeGoProvider().getName()).toBe(opencodeGoInfo.name);
  });

  it("uses the Go base url", () => {
    expect(new OpenCodeGoProvider().getBaseUrl()).toBe(
      "https://opencode.ai/zen/go/v1"
    );
  });

  it("maps fetched models with the opencode-go provider type", async () => {
    mockList.mockResolvedValue({ data: [{ id: "kimi-k3" }, { id: "gpt-5" }] });

    const models = await new OpenCodeGoProvider().getProviderModels({
      apiKey: "key",
      url: "",
    });

    expect(models).toHaveLength(1);
    expect(models[0]).toMatchObject({ id: "kimi-k3", provider: "opencode-go" });
  });

  it("falls back to the curated model list when /models fails", async () => {
    mockList.mockRejectedValue(new Error("not supported"));

    const models = await new OpenCodeGoProvider().getProviderModels({
      apiKey: "key",
      url: "",
    });

    expect(models.length).toBeGreaterThan(0);
    expect(models[0].provider).toBe("opencode-go");
    expect(models.map((m) => m.id)).toContain("glm-5.3");
  });
});
