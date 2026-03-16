const NEW_TAB_PREFIX = "newtab://";

export function isNewTabPath(path: string): boolean {
	return path.startsWith(NEW_TAB_PREFIX);
}

export function createNewTabPath(id: number): string {
	return `${NEW_TAB_PREFIX}${id}`;
}

export const SEP_RE = /[\\/]/;

function getSep(path: string): string {
	const match = path.match(SEP_RE);
	return match ? match[0] : "/";
}

export function dirname(path: string): string {
	const sep = getSep(path);
	const lastIndex = path.lastIndexOf(sep);
	if (lastIndex === -1) return ".";
	if (lastIndex === 0) return sep;
	const parent = path.slice(0, lastIndex);
	// Preserve drive root (e.g. "C:" → "C:\")
	if (parent.endsWith(":")) return parent + sep;
	return parent;
}

export function joinPath(base: string, name: string): string {
	if (base === "") return name;
	const sep = getSep(base);
	return base.endsWith(sep) ? `${base}${name}` : `${base}${sep}${name}`;
}

export function replaceName(path: string, newName: string): string {
	const sep = getSep(path);
	const lastIndex = path.lastIndexOf(sep);
	if (lastIndex === -1) return newName;
	return path.slice(0, lastIndex + 1) + newName;
}

export function basename(path: string): string {
	const sep = getSep(path);
	const lastIndex = path.lastIndexOf(sep);
	if (lastIndex === -1) return path;
	return path.slice(lastIndex + 1);
}

export function addTrailingSep(path: string): string {
	const sep = getSep(path);
	return path.endsWith(sep) ? path : path + sep;
}

export function toRelativePath(workspacePath: string, absolutePath: string): string {
	const prefix = addTrailingSep(workspacePath);
	const relative = absolutePath.startsWith(prefix)
		? absolutePath.slice(prefix.length)
		: absolutePath;
	return relative.replace(/\\/g, "/");
}

export function replacePrefix(path: string, oldPrefix: string, newPrefix: string): string {
	if (path === oldPrefix) return newPrefix;
	const oldWithSep = addTrailingSep(oldPrefix);
	if (!path.startsWith(oldWithSep)) return path;
	const newWithSep = addTrailingSep(newPrefix);
	return newWithSep + path.slice(oldWithSep.length);
}
