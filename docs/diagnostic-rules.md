# Diagnostic rules

| Layer           | Evidence                                                         | Interpretation                                                               |
| --------------- | ---------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| Configured      | validated enabled Profile                                        | Permission to probe this exact target, not reachability                      |
| SSH config      | bounded `ssh -G` after safe preprocessing                        | Effective host/port/forward definitions; no authentication                   |
| DNS             | async lookup, up to 8 returned addresses                         | Name resolution only                                                         |
| CIDR            | parsed IPv4/IPv6 network membership                              | Range membership; not route installation                                     |
| Route           | `route -n get` for first resolved address                        | OS interface/gateway evidence; utun is not a Tailscale identity              |
| TCP             | bounded connect, up to 4 addresses                               | Actual connected address reported; no SSH login                              |
| HTTP Proxy      | bounded HTTP CONNECT response                                    | Non-2xx, including 407, fails handshake                                      |
| SOCKS5          | greeting + CONNECT response                                      | No-auth support and actual CONNECT must both succeed                         |
| HTTPS           | independent reqwest request with explicit proxy/direct selection | TLS validation remains enabled; 2xx/3xx reachability, redirects not followed |
| SSH application | not checked                                                      | No remote app health or authentication claim                                 |
| Tailscale peer  | explicit `tailscale ping` pong path                              | direct / relay only when output provides path evidence                       |

A reachable proxy TCP port with failed handshake or egress is **degraded / 部分可用**, with the failing sub-step **down**. TCP refusal or DNS failure is not called a healthy proxy. Unavailable tooling, permission failures, unsupported configuration and cancellation remain unknown.

`10.204.100.80 ∈ 10.204.96.0/21`, while `10.204.81.72 ∉ 10.204.96.0/21`; these historical values exist in regression tests only. The diagnostic engine uses each Profile's current configured address and CIDR.

RemoteForward conflicts are conservative risks. Repeated remote listen ports are flagged; an existing forward is reported before any future manager could append another one. Unix socket forwards are displayed but are not treated as TCP ports. There is no remote port-owner claim.

Tailscale peers marked Online are control-plane metadata, not ping evidence. Published PrimaryRoutes and local accept-routes are displayed separately. Missing prefs capabilities degrade to null/unknown.
