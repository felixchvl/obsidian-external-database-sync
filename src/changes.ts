import type { JsonValue } from "./properties.ts";

/** An edit made in the database, as the `changes` table keeps it until the vault takes it. */
export interface DatabaseChange {
	changeId: string;
	kind: "create" | "update" | "delete";
	/** The note's path before the edit: where it is, or where to create it. */
	path: string;
	/** Where the edit moves the note; null when it stays. */
	newPath: string | null;
	/** Properties written or changed, by name; all of a created note's properties. */
	setProperties: Record<string, JsonValue>;
	removedProperties: string[];
	/** Whether the edit placed the note elsewhere, or took its place away (null latitude or longitude). */
	placeChanged: boolean;
	latitude: number | null;
	longitude: number | null;
}

/** How one database edit went in the vault. */
export interface ChangeOutcome {
	changeId: string;
	status: "applied" | "failed";
	message: string | null;
}

/** The keys of `frontmatter` naming `name`, whatever their capitals. */
function keysNamed(frontmatter: Record<string, unknown>, name: string): string[] {
	const lowercased = name.toLowerCase();
	return Object.keys(frontmatter).filter((key) => key.toLowerCase() === lowercased);
}

/**
 * Writes a database edit into a note's properties, in place, as `processFrontMatter` expects:
 * a property keeps the spelling the note already uses for it, a removed property goes in every
 * spelling, and a place goes into the note's own location property, in the format it already
 * has (`"lat, lng"` or `[lat, lng]`), else into the first of `placePropertyNames`.
 */
export function editFrontmatter(frontmatter: Record<string, unknown>, change: DatabaseChange, placePropertyNames: string[]): void {
	for (const name of change.removedProperties) {
		for (const key of keysNamed(frontmatter, name)) delete frontmatter[key];
	}
	for (const [name, value] of Object.entries(change.setProperties)) {
		const [key, ...others] = keysNamed(frontmatter, name);
		for (const other of others) delete frontmatter[other];
		frontmatter[key ?? name] = value;
	}
	if (!change.placeChanged) return;
	const placeKeys = placePropertyNames.flatMap((name) => keysNamed(frontmatter, name));
	if (change.latitude === null || change.longitude === null) {
		for (const key of placeKeys) delete frontmatter[key];
		return;
	}
	const key = placeKeys[0] ?? placePropertyNames[0] ?? "coordinates";
	frontmatter[key] = typeof frontmatter[key] === "string"
		? `${change.latitude}, ${change.longitude}`
		: [change.latitude, change.longitude];
}

/**
 * Why the database may not write a note at `path`, or undefined when it may: notes stay in the
 * vault, out of hidden folders (the configuration folder, the trash) and out of excluded ones.
 */
export function unwritablePathReason(path: string, excludedFolders: string[]): string | undefined {
	if (!/\.md$/i.test(path)) return `${path} is not a Markdown note`;
	const segments = path.split("/");
	if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) return `${path} is not a path in the vault`;
	if (segments.some((segment) => segment.startsWith("."))) return `${path} is in a hidden folder`;
	const excluded = excludedFolders.map((folder) => folder.trim().replace(/^\/+|\/+$/g, "")).filter((folder) => folder !== "");
	if (excluded.some((folder) => path.startsWith(folder + "/"))) return `${path} is in an excluded folder`;
	return undefined;
}

/** The change as the `changes` table's row gives it. */
export function databaseChange(row: {
	change_id: string;
	kind: string;
	path: string;
	new_path: string | null;
	set_properties: Record<string, JsonValue> | null;
	removed_properties: string[] | null;
	place_changed: boolean;
	latitude: number | null;
	longitude: number | null;
}): DatabaseChange {
	return {
		changeId: row.change_id,
		kind: row.kind === "create" || row.kind === "delete" ? row.kind : "update",
		path: row.path,
		newPath: row.new_path,
		setProperties: row.set_properties ?? {},
		removedProperties: row.removed_properties ?? [],
		placeChanged: row.place_changed,
		latitude: row.latitude,
		longitude: row.longitude,
	};
}
