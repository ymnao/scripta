import { existsSync } from "node:fs";
import { relative, sep } from "node:path";
import type { FsKind } from "../../../src/types/workspace";

export type { FsKind };

// **root からの相対成分** のいずれかが '.' で始まれば hidden。
// 絶対パス全体を見ると、root 自体が hidden な祖先の下（例: `/Users/me/.notes/project`）
// にあった場合に root 配下のファイルも全部 hidden 扱いになり、watcher と
// search の挙動が食い違ってしまう。search 側 (walkMdFiles) は root 配下の
// エントリ名だけを見ているので、こちらも相対成分に揃える。
//
// root 自体（rel === ""）は hidden 扱いしない。root の外側（rel が `..` で始まる）も
// hidden ではないとする — chokidar は root 配下しか emit しない前提だが、防御的に false。
export function isHidden(p: string, root: string): boolean {
	const rel = relative(root, p);
	if (rel === "") return false;
	if (rel === ".." || rel.startsWith(`..${sep}`)) return false;
	for (const part of rel.split(sep)) {
		if (part.length > 0 && part.startsWith(".")) return true;
	}
	return false;
}

// 新しい event kind を pending Map にマージする。状態遷移ルール（旧 Rust 1:1）：
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
// macOS FSEvents は削除を modify として誤分類することがあるための救済（旧 Rust の
// reclassify_deleted と同じ挙動）。
//
// TOCTOU について：exists() チェック後にファイルが再生成されると "delete" が誤って
// 残るが、後続 batch の merge_event_kind で "delete + create → modify" に収束する。
// 旧 Rust と同じ判断（コメント L148-152 参照）。
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
