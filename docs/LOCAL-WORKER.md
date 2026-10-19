# Local project contributor

Use the existing Ollama installation with a dedicated hidden server and model
storage in this project. The initial candidate is HauhauCS Qwen3.5-9B Q4_K_M,
subject to actual GPU/tool-use tests. No cloud billing fallback is enabled.

The worker can take explicitly authorized work when hosted models reach usage
limits or are unavailable. A context-recovery handoff preserves the original
goal, relevant evidence, the prior model's exact failure and missing information.
The worker independently reassesses that context and proposes the next valid
step. A misunderstanding may be corrected; the handoff grants no extra access.

Game authority, task ownership, permission decisions and project validation
apply to every model. Genuine security or permission refusals do not become an
instruction to execute. Unknown outcomes are not replayed automatically.

Model runs use one request at a time, bounded context/output/tool budgets and
an explicit deadline. Idle status/queue checks use no inference. A model being
installed is not evidence that GPU inference or MCP tools work; verification
records must distinguish those states.

Keep all new model files and evidence under models/ollama and state/local-worker.
No background console windows, desktop takeover or scheduled prompt polling.

## Individual chat and team connection

The existing Copilot app includes **Chat with HauhauCS** at
<http://127.0.0.1:8795/#local-chat>. Each conversation retains its own original
goal, recent history, explicit omissions, tool evidence and outcome. Maximums
are 50 conversations, 6000 characters per user message and one active run.
The original goal and latest turn survive model-context pruning; a request
that cannot fit those alone is refused with a split-request explanation.
The transcript and the model context have separate labelled bounds.

Send starts inference; Stop requests cancellation and keeps the inference
slot occupied until the adapter settles. A process restart marks unfinished
work interrupted/unknown. It never resubmits it. History is stored under
`state/local-worker/chats/`; do not store credentials in conversations.

The project-local `.mcp.json` and `.codex/config.toml` retain the existing
servers and add `local_model`, launched internally by `scripts/local-worker.mjs`.
Reconnect clients to discover its status/chat/cancel tools. This is part of
the same application, not another user-facing launcher. Model calls use the
app's same chat service, persistence, concurrency limit and tool adapter.

HauhauCS can call `project_context` to read bounded lab/Architect task and memory
evidence through a real stdio MCP session, or `project_handoff` to append an
attributed observation when asked to share work. Handoffs do not prove peer
receipt or acceptance. These tools cannot edit source, issue shell commands,
change permissions or commit game actions. Code can be proposed in chat for
an owning implementer to apply and test. Automatic cloud-failure routing is
not wired into the hosted coordinator yet; explicit MCP delegation works
independently of cloud credits. No model weight training is claimed.

## Installed and measured, 2026-10-17

The candidate is the publisher's
[Qwen3.5-9B model](https://huggingface.co/HauhauCS/Qwen3.5-9B-Uncensored-HauhauCS-Aggressive),
revision `0a41c68809d375475f954be12ba7c40efa56c2a9`. Its 5,627,044,224-byte
Q4_K_M weight file was hashed locally and matched SHA-256
`2ca636d9e81d3d23ca9b60c234fe185d30ec082eeba69ce770fdb0c76559a4f5`.
The Ollama manifest also includes a vision projector; vision was not tested.

Existing Ollama 0.40.5 serves this project on localhost port 11436 using
`models/ollama/`, separate from the existing user service on port 11434. Logs proved
ROCm `gfx1101` on the RX 7800 XT with 16 GiB VRAM. A real local two-request tool
exchange called `project_context` once and returned a proposed acceptance
checklist in 42.036 seconds including startup, with 714 output tokens. The loaded
runtime reported 5,734,588,742 GPU bytes. This single check proves inference and
tool use, not general reliability, game understanding or training improvement.

Configuration: 8192-token context, 1024 generated tokens per request, one parallel
request, four MCP calls per turn, 60-second keep-alive, no cloud fallback. The service
identity is checked at startup and before explicit runs; status refreshes
launch no processes. Settings follow the official
[Ollama documentation](https://docs.ollama.com/faq).

Evidence: `state/local-worker/weight-check.json`, `inference-check.json`,
`mcp-chat-check.json`, `app-check.json`, and `chat-suite.log`. An initial live
chat exposed Qwen's single-system-prelude requirement; the adapter now merges
the two internal preludes and a regression test covers it. Failed attempts
remain saved with their true outcomes.

Verification is scoped: 35 local chat/service/gateway/MCP tests pass. The full
lab run before the last two added regressions had 82 passes, one opt-in skip,
and eight failures from the already unfinished reference-demo task. Its partial
test file is preserved; this chat extension does not claim that separate work
is finished. Native Satisfactory playtesting still needs the matching SDK's
authenticated Wwise dependency and a live game run.

The app's real MCP gateway completed a saved conversation with both
`project_context` and `project_handoff`. A separate live cancellation check
preserved its unknown outcome and rejected an overlapping send with HTTP 409.
The DOM harness in `state/local-worker/ui-check.mjs` verifies reload/Stop,
bounded status polling, visible terminal errors, draft preservation and
GET-only startup against the exact current UI source with mocked HTTP.
