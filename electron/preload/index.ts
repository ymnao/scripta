import { electronAPI } from "@electron-toolkit/preload";
import { contextBridge } from "electron";
import type { Api } from "./api";

const api: Api = Object.freeze({
	getVersion: () => process.versions.electron,
});

contextBridge.exposeInMainWorld("electron", electronAPI);
contextBridge.exposeInMainWorld("api", api);
