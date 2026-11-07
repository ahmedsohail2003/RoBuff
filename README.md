# Buffalo Hackathon

Project for the Buffalo Hackathon.

## Private files

This repository is public, including its commit history. Git ignores the locations below, so files in them are never committed or pushed:

| Location | Examples |
| --- | --- |
| Any folder named `private`, at any depth | `private/notes.md`, `src/private/data.csv` |
| Any file with `.private.` in its name | `pitch.private.md` |
| `.env` and `.env.*`, except `.env.example` | `.env`, `.env.local` |

Everything else can be committed and published.

This repo does not back up or share private files. The top-level `private/` folder is backed up separately to a private repo. Other private files exist only on the computer that holds them.

To check a file before you commit it, run this command. If it prints a matching rule, the file is private. If it prints nothing, the file can be published.

```bash
git check-ignore -v path/to/file
```
