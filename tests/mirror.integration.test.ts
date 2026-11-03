import assert from "node:assert/strict";
import { test } from "node:test";
import pg from "pg";
import type { ConnectionSettings, VaultState } from "../src/mirror.ts";
import { PostgreSQLMirror } from "../src/mirror.ts";
import { columnsByKey, propertyColumns } from "../src/properties.ts";
import type { NoteLink, NoteSource } from "../src/rows.ts";
import { contentDigest, linkRows, linksDigest, noteContent } from "../src/rows.ts";

// Runs against a real server only when asked: MIRROR_TEST_DATABASE=postgres://user@localhost/database npm test
const databaseUrl = process.env.MIRROR_TEST_DATABASE;
const schema = `mirror_test_${process.pid}`;

interface MemoryNote {
	source: NoteSource;
	links: NoteLink[];
}

function note(path: string, frontmatter: Record<string, unknown>, links: NoteLink[] = []): MemoryNote {
	const name = path.replace(/^.*\//, "").replace(/\.md$/, "");
	const folder = path.includes("/") ? path.replace(/\/[^/]*$/, "") : "";
	return {
		source: { path, name, folder, createdMs: Date.UTC(2026, 0, 1), modifiedMs: Date.UTC(2026, 10, 3), sizeBytes: 100, frontmatter, tags: [], aliases: [] },
		links,
	};
}

/** A vault held in memory, read as the plugin reads Obsidian's metadata cache. */
function vaultState(notes: MemoryNote[]): VaultState {
	const columns = propertyColumns(notes.map((each) => each.source.frontmatter), new Map([["rating", "number"]]));
	const byKey = columnsByKey(columns);
	const rows = new Map(notes.map((each) => {
		const content = noteContent(each.source, byKey, ["coordinates"]);
		return [each.source.path, {
			note: { ...content, content_digest: contentDigest(content), links_digest: linksDigest(each.links) },
			links: linkRows(each.links, each.source.path),
		}];
	}));
	return {
		vault: "Test vault",
		digests: new Map([...rows].map(([path, row]) => [path, { contentDigest: row.note.content_digest, linksDigest: row.note.links_digest }])),
		columns,
		rows: (paths) => paths.flatMap((path) => rows.get(path) ?? []),
	};
}

const toParis = { target: "Paris", targetPath: "Paris.md", isEmbed: false, isInProperties: true };
const toNowhere = { target: "Nowhere#Heading", targetPath: null, isEmbed: false, isInProperties: false };

test("the mirror copies notes, typed properties, links and places, then only what changed", { skip: !databaseUrl }, async (t) => {
	const url = new URL(databaseUrl ?? "postgres://localhost/postgres");
	const settings: ConnectionSettings = {
		host: url.hostname, port: Number(url.port || 5432), database: url.pathname.slice(1),
		user: decodeURIComponent(url.username), password: decodeURIComponent(url.password), schema, security: "preferred",
	};
	const client = new pg.Client({ connectionString: databaseUrl });
	await client.connect();
	t.after(async () => {
		await client.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
		await client.end();
	});
	const hasPostGIS = (await client.query("SELECT 1 FROM pg_extension WHERE extname = 'postgis'")).rowCount === 1;
	const mirror = new PostgreSQLMirror(settings);
	const server = await mirror.describeServer();
	assert.match(server.version, /^\d+/);

	const louvre = note("Places/Louvre.md", { Type: "Museum", rating: "5", visited: "2025-01-26", coordinates: [48.861, 2.336], city: "[[Paris]]" }, [toParis, toNowhere]);
	const paris = note("Paris.md", { type: "City", coordinates: "48.8566, 2.3522", rating: 4 });
	const first = await mirror.copy(vaultState([louvre, paris]));
	assert.deepEqual({ ...first, elapsedMs: 0 }, {
		copiedNoteCount: 2, writtenNoteCount: 2, deletedNoteCount: 0, rewrittenLinkSourceCount: 2, hasGeometry: hasPostGIS, elapsedMs: 0,
	});

	const typed = await client.query(`SELECT path, folder, "Type", rating, visited, latitude FROM "${schema}".notes_with_properties ORDER BY path`);
	assert.deepEqual(typed.rows, [
		{ path: "Paris.md", folder: "", Type: "City", rating: 4, visited: null, latitude: 48.8566 },
		{ path: "Places/Louvre.md", folder: "Places", Type: "Museum", rating: 5, visited: new Date(2025, 0, 26), latitude: 48.861 },
	]);
	const links = await client.query(`SELECT link_number, target, target_path, is_in_properties FROM "${schema}".links ORDER BY link_number`);
	assert.deepEqual(links.rows, [
		{ link_number: 1, target: "Paris", target_path: "Paris.md", is_in_properties: true },
		{ link_number: 2, target: "Nowhere#Heading", target_path: null, is_in_properties: false },
	]);
	if (hasPostGIS) {
		const lines = await client.query(`SELECT source_path, round(ST_Length(geometry::geography)) AS metres FROM "${schema}".links_on_map`);
		assert.deepEqual(lines.rows, [{ source_path: "Places/Louvre.md", metres: 1285 }]);
	}

	const unchanged = await mirror.copy(vaultState([louvre, paris]));
	assert.equal(unchanged.writtenNoteCount + unchanged.deletedNoteCount, 0);

	// Paris deleted: its row goes, and the Louvre's link to it no longer reaches a file.
	const alone = note("Places/Louvre.md", louvre.source.frontmatter ?? {}, [{ ...toParis, targetPath: null }, toNowhere]);
	const third = await mirror.copy(vaultState([alone]));
	assert.deepEqual([third.copiedNoteCount, third.writtenNoteCount, third.deletedNoteCount, third.rewrittenLinkSourceCount], [1, 1, 1, 1]);
	const reached = await client.query(`SELECT count(*)::int AS reached FROM "${schema}".links WHERE target_path IS NOT NULL`);
	assert.equal(reached.rows[0].reached, 0);

	// Another device (or a person) changed the database: a recheck sees it and writes the note again.
	await client.query(`UPDATE "${schema}".notes SET content_digest = 'stale'`);
	const rechecked = await new PostgreSQLMirror(settings).copy(vaultState([alone]), { rechecksDatabase: true });
	assert.equal(rechecked.writtenNoteCount, 1);

	await mirror.forget("Test vault");
	const emptied = await client.query(`SELECT count(*)::int AS notes FROM "${schema}".notes`);
	assert.equal(emptied.rows[0].notes, 0);
});

test("an unreachable server is reported as a connection failure", { skip: !databaseUrl }, async () => {
	const url = new URL(databaseUrl ?? "postgres://localhost/postgres");
	const mirror = new PostgreSQLMirror({
		host: url.hostname, port: 1, database: "postgres", user: "nobody", password: "", schema, security: "off",
	});
	await assert.rejects(mirror.describeServer(), /Could not connect to PostgreSQL at .*:1/);
});

