# Security Policy

Xyron Center runs with administrator rights and can execute commands as `NT AUTHORITY\SYSTEM`, so we take security reports seriously.

## Supported versions

| Version | Supported |
|---|---|
| 1.0.x (latest) | Yes |
| Older builds | No. Please update first |

## Reporting a vulnerability

**Please do not open a public issue for security problems.**

Use GitHub's private reporting instead: open the repository's **Security** tab, then choose **Report a vulnerability**. Include:

- what an attacker could do (for example, run a command without `/op`, or escape path validation),
- the steps or a minimal proof of concept,
- your Windows version and the Xyron Center version.

You can expect an acknowledgement within a few days. Once a fix is released, we will credit you in the release notes unless you prefer to stay anonymous.

## Scope

In scope:

- Privilege escalation beyond what the user explicitly requested (`/op`, `/op-system`, `/op-unlock`)
- Command injection through file names, paths, URLs, drag and drop or the command palette
- Bypassing renderer isolation (`contextBridge`) or the main-process path and URL validation

Out of scope:

- Actions a local administrator can already perform by design
- Reports that rely on a machine that is already compromised
- Antivirus or SmartScreen warnings about the unsigned build
