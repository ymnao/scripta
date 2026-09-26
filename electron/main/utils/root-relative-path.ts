import { isAbsolute, relative, sep } from "node:path";

// `pathOps` を差し替え可能にしているのは host OS (macOS / Linux) 上から Windows 形式の
// 入力を verify するため (renderer-url.ts の PathOps と同じ理由・同じ形)。production code は
// default の host OS ops を使う。
export interface RelPathOps {
	relative: (from: string, to: string) => string;
	isAbsolute: (p: string) => boolean;
	sep: string;
}

const DEFAULT_REL_PATH_OPS: RelPathOps = { relative, isAbsolute, sep };

// canonicalRoot 配下なら相対パスの component 列、canonicalRoot 自身または root 外なら null。
//
// 判定を `rel.startsWith("..")` で書くと `..foo` のような component を root 外と誤読して
// 呼び出し側の filter を素通りさせる。`isAbsolute(rel)` は win32 で drive をまたぐと
// relative() が絶対パスを返すため必要 (component 列として扱うと `.` 始まりの component を
// 持つ別 drive の path が「root 配下の hidden」に化ける)。
export function relComponentsUnderRoot(
	canonicalRoot: string,
	absPath: string,
	pathOps: RelPathOps = DEFAULT_REL_PATH_OPS,
): string[] | null {
	const rel = pathOps.relative(canonicalRoot, absPath);
	if (rel === "" || rel === ".." || rel.startsWith(`..${pathOps.sep}`)) return null;
	if (pathOps.isAbsolute(rel)) return null;
	return rel.split(pathOps.sep);
}
