/**
 * Tests for textUtils - LRU Cache + Code Point Utilities
 */

import { describe, it, expect, beforeEach } from "vitest";
import {
  LRUCache,
  getCodePointLength,
  getVisualWidth,
  getCharAtCodePoint,
  splitByCodePoints,
  truncateByVisualWidth,
  isWideChar,
} from "@kodax/repl";

describe("LRUCache", () => {
  let cache: LRUCache<string, number>;

  beforeEach(() => {
    cache = new LRUCache<string, number>(3); // Small capacity for testing
  });

  describe("basic operations", () => {
    it("should set and get values", () => {
      cache.set("a", 1);
      expect(cache.get("a")).toBe(1);
    });

    it("should return undefined for missing keys", () => {
      expect(cache.get("missing")).toBeUndefined();
    });

    it("should check if key exists", () => {
      cache.set("a", 1);
      expect(cache.has("a")).toBe(true);
      expect(cache.has("b")).toBe(false);
    });

    it("should delete keys", () => {
      cache.set("a", 1);
      expect(cache.delete("a")).toBe(true);
      expect(cache.get("a")).toBeUndefined();
      expect(cache.delete("a")).toBe(false);
    });

    it("should clear all entries", () => {
      cache.set("a", 1);
      cache.set("b", 2);
      cache.clear();
      expect(cache.size).toBe(0);
      expect(cache.get("a")).toBeUndefined();
    });
  });

  describe("eviction policy", () => {
    it("should evict oldest entry when capacity exceeded", () => {
      cache.set("a", 1);
      cache.set("b", 2);
      cache.set("c", 3);
      cache.set("d", 4); // Should evict "a"

      expect(cache.get("a")).toBeUndefined();
      expect(cache.get("b")).toBe(2);
      expect(cache.get("c")).toBe(3);
      expect(cache.get("d")).toBe(4);
    });

    it("should update LRU order on get", () => {
      cache.set("a", 1);
      cache.set("b", 2);
      cache.set("c", 3);

      // Access "a" to make it most recently used
      cache.get("a");

      // Add new entry, should evict "b" (not "a")
      cache.set("d", 4);

      expect(cache.get("a")).toBe(1);
      expect(cache.get("b")).toBeUndefined();
      expect(cache.get("c")).toBe(3);
      expect(cache.get("d")).toBe(4);
    });

    it("should update LRU order on set existing key", () => {
      cache.set("a", 1);
      cache.set("b", 2);
      cache.set("c", 3);

      // Update "a" to make it most recently used
      cache.set("a", 10);

      // Add new entry, should evict "b" (not "a")
      cache.set("d", 4);

      expect(cache.get("a")).toBe(10);
      expect(cache.get("b")).toBeUndefined();
    });
  });

  describe("size tracking", () => {
    it("should track size correctly", () => {
      expect(cache.size).toBe(0);
      cache.set("a", 1);
      expect(cache.size).toBe(1);
      cache.set("b", 2);
      expect(cache.size).toBe(2);
      cache.delete("a");
      expect(cache.size).toBe(1);
    });
  });
});

