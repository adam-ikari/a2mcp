/**
 * Which repo file each site page is generated from — one list, two consumers.
 *
 * `sync.mjs` copies `docs/**` verbatim and derives `intro` / `changelog` /
 * `index` from three specific files, so the sitemap cannot map page → source by
 * path alone for those three. It used to keep its own copy of that list, which
 * is the shape this repo has been bitten by before: two things to remember when
 * a page moves, and nothing fails when only one of them moves. `render-check.mjs`
 * now verifies each `<lastmod>` against this same mapping, so the copy has to be
 * a module rather than a constant.
 */

/** Pages whose source is not `docs/<page>.md`. */
export const SOURCE_OF = {
	index: "README_ZN.md",
	intro: "README_ZN.md",
	changelog: "CHANGELOG.md",
	protocol: "docs/protocol.md",
	testing: "docs/testing.md",
};

/**
 * The repo file a built page came from, or undefined when nothing maps to it.
 * sync.mjs copies docs/** verbatim, so everything else falls back by path.
 *
 * The home page arrives here as an EMPTY name — `collect()` strips the `index`
 * suffix off `index.html` — so it is normalized to `index` before the lookup.
 * Without that, `SOURCE_OF.index` is dead code and the home page falls through to
 * the fallback, which is no source at all: its lastmod became the newest commit in
 * the repo rather than the date README_ZN.md changed. Invisible whenever the two
 * happen to be the same day, which is most days. Caught by render-check's
 * "maps to an existing source file" line.
 */
export function sourceOf(page) {
	const name = page === "" ? "index" : page;
	return SOURCE_OF[name] ?? (name ? `docs/${name}.md` : undefined);
}
