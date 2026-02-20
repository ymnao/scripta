export interface TauriMockStore {
	handlers: Record<string, (args: Record<string, unknown>) => unknown>;
	calls: Record<string, Array<Record<string, unknown>>>;
	dialogResult: string | null;
}

export function getMockStore(): TauriMockStore {
	const win = window as Window & { __TAURI_MOCK__?: TauriMockStore };
	if (!win.__TAURI_MOCK__) {
		win.__TAURI_MOCK__ = {
			handlers: {},
			calls: {},
			dialogResult: null,
		};
	}
	return win.__TAURI_MOCK__;
}
