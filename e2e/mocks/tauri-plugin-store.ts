type WindowWithStoreInit = Window & { __STORE_INIT__?: Record<string, unknown> };

const memoryStore = new Map<string, unknown>();
const initData = (window as unknown as WindowWithStoreInit).__STORE_INIT__;
if (initData) {
	for (const [key, value] of Object.entries(initData)) {
		memoryStore.set(key, value);
	}
}

interface Store {
	get<T>(key: string): Promise<T | undefined>;
	set(key: string, value: unknown): Promise<void>;
	delete(key: string): Promise<void>;
	save(): Promise<void>;
}

const storeInstance: Store = {
	async get<T>(key: string): Promise<T | undefined> {
		return memoryStore.get(key) as T | undefined;
	},
	async set(key: string, value: unknown): Promise<void> {
		memoryStore.set(key, value);
	},
	async delete(key: string): Promise<void> {
		memoryStore.delete(key);
	},
	async save(): Promise<void> {
		// no-op in mock
	},
};

export async function load(_path: string, _options?: { autoSave?: boolean }): Promise<Store> {
	return storeInstance;
}
