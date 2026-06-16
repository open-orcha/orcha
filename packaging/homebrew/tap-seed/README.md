# homebrew-orcha — private tap for the `orcha` CLI

**Access = Quantal-Labs-AI org membership + a working GitHub SSH key**
(`ssh -T git@github.com` should greet you). Formulae fetch the private source
repo over SSH; there are no tokens to configure.

## Install

```bash
brew tap quantal-labs-ai/orcha git@github.com:Quantal-Labs-AI/homebrew-orcha.git
brew install quantal-labs-ai/orcha/orcha
```

Docker Desktop (or OrbStack/Colima) is required before `orcha init` — the
formula prints the same caveat.

## Upgrade

```bash
brew upgrade orcha     # CLI only
orcha update           # in a project: CLI (via brew) + templates + portal + DB
```

## Hold a version

```bash
brew pin orcha         # brew upgrade skips it until brew unpin
```

## Downgrade

Every release leaves a frozen formula behind:

```bash
brew uninstall orcha
brew install quantal-labs-ai/orcha/orcha@0.2.0
```

`orcha update` will NOT auto-upgrade a versioned install (it's treated as a
deliberate pin). Note: DB migrations are forward-only — a downgraded CLI runs
fine against the newer (additive) schema; a true schema rollback is
`orcha down -v` + re-init (DESTRUCTIVE: wipes that project's data).

### Returning to latest

The frozen formula conflicts with the tracking one, so uninstall it first:

```bash
brew uninstall orcha@0.2.0
brew install quantal-labs-ai/orcha/orcha
```

## Maintenance

`Formula/*.rb` are **generated** by the
[Orcha release workflow](https://github.com/Quantal-Labs-AI/Orcha/blob/main/.github/workflows/publish.yml).
Don't edit them here — change `packaging/homebrew/` in the main repo and cut a
release.
