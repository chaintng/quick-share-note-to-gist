import { Plugin, requestUrl, Notice, PluginSettingTab, Setting, TFile, App, RequestUrlParam, RequestUrlResponse } from 'obsidian';

type PublishProvider = 'gist' | 'hackmd';

interface QuickShareNotePluginSettings {
	provider: PublishProvider;
	githubToken: string;
	imgurClientId: string;
	hackmdToken: string;
	showFrontmatter: boolean;
	showFilenameHeader: boolean;
}

const DEFAULT_SETTINGS: QuickShareNotePluginSettings = {
	provider: 'hackmd',
	githubToken: '',
	imgurClientId: '',
	hackmdToken: '',
	showFrontmatter: true,
	showFilenameHeader: true,
};

const HACKMD_MAX_IMAGE_BYTES = 1 * 1024 * 1024;
const HACKMD_TARGET_IMAGE_BYTES = 950 * 1024;

interface PreparedNote {
	contentToPublish: string;
	fileNameWithoutSuffix: string;
	gistId: string | null;
	hackmdNoteId: string | null;
	hackmdPublishUrl: string | null;
}

interface PublishedNote {
	url: string;
	noteId?: string;
}

interface AttachmentMatch {
	markdown: string;
	file: TFile;
}

export default class QuickShareNotePlugin extends Plugin {
	settings: QuickShareNotePluginSettings;

	async onload() {
		await this.loadSettings();
		this.addSettingTab(new QuickShareNoteSettingTab(this.app, this));

		this.addCommand({
			id: 'publish-note-to-gist',
			name: 'Publish note to selected provider',
			callback: () => this.publishNote(),
		});
	}

	async publishNote() {
		const activeFile = this.app.workspace.getActiveFile();
		if (!activeFile) {
			new Notice('No active file found');
			return;
		}

		const providerLabel = this.settings.provider === 'hackmd' ? 'HackMD' : 'GitHub gist';
		const notice = new Notice(`Uploading note to ${providerLabel}: ${activeFile.name}...`, 0);

		try {
			const preparedNote = await this.prepareNoteForPublish(activeFile);
			const publishedNote = this.settings.provider === 'hackmd'
				? await this.publishToHackmd(activeFile, preparedNote)
				: await this.publishToGist(activeFile, preparedNote);

			this.copyLinkToClipboard(publishedNote.url);
			await this.updatePublishFrontmatter(activeFile, publishedNote);
			new Notice(`Note published to ${providerLabel}`);
		} catch (error) {
			console.error(`Failed to publish note to ${providerLabel}`, error);
			new Notice(`Failed to publish note: ${this.formatError(error)}`, 10000);
		} finally {
			notice.hide();
		}
	}

	async prepareNoteForPublish(activeFile: TFile): Promise<PreparedNote> {
		let content = await this.app.vault.read(activeFile);
		const gistIdMatch = content.match(/gist-publish-url:\s*https.*\/([^/\s]+)/);
		const hackmdNoteIdMatch = content.match(/hackmd-note-id:\s*([^\s]+)/);
		const hackmdPublishUrlMatch = content.match(/hackmd-publish-url:\s*(https?:\/\/[^\s]+)/);

		if (!this.settings.showFrontmatter) {
			content = content.replace(/^---\n[\s\S]*?\n---\n/, '');
		}

		const frontmatterMatch = content.match(/^---\n[\s\S]*?\n---\n/);
		const frontmatter = frontmatterMatch ? frontmatterMatch[0] : '';
		const contentWithoutFrontmatter = content.replace(frontmatter, '');
		const fileNameWithoutSuffix = activeFile.name.replace(/\.[^/.]+$/, '');
		const header = this.settings.showFilenameHeader ? `# ${fileNameWithoutSuffix}\n\n` : '';

		return {
			contentToPublish: frontmatter + header + contentWithoutFrontmatter,
			fileNameWithoutSuffix,
			gistId: gistIdMatch ? gistIdMatch[1] : null,
			hackmdNoteId: hackmdNoteIdMatch ? hackmdNoteIdMatch[1] : null,
			hackmdPublishUrl: hackmdPublishUrlMatch ? hackmdPublishUrlMatch[1] : null,
		};
	}

	async publishToGist(activeFile: TFile, preparedNote: PreparedNote): Promise<PublishedNote> {
		const contentToPublish = await this.uploadImagesAndReplaceLinks(
			preparedNote.contentToPublish,
			(imageData) => this.uploadImageToImgur(imageData),
		);
		const response = preparedNote.gistId
			? await this.updateGist(preparedNote.gistId, activeFile.name, contentToPublish)
			: await this.createNewGist(activeFile.name, contentToPublish);

		return { url: response.json.html_url };
	}

