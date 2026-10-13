export type LedgerAuthConfig =
  | {
      mode: "caller-bearer";
      // The same list as the one below, named in CALLER_BEARER_INSECURE_HTTP_HOSTS. Optional on the
      // type only because the app can be built without reading an environment (tests hand it the
      // mode alone); readLedgerAuthConfig always sets it.
      insecureHttpHosts?: string[];
    }
  | {
      mode: "shared-identity";
      issuer: string;
      clientId: string;
      clientSecret: string;
      scopes: string;
      audience?: string;
      // Hostnames this deployment has named as reachable over plaintext HTTP, beyond the loopback
      // names below. Empty in every deployment that has not named one.
      insecureHttpHosts: string[];
    };

// Addresses that cannot leave the machine running this process. This is a fact about those names,
// not a deployment choice, so it is not configurable. What a deployment does choose — which other
// hosts it accepts over plaintext — is named in SHARED_IDENTITY_INSECURE_HTTP_HOSTS or
// CALLER_BEARER_INSECURE_HTTP_HOSTS, one list per mode.
const LOOPBACK_HOSTS = ["localhost", "127.0.0.1", "[::1]"];

const httpHostAllowed = (hostname: string, named: string[]): boolean =>
  LOOPBACK_HOSTS.includes(hostname) || named.includes(hostname);

// Bare hostnames, separated by commas or spaces. Anything carrying a scheme, port, path or wildcard
// is refused rather than matched loosely. One parser for both lists, so the two cannot drift.
const namedInsecureHosts = (value: string | undefined, key: string): string[] => {
  const hosts = (value ?? "").split(/[\s,]+/).filter((host) => host !== "");
  if (hosts.some((host) => !/^([a-z0-9.-]+|\[[0-9a-f:]+\])$/i.test(host))) {
    throw new Error(`Invalid ${key}; list bare hostnames separated by commas or spaces`);
  }
  return hosts;
};

// Server-only configuration. No values (including malformed URLs) appear in errors.
export function readLedgerAuthConfig(env: Record<string, string | undefined>): LedgerAuthConfig {
  const mode = env.LEDGER_AUTH_MODE;
  if (mode !== "caller-bearer" && mode !== "shared-identity") {
    throw new Error("Select LEDGER_AUTH_MODE=caller-bearer or shared-identity");
  }
  const keys = [
    "SHARED_IDENTITY_ISSUER",
    "SHARED_IDENTITY_CLIENT_ID",
    "SHARED_IDENTITY_CLIENT_SECRET",
    "SHARED_IDENTITY_SCOPES",
    "SHARED_IDENTITY_AUDIENCE",
    // Carries the SHARED_IDENTITY_ prefix deliberately: the loop below then refuses it in
    // caller-bearer mode, where there is no service credential for it to expose.
    "SHARED_IDENTITY_INSECURE_HTTP_HOSTS",
  ];
  // Reject typos/unsupported options as well as leftover credentials in caller mode.
  for (const key of Object.keys(env)) {
    if (key.startsWith("SHARED_IDENTITY_") && env[key] !== undefined) {
      if (mode === "caller-bearer" || !keys.includes(key)) {
        throw new Error("Contradictory or unsupported shared-identity configuration");
      }
    }
  }
  // The caller-bearer list carries its own prefix for the same reason, read the other way round: in
  // shared-identity mode SHARED_IDENTITY_INSECURE_HTTP_HOSTS already governs the ledger address, and
  // a second list would be a second place for the same decision.
  if (mode === "shared-identity" && env.CALLER_BEARER_INSECURE_HTTP_HOSTS !== undefined) {
    throw new Error("Contradictory or unsupported caller-bearer configuration");
  }
  if (mode === "caller-bearer") {
    return {
      mode,
      insecureHttpHosts: namedInsecureHosts(
        env.CALLER_BEARER_INSECURE_HTTP_HOSTS,
        "CALLER_BEARER_INSECURE_HTTP_HOSTS",
      ),
    };
  }
  const required = (key: string): string => {
    const value = env[key];
    if (!value?.trim()) throw new Error(`Missing ${key}`);
    return value;
  };
  // **Plaintext is allowed only to hosts this deployment names.** The loopback allowance cannot be
  // used from inside a container: the addresses a container reaches its host through are not
  // loopback names, and the loopback names reach the container itself. Without this, a containerised
  // Backend cannot be pointed at a local HTTP participant or IdP at all.
  //
  // A list rather than a switch, because a switch lifts TLS for every address at once. Naming the
  // hosts keeps a value left behind in a production environment from covering a production ledger,
  // and states in the environment itself what the deployment intends. It lifts the scheme
  // requirement only — embedded credentials, query and fragment stay refused — and startup says so.
  const insecureHttpHosts = namedInsecureHosts(
    env.SHARED_IDENTITY_INSECURE_HTTP_HOSTS,
    "SHARED_IDENTITY_INSECURE_HTTP_HOSTS",
  );
  // An explicitly configured HTTP loopback issuer selects local development transport only.
  // It never selects or changes the authentication mode.
  const issuer = safeServiceEndpoint(
    required("SHARED_IDENTITY_ISSUER"),
    true,
    insecureHttpHosts,
  ).href;
  const scopes = required("SHARED_IDENTITY_SCOPES").trim().split(/\s+/);
  if (
    scopes.includes("offline_access") ||
    scopes.some((s) => !/^[\x21\x23-\x5B\x5D-\x7E]+$/.test(s))
  ) {
    throw new Error("Invalid SHARED_IDENTITY_SCOPES; refresh tokens are not supported");
  }
  const audience = env.SHARED_IDENTITY_AUDIENCE;
  if (audience !== undefined && (!audience.trim() || /[\r\n]/.test(audience))) {
    throw new Error("Invalid SHARED_IDENTITY_AUDIENCE");
  }
  return {
    mode,
    issuer,
    clientId: required("SHARED_IDENTITY_CLIENT_ID"),
    clientSecret: required("SHARED_IDENTITY_CLIENT_SECRET"),
    scopes: scopes.join(" "),
    ...(audience === undefined ? {} : { audience }),
    insecureHttpHosts,
  };
}

