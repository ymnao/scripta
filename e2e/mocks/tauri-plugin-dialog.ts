import { getMockStore } from "./types";

export async function open(_options?: Record<string, unknown>): Promise<string | null> {
	const store = getMockStore();
	if (!store.calls["dialog:open"]) {
		store.calls["dialog:open"] = [];
	}
	store.calls["dialog:open"].push(_options ?? {});
	return store.dialogResult;
}

export async function save(_options?: Record<string, unknown>): Promise<string | null> {
	const store = getMockStore();
	if (!store.calls["dialog:save"]) {
		store.calls["dialog:save"] = [];
	}
	store.calls["dialog:save"].push(_options ?? {});
	return store.saveDialogResult;
}
