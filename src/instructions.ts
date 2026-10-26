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
 * It is ordered by what changes behavior on the first call: read the schema (this
 * host's `edit` is not the usual one), then the calling rules, then files. Length
 * is kept down because a long prompt gets skimmed.
 */
export const BRIDGE_INSTRUCTIONS = `You are connected over MCP to a live agent session on another machine. The tools in \`tools/list\` run there for real: \`bash\` runs in its shell, \`read\`/\`write\`/\`edit\` act on its files, and results come back verbatim, errors included. Nothing is reasoned about on that side: you decide what runs, that machine only executes.

Before you call a tool:
- Read its input schema in \`tools/list\`. A same-named tool can differ here: this host's \`edit\` takes a hashline patch (\`*** Begin Patch\`, \`[PATH#TAG]\`, \`PUT N.=M:\`, \`*** End Patch\`), where \`TAG\` is the 4-hex snapshot from your latest \`read\` — not \`oldString\`/\`newString\`. A guess comes back \`File not found\`; re-read after each edit.
- Work one fact at a time: call, read the result, then decide the next call.
- Use absolute paths; no working directory is implied. The host is a general-purpose machine: commands run through \`bash\` on whatever \`PATH\` it has, and nothing else should be assumed about its setup.
- Give every call a timeout of your own. A call can hang: a permission prompt on the other side may have nobody to answer it, and your timeout is the only way out.
- What you run there stays there: nothing on that machine is rolled back for you.
- The token in your client config is the only gate to that machine. Do not echo it into commands, files, or messages.

Files move over the bridge's own WebDAV route, never through tool arguments. Use an existing WebDAV client (\`curl\`, \`rclone\`); do not write your own. The route is:
1. \`xfer_share {"path": "/absolute/host/path"}\` serves one host file or directory and returns the route; it closes after an hour unless you pass \`ttlSeconds\`. Use \`publicUrl\` when it is not \`null\`; otherwise use the bridge URL your client already uses plus \`/xfer/\` — the loopback \`url\` in the reply is the host's own address. One share at a time: a second \`xfer_share\` replaces the first; \`xfer_status\` reports it, \`xfer_stop\` closes it, and you close only the share you opened.
2. Send \`Authorization: Bearer <token>\` on every request, with paths relative to the shared path, and keep the token in an environment variable rather than in a command line. Download: \`curl -fL -C - -H "Authorization: Bearer $A2MCP_TOKEN" "$ROUTE/path/to/file" -o LOCAL\`; \`-C -\` resumes, and a \`416\` means the local copy is complete. Upload: \`curl -fL -T LOCAL -H "Authorization: Bearer $A2MCP_TOKEN" "$ROUTE/path/to/file"\`. To resume an upload, send the first chunk with PUT and later chunks with PATCH plus \`X-Update-Range: append\`. List: \`curl -fL -X PROPFIND -H "Depth: 1" -H "Authorization: Bearer $A2MCP_TOKEN" "$ROUTE/"\`. DELETE and MOVE are refused, and an upload never overwrites a non-empty file (403): delete that file on the host first.
3. Over a \`publicUrl\`, Cloudflare refuses a request body over 100 MB. Split a larger upload with \`split -b 64m FILE FILE.part.\`, PUT each part, then join them on the host with \`bash\` (\`cat FILE.part.* > FILE\`), check \`sha256sum\`, and remove the parts. If a part is interrupted, delete that non-empty part on the host and send it again.
4. Never move file bytes through \`read\`, \`bash\` or tool arguments: host \`read\` truncates around 150 KB and \`bash\` around 768 bytes, so large or binary content comes back corrupted. Never paste megabytes into a command.
5. When \`publicUrl\` is \`null\`, ask the operator to run \`/a2mcp tunnel\` or forward the bridge port over SSH. Do not start your own tunnel or second file server: a hostname you open is not behind this bridge's token, so whatever it serves is public.

If your side cannot speak MCP to this endpoint, use the bridge's zero-dependency client for single calls — \`scripts/mcp-call.py\` — and a standard WebDAV client (\`curl\`, \`rclone\`) for files. There is no bridge-specific file client to install or fetch.`;
