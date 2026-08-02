import type { EditorView } from "@codemirror/view";
import { act } from "@testing-library/react";
import type { RefObject } from "react";
import { type Mock, vi } from "vitest";
import type { MarkdownEditorHandle } from "../components/editor/MarkdownEditor";
import { type Tab, useWorkspaceStore } from "../stores/workspace";

/**
 * useTabContentManager / AppLayout 系の hook テスト用 fixture。
 *
 * 方針: cache (tabCacheRef) は hook の非公開表現なので直接触らず、公開 API 経由でのみ
 * seed / 観測する。ここが提供するのは「実 CodeMirror の代わりに getContent() が読む doc」と
 * 「store の seed」「deferred な IO」だけ。
 */

export interface Deferred<T> {
	promise: Promise<T>;
	resolve: (value: T) => void;
	reject: (reason: unknown) => void;
}

/**
 * 解決タイミングを手で制御できる promise。
 * executor は同期実行されるため definite assignment assertion (`!`) が正当化される
 * (`let resolve: ... | null = null` だと TS の CFA が never に落として TS2349 になる)。
 */
export function createDeferred<T>(): Deferred<T> {
	let resolve!: (value: T) => void;
	let reject!: (reason: unknown) => void;
	const promise = new Promise<T>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}

/**
 * 実 CodeMirror の代わりに getContent() が読む doc を持つ fake。
 *
 * 未対応の境界: 実 AppLayout は activeTabPath が null / newtab のとき MarkdownEditor 自体を
 * unmount して editorViewRef を null にするが、この fake は view を保持し続けるため
 * getContent() が旧タブの doc を返す。その状態で getContent() を観測する test を書くときは
 * `ref.current` を手で null にすること。
 */
export interface FakeEditor {
	/** useTabContentManager に渡す editorViewRef。 */
	ref: RefObject<EditorView | null>;
	/** 現在の doc (getContent() が返す値)。 */
	getContent: () => string;
	/** ユーザーの編集を模す。remount (editorKey / epoch bump) までは保持される。 */
	type: (content: string) => void;
	/**
	 * remount を模して doc を loadedDoc で初期化し直す。
	 * 実 MarkdownEditor は uncontrolled で、editorKey bump による remount か
	 * restoreSnapshot でしか doc が外から置き換わらない。テスト側でも同じ境界を保つ。
	 */
	remountWith: (loadedDoc: string) => void;
	/**
	 * remountWith が呼ばれた回数。restore 成功時は remount しない (view identity を
	 * 保ったまま state だけ差し替える) という区別を、doc の値ではなく経路で観測するために使う。
	 * 復元内容と loadedDoc は一致するのが常態なので、doc を見ても両経路を区別できない。
	 */
	getRemountCount: () => number;
	/**
	 * この editor に紐づく MarkdownEditorHandle の fake を作る。
	 * 実 MarkdownEditor が自分の view を closure に持って useImperativeHandle を
	 * 組むのと同じ所有関係にしてあり、doc を restore 経由で書き換える手段は
	 * この handle の中だけに閉じている (remountWith と混同できない)。
	 */
	createSnapshotHandle: () => FakeSnapshotHandle;
}

/** captureSnapshot が返す不透明トークン。中身は fake 側の実装詳細。 */
interface FakeSnapshotToken {
	kind: "fake-snapshot";
	doc: string;
}

function isFakeSnapshotToken(value: unknown): value is FakeSnapshotToken {
	return (
		typeof value === "object" &&
		value !== null &&
		(value as { kind?: unknown }).kind === "fake-snapshot"
	);
}

/**
 * MarkdownEditorHandle (captureSnapshot / restoreSnapshot) の fake。
 *
 * 実物は EditorState を JSON 化 / 復元するが、ここが模すのは
 * 「capture した時点の doc が restore で戻る」という往復の性質だけ。
 * restore が doc を戻さないと「復帰後に capture すると別タブの doc が取れる」等、
 * harness が実配線と乖離した状態を作ってしまう。
 *
 * 呼び出し履歴は vi.fn の mock.calls / mock.results から読む (リポジトリの既存慣行)。
 */
