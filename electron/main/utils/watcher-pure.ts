import { existsSync } from "node:fs";
import { relative, sep } from "node:path";
import type { FsKind } from "../../../src/types/workspace";

export type { FsKind };

// 性能対策のためのハードコード除外。watcher の役割は外部変更の検知（タブの reload /
// conflict 経路）なので、ユーザー設定の FileTree フィルタには紐付けない。`.git/` 配下は
// git 操作で大量のファイル変更が走るため、tracking してもユーザー価値がなくノイズになる。
// `node_modules/` 配下も依存パッケージの大量ファイルを監視することになり性能ノイズになる
// ため同様に除外する。FileTree のデフォルト除外には node_modules がないため「ツリーに見えるが
// 監視されない」非対称が生じるが、node_modules 内のノート編集は想定外として受容済み（#299）。
// また path component 単位で判定するため、`node_modules` という名前のプレーンファイル
// （拡張子なし）は file/dir 区別なく ignore 対象になる。FileTree 側 (entry-filter.ts) は
// gitignore-style `node_modules/` の dirOnly マッチでプレーンファイルを表示するため、
// 「ツリーには見えるが監視されない」非対称がこの edge case でも生じるが、そのような名前の
// ノートが発生するケースは通常なく、過剰除外は実害なしと判断（`.git` と同じ扱い）。
// `.gitignore` や `.scripta/scratchpads/*.md` のような hidden path は通常通り監視する
// （ユーザーが開いて編集する可能性がある）。
export function isWatcherIgnored(absPath: string, canonicalRoot: string): boolean {
	const rel = relative(canonicalRoot, absPath);
	if (rel === "") return false;
	if (rel === ".." || rel.startsWith(`..${sep}`)) return false;
	for (const part of rel.split(sep)) {
		if (part === ".git" || part === "node_modules") return true;
	}
	return false;
}

// 新しい event kind を pending Map にマージする。状態遷移ルール：
//   - create + modify → keep create（modification は creation の一部）
//   - create + delete → エントリ削除（net no-op）
//   - delete + create → modify（再作成）
//   - その他           → 後勝ち
export function mergeEventKind(pending: Map<string, FsKind>, path: string, kind: FsKind): void {
	const prev = pending.get(path);
	if (prev === "create" && kind === "modify") return; // keep create
	if (prev === "create" && kind === "delete") {
		pending.delete(path);
		return;
	}
	if (prev === "delete" && kind === "create") {
		pending.set(path, "modify");
		return;
	}
	pending.set(path, kind);
}

// pending の "modify" を、対象パスが存在しなければ "delete" に昇格する。
// macOS FSEvents は削除を modify として誤分類することがあるための救済。
//
// TOCTOU について：exists() チェック後にファイルが再生成されると "delete" が誤って
// 残るが、後続 batch の merge_event_kind で "delete + create → modify" に収束する。
export function reclassifyDeleted(
	pending: Map<string, FsKind>,
	exists: (p: string) => boolean = existsSync,
): void {
	const toReclassify: string[] = [];
	for (const [path, kind] of pending) {
		if (kind === "modify" && !exists(path)) toReclassify.push(path);
	}
	for (const path of toReclassify) {
		pending.set(path, "delete");
	}
}
