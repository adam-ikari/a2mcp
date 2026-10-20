#!/usr/bin/env python3
"""A2MCP bridge minimal client. Zero dependency (Python 3 standard library only).

If you have an MCP client already, do not use this — point it at the bridge with
`mcp.json` (`{"type": "http", "url": "http://127.0.0.1:<port>/", "headers":
{"Authorization": "Bearer <token>"}}`) and the host's tools appear in your tool
list natively. This file is only for callers that can run code but are not an MCP
client: it speaks the bridge's handshake so you do not have to rebuild it.

The bridge answers plain JSON (no SSE). Every message after `initialize` must
carry the `Mcp-Session-Id` the `initialize` response handed back; a missing one
is a 400, an expired or unknown one is a 404 (the bridge re-issues a session, this
client re-handshakes once on a 404 and retries). Put a timeout on every call: on a
host with no interactive UI, a tool that needs approval neither runs nor errors —
it hangs, and only your timeout ends it.

Usage:
    python3 mcp-call.py --url URL --token TOKEN list
    python3 mcp-call.py --url URL --token TOKEN call bash '{"command":"adb devices"}'
    python3 mcp-call.py --url URL --token TOKEN call read '{"path":"xd://"}'

`--url`/`--token` also read from A2MCP_URL / A2MCP_TOKEN. Exit code is the caller's
signal: 0 on success, non-zero on auth error, transport error, or a tool result
flagged `isError`.
"""

import argparse
import json
import os
import sys
import urllib.error
import urllib.request

PROTOCOL_VERSION = "2025-11-25"


class BridgeError(Exception):
    pass


class SessionExpired(Exception):
    pass


class Client:
    def __init__(self, url, token, timeout):
        self.url = url.rstrip("/") + "/"
        self.token = token
        self.timeout = timeout
        self.sid = None
        self._id = 0

    def _post(self, payload, need_reply=True):
        self._id += 1
        if "id" not in payload:
            payload = {**payload, "id": self._id}
        headers = {
            "content-type": "application/json",
            "authorization": f"Bearer {self.token}",
        }
        if self.sid:
            headers["mcp-session-id"] = self.sid
        req = urllib.request.Request(
            self.url, data=json.dumps(payload).encode("utf-8"), headers=headers, method="POST"
        )
        try:
            with urllib.request.urlopen(req, timeout=self.timeout) as resp:
                sid = resp.headers.get("mcp-session-id")
                if sid:
                    self.sid = sid
                status = resp.status
                body = resp.read()
        except urllib.error.HTTPError as e:
            # The bridge signals session state with HTTP status, not JSON-RPC code.
            if e.code in (400, 404):
                raise SessionExpired(f"HTTP {e.code}: {e.reason}")
            if e.code == 401:
                raise BridgeError("401 unauthorized — the token does not match the bridge config")
            detail = e.read().decode("utf-8", "replace").strip()
            raise BridgeError(f"HTTP {e.code}: {detail or e.reason}")
        except urllib.error.URLError as e:
            raise BridgeError(f"cannot reach {self.url}: {e.reason}")

        if not need_reply:
            return None
        if status != 200:
            raise BridgeError(f"expected 200, got {status}")
        if not body:
            raise BridgeError("empty body for a request that expects a reply")
        try:
            msg = json.loads(body)
        except json.JSONDecodeError:
            raise BridgeError(f"response is not JSON: {body[:200]!r}")
        if "error" in msg:
            err = msg["error"]
            raise BridgeError(f"JSON-RPC error {err.get('code')}: {err.get('message')}")
        return msg.get("result", msg)

    def handshake(self):
        self.sid = None
        self._post({"jsonrpc": "2.0", "method": "initialize",
                    "params": {"protocolVersion": PROTOCOL_VERSION,
                               "capabilities": {},
                               "clientInfo": {"name": "mcp-call.py", "version": "1"}}},
                   need_reply=True)
        if not self.sid:
            raise BridgeError("initialize returned no mcp-session-id header")
        self._post({"jsonrpc": "2.0", "method": "notifications/initialized"}, need_reply=False)

    def _call(self, method, params):
        try:
            return self._post({"jsonrpc": "2.0", "method": method, "params": params})
        except SessionExpired:
            # One recovery: the session aged out or the host restarted. Re-handshake
            # and retry the single request; a second failure is real.
            self.handshake()
            return self._post({"jsonrpc": "2.0", "method": method, "params": params})

    def list_tools(self):
        return self._call("tools/list", {})

    def call_tool(self, name, arguments):
        return self._call("tools/call", {"name": name, "arguments": arguments})

    def close(self):
        if self.sid:
            try:
                req = urllib.request.Request(self.url, method="DELETE", headers={
                    "authorization": f"Bearer {self.token}", "mcp-session-id": self.sid})
                urllib.request.urlopen(req, timeout=self.timeout).read()
            except Exception:
                pass  # teardown is best-effort; the session expires on its own anyway


def emit_call_result(result):
    parts = result.get("content", []) if isinstance(result, dict) else []
    for part in parts:
        if part.get("type") == "text":
            sys.stdout.write(part.get("text", ""))
            if not part.get("text", "").endswith("\n"):
                sys.stdout.write("\n")
    if isinstance(result, dict) and result.get("isError"):
        sys.stderr.write("the tool reported isError\n")
        return 1
    return 0


def main(argv):
    ap = argparse.ArgumentParser(description="minimal MCP client for the a2mcp bridge")
    ap.add_argument("--url", default=os.environ.get("A2MCP_URL"), help="bridge URL (or A2MCP_URL)")
    ap.add_argument("--token", default=os.environ.get("A2MCP_TOKEN"), help="Bearer token (or A2MCP_TOKEN)")
    ap.add_argument("--timeout", type=float, default=30.0, help="per-call seconds (default 30)")
    ap.add_argument("--keep-session", action="store_true", help="skip the DELETE on exit")
    ap.add_argument("cmd", choices=["list", "call"])
    ap.add_argument("rest", nargs="*", help="for call: <tool-name> [json-arguments]")
    args = ap.parse_args(argv)

    if not args.url:
        ap.error("--url (or A2MCP_URL) is required")
    if not args.token:
        ap.error("--token (or A2MCP_TOKEN) is required")

    client = Client(args.url, args.token, args.timeout)
    try:
        client.handshake()
        if args.cmd == "list":
            res = client.list_tools()
            for tool in res.get("tools", []):
                desc = (tool.get("description") or "").splitlines()
                sys.stdout.write(f"{tool.get('name')}\t{desc[0] if desc else ''}\n")
            return 0

        if not args.rest:
            ap.error("call needs a tool name")
        name = args.rest[0]
        arguments = {}
        if len(args.rest) > 1:
            try:
                arguments = json.loads(args.rest[1])
            except json.JSONDecodeError as e:
                sys.stderr.write(f"arguments are not valid JSON: {e}\n")
                return 2
            if not isinstance(arguments, dict):
                sys.stderr.write("arguments must be a JSON object\n")
                return 2
        result = client.call_tool(name, arguments)
        return emit_call_result(result)
    except BridgeError as e:
        sys.stderr.write(f"mcp-call: {e}\n")
        return 1
    finally:
        if not args.keep_session:
            client.close()


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
