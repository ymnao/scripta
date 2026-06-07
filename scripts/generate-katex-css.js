#!/usr/bin/env node
const { existsSync, readFileSync, statSync, writeFileSync, mkdirSync } = require("node:fs");
const { join, dirname } = require("node:path");

const ROOT = join(__dirname, "..");
const KATEX_CSS = join(ROOT, "node_modules/katex/dist/katex.min.css");
const KATEX_DIST = dirname(KATEX_CSS);
const OUT_FILE = join(ROOT, "src/generated/katex-inline-css.ts");

if (existsSync(OUT_FILE) && statSync(OUT_FILE).mtimeMs >= statSync(KATEX_CSS).mtimeMs) {
	process.exit(0);
}

let css = readFileSync(KATEX_CSS, "utf8");

css = css.replace(/url\(fonts\/([\w-]+\.woff2)\)/g, (_match, fileName) => {
	const base64 = readFileSync(join(KATEX_DIST, "fonts", fileName)).toString("base64");
	return `url(data:font/woff2;base64,${base64})`;
});

css = css.replace(/,url\(fonts\/[\w-]+\.(?:woff|ttf)\) format\("(?:woff|truetype)"\)/g, "");

mkdirSync(dirname(OUT_FILE), { recursive: true });

const escaped = css.replace(/\\/g, "\\\\").replace(/`/g, "\\`").replace(/\$/g, "\\$");

writeFileSync(OUT_FILE, `export const katexInlineCss = \`${escaped}\`;\n`);

console.log(`[generate-katex-css] ${OUT_FILE} (${(css.length / 1024).toFixed(0)} KB)`);
