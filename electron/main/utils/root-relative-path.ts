import { isAbsolute, relative, sep } from "node:path";

// canonicalRoot 配下なら相対パスの component 列、canonicalRoot 自身または root 外なら null。
//
// 判定を `rel.startsWith("..")` で書くと `..foo` のような component を root 外と誤読して
// 呼び出し側の filter を素通りさせる。`isAbsolute(rel)` は win32 で drive をまたぐと
// relative() が絶対パスを返すため必要 (component 列として扱うと `.` 始まりの component を
// 持つ別 drive の path が「root 配下の hidden」に化ける)。
export function relComponentsUnderRoot(canonicalRoot: string, absPath: string): string[] | null {
	const rel = relative(canonicalRoot, absPath);
	if (rel === "" || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return null;
	return rel.split(sep);
}
