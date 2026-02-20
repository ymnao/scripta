import { getMockStore } from "./types";

export async function invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
	const store = getMockStore();
	if (!store.calls[cmd]) {
		store.calls[cmd] = [];
	}
	store.calls[cmd].push(args ?? {});

	const handler = store.handlers[cmd];
	if (handler) {
		return handler(args ?? {}) as T;
	}
	throw new Error(`No mock handler for command: ${cmd}`);
}

export function convertFileSrc(path: string): string {
	return `https://mock.tauri.local/${encodeURIComponent(path)}`;
}
