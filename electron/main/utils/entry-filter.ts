import { relative, sep } from "node:path";
import { DEFAULT_FILE_TREE_EXCLUDE_PATTERNS } from "../../../src/types/file-tree";

export { DEFAULT_FILE_TREE_EXCLUDE_PATTERNS };

export interface EntryFilterOptions {
	showHidden: boolean;
	excludePatterns: string;
}

// isDir = undefined は「呼び出し側が dir/file の判別を持っていない」を表す（chokidar の
// initial scan で stats なし時など）。その場合は dir/file 両方の解釈で評価し、どちらかが
// hide なら hide。`.git/` のような dirOnly パターンでも初期スキャンで確実に skip される。
export type EntryFilter = (absPath: string, isDir: boolean | undefined) => boolean;

export function createEntryFilter(opts: EntryFilterOptions, root: string): EntryFilter {
	const matcher = getMatcher(opts.excludePatterns);
	return (absPath, isDir) => {
		const rel = toRel(absPath, root);
		if (rel === null) return true;
		if (!opts.showHidden && hasHiddenComponent(rel)) return false;
		if (isDir === undefined) {
			if (matcher.isMatched(rel, true) || matcher.isMatched(rel, false)) return false;
		} else if (matcher.isMatched(rel, isDir)) {
			return false;
		}
		return true;
	};
}

// root 自体（rel === ""）と root 外（`..` 始まり）は対象外。
function toRel(absPath: string, root: string): string | null {
	const rel = relative(root, absPath);
	if (rel === "") return null;
	if (rel === ".." || rel.startsWith(`..${sep}`)) return null;
	return sep === "/" ? rel : rel.split(sep).join("/");
}

function hasHiddenComponent(rel: string): boolean {
	for (const part of rel.split("/")) {
		if (part.length > 0 && part.startsWith(".")) return true;
	}
	return false;
}

interface ParsedRule {
	regex: RegExp;
	negate: boolean;
	dirOnly: boolean;
}

interface GitignoreMatcher {
	isMatched(relPath: string, isDir: boolean): boolean;
}

// 同一 content 文字列に対する matcher コンパイル結果を 1 枠だけキャッシュする。
// 設定が変わらなければ getFileTreeFilterOptions() は cache から同じ string 参照を
// 返すため、listDirectory / chokidar の ignored callback など hot path で
// 毎回 RegExp を再構築せずに済む。
let memoKey: string | null = null;
let memoMatcher: GitignoreMatcher | null = null;

function getMatcher(content: string): GitignoreMatcher {
	if (memoKey === content && memoMatcher !== null) return memoMatcher;
	memoMatcher = parsePatterns(content);
	memoKey = content;
	return memoMatcher;
}

function parsePatterns(content: string): GitignoreMatcher {
	const rules: ParsedRule[] = [];
	for (const line of content.split(/\r?\n/)) {
		const parsed = parsePatternLine(line);
		if (parsed !== null) rules.push(parsed);
	}
	return {
		isMatched(relPath: string, isDir: boolean): boolean {
			let matched = false;
			for (const rule of rules) {
				const m = rule.regex.exec(relPath);
				if (m === null) continue;
				if (rule.dirOnly) {
					// dirOnly パターン（`cache/` 等）は「先祖ディレクトリとしてマッチ」
					// （path 中央でマッチ、後ろに `/`...）なら isDir 問わず適用する。
					// 「葉自体でマッチ」（relPath 末端）なら isDir=true のときだけ適用する。
					// これにより `cache/` を書いたら `cache/keep.md` のような子も hide される
					// （gitignore の標準挙動と一致）。
					const matchedAtLeaf = m.index + m[0].length === relPath.length;
					if (matchedAtLeaf && !isDir) continue;
				}
				matched = !rule.negate;
			}
			return matched;
		},
	};
}

function parsePatternLine(rawLine: string): ParsedRule | null {
	let line = rawLine.trim();
	if (line === "" || line.startsWith("#")) return null;

	let negate = false;
	if (line.startsWith("!")) {
		negate = true;
		line = line.slice(1);
	}

	let dirOnly = false;
	if (line.endsWith("/")) {
		dirOnly = true;
		line = line.slice(0, -1);
	}
	if (line === "") return null;

	let anchored = false;
	if (line.startsWith("**/")) {
		line = line.slice(3);
	} else if (line.startsWith("/")) {
		anchored = true;
		line = line.slice(1);
	} else if (line.includes("/")) {
		// 内部に `/` を含むパターンは root アンカー扱い（gitignore 仕様）
		anchored = true;
	}
	if (line === "") return null;

	const body = globToRegexBody(line);
	const regexStr = anchored ? `^${body}(?:/|$)` : `(?:^|/)${body}(?:/|$)`;
	return { regex: new RegExp(regexStr), negate, dirOnly };
}

function globToRegexBody(glob: string): string {
	let result = "";
	let i = 0;
	while (i < glob.length) {
		const c = glob[i];
		if (c === "*") {
			if (glob[i + 1] === "*") {
				if (glob[i + 2] === "/") {
					result += "(?:.*/)?";
					i += 3;
				} else {
					result += ".*";
					i += 2;
				}
			} else {
				result += "[^/]*";
				i += 1;
			}
		} else if (c === "?") {
			result += "[^/]";
			i += 1;
		} else if (/[.+^$()|[\]\\{}]/.test(c)) {
			result += `\\${c}`;
			i += 1;
		} else {
			result += c;
			i += 1;
		}
	}
	return result;
}

export const __testing = {
	parsePatterns,
	clearMatcherCache(): void {
		memoKey = null;
		memoMatcher = null;
	},
};
