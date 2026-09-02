---
name: linux-box
label: This machine
category: machine
description: Diagnose and tend this Linux (or macOS/Windows) box — disk, memory, services, logs, doctor. Use when something is slow, down, full, or "the machine is acting up".
---

# This machine

1. `system_status` first. Then targeted `run_command`: `df -h`, `free -h`, `uptime`, `journalctl --user -u cunningclaw -n 50` (Linux), or the equivalent the platform adapter already named.
2. If CUNNING CLAW itself is the patient, say to run `npm run doctor` from the repo — or run it. Every failure line names a fix.
3. Read logs. Do not restart, reboot, or `chmod 777` anything. Reboot is denylisted. If a service unit needs a restart, put the exact `systemctl --user` command on an approval card and wait.
4. Disk-full: identify the hog (`du -sh` on likely dirs), propose what to delete, wait for approval before deleting.
5. Report in four lines: what is wrong, evidence, what you did, what still needs a human.
