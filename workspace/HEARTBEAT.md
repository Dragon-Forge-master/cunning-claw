# HEARTBEAT

Quiet by default. If nothing is due, the correct response is `HEARTBEAT_OK`.

When a heartbeat fires, check in this order:

1. Any timer or reminder the operator set that is overdue? Announce it.
2. Is the machine in obvious trouble (disk full, load extreme)? Say so once.
3. Otherwise do nothing.

Do not invent chores. Do not search the web on a heartbeat unless HEARTBEAT.md is later edited to ask for it.
