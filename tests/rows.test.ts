import assert from "node:assert/strict";
import { test } from "node:test";
import { columnsByKey } from "../src/properties.ts";
import { contentDigest, linkName, linksDigest, mirrorPlan, noteContent, sortedJson } from "../src/rows.ts";

const source = {
	path: "Places/Louvre.md",
	name: "Louvre",
	folder: "Places",
	createdMs: Date.UTC(2025, 0, 26),
	modifiedMs: Date.UTC(2026, 10, 3),
	sizeBytes: 120,
	frontmatter: { Type: "Museum", visits: "3", coordinates: [48.861, 2.336] },
	tags: ["paris"],
	aliases: ["Musée du Louvre"],
};

test("a note's content names and types properties as the vault does, and reads its place", () => {
	const byKey = columnsByKey([
		{ propertyName: "type", propertyType: "text", noteCount: 10 },
		{ propertyName: "visits", propertyType: "number", noteCount: 4 },
	]);
	const content = noteContent(source, byKey, ["coordinates"]);
	assert.deepEqual(content.properties, { type: "Museum", visits: 3, coordinates: [48.861, 2.336] });
	assert.equal(content.latitude, 48.861);
	assert.equal(content.longitude, 2.336);
	assert.equal(content.created, "2025-01-26T00:00:00.000Z");
});

test("digests do not depend on the order keys were written in", () => {
	assert.equal(sortedJson({ b: 1, a: { d: 2, c: [3] } }), '{"a":{"c":[3],"d":2},"b":1}');
	const byKey = columnsByKey([]);
	const reordered = { ...source, frontmatter: { coordinates: [48.861, 2.336], visits: "3", Type: "Museum" } };
	assert.equal(contentDigest(noteContent(source, byKey, [])), contentDigest(noteContent(reordered, byKey, [])));
	const link = { target: "Paris", targetPath: "Paris.md", isEmbed: false, isInProperties: false };
	assert.notEqual(linksDigest([link]), linksDigest([{ ...link, targetPath: null }]));
	assert.match(linksDigest([]), /^[0-9a-f]{32}$/);
});

test("a copy writes new and changed notes and deletes those the vault no longer has", () => {
	const same = { contentDigest: "a", linksDigest: "b" };
	const plan = mirrorPlan(
		new Map([["kept.md", same], ["changed.md", same], ["new.md", same]]),
		new Map([["kept.md", same], ["changed.md", { ...same, linksDigest: "c" }], ["gone.md", same]]),
	);
	assert.deepEqual(plan, { notePathsToWrite: ["changed.md", "new.md"], notePathsToDelete: ["gone.md"] });
});

test("links and files go by their last segment when Obsidian resolves links", () => {
	assert.equal(linkName("Places/Louvre.md"), "louvre");
	assert.equal(linkName("Louvre"), "louvre");
	assert.equal(linkName("Images/Map.PNG"), "map.png");
});
