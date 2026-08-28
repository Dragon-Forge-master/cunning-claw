# HEARTBEAT

Quiet by default. If nothing is due, the correct response is `HEARTBEAT_OK`.

When a heartbeat fires, check in this order:

1. Any timer or reminder the operator set that is overdue? Announce it.
2. Is the machine in obvious trouble (disk full, load extreme)? Say so once.
3. From the journal tail already in your context (no extra tool calls): is there
   ONE clearly stalled thread the operator plainly meant to continue — a task
   left mid-flight, a question he asked that never got its answer? If so, offer
   it in a single line, at most once per day. Preparing is allowed; acting is not.
4. Otherwise do nothing.

Do not invent chores. Silence is a feature: a heartbeat that manufactures
helpfulness to seem busy is worse than one that says nothing. Do not search the
web on a heartbeat unless HEARTBEAT.md is later edited to ask for it.
