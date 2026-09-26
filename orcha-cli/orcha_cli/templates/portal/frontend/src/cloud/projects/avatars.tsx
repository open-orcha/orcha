/**
 * GitHub-aware avatar faces — React ports of app-ui.js ghAvatar()/face(),
 * emitting the SAME markup/class names the shared styles.css already styles.
 * Local to the cloud pages (the open ui.tsx only ships the letter Avatar).
 */
import { hue } from "../../lib/format";
import { Avatar } from "../../components/ui";

export function GhAvatar({ login, size }: { login: string | null | undefined; size?: string }) {
  const h = hue(login || "");
  const grad = `linear-gradient(140deg, hsl(${h} 70% 62%), hsl(${(h + 38) % 360} 72% 54%))`;
  const cls = "av gh" + (size ? " " + size : "") + " human";
  const init = (login || "?").trim().charAt(0).toUpperCase();
  return (
    <span className={cls} style={{ background: grad }}>
      {init}
      <img
        className="gh-face"
        src={`https://github.com/${encodeURIComponent(login || "")}.png?size=96`}
        alt=""
        loading="lazy"
        referrerPolicy="no-referrer"
        onError={(e) => e.currentTarget.remove()}
      />
    </span>
  );
}

/* Portal-wide face convention: a HUMAN with a mapped GitHub identity gets their
 * real GitHub profile picture; every AI agent, and any unmapped human, keeps
 * the plain deterministic letter avatar. */
export function Face({ rec, size }: { rec: { kind?: string | null; alias?: string | null; github_login?: string | null }; size?: string }) {
  return rec.kind === "human" && rec.github_login
    ? <GhAvatar login={rec.github_login} size={size} />
    : <Avatar alias={rec.alias} kind={rec.kind} size={size} />;
}
