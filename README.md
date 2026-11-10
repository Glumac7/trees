# trees

A local web UI for [worktrunk](https://github.com/max-sixty/worktrunk). See every git worktree across all your repos, with PR and CI state, and create, merge or remove them with a click.

- Repo sidebar with a red dot where CI is failing or a branch has conflicts
- One row per worktree: status, ahead/behind, PR link
- Detail panel: commits, changed files, open in terminal or editor, merge, remove
- Move a feature branch out of the main checkout into its own worktree, or stash it away
- One-click self-update from this repo

No dependencies, no build step: one Node file and one HTML page.

## Requirements

- macOS, Node 24+
- [`wt`](https://github.com/max-sixty/worktrunk) (`brew install worktrunk`) and `git`
- [`gh`](https://cli.github.com), logged in, for PR and CI status

## Run

```bash
git clone https://github.com/Glumac7/trees.git
cd trees
node server.mjs ~/code
```

`~/code` is the folder that holds your repos. Without it, trees lists the repos next to its own checkout.

Open http://127.0.0.1:7171 and log in with your token:

```bash
pbcopy < ~/.config/trees/token
```

The token is created on first start. Delete the file and restart to get a new one.

## Settings

| Variable | Default | What it does |
|---|---|---|
| `PORT` | `7171` | Port to listen on (always `127.0.0.1`) |
| `WT_UI_EDITOR` | `cursor` | Command the Editor button runs |
| `TREES_HOST` | none | Extra hostname to accept when you put trees behind an HTTPS reverse proxy, e.g. `trees.example.test` |

## Updates

When `main` here moves ahead of your checkout, the header shows "Update available" with the new commits. One click installs exactly those. Under [pm2](https://pm2.keymetrics.io) trees restarts itself; otherwise it asks you to restart it.

## Security

trees runs git commands on your machine, so it only answers to its owner: it listens on `127.0.0.1`, requires the token, and rejects requests from other sites. If you expose it through a reverse proxy, keep it on a network you trust.

## Development

```bash
npm test
```

## License

MIT
