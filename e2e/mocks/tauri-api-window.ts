type CloseRequestedEvent = {
	preventDefault: () => void;
};

type CloseHandler = (event: CloseRequestedEvent) => void | Promise<void>;

interface TauriWindowStore {
	closeHandler: CloseHandler | null;
	closeCalled?: boolean;
	destroyed?: boolean;
}

type WindowWithStore = Window & { __TAURI_WINDOW__: TauriWindowStore };

const win = window as unknown as WindowWithStore;
win.__TAURI_WINDOW__ = {
	closeHandler: null,
};

class MockWindow {
	async onCloseRequested(handler: CloseHandler): Promise<() => void> {
		win.__TAURI_WINDOW__.closeHandler = handler;
		return () => {
			win.__TAURI_WINDOW__.closeHandler = null;
		};
	}

	async close(): Promise<void> {
		win.__TAURI_WINDOW__.closeCalled = true;
		const handler = win.__TAURI_WINDOW__.closeHandler;
		if (handler) {
			await handler({ preventDefault: () => {} });
		}
	}

	async destroy(): Promise<void> {
		win.__TAURI_WINDOW__.destroyed = true;
	}
}

const mainWindow = new MockWindow();

export function getCurrentWindow(): MockWindow {
	return mainWindow;
}
