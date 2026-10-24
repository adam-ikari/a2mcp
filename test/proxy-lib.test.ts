/**
 * The client proxy's pure half (`scripts/a2mcp-proxy.mjs`).
 *
 * The path rules are the part that can be pinned without a host: how a remote path
 * is spelled once, what "inside the share" means on POSIX and on Windows, and when
 * a half-finished transfer may be continued. The transfer itself — real `dufs`, real
 * stdio — is `test/proxy-probe.ts`.
 */
import { describe, expect, test } from "bun:test";

import {
	basenameRemote,
	clampChunkBytes,
	covers,
	DEFAULT_CHUNK_BYTES,
	dirnameRemote,
	downloadResumeFrom,
	isAbsoluteRemote,
	LOCAL_TOOLS,
	normalizeRemote,
	parseArgs,
	planUploadResume,
	relativeName,
	resolveLocalPath,
	xferUrl,
} from "../scripts/a2mcp-proxy.mjs";

describe("remote paths", () => {
	test("one spelling: forward slashes, no dot segments, no trailing slash", () => {
		expect(normalizeRemote("/a//b/./c/")).toBe("/a/b/c");
		expect(normalizeRemote("C:\\work\\file.bin")).toBe("C:/work/file.bin");
		expect(normalizeRemote("//server/share/dir/file")).toBe("//server/share/dir/file");
		expect(normalizeRemote("~/dir/file")).toBe("~/dir/file");
		expect(normalizeRemote("/")).toBe("/");
		expect(normalizeRemote("C:/")).toBe("C:/");
		expect(normalizeRemote("~")).toBe("~");
	});

	test("'..' is refused rather than resolved, and a relative path is refused", () => {
		expect(() => normalizeRemote("/a/../b")).toThrow("'..'");
		expect(() => normalizeRemote("a/b")).toThrow("not an absolute host path");
		expect(() => normalizeRemote("/a\0b")).toThrow("NUL");
		expect(() => normalizeRemote("//server")).toThrow("UNC");
		expect(isAbsoluteRemote("~")).toBe(false);
		expect(isAbsoluteRemote("/x")).toBe(true);
	});

	test("covers is lexical, and Windows drives and UNC compare without case", () => {
		expect(covers("/srv/share", "/srv/share/a/b")).toBe(true);
		expect(covers("/srv/share", "/srv/share")).toBe(true);
		expect(covers("/srv/share", "/srv/share-other/a")).toBe(false);
		expect(covers("C:/Data", "c:/data/file.bin")).toBe(true);
		expect(covers("//Server/Share", "//server/share/x")).toBe(true);
		expect(covers("~/dir", "~/dir/x")).toBe(true);
		expect(covers("/srv/A", "/srv/a")).toBe(false);
	});

	test("the name under the root is empty for the root itself, and each segment is encoded", () => {
		expect(relativeName("/srv/share", "/srv/share")).toBe("");
		expect(relativeName("/srv/share", "/srv/share/a b#c.txt")).toBe("a%20b%23c.txt");
		expect(relativeName("C:/Data", "c:/data/Sub/file")).toBe("Sub/file");
		expect(relativeName("//server/share", "//SERVER/share/x")).toBe("x");
		expect(() => relativeName("/srv/share", "/etc/passwd")).toThrow("outside");
	});

	test("dirname and basename keep the platform's root", () => {
		expect(dirnameRemote("/a/b")).toBe("/a");
		expect(dirnameRemote("/a")).toBe("/");
		expect(dirnameRemote("/")).toBe("/");
		expect(dirnameRemote("C:/a/b")).toBe("C:/a");
		expect(dirnameRemote("C:/a")).toBe("C:/");
		expect(dirnameRemote("//server/share/a")).toBe("//server/share");
		expect(dirnameRemote("//server/share")).toBe("//server/share");
		expect(dirnameRemote("~/a")).toBe("~");
		expect(dirnameRemote("~/a/b")).toBe("~/a");
		expect(basenameRemote("/a/b c.txt")).toBe("b c.txt");
	});

	test("the route URL is built from the caller's own base, not from a share's loopback", () => {
		expect(xferUrl("http://127.0.0.1:8787/", "")).toBe("http://127.0.0.1:8787/xfer/");
		expect(xferUrl("https://edge.example", "dir/a%20b.bin")).toBe("https://edge.example/xfer/dir/a%20b.bin");
	});

	test("the local path resolves ~ and relative paths against this machine", () => {
		expect(resolveLocalPath("/tmp/x")).toBe("/tmp/x");
		expect(resolveLocalPath("x").endsWith("/x")).toBe(true);
	});
});

