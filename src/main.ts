import type { TAbstractFile } from "obsidian";
import { Notice, Plugin, normalizePath } from "obsidian";
import type { ConnectionSettings, CopyReport } from "./mirror.ts";
import { MirrorError, PostgreSQLMirror, messageOf, missingSetting } from "./mirror.ts";
import { declaredTypes, defaultPlacePropertyNames, distinctNames } from "./properties.ts";
import type { MirrorSettings } from "./settings.ts";
import { MirrorSettingTab, defaultSettings } from "./settings.ts";
import { VaultReader } from "./vault-reader.ts";

/** A change is copied once the vault has been still this long… */
const quietDelayMs = 2_000;
/** …or this long after the first change, while you keep typing. */
const longestDelayMs = 30_000;
/** A plugin's settings file larger than this is not read: it is not the mirror's to trust. */
const largestSettingsFileBytes = 1_048_576;

type CopyStatus =
	| { kind: "idle" }
	| { kind: "copying" }
	| { kind: "copied"; report: CopyReport; at: Date }
	| { kind: "failed"; message: string; at: Date };

export default class PostgreSQLMirrorPlugin extends Plugin {
	settings: MirrorSettings = { ...defaultSettings };
	private reader!: VaultReader;
	private mirror: PostgreSQLMirror | undefined;
	private mirrorKey = "";
	private statusBar!: HTMLElement;
	private status: CopyStatus = { kind: "idle" };
	private isLayoutReady = false;
	private timer: number | undefined;
	private firstChangeAt: number | undefined;
	/** The copy running now, which the next one waits for: one copy at a time. */
	private running: Promise<unknown> = Promise.resolve();
	/** A scheduled copy waiting for the running one; later changes join it. */
	private waiting: Promise<CopyReport> | undefined;

	async onload(): Promise<void> {
		await this.loadSettings();
		this.reader = new VaultReader(this.app);
		this.statusBar = this.addStatusBarItem();
		this.addSettingTab(new MirrorSettingTab(this.app, this));

		this.addCommand({
			id: "copy-now",
			name: "Copy the vault now",
			callback: () => void this.copyNow().catch((error: unknown) => new Notice(messageOf(error))),
		});
		this.addCommand({
			id: "copy-every-note-again",
			name: "Copy every note again",
			callback: () => void this.copyNow({ rebuilds: true }).catch((error: unknown) => new Notice(messageOf(error))),
		});
		this.addCommand({
			id: "test-connection",
			name: "Test the connection",
			callback: () => void this.describeServer().then(
				(description) => new Notice(description),
				(error: unknown) => new Notice(messageOf(error)),
			),
		});
		this.registerCommandLine();

		this.app.workspace.onLayoutReady(() => {
			this.isLayoutReady = true;
			// Registered once the vault is loaded: Obsidian reports every file as created while it loads.
			this.registerEvent(this.app.vault.on("create", (file) => this.fileChanged(file)));
			this.registerEvent(this.app.vault.on("delete", (file) => this.fileChanged(file)));
			this.registerEvent(this.app.vault.on("rename", (file, oldPath) => this.fileChanged(file, oldPath)));
			this.registerEvent(this.app.metadataCache.on("changed", () => this.scheduleCopy()));
			this.registerEvent(this.app.metadataCache.on("deleted", () => this.scheduleCopy()));
			// Obsidian has read every note: the copy can no longer miss one.
			this.registerEvent(this.app.metadataCache.on("resolved", () => this.scheduleCopy()));
			this.scheduleCopy(0);
		});
		this.showStatus();
	}

	onunload(): void {
		window.clearTimeout(this.timer);
	}

	async loadSettings(): Promise<void> {
		this.settings = { ...defaultSettings, ...((await this.loadData()) as Partial<MirrorSettings> | null) };
	}

	async saveSettings(): Promise<void> {
		await this.saveData(this.settings);
		this.showStatus();
	}

	private fileChanged(file: TAbstractFile, oldPath?: string): void {
		this.reader.fileChanged(file, oldPath);
		this.scheduleCopy();
	}

	/** Copies soon, once the vault has been still for a moment, when copying automatically. */
	scheduleCopy(delayMs = quietDelayMs): void {
		if (!this.settings.copiesAutomatically || !this.isLayoutReady) return;
		const now = Date.now();
		this.firstChangeAt ??= now;
		const delay = Math.max(0, Math.min(delayMs, this.firstChangeAt + longestDelayMs - now));
		window.clearTimeout(this.timer);
		this.timer = window.setTimeout(() => {
			this.firstChangeAt = undefined;
			void this.scheduledCopy();
		}, delay);
	}

