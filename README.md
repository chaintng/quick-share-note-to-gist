# Quick Share Note (Plugin)

**Quick Share Note** is an Obsidian plugin. It quickly publishes your notes through multiple providers, with HackMD recommended for most sharing workflows. It copies the published URL and writes the publish URL back to note frontmatter.

## DEMO
[Link to demo gist file](https://gist.github.com/chaintng/e20f278cbf03d855bd51c5840caf728f)
![Demo of Plugin](./docs/DEMO.gif)

## Installation
- Search "Quick Share Note to gist" in Obsidian's Plug-in marketplace
- OR go to this link: https://obsidian.md/plugins?id=quick-share-note-to-gist

## Configuration

After enabling the plugin, go to the plugin settings to configure the following options:

- **Provider**: Choose HackMD or GitHub gist. HackMD is recommended.
- **HackMD Token**: Required when publishing to HackMD. HackMD image upload uses HackMD directly and does not use Imgur. HackMD allows images up to 1 MB.
- **GitHub Token**: Required when publishing to GitHub gist.
- **Imgur Client ID**: Required for image uploads when publishing to GitHub gist.
- **Show Frontmatter**: Toggle whether to include frontmatter in the published note.
- **Show Filename as First Header**: Toggle whether to add the note filename as an H1 at the top of the published note.

## Usage

1. Open the note you want to publish in Obsidian.
2. Use the command palette (`Ctrl+P` or `Cmd+P`) and select `Publish note to selected provider`.
3. The plugin will upload the note to the configured provider.
4. A notification will appear with the published URL, which will also be copied to your clipboard.

## Features

- Publish notes through multiple providers: HackMD or GitHub gist.
- New HackMD notes are created readable by everyone with the link, while editing stays owner-only.
- Upload images to Imgur for GitHub gist publishing.
- Upload images directly to HackMD for HackMD publishing. Images over 1 MB are resized before upload when possible.
- Option to include or exclude frontmatter in the published note.
- Option to include or exclude the filename H1 in the published note.
- Copy published URL into clipboard, and save it in frontmatter.

## License

This project is licensed under the MIT License.