	async publishToHackmd(activeFile: TFile, preparedNote: PreparedNote): Promise<PublishedNote> {
		const initialContent = preparedNote.hackmdNoteId
			? preparedNote.contentToPublish
			: this.replaceObsidianImageLinks(preparedNote.contentToPublish, 'Uploading attachments...');

		const note = preparedNote.hackmdNoteId
			? { id: preparedNote.hackmdNoteId, publishLink: '' }
			: await this.createHackmdNote(preparedNote.fileNameWithoutSuffix, initialContent);

		const contentToPublish = await this.uploadImagesAndReplaceLinks(
			preparedNote.contentToPublish,
			(imageData, file) => this.uploadImageToHackmd(note.id, imageData, file),
		);

		await this.updateHackmdNote(note.id, contentToPublish);

		return {
			url: note.publishLink || preparedNote.hackmdPublishUrl || `https://hackmd.io/${note.id}`,
			noteId: note.id,
		};
	}

	async createNewGist(activeFileName: string, contentToPublish: string) {
		const body = JSON.stringify({
			files: {
				[activeFileName]: {
					content: contentToPublish,
				},
			},
			public: false, // Set to false for secret gist
		});

		return await this.requestUrlChecked({
			url: 'https://api.github.com/gists',
			method: 'POST',
			headers: {
				Authorization: `token ${this.settings.githubToken}`,
				'Content-Type': 'application/json',
			},
			body,
		}, `GitHub gist create for ${activeFileName}`, this.getStringByteLength(body));
	}

	async createHackmdNote(title: string, content: string): Promise<{ id: string; publishLink: string }> {
		this.ensureHackmdToken();

		const body = JSON.stringify({
			title,
			content,
			readPermission: 'guest',
			writePermission: 'owner',
			commentPermission: 'disabled',
		});
		const response = await this.requestUrlChecked({
			url: 'https://api.hackmd.io/v1/notes',
			method: 'POST',
			headers: {
				Authorization: `Bearer ${this.settings.hackmdToken}`,
				'Content-Type': 'application/json',
			},
			body,
		}, `HackMD note create for ${title}`, this.getStringByteLength(body));

		return {
			id: response.json.id,
			publishLink: response.json.publishLink || `https://hackmd.io/${response.json.id}`,
		};
	}

	async updateHackmdNote(noteId: string, content: string): Promise<void> {
		this.ensureHackmdToken();

		const body = JSON.stringify({ content });
		await this.requestUrlChecked({
			url: `https://api.hackmd.io/v1/notes/${noteId}`,
			method: 'PATCH',
			headers: {
				Authorization: `Bearer ${this.settings.hackmdToken}`,
				'Content-Type': 'application/json',
			},
			body,
		}, `HackMD note update for ${noteId}`, this.getStringByteLength(body));
	}

	async updateGist(gistId: string, activeFileName: string, contentToPublish: string) {
		const body = JSON.stringify({
			files: {
				[activeFileName]: {
					content: contentToPublish,
				},
			},
		});

		return await this.requestUrlChecked({
			url: `https://api.github.com/gists/${gistId}`,
			method: 'PATCH',
			headers: {
				Authorization: `token ${this.settings.githubToken}`,
				'Content-Type': 'application/json',
			},
			body,
		}, `GitHub gist update for ${activeFileName}`, this.getStringByteLength(body));
	}

	async addHeaderToContent(file: TFile) {
		const fileContent = await this.app.vault.read(file);
		const header = `# ${file.name}\n\n`;
		const newContent = header + fileContent;
		await this.app.vault.modify(file, newContent);
	}

	async updatePublishFrontmatter(file: TFile, publishedNote: PublishedNote) {
		const fileContent = await this.app.vault.read(file);
		const frontmatterRegex = /^---\n([\s\S]*?)\n---/;
		const match = frontmatterRegex.exec(fileContent);
		const urlKey = this.settings.provider === 'hackmd' ? 'hackmd-publish-url' : 'gist-publish-url';
		const updates: Record<string, string> = { [urlKey]: publishedNote.url };

		if (this.settings.provider === 'hackmd' && publishedNote.noteId) {
			updates['hackmd-note-id'] = publishedNote.noteId;
		}

		let newContent;

		if (match) {
			const frontmatter = match[1];
			const updatedFrontmatter = this.upsertFrontmatterValues(frontmatter, updates);
			newContent = fileContent.replace(frontmatterRegex, `---\n${updatedFrontmatter}\n---`);
		} else {
			newContent = `---\n${this.formatFrontmatterValues(updates)}\n---\n${fileContent}`;
		}

		await this.app.vault.modify(file, newContent);
	}

