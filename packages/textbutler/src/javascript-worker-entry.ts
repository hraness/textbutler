import { parentPort } from "node:worker_threads";
import { runJavascriptInInterpreter, type JavascriptResult } from "./javascript-tool.ts";

const port = parentPort;
if (!port) throw Error("JavaScript worker requires a parent port");
port.once("message", async (message: { code: string; inputJson: string }) => {
  let result: JavascriptResult;
  try { result = await runJavascriptInInterpreter(message.code, JSON.parse(message.inputJson), new AbortController().signal); }
  catch { result = { ok: false, error: "execution-failed" }; }
  port.postMessage(result); port.close();
});
port.postMessage({ ready: true });