	private async scheduledCopy(): Promise<void> {
		const wasFailing = this.status.kind === "failed";
		try {
			await this.enqueueCopy({ rebuilds: false, rechecksDatabase: false });
		} catch (error) {
			// Obsidian is still reading the vault: the `resolved` event schedules the copy again.
			if (error instanceof VaultNotReadError) return;
			// Said once, not at every change while the server stays unreachable.
			if (!wasFailing) new Notice(`PostgreSQL Mirror: ${messageOf(error)}`);
		}
	}

	/** Copies now, whether or not copying is automatic; `rebuilds` deletes the vault's rows first. */
	async copyNow(options: { rebuilds?: boolean } = {}): Promise<CopyReport> {
		return this.enqueueCopy({ rebuilds: options.rebuilds ?? false, rechecksDatabase: true });
	}

	private enqueueCopy(options: { rebuilds: boolean; rechecksDatabase: boolean }): Promise<CopyReport> {
		const joinsWaitingCopy = !options.rebuilds && !options.rechecksDatabase;
		if (joinsWaitingCopy && this.waiting) return this.waiting;
		const copy: Promise<CopyReport> = this.running
			.catch(() => undefined)
			.then(() => {
				if (this.waiting === copy) this.waiting = undefined;
				return this.copyOnce(options);
			});
		if (joinsWaitingCopy) this.waiting = copy;
		this.running = copy;
		return copy;
	}

	private async copyOnce(options: { rebuilds: boolean; rechecksDatabase: boolean }): Promise<CopyReport> {
		const connection = this.connectionSettings();
		const missing = missingSetting(connection);
		if (missing) throw this.failed(new MirrorError(`Fill in ${missing} in the settings.`));
		const [typesJson, placePropertyNames] = await Promise.all([this.readConfigFile("types.json"), this.placePropertyNames()]);
		const state = this.reader.state({
			vault: this.vaultName(),
			declaredTypes: declaredTypes(typesJson),
			placePropertyNames,
			excludedFolders: this.settings.excludedFolders.split("\n"),
		});
		if (!state) throw new VaultNotReadError("Obsidian is still reading the vault; try again in a moment.");
		const mirror = this.mirrorFor(connection);
		this.status = { kind: "copying" };
		this.showStatus();
		try {
			if (options.rebuilds) await mirror.forget(state.vault);
			const report = await mirror.copy(state, { rechecksDatabase: options.rechecksDatabase });
			this.status = { kind: "copied", report, at: new Date() };
			return report;
		} catch (error) {
			throw this.failed(error);
		} finally {
			this.showStatus();
		}
	}

	private failed(error: unknown): unknown {
		this.status = { kind: "failed", message: messageOf(error), at: new Date() };
		this.showStatus();
		return error;
	}

	/** The server's version and PostGIS's, in words. */
	async describeServer(): Promise<string> {
		const connection = this.connectionSettings();
		const missing = missingSetting(connection);
		if (missing) throw new MirrorError(`Fill in ${missing} in the settings.`);
		const server = await new PostgreSQLMirror(connection).describeServer();
		const postGIS = server.postGISVersion ? `PostGIS ${server.postGISVersion}` : "no PostGIS (notes keep their latitude and longitude)";
		return `Connected: PostgreSQL ${server.version}, ${postGIS}.`;
	}

	private connectionSettings(): ConnectionSettings {
		const settings = this.settings;
		const secret = settings.passwordSecret ? this.app.secretStorage.getSecret(settings.passwordSecret) : null;
		return {
			host: settings.host,
			port: settings.port,
			database: settings.database,
			user: settings.user,
			password: secret ?? "",
			schema: settings.schema,
			security: settings.security,
		};
	}

	/** One mirror per server and schema, so it remembers what the database holds between copies. */
	private mirrorFor(connection: ConnectionSettings): PostgreSQLMirror {
		const key = JSON.stringify(connection);
		if (!this.mirror || key !== this.mirrorKey) {
			this.mirror = new PostgreSQLMirror(connection);
			this.mirrorKey = key;
		}
		return this.mirror;
	}

	private vaultName(): string {
		return this.settings.vaultName.trim() || this.app.vault.getName();
	}

	/** The properties that place a note: those set in the settings, else those the map plugins use. */
	async placePropertyNames(): Promise<string[]> {
		const written = distinctNames(this.settings.placeProperties.split(","));
		return written.length > 0 ? written : this.automaticPlacePropertyNames();
	}