export interface FakeSnapshotHandle extends MarkdownEditorHandle {
	captureSnapshot: Mock<() => unknown>;
	restoreSnapshot: Mock<(snapshot: unknown) => boolean>;
	/** true の間 captureSnapshot は null を返す (MarkdownEditor 未 mount 時の実挙動)。 */
	captureReturnsNull: boolean;
	/** true の間 restoreSnapshot は false を返す (EditorState.fromJSON 失敗の実挙動)。 */
	restoreFails: boolean;
}

export function createFakeEditor(initialContent = ""): FakeEditor {
	let content = initialContent;
	let remountCount = 0;
	const view = {
		composing: false,
		state: {
			doc: {
				toString: () => content,
			},
		},
	} as unknown as EditorView;
	const ref: RefObject<EditorView | null> = { current: view };
	return {
		ref,
		getContent: () => content,
		type: (next) => {
			content = next;
		},
		remountWith: (loadedDoc) => {
			remountCount += 1;
			content = loadedDoc;
		},
		getRemountCount: () => remountCount,
		createSnapshotHandle: () => {
			const handle: FakeSnapshotHandle = {
				captureReturnsNull: false,
				restoreFails: false,
				captureSnapshot: vi.fn((): unknown =>
					handle.captureReturnsNull
						? null
						: ({ kind: "fake-snapshot", doc: content } satisfies FakeSnapshotToken),
				),
				restoreSnapshot: vi.fn((snapshot: unknown): boolean => {
					if (handle.restoreFails || !isFakeSnapshotToken(snapshot)) return false;
					content = snapshot.doc;
					return true;
				}),
			};
			return handle;
		},
	};
}

export interface SeedTabOptions {
	path: string;
	dirty?: boolean;
}

/**
 * workspace store にタブを並べる。activePath を省略すると activeTab なし
 * (タブ切替 effect が readFile を発行しない状態) になる。
 */
export function seedWorkspace(
	workspacePath: string,
	tabs: (string | SeedTabOptions)[],
	activePath?: string | null,
): Tab[] {
	const seeded: Tab[] = tabs.map((entry, index) => {
		const { path, dirty = false } = typeof entry === "string" ? { path: entry } : entry;
		return { id: index + 1, path, dirty, history: [path], historyIndex: 0 };
	});
	const active = activePath ? (seeded.find((t) => t.path === activePath) ?? null) : null;
	useWorkspaceStore.setState({
		workspacePath,
		tabs: seeded,
		activeTabPath: active?.path ?? null,
		activeTabId: active?.id ?? null,
		_nextTabId: seeded.length + 1,
		fileTreeVersion: 0,
		contentVersion: 0,
	});
	return seeded;
}

/** store をテスト間で共有しないよう初期状態へ戻す。 */
export function resetWorkspace(): void {
	useWorkspaceStore.setState({
		workspacePath: null,
		tabs: [],
		activeTabPath: null,
		activeTabId: null,
		_nextTabId: 1,
		fileTreeVersion: 0,
		contentVersion: 0,
	});
}

/** タブのパス一覧 (順序込み)。prefix 境界の assert に使う。 */
export function tabPaths(): string[] {
	return useWorkspaceStore.getState().tabs.map((t) => t.path);
}

/** 保留中の microtask を流す。readFile/writeFile の .then 連鎖の同期点。 */
export async function flushAsync(): Promise<void> {
	await act(async () => {
		await Promise.resolve();
		await Promise.resolve();
	});
}

/** fake timer を進めつつ microtask も流す (autosave debounce と write の噛み合わせ用)。 */
export async function advance(ms: number): Promise<void> {
	await act(async () => {
		await vi.advanceTimersByTimeAsync(ms);
	});
}