	upsertFrontmatterValues(frontmatter: string, updates: Record<string, string>): string {
		let updatedFrontmatter = frontmatter;

		for (const [key, value] of Object.entries(updates)) {
			const keyRegex = new RegExp(`^${key}: .*`, 'm');
			updatedFrontmatter = keyRegex.test(updatedFrontmatter)
				? updatedFrontmatter.replace(keyRegex, `${key}: ${value}`)
				: `${updatedFrontmatter}\n${key}: ${value}`;
		}

		return updatedFrontmatter;
	}

	formatFrontmatterValues(values: Record<string, string>): string {
		return Object.entries(values)
			.map(([key, value]) => `${key}: ${value}`)
			.join('\n');
	}

	async uploadImagesAndReplaceLinks(
		content: string,
		uploadImage: (imageData: ArrayBuffer, file: TFile) => Promise<string>,
	): Promise<string> {
		const attachmentMatches = this.findAttachmentMatches(content);

		for (const attachmentMatch of attachmentMatches) {
			const imageData = await this.app.vault.adapter.readBinary(attachmentMatch.file.path);
			const imageUrl = await uploadImage(imageData, attachmentMatch.file);
			content = content.replace(attachmentMatch.markdown, `![${attachmentMatch.file.basename}](${imageUrl})`);
		}

		return content;
	}

	findAttachmentMatches(content: string): AttachmentMatch[] {
		const imageRegex = /!\[\[(.*?)\]\]/g;
		const activeFile = this.app.workspace.getActiveFile();
		const notePath = activeFile ? activeFile.path.replace(/[^/]+$/, '') : '';
		const attachmentMatches: AttachmentMatch[] = [];
		let match;

		while ((match = imageRegex.exec(content)) !== null) {
			const attachFile = this.app.metadataCache.getFirstLinkpathDest(match[1], notePath);
			if (attachFile == null) {
				continue;
			}

			attachmentMatches.push({ markdown: match[0], file: attachFile });
		}

		return attachmentMatches;
	}

	replaceObsidianImageLinks(content: string, replacement: string): string {
		for (const attachmentMatch of this.findAttachmentMatches(content)) {
			content = content.replace(attachmentMatch.markdown, replacement);
		}

		return content;
	}

	async uploadImageToImgur(imageData: ArrayBuffer): Promise<string> {
		const response = await this.requestUrlChecked({
			url: 'https://api.imgur.com/3/image',
			method: 'POST',
			body: imageData,
			headers: {
				Authorization: `Client-ID ${this.settings.imgurClientId}`,
				'Content-Type': 'application/octet-stream',
			},
		}, 'Imgur image upload', imageData.byteLength);
		return response.json.data.link;
	}

	async uploadImageToHackmd(noteId: string, imageData: ArrayBuffer, file: TFile): Promise<string> {
		this.ensureHackmdToken();

		const uploadImage = imageData.byteLength > HACKMD_MAX_IMAGE_BYTES
			? await this.resizeImageForHackmd(imageData, file)
			: { data: imageData, fileName: file.name, mimeType: this.getMimeType(file) };

		const boundary = `----quick-share-${Date.now()}-${Math.random().toString(16).slice(2)}`;
		const body = this.buildMultipartImageBody(boundary, uploadImage.data, uploadImage.fileName, uploadImage.mimeType);
		const response = await this.requestUrlChecked({
			url: `https://api.hackmd.io/v1/notes/${noteId}/images`,
			method: 'POST',
			body,
			headers: {
				Authorization: `Bearer ${this.settings.hackmdToken}`,
				'Content-Type': `multipart/form-data; boundary=${boundary}`,
			},
		}, `HackMD image upload for ${uploadImage.fileName}`, body.byteLength);

		return response.json.data.link;
	}

