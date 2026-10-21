# Command matrix — 0.2

| Command | Trigger | Bounds / effects |
| --- | --- | --- |
| sw_vers, scutil --proxy, route get default, lsof LISTEN | discovery | 3–4 s, listener cap 128 |
| tailscale status --json / debug prefs | discovery or operation preview/verification | bounded, unavailable stays unknown |
| ssh -G -F private-config ALIAS | selected profile / operation preview | 5–15 s; executable Match conditions rejected or disabled before evaluation |
| route -n get IP | selected profile | 3 s |
| tailscale ping --c 2 --timeout 3s HOST | enabled Tailscale Profile | 7 s |
| networksetup -listallnetworkservices / -get*proxy | settings discovery and operation preview | 15 s |
| networksetup -set{webproxy,securewebproxy,socksfirewallproxy} / -set*state | confirmed plan / confirmed rollback / recovery after failure | exact discovered service, validated host/port, no credentials or sudo |
| tailscale up --timeout=8s / down | confirmed connection plan | 15 s command deadline, readback and rollback |
| tailscale set --accept-routes=BOOL / --exit-node=IP | confirmed setting plan | fixed flags, snapshot/readback/rollback; no reset |
| ssh -N -T -n -v -F private-config ... | confirmed tunnel / auth | batch auth, strict host keys, no control multiplexing or agent forwarding; init deadline 12 s; keepalive 15 s × 3 |
| ssh ... curl --head --proxy http://127.0.0.1:PORT ... HTTPS_URL | confirmed remote egress test | fixed curl command, validated and quoted URL, max-time 8 s; no arbitrary remote command input |
| pbcopy | explicit report copy | 3 s, bounded redacted stdin |

Normal command stdout/stderr are capped at 256 KiB. Managed SSH drains bounded diagnostic output and stores classified messages only; it tracks child exit and authentication/forward initialization separately. All OS calls use argv arrays. The only remote shell text is a fixed curl template with shell-quoted validated input. Existing trusted SSH ProxyCommand may run only after a preview warning and confirmation.

No sudo, original SSH writes, VPN-client internal controls, Windows agent, launchd, pkill or arbitrary frontend shell bridge.
