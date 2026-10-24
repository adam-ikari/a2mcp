/**
 * Types for the pure half of `a2mcp-proxy.mjs`, so `bun run typecheck` can read
 * the imports in `test/proxy-lib.test.ts`. The script itself stays plain ESM.
 */

export const DEFAULT_CHUNK_BYTES: number;

export interface LocalTool {
	name: string;
	description: string;
	inputSchema: {
		type: "object";
		properties: Record<string, { type: string; description: string }>;
		required: string[];
	};
}

export const LOCAL_TOOLS: LocalTool[];

export function normalizeRemote(input: string): string;
export function isAbsoluteRemote(path: string): boolean;
export function covers(root: string, target: string): boolean;
export function relativeName(root: string, target: string): string;
export function dirnameRemote(input: string): string;
export function basenameRemote(input: string): string;
export function xferUrl(baseUrl: string, relative: string): string;
export function resolveLocalPath(input: string): string;
export function clampChunkBytes(value: unknown): number;
export function downloadResumeFrom(
	partSize: number,
	sidecar: { size?: number; etag?: string | null } | null,
	remote: { size: number; etag?: string | null },
): number;
export function planUploadResume(
	state: Record<string, unknown> | null | undefined,
	local: { path: string; size: number; mtimeMs: number },
	remoteSize: number,
): { start: number; resumed: boolean; prefixSha256?: string; refuse?: string };
export function parseArgs(
	argv: string[],
	env?: Record<string, string | undefined>,
): { url: string; token: string; chunkBytes: number; help: boolean };