export function safeServiceEndpoint(
  value: string,
  allowLoopbackHttp: boolean,
  insecureHttpHosts: string[] = [],
): URL {
  try {
    const url = new URL(value);
    const httpAllowed = allowLoopbackHttp && httpHostAllowed(url.hostname, insecureHttpHosts);
    if (
      (url.protocol !== "https:" && !(httpAllowed && url.protocol === "http:")) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    )
      throw new Error();
    return url;
  } catch {
    throw new Error(
      "Service OAuth URLs require HTTPS without credentials, query or fragment; HTTP requires a loopback host or one named in SHARED_IDENTITY_INSECURE_HTTP_HOSTS",
    );
  }
}

// A caller-bearer token is just as sensitive as the shared service token. Refuse to relay it to a
// remote participant over plaintext, while keeping loopback HTTP — and the hosts the deployment
// named in CALLER_BEARER_INSECURE_HTTP_HOSTS — available for local development. There is no issuer
// to pair the ledger with here: the caller brought the token, so the ledger address is the only one
// this mode holds. Embedded credentials, query parameters and fragments are not valid parts of the
// configured base, named host or not.
export function assertCallerLedgerBase(
  ledgerBase: string,
  auth: Extract<LedgerAuthConfig, { mode: "caller-bearer" }>,
): void {
  try {
    const url = new URL(ledgerBase);
    const httpAllowed = httpHostAllowed(url.hostname, auth.insecureHttpHosts ?? []);
    if (
      (url.protocol !== "https:" && !(httpAllowed && url.protocol === "http:")) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    ) {
      throw new Error();
    }
  } catch {
    throw new Error(
      "caller-bearer LEDGER_BASE requires HTTPS without credentials, query or fragment; HTTP requires a loopback host or one named in CALLER_BEARER_INSECURE_HTTP_HOSTS",
    );
  }
}

// **Where the service credential is allowed to travel.** A shared-identity token opens the whole
// configured Canton scope for every user at once, so it does not go out over plaintext. Kept here
// rather than inline in serve.mjs so the rule is testable without opening a socket; that file owns
// only the message and the exit. Throws when the address is refused — the value never reaches the
// error, and a malformed address is refused the same way.
export function assertServiceLedgerBase(
  ledgerBase: string,
  auth: Extract<LedgerAuthConfig, { mode: "shared-identity" }>,
): void {
  try {
    const url = new URL(ledgerBase);
    // Plaintext to the ledger is paired with a plaintext issuer on purpose: one local development
    // stack, not a remote IdP reached over TLS while the ledger beside it travels in the clear.
    const httpAllowed =
      httpHostAllowed(url.hostname, auth.insecureHttpHosts) &&
      new URL(auth.issuer).protocol === "http:";
    if (
      (url.protocol !== "https:" && !(httpAllowed && url.protocol === "http:")) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    )
      throw new Error();
  } catch {
    throw new Error(
      "shared-identity LEDGER_BASE requires HTTPS; HTTP requires a loopback host or one named in SHARED_IDENTITY_INSECURE_HTTP_HOSTS",
    );
  }
}
