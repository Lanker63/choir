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
```

## Publish Notes

This package copies runtime files from the source repository `out/` tree during `prepack`.
Run this from the repository root before packing or publishing:

```bash
npm run build:extension
npm run build:cli:package
```