	async resizeImageForHackmd(
		imageData: ArrayBuffer,
		file: TFile,
	): Promise<{ data: ArrayBuffer; fileName: string; mimeType: string }> {
		if (!this.canResizeImage(file)) {
			throw new Error(
				`HackMD image upload for ${file.name} is too large: ${this.formatBytes(imageData.byteLength)}. HackMD allows images up to ${this.formatBytes(HACKMD_MAX_IMAGE_BYTES)}, and this image type cannot be resized automatically.`,
			);
		}

		const originalMimeType = this.getMimeType(file);
		const outputMimeType = originalMimeType === 'image/png' ? 'image/jpeg' : originalMimeType;
		const imageBitmap = await createImageBitmap(new Blob([imageData], { type: originalMimeType }));

		try {
			const resizedImage = await this.encodeImageUnderLimit(imageBitmap, outputMimeType);
			console.info('[quick-share-note-to-gist] HackMD image resized', {
				fileName: file.name,
				from: this.formatBytes(imageData.byteLength),
				to: this.formatBytes(resizedImage.byteLength),
			});

			return {
				data: resizedImage,
				fileName: this.getResizedFileName(file, outputMimeType),
				mimeType: outputMimeType,
			};
		} finally {
			imageBitmap.close();
		}
	}

	async encodeImageUnderLimit(imageBitmap: ImageBitmap, mimeType: string): Promise<ArrayBuffer> {
		let scale = 1;

		for (let scaleAttempt = 0; scaleAttempt < 8; scaleAttempt++) {
			const width = Math.max(1, Math.round(imageBitmap.width * scale));
			const height = Math.max(1, Math.round(imageBitmap.height * scale));

			for (const quality of [0.88, 0.78, 0.68, 0.58, 0.48, 0.38]) {
				const encoded = await this.encodeImageBitmap(imageBitmap, width, height, mimeType, quality);
				if (encoded.byteLength <= HACKMD_TARGET_IMAGE_BYTES) {
					return encoded;
				}
			}

			scale *= 0.82;
		}

		throw new Error(`Could not resize image below ${this.formatBytes(HACKMD_MAX_IMAGE_BYTES)} for HackMD.`);
	}

	async encodeImageBitmap(
		imageBitmap: ImageBitmap,
		width: number,
		height: number,
		mimeType: string,
		quality: number,
	): Promise<ArrayBuffer> {
		const canvas = document.createElement('canvas');
		canvas.width = width;
		canvas.height = height;

		const context = canvas.getContext('2d');
		if (!context) {
			throw new Error('Could not create canvas context for image resizing');
		}

		context.drawImage(imageBitmap, 0, 0, width, height);

		const blob = await new Promise<Blob>((resolve, reject) => {
			canvas.toBlob((encodedBlob) => {
				if (!encodedBlob) {
					reject(new Error('Could not encode resized image'));
					return;
				}

				resolve(encodedBlob);
			}, mimeType, quality);
		});

		return await blob.arrayBuffer();
	}

	async requestUrlChecked(
		request: RequestUrlParam,
		label: string,
		bodySizeBytes?: number,
	): Promise<RequestUrlResponse> {
		const requestSummary = {
			method: request.method ?? 'GET',
			url: request.url,
			bodySize: bodySizeBytes === undefined ? undefined : this.formatBytes(bodySizeBytes),
		};

		console.info(`[quick-share-note-to-gist] ${label} started`, requestSummary);

		const response = await requestUrl({ ...request, throw: false });

		console.info(`[quick-share-note-to-gist] ${label} completed`, {
			...requestSummary,
			status: response.status,
		});

		if (response.status >= 400) {
			const responseText = response.text?.trim();
			const sizeMessage = bodySizeBytes === undefined ? '' : ` (${this.formatBytes(bodySizeBytes)})`;
			const responseMessage = responseText ? `: ${responseText.slice(0, 300)}` : '';
			throw new Error(`${label} failed with HTTP ${response.status}${sizeMessage}${responseMessage}`);
		}

		return response;
	}

	getStringByteLength(value: string): number {
		return new TextEncoder().encode(value).byteLength;
	}

	formatBytes(bytes: number): string {
		if (bytes < 1024) {
			return `${bytes} B`;
		}

		const kib = bytes / 1024;
		if (kib < 1024) {
			return `${kib.toFixed(1)} KB`;
		}

		return `${(kib / 1024).toFixed(1)} MB`;
	}

	buildMultipartImageBody(boundary: string, imageData: ArrayBuffer, fileName: string, mimeType: string): ArrayBuffer {
		const encoder = new TextEncoder();
		const header = encoder.encode(
			`--${boundary}\r\n` +
			`Content-Disposition: form-data; name="image"; filename="${fileName}"\r\n` +
			`Content-Type: ${mimeType}\r\n\r\n`,
		);
		const footer = encoder.encode(`\r\n--${boundary}--\r\n`);
		const imageBytes = new Uint8Array(imageData);
		const body = new Uint8Array(header.byteLength + imageBytes.byteLength + footer.byteLength);

		body.set(header, 0);
		body.set(imageBytes, header.byteLength);
		body.set(footer, header.byteLength + imageBytes.byteLength);

		return body.buffer;
	}

