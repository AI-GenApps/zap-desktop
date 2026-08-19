import type { AuthMode } from "../shared/contracts";

interface OnboardingProps {
  busy: boolean;
  error?: string;
  onAuthenticate: (mode: AuthMode) => void;
  onContinueLocally: () => void;
}

export function Onboarding({ busy, error, onAuthenticate, onContinueLocally }: OnboardingProps) {
  return (
    <main className="onboarding-shell">
      <div className="onboarding-mark" aria-hidden="true"><span>Z</span></div>
      <div className="onboarding-copy">
        <p className="eyebrow">ZAPTURE DESKTOP</p>
        <h1>Let&apos;s get you recording.</h1>
        <p>Sign in to upload, share, and edit your captures.</p>
      </div>
      {error ? <p className="onboarding-error" role="alert">{error}</p> : null}
      <div className="onboarding-actions">
        <button type="button" onClick={() => onAuthenticate("sign-in")} disabled={busy}>Sign in</button>
        <button type="button" className="onboarding-primary" onClick={() => onAuthenticate("sign-up")} disabled={busy}>Sign up</button>
      </div>
      <button type="button" className="local-link" onClick={onContinueLocally} disabled={busy}>Record locally</button>
    </main>
  );
}