	/**
	 * The properties the vault's map plugins place notes with: the one the Geocoding Properties
	 * plugin writes coordinates into, the one the Map View plugin reads, then `coordinates`
	 * and `location`.
	 */
	async automaticPlacePropertyNames(): Promise<string[]> {
		const geocoding = await this.readPluginSettings("geocoding-properties");
		const mapView = await this.readPluginSettings("obsidian-map-view");
		const location = (geocoding?.properties as Record<string, unknown> | undefined)?.location as Record<string, unknown> | undefined;
		return distinctNames([
			location && location.enabled !== false && typeof location.frontmatterKey === "string" ? location.frontmatterKey : undefined,
			typeof mapView?.frontMatterKey === "string" ? mapView.frontMatterKey : undefined,
			...defaultPlacePropertyNames,
		]);
	}

	private async readPluginSettings(pluginId: string): Promise<Record<string, unknown> | undefined> {
		const text = await this.readConfigFile(`plugins/${pluginId}/data.json`);
		if (!text) return undefined;
		try {
			const parsed: unknown = JSON.parse(text);
			return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : undefined;
		} catch {
			return undefined;
		}
	}

	/** A file of the vault's configuration folder, or null when it is missing or too large. */
	private async readConfigFile(relativePath: string): Promise<string | null> {
		const path = normalizePath(`${this.app.vault.configDir}/${relativePath}`);
		try {
			const stat = await this.app.vault.adapter.stat(path);
			if (!stat || stat.type !== "file" || stat.size > largestSettingsFileBytes) return null;
			return await this.app.vault.adapter.read(path);
		} catch {
			return null;
		}
	}

	/** The last copy, in words, for the settings, the status bar's tooltip and the command line. */
	statusText(): string {
		const status = this.status;
		switch (status.kind) {
			case "idle":
				return this.settings.copiesAutomatically ? "Waiting for Obsidian to read the vault." : "Not copied yet: turn on Copy automatically, or copy now.";
			case "copying":
				return "Copying…";
			case "copied": {
				const report = status.report;
				const changes = report.writtenNoteCount + report.deletedNoteCount === 0
					? "nothing had changed"
					: `${report.writtenNoteCount} written, ${report.deletedNoteCount} deleted`;
				const geometry = report.hasGeometry ? ", with PostGIS points" : "";
				return `${report.copiedNoteCount} notes in PostgreSQL${geometry} at ${status.at.toLocaleTimeString()}: ${changes} (${report.elapsedMs} ms).`;
			}
			case "failed":
				return `Failed at ${status.at.toLocaleTimeString()}: ${status.message}`;
		}
	}

	private showStatus(): void {
		const status = this.status;
		const label = status.kind === "copying" ? "PostgreSQL: copying…"
			: status.kind === "failed" ? "PostgreSQL: copy failed"
			: status.kind === "copied" ? `PostgreSQL: ${status.report.copiedNoteCount} notes`
			: "";
		this.statusBar.setText(this.settings.copiesAutomatically || status.kind !== "idle" ? label : "");
		this.statusBar.setAttribute("aria-label", this.statusText());
	}

	/** `obsidian postgresql-mirror`, `…:copy` and `…:test`, for the terminal, scripts and agents. */
	private registerCommandLine(): void {
		this.registerCliHandler("postgresql-mirror", "Show where the vault is copied and how the last copy went", null, () => {
			const settings = this.settings;
			const lines = [
				`Server: ${settings.user || "?"}@${settings.host}:${settings.port}/${settings.database || "?"}, schema ${settings.schema}`,
				`Vault: ${this.vaultName()}`,
				`Copies automatically: ${settings.copiesAutomatically ? "yes" : "no"}`,
				`Last copy: ${this.statusText()}`,
			];
			return lines.join("\n");
		});
		this.registerCliHandler(
			"postgresql-mirror:copy",
			"Copy the vault into PostgreSQL now",
			{ rebuild: { description: "Delete the vault's rows first, and copy every note again" } },
			async (params) => {
				try {
					await this.copyNow({ rebuilds: params.rebuild === "true" });
					return this.statusText();
				} catch (error) {
					return `Error: ${messageOf(error)}`;
				}
			},
		);
		this.registerCliHandler("postgresql-mirror:test", "Connect to PostgreSQL and show its version", null, async () => {
			try {
				return await this.describeServer();
			} catch (error) {
				return `Error: ${messageOf(error)}`;
			}
		});
	}
}

class VaultNotReadError extends MirrorError {}