	getMimeType(file: TFile): string {
		switch (file.extension.toLowerCase()) {
			case 'jpg':
			case 'jpeg':
				return 'image/jpeg';
			case 'gif':
				return 'image/gif';
			case 'webp':
				return 'image/webp';
			case 'svg':
				return 'image/svg+xml';
			case 'png':
			default:
				return 'image/png';
		}
	}

	canResizeImage(file: TFile): boolean {
		return ['jpg', 'jpeg', 'png', 'webp'].includes(file.extension.toLowerCase());
	}

	getResizedFileName(file: TFile, mimeType: string): string {
		const extension = mimeType === 'image/jpeg' ? 'jpg' : file.extension.toLowerCase();
		return `${file.basename}.${extension}`;
	}

	ensureHackmdToken() {
		if (!this.settings.hackmdToken.trim()) {
			throw new Error('HackMD token is required');
		}
	}

	copyLinkToClipboard(link: string) {
		navigator.clipboard.writeText(link).then(() => {
			new Notice('Published URL copied to clipboard');
		}, (err) => {
			console.error('Failed to copy published URL to clipboard', err);
			new Notice('Failed to copy published URL to clipboard');
		});
	}

	formatError(error: unknown): string {
		if (error instanceof Error && error.message.trim().length > 0) {
			return error.message;
		}

		if (typeof error === 'object' && error !== null && 'message' in error) {
			const message = String((error as { message?: unknown }).message ?? '').trim();
			if (message.length > 0) {
				return message;
			}
		}

		return 'Unknown error';
	}

	async loadSettings() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}
}

class QuickShareNoteSettingTab extends PluginSettingTab {
	plugin: QuickShareNotePlugin;

	constructor(app: App, plugin: QuickShareNotePlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;

		containerEl.empty();
		containerEl.createEl('h2', { text: 'Publishing' });

		new Setting(containerEl)
			.setName('Provider')
			.setDesc('Choose where the note is published. HackMD is recommended for most sharing workflows.')
			.addDropdown(dropdown => dropdown
				.addOption('hackmd', 'HackMD (recommended)')
				.addOption('gist', 'GitHub gist')
				.setValue(this.plugin.settings.provider)
				.onChange(async (value) => {
					this.plugin.settings.provider = value as PublishProvider;
					await this.plugin.saveSettings();
				}));

		containerEl.createEl('h2', { text: 'HackMD' });

		new Setting(containerEl)
			.setName('HackMD token')
			.setDesc('Required when provider is HackMD. Images upload directly to HackMD; Imgur is not used. HackMD allows images up to 1 MB.')
			.addText(text => text
				.setPlaceholder('Enter your HackMD API token')
				.setValue(this.plugin.settings.hackmdToken)
				.onChange(async (value) => {
					this.plugin.settings.hackmdToken = value;
					await this.plugin.saveSettings();
				}));

		containerEl.createEl('h2', { text: 'GitHub Gist' });

		new Setting(containerEl)
			.setName('GitHub token')
			.setDesc('Required when provider is GitHub gist')
			.addText(text => text
				.setPlaceholder('Enter your token')
				.setValue(this.plugin.settings.githubToken)
				.onChange(async (value) => {
					this.plugin.settings.githubToken = value;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('Imgur client ID')
			.setDesc('Required for image uploads when provider is GitHub gist')
			.addText(text => text
				.setPlaceholder('Enter your client ID')
				.setValue(this.plugin.settings.imgurClientId)
				.onChange(async (value) => {
					this.plugin.settings.imgurClientId = value;
					await this.plugin.saveSettings();
				}));

		containerEl.createEl('h2', { text: 'Output formatting' });

		new Setting(containerEl)
			.setName('Show frontmatter')
			.setDesc('Show frontmatter in published note')
			.addToggle(toggle => toggle
				.setValue(this.plugin.settings.showFrontmatter)
				.onChange(async (value) => {
					this.plugin.settings.showFrontmatter = value;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('Show filename as first header')
			.setDesc('Add the note filename as an H1 at the top of the published note')
			.addToggle(toggle => toggle
				.setValue(this.plugin.settings.showFilenameHeader)
				.onChange(async (value) => {
					this.plugin.settings.showFilenameHeader = value;
					await this.plugin.saveSettings();
				}));
	}
}
