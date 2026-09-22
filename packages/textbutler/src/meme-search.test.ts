import { expect, test } from "bun:test";
import { createMemeSearch } from "./meme-search.ts";

test("free meme search ranks a bounded public catalog locally without sending the query", async () => {
  const urls: string[] = [];
  const memes = createMemeSearch({ fetch: async url => { urls.push(url); return Response.json({ success: true, data: { memes: [
    { id: "1", name: "Distracted Developer", url: "https://i.imgflip.com/abc123.jpg", width: 600, height: 400 },
    { id: "2", name: "Two Buttons", url: "https://i.imgflip.com/def456.png", width: 600, height: 400 },
  ] } }); } });
  const results = await memes.search("distracted", new AbortController().signal);
  expect(results.map(result => result.id)).toEqual(["1"]);
  await memes.search("buttons", new AbortController().signal);
  expect(urls).toEqual(["https://api.imgflip.com/get_memes"]);
  expect(results[0]?.source).toBe("Imgflip popular templates; not full-library search");
});

test("untrusted media URLs and unknown IDs cannot initiate arbitrary downloads", async () => {
  let calls = 0;
  const memes = createMemeSearch({ fetch: async () => { calls++; return Response.json({ success: true, data: { memes: [{ id: "1", name: "Bad", url: "http://127.0.0.1/private", width: 1, height: 1 }] } }); } });
  await expect(memes.search("Bad", new AbortController().signal)).rejects.toThrow();
  await expect(memes.image("1", new AbortController().signal)).rejects.toThrow();
  expect(calls).toBe(1);
});
