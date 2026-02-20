const SEP_RE = /[\\/]/;

function getSep(path: string): string {
	const match = path.match(SEP_RE);
	return match ? match[0] : "/";
}

export function dirname(path: string): string {
	const sep = getSep(path);
	const lastIndex = path.lastIndexOf(sep);
	if (lastIndex === -1) return ".";
	if (lastIndex === 0) return sep;
	return path.slice(0, lastIndex);
}

export function joinPath(base: string, name: string): string {
	const sep = getSep(base);
	return base.endsWith(sep) ? `${base}${name}` : `${base}${sep}${name}`;
}

export function replaceName(path: string, newName: string): string {
	const sep = getSep(path);
	const lastIndex = path.lastIndexOf(sep);
	if (lastIndex === -1) return newName;
	return path.slice(0, lastIndex + 1) + newName;
}

export function addTrailingSep(path: string): string {
	const sep = getSep(path);
	return path.endsWith(sep) ? path : path + sep;
}

export function replacePrefix(path: string, oldPrefix: string, newPrefix: string): string {
	const oldWithSep = addTrailingSep(oldPrefix);
	if (!path.startsWith(oldWithSep)) return path;
	const newWithSep = addTrailingSep(newPrefix);
	return newWithSep + path.slice(oldWithSep.length);
}
