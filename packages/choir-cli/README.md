# choir-cli

Standalone CLI distribution for Choir.

## Install

```bash
npm install -g choir-cli
```

## Usage

```bash
choir ci run
choir verify --quick
choir analyze summary
```

`choir-cli` emits JSON envelopes for command output:

```json
{
	"ok": true,
	"command": "verify",
	"data": {
		"mode": "quick"
	}
}
```

Current implementation coverage includes:

- `verify [--quick]`
- `ci run`
- `define`, `status`, `policy status`, `approve`, `reject`
- `export dsl`, `export json`, `remove goal <name>`
- `analyze workspace|hotspots|summary`
- `plan --optimize|--adaptive`, `simulate`, `preview`, `execute`, `rollback`
- `refactor rename|move|extract|inline`
- `import`, `library list|install|update|lock`
- `macro list|show|run`
- `abstraction list|describe|<abstraction-id>`
- `audit log|query|report`
- `init [--template <name>] [--expand-domain|--reclassify|--recalibrate]`

## Publish Notes

This package copies runtime files from the source repository `out/` tree during `prepack`.
Run this from the repository root before packing or publishing:

```bash
npm run build:extension
npm run build:cli:package
```