describe("Code Point Utilities", () => {
  describe("getCodePointLength", () => {
    it("should return 0 for empty string", () => {
      expect(getCodePointLength("")).toBe(0);
    });

    it("should count ASCII characters correctly", () => {
      expect(getCodePointLength("hello")).toBe(5);
    });

    it("should count emoji as single code point", () => {
      expect(getCodePointLength("👍")).toBe(1);
    });

    it("should count combined emoji as single code point", () => {
      // Family emoji: 👨‍👩‍👧‍👦 (4 ZWJ combined)
      expect(getCodePointLength("👨‍👩‍👧‍👦")).toBe(1);
    });

    it("should count mixed content correctly", () => {
      expect(getCodePointLength("Hi 👍!")).toBe(5);
    });

    it("should handle CJK characters", () => {
      expect(getCodePointLength("你好世界")).toBe(4);
    });
  });

  describe("getVisualWidth", () => {
    it("should return 0 for empty string", () => {
      expect(getVisualWidth("")).toBe(0);
    });

    it("should count ASCII as width 1", () => {
      expect(getVisualWidth("hello")).toBe(5);
    });

    it("should count CJK as width 2", () => {
      expect(getVisualWidth("你好")).toBe(4);
    });

    it("should count emoji as width 2 (typically)", () => {
      // Most emojis display as 2 columns
      expect(getVisualWidth("👍")).toBe(2);
    });

    it("should handle mixed content", () => {
      // "Hi你好" = 2*1 + 2*2 = 6
      expect(getVisualWidth("Hi你好")).toBe(6);
    });
  });

  describe("isWideChar", () => {
    it("should return false for ASCII", () => {
      expect(isWideChar("a")).toBe(false);
      expect(isWideChar("Z")).toBe(false);
      expect(isWideChar("0")).toBe(false);
    });

    it("should return true for CJK", () => {
      expect(isWideChar("中")).toBe(true);
      expect(isWideChar("あ")).toBe(true);
      expect(isWideChar("한")).toBe(true);
    });

    it("should return true for emoji", () => {
      expect(isWideChar("👍")).toBe(true);
    });
  });

  describe("getCharAtCodePoint", () => {
    it("should return empty string for out of bounds", () => {
      expect(getCharAtCodePoint("hello", 10)).toBe("");
    });

    it("should return correct ASCII character", () => {
      expect(getCharAtCodePoint("hello", 0)).toBe("h");
      expect(getCharAtCodePoint("hello", 4)).toBe("o");
    });

    it("should return emoji as single unit", () => {
      expect(getCharAtCodePoint("👍abc", 0)).toBe("👍");
      expect(getCharAtCodePoint("a👍b", 1)).toBe("👍");
    });

    it("should return combined emoji as single unit", () => {
      const family = "👨‍👩‍👧‍👦";
      expect(getCharAtCodePoint(family, 0)).toBe(family);
    });
  });

  describe("splitByCodePoints", () => {
    it("should return empty array for empty string", () => {
      expect(splitByCodePoints("")).toEqual([]);
    });

    it("should split ASCII correctly", () => {
      expect(splitByCodePoints("abc")).toEqual(["a", "b", "c"]);
    });

    it("should split emoji correctly", () => {
      expect(splitByCodePoints("👍😊")).toEqual(["👍", "😊"]);
    });

    it("should split mixed content correctly", () => {
      expect(splitByCodePoints("a👍b")).toEqual(["a", "👍", "b"]);
    });
  });

  describe("truncateByVisualWidth", () => {
    it("should not truncate if within width", () => {
      expect(truncateByVisualWidth("hello", 10)).toBe("hello");
    });

    it("should truncate ASCII to width", () => {
      expect(truncateByVisualWidth("hello world", 5)).toBe("hello");
    });

    it("should truncate CJK correctly", () => {
      // "你好世界" = 8 visual width, truncate to 4 = "你好"
      expect(truncateByVisualWidth("你好世界", 4)).toBe("你好");
    });

    it("should handle partial CJK truncation", () => {
      // Truncate "你好" (width 4) to width 3 should give "你" (width 2) since "好" doesn't fit
      // Without ellipsis flag, just truncate
      const result = truncateByVisualWidth("你好", 3);
      expect(result).toBe("你");
    });

    it("should add ellipsis when requested", () => {
      // "hello world" = 11 chars, truncate to 8 width with ellipsis
      // Ellipsis takes 1 width, so we have 7 width for text = "hello w" (7 chars)
      expect(truncateByVisualWidth("hello world", 8, true)).toBe("hello w…");
    });

    it("should add ellipsis for shorter width", () => {
      // Truncate to 6 width with ellipsis = 5 width for text = "hello"
      expect(truncateByVisualWidth("hello world", 6, true)).toBe("hello…");
    });

    it("should handle empty string", () => {
      expect(truncateByVisualWidth("", 5)).toBe("");
    });
  });
});