describe("chunk and resume decisions", () => {
	test("the chunk size is clamped to the route's limits", () => {
		expect(clampChunkBytes(undefined)).toBe(DEFAULT_CHUNK_BYTES);
		expect(clampChunkBytes(1)).toBe(4096);
		expect(clampChunkBytes(65536)).toBe(65536);
		expect(clampChunkBytes("65536")).toBe(65536);
		expect(clampChunkBytes(1024 * 1024 * 1024)).toBe(64 * 1024 * 1024);
		expect(clampChunkBytes("nonsense")).toBe(DEFAULT_CHUNK_BYTES);
	});

	test("a download resumes only from a part that is the same remote file", () => {
		const remote = { size: 100, etag: "abc" };
		expect(downloadResumeFrom(40, { size: 100, etag: "abc" }, remote)).toBe(40);
		expect(downloadResumeFrom(40, { size: 100 }, remote)).toBe(40);
		expect(downloadResumeFrom(40, { size: 100, etag: "old" }, remote)).toBe(0);
		expect(downloadResumeFrom(40, { size: 99, etag: "abc" }, remote)).toBe(0);
		expect(downloadResumeFrom(101, { size: 100, etag: "abc" }, remote)).toBe(0);
		expect(downloadResumeFrom(0, { size: 100, etag: "abc" }, remote)).toBe(0);
		expect(downloadResumeFrom(40, null, remote)).toBe(0);
	});

	test("an upload continues only its own interrupted transfer", () => {
		const local = { path: "/local/file", size: 30, mtimeMs: 1234 };
		const state = { source: "/local/file", size: 30, mtimeMs: 1234, sent: 10, prefixSha256: "aa" };
		expect(planUploadResume(null, local, 0)).toEqual({ start: 0, resumed: false });
		expect(planUploadResume(state, local, 10)).toEqual({ start: 10, resumed: true, prefixSha256: "aa" });
		expect(planUploadResume(null, local, 10).refuse).toContain("10 bytes");
		expect(planUploadResume({ ...state, source: "/elsewhere" }, local, 10).refuse).toContain("different local file");
		expect(planUploadResume({ ...state, size: 31 }, local, 10).refuse).toContain("was 31 bytes");
		expect(planUploadResume({ ...state, mtimeMs: 9 }, local, 10).refuse).toContain("changed");
		expect(planUploadResume({ ...state, sent: 9 }, local, 10).refuse).toContain("reached 9 bytes");
		expect(planUploadResume({ ...state, prefixSha256: undefined }, local, 10).refuse).toContain("checksum");
	});
});

describe("command line", () => {
	test("flags override the environment, and the environment is the default", () => {
		const env = { A2MCP_URL: "http://env/", A2MCP_TOKEN: "env-token", A2MCP_CHUNK_BYTES: "8192" };
		expect(parseArgs([], env)).toEqual({ url: "http://env/", token: "env-token", chunkBytes: 8192, help: false });
		expect(parseArgs(["--url", "http://argv/", "--token=t", "--chunk-bytes", "16384"], env)).toEqual({
			url: "http://argv/",
			token: "t",
			chunkBytes: 16384,
			help: false,
		});
		expect(parseArgs(["--help"], env).help).toBe(true);
		expect(() => parseArgs(["--nope"], env)).toThrow("unknown argument");
	});

	test("the two local tools name both machines, and say bytes stay out of the conversation", () => {
		const names = LOCAL_TOOLS.map((t) => t.name);
		expect(names).toEqual(["a2mcp_upload", "a2mcp_download"]);
		for (const tool of LOCAL_TOOLS) {
			expect(tool.description).toContain("MCP conversation");
			expect(tool.inputSchema.required.length).toBe(2);
		}
	});
});
