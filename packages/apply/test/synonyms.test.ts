import { describe, expect, it } from "vitest";
import { canonicalKeyForLabel } from "../src/profile.js";

describe("I14 synonym matching strictness", () => {
  it("does not map 'Company Name' to full_name", () => {
    expect(canonicalKeyForLabel("Company Name")).not.toBe("full_name");
    expect(canonicalKeyForLabel("Previous employer name")).not.toBe("full_name");
  });
  it("still maps exact generic labels", () => {
    expect(canonicalKeyForLabel("Name")).toBe("full_name");
    expect(canonicalKeyForLabel("Email")).toBe("email");
    expect(canonicalKeyForLabel("Phone")).toBe("phone");
    expect(canonicalKeyForLabel("Full Name")).toBe("full_name");
  });
});
