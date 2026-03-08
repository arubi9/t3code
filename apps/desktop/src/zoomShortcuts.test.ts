import { describe, expect, it } from "vitest";

import { isWindowsZoomInShortcut } from "./zoomShortcuts";

describe("isWindowsZoomInShortcut", () => {
  it("matches Ctrl++ from the main keyboard on Windows", () => {
    expect(
      isWindowsZoomInShortcut(
        {
          type: "keyDown",
          control: true,
          shift: true,
          key: "+",
          code: "Equal",
        },
        "win32",
      ),
    ).toBe(true);
    expect(
      isWindowsZoomInShortcut(
        {
          type: "keyDown",
          control: true,
          shift: true,
          key: "=",
          code: "Equal",
        },
        "win32",
      ),
    ).toBe(true);
  });

  it("matches Ctrl+numpad plus on Windows", () => {
    expect(
      isWindowsZoomInShortcut(
        {
          type: "keyDown",
          control: true,
          key: "+",
          code: "NumpadAdd",
        },
        "win32",
      ),
    ).toBe(true);
  });

  it("does not match unrelated shortcuts or other platforms", () => {
    expect(
      isWindowsZoomInShortcut(
        {
          type: "keyDown",
          control: true,
          key: "-",
          code: "Minus",
        },
        "win32",
      ),
    ).toBe(false);
    expect(
      isWindowsZoomInShortcut(
        {
          type: "keyDown",
          control: true,
          shift: true,
          key: "+",
          code: "Equal",
        },
        "linux",
      ),
    ).toBe(false);
  });
});
