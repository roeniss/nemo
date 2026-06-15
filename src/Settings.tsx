// Settings page: manage API tokens for the external integration surface
// (/api/ext/*, e.g. a Siri Shortcut). Deliberately plain — list, generate, revoke.
import { useEffect, useState } from "react";
import { startRegistration } from "@simplewebauthn/browser";
import type { PublicKeyCredentialCreationOptionsJSON } from "@simplewebauthn/browser";
import { api } from "./lib";

type TokenMeta = {
  id: number;
  label: string;
  created_at: number;
  last_used_at: number | null;
};

type PasskeyMeta = {
  id: number;
  credential_id: string;
  transports: string[];
  created_at: number;
};

export function Settings({ flash }: { flash: (msg: string) => void }) {
  const [tokens, setTokens] = useState<TokenMeta[]>([]);
  const [label, setLabel] = useState("");
  const [created, setCreated] = useState<string | null>(null); // plaintext, shown once
  const [loading, setLoading] = useState(true);
  const [passkeyMsg, setPasskeyMsg] = useState<string | null>(null);
  const [passkeys, setPasskeys] = useState<PasskeyMeta[]>([]);
  const [passkeysLoading, setPasskeysLoading] = useState(true);

  async function load() {
    try {
      const r = await api("/tokens");
      setTokens(r.ok ? await r.json() : []);
    } catch {
      setTokens([]); // offline / error — show an empty list rather than crash
    } finally {
      setLoading(false);
    }
  }

  async function loadPasskeys() {
    try {
      const r = await api("/passkey/credentials");
      setPasskeys(r.ok ? await r.json() : []);
    } catch {
      setPasskeys([]);
    } finally {
      setPasskeysLoading(false);
    }
  }

  useEffect(() => {
    load();
    loadPasskeys();
  }, []);

  async function create() {
    const r = await api("/tokens", {
      method: "POST",
      body: JSON.stringify({ label: label.trim() }),
    });
    const t = (await r.json()) as { token: string };
    setCreated(t.token); // reveal once; the server never returns it again
    setLabel("");
    await load();
  }

  async function revoke(id: number) {
    await api(`/tokens/${id}`, { method: "DELETE" });
    await load();
  }

  async function copy(token: string) {
    try {
      await navigator.clipboard.writeText(token);
      flash("Token copied");
    } catch {
      flash("Copy failed — select the token and copy it manually");
    }
  }

  async function registerPasskey() {
    setPasskeyMsg(null);
    try {
      const optRes = await api("/passkey/register/options", { method: "POST" });
      if (!optRes.ok) { setPasskeyMsg("Failed to get registration options."); return; }
      const options = await optRes.json() as PublicKeyCredentialCreationOptionsJSON;
      const regResp = await startRegistration({ optionsJSON: options });
      const verRes = await api("/passkey/register/verify", {
        method: "POST",
        body: JSON.stringify({ response: regResp, challenge: options.challenge }),
      });
      if (verRes.ok) {
        setPasskeyMsg("Passkey registered successfully.");
        await loadPasskeys();
      } else {
        setPasskeyMsg("Passkey registration failed.");
      }
    } catch {
      setPasskeyMsg("Passkey registration was cancelled or failed.");
    }
  }

  async function deletePasskey(id: number) {
    await api(`/passkey/credentials/${id}`, { method: "DELETE" });
    await loadPasskeys();
  }

  return (
    <div className="settings">
      <h2>API tokens</h2>
      <p className="muted">
        For external integrations like a Siri Shortcut. Send the token as{" "}
        <code>Authorization: Bearer &lt;token&gt;</code> when calling{" "}
        <code>POST /api/ext/memos</code> with a JSON body{" "}
        <code>{'{ "content": "..." }'}</code>.
      </p>

      <div className="token-create">
        <input
          placeholder="Label (e.g. iPhone Siri)"
          value={label}
          onChange={(e) => setLabel(e.currentTarget.value)}
        />
        <button onClick={create}>Generate token</button>
      </div>

      {created && (
        <div className="token-reveal">
          <p>Copy this token now — it won't be shown again:</p>
          <code className="token-value">{created}</code>
          <div className="token-reveal-actions">
            <button onClick={() => copy(created)}>Copy</button>
            <button className="ghost" onClick={() => setCreated(null)}>
              Done
            </button>
          </div>
        </div>
      )}

      <ul className="token-list">
        {tokens.map((t) => (
          <li key={t.id}>
            <span className="token-label">{t.label || "(no label)"}</span>
            <span className="muted">{t.last_used_at ? "used" : "never used"}</span>
            <button className="del" onClick={() => revoke(t.id)}>
              Revoke
            </button>
          </li>
        ))}
        {tokens.length === 0 && (
          <li className="empty">{loading ? "Loading…" : "No tokens yet"}</li>
        )}
      </ul>

      <h2>Passkeys</h2>
      <p className="muted">Register a passkey (fingerprint, Face ID, or hardware key) as an additional login option.</p>
      <button onClick={registerPasskey}>Passkey 등록</button>
      {passkeyMsg && <p className="muted">{passkeyMsg}</p>}

      <ul className="token-list">
        {passkeys.map((pk) => (
          <li key={pk.id}>
            <span className="token-label">{new Date(pk.created_at).toLocaleDateString()}</span>
            <span className="muted">{pk.transports.length > 0 ? pk.transports.join(", ") : "unknown"}</span>
            <button className="del" onClick={() => deletePasskey(pk.id)}>
              Delete
            </button>
          </li>
        ))}
        {passkeys.length === 0 && (
          <li className="empty">{passkeysLoading ? "Loading…" : "No passkeys registered"}</li>
        )}
      </ul>
    </div>
  );
}
