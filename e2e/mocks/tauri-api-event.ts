type EventHandler = (event: { payload: unknown }) => void;

interface TauriEventStore {
	listeners: Map<string, Set<EventHandler>>;
	emit: (event: string, payload: unknown) => void;
}

type WindowWithEvent = Window & { __TAURI_EVENT__: TauriEventStore };

const listeners = new Map<string, Set<EventHandler>>();

const win = window as unknown as WindowWithEvent;
win.__TAURI_EVENT__ = {
	listeners,
	emit(event: string, payload: unknown) {
		const handlers = listeners.get(event);
		if (handlers) {
			for (const handler of handlers) {
				handler({ payload });
			}
		}
	},
};

export async function emit(event: string, payload?: unknown): Promise<void> {
	const handlers = listeners.get(event);
	if (handlers) {
		for (const handler of handlers) {
			handler({ payload });
		}
	}
}

export async function listen<T>(
	event: string,
	handler: (event: { payload: T }) => void,
): Promise<() => void> {
	if (!listeners.has(event)) {
		listeners.set(event, new Set());
	}
	const handlers = listeners.get(event) as Set<EventHandler>;
	const wrappedHandler = handler as EventHandler;
	handlers.add(wrappedHandler);

	return () => {
		handlers.delete(wrappedHandler);
	};
}
