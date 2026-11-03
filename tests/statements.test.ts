import assert from "node:assert/strict";
import { test } from "node:test";
import { MirrorStatements, quotedIdentifier, quotedLiteral, typedExpression, viewColumns } from "../src/statements.ts";

test("names are quoted, and literals keep their meaning whatever the server's settings", () => {
	assert.equal(quotedIdentifier('my "vault"'), '"my ""vault"""');
	assert.equal(quotedLiteral("it's C:\\notes"), "E'it''s C:\\\\notes'");
	assert.equal(new MirrorStatements("Obsidian").schema, '"Obsidian"');
});

test("view columns merge spellings, put the most used first and stay clear of fixed columns", () => {
	const columns = viewColumns([
		{ propertyName: "Cours", propertyType: "number", noteCount: 1 },
		{ propertyName: "cours", propertyType: "number", noteCount: 5 },
		{ propertyName: "tags", propertyType: "tags", noteCount: 9 },
		{ propertyName: "x".repeat(64), propertyType: "text", noteCount: 2 },
		{ propertyName: "Statut", propertyType: "text", noteCount: 3 },
		{ propertyName: "statut", propertyType: "number", noteCount: 1 },
	]);
	assert.deepEqual(columns, [
		{ columnName: "tags (property)", spellings: ["tags"], type: "tags" },
		{ columnName: "cours", spellings: ["cours", "Cours"], type: "number" },
		{ columnName: "Statut", spellings: ["Statut", "statut"], type: undefined },
	]);
});

test("typed expressions cast only values of the right JSON type", () => {
	assert.equal(
		typedExpression(["rating"], "number", true),
		"CASE WHEN jsonb_typeof(note.properties -> E'rating') = 'number' THEN (note.properties -> E'rating' #>> '{}')::double precision END",
	);
	assert.match(typedExpression(["due"], "date", true), /pg_input_is_valid/);
	assert.equal(typedExpression(["due"], "date", false), "(note.properties -> E'due' #>> '{}')");
	assert.match(typedExpression(["a", "A"], "multitext", true), /^CASE jsonb_typeof\(COALESCE\(/);
});
