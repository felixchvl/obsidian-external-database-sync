import type { App } from "obsidian";
import { Notice, PluginSettingTab, SecretComponent, Setting } from "obsidian";
import type PostgreSQLMirrorPlugin from "./main.ts";
import type { TransportSecurity } from "./mirror.ts";
import { messageOf } from "./mirror.ts";

export interface MirrorSettings {
	host: string;
	port: number;
	database: string;
	user: string;
	/** The name of the secret, in Obsidian's secret storage, that holds the password. */
	passwordSecret: string;
	security: TransportSecurity;
	schema: string;
	/** Copies changes as they happen; off until the server is set. */
	copiesAutomatically: boolean;
	/** The name that keys the vault's rows; empty for the vault's folder name. */
	vaultName: string;
	/** Properties that place a note, comma separated; empty to read them from the map plugins. */
	placeProperties: string;
	/** Folders whose notes are not copied, one per line. */
	excludedFolders: string;
}

export const defaultSettings: MirrorSettings = {
	host: "localhost",
	port: 5432,
	database: "",
	user: "",
	passwordSecret: "",
	security: "preferred",
	schema: "obsidian",
	copiesAutomatically: false,
	vaultName: "",
	placeProperties: "",
	excludedFolders: "",
};

export class MirrorSettingTab extends PluginSettingTab {
	private readonly plugin: PostgreSQLMirrorPlugin;

	constructor(app: App, plugin: PostgreSQLMirrorPlugin) {
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

		new Setting(containerEl).setName("Copy").setHeading();
		new Setting(containerEl)
			.setName("Copy automatically")
			.setDesc("Copy the vault now, then each change a few seconds after it is made.")
			.addToggle((toggle) =>
				toggle.setValue(settings.copiesAutomatically).onChange(async (value) => {
					settings.copiesAutomatically = value;
					await save();
					if (value) this.plugin.scheduleCopy(0);
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
			.setDesc("Notes in these folders are not copied. One folder per line.")
			.addTextArea((text) =>
				text.setPlaceholder("Private").setValue(settings.excludedFolders).onChange(async (value) => {
					settings.excludedFolders = value;
					await save();
				}));

		const status = new Setting(containerEl).setName("Last copy").setDesc(this.plugin.statusText());
		status
			.addButton((button) =>
				button.setButtonText("Copy now").onClick(async () => {
					await this.copy(status, false);
				}))
			.addButton((button) =>
				button.setButtonText("Copy every note again").onClick(async () => {
					await this.copy(status, true);
				}));
	}

	private async copy(status: Setting, rebuilds: boolean): Promise<void> {
		status.setDesc("Copying…");
		try {
			await this.plugin.copyNow({ rebuilds });
		} catch (error) {
			new Notice(messageOf(error));
		}
		status.setDesc(this.plugin.statusText());
	}
}
