---
name: migrator
description: Securely migrate OpenClaw Agent (config, memory, skills) to a new machine.
---

# OpenClaw Migrator

A utility to package an Agent's state into a portable, encrypted archive (`.oca`) for migration.

## Features

- **Encrypted Archive**: Uses AES-256-GCM + auth tag for confidentiality and integrity.
- **Path Normalization**: Restores workspace path using `manifest.json` metadata.
- **Dependency Manifest**: Captures system dependencies (Brewfile) to ensure the new environment matches.

## Usage
## 使用方法

### Export (On Old Machine)
### 导出（在旧机器上）
全量导出所有数据（配置、记忆、Skills、Workspace）。
Automatically detects `~/.openclaw` or `~/.clawdbot` and your workspace.

```bash
migrator export -o my-agent.oca --password "secret"
```

### Import (On New Machine)
### 导入（在新机器上）

**Default (Standard Restore)**:
Restores everything to standard `~/.openclaw` paths.
将所有数据恢复到新的标准路径 `~/.openclaw` 和 `~/.openclaw/workspace`。

```bash
migrator import -i my-agent.oca --password "secret"
```

**Minimal Restore**:
Only restores Memory, Skills, and Credentials. Keeps existing config.
只恢复记忆、Skills 和密钥，保留现有配置。

```bash
migrator import -i my-agent.oca --password "secret" --minimal
```

## Security

This skill handles sensitive data (`openclaw.json`, `auth.token`). 
The export process **always** requires a password to encrypt the archive.
Unencrypted exports are **disabled** by design.
