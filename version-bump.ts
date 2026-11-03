import { readFileSync, writeFileSync } from "node:fs";

interface Manifest {
	version: string;
	minAppVersion: string;
}

const targetVersion = process.env.npm_package_version;
if (!targetVersion) throw new Error("Run this through `npm version`, which sets npm_package_version.");

// Bump manifest.json to the package's version, and map that version to minAppVersion in versions.json.
const manifest = JSON.parse(readFileSync("manifest.json", "utf8")) as Manifest;
manifest.version = targetVersion;
writeFileSync("manifest.json", JSON.stringify(manifest, null, "\t") + "\n");

const versions = JSON.parse(readFileSync("versions.json", "utf8")) as Record<string, string>;
if (!(targetVersion in versions)) {
	versions[targetVersion] = manifest.minAppVersion;
	writeFileSync("versions.json", JSON.stringify(versions, null, "\t") + "\n");
}
