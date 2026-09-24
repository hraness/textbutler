import { expect, test } from "bun:test";
import { searchHabitatMemory } from "./memory-search.ts";
import type { HabitatMemory } from "./contact-habitat.ts";

const memory = (id: string, text: string, at = 1): HabitatMemory => ({ id, text, at, author: "contact", sourceDigest: "a".repeat(64), truncated: false });
test("memory search ranks relevant source records, preserves provenance and leaves the archive unchanged", () => {
  const archive = [memory("unrelated", "Dinner is at seven"), memory("partial", "Travel is fun", 4), { ...memory("specific", "Travel planning starts Monday"), category: "open-loop" as const }];
  const before = structuredClone(archive), result = searchHabitatMemory(archive, "travel planning");
  expect(result.matches.map(value => value.id)).toEqual(["specific", "partial"]);
  expect(result.matches[0]).toMatchObject({ category: "open-loop", sourceDigest: "a".repeat(64), author: "contact" });
  expect(archive).toEqual(before); expect(searchHabitatMemory([], "travel")).toEqual({ matches: [], omitted: 0 });
  expect(searchHabitatMemory(archive, "no-match").matches).toEqual([]);
});
test("memory search limits result count and encoded bytes while reporting omissions", () => {
  const archive = Array.from({ length: 64 }, (_, index) => memory(`source-${index}`.padEnd(256, "s"), `travel ${"\n".repeat(500)}`, index));
  const result = searchHabitatMemory(archive, "travel");
  expect(result.matches.length).toBeLessThanOrEqual(8); expect(result.matches.length).toBeGreaterThan(0);
  expect(result.matches[0]!.id).toStartWith("source-63"); expect(result.matches[0]!.truncated).toBe(true);
  expect(result.omitted).toBe(64 - result.matches.length); expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(4096);
  expect(() => searchHabitatMemory(archive, "é".repeat(129))).toThrow();
  expect(() => searchHabitatMemory([...archive, archive[0]!], "travel")).toThrow();
});
