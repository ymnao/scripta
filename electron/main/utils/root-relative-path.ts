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
