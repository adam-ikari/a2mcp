/**
 * Quick tunnel, managed in-process.
 *
 * cloudflared's "quick tunnel" (`cloudflared tunnel --url http://127.0.0.1:<port>`)
 * needs no account, no config file and no DNS: the process dials out, gets a
 * random `*.trycloudflare.com` hostname, and proxies it to the local address. That
 * dial-out shape is the whole reason it is here — the machines this bridge links
 * are typically both behind NAT with nothing forwarded (measured on the pair this
 * was written for: neither router answers UPnP, neither host accepts an inbound
 * connection on any port), so a tunnel that starts from the inside is the only
 * path that needs neither a router change nor a third-party account.
 *
 * The hostname is random per run and exists only in the child's output, so it is
 * parsed rather than configured, and `openQuickTunnel` resolves when it appears.
 *
 * What this does not do: retry, supervise, or survive. The URL is bound to the
 * process that has it, so a dead child means a dead URL — `stop()` is the only
 * lifecycle here, and a caller that wants a tunnel up longer than its request
 * keeps the handle and checks it.
 */
import { type ChildProcess, spawn } from "node:child_process";

/** The hostname cloudflared announces for a quick tunnel. */
const QUICK_URL = /https:\/\/[a-z0-9][a-z0-9-]*\.trycloudflare\.com/;

/** How much of the child's output to hold on to, in characters. */
const TRANSCRIPT_LIMIT = 64 * 1024;

export interface QuickTunnel {
	/** Public hostname, no trailing slash — e.g. `https://calm-river-xyz.trycloudflare.com`. */
	url: string;
	/** Local port the tunnel forwards to. */
	port: number;
	pid: number | undefined;
	stop(): Promise<void>;
}

export interface QuickTunnelOptions {
	/** Path or name of the cloudflared binary. */
	bin: string;
	/** Local port to expose. The tunnel targets `http://127.0.0.1:<port>`. */
	port: number;
	/** How long to wait for the hostname before giving up. Default 30s. */
	timeoutMs?: number;
	env?: NodeJS.ProcessEnv;
}

/** What `openQuickTunnel` promises — the seam tests replace. */
export type TunnelOpener = (opts: QuickTunnelOptions) => Promise<QuickTunnel>;

/**
 * Start a quick tunnel and wait for its hostname.
 *
 * Rejects with the child's own output when it exits early or never announces a
 * URL: "cloudflared not found" and "cloudflared refused the arguments" are the two
 * failures an operator actually hits, and both arrive here.
 */
export function openQuickTunnel(opts: QuickTunnelOptions): Promise<QuickTunnel> {
	const timeoutMs = opts.timeoutMs ?? 30_000;
	return new Promise((resolve, reject) => {
		let child: ChildProcess;
		try {
			child = spawn(opts.bin, ["tunnel", "--no-autoupdate", "--url", `http://127.0.0.1:${opts.port}`], {
				stdio: ["ignore", "pipe", "pipe"],
				env: opts.env ?? process.env,
			});
		} catch (e) {
			reject(new Error(`cannot start ${opts.bin}: ${(e as Error).message}`));
			return;
		}

		let out = "";
		let settled = false;
		const timer = setTimeout(() => {
			if (settled) return;
			settled = true;
			child.kill("SIGKILL");
			reject(new Error(`no quick-tunnel URL from ${opts.bin} within ${timeoutMs}ms; output: ${out.slice(-400)}`));
		}, timeoutMs);

		const onData = (chunk: Buffer) => {
			// Nothing is kept once the hostname is in hand: the transcript exists to find
			// it and to quote the child when there is none, and a quick tunnel is left
			// running for an hour at a time while cloudflared talks the whole way.
			// Dropping the data does not pause the stream, so the child is never the one
			// that blocks.
			if (settled) return;
			out += chunk.toString();
			const m = QUICK_URL.exec(out);
			if (!m) {
				// Still looking, so the buffer gets bounded, and by its tail: the newest
				// lines are what an operator needs to see when the child never announces
				// anything (both rejection messages quote the end of `out`), and a
				// hostname already scrolled past is not coming back. Halving rather than
				// trimming to the limit keeps a chatty child from re-slicing on every
				// line (test/tunnel.test.ts).
				if (out.length > TRANSCRIPT_LIMIT) out = out.slice(-TRANSCRIPT_LIMIT / 2);
				return;
			}
			settled = true;
			clearTimeout(timer);
			resolve({
				url: m[0],
				port: opts.port,
				pid: child.pid,
				// SIGTERM first: on unix cloudflared takes the hint and closes its edge
				// connections, which is what makes the URL stop answering promptly.
				// SIGKILL follows only if it is still alive a moment later, so a
				// wedged child cannot hold the hostname open. Windows has no signal to
				// take — `kill` there ends the process outright, so the first call is
				// the last one and the child exits without a graceful close.
				async stop() {
					if (child.exitCode !== null || child.signalCode !== null) return;
					const dead = new Promise<void>((r) => child.once("exit", () => r()));
					child.kill("SIGTERM");
					const killed = await Promise.race([dead.then(() => true), Bun.sleep(2000).then(() => false)]);
					if (!killed) {
						child.kill("SIGKILL");
						await dead;
					}
				},
			});
		};
		child.stdout?.on("data", onData);
		child.stderr?.on("data", onData);
		child.once("error", (e) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			reject(new Error(`cannot run ${opts.bin}: ${e.message}`));
		});
		child.once("exit", (code) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			reject(new Error(`${opts.bin} exited with code ${code} before announcing a URL; output: ${out.slice(-400)}`));
		});
	});
}
