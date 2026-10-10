import { isAbsolute, relative, sep } from "node:path";

// `pathOps` を差し替え可能にしているのは host OS (macOS / Linux) 上から Windows 形式の
// 入力を verify するため。production code は default の host OS ops を使う。
export interface RelPathOps {
	relative: (from: string, to: string) => string;
	isAbsolute: (p: string) => boolean;
	sep: string;
}

const DEFAULT_REL_PATH_OPS: RelPathOps = { relative, isAbsolute, sep };

// `rel === ""` (root 自身) を含めないのは、root 自身を配下とみなすかが呼び出し側ごとに違うため。
// `rel.startsWith("..")` で書くと `..foo` のような正当な名前を root 外と誤読する。
// `isAbsolute(rel)` は win32 で drive をまたぐと relative() が絶対パスを返すため必要。
export function isRelOutsideRoot(rel: string, pathOps: RelPathOps = DEFAULT_REL_PATH_OPS): boolean {
	return rel === ".." || rel.startsWith(`..${pathOps.sep}`) || pathOps.isAbsolute(rel);
}

// 返す関数は、prefixes のいずれかについて「path と一致」または「path が prefix + sep
// (prefix が sep で終わるなら prefix そのもの) で始まる」なら true。
// prefix ごとに startsWith を回すと path 数 × prefix 数になり、watcher batch に非 `.md` event が
// 1000 件入ると cache 1 万件で秒単位かかるので、prefix の長さごとに path の先頭を切り出して
// Set で引く (長さの種類は path 長が上限)。path 側の sep を indexOf で全部辿る形にしなかったのは、
// prefix 1 件のとき startsWith より 1 桁遅かったため。
// 切り出し位置の直後が sep なら「prefix + sep で始まる」、直前が sep なら「sep で終わる prefix で
// 始まる」に当たる。どちらでもない位置は `/foo` と `/foobar` のような誤一致なので引かない。
export function atOrUnderMatcher(prefixes: ReadonlySet<string>): (path: string) => boolean {
	const sepCode = sep.charCodeAt(0);
	const lengths = [...new Set(Array.from(prefixes, (p) => p.length))];
	return (path) => {
		if (prefixes.has(path)) return true;
		for (const len of lengths) {
			if (len >= path.length) continue;
			if (path.charCodeAt(len) !== sepCode && path.charCodeAt(len - 1) !== sepCode) continue;
			if (prefixes.has(path.slice(0, len))) return true;
		}
		return false;
	};
}

// canonicalRoot 配下なら相対パスの component 列、canonicalRoot 自身または root 外なら null。
export function relComponentsUnderRoot(
	canonicalRoot: string,
	absPath: string,
	pathOps: RelPathOps = DEFAULT_REL_PATH_OPS,
): string[] | null {
	const rel = pathOps.relative(canonicalRoot, absPath);
	if (rel === "" || isRelOutsideRoot(rel, pathOps)) return null;
	return rel.split(pathOps.sep);
}
