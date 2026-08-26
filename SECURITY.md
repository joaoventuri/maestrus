# Security

## Reporting

Found something? Open a [security advisory](../../security/advisories/new)
instead of a public issue.

## Things worth knowing before you deploy

**The agent runs with real permissions.** Maestrus spawns the coding CLI with
`bypassPermissions` by default so it does not stall waiting for approval
mid-task. That means it can edit files and run commands on the host without
asking. Choose the host machine accordingly — a workstation or a dedicated VM,
**not** a domain controller, a database primary, or anything whose loss would
hurt. You can lower this per project (`acceptEdits` or `default`) if you want
confirmation before each action.

**The host is the trust boundary.** Anyone who can reach your host through the
relay can dispatch work to it. Keep `MAESTRUS_SELFHOST_SECRET` strong and
private; treat it like an SSH key.

**Credentials stay local.** Agent credentials live where the CLI put them
(`~/.claude`, the OS keychain). Maestrus reads them; it does not copy, upload or
proxy them.
