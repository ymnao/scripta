import type { EditorView } from "@codemirror/view";
import { act } from "@testing-library/react";
import type { RefObject } from "react";
import { vi } from "vitest";
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

export interface FakeEditor {
	/** useTabContentManager に渡す editorViewRef。 */
	ref: RefObject<EditorView | null>;
	/** 現在の doc (getContent() が返す値)。 */
	getContent: () => string;
	/** ユーザーの編集を模す。remount (editorKey / epoch bump) までは保持される。 */
	type: (content: string) => void;
	/** IME 変換中フラグ。isEditorComposing() が読む。 */
	setComposing: (composing: boolean) => void;
	/**
	 * remount / snapshot 復元を模して doc を loadedDoc で初期化し直す。
	 * 実 MarkdownEditor は uncontrolled で、editorKey bump による remount か
	 * restoreSnapshot でしか doc が外から置き換わらない。テスト側でも同じ境界を保つ。
	 */
	remountWith: (loadedDoc: string) => void;
	/** view を外す (SlideView 表示中など MarkdownEditor が mount されていない状態)。 */
	detach: () => void;
}

export function createFakeEditor(initialContent = ""): FakeEditor {
	let content = initialContent;
	let composing = false;
	const view = {
		get composing() {
			return composing;
		},
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
		setComposing: (next) => {
			composing = next;
		},
		remountWith: (loadedDoc) => {
			content = loadedDoc;
		},
		detach: () => {
			ref.current = null;
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
