import type { App } from "obsidian";
import { Notice, PluginSettingTab, SecretComponent, Setting } from "obsidian";
import type PostgreSQLBridgePlugin from "./main.ts";
import type { TransportSecurity } from "./mirror.ts";
import { messageOf } from "./mirror.ts";

export interface SyncSettings {
	host: string;
	port: number;
	database: string;
	user: string;
	/** The name of the secret, in Obsidian's secret storage, that holds the password. */
	passwordSecret: string;
	security: TransportSecurity;
	schema: string;
	/** Syncs changes as they happen; off until the server is set. */
	copiesAutomatically: boolean;
	/** Brings the edits made in the database into the vault; off, the vault overwrites them. */
	bringsBackEdits: boolean;
	/** The name that keys the vault's rows; empty for the vault's folder name. */
	vaultName: string;
	/** Properties that place a note, comma separated; empty to read them from the map plugins. */
	placeProperties: string;
	/** Folders whose notes are not copied, one per line. */
	excludedFolders: string;
}

export const defaultSettings: SyncSettings = {
	host: "localhost",
	port: 5432,
	database: "",
	user: "",
	passwordSecret: "",
	security: "preferred",
	schema: "obsidian",
	copiesAutomatically: false,
	bringsBackEdits: true,
	vaultName: "",
	placeProperties: "",
	excludedFolders: "",
};

export class SyncSettingTab extends PluginSettingTab {
	private readonly plugin: PostgreSQLBridgePlugin;

	constructor(app: App, plugin: PostgreSQLBridgePlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		const settings = this.plugin.settings;
		const save = () => this.plugin.saveSettings();
		containerEl.empty();

		new Setting(containerEl).setName("Server").setHeading();
		new Setting(containerEl).setName("Host").setDesc("The server's address.").addText((text) =>
			text.setValue(settings.host).onChange(async (value) => {
				settings.host = value;
				await save();
			}));
		new Setting(containerEl).setName("Port").addText((text) =>
			text.setPlaceholder("5432").setValue(String(settings.port)).onChange(async (value) => {
				settings.port = Number(value.trim() || defaultSettings.port);
				await save();
			}));
		new Setting(containerEl).setName("Database").addText((text) =>
			text.setValue(settings.database).onChange(async (value) => {
				settings.database = value;
				await save();
			}));
		new Setting(containerEl).setName("User").addText((text) =>
			text.setValue(settings.user).onChange(async (value) => {
				settings.user = value;
				await save();
			}));
		new Setting(containerEl)
			.setName("Password")
			.setDesc("Kept in Obsidian's secret storage, never in the plugin's settings file. Leave empty for a server that asks for none.")
			.addComponent((element) =>
				new SecretComponent(this.app, element).setValue(settings.passwordSecret).onChange(async (value) => {
					settings.passwordSecret = value ?? "";
					await save();
				}));
		new Setting(containerEl)
			.setName("Encryption")
			.setDesc("Whether the connection is encrypted.")
			.addDropdown((dropdown) =>
				dropdown
					.addOption("preferred", "When the server offers it")
					.addOption("verified", "Always, with a valid certificate")
					.addOption("off", "Never (this computer or a trusted network)")
					.setValue(settings.security)
					.onChange(async (value) => {
						settings.security = value as TransportSecurity;
						await save();
					}));
		new Setting(containerEl)
			.setName("Schema")
			.setDesc("The schema the tables and views go in, created if missing.")
			.addText((text) =>
				text.setValue(settings.schema).onChange(async (value) => {
					settings.schema = value;
					await save();
				}));
		const test = new Setting(containerEl).setName("Test the connection").addButton((button) =>
			button.setButtonText("Test").onClick(async () => {
				test.setDesc("Connecting…");
				try {
					test.setDesc(await this.plugin.describeServer());
				} catch (error) {
					test.setDesc(messageOf(error));
				}
			}));

		new Setting(containerEl).setName("Sync").setHeading();
		new Setting(containerEl)
			.setName("Sync automatically")
			.setDesc("Sync now, then each change a few seconds after it is made, in the vault or in the database.")
			.addToggle((toggle) =>
				toggle.setValue(settings.copiesAutomatically).onChange(async (value) => {
					settings.copiesAutomatically = value;
					await save();
					if (value) this.plugin.scheduleSync(0);
				}));
		new Setting(containerEl)
			.setName("Bring database edits into the vault")
			.setDesc("Edits made in the database come into your notes: properties, moves and renames, new notes, deletions (to the trash). "
				+ "The text of your notes never changes. More than 50 edits at once wait for you to apply them. "
				+ "Turned off, the vault overwrites what the database changes.")
			.addToggle((toggle) =>
				toggle.setValue(settings.bringsBackEdits).onChange(async (value) => {
					settings.bringsBackEdits = value;
					await save();
				}));
		new Setting(containerEl)
			.setName("Vault name")
			.setDesc("The name that keys this vault's rows, so several vaults can share one schema.")
			.addText((text) =>
				text.setPlaceholder(this.app.vault.getName()).setValue(settings.vaultName).onChange(async (value) => {
					settings.vaultName = value;
					await save();
				}));
		new Setting(containerEl)
			.setName("Location properties")
			.setDesc("The properties that place a note, holding [lat, lng] or \"lat, lng\"; the first that reads as one wins. Leave empty to use those the map plugins use.")
			.addText((text) => {
				text.setValue(settings.placeProperties).onChange(async (value) => {
					settings.placeProperties = value;
					await save();
				});
				void this.plugin.automaticPlacePropertyNames().then((names) => text.setPlaceholder(names.join(", ")));
			});
		new Setting(containerEl)
			.setName("Excluded folders")
			.setDesc("Notes in these folders are not copied, and the database cannot write in them. One folder per line.")
			.addTextArea((text) =>
				text.setPlaceholder("Private").setValue(settings.excludedFolders).onChange(async (value) => {
					settings.excludedFolders = value;
					await save();
				}));

		const status = new Setting(containerEl).setName("Last sync").setDesc(this.plugin.statusText());
		status
			.addButton((button) =>
				button.setButtonText("Sync now").onClick(async () => {
					await this.run(status, () => this.plugin.syncNow());
				}))
			.addButton((button) =>
				button.setButtonText("Copy every note again").onClick(async () => {
					await this.run(status, () => this.plugin.syncNow({ rebuilds: true }));
				}));
		if (this.plugin.heldEditCount > 0) {
			const held = new Setting(containerEl)
				.setName("Edits held in the database")
				.setDesc(`The database holds ${this.plugin.heldEditCount} edits, more than a sync applies on its own.`);
			held
				.addButton((button) =>
					button.setButtonText("Apply them").setCta().onClick(async () => {
						await this.run(status, () => this.plugin.syncNow({ appliesHeldEdits: true }));
						if (this.plugin.heldEditCount === 0) held.settingEl.remove();
					}))
				.addButton((button) =>
					button.setButtonText("Discard them").onClick(async () => {
						await this.run(status, () => this.plugin.discardHeldEdits());
						if (this.plugin.heldEditCount === 0) held.settingEl.remove();
					}));
		}
	}

	private async run(status: Setting, work: () => Promise<unknown>): Promise<void> {
		status.setDesc("Syncing…");
		try {
			await work();
		} catch (error) {
			new Notice(messageOf(error));
		}
		status.setDesc(this.plugin.statusText());
	}
}
