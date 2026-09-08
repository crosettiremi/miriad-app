# Workers AI runtime adapter

Hosted Miriad agents use `@cf/qwen/qwen3.8-27b` through the Worker `AI` binding. They do not need an Anthropic key. Cloudflare remains responsible for inference, the Agents SDK `SpaceAgent` coordinates runtimes and persists final frames, and the Sandbox SDK runs tools and checkpoints the workspace.

## Request path

Sandbox engine → runtime origin `/api/ai/chat/completions` → existing Server credential authentication → the caller's SpaceAgent → `env.AI.run()`.

The endpoint accepts only runtime credentials on the runtime hostname. Browser sessions and container tokens cannot call inference. Callers cannot choose another model/provider. Requests are parsed with a 192 KiB body limit, bounded tool/message counts and a 4,096 output-token ceiling. SpaceAgent permits four concurrent requests and 60 requests per minute per space. Its inference method is internal binding RPC, never browser-callable.

`HOSTED_ENGINE=workers-ai` selects the adapter for hosted agents; `WORKERS_AI_MODEL` selects the deployed model. The runtime receives the model endpoint and its own revocable Server credential in process environment. Legacy local Claude and Nuum runtimes remain available when the hosted override is absent. Switching back to Claude also requires restoring its API key configuration.

## Tool and session behavior

The engine implements Miriad's existing SDK-message interface rather than an Anthropic HTTP emulation. It emits full assistant messages, tool-call/result events and final usage/cost events. Token-by-token streaming is not implemented. It provides Bash, Read, Write and Edit plus official MCP SDK clients for stdio, Streamable HTTP and SSE servers. Built-in Miriad MCP uses the machine hostname, while browser OAuth keeps the app hostname.

Sessions are written atomically to `.miriad-ai/session.json` in each agent workspace, included in Sandbox R2 checkpoints. Tool intent is saved before execution and the result afterward. On restart, an unrecorded result is marked as an unknown outcome; the adapter never automatically replays that side effect. The model is told to inspect state before repeating it. An interrupted turn still needs another message to continue; this is not exactly-once tool execution or automatic resumption of in-flight work.

The input budget is 128 KiB including system prompt and tool definitions, conservatively below the selected model's context window. History is capped at 510 messages, reserving two gateway slots for the system prompt and truncation notice; at most 128 tools (including built-ins) may be configured. Old complete conversation/tool groups are removed with a visible notice. An oversized current request fails explicitly. Defaults are 2,048 generated tokens per request, a 240-second inference deadline, up to 24 tool rounds per turn, at most 120 seconds per Bash/MCP tool call, and bounded tool output. These controls cannot guarantee completion of arbitrary tasks: timeouts, output exhaustion and round limits produce error results, not successful completion. Shell interruption kills the child process group. Queued turns keep the agent busy until the final result, including when an earlier turn fails.

This first adapter is text-oriented. MCP structured/nontext results are serialized and bounded; image understanding, interactive MCP OAuth and mid-turn MCP tool-list refresh are not implemented. Platform credentials are not injected into shell environments or deliberately persisted in sessions. This is not a security boundary against arbitrary code running as the same Sandbox user.

Usage cost is an estimate from model token counts and the published Qwen 3.8 27B unit prices ($0.45/M input, $3.20/M output); Cloudflare billing is authoritative. Update the estimate and context budget when changing models. Failed turns retain usage already returned by inference, but a canceled request may still incur provider charges that were not returned to the adapter.

## Validation

Focused tests cover correlated tool calls, file writes/reads, session resume, interrupted side effects, context grouping, credential override rejection, real stdio MCP, shell process-group cancellation, and explicit token/round-limit failures. Boundary tests cover authentication, caller-selected model rejection and oversized streaming bodies. The workerd security test verifies the inference method cannot be invoked over browser RPC.

References: [Workers AI binding](https://developers.cloudflare.com/workers-ai/configuration/bindings/), [Qwen 3.8 27B](https://developers.cloudflare.com/workers-ai/models/qwen3.8-27b/), [Agents SDK](https://developers.cloudflare.com/agents/).
