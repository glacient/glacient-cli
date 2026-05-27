# Contributing to glacient CLI

Thanks for your interest in contributing! This document covers how to get set
up and the conventions we follow.

## Development setup

This project uses [Bun](https://bun.sh) as its toolchain.

```sh
# Install dependencies
bun install

# Run the CLI from source
bun run dev -- --help

# Build the distributable bundle (dist/glacient.js)
bun run build

# Run the test suite
bun test

# Type-check and lint
bun run typecheck
bun run lint
```

Node.js >= 20 is required to run the built binary.

## Making changes

1. Fork the repository and create a feature branch off `main`.
2. Keep changes focused; one logical change per pull request.
3. Add or update tests for any behavior you change. All tests, type-checks, and
   lint must pass before a PR can be merged.
4. Write clear commit messages describing the *why*, not just the *what*.

## Pull requests

Open a pull request against `main` in the public repository. A maintainer will
review it. Please make sure CI is green and describe how you verified your
change.

> **Note:** Active development happens in a separate internal repository; the
> public repository is the canonical home for releases and accepts contributions
> via pull request. Maintainers sync accepted changes back internally.

## Reporting bugs

Open an issue with steps to reproduce, the version (`glacient --version` once
available), and your environment. For security-sensitive reports, see
[SECURITY.md](./SECURITY.md) instead of filing a public issue.
