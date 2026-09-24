# Contact calculation and memory tools

Each contact plan controls two local tools. `memorySearch` defaults to `true` and
searches that conversation's retained memory archive. `javascript` defaults to
`false`; enable it in the owner's complete plan with `habitats configure` while
automatic replies are paused. Learning preserves both flags.

Memory search ranks exact words and phrases in the contact's source notes. It
returns up to eight excerpts with their source IDs, digests, authors and
categories. Each excerpt contains at most 256 UTF-8 bytes, and the complete result
fits within 4,096 bytes. Results report omitted matches and shortened text. A
search reads the archive without changing it or contacting an external service.

JavaScript supports small calculations and data transformations. The model supplies
a synchronous function body and optional JSON input, available as `input`:

```json
{"kind":"javascript","code":"return input.prices.reduce((total, price) => total + price, 0);","input":{"prices":[12,8,5]}}
```

The result is JSON, such as `{"ok":true,"value":25}`. A failed calculation returns
a bounded error code. The model may use the remaining tool call to correct it.
All tools share the existing limit of two calls per reply.

Each calculation runs in a new QuickJS interpreter compiled to WebAssembly. The
host supplies only copied JSON. There are no file, network, process, module,
timer or messaging APIs inside the interpreter. `Date` and `Math.random` are
unavailable. A calculation cannot inspect contact memory unless the reply agent
passes selected data as input. That data stays on the local host during execution.

| Resource | Limit |
| --- | --- |
| Code | 8,192 UTF-8 bytes |
| Input JSON | 16,384 UTF-8 bytes |
| Output JSON | 4,096 UTF-8 bytes |
| QuickJS heap | 8 MiB |
| Interpreter stack | 256 KiB |
| Cooperative interrupt | 50 ms, with at most 5,000 interrupt checks |
| Worker watchdog | 250 ms after worker startup; a calculation that misses this gets a resource-limit result and termination is requested |
| Worker startup | 2,000 ms maximum before a bounded failure result |
| Input/output structure | 16 levels and 1,024 values |

The interpreter checks its deadline during execution and is disposed after every
call. A separate worker watchdog requests termination if a native engine
operation fails to reach an interrupt check. The host returns a bounded
resource-limit result and refuses another calculation until worker termination
settles. If termination cannot be confirmed, JavaScript stays unavailable for
that app process; restarting the app clears the fail-closed guard. JSON output
rejects pending asynchronous work. Loading the interpreter and generating the
model response take additional time. The WebAssembly runtime and worker have
fixed overhead outside the QuickJS heap limit.

Submitted replies retain tool outcomes for inspection and reflection. JavaScript
evidence labels the code with its SHA-256 digest. Offline personality evaluation
does not execute either tool and cannot measure tool behavior from a text replay.

The implementation uses the pinned `quickjs-emscripten-core` and embedded
`@jitl/quickjs-singlefile-browser-release-sync` packages. The upstream
[runtime documentation](https://github.com/justjake/quickjs-emscripten/blob/main/doc/quickjs-emscripten/classes/QuickJSRuntime.md)
describes interpreter memory, stack and interrupt controls.
