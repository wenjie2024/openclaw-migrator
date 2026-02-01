---
name: migrator
description: Securely migrate OpenClaw Agent (config, memory, skills) to a new machine.
---

# OpenClaw Migrator

A utility to package an Agent's state into a portable, encrypted archive (`.oca`) for migration.

## Features

- **Encrypted Archive**: Uses AES-256-GCM to protect sensitive data (API keys) during transit.
- **Path Normalization**: Automatically adjusts absolute paths (e.g. `/Users/olduser` -> `/Users/newuser`) during restore.
- **Dependency Manifest**: Captures system dependencies (Brewfile) to ensure the new environment matches.

## Usage

### Export (On Old Machine)

```bash
migrator export --out my-agent.oca --password "secret"
```

### Import (On New Machine)

```bash
migrator import --in my-agent.oca --password "secret"
```

## Security

This skill handles sensitive data (`openclaw.json`, `auth.token`). 
The export process **always** requires a password to encrypt the archive.
Unencrypted exports are **disabled** by design.
