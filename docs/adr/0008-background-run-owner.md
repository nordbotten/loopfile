# Every run has a background run owner with a control socket

Every run, attached or detached, is carried out by a run owner process that the CLI starts in its own session. The CLI only checks the input, starts the run owner and, in attached mode, shows the monitor. The run owner listens on a control socket, and that socket is how other processes know it is alive, how cancel reaches it, and how two run owners are kept off one run. We picked this so `d` in the monitor only stops the client, and so a reused pid can never make a dead run look alive. Daemon and server mode stay outside the MVP.

## Loop owner

A loop has the same background-owner model as a run. The CLI performs the Loopfile and fixed-input checks, makes `loops/<loopid>/`, materializes the Loopfile, writes `loop.created`, and starts the owner in its own session. The loop owner writes `owner.started`, listens on its own `loops/<loopid>/owner.sock`, and runs the loop driver. It is the only writer after the initial `loop.created` event, and its socket answers the ready handshake and ping with the loop ID.

## Decisions

- **One process model:** `loopfile <source>` and `loopfile <source> -d` start the run owner the same way. Without `-d` the CLI then attaches the monitor. `d` exits the monitor and nothing else, and `Ctrl+C` in the monitor does the same. Closing the terminal stops only the monitor. `loopfile resume <runid>` starts the run owner by the same rule: it attaches the monitor unless `-d` is given.
- **Before launch:** the CLI loads and checks the Loopfile and shows the upgrade prompt (ADR 0006). It picks the run ID, creates the run folder and opens `owner.log` for the spawn redirect. It writes no run state: the run owner makes the Materialized Loopfile and writes `run.created`, so the one-writer rule of ADR 0003 stays true. The CLI creates the folder and that one file so output from a run owner that dies in its first second is not lost, which the ready handshake below depends on (#81).
- **Start:** the CLI runs `spawn(process.execPath, [cli, "__owner", runid], { detached: true })`. On Linux and macOS this calls `setsid`, so the run owner has no controlling terminal and does not get the terminal's hangup. Stdin is ignored. Stdout and stderr go to `runs/<runid>/owner.log`.
- **Ready handshake:** the CLI waits until the run owner answers "ready" on the control socket, or until it exits. If it exits first, the CLI shows the end of `owner.log` and exits with a non-zero code. After "ready", the CLI calls `unref()` and returns (`-d`) or attaches.
- **Identity:** the run owner appends `owner.started` with its pid and host name. A resumed run gets a new `owner.started`.
- **Control socket:** `runs/<runid>/owner.sock`. It answers a ping with the run ID. This is separate from the per-attempt socket of ADR 0005, which step processes use.
- **Liveness:** a run owner is alive when its socket answers with the right run ID. A run with no end event and no answer is crashed (ADR 0003). If the last `owner.started` host name is not this host, a reader shows the run as unknown, not crashed.
- **Cancel:** `loopfile cancel` sends `cancel` on the control socket. The run owner sends SIGTERM to the attempt's process group, then SIGKILL after 10 seconds. It writes `attempt.interrupted` and `run.cancelled`, removes the socket and exits. SIGTERM, SIGINT or SIGHUP sent to the run owner does the same.
- **One run owner per run:** the socket is the lock. A new run owner binds the socket. If the file exists and answers, it refuses to start. If the file exists and does not answer, it deletes the file and binds again one time.
- **Attempt process groups:** each attempt runs in its own process group, and `attempt.started` records the group ID. On resume, if that group still has processes, resume stops with an error that gives the kill command. `--kill-leftovers` sends SIGKILL to the group. No flag skips the model digest check (ADR 0006).
- **No automatic restart:** after a reboot or a crash the run shows as crashed and a person resumes it.

## Considered Options

- **Attached mode runs the steps in the CLI process:** `d` would then have to move a running run to a new process.
- **Pid check only for liveness:** the OS reuses pids, so a dead run can look alive.
- **Lock file with a pid:** has the same pid reuse problem, and is one more file next to the socket.
- **SIGTERM to the pid as the cancel channel:** can hit the wrong process after pid reuse. A signal to the run owner is still accepted, as a second way in.
- **Run owner does all checks, CLI returns at once:** errors would appear only in `owner.log`, and the upgrade prompt needs a terminal.
- **`nohup`, `launchd` or `systemd` units:** `setsid` is enough to survive terminal close, and service units are daemon mode.

## Consequences

- Readers that check liveness connect to the control socket. This writes nothing, so they stay readers under ADR 0007.
- Unix socket paths are limited to 104 bytes on macOS and 108 on Linux. A long `LOOPFILE_HOME` can go past this. The run owner must fail with a clear error in that case.
- Two resumes at the same moment can both see a stale socket. This is accepted for a manual MVP command.
- If an attempt group ID is reused by the OS, resume can refuse when it did not need to. It never kills a process without `--kill-leftovers`.
