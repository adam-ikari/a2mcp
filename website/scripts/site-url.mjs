/**
 * The site's absolute origin, derived the way .vitepress/config.ts derives it:
 * the published GitHub Pages host, or the local dev server.
 *
 * One module, two consumers (sitemap.mjs and llms.mjs), because the origin is
 * derived from the environment and a second copy is a second thing to forget
 * when the repo moves. `SITE_URL` overrides it for a preview that is not
 * either of those.
 */
export function siteUrl() {
	const [owner, repo] = (process.env.GITHUB_REPOSITORY ?? "").split("/");
	const isUserSite = repo === `${owner}.github.io`;
	const base = isUserSite ? "/" : `/${repo}/`;
	const url = owner && repo ? `https://${owner}.github.io${base}` : "http://localhost:5173/";
	return (process.env.SITE_URL ?? url).replace(/\/?$/, "/");
}
