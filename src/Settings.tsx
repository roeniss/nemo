// Settings page: manage API tokens for the external integration surface
// (/api/ext/*, e.g. a Siri Shortcut). Deliberately plain — list, generate, revoke.
import { useEffect, useState } from "react";
import { startRegistration } from "@simplewebauthn/browser";
import type { PublicKeyCredentialCreationOptionsJSON } from "@simplewebauthn/browser";
import { api } from "./lib";
import { AdminPanel } from "./AdminPanel";

type TokenMeta = {
  id: number;
  label: string;
  created_at: number;
  last_used_at: number | null;
};

export function Settings({ flash, admin }: { flash: (msg: string) => void; admin?: boolean }) {
  const [tokens, setTokens] = useState<TokenMeta[]>([]);
  const [label, setLabel] = useState("");
  const [created, setCreated] = useState<string | null>(null); // plaintext, shown once
  const [loading, setLoading] = useState(true);
  const [passkeyMsg, setPasskeyMsg] = useState<string | null>(null);

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

  useEffect(() => {
    load();
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
      } else {
        setPasskeyMsg("Passkey registration failed.");
      }
    } catch {
      setPasskeyMsg("Passkey registration was cancelled or failed.");
    }
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

      {admin && <AdminPanel flash={flash} />}
    </div>
  );
}
