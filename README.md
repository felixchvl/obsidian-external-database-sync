# PostgreSQL Mirror for Obsidian

An Obsidian plugin that copies your vault into PostgreSQL as tables you can query: notes, properties typed as the Properties view types them, tags, aliases, links resolved to files, and places, with a PostGIS point when the database has PostGIS.

The copy goes one way, from the vault to the database. The plugin never writes your notes, and the database can be emptied and copied again at any time. Use it to query the vault in SQL, join it with other data, draw it in QGIS, or give tools and agents a read-only view of it.

## What you get

The plugin creates a schema (`obsidian` by default) with:

| Table or view | What it holds |
| --- | --- |
| `notes` | One row per note: `path`, `name`, `folder`, `created`, `modified`, `size_bytes`, `tags`, `aliases`, `properties` (JSONB), `latitude`, `longitude`, and `geometry` with PostGIS |
| `links` | One row per link, in the order you wrote them: `target` as written, `target_path` it reaches (null when broken), `is_embed`, `is_in_properties` |
| `property_columns` | The vault's properties, their type and how many notes use them |
| `notes_with_properties` | The notes with one typed column per property: numbers are `double precision`, checkboxes `boolean`, dates `date` (PostgreSQL 16 and later), lists `text[]` |
| `links_on_map` | With PostGIS, the links between two placed notes as lines |
| `vaults` | The vaults copied into the schema, so several vaults can share one |

Types come from `.obsidian/types.json`, then from the property's name (`tags`, `aliases`), then from its first value. Every capitalization of a property is one property, named as most notes spell it.

A note is placed by the first of its location properties that holds `[lat, lng]` or `"lat, lng"`. By default these are the property the Map View and Geocoding Properties plugins use, then `coordinates` and `location`; you can name your own in the settings.

Some queries:

```sql
-- Books rated 4 or more, with their tags
SELECT name, rating, tags FROM obsidian.notes_with_properties
WHERE "type" = 'Book' AND rating >= 4 ORDER BY rating DESC;

-- Broken links
SELECT source_path, target FROM obsidian.links WHERE target_path IS NULL;

-- The notes most linked to
SELECT target_path, count(*) FROM obsidian.links
WHERE target_path IS NOT NULL GROUP BY 1 ORDER BY 2 DESC LIMIT 20;

-- Places within 2 km of the Louvre (PostGIS)
SELECT name FROM obsidian.notes
WHERE ST_DWithin(geometry::geography, ST_MakePoint(2.336, 48.861)::geography, 2000);
```

QGIS can open `notes` and `links_on_map` as layers. Set a layer to **Refresh layer on notification** with the `qgis` channel: it draws again after each copy.

## Setting it up

1. Install the plugin, then open **Settings → PostgreSQL Mirror**.
2. Fill in the server, database and user. The password goes in Obsidian's secret storage, never in the plugin's settings file.
3. Select **Test** to check the connection.
4. Turn on **Copy automatically**. The plugin copies the vault, then each change a few seconds after you make it.

The user needs to create tables in the schema, or in the database if the schema does not exist yet. For geometry, install PostGIS in the database (`CREATE EXTENSION postgis`) before or after the first copy.

The plugin runs on desktop only: it talks to PostgreSQL directly over the network.

## From the terminal

With the [Obsidian CLI](https://help.obsidian.md/cli) and Obsidian open:

```bash
obsidian postgresql-mirror             # where the vault is copied and how the last copy went
obsidian postgresql-mirror:test        # connect and show the server's version
obsidian postgresql-mirror:copy        # copy now
obsidian postgresql-mirror:copy rebuild  # delete the vault's rows and copy every note again
```

## How it copies

Each copy compares a digest of every note, and of its links, with those in the database, and writes only what changed, in one transaction. A lock per vault makes copies from two computers wait for each other rather than interleave. Notes Obsidian has not read again are not read again, and links resolve again only for notes that name a file that came, went or was renamed.

On a vault of 20,000 notes, the first copy takes about five seconds; after that, a change is copied in a few dozen milliseconds.

## Privacy

The plugin sends your notes' metadata (paths, properties, tags, aliases, links and places) to the PostgreSQL server you set, and nowhere else. It does not copy the text of your notes. There is no telemetry.

## Development

```bash
npm install
npm run dev     # rebuild main.js on every change
npm run build   # type-check and build for release
npm test        # unit tests
npm run lint
```

The integration tests need a PostgreSQL server; they create a schema of their own and drop it:

```bash
MIRROR_TEST_DATABASE=postgres://user@localhost/database npm test
```

To try the plugin, copy `main.js` and `manifest.json` into `<vault>/.obsidian/plugins/postgresql-mirror/`, then enable it in **Settings → Community plugins**.

The tables are those of [Graphite](https://github.com/Graphite-Note/Graphite)'s PostgreSQL Mirror, so both can fill the same schema.

## License

[MIT](LICENSE)
