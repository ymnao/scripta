import { electronAPI } from "@electron-toolkit/preload";
import { contextBridge } from "electron";

const api = {
	getVersion: (): string => process.versions.electron,
};

try {
	contextBridge.exposeInMainWorld("electron", electronAPI);
	contextBridge.exposeInMainWorld("api", api);
} catch (error) {
	console.error(error);
}
