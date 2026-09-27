// Where pictures from the data may come from. The page CSP's img-src is built from this list
// (vite.config.ts), and every <img> from data goes through `imageSrc`, which drops a picture from
// anywhere else rather than have the browser block it: a venue's listing or a Wikipedia edit
// could otherwise point every visitor's browser at a server that logs them.
//
// A new venue whose pictures live elsewhere: add its image host here (look at `image` in
// data/site/gigs.json after `make data`).

/** Hostnames, `*.` for any subdomain (as in CSP: not the domain itself). */
export const IMAGE_HOSTS = [
	// Artists: YouTube Music (yt3/lh3… on Google's image CDNs) and Wikipedia.
	'*.googleusercontent.com',
	'*.ggpht.com',
	'upload.wikimedia.org',
	'thumb.wikimedia.org',
	// Gig pictures, from each venue's site or CDN.
	'backend.bimhuis.nl',
	'www.bitterzoet.com',
	'cdn.prod.website-files.com', // Cinetol (Webflow)
	'denieuweanita.nl',
	'ekko.nl',
	'assets.melkweg.nl',
	'img.muziekgebouw.nl',
	'nobel.nl',
	'assets.paradiso.nl',
	'patronaat.nl',
	'a.storyblok.com', // Q-Factory
	'media.tivolivredenburg.nl',
	'stadsherstel.nl' // Het Zonnehuis (run by Stadsherstel)
] as const;

/** The CSP img-src sources for IMAGE_HOSTS. */
export const IMAGE_SOURCES = IMAGE_HOSTS.map((host) => `https://${host}` as const);

function allowed(hostname: string): boolean {
	return IMAGE_HOSTS.some((host) =>
		host.startsWith('*.') ? hostname.endsWith(host.slice(1)) : hostname === host
	);
}

/** `url` if it's an https picture from one of IMAGE_HOSTS, fit for a `src`; else undefined. */
export function imageSrc(url: string | null | undefined): string | undefined {
	if (!url) return undefined;
	let parsed: URL;
	try {
		parsed = new URL(url.trim());
	} catch {
		return undefined;
	}
	if (parsed.protocol !== 'https:' || parsed.username || parsed.password) return undefined;
	return allowed(parsed.hostname) ? parsed.href : undefined;
}
