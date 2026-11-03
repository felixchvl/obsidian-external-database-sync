import assert from "node:assert/strict";
import { test } from "node:test";
import type { DatabaseChange } from "../src/changes.ts";
import { databaseChange, editFrontmatter, unwritablePathReason } from "../src/changes.ts";

function change(edit: Partial<DatabaseChange>): DatabaseChange {
	return {
		changeId: "1", kind: "update", path: "Louvre.md", newPath: null, setProperties: {}, removedProperties: [],
		placeChanged: false, latitude: null, longitude: null, ...edit,
	};
}

test("an edit keeps the spelling the note uses, and a removal takes every spelling", () => {
	const frontmatter: Record<string, unknown> = { type: "Museum", Rating: 4, Note: "a", note: "b" };
	editFrontmatter(frontmatter, change({ setProperties: { Type: "Palace", rating: 5, visited: "2026-11-03" }, removedProperties: ["NOTE"] }), []);
	assert.deepEqual(frontmatter, { type: "Palace", Rating: 5, visited: "2026-11-03" });
});

test("a place goes into the note's own location property, in the format it has", () => {
	const asText: Record<string, unknown> = { Coordonnées: "48.86, 2.33" };
	editFrontmatter(asText, change({ placeChanged: true, latitude: 48.8606, longitude: 2.3376 }), ["Coordonnées", "coordinates"]);
	assert.deepEqual(asText, { Coordonnées: "48.8606, 2.3376" });

	const unplaced: Record<string, unknown> = {};
	editFrontmatter(unplaced, change({ placeChanged: true, latitude: 1, longitude: 2 }), ["Coordonnées", "coordinates"]);
	assert.deepEqual(unplaced, { Coordonnées: [1, 2] });

	const removed: Record<string, unknown> = { coordinates: [1, 2], location: "1, 2" };
	editFrontmatter(removed, change({ placeChanged: true }), ["coordinates", "location"]);
	assert.deepEqual(removed, {});
});

test("the database writes Markdown notes only, inside the vault and out of hidden or excluded folders", () => {
	assert.equal(unwritablePathReason("Places/Louvre.md", []), undefined);
	assert.match(unwritablePathReason("Places/photo.png", []) ?? "", /not a Markdown note/);
	assert.match(unwritablePathReason("../outside.md", []) ?? "", /not a path in the vault/);
	assert.match(unwritablePathReason(".obsidian/plugins/x.md", []) ?? "", /hidden folder/);
	assert.match(unwritablePathReason("Private/diary.md", ["/Private/"]) ?? "", /excluded folder/);
});

test("a row of changes reads as a change", () => {
	const read = databaseChange({
		change_id: "7", kind: "delete", path: "Old.md", new_path: null, set_properties: null, removed_properties: null,
		place_changed: false, latitude: null, longitude: null,
	});
	assert.deepEqual(read, change({ changeId: "7", kind: "delete", path: "Old.md" }));
});
