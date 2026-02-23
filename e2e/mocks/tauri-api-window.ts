type CloseRequestedEvent = {
	preventDefault: () => void;
};

type CloseHandler = (event: CloseRequestedEvent) => void | Promise<void>;

interface TauriWindowStore {
	closeHandler: CloseHandler | null;
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

	async destroy(): Promise<void> {
		// no-op in mock
	}
}

const mainWindow = new MockWindow();

export function getCurrentWindow(): MockWindow {
	return mainWindow;
}
