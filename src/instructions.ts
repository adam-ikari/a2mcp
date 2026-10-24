/**
 * The usage guide the endpoint hands a remote agent. It is returned as MCP's
 * `instructions` on every `initialize` and printed verbatim by `/a2mcp prompt`, so
 * the two cannot drift: whatever an MCP client shows its model is what the operator
 * would have pasted.
 *
 * Plain English is deliberate — the reader is the model on the other side, not the
 * operator. Neither the URL nor the token appears here: a credential in a prompt
 * lands in model context, which is a wider place than a config file.
 *
 * The text is long because it is read once per session. Tool results stay compact.
 */
export const BRIDGE_INSTRUCTIONS = `You are connected over MCP to a live agent session on another machine. The tools in \`tools/list\` are that machine's own: \`bash\` runs commands in its shell, \`read\`/\`write\`/\`edit\` work on its files, and the results come back verbatim — errors included, in the tool's own words. Nothing is reasoned about on that side: you decide what runs, that machine only executes.

How to call:
- Work one fact at a time: call a tool, read its result, then decide the next call.
- Use absolute paths; no working directory is implied. The machine is often a device lab — \`adb\`, flashing tools and serial ports are reached through \`bash\`.
- Give every call a timeout of your own. A call can hang: a permission prompt on the other side may have nobody to answer it, and your timeout is the only way out.
- What you run there stays there: nothing on that machine is rolled back for you.
- The token in your client config is the only gate to that machine. Do not echo it into commands, files, or messages.

Files move over the bridge's own WebDAV route, never through tool arguments. \`xfer_share\` works like this:
1. \`xfer_share {"path": "/absolute/host/path", "ttlSeconds": 3600}\` serves one host file or directory and returns compact JSON: \`url\` is the route on this endpoint, \`publicUrl\` is the same route behind the operator's tunnel (or \`null\`), plus \`route\`, \`path\`, \`port\`, \`startedAt\`, \`expiresAt\` and \`installed\`. The share closes itself at \`ttlSeconds\` (default 3600).
2. Transfer over HTTP with \`Authorization: Bearer <token>\` on every request and paths relative to the shared path. GET downloads, and \`Range: bytes=start-end\` reads a slice or resumes (a range past the end answers 416 with \`content-range: bytes */<size>\`). PUT creates a file. PATCH with \`X-Update-Range: append\` continues a partial upload: first chunk PUT, later chunks PATCH. PROPFIND lists a directory. DELETE and MOVE are refused, and an upload never overwrites an existing non-empty file (403) — remove the remote file some other way first.
3. Use an existing WebDAV client instead of writing your own. Anything that can send \`Authorization: Bearer <token>\` works; \`curl\` covers the common cases:
   - download: \`curl -fL -C - -H "Authorization: Bearer $A2MCP_TOKEN" "$ROUTE/path/to/file" -o LOCAL\`. \`-C -\` resumes a partial local file with a Range request; a \`416\` means the local copy is already complete.
   - upload: \`curl -fL -T LOCAL -H "Authorization: Bearer $A2MCP_TOKEN" "$ROUTE/path/to/file"\`.
   - list: \`curl -fL -X PROPFIND -H "Depth: 1" -H "Authorization: Bearer $A2MCP_TOKEN" "$ROUTE/"\`.
   \`$ROUTE\` is the share's \`publicUrl\` when it is not \`null\`; otherwise it is the bridge URL your client already uses, with \`/xfer/\` appended — not the loopback \`url\` in the reply, which is the host's own address. \`rclone\` and other WebDAV clients mount the same route. Interrupted downloads resume from where they stopped. Standard WebDAV clients restart an interrupted upload; \`dufs\` also accepts \`PATCH\` with \`X-Update-Range: append\`, so a client that can send that header resumes instead. Keep the token in an environment variable rather than pasting its value into a command line.
4. One share at a time: a second \`xfer_share\` replaces the first and says \`replaced: true\`. \`xfer_status\` reports the current share; \`xfer_stop\` closes it. Close the share you opened when the transfer is done; do not stop a share you did not open.
5. Reach the route through \`publicUrl\` when it is not \`null\`. When it is \`null\`, ask the operator to run \`/a2mcp tunnel\` or forward the bridge port over SSH. Do not start your own tunnel or second file server: a hostname you open is not behind this bridge's token, so whatever it serves is public.
6. Never move file bytes through \`read\`, \`bash\` or tool arguments: host \`read\` truncates around 150 KB and \`bash\` around 768 bytes, so large or binary content comes back corrupted. Never paste megabytes into a command.

If your side cannot speak MCP to this endpoint, use the bridge's zero-dependency client for single calls — \`scripts/mcp-call.py\` — and a standard WebDAV client (\`curl\`, \`rclone\`) for files. There is no bridge-specific file client to install or fetch.`;
