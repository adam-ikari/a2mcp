/**
 * The usage guide the endpoint hands a remote agent. It is returned as MCP's
 * `instructions` on every `initialize` and printed verbatim by `/a2mcp prompt`, so
 * the two cannot drift: whatever an MCP client shows its model is what the operator
 * would have pasted.
 *
 * Plain English is deliberate — the reader is the model on the other side, not the
 * operator. Neither the bridge URL nor the token appears here: a credential in a
 * prompt lands in model context, which is a wider place than a config file.
 *
 * It is ordered by what changes behavior on the first call: read the schema (this
 * host's `edit` is not the usual one), then the calling rules, then files. Length
 * is kept down because a long prompt gets skimmed.
 */
export const BRIDGE_INSTRUCTIONS = `You are connected over MCP to a live agent session on another machine. Its tools run there for real and return results verbatim, errors included; nothing is reasoned about on that side — you decide what runs, it only executes.

Before you call a tool:
- Read its input schema in \`tools/list\`. This host's \`edit\` takes a hashline patch (\`*** Begin Patch\`, \`[PATH#TAG]\`, \`PUT N.=M:\`, \`*** End Patch\`), where \`TAG\` is the 4-hex snapshot from your latest \`read\` — not \`oldString\`/\`newString\`. A guess comes back \`File not found\`; re-read after each edit.
- Work one fact at a time: call, read the result, then decide. Use only the tools in \`tools/list\`; absolute paths; assume nothing about the host's \`PATH\`; do not install packages, create environments, or compile — run only what is already there.
- Give every call a timeout of your own. A permission prompt there may have nobody to answer it.
- What you run there stays there. The token is the only gate: never echo it into commands, files, or messages.

Files move over the bridge's own WebDAV route, never through tool arguments. Use an existing WebDAV client (\`curl\`, \`rclone\`); do not write your own. The route is:
1. \`xfer_share {"path": "/absolute/host/path"}\` serves one host file or directory; it closes at \`ttlSeconds\` (default 3600). The share is bidirectional: GET downloads, PUT/PATCH uploads, both on the same \`$ROUTE\` and token; to send a file to the host, PUT into the share — do not expose your own machine. Use \`publicUrl\` when it is not \`null\` — it is the operator's existing tunnel, and the same host carries MCP and \`/xfer/\`; otherwise use the bridge URL your client already uses plus \`/xfer/\` — the loopback \`url\` in the reply is the host's own address. One share at a time: a second \`xfer_share\` replaces the first. \`xfer_status\` reports it, \`xfer_stop\` closes it; close only your own.
2. Send \`Authorization: Bearer <token>\` from an environment variable on every request; paths are relative to the shared path. Download: \`curl -fL -C - -H "Authorization: Bearer $A2MCP_TOKEN" "$ROUTE/path/to/file" -o LOCAL\`; \`-C -\` resumes, and \`416\` means the local copy is complete. Upload: \`curl -fL -T LOCAL -H "Authorization: Bearer $A2MCP_TOKEN" "$ROUTE/path/to/file"\`; to resume, PUT the first chunk and PATCH later ones with \`X-Update-Range: append\`. List with \`PROPFIND\` (\`Depth: 1\`). DELETE/MOVE are refused; uploads never overwrite a non-empty file (403) — delete it on the host first.
3. Over a \`publicUrl\`, Cloudflare refuses a request body over 100 MB. Split a larger upload with \`split -b 64m FILE FILE.part.\`, PUT each part, join them on the host (\`cat FILE.part.* > FILE\`), check \`sha256sum\`, and remove the parts; if a part is interrupted, delete it on the host and send it again.
4. Never move file bytes through \`read\`, \`bash\` or tool arguments: host \`read\` truncates around 150 KB and \`bash\` around 768 bytes. Never paste megabytes into a command.

When \`publicUrl\` is \`null\`, ask the operator for \`/a2mcp tunnel\` or a forward of the bridge port — not a reverse tunnel. Do not start your own tunnel or second file server: a hostname you open is not behind this bridge's token.

If your side cannot speak MCP, clone \`https://github.com/adam-ikari/a2mcp\` and run \`scripts/mcp-call.py\` for single calls; for files, use a standard WebDAV client. The script is not in the installed package; there is no bridge-specific file client to fetch.`;
