import assert from "node:assert/strict";
import { test } from "node:test";
import { coordinate, declaredTypes, mirroredValue, placeOf, propertyColumns, propertyType } from "../src/properties.ts";

test("types.json assigns types, and ignores types Obsidian does not have", () => {
	const types = declaredTypes(JSON.stringify({ types: { rating: "number", done: "checkbox", odd: "color" } }));
	assert.deepEqual([...types], [["rating", "number"], ["done", "checkbox"]]);
	assert.equal(declaredTypes("not json").size, 0);
	assert.equal(declaredTypes(null).size, 0);
});

test("a property's type comes from types.json, then its name, then its first value", () => {
	const declared = new Map([["Rating", "number" as const]]);
	assert.equal(propertyType("rating", ["5"], declared), "number");
	assert.equal(propertyType("tags", ["a"], new Map()), "tags");
	assert.equal(propertyType("due", [null, "2026-11-03"], new Map()), "date");
	assert.equal(propertyType("met", ["2026-11-03T14:30"], new Map()), "datetime");
	assert.equal(propertyType("list", [["a"]], new Map()), "multitext");
	assert.equal(propertyType("empty", [null, ""], new Map()), "text");
});

test("values are typed as the vault types the property", () => {
	assert.equal(mirroredValue(2024, "text"), "2024");
	assert.equal(mirroredValue("12", "number"), 12);
	assert.equal(mirroredValue("twelve", "number"), "twelve");
	assert.equal(mirroredValue("TRUE", "checkbox"), true);
	assert.deepEqual(mirroredValue("fiction, classic", "tags"), ["fiction", "classic"]);
	assert.deepEqual(mirroredValue("one", "multitext"), ["one"]);
	assert.deepEqual(mirroredValue(null, "multitext"), []);
	assert.equal(mirroredValue(null, "text"), null);
	assert.deepEqual(mirroredValue([1, "2", null], "multitext"), [1, "2", null]);
	assert.deepEqual(mirroredValue([2024], "aliases"), ["2024"]);
	assert.deepEqual(mirroredValue({ city: "Paris", year: 2026 }, "text"), { city: "Paris", year: 2026 });
	assert.equal(mirroredValue(Number.POSITIVE_INFINITY, undefined), "Infinity");
});

test("columns merge capitalizations, keep the spelling most notes use and count notes once", () => {
	const columns = propertyColumns(
		[{ Cours: 1, cours: 2 }, { cours: 3 }, { cours: 4 }, { Ville: "Paris" }, undefined],
		new Map(),
	);
	assert.deepEqual(columns, [
		{ propertyName: "Ville", propertyType: "text", noteCount: 1 },
		{ propertyName: "cours", propertyType: "number", noteCount: 3 },
	]);
});

test("a place reads from [lat, lng] or \"lat, lng\", never from decimal commas", () => {
	assert.deepEqual(coordinate([48.85, 2.35]), { latitude: 48.85, longitude: 2.35 });
	assert.deepEqual(coordinate(["48.85", "2.35"]), { latitude: 48.85, longitude: 2.35 });
	assert.deepEqual(coordinate("48.85, 2.35"), { latitude: 48.85, longitude: 2.35 });
	assert.deepEqual(coordinate("[48.85,2.35]"), { latitude: 48.85, longitude: 2.35 });
	assert.equal(coordinate("48,85, 2,35"), undefined);
	assert.equal(coordinate("Paris"), undefined);
	assert.equal(coordinate([91, 0]), undefined);
});

test("the first location property that reads as a place wins, whatever its capitals", () => {
	const frontmatter = { coordinates: "somewhere", Coordonnées: [48.85, 2.35] };
	assert.deepEqual(placeOf(frontmatter, ["coordinates", "coordonnées"]), { latitude: 48.85, longitude: 2.35 });
	assert.equal(placeOf(frontmatter, ["location"]), undefined);
});
