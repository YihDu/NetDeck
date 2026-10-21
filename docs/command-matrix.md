# Read-only command matrix

| Command                                       | Trigger                        | Bound                          |
| --------------------------------------------- | ------------------------------ | ------------------------------ |
| `/usr/bin/sw_vers -productVersion`            | discovery                      | 3 s                            |
| `/usr/sbin/scutil --proxy`                    | discovery                      | 3 s                            |
| `/sbin/route -n get default`                  | discovery                      | 3 s                            |
| `/usr/sbin/lsof -nP -iTCP -sTCP:LISTEN -Fpcn` | discovery                      | 4 s, 128 listener rows         |
| `tailscale status --json`                     | discovery, discovered CLI path | 5 s                            |
| `tailscale debug prefs`                       | successful Tailscale discovery | 3 s; unsupported stays unknown |
| `/usr/bin/ssh -G -F TEMP_CONFIG ALIAS`        | enabled selected SSH Profile   | 5 s, safe preprocessed config  |
| `/sbin/route -n get IP`                       | enabled selected Profile       | 3 s                            |
| `tailscale ping --c 2 --timeout 3s HOST`      | enabled Tailscale Profile      | 7 s                            |
| `/usr/bin/pbcopy`                             | explicit copy button           | 3 s, redacted stdin only       |

All process calls use executable/argument arrays, null stdin except clipboard, inherited locale overridden with `LC_ALL=C`, capped stdout/stderr (256 KiB each) and kill-on-drop. The app kills only the child it just created, never searches for SSH or VPN processes to terminate.

No `sudo`, shell evaluation, system proxy mutation, Tailscale `set/up/down`, SSH login, remote commands, or service installation is implemented.
