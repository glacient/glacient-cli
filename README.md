# glacient

CLI for glacient services. Requires an existing glacient account.

## Install

```sh
npm i -g @glacient.tech/cli
```

Installs the `glacient` binary on your `PATH`.

## Quickstart

```sh
# Authenticate
glacient login

# Show your current identity
glacient whoami

# List workflows
glacient workflow list
```

> **Note:** The commands above (`login`, `whoami`, `workflow list`) will be wired up in future iterations. This release scaffolds the binary and credentials layer.

## Configuration

Credentials are stored at:

```
${XDG_CONFIG_HOME:-~/.config}/glacient.tech/cli/credentials.json
```

To point at a different server:

```sh
GLACIENT_SERVER_URL=https://my-server.example.com glacient login
```

## License

[MIT](./LICENSE). The published `glacient` binary bundles third-party
dependencies; their licenses are reproduced in
[THIRD-PARTY-NOTICES.md](./THIRD-PARTY-NOTICES.md).
