import { basename, sep } from "node:path";
import type { FsChangeEvent } from "../../../src/types/workspace";
import { byteCmp } from "./search-pure";

// canonical `.md` パス集合を single source of truth とし、
// query 側が使う派生物 (sorted / fileMap / existingStems) を lazy に構築する。
// invalidation 規約は「batch 適用で files が変われば epoch を +1 して派生物 3 つを null 化」の 1 行。
// files === null は「未 populate または保守的 full invalidate」を表す。
export interface FileListCacheState {
	epoch: number;
	files: Set<string> | null;
	sorted: readonly string[] | null;
	fileMap: ReadonlyMap<string, string> | null;
	existingStems: ReadonlySet<string> | null;
}

export function createCacheState(): FileListCacheState {
	return {
		epoch: 0,
		files: null,
		sorted: null,
		fileMap: null,
		existingStems: null,
	};
}

// populateFileListCache 完了時に walk 結果を格納する。以降の getSortedFiles 等で
// 派生物を lazy 構築するため、ここでは Set だけ差し替える。
export function setCacheFiles(state: FileListCacheState, files: readonly string[]): void {
	state.files = new Set(files);
	state.sorted = null;
	state.fileMap = null;
	state.existingStems = null;
}

// watcher batch を state に反映。
//   - `.md` create → files.add / `.md` delete → files.delete / `.md` modify → 無変更
//   - 非 `.md` の create / delete はディレクトリ or 未知エントリの可能性があるため
//     保守的に files を null に落として次回 miss で再 populate させる。
//     watcher.ts:94-98 は addDir/unlinkDir も同じ FsKind に畳んでおり、
//     batch payload からは file / dir を区別できないための安全側倒し。
//   - 非 `.md` modify と `.md` modify は無視 (Phase A の files 集合には影響しない)。
// 構造的変化 (create/delete のうち集合に効いたもの、および full invalidate) があれば
// epoch を +1 し、派生物 3 つを dirty にする。
// state.files が null の間 (populate 進行中 or 既 invalidate) でも create/delete イベントは
// 「populate 結果を stale 化する信号」として epoch を進める (populate 側の epoch guard で
// 「populate 中に workspace が変わった」ケースを弾くため)。
export function applyBatchToState(
	state: FileListCacheState,
	batch: ReadonlyArray<FsChangeEvent>,
): void {
	let shouldBump = false;
	for (const ev of batch) {
		// modify は Phase A の files 集合に影響しない (.md / 非 .md いずれも無視)。
		if (ev.kind === "modify") continue;
		if (state.files === null) {
			// populate 進行中 or 既 full-invalidate: 追記はできないが「変化があった」信号として
			// epoch を進める (populate 完了時の epoch guard を作動させる)。
			shouldBump = true;
			continue;
		}
		const isMd = ev.path.endsWith(".md");
		if (isMd) {
			if (ev.kind === "create") {
				const before = state.files.size;
				state.files.add(ev.path);
				if (state.files.size !== before) shouldBump = true;
			} else {
				if (state.files.delete(ev.path)) shouldBump = true;
			}
		} else {
			// 非 .md の create/delete は dir イベントかもしれない → 保守的 full invalidate
			state.files = null;
			shouldBump = true;
		}
	}
	if (shouldBump) {
		state.epoch++;
		state.sorted = null;
		state.fileMap = null;
		state.existingStems = null;
	}
}

// files 集合を byteCmp 昇順で sort した配列を返す。files === null なら null。
// dirty 時のみ再構築して memo する。
export function getSortedFiles(state: FileListCacheState): readonly string[] | null {
	if (state.files === null) return null;
	if (state.sorted !== null) return state.sorted;
	const arr = [...state.files];
	arr.sort(byteCmp);
	state.sorted = arr;
	return arr;
}

// stem (basename から `.md` を剥いで NFC 正規化) → canonical path の Map を構築。
// 同 stem が複数 path に存在するときは lexicographically smallest path を採用する
// (live-preview の buildFileMap / scanBacklinksImpl :488-496 と同一 tie-break)。
export function getFileMap(state: FileListCacheState): ReadonlyMap<string, string> | null {
	if (state.files === null) return null;
	if (state.fileMap !== null) return state.fileMap;
	const map = buildFileMapFrom(state.files);
	state.fileMap = map;
	return map;
}

// 「ワークスペースに存在するページ名の集合」= basename から `.md` を剥いで NFC 正規化。
// scanUnresolvedWikilinksImpl :409-414 と同一ロジック。
export function getExistingStems(state: FileListCacheState): ReadonlySet<string> | null {
	if (state.files === null) return null;
	if (state.existingStems !== null) return state.existingStems;
	const set = buildExistingStemsFrom(state.files);
	state.existingStems = set;
	return set;
}

// cache miss 経路 (watcher 非稼働時) から同一ロジックを共有するため export する。
export function buildFileMapFrom(files: Iterable<string>): Map<string, string> {
	const map = new Map<string, string>();
	for (const filePath of files) {
		const name = basename(filePath);
		if (!name.toLowerCase().endsWith(".md")) continue;
		const stem = name.slice(0, -3).normalize("NFC");
		if (stem === "") continue;
		const existing = map.get(stem);
		if (existing === undefined || filePath < existing) {
			map.set(stem, filePath);
		}
	}
	return map;
}

export function buildExistingStemsFrom(files: Iterable<string>): Set<string> {
	const set = new Set<string>();
	for (const filePath of files) {
		const name = basename(filePath);
		if (!name.toLowerCase().endsWith(".md")) continue;
		set.add(name.slice(0, -3).normalize("NFC"));
	}
	return set;
}

// canonical 配列 (sort 済み) を inputRoot 側の表記へ prefix 置換する。
// canonical と canonicalRoot が同一 prefix を共有するので、置換後も sort 順は保存される。
// canonicalRoot に対する rel が `..` を返す (境界外) 場合は防御的に canonical をそのまま返す。
export function canonicalToInputPaths(
	canonical: readonly string[],
	canonicalRoot: string,
	inputRoot: string,
): string[] {
	if (canonicalRoot === inputRoot) return [...canonical];
	const rootWithSep = canonicalRoot.endsWith(sep) ? canonicalRoot : canonicalRoot + sep;
	const result: string[] = new Array(canonical.length);
	for (let i = 0; i < canonical.length; i++) {
		const p = canonical[i];
		if (p === canonicalRoot) {
			result[i] = inputRoot;
			continue;
		}
		if (p.startsWith(rootWithSep)) {
			result[i] = inputRoot + sep + p.slice(rootWithSep.length);
		} else {
			// canonical prefix に一致しない (通常起きない) — 防御的に原文
			result[i] = p;
		}
	}
	return result;
}
