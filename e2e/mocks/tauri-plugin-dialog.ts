import { getMockStore } from "./types";

export async function open(_options?: Record<string, unknown>): Promise<string | null> {
	const store = getMockStore();
	if (!store.calls["dialog:open"]) {
		store.calls["dialog:open"] = [];
	}
	store.calls["dialog:open"].push(_options ?? {});
	return store.dialogResult;
}
