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

- Read each tool's input schema in \`tools/list\` before calling. This host's \`edit\` takes a hashline patch (\`*** Begin Patch\`, \`[PATH#TAG]\`, \`PUT N.=M:\`, \`*** End Patch\`), where \`TAG\` is the 4-hex snapshot from your latest \`read\` — not \`oldString\`/\`newString\`. A guess returns \`File not found\`; re-read after each edit.
- One fact at a time: call, read the result, then decide. Use only the tools in \`tools/list\`; absolute paths; assume nothing about the host's \`PATH\`; do not install packages, create environments, or compile — run only what is already there.
- Set your own timeout on every call: a permission prompt may never be answered.
- What you run there stays there. The token is the only gate: never echo it into commands, files, or messages.

Files move over the bridge's own WebDAV route, never through tool arguments. Use an existing WebDAV client (\`curl\`, \`rclone\`), not one of your own. \`xfer_share {"path": "/absolute/host/path"}\` serves one host file or directory for \`ttlSeconds\` (default 3600). The share is bidirectional: GET downloads, PUT/PATCH uploads, same \`$ROUTE\` and token — to send a file, PUT into the share; do not expose your own machine. Use \`publicUrl\` when not \`null\` (the operator's existing tunnel, shared with MCP); otherwise use your bridge URL plus \`/xfer/\` — the reply's \`url\` is loopback, for the host itself. One share at a time — a second replaces the first; \`xfer_status\` / \`xfer_stop\` manage it, and close only your own.

Send \`Authorization: Bearer <token>\` from an environment variable; paths are relative to the share. Download: \`curl -fL -C - -H "Authorization: Bearer $A2MCP_TOKEN" "$ROUTE/file" -o LOCAL\`; \`-C -\` resumes, \`416\` means complete. Upload: \`curl -fL -T LOCAL -H "Authorization: Bearer $A2MCP_TOKEN" "$ROUTE/file"\`; to resume, PUT then PATCH \`X-Update-Range: append\`. \`PROPFIND\` lists. DELETE/MOVE are refused; uploads never overwrite a non-empty file (403) — delete it with \`bash\` first. Over a \`publicUrl\`, Cloudflare refuses a request body over 100 MB: split with \`split -b 64m FILE FILE.part.\`, PUT each part, join on the host (\`cat FILE.part.* > FILE\`), check \`sha256sum\`, remove the parts, resend only an interrupted one. Never move bytes through \`read\`, \`bash\`, or arguments (\`read\` truncates ~150 KB, \`bash\` ~768 bytes); never paste megabytes into a command.

When \`publicUrl\` is \`null\`, ask the operator for \`/a2mcp tunnel\` or a forward of the bridge port — not a reverse tunnel. Do not start your own tunnel or second file server. If your side cannot speak MCP, clone \`https://github.com/adam-ikari/a2mcp\` and run \`scripts/mcp-call.py\` (not in the installed package); for files, use a standard WebDAV client.`;
