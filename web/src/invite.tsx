// Tell a maintainer money is waiting. Nothing is ever posted automatically: a person always opens GitHub's form and presses submit themselves.
import { useEffect, useMemo, useState } from "react";
import { ExternalLink, Link2, Send } from "lucide-react";
import { api, useApi } from "./api.ts";
import { useBrand } from "./brand.tsx";
import { dateTime } from "./format.ts";
import { inviteBody, issueUrl } from "./invite-text.ts";
import { CopyButton, ErrorBox, Modal, Skeleton, useCopy } from "./ui.tsx";

// GitHub answers 414 when the address is too long. Past this, the form isn't offered and the text is copied instead.
const MAX_URL = 6000;

export function InviteModal({ repo, onClose, onSent }: { repo: string; onClose: () => void; onSent: () => void }) {
  const short = repo.replace("github.com/", "");
  const brand = useBrand();
  const copy = useCopy();
  const { data, error } = useApi<any>(`/api/invite/${short}`, [short]);
  const defaults = useMemo(() => (data ? { title: `Open-source funding is waiting for ${short}`, body: inviteBody(data, brand) } : null), [data, brand, short]);
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [again, setAgain] = useState(false);
  useEffect(() => {
    if (defaults) {
      setTitle(defaults.title);
      setBody(defaults.body);
    }
  }, [defaults]);
  const url = issueUrl(repo, title, body);
  const tooLong = url.length > MAX_URL;
  const mark = async (channel: string) => {
    await api(`/api/invite/${short}/sent`, { body: { channel }, admin: true });
    onSent();
  };

  return (
    <Modal
      width={640}
      title="Invite the maintainer"
      sub={`${short} · nothing is posted until you do it yourself`}
      icon={<Send size={17} />}
      tone="teal"
      onClose={onClose}
      foot={data && (!data.invited || again) ? (
        <>
          <button className="btn" onClick={() => void copy(data.claim_url, "Claim link copied.").then(() => mark("copied_link"))}><Link2 size={14} />Copy claim link</button>
          <span onClick={() => void mark("copied_text")}>
            <CopyButton text={`${title}\n\n${body}`} label="Copy text" className="btn" done="Text copied. Paste it into an email or a Discussion." />
          </span>
          <a
            className={`btn primary${tooLong ? " disabled" : ""}`}
            href={tooLong ? undefined : url}
            aria-disabled={tooLong}
            target="_blank"
            rel="noreferrer"
            title={tooLong ? "This message is too long for GitHub's address limit. Shorten it, or copy the text." : "Opens GitHub's form with this text. You press submit."}
            onClick={() => void mark("github_issue")}
          >
            Open GitHub issue<ExternalLink size={14} />
          </a>
        </>
      ) : undefined}
    >
      {error && <ErrorBox error={error} />}
      {!data && !error && <div className="stack"><Skeleton h={40} /><Skeleton h={160} /></div>}
      {data && data.invited && !again && (
        <div className="stack">
          <p>Already invited on <strong>{dateTime(data.invited.created_at)}</strong>. Invite again?</p>
          <div className="row"><button className="btn primary" onClick={() => setAgain(true)}>Invite again</button><button className="btn ghost" onClick={onClose}>Not now</button></div>
        </div>
      )}
      {data && (!data.invited || again) && (
        <div className="stack">
          <div className="field">
            <label htmlFor="invite-title">Title</label>
            <input id="invite-title" className="input" value={title} onChange={(e) => setTitle(e.target.value)} />
          </div>
          <div className="field">
            <label htmlFor="invite-body">Message</label>
            <textarea id="invite-body" className="input" rows={9} style={{ padding: 10, resize: "vertical", lineHeight: 1.45 }} value={body} onChange={(e) => setBody(e.target.value)} />
            <span className="hint">If issues are turned off for this repo, GitHub won't open the form. Copy the text for email or Discussions.</span>
            {tooLong && <span className="err">This message is too long for GitHub's address limit. Shorten it, or copy the text.</span>}
          </div>
        </div>
      )}
    </Modal>
  );
}
